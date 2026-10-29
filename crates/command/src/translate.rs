//! `bmo translate` (`docs/boundary-api.md`, 「The unit command」): the gate's translator asked for one text in
//! one language, at the service's own address and token, and the first reading printed.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use gate_server::settings::Settings;
use serde::{Deserialize, Serialize};

use crate::{Answered, Fault};

/// The longest the translator is waited on.
pub const WAIT: Duration = Duration::from_secs(180);

#[derive(clap::Args, Debug)]
pub struct TranslateArgs {
  /// The language the text is rendered in.
  #[arg(long, default_value = "ko")]
  pub language: String,
  /// The words; read from standard input where none are given.
  #[arg(long)]
  pub text: Option<String>,
}

#[derive(Serialize)]
struct Ask {
  language: String,
  originals: Vec<String>,
}

#[derive(Deserialize)]
struct AnsweredReadings {
  readings: Vec<Reading>,
}

#[derive(Deserialize)]
struct Reading {
  text: String,
}

/// One text translated into the language named.
pub async fn translate(path: &Path, args: TranslateArgs) -> Answered {
  let text = match args.text {
    Some(text) => text,
    None => {
      let mut read = String::new();

      std::io::stdin()
        .read_to_string(&mut read)
        .map_err(|why| Fault::failed(format!("the words could not be read from standard input: {why}")))?;
      read
    }
  };
  let settings =
    Settings::read(path).map_err(|why| Fault::failed(format!("the settings do not stand: {why}")))?;
  let token = settings
    .token(&settings.token_file)
    .map_err(|why| Fault::failed(format!("the service's token: {why}")))?
    .ok_or_else(|| Fault::failed(format!("{} holds no token", settings.token_file)))?;
  let url = format!("{}/translations", settings.address.trim_end_matches('/'));
  let client = reqwest::Client::builder()
    .timeout(WAIT)
    .build()
    .map_err(|why| Fault::failed(format!("no client: {why}")))?;
  let answer = client
    .post(&url)
    .bearer_auth(token)
    .json(&Ask {
      language: args.language,
      originals: vec![text],
    })
    .send()
    .await
    .map_err(|why| Fault::failed(format!("{url} does not answer: {why}")))?;

  if !answer.status().is_success() {
    let said = answer.text().await.unwrap_or_default();

    return Err(Fault::failed(format!("{url} answered with {said}")));
  }

  let read: AnsweredReadings = answer
    .json()
    .await
    .map_err(|why| Fault::failed(format!("{url} answered no readings: {why}")))?;

  Ok(vec![read.readings.into_iter().next().map(|one| one.text).unwrap_or_default()])
}
