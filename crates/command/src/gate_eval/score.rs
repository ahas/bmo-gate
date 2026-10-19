//! Scoring the set on a road (docs/gate-eval.md, 「Scoring」): each gate asked through the gate's own run with the
//! road put in place of its configured one, its items one at a time.

use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use futures_util::future::join_all;
use gate_runs::{GateRequest, route};
use gate_stages::Stages;
use serde::{Deserialize, Serialize};

use super::member::{Ask, EvalGate, Score};
use super::store::{append_line, gate_items, read_json, scores_folder, write_json};

/// The provider the Claude road asks on.
pub const CLAUDE_PROVIDER: &str = "claude-code";

/// A road the gates are scored on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Road {
  /// The Claude model the gate's tier maps to on Claude Code.
  Claude,
  /// A registration, asked through the agency's model gateway.
  Registered(String),
}

impl Road {
  /// The roads by the names a score is asked on them by.
  pub const NAMES: [&str; 2] = ["claude", "registered"];

  /// The road a name and a registration make, or none where they make none.
  pub fn named(name: &str, registration: Option<&str>) -> Option<Self> {
    match (name, registration) {
      ("claude", _) => Some(Self::Claude),
      ("registered", Some(registration)) if !registration.trim().is_empty() => {
        Some(Self::Registered(registration.trim().to_owned()))
      }
      _ => None,
    }
  }

  pub fn name(&self) -> &'static str {
    match self {
      Self::Claude => "claude",
      Self::Registered(_) => "registered",
    }
  }

  /// Whether the gates are asked side by side. A registration has one slot, so its gates are asked one after
  /// another and a time is one answer's wait rather than a place in the queue.
  fn side_by_side(&self) -> bool {
    *self == Self::Claude
  }

  /// The model a gate is asked on here.
  async fn model(&self, stages: &Stages, stage: &str) -> String {
    match self {
      Self::Claude => route::read_on(&stages.runs, stage, Some(CLAUDE_PROVIDER))
        .await
        .map(|road| road.model().to_owned())
        .unwrap_or_default(),
      Self::Registered(registration) => registration.clone(),
    }
  }

  /// A request sent down this road in place of the gate's configured one, its options standing.
  fn put(&self, request: &mut GateRequest) {
    match self {
      Self::Claude => request.provider = Some(CLAUDE_PROVIDER.to_owned()),
      Self::Registered(registration) => request.registration = Some(registration.clone()),
    }
  }
}

/// One item's score on one road, as the scores' lines keep it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScoreLine {
  #[serde(flatten)]
  pub score: Score,
  pub gate: String,
  pub id: String,
  pub difficulty: String,
  pub road: String,
  pub model: String,
  pub ms: u64,
}

/// How many of one kind of item were asked and passed.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Tally {
  pub asked: usize,
  pub passed: usize,
}

/// One gate's figures on one road.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GateFigures {
  pub gate: String,
  pub road: String,
  pub model: String,
  pub asked: usize,
  pub answered: usize,
  pub passed: usize,
  pub share: f64,
  pub easy: Tally,
  pub borderline: Tally,
  pub median_seconds: f64,
  pub ninetieth_seconds: f64,
}

/// One scoring run as its summary keeps it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ScoreRun {
  pub set: String,
  pub road: String,
  pub started: String,
  pub ended: String,
  pub gates: Vec<GateFigures>,
}

fn percentile(values: &[f64], share: f64) -> f64 {
  let mut sorted = values.to_vec();

  sorted.sort_by(f64::total_cmp);

  match sorted.len() {
    0 => 0.0,
    len => sorted[((share * len as f64).floor() as usize).min(len - 1)],
  }
}

fn tenths(value: f64) -> f64 {
  (value * 10.0).round() / 10.0
}

pub fn figures_of(gate: &str, road: &str, model: &str, lines: &[ScoreLine]) -> GateFigures {
  let of = |difficulty: &str| {
    let asked: Vec<&ScoreLine> = lines.iter().filter(|line| line.difficulty == difficulty).collect();

    Tally {
      asked: asked.len(),
      passed: asked.iter().filter(|line| line.score.pass).count(),
    }
  };
  let seconds: Vec<f64> = lines
    .iter()
    .filter(|line| line.score.answered)
    .map(|line| line.ms as f64 / 1000.0)
    .collect();
  let shares: f64 = lines
    .iter()
    .map(|line| {
      if line.score.checks == 0 {
        0.0
      } else {
        line.score.met as f64 / line.score.checks as f64
      }
    })
    .sum();

  GateFigures {
    gate: gate.to_owned(),
    road: road.to_owned(),
    model: model.to_owned(),
    asked: lines.len(),
    answered: lines.iter().filter(|line| line.score.answered).count(),
    passed: lines.iter().filter(|line| line.score.pass).count(),
    share: if lines.is_empty() { 0.0 } else { shares / lines.len() as f64 },
    easy: of("easy"),
    borderline: of("borderline"),
    median_seconds: tenths(percentile(&seconds, 0.5)),
    ninetieth_seconds: tenths(percentile(&seconds, 0.9)),
  }
}

/// So many items spread evenly over the set, so a sample covers every topic the batches cycled through rather
/// than the first few.
pub fn spread<T: Clone>(items: &[T], limit: Option<usize>) -> Vec<T> {
  match limit {
    Some(limit) if limit < items.len() => {
      (0..limit).map(|at| items[at * items.len() / limit].clone()).collect()
    }
    _ => items.to_vec(),
  }
}

/// What a scoring run is handed: the gates it runs, the set, the road, how many items of each gate it takes, and
/// where it says how it goes.
pub struct Scoring<'a> {
  pub stages: Arc<Stages>,
  pub data_root: &'a Path,
  pub set: &'a str,
  pub road: Road,
  pub limit: Option<usize>,
  pub log: &'a (dyn Fn(&str) + Sync),
}

// The road a member's questions go down: the gate's own run with this road in its place.
fn asking(stages: &Arc<Stages>, stage: &'static str, road: &Road) -> Ask {
  let stages = Arc::clone(stages);
  let road = road.clone();

  Arc::new(move |mut request: GateRequest| {
    let stages = Arc::clone(&stages);

    road.put(&mut request);

    Box::pin(async move {
      match stages.runs.run(stage, &request).await {
        Ok(answer) => answer,
        Err(why) => {
          eprintln!("{stage}: the gate's run failed: {why}");
          None
        }
      }
    })
  })
}

async fn score_gate(
  member: &dyn EvalGate,
  given: &Scoring<'_>,
  lines_path: &Path,
) -> Result<GateFigures, String> {
  let stage = member.stage();
  let model = given.road.model(&given.stages, stage).await;
  // The member's own cases are asked after the set's items, whatever the limit.
  let mut items = spread(&gate_items(given.data_root, given.set, stage)?, given.limit);

  items.extend(member.cases());

  let ask = asking(&given.stages, stage, &given.road);
  let mut lines = vec![];

  for item in items {
    let started = Instant::now();
    let score = member.run(&given.stages, &item.input, &item.key, &ask).await;
    let line = ScoreLine {
      score,
      gate: stage.to_owned(),
      id: item.id.clone(),
      difficulty: item.difficulty.clone(),
      road: given.road.name().to_owned(),
      model: model.clone(),
      ms: started.elapsed().as_millis() as u64,
    };
    let mut kept = line.clone();

    kept.score.answer = kept.score.answer.map(|answer| answer.chars().take(4_000).collect());
    append_line(lines_path, &kept)?;

    let mut said = format!(
      "{stage} {} {} {}/{} {}s",
      line.id,
      if line.score.pass { "pass" } else { "fail" },
      line.score.met,
      line.score.checks,
      tenths(line.ms as f64 / 1000.0)
    );

    if !line.score.pass {
      said.push_str(&format!(
        " {}",
        line.score.misses.iter().take(2).cloned().collect::<Vec<_>>().join("; ")
      ));
    }

    (given.log)(&said.chars().take(300).collect::<String>());
    lines.push(line);
  }

  Ok(figures_of(stage, given.road.name(), &model, &lines))
}

fn now_iso() -> String {
  chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// One scoring run over the given gates, its lines and its summary written under the set's scores.
pub async fn score_set(members: &[&dyn EvalGate], given: &Scoring<'_>) -> Result<ScoreRun, String> {
  let started = now_iso();
  let stamp = started.replace([':', '.'], "-");
  let folder = scores_folder(given.data_root, given.set);
  let lines_path = folder.join(format!("{}-{stamp}.jsonl", given.road.name()));
  let gates = if given.road.side_by_side() {
    join_all(members.iter().map(|member| score_gate(*member, given, &lines_path)))
      .await
      .into_iter()
      .collect()
  } else {
    let mut gates = vec![];

    for member in members {
      gates.push(score_gate(*member, given, &lines_path).await?);
    }

    Ok(gates)
  }?;
  let run = ScoreRun {
    set: given.set.to_owned(),
    road: given.road.name().to_owned(),
    started,
    ended: now_iso(),
    gates,
  };

  write_json(&folder.join(format!("{}-{stamp}.json", given.road.name())), &run)?;

  Ok(run)
}

/// The latest figures of each gate on each road and model, read from the run summaries in time order: a road on
/// two registrations is two roads.
pub fn latest_figures(data_root: &Path, set: &str) -> Vec<GateFigures> {
  let Ok(listed) = std::fs::read_dir(scores_folder(data_root, set)) else {
    return vec![];
  };
  let mut names: Vec<_> = listed
    .flatten()
    .map(|entry| entry.path())
    .filter(|path| path.extension().is_some_and(|extension| extension == "json"))
    .collect();
  let mut latest: Vec<GateFigures> = vec![];

  names.sort();

  for path in names {
    for figures in read_json::<ScoreRun>(&path).map(|run| run.gates).unwrap_or_default() {
      if figures.asked == 0 {
        continue;
      }

      latest.retain(|one| {
        !(one.gate == figures.gate && one.road == figures.road && one.model == figures.model)
      });
      latest.push(figures);
    }
  }

  latest.sort_by(|a, b| {
    a.gate
      .cmp(&b.gate)
      .then_with(|| a.road.cmp(&b.road))
      .then_with(|| a.model.cmp(&b.model))
  });
  latest
}
