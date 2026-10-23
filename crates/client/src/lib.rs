//! The gate's contract in Rust (`docs/api.md`): every body and answer as a type, every route a unit calls as a call
//! (the console's screen routes are a browser's, through a console's relay), and the OpenAPI document generated from
//! those types. The server answers in these types, so the document, the server and the client never drift apart.

pub mod client;
pub mod openapi;
pub mod types;

pub use client::{ClientFailure, GateClient};
pub use gate_codes::Code;
pub use types::*;
