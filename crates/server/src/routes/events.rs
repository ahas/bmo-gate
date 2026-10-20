//! The event stream (`docs/api.md`, 「Events」): every event the gate tells its readers of, as server-sent
//! events by its kind, from the moment the stream opens; a reader that falls behind loses what it missed and
//! reads on.

use std::convert::Infallible;
use std::sync::Arc;

use axum::extract::State;
use axum::response::sse::{Event as SseEvent, KeepAlive, Sse};
use bmo_gate_client::Event;
use futures_util::Stream;
use futures_util::stream;
use tokio::sync::broadcast::error::RecvError;

use crate::App;

pub async fn stream(State(app): State<Arc<App>>) -> Sse<impl Stream<Item = Result<SseEvent, Infallible>>> {
  let heard = app.stages.events.subscribe();
  let events = stream::unfold(heard, |mut heard| async move {
    loop {
      match heard.recv().await {
        Ok(event) => {
          let body = Event {
            id: event.id,
            kind: event.kind.to_owned(),
            at: event.at,
            data: event.data,
          };
          let sent = SseEvent::default()
            .id(body.id.to_string())
            .event(event.kind)
            .data(serde_json::to_string(&body).unwrap_or_default());

          return Some((Ok(sent), heard));
        }
        Err(RecvError::Lagged(_)) => continue,
        Err(RecvError::Closed) => return None,
      }
    }
  });

  Sse::new(events).keep_alive(KeepAlive::default())
}
