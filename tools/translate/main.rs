//! The `translate` tool's executable: one call handed by the tool host on standard input, answered on standard
//! output (the tool host's `docs/api.md`, 「The call protocol」).

use std::io::Read;
use std::process::ExitCode;

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
  let mut asked = String::new();

  if let Err(error) = std::io::stdin().read_to_string(&mut asked) {
    eprintln!("the call could not be read from standard input: {error}");
    return ExitCode::FAILURE;
  }

  match gate_translate_tool::answer(&asked, |name| std::env::var(name).ok()).await {
    Ok(result) => {
      println!("{result}");
      ExitCode::SUCCESS
    }
    Err(why) => {
      eprintln!("{why}");
      ExitCode::FAILURE
    }
  }
}
