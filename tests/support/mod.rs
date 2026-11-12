//! What the modules of the test harness share: a scratch store of a test's own, a stand-in unit on the loopback,
//! and one whose connections go by a script.

pub mod scratch;
pub mod stub;
pub mod turns;
