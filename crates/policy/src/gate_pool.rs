//! How many runs of one gate stand at once where its profile names no bound of its own (docs/gates.md, 「How
//! many runs stand at once」).

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GatePool {
  pub size: usize,
}

crate::part!(pub GATE_POOL: GatePool = "gate-pool.toml");
