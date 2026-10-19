//! What the service keeps going beside its routes: the agency's `road-walked` events written into the road records,
//! the session summariser's hook registered again every few minutes so an agency started since finds it, Laya's
//! health asked once a minute and told to the screens where its state or model moved, and the attachments counted
//! every hour.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;
use gate_ports::agency::RoadWalked;
use gate_reference::attachments;
use gate_runs::records::{self, Road, Spent, now};
use gate_stages::laya_health;
use sea_orm::DatabaseConnection;
use serde_json::json;

use crate::App;

/// How long a dropped event stream waits before it is opened again.
const REOPEN: Duration = Duration::from_secs(5);

/// How often the hook is registered again, and how often a registration that failed is tried again.
const REGISTER_EVERY: Duration = Duration::from_secs(300);
const REGISTER_RETRY: Duration = Duration::from_secs(30);

/// How often Laya's health is asked, and how often the attachments are counted.
const HEALTH_EVERY: Duration = Duration::from_secs(60);
const ATTACHMENTS_EVERY: Duration = Duration::from_secs(3_600);

/// The point the session summariser answers.
pub const SUMMARISER: &str = "session-summariser";

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

async fn hook(app: Arc<App>, url: String) {
  let agency = app.stages.runs.agency.clone();

  loop {
    let wait = match agency.register_hook(SUMMARISER, &url, Some(&app.token)).await {
      Ok(()) => REGISTER_EVERY,
      Err(why) => {
        eprintln!("gate-server: the {SUMMARISER} hook could not be registered: {why}");
        REGISTER_RETRY
      }
    };

    tokio::time::sleep(wait).await;
  }
}

/// One health pass of Laya, told to the screens where its state or model moved.
pub async fn health_pass(app: &App) {
  let db = &app.stages.runs.db;

  match laya_health::pass(db, &app.stages.laya, now()).await {
    Ok(true) => match laya_health::read(db).await {
      Ok(health) => app.stages.publish("laya", json!({ "state": health.state, "model": health.model })),
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

async fn attachments(app: Arc<App>) {
  let file = app.data_root.join("gate").join("attachments.json");

  loop {
    tokio::time::sleep(ATTACHMENTS_EVERY).await;

    match attachments::pass(&app.reference, app.job.as_ref(), app.owner_room, &file, now()).await {
      Ok(raised) if !raised.is_empty() => println!("gate-server: the attachments watch raised {raised:?}"),
      Ok(_) => {}
      Err(why) => eprintln!("gate-server: the attachments watch stopped short: {why}"),
    }
  }
}

/// Every watch started beside the routes, the hook registered at `url`.
pub fn start(app: Arc<App>, url: String) {
  tokio::spawn(road_walked(app.clone()));
  tokio::spawn(hook(app.clone(), url));
  tokio::spawn(health(app.clone()));
  tokio::spawn(attachments(app));
}
