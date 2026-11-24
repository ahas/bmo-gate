//! The translator's readings (`docs/boundary-api.md`, 「For bmo-job」): a text read in a language its reader takes,
//! its parts in another language alone put into it by the agency's translation line (`docs/boundary-api.md`, 「The
//! translation line」), no more out at once across every reading standing than the translation policy's bound
//! (`docs/api.md`, 「Translations」), each part standing beside
//! the rest as it did in the original, and the reading kept under the digest of the original exactly as written, so
//! the same original is never translated twice into one language. A text the translator could not render whole has
//! every part that came back read and the rest in its original, and nothing is kept for it, so the next reading asks
//! again.
//!
//! Three readers stand: into the language a worker reads, the line's `worker` purpose; into the owner's language,
//! its `record` purpose, with the checks a record is held to (`crate::records`); and into any other language the
//! policy names the scripts of, for a person reading the console in it, its `document` purpose with the structure a
//! document's part is held to. Which language each reads into is the policy's (`gate_policy::translation`).

use std::sync::Arc;

use futures_util::future::BoxFuture;
use gate_policy::translation::{TRANSLATION, Translation};
use gate_ports::PortError;
use gate_ports::agency::TranslationAsk;
use sha2::{Digest, Sha256};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::Stages;
use crate::document_translation::{Kept, Outcome, translate_part};
use crate::markdown::{Scripts, TRANSLATION_PART_TOKENS, korean_parts, shown_part, translation_parts};
use crate::records::Record;
use crate::sql::{one, run};

/// The name the translation's lines are told under.
pub const STAGE: &str = "translator";

/// The most originals one reading carries.
pub const CALL_ORIGINALS: usize = 16;

/// The most originals standing at once across the readings, read or waiting for the translator.
pub const STANDING_ORIGINALS: usize = 64;

/// Where the readings queue for the translator: the places of the parts out at once, shared by every reading
/// standing and taken in the order asked, and the count of originals standing, read or waiting.
pub struct Intake {
  lanes: Semaphore,
  standing: Arc<Semaphore>,
}

/// Why a reading was not taken in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Turned {
  /// It carries more originals than one reading takes.
  TooMany,
}

/// A reading's originals standing in the intake until it is dropped.
pub struct Admitted(#[allow(dead_code)] Option<OwnedSemaphorePermit>);

impl Intake {
  /// An intake of so many parts out at once and so many originals standing.
  pub fn new(lanes: usize, standing: usize) -> Self {
    Self {
      lanes: Semaphore::new(lanes.max(1)),
      standing: Arc::new(Semaphore::new(standing)),
    }
  }

  /// The intake the policy bounds: as many parts out as the translation policy's `lanes`, and
  /// `STANDING_ORIGINALS`.
  pub fn of_policy() -> Self {
    Self::new(TRANSLATION.lanes, STANDING_ORIGINALS)
  }

  /// The originals of one reading taken in, or why not: never more than `CALL_ORIGINALS`. A reading that would
  /// take those standing past their bound waits in line until enough of them are given back, however long that
  /// takes.
  pub async fn admit(&self, originals: usize) -> Result<Admitted, Turned> {
    if originals > CALL_ORIGINALS {
      return Err(Turned::TooMany);
    }
    if originals == 0 {
      return Ok(Admitted(None));
    }

    let permit = Arc::clone(&self.standing)
      .acquire_many_owned(originals as u32)
      .await
      .expect("the intake's places are never closed");

    Ok(Admitted(Some(permit)))
  }
}

/// What a part is translated for, as the agency's translation line takes it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
  /// A part of a document the viewer asked for, or of a text read into a language a person reads the console in.
  Document,
  /// A text read into the language a worker reads.
  Worker,
  /// A worker's record read into the owner's language.
  Record,
}

impl Purpose {
  /// The line's word for it.
  pub fn word(self) -> &'static str {
    match self {
      Self::Document => "document",
      Self::Worker => "worker",
      Self::Record => "record",
    }
  }
}

/// One part asked of the line: what it is for, the target language by its tag, the text, and the gate's word on
/// it where it has one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Asked {
  pub purpose: Purpose,
  pub target: String,
  pub text: String,
  pub note: Option<String>,
}

/// What the line made of one part: its translation, a refusal saying it is past the model's window, or no answer
/// with why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ran {
  Translated(String),
  TooLarge,
  Unanswered(String),
}

/// What a part is asked of: the agency's translation line, or whatever stands in for it.
pub type Ask = Arc<dyn Fn(Asked) -> BoxFuture<'static, Ran> + Send + Sync>;

/// The code the line refuses a part past the model's window with.
pub const TOO_LARGE: &str = "too-large";

/// Whether the line refused a part as past the model's window.
pub fn past_window(why: &PortError) -> bool {
  matches!(why, PortError::Refused { code, .. } if code == TOO_LARGE)
}

/// Each part asked of the agency's translation line, the target named as the policy names it.
pub fn by_agency(stages: Arc<Stages>) -> Ask {
  Arc::new(move |asked: Asked| {
    let stages = Arc::clone(&stages);

    Box::pin(async move {
      let language = TRANSLATION.language_name(&asked.target).unwrap_or(&asked.target).to_owned();
      let ask = TranslationAsk {
        purpose: asked.purpose.word().to_owned(),
        language,
        text: asked.text,
        note: asked.note,
      };

      match stages.runs.agency.translation_run(&ask).await {
        Ok(run) => Ran::Translated(run.text),
        Err(why) if past_window(&why) => Ran::TooLarge,
        Err(why) => Ran::Unanswered(why.to_string()),
      }
    })
  })
}

/// Who reads a text into a language: the worker's reader into the language a worker reads, the record's into the
/// owner's language, and the viewer's into any other language the policy names the scripts of, each as the policy
/// names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
  Worker,
  Record,
  Viewer,
}

impl Reader {
  /// The reader of a language under the gate's policy, or none for a language no reader takes.
  pub fn of(language: &str) -> Option<Self> {
    Self::under(&TRANSLATION, language)
  }

  /// The reader of a language under `policy`, or none for a language no reader takes.
  pub fn under(policy: &Translation, language: &str) -> Option<Self> {
    if language == policy.worker_language {
      Some(Self::Worker)
    } else if language == policy.owner_language {
      Some(Self::Record)
    } else {
      policy.language_scripts(language).and_then(Scripts::of).map(|_| Self::Viewer)
    }
  }

  /// What the agency's translation line is asked to translate a part for, for this reader.
  pub fn purpose(self) -> Purpose {
    match self {
      Self::Worker => Purpose::Worker,
      Self::Record => Purpose::Record,
      Self::Viewer => Purpose::Document,
    }
  }
}

// The name an original's reading is kept under: the digest of the original exactly as written.
fn key(text: &str) -> String {
  format!("{:x}", Sha256::digest(text.as_bytes()))
}

// The documents a whole reading in a language is kept under.
fn shelf(language: &str) -> String {
  format!("worker-{language}")
}

/// The reading kept for an original in the translation table, under the digest of the original exactly as written,
/// in the documents `prefix` names and the language `target`, where one is kept. Never asks the translator.
pub async fn recalled_under(stages: &Stages, prefix: &str, target: &str, original: &str) -> Option<String> {
  recalled_by_key(stages, prefix, target, key(original)).await
}

// The reading kept under an original's digest, as `recalled_under` reads it.
async fn recalled_by_key(stages: &Stages, prefix: &str, target: &str, key: String) -> Option<String> {
  one(
    &stages.runs.db,
    r#"SELECT "text" FROM "document_translations" WHERE "document" = $1 AND "version" = $2 AND "target" = $3 ORDER BY "part" LIMIT 1"#,
    vec![format!("{prefix}:{key}").into(), key.into(), target.into()],
  )
  .await
  .ok()
  .flatten()
  .and_then(|row| row.try_get::<Option<String>>("", "text").ok().flatten())
}

/// A reading kept for an original as `recalled_under` reads it back, in place of any kept before.
pub async fn keep_under(
  stages: &Stages,
  prefix: &str,
  target: &str,
  original: &str,
  reading: &str,
) -> Result<(), sea_orm::DbErr> {
  let key = key(original);
  let document = format!("{prefix}:{key}");
  let db = &stages.runs.db;

  run(
    db,
    r#"INSERT INTO "document_translations" ("document", "version", "target", "part", "parts", "text", "failed", "translated_at")
       VALUES ($1, $2, $3, 0, 1, $4, 0, $5)
       ON CONFLICT ("document", "target", "version", "part") DO UPDATE SET
         "parts" = excluded."parts", "text" = excluded."text", "failed" = excluded."failed", "translated_at" = excluded."translated_at""#,
    vec![
      document.as_str().into(),
      key.as_str().into(),
      target.into(),
      reading.into(),
      gate_runs::records::now().into(),
    ],
  )
  .await?;
  run(
    db,
    r#"DELETE FROM "document_translations" WHERE "document" = $1 AND "target" = $2 AND "version" <> $3"#,
    vec![document.into(), target.into(), key.into()],
  )
  .await?;

  Ok(())
}

/// The kept reading of an original in a language, where one is kept. Never asks the translator.
pub async fn recalled(stages: &Stages, language: &str, original: &str) -> Option<String> {
  recalled_under(stages, &shelf(language), language, original).await
}

/// The kept reading in a language of the original whose digest is `digest`, the SHA-256 of the original exactly
/// as written in lowercase hex, where one is kept. Never asks the translator.
pub async fn recalled_digest(stages: &Stages, language: &str, digest: &str) -> Option<String> {
  recalled_by_key(stages, &shelf(language), language, digest.to_owned()).await
}

/// Whether a text is a digest as `recalled_digest` reads one: 64 lowercase hex characters.
pub fn is_digest(text: &str) -> bool {
  text.len() == 64 && text.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A reading kept as the one an original reads as in a language: a worker's own English kept as the reading of the
/// Korean a record was rendered into, so a worker reading it later is handed the English that was written.
pub async fn keep(
  stages: &Stages,
  language: &str,
  original: &str,
  text: &str,
) -> Result<(), sea_orm::DbErr> {
  keep_under(stages, &shelf(language), language, original, text).await
}

// A slot every original holds by the end; one that somehow holds none reads as empty and not whole.
fn unread() -> Read {
  Read {
    text: String::new(),
    whole: false,
  }
}

/// One original's reading: its text, and whether every part of it that needed one was rendered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Read {
  pub text: String,
  pub whole: bool,
}

// What one part came to, by its reader.
async fn part_into(
  reader: Reader,
  part: &str,
  language: &str,
  record: &mut Record<'_>,
  ask: &Ask,
) -> Option<String> {
  match reader {
    Reader::Record => match record.korean_part(part, None).await {
      Ok(text) => Some(text),
      Err(fault) => {
        record.log.push(format!("a part stays in its original: {fault}"));
        None
      }
    },
    Reader::Worker | Reader::Viewer => {
      match translate_part(part, language, reader.purpose(), Kept::Whole, None, ask).await {
        Outcome::Translated(text) => Some(text),
        Outcome::Mismatch(lost) => {
          eprintln!("{STAGE}: a part stays in its original: {lost}");
          None
        }
        Outcome::Unanswered => None,
      }
    }
  }
}

/// Every original read in `language`, in the order given: one with no part in another language as it stands, one
/// with a reading kept as that, and every other its parts in another language put into it now, each waiting for a
/// place among the intake's lanes, and kept where every part came back. None where the language is none a reader
/// takes.
pub async fn readings(
  stages: &Stages,
  intake: &Intake,
  language: &str,
  originals: &[String],
  ask: &Ask,
) -> Option<Vec<Read>> {
  let reader = Reader::of(language)?;
  let english = stages.reading.english();
  let scripts = TRANSLATION.language_scripts(language).and_then(Scripts::of);
  let foreign = |text: &str, parts: &[String]| -> Vec<bool> {
    match (reader, &scripts) {
      (Reader::Worker, _) => korean_parts(text, parts),
      (Reader::Record, _) => parts.iter().map(|part| english.written(part)).collect(),
      (Reader::Viewer, Some(scripts)) => scripts.foreign_parts(text, parts),
      (Reader::Viewer, None) => vec![false; parts.len()],
    }
  };
  let cuts: Vec<(Vec<String>, Vec<bool>)> = originals
    .iter()
    .map(|text| {
      let parts = translation_parts(text, TRANSLATION_PART_TOKENS);
      let foreign = foreign(text, &parts);

      (parts, foreign)
    })
    .collect();
  let mut read: Vec<Option<Read>> = Vec::with_capacity(originals.len());

  for (text, (_, foreign)) in originals.iter().zip(&cuts) {
    read.push(if foreign.contains(&true) {
      recalled(stages, language, text).await.map(|text| Read { text, whole: true })
    } else {
      Some(Read {
        text: text.clone(),
        whole: true,
      })
    });
  }

  let wanted: Vec<usize> = (0..originals.len()).filter(|at| read[*at].is_none()).collect();

  if wanted.is_empty() {
    return Some(read.into_iter().map(|one| one.unwrap_or_else(unread)).collect());
  }

  let glossary = stages.reading.glossary();
  let lanes = &intake.lanes;
  let mut asking = Vec::new();

  // Only the parts in another language are asked for; a part already in the language stands as its own reading.
  for at in &wanted {
    let (parts, foreign) = &cuts[*at];

    for (part, foreign) in parts.iter().zip(foreign) {
      if !foreign {
        continue;
      }

      let (glossary, english) = (&glossary, &english);

      asking.push(async move {
        let _lane = lanes.acquire().await.ok();
        let mut record = Record::new(stages, glossary.clone(), english, Arc::clone(ask));
        let answer = part_into(reader, part, language, &mut record, ask).await;

        for line in &record.log {
          eprintln!("{STAGE}: {line}");
        }

        answer
      });
    }
  }

  let answered: Vec<Option<String>> = futures_util::future::join_all(asking).await;
  let mut answers = answered.into_iter();

  for at in wanted {
    let (parts, foreign) = &cuts[at];
    let mine: Vec<Option<String>> = parts
      .iter()
      .zip(foreign)
      .map(|(part, foreign)| if *foreign { answers.next().flatten() } else { Some(part.clone()) })
      .collect();
    // The gate trims what it hands back, so a part keeps the blank lines it opened on as well as those it closed
    // on, and the parts joined stand apart as they did in the original.
    let joined: String = parts
      .iter()
      .zip(foreign)
      .zip(&mine)
      .map(|((part, foreign), outcome)| match outcome {
        Some(text) if *foreign => {
          let opening: String = part.chars().take_while(|char| char.is_whitespace()).collect();

          format!("{opening}{}", shown_part(part, text.trim_start()))
        }
        _ => part.clone(),
      })
      .collect();
    let whole = mine.iter().all(Option::is_some);

    if whole && let Err(why) = keep(stages, language, &originals[at], &joined).await {
      eprintln!("{STAGE}: a reading could not be kept: {why}");
    }

    read[at] = Some(Read {
      text: joined,
      whole,
    });
  }

  Some(read.into_iter().map(|one| one.unwrap_or_else(unread)).collect())
}
