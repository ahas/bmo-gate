//! One gate's generation (docs/gate-eval.md, 「Generation」): batches on one Codex thread at a time, each item
//! read by the gate's member before it is kept, refusals counted and never worked around.

use std::collections::HashSet;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use gate_markup::js::bun_hash;
use gate_stages::Stages;
use regex::Regex;
use serde_json::Value;

use super::codex::CodexRun;
use super::member::{EvalGate, EvalItem, plain, schema};
use super::store::{
  BatchRecord, GateState, append_line, gate_items, gate_records, gate_state, write_json, write_lines,
};

/// How many batches one thread carries before a new one is opened, so the thread never fills.
pub const THREAD_BATCHES: usize = 5;
/// How many refused batches in a row leave the gate for a model that writes it.
pub const REFUSALS_TO_LEAVE: usize = 3;
// How many times the batches a run needs it may spend, for the items it drops.
const SPARE_BATCHES: f64 = 1.5;
// How many earlier inputs a new thread is shown so it does not write them again.
const SHOWN_EARLIER: usize = 40;

/// A turn Codex ended on its account's usage policy rather than a fault of the run.
pub static POLICY_FAILURE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(r"(?i)policy|safety|violat|refus|not allowed|cyber").expect("a policy failure")
});

/// An answer that is a refusal in words rather than items: in English, or in Korean an apology, "cannot help" or
/// "cannot write".
pub static REFUSAL_WORDS: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(
    r"(?i)(?-u:\b)(can'?t|cannot|unable to|won'?t) (help|assist|provide|create|write|comply)|\u{C8C4}\u{C1A1}|\u{B3C4}\u{C640}\u{B4DC}\u{B9B4} \u{C218} \u{C5C6}|\u{C791}\u{C131}\u{D560} \u{C218} \u{C5C6}",
  )
  .expect("a refusal in words")
});

/// The schema Codex holds a gate's answer to: a list of items, each its difficulty, why its key is right, and
/// the member's own input and key.
pub fn item_schema(member: &dyn EvalGate) -> Value {
  schema::object(&[(
    "items",
    schema::list(schema::object(&[
      ("difficulty", schema::one_of(&["easy", "borderline"])),
      ("why", schema::text()),
      ("input", member.input_schema()),
      ("key", member.key_schema()),
    ])),
  )])
}

// What every gate's thread opens with, before the gate's own brief.
fn preamble() -> String {
  [
    "You are writing an evaluation set for one gate of a chat assistant that talks with people in Korean chat rooms. A gate is a model-only step: one system prompt, one input, one answer. Each item you write is one question for the gate: the input it is handed (in the gate's own terms; the assistant's code builds the actual prompt from it) and the answer key that a correct answer meets.",
    "",
    "Rules for every item:",
    "- Realistic: the material the assistant really handles, in the language mix of its rooms (mostly Korean, technical English words inside it).",
    "- Invented: every person, name, id, phone number and address is made up. Never use a real person's private data.",
    "- Correct key: the key states what a careful gate following its own instructions answers. `why` says in one sentence why the key is right, naming the instruction it rests on.",
    "- Varied: no two items share their input; vary length, register, subject and the trap they test.",
    "- Your answer is the JSON the schema asks for and nothing else.",
  ]
  .join("\n")
}

struct BatchAsk {
  topic: String,
  prompt: String,
}

fn batch_ask(member: &dyn EvalGate, size: usize, batch: usize, earlier: &[String]) -> BatchAsk {
  let topics = member.topics();
  let topic = topics[batch % topics.len()].clone();
  let mut lines = vec![
    format!("Batch {}: write {size} items on this topic: {topic}.", batch + 1),
    "About half easy and half borderline. Each item differs from every item written before in this set."
      .to_owned(),
  ];

  if !earlier.is_empty() {
    lines.push(String::new());
    lines
      .push("Inputs already in the set (do not write these again or anything close to them):".to_owned());
    lines.extend(earlier.iter().map(|one| format!("- {one}")));
  }

  BatchAsk {
    topic,
    prompt: lines.join("\n"),
  }
}

fn excerpt(text: &str) -> String {
  let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");

  if flat.chars().count() > 100 {
    format!("{}\u{2026}", flat.chars().take(100).collect::<String>())
  } else {
    flat
  }
}

// The items an answer held, or none where it held none to read.
fn answer_items(text: &str) -> Option<Vec<Value>> {
  serde_json::from_str::<Value>(text).ok()?.get("items")?.as_array().cloned()
}

/// The reason a drop is counted under: its words up to the colon of its last line, the rest naming the one item.
pub fn reason_of(why: &str) -> &str {
  let last_line = why.rfind('\n').map_or(0, |at| at + 1);

  why[last_line..].find(':').map_or(why, |at| &why[..last_line + at])
}

/// What one gate's generation is handed: where the set stands, how many items it is asked for and how many one
/// batch asks, the Codex it asks, the gates its brief reads the gate's prompts through, and where it says how it
/// goes.
pub struct Generation<'a> {
  pub data_root: &'a Path,
  pub set: &'a str,
  pub per_gate: Option<usize>,
  pub batch: Option<usize>,
  pub codex: &'a dyn CodexRun,
  pub stages: &'a Stages,
  pub log: &'a (dyn Fn(&str) + Sync),
}

fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One gate's generation from where it stands until it has its items, is left for a model that writes it, or
/// stops on a failure that the next run takes up after.
pub async fn generate_gate(member: &dyn EvalGate, given: &Generation<'_>) -> Result<GateState, String> {
  let stage = member.stage();
  let log = given.log;
  let records = gate_records(given.data_root, given.set, stage);
  let wanted = given.per_gate.unwrap_or_else(|| member.per_gate());
  let stored = gate_items(given.data_root, given.set, stage)?;
  // What the gate kept is read again by its member as it stands now, so an item a tightened rule refuses leaves
  // the set. An id is never given twice, so a score already written keeps meaning the item it named.
  let mut kept: Vec<EvalItem> = stored
    .iter()
    .filter(|item| member.refusal(&item.input, &item.key).is_none())
    .cloned()
    .collect();
  let mut last_number = stored
    .iter()
    .filter_map(|item| item.id.rsplit('-').next()?.parse::<usize>().ok())
    .max()
    .unwrap_or_default();

  if kept.len() < stored.len() {
    write_lines(&records.items, &kept)?;
    log(&format!(
      "{stage}: {} kept items no longer pass the gate's reading and left the set",
      stored.len() - kept.len()
    ));
  }

  let mut seen: HashSet<String> = kept.iter().map(|item| plain(&member.fingerprint(&item.input))).collect();
  let schema_path = given.codex.schema_file(stage, &item_schema(member))?;
  let size = given.batch.unwrap_or_else(|| member.batch_size());
  // What this run may spend: enough for the items still wanted, with room for the ones it drops.
  let max_batches = (((wanted as f64 - kept.len() as f64) / size as f64) * SPARE_BATCHES).ceil() as i64 + 1;
  let mut state = GateState {
    status: "running".to_owned(),
    wanted: Some(wanted),
    reason: None,
    ..gate_state(given.data_root, given.set, stage)
  };
  let save = |state: &GateState| {
    write_json(
      &records.state,
      &GateState {
        updated_at: now_iso(),
        ..state.clone()
      },
    )
  };

  if state.refused_in_row >= REFUSALS_TO_LEAVE {
    state.status = "refused".to_owned();
    save(&state)?;

    return Ok(state);
  }

  save(&state)?;

  let first_batch = state.batches;
  let opened = format!("{}\n\n{}", preamble(), member.brief(given.stages).await?);
  let brief = bun_hash(&opened).to_string();

  while kept.len() < wanted {
    if (state.batches - first_batch) as i64 >= max_batches {
      state.status = "stopped".to_owned();
      state.reason = Some(format!(
        "{max_batches} batches spent this run with {} of {wanted} items kept",
        kept.len()
      ));
      break;
    }

    let opening = state.thread.is_none()
      || state.thread_batches >= THREAD_BATCHES
      || state.brief.as_deref() != Some(&brief);
    let thread = if opening { None } else { state.thread.clone() };
    let earlier: Vec<String> = if opening {
      kept[kept.len().saturating_sub(SHOWN_EARLIER)..]
        .iter()
        .map(|item| excerpt(&member.fingerprint(&item.input)))
        .collect()
    } else {
      vec![]
    };
    let ask = batch_ask(member, size, state.batches, &earlier);
    let prompt = if opening { format!("{opened}\n\n{}", ask.prompt) } else { ask.prompt.clone() };
    let started = Instant::now();
    let reading = given.codex.run(thread.as_deref(), &schema_path, &prompt).await;
    let mut record = BatchRecord {
      batch: state.batches,
      topic: ask.topic.clone(),
      asked: size,
      input_tokens: reading.input_tokens,
      cached_tokens: reading.cached_tokens,
      output_tokens: reading.output_tokens,
      seconds: started.elapsed().as_secs_f64().round() as u64,
      failure: reading.failure.clone(),
      at: now_iso(),
      ..BatchRecord::default()
    };
    let items = if reading.failure.is_none() { answer_items(&reading.text) } else { None };
    let refused = match &reading.failure {
      Some(failure) => POLICY_FAILURE.is_match(failure),
      None => items.is_none() && REFUSAL_WORDS.is_match(&reading.text),
    };

    if let Some(failure) = reading.failure.as_ref().filter(|_| !refused) {
      append_line(&records.batches, &record)?;
      state.status = "stopped".to_owned();
      state.reason = Some(failure.clone());
      log(&format!("{stage}: batch {} failed, stopping: {failure}", state.batches + 1));
      break;
    }

    state.batches += 1;
    state.thread = reading.thread.clone().or(thread);
    state.brief = Some(brief.clone());
    state.thread_batches = if opening { 1 } else { state.thread_batches + 1 };

    let Some(items) = items.filter(|_| !refused) else {
      if refused {
        record.refused = size;
      } else {
        record.dropped.insert("unreadable answer".to_owned(), size);
      }

      append_line(&records.batches, &record)?;

      if refused {
        state.refused_in_row += 1;
      }

      state.thread = None;
      log(&format!(
        "{stage}: batch {} {}",
        state.batches,
        if refused { "refused" } else { "unreadable" }
      ));

      if state.refused_in_row >= REFUSALS_TO_LEAVE {
        state.status = "refused".to_owned();
        state.reason = Some(format!(
          "{} batches in a row refused: {}",
          state.refused_in_row,
          reading.failure.clone().unwrap_or_else(|| excerpt(&reading.text))
        ));
        break;
      }

      save(&state)?;
      continue;
    };

    let drop = |record: &mut BatchRecord, why: &str| {
      let reason = reason_of(why).to_owned();

      *record.dropped.entry(reason.clone()).or_default() += 1;
      record.examples.entry(reason).or_insert_with(|| why.to_owned());
    };

    for one in &items {
      if kept.len() >= wanted {
        drop(&mut record, "past the set's size");
        continue;
      }

      let difficulty = one
        .get("difficulty")
        .and_then(Value::as_str)
        .filter(|one| ["easy", "borderline"].contains(one));
      let why = one.get("why").and_then(Value::as_str);
      let (Some(difficulty), Some(why), Some(input), Some(key)) =
        (difficulty, why, one.get("input"), one.get("key"))
      else {
        drop(&mut record, "item shape");
        continue;
      };

      if let Some(refusal) = member.refusal(input, key) {
        drop(&mut record, &refusal);
        continue;
      }

      if !seen.insert(plain(&member.fingerprint(input))) {
        drop(&mut record, "duplicate");
        continue;
      }

      last_number += 1;

      let item = EvalItem {
        id: format!("{stage}-{last_number:04}"),
        gate: stage.to_owned(),
        topic: ask.topic.clone(),
        difficulty: difficulty.to_owned(),
        why: why.to_owned(),
        input: input.clone(),
        key: key.clone(),
      };

      append_line(&records.items, &item)?;
      kept.push(item);
      record.kept += 1;
    }

    append_line(&records.batches, &record)?;
    state.refused_in_row = 0;
    save(&state)?;
    log(&format!(
      "{stage}: batch {} kept {}/{} ({}/{wanted}) in {}s",
      state.batches,
      record.kept,
      record.asked,
      kept.len(),
      record.seconds
    ));
  }

  if state.status == "running" {
    state.status = "done".to_owned();
  }

  save(&state)?;

  Ok(state)
}
