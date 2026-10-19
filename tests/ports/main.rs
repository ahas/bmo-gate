//! The ports' tests: each call made against a stand-in of its unit on the loopback, the request it sends read
//! back field by field and the answer the unit gives read as the call's shape.

#[path = "../support/stub.rs"]
mod stub;

mod agency;
mod arbiter;
mod brain;
mod gateway;
mod http;
mod job;
mod receiver;

use std::time::Duration;

use gate_ports::Peer;

/// A peer for a stand-in, presenting `token`, offering each call once.
pub fn peer(stub: &stub::Stub, token: &str) -> Peer {
  Peer::new(&stub.address, Some(token.to_owned()))
    .unwrap()
    .with_patience(Duration::ZERO, Duration::ZERO)
}
