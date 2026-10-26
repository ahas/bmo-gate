//! The gates of the set: each file here brings its own member, which registers itself with the set, so a gate is
//! added by adding its file and its words and declaring it here (docs/gate-eval.md, 「The members」).

pub mod session_summary;
pub mod translator;

use super::member::{EvalGate, Registered};

/// Every member of the set, in the order of the gates' names.
pub fn members() -> Vec<&'static dyn EvalGate> {
  let mut members: Vec<&'static dyn EvalGate> =
    inventory::iter::<Registered>.into_iter().map(|one| one.0).collect();

  members.sort_by_key(|member| member.stage());
  members
}
