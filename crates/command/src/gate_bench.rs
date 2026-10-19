//! `gate bench` (docs/output-gate.md, 「The replay bench」): the chat agent's own answers fed to the output gate one
//! call at a time — never two at once — with what each call answered and how long it held the turn written down,
//! so the same pinned set replayed before and after a change moves only because the gate did.
//!
//! Given two answer ceilings, every call is asked once at each, back to back and in turn, and both answers are
//! written down against the same item: a shared service's queue moves over minutes, so two whole runs one after
//! the other compare the queue as much as the ceiling, where a pair asked seconds apart compares the ceiling alone.
//!
//! What it asks goes straight to the registration `--registration` names, through the agency's model gateway, with
//! its wait given by `--share-ms`; a road that does not answer is recorded as it failed rather than walked on.

use std::collections::BTreeSet;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use clap::Args;
use gate_markup::markdown::{convert_markdown, folded_markup, telegram_parts};
use gate_policy::fill_marks;
use gate_policy::profiles::PROFILES;
use gate_ports::PortError;
use gate_ports::gateway::Ask;
use gate_runs::options;
use gate_stages::Stages;
use gate_stages::output::{GATE_KEY, format_request, instructions, too_short_to_fold};
use gate_words::gate_bench as words;
use serde::{Deserialize, Serialize};

use crate::{Answered, Fault};

/// The noun's arguments: `make-set`, `run` or `summary`, and the flags each reads.
#[derive(Args, Debug)]
pub struct GateBenchArgs {
  /// make-set, run or summary.
  pub command: Option<String>,
  /// How many of the chat agent's latest answers in the owner's room the set takes.
  #[arg(long, default_value_t = 30)]
  pub owner_answers: i64,
  /// How many of the chat agent's latest answers in group rooms the set takes.
  #[arg(long, default_value_t = 20)]
  pub room_answers: i64,
  /// The name a run is recorded and summed up under.
  #[arg(long)]
  pub label: Option<String>,
  #[arg(long, default_value_t = 0)]
  pub offset: usize,
  #[arg(long, default_value_t = 1_000_000)]
  pub limit: usize,
  /// Each call's wait in milliseconds, or `profile` for the gate's own wait.
  #[arg(long, default_value = "45000")]
  pub share_ms: String,
  /// The registration every call is asked of.
  #[arg(long)]
  pub registration: Option<String>,
  /// The answer's ceiling; two of them, comma-joined, ask every call at each in turn.
  #[arg(long, default_value = "4096")]
  pub answer_tokens: String,
  /// The whole usage.
  #[arg(short = 'h', long)]
  pub help: bool,
}

/// The bench's folder under the data root, and the set it pins there.
pub fn bench_folder(data_root: &Path) -> PathBuf {
  data_root.join("gate-bench")
}

pub fn set_path(data_root: &Path) -> PathBuf {
  bench_folder(data_root).join("bench-set.json")
}

fn failed(why: impl std::fmt::Display) -> Fault {
  Fault::failed(why)
}

fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One answer of the chat agent's the set pins.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AnswerItem {
  pub kind: String,
  pub id: String,
  pub chat_id: i64,
  pub message_id: i64,
  pub chat_kind: String,
  pub text: String,
}

/// The pinned set: when it was made, and its answers.
#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BenchSet {
  pub made_at: String,
  pub answers: Vec<AnswerItem>,
}

/// One call as the run writes it down: the item and gate, the ceiling it was sent with, how long it took and how
/// it ended, its verdict line, and the answer's size in estimated tokens with whether it stood at the ceiling —
/// which is what a cut answer looks like from outside a service that does not say so.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallRecord {
  pub item: String,
  pub stage: String,
  #[serde(default)]
  pub ceiling: i64,
  pub ms: i64,
  pub outcome: String,
  pub verdict: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub answer_tokens: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub cut: Option<bool>,
}

/// An answer's size in tokens as the bench estimates it: a character of another script near one token, an ASCII
/// character a third of one.
pub fn estimated_tokens(text: &str) -> i64 {
  let (ascii, other) = text.chars().fold((0_i64, 0_i64), |(ascii, other), char| {
    if char.is_ascii() { (ascii + 1, other) } else { (ascii, other + 1) }
  });

  (other as f64 * 0.8 + ascii as f64 * 0.3).ceil() as i64
}

/// The value at a percentile of the values, the lower of two where it falls between them; nought for none.
pub fn percentile(values: &[i64], p: usize) -> i64 {
  let mut sorted = values.to_vec();

  sorted.sort_unstable();

  match sorted.len() {
    0 => 0,
    len => sorted[(p * len / 100).min(len - 1)],
  }
}

/// What one run of the set is handed: its label, the registration it asks, each call's wait, the ceilings, and the
/// stretch of the set it takes.
#[derive(Clone, Debug)]
pub struct Replay {
  pub label: String,
  pub registration: String,
  pub share: String,
  pub ceilings: Vec<i64>,
  pub offset: usize,
  pub limit: usize,
}

// How long one call is given: the number named, or the gate's own wait for the chat agent.
async fn share_of(stages: &Stages, share: &str) -> Result<Duration, Fault> {
  let ms = if share == "profile" {
    options::timeout_ms(&stages.runs.db, GATE_KEY, &stages.runs.chat_agent)
      .await
      .map_err(failed)?
      .ok_or_else(|| failed(fill_marks(words::NO_WAIT, &[("stage", GATE_KEY)])))?
  } else {
    share
      .trim()
      .parse::<i64>()
      .map_err(|_| Fault::Words(fill_marks(words::SHARE, &[("share", share)])))?
  };

  Ok(Duration::from_millis(ms.max(0) as u64))
}

fn append(path: &Path, line: &str) -> Result<(), Fault> {
  let mut file = std::fs::OpenOptions::new().create(true).append(true).open(path).map_err(failed)?;

  writeln!(file, "{line}").map_err(failed)
}

// One item's calls, each timed from the moment it is asked to the moment it answers or gives up. The order a pair
// is asked in alternates, so a queue that is filling while the run goes on cannot land on one ceiling more often
// than the other.
struct Caller<'a> {
  stages: &'a Stages,
  replay: &'a Replay,
  out: PathBuf,
  item: String,
  turn: usize,
}

impl Caller<'_> {
  fn record(&self, ceiling: i64, ms: i64, outcome: &str) -> CallRecord {
    CallRecord {
      item: self.item.clone(),
      stage: GATE_KEY.to_owned(),
      ceiling,
      ms,
      outcome: outcome.to_owned(),
      verdict: None,
      answer_tokens: None,
      cut: None,
    }
  }

  async fn call(&mut self, system: &str, prompt: &str) -> Result<(), Fault> {
    let mut asked = self.replay.ceilings.clone();

    if self.turn % 2 == 1 {
      asked.reverse();
    }

    self.turn += 1;

    for ceiling in asked {
      let wait = share_of(self.stages, &self.replay.share).await?;
      let sampling = PROFILES
        .of(GATE_KEY)
        .and_then(|profile| profile.sampling.as_ref())
        .filter(|sampling| !sampling.is_empty())
        .and_then(|sampling| serde_json::to_string(sampling).ok());
      let ask = Ask {
        model: self.replay.registration.clone(),
        system: system.to_owned(),
        input: prompt.to_owned(),
        max_tokens: ceiling,
        thinking: false,
        wait,
        sampling,
      };
      let started = Instant::now();
      let answered = tokio::time::timeout(wait, self.stages.runs.gateway.complete(&ask)).await;
      let ms = started.elapsed().as_millis() as i64;
      let record = match answered {
        Err(_) => self.record(ceiling, ms, "timeout"),
        Ok(Ok(completion)) => match completion.text.filter(|text| !text.trim().is_empty()) {
          Some(text) => {
            let written = estimated_tokens(&text);

            CallRecord {
              verdict: Some(text.trim().split('\n').next().unwrap_or_default().chars().take(300).collect()),
              answer_tokens: Some(written),
              cut: Some(written >= ceiling),
              ..self.record(ceiling, ms, "answered")
            }
          }
          None => self.record(ceiling, ms, "error"),
        },
        Ok(Err(PortError::Refused { status: 408, .. })) => self.record(ceiling, ms, "timeout"),
        Ok(Err(PortError::Refused {
          status: 400, error, ..
        }))
          if gate_runs::gateway::says_too_large(&error) =>
        {
          self.record(ceiling, ms, "too-large")
        }
        Ok(Err(_)) => self.record(ceiling, ms, "error"),
      };

      append(&self.out, &serde_json::to_string(&record).map_err(failed)?)?;
      println!(
        "{}",
        format!(
          "{} {} @{ceiling} {} {}ms {}",
          record.item,
          record.stage,
          record.outcome,
          record.ms,
          record.verdict.as_deref().unwrap_or_default()
        )
        .chars()
        .take(200)
        .collect::<String>()
      );
    }

    Ok(())
  }
}

/// The ceilings `--answer-tokens` names.
pub fn ceilings(given: &str) -> Result<Vec<i64>, Fault> {
  let read: Result<Vec<i64>, _> = given.split(',').map(|one| one.trim().parse::<i64>()).collect();

  match read {
    Ok(ceilings) if (1..=2).contains(&ceilings.len()) => Ok(ceilings),
    _ => Err(Fault::Words(fill_marks(words::CEILING, &[("ceilings", given)]))),
  }
}

/// One replay of the pinned set: every part of each answer that can be folded asked of the gate's road, its calls
/// written under the run's label.
pub async fn replay(stages: &Stages, data_root: &Path, replay: &Replay) -> Answered {
  let path = set_path(data_root);
  let Ok(text) = std::fs::read_to_string(&path) else {
    return Err(failed(fill_marks(words::NO_SET, &[("path", &path.to_string_lossy())])));
  };
  let set: BenchSet = serde_json::from_str(&text).map_err(failed)?;
  let system = instructions(stages).await.ok_or_else(|| {
    failed(fill_marks(words::NO_INSTRUCTIONS, &[("stage", GATE_KEY), ("why", "see the log")]))
  })?;

  std::fs::create_dir_all(bench_folder(data_root)).map_err(failed)?;

  for item in set.answers.iter().skip(replay.offset).take(replay.limit) {
    let mut caller = Caller {
      stages,
      replay,
      out: bench_folder(data_root).join(format!("bench-{}.jsonl", replay.label)),
      item: item.id.clone(),
      turn: 0,
    };

    // The bench measures the folding dialect's gate, which is the one that folds.
    for part in telegram_parts(&item.text) {
      let converted = convert_markdown(&part);

      if too_short_to_fold(&converted) || folded_markup(&converted).is_none() {
        continue;
      }

      caller.call(&system, &format_request(&converted.markup)).await?;
    }
  }

  Ok(vec![])
}

/// A run summed up: one table line per ceiling, printed and written beside the run.
pub fn summary(data_root: &Path, label: &str) -> Answered {
  let path = bench_folder(data_root).join(format!("bench-{label}.jsonl"));
  let Ok(text) = std::fs::read_to_string(&path) else {
    return Err(failed(fill_marks(words::NO_RUN, &[("path", &path.to_string_lossy())])));
  };
  let records: Vec<CallRecord> = text
    .lines()
    .filter(|line| !line.trim().is_empty())
    .map(|line| serde_json::from_str(line).map_err(failed))
    .collect::<Result<_, _>>()?;
  let items: BTreeSet<&str> = records.iter().map(|record| record.item.as_str()).collect();
  let mut lines = vec![
    fill_marks(words::SUMMARY_TITLE, &[("label", label)]),
    String::new(),
    fill_marks(
      words::SUMMARY_COUNTS,
      &[
        ("calls", &records.len().to_string()),
        ("items", &items.len().to_string()),
        ("at", &now_iso()),
      ],
    ),
    String::new(),
    words::SUMMARY_HEAD.to_owned(),
    words::SUMMARY_RULE.to_owned(),
  ];
  let ceilings: BTreeSet<i64> = records.iter().map(|record| record.ceiling).collect();

  for ceiling in ceilings {
    let of: Vec<&CallRecord> = records
      .iter()
      .filter(|record| record.stage == GATE_KEY && record.ceiling == ceiling)
      .collect();

    if of.is_empty() {
      continue;
    }

    let answered: Vec<&&CallRecord> = of.iter().filter(|record| record.outcome == "answered").collect();
    let answered_ms: Vec<i64> = answered.iter().map(|record| record.ms).collect();
    let written: Vec<i64> =
      answered.iter().map(|record| record.answer_tokens.unwrap_or_default()).collect();

    lines.push(format!(
      "| {GATE_KEY} | {ceiling} | {} | {} | {} | {} | {} | {} | {} | {} | {} | {} |",
      of.len(),
      answered.len(),
      percentile(&answered_ms, 50),
      percentile(&answered_ms, 90),
      of.iter().map(|record| record.ms).max().unwrap_or_default().max(0),
      of.iter().filter(|record| record.outcome == "timeout").count(),
      of.iter()
        .filter(|record| record.outcome != "answered" && record.outcome != "timeout")
        .count(),
      percentile(&written, 90),
      written.iter().copied().max().unwrap_or_default().max(0),
      answered.iter().filter(|record| record.cut == Some(true)).count(),
    ));
  }

  let out = bench_folder(data_root).join(format!("bench-{label}.md"));

  std::fs::write(&out, format!("{}\n", lines.join("\n"))).map_err(failed)?;
  lines.push(String::new());
  lines.push(fill_marks(words::WRITTEN, &[("path", &out.to_string_lossy())]));

  Ok(lines)
}

fn needs(command: &str, flag: &str) -> Fault {
  Fault::Words(fill_marks(words::NEEDS, &[("command", command), ("flag", flag)]))
}

/// One run of `bmo gate bench`.
pub async fn gate_bench(args: GateBenchArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE.to_owned()]);
  }

  match args.command.as_deref() {
    // The chat agent's answers are the receiver's, which serves no route for a room's messages yet.
    Some("make-set") => Err(failed(words::UNAVAILABLE)),
    Some("run") => {
      let label = args.label.clone().ok_or_else(|| needs("run", "--label <name>"))?;
      let registration = args.registration.clone().ok_or_else(|| needs("run", "--registration <name>"))?;
      let given = Replay {
        label,
        registration,
        share: args.share_ms.clone(),
        ceilings: ceilings(&args.answer_tokens)?,
        offset: args.offset,
        limit: args.limit,
      };
      let settings = crate::settings()?;
      let stages = crate::stages(&settings).await?;

      replay(&stages, &settings.data_root, &given).await
    }
    Some("summary") => {
      let label = args.label.as_deref().ok_or_else(|| needs("summary", "--label <name>"))?;

      summary(&crate::settings()?.data_root, label)
    }
    _ => Err(Fault::Words(words::COMMAND.to_owned())),
  }
}
