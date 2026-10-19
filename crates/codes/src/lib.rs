//! The gate's codes (`docs/codes.md`): every refusal the gate answers with, the status it goes out under, and
//! how each wire family spells it. A caller decides on the code and never on the sentence beside it.

/// One code of the gate's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Code {
  BodyNotJson,
  FieldWrong,
  Unauthorized,
  RouteAbsent,
  NotReady,
  Database,
  Failed,
  UnitFailed,
  Stopped,
  NoGate,
  NoAnswer,
  NothingToChange,
  OwnLlm,
  TimeoutOutOfRange,
  SwitchNotBoolean,
  AlwaysOn,
  LayaModeUnknown,
  LayaModeRefused,
  LayaTauOutOfRange,
  LayaFallbackUnknown,
  NoProbe,
  NoCheckpoint,
  NeedsTau,
  DocumentUnknown,
  LanguageUnknown,
  PromptTooLong,
}

impl Code {
  /// Every code, in the order `docs/codes.md` lists them.
  pub const ALL: [Code; 26] = [
    Code::BodyNotJson,
    Code::FieldWrong,
    Code::Unauthorized,
    Code::RouteAbsent,
    Code::NotReady,
    Code::Database,
    Code::Failed,
    Code::UnitFailed,
    Code::Stopped,
    Code::NoGate,
    Code::NoAnswer,
    Code::NothingToChange,
    Code::OwnLlm,
    Code::TimeoutOutOfRange,
    Code::SwitchNotBoolean,
    Code::AlwaysOn,
    Code::LayaModeUnknown,
    Code::LayaModeRefused,
    Code::LayaTauOutOfRange,
    Code::LayaFallbackUnknown,
    Code::NoProbe,
    Code::NoCheckpoint,
    Code::NeedsTau,
    Code::DocumentUnknown,
    Code::LanguageUnknown,
    Code::PromptTooLong,
  ];

  /// The code as the units' family spells it: snake_case.
  pub fn as_str(self) -> &'static str {
    match self {
      Code::BodyNotJson => "body_not_json",
      Code::FieldWrong => "field_wrong",
      Code::Unauthorized => "unauthorized",
      Code::RouteAbsent => "route_absent",
      Code::NotReady => "not_ready",
      Code::Database => "database",
      Code::Failed => "failed",
      Code::UnitFailed => "unit_failed",
      Code::Stopped => "stopped",
      Code::NoGate => "no_gate",
      Code::NoAnswer => "no_answer",
      Code::NothingToChange => "nothing_to_change",
      Code::OwnLlm => "own_llm",
      Code::TimeoutOutOfRange => "timeout_out_of_range",
      Code::SwitchNotBoolean => "switch_not_boolean",
      Code::AlwaysOn => "always_on",
      Code::LayaModeUnknown => "laya_mode_unknown",
      Code::LayaModeRefused => "laya_mode_refused",
      Code::LayaTauOutOfRange => "laya_tau_out_of_range",
      Code::LayaFallbackUnknown => "laya_fallback_unknown",
      Code::NoProbe => "no_probe",
      Code::NoCheckpoint => "no_checkpoint",
      Code::NeedsTau => "needs_tau",
      Code::DocumentUnknown => "document_unknown",
      Code::LanguageUnknown => "language_unknown",
      Code::PromptTooLong => "prompt_too_long",
    }
  }

  /// The code as the brain's family spells it: kebab-case.
  pub fn kebab(self) -> String {
    self.as_str().replace('_', "-")
  }

  /// The status the code goes out under. A Laya mode refusal is no answer of its own: it rides beside
  /// `laya_mode_refused`, and is answered under that one's status.
  pub fn status(self) -> u16 {
    match self {
      Code::BodyNotJson
      | Code::FieldWrong
      | Code::NothingToChange
      | Code::OwnLlm
      | Code::TimeoutOutOfRange
      | Code::SwitchNotBoolean
      | Code::LayaModeUnknown
      | Code::LayaTauOutOfRange
      | Code::LayaFallbackUnknown
      | Code::DocumentUnknown
      | Code::LanguageUnknown
      | Code::PromptTooLong => 400,
      Code::Unauthorized => 401,
      Code::RouteAbsent | Code::NoGate => 404,
      Code::Stopped
      | Code::AlwaysOn
      | Code::LayaModeRefused
      | Code::NoProbe
      | Code::NoCheckpoint
      | Code::NeedsTau => 409,
      Code::Database | Code::Failed => 500,
      Code::UnitFailed | Code::NoAnswer => 502,
      Code::NotReady => 503,
    }
  }

  /// The code a spelling of either family names, or none.
  pub fn named(spelled: &str) -> Option<Code> {
    let snake = spelled.replace('-', "_");

    Code::ALL.into_iter().find(|code| code.as_str() == snake)
  }
}
