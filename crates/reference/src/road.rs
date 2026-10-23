//! The road a turn's reference is composed on (`docs/reference-selection.md`): the room's due memories and the head
//! of the sheet of everyone who spoke, as the brain renders it from their facts, which no model chooses; each
//! picker's libraries, less what the round already holds and narrowed by the code, with what each was offered
//! written down; the three reference gates, the person-book search, the memory picker and the situation-rule
//! matcher asked side by side; each gate's picks held to its allowance and all of them to the turn's total; and
//! what the turn attached handed to the brain to count.

use std::collections::{HashMap, HashSet};
use std::sync::LazyLock;

use futures_util::future::{join_all, try_join_all};
use gate_markup::js;
use gate_policy::laya::QUESTIONS;
use gate_policy::prompts;
use gate_policy::reference::{BotLinesAlone, REFERENCE, ReferenceGate};
use gate_ports::brain::MemoryRow;
use gate_runs::GateError;
use gate_runs::records::{self, Judgement, now};
use regex::Regex;

use crate::fragments::{self, Fragment, Offer, Verdict};
use crate::narrow::{self, KeptBy};
use crate::pick::{self, Body, Library, Picked, Picker, Reads, ReferenceProbe};
use crate::{Entry, Reference, SituationTurn, Source, memories, situation};

// Where a situation rule stands when the turn is over its total: above every other kind.
const SITUATION_HOLD: u8 = 4;

/// The kinds the system-documents gate offers: the shipped reference documents, and the lore of the agent's
/// brain.
pub const SYSTEM_DOCUMENT: &str = "system-document";
pub const LORE: &str = "lore";

/// The brain's kinds the other gates offer.
pub const ROOM_RULE: &str = "room-rule";
pub const KNOWLEDGE: &str = "library-knowledge";
pub const PERSON_BOOK: &str = "person-book";

/// What a turn is handed to compose its reference by: the room, its lines, the message it is about, who spoke, the
/// situation road where the turn has one, what the round already holds where it is inside one and the round's name,
/// whether anybody's words came in, the line of the message it follows on from, the gates the turn's agent has
/// switched off, whether the room reads the lore, and whether the road writes down what its pickers were offered and
/// judged and what the turn attached — a replay of a stored turn, which carries no situation road, writes none of
/// it.
pub struct Turn {
  pub chat_id: i64,
  pub message_lines: Vec<String>,
  pub message_id: Option<i64>,
  pub speaker_ids: Vec<i64>,
  pub situation: Option<SituationTurn>,
  pub holds: Option<HashSet<String>>,
  pub round: Option<String>,
  pub people_spoke: bool,
  pub answered: Option<String>,
  pub off: Vec<String>,
  pub lore: bool,
  pub records: bool,
}

impl Turn {
  /// The agent whose turn it is: the situation road's, the chat agent's where the turn carries none.
  pub fn agent<'a>(&'a self, reference: &'a Reference) -> &'a str {
    self
      .situation
      .as_ref()
      .map_or(reference.chat_agent(), |situation| situation.agent.as_str())
  }
}

fn fault(why: impl std::fmt::Display) -> GateError {
  GateError::Fault(why.to_string())
}

async fn library(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  kind: &str,
  index_path: String,
  source: Source,
  body: Body,
) -> Result<Option<Library>, GateError> {
  let rows = fragments::rows(reference, agent, chat_id, kind).await.map_err(fault)?;

  Ok(Library::of(index_path, rows, source, body))
}

// The system's own reference documents, and in a room that reads it the lore of the agent's brain, one library a
// section of its table of contents, in the order the brain gives them.
async fn system_libraries(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
  lore: bool,
) -> Result<Vec<Library>, GateError> {
  let shipped = library(
    reference,
    agent,
    chat_id,
    SYSTEM_DOCUMENT,
    "docs/reference-index.md".to_owned(),
    Source::Document,
    Body::Shipped,
  );
  let lore_rows = async {
    if !lore {
      return Ok(vec![]);
    }

    fragments::rows(reference, agent, chat_id, LORE).await.map_err(fault)
  };
  let (shipped, rows) = tokio::try_join!(shipped, lore_rows)?;
  let mut libraries: Vec<Library> = shipped.into_iter().collect();
  let mut sections: Vec<(String, Vec<Fragment>)> = vec![];

  for row in rows {
    let section = row.section.clone().unwrap_or_else(|| LORE.to_owned());

    match sections.iter_mut().find(|(name, _)| *name == section) {
      Some((_, rows)) => rows.push(row),
      None => sections.push((section, vec![row])),
    }
  }

  for (section, rows) in sections {
    libraries.extend(Library::of(section, rows, Source::Document, Body::Lore));
  }

  Ok(libraries)
}

async fn room_rule_libraries(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
) -> Result<Vec<Library>, GateError> {
  let index = format!("rooms/{chat_id}/rules/index.md");

  Ok(
    library(reference, agent, chat_id, ROOM_RULE, index, Source::Rule, Body::Knowledge)
      .await?
      .into_iter()
      .collect(),
  )
}

async fn knowledge_libraries(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
) -> Result<Vec<Library>, GateError> {
  Ok(
    library(
      reference,
      agent,
      chat_id,
      KNOWLEDGE,
      "knowledge/index.md".to_owned(),
      Source::Knowledge,
      Body::Knowledge,
    )
    .await?
    .into_iter()
    .collect(),
  )
}

// The person book a room's search reads: one candidate for each person the brain knows facts of, as the brain
// offers them, in one library.
async fn people_libraries(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
) -> Result<Vec<Library>, GateError> {
  let rows = fragments::rows(reference, agent, chat_id, PERSON_BOOK).await.map_err(fault)?;

  Ok(
    Library::of(format!("rooms/{chat_id}/people/index.md"), rows, Source::Person, Body::People)
      .into_iter()
      .collect(),
  )
}

/// A person's sheet held to the reference's ceiling for one: its lines from the top, the most important first, as
/// many as fit; empty where not even the first does.
pub fn held_sheet(text: &str) -> String {
  let ceiling = REFERENCE.sheet_chars;
  let mut kept: Vec<&str> = vec![];
  let mut used = 0;

  for line in js::trim(text).split('\n') {
    let cost = js::units(line) + usize::from(!kept.is_empty());

    if used + cost > ceiling {
      break;
    }

    used += cost;
    kept.push(line);
  }

  kept.join("\n")
}

/// The head of the standing sheet of everyone who spoke this turn: the first lines of each one's sheet in the room
/// as the brain renders it from their facts, as many as the policy names, held to its ceiling. An agent keeping no
/// long-term memory is given none.
pub async fn standing_entries(
  reference: &Reference,
  chat_id: i64,
  speakers: &[i64],
  agent: &str,
) -> Vec<Entry> {
  let mut seen = HashSet::new();
  let senders: Vec<i64> = speakers.iter().copied().filter(|id| seen.insert(*id)).collect();

  if senders.is_empty() {
    return vec![];
  }

  match reference.brain.sheets(agent, chat_id, &senders, Some(REFERENCE.sheet_lines)).await {
    Ok(sheets) => sheets
      .into_iter()
      .map(|sheet| Entry {
        path: sheet.path,
        text: held_sheet(&sheet.text),
        source: Source::Person,
        fragment: None,
      })
      .filter(|entry| !entry.text.is_empty())
      .collect(),
    Err(why) => {
      eprintln!("reference: chat {chat_id} sheets could not be read: {why}");
      vec![]
    }
  }
}

// The libraries less every piece the round already holds.
fn unheld(libraries: &[Library], holds: &HashSet<String>) -> Vec<Library> {
  if holds.is_empty() {
    return libraries.to_vec();
  }

  libraries
    .iter()
    .filter_map(|library| library.with(|row| !holds.contains(&row.path)))
    .collect()
}

// Whether a gate is asked on a turn, as it declares: always where anybody spoke, and on a turn of the bot's own
// lines alone only where they open it and the gate does not say never.
fn asks(bot_lines_alone: BotLinesAlone, people_spoke: bool, in_round: bool) -> bool {
  people_spoke || (bot_lines_alone != BotLinesAlone::Never && !in_round)
}

// The rules a gate narrows a turn by: all of them, or the item rule alone on a turn of the bot's own lines
// where the gate declares so.
fn rules_of(bot_lines_alone: BotLinesAlone, people_spoke: bool) -> Option<Vec<KeptBy>> {
  (!people_spoke && bot_lines_alone == BotLinesAlone::OwnTurnNamedItems).then(|| vec![KeptBy::Item])
}

// The line on what the gates attach together: within its total the turn keeps everything; over it, the kind
// held least goes first, and within one kind the largest piece, the path breaking a tie.
fn within_turn_budget(chat_id: i64, streams: Vec<(Vec<Entry>, u8)>) -> Vec<Entry> {
  let budget = REFERENCE.turn_budget_chars;
  let taken: Vec<(Entry, u8)> = streams
    .into_iter()
    .flat_map(|(entries, hold)| entries.into_iter().map(move |entry| (entry, hold)))
    .collect();
  let mut total: usize = taken.iter().map(|(entry, _)| js::units(&entry.text)).sum();

  if total <= budget {
    return taken.into_iter().map(|(entry, _)| entry).collect();
  }

  let mut order: Vec<usize> = (0..taken.len()).collect();

  order.sort_by(|left, right| {
    let (left, right) = (&taken[*left], &taken[*right]);

    left
      .1
      .cmp(&right.1)
      .then(js::units(&right.0.text).cmp(&js::units(&left.0.text)))
      .then(left.0.path.cmp(&right.0.path))
  });

  let mut dropped = HashSet::new();

  for at in order {
    if total <= budget {
      break;
    }

    let entry = &taken[at].0;

    dropped.insert(at);
    total -= js::units(&entry.text);
    eprintln!(
      "reference: chat {chat_id} passes over {} at {} characters — the turn is over the {budget} its gates may attach",
      entry.path,
      js::units(&entry.text)
    );
  }

  taken
    .into_iter()
    .enumerate()
    .filter(|(at, _)| !dropped.contains(at))
    .map(|(_, (entry, _))| entry)
    .collect()
}

/// The line a turn's message is handed to the pickers as.
pub fn message_line(sender_name: &str, sender_id: Option<i64>, text: &str) -> String {
  format!(
    "{sender_name} (id {}): {text}",
    sender_id.map_or_else(|| "unknown".to_owned(), |id| id.to_string())
  )
}

// The words a quiet instruction's line opens on.
const INSTRUCTION_HEAD: &str = "quiet instruction from the bot: ";

/// A quiet instruction as one of the turn's lines.
pub fn instruction_line(text: &str) -> String {
  format!("{INSTRUCTION_HEAD}{text}")
}

static MESSAGE_HEAD: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r"^[^\n]*?\(id [^)\n]*\): ").expect("a message line's head"));

/// What a turn's line said: its text, without the head that names its sender or opens a quiet instruction.
pub fn spoken(line: &str) -> &str {
  if let Some(said) = line.strip_prefix(INSTRUCTION_HEAD) {
    return said;
  }

  MESSAGE_HEAD.find(line).map_or(line, |head| &line[head.end()..])
}

/// One picker of a room for one agent's turn: its key, its libraries before any turn narrows them, how a turn of
/// the bot's own lines asks it, whether it reads the message a turn follows on from, whether a piece about a person
/// who spoke is offered for that alone, its instructions and the answer file its request closes on, how its answer
/// is read, the most slugs and characters it takes, where its picks stand when the turn is over its total, and the
/// probe Laya asks it through.
pub struct Gate {
  pub stage: String,
  pub libraries: Vec<Library>,
  pub bot_lines_alone: BotLinesAlone,
  pub reads_answered: bool,
  pub speakers_keep: bool,
  pub system: String,
  pub answer: String,
  pub reads: Reads,
  pub cap: Option<usize>,
  pub budget: usize,
  pub hold: u8,
  pub probe: ReferenceProbe,
}

impl Gate {
  /// Whether a turn asks this gate, as it declares; a turn inside a round asks it on the bot's own lines never.
  pub fn asks(&self, turn: &Turn, in_round: bool) -> bool {
    asks(self.bot_lines_alone, turn.people_spoke, in_round)
  }

  /// The turn's lines as this gate reads them: behind the message the turn follows on from where it reads that.
  pub fn lines(&self, turn: &Turn) -> Vec<String> {
    match (&turn.answered, self.reads_answered) {
      (Some(answered), true) => {
        std::iter::once(answered.clone()).chain(turn.message_lines.iter().cloned()).collect()
      }
      _ => turn.message_lines.clone(),
    }
  }
}

// One of the three reference gates of a room for one agent's turn, as it is declared.
async fn reference_gate(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
  lore: bool,
  declared: &ReferenceGate,
) -> Result<Gate, GateError> {
  let libraries = match declared.stage.as_str() {
    "system-documents" => system_libraries(reference, chat_id, agent, lore).await,
    "room-rules" => room_rule_libraries(reference, chat_id, agent).await,
    KNOWLEDGE_GATE => knowledge_libraries(reference, chat_id, agent).await,
    other => return Err(GateError::Fault(format!("no reference gate named {other}"))),
  }?;

  Ok(Gate {
    stage: declared.stage.clone(),
    libraries,
    bot_lines_alone: declared.bot_lines_alone,
    reads_answered: declared.reads_answered,
    speakers_keep: declared.speakers_keep,
    system: instructions(&declared.stage)?,
    answer: answer_file(&declared.stage),
    reads: Reads::Verdicts,
    cap: None,
    budget: declared.budget,
    hold: declared.hold,
    probe: probe(&declared.stage)?,
  })
}

// A gate's instructions, as its prompts write them.
fn instructions(stage: &str) -> Result<String, GateError> {
  prompts::instructions(stage)
    .map(str::to_owned)
    .ok_or_else(|| GateError::Fault(format!("{stage}: its instructions are not among the prompts")))
}

// The answer file a gate's request closes on, as its prompts write it; nothing where it has none.
fn answer_file(stage: &str) -> String {
  prompts::answer(stage).map(str::to_owned).unwrap_or_default()
}

// The probe Laya asks a gate's candidates through: its own question, and the word a candidate is named by.
fn probe(stage: &str) -> Result<ReferenceProbe, GateError> {
  let asked = QUESTIONS
    .of(stage)
    .ok_or_else(|| GateError::Fault(format!("{stage} has no Laya question")))?;

  Ok(ReferenceProbe {
    question: asked.question.clone(),
    subject: asked.subject.clone(),
  })
}

// The gate the knowledge a piece of work beyond a turn is handed is picked by.
const KNOWLEDGE_GATE: &str = "library-knowledge";

/// Every picker of a room for one agent's turn: the three reference gates in their order, then the person-book
/// search, their libraries read at once.
pub async fn gates_of(
  reference: &Reference,
  chat_id: i64,
  agent: &str,
  lore: bool,
) -> Result<Vec<Gate>, GateError> {
  let declared = try_join_all(
    REFERENCE
      .gates
      .iter()
      .map(|declared| reference_gate(reference, chat_id, agent, lore, declared)),
  );
  let (mut gates, people_libraries) =
    tokio::try_join!(declared, people_libraries(reference, chat_id, agent))?;
  let people = &REFERENCE.people;
  let cap = people.cap.to_string();
  let system = prompts::render(&instructions(&people.stage)?, &[("selectionCap", &cap)]);
  let answer = prompts::render(&answer_file(&people.stage), &[("selectionCap", &cap)]);

  gates.push(Gate {
    stage: people.stage.clone(),
    libraries: people_libraries,
    bot_lines_alone: people.bot_lines_alone,
    reads_answered: people.reads_answered,
    speakers_keep: people.speakers_keep,
    system,
    answer,
    reads: Reads::Named,
    cap: Some(people.cap),
    budget: people.budget,
    hold: 0,
    probe: probe(&people.stage)?,
  });

  Ok(gates)
}

// The names the receiver knows each owner of these rows by.
async fn owner_names(reference: &Reference, rows: &[Fragment]) -> HashMap<i64, Vec<String>> {
  let owners: Vec<i64> =
    rows.iter().filter_map(|row| row.owner).collect::<HashSet<_>>().into_iter().collect();

  if owners.is_empty() {
    return HashMap::new();
  }

  match reference.receiver.names(&owners).await {
    Ok(names) => names.into_iter().map(|name| (name.person, name.name.into_iter().collect())).collect(),
    Err(why) => {
      eprintln!("reference: the names of the rows' people could not be read: {why}");
      HashMap::new()
    }
  }
}

/// What the narrowing leaves one gate for a turn: its libraries holding only the rows it kept, how it came to them,
/// and the rules a row could be kept by where fewer than all of them could.
pub struct Narrowing {
  pub libraries: Vec<Library>,
  pub narrowed: narrow::Narrowed,
  pub rules: Option<Vec<KeptBy>>,
}

// What a turn hands the narrowing beside its text: what its lines said, who spoke as far as the gate counts them,
// what the gate attached in the room a moment ago, and the rules a row may be kept by.
struct Read<'a> {
  lines: &'a [String],
  speakers: Vec<i64>,
  attached: HashMap<String, i64>,
  rules: Option<Vec<KeptBy>>,
}

// What some lines said, one to a line, their heads left off.
fn said_in(lines: &[String]) -> String {
  lines.iter().map(|line| spoken(line)).collect::<Vec<_>>().join("\n")
}

// Some libraries as the narrowing leaves them for what a turn's own lines said and what the turn hands it beside.
async fn narrowed(reference: &Reference, libraries: &[Library], text: String, read: Read<'_>) -> Narrowing {
  let rows: Vec<Fragment> = libraries.iter().flat_map(|library| library.rows.iter().cloned()).collect();
  let rules = read.rules;
  let narrowed = narrow::narrow(
    &rows,
    &narrow::Turn {
      text,
      said: said_in(read.lines),
      speakers: read.speakers,
      names: owner_names(reference, &rows).await,
      recent_since: Some(narrow::recent_since_of(now())),
      attached: read.attached,
      rules: rules.clone(),
    },
  );
  let kept: HashSet<i64> = narrowed.rows.iter().map(|row| row.id).collect();

  Narrowing {
    libraries: libraries
      .iter()
      .filter_map(|library| library.with(|row| kept.contains(&row.id)))
      .collect(),
    narrowed,
    rules,
  }
}

/// A gate's libraries, less what the round already holds, as the narrowing leaves them for a turn — its words read in
/// the lines the gate reads, its speakers where the gate counts them, and what the gate attached in the room a moment
/// ago — by the rules the turn asks it by; nothing of it written down.
pub async fn narrowing(
  reference: &Reference,
  turn: &Turn,
  gate: &Gate,
  holds: &HashSet<String>,
) -> Narrowing {
  let since = now() - narrow::RECENT_MS;
  let attached =
    match fragments::attached_since(&reference.stages.runs.db, &gate.stage, turn.chat_id, since).await {
      Ok(attached) => attached,
      Err(why) => {
        eprintln!("reference: what {} attached a moment ago could not be read: {why}", gate.stage);
        HashMap::new()
      }
    };
  let lines = gate.lines(turn);

  narrowed(
    reference,
    &unheld(&gate.libraries, holds),
    said_in(&turn.message_lines),
    Read {
      lines: &lines,
      speakers: if gate.speakers_keep { turn.speaker_ids.clone() } else { vec![] },
      attached,
      rules: rules_of(gate.bot_lines_alone, turn.people_spoke),
    },
  )
  .await
}

// A gate's libraries as the narrowing leaves them, with what it was offered written down where the turn records.
async fn offered_to(
  reference: &Reference,
  turn: &Turn,
  gate: &Gate,
  holds: &HashSet<String>,
) -> Vec<Library> {
  let Narrowing {
    libraries,
    narrowed,
    rules,
  } = narrowing(reference, turn, gate, holds).await;
  let slugs: Vec<String> =
    pick::candidates(&libraries).into_iter().map(|candidate| candidate.slug).collect();

  println!(
    "reference: chat {} {} asked about {} of {} candidates",
    turn.chat_id,
    gate.stage,
    slugs.len(),
    narrowed.held
  );

  if !turn.records {
    return libraries;
  }

  let rule_words: Option<Vec<&str>> = rules.map(|rules| rules.iter().map(|rule| rule.word()).collect());
  let written = fragments::record_offer(
    &reference.stages.runs.db,
    &Offer {
      stage: &gate.stage,
      chat_id: turn.chat_id,
      message_id: turn.message_id,
      held: narrowed.held,
      kept: narrowed.kept,
      capped: narrowed.capped,
      slugs: &slugs,
      round: turn.round.as_deref(),
      rules: rule_words.as_deref(),
    },
  )
  .await;

  if let Err(why) = written {
    eprintln!("reference: what {} was offered could not be recorded: {why}", gate.stage);
  }

  libraries
}

// What a gate is asked about on a turn: nothing where the turn does not ask it or its agent switched it off;
// otherwise its narrowed libraries, a gate left none saying so.
async fn offered(
  reference: &Reference,
  turn: &Turn,
  gate: &Gate,
  holds: &HashSet<String>,
  in_round: bool,
  on: bool,
) -> Vec<Library> {
  if !gate.asks(turn, in_round) || !on {
    return vec![];
  }

  let narrowed = offered_to(reference, turn, gate, holds).await;

  if pick::candidates(&narrowed).is_empty() {
    if turn.records {
      no_candidates(reference, turn.chat_id, turn.message_id, turn.round.as_deref(), &gate.stage).await;
    }

    return vec![];
  }

  narrowed
}

// One gate as the picker for this turn, writing down what it judged where the turn records.
fn picker(turn: &Turn, agent: &str, gate: &Gate, libraries: Vec<Library>) -> Picker {
  Picker {
    chat_id: turn.chat_id,
    message_id: turn.message_id,
    agent: agent.to_owned(),
    round: turn.round.clone(),
    stage: gate.stage.clone(),
    system: gate.system.clone(),
    answer: gate.answer.clone(),
    libraries,
    message_lines: gate.lines(turn),
    reads: gate.reads,
    cap: gate.cap,
    budget: Some(gate.budget),
    probe: gate.probe.clone(),
    records: turn.records,
  }
}

/// What a gate on for the turn leaves where nothing was left to ask it about.
pub async fn no_candidates(
  reference: &Reference,
  chat_id: i64,
  message_id: Option<i64>,
  round: Option<&str>,
  stage: &str,
) {
  let decided = &REFERENCE.decided;

  records::judgement(
    &reference.stages.runs.db,
    &Judgement {
      chat_id,
      message_id,
      stage,
      verdict: &decided.no_candidates,
      detail: Some(&decided.no_candidates_detail),
      ms: None,
      round,
    },
  )
  .await;
}

/// What this turn's prompt is given to read: the room's due memories with those the memory picker picks, the
/// standing sheets of everyone who spoke, what the three reference gates and the matcher pick held to the turn's
/// total, then what the person book's search picks; what it attached counted on the rows and beside each
/// candidate's verdict where the turn records. A stop is raised; anything else that breaks the road is the caller's
/// to let go.
pub async fn select(reference: &Reference, turn: &Turn) -> Result<Vec<Entry>, GateError> {
  let composed = compose(reference, turn).await?;

  if turn.records {
    note_attached(reference, turn, &composed).await;
  }

  Ok(composed.entries)
}

/// What the road composed for a turn: the entries its prompt is given, the fragment rows among them, and what each
/// candidate a picker wanted came to — whether it attached.
pub struct Composed {
  pub entries: Vec<Entry>,
  pub attached: Vec<Fragment>,
  pub verdicts: Vec<Verdict>,
}

/// The memory picker of a room for one agent's turn, over the room's rows that are not due, as reference.toml
/// declares it.
pub fn memory_gate(chat_id: i64, rows: &[MemoryRow]) -> Result<Gate, GateError> {
  let declared = &REFERENCE.memories;

  Ok(Gate {
    stage: declared.stage.clone(),
    libraries: memories::library(chat_id, rows).into_iter().collect(),
    bot_lines_alone: declared.bot_lines_alone,
    reads_answered: declared.reads_answered,
    speakers_keep: declared.speakers_keep,
    system: instructions(&declared.stage)?,
    answer: answer_file(&declared.stage),
    reads: Reads::Verdicts,
    cap: None,
    budget: declared.budget,
    hold: SITUATION_HOLD,
    probe: probe(&declared.stage)?,
  })
}

// The rows the memory picker's resolved picks stand for, in the order the brain lists them: a pick is a body read
// out of its row, so an index handed over in place of picks stands for none.
fn picked_rows<'a>(gate: &Gate, picked: &Picked, rows: &'a [MemoryRow]) -> Vec<&'a MemoryRow> {
  let ids: HashSet<i64> = picked.entries.iter().filter_map(|entry| entry.fragment).collect();
  let keys: HashSet<&str> = gate
    .libraries
    .iter()
    .flat_map(|library| library.rows.iter())
    .filter(|row| ids.contains(&row.id))
    .map(|row| row.key.as_str())
    .collect();

  rows.iter().filter(|memory| keys.contains(memory.id.to_string().as_str())).collect()
}

/// The turn's reference composed as `select` composes it, with what it attached handed back rather than counted.
pub async fn compose(reference: &Reference, turn: &Turn) -> Result<Composed, GateError> {
  let agent = turn.agent(reference);
  let woken = async {
    match &turn.situation {
      Some(situation) => situation::event_entries(reference, situation).await,
      None => vec![],
    }
  };
  // Every picker's libraries are read beside the rest, but on a turn with no line, which asks none of them.
  let gates = async {
    if turn.message_lines.is_empty() {
      return Ok(vec![]);
    }

    gates_of(reference, turn.chat_id, agent, turn.lore).await
  };
  let (woken, standing, sheets, gates) = tokio::join!(
    woken,
    memories::standing(reference, turn.chat_id, agent),
    standing_entries(reference, turn.chat_id, &turn.speaker_ids, agent),
    gates
  );
  let (due, undue) = memories::due_first(&standing);
  let holds = turn.holds.clone().unwrap_or_default();
  let on = |gate: &str| !turn.off.iter().any(|off| off == gate);
  let matched = async {
    match &turn.situation {
      Some(situation) if on(situation::STAGE) => {
        situation::situation_entries(reference, situation, &holds).await
      }
      _ => Ok(vec![]),
    }
  };
  // The memories entry: the due rows, then the rows the memory picker picked.
  let memory_of = |picked: Vec<&MemoryRow>| {
    let carried: Vec<&MemoryRow> = due.iter().chain(picked).collect();

    memories::memories_entry(turn.chat_id, standing.len(), &carried)
  };
  let held = |memory: &Option<Entry>, streams: Vec<(Vec<Entry>, u8)>| {
    let mut all = vec![(memory.clone().into_iter().collect(), SITUATION_HOLD)];

    all.extend(streams);
    within_turn_budget(turn.chat_id, all)
  };
  // A speaker the person-book search picked has the whole sheet in place of the head, under the same path.
  let standing_first = |memory: &Option<Entry>, kept: Vec<Entry>, picked: Vec<Entry>| {
    let is_memory = |entry: &Entry| memory.as_ref() == Some(entry);
    let mut entries: Vec<Entry> = kept.iter().filter(|entry| is_memory(entry)).cloned().collect();
    let whole: HashSet<&str> = picked.iter().map(|entry| entry.path.as_str()).collect();

    entries.extend(sheets.iter().filter(|sheet| !whole.contains(sheet.path.as_str())).cloned());

    let mut seen: HashSet<String> = entries.iter().map(|entry| entry.path.clone()).collect();

    for entry in kept.into_iter().filter(|entry| !is_memory(entry)).chain(picked) {
      if seen.insert(entry.path.clone()) {
        entries.push(entry);
      }
    }

    entries
  };

  if turn.message_lines.is_empty() {
    let mut rules = woken;

    rules.extend(matched.await?);

    let memory = memory_of(vec![]);
    let kept = held(&memory, vec![(rules, SITUATION_HOLD)]);

    return Ok(Composed {
      entries: standing_first(&memory, kept, vec![]),
      attached: vec![],
      verdicts: vec![],
    });
  }

  let in_round = turn.holds.is_some();
  let mut gates = gates?;
  let people = gates.pop().expect("the person-book search");
  let remembering = memory_gate(turn.chat_id, &undue)?;
  let picks = gates.iter().map(|gate| {
    let holds = &holds;
    let asked = on(&gate.stage);

    async move {
      let libraries = offered(reference, turn, gate, holds, in_round, asked).await;

      if libraries.is_empty() {
        return Ok(Picked::nothing(&gate.stage));
      }

      pick::pick(reference, picker(turn, agent, gate, libraries)).await
    }
  });
  let pieces = async {
    let libraries = offered(reference, turn, &people, &holds, in_round, on(&people.stage)).await;

    if libraries.is_empty() {
      return Ok(Picked::nothing(&people.stage));
    }

    pick::pick(reference, picker(turn, agent, &people, libraries)).await
  };
  let recalled = async {
    let libraries = offered(reference, turn, &remembering, &holds, in_round, on(&remembering.stage)).await;

    if libraries.is_empty() {
      return Ok(Picked::nothing(&remembering.stage));
    }

    pick::pick(reference, picker(turn, agent, &remembering, libraries)).await
  };
  let (picked, pieces, recalled, rules) = tokio::join!(join_all(picks), pieces, recalled, matched);
  let picked: Vec<Picked> = picked.into_iter().collect::<Result<_, _>>()?;
  let pieces = pieces?;
  let recalled = recalled?;
  let mut rule_entries = woken;

  rule_entries.extend(rules?);

  let mut streams: Vec<(Vec<Entry>, u8)> = gates
    .iter()
    .zip(&picked)
    .map(|(gate, picked)| (picked.entries.clone(), gate.hold))
    .collect();

  streams.push((rule_entries, SITUATION_HOLD));

  let memory = memory_of(picked_rows(&remembering, &recalled, &undue));
  let entries = standing_first(&memory, held(&memory, streams), pieces.entries.clone());

  if !entries.is_empty() {
    println!(
      "reference: chat {} selected {}",
      turn.chat_id,
      entries.iter().map(|entry| entry.path.as_str()).collect::<Vec<_>>().join(", ")
    );
  }

  let rows: HashMap<i64, Fragment> = gates
    .iter()
    .chain([&people, &remembering])
    .flat_map(|gate| gate.libraries.iter().flat_map(|library| library.rows.iter()))
    .map(|row| (row.id, row.clone()))
    .collect();
  let mut all_picked = picked;

  all_picked.push(pieces);

  let mut attached: Vec<i64> = vec![];
  let remembered = memory.as_ref().is_some_and(|memory| entries.contains(memory));

  for id in entries
    .iter()
    .filter_map(|entry| entry.fragment)
    .chain(recalled.entries.iter().filter(|_| remembered).filter_map(|entry| entry.fragment))
  {
    if !attached.contains(&id) {
      attached.push(id);
    }
  }

  all_picked.push(recalled);

  let verdicts: Vec<Verdict> = all_picked
    .iter()
    .flat_map(|one| {
      one.wanted.iter().map(|(slug, fragment)| Verdict {
        stage: one.stage.clone(),
        chat_id: turn.chat_id,
        message_id: turn.message_id,
        slug: slug.clone(),
        llm: None,
        laya: None,
        attached: Some(fragment.is_some_and(|id| attached.contains(&id))),
      })
    })
    .collect();

  Ok(Composed {
    entries,
    attached: attached.iter().filter_map(|id| rows.get(id).cloned()).collect(),
    verdicts,
  })
}

// The fragments a turn attached, handed to the brain to count and written beside each wanted candidate's verdict.
async fn note_attached(reference: &Reference, turn: &Turn, composed: &Composed) {
  if let Err(why) =
    fragments::hits(reference, turn.agent(reference), turn.chat_id, &composed.attached).await
  {
    eprintln!("reference: what the turn attached could not be counted: {why}");
  }

  fragments::record_verdicts(&reference.stages.runs.db, &composed.verdicts).await;
}

/// What the knowledge gate picks for a piece of work that is no chat turn — a job, a search, a browse — out of the
/// knowledge the room it reports to may see (`docs/reference-selection.md`, 「Work beyond a turn」): the rows naming
/// the room and the shared ones, read for the agent, narrowed by the code for the work's own lines and asked about as
/// a turn's are. Nothing of what the gate read or judged is written down, the pieces it attached are counted on their
/// rows, and nothing else a turn carries attaches. A failure never reaches the work: it is said, and the work goes on
/// with nothing.
pub async fn select_knowledge(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  lines: &[String],
) -> Vec<Entry> {
  match work_knowledge(reference, agent, chat_id, lines).await {
    Ok(entries) => entries,
    Err(why) => {
      eprintln!("reference: chat {chat_id} knowledge for a piece of work could not be picked: {why}");
      vec![]
    }
  }
}

/// The knowledge gate a piece of work is asked by and what the narrowing leaves it for the work's own lines, written
/// down nowhere; none where the work has no line or the gate is not declared.
pub async fn work_narrowing(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  lines: &[String],
) -> Result<Option<(Gate, Narrowing)>, GateError> {
  let Some(declared) = REFERENCE.gates.iter().find(|gate| gate.stage == KNOWLEDGE_GATE) else {
    return Ok(None);
  };

  if lines.is_empty() {
    return Ok(None);
  }

  let gate = reference_gate(reference, chat_id, agent, false, declared).await?;
  let read = Read {
    lines,
    speakers: vec![],
    attached: HashMap::new(),
    rules: None,
  };
  let narrowing = narrowed(reference, &gate.libraries, said_in(lines), read).await;

  Ok(Some((gate, narrowing)))
}

async fn work_knowledge(
  reference: &Reference,
  agent: &str,
  chat_id: i64,
  lines: &[String],
) -> Result<Vec<Entry>, GateError> {
  let Some((gate, Narrowing { libraries, .. })) = work_narrowing(reference, agent, chat_id, lines).await?
  else {
    return Ok(vec![]);
  };

  if pick::candidates(&libraries).is_empty() {
    return Ok(vec![]);
  }

  let rows: HashMap<i64, Fragment> = libraries
    .iter()
    .flat_map(|library| library.rows.iter())
    .map(|row| (row.id, row.clone()))
    .collect();
  let picked = pick::pick(
    reference,
    Picker {
      chat_id,
      message_id: None,
      agent: agent.to_owned(),
      round: None,
      stage: gate.stage.clone(),
      system: gate.system.clone(),
      answer: gate.answer.clone(),
      libraries,
      message_lines: lines.to_vec(),
      reads: gate.reads,
      cap: None,
      budget: Some(gate.budget),
      probe: gate.probe.clone(),
      records: false,
    },
  )
  .await?;
  let attached: Vec<Fragment> = picked
    .entries
    .iter()
    .filter_map(|entry| entry.fragment)
    .filter_map(|id| rows.get(&id).cloned())
    .collect();

  if let Err(why) = fragments::hits(reference, agent, chat_id, &attached).await {
    eprintln!("reference: what a piece of work attached could not be counted: {why}");
  }

  Ok(picked.entries)
}
