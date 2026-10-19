//! The Laya service's relay on the operations machine (docs/llm-server.md, 「The relay」): the one address the gate
//! asks the service at, handing each call to the placement's nodes in order and moving on past a node that cannot
//! take it. Nothing of a call is logged.

pub mod placement;
pub mod relay;
