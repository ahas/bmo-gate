//! The Laya service's relay on the operations machine, run by `bmo-laya-relay.service` (docs/llm-server.md, 「The
//! relay」).

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;
use laya_relay::placement::{PLACEMENT_FILE, RELAY_LISTEN, Watcher, placement_path};
use laya_relay::relay::{Relay, Waits, router, start_probes};
use tokio::net::TcpListener;

#[derive(Parser)]
#[command(
  name = "laya-relay",
  about = format!(
    "Listens at {RELAY_LISTEN} and asks each Laya call of the nodes of the placement file \
     placements/{PLACEMENT_FILE}, in their order.\nA node that is not reached, answers 503 or answers too late \
     is passed over and the same call sent to the next. Every answer names the node that gave it in x-laya-node."
  )
)]
struct Cli {
  /// The data root the placement stands under.
  #[arg(long, env = "BMO_DATA_DIR")]
  data_root: Option<PathBuf>,
  /// Where the relay listens.
  #[arg(long, env = "LAYA_RELAY_LISTEN", default_value = RELAY_LISTEN)]
  listen: String,
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
  let cli = Cli::parse();
  let Some(data_root) = cli.data_root.filter(|root| !root.as_os_str().is_empty()) else {
    eprintln!("laya-relay: name the data root the placement stands under with --data-root or BMO_DATA_DIR");
    return ExitCode::from(2);
  };
  let relay = Arc::new(Relay::new(Watcher::new(placement_path(&data_root)), Waits::from_env()));
  let listener = match TcpListener::bind(&cli.listen).await {
    Ok(listener) => listener,
    Err(fault) => {
      eprintln!("laya-relay: could not listen at {}: {fault}", cli.listen);
      return ExitCode::FAILURE;
    }
  };

  match listener.local_addr() {
    Ok(at) => println!("laya-relay: listening at {at}"),
    Err(_) => println!("laya-relay: listening at {}", cli.listen),
  }

  start_probes(Arc::clone(&relay));

  match axum::serve(listener, router(relay)).await {
    Ok(()) => ExitCode::SUCCESS,
    Err(fault) => {
      eprintln!("laya-relay: {fault}");
      ExitCode::FAILURE
    }
  }
}
