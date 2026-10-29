//! What the service keeps going beside its routes: the agency's `road-walked` events written into the road
//! records, and the receiver's `draft` rows written as the `draft` stage and told to the screens. None of them
//! registers a hook at the agency.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use gate_ports::agency::RoadWalked;
use gate_ports::receiver::Drafted;
use gate_runs::records::{self, Road, Spent};
use sea_orm::DatabaseConnection;
use serde_json::json;

use crate::App;
use crate::drafts;
use crate::routes::judgements::judgement_of;

/// How long a dropped event stream waits before it is opened again.
const REOPEN: Duration = Duration::from_secs(5);

/// One road the agency walked, written as a road record.
pub async fn write_walked(db: &DatabaseConnection, road: &RoadWalked) {
  let spent = Spent {
    input_tokens: road.input_tokens,
    output_tokens: road.output_tokens,
    cache_read_tokens: road.cache_read_tokens,
    cache_write_tokens: road.cache_write_tokens,
  };

  records::road(
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
    },
  )
  .await;
}

async fn road_walked(app: Arc<App>) {
  let agency = app.stages.runs.agency.clone();
  let db = app.stages.runs.db.clone();

  loop {
    match agency.roads_walked().await {
      Ok(mut stream) => {
        while let Some(road) = stream.next().await {
          match road {
            Ok(road) => write_walked(&db, &road).await,
            Err(why) => eprintln!("gate-server: a road the agency walked did not read: {why}"),
          }
        }
      }
      Err(why) => eprintln!("gate-server: the agency's road events could not be opened: {why}"),
    }

    tokio::time::sleep(REOPEN).await;
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

async fn drafted(app: Arc<App>) {
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

    tokio::time::sleep(REOPEN).await;
  }
}

/// Every watch started beside the routes.
pub fn start(app: Arc<App>) {
  tokio::spawn(road_walked(app.clone()));
  tokio::spawn(drafted(app.clone()));
}
