//! A gate's run on its one road (`docs/gates.md`; `docs/boundary-api.md`, 「How a gate run reaches a model」): one
//! prompt in, one text out, on the one provider the gate's road begins on, waited for as long as the gate's own
//! row says and no longer, with nothing behind it. What did not answer is the gate having no answer; what
//! somebody stopped is raised to the caller.

pub mod gateway;
pub mod live;
pub mod options;
pub mod pool;
pub mod records;
pub mod route;
pub mod session;
pub mod summary;
pub mod tried;

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use gate_ports::agency::Agency;
use gate_ports::gateway::Gateway;
use sea_orm::DatabaseConnection;
use tokio::time::Instant;

use self::pool::Pools;
use self::records::{Outcome, Road};
use self::route::{Route, Way};

/// Where the session summariser reads a closed session's record: Claude Code's configuration folders, searched
/// in order, and Codex's sessions folder.
#[derive(Clone, Debug, Default)]
pub struct RecordFolders {
  pub claude: Vec<PathBuf>,
  pub codex: Option<PathBuf>,
}

/// What every run of this service stands on: the gate's database, the agency and its model gateway, the chat
/// agent whose options stand outside any turn, the folder a thrown-away session is started in, and where a
/// closed session's record is read.
pub struct Runs {
  pub db: DatabaseConnection,
  pub agency: Arc<dyn Agency>,
  pub gateway: Arc<dyn Gateway>,
  pub chat_agent: String,
  /// The agent a run's session stands under where the settings name one: a place of the gate's own, apart
  /// from the chat agent's, whose turns a gate run would otherwise stand over.
  pub run_agent: Option<String>,
  pub session_folder: String,
  pub records: RecordFolders,
  pools: Pools,
}

// The number each run of this service is told apart by.
static LIVE: AtomicU64 = AtomicU64::new(1);

/// One gate's request: its instructions, the one call's material, what it judges, whose turn it runs in and
/// which round, whether it thinks, whether it stands beside the gate's other runs, and how its caller cuts it
/// where it is too large for its road.
pub struct GateRequest {
  pub system: String,
  pub prompt: String,
  pub chat_id: Option<i64>,
  pub message_id: Option<i64>,
  /// The agent whose turn the gate runs in, whose rows it reads; the chat agent's outside any turn.
  pub agent: Option<String>,
  /// The round the run belongs to, which its road is written under.
  pub round: Option<String>,
  pub thinking: bool,
  pub alongside: bool,
  pub split: Option<Arc<dyn Split>>,
  /// Whether the run is a gate on Laya asking its fallback LLM, where Laya gave no verdict: its road then reads
  /// as that LLM's.
  pub laya_fallback: bool,
  /// The registration the run goes out on in place of the gate's own road, with nothing behind it: the model of
  /// the agent whose memory a recollector writes.
  pub registration: Option<String>,
  /// The provider the run goes out on in place of the one the gate's road begins on, with nothing behind it:
  /// the road a gate evaluation scores the gate on.
  pub provider: Option<String>,
}

impl GateRequest {
  /// A request with nothing but its instructions and material: judged for no room, outside any turn, thinking,
  /// taking its turn among the gate's runs, and not cut.
  pub fn new(system: impl Into<String>, prompt: impl Into<String>) -> Self {
    Self {
      system: system.into(),
      prompt: prompt.into(),
      chat_id: None,
      message_id: None,
      agent: None,
      round: None,
      thinking: true,
      alongside: false,
      split: None,
      laya_fallback: false,
      registration: None,
      provider: None,
    }
  }

  /// The same request on other material, for one part of a cut: the part's own judgement, nothing else of it
  /// changed.
  pub fn part(&self, prompt: impl Into<String>) -> Self {
    Self {
      system: self.system.clone(),
      prompt: prompt.into(),
      chat_id: self.chat_id,
      message_id: self.message_id,
      agent: self.agent.clone(),
      round: self.round.clone(),
      thinking: self.thinking,
      alongside: self.alongside,
      split: None,
      laya_fallback: self.laya_fallback,
      registration: self.registration.clone(),
      provider: self.provider.clone(),
    }
  }
}

/// How a caller cuts a request too large for its road, and joins the answers to the parts.
pub trait Split: Send + Sync {
  /// The parts, in order, or none where the request cannot be cut further.
  fn halve(&self) -> Option<Vec<Piece>>;
  /// The answer to the whole, out of the parts' answers in order; none where the parts leave it none.
  fn join(&self, answers: Vec<Option<String>>) -> Option<String>;
}

/// One part of a cut request: answered already by the caller's own reading, or asked of the gate.
pub enum Piece {
  Answered(String),
  Asked(GateRequest),
}

/// Why a gate's run gave no answer to hand on: somebody stopped it, or something under it failed in a way that
/// is no gate's missing answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateError {
  Stopped(String),
  Fault(String),
}

impl std::fmt::Display for GateError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    match self {
      GateError::Stopped(why) | GateError::Fault(why) => f.write_str(why),
    }
  }
}

impl std::error::Error for GateError {}

pub(crate) fn fault(why: impl std::fmt::Display) -> GateError {
  GateError::Fault(why.to_string())
}

/// What one run of a gate is, as each road carries it: the gate, the request, the road and the moment its wait
/// runs out.
pub struct Run<'a> {
  pub stage: &'a str,
  pub request: &'a GateRequest,
  pub route: &'a Route,
  pub deadline: Instant,
  /// The name the run goes out under, which a stop names it by.
  pub name: String,
}

impl Run<'_> {
  /// What is left of the run's wait.
  pub fn left(&self) -> Duration {
    self.deadline.saturating_duration_since(Instant::now())
  }
}

impl Runs {
  pub fn new(
    db: DatabaseConnection,
    agency: Arc<dyn Agency>,
    gateway: Arc<dyn Gateway>,
    chat_agent: impl Into<String>,
    session_folder: impl Into<String>,
    records: RecordFolders,
  ) -> Self {
    Self {
      db,
      agency,
      gateway,
      chat_agent: chat_agent.into(),
      run_agent: None,
      session_folder: session_folder.into(),
      records,
      pools: Pools::default(),
    }
  }

  /// The gate's judgement on its one road, or none where the road gave none.
  pub async fn run(&self, stage: &str, request: &GateRequest) -> Result<Option<String>, GateError> {
    let mut route = match (&request.registration, &request.provider) {
      (Some(registration), _) => route::read_registered(self, stage, registration).await?,
      (None, Some(provider)) => route::read_on(self, stage, Some(provider)).await?,
      (None, None) => route::read(self, stage).await?,
    };

    // A gate on Laya asking its fallback LLM runs on that LLM's road, where its row leaves it one.
    if route.laya
      && request.laya_fallback
      && let Some(fallback) = options::laya_fallback(self, stage).await?
    {
      route = route::read_on(self, stage, Some(&fallback)).await?;
    }

    // A gate on Laya has no model to run: whoever asked for one is told so and given no answer, never a run on
    // another road in Laya's place.
    if route.laya {
      println!("{stage}: this gate stands on Laya, so no model is run for it");
      return Ok(None);
    }

    // A gate whose row holds no wait is not run.
    let agent = request.agent.as_deref().unwrap_or(&self.chat_agent);
    let Some(timeout_ms) = options::timeout_ms(&self.db, stage, agent).await.map_err(fault)? else {
      eprintln!(
        "{stage}: no gate options row holds a wait for {agent}; the gate is not run and has no answer"
      );
      return Ok(None);
    };
    let started = Instant::now();
    let deadline = started + Duration::from_millis(timeout_ms.max(0) as u64);
    let live = LIVE.fetch_add(1, Ordering::Relaxed);
    let run = Run {
      stage,
      request,
      route: &route,
      deadline,
      name: format!("gate:{stage}:{live}"),
    };

    // A run waits for its place in the gate's pool within its wait, but for one standing beside the gate's
    // other runs.
    let place = if request.alongside {
      None
    } else {
      match self.pools.take(stage, &route, deadline).await {
        Some(place) => Some(place),
        None => {
          self
            .road(&run, Outcome::Timeout, records::elapsed_ms(started), &records::Spent::none())
            .await;
          println!("{stage}: no place of its pool came free within its wait; this gate has no answer");
          return Ok(None);
        }
      }
    };
    // The run stands in the live board from here until it returns, whichever way it does.
    let _drawn = live::hold(live::GateRun {
      id: live,
      stage: stage.to_owned(),
      chat_id: request.chat_id,
      message_id: request.message_id,
      started_at: records::now(),
      cap_seconds: timeout_ms.max(0) / 1000,
    });
    let answer = self.carry(&run).await;

    drop(place);
    answer
  }

  // The run carried on its road, a request too large for a registration cut where its caller can cut it.
  async fn carry(&self, run: &Run<'_>) -> Result<Option<String>, GateError> {
    let stage = run.stage;
    let started = Instant::now();

    println!("{stage}: {} goes out on {} · {}", run.name, run.route.provider, run.route.model());

    let ended = match run.route.way {
      Way::Session => session::ask(self, run).await,
      Way::Gateway => gateway::ask(self, run).await,
    };
    let ms = records::elapsed_ms(started);

    match ended {
      Err(GateError::Stopped(why)) => {
        self.road(run, Outcome::Stopped, ms, &records::Spent::none()).await;
        println!("{stage}: {} was stopped", run.name);
        Err(GateError::Stopped(why))
      }
      Err(fault) => Err(fault),
      Ok(Ended::Answered { text, model, spent }) => {
        self.road_on(run, &model, Outcome::Answered, ms, &spent).await;
        println!("{stage}: {} answered on {model}", run.name);
        Ok(Some(text))
      }
      Ok(Ended::Unanswered { outcome, why }) => {
        self.road(run, outcome, ms, &records::Spent::none()).await;

        match (outcome, &run.request.split) {
          (Outcome::TooLarge, Some(split)) => self.cut(run, split.as_ref()).await,
          _ => {
            println!("{stage}: {} had no answer ({}): {why}", run.name, outcome.word());
            Ok(None)
          }
        }
      }
    }
  }

  // A request too large for its road, cut into the parts its caller makes and each asked on its own, on the
  // same road and within the same wait.
  async fn cut(&self, run: &Run<'_>, split: &dyn Split) -> Result<Option<String>, GateError> {
    let stage = run.stage;
    let Some(parts) = split.halve() else {
      println!("{stage}: {} was too large and cannot be cut further; this gate has no answer", run.name);
      return Ok(None);
    };

    println!("{stage}: {} was too large; cut into {} parts", run.name, parts.len());

    let mut answers = Vec::new();

    for part in parts {
      answers.push(match part {
        Piece::Answered(answer) => Some(answer),
        Piece::Asked(request) => {
          let part = Run {
            stage,
            request: &request,
            route: run.route,
            deadline: run.deadline,
            name: run.name.clone(),
          };

          Box::pin(self.carry(&part)).await?
        }
      });
    }

    Ok(split.join(answers))
  }

  async fn road(&self, run: &Run<'_>, outcome: Outcome, ms: i64, spent: &records::Spent) {
    self.road_on(run, run.route.model(), outcome, ms, spent).await;
  }

  async fn road_on(&self, run: &Run<'_>, model: &str, outcome: Outcome, ms: i64, spent: &records::Spent) {
    records::road(
      &self.db,
      &Road {
        stage: run.stage,
        chat_id: run.request.chat_id,
        message_id: run.request.message_id,
        provider: &run.route.provider,
        model,
        outcome: outcome.word(),
        ms,
        spent,
        round: run.request.round.as_deref(),
        run: Some(&run.name),
        context_ratio: None,
      },
    )
    .await;
  }
}

/// How one road carried a run: answered with its text, the model that answered and what it spent, or with no
/// answer, how and why.
pub enum Ended {
  Answered {
    text: String,
    model: String,
    spent: records::Spent,
  },
  Unanswered {
    outcome: Outcome,
    why: String,
  },
}
