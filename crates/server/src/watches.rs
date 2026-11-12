//! What the service keeps going beside its routes: the agency's `road-walked` events written into the road
//! records, read on from the newest one written (`docs/boundary-api.md`, 「The roads walked」), and the receiver's
//! `draft` rows written as the `draft` stage and told to the screens. None of them registers a hook at the agency.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use gate_ports::agency::{RoadEvent, RoadWalked};
use gate_ports::receiver::Drafted;
use gate_runs::records::{self, Road, Spent};
use sea_orm::{DatabaseConnection, DbErr};
use serde_json::json;

use crate::App;
use crate::drafts;
use crate::routes::judgements::judgement_of;

/// How long a dropped event stream waits before it is opened again.
pub const REOPEN: Duration = Duration::from_secs(5);

/// One road the agency walked, written as a road record with the number of the event it came in.
pub async fn write_walked(db: &DatabaseConnection, event: i64, road: &RoadWalked) -> Result<(), DbErr> {
  let spent = Spent {
    input_tokens: road.input_tokens,
    output_tokens: road.output_tokens,
    cache_read_tokens: road.cache_read_tokens,
    cache_write_tokens: road.cache_write_tokens,
  };

  records::write_road(
    db,
    &Road {
      stage: &road.stage,
      chat_id: road.chat_id,
      message_id: None,
      provider: &road.provider,
      model: &road.model,
      outcome: &road.outcome,
      ms: road.ms,
      spent: &spent,
      round: None,
      run: road.run.as_deref(),
      context_ratio: road.context_ratio,
      event: Some(event),
    },
  )
  .await
}

/// The newest number a road was written with, read again after `reopen` for as long as the store does not answer.
async fn newest_written(db: &DatabaseConnection, reopen: Duration) -> Option<i64> {
  loop {
    match records::newest_event(db).await {
      Ok(newest) => return newest,
      Err(why) => eprintln!("gate-server: the newest road written could not be read: {why}"),
    }

    tokio::time::sleep(reopen).await;
  }
}

/// The agency's roads read on from the newest written, each written once, the stream opened again `reopen` after
/// it drops. A road the store would not take ends the stream, so it is read again when the stream is opened again.
async fn road_walked(app: Arc<App>, reopen: Duration) {
  let agency = app.stages.runs.agency.clone();
  let db = app.stages.runs.db.clone();
  let mut newest = newest_written(&db, reopen).await;

  loop {
    match agency.roads_walked(newest).await {
      Ok(mut stream) => {
        while let Some(told) = stream.next().await {
          match told {
            Ok(RoadEvent::Walked { event, road }) if newest.is_none_or(|newest| event > newest) => {
              if let Err(why) = write_walked(&db, event, &road).await {
                eprintln!("gate-server: the road of event {event} could not be written: {why}");
                break;
              }

              newest = Some(event);
            }
            Ok(RoadEvent::Walked { .. }) => {}
            Ok(RoadEvent::Missed { after, kept_from }) => {
              eprintln!(
                "gate-server: the agency keeps no roads after event {after}; it keeps them from {}",
                kept_from.map_or("none".to_owned(), |kept| kept.to_string())
              );

              // A number past what the agency keeps is one it never gave, so its numbering stands behind the
              // gate's and every road it sends after the notice is new.
              if kept_from.is_none_or(|kept| kept <= after) {
                newest = None;
              }
            }
            Err(why) => eprintln!("gate-server: a road the agency walked did not read: {why}"),
          }
        }
      }
      Err(why) => eprintln!("gate-server: the agency's road events could not be opened: {why}"),
    }

    tokio::time::sleep(reopen).await;
  }
}

/// One row of a round's draft process written as the `draft` stage, and told to the screens where it was written.
pub async fn write_drafted(app: &App, drafted: &Drafted) {
  match drafts::write(&app.stages.runs.db, drafted).await {
    Ok(Some(written)) => app
      .stages
      .publish("judgement.created", serde_json::to_value(judgement_of(&written)).unwrap_or(json!({}))),
    Ok(None) => {}
    Err(why) => {
      eprintln!("gate-server: a draft row of chat {} could not be written: {why}", drafted.chat_id)
    }
  }
}

async fn drafted(app: Arc<App>, reopen: Duration) {
  let receiver = app.reference.receiver.clone();

  loop {
    match receiver.drafts().await {
      Ok(mut stream) => {
        while let Some(drafted) = stream.next().await {
          match drafted {
            Ok(drafted) => write_drafted(&app, &drafted).await,
            Err(why) => eprintln!("gate-server: a draft row the receiver told did not read: {why}"),
          }
        }
      }
      Err(why) => eprintln!("gate-server: the receiver's event stream could not be opened: {why}"),
    }

    tokio::time::sleep(reopen).await;
  }
}

/// Every watch started beside the routes, each stream opened again `reopen` after it drops.
pub fn start(app: Arc<App>, reopen: Duration) {
  tokio::spawn(road_walked(app.clone(), reopen));
  tokio::spawn(drafted(app, reopen));
}
