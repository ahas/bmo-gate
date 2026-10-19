//! The event stream (`docs/boundary-api.md`, `GET /events`): every event the gate tells its screens of, as
//! server-sent events by their kind, from the moment the stream opens; a reader that falls behind loses what it
//! missed and reads on.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures_util::Stream;
use futures_util::stream;
use tokio::sync::broadcast::error::RecvError;

use crate::App;

pub async fn stream(State(app): State<Arc<App>>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
  let heard = app.stages.events.subscribe();
  let events = stream::unfold(heard, |mut heard| async move {
    loop {
      match heard.recv().await {
        Ok(event) => {
          let sent = Event::default().event(event.kind).data(event.body.to_string());

          return Some((Ok(sent), heard));
        }
        Err(RecvError::Lagged(_)) => continue,
        Err(RecvError::Closed) => return None,
      }
    }
  });

  Sse::new(events).keep_alive(KeepAlive::default())
}
