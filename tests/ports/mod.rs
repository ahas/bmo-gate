//! The ports' tests: each call made against a stand-in of its unit on the loopback, the request it sends read
//! back field by field and the answer the unit gives read as the call's shape.

mod agency;
mod brain;
mod gateway;
mod http;
mod receiver;

use gate_ports::Peer;

/// A peer for a stand-in, presenting `token`.
pub fn peer(stub: &crate::support::stub::Stub, token: &str) -> Peer {
  Peer::new(&stub.address, Some(token.to_owned())).unwrap()
}
