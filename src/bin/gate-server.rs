//! The gate's service (`docs/boundary-api.md`): `gate-server <settings.toml>` stands at the settings the file holds
//! and answers until it is stopped.

use std::path::PathBuf;
use std::process::ExitCode;

use gate_server::settings::Settings;

#[tokio::main]
async fn main() -> ExitCode {
  let Some(path) = std::env::args_os().nth(1).map(PathBuf::from) else {
    eprintln!("usage: gate-server <settings.toml>");
    return ExitCode::from(2);
  };
  let settings = match Settings::read(&path) {
    Ok(settings) => settings,
    Err(why) => {
      eprintln!("gate-server: the settings do not stand: {why}");
      return ExitCode::FAILURE;
    }
  };

  match gate_server::serve(settings).await {
    Ok(()) => ExitCode::SUCCESS,
    Err(why) => {
      eprintln!("gate-server: {why}");
      ExitCode::FAILURE
    }
  }
}
