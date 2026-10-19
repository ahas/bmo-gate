//! `reference replay` (docs/reference-selection.md, 「What it picks and what it costs, measured」): real turns the use
//! judge already labelled put through the reference road as it stands now — the fragment rows, the narrowing and
//! the gates — and what attaches, and how much of it the answer used, set beside what attached then.
//!
//! A turn here is one the use judge labelled (docs/reference-data.md): every candidate it was offered carries a word
//! saying whether the answer used it, or would have needed it. The same message, read through the receiver, is put
//! through the road again, with nothing the road offered, judged, attached or released written down. A piece
//! attached now is counted used where its label is `used` or `needed`, not used where it is `related`, `unused` or
//! `not-needed`, and unknown where the judge never saw it. The gates are really asked; nothing is written anywhere
//! but the file `--out` names and the log each gate's own run leaves.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use gate_markup::text::count_text;
use gate_policy::fill_marks;
use gate_reference::Reference;
use gate_reference::road::{self, Turn};
use gate_words::reference_benches as words;
use indexmap::IndexMap;
use serde::Serialize;

use super::waste::use_turns;
use super::{count, counted_gates, message_line, road_of, stored_message};
use crate::{Answered, Fault};

// How many judged turns are replayed where the caller names no number.
const TURNS: usize = 60;

#[derive(clap::Args, Debug)]
pub struct ReplayArgs {
  /// Another database's address.
  #[arg(long, allow_hyphen_values = true)]
  db: Option<String>,
  /// The use judge's turns.
  #[arg(long = "use", allow_hyphen_values = true)]
  use_path: Option<String>,
  #[arg(long, allow_hyphen_values = true)]
  turns: Option<String>,
  #[arg(long, allow_hyphen_values = true)]
  out: Option<String>,
  #[arg(short = 'h', long)]
  help: bool,
}

/// One turn the use judge labelled: its room and message, what the record says reached the prompt then, and the
/// judge's word on every candidate, by gate and slug.
#[derive(Clone, Debug)]
pub struct Judged {
  pub id: String,
  pub chat_id: i64,
  pub message_id: i64,
  pub then: Vec<(String, String)>,
  pub labels: HashMap<(String, String), String>,
}

#[derive(serde::Deserialize)]
struct JudgedLine {
  id: String,
  source: String,
  candidates: Vec<JudgedCandidate>,
}

#[derive(serde::Deserialize)]
struct JudgedCandidate {
  gate: String,
  slug: String,
  attached: bool,
  label: Option<String>,
}

/// The turns of the use judge's file that came from the record, each named by its room and message.
pub fn judged_turns(text: &str) -> Result<Vec<Judged>, Fault> {
  let mut judged = vec![];

  for line in text.split('\n').filter(|line| !line.trim().is_empty()) {
    let turn: JudgedLine = serde_json::from_str(line)
      .map_err(|why| Fault::failed(format!("reference replay: a judged turn does not read: {why}")))?;
    let mut parts = turn.id.split(':').map(str::parse::<i64>);
    let (Some(Ok(chat_id)), Some(Ok(message_id))) = (parts.next(), parts.next()) else {
      continue;
    };

    if turn.source != "record" {
      continue;
    }

    judged.push(Judged {
      id: turn.id,
      chat_id,
      message_id,
      then: turn
        .candidates
        .iter()
        .filter(|one| one.attached)
        .map(|one| (one.gate.clone(), one.slug.clone()))
        .collect(),
      labels: turn
        .candidates
        .into_iter()
        .filter_map(|one| one.label.map(|label| ((one.gate, one.slug), label)))
        .collect(),
    });
  }

  Ok(judged)
}

/// An even spread of at most `wanted` over the judged turns, so neither end of the record weighs more than the other.
pub fn spread<T: Clone>(judged: &[T], wanted: usize) -> Vec<T> {
  let step = (judged.len() as f64 / wanted as f64).max(1.0);

  (0..wanted.min(judged.len()))
    .map(|at| judged[(at as f64 * step).floor() as usize].clone())
    .collect()
}

/// What a piece's label says of the answer's use of it.
pub fn use_of(label: Option<&str>) -> &'static str {
  match label {
    Some("used" | "needed") => "used",
    None => "unknown",
    Some(_) => "not used",
  }
}

/// One piece of one side of a replayed turn.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Side {
  pub gate: String,
  pub slug: String,
  #[serde(rename = "use")]
  pub use_: String,
}

/// One turn replayed: what the road took, and what attached then and now.
#[derive(Clone, Debug, Serialize)]
pub struct Replayed {
  pub id: String,
  pub ms: i64,
  pub then: Vec<Side>,
  pub now: Vec<Side>,
}

pub async fn run(args: ReplayArgs) -> Answered {
  let usage = words::USAGE_REPLAY;

  if args.help {
    return Ok(vec![usage.to_owned()]);
  }

  let wanted = count(args.turns.as_deref(), TURNS, usage)?;
  let (settings, reference) = road_of(args.db.as_deref()).await?;
  let use_path = args.use_path.map_or_else(|| use_turns(&settings.data_root), PathBuf::from);
  let Ok(text) = std::fs::read_to_string(&use_path) else {
    return Err(Fault::Words(format!("reference replay: no use judgements at {}", use_path.display())));
  };

  replay_all(&reference, &spread(&judged_turns(&text)?, wanted), args.out.as_deref().map(Path::new)).await
}

fn write(out: &Path, replayed: &[Replayed]) -> Result<(), Fault> {
  std::fs::write(out, serde_json::to_string_pretty(replayed).unwrap_or_default()).map_err(|why| {
    Fault::failed(format!("reference replay: {} could not be written: {why}", out.display()))
  })
}

/// The chosen turns replayed one after another, each written to `out` as it ends, and the lines summing them up.
pub async fn replay_all(reference: &Reference, chosen: &[Judged], out: Option<&Path>) -> Answered {
  let mut replayed = vec![];
  let mut gone = 0;

  for turn in chosen {
    let Some(one) = replay(reference, turn).await? else {
      gone += 1;
      continue;
    };

    eprintln!(
      "reference replay: {}/{} {} in {:.1}s",
      replayed.len() + 1,
      chosen.len(),
      turn.id,
      one.ms as f64 / 1000.0
    );
    replayed.push(one);

    if let Some(out) = out {
      write(out, &replayed)?;
    }
  }

  if let Some(out) = out {
    write(out, &replayed)?;
  }

  let mut said = lines(&replayed);

  if gone > 0 {
    said.push(String::new());
    said.push(fill_marks(words::MESSAGES_GONE, &[("count", &count_text(gone))]));
  }

  Ok(said)
}

/// One judged turn through the road as it stands, or none where its message is gone or the road broke under it: a
/// run that breaks under one turn costs that turn and no other, the way it does on the live road.
pub async fn replay(reference: &Reference, judged: &Judged) -> Result<Option<Replayed>, Fault> {
  let Some(message) = stored_message(reference, judged.chat_id, judged.message_id).await? else {
    return Ok(None);
  };
  let turn = Turn {
    chat_id: judged.chat_id,
    message_lines: vec![message_line(&message)],
    message_id: Some(judged.message_id),
    speaker_ids: message.sender.into_iter().collect(),
    situation: None,
    holds: None,
    round: None,
    people_spoke: true,
    answered: None,
    off: vec![],
    lore: true,
    records: false,
  };
  let started = std::time::Instant::now();
  let composed = match road::compose(reference, &turn).await {
    Ok(composed) => composed,
    Err(why) => {
      eprintln!("reference replay: {} broke: {why}", judged.id);
      return Ok(None);
    }
  };
  let ms = started.elapsed().as_millis() as i64;
  let stages: HashSet<String> = counted_gates().into_iter().collect();
  let side = |gate: &str, slug: &str| Side {
    gate: gate.to_owned(),
    slug: slug.to_owned(),
    use_: use_of(judged.labels.get(&(gate.to_owned(), slug.to_owned())).map(String::as_str)).to_owned(),
  };

  Ok(Some(Replayed {
    id: judged.id.clone(),
    ms,
    then: judged.then.iter().map(|(gate, slug)| side(gate, slug)).collect(),
    now: composed
      .verdicts
      .iter()
      .filter(|verdict| verdict.attached == Some(true) && stages.contains(&verdict.stage))
      .map(|verdict| side(&verdict.stage, &verdict.slug))
      .collect(),
  }))
}

/// The replayed turns as lines: the road's time, then per gate what attached and was used then and now, then the
/// twenty pieces that attached most.
pub fn lines(replayed: &[Replayed]) -> Vec<String> {
  let mut times: Vec<i64> = replayed.iter().map(|turn| turn.ms).collect();

  times.sort_unstable();

  let middle = times.get(times.len() / 2).copied().unwrap_or_default() as f64 / 1000.0;
  let count = |then: bool, gate: &str, use_: Option<&str>| -> usize {
    replayed
      .iter()
      .map(|turn| {
        let side = if then { &turn.then } else { &turn.now };

        side
          .iter()
          .filter(|one| one.gate == gate && use_.is_none_or(|use_| one.use_ == use_))
          .count()
      })
      .sum()
  };
  let mut lines = vec![
    format!("turns {} \u{b7} road time per turn, middle {middle}s", replayed.len()),
    "gate | attached then | used then | attached now | used now | not used now | unknown now".to_owned(),
  ];

  for gate in counted_gates() {
    lines.push(
      [
        gate.clone(),
        count(true, &gate, None).to_string(),
        count(true, &gate, Some("used")).to_string(),
        count(false, &gate, None).to_string(),
        count(false, &gate, Some("used")).to_string(),
        count(false, &gate, Some("not used")).to_string(),
        count(false, &gate, Some("unknown")).to_string(),
      ]
      .join(" | "),
    );
  }

  let mut pieces: IndexMap<String, (usize, usize)> = IndexMap::new();

  for turn in replayed {
    for (then, side) in [(true, &turn.then), (false, &turn.now)] {
      for one in side {
        let piece = pieces.entry(format!("{} \u{b7} {}", one.gate, one.slug)).or_default();

        if then {
          piece.0 += 1;
        } else {
          piece.1 += 1;
        }
      }
    }
  }

  let mut ranked: Vec<(String, (usize, usize))> = pieces.into_iter().collect();

  ranked.sort_by(|left, right| right.1.0.cmp(&left.1.0).then(right.1.1.cmp(&left.1.1)));
  lines.push(String::new());
  lines.push("piece | attached then | attached now".to_owned());
  lines.extend(ranked.into_iter().take(20).map(|(key, (then, now))| format!("{key} | {then} | {now}")));

  lines
}
