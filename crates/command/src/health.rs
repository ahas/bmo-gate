//! `bmo-gate health` (`docs/boundary-api.md`, 「Health」): the service the settings name asked whether it is
//! ready, at its own address with its own token, the deployment's check of a release it has just started.

use std::path::Path;
use std::time::Duration;

use gate_server::settings::Settings;
use serde::Deserialize;

use crate::{Answered, Fault};

/// The longest the service is waited on.
pub const WAIT: Duration = Duration::from_secs(5);

#[derive(Deserialize)]
struct Health {
  ready: bool,
  version: String,
}

/// Whether the service the settings at `path` name answers ready.
pub async fn health(path: &Path) -> Answered {
  let settings =
    Settings::read(path).map_err(|why| Fault::failed(format!("the settings do not stand: {why}")))?;
  let token = settings
    .token(&settings.token_file)
    .map_err(|why| Fault::failed(format!("the service's token: {why}")))?
    .ok_or_else(|| Fault::failed(format!("{} holds no token", settings.token_file)))?;
  let url = format!("{}/health", settings.address.trim_end_matches('/'));
  let client = reqwest::Client::builder()
    .timeout(WAIT)
    .build()
    .map_err(|why| Fault::failed(format!("no client: {why}")))?;
  let answer = client
    .get(&url)
    .bearer_auth(token)
    .send()
    .await
    .map_err(|why| Fault::failed(format!("{url} does not answer: {why}")))?;

  if !answer.status().is_success() {
    return Err(Fault::failed(format!("{url} answered {}", answer.status())));
  }

  let health: Health = answer
    .json()
    .await
    .map_err(|why| Fault::failed(format!("{url} answered no health: {why}")))?;

  if health.ready {
    Ok(vec![format!("ready, version {}", health.version)])
  } else {
    Err(Fault::failed(format!("{url} answers, version {}, and is not ready", health.version)))
  }
}
