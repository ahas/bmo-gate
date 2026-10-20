//! Every body and answer the gate's routes carry, in the common wire format: camelCase keys, epoch milliseconds,
//! signed 64-bit identifiers, a page of `items` and `more`, and a refusal of `code` and `error`.

use std::collections::BTreeMap;

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
  pub laya_probe: bool,
  pub default_laya_mode: Option<String>,
  pub answer_tokens: Option<i64>,
}

/// What a gate runs on beside its own options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EffectiveOptions {
  pub thinking: bool,
  pub answer_tokens: i64,
  pub timeout_ms: Option<i64>,
  pub laya_mode: String,
  pub laya_tau: Option<f64>,
}

/// The values a blank setting stands for.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DefaultOptions {
  pub thinking: bool,
  pub answer_tokens: i64,
  pub laya_mode: String,
  pub laya_tau: Option<f64>,
}

/// One gate's options as it stands for the chat agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GateOptions {
  pub timeout_ms: Option<i64>,
  pub laya_mode: Option<String>,
  pub laya_tau: Option<f64>,
  pub laya_probe: bool,
  pub switchable: bool,
  pub enabled: bool,
  pub laya_fallback: Option<String>,
  pub effective: EffectiveOptions,
  pub defaults: DefaultOptions,
}

/// A change of a gate's options: a field left out stays, a Laya field sent null goes back to the default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GateOptionChange {
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub timeout_ms: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "sends_null")]
  pub laya_mode: Option<Option<String>>,
  #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "sends_null")]
  pub laya_tau: Option<Option<f64>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub enabled: Option<bool>,
  #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "sends_null")]
  pub laya_fallback: Option<Option<String>>,
  /// Not a gate option: its tier's. A change naming it is refused `own-llm`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub thinking: Option<bool>,
  /// Not a gate option: its tier's. A change naming it is refused `own-llm`.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub answer_tokens: Option<i64>,
}

/// A field that may be left out, set, or sent as null: null is `Some(None)`, which tells the gate to go back to
/// the default, while a field left out is `None` and stays as it was.
fn sends_null<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
  D: serde::Deserializer<'de>,
  T: Deserialize<'de>,
{
  Option::<T>::deserialize(deserializer).map(Some)
}

/// The gate's route as a run reads it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct GateRoute {
  pub provider: String,
  pub model: String,
  pub laya: bool,
  pub timeout_ms: Option<i64>,
  /// Epoch milliseconds.
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
// Laya

/// One τ where a gate's agreement was counted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct AgreementAt {
  pub tau: f64,
  pub coverage: Option<f64>,
  pub agreement: Option<f64>,
  pub safe_count: Option<i64>,
  pub safe_agreement: Option<f64>,
}

/// How often Laya agrees with a gate's LLM.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Agreement {
  pub gate_name: String,
  /// `pair` or `question`: what the figures are counted over.
  pub unit: String,
  pub pairs: i64,
  pub failures: i64,
  pub agreement: Option<f64>,
  pub by_tau: Vec<AgreementAt>,
  pub settled: Option<f64>,
}

/// A Laya mode a gate may not run in, and the code that says why.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ModeRefusal {
  pub mode: String,
  pub code: String,
}

/// One probed gate as Laya's screen reads it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayaGate {
  pub gate_name: String,
  pub mode: String,
  pub tau: Option<f64>,
  pub agreement: Option<Agreement>,
  pub checkpoint: Option<String>,
  pub refused: Vec<ModeRefusal>,
}

/// The last health check of the Laya relay.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayaHealth {
  pub state: String,
  pub model: Option<String>,
  pub device: Option<String>,
  pub vram_bytes: Option<i64>,
  pub load_ms: Option<i64>,
  pub versions: BTreeMap<String, String>,
  pub address: Option<String>,
  pub check_ms: Option<i64>,
  /// Epoch milliseconds.
  pub checked_at: Option<i64>,
  /// Epoch milliseconds.
  pub answered_at: Option<i64>,
}

/// Laya as `GET /laya` answers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct LayaView {
  pub health: LayaHealth,
  pub gates: Vec<LayaGate>,
  pub modes: Vec<String>,
  pub taus: Vec<f64>,
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
  pub person: i64,
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
  pub roads: Vec<Road>,
  pub offers: Vec<Offer>,
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
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub holds: Option<Vec<String>>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub round: Option<String>,
  pub people_spoke: bool,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub answered: Option<String>,
  /// The gates switched off for the agent.
  #[serde(default)]
  pub off_gates: Vec<String>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub lore: Option<bool>,
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

// ---------------------------------------------------------------------------------------------------------------
// The sanitiser

/// Words to sanitise.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SanitiseAsk {
  pub text: String,
  pub label: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub room_id: Option<i64>,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub message_id: Option<i64>,
}

/// Words as the sanitiser left them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Sanitised {
  pub text: String,
  pub changed: bool,
}

/// A document the brain is about to keep.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentSanitiseAsk {
  pub path: String,
  pub text: String,
}

/// The text to keep of a document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSanitised {
  pub text: String,
}

// ---------------------------------------------------------------------------------------------------------------
// Person-book sheets

/// One piece a sheet is written from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SheetPiece {
  pub path: String,
  pub text: String,
}

/// A sheet to judge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetAsk {
  pub agent_name: String,
  /// `common` or `room`.
  pub part: String,
  pub room_id: Option<i64>,
  pub person_id: i64,
  pub pieces: Vec<SheetPiece>,
  pub ceiling: usize,
  pub registration: Option<String>,
}

/// The sheet that came, or none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct SheetAnswer {
  pub sheet: Option<String>,
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

/// Which kept translations to read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(inline)]
pub struct KeptQuery {
  pub language: String,
  /// The originals, a comma between them.
  pub originals: String,
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
// Knowledge

/// The knowledge a job's work calls for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnowledgeAsk {
  pub agent_name: String,
  pub room_id: i64,
  pub lines: Vec<String>,
}

/// The knowledge a search's work calls for, for the chat agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkKnowledgeAsk {
  pub room_id: i64,
  pub lines: Vec<String>,
}

/// One piece of knowledge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Piece {
  pub path: String,
  pub text: String,
}

/// The pieces picked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Pieces {
  pub pieces: Vec<Piece>,
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
}

/// What a run of a gate answered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct StageRun {
  pub answer: Option<String>,
  pub ms: i64,
}

// ---------------------------------------------------------------------------------------------------------------
// The output gate

/// One part of a reply, in markdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FormatAsk {
  pub room_id: i64,
  pub text: String,
}

/// The markup the part goes out as, or none to send its plain text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct FormatAnswer {
  pub markup: Option<String>,
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

/// One line of a document index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct SeekEntry {
  pub slug: String,
  pub line: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub group: Option<String>,
}

/// A question put to the document seeker over an index.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeekAsk {
  pub question: String,
  pub entries: Vec<SeekEntry>,
}

/// The documents a question calls for.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Picks {
  pub picks: Vec<String>,
}

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
// Health and the agency's hook

/// Readiness, version and Laya's last state.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Health {
  pub ready: bool,
  pub reason: Option<String>,
  pub version: String,
  /// `up`, `down` or `off`.
  pub laya: String,
}

/// The agency's session-summariser hook as it asks it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HookAsk {
  pub point: String,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub ask: Option<Value>,
}

/// The agency's session-summariser hook as the gate answers it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct HookAnswer {
  pub answer: Option<String>,
}
