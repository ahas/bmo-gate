//! `reference waste` (docs/reference-selection.md, 「What it picks and what it costs, measured」): for every document
//! the reference gates attached, how often it attached, how often the answer used it, and how many tokens it carried
//! for nothing.
//!
//! What reached a turn's prompt is the verdict record's; whether the answer used it is the use judge's, run by the
//! training tooling over the same turns into the folder named here (docs/reference-data.md). A piece the answer did
//! not use — judged `related` or `unused` — was carried for nothing, and its body's size, read where the live road
//! reads it, is what it cost the turn. The gate stage's time is the judgement record's. A turn's own prompt is the
//! usage record's, which no unit keeps. No model is asked and nothing is written.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};

use chrono::{FixedOffset, NaiveDate, TimeZone};
use gate_markup::js;
use gate_reference::Reference;
use gate_reference::pick::{Reader, read_bodies};
use gate_reference::road;
use gate_stages::sql::all;
use gate_words::reference_benches as words;
use indexmap::IndexMap;
use serde::Serialize;

use super::{count, counted_gates, db, js_number, misread, road_of};
use crate::{Answered, Fault};

// How many pieces the table shows where the caller names no number.
const TOP: usize = 25;

// Characters of text per token, as a turn's prompt counts them: the pieces are English with Korean kept in them,
// which the tokenizer reads at about three characters a token.
const CHARS_PER_TOKEN: f64 = 3.0;

// The offset of the day a `--since` names, in hours east of UTC: the owner's time.
const OWNER_OFFSET_HOURS: i32 = 9;

#[derive(clap::Args, Debug)]
pub struct WasteArgs {
  /// Another database's address.
  #[arg(long, allow_hyphen_values = true)]
  db: Option<String>,
  /// The use judge's turns.
  #[arg(long = "use", allow_hyphen_values = true)]
  use_path: Option<String>,
  #[arg(long, allow_hyphen_values = true)]
  since: Option<String>,
  #[arg(long, allow_hyphen_values = true)]
  top: Option<String>,
  #[arg(long)]
  json: bool,
  #[arg(short = 'h', long)]
  help: bool,
}

/// Where the use judge's turns stand under a data root where the caller names no file.
pub fn use_turns(data_root: &Path) -> PathBuf {
  data_root.join("reference-use").join("use-1").join("turns.jsonl")
}

/// What the use judge said of each attached piece, by turn, gate and slug.
#[derive(Default)]
pub struct Labels(HashMap<(String, String, String), String>);

#[derive(serde::Deserialize)]
struct JudgedTurn {
  id: String,
  candidates: Vec<JudgedCandidate>,
}

#[derive(serde::Deserialize)]
struct JudgedCandidate {
  gate: String,
  slug: String,
  attached: bool,
  label: Option<String>,
}

impl Labels {
  /// The labels the use judge's turns hold of every attached piece; none where the file is not there.
  pub fn read(path: &Path) -> Result<Self, Fault> {
    let Ok(text) = std::fs::read_to_string(path) else {
      return Ok(Self::default());
    };

    Self::of(&text)
  }

  /// The labels a judge's turns hold of every attached piece.
  pub fn of(text: &str) -> Result<Self, Fault> {
    let mut labels = HashMap::new();

    for line in text.split('\n').filter(|line| !line.trim().is_empty()) {
      let turn: JudgedTurn = serde_json::from_str(line)
        .map_err(|why| Fault::failed(format!("reference waste: a judged turn does not read: {why}")))?;

      for candidate in turn.candidates {
        if let (true, Some(label)) = (candidate.attached, candidate.label) {
          labels.insert((turn.id.clone(), candidate.gate, candidate.slug), label);
        }
      }
    }

    Ok(Self(labels))
  }

  fn of_piece(&self, turn: &str, gate: &str, slug: &str) -> Option<&str> {
    self.0.get(&(turn.to_owned(), gate.to_owned(), slug.to_owned())).map(String::as_str)
  }
}

/// One piece's attachments and what the judge said of them: the tokens they carried in all, and the share of them
/// the judge found unused.
#[derive(Clone, Debug, Serialize)]
pub struct Piece {
  pub stage: String,
  pub slug: String,
  pub attached: usize,
  pub judged: usize,
  pub used: usize,
  pub related: usize,
  pub unused: usize,
  pub chars: usize,
  #[serde(serialize_with = "as_js")]
  pub tokens: f64,
  #[serde(serialize_with = "as_js")]
  pub wasted: f64,
}

fn as_js<S: serde::Serializer>(value: &f64, to: S) -> Result<S::Ok, S::Error> {
  js_number(*value).serialize(to)
}

#[derive(Serialize)]
struct Asked {
  stage: String,
  turns: i64,
}

#[derive(Serialize)]
struct Timing {
  gate: String,
  runs: usize,
  middle: i64,
  tail: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
  turns: i64,
  asked: Vec<Asked>,
  carried_tokens: i64,
  wasted_tokens: i64,
  wasted_per_turn: i64,
  gate_waste: IndexMap<String, serde_json::Number>,
  timing: Vec<Timing>,
}

pub async fn run(args: WasteArgs) -> Answered {
  let usage = words::USAGE_WASTE;

  if args.help {
    return Ok(vec![usage.to_owned()]);
  }

  let since = match args.since.as_deref() {
    None => 0,
    Some(given) => day_start(given).ok_or_else(|| misread(usage))?,
  };
  let top = count(args.top.as_deref(), TOP, usage)?;
  let (settings, reference) = road_of(args.db.as_deref()).await?;
  let labels = Labels::read(&args.use_path.map_or_else(|| use_turns(&settings.data_root), PathBuf::from))?;

  waste(&reference, &labels, since, top, args.json).await
}

/// The first moment of a day written `YYYY-MM-DD`, in the owner's time, as Unix seconds.
pub fn day_start(day: &str) -> Option<i64> {
  let well_written = day.len() == 10
    && day
      .bytes()
      .enumerate()
      .all(|(at, byte)| if at == 4 || at == 7 { byte == b'-' } else { byte.is_ascii_digit() });

  if !well_written {
    return None;
  }

  let date = NaiveDate::parse_from_str(day, "%Y-%m-%d").ok()?;
  let offset = FixedOffset::east_opt(OWNER_OFFSET_HOURS * 3_600)?;

  Some(offset.from_local_datetime(&date.and_hms_opt(0, 0, 0)?).single()?.timestamp())
}

fn database(why: sea_orm::DbErr) -> Fault {
  Fault::failed(format!("the gate's database: {why}"))
}

/// The pieces attached since a moment, as the table of the `top` that wasted most and the summary under it, or as
/// JSON.
pub async fn waste(reference: &Reference, labels: &Labels, since: i64, top: usize, json: bool) -> Answered {
  let gates = counted_gates();
  let marks: Vec<String> = (0..gates.len()).map(|at| format!("${}", at + 2)).collect();
  let mut values: Vec<sea_orm::Value> = vec![since.into()];

  values.extend(gates.iter().map(|gate| gate.clone().into()));

  // Every attachment the record holds: one row per turn, gate and piece that reached a prompt.
  let attached = all(
    db(reference),
    &format!(
      r#"SELECT "stage", "chat_id", "message_id", "slug" FROM "reference_verdicts"
          WHERE "attached" = 1 AND "created_at" >= $1 AND "stage" IN ({}) ORDER BY "id""#,
      marks.join(", ")
    ),
    values.clone(),
  )
  .await
  .map_err(database)?;
  let asked: Vec<Asked> = all(
    db(reference),
    &format!(
      r#"SELECT "stage", COUNT(DISTINCT "chat_id" || ':' || COALESCE("message_id", 0)) AS "turns" FROM "reference_verdicts"
          WHERE "created_at" >= $1 AND "stage" IN ({}) GROUP BY "stage" ORDER BY "stage""#,
      marks.join(", ")
    ),
    values,
  )
  .await
  .map_err(database)?
  .iter()
  .map(|row| Ok(Asked { stage: row.try_get("", "stage")?, turns: row.try_get("", "turns")? }))
  .collect::<Result<_, sea_orm::DbErr>>()
  .map_err(database)?;
  let mut rows = vec![];

  for row in &attached {
    let stage: String = row.try_get("", "stage").map_err(database)?;
    let chat_id: i64 = row.try_get("", "chat_id").map_err(database)?;
    let message_id: Option<i64> = row.try_get("", "message_id").map_err(database)?;
    let slug: String = row.try_get("", "slug").map_err(database)?;

    rows.push((stage, chat_id, message_id, slug));
  }

  let sizes = sizes(reference, &rows).await?;
  let mut pieces: IndexMap<(String, String), Piece> = IndexMap::new();

  for (stage, chat_id, message_id, slug) in &rows {
    let chars = sizes.get(&(*chat_id, stage.clone(), slug.clone())).copied().unwrap_or_default();
    let turn = format!("{chat_id}:{}", message_id.map_or_else(|| "null".to_owned(), |id| id.to_string()));
    let label = labels.of_piece(&turn, stage, slug);
    let piece = pieces.entry((stage.clone(), slug.clone())).or_insert_with(|| Piece {
      stage: stage.clone(),
      slug: slug.clone(),
      attached: 0,
      judged: 0,
      used: 0,
      related: 0,
      unused: 0,
      chars,
      tokens: 0.0,
      wasted: 0.0,
    });

    piece.attached += 1;
    piece.tokens += chars as f64 / CHARS_PER_TOKEN;

    if let Some(label) = label {
      piece.judged += 1;

      match label {
        "used" => piece.used += 1,
        "related" => piece.related += 1,
        _ => piece.unused += 1,
      }
    }
  }

  // A piece's waste over all its attachments is the share the answer did not use, carried over to the attachments
  // the judge did not see; a piece never judged is counted as its gate's pieces were.
  let mut gate_waste: IndexMap<String, f64> = IndexMap::new();

  for gate in &gates {
    let of_gate: Vec<&Piece> = pieces.values().filter(|piece| piece.stage == *gate).collect();
    let judged: usize = of_gate.iter().map(|piece| piece.judged).sum();
    let unused: usize = of_gate.iter().map(|piece| piece.judged - piece.used).sum();

    gate_waste.insert(gate.clone(), if judged == 0 { 0.0 } else { unused as f64 / judged as f64 });
  }

  for piece in pieces.values_mut() {
    let share = if piece.judged == 0 {
      gate_waste.get(&piece.stage).copied().unwrap_or_default()
    } else {
      (piece.judged - piece.used) as f64 / piece.judged as f64
    };

    piece.wasted = piece.tokens * share;
  }

  // How long each gate took.
  let mut timing = vec![];

  for gate in &gates {
    let mut times: Vec<i64> = all(
      db(reference),
      r#"SELECT "ms" FROM "judgements" WHERE "stage" = $1 AND "created_at" >= $2 AND "ms" IS NOT NULL"#,
      vec![gate.clone().into(), since.into()],
    )
    .await
    .map_err(database)?
    .iter()
    .filter_map(|row| row.try_get::<i64>("", "ms").ok())
    .collect();

    times.sort_unstable();
    timing.push(Timing {
      gate: gate.clone(),
      runs: times.len(),
      middle: times.get(times.len() / 2).copied().unwrap_or_default(),
      tail: times.get((times.len() as f64 * 0.9).floor() as usize).copied().unwrap_or_default(),
    });
  }

  let turn_count = asked.iter().map(|one| one.turns).max().unwrap_or_default().max(1);
  let wasted_tokens: f64 = pieces.values().map(|piece| piece.wasted).sum();
  let carried_tokens: f64 = pieces.values().map(|piece| piece.tokens).sum();
  let mut ranked: Vec<Piece> = pieces.into_values().collect();

  ranked.sort_by(|left, right| right.wasted.total_cmp(&left.wasted));

  let summary = Summary {
    turns: turn_count,
    asked,
    carried_tokens: carried_tokens.round() as i64,
    wasted_tokens: wasted_tokens.round() as i64,
    wasted_per_turn: (wasted_tokens / turn_count as f64).round() as i64,
    gate_waste: gate_waste.iter().map(|(gate, share)| (gate.clone(), js_number(*share))).collect(),
    timing,
  };

  if json {
    #[derive(Serialize)]
    struct Written<'a> {
      summary: &'a Summary,
      pieces: &'a [Piece],
    }

    return Ok(vec![
      serde_json::to_string_pretty(&Written {
        summary: &summary,
        pieces: &ranked,
      })
      .unwrap_or_default(),
    ]);
  }

  let percent = |share: f64| format!("{}%", (share * 100.0).round());
  let mut lines = vec![
    "gate | piece | attached | judged | used | related | unused | not used | chars | tokens carried | tokens wasted"
      .to_owned(),
  ];

  for piece in ranked.iter().take(top) {
    lines.push(
      [
        piece.stage.clone(),
        piece.slug.clone(),
        piece.attached.to_string(),
        piece.judged.to_string(),
        piece.used.to_string(),
        piece.related.to_string(),
        piece.unused.to_string(),
        if piece.judged == 0 {
          "-".to_owned()
        } else {
          percent((piece.judged - piece.used) as f64 / piece.judged as f64)
        },
        piece.chars.to_string(),
        piece.tokens.round().to_string(),
        piece.wasted.round().to_string(),
      ]
      .join(" | "),
    );
  }

  lines.push(String::new());
  lines.push(format!(
    "turns {} \u{b7} tokens carried {} \u{b7} wasted {} ({} a turn)",
    summary.turns, summary.carried_tokens, summary.wasted_tokens, summary.wasted_per_turn
  ));
  lines.push(words::WASTE_NO_USAGE.to_owned());
  lines.push(format!(
    "not-used share by gate: {}",
    gates
      .iter()
      .map(|gate| format!("{gate} {}", percent(gate_waste.get(gate).copied().unwrap_or_default())))
      .collect::<Vec<_>>()
      .join(" \u{b7} ")
  ));
  lines.push(format!(
    "gate time (middle / ninth tenth): {}",
    summary
      .timing
      .iter()
      .map(|one| format!(
        "{} {:.1}s / {:.1}s",
        one.gate,
        one.middle as f64 / 1000.0,
        one.tail as f64 / 1000.0
      ))
      .collect::<Vec<_>>()
      .join(" \u{b7} ")
  ));

  Ok(lines)
}

/// The size of each attached piece's body as it stands now, by room, gate and slug: each room's gates as the live
/// road stands them, and each body read where the live road reads it. A piece no gate of its room offers any more
/// weighs nothing.
async fn sizes(
  reference: &Reference,
  rows: &[(String, i64, Option<i64>, String)],
) -> Result<HashMap<(i64, String, String), usize>, Fault> {
  let mut wanted: IndexMap<(i64, String), BTreeSet<String>> = IndexMap::new();

  for (stage, chat_id, _, slug) in rows {
    wanted.entry((*chat_id, stage.clone())).or_default().insert(slug.clone());
  }

  let rooms: BTreeSet<i64> = wanted.keys().map(|(chat_id, _)| *chat_id).collect();
  let mut sizes = HashMap::new();

  for chat_id in rooms {
    let gates = road::gates_of(reference, chat_id, reference.chat_agent(), true)
      .await
      .map_err(|why| Fault::failed(format!("reference waste: {why}")))?;

    for gate in &gates {
      let Some(slugs) = wanted.get(&(chat_id, gate.stage.clone())) else { continue };
      let slugs: Vec<String> = slugs.iter().cloned().collect();
      let reader = Reader {
        agent: reference.chat_agent(),
        chat_id,
        stage: &gate.stage,
      };

      for (slug, (_, text)) in read_bodies(reference, &reader, &gate.libraries, &slugs).await {
        sizes.insert((chat_id, gate.stage.clone(), slug), js::units(&text));
      }
    }
  }

  Ok(sizes)
}
