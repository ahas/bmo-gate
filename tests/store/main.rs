//! The store's tests: its migrations and its entities, each on a scratch database of the test's own on the
//! suite's PostgreSQL server.

#[path = "../support/scratch.rs"]
mod scratch;

mod entities;
mod import;
mod migration;
