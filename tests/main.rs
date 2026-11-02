//! The repository's one test harness (bmo-chat's docs/conventions.md, 「Rust builds」): the checks that span the
//! repository and the contract's test a module each, each crate's tests a module of a folder named after it, and
//! what they share in `support`. Every module shares the process.

mod support;

mod api;
mod codes;
mod command;
mod markup;
mod personal_data;
mod policy;
mod ports;
mod reference;
mod repository;
mod runs;
mod server;
mod stages;
mod store;
mod tools;
