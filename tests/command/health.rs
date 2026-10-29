//! `bmo-gate health` against a stand-in service on the loopback: ready ends 0, not ready or a wrong token ends 1
//! saying why, and settings that do not stand end 1 before anything is asked.

use std::path::{Path, PathBuf};

use axum::Json;
use axum::Router;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::get;
use gate_command::health::health;
use gate_command::{Fault, ended};
use serde_json::{Value, json};

const TOKEN: &str = "health-token";

// A stand-in answering `/health` as the service does, ready or not, behind the token.
async fn serve(ready: bool) -> String {
  let app = Router::new().route(
    "/health",
    get(move |headers: HeaderMap| async move {
      let given = headers.get("authorization").and_then(|value| value.to_str().ok());

      if given != Some(&format!("Bearer {TOKEN}")) {
        return Err(StatusCode::UNAUTHORIZED);
      }

      Ok::<Json<Value>, StatusCode>(Json(json!({ "version": "9.9.9", "ready": ready })))
    }),
  );
  let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
  let address = format!("http://{}", listener.local_addr().expect("its address"));

  tokio::spawn(async move { axum::serve(listener, app).await });

  address
}

// The service's settings, every unit it calls at the same stand-in, with its token under the data root's `env/`.
fn settings(root: &Path, address: &str, token: &str) -> PathBuf {
  std::fs::create_dir_all(root.join("env")).expect("env/");
  std::fs::write(root.join("env").join("gate.token"), format!("{token}\n")).expect("the token file");
  let path = root.join("settings.toml");
  let unit = format!("address = \"{address}\"");

  std::fs::write(
    &path,
    format!(
      "listen = \"127.0.0.1:0\"\naddress = \"{address}\"\ntoken_file = \"gate.token\"\n\
       database = \"postgres://nobody@127.0.0.1/none\"\ndata_root = \"{}\"\nchat_agent = \"agent\"\n\
       session_folder = \"/tmp\"\n\
       [agency]\n{unit}\n[brain]\n{unit}\n[receiver]\n{unit}\n\
       [gateway]\n{unit}\nkey_file = \"gateway.key\"\n",
      root.display()
    ),
  )
  .expect("the settings");

  path
}

#[tokio::test]
async fn a_ready_service_ends_zero() {
  let root = tempfile::tempdir().expect("a scratch folder");
  let address = serve(true).await;

  let (lines, said, code) = ended(health(&settings(root.path(), &address, TOKEN)).await);

  assert_eq!((lines, said, code), (vec!["ready, version 9.9.9".to_owned()], None, 0));
}

#[tokio::test]
async fn a_service_not_ready_ends_one_saying_so() {
  let root = tempfile::tempdir().expect("a scratch folder");
  let address = serve(false).await;

  let (_, said, code) = ended(health(&settings(root.path(), &address, TOKEN)).await);

  assert_eq!(code, 1);
  assert!(said.expect("a reason").contains("is not ready"));
}

#[tokio::test]
async fn a_wrong_token_ends_one_with_the_status() {
  let root = tempfile::tempdir().expect("a scratch folder");
  let address = serve(true).await;

  let (_, said, code) = ended(health(&settings(root.path(), &address, "another")).await);

  assert_eq!(code, 1);
  assert!(said.expect("a reason").contains("401"));
}

#[tokio::test]
async fn settings_that_do_not_stand_end_one() {
  let root = tempfile::tempdir().expect("a scratch folder");

  let answered = health(&root.path().join("absent.toml")).await;

  assert!(
    matches!(answered, Err(Fault::Failed { ref said, .. }) if said.contains("the settings do not stand"))
  );
}
