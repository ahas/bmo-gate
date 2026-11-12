//! The service stopped (`docs/boundary-api.md`, 「Stopping」): every open event stream told `stopping` and ended,
//! no new connection taken, a call in hand let finish, and the serve ended at its deadline with a call still open.

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::routing::get;
use gate_server::stop::{Stop, drain};
use reqwest::StatusCode;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use tokio::time::timeout;

use super::{TOKEN, ground};

// The longest any of these waits on a condition.
const BOUND: Duration = Duration::from_secs(10);

// A route that tells `entered` it has the call and answers once `released` lets it.
fn held(entered: Arc<Notify>, released: Arc<Notify>) -> Router {
  Router::new().route(
    "/held",
    get(move || async move {
      entered.notify_one();
      released.notified().await;
      "done"
    }),
  )
}

#[tokio::test]
async fn a_stop_tells_the_event_stream_ends_it_takes_no_new_connection_and_lets_the_call_in_hand_finish() {
  let ground = ground("stop-drained", |_| None).await;
  let entered = Arc::new(Notify::new());
  let released = Arc::new(Notify::new());
  let router = gate_server::router(ground.app.clone()).merge(held(entered.clone(), released.clone()));
  let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
  let at = listener.local_addr().unwrap();
  let stop = ground.app.stop.clone();
  let serving = tokio::spawn(drain(listener, router, stop.clone(), BOUND * 6));
  let client = reqwest::Client::new();
  let events = client.get(format!("http://{at}/events")).bearer_auth(TOKEN).send().await.unwrap();
  let in_hand = tokio::spawn(client.get(format!("http://{at}/held")).send());

  timeout(BOUND, entered.notified()).await.unwrap();
  stop.stop();

  let told = timeout(BOUND, events.text()).await.unwrap().unwrap();

  assert_eq!(told.trim(), "event: stopping\ndata: {}");

  let mut refused = false;

  for _ in 0..500 {
    if TcpStream::connect(at).await.is_err() {
      refused = true;
      break;
    }

    tokio::time::sleep(Duration::from_millis(20)).await;
  }

  assert!(refused, "a connection was still taken after the stop");
  assert!(!serving.is_finished(), "the serve ended with a call in hand");

  released.notify_one();

  let answered = timeout(BOUND, in_hand).await.unwrap().unwrap().unwrap();

  assert_eq!(answered.status(), StatusCode::OK);
  assert_eq!(answered.text().await.unwrap(), "done");
  timeout(BOUND, serving).await.unwrap().unwrap().unwrap();
}

#[tokio::test]
async fn a_call_still_in_hand_at_the_deadline_ends_with_the_serve() {
  let entered = Arc::new(Notify::new());
  let never = Arc::new(Notify::new());
  let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
  let at = listener.local_addr().unwrap();
  let stop = Stop::default();
  let serving =
    tokio::spawn(drain(listener, held(entered.clone(), never), stop.clone(), Duration::from_millis(50)));
  let _in_hand = tokio::spawn(reqwest::get(format!("http://{at}/held")));

  timeout(BOUND, entered.notified()).await.unwrap();
  stop.stop();

  timeout(BOUND, serving).await.unwrap().unwrap().unwrap();
}
