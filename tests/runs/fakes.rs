//! A stand-in agency and model gateway the runs are carried against: each answers as it is set to and keeps what
//! it was asked, so a test reads back every call a run made.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use gate_ports::PortError;
use gate_ports::agency::{
  Agency, Apart, Entry, GateTurn, Provider, RoadEvent, Role, Session, TranslationAsk, TranslationRun,
  TurnEnd,
};
use gate_ports::brain::Load;
use gate_ports::gateway::{Ask, Completion, Gateway};
use gate_ports::http::Answer;
use gate_runs::Runs;
use sea_orm::DatabaseConnection;
use serde_json::json;

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

/// An entry of a role's provider order: the provider and the model, effort, thinking and answer ceiling there.
pub fn entry(provider: &str, model: &str, thinking: Option<&str>, answer_tokens: Option<i64>) -> Entry {
  Entry {
    provider: provider.to_owned(),
    model: model.to_owned(),
    effort: None,
    thinking: thinking.map(str::to_owned),
    answer_tokens,
  }
}

/// A role with its provider order and its active provider.
pub fn role(name: &str, order: Vec<Entry>, active: Option<&str>) -> Role {
  Role {
    name: name.to_owned(),
    order,
    provider: active.map(str::to_owned),
  }
}

/// The stand-in agency: its providers, its roles, how a turn ends, how long a turn takes, and every session,
/// turn and stop it was asked.
#[derive(Default)]
pub struct FakeAgency {
  pub providers: Mutex<Vec<Provider>>,
  pub roles: Mutex<HashMap<String, Role>>,
  pub end: Mutex<Option<TurnEnd>>,
  pub turn_takes: Mutex<Duration>,
  pub started: Mutex<Vec<(String, Apart)>>,
  pub turns: Mutex<Vec<GateTurn>>,
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
}

fn unanswered<T>(call: &'static str) -> Answer<T> {
  Err(PortError::Unreachable {
    unit: "bmo-agency",
    call,
    why: "not offered by the stand-in".to_owned(),
  })
}

impl Agency for FakeAgency {
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

  fn providers(&self) -> BoxFuture<'_, Answer<Vec<Provider>>> {
    Box::pin(async move { Ok(self.providers.lock().unwrap().clone()) })
  }

  fn role<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Answer<Option<Role>>> {
    Box::pin(async move { Ok(self.roles.lock().unwrap().get(name).cloned()) })
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

  fn roads_walked(
    &self,
    _after: Option<i64>,
  ) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<RoadEvent>>>> {
    Box::pin(async move { unanswered("road-walked") })
  }
}

/// The stand-in gateway: the answers it gives in turn, and every request it was asked.
#[derive(Default)]
pub struct FakeGateway {
  pub answers: Mutex<Vec<Answer<Completion>>>,
  pub asked: Mutex<Vec<Ask>>,
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

/// The runs over a database and the stand-ins, the chat agent named `the-chat-agent`.
pub fn runs(db: &DatabaseConnection, agency: &Arc<FakeAgency>, gateway: &Arc<FakeGateway>) -> Runs {
  Runs::new(db.clone(), agency.clone(), gateway.clone(), "the-chat-agent", "/a/session/folder")
}
