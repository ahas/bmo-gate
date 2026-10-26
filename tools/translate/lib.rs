//! The translator's tool (`docs/api.md`, 「The tools a tool host places」): a call of `gate/translate` read from
//! what the tool host hands it, put to the gate's `POST /translations` with the address and token the record
//! carries, and the readings answered as a tool result.

use std::collections::BTreeMap;

use bmo_gate_client::{ClientFailure, GateClient, TranslationAsk};
use serde::Deserialize;
use serde_json::{Value, json};

/// The entry's full name.
pub const ENTRY: &str = "gate/translate";

/// The variable naming the gate's base address.
pub const ADDRESS: &str = "BMO_GATE_URL";

/// The variable holding the gate's token.
pub const TOKEN: &str = "BMO_GATE_TOKEN";

/// The variable naming a file that holds the gate's token.
pub const TOKEN_FILE: &str = "BMO_GATE_TOKEN_FILE";

/// What the tool host hands a call: the protocol, the kind with its fields, and the record it is made under. Every
/// field the tool does not read is passed over.
#[derive(Deserialize)]
struct Asked {
  protocol: u32,
  #[serde(flatten)]
  kind: Kind,
  #[serde(default)]
  session: Record,
}

/// The kinds the tool answers: a call alone, since it serves no resources and is no helper.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Kind {
  Call {
    entry: String,
    #[serde(default)]
    arguments: Value,
  },
}

/// The part of the session record the tool reads.
#[derive(Default, Deserialize)]
struct Record {
  #[serde(default)]
  variables: BTreeMap<String, String>,
}

/// The entry's arguments, as its input schema states them.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
  language: String,
  texts: Vec<String>,
}

/// The tool result answering one call handed as `asked`, where `environment` reads the call's own environment.
/// A request that does not read, of another protocol, kind or entry, is answered `Err` with why, for the
/// executable to end unclean on.
pub async fn answer(asked: &str, environment: impl Fn(&str) -> Option<String>) -> Result<Value, String> {
  let asked: Asked =
    serde_json::from_str(asked).map_err(|error| format!("the call does not read: {error}"))?;

  if asked.protocol != 1 {
    return Err(format!("the call speaks protocol {}, and this tool speaks 1", asked.protocol));
  }

  let Kind::Call { entry, arguments } = asked.kind;

  if entry != ENTRY {
    return Err(format!("the call names {entry}, and this tool answers {ENTRY} alone"));
  }

  let arguments: Arguments = match serde_json::from_value(arguments) {
    Ok(arguments) => arguments,
    Err(error) => return Ok(refusal(format!("The arguments do not read: {error}."))),
  };
  let variable = |name: &str| {
    asked
      .session
      .variables
      .get(name)
      .cloned()
      .or_else(|| environment(name))
      .filter(|value| !value.trim().is_empty())
  };

  let Some(address) = variable(ADDRESS) else {
    return Ok(refusal(format!("ERROR: the record names no gate address in {ADDRESS}.")));
  };
  let token = match (variable(TOKEN), variable(TOKEN_FILE)) {
    (Some(token), _) => token,
    (None, Some(file)) => match std::fs::read_to_string(&file) {
      Ok(token) if !token.trim().is_empty() => token.trim().to_owned(),
      Ok(_) => return Ok(refusal(format!("ERROR: the file {TOKEN_FILE} names holds no token."))),
      Err(error) => {
        return Ok(refusal(format!("ERROR: the file {TOKEN_FILE} names could not be read: {error}.")));
      }
    },
    (None, None) => {
      return Ok(refusal(format!("ERROR: the record names no gate token in {TOKEN} or {TOKEN_FILE}.")));
    }
  };

  let asked = TranslationAsk {
    language: arguments.language,
    originals: arguments.texts,
  };
  let translated = match GateClient::new(&address, token) {
    Ok(client) => client.translate(&asked).await,
    Err(failure) => Err(failure),
  };

  Ok(match translated {
    Ok(readings) => {
      let structured = serde_json::to_value(&readings).map_err(|error| error.to_string())?;

      json!({
        "content": [{ "type": "text", "text": structured.to_string() }],
        "isError": false,
        "structuredContent": structured,
      })
    }
    Err(ClientFailure::Answered {
      status,
      answer,
      body,
    }) => refusal(match answer {
      Some(answer) => {
        format!("The gate refused the translation with {status} {}: {}", answer.code, answer.error)
      }
      None => format!("The gate refused the translation with {status}: {}", body.trim()),
    }),
    Err(failure) => refusal(format!("ERROR: {failure}.")),
  })
}

/// A tool result the model reads as a refusal.
fn refusal(text: String) -> Value {
  json!({
    "content": [{ "type": "text", "text": text }],
    "isError": true,
  })
}
