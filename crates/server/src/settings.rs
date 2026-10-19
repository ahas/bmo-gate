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

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Records {
  #[serde(default)]
  pub claude: Vec<PathBuf>,
  pub codex: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shipped {
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
  pub session_folder: String,
  pub owner_room: i64,
  pub agency: Unit,
  pub brain: Unit,
  pub receiver: Unit,
  pub job: Unit,
  pub arbiter: Option<Arbiter>,
  pub gateway: Gateway,
  pub laya: Option<Unit>,
  #[serde(default)]
  pub records: Records,
  pub shipped: Option<Shipped>,
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
  /// The settings a file holds.
  pub fn read(path: &Path) -> Result<Self, Unread> {
    let text = std::fs::read_to_string(path).map_err(|why| Unread(format!("{}: {why}", path.display())))?;

    toml::from_str(&text).map_err(|why| Unread(format!("{}: {why}", path.display())))
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
