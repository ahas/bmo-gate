//! A record put into the owner's language (bmo-job's `docs/worker-language.md`, 「What a worker writes onto an
//! item」): an agent writes English and the owner reads the item in Korean, so each English part of what bmo-job
//! hands over is rendered by the translator gate and checked before it stands. A rendering whose numbered or
//! bulleted lines ran together, which handed a paragraph back in English, changed a fenced block or used a term the
//! owner banned is asked for again with its own answer and what is wrong named; one still wrong after the last ask
//! leaves the part in its original, and a banned term that stays is said in the log. A rendering that passed every
//! check is kept under the English part and what it was told it is, and read back before the gate is asked, so the
//! same English is rendered once.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use gate_markup::dashes::without_dashes;
use gate_markup::english::EnglishTest;
use gate_markup::text::fenced_blocks;
use gate_markup::wording::{BannedTerm, banned_terms_in, banned_terms_line};
use gate_policy::prompts;
use gate_policy::translation::TRANSLATION;
use gate_runs::GateError;
use regex::Regex;

use crate::Stages;
use crate::document_translation::{Kept, Outcome, translate_part};
use crate::markdown::{TRANSLATION_PART_TOKENS, shown_part, translation_parts};
use crate::markdown_shape::{list_shape, prose_blocks};
use crate::translator::{Ask, STAGE, keep_under, recalled_under};

/// The rulebook the record instructions stand on.
pub const PLAIN_WRITING: &str = "plain-writing";

// The documents a part's rendering is kept under, each named also for what the part was told it is.
const KEPT_KOREAN: &str = "record-ko";

/// The instructions a text is read by into the language a worker reads.
pub fn worker_system() -> Option<&'static str> {
  prompts::read(&format!("{STAGE}/worker.md"))
}

/// The instructions a record is read by into the owner's language: the plain-writing rulebook ahead of the record
/// instructions.
pub async fn record_system(stages: &Stages) -> Result<String, GateError> {
  let path = format!("{STAGE}/record.md");
  let record =
    prompts::read(&path).ok_or_else(|| GateError::Fault(format!("{path} is not among the prompts")))?;
  let rulebooks = stages
    .runs
    .agency
    .rulebooks(&[PLAIN_WRITING])
    .await
    .map_err(|why| GateError::Fault(why.to_string()))?;
  let rulebook = rulebooks
    .into_iter()
    .find(|rulebook| rulebook.name == PLAIN_WRITING)
    .ok_or_else(|| GateError::Fault(format!("the agency holds no {PLAIN_WRITING} rulebook")))?;

  Ok(format!("{}\n\n{record}", rulebook.text.trim()))
}

// What is wrong with a part's rendering: numbered or bulleted lines run together, a paragraph of the English handed
// back as it came, a fenced block not handed back byte for byte in its place, or a term the owner bans.
struct PartFaults {
  lists_lost: bool,
  left_english: Vec<String>,
  fences_changed: bool,
  banned: Vec<BannedTerm>,
}

static PLAIN_WORD: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(r#"^[("'\[]*[a-z]+[)"'\].,;:!?]*$"#).expect("an ordinary word"));

/// The ordinary lowercase words of a paragraph, punctuation around them read past. Names, versions, figures, paths
/// and flags are not among them: a line made of those reads the same in Korean, and the gate handing it back as it
/// came is a rendering of it, not English left behind.
pub fn plain_words(block: &str) -> usize {
  block.split_whitespace().filter(|token| PLAIN_WORD.is_match(token)).count()
}

// The note a part is asked for again under: the last answer, and each thing wrong with it.
fn correction(korean: &str, faults: &PartFaults) -> String {
  let mut lines = vec![
    "Your last translation of this part was:".to_owned(),
    String::new(),
    korean.to_owned(),
    String::new(),
  ];

  if faults.lists_lost {
    lines.push("It did not keep the lists: every numbered or bulleted item of the source stays an item of its own, on its own line, with its own number or marker.".to_owned());
  }

  if !faults.left_english.is_empty() {
    lines.push("It left these in English; translate them too:".to_owned());
    lines.extend(faults.left_english.iter().map(|block| format!("- {block}")));
  }

  if faults.fences_changed {
    lines.push("It changed a fenced block. Every fenced block of the source stays exactly as written, byte for byte, its opening and closing lines included, in the same order, and no fenced block is added.".to_owned());
  }

  if !faults.banned.is_empty() {
    lines.push(format!(
      "It used words the owner has set aside: {}. Write each as its replacement says.",
      banned_terms_line(&faults.banned)
    ));
  }

  lines.push("Translate the part again, whole.".to_owned());
  lines.join("\n")
}

/// One record's reading under way: the gate's instructions, the glossary the rendering is held to, the English
/// test, what each part is asked of, and what the log says of it — which part stayed in its original and why, and
/// a banned term a rendering kept.
pub struct Record<'a> {
  stages: &'a Stages,
  system: String,
  glossary: Vec<BannedTerm>,
  english: &'a EnglishTest,
  ask: Ask,
  pub log: Vec<String>,
}

impl<'a> Record<'a> {
  pub fn new(
    stages: &'a Stages,
    system: String,
    glossary: Vec<BannedTerm>,
    english: &'a EnglishTest,
    ask: Ask,
  ) -> Self {
    Self {
      stages,
      system,
      glossary,
      english,
      ask,
      log: vec![],
    }
  }

  /// Whether some part of `text`, cut the way a document is, is English prose a person needs put into the owner's
  /// language. An English text quoting the owner in a fence, or naming a Korean term, holds English; a Korean text
  /// naming code does not.
  pub fn holds_english(&self, text: &str) -> bool {
    translation_parts(text, TRANSLATION_PART_TOKENS)
      .iter()
      .any(|part| self.english.written(part))
  }

  fn faults_of(&self, part: &str, korean: &str) -> PartFaults {
    let kept: HashSet<String> = prose_blocks(korean).into_iter().collect();

    PartFaults {
      lists_lost: list_shape(korean) != list_shape(part),
      left_english: prose_blocks(part)
        .into_iter()
        .filter(|block| kept.contains(block) && self.english.written(block) && plain_words(block) >= 6)
        .collect(),
      fences_changed: fenced_blocks(korean) != fenced_blocks(part),
      banned: banned_terms_in(korean, &self.glossary),
    }
  }

  /// One part into the owner's language, or what kept it from coming back. `line` names what a one-line text is
  /// — a title, a state line — so the gate answers it as one. A dash the gate left between words is set right as
  /// every notice's is.
  pub async fn korean_part(&mut self, part: &str, line: Option<&str>) -> Result<String, String> {
    let stages = self.stages;
    let shelf = format!("{KEPT_KOREAN}:{}", line.unwrap_or("text").replace(' ', "-"));

    if let Some(kept) = recalled_under(stages, &shelf, &TRANSLATION.owner_language, part).await
      && banned_terms_in(&kept, &self.glossary).is_empty()
    {
      return Ok(kept);
    }

    let own = match line {
      None => self.system.clone(),
      Some(line) => format!(
        "{}\n\nThis text is the item's {line}: answer one short line in the plain written style, with no full stop the English does not have.",
        self.system
      ),
    };
    let attempts = TRANSLATION.record_attempts.max(1);
    let ask = Arc::clone(&self.ask);
    let mut system = own.clone();
    let mut attempt = 1;

    loop {
      let outcome =
        translate_part(part, &TRANSLATION.owner_language, &Arc::new(system), Kept::Headings, |request| {
          ask(request)
        })
        .await;
      let korean = match outcome {
        Outcome::Translated(text) => without_dashes(&text, false),
        Outcome::Mismatch(lost) => return Err(lost.to_string()),
        Outcome::Unanswered => return Err("the gate did not answer".to_owned()),
      };
      let faults = self.faults_of(part, &korean);
      let whole = !faults.lists_lost && faults.left_english.is_empty() && !faults.fences_changed;

      if whole && faults.banned.is_empty() {
        if let Err(why) = keep_under(stages, &shelf, &TRANSLATION.owner_language, part, &korean).await {
          self.log.push(format!("a part's rendering could not be kept: {why}"));
        }

        return Ok(korean);
      }

      if attempt >= attempts {
        if faults.lists_lost {
          return Err(format!("its numbered or bulleted lines ran together {attempts} times"));
        }

        if let Some(left) = faults.left_english.first() {
          let opening: String = left.chars().take(80).collect();

          return Err(format!("a paragraph came back in English {attempts} times: {opening}"));
        }

        if faults.fences_changed {
          return Err(format!("a fenced block came back changed {attempts} times"));
        }

        self.log.push(format!("the rendering still uses {}", banned_terms_line(&faults.banned)));
        return Ok(korean);
      }

      system = format!("{own}\n\n{}", correction(&korean, &faults));
      attempt += 1;
    }
  }

  /// A whole English text into the owner's language, or what kept one of its parts from coming back: the text cut
  /// the way a document is, a part not in English staying as it was written.
  pub async fn korean_of_record(&mut self, text: &str, line: Option<&str>) -> Result<String, String> {
    let mut joined = String::new();

    for part in translation_parts(text, TRANSLATION_PART_TOKENS) {
      if !self.english.written(&part) {
        joined.push_str(&part);
        continue;
      }

      let korean = self.korean_part(&part, line).await?;
      // The gate trims what it hands back, so a part keeps the blank lines it opened and closed on.
      let opening: String = part.chars().take_while(|char| char.is_whitespace()).collect();

      joined.push_str(&opening);
      joined.push_str(&shown_part(&part, korean.trim_start()));
    }

    Ok(joined)
  }
}
