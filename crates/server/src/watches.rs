//! What the service keeps going beside its routes: the agency's `road-walked` events written into the road records,
//! the receiver's `draft` rows written as the `draft` stage and told to the screens, Laya's health asked once a
//! minute and told to the screens where its state or model moved, and the bounded tables swept as the service starts
//! and once a day after. None of them registers a hook at the agency.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use gate_ports::agency::RoadWalked;
use gate_ports::receiver::Drafted;
use gate_runs::records::{self, Road, Spent, now};
use gate_stages::{laya_health, retention};
use sea_orm::DatabaseConnection;
use serde_json::json;

use crate::App;
use crate::drafts;
use crate::routes::judgements::judgement_of;

/// How long a dropped event stream waits before it is opened again.
const REOPEN: Duration = Duration::from_secs(5);

/// How often Laya's health is asked.
const HEALTH_EVERY: Duration = Duration::from_secs(60);

/// How often the bounded tables are swept.
const SWEEP_EVERY: Duration = Duration::from_secs(24 * 3_600);

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

/// One health pass of Laya, told to the screens where its state or model moved.
pub async fn health_pass(app: &App) {
  let db = &app.stages.runs.db;

  match laya_health::pass(db, &app.stages.laya, now()).await {
    Ok(true) => match laya_health::read(db).await {
      Ok(health) => app
        .stages
        .publish("laya.changed", json!({ "state": health.state, "model": health.model })),
      Err(why) => eprintln!("gate-server: Laya's health could not be read back: {why}"),
    },
    Ok(false) => {}
    Err(why) => eprintln!("gate-server: Laya's health could not be written: {why}"),
  }
}

async fn health(app: Arc<App>) {
  loop {
    health_pass(&app).await;
    tokio::time::sleep(HEALTH_EVERY).await;
  }
}

/// One sweep of the bounded tables, said where it took anything.
pub async fn sweep_pass(db: &DatabaseConnection) {
  match retention::sweep(db, now()).await {
    Ok(swept) => {
      for (table, gone) in swept.into_iter().filter(|(_, gone)| *gone > 0) {
        println!("gate-server: swept {gone} rows of {table} past their bound");
      }
    }
    Err(why) => eprintln!("gate-server: the bounded tables could not be swept: {why}"),
  }
}

async fn sweeps(app: Arc<App>) {
  loop {
    sweep_pass(&app.stages.runs.db).await;
    tokio::time::sleep(SWEEP_EVERY).await;
  }
}

/// Every watch started beside the routes.
pub fn start(app: Arc<App>) {
  tokio::spawn(road_walked(app.clone()));
  tokio::spawn(drafted(app.clone()));
  tokio::spawn(health(app.clone()));
  tokio::spawn(sweeps(app));
}
