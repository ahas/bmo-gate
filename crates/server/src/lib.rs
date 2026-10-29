//! The gate's service (`docs/boundary-api.md`): every route the boundary states, behind the gate's bearer token,
//! and the watches the service keeps going beside them — the agency's road events written into the road records,
//! and the receiver's draft rows written as the `draft` stage.

pub mod answer;
pub mod drafts;
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
use gate_ports::receiver::HttpReceiver;
use gate_reference::Reference;
use gate_runs::Runs;
use gate_stages::document_translation::Queue;
use gate_stages::translator::Intake;
use gate_stages::{Reading, Stages};
use sea_orm::DatabaseConnection;
use sea_orm_migration::MigratorTrait;

use crate::answer::Refused;
use crate::settings::{Settings, Unread};

/// Everything a route stands on: the gates and the reference road, the document translations' queue, the
/// translations' intake, the token every caller presents and the data root.
pub struct App {
  pub stages: Arc<Stages>,
  pub reference: Arc<Reference>,
  pub queue: Queue,
  pub translations: Intake,
  pub token: String,
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
  Refused::new(Code::NoRoute, "no route answers this method and path")
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

/// The stages as the settings make them over `db`: the runs on the agency and its gateway, and the readings the
/// translator's checks stand on.
pub fn stages(settings: &Settings, db: DatabaseConnection) -> Result<Arc<Stages>, Unread> {
  let agency =
    Arc::new(HttpAgency::new(peer(&settings.agency.address, settings.unit_token(&settings.agency)?)?));
  let gateway = Arc::new(HttpGateway::new(
    peer(&settings.gateway.address, None)?,
    settings.env_file(&settings.gateway.key_file),
  ));
  let mut runs = Runs::new(
    db.clone(),
    agency,
    gateway,
    settings.chat_agent.clone(),
    settings.session_folder.clone(),
  );

  runs.run_agent = settings.run_agent.clone();
  let reading = Reading {
    set_aside: settings.reading.set_aside.clone(),
    wording: settings.reading.wording.clone(),
  };

  Ok(Arc::new(Stages::new(runs, reading)))
}

/// The reference road as the settings make it over the gates: the brain and the receiver it reads, and the folder
/// the shipped pieces' bodies are read under.
pub fn reference(settings: &Settings, stages: Arc<Stages>) -> Result<Arc<Reference>, Unread> {
  Ok(Arc::new(Reference {
    stages,
    brain: Arc::new(HttpBrain::new(peer(&settings.brain.address, settings.unit_token(&settings.brain)?)?)),
    receiver: Arc::new(HttpReceiver::new(peer(
      &settings.receiver.address,
      settings.unit_token(&settings.receiver)?,
    )?)),
    shipped: settings.shipped.as_ref().map(|shipped| shipped.folder.clone()),
  }))
}

/// The service as its settings make it: the store connected and migrated, every port, the gates and the road.
pub async fn stand(settings: &Settings) -> Result<Arc<App>, Unread> {
  let db = database(settings, 16).await?;

  gate_store::migration::Migrator::up(&db, None)
    .await
    .map_err(|why| Unread(format!("the migration: {why}")))?;

  let stages = stages(settings, db)?;
  let reference = reference(settings, stages.clone())?;
  let token = settings
    .token(&settings.token_file)?
    .ok_or_else(|| Unread("the gate's token file is empty".into()))?;

  Ok(Arc::new(App {
    stages,
    reference,
    queue: Queue::default(),
    translations: Intake::of_policy(),
    token,
    data_root: settings.data_root.clone(),
  }))
}

/// The service answering at its listen address until it is stopped, its watches going beside it.
pub async fn serve(settings: Settings) -> Result<(), Unread> {
  let app = stand(&settings).await?;
  let listener = tokio::net::TcpListener::bind(&settings.listen)
    .await
    .map_err(|why| Unread(format!("{}: {why}", settings.listen)))?;

  watches::start(app.clone());
  println!("gate-server: answering at {}", settings.listen);

  axum::serve(listener, router(app)).await.map_err(|why| Unread(why.to_string()))
}
