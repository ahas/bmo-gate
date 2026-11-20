//! Whom an org brain is read for (`docs/reference-selection.md`, 「What an organisation hands its members」): the
//! company's own people alone, or a room where someone outside the company sits.

use serde::{Deserialize, Serialize};

/// The audience a read of the org brains is for: `Internal` where everyone in the room is of the company of the
/// supervisor's owner, `External` where someone outside it sits there, or who sits there could not be read.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
  Internal,
  External,
}

impl Audience {
  /// The word the wire carries.
  pub fn as_str(self) -> &'static str {
    match self {
      Self::Internal => "internal",
      Self::External => "external",
    }
  }

  /// Whether an org memory marked internal-only, or not, may be read for this audience.
  pub fn reads(self, internal_only: bool) -> bool {
    self == Self::Internal || !internal_only
  }
}
