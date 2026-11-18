//! Every body and answer the gate's routes carry, in the common wire format: camelCase keys, epoch milliseconds,
//! signed 64-bit identifiers, a page of `items` and `more`, and a refusal of `code` and `error`.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// A refusal or failure: a code for a machine and one English sentence for a person.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct ErrorBody {
  pub code: String,
  pub error: String,
}

/// One page of a list, and whether anything stands past its last member.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[schemars(rename = "{T}Page")]
pub struct Page<T> {
  pub items: Vec<T>,
  pub more: bool,
}

impl<T> Page<T> {
  pub fn of(items: Vec<T>, more: bool) -> Self {
    Self { items, more }
  }
}

/// One event the gate tells its readers of, as the stream and a page of it carry it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Event {
  pub id: i64,
  pub kind: String,
  /// Epoch milliseconds.
  pub at: i64,
  pub data: Value,
}

// ---------------------------------------------------------------------------------------------------------------
// Gates

/// One gate of the gate order, and the profile it runs under.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Gate {
  pub gate_name: String,
  /// `pre`, `post` or `apart`: where the gate stands against a turn.
  pub part: String,
  pub step: i64,
  pub condition: Option<String>,
  pub switchable: bool,
  pub answer_tokens: Option<i64>,
}

/// What a gate runs on beside its own options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveOptions {
  pub thinking: bool,
  pub answer_tokens: i64,
}

/// The values a blank setting stands for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DefaultOptions {
  pub thinking: bool,
  pub answer_tokens: i64,
}

/// One gate's options as it stands for the chat agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GateOptions {
  pub switchable: bool,
  pub enabled: bool,
  pub effective: EffectiveOptions,
  pub defaults: DefaultOptions,
}

/// A change of a gate's options: a field left out stays.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GateOptionChange {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub enabled: Option<bool>,
  /// Not a gate option: its role's. A change naming it is refused `own-llm`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub thinking: Option<bool>,
  /// Not a gate option: its role's. A change naming it is refused `own-llm`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub answer_tokens: Option<i64>,
}

/// The gate's road as a run reads it: the provider and the model its role's order names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GateRoute {
  pub provider: String,
  pub model: String,
  /// The moment the change was written, in epoch milliseconds.
  pub set_at: i64,
}

/// The options as a change left them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GateOptionsChanged {
  pub gate_name: String,
  pub options: GateRoute,
}

/// A companion's options copied from the chat agent's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct OptionsCopied {
  pub agent_name: String,
  pub from_agent_name: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Judgements

/// A judgement to write into a room's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewJudgement {
  pub room_id: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub message_id: Option<i64>,
  pub gate_name: String,
  pub verdict: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub detail: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ms: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub round: Option<String>,
}

/// The tokens a road reported.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
  pub input_tokens: i64,
  pub output_tokens: Option<i64>,
  pub cache_read_tokens: Option<i64>,
  pub cache_write_tokens: Option<i64>,
}

/// One road a gate run walked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Road {
  pub id: i64,
  pub provider: String,
  pub model: String,
  pub outcome: String,
  pub ms: i64,
  pub tokens: Option<Tokens>,
}

/// What one reference gate kept, by the rule that kept it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeptCounts {
  pub item: i64,
  pub keyword: i64,
  pub word: i64,
  pub person: i64,
  pub recent: i64,
}

/// What a round's gates were offered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Offer {
  pub gate_name: String,
  pub held: i64,
  pub asked: i64,
  pub kept: KeptCounts,
  pub capped: i64,
  pub rules: Option<Vec<String>>,
}

/// A decision written into a room's log.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Judgement {
  pub id: i64,
  pub room_id: i64,
  pub message_id: Option<i64>,
  pub gate_name: String,
  pub verdict: String,
  pub detail: Option<String>,
  /// Epoch milliseconds.
  pub created_at: i64,
  pub ms: Option<i64>,
  pub round: Option<String>,
  /// What a gate's model was asked of its candidates, one line each, in the order it read them, where the judgement
  /// keeps them; empty on every other judgement.
  #[serde(default)]
  pub lines: Vec<JudgementLine>,
  pub roads: Vec<Road>,
  pub offers: Vec<Offer>,
}

/// One line a gate's model was asked of a candidate, exactly as the model read it, and what it answered of that
/// line as the judgement kept it; none where its answer was not read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct JudgementLine {
  pub line: String,
  pub answer: Option<String>,
}

/// Which judgements to read: a room, a gate, a span, and the cursor of the page.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct JudgementQuery {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub room_id: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub gate_name: Option<String>,
  /// A judgement written at or after this moment, in epoch milliseconds.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub from: Option<i64>,
  /// A judgement written at or before this moment, in epoch milliseconds.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub to: Option<i64>,
  /// The id the page starts below; the list is newest first.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub before: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub limit: Option<i64>,
}

/// A round's judgements put under the message that answered it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachJudgements {
  pub room_id: i64,
  pub message_id: i64,
  /// The moment the round began, in epoch milliseconds: every judgement written at or after it is attached.
  pub since: i64,
}

// ---------------------------------------------------------------------------------------------------------------
// A turn's reference

/// One event a turn's situation carries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SituationEvent {
  pub kind: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub item_id: Option<i64>,
}

/// A turn's situation: the agent, the kind of room, the events and the moment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Situation {
  pub agent_name: String,
  /// `owner` or `group`.
  pub room_kind: String,
  pub events: Vec<SituationEvent>,
  /// Epoch milliseconds.
  pub now_at: i64,
}

/// A turn's envelope, as the gate's reference road reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceAsk {
  pub room_id: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub message_id: Option<i64>,
  pub lines: Vec<String>,
  pub speaker_ids: Vec<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub situation: Option<Situation>,
  /// The supervisor a turn with no situation is read for, a job's first prompt or its double's; where a
  /// situation stands too, the same agent it names.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub agent: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub holds: Option<Vec<String>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub round: Option<String>,
  pub people_spoke: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub answered: Option<String>,
  pub records: bool,
}

/// One piece a turn is handed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
  pub path: String,
  pub text: String,
  /// `document`, `person`, `rule`, `situation`, `knowledge`, `memory`, `room` or `archive`.
  pub source: String,
}

/// A turn's reference.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceAnswer {
  pub entries: Vec<Entry>,
}

/// The brain's index asked for: the room, the session whose loads count an entry read, and the agent whose own
/// brain it is read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ReferenceIndexQuery {
  pub room: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub session: Option<String>,
  pub agent: String,
}

/// One entry of the index: its slug, what it holds and when it is read, null where its title says not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
  pub slug: String,
  pub holds: String,
  pub read_when: Option<String>,
  /// The path a piece read of the entry is recorded under among the session's loads.
  pub path: String,
}

/// One group of the index: `system-documents`, `room-rules`, `knowledge`, `people` or `room-memories`, how many of
/// its entries the session has not read, one sentence of what changed in the last three days or null, and its
/// entries.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct IndexGroup {
  pub group: String,
  pub unread: u64,
  pub hint: Option<String>,
  pub entries: Vec<IndexEntry>,
}

/// The brain's index, its groups in order.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceIndex {
  pub groups: Vec<IndexGroup>,
}

/// A piece asked for by its slug: the room, its group, the session it is recorded among the loads of, and the
/// agent whose own brain it is read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ReferencePieceQuery {
  pub room: i64,
  pub group: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub session: Option<String>,
  pub agent: String,
}

/// One piece read whole.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferencePiece {
  pub slug: String,
  pub group: String,
  pub path: String,
  pub text: String,
}

/// A search of the index: its words, the room, at most how many entries (8 where absent, at most 24), and the
/// agent whose own brain it is read from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct ReferenceSearchQuery {
  pub q: String,
  pub room: i64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub limit: Option<u32>,
  pub agent: String,
}

/// One entry a search found, with its group.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SearchEntry {
  pub slug: String,
  pub group: String,
  pub holds: String,
  pub read_when: Option<String>,
}

/// What a search found, the entries holding the most of its words first.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceSearch {
  pub entries: Vec<SearchEntry>,
}

// ---------------------------------------------------------------------------------------------------------------
// Translations

/// Originals to translate into one language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranslationAsk {
  pub language: String,
  pub originals: Vec<String>,
}

/// One original's reading.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reading {
  pub text: String,
  pub whole: bool,
}

/// The readings of a batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Readings {
  pub readings: Vec<Reading>,
}

/// One translation kept under its original and its language.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeptTranslation {
  pub original: String,
  pub text: String,
}

/// One translation kept, read back by the digest of its original.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct KeptReading {
  /// The SHA-256 of the original exactly as written, in lowercase hex.
  pub digest: String,
  pub text: String,
}

/// Which kept translations to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct KeptQuery {
  pub language: String,
  /// The digests of the originals, each the SHA-256 of an original exactly as written in lowercase hex, a comma
  /// between them.
  pub digests: String,
}

/// A translation to keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeepTranslation {
  pub language: String,
  pub original: String,
  pub text: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Gate runs

/// One run of one gate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageRunAsk {
  pub prompt: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub system: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub room_id: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub message_id: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub agent_name: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub thinking: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub alongside: Option<bool>,
  /// The company the run is for, as the caller names it; runs for different companies share no prompt prefix.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub tenant: Option<String>,
}

/// What a run of a gate answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
  pub answer: Option<String>,
  pub ms: i64,
}

// ---------------------------------------------------------------------------------------------------------------
// Trials

/// One prompt put to one gate as a turn would put it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NewTrial {
  pub gate_name: String,
  pub prompt: String,
  pub user_name: String,
}

/// A trial as it was kept.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Trial {
  pub id: i64,
  pub gate_name: String,
  pub user_name: String,
  pub prompt: String,
  pub answer: Option<String>,
  pub ms: i64,
  /// Epoch milliseconds.
  pub created_at: i64,
}

/// Which trials to read: a gate and the cursor of the page, oldest first.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct TrialQuery {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub gate_name: Option<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub after: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub before: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub limit: Option<i64>,
}

// ---------------------------------------------------------------------------------------------------------------
// Documents

/// One part of a document to translate.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct WantedPart {
  pub part: i64,
  pub text: String,
}

/// A document's translation queued part by part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentTranslationOrder {
  pub document: String,
  pub version: String,
  pub target: String,
  pub part_count: i64,
  pub wanted: Vec<WantedPart>,
}

/// The parts queued.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Taken {
  pub taken: usize,
}

/// Why a document's translation last stopped short.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TranslationFailure {
  pub reason: String,
  pub provider: Option<String>,
  pub model: Option<String>,
}

/// Where a document's translation into one language stands.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentTranslationState {
  pub pending: usize,
  pub failure: Option<TranslationFailure>,
}

/// Which document's translation state to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct DocumentStateQuery {
  pub document: String,
  pub target: String,
}

/// One part of a document's translation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPart {
  pub part: i64,
  pub text: Option<String>,
  pub failed: bool,
  /// What the last answer of a part kept as failed lost, as a sentence; none for a part that did not fail.
  #[serde(default)]
  pub failure: Option<String>,
}

/// Which document's translation parts to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct DocumentPartsQuery {
  pub document: String,
  pub version: String,
  pub target: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Health

/// Readiness and version.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
  pub ready: bool,
  pub reason: Option<String>,
  pub version: String,
}
