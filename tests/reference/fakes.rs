//! Stand-ins for the brain, the receiver and bmo-job the reference road is carried against, and a gateway that
//! answers each request by what it is asked: each keeps what it was asked, so a test reads back every call.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use gate_ports::brain::{Brain, BrainKey, Condition, Document, Event, Fragment, MemoryRow, Reply, Sheet};
use gate_ports::gateway::{Ask, Completion, Gateway};
use gate_ports::http::Answer;
use gate_ports::receiver::{Drafted, Receiver};

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
    section: None,
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

/// The stand-in brain: what it answers each read with, every brain it was asked to read, and what it was handed
/// back. Where `own` holds brains, only they are kept, and each answers the fragments it holds; where it holds none,
/// every agent keeps one brain answering `fragments`. A brain `standing_of` holds answers its own standing rows in
/// place of `standing`.
#[derive(Default)]
pub struct FakeBrain {
  pub own: Mutex<HashMap<BrainKey, Vec<Fragment>>>,
  pub read: Mutex<Vec<BrainKey>>,
  pub standing: Mutex<Vec<MemoryRow>>,
  pub standing_of: Mutex<HashMap<BrainKey, Vec<MemoryRow>>>,
  pub conditions: Mutex<Vec<Condition>>,
  pub woken: Mutex<Vec<MemoryRow>>,
  pub fragments: Mutex<Vec<Fragment>>,
  pub documents: Mutex<HashMap<String, String>>,
  pub lore: Mutex<HashMap<String, String>>,
  pub sheets: Mutex<Vec<Sheet>>,
  pub events: Mutex<Vec<Event>>,
  pub knowledge_asked: Mutex<Vec<Vec<String>>>,
  pub lore_asked: Mutex<Vec<Vec<String>>>,
}

impl FakeBrain {
  // Whether the brain of the key is kept, the read recorded.
  fn reads(&self, key: &BrainKey) -> bool {
    self.read.lock().unwrap().push(key.clone());

    let own = self.own.lock().unwrap();

    own.is_empty() || own.contains_key(key)
  }
}

impl Brain for FakeBrain {
  fn kept<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move { Ok(self.reads(key)) })
  }

  fn standing<'a>(&'a self, key: &'a BrainKey, _chat: i64) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      if !self.reads(key) {
        return Ok(vec![]);
      }

      let own = self.standing_of.lock().unwrap();

      Ok(own.get(key).cloned().unwrap_or_else(|| self.standing.lock().unwrap().clone()))
    })
  }

  fn conditions<'a>(&'a self, key: &'a BrainKey, _chat: i64) -> BoxFuture<'a, Answer<Vec<Condition>>> {
    Box::pin(async move {
      let kept = self.reads(key);

      Ok(if kept { self.conditions.lock().unwrap().clone() } else { vec![] })
    })
  }

  fn woken<'a>(
    &'a self,
    key: &'a BrainKey,
    _chat: i64,
    events: &'a [Event],
  ) -> BoxFuture<'a, Answer<Vec<MemoryRow>>> {
    Box::pin(async move {
      if !self.reads(key) {
        return Ok(vec![]);
      }

      self.events.lock().unwrap().extend(events.iter().cloned());
      Ok(self.woken.lock().unwrap().clone())
    })
  }

  fn offered<'a>(
    &'a self,
    key: &'a BrainKey,
    _chat: i64,
    kinds: &'a [String],
  ) -> BoxFuture<'a, Answer<Vec<Fragment>>> {
    Box::pin(async move {
      if !self.reads(key) {
        return Ok(vec![]);
      }

      let own = self.own.lock().unwrap();
      let shared = self.fragments.lock().unwrap();
      let rows = own.get(key).unwrap_or(&shared);

      Ok(rows.iter().filter(|row| kinds.contains(&row.kind)).cloned().collect())
    })
  }

  fn knowledge<'a>(
    &'a self,
    key: &'a BrainKey,
    _chat: i64,
    slugs: &'a [String],
  ) -> BoxFuture<'a, Answer<Reply<Vec<Document>>>> {
    Box::pin(async move {
      if !self.reads(key) {
        return Ok(Reply::Answered(vec![]));
      }

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

  fn lore<'a>(&'a self, key: &'a BrainKey, slugs: &'a [String]) -> BoxFuture<'a, Answer<Vec<Document>>> {
    Box::pin(async move {
      if !self.reads(key) {
        return Ok(vec![]);
      }

      self.lore_asked.lock().unwrap().push(slugs.to_vec());

      let lore = self.lore.lock().unwrap();

      Ok(
        slugs
          .iter()
          .filter_map(|slug| {
            lore.get(slug).map(|text| Document {
              slug: slug.clone(),
              path: format!("lore/{slug}.md"),
              text: text.clone(),
              version: "v".into(),
            })
          })
          .collect(),
      )
    })
  }

  fn sheets<'a>(
    &'a self,
    key: &'a BrainKey,
    _chat: i64,
    people: &'a [i64],
    lines: Option<usize>,
  ) -> BoxFuture<'a, Answer<Vec<Sheet>>> {
    Box::pin(async move {
      if !self.reads(key) {
        return Ok(vec![]);
      }

      let sheets = self.sheets.lock().unwrap();
      let head = |sheet: &Sheet| Sheet {
        text: match lines {
          Some(lines) => sheet.text.lines().take(lines).collect::<Vec<_>>().join("\n"),
          None => sheet.text.clone(),
        },
        ..sheet.clone()
      };

      Ok(
        people
          .iter()
          .filter_map(|person| sheets.iter().find(|sheet| sheet.person == *person).map(head))
          .collect(),
      )
    })
  }
}

/// The stand-in receiver: the rooms it keeps, the names it knows people by, the messages it keeps by room and number,
/// the chat agent's own number, the owner notices it was handed, and the draft rows its stream tells.
#[derive(Default)]
pub struct FakeReceiver {
  pub drafted: Mutex<Vec<Drafted>>,
}

impl Receiver for FakeReceiver {
  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>> {
    Box::pin(async move {
      let drafted: Vec<Answer<Drafted>> = self.drafted.lock().unwrap().iter().cloned().map(Ok).collect();

      Ok(futures_util::stream::iter(drafted).boxed())
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

/// A gateway answering as another does, each answer a pause after it was asked.
pub struct PausingGateway {
  pub inner: std::sync::Arc<AnsweringGateway>,
  pub pause: std::time::Duration,
}

impl Gateway for PausingGateway {
  fn complete<'a>(&'a self, ask: &'a Ask) -> BoxFuture<'a, Answer<Completion>> {
    Box::pin(async move {
      tokio::time::sleep(self.pause).await;
      self.inner.complete(ask).await
    })
  }
}
