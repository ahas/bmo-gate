//! The agency port (`docs/boundary-api.md`, 「bmo-agency」 and 「How a gate run reaches a model」): the providers,
//! a role's provider order, a thrown-away session and its one turn, and the roads a turn walked. Bodies are
//! camelCase, but for a turn's work parts, which go by the snake-case names a job's runner sends them.

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use futures_util::{StreamExt, TryStreamExt};
use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::brain::Load;
use crate::http::{Answer, Caller, Peer, PortError};

/// A provider in the walk's order, and what it declares.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct Provider {
  pub name: String,
  pub enabled: bool,
  pub registered: bool,
  /// Whether the agency serves its models on its gateway, where a gate's judgement is one request.
  #[serde(default)]
  pub gateway: bool,
  pub coworker: bool,
  pub lines: Vec<String>,
}

/// One entry of a role's provider order: the provider, and the model, the effort, the thinking and the answer
/// ceiling the role runs on there, each of the last three none where the entry leaves it to the provider.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub provider: String,
  pub model: String,
  #[serde(default)]
  pub effort: Option<String>,
  /// `on`, `off`, or none for the provider's own.
  #[serde(default)]
  pub thinking: Option<String>,
  #[serde(default)]
  pub answer_tokens: Option<i64>,
}

/// A role as the agency answers it, what a gate's run reads of it: its provider order and its active provider.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
  pub name: String,
  #[serde(default)]
  pub order: Vec<Entry>,
  /// The first provider of its order with quota that can answer now; none where no provider of it has quota or
  /// its order is empty.
  #[serde(default)]
  pub provider: Option<String>,
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
  pub answer_tokens: Option<i64>,
}

/// One gate run's turn into its thrown-away session: the material as the prompt, the gate's instructions as
/// the whole system prompt, whether the run thinks, a fresh session, and the run's name and its gate's.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct GateTurn {
  pub session: String,
  pub prompt: String,
  pub provider: String,
  pub model: String,
  pub mapping: Line,
  pub name: String,
  pub gate: String,
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
  /// The gate's word on this one part, carried into the run untranslated.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub note: Option<String>,
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
  /// The providers in the walk's order.
  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>>;

  /// One role with its provider order, or none where the agency holds no role of the name.
  fn role<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Answer<Option<Role>>>;

  /// A thrown-away session started for the agent at the scope given.
  fn start_apart<'a>(&'a self, agent: &'a str, apart: &'a Apart) -> BoxFuture<'a, Answer<Session>>;

  /// A gate run's one turn, carried to its end.
  fn turn<'a>(&'a self, turn: &'a GateTurn) -> BoxFuture<'a, Answer<TurnEnd>>;

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
struct Providers {
  #[serde(default)]
  items: Vec<Provider>,
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
  fn translation_run<'a>(&'a self, ask: &'a TranslationAsk) -> BoxFuture<'a, Answer<TranslationRun>> {
    Box::pin(async move { self.caller.post("translation run", &["translation-runs"], ask).await })
  }

  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>> {
    Box::pin(async move {
      let providers: Providers = self.caller.get("providers", &["providers"], &[]).await?;

      Ok(providers.items)
    })
  }

  fn role<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Answer<Option<Role>>> {
    Box::pin(async move {
      match self.caller.get::<Role>("role", &["roles", name], &[]).await {
        Ok(role) => Ok(Some(role)),
        Err(PortError::Refused { code, .. }) if code == NOTHING_HELD => Ok(None),
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
