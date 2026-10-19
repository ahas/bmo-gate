//! The agency port (`docs/boundary-api.md`, 「bmo-agency」 and 「How a gate run reaches a model」): the agents and
//! the shared rulebooks, the providers, a work key's route and mapping, the stand-in, a thrown-away session and
//! its one turn, a run stopped, the roads a turn walked, and the gate's hook registered. Bodies are camelCase,
//! but for a turn's work parts, which go by the snake-case names a job's runner sends them.

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::http::{Answer, Caller, Peer, PortError};

/// One agent as the agency lists it: what the gate reads of it, and the rest of its row as it stands.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
  pub name: String,
  pub label: Option<String>,
  pub awake: bool,
  pub brain_folder: Option<String>,
  pub recollector_registration: Option<String>,
  #[serde(flatten)]
  pub rest: Map<String, Value>,
}

/// A shared rulebook, by its name and its text.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Rulebook {
  pub name: String,
  pub text: String,
}

/// A provider in the walk's order, and what it declares.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Provider {
  pub name: String,
  pub enabled: bool,
  pub registered: bool,
  pub coworker: bool,
  pub lines: Vec<String>,
}

/// A work key's route as the fallback settings hold it: the run mode it stands on, `laya` among them.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Route {
  pub key: String,
  pub route_mode: String,
  pub account: Option<String>,
  pub set_at: Option<i64>,
}

/// The mapping a work key goes out on at a tier.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Mapping {
  pub provider: Option<String>,
  pub tier: Option<String>,
  pub model: Option<String>,
  pub effort: Option<String>,
  pub answer_tokens: Option<i64>,
}

/// The scope a thrown-away session is started at: on a provider and a model, in a folder, for no item and
/// no role.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Apart {
  pub provider: String,
  pub model: String,
  pub cwd: String,
}

/// A session as the agency answers it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct Session {
  pub id: String,
  pub agent: String,
  pub scope: Value,
}

/// The line a gate run is laid on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Line {
  pub model: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub effort: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tier: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub answer_tokens: Option<i64>,
}

/// One gate run's turn into its thrown-away session: the material as the prompt, the gate's instructions as
/// the whole system prompt, whether the run thinks, a fresh session, and the run's name and work key.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GateTurn {
  pub session: String,
  pub prompt: String,
  pub provider: String,
  pub model: String,
  pub mapping: Line,
  pub name: String,
  pub work_key: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub chat: Option<i64>,
  pub system: String,
  pub thinking: bool,
}

/// What a turn's line went out on.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct WentOut {
  pub provider: Option<String>,
  pub model: Option<String>,
  pub effort: Option<String>,
  pub tier: Option<String>,
}

/// A turn's end, as its send answers it: the parts the gate reads, and the reply and the failure as they came.
#[derive(Clone, Debug, PartialEq, Deserialize)]
pub struct TurnEnd {
  pub delivery: String,
  pub run: Option<String>,
  pub outcome: String,
  pub answer: Option<String>,
  pub reason: Option<String>,
  #[serde(rename = "engineError")]
  pub engine_error: Option<Value>,
  pub went_out: Option<WentOut>,
  pub reply: Option<Value>,
  pub failure: Option<Value>,
}

/// The road a conversational turn walked, as `road-walked` carries it.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoadWalked {
  pub stage: String,
  pub chat_id: Option<i64>,
  pub run: Option<String>,
  pub provider: String,
  pub model: String,
  pub outcome: String,
  pub ms: i64,
  pub input_tokens: Option<i64>,
  pub output_tokens: Option<i64>,
  pub cache_read_tokens: Option<i64>,
  pub cache_write_tokens: Option<i64>,
  pub context_ratio: Option<f64>,
}

/// Every call the gate makes on the agency.
pub trait Agency: Send + Sync {
  /// Every agent of the store, the resting among them.
  fn agents(&self) -> BoxFuture<'_, Answer<Vec<Agent>>>;

  /// The shared rulebooks named, in the order asked.
  fn rulebooks<'a>(&'a self, names: &'a [&'a str]) -> BoxFuture<'a, Answer<Vec<Rulebook>>>;

  /// The providers in the walk's order.
  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>>;

  /// Every work key's route as the fallback settings hold it.
  fn routes(&self) -> BoxFuture<'_, Answer<Vec<Route>>>;

  /// The mapping a work key goes out on at a tier, on the provider named or the walk's first, or none where no
  /// provider serves it.
  fn resolve<'a>(
    &'a self,
    work_key: &'a str,
    provider: Option<&'a str>,
    tier: &'a str,
  ) -> BoxFuture<'a, Answer<Option<Mapping>>>;

  /// Whether a stand-in answers the agent while the rest closes Claude Code's road.
  fn stand_in<'a>(&'a self, agent: &'a str) -> BoxFuture<'a, Answer<bool>>;

  /// A thrown-away session started for the agent at the scope given.
  fn start_apart<'a>(&'a self, agent: &'a str, apart: &'a Apart) -> BoxFuture<'a, Answer<Session>>;

  /// A gate run's one turn, carried to its end.
  fn turn<'a>(&'a self, turn: &'a GateTurn) -> BoxFuture<'a, Answer<TurnEnd>>;

  /// A run of the gate's stopped, with why.
  fn stop<'a>(&'a self, run: &'a str, reason: &'a str) -> BoxFuture<'a, Answer<()>>;

  /// The roads conversational turns walk, from the moment the stream opens.
  fn roads_walked(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<RoadWalked>>>>;

  /// The gate's address registered at a hook point, in place of any before.
  fn register_hook<'a>(
    &'a self,
    point: &'a str,
    url: &'a str,
    token: Option<&'a str>,
  ) -> BoxFuture<'a, Answer<()>>;
}

/// The agency over HTTP.
#[derive(Clone, Debug)]
pub struct HttpAgency {
  caller: Caller,
}

impl HttpAgency {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("bmo-agency", peer),
    }
  }
}

#[derive(Deserialize)]
struct Agents {
  agents: Vec<Agent>,
}

#[derive(Deserialize)]
struct Rulebooks {
  rulebooks: Vec<Rulebook>,
}

#[derive(Deserialize)]
struct Providers {
  providers: Vec<Provider>,
}

#[derive(Deserialize)]
struct Fallback {
  profiles: Vec<Route>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Resolve<'a> {
  work_key: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  provider: Option<&'a str>,
  tier: &'a str,
}

#[derive(Deserialize)]
struct Answers {
  answers: bool,
}

#[derive(Serialize)]
struct ApartScope<'a> {
  kind: &'static str,
  provider: &'a str,
  model: &'a str,
  cwd: &'a str,
  todo: Option<i64>,
  role: Option<&'a str>,
}

#[derive(Serialize)]
struct Start<'a> {
  agent: &'a str,
  scope: ApartScope<'a>,
}

#[derive(Serialize)]
struct Resume {
  kind: &'static str,
}

#[derive(Serialize)]
struct TurnBody<'a> {
  #[serde(flatten)]
  turn: &'a GateTurn,
  resume: Resume,
}

#[derive(Serialize)]
struct Stop<'a> {
  run: &'a str,
  reason: &'a str,
}

#[derive(Serialize)]
struct Hook<'a> {
  point: &'a str,
  url: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  token: Option<&'a str>,
}

/// The code the agency answers a read of nothing held with.
const NOTHING_HELD: &str = "nothing-held";

impl Agency for HttpAgency {
  fn agents(&self) -> BoxFuture<'_, Answer<Vec<Agent>>> {
    Box::pin(async move {
      let agents: Agents = self.caller.get("agents", &["agents"], &[]).await?;

      Ok(agents.agents)
    })
  }

  fn rulebooks<'a>(&'a self, names: &'a [&'a str]) -> BoxFuture<'a, Answer<Vec<Rulebook>>> {
    Box::pin(async move {
      let names = names.join(",");
      let rulebooks: Rulebooks = self.caller.get("rulebooks", &["rulebooks"], &[("names", &names)]).await?;

      Ok(rulebooks.rulebooks)
    })
  }

  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>> {
    Box::pin(async move {
      let providers: Providers = self.caller.get("providers", &["providers"], &[]).await?;

      Ok(providers.providers)
    })
  }

  fn routes(&self) -> BoxFuture<'_, Answer<Vec<Route>>> {
    Box::pin(async move {
      let fallback: Fallback = self.caller.get("routes", &["fallback"], &[]).await?;

      Ok(fallback.profiles)
    })
  }

  fn resolve<'a>(
    &'a self,
    work_key: &'a str,
    provider: Option<&'a str>,
    tier: &'a str,
  ) -> BoxFuture<'a, Answer<Option<Mapping>>> {
    Box::pin(async move {
      self
        .caller
        .post_or_nothing(
          "route resolved",
          &["routes", "resolve"],
          &Resolve {
            work_key,
            provider,
            tier,
          },
          NOTHING_HELD,
        )
        .await
    })
  }

  fn stand_in<'a>(&'a self, agent: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move {
      let answers: Answers = self.caller.get("stand-in", &["stand-in"], &[("agent", agent)]).await?;

      Ok(answers.answers)
    })
  }

  fn start_apart<'a>(&'a self, agent: &'a str, apart: &'a Apart) -> BoxFuture<'a, Answer<Session>> {
    Box::pin(async move {
      let scope = ApartScope {
        kind: "apart",
        provider: &apart.provider,
        model: &apart.model,
        cwd: &apart.cwd,
        todo: None,
        role: None,
      };

      self
        .caller
        .post("session started", &["session", "start"], &Start { agent, scope })
        .await
    })
  }

  fn turn<'a>(&'a self, turn: &'a GateTurn) -> BoxFuture<'a, Answer<TurnEnd>> {
    Box::pin(async move {
      let body = TurnBody {
        turn,
        resume: Resume { kind: "fresh" },
      };

      self.caller.post("gate turn", &["session", "turn"], &body).await
    })
  }

  fn stop<'a>(&'a self, run: &'a str, reason: &'a str) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self
        .caller
        .done("run stopped", Method::POST, &["runs", "stop"], &Stop { run, reason })
        .await
    })
  }

  fn roads_walked(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<RoadWalked>>>> {
    Box::pin(async move {
      let events = self.caller.events("roads walked", &["events"], &[("kinds", "road-walked")]).await?;
      let roads = events
        .try_filter(|(name, _)| futures_util::future::ready(name == "road-walked"))
        .and_then(|(_, data)| {
          futures_util::future::ready(serde_json::from_value(data).map_err(|why| PortError::Malformed {
            unit: "bmo-agency",
            call: "roads walked",
            status: 200,
            why: why.to_string(),
          }))
        });

      Ok(roads.boxed())
    })
  }

  fn register_hook<'a>(
    &'a self,
    point: &'a str,
    url: &'a str,
    token: Option<&'a str>,
  ) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self
        .caller
        .done("hook registered", Method::POST, &["hooks"], &Hook { point, url, token })
        .await
    })
  }
}
