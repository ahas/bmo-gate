//! The translator's readings (`docs/boundary-api.md`, 「For bmo-job」): a text read in a language its reader takes,
//! its parts in another language alone put into it by the translator gate a few at a time, each part standing beside
//! the rest as it did in the original, and the reading kept under the digest of the original exactly as written, so
//! the same original is never translated twice into one language. A text the translator could not render whole has
//! every part that came back read and the rest in its original, and nothing is kept for it, so the next reading asks
//! again.
//!
//! Two readers stand: into the language a worker reads, English, by the worker instructions; and into the owner's
//! language, Korean, by the record instructions and the checks a record is held to (`crate::records`).

use std::sync::Arc;

use futures_util::future::BoxFuture;
use gate_runs::GateRequest;
use sha2::{Digest, Sha256};

use crate::Stages;
use crate::document_translation::{Kept, Outcome, translate_part};
use crate::markdown::{TRANSLATION_PART_TOKENS, korean_parts, shown_part, translation_parts};
use crate::records::Record;
use crate::sql::{one, run};

/// The gate's key.
pub const STAGE: &str = "translator";

/// How many parts are out at the translator at once.
pub const LANES: usize = 3;

/// The language a worker reads, which the worker instructions put a text into.
pub const WORKER_LANGUAGE: &str = "en";

/// The owner's language, which the record instructions put a text into.
pub const OWNER_LANGUAGE: &str = "ko";

/// What a part is asked of: the translator gate, or whatever stands in for it.
pub type Ask = Arc<dyn Fn(GateRequest) -> BoxFuture<'static, Option<String>> + Send + Sync>;

/// Each part asked of the translator gate on its own road; a part it could not answer, or a run somebody stopped,
/// comes back with nothing.
pub fn by_gate(stages: Arc<Stages>) -> Ask {
  Arc::new(move |request: GateRequest| {
    let stages = Arc::clone(&stages);

    Box::pin(async move {
      match stages.runs.run(STAGE, &request).await {
        Ok(answer) => answer,
        Err(why) => {
          eprintln!("{STAGE}: a part could not be translated: {why}");
          None
        }
      }
    })
  })
}

/// Who reads a text into a language: the worker's reader into English, the record's into the owner's language.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reader {
  Worker,
  Record,
}

impl Reader {
  /// The reader of a language, or none for a language the translator does not take.
  pub fn of(language: &str) -> Option<Self> {
    match language {
      WORKER_LANGUAGE => Some(Self::Worker),
      OWNER_LANGUAGE => Some(Self::Record),
      _ => None,
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
  let key = key(original);

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
  worker: &Arc<String>,
  record: &mut Record<'_>,
  ask: &Ask,
) -> Option<String> {
  match reader {
    Reader::Worker => {
      match translate_part(part, language, worker, Kept::Whole, |request| ask(request)).await {
        Outcome::Translated(text) => Some(text),
        Outcome::Mismatch(lost) => {
          eprintln!("{STAGE}: a part stays in its original: {lost}");
          None
        }
        Outcome::Unanswered => None,
      }
    }
    Reader::Record => match record.korean_part(part, None).await {
      Ok(text) => Some(text),
      Err(fault) => {
        record.log.push(format!("a part stays in its original: {fault}"));
        None
      }
    },
  }
}

/// Every original read in `language`, in the order given: one with no part in another language as it stands, one
/// with a reading kept as that, and every other its parts in another language put into it now, a few at a time,
/// and kept where every part came back. None where the language is none a reader takes.
pub async fn readings(
  stages: &Stages,
  language: &str,
  originals: &[String],
  ask: &Ask,
) -> Option<Vec<Read>> {
  let reader = Reader::of(language)?;
  let english = stages.reading.english();
  let foreign = |text: &str, parts: &[String]| -> Vec<bool> {
    match reader {
      Reader::Worker => korean_parts(text, parts),
      Reader::Record => parts.iter().map(|part| english.written(part)).collect(),
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

  let worker = Arc::new(match crate::records::worker_system() {
    Some(system) => system.to_owned(),
    None => {
      eprintln!("{STAGE}: the worker instructions are not among the prompts");
      String::new()
    }
  });
  let system = match reader {
    Reader::Record => crate::records::record_system(stages).await.unwrap_or_else(|why| {
      eprintln!("{STAGE}: the record instructions could not be had: {why}");
      String::new()
    }),
    Reader::Worker => String::new(),
  };
  let glossary = stages.reading.glossary();
  let lanes = tokio::sync::Semaphore::new(LANES);
  let mut asking = Vec::new();

  // Only the parts in another language are asked for; a part already in the language stands as its own reading.
  for at in &wanted {
    let (parts, foreign) = &cuts[*at];

    for (part, foreign) in parts.iter().zip(foreign) {
      if !foreign {
        continue;
      }

      let (lanes, worker, system, glossary, english) = (&lanes, &worker, &system, &glossary, &english);

      asking.push(async move {
        let _lane = lanes.acquire().await.ok();
        let mut record = Record::new(stages, system.clone(), glossary.clone(), english, Arc::clone(ask));
        let answer = part_into(reader, part, language, worker, &mut record, ask).await;

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
