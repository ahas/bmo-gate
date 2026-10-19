//! The Python suites of the Laya runtime and training under `tests/python/` (docs/layout.md, 「The rules the layout
//! keeps」), run by this Cargo test so one `cargo test` runs every test of the repository: the decision server's, the
//! training scripts' and the shared waits' on the system's Python, which is all they need — a test that needs torch
//! skips itself where the interpreter has none — and the front's on the packages its `pyproject.toml` pins,
//! through `uv`. Their output is shown where any fails.

use std::process::Command;

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

// The front's packages, as `runtime/front/pyproject.toml` pins them.
const FRONT_PACKAGES: [&str; 5] =
  ["mcp==2.2.0", "httpx==0.28.1", "starlette==1.7.0", "uvicorn==0.53.0", "websockets==17.1"];

// One suite discovered under its folder by the Python `command` starts, its output kept for a failure to show.
fn suite(mut command: Command, folder: &str) {
  let ran = command
    .args(["python3", "-B", "-m", "unittest", "discover", "-s", folder])
    .current_dir(ROOT)
    .output()
    .unwrap_or_else(|why| panic!("the Python of {folder} runs: {why}"));
  let said = format!("{}{}", String::from_utf8_lossy(&ran.stdout), String::from_utf8_lossy(&ran.stderr));

  assert!(ran.status.success(), "the tests under {folder} failed:\n{said}");
  assert!(said.contains("\nOK"), "the tests under {folder} did not end OK:\n{said}");
}

// The system's own Python.
fn system() -> Command {
  Command::new("env")
}

#[test]
fn the_decision_servers_tests_pass() {
  suite(system(), "tests/python/laya-server");
}

#[test]
fn the_training_scripts_tests_pass() {
  suite(system(), "tests/python/training");
}

#[test]
fn the_shared_waits_tests_pass() {
  suite(system(), "tests/python/support");
}

#[test]
fn the_fronts_tests_pass_on_its_pinned_packages() {
  let mut uv = Command::new("uv");

  uv.args(["run", "--no-project", "--python", "3.12"]);

  for package in FRONT_PACKAGES {
    uv.args(["--with", package]);
  }

  suite(uv, "tests/python/front");
}

#[test]
fn the_fronts_pins_are_its_pyproject_s() {
  let pinned =
    std::fs::read_to_string(format!("{ROOT}/runtime/front/pyproject.toml")).expect("the front's pyproject");

  for package in FRONT_PACKAGES {
    assert!(
      pinned.contains(&format!("\"{package}\"")),
      "{package} is not what runtime/front/pyproject.toml pins"
    );
  }
}
