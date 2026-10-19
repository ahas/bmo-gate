//! The gate's unit command (`docs/boundary-api.md`, 「The unit command」): `bmo-gate nouns`, and each noun it
//! declares, on the words it is given.

use std::process::ExitCode;

#[tokio::main]
async fn main() -> ExitCode {
  gate_command::main(std::env::args().collect()).await
}
