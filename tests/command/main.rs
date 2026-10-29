//! The unit command's tests: the nouns it declares and the words it reads, its health check against a stand-in
//! service, and the gate's records read off a scratch database.

#[path = "../support/scratch.rs"]
mod scratch;

mod health;
mod nouns;
mod records;

use std::path::PathBuf;

/// A folder of the test's own, empty.
pub fn folder(test: &str) -> PathBuf {
  let dir = std::env::temp_dir().join(format!("gate-command-{}-{test}", std::process::id()));

  let _ = std::fs::remove_dir_all(&dir);
  std::fs::create_dir_all(&dir).unwrap();
  dir
}
