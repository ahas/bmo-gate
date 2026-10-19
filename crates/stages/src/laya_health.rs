//! Laya's health, watched by the gate (`docs/laya.md`, 「The health watcher」): the relay's `GET /health` asked
//! with the token, the outcome kept as the gate's one `laya_health` row, and whether the state or the model moved,
//! which the gate tells its screens of.

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::time::{Duration, Instant};

use reqwest::StatusCode;
use sea_orm::{DatabaseConnection, DbErr, QueryResult};
use serde_json::Value;

use crate::laya::Side;
use crate::sql::{one, run};

// How long a check waits: the check is not a gate and has no row to read one from.
const HEALTH_WAIT: Duration = Duration::from_secs(2);

// The most an answer may weigh before it reads as a bad one.
const MOST_ANSWER_BYTES: usize = 256 * 1024;

/// The last check as its row keeps it. `up` is a server that answered, `off` a service with no address
/// set, which asks nothing, `unknown` a server nobody has checked yet, and every other word the
/// failure the last check met.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Health {
  pub state: String,
  pub model: Option<String>,
  pub device: Option<String>,
  pub vram_bytes: Option<i64>,
  pub load_ms: Option<i64>,
  pub versions: BTreeMap<String, String>,
  /// The address the check asked, so a screen can say which machine the server stands on.
  pub address: Option<String>,
  /// How long the last check took, in milliseconds.
  pub check_ms: Option<i64>,
  /// When the last check was made and when the server last answered one, in unix seconds.
  pub checked_at: Option<i64>,
  pub healthy_at: Option<i64>,
}

impl Health {
  /// Nothing known: no check made yet.
  pub fn unknown() -> Self {
    Self {
      state: "unknown".to_owned(),
      model: None,
      device: None,
      vram_bytes: None,
      load_ms: None,
      versions: BTreeMap::new(),
      address: None,
      check_ms: None,
      checked_at: None,
      healthy_at: None,
    }
  }
}

/// What the server said about itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Report {
  pub model: String,
  pub device: String,
  pub vram_bytes: Option<i64>,
  pub load_ms: Option<i64>,
  pub versions: BTreeMap<String, String>,
  pub ms: i64,
}

/// What one check came to: the server's report, or the state word of a check that met none.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
  Up(Report),
  Down(&'static str),
}

/// The new row out of the last one and a check's outcome. A failed check keeps what the server last
/// said about itself and when, so the screen can tell what went quiet and since when.
pub fn next_health(last: &Health, outcome: Outcome, at: i64, address: Option<String>) -> Health {
  match outcome {
    Outcome::Up(report) => Health {
      state: "up".to_owned(),
      model: Some(report.model),
      device: Some(report.device),
      vram_bytes: report.vram_bytes,
      load_ms: report.load_ms,
      versions: report.versions,
      address,
      check_ms: Some(report.ms),
      checked_at: Some(at),
      healthy_at: Some(at),
    },
    Outcome::Down(state) => Health {
      state: state.to_owned(),
      address,
      check_ms: None,
      checked_at: Some(at),
      ..last.clone()
    },
  }
}

/// The token, from a file that is exactly 0600 and not empty; anything else is no token, which the
/// server would turn away anyway. It is read at each check, so a token replaced needs no restart.
pub fn token(path: &Path) -> Option<String> {
  let private = |path: &Path| {
    std::fs::metadata(path)
      .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o777 == 0o600 && meta.len() > 0)
  };

  private(path)
    .then(|| std::fs::read_to_string(path).ok())
    .flatten()
    .map(|token| token.trim().to_owned())
    .filter(|token| !token.is_empty())
}

/// The server's own word for a question too large is not asked here, so a turning away below 500 is a
/// refusal; of the server errors, a 504 is a call held past its bound and a 503 a service unable to take
/// the call, which is as far from an answer as no connection.
pub fn failure_of(status: StatusCode) -> &'static str {
  match status.as_u16() {
    504 => "timeout",
    503 => "unreachable",
    500.. => "bad-answer",
    _ => "refused",
  }
}

fn whole_number(value: &Value) -> Option<i64> {
  // A float is kept to the nearest whole, as the column holds it.
  #[allow(clippy::cast_possible_truncation)]
  value.as_f64().filter(|number| number.is_finite()).map(|number| number.round() as i64)
}

/// What the server said about itself, where it answered up with its model and device.
pub fn report_of(body: &Value, ms: i64) -> Option<Report> {
  if body.get("state")?.as_str()? != "up" {
    return None;
  }

  let versions = body
    .get("versions")
    .and_then(Value::as_object)
    .map(|versions| {
      versions
        .iter()
        .filter_map(|(name, version)| Some((name.clone(), version.as_str()?.to_owned())))
        .collect()
    })
    .unwrap_or_default();

  Some(Report {
    model: body.get("model")?.as_str()?.to_owned(),
    device: body.get("device")?.as_str()?.to_owned(),
    vram_bytes: body.get("vramBytes").and_then(whole_number),
    load_ms: body.get("loadMs").and_then(whole_number),
    versions,
    ms,
  })
}

/// The server asked `GET /health` at the address, with the token where one stands.
pub async fn ask(address: &str, token: Option<&str>, wait: Duration) -> Outcome {
  let Some(token) = token else {
    return Outcome::Down("refused");
  };
  let lost =
    |error: reqwest::Error| Outcome::Down(if error.is_timeout() { "timeout" } else { "unreachable" });
  let started = Instant::now();
  let client = match reqwest::Client::builder().timeout(wait).build() {
    Ok(client) => client,
    Err(error) => return lost(error),
  };
  let answer = match client
    .get(format!("{address}/health"))
    .bearer_auth(token)
    .header(reqwest::header::CONTENT_TYPE, "application/json")
    .send()
    .await
  {
    Ok(answer) => answer,
    Err(error) => return lost(error),
  };
  let status = answer.status();
  let text = match answer.bytes().await {
    Ok(text) => text,
    Err(error) => return lost(error),
  };

  if !status.is_success() {
    return Outcome::Down(failure_of(status));
  }

  if text.len() > MOST_ANSWER_BYTES {
    return Outcome::Down("bad-answer");
  }

  let ms = i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);

  serde_json::from_slice::<Value>(&text)
    .ok()
    .and_then(|body| report_of(&body, ms))
    .map_or(Outcome::Down("bad-answer"), Outcome::Up)
}

fn read_row(row: &QueryResult) -> Result<Health, DbErr> {
  let versions: Option<String> = row.try_get("", "versions")?;

  Ok(Health {
    state: row.try_get("", "state")?,
    model: row.try_get("", "model")?,
    device: row.try_get("", "device")?,
    vram_bytes: row.try_get("", "vram_bytes")?,
    load_ms: row.try_get("", "load_ms")?,
    versions: versions.and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default(),
    address: row.try_get("", "address")?,
    check_ms: row.try_get("", "check_ms")?,
    checked_at: row.try_get("", "checked_at")?,
    healthy_at: row.try_get("", "healthy_at")?,
  })
}

/// The last check, or nothing known where none has been made.
pub async fn read(db: &DatabaseConnection) -> Result<Health, DbErr> {
  match one(db, r#"SELECT * FROM "laya_health" WHERE "id" = 1"#, vec![]).await? {
    Some(row) => read_row(&row),
    None => Ok(Health::unknown()),
  }
}

async fn write(db: &DatabaseConnection, health: &Health) -> Result<(), DbErr> {
  let versions = serde_json::to_string(&health.versions).unwrap_or_else(|_| "{}".to_owned());

  run(
    db,
    r#"INSERT INTO "laya_health" ("id", "state", "model", "device", "vram_bytes", "load_ms", "versions", "address", "check_ms", "checked_at", "healthy_at")
      VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT ("id") DO UPDATE SET "state" = excluded."state", "model" = excluded."model", "device" = excluded."device",
        "vram_bytes" = excluded."vram_bytes", "load_ms" = excluded."load_ms", "versions" = excluded."versions",
        "address" = excluded."address", "check_ms" = excluded."check_ms", "checked_at" = excluded."checked_at",
        "healthy_at" = excluded."healthy_at""#,
    vec![
      health.state.clone().into(),
      health.model.clone().into(),
      health.device.clone().into(),
      health.vram_bytes.into(),
      health.load_ms.into(),
      versions.into(),
      health.address.clone().into(),
      health.check_ms.into(),
      health.checked_at.into(),
      health.healthy_at.into(),
    ],
  )
  .await?;

  Ok(())
}

/// One check of the relay the side names, written to the row; whether the state or the model moved.
pub async fn pass(db: &DatabaseConnection, side: &Side, at: i64) -> Result<bool, DbErr> {
  let last = read(db).await?;
  let address = side.url().map(str::to_owned);
  let outcome = match &address {
    None => Outcome::Down("off"),
    Some(address) => ask(address, side.token().as_deref(), HEALTH_WAIT).await,
  };
  let health = next_health(&last, outcome, at, address);

  write(db, &health).await?;

  Ok(health.state != last.state || health.model != last.model)
}
