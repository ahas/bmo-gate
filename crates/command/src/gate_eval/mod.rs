//! `gate eval` (docs/gate-eval.md): the gates' evaluation set — its generation on Codex, how far it has come, and
//! its scoring on a road.

pub mod codex;
pub mod gates;
pub mod generate;
pub mod member;
pub mod score;
pub mod store;

use std::os::unix::fs::MetadataExt as _;
use std::path::Path;
use std::sync::Arc;

use clap::Args;
use futures_util::future::join_all;
use gate_policy::fill_marks;
use gate_stages::Stages;
use gate_words::gate_eval as words;

use self::codex::{Codex, CodexRun};
use self::generate::{Generation, generate_gate};
use self::member::EvalGate;
use self::score::{Road, Scoring, latest_figures, score_set};
use self::store::{gate_batches, gate_items, gate_state, set_folder};
use crate::{Answered, Fault};

/// The transient user unit the generation runs as.
pub const UNIT: &str = "bmo-gate-eval";

/// The noun's arguments: its command and the flags each reads, a flag given twice standing as given last.
#[derive(Args, Debug, Default)]
pub struct GateEvalArgs {
  /// start, generate, status, score or report.
  pub command: Option<String>,
  #[arg(hide = true)]
  pub rest: Vec<String>,
  /// The set's name, v1 where none is given; an absolute path is that folder.
  #[arg(long, allow_hyphen_values = true)]
  pub set: Vec<String>,
  /// That gate alone; given again for each more.
  #[arg(long = "gate", allow_hyphen_values = true)]
  pub gates: Vec<String>,
  #[arg(long, allow_hyphen_values = true)]
  pub per_gate: Vec<String>,
  #[arg(long, allow_hyphen_values = true)]
  pub road: Vec<String>,
  /// The registration the registered road asks.
  #[arg(long, allow_hyphen_values = true)]
  pub registration: Vec<String>,
  #[arg(long, allow_hyphen_values = true)]
  pub limit: Vec<String>,
  #[arg(long, allow_hyphen_values = true)]
  pub batch: Vec<String>,
  /// The whole usage.
  #[arg(short = 'h', long)]
  pub help: bool,
}

impl GateEvalArgs {
  pub fn set(&self) -> &str {
    self.set.last().map_or("v1", String::as_str)
  }
}

// A refusal of the words given, with where the whole usage is.
fn refused(said: &str) -> Fault {
  Fault::Words(format!("{said}\nRun bmo gate eval --help for the whole usage."))
}

// A count a flag gives: a whole number from one, or none where the flag is not given.
fn count(flag: &str, given: &[String]) -> Result<Option<usize>, Fault> {
  let Some(given) = given.last() else { return Ok(None) };

  match given.trim().parse::<usize>() {
    Ok(number) if number >= 1 => Ok(Some(number)),
    _ => Err(refused(&fill_marks(words::COUNT, &[("flag", flag)]))),
  }
}

/// The gates the words name, every one where they name none.
pub fn chosen_gates(args: &GateEvalArgs) -> Result<Vec<&'static dyn EvalGate>, Fault> {
  let all = gates::members();
  let unknown: Vec<&str> = args
    .gates
    .iter()
    .filter(|stage| !all.iter().any(|member| member.stage() == stage.as_str()))
    .map(String::as_str)
    .collect();

  if !unknown.is_empty() {
    let known: Vec<&str> = all.iter().map(|member| member.stage()).collect();

    return Err(refused(&fill_marks(
      words::GATE,
      &[("unknown", &unknown.join(", ")), ("known", &known.join(", "))],
    )));
  }

  Ok(
    all
      .into_iter()
      .filter(|member| args.gates.is_empty() || args.gates.iter().any(|stage| stage == member.stage()))
      .collect(),
  )
}

/// How far each gate's set has come, with the lines of the gates that have no member.
pub fn status(data_root: &Path, args: &GateEvalArgs, members: &[&dyn EvalGate]) -> Answered {
  let set = args.set();
  let per_gate = count("--per-gate", &args.per_gate)?;
  let mut lines = vec![
    fill_marks(
      words::STATUS_SET,
      &[("set", set), ("folder", &set_folder(data_root, set).to_string_lossy())],
    ),
    words::STATUS_HEAD.to_owned(),
  ];

  for member in members {
    let stage = member.stage();
    let state = gate_state(data_root, set, stage);
    let batches = gate_batches(data_root, set, stage).map_err(Fault::failed)?;
    let kept = gate_items(data_root, set, stage).map_err(Fault::failed)?.len();
    let target = per_gate.or(state.wanted).unwrap_or_else(|| member.per_gate());
    let dropped: usize = batches.iter().map(|batch| batch.dropped.values().sum::<usize>()).sum();

    lines.push(
      [
        stage.to_owned(),
        state.status,
        kept.to_string(),
        target.to_string(),
        target.saturating_sub(kept).to_string(),
        batches.len().to_string(),
        batches.iter().map(|batch| batch.asked).sum::<usize>().to_string(),
        batches.iter().map(|batch| batch.refused).sum::<usize>().to_string(),
        dropped.to_string(),
        state.reason.unwrap_or_default(),
      ]
      .join(" | "),
    );
  }

  Ok(lines)
}

/// The last score of each gate on each road, side by side.
pub fn report(data_root: &Path, set: &str) -> Vec<String> {
  let figures = latest_figures(data_root, set);

  if figures.is_empty() {
    return vec![fill_marks(words::REPORT_NONE, &[("set", set)])];
  }

  let percent = |part: f64| format!("{}%", (part * 100.0).round());
  let mut lines = vec![words::REPORT_HEAD.to_owned()];

  for one in figures {
    let rate = if one.asked == 0 {
      "-".to_owned()
    } else {
      percent(one.passed as f64 / one.asked as f64)
    };

    lines.push(
      [
        one.gate,
        one.road,
        one.model,
        one.asked.to_string(),
        one.answered.to_string(),
        one.passed.to_string(),
        rate,
        format!("{}/{}", one.easy.passed, one.easy.asked),
        format!("{}/{}", one.borderline.passed, one.borderline.asked),
        percent(one.share),
        one.median_seconds.to_string(),
        one.ninetieth_seconds.to_string(),
      ]
      .join(" | "),
    );
  }

  lines
}

// The user's own service manager reached whatever line this process was started on: the runtime directory named
// where it is missing, and a bus address marked off taken away.
fn on_user_bus(command: &mut std::process::Command) {
  if std::env::var("XDG_RUNTIME_DIR").ok().is_none_or(|dir| dir.is_empty())
    && let Ok(own) = std::fs::metadata("/proc/self")
  {
    command.env("XDG_RUNTIME_DIR", format!("/run/user/{}", own.uid()));
  }

  if std::env::var("DBUS_SESSION_BUS_ADDRESS").is_ok_and(|address| address == "disabled:") {
    command.env_remove("DBUS_SESSION_BUS_ADDRESS");
  }
}

/// The words the generation's unit is started with, after the binary: the noun's own and the flags it was given.
pub fn unit_words(args: &GateEvalArgs) -> Vec<String> {
  let mut passed = vec!["gate".to_owned(), "eval".to_owned(), "generate".to_owned()];

  for (flag, values) in [
    ("--set", &args.set),
    ("--gate", &args.gates),
    ("--per-gate", &args.per_gate),
    ("--batch", &args.batch),
  ] {
    for value in values {
      passed.extend([flag.to_owned(), value.clone()]);
    }
  }

  passed
}

// The generation as a transient unit of the user's manager, run by this binary in the folder this command runs in
// on the settings it read, so it outlives whoever started it.
fn start(args: &GateEvalArgs) -> Answered {
  let failed = |why: &dyn std::fmt::Display| Fault::failed(format!("gate eval: {why}"));
  let mut active = std::process::Command::new("systemctl");

  active.args(["--user", "is-active", "--quiet", UNIT]);
  on_user_bus(&mut active);

  if active.status().is_ok_and(|status| status.success()) {
    return Err(Fault::failed(fill_marks(words::RUNNING, &[("unit", UNIT)])));
  }

  let here = std::env::current_dir().map_err(|why| failed(&why))?;
  let binary = std::env::current_exe().map_err(|why| failed(&why))?;
  let settings = std::path::absolute(crate::settings_path()).map_err(|why| failed(&why))?;
  let mut line = std::process::Command::new("systemd-run");

  line
    .args(["--user", "--quiet", "--collect", &format!("--unit={UNIT}")])
    .arg(format!("--property=WorkingDirectory={}", here.display()))
    .arg(format!("--setenv={}={}", crate::SETTINGS_VARIABLE, settings.display()))
    .arg(format!("--setenv=PATH={}", std::env::var("PATH").unwrap_or_default()))
    .arg(&binary)
    .args(unit_words(args));
  on_user_bus(&mut line);

  let started = line.status().map_err(|why| failed(&format!("systemd-run: {why}")))?;

  if !started.success() {
    return Err(failed(&format!("systemd-run ended with {started}")));
  }

  Ok(vec![fill_marks(
    words::STARTED,
    &[("unit", UNIT), ("tree", &here.to_string_lossy()), ("set", args.set())],
  )])
}

/// One generation over the chosen gates, side by side, its status printed after it.
pub async fn generate(
  data_root: &Path,
  stages: &Stages,
  codex: &dyn CodexRun,
  args: &GateEvalArgs,
  log: &(dyn Fn(&str) + Sync),
) -> Answered {
  let members = chosen_gates(args)?;
  let given = Generation {
    data_root,
    set: args.set(),
    per_gate: count("--per-gate", &args.per_gate)?,
    batch: count("--batch", &args.batch)?,
    codex,
    stages,
    log,
  };
  let generated = join_all(members.iter().map(|member| {
    let given = &given;

    async move {
      let generated = generate_gate(*member, given).await;

      if let Err(why) = &generated {
        eprintln!("{}: generation fell over: {why}", member.stage());
      }

      generated.is_ok()
    }
  }))
  .await;
  let lines = status(data_root, args, &members)?;

  if generated.contains(&false) {
    return Err(Fault::Failed {
      lines,
      said: String::new(),
    });
  }

  Ok(lines)
}

/// The road the words name, or the refusal naming the roads there are.
pub fn road_of(args: &GateEvalArgs) -> Result<Road, Fault> {
  args
    .road
    .last()
    .and_then(|road| Road::named(road, args.registration.last().map(String::as_str)))
    .ok_or_else(|| refused(&fill_marks(words::ROAD, &[("roads", &Road::NAMES.join(words::ROADS_JOINED))])))
}

/// One scoring run over the chosen gates, the report printed after it.
pub async fn score(
  data_root: &Path,
  stages: Arc<Stages>,
  args: &GateEvalArgs,
  log: &(dyn Fn(&str) + Sync),
) -> Answered {
  let road = road_of(args)?;
  let members = chosen_gates(args)?;
  let given = Scoring {
    stages,
    data_root,
    set: args.set(),
    road,
    limit: count("--limit", &args.limit)?,
    log,
  };

  score_set(&members, &given).await.map_err(Fault::failed)?;

  Ok(report(data_root, args.set()))
}

/// One run of `bmo gate eval`.
pub async fn gate_eval(args: GateEvalArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE.to_owned()]);
  }

  let Some(command) = args.command.clone().filter(|_| args.rest.is_empty()) else {
    return Err(refused(words::COMMAND));
  };
  let log = |line: &str| println!("{line}");

  match command.as_str() {
    "start" => {
      chosen_gates(&args)?;
      start(&args)
    }
    "generate" => {
      let settings = crate::settings()?;
      let stages = crate::stages(&settings).await?;
      let codex = Codex::new().map_err(Fault::failed)?;

      generate(&settings.data_root, &stages, &codex, &args, &log).await
    }
    "status" => status(&crate::settings()?.data_root, &args, &chosen_gates(&args)?),
    "score" => {
      road_of(&args)?;

      let settings = crate::settings()?;
      let stages = crate::stages(&settings).await?;

      score(&settings.data_root, stages, &args, &log).await
    }
    "report" => Ok(report(&crate::settings()?.data_root, args.set())),
    other => Err(refused(&fill_marks(words::UNKNOWN_COMMAND, &[("command", other)]))),
  }
}
