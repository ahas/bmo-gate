//! The agency port (`docs/boundary-api.md`, 「bmo-agency」 and 「How a gate run reaches a model」): the agents and
//! the shared rulebooks, the providers, a work key's route and mapping, the stand-in, a thrown-away session and
//! its one turn, a run stopped, and the roads a turn walked. Bodies are camelCase, but for a turn's work parts,
//! which go by the snake-case names a job's runner sends them.

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::brain::Load;
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
  /// The provider the work key goes out on.
  pub provider: Option<String>,
  /// The model the work key's tier maps there.
  pub model: Option<String>,
  pub effort: Option<String>,
  pub answer_tokens: Option<i64>,
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

/// One part asked of the agency's translation line: what it is for, the target language's name and the text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationAsk {
  /// `document`, `worker` or `record`.
  pub purpose: String,
  pub language: String,
  pub text: String,
}

/// A part translated whole by the agency's translation line, with the road it went out on.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationRun {
  pub text: String,
  #[serde(default)]
  pub provider: String,
  #[serde(default)]
  pub model: String,
}

/// Every call the gate makes on the agency.
pub trait Agency: Send + Sync {
  /// Every agent of the store, the resting among them.
  fn agents(&self) -> BoxFuture<'_, Answer<Vec<Agent>>>;

  /// The shared rulebooks named, in the order asked.
  fn rulebooks<'a>(&'a self, names: &'a [&'a str]) -> BoxFuture<'a, Answer<Vec<Rulebook>>>;

  /// The providers in the walk's order.
  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>>;

  /// One work key's route, or none where the agency holds no route for it.
  fn work_key<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Answer<Option<Route>>>;

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

  /// The run's session ended, its turn cut short where one is still going.
  fn stop<'a>(&'a self, session: &'a str, reason: &'a str) -> BoxFuture<'a, Answer<()>>;

  /// The roads conversational turns walk, from the moment the stream opens.
  fn roads_walked(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<RoadWalked>>>>;

  /// What a session was handed in full, each document by its path and version; none where it holds none.
  fn session_loads<'a>(&'a self, _session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>> {
    Box::pin(async { Ok(vec![]) })
  }

  /// A session's loads kept: every load it now holds, in place of those it held.
  fn keep_loads<'a>(&'a self, _session: &'a str, _loads: &'a [Load]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async { Ok(()) })
  }

  /// One part translated by the agency's translation line; an agency that serves none refuses it.
  fn translation_run<'a>(&'a self, _ask: &'a TranslationAsk) -> BoxFuture<'a, Answer<TranslationRun>> {
    Box::pin(async {
      Err(PortError::Unreachable {
        unit: "bmo-agency",
        call: "translation run",
        why: "this agency serves no translation line".to_owned(),
      })
    })
  }
}

/// A session's loads as the agency answers and takes them.
#[derive(Serialize, Deserialize)]
struct Loads {
  #[serde(default)]
  documents: Vec<Load>,
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
  #[serde(default)]
  items: Vec<Agent>,
}

#[derive(Deserialize)]
struct Rulebooks {
  rulebooks: Vec<Rulebook>,
}

#[derive(Deserialize)]
struct Providers {
  #[serde(default)]
  items: Vec<Provider>,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkKey {
  key: String,
  provider: String,
  model: String,
  #[serde(default)]
  effort: Option<String>,
  #[serde(default)]
  answer_tokens: Option<i64>,
  #[serde(default)]
  cap_ms: i64,
  #[serde(default)]
  run_mode: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgencySession {
  id: String,
  agent_name: String,
  #[serde(default)]
  scope: Value,
}

#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgencyTurn {
  #[serde(default)]
  id: i64,
  #[serde(default)]
  session_id: String,
  #[serde(default)]
  state: String,
  #[serde(default)]
  delivery: Option<String>,
  #[serde(default)]
  outcome: Option<String>,
  #[serde(default)]
  answer: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StandIn {
  #[serde(default)]
  stand_in_available: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StartApart<'a> {
  agent_name: &'a str,
  scope: &'static str,
  options: ApartOptions<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ApartOptions<'a> {
  provider: &'a str,
  model: &'a str,
  cwd: &'a str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnSend<'a> {
  prompt: &'a str,
  gate: GateSend<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GateSend<'a> {
  system: &'a str,
  thinking: bool,
  model: &'a str,
  #[serde(skip_serializing_if = "Option::is_none")]
  effort: Option<&'a str>,
  #[serde(skip_serializing_if = "Option::is_none")]
  answer_tokens: Option<i64>,
}

/// The code the agency answers a read of nothing held with.
const NOTHING_HELD: &str = "not-found";

impl Agency for HttpAgency {
  fn agents(&self) -> BoxFuture<'_, Answer<Vec<Agent>>> {
    Box::pin(async move {
      let agents: Agents = self.caller.get("agents", &["agents"], &[]).await?;

      Ok(agents.items)
    })
  }

  fn rulebooks<'a>(&'a self, names: &'a [&'a str]) -> BoxFuture<'a, Answer<Vec<Rulebook>>> {
    Box::pin(async move {
      let names = names.join(",");
      let rulebooks: Rulebooks = self.caller.get("rulebooks", &["rulebooks"], &[("names", &names)]).await?;

      Ok(rulebooks.rulebooks)
    })
  }

  fn translation_run<'a>(&'a self, ask: &'a TranslationAsk) -> BoxFuture<'a, Answer<TranslationRun>> {
    Box::pin(async move { self.caller.post("translation run", &["translation-runs"], ask).await })
  }

  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>> {
    Box::pin(async move {
      let providers: Providers = self.caller.get("providers", &["providers"], &[]).await?;

      Ok(providers.items)
    })
  }

  fn work_key<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Answer<Option<Route>>> {
    Box::pin(async move {
      match self.caller.get::<WorkKey>("work key", &["work-keys", key], &[]).await {
        Ok(work) => Ok(Some(Route {
          key: work.key,
          route_mode: work.run_mode,
          account: None,
          set_at: None,
          provider: Some(work.provider),
          model: Some(work.model),
          effort: work.effort,
          answer_tokens: work.answer_tokens,
        })),
        Err(PortError::Refused { code, .. }) if code == NOTHING_HELD => Ok(None),
        Err(why) => Err(why),
      }
    })
  }

  fn resolve<'a>(
    &'a self,
    work_key: &'a str,
    provider: Option<&'a str>,
    tier: &'a str,
  ) -> BoxFuture<'a, Answer<Option<Mapping>>> {
    Box::pin(async move {
      let mut query: Vec<(&str, &str)> = vec![("tier", tier)];

      if let Some(provider) = provider {
        query.push(("provider", provider));
      }

      match self.caller.get::<Mapping>("mapping", &["work-keys", work_key], &query).await {
        Ok(mapping) => Ok(Some(mapping)),
        Err(PortError::Refused { code, .. }) if code == NOTHING_HELD => Ok(None),
        Err(why) => Err(why),
      }
    })
  }

  fn stand_in<'a>(&'a self, agent: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move {
      match self.caller.get::<StandIn>("stand-in", &["agents", agent], &[]).await {
        Ok(stand) => Ok(stand.stand_in_available),
        Err(PortError::Refused { code, .. }) if code == NOTHING_HELD => Ok(false),
        Err(why) => Err(why),
      }
    })
  }

  fn start_apart<'a>(&'a self, agent: &'a str, apart: &'a Apart) -> BoxFuture<'a, Answer<Session>> {
    Box::pin(async move {
      let started: AgencySession = self
        .caller
        .post(
          "session started",
          &["sessions"],
          &StartApart {
            agent_name: agent,
            scope: "conversation",
            options: ApartOptions {
              provider: &apart.provider,
              model: &apart.model,
              cwd: &apart.cwd,
            },
          },
        )
        .await?;

      Ok(Session {
        id: started.id,
        agent: started.agent_name,
        scope: started.scope,
      })
    })
  }

  fn turn<'a>(&'a self, turn: &'a GateTurn) -> BoxFuture<'a, Answer<TurnEnd>> {
    Box::pin(async move {
      let sent: AgencyTurn = self
        .caller
        .post(
          "gate turn",
          &["sessions", &turn.session, "turns"],
          &TurnSend {
            prompt: &turn.prompt,
            gate: GateSend {
              system: &turn.system,
              thinking: turn.thinking,
              model: &turn.model,
              effort: turn.mapping.effort.as_deref(),
              answer_tokens: turn.mapping.answer_tokens,
            },
          },
        )
        .await?;

      Ok(TurnEnd {
        delivery: sent.delivery.unwrap_or_default(),
        run: None,
        outcome: sent.outcome.unwrap_or_default(),
        answer: sent.answer,
        reason: None,
        engine_error: None,
        went_out: None,
        reply: None,
        failure: None,
      })
    })
  }

  fn stop<'a>(&'a self, session: &'a str, _reason: &'a str) -> BoxFuture<'a, Answer<()>> {
    Box::pin(
      async move { self.caller.without("session ended", Method::DELETE, &["sessions", session]).await },
    )
  }

  fn session_loads<'a>(&'a self, session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>> {
    Box::pin(async move {
      let loads: Loads = self.caller.get("session loads", &["session-loads", session], &[]).await?;

      Ok(loads.documents)
    })
  }

  fn keep_loads<'a>(&'a self, session: &'a str, loads: &'a [Load]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      let body = Loads {
        documents: loads.to_vec(),
      };
      let _: Value = self
        .caller
        .send_json("session loads kept", Method::PUT, &["session-loads", session], &body)
        .await?;

      Ok(())
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
}
