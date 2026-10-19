//! `reference compare` (docs/reference-selection.md, 「What it picks and what it costs, measured」): what the split
//! changed, in numbers — the conversations the one reference classifier answered, put to the three gates that
//! answer now.
//!
//! The before side is read rather than run again: the stored answer is what that gate chose, and the judgement of
//! that turn is what it cost. The stored runs are the agency's run log's, which lists no agent's runs to another
//! unit, so they are handed to the noun as a file. The after side is a real run of each gate over the same messages,
//! with the stored index cut back into the candidates each gate would be offered.

use std::collections::hash_map::Entry;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;

use futures_util::future::join_all;
use gate_policy::fill_marks;
use gate_policy::reference::REFERENCE;
use gate_reference::Reference;
use gate_reference::pick::{self, Candidate};
use gate_reference::road;
use gate_stages::sql::all;
use gate_words::reference_benches as words;
use serde::{Deserialize, Serialize};

use super::{db, road_of};
use crate::{Answered, Fault};

// How many runs a cell of the sample takes where the caller names no number.
const PER_CELL: usize = 8;

/// The stage the one reference classifier's judgements stand under, which time the before side.
pub const CLASSIFIER: &str = "classifier";

// How far apart, in seconds, a run's end and the judgement that timed it may stand.
const TIMED_WITHIN: i64 = 5;

#[derive(clap::Args, Debug)]
pub struct CompareArgs {
  /// The stored runs, one a line as the run log kept them.
  #[arg(long, allow_hyphen_values = true)]
  runs: Option<String>,
  #[arg(long, allow_hyphen_values = true)]
  per_cell: Option<String>,
  /// Another database's address.
  #[arg(long, allow_hyphen_values = true)]
  db: Option<String>,
  #[arg(long)]
  json: bool,
  #[arg(long, allow_hyphen_values = true)]
  out: Option<String>,
  #[arg(short = 'h', long)]
  help: bool,
}

/// One run the run log kept whole: its room, the moment it ended, the prompt it was given and the answer it gave.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredRun {
  pub chat_id: i64,
  pub ended_at: i64,
  pub prompt: String,
  pub answer: String,
}

/// One judgement's time: its room, when it was made, and what it took.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
  pub chat_id: i64,
  pub at: i64,
  pub ms: i64,
}

/// A stored run cut into what each gate would have been asked, or the slugs that stopped it being cut at all —
/// slugs no gate offers this room any more, since guessing which gate would have held one is how a comparison
/// quietly measures something else.
#[derive(Clone, Debug)]
pub struct CutRun {
  pub run: StoredRun,
  pub message_lines: Vec<String>,
  pub by_gate: Vec<(String, Vec<Candidate>)>,
  pub unattributed: Vec<String>,
}

/// The stored runs a file holds, one JSON object a line.
pub fn stored_runs(text: &str) -> Result<Vec<StoredRun>, Fault> {
  text
    .split('\n')
    .filter(|line| !line.trim().is_empty())
    .map(|line| {
      serde_json::from_str(line)
        .map_err(|why| Fault::failed(format!("reference compare: a stored run does not read: {why}")))
    })
    .collect()
}

/// What each run of one stage cost the front of a turn, as the judgement of that run recorded it.
pub async fn timings(reference: &Reference, stage: &str) -> Result<Vec<Timing>, Fault> {
  let rows = all(
    db(reference),
    r#"SELECT "chat_id", "created_at", "ms" FROM "judgements" WHERE "stage" = $1 AND "ms" IS NOT NULL ORDER BY "created_at""#,
    vec![stage.into()],
  )
  .await
  .map_err(|why| Fault::failed(format!("the gate's database: {why}")))?;

  rows
    .iter()
    .map(|row| {
      Ok(Timing {
        chat_id: row.try_get("", "chat_id")?,
        at: row.try_get("", "created_at")?,
        ms: row.try_get("", "ms")?,
      })
    })
    .collect::<Result<_, sea_orm::DbErr>>()
    .map_err(|why| Fault::failed(format!("the gate's database: {why}")))
}

/// The judgement that timed one run: the one of the same room made nearest to when the run ended, within a few
/// seconds of it. A run with none is counted as unpaired rather than given the time of a turn it was not part of.
pub fn timing_of(run: &StoredRun, timings: &[Timing]) -> Option<i64> {
  let mut nearest: Option<(i64, i64)> = None;

  for timing in timings.iter().filter(|timing| timing.chat_id == run.chat_id) {
    let apart = (timing.at - run.ended_at).abs();

    if apart <= TIMED_WITHIN && nearest.is_none_or(|(_, standing)| apart < standing) {
      nearest = Some((timing.ms, apart));
    }
  }

  nearest.map(|(ms, _)| ms)
}

/// A picker's prompt as it was stored: the index it was offered and the turn's messages.
pub fn read_prompt(prompt: &str) -> Option<(String, Vec<String>)> {
  let rest = prompt.strip_prefix("INDEX:\n")?;
  let (index, messages) = rest.rsplit_once("\n\nMESSAGES:\n")?;

  Some((index.to_owned(), messages.split('\n').map(str::to_owned).collect()))
}

/// A stored run's candidates cut back into the gates that would be asked about them now.
///
/// The stored index is the libraries' index texts joined end to end, and what tells one from another is not where
/// the joins fell but which library offers a slug. So each candidate goes to the gate whose library offers that
/// slug in that room today, and a slug no gate offers any more leaves the run uncut.
pub fn cut_by_gate(
  run: StoredRun,
  offered: &[(String, HashSet<String>)],
  candidates: &[Candidate],
  message_lines: Vec<String>,
) -> CutRun {
  let mut by_gate: Vec<(String, Vec<Candidate>)> =
    offered.iter().map(|(stage, _)| (stage.clone(), vec![])).collect();
  let mut unattributed = vec![];

  for candidate in candidates {
    match offered.iter().position(|(_, slugs)| slugs.contains(&candidate.slug)) {
      Some(place) => by_gate[place].1.push(candidate.clone()),
      None => unattributed.push(candidate.slug.clone()),
    }
  }

  CutRun {
    run,
    message_lines,
    by_gate,
    unattributed,
  }
}

/// The index one gate is offered, written the way an index writes a line.
pub fn index_text_of(candidates: &[Candidate]) -> String {
  candidates
    .iter()
    .map(|candidate| format!("- {} \u{2014} {}", candidate.slug, candidate.about))
    .collect::<Vec<_>>()
    .join("\n")
}

/// How one turn's pick moved: equal sets are equal; otherwise what the two sets are to each other.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SetShape {
  Equal,
  Superset,
  Subset,
  Disjoint,
  Overlapping,
}

impl SetShape {
  const ALL: [SetShape; 5] = [Self::Equal, Self::Superset, Self::Subset, Self::Disjoint, Self::Overlapping];

  fn word(self) -> &'static str {
    match self {
      Self::Equal => "equal",
      Self::Superset => "superset",
      Self::Subset => "subset",
      Self::Disjoint => "disjoint",
      Self::Overlapping => "overlapping",
    }
  }
}

pub fn shape_of(before: &[String], after: &[String]) -> SetShape {
  let was: HashSet<&String> = before.iter().collect();
  let now: HashSet<&String> = after.iter().collect();
  let held = now.iter().filter(|slug| was.contains(*slug)).count();

  if was.len() == now.len() && held == was.len() {
    SetShape::Equal
  } else if held == was.len() {
    SetShape::Superset
  } else if held == now.len() {
    SetShape::Subset
  } else if held == 0 {
    SetShape::Disjoint
  } else {
    SetShape::Overlapping
  }
}

/// An even spread over the cells a sample is to stand for, taken the same way every time it is taken: the runs of
/// one cell in the order the log holds them, every so many.
pub fn spread_sample<T: Clone>(runs: &[T], cell_of: impl Fn(&T) -> String, per_cell: usize) -> Vec<T> {
  let mut cells: BTreeMap<String, Vec<T>> = BTreeMap::new();

  for run in runs {
    cells.entry(cell_of(run)).or_default().push(run.clone());
  }

  let most = per_cell * cells.len();
  let mut taken = vec![];

  for held in cells.values() {
    let step = (held.len() / per_cell).max(1);
    let mut index = 0;

    while index < held.len() && taken.len() < most {
      taken.push(held[index].clone());
      index += step;
    }
  }

  taken
}

/// Which band of candidate counts a run falls in, for spreading a sample over the small indexes and the large ones
/// alike.
pub fn band_of(count: usize) -> &'static str {
  match count {
    0..10 => "07-09",
    10..20 => "10-19",
    _ => "20+",
  }
}

/// What one sampled turn came to, on both sides.
#[derive(Clone, Debug)]
pub struct Compared {
  pub chat_id: i64,
  pub candidates: usize,
  pub before: Before,
  pub after: After,
}

/// The stored side: whether its answer read, what it picked, and what the judgement pairing it took.
#[derive(Clone, Debug)]
pub struct Before {
  pub read: bool,
  pub slugs: Vec<String>,
  pub ms: Option<i64>,
}

/// The side run now: whether every gate's answer read, what they picked, the wall clock of all of them, how many
/// were asked and how many answers did not read.
#[derive(Clone, Debug)]
pub struct After {
  pub read: bool,
  pub slugs: Vec<String>,
  pub ms: i64,
  pub gates: usize,
  pub unread: usize,
}

/// How many turns fell in each set shape.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Shapes {
  pub equal: usize,
  pub superset: usize,
  pub subset: usize,
  pub disjoint: usize,
  pub overlapping: usize,
}

impl Shapes {
  fn add(&mut self, shape: SetShape) {
    *match shape {
      SetShape::Equal => &mut self.equal,
      SetShape::Superset => &mut self.superset,
      SetShape::Subset => &mut self.subset,
      SetShape::Disjoint => &mut self.disjoint,
      SetShape::Overlapping => &mut self.overlapping,
    } += 1;
  }

  fn count(&self, shape: SetShape) -> usize {
    match shape {
      SetShape::Equal => self.equal,
      SetShape::Superset => self.superset,
      SetShape::Subset => self.subset,
      SetShape::Disjoint => self.disjoint,
      SetShape::Overlapping => self.overlapping,
    }
  }

  fn line(&self) -> String {
    SetShape::ALL
      .iter()
      .map(|shape| format!("{} {}", shape.word(), self.count(*shape)))
      .collect::<Vec<_>>()
      .join(" \u{b7} ")
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Spread {
  pub middle: i64,
  pub ninth: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Counts {
  pub least: usize,
  pub middle: usize,
  pub most: usize,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct BeforeFigures {
  pub read: usize,
  pub none: usize,
  pub pieces: usize,
  pub timed: usize,
  pub ms: Option<Spread>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AfterFigures {
  pub read: usize,
  pub none: usize,
  pub pieces: usize,
  pub unread_gates: usize,
  pub gates: usize,
  pub ms: Spread,
}

/// The same tally over the turns where at least one side wanted something, since a turn where both said nothing
/// agrees without saying anything about how the split picks.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Wanting {
  pub runs: usize,
  pub shapes: Shapes,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Figures {
  pub runs: usize,
  pub rooms: usize,
  pub candidates: Counts,
  pub before: BeforeFigures,
  pub after: AfterFigures,
  pub shapes: Shapes,
  pub wanting: Wanting,
}

fn middle_of<T: Copy + Ord + Default>(values: &[T], part: f64) -> T {
  let mut sorted = values.to_vec();

  sorted.sort_unstable();

  if sorted.is_empty() {
    return T::default();
  }

  sorted[((sorted.len() as f64 * part).floor() as usize).min(sorted.len() - 1)]
}

pub fn figures_of(compared: &[Compared]) -> Figures {
  let before_ms: Vec<i64> = compared.iter().filter_map(|one| one.before.ms).collect();
  let after_ms: Vec<i64> = compared.iter().map(|one| one.after.ms).collect();
  let counts: Vec<usize> = compared.iter().map(|one| one.candidates).collect();
  let mut shapes = Shapes::default();
  let mut wanting = Shapes::default();
  let mut wanted = 0;

  for one in compared.iter().filter(|one| one.before.read && one.after.read) {
    let shape = shape_of(&one.before.slugs, &one.after.slugs);

    shapes.add(shape);

    if !one.before.slugs.is_empty() || !one.after.slugs.is_empty() {
      wanting.add(shape);
      wanted += 1;
    }
  }

  let before_read: Vec<&Compared> = compared.iter().filter(|one| one.before.read).collect();
  let after_read: Vec<&Compared> = compared.iter().filter(|one| one.after.read).collect();

  Figures {
    runs: compared.len(),
    rooms: compared.iter().map(|one| one.chat_id).collect::<HashSet<_>>().len(),
    candidates: Counts {
      least: counts.iter().copied().min().unwrap_or_default(),
      middle: middle_of(&counts, 0.5),
      most: counts.iter().copied().max().unwrap_or_default(),
    },
    before: BeforeFigures {
      read: before_read.len(),
      none: before_read.iter().filter(|one| one.before.slugs.is_empty()).count(),
      pieces: before_read.iter().map(|one| one.before.slugs.len()).sum(),
      timed: before_ms.len(),
      ms: (!before_ms.is_empty()).then(|| Spread {
        middle: middle_of(&before_ms, 0.5),
        ninth: middle_of(&before_ms, 0.9),
      }),
    },
    after: AfterFigures {
      read: after_read.len(),
      none: after_read.iter().filter(|one| one.after.slugs.is_empty()).count(),
      pieces: after_read.iter().map(|one| one.after.slugs.len()).sum(),
      unread_gates: compared.iter().map(|one| one.after.unread).sum(),
      gates: compared.iter().map(|one| one.after.gates).sum(),
      ms: Spread {
        middle: middle_of(&after_ms, 0.5),
        ninth: middle_of(&after_ms, 0.9),
      },
    },
    shapes,
    wanting: Wanting {
      runs: wanted,
      shapes: wanting,
    },
  }
}

// What the corpus came to before the gates were asked.
#[derive(Serialize)]
struct Corpus {
  runs: usize,
  unreadable: usize,
  dropped: usize,
  cut: usize,
}

#[derive(Serialize)]
struct Written<'a> {
  corpus: &'a Corpus,
  figures: &'a Figures,
}

pub async fn run(args: CompareArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE_COMPARE.to_owned()]);
  }

  let Some(runs) = args.runs.as_deref() else {
    return Err(Fault::Words(words::COMPARE_NO_RUNS.to_owned()));
  };
  let per_cell = match args.per_cell.as_deref() {
    None => PER_CELL,
    Some(given) => match given.parse::<usize>() {
      Ok(count) if count >= 1 => count,
      _ => return Err(Fault::Words(words::COMPARE_PER_CELL.to_owned())),
    },
  };
  let text = std::fs::read_to_string(runs)
    .map_err(|why| Fault::failed(format!("reference compare: {runs}: {why}")))?;
  let stored = stored_runs(&text)?;
  let (_, reference) = road_of(args.db.as_deref()).await?;

  compare(&reference, &stored, per_cell, args.json, args.out.as_deref().map(Path::new)).await
}

// The three reference gates of a room as they stand today.
async fn offered_in(reference: &Reference, chat_id: i64) -> Result<Vec<road::Gate>, Fault> {
  let mut gates = road::gates_of(reference, chat_id, reference.chat_agent(), true)
    .await
    .map_err(|why| Fault::failed(format!("reference compare: {why}")))?;

  gates.retain(|gate| REFERENCE.gates.iter().any(|declared| declared.stage == gate.stage));

  Ok(gates)
}

/// The stored runs cut, sampled and put to today's gates, as the lines of the figures, or as JSON; written to
/// `out` as JSON where it names a file.
pub async fn compare(
  reference: &Reference,
  runs: &[StoredRun],
  per_cell: usize,
  json: bool,
  out: Option<&Path>,
) -> Answered {
  let timings = timings(reference, CLASSIFIER).await?;
  let mut cut: Vec<CutRun> = vec![];
  let mut unreadable = 0;
  let mut dropped = 0;
  let mut rooms: HashMap<i64, Vec<road::Gate>> = HashMap::new();

  for run in runs {
    if let Entry::Vacant(room) = rooms.entry(run.chat_id) {
      room.insert(offered_in(reference, run.chat_id).await?);
    }
  }

  for run in runs {
    let Some((index, message_lines)) = read_prompt(&run.prompt) else {
      unreadable += 1;
      continue;
    };
    let candidates = pick::index_candidates([index]);
    let offered: Vec<(String, HashSet<String>)> = rooms[&run.chat_id]
      .iter()
      .map(|gate| {
        (
          gate.stage.clone(),
          pick::candidates(&gate.libraries).into_iter().map(|candidate| candidate.slug).collect(),
        )
      })
      .collect();
    let one = cut_by_gate(run.clone(), &offered, &candidates, message_lines);

    if !one.unattributed.is_empty() || one.by_gate.iter().all(|(_, candidates)| candidates.is_empty()) {
      dropped += 1;
      continue;
    }

    cut.push(one);
  }

  let total = |one: &CutRun| one.by_gate.iter().map(|(_, candidates)| candidates.len()).sum::<usize>();
  let sample = spread_sample(&cut, |one| format!("{}:{}", one.run.chat_id, band_of(total(one))), per_cell);
  let counted = |count: usize| count.to_string();

  eprintln!(
    "{}",
    fill_marks(
      words::COMPARE_CORPUS,
      &[
        ("runs", &counted(runs.len())),
        ("unreadable", &counted(unreadable)),
        ("dropped", &counted(dropped)),
        ("cut", &counted(cut.len())),
        ("sample", &counted(sample.len())),
      ],
    )
  );

  let mut compared: Vec<Compared> = vec![];

  for one in &sample {
    let last = asked(reference, one, &rooms[&one.run.chat_id], &timings).await;

    eprintln!(
      "{}",
      fill_marks(
        words::COMPARE_ASKED,
        &[
          ("at", &counted(compared.len() + 1)),
          ("sample", &counted(sample.len())),
          ("chat", &one.run.chat_id.to_string()),
          ("gates", &counted(last.after.gates)),
          ("ms", &last.after.ms.to_string()),
        ],
      )
    );
    compared.push(last);
  }

  let figures = figures_of(&compared);
  let corpus = Corpus {
    runs: runs.len(),
    unreadable,
    dropped,
    cut: cut.len(),
  };
  let written = serde_json::to_string_pretty(&Written {
    corpus: &corpus,
    figures: &figures,
  })
  .unwrap_or_default();

  if let Some(out) = out {
    std::fs::write(out, format!("{written}\n")).map_err(|why| {
      Fault::failed(format!("reference compare: {} could not be written: {why}", out.display()))
    })?;
    eprintln!("{}", fill_marks(words::COMPARE_WRITTEN, &[("out", &out.to_string_lossy())]));
  }

  if json {
    return Ok(vec![written]);
  }

  Ok(figure_lines(&corpus, &figures))
}

// One sampled turn put to the gates its candidates fall to, side by side as a turn sends them, so what is measured
// is what a turn waits.
async fn asked(reference: &Reference, one: &CutRun, gates: &[road::Gate], timings: &[Timing]) -> Compared {
  let asked: Vec<(&road::Gate, &Vec<Candidate>)> = one
    .by_gate
    .iter()
    .filter(|(_, candidates)| !candidates.is_empty())
    .filter_map(|(stage, candidates)| {
      gates.iter().find(|gate| gate.stage == *stage).map(|gate| (gate, candidates))
    })
    .collect();
  let started = std::time::Instant::now();
  let answers = join_all(asked.iter().map(|(gate, candidates)| async move {
    let request = pick::picker_request(&gate.system, &index_text_of(candidates), &one.message_lines);

    match reference.stages.runs.run(&gate.stage, &request).await {
      Ok(answer) => answer,
      Err(why) => {
        eprintln!("reference compare: {} gave no answer: {why}", gate.stage);
        None
      }
    }
  }))
  .await;
  let ms = started.elapsed().as_millis() as i64;
  let mut slugs = vec![];
  let mut unread = 0;

  for ((_, candidates), answer) in asked.iter().zip(answers) {
    let offered: Vec<String> = candidates.iter().map(|candidate| candidate.slug.clone()).collect();

    match answer.and_then(|answer| pick::parse_verdicts(&answer, &offered)) {
      Some(verdicts) => slugs.extend(verdicts.into_iter().filter(|(_, yes)| *yes).map(|(slug, _)| slug)),
      None => unread += 1,
    }
  }

  let before = pick::parse_selection(&one.run.answer);

  Compared {
    chat_id: one.run.chat_id,
    candidates: one.by_gate.iter().map(|(_, candidates)| candidates.len()).sum(),
    before: Before {
      read: before.is_some(),
      slugs: before.map(|before| before.slugs).unwrap_or_default(),
      ms: timing_of(&one.run, timings),
    },
    after: After {
      read: unread == 0,
      slugs,
      ms,
      gates: asked.len(),
      unread,
    },
  }
}

// The figures as the lines a person reads.
fn figure_lines(corpus: &Corpus, figures: &Figures) -> Vec<String> {
  let share = |part: usize, whole: usize| {
    if whole == 0 {
      "\u{2014}".to_owned()
    } else {
      format!("{}%", ((part as f64 / whole as f64) * 100.0).round())
    }
  };
  let per = |part: usize, whole: usize| {
    if whole == 0 {
      "\u{2014}".to_owned()
    } else {
      format!("{:.2}", part as f64 / whole as f64)
    }
  };
  let ms = |spread: Option<Spread>, of: fn(&Spread) -> i64| {
    spread.as_ref().map_or_else(|| "\u{2014}".to_owned(), |spread| of(spread).to_string())
  };

  vec![
    fill_marks(
      words::COMPARE_SAMPLE,
      &[
        ("runs", &figures.runs.to_string()),
        ("rooms", &figures.rooms.to_string()),
        ("least", &figures.candidates.least.to_string()),
        ("most", &figures.candidates.most.to_string()),
        ("middle", &figures.candidates.middle.to_string()),
      ],
    ),
    fill_marks(
      words::COMPARE_SIFTED,
      &[
        ("runs", &corpus.runs.to_string()),
        ("unreadable", &corpus.unreadable.to_string()),
        ("dropped", &corpus.dropped.to_string()),
        ("cut", &corpus.cut.to_string()),
      ],
    ),
    fill_marks(
      words::COMPARE_PIECES,
      &[
        ("before", &per(figures.before.pieces, figures.before.read)),
        ("after", &per(figures.after.pieces, figures.after.read)),
      ],
    ),
    fill_marks(
      words::COMPARE_NONE,
      &[
        ("before", &share(figures.before.none, figures.before.read)),
        ("after", &share(figures.after.none, figures.after.read)),
      ],
    ),
    fill_marks(
      words::COMPARE_UNREAD,
      &[
        ("before", &share(figures.runs - figures.before.read, figures.runs)),
        ("after", &share(figures.after.unread_gates, figures.after.gates)),
      ],
    ),
    fill_marks(words::COMPARE_SHAPES, &[("shapes", &figures.shapes.line())]),
    fill_marks(
      words::COMPARE_WANTING,
      &[("runs", &figures.wanting.runs.to_string()), ("shapes", &figures.wanting.shapes.line())],
    ),
    fill_marks(
      words::COMPARE_FRONT,
      &[
        ("before_middle", &ms(figures.before.ms, |spread| spread.middle)),
        ("before_ninth", &ms(figures.before.ms, |spread| spread.ninth)),
        ("timed", &figures.before.timed.to_string()),
        ("after_middle", &figures.after.ms.middle.to_string()),
        ("after_ninth", &figures.after.ms.ninth.to_string()),
      ],
    ),
  ]
}
