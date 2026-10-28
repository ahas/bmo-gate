//! A stand-in agency and model gateway the runs are carried against: each answers as it is set to and keeps what
//! it was asked, so a test reads back every call a run made.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use gate_ports::PortError;
use gate_ports::agency::{
  Agency, Agent, Apart, GateTurn, Mapping, Provider, RoadWalked, Route, Rulebook, Session, TranslationAsk,
  TranslationRun, TurnEnd,
};
use gate_ports::brain::Load;
use gate_ports::gateway::{Ask, Completion, Gateway};
use gate_ports::http::Answer;
use gate_runs::Runs;
use sea_orm::DatabaseConnection;
use serde_json::{Map, Value, json};

/// A provider the stand-in lists, on, carrying a gate's line.
pub fn provider(name: &str, registered: bool) -> Provider {
  Provider {
    name: name.to_owned(),
    enabled: true,
    registered,
    gateway: registered,
    coworker: false,
    lines: vec!["chat".to_owned(), "gate".to_owned()],
  }
}

/// A mapping on a provider.
pub fn mapping(provider: &str, model: &str, effort: Option<&str>, answer_tokens: Option<i64>) -> Mapping {
  Mapping {
    provider: Some(provider.to_owned()),
    tier: Some("Simple".to_owned()),
    model: Some(model.to_owned()),
    effort: effort.map(str::to_owned),
    answer_tokens,
  }
}

/// A turn's end as the agency answers it.
pub fn turn_end(outcome: &str, answer: Option<&str>, reply: Option<Value>) -> TurnEnd {
  TurnEnd {
    delivery: "taken".to_owned(),
    run: Some("run-1".to_owned()),
    outcome: outcome.to_owned(),
    answer: answer.map(str::to_owned),
    reason: (outcome != "answered").then(|| format!("it ended {outcome}")),
    engine_error: None,
    went_out: None,
    reply,
    failure: None,
  }
}

/// The stand-in agency: its providers, its work keys' run modes, the mapping each provider resolves, how a turn
/// ends, how long a turn takes, and every session, turn and stop it was asked.
#[derive(Default)]
pub struct FakeAgency {
  pub providers: Mutex<Vec<Provider>>,
  pub routes: Mutex<Vec<Route>>,
  pub mappings: Mutex<HashMap<String, Mapping>>,
  pub end: Mutex<Option<TurnEnd>>,
  pub turn_takes: Mutex<Duration>,
  pub label: Mutex<Option<String>>,
  pub started: Mutex<Vec<(String, Apart)>>,
  pub turns: Mutex<Vec<GateTurn>>,
  pub stopped: Mutex<Vec<String>>,
  pub resolved: Mutex<Vec<(String, Option<String>, String)>>,
  pub loads: Mutex<HashMap<String, Vec<Load>>>,
  /// What the translation line answers, one text an ask, in order; none left is no answer.
  pub translated: Mutex<std::collections::VecDeque<String>>,
  /// A text longer than so many characters is refused as past the line's window.
  pub window_chars: Mutex<Option<usize>>,
  pub translations: Mutex<Vec<TranslationAsk>>,
}

impl FakeAgency {
  /// The translation line's answers, one an ask, in order.
  pub fn translates(&self, answers: &[&str]) {
    self
      .translated
      .lock()
      .unwrap()
      .extend(answers.iter().map(|answer| (*answer).to_owned()));
  }

  pub fn route(&self, key: &str, mode: &str) {
    self.routes.lock().unwrap().push(Route {
      key: key.to_owned(),
      route_mode: mode.to_owned(),
      account: None,
      set_at: Some(42),
      provider: None,
      model: None,
      effort: None,
      answer_tokens: None,
    });
  }
}

fn unanswered<T>(call: &'static str) -> Answer<T> {
  Err(PortError::Unreachable {
    unit: "bmo-agency",
    call,
    why: "not offered by the stand-in".to_owned(),
  })
}

impl Agency for FakeAgency {
  fn agents(&self) -> BoxFuture<'_, Answer<Vec<Agent>>> {
    Box::pin(async move {
      Ok(vec![Agent {
        name: "the-chat-agent".to_owned(),
        label: self.label.lock().unwrap().clone(),
        awake: true,
        brain_folder: None,
        recollector_registration: None,
        rest: Map::new(),
      }])
    })
  }

  fn translation_run<'a>(&'a self, ask: &'a TranslationAsk) -> BoxFuture<'a, Answer<TranslationRun>> {
    Box::pin(async move {
      self.translations.lock().unwrap().push(ask.clone());

      if self.window_chars.lock().unwrap().is_some_and(|most| ask.text.chars().count() > most) {
        return Err(PortError::Refused {
          unit: "bmo-agency",
          call: "translation run",
          status: 413,
          code: "too-large".to_owned(),
          error: "the part is longer than the model's window takes".to_owned(),
        });
      }

      match self.translated.lock().unwrap().pop_front() {
        Some(text) => Ok(TranslationRun {
          text,
          provider: "registry".to_owned(),
          model: "translation-model".to_owned(),
        }),
        None => unanswered("translation run"),
      }
    })
  }

  fn rulebooks<'a>(&'a self, names: &'a [&'a str]) -> BoxFuture<'a, Answer<Vec<Rulebook>>> {
    Box::pin(async move {
      Ok(
        names
          .iter()
          .map(|name| Rulebook {
            name: (*name).to_owned(),
            text: format!("the {name} rulebook"),
          })
          .collect(),
      )
    })
  }

  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>> {
    Box::pin(async move { Ok(self.providers.lock().unwrap().clone()) })
  }

  fn work_key<'a>(&'a self, key: &'a str) -> BoxFuture<'a, Answer<Option<Route>>> {
    Box::pin(async move { Ok(self.routes.lock().unwrap().iter().find(|one| one.key == key).cloned()) })
  }

  fn session_loads<'a>(&'a self, session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>> {
    Box::pin(async move { Ok(self.loads.lock().unwrap().get(session).cloned().unwrap_or_default()) })
  }

  fn keep_loads<'a>(&'a self, session: &'a str, loads: &'a [Load]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self.loads.lock().unwrap().insert(session.to_owned(), loads.to_vec());

      Ok(())
    })
  }

  fn resolve<'a>(
    &'a self,
    work_key: &'a str,
    provider: Option<&'a str>,
    tier: &'a str,
  ) -> BoxFuture<'a, Answer<Option<Mapping>>> {
    Box::pin(async move {
      self.resolved.lock().unwrap().push((
        work_key.to_owned(),
        provider.map(str::to_owned),
        tier.to_owned(),
      ));

      let mappings = self.mappings.lock().unwrap();
      let found = match provider {
        Some(provider) => mappings.get(provider).cloned(),
        None => {
          let providers = self.providers.lock().unwrap();

          providers
            .iter()
            .filter(|one| one.enabled)
            .find_map(|one| mappings.get(&one.name).cloned())
        }
      };

      Ok(found)
    })
  }

  fn stand_in<'a>(&'a self, _agent: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move { unanswered("a stand-in") })
  }

  fn start_apart<'a>(&'a self, agent: &'a str, apart: &'a Apart) -> BoxFuture<'a, Answer<Session>> {
    Box::pin(async move {
      let mut started = self.started.lock().unwrap();

      started.push((agent.to_owned(), apart.clone()));

      Ok(Session {
        id: format!("session-{}", started.len()),
        agent: agent.to_owned(),
        scope: json!({ "kind": "apart" }),
      })
    })
  }

  fn turn<'a>(&'a self, turn: &'a GateTurn) -> BoxFuture<'a, Answer<TurnEnd>> {
    Box::pin(async move {
      self.turns.lock().unwrap().push(turn.clone());

      let takes = *self.turn_takes.lock().unwrap();

      tokio::time::sleep(takes).await;

      self.end.lock().unwrap().clone().ok_or_else(|| PortError::Unreachable {
        unit: "bmo-agency",
        call: "a turn",
        why: "no end is set".to_owned(),
      })
    })
  }

  fn stop<'a>(&'a self, run: &'a str, _reason: &'a str) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self.stopped.lock().unwrap().push(run.to_owned());
      Ok(())
    })
  }

  fn roads_walked(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<RoadWalked>>>> {
    Box::pin(async move { unanswered("road-walked") })
  }
}

/// The stand-in gateway: the answers it gives in turn, and every request it was asked.
#[derive(Default)]
pub struct FakeGateway {
  pub answers: Mutex<Vec<Answer<Completion>>>,
  pub asked: Mutex<Vec<Ask>>,
}

impl FakeGateway {
  pub fn answers(&self, answers: Vec<Answer<Completion>>) {
    *self.answers.lock().unwrap() = answers;
  }
}

impl Gateway for FakeGateway {
  fn complete<'a>(&'a self, ask: &'a Ask) -> BoxFuture<'a, Answer<Completion>> {
    Box::pin(async move {
      self.asked.lock().unwrap().push(ask.clone());

      let mut answers = self.answers.lock().unwrap();

      if answers.is_empty() {
        return Err(PortError::Unreachable {
          unit: "the model gateway",
          call: "chat completion",
          why: "no answer is set".to_owned(),
        });
      }

      answers.remove(0)
    })
  }
}

/// A completion answering `text`, with a usage.
pub fn completion(text: &str) -> Answer<Completion> {
  Ok(Completion {
    text: Some(text.to_owned()),
    usage: Some(json!({
      "prompt_tokens": 120,
      "completion_tokens": 7,
      "prompt_tokens_details": { "cached_tokens": 100 }
    })),
  })
}

/// The runs over a database and the stand-ins, the chat agent named `the-chat-agent`.
pub fn runs(db: &DatabaseConnection, agency: &Arc<FakeAgency>, gateway: &Arc<FakeGateway>) -> Runs {
  Runs::new(db.clone(), agency.clone(), gateway.clone(), "the-chat-agent", "/a/session/folder")
}
