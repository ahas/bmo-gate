//! A stand-in agency the test stops and starts on one port, as a deploy restarts the real one: stopped, every
//! connection it holds is cut and the port refuses; started again, it answers on the same port. What it keeps
//! outlives a stop, as the agency's store does: the road events it was told to publish, each under a rising number,
//! which its event stream sends after the number `Last-Event-ID` names and then live; and the script its
//! translation runs are answered by, a step a run.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use axum::Router;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use futures_util::{Stream, StreamExt, stream};
use hyper::server::conn::http1;
use hyper_util::rt::TokioIo;
use hyper_util::service::TowerToHyperService;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio::sync::{Notify, broadcast};
use tokio::task::{JoinHandle, JoinSet};

/// How the stand-in answers one translation run.
#[derive(Clone, Debug)]
pub enum Run {
  /// Held, unanswered, until the test lets it go, then answered with the text.
  Held(String),
  /// Refused with a status and a code.
  Refused(u16, &'static str),
  /// Answered with the text.
  Answered(String),
}

#[derive(Default)]
struct Kept {
  /// Every road event published, its number and its frame's data.
  roads: Mutex<Vec<(i64, Value)>>,
  /// The `Last-Event-ID` each opening of the event stream named.
  opened: Mutex<Vec<Option<String>>>,
  /// The steps the coming translation runs are answered by; a run past them is answered `the translation`.
  runs: Mutex<VecDeque<Run>>,
  /// Every translation run asked, its body.
  asked: Mutex<Vec<Value>>,
  heard: Notify,
  released: Notify,
  live: Mutex<Option<broadcast::Sender<(i64, Value)>>>,
}

/// The stand-in, answering at `at` while it stands.
pub struct StandInAgency {
  pub at: SocketAddr,
  kept: Arc<Kept>,
  serving: Mutex<Option<JoinHandle<()>>>,
}

fn frame(event: i64, data: &Value) -> Event {
  Event::default().id(event.to_string()).event("road-walked").data(data.to_string())
}

async fn events(
  State(kept): State<Arc<Kept>>,
  headers: HeaderMap,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
  let after = headers.get("last-event-id").and_then(|value| value.to_str().ok()).map(str::to_owned);

  kept.opened.lock().unwrap().push(after.clone());

  let after: Option<i64> = after.and_then(|after| after.parse().ok());
  let live = kept
    .live
    .lock()
    .unwrap()
    .as_ref()
    .expect("a standing stand-in has its live channel")
    .subscribe();
  let replayed: Vec<(i64, Value)> = match after {
    Some(after) => kept.roads.lock().unwrap().iter().filter(|(event, _)| *event > after).cloned().collect(),
    None => vec![],
  };
  let sent = replayed.last().map(|(event, _)| *event).or(after).unwrap_or(i64::MIN);
  let replayed = stream::iter(replayed.into_iter().map(|(event, data)| Ok(frame(event, &data))));
  // What was published between the subscription and the replay is in both, and goes once.
  let live = stream::unfold((live, sent), |(mut live, sent)| async move {
    loop {
      match live.recv().await {
        Ok((event, data)) if event > sent => return Some((Ok(frame(event, &data)), (live, event))),
        Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
        Err(broadcast::error::RecvError::Closed) => return None,
      }
    }
  });

  Sse::new(replayed.chain(live))
}

async fn translation_run(State(kept): State<Arc<Kept>>, body: axum::Json<Value>) -> Response {
  kept.asked.lock().unwrap().push(body.0);
  kept.heard.notify_one();

  let step = kept.runs.lock().unwrap().pop_front();
  let answered = |text: String| {
    (
      StatusCode::OK,
      axum::Json(json!({ "text": text, "provider": "a-provider", "model": "a-model" })),
    )
      .into_response()
  };

  match step {
    Some(Run::Held(text)) => {
      kept.released.notified().await;
      answered(text)
    }
    Some(Run::Refused(status, code)) => (
      StatusCode::from_u16(status).unwrap(),
      axum::Json(json!({ "code": code, "error": "refused by the stand-in" })),
    )
      .into_response(),
    Some(Run::Answered(text)) => answered(text),
    None => answered("the translation".to_owned()),
  }
}

impl StandInAgency {
  /// The stand-in on a port the system chooses.
  pub async fn start() -> StandInAgency {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let agency = StandInAgency {
      at: listener.local_addr().unwrap(),
      kept: Arc::new(Kept::default()),
      serving: Mutex::new(None),
    };

    agency.serve(listener);
    agency
  }

  /// Its address as a peer names it.
  pub fn address(&self) -> String {
    format!("http://{}", self.at)
  }

  fn serve(&self, listener: TcpListener) {
    let (live, _) = broadcast::channel(64);

    *self.kept.live.lock().unwrap() = Some(live);

    let router = Router::new()
      .route("/events", get(events))
      .route("/translation-runs", post(translation_run))
      .with_state(self.kept.clone());
    let serving = tokio::spawn(async move {
      // Each connection is a task of this set, so the set going with the accept loop cuts every one.
      let mut connections = JoinSet::new();

      loop {
        let Ok((stream, _)) = listener.accept().await else { return };
        let service = TowerToHyperService::new(router.clone());

        connections.spawn(async move {
          let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
        });
      }
    });

    *self.serving.lock().unwrap() = Some(serving);
  }

  /// The stand-in stopped: every connection cut, the port let go, what it keeps kept.
  pub async fn stop(&self) {
    let serving = self.serving.lock().unwrap().take();

    if let Some(serving) = serving {
      serving.abort();
      let _ = serving.await;
    }

    *self.kept.live.lock().unwrap() = None;
  }

  /// The stand-in started again on its own port.
  pub async fn start_again(&self) {
    let listener = TcpListener::bind(self.at).await.unwrap();

    self.serve(listener);
  }

  /// One road of `run` published under `event`, kept and told to every stream open now.
  pub fn publish_road(&self, event: i64, chat: i64, run: &str) {
    let road = json!({
      "stage": "chat", "chatId": chat, "run": run, "provider": "a-provider", "model": "a-model",
      "outcome": "answered", "ms": 900, "inputTokens": 3, "outputTokens": 4, "cacheReadTokens": null,
      "cacheWriteTokens": null, "contextRatio": null
    });
    let data = json!({ "id": event, "kind": "road-walked", "at": 1, "data": road });

    self.kept.roads.lock().unwrap().push((event, data.clone()));

    if let Some(live) = self.kept.live.lock().unwrap().as_ref() {
      let _ = live.send((event, data));
    }
  }

  /// The `Last-Event-ID` each opening of the event stream named, in order.
  pub fn opened(&self) -> Vec<Option<String>> {
    self.kept.opened.lock().unwrap().clone()
  }

  /// The coming translation runs answered by `runs`, in order.
  pub fn script(&self, runs: Vec<Run>) {
    self.kept.runs.lock().unwrap().extend(runs);
  }

  /// How many translation runs were asked.
  pub fn asked(&self) -> usize {
    self.kept.asked.lock().unwrap().len()
  }

  /// Ends once a translation run is asked after the last one this waited for.
  pub async fn heard(&self) {
    self.kept.heard.notified().await;
  }

  /// A held run let go.
  pub fn release(&self) {
    self.kept.released.notify_one();
  }
}

impl Drop for StandInAgency {
  fn drop(&mut self) {
    if let Some(serving) = self.serving.lock().unwrap().take() {
      serving.abort();
    }
  }
}
