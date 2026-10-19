//! The document seeker (`docs/boundary-api.md`, `POST /documents/sought`): where a question the owner asks in the
//! web unit's document viewer is answered. The viewer builds the index — one line per heading of the open document,
//! or one per document — and hands it over with the question; this gate names the entries to open, most direct
//! first. An index too large for the road is cut in two and each half asked on its own, a half no road answered
//! picking nothing; and where the index was cut and more than one entry was picked, the gate is asked once more
//! over those entries alone, since the halves' picks stand in the halves' order rather than by relevance.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};

use gate_policy::document_seek::DOCUMENT_SEEK;
use gate_policy::prompts;
use gate_runs::{GateRequest, Piece, Split};
use regex::Regex;

use crate::Stages;

/// The gate's key.
pub const STAGE: &str = "document-seek";

/// One line of the index: the slug the gate answers with, what the entry is, and the branch it is listed
/// under where the viewer groups its lines.
#[derive(Clone, Debug, PartialEq, Eq, serde::Deserialize)]
pub struct SeekEntry {
  pub slug: String,
  pub line: String,
  #[serde(default)]
  pub group: Option<String>,
}

static SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z0-9-]{1,40}$").expect("a slug"));
static LEAD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[-*]\s+").expect("a list mark"));
static TAIL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[.,;]$").expect("a closing mark"));

/// The seeker's instructions, its ceiling filled in; none where they are not among the prompts.
pub fn system() -> Option<String> {
  let written = prompts::instructions(STAGE)?;

  Some(prompts::render(written, &[("selectionCap", &DOCUMENT_SEEK.cap.to_string())]))
}

/// Whether a slug is one the gate can answer with.
pub fn is_slug(slug: &str) -> bool {
  SLUG.is_match(slug)
}

// The index as the gate reads it: consecutive entries of one branch under that branch's name.
fn index_lines(entries: &[SeekEntry]) -> Vec<String> {
  let mut lines = Vec::new();
  let mut group: Option<&str> = None;

  for entry in entries {
    if let Some(named) = entry.group.as_deref()
      && Some(named) != group
    {
      lines.push(format!("[{named}]"));
    }

    group = entry.group.as_deref();
    lines.push(format!("{} — {}", entry.slug, entry.line));
  }

  lines
}

fn answer_lines(answer: &str) -> Vec<String> {
  answer
    .split('\n')
    .map(|line| TAIL.replace(&LEAD.replace(line.trim(), ""), "").into_owned())
    .filter(|line| !line.is_empty())
    .collect()
}

/// One request over the index; `cut` learns whether the request was cut at all.
pub fn request(
  system: &Arc<String>,
  entries: &[SeekEntry],
  question: &str,
  cut: Option<Arc<AtomicBool>>,
) -> GateRequest {
  let mut asked = GateRequest::new(
    system.as_str(),
    ["INDEX:".to_owned()]
      .into_iter()
      .chain(index_lines(entries))
      .chain([String::new(), "QUESTION:".to_owned(), question.to_owned()])
      .collect::<Vec<_>>()
      .join("\n"),
  );

  asked.thinking = false;
  asked.split = Some(Arc::new(Halves {
    system: Arc::clone(system),
    entries: entries.to_vec(),
    question: question.to_owned(),
    cut,
  }));
  asked
}

struct Halves {
  system: Arc<String>,
  entries: Vec<SeekEntry>,
  question: String,
  cut: Option<Arc<AtomicBool>>,
}

impl Split for Halves {
  fn halve(&self) -> Option<Vec<Piece>> {
    if self.entries.len() < 2 {
      return None;
    }

    let middle = self.entries.len().div_ceil(2);

    if let Some(cut) = &self.cut {
      cut.store(true, Ordering::SeqCst);
    }

    Some(vec![
      Piece::Asked(request(&self.system, &self.entries[..middle], &self.question, self.cut.clone())),
      Piece::Asked(request(&self.system, &self.entries[middle..], &self.question, self.cut.clone())),
    ])
  }

  fn join(&self, answers: Vec<Option<String>>) -> Option<String> {
    if answers.iter().all(Option::is_none) {
      return None;
    }

    let picks: Vec<String> = answers
      .iter()
      .flatten()
      .flat_map(|answer| answer_lines(answer))
      .filter(|line| !line.eq_ignore_ascii_case("none"))
      .collect();

    Some(if picks.is_empty() { "none".to_owned() } else { picks.join("\n") })
  }
}

/// The entries an answer names, known slugs only, each once, in the order given and no more than the gate's
/// ceiling: an empty pick where it says none, and none at all where it names nothing known.
pub fn parse(answer: &str, entries: &[SeekEntry]) -> Option<Vec<String>> {
  let lines = answer_lines(answer);

  if lines.len() == 1 && lines[0].eq_ignore_ascii_case("none") {
    return Some(vec![]);
  }

  let known: HashSet<&str> = entries.iter().map(|entry| entry.slug.as_str()).collect();
  let mut seen = HashSet::new();
  let picks: Vec<String> = lines
    .into_iter()
    .filter(|line| known.contains(line.as_str()) && seen.insert(line.clone()))
    .take(DOCUMENT_SEEK.cap)
    .collect();

  (!picks.is_empty()).then_some(picks)
}

/// The picks for one question, asked through `run`, or none where the gate did not answer or answered nothing
/// readable.
pub async fn seek<F, Fut>(
  system: &Arc<String>,
  entries: &[SeekEntry],
  question: &str,
  run: F,
) -> Option<Vec<String>>
where
  F: Fn(GateRequest) -> Fut,
  Fut: Future<Output = Option<String>>,
{
  if entries.is_empty() {
    return Some(vec![]);
  }

  let cut = Arc::new(AtomicBool::new(false));
  let picks = run(request(system, entries, question, Some(Arc::clone(&cut))))
    .await
    .and_then(|answer| parse(&answer, entries));
  let picks = picks?;

  if picks.len() < 2 || !cut.load(Ordering::SeqCst) {
    return Some(picks);
  }

  let chosen: Vec<SeekEntry> = picks
    .iter()
    .filter_map(|slug| entries.iter().find(|entry| &entry.slug == slug).cloned())
    .collect();
  let order = run(request(system, &chosen, question, None))
    .await
    .and_then(|answer| parse(&answer, &chosen));

  match order {
    Some(order) if !order.is_empty() => {
      let mut ranked = order.clone();

      ranked.extend(picks.into_iter().filter(|slug| !order.contains(slug)));
      Some(ranked)
    }
    _ => Some(picks),
  }
}

/// The picks for one question, asked of the gate on its own road; none where it gave no readable answer or its
/// instructions could not be had.
pub async fn sought(stages: &Stages, entries: &[SeekEntry], question: &str) -> Option<Vec<String>> {
  let system = Arc::new(system()?);

  seek(&system, entries, question, |request| async move {
    match stages.runs.run(STAGE, &request).await {
      Ok(answer) => answer,
      Err(why) => {
        eprintln!("{STAGE}: {why}");
        None
      }
    }
  })
  .await
}
