//! `reference narrowing` (docs/reference-selection.md, 「The narrowing」): the turns the chat agent really answered —
//! the messages the reference gates left verdicts on, each read through the receiver — put through the narrowing a
//! turn goes through before any gate is asked, against the fragment table as it stands now, and what each gate
//! would be asked about counted. No model is asked and nothing is written.

use std::collections::HashSet;

use gate_markup::text::count_text;
use gate_policy::fill_marks;
use gate_reference::Reference;
use gate_reference::pick;
use gate_reference::road::{self, Turn};
use gate_stages::laya::QUESTIONS_PER_CALL;
use gate_stages::sql::all;
use gate_words::reference_benches as words;
use serde::Serialize;

use super::{count, db, message_line, misread, road_of, stored_message};
use crate::{Answered, Fault};

// How many of a room's latest answered turns are measured where the caller names no number.
const TURNS: usize = 20;

#[derive(clap::Args, Debug)]
pub struct NarrowingArgs {
  /// Another database's address.
  #[arg(long, allow_hyphen_values = true)]
  db: Option<String>,
  /// One room alone.
  #[arg(long, allow_hyphen_values = true)]
  chat: Option<String>,
  /// How many of each room's latest answered turns.
  #[arg(long, allow_hyphen_values = true)]
  turns: Option<String>,
  #[arg(long)]
  json: bool,
  #[arg(short = 'h', long)]
  help: bool,
}

/// What the narrowing left one gate on one turn.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measured {
  pub chat_id: i64,
  pub message_id: i64,
  pub stage: String,
  pub held: i64,
  pub asked: usize,
  pub kept: Kept,
  pub capped: i64,
}

/// How many candidates each rule kept.
#[derive(Clone, Copy, Debug, Serialize)]
pub struct Kept {
  pub item: i64,
  pub keyword: i64,
  pub word: i64,
  pub person: i64,
  pub recent: i64,
}

impl Kept {
  pub fn of(kept: &gate_reference::fragments::Kept) -> Self {
    Self {
      item: kept.item,
      keyword: kept.keyword,
      word: kept.word,
      person: kept.person,
      recent: kept.recent,
    }
  }
}

pub async fn run(args: NarrowingArgs) -> Answered {
  let usage = words::USAGE_NARROWING;

  if args.help {
    return Ok(vec![usage.to_owned()]);
  }

  let chat = match args.chat.as_deref().map(str::parse::<i64>) {
    None => None,
    Some(Ok(chat)) => Some(chat),
    Some(Err(_)) => return Err(misread(usage)),
  };
  let turns = count(args.turns.as_deref(), TURNS, usage)?;
  let (_, reference) = road_of(args.db.as_deref()).await?;

  narrowing(&reference, chat, turns, args.json).await
}

fn database(why: sea_orm::DbErr) -> Fault {
  Fault::failed(format!("the gate's database: {why}"))
}

/// The narrowing measured over each room's latest answered turns — one room's where one is named — as lines, or as
/// JSON.
pub async fn narrowing(reference: &Reference, chat: Option<i64>, turns: usize, json: bool) -> Answered {
  let rooms: Vec<i64> = match chat {
    Some(chat) => vec![chat],
    None => all(
      db(reference),
      r#"SELECT DISTINCT "chat_id" FROM "reference_verdicts" ORDER BY "chat_id""#,
      vec![],
    )
    .await
    .map_err(database)?
    .iter()
    .filter_map(|row| row.try_get::<i64>("", "chat_id").ok())
    .collect(),
  };
  let mut measured: Vec<Measured> = vec![];
  let mut gone = 0;

  for &chat_id in &rooms {
    let (of_room, missing) = room(reference, chat_id, turns).await?;

    measured.extend(of_room);
    gone += missing;
  }

  if gone > 0 {
    eprintln!("{}", fill_marks(words::MESSAGES_GONE, &[("count", &count_text(gone))]));
  }

  if json {
    return Ok(vec![serde_json::to_string_pretty(&measured).unwrap_or_default()]);
  }

  Ok(lines(&rooms, &measured))
}

// The room's latest answered turns, each through the narrowing of every gate, and how many of them the receiver
// keeps no message for.
async fn room(reference: &Reference, chat_id: i64, turns: usize) -> Result<(Vec<Measured>, usize), Fault> {
  let answered = all(
    db(reference),
    r#"SELECT "message_id" FROM "reference_verdicts"
        WHERE "chat_id" = $1 AND "message_id" IS NOT NULL
        GROUP BY "message_id" ORDER BY MAX("id") DESC LIMIT $2"#,
    vec![chat_id.into(), (turns as i64).into()],
  )
  .await
  .map_err(database)?;
  let gates = road::gates_of(reference, chat_id, reference.chat_agent(), true)
    .await
    .map_err(|why| Fault::failed(why.to_string()))?;
  let mut measured = vec![];
  let mut missing = 0;

  for row in &answered {
    let message_id: i64 = row.try_get("", "message_id").map_err(database)?;
    let Some(message) = stored_message(reference, chat_id, message_id).await? else {
      missing += 1;
      continue;
    };
    let turn = Turn {
      chat_id,
      message_lines: vec![message_line(&message)],
      message_id: Some(message_id),
      speaker_ids: message.sender.into_iter().collect(),
      situation: None,
      holds: None,
      round: None,
      people_spoke: true,
      answered: None,
      off: vec![],
      lore: true,
      records: false,
    };

    for gate in &gates {
      let narrowing = road::narrowing(reference, &turn, gate, &HashSet::new()).await;
      let narrowed = &narrowing.narrowed;

      measured.push(Measured {
        chat_id,
        message_id,
        stage: gate.stage.clone(),
        held: narrowed.held,
        asked: pick::candidates(&narrowing.libraries).len(),
        kept: Kept::of(&narrowed.kept),
        capped: narrowed.capped,
      });
    }
  }

  Ok((measured, missing))
}

/// The measurements as lines: per room its turns, and per gate how many the libraries held, how many it would be
/// asked about, what each rule kept, and on how many turns it would be asked in more than one Laya call.
pub fn lines(rooms: &[i64], measured: &[Measured]) -> Vec<String> {
  let mut lines = vec![];

  for &chat_id in rooms {
    let of_room: Vec<&Measured> = measured.iter().filter(|one| one.chat_id == chat_id).collect();
    let turns: HashSet<i64> = of_room.iter().map(|one| one.message_id).collect();

    if turns.is_empty() {
      continue;
    }

    lines.push(format!("chat {chat_id} \u{b7} {} turns", turns.len()));

    let mut stages: Vec<&str> = vec![];

    for one in &of_room {
      if !stages.contains(&one.stage.as_str()) {
        stages.push(&one.stage);
      }
    }

    for stage in stages {
      let of_stage: Vec<&&Measured> = of_room.iter().filter(|one| one.stage == stage).collect();
      let mut asked: Vec<usize> = of_stage.iter().map(|one| one.asked).collect();

      asked.sort_unstable();

      let held = of_stage.iter().map(|one| one.held).max().unwrap_or_default();
      let over = of_stage.iter().filter(|one| one.asked > QUESTIONS_PER_CALL).count();
      let sum = |kept: fn(&Kept) -> i64| of_stage.iter().map(|one| kept(&one.kept)).sum::<i64>();

      lines.push(format!(
        "  {stage}: held {held} \u{b7} asked {}~{} (middle {}) \u{b7} kept by item {}, keyword {}, word {}, person {}, recent {} \u{b7} capped {} \u{b7} asked in more than one Laya call on {over} turns",
        asked[0],
        asked[asked.len() - 1],
        asked[asked.len() / 2],
        sum(|kept| kept.item),
        sum(|kept| kept.keyword),
        sum(|kept| kept.word),
        sum(|kept| kept.person),
        sum(|kept| kept.recent),
        of_stage.iter().map(|one| one.capped).sum::<i64>(),
      ));
    }
  }

  lines
}
