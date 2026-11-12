//! A stand-in unit on the loopback whose connections go by a script: each connection it takes is the next step,
//! the last step standing for every connection after it. A step closes the connection once the request has come,
//! with no answer, resets it with the request half read, or answers it and closes, so every call the caller makes
//! is a connection of its own.

use std::convert::Infallible;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Response, StatusCode};
use hyper_util::rt::TokioIo;
use tokio::io::AsyncReadExt;
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

/// What the stand-in does with one connection.
#[derive(Clone, Debug)]
pub enum Step {
  /// The request read and the connection closed with no answer.
  Close,
  /// One byte of the request read and the connection dropped with the rest unread, which the kernel answers
  /// with a reset.
  Reset,
  /// The request answered with a status and a JSON body.
  Answer(u16, String),
}

/// The stand-in, listening until it is dropped.
pub struct Turns {
  pub address: String,
  taken: Arc<AtomicUsize>,
  serving: JoinHandle<()>,
}

impl Turns {
  /// A stand-in on a port the system chooses, going through `steps` a connection at a time.
  pub async fn start(steps: Vec<Step>) -> Turns {
    assert!(!steps.is_empty(), "a script has a step");

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let taken = Arc::new(AtomicUsize::new(0));
    let counted = taken.clone();
    let serving = tokio::spawn(async move {
      loop {
        let Ok((mut stream, _)) = listener.accept().await else { return };
        let at = counted.fetch_add(1, Ordering::SeqCst);
        let step = steps[at.min(steps.len() - 1)].clone();

        tokio::spawn(async move {
          match step {
            Step::Close => {
              let mut read = [0_u8; 4096];
              let _ = stream.read(&mut read).await;
            }
            Step::Reset => {
              let mut read = [0_u8; 1];
              let _ = stream.read_exact(&mut read).await;
            }
            Step::Answer(status, body) => {
              let answer = service_fn(move |_| {
                let body = body.clone();

                async move {
                  Ok::<_, Infallible>(
                    Response::builder()
                      .status(StatusCode::from_u16(status).unwrap())
                      .header("content-type", "application/json")
                      .body(Full::new(Bytes::from(body)))
                      .unwrap(),
                  )
                }
              });
              let _ = http1::Builder::new()
                .keep_alive(false)
                .serve_connection(TokioIo::new(stream), answer)
                .await;
            }
          }
        });
      }
    });

    Turns {
      address,
      taken,
      serving,
    }
  }

  /// How many connections the stand-in has taken.
  pub fn taken(&self) -> usize {
    self.taken.load(Ordering::SeqCst)
  }
}

impl Drop for Turns {
  fn drop(&mut self) {
    self.serving.abort();
  }
}
