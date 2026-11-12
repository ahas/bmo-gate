//! What the modules of the test harness share: a scratch store of a test's own, a stand-in unit on the loopback,
//! one whose connections go by a script, and a stand-in agency the test stops and starts.

pub mod agency;
pub mod scratch;
pub mod stub;
pub mod turns;
