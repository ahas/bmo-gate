//! The brain's index as the tool host places it (`docs/api.md`, 「The tools a tool host places」): a call of
//! `gate/reference_index`, `gate/reference_piece` or `gate/reference_search` read from what the tool host hands it,
//! put to the gate's reference routes with the address and token the record carries, for the turn's agent, room and
//! session the record names, and answered as a tool result. A call whose record names no agent is refused, so an
//! answer is only ever the calling agent's own brain's.

use std::collections::BTreeMap;

use bmo_gate_client::{
  ClientFailure, GateClient, ReferenceIndexQuery, ReferencePieceQuery, ReferenceSearchQuery,
};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// The entries' full names.
pub const INDEX: &str = "gate/reference_index";
pub const PIECE: &str = "gate/reference_piece";
pub const SEARCH: &str = "gate/reference_search";

/// The variables naming the gate and its token, and the turn's agent, room and session.
pub const ADDRESS: &str = "BMO_GATE_URL";
pub const TOKEN: &str = "BMO_GATE_TOKEN";
pub const TOKEN_FILE: &str = "BMO_GATE_TOKEN_FILE";
pub const AGENT: &str = "BMO_TURN_AGENT";
pub const ROOM: &str = "BMO_TURN_CHAT";
pub const SESSION: &str = "BMO_TURN_SESSION";

#[derive(Deserialize)]
struct Asked {
  protocol: u32,
  #[serde(flatten)]
  kind: Kind,
  #[serde(default)]
  session: Record,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Kind {
  Call {
    entry: String,
    #[serde(default)]
    arguments: Value,
  },
}

#[derive(Default, Deserialize)]
struct Record {
  #[serde(default)]
  variables: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IndexArguments {
  #[serde(default)]
  room: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PieceArguments {
  slug: String,
  group: String,
  #[serde(default)]
  room: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SearchArguments {
  query: String,
  #[serde(default)]
  room: Option<i64>,
  #[serde(default)]
  limit: Option<u32>,
}

fn arguments<T: DeserializeOwned>(arguments: Value) -> Result<T, Value> {
  serde_json::from_value(if arguments.is_null() { json!({}) } else { arguments })
    .map_err(|error| refusal(format!("The arguments do not read: {error}.")))
}

/// The tool result answering one call handed as `asked`, where `environment` reads the call's own environment. A
/// request that does not read, of another protocol, kind or entry, is answered `Err` with why.
pub async fn answer(asked: &str, environment: impl Fn(&str) -> Option<String>) -> Result<Value, String> {
  let asked: Asked =
    serde_json::from_str(asked).map_err(|error| format!("the call does not read: {error}"))?;

  if asked.protocol != 1 {
    return Err(format!("the call speaks protocol {}, and this tool speaks 1", asked.protocol));
  }

  let Kind::Call {
    entry,
    arguments: given,
  } = asked.kind;

  if ![INDEX, PIECE, SEARCH].contains(&entry.as_str()) {
    return Err(format!("the call names {entry}, and this tool answers {INDEX}, {PIECE} and {SEARCH}"));
  }

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
  let Some(agent) = variable(AGENT) else {
    return Ok(refusal(format!(
      "The record names no agent in {AGENT}, and the brain's index is read only for the agent whose turn it is."
    )));
  };
  let session = variable(SESSION);
  let room_of =
    |named: Option<i64>| named.or_else(|| variable(ROOM).and_then(|room| room.trim().parse().ok()));
  let client = match GateClient::new(&address, token) {
    Ok(client) => client,
    Err(failure) => return Ok(refusal(format!("ERROR: {failure}."))),
  };
  let no_room = || refusal(format!("The call names no room, and the record names none in {ROOM}."));

  let answered: Result<Value, ClientFailure> = match entry.as_str() {
    INDEX => {
      let given: IndexArguments = match arguments(given) {
        Ok(given) => given,
        Err(refused) => return Ok(refused),
      };
      let Some(room) = room_of(given.room) else { return Ok(no_room()) };

      client
        .reference_index(&ReferenceIndexQuery {
          room,
          session,
          agent,
          audience: None,
        })
        .await
        .map(|index| serde_json::to_value(index).unwrap_or_default())
    }
    PIECE => {
      let given: PieceArguments = match arguments(given) {
        Ok(given) => given,
        Err(refused) => return Ok(refused),
      };
      let Some(room) = room_of(given.room) else { return Ok(no_room()) };

      client
        .reference_piece(
          &given.slug,
          &ReferencePieceQuery {
            room,
            group: given.group,
            session,
            agent,
            audience: None,
          },
        )
        .await
        .map(|piece| serde_json::to_value(piece).unwrap_or_default())
    }
    _ => {
      let given: SearchArguments = match arguments(given) {
        Ok(given) => given,
        Err(refused) => return Ok(refused),
      };
      let Some(room) = room_of(given.room) else { return Ok(no_room()) };

      client
        .reference_search(&ReferenceSearchQuery {
          q: given.query,
          room,
          limit: given.limit,
          agent,
          audience: None,
        })
        .await
        .map(|found| serde_json::to_value(found).unwrap_or_default())
    }
  };

  Ok(match answered {
    Ok(structured) => json!({
      "content": [{ "type": "text", "text": structured.to_string() }],
      "isError": false,
      "structuredContent": structured,
    }),
    Err(ClientFailure::Answered {
      status,
      answer,
      body,
    }) => refusal(match answer {
      Some(answer) => format!("The gate refused the call with {status} {}: {}", answer.code, answer.error),
      None => format!("The gate refused the call with {status}: {}", body.trim()),
    }),
    Err(failure) => refusal(format!("ERROR: {failure}.")),
  })
}

fn refusal(text: String) -> Value {
  json!({
    "content": [{ "type": "text", "text": text }],
    "isError": true,
  })
}
