//! One picker's turn (`docs/reference-selection.md`, 「What the three reference gates are asked, and what they
//! answer」): a gate over the index of its libraries, asked of its model with Laya beside it as its mode says, or
//! of Laya alone where its road is Laya; its answer read against the candidates it was offered, the pieces it named
//! read through the library each stands in within its allowance, and its own index handed over where it gave no
//! reading. Every judgement and each candidate's verdict is written down as it comes.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::reference::REFERENCE;
use gate_ports::brain::Reply as Read;
use gate_runs::records::{self, Judgement};
use gate_runs::{GateError, GateRequest, route};
use gate_stages::laya::{self, LayaRun, NONE_LABEL, PairKept, Probe, Question, Reading, Reply, Request};
use gate_stages::ordered::Ordered;
use regex::Regex;
use sea_orm::DatabaseConnection;

use crate::fragments::{self, Fragment, Verdict, index_entries, index_line};
use crate::{Entry, Reference, Source};

/// Where a library's bodies are read: a shipped piece's under the folder the deployment places the shipped pieces
/// in, by its row's path; a knowledge chunk's and a room rule's through the brain's knowledge read; a lore piece's
/// through the brain's lore read; a person-book piece's through the brain's person-book read; a memory's from the
/// row itself, which the brain already answered whole.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Body {
  Shipped,
  Knowledge,
  Lore,
  People,
  Memory,
}

/// One library of a gate for one turn: the index its gate reads, written out of its rows in their order, and
/// what each slug resolves to.
#[derive(Clone, Debug)]
pub struct Library {
  pub index_path: String,
  pub rows: Vec<Fragment>,
  pub source: Source,
  pub body: Body,
}

impl Library {
  /// A library of these rows, or none where there are none.
  pub fn of(index_path: String, rows: Vec<Fragment>, source: Source, body: Body) -> Option<Self> {
    (!rows.is_empty()).then_some(Self {
      index_path,
      rows,
      source,
      body,
    })
  }

  /// The same library holding only some of its rows.
  pub fn with(&self, keep: impl Fn(&Fragment) -> bool) -> Option<Self> {
    Self::of(
      self.index_path.clone(),
      self.rows.iter().filter(|row| keep(row)).cloned().collect(),
      self.source,
      self.body,
    )
  }

  pub fn index_text(&self) -> String {
    self.rows.iter().map(index_line).collect::<Vec<_>>().join("\n")
  }

  // The row a slug names, the last of the library's rows under it.
  fn row(&self, slug: &str) -> Option<&Fragment> {
    self.rows.iter().rev().find(|row| row.slug == slug)
  }

  /// The path a slug's body is read by, or none where the slug is not this library's to give out.
  pub fn resolve(&self, slug: &str) -> Option<String> {
    self.row(slug).map(|row| row.path.clone())
  }
}

/// One candidate as a gate is offered it: its slug and what its index line says of it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
  pub slug: String,
  pub about: String,
}

/// The candidates some libraries offer, a slug offered twice being the first one.
pub fn candidates(libraries: &[Library]) -> Vec<Candidate> {
  index_candidates(libraries.iter().map(Library::index_text))
}

/// The candidates some index texts offer, in their order, a slug offered twice being the first one.
pub fn index_candidates(indexes: impl IntoIterator<Item = String>) -> Vec<Candidate> {
  let mut found: Vec<Candidate> = vec![];

  for index in indexes {
    for entry in index_entries(&index) {
      if !found.iter().any(|candidate| candidate.slug == entry.slug) {
        found.push(Candidate {
          slug: entry.slug,
          about: entry.title,
        });
      }
    }
  }

  found
}

/// One candidate some libraries offer, with the body its slug resolves to, or none where no library gives one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Offered {
  pub slug: String,
  pub about: String,
  pub path: Option<String>,
}

/// Every candidate some libraries offer, each resolved by the first library that gives out its body — the whole
/// of what a road hands a picker before a model has said anything.
pub fn offered(libraries: &[Library]) -> Vec<Offered> {
  candidates(libraries)
    .into_iter()
    .map(|candidate| Offered {
      path: libraries.iter().find_map(|library| library.resolve(&candidate.slug)),
      slug: candidate.slug,
      about: candidate.about,
    })
    .collect()
}

/// What a picker chose: nothing, or these slugs, with what it said of each candidate where it answered for
/// every one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Selection {
  pub none: bool,
  pub slugs: Vec<String>,
  pub answers: Option<Vec<(String, bool)>>,
}

impl Selection {
  /// A selection of nothing.
  pub fn nothing() -> Self {
    Self {
      none: true,
      slugs: vec![],
      answers: None,
    }
  }
}

static ANSWER_LINE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!(r"(?i)^([a-z0-9-]+)(?:[{0}]*:[{0}]*|[{0}]+)(yes|no)$", js::SPACE))
    .expect("an answer line")
});
static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z0-9-]+$").expect("a slug"));

fn answer_lines(answer: &str) -> Vec<&str> {
  answer.split('\n').map(js::trim).filter(|line| !line.is_empty()).collect()
}

/// A reference gate's answer read against the candidates it was offered: every one with what was said of it,
/// or none where the answer does not cover exactly them.
pub fn parse_verdicts(answer: &str, candidates: &[String]) -> Option<Vec<(String, bool)>> {
  let mut read: Vec<(String, bool)> = vec![];

  for line in answer_lines(answer) {
    let found = ANSWER_LINE.captures(line)?;
    let slug = found[1].to_owned();

    if !candidates.contains(&slug) || read.iter().any(|(seen, _)| *seen == slug) {
      return None;
    }

    read.push((slug, found[2].eq_ignore_ascii_case("yes")));
  }

  let offered: std::collections::HashSet<&String> = candidates.iter().collect();

  (read.len() == offered.len()).then_some(read)
}

/// Every candidate's verdict as a selection.
pub fn selection_of(verdicts: Option<Vec<(String, bool)>>) -> Option<Selection> {
  let verdicts = verdicts?;
  let slugs: Vec<String> = verdicts.iter().filter(|(_, yes)| *yes).map(|(slug, _)| slug.clone()).collect();

  Some(Selection {
    none: slugs.is_empty(),
    slugs,
    answers: Some(verdicts),
  })
}

/// A picker's answer in either shape it is written in: a verdict per candidate, or a list of slugs or the
/// word for none.
pub fn parse_selection(answer: &str) -> Option<Selection> {
  let lines = answer_lines(answer);

  if lines.len() == 1 && lines[0].to_lowercase() == "none" {
    return Some(Selection::nothing());
  }

  if lines.is_empty() {
    return None;
  }

  let verdicts: Option<Vec<regex::Captures<'_>>> =
    lines.iter().map(|line| ANSWER_LINE.captures(line)).collect();

  if let Some(verdicts) = verdicts {
    let mut answers: Vec<(String, bool)> = vec![];

    for found in verdicts {
      let yes = found[2].eq_ignore_ascii_case("yes");

      match answers.iter_mut().find(|(slug, _)| *slug == found[1]) {
        Some(standing) => standing.1 = yes,
        None => answers.push((found[1].to_owned(), yes)),
      }
    }

    let slugs: Vec<String> = answers.iter().filter(|(_, yes)| *yes).map(|(slug, _)| slug.clone()).collect();

    return Some(Selection {
      none: slugs.is_empty(),
      slugs,
      answers: Some(answers),
    });
  }

  lines.iter().all(|line| SLUG.is_match(line)).then(|| Selection {
    none: false,
    slugs: lines.iter().map(|line| (*line).to_owned()).collect(),
    answers: None,
  })
}

/// The person book's search's answer with what it named among the candidates marked as named.
pub fn named_of(selection: Option<Selection>, candidates: &[String]) -> Option<Selection> {
  let selection = selection?;
  let mut answers: Vec<(String, bool)> = vec![];

  for slug in selection.slugs.iter().filter(|slug| candidates.contains(slug)) {
    if !answers.iter().any(|(seen, _)| seen == slug) {
      answers.push((slug.clone(), true));
    }
  }

  Some(Selection {
    answers: Some(answers),
    ..selection
  })
}

/// Whether a picker thinks: picking slugs out of an index needs no thinking.
pub const THINKS: bool = false;

/// The request a picker's model is asked: its instructions, the index, the turn's lines, and its answer file
/// closing them where it has one.
pub fn picker_request(system: &str, answer: &str, index: &str, message_lines: &[String]) -> GateRequest {
  let mut lines = vec!["INDEX:".to_owned(), index.to_owned(), String::new(), "MESSAGES:".to_owned()];

  lines.extend(message_lines.iter().cloned());

  if !answer.is_empty() {
    lines.extend([String::new(), answer.to_owned()]);
  }

  let mut request = GateRequest::new(system, lines.join("\n"));

  request.thinking = THINKS;
  request
}

/// One turn as Laya asks a picker's question.
#[derive(Clone, Debug)]
pub struct Asked {
  pub message_lines: Vec<String>,
  pub candidates: Vec<Candidate>,
}

/// A picker as Laya asks it: for each candidate, whether this turn needs it, in the words its gate's own
/// question fixes; each candidate settled on its own.
#[derive(Clone, Debug)]
pub struct ReferenceProbe {
  pub question: String,
  pub subject: String,
}

impl Probe for ReferenceProbe {
  type Input = Asked;
  type Verdict = Selection;

  fn question(&self, input: &Asked) -> Result<Request, laya::Failure> {
    let lines = laya::fit_messages(&input.message_lines, |kept| Ordered::text(kept.join("\n")));

    Ok(Request {
      state: Ordered::text(lines.join("\n")),
      questions: input
        .candidates
        .iter()
        .map(|candidate| {
          (
            candidate.slug.clone(),
            laya::fit_question(Question::Noul {
              instructions: format!(
                "{} {} {}: {}",
                self.question, self.subject, candidate.slug, candidate.about
              ),
            }),
          )
        })
        .collect(),
    })
  }

  fn read(&self, reply: &Reply) -> Result<Reading, laya::Failure> {
    let members: Vec<(String, String)> =
      reply.answers.iter().map(|(id, _)| (id.clone(), id.clone())).collect();

    laya::set_reading(reply, &members)
  }

  fn verdict_of(&self, label: &str) -> Option<Selection> {
    Some(if label == NONE_LABEL {
      Selection::nothing()
    } else {
      Selection {
        none: false,
        slugs: label.split(',').map(str::to_owned).collect(),
        answers: None,
      }
    })
  }

  fn label_of(&self, selection: &Selection) -> String {
    laya::set_label(if selection.none { &[] } else { &selection.slugs })
  }

  fn truth_of(&self, label: &str, request: &Request) -> Option<Ordered> {
    let chosen: Vec<&str> = if label == NONE_LABEL { vec![] } else { label.split(',').collect() };

    Some(Ordered::map(
      request
        .questions
        .iter()
        .map(|(slug, _)| (slug.clone(), Ordered::Flag(chosen.contains(&slug.as_str())))),
    ))
  }

  fn safe_label(&self) -> Option<&str> {
    None
  }

  fn narrow(&self, input: &Asked, ids: &[String]) -> Option<Asked> {
    Some(Asked {
      message_lines: input.message_lines.clone(),
      candidates: input
        .candidates
        .iter()
        .filter(|candidate| ids.contains(&candidate.slug))
        .cloned()
        .collect(),
    })
  }

  fn join(&self, laya: Selection, llm: Selection) -> Selection {
    let mut slugs = laya.slugs.clone();

    for slug in llm.slugs {
      if !slugs.contains(&slug) {
        slugs.push(slug);
      }
    }

    let answers = match (laya.answers, llm.answers) {
      (None, None) => None,
      (left, right) => {
        let mut joined = left.unwrap_or_default();

        for (slug, said) in right.unwrap_or_default() {
          match joined.iter_mut().find(|(seen, _)| *seen == slug) {
            Some(standing) => standing.1 = said,
            None => joined.push((slug, said)),
          }
        }

        Some(joined)
      }
    };

    Selection {
      none: slugs.is_empty(),
      slugs,
      answers,
    }
  }
}

/// A gate's raw answer as a verdict line: its first line, cut to what fits in a list.
pub fn verdict_line(answer: &str) -> String {
  records::verdict_line(answer, 200)
}

/// The verdict line of one run of a gate's model (`docs/gates.md`, 「What a turn records」): what it read, as
/// `read` writes it; the keyword for an answer not in the shape it was asked for; the keyword for no answer. The
/// answer itself is the judgement's detail, never its verdict.
pub fn run_verdict<T>(answer: Option<&str>, parsed: Option<&T>, read: impl FnOnce(&T) -> String) -> String {
  let words = &REFERENCE.verdicts;

  match (answer, parsed) {
    (None, _) => words.no_answer.clone(),
    (Some(_), None) => words.unreadable.clone(),
    (Some(_), Some(parsed)) => read(parsed),
  }
}

/// A selection's verdict line: the slugs it named after their keyword, or the keyword for nothing.
pub fn selection_verdict(selection: &Selection) -> String {
  let words = &REFERENCE.verdicts;

  if selection.none || selection.slugs.is_empty() {
    words.nothing.clone()
  } else {
    verdict_line(&format!("{}: {}", words.picked, selection.slugs.join(", ")))
  }
}

/// How a picker reads its model's answer: the strict verdict per candidate, or the slugs it named.
#[derive(Clone, Copy, Debug)]
pub enum Reads {
  Verdicts,
  Named,
}

impl Reads {
  fn read(self, answer: &str, candidates: &[String]) -> Option<Selection> {
    match self {
      Self::Verdicts => selection_of(parse_verdicts(answer, candidates)),
      Self::Named => named_of(parse_selection(answer), candidates),
    }
  }
}

/// What one picker is: the room, the agent and the round it picks for, the gate it runs as, its instructions and
/// the answer file its request closes on, its libraries, the turn's lines it reads, how its answer is read, the
/// most slugs and characters it takes, its Laya probe, and whether it writes down what it judged — a picker over
/// work whose words are kept nowhere writes nothing of them.
pub struct Picker {
  pub chat_id: i64,
  pub message_id: Option<i64>,
  pub agent: String,
  pub round: Option<String>,
  pub stage: String,
  pub system: String,
  pub answer: String,
  pub libraries: Vec<Library>,
  pub message_lines: Vec<String>,
  pub reads: Reads,
  pub cap: Option<usize>,
  pub budget: Option<usize>,
  pub probe: ReferenceProbe,
  pub records: bool,
}

/// What a picker came back with: the pieces it resolved, and the slugs it wanted with the row behind each.
#[derive(Clone, Debug)]
pub struct Picked {
  pub stage: String,
  pub entries: Vec<Entry>,
  pub wanted: Vec<(String, Option<i64>)>,
}

impl Picked {
  pub fn nothing(stage: &str) -> Self {
    Self {
      stage: stage.to_owned(),
      entries: vec![],
      wanted: vec![],
    }
  }
}

// One side of what a run answered about each candidate, written as it comes.
async fn keep(db: &DatabaseConnection, picker: &Picker, laya_side: bool, answers: &[(String, bool)]) {
  let rows: Vec<Verdict> = answers
    .iter()
    .map(|(slug, said)| Verdict {
      stage: picker.stage.clone(),
      chat_id: picker.chat_id,
      message_id: picker.message_id,
      slug: slug.clone(),
      llm: (!laya_side).then_some(*said),
      laya: laya_side.then_some(*said),
      attached: None,
    })
    .collect();

  fragments::record_verdicts(db, &rows).await;
}

fn fallback(chat_id: i64, libraries: &[Library], reason: &str) -> Vec<Entry> {
  eprintln!("reference: chat {chat_id} falling back to the indexes ({reason})");

  libraries
    .iter()
    .map(|library| Entry {
      path: library.index_path.clone(),
      text: library.index_text(),
      source: library.source,
      fragment: None,
    })
    .collect()
}

/// Whose bodies are read: the agent the brain reads them for, the room, and the gate that asks, which a failure is
/// said under.
pub struct Reader<'a> {
  pub agent: &'a str,
  pub chat_id: i64,
  pub stage: &'a str,
}

/// The bodies of some slugs, each by the library of `libraries` it stands in — a shipped piece under the shipped
/// folder, a person as their sheet in the room held to its ceiling, a memory as the row carries it, any other
/// through the brain — as its path and its text, none for a slug whose body could not be read or is empty.
pub async fn read_bodies(
  reference: &Reference,
  reader: &Reader<'_>,
  libraries: &[Library],
  slugs: &[String],
) -> HashMap<String, (String, String)> {
  let mut read: HashMap<String, (String, String)> = HashMap::new();
  let mut knowledge = vec![];
  let mut lore = vec![];
  let mut people = vec![];

  for slug in slugs {
    let Some((library, row)) =
      libraries.iter().find_map(|library| library.row(slug).map(|row| (library, row)))
    else {
      continue;
    };

    match library.body {
      Body::Shipped => {
        let text = reference
          .shipped
          .as_ref()
          .and_then(|root| std::fs::read_to_string(root.join(&row.path)).ok())
          .map(|text| js::trim(&text).to_owned())
          .unwrap_or_default();

        if !text.is_empty() {
          read.insert(slug.clone(), (row.path.clone(), text));
        }
      }
      Body::Knowledge => knowledge.push(slug.clone()),
      Body::Lore => lore.push(slug.clone()),
      Body::People => {
        if let Some(owner) = row.owner {
          people.push((slug.clone(), owner));
        }
      }
      Body::Memory => {
        if let Some(text) = row.body.as_ref().filter(|text| !text.is_empty()) {
          read.insert(slug.clone(), (row.path.clone(), text.clone()));
        }
      }
    }
  }

  let (agent, chat_id, stage) = (reader.agent, reader.chat_id, reader.stage);

  if !knowledge.is_empty() {
    match reference.brain.knowledge(agent, chat_id, &knowledge).await {
      Ok(Read::Answered(documents)) => {
        read.extend(documents.into_iter().map(|document| (document.slug, (document.path, document.text))));
      }
      Ok(Read::Refused(refusal)) => {
        eprintln!("reference: chat {chat_id} {stage} pieces were refused: {}", refusal.message)
      }
      Err(why) => eprintln!("reference: chat {chat_id} {stage} pieces could not be read: {why}"),
    }
  }

  if !lore.is_empty() {
    match reference.brain.lore(agent, &lore).await {
      Ok(documents) => {
        read.extend(documents.into_iter().map(|document| (document.slug, (document.path, document.text))));
      }
      Err(why) => eprintln!("reference: chat {chat_id} {stage} lore pieces could not be read: {why}"),
    }
  }

  if !people.is_empty() {
    let owners: Vec<i64> = people.iter().map(|(_, owner)| *owner).collect();

    match reference.brain.sheets(agent, chat_id, &owners, None).await {
      Ok(sheets) => {
        for sheet in sheets {
          let text = crate::road::held_sheet(&sheet.text);
          let Some((slug, _)) = people.iter().find(|(_, owner)| *owner == sheet.person) else {
            continue;
          };

          if !text.is_empty() {
            read.insert(slug.clone(), (sheet.path, text));
          }
        }
      }
      Err(why) => eprintln!("reference: chat {chat_id} {stage} sheets could not be read: {why}"),
    }
  }

  read
}

/// One picker's whole turn: its gate asked, its judgement written, and what came back read through its own
/// libraries; its indexes where it gave no reading, nothing where it wanted nothing. A stop is raised.
pub async fn pick(reference: &Reference, picker: Picker) -> Result<Picked, GateError> {
  let stages = &reference.stages;
  let db = &stages.runs.db;
  let offered = candidates(&picker.libraries);
  let missed = Arc::new(std::sync::Mutex::new(format!("{} gave no selection", picker.stage)));
  let picker = Arc::new(picker);
  // The gate's own model, asked about the candidates it is handed — on Laya's road, as the fallback LLM its row
  // names.
  let ask = |question: Asked, fallback: bool| {
    let (picker, missed) = (picker.clone(), missed.clone());

    async move {
      let slugs: Vec<String> = question.candidates.iter().map(|candidate| candidate.slug.clone()).collect();
      let whole = slugs.len() == candidates(&picker.libraries).len();
      let index = picker
        .libraries
        .iter()
        .filter_map(|library| {
          if whole {
            Some(library.clone())
          } else {
            library.with(|row| slugs.contains(&row.slug))
          }
        })
        .map(|library| library.index_text())
        .collect::<Vec<_>>()
        .join("\n\n");
      let started = std::time::Instant::now();
      let mut request = picker_request(&picker.system, &picker.answer, &index, &picker.message_lines);

      request.chat_id = Some(picker.chat_id);
      request.message_id = picker.message_id;
      request.agent = Some(picker.agent.clone());
      request.round = picker.round.clone();
      request.laya_fallback = fallback;

      let answer = stages.runs.run(&picker.stage, &request).await?;
      let ms = started.elapsed().as_millis() as i64;
      let parsed = answer.as_deref().and_then(|answer| picker.reads.read(answer, &slugs));

      if picker.records {
        let verdict = run_verdict(answer.as_deref(), parsed.as_ref(), selection_verdict);

        records::judgement(
          db,
          &Judgement {
            chat_id: picker.chat_id,
            message_id: picker.message_id,
            stage: &picker.stage,
            verdict: &verdict,
            detail: answer.as_deref(),
            ms: Some(ms),
            round: picker.round.as_deref(),
          },
        )
        .await;
      }

      match (&answer, &parsed) {
        (None, _) => {
          *missed.lock().expect("why it missed") = format!("{} failed or timed out", picker.stage)
        }
        (Some(answer), None) => {
          let shown = js::chars(js::trim(answer));

          *missed.lock().expect("why it missed") = format!(
            "{} gave an unreadable answer: {}",
            picker.stage,
            js::text(&shown[..js::within(&shown, 200)])
          );
        }
        _ => {}
      }

      if let Some(answers) = parsed.as_ref().and_then(|parsed| parsed.answers.as_ref())
        && picker.records
      {
        keep(db, &picker, false, answers).await;
      }

      Ok(parsed)
    }
  };
  // Laya's side of each candidate's row, out of the pair its answer is kept as.
  let kept: PairKept = {
    let (db, picker) = (db.clone(), picker.clone());

    Arc::new(move |label, request| {
      let (db, picker) = (db.clone(), picker.clone());

      Box::pin(async move {
        let (Some(label), Some(request)) = (label, request) else { return };
        let Some(Ordered::Map(truth)) = picker.probe.truth_of(&label, &request) else { return };
        let answers: Vec<(String, bool)> = truth
          .into_iter()
          .filter_map(|(slug, said)| match said {
            Ordered::Flag(said) => Some((slug, said)),
            _ => None,
          })
          .collect();

        keep(&db, &picker, true, &answers).await;
      })
    })
  };
  let run = LayaRun {
    kept: picker.records.then_some(kept),
    keeps_pairs: picker.records,
    ..LayaRun::of(&picker.stage, Some(picker.chat_id), picker.message_id)
  };
  let input = Asked {
    message_lines: picker.message_lines.clone(),
    candidates: offered.clone(),
  };
  let selection = if route::read(&stages.runs, &picker.stage).await?.laya {
    let started = std::time::Instant::now();
    let decided =
      laya::judge_on_laya(stages, &run, &picker.probe, &input, Selection::nothing(), |question| {
        ask(question, true)
      })
      .await?;
    let failure = decided.failure_said();
    let detail = match decided.decided_by {
      laya::DecidedBy::Laya => "Laya".to_owned(),
      laya::DecidedBy::Llm => fill_marks(&REFERENCE.decided.by_fallback, &[("failure", &failure)]),
      laya::DecidedBy::Default => fill_marks(&REFERENCE.decided.nothing_attached, &[("failure", &failure)]),
    };
    let verdict = selection_verdict(&decided.verdict);

    if picker.records {
      records::judgement(
        db,
        &Judgement {
          chat_id: picker.chat_id,
          message_id: picker.message_id,
          stage: &picker.stage,
          verdict: &verdict,
          detail: Some(&detail),
          ms: Some(started.elapsed().as_millis() as i64),
          round: picker.round.as_deref(),
        },
      )
      .await;
    }

    Some(decided.verdict)
  } else {
    laya::judge_with_laya(stages, &run, &picker.probe, &input, |question| ask(question, false)).await?
  };
  let missed = missed.lock().expect("why it missed").clone();

  let Some(selection) = selection else {
    return Ok(Picked {
      stage: picker.stage.clone(),
      entries: fallback(picker.chat_id, &picker.libraries, &missed),
      wanted: vec![],
    });
  };

  if selection.none {
    println!("reference: chat {} {} selected none", picker.chat_id, picker.stage);
    return Ok(Picked::nothing(&picker.stage));
  }

  let mut entries = vec![];
  let mut wanted = vec![];
  let mut spent = 0;
  let taken = picker.cap.map_or(selection.slugs.len(), |cap| cap.min(selection.slugs.len()));
  let reader = Reader {
    agent: &picker.agent,
    chat_id: picker.chat_id,
    stage: &picker.stage,
  };
  let read = read_bodies(reference, &reader, &picker.libraries, &selection.slugs[..taken]).await;

  for slug in &selection.slugs[..taken] {
    let row = picker.libraries.iter().find_map(|library| library.row(slug));

    wanted.push((slug.clone(), row.map(|row| row.id)));

    let Some(from) = picker.libraries.iter().find(|library| library.row(slug).is_some()) else {
      eprintln!(
        "reference: chat {} {} named unknown chunk {slug}, dropping it",
        picker.chat_id, picker.stage
      );
      continue;
    };
    let Some((found, text)) = read.get(slug).cloned() else { continue };

    if text.is_empty() {
      continue;
    }

    let size = js::units(&text);

    if picker.budget.is_some_and(|budget| spent + size > budget) {
      eprintln!(
        "reference: chat {} {} picked {found} at {size} characters, which does not fit what is left of its {}; passing it over",
        picker.chat_id,
        picker.stage,
        picker.budget.unwrap_or_default()
      );
      continue;
    }

    spent += size;
    entries.push(Entry {
      path: found,
      text,
      source: from.source,
      fragment: row.map(|row| row.id),
    });
  }

  if entries.is_empty() {
    let reason = format!("no chunk {} selected exists or fits", picker.stage);

    return Ok(Picked {
      stage: picker.stage.clone(),
      entries: fallback(picker.chat_id, &picker.libraries, &reason),
      wanted,
    });
  }

  Ok(Picked {
    stage: picker.stage.clone(),
    entries,
    wanted,
  })
}
