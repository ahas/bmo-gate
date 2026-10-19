//! The road the items are written on: `codex exec`, driven directly and never through the agency's provider switch
//! (docs/gate-eval.md, 「Generation」). It names the tier the set is written on and the answer's schema on every
//! call, in a folder of its own holding nothing.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde_json::Value;
use tokio::io::AsyncWriteExt as _;

pub const CODEX_MODEL: &str = "gpt-5.6-terra";
pub const CODEX_EFFORT: &str = "high";
/// A batch of long items is minutes of writing.
pub const CODEX_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// One run as its event stream tells it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CodexReading {
  pub thread: Option<String>,
  pub text: String,
  pub input_tokens: u64,
  pub cached_tokens: u64,
  pub output_tokens: u64,
  /// Why the turn did not finish, in Codex's own words, or none where it did.
  pub failure: Option<String>,
}

fn said(value: Option<&Value>) -> Option<String> {
  value.and_then(Value::as_str).filter(|text| !text.is_empty()).map(str::to_owned)
}

/// One run as its event stream tells it, one JSON object a line. A line that is no event (the notice Codex
/// prints on taking its prompt from standard input) is passed over, and an item of the error kind is a notice
/// about the run rather than its failure.
pub fn read_codex_events(stream: &str) -> CodexReading {
  let mut reading = CodexReading::default();

  for line in stream.split('\n') {
    let Ok(event) = serde_json::from_str::<Value>(line) else { continue };

    if !event.is_object() {
      continue;
    }

    let kind = event.get("type").and_then(Value::as_str);

    if kind == Some("thread.started") {
      reading.thread = said(event.get("thread_id")).or(reading.thread);
    }

    if kind == Some("item.completed")
      && event.pointer("/item/type").and_then(Value::as_str) == Some("agent_message")
    {
      reading.text = said(event.pointer("/item/text")).unwrap_or(reading.text);
    }

    if kind == Some("turn.completed")
      && let Some(usage) = event.get("usage")
    {
      let count = |name: &str| usage.get(name).and_then(Value::as_u64).unwrap_or_default();

      reading.input_tokens += count("input_tokens");
      reading.cached_tokens += count("cached_input_tokens");
      reading.output_tokens += count("output_tokens") + count("reasoning_output_tokens");
    }

    if matches!(kind, Some("error" | "turn.failed")) && reading.failure.is_none() {
      reading.failure = Some(
        said(event.get("message"))
          .or_else(|| said(event.pointer("/error/message")))
          .unwrap_or(event.to_string()),
      );
    }
  }

  reading
}

/// The command one batch is: a new thread, or the thread it continues, with the model, the effort and the
/// answer's schema named on every call.
pub fn codex_command(thread: Option<&str>, schema_path: &Path) -> Vec<String> {
  let mut command = vec!["codex".to_owned(), "exec".to_owned()];

  if let Some(thread) = thread {
    command.extend(["resume".to_owned(), thread.to_owned()]);
  }

  command.extend(
    [
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "-m",
      CODEX_MODEL,
      "-c",
      &format!("model_reasoning_effort={CODEX_EFFORT}"),
      "--output-schema",
      &schema_path.to_string_lossy(),
      "-",
    ]
    .map(str::to_owned),
  );
  command
}

/// How a gate's batches are asked: the schema its answers are held to written where Codex is pointed at it, and
/// one batch asked on the thread it continues with its prompt.
pub trait CodexRun: Send + Sync {
  fn schema_file(&self, name: &str, shape: &Value) -> Result<PathBuf, String>;

  fn run<'a>(
    &'a self,
    thread: Option<&'a str>,
    schema_path: &'a Path,
    prompt: &'a str,
  ) -> BoxFuture<'a, CodexReading>;
}

/// Codex itself, started in a folder of this process's own holding nothing, so no checkout's instruction file
/// reaches it, with the schema files in another beside it.
pub struct Codex {
  cwd: tempfile::TempDir,
  schemas: tempfile::TempDir,
}

impl Codex {
  pub fn new() -> Result<Self, String> {
    let folder = |prefix: &str| {
      tempfile::Builder::new()
        .prefix(prefix)
        .tempdir()
        .map_err(|why| format!("a folder for Codex: {why}"))
    };

    Ok(Self {
      cwd: folder("gate-eval-cwd-")?,
      schemas: folder("gate-eval-schema-")?,
    })
  }
}

impl CodexRun for Codex {
  fn schema_file(&self, name: &str, shape: &Value) -> Result<PathBuf, String> {
    let path = self.schemas.path().join(format!("{name}.json"));

    std::fs::write(&path, shape.to_string()).map_err(|why| format!("{}: {why}", path.display()))?;

    Ok(path)
  }

  // The prompt goes in on standard input and the stream is closed behind it, since Codex left holding an open
  // input waits on it.
  fn run<'a>(
    &'a self,
    thread: Option<&'a str>,
    schema_path: &'a Path,
    prompt: &'a str,
  ) -> BoxFuture<'a, CodexReading> {
    Box::pin(async move {
      let command = codex_command(thread, schema_path);
      let spawned = tokio::process::Command::new(&command[0])
        .args(&command[1..])
        .current_dir(self.cwd.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn();
      let mut child = match spawned {
        Ok(child) => child,
        Err(why) => {
          return CodexReading {
            failure: Some(format!("codex could not start: {why}")),
            ..CodexReading::default()
          };
        }
      };

      // Written beside the reading, so a long prompt never waits on an answer nobody is reading yet.
      if let Some(mut input) = child.stdin.take() {
        let prompt = prompt.to_owned();

        tokio::spawn(async move {
          let _ = input.write_all(prompt.as_bytes()).await;
        });
      }

      let Ok(ran) = tokio::time::timeout(CODEX_TIMEOUT, child.wait_with_output()).await else {
        return CodexReading {
          failure: Some(format!("no answer within {} seconds", CODEX_TIMEOUT.as_secs())),
          ..CodexReading::default()
        };
      };

      match ran {
        Err(why) => CodexReading {
          failure: Some(format!("codex could not be read: {why}")),
          ..CodexReading::default()
        },
        Ok(output) => {
          let mut reading = read_codex_events(&String::from_utf8_lossy(&output.stdout));
          let err = String::from_utf8_lossy(&output.stderr).trim().to_owned();

          if reading.failure.is_none() && reading.text.is_empty() && !output.status.success() {
            let code = output.status.code().unwrap_or(-1);
            let tail: String =
              err.chars().rev().take(2_000).collect::<Vec<_>>().into_iter().rev().collect();

            reading.failure = Some(if err.is_empty() { format!("codex exited {code}") } else { tail });
          }

          reading
        }
      }
    })
  }
}
