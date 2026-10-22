//! Stand-ins for the brain, the receiver and bmo-job the reference road is carried against, and a gateway that
//! answers each request by what it is asked: each keeps what it was asked, so a test reads back every call.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::future::BoxFuture;
use gate_ports::PortError;
use gate_ports::brain::{
  Brain, Condition, Document, Event, Fragment, Hit, Load, MemoryRow, People, PeoplePiece, Reply, RoomRule,
  Sheet,
};
use gate_ports::gateway::{Ask, Completion, Gateway};
use gate_ports::http::Answer;
use gate_ports::job::{Job, Raised};
use gate_ports::receiver::{Message, Name, OwnerSpoke, Receiver, Roads, RoomTitle};
use serde_json::{Map, Value};

fn unoffered<T>(unit: &'static str, call: &'static str) -> Answer<T> {
  Err(PortError::Unreachable {
    unit,
    call,
    why: "not offered by the stand-in".into(),
  })
}

/// A fragment row of a kind, its slug and title, in the room or shared, owned by a person or nobody.
pub fn fragment(kind: &str, slug: &str, title: &str, chat_id: Option<i64>, owner: Option<i64>) -> Fragment {
  Fragment {
    key: format!("{kind}:{slug}"),
    kind: kind.into(),
    chat_id,
    owner,
    agent: "the-chat-agent".into(),
    all_agents: false,
    slug: slug.into(),
    title: title.into(),
    path: format!("{kind}/{slug}.md"),
    scope: None,
    position: 0,
    active: true,
    last_hit_at: None,
    hits: 0,
    set_by: None,
    set_at: 1,
    hand: None,
    hand_at: None,
    keywords: vec![],
    items: vec![],
    written_on: None,
    confirmed_on: None,
    status: "open".into(),
    body_hash: None,
  }
}

/// A memory row of a kind, its slug and what it asks, waiting on nothing.
pub fn memory(id: i64, kind: &str, slug: &str, action: &str) -> MemoryRow {
  MemoryRow {
    id,
    agent: "the-chat-agent".into(),
    slug: slug.into(),
    kind: kind.into(),
    chat_id: Some(7),
    reach: "room".into(),
    condition: String::new(),
    action: action.into(),
    for_user: None,
    message_id: None,
    todo_id: None,
    set_by: None,
    set_at: 0,
    active: true,
    last_hit_at: None,
    hits: 0,
    done_at: None,
    done_text: None,
    down_reason: None,
    down_at: None,
    candidate_why: None,
    candidate_at: None,
    event: None,
    event_met_at: None,
    moved_at: None,
  }
}

/// The stand-in brain: what it answers each read with, and what it was handed back.
#[derive(Default)]
pub struct FakeBrain {
  pub standing: Mutex<Vec<MemoryRow>>,
  pub conditions: Mutex<Vec<Condition>>,
  pub woken: Mutex<Vec<MemoryRow>>,
  pub fragments: Mutex<Vec<Fragment>>,
  pub documents: Mutex<HashMap<String, String>>,
  pub sheets: Mutex<Vec<Sheet>>,
  pub pieces: Mutex<HashMap<String, (String, i64)>>,
  pub hits: Mutex<Vec<Hit>>,
  pub matched: Mutex<Vec<(Vec<String>, Vec<String>)>>,
  pub events: Mutex<Vec<Event>>,
  pub knowledge_asked: Mutex<Vec<Vec<String>>>,
}

impl Brain for FakeBrain {
  fn standing<'a>(&'a self, _agent: &'a str, _chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move { Ok(self.standing.lock().unwrap().clone()) })
  }

  fn conditions<'a>(&'a self, _agent: &'a str, _chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>> {
    Box::pin(async move { Ok(self.conditions.lock().unwrap().clone()) })
  }

  fn matched<'a>(
    &'a self,
    _agent: &'a str,
    _chat: i64,
    matched: &'a [String],
    spent: &'a [String],
  ) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self.matched.lock().unwrap().push((matched.to_vec(), spent.to_vec()));
      Ok(())
    })
  }

  fn woken<'a>(
    &'a self,
    _agent: &'a str,
    _chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      self.events.lock().unwrap().extend(events.iter().cloned());
      Ok(self.woken.lock().unwrap().clone())
    })
  }

  fn offered<'a>(
    &'a self,
    _agent: &'a str,
    _chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>> {
    Box::pin(async move {
      Ok(
        self
          .fragments
          .lock()
          .unwrap()
          .iter()
          .filter(|row| kinds.contains(&row.kind))
          .cloned()
          .collect(),
      )
    })
  }

  fn hits<'a>(&'a self, _agent: &'a str, _chat: i64, attached: &'a [Hit]) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self.hits.lock().unwrap().extend(attached.iter().cloned());
      Ok(())
    })
  }

  fn knowledge<'a>(
    &'a self,
    _agent: &'a str,
    _chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>> {
    Box::pin(async move {
      self.knowledge_asked.lock().unwrap().push(slugs.to_vec());

      let documents = self.documents.lock().unwrap();

      Ok(Reply::Answered(
        slugs
          .iter()
          .filter_map(|slug| {
            documents.get(slug).map(|text| Document {
              slug: slug.clone(),
              path: format!("knowledge/{slug}.md"),
              text: text.clone(),
              version: "v".into(),
            })
          })
          .collect(),
      ))
    })
  }

  fn people<'a>(
    &'a self,
    _agent: &'a str,
    _chat: i64,
    senders: &'a [i64],
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<People>>> {
    Box::pin(async move {
      let pieces = self.pieces.lock().unwrap();

      Ok(Reply::Answered(People {
        sheets: self
          .sheets
          .lock()
          .unwrap()
          .iter()
          .filter(|sheet| senders.contains(&sheet.person))
          .cloned()
          .collect(),
        pieces: slugs
          .iter()
          .filter_map(|slug| {
            pieces.get(slug).map(|(text, owner)| PeoplePiece {
              slug: slug.clone(),
              path: format!("people/{owner}/{slug}.md"),
              text: text.clone(),
              version: "v".into(),
              owner: Some(*owner),
            })
          })
          .collect(),
      }))
    })
  }

  fn room_rules(&self, _chat: i64) -> BoxFuture<'_, Answer<Vec<RoomRule>>> {
    Box::pin(async move { unoffered("bmo-brain", "room rules") })
  }

  fn loads<'a>(&'a self, _session: &'a str) -> BoxFuture<'a, Answer<Vec<Load>>> {
    Box::pin(async move { unoffered("bmo-brain", "loads") })
  }
}

/// The stand-in receiver: the rooms it keeps, the names it knows people by, the messages it keeps by room and number,
/// the chat agent's own number, and the owner notices it was handed.
#[derive(Default)]
pub struct FakeReceiver {
  pub rooms: Mutex<Vec<RoomTitle>>,
  pub names: Mutex<HashMap<i64, String>>,
  pub messages: Mutex<HashMap<(i64, i64), Message>>,
  pub own: Mutex<Option<i64>>,
  pub notices: Mutex<Vec<(String, Map<String, Value>)>>,
}

impl Receiver for FakeReceiver {
  fn titles(&self) -> BoxFuture<'_, Answer<Vec<RoomTitle>>> {
    Box::pin(async move { Ok(self.rooms.lock().unwrap().clone()) })
  }

  fn roads(&self, _chat: i64) -> BoxFuture<'_, Answer<Roads>> {
    Box::pin(async move { unoffered("bmo-receiver", "roads") })
  }

  fn spoke_between(&self, _chat: i64, _person: i64, _from: i64, _to: i64) -> BoxFuture<'_, Answer<bool>> {
    Box::pin(async move { unoffered("bmo-receiver", "spoke between") })
  }

  fn owner_spoke(
    &self,
    _chat: i64,
    _person: i64,
    _before: i64,
    _seconds: i64,
  ) -> BoxFuture<'_, Answer<OwnerSpoke>> {
    Box::pin(async move { unoffered("bmo-receiver", "owner spoke") })
  }

  fn names<'a>(&'a self, people: &'a [i64]) -> BoxFuture<'a, Answer<Vec<Name>>> {
    Box::pin(async move {
      let names = self.names.lock().unwrap();

      Ok(
        people
          .iter()
          .map(|person| Name {
            person: *person,
            name: names.get(person).cloned(),
          })
          .collect(),
      )
    })
  }

  fn waits<'a>(&'a self, _text: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move { unoffered("bmo-receiver", "waits") })
  }

  fn own_number<'a>(&'a self, _agent: &'a str, _chat: i64) -> BoxFuture<'a, Answer<Option<i64>>> {
    Box::pin(async move { Ok(*self.own.lock().unwrap()) })
  }

  fn message(&self, chat: i64, message: i64) -> BoxFuture<'_, Answer<Option<Message>>> {
    Box::pin(async move { Ok(self.messages.lock().unwrap().get(&(chat, message)).cloned()) })
  }

  fn owner_notice<'a>(
    &'a self,
    code: &'a str,
    fields: &'a Map<String, Value>,
  ) -> BoxFuture<'a, Answer<()>> {
    Box::pin(async move {
      self.notices.lock().unwrap().push((code.to_owned(), fields.clone()));
      Ok(())
    })
  }
}

/// The stand-in bmo-job: the row it answers each raise with, and every raise it was asked.
pub struct FakeJob {
  pub answer: Mutex<Raised>,
  pub raised: Mutex<Vec<(String, String, i64, String)>>,
}

impl Default for FakeJob {
  fn default() -> Self {
    Self {
      answer: Mutex::new(Raised {
        id: 1900,
        raised: true,
      }),
      raised: Mutex::default(),
    }
  }
}

impl Job for FakeJob {
  fn raise<'a>(
    &'a self,
    title: &'a str,
    judgement: &'a str,
    chat: i64,
    key: &'a str,
  ) -> BoxFuture<'a, Answer<Raised>> {
    Box::pin(async move {
      self
        .raised
        .lock()
        .unwrap()
        .push((title.to_owned(), judgement.to_owned(), chat, key.to_owned()));
      Ok(*self.answer.lock().unwrap())
    })
  }
}

/// How a stand-in gateway answers a request.
pub type Answering = Box<dyn Fn(&Ask) -> Option<String> + Send + Sync>;

/// A gateway answering each request as `answer` makes it of the request, and every request it was asked.
pub struct AnsweringGateway {
  pub answer: Answering,
  pub asked: Mutex<Vec<Ask>>,
}

impl Gateway for AnsweringGateway {
  fn complete<'a>(&'a self, ask: &'a Ask) -> BoxFuture<'a, Answer<Completion>> {
    Box::pin(async move {
      self.asked.lock().unwrap().push(ask.clone());

      Ok(Completion {
        text: (self.answer)(ask),
        usage: None,
      })
    })
  }
}
