//! Stand-ins for the brain, the account service, the receiver and bmo-job the reference road is carried against, and a gateway that
//! answers each request by what it is asked: each keeps what it was asked, so a test reads back every call.

use std::collections::HashMap;
use std::sync::Mutex;

use futures_util::StreamExt;
use futures_util::future::BoxFuture;
use futures_util::stream::BoxStream;
use gate_ports::PortError;
use gate_ports::accounts::{Accounts, Placement};
use gate_ports::audience::Audience;
use gate_ports::brain::{
  Brain, BrainKey, Condition, Document, Event, Fragment, MemoryRow, OrgMemory, OrgTopic, Reply, Sheet,
};
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
  /// The org brains it keeps, by the company's and the unit's numbers.
  pub org_brains: Mutex<HashMap<(i64, i64), i64>>,
  /// What stands, each topic answered where its brain is among those named.
  pub org_topics: Mutex<Vec<OrgTopic>>,
  /// The org brains named on each read of what stands, and the audience it was read for.
  pub org_topics_asked: Mutex<Vec<(Vec<i64>, Audience)>>,
  /// Each org brain's live memories.
  pub org_memories: Mutex<HashMap<i64, Vec<OrgMemory>>>,
  /// The base, where it keeps one.
  pub base: Mutex<Option<i64>>,
  /// The id of each agent's own brain, where a test names one.
  pub ids: Mutex<HashMap<BrainKey, i64>>,
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

  fn own<'a>(&'a self, key: &'a BrainKey) -> BoxFuture<'a, Answer<Option<i64>>> {
    Box::pin(async move { Ok(self.ids.lock().unwrap().get(key).copied()) })
  }

  fn base(&self) -> BoxFuture<'_, Answer<Option<i64>>> {
    Box::pin(async move { Ok(*self.base.lock().unwrap()) })
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

  fn org_brain(&self, company: i64, unit: i64) -> BoxFuture<'_, Answer<Option<i64>>> {
    Box::pin(async move { Ok(self.org_brains.lock().unwrap().get(&(company, unit)).copied()) })
  }

  fn org_topics<'a>(
    &'a self,
    brains: &'a [i64],
    audience: Audience,
  ) -> BoxFuture<'a, Answer<Vec<OrgTopic>>> {
    Box::pin(async move { Ok(self.standing_for(brains, audience)) })
  }

  fn org_memories(&self, brain: i64) -> BoxFuture<'_, Answer<Vec<OrgMemory>>> {
    Box::pin(async move { Ok(self.org_memories.lock().unwrap().get(&brain).cloned().unwrap_or_default()) })
  }
}

impl FakeBrain {
  /// The brain answering `standing` for the brains named, whatever the audience.
  fn standing_for(&self, brains: &[i64], audience: Audience) -> Vec<OrgTopic> {
    self.org_topics_asked.lock().unwrap().push((brains.to_vec(), audience));
    self
      .org_topics
      .lock()
      .unwrap()
      .iter()
      .filter(|topic| brains.contains(&topic.brain))
      .cloned()
      .collect()
  }
}

/// The stand-in account service: where each person stands, every person it holds none of standing in no unit, and
/// the layers each person's chain turns off, every other layer read.
#[derive(Default)]
pub struct FakeAccounts {
  pub placements: Mutex<HashMap<i64, Placement>>,
  pub layers_off: Mutex<Vec<(i64, String)>>,
}

impl Accounts for FakeAccounts {
  fn placement(&self, user: i64) -> BoxFuture<'_, Answer<Option<Placement>>> {
    Box::pin(async move { Ok(self.placements.lock().unwrap().get(&user).cloned()) })
  }

  fn reads<'a>(&'a self, user: i64, layer: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move {
      Ok(!self.layers_off.lock().unwrap().iter().any(|(who, off)| *who == user && off == layer))
    })
  }
}

/// The stand-in receiver: the draft rows its stream tells, the audience of each room it holds, every other room
/// refused as one it does not hold, and each room and agent its audience was asked for.
#[derive(Default)]
pub struct FakeReceiver {
  pub drafted: Mutex<Vec<Drafted>>,
  pub audiences: Mutex<HashMap<i64, Audience>>,
  pub audience_asked: Mutex<Vec<(i64, String)>>,
}

impl Receiver for FakeReceiver {
  fn drafts(&self) -> BoxFuture<'_, Answer<BoxStream<'static, Answer<Drafted>>>> {
    Box::pin(async move {
      let drafted: Vec<Answer<Drafted>> = self.drafted.lock().unwrap().iter().cloned().map(Ok).collect();

      Ok(futures_util::stream::iter(drafted).boxed())
    })
  }

  fn audience<'a>(&'a self, room: i64, agent: &'a str) -> BoxFuture<'a, Answer<Audience>> {
    Box::pin(async move {
      self.audience_asked.lock().unwrap().push((room, agent.to_owned()));
      self.audiences.lock().unwrap().get(&room).copied().ok_or(PortError::Refused {
        unit: "bmo-receiver",
        call: "a room's audience",
        status: 404,
        code: "not-found".into(),
        error: "no such room".into(),
      })
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
