//! The settings the service reads at start (`docs/boundary-api.md`, 「Configuration」): one TOML file, held for the
//! service's life. Every address, path and name of a deployment is read from here, and every token from its own
//! file under the data root's `env/`.

use std::path::{Path, PathBuf};

use serde::Deserialize;

/// A unit the gate calls: its base address, and the file its token stands in.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Unit {
  pub address: String,
  pub token_file: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Gateway {
  pub address: String,
  pub key_file: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Arbiter {
  pub address: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shipped {
  pub folder: PathBuf,
}

/// The console bundle the gate serves (`docs/api.md`, 「Console」): the folder it is built into.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Console {
  pub folder: PathBuf,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Reading {
  #[serde(default)]
  pub set_aside: Vec<String>,
  pub wording: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Settings {
  pub listen: String,
  pub address: String,
  pub token_file: String,
  pub database: String,
  pub data_root: PathBuf,
  pub chat_agent: String,
  /// The agent a gate run's own session stands under, so its program keeps a place of its own; none keeps the
  /// caller's agent, and the stage's name where the caller names none.
  #[serde(default)]
  pub run_agent: Option<String>,
  pub session_folder: String,
  pub owner_room: i64,
  pub agency: Unit,
  pub brain: Unit,
  pub receiver: Unit,
  pub job: Unit,
  pub arbiter: Option<Arbiter>,
  pub gateway: Gateway,
  pub laya: Option<Unit>,
  pub shipped: Option<Shipped>,
  pub console: Option<Console>,
  #[serde(default)]
  pub reading: Reading,
}

/// Why the settings would not stand.
#[derive(Debug)]
pub struct Unread(pub String);

impl std::fmt::Display for Unread {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.0)
  }
}

impl Settings {
  /// The settings a file holds, a relative console folder read from the folder the file stands in.
  pub fn read(path: &Path) -> Result<Self, Unread> {
    let text = std::fs::read_to_string(path).map_err(|why| Unread(format!("{}: {why}", path.display())))?;
    let mut settings: Settings =
      toml::from_str(&text).map_err(|why| Unread(format!("{}: {why}", path.display())))?;

    if let Some(console) = &mut settings.console
      && console.folder.is_relative()
    {
      console.folder = path.parent().unwrap_or(Path::new("")).join(&console.folder);
    }

    Ok(settings)
  }

  /// A file under the data root's `env/`.
  pub fn env_file(&self, name: &str) -> PathBuf {
    self.data_root.join("env").join(name)
  }

  /// The token a file under `env/` holds, trimmed; none where it holds none.
  pub fn token(&self, name: &str) -> Result<Option<String>, Unread> {
    let path = self.env_file(name);
    let text =
      std::fs::read_to_string(&path).map_err(|why| Unread(format!("{}: {why}", path.display())))?;
    let token = text.trim();

    Ok((!token.is_empty()).then(|| token.to_owned()))
  }

  /// The token a unit is called with, where it names a file.
  pub fn unit_token(&self, unit: &Unit) -> Result<Option<String>, Unread> {
    match &unit.token_file {
      Some(name) => self.token(name),
      None => Ok(None),
    }
  }
}
