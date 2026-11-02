//! The gate's codes (`docs/codes.md`): every refusal the gate answers with, the status it goes out under, and
//! the kebab-case word it is written as. A caller decides on the code and never on the sentence beside it.

/// One code of the gate's.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Code {
  BadRequest,
  Unauthorized,
  NoRoute,
  NotFound,
  Conflict,
  TooLarge,
  Failed,
  UpstreamFailed,
  NotReady,
  Stopped,
  NoGate,
  NothingToChange,
  OwnLlm,
  SwitchNotBoolean,
  AlwaysOn,
  DocumentUnknown,
  LanguageUnknown,
  TooManyOriginals,
}

impl Code {
  /// Every code, in the order `docs/codes.md` lists them.
  pub const ALL: [Code; 18] = [
    Code::BadRequest,
    Code::Unauthorized,
    Code::NoRoute,
    Code::NotFound,
    Code::Conflict,
    Code::TooLarge,
    Code::Failed,
    Code::UpstreamFailed,
    Code::NotReady,
    Code::Stopped,
    Code::NoGate,
    Code::NothingToChange,
    Code::OwnLlm,
    Code::SwitchNotBoolean,
    Code::AlwaysOn,
    Code::DocumentUnknown,
    Code::LanguageUnknown,
    Code::TooManyOriginals,
  ];

  /// The code as the wire spells it: kebab-case.
  pub fn as_str(self) -> &'static str {
    match self {
      Code::BadRequest => "bad-request",
      Code::Unauthorized => "unauthorized",
      Code::NoRoute => "no-route",
      Code::NotFound => "not-found",
      Code::Conflict => "conflict",
      Code::TooLarge => "too-large",
      Code::Failed => "failed",
      Code::UpstreamFailed => "upstream-failed",
      Code::NotReady => "not-ready",
      Code::Stopped => "stopped",
      Code::NoGate => "no-gate",
      Code::NothingToChange => "nothing-to-change",
      Code::OwnLlm => "own-llm",
      Code::SwitchNotBoolean => "switch-not-boolean",
      Code::AlwaysOn => "always-on",
      Code::DocumentUnknown => "document-unknown",
      Code::LanguageUnknown => "language-unknown",
      Code::TooManyOriginals => "too-many-originals",
    }
  }

  /// The status the code goes out under.
  pub fn status(self) -> u16 {
    match self {
      Code::BadRequest | Code::NothingToChange | Code::TooManyOriginals => 400,
      Code::Unauthorized => 401,
      Code::NoRoute | Code::NotFound | Code::NoGate => 404,
      Code::Conflict | Code::Stopped => 409,
      Code::TooLarge => 413,
      Code::OwnLlm
      | Code::SwitchNotBoolean
      | Code::AlwaysOn
      | Code::DocumentUnknown
      | Code::LanguageUnknown => 422,
      Code::Failed => 500,
      Code::UpstreamFailed => 502,
      Code::NotReady => 503,
    }
  }

  /// The code a word names, or none.
  pub fn named(spelled: &str) -> Option<Code> {
    Code::ALL.into_iter().find(|code| code.as_str() == spelled)
  }
}
