//! The service's stop (`docs/boundary-api.md`, 「Stopping」): asked by SIGTERM or an interrupt, it takes no new
//! connection, tells every open event stream it is stopping and ends it, and lets the calls in hand finish within
//! a deadline.

use std::future::IntoFuture;
use std::time::Duration;

use axum::Router;
use tokio::net::TcpListener;
use tokio::signal::unix::{SignalKind, signal};
use tokio::sync::watch;

/// How long the calls in hand are let finish once the service is asked to stop.
pub const DRAIN: Duration = Duration::from_secs(30);

/// Whether the service has been asked to stop, which every open event stream and the serve itself wait on.
#[derive(Clone, Debug)]
pub struct Stop(watch::Sender<bool>);

impl Default for Stop {
  fn default() -> Self {
    Self(watch::Sender::new(false))
  }
}

impl Stop {
  /// The service asked to stop; asked again, nothing more happens.
  pub fn stop(&self) {
    self.0.send_replace(true);
  }

  /// Ends once the service has been asked to stop, at once where it already has.
  pub async fn stopped(&self) {
    let mut asked = self.0.subscribe();

    // The sender is `self`'s own, so the wait ends only with the stop.
    let _ = asked.wait_for(|stopping| *stopping).await;
  }

  /// The service asked to stop when SIGTERM or an interrupt comes.
  pub async fn on_signal(self) {
    let terminated = async {
      match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
          terminate.recv().await;
        }
        Err(why) => {
          eprintln!("gate-server: SIGTERM cannot be heard: {why}");
          std::future::pending::<()>().await;
        }
      }
    };

    tokio::select! {
      () = terminated => {}
      interrupted = tokio::signal::ctrl_c() => {
        if let Err(why) = interrupted {
          eprintln!("gate-server: an interrupt cannot be heard: {why}");
          std::future::pending::<()>().await;
        }
      }
    }

    println!("gate-server: stopping; the calls in hand are let finish");
    self.stop();
  }
}

/// `router` answering at `listener` until `stop` is asked, then drained: no new connection taken, each idle one
/// closed, and the calls in hand let finish within `deadline`, past which those still open end with the serve.
pub async fn drain(
  listener: TcpListener,
  router: Router,
  stop: Stop,
  deadline: Duration,
) -> std::io::Result<()> {
  let asked = stop.clone();
  let serving = axum::serve(listener, router)
    .with_graceful_shutdown(async move { asked.stopped().await })
    .into_future();
  let cut = async {
    stop.stopped().await;
    tokio::time::sleep(deadline).await;
  };

  tokio::select! {
    served = serving => served,
    () = cut => {
      eprintln!("gate-server: the calls still in hand after {}s end with the service", deadline.as_secs());
      Ok(())
    }
  }
}
