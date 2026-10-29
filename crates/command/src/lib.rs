//! The gate's unit command, `bmo-gate` (`docs/boundary-api.md`, 「The unit command」): the nouns it declares when
//! asked `nouns` — none — and its own `health`, `records` and `import`, each answering in English. A run reads the
//! settings the service reads, and with them the gate's own database and data root.

pub mod health;
pub mod records;
pub mod translate;

use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use gate_server::settings::Settings;
use sea_orm::DatabaseConnection;

/// The variable naming the settings file, and the file read where it names none, in the folder the command runs in.
pub const SETTINGS_VARIABLE: &str = "BMO_GATE_SETTINGS";
pub const SETTINGS_FILE: &str = "settings.toml";

/// Every noun this command carries, as `nouns` prints them: the mouth group's `translate`, whose translator
/// stands on the operations machine beside the gate.
pub const NOUNS: [&str; 1] = ["translate\thome"];

// How many database connections a noun holds.
const CONNECTIONS: u32 = 2;

/// Why a noun ended short: words it cannot read, which end with 2, or work that failed, which ends with 1 after
/// the lines it did print.
#[derive(Debug, PartialEq, Eq)]
pub enum Fault {
  Words(String),
  Failed { lines: Vec<String>, said: String },
}

impl Fault {
  /// Work that failed, with nothing printed before it.
  pub fn failed(said: impl std::fmt::Display) -> Self {
    Self::Failed {
      lines: vec![],
      said: said.to_string(),
    }
  }
}

/// What a noun answers: its lines, or why it ended short.
pub type Answered = Result<Vec<String>, Fault>;

/// The command's words: `nouns`, or one of its own.
#[derive(Parser, Debug)]
#[command(name = "bmo-gate", version, about = "The gate's health, records and archive import")]
pub struct Cli {
  #[command(subcommand)]
  pub noun: Noun,
}

#[derive(Subcommand, Debug)]
pub enum Noun {
  /// Every noun this command carries, one a line.
  Nouns,
  /// Whether the service the settings name answers ready: the deployment's check, and no noun.
  Health,
  /// One text translated into a language: the mouth group's first-class verb.
  Translate(translate::TranslateArgs),
  /// Every row of one of the gate's own tables, one JSON object a line, and no noun.
  Records(records::RecordsArgs),
  /// Moves the old archive's gate tables from the item's export into this store (TODO #1923), and no noun.
  #[command(disable_help_flag = true)]
  Import(ImportArgs),
}

/// What `import` is given.
#[derive(clap::Args, Debug)]
pub struct ImportArgs {
  /// The export directory the item's export hand wrote.
  #[arg(long)]
  pub export: PathBuf,
  /// The PostgreSQL address of this store.
  #[arg(long)]
  pub database: String,
  /// Reads the export and reports what it would write, writing nothing.
  #[arg(long)]
  pub dry_run: bool,
}

/// The settings file this run reads.
pub fn settings_path() -> PathBuf {
  match std::env::var(SETTINGS_VARIABLE) {
    Ok(named) if !named.trim().is_empty() => PathBuf::from(named.trim()),
    _ => PathBuf::from(SETTINGS_FILE),
  }
}

/// The settings this run reads, or why they do not stand.
pub fn settings() -> Result<Settings, Fault> {
  Settings::read(&settings_path()).map_err(|why| Fault::failed(format!("the settings do not stand: {why}")))
}

/// The gate's database as the settings name it, or the one `other` names in its place.
pub async fn database(settings: &Settings, other: Option<&str>) -> Result<DatabaseConnection, Fault> {
  let address = other.unwrap_or(&settings.database);

  gate_store::connect(address, CONNECTIONS)
    .await
    .map_err(|why| Fault::failed(format!("the database: {why}")))
}

/// One noun run on its words, its answer printed.
pub async fn dispatch(noun: Noun) -> Answered {
  match noun {
    Noun::Nouns => Ok(NOUNS.iter().map(|noun| (*noun).to_owned()).collect()),
    Noun::Health => health::health(&settings_path()).await,
    Noun::Translate(args) => translate::translate(&settings_path(), args).await,
    Noun::Records(args) => records::records(args).await,
    Noun::Import(args) => moved(args).await,
  }
}

/// The old archive's gate tables moved into this store: the report printed, and a failure where the
/// count-and-sample compare found one.
async fn moved(args: ImportArgs) -> Answered {
  match gate_store::import::run(&args.database, &args.export, args.dry_run).await {
    Ok(report) => {
      let lines = report.lines();
      if report.sample.failures.is_empty() {
        Ok(lines)
      } else {
        Err(Fault::Failed {
          lines,
          said: format!("{} rows failed to compare", report.sample.failures.len()),
        })
      }
    }
    Err(said) => Err(Fault::failed(said)),
  }
}

/// The lines printed and the code a run ends with, for an answer.
pub fn ended(answered: Answered) -> (Vec<String>, Option<String>, u8) {
  match answered {
    Ok(lines) => (lines, None, 0),
    Err(Fault::Words(said)) => (vec![], Some(said), 2),
    Err(Fault::Failed { lines, said }) => (lines, (!said.is_empty()).then_some(said), 1),
  }
}

/// The command on the words it was started with, the program's name first.
pub async fn main(words: Vec<String>) -> ExitCode {
  let cli = match Cli::try_parse_from(words) {
    Ok(cli) => cli,
    Err(refused) => {
      let _ = refused.print();

      return ExitCode::from(u8::try_from(refused.exit_code()).unwrap_or(2));
    }
  };
  let (lines, said, code) = ended(dispatch(cli.noun).await);

  for line in lines {
    println!("{line}");
  }

  if let Some(said) = said {
    eprintln!("bmo-gate: {said}");
  }

  ExitCode::from(code)
}
