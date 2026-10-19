//! Where a set stands under the data root, and the records a gate's generation and a scoring run leave there
//! (docs/gate-eval.md, 「Where the data is」).

use std::collections::BTreeMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::member::EvalItem;

/// A set's folder: the one an absolute name names, or the set's own under the data root.
pub fn set_folder(data_root: &Path, set: &str) -> PathBuf {
  if set.starts_with('/') {
    PathBuf::from(set)
  } else {
    data_root.join("gate-eval").join(set)
  }
}

pub fn scores_folder(data_root: &Path, set: &str) -> PathBuf {
  set_folder(data_root, set).join("scores")
}

/// Every record of a file written one JSON value to a line; none for a file not there.
pub fn read_lines<T: DeserializeOwned>(path: &Path) -> Result<Vec<T>, String> {
  let Ok(text) = std::fs::read_to_string(path) else { return Ok(vec![]) };

  text
    .lines()
    .filter(|line| !line.trim().is_empty())
    .map(|line| serde_json::from_str(line).map_err(|why| format!("{}: {why}", path.display())))
    .collect()
}

fn made(path: &Path) -> Result<(), String> {
  path
    .parent()
    .map_or(Ok(()), std::fs::create_dir_all)
    .map_err(|why| format!("{}: {why}", path.display()))
}

pub fn append_line<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
  made(path)?;

  let line = serde_json::to_string(value).map_err(|why| why.to_string())?;
  let mut file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(|why| format!("{}: {why}", path.display()))?;

  writeln!(file, "{line}").map_err(|why| format!("{}: {why}", path.display()))
}

// A file written whole or not at all, so a reader never finds half of it.
fn write_whole(path: &Path, text: &str) -> Result<(), String> {
  made(path)?;

  let part = path.with_extension(format!(
    "{}.part",
    path.extension().and_then(|extension| extension.to_str()).unwrap_or_default()
  ));

  std::fs::write(&part, text)
    .and_then(|()| std::fs::rename(&part, path))
    .map_err(|why| format!("{}: {why}", path.display()))
}

/// A list of records written over whole, one to a line.
pub fn write_lines<T: Serialize>(path: &Path, values: &[T]) -> Result<(), String> {
  let mut text = String::new();

  for value in values {
    text.push_str(&serde_json::to_string(value).map_err(|why| why.to_string())?);
    text.push('\n');
  }

  write_whole(path, &text)
}

pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
  let text = serde_json::to_string_pretty(value).map_err(|why| why.to_string())?;

  write_whole(path, &format!("{text}\n"))
}

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
  std::fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok())
}

/// Where one gate's generation stands. A record written before a field stood reads it as the fresh state has it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct GateState {
  /// waiting, running, done, stopped or refused.
  pub status: String,
  /// How many items the generation was asked for, or none before it started.
  pub wanted: Option<usize>,
  /// Why the gate stopped or was left, in Codex's own words where it said any.
  pub reason: Option<String>,
  pub thread: Option<String>,
  /// A digest of the brief the open thread was given, so a changed brief opens a new thread.
  pub brief: Option<String>,
  /// How many batches the open thread has carried, how many the gate has asked, and how many of the last ones
  /// in a row were refused.
  pub thread_batches: usize,
  pub batches: usize,
  pub refused_in_row: usize,
  pub updated_at: String,
}

impl Default for GateState {
  fn default() -> Self {
    Self {
      status: "waiting".to_owned(),
      wanted: None,
      reason: None,
      thread: None,
      brief: None,
      thread_batches: 0,
      batches: 0,
      refused_in_row: 0,
      updated_at: String::new(),
    }
  }
}

/// One batch as it is recorded: what it asked for and what became of it. A record written before a field stood
/// reads it as none.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct BatchRecord {
  pub batch: usize,
  pub topic: String,
  pub asked: usize,
  pub kept: usize,
  pub refused: usize,
  pub dropped: BTreeMap<String, usize>,
  /// The first item dropped for each reason, said whole.
  pub examples: BTreeMap<String, String>,
  pub input_tokens: u64,
  pub cached_tokens: u64,
  pub output_tokens: u64,
  pub seconds: u64,
  pub failure: Option<String>,
  pub at: String,
}

/// The three records of one gate's generation.
pub struct GateRecords {
  pub items: PathBuf,
  pub batches: PathBuf,
  pub state: PathBuf,
}

pub fn gate_records(data_root: &Path, set: &str, stage: &str) -> GateRecords {
  let folder = set_folder(data_root, set).join(stage);

  GateRecords {
    items: folder.join("items.jsonl"),
    batches: folder.join("batches.jsonl"),
    state: folder.join("state.json"),
  }
}

pub fn gate_items(data_root: &Path, set: &str, stage: &str) -> Result<Vec<EvalItem>, String> {
  read_lines(&gate_records(data_root, set, stage).items)
}

pub fn gate_state(data_root: &Path, set: &str, stage: &str) -> GateState {
  read_json(&gate_records(data_root, set, stage).state).unwrap_or_default()
}

pub fn gate_batches(data_root: &Path, set: &str, stage: &str) -> Result<Vec<BatchRecord>, String> {
  read_lines(&gate_records(data_root, set, stage).batches)
}
