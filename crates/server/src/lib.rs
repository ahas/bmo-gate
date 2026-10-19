//! The gate's service (`docs/boundary-api.md`): every route the boundary states, behind the gate's bearer token,
//! and the watches the service keeps going beside them — the agency's road events written into the road records,
//! the session summariser's hook kept registered, Laya's health asked once a minute, and the attachments counted
//! every hour.

pub mod answer;
pub mod routes;
pub mod settings;
pub mod watches;

use std::path::PathBuf;
use std::sync::Arc;

use axum::Router;
use axum::extract::{Request, State};
use axum::http::header::AUTHORIZATION;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use gate_codes::Code;
use gate_ports::Peer;
use gate_ports::agency::HttpAgency;
use gate_ports::brain::HttpBrain;
use gate_ports::gateway::HttpGateway;
use gate_ports::job::{HttpJob, Job};
use gate_ports::receiver::HttpReceiver;
use gate_reference::Reference;
use gate_runs::{RecordFolders, Runs};
use gate_stages::document_translation::Queue;
use gate_stages::laya::Side;
use gate_stages::{Reading, Stages};
use sea_orm::DatabaseConnection;
use sea_orm_migration::MigratorTrait;

use crate::answer::Refused;
use crate::settings::{Settings, Unread};

/// Everything a route stands on: the gates and the reference road, bmo-job for the rows the gate raises, the
/// document translations' queue, the token every caller presents, the owner's room, and the data root.
pub struct App {
  pub stages: Arc<Stages>,
  pub reference: Arc<Reference>,
  pub job: Arc<dyn Job>,
  pub queue: Queue,
  pub token: String,
  pub owner_room: i64,
  pub data_root: PathBuf,
}

async fn bearer(State(app): State<Arc<App>>, request: Request, next: Next) -> Response {
  let presented = request
    .headers()
    .get(AUTHORIZATION)
    .and_then(|value| value.to_str().ok())
    .and_then(|value| value.strip_prefix("Bearer "));

  if presented != Some(app.token.as_str()) {
    return Refused::new(Code::Unauthorized, "the token is missing or wrong").into_response();
  }

  next.run(request).await
}

async fn absent() -> Refused {
  Refused::new(Code::RouteAbsent, "no route answers this method and path")
}

/// Every route, behind the bearer check.
pub fn router(app: Arc<App>) -> Router {
  routes::all()
    .fallback(absent)
    .method_not_allowed_fallback(absent)
    .layer(middleware::from_fn_with_state(app.clone(), bearer))
    .with_state(app)
}

fn peer(address: &str, token: Option<String>) -> Result<Peer, Unread> {
  Peer::new(address, token).map_err(|why| Unread(why.to_string()))
}

/// The gate's database as its settings name it, holding so many connections, neither migrated nor checked.
pub async fn database(settings: &Settings, connections: u32) -> Result<DatabaseConnection, Unread> {
  gate_store::connect(&settings.database, connections)
    .await
    .map_err(|why| Unread(format!("the database: {why}")))
}

/// The gates as the settings make them over `db`: the runs on the agency and its gateway, Laya's side and the
/// readings the translator's checks stand on.
pub fn stages(settings: &Settings, db: DatabaseConnection) -> Result<Arc<Stages>, Unread> {
  let agency =
    Arc::new(HttpAgency::new(peer(&settings.agency.address, settings.unit_token(&settings.agency)?)?));
  let gateway = Arc::new(HttpGateway::new(
    peer(&settings.gateway.address, None)?,
    settings.env_file(&settings.gateway.key_file),
  ));
  let runs = Runs::new(
    db.clone(),
    agency,
    gateway,
    settings.chat_agent.clone(),
    settings.session_folder.clone(),
    RecordFolders {
      claude: settings.records.claude.clone(),
      codex: settings.records.codex.clone(),
    },
  );
  let side = Side::new(
    db,
    settings.laya.as_ref().map(|laya| laya.address.as_str()),
    settings
      .laya
      .as_ref()
      .and_then(|laya| laya.token_file.as_deref())
      .map(|name| settings.env_file(name)),
    settings.chat_agent.clone(),
  );
  let reading = Reading {
    set_aside: settings.reading.set_aside.clone(),
    wording: settings.reading.wording.clone(),
  };

  Ok(Arc::new(Stages::new(runs, side, reading)))
}

/// The service as its settings make it: the store connected and migrated, every port, the gates and the road.
pub async fn stand(settings: &Settings) -> Result<Arc<App>, Unread> {
  let db = database(settings, 16).await?;

  gate_store::migration::Migrator::up(&db, None)
    .await
    .map_err(|why| Unread(format!("the migration: {why}")))?;

  let stages = stages(settings, db)?;
  let reference = Arc::new(Reference {
    stages: stages.clone(),
    brain: Arc::new(HttpBrain::new(peer(&settings.brain.address, settings.unit_token(&settings.brain)?)?)),
    receiver: Arc::new(HttpReceiver::new(peer(
      &settings.receiver.address,
      settings.unit_token(&settings.receiver)?,
    )?)),
    shipped: settings.shipped.as_ref().map(|shipped| shipped.folder.clone()),
  });
  let token = settings
    .token(&settings.token_file)?
    .ok_or_else(|| Unread("the gate's token file is empty".into()))?;

  Ok(Arc::new(App {
    stages,
    reference,
    job: Arc::new(HttpJob::new(peer(&settings.job.address, settings.unit_token(&settings.job)?)?)),
    queue: Queue::default(),
    token,
    owner_room: settings.owner_room,
    data_root: settings.data_root.clone(),
  }))
}

/// The service answering at its listen address until it is stopped, its watches going beside it.
pub async fn serve(settings: Settings) -> Result<(), Unread> {
  let app = stand(&settings).await?;
  let listener = tokio::net::TcpListener::bind(&settings.listen)
    .await
    .map_err(|why| Unread(format!("{}: {why}", settings.listen)))?;

  watches::start(
    app.clone(),
    format!("{}/hooks/session-summariser", settings.address.trim_end_matches('/')),
  );
  println!("gate-server: answering at {}", settings.listen);

  axum::serve(listener, router(app)).await.map_err(|why| Unread(why.to_string()))
}
