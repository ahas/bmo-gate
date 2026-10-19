//! The English the gate answers and prints in. A refusal goes out as its code (`gate-codes`) with one of these
//! sentences beside it; a screen that shows it in another language reads the code, never the sentence. Each
//! `{name}` in a line is filled in with what it names, by the policy's `fill_marks`.

pub mod attachments;
pub mod casebook;
pub mod gate_bench;
pub mod gate_eval;
pub mod laya_agreement;
pub mod options;
pub mod reference_benches;
pub mod translation;
