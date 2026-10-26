//! What the fold asks Laya about one outgoing message (`docs/laya-gates.md`, the output format's gate): never the
//! message whole, but its opening and closing as written and the counts that say how large and how built it is.
//! The shape is fixed to the character, since the checkpoint answers only the state it was trained on, which the
//! training tooling builds from the same markdown the same way; so its lines are counted by the kinds that tooling
//! counts, not read as a markdown parser reads them. Beside it stands the probe the output gate asks Laya with.

use std::sync::LazyLock;

use gate_markup::js;
use gate_policy::laya::{QUESTIONS, wording_for};
use regex::Regex;

use crate::laya::{self, Failure, Probe, Question, Reading, Reply, Request, estimated_tokens};
use crate::ordered::Ordered;

// How much of the message the excerpts may carry, in the generous token count every fit is measured by, and
// what the whole state may take; a text whose escaping swells it has its excerpts cut a quarter at a time.
const HEAD_TOKENS: f64 = 320.0;
const TAIL_TOKENS: f64 = 200.0;
pub const STATE_TOKENS: usize = 768;
const SCALES: [f64; 4] = [1.0, 0.75, 0.5, 0.25];

static ITEM_LINE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!("^[{0}]*(?:[-*+\u{2022}]|[0-9]{{1,3}}[.)])[{0}]+[^{0}]", js::SPACE)).expect("an item")
});
static HEADING_LINE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!("^[{0}]{{0,3}}#{{1,6}}[{0}]+[^{0}]", js::SPACE)).expect("a heading")
});
static FENCE_LINE: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(&format!("^[{0}]*(?:```|~~~)", js::SPACE)).expect("a fence"));
static TABLE_LINE: LazyLock<Regex> =
  LazyLock::new(|| Regex::new(&format!("^[{0}]*\\|", js::SPACE)).expect("a table row"));

fn cost(character: char) -> f64 {
  if (character as u32) < 128 { 0.35 } else { 1.0 }
}

// The longest opening within the budget, ended at a line break where one falls in its latter half.
fn opening(text: &str, budget: f64) -> String {
  let mut spent = 0.0;
  let taken: String = text
    .chars()
    .take_while(|character| {
      spent += cost(*character);
      spent <= budget
    })
    .collect();

  match taken.rfind('\n') {
    Some(end) if js::units(&taken[..end]) as f64 >= js::units(&taken) as f64 / 2.0 => {
      taken[..end].to_owned()
    }
    _ => taken,
  }
}

// The longest closing within the budget, begun at a line break where one falls in its former half.
fn closing(text: &str, budget: f64) -> String {
  let characters = js::chars(text);
  let mut spent = 0.0;
  let mut start = characters.len();

  while start > 0 {
    spent += cost(characters[start - 1]);

    if spent > budget {
      break;
    }

    start -= 1;
  }

  let taken = js::text(&characters[start..]);

  match taken.find('\n') {
    Some(at) if (js::units(&taken[..at]) as f64) < js::units(&taken) as f64 / 2.0 => {
      taken[at + 1..].to_owned()
    }
    _ => taken,
  }
}

fn count(number: usize) -> Ordered {
  Ordered::Number(number.into())
}

fn state_at(text: &str, scale: f64) -> Ordered {
  let head_tokens = HEAD_TOKENS * scale;
  let tail_tokens = TAIL_TOKENS * scale;
  let filled: Vec<&str> = text.split('\n').filter(|line| !js::trim(line).is_empty()).collect();
  let whole = estimated_tokens(text) as f64 <= head_tokens + tail_tokens;
  let mut paragraphs = 0;
  let mut blank = true;

  for line in text.split('\n') {
    let empty = js::trim(line).is_empty();

    if !empty && blank {
      paragraphs += 1;
    }

    blank = empty;
  }

  let matching = |pattern: &Regex| filled.iter().filter(|line| pattern.is_match(line)).count();

  Ordered::map([
    ("head", Ordered::text(if whole { text.to_owned() } else { opening(text, head_tokens) })),
    ("tail", Ordered::text(if whole { String::new() } else { closing(text, tail_tokens) })),
    ("chars", count(text.chars().count())),
    ("lines", count(filled.len())),
    ("paragraphs", count(paragraphs)),
    ("items", count(matching(&ITEM_LINE))),
    ("headings", count(matching(&HEADING_LINE))),
    ("code", count(matching(&FENCE_LINE).div_ceil(2))),
    ("table", count(matching(&TABLE_LINE))),
  ])
}

/// The state of a message as the fold asks Laya about it.
pub fn fold_state(original: &str) -> Ordered {
  let text = js::trim(original);

  for scale in &SCALES[..SCALES.len() - 1] {
    let state = state_at(text, *scale);

    if estimated_tokens(&serde_json::to_string(&state).unwrap_or_default()) <= STATE_TOKENS {
      return state;
    }
  }

  state_at(text, SCALES[SCALES.len() - 1])
}

/// The fold's one question's id, which names it among a checkpoint's learnt wordings too.
pub const FOLD_QUESTION: &str = "fold";

/// The fold as Laya asks it: one yes/no over the markdown reduced to its opening, its closing and its counts, the
/// shape the fold checkpoint was trained on, in the wording that checkpoint learnt (`docs/laya.md`, 「Each gate's
/// probe」). Laya's yes is FOLD and its no is OPEN.
#[derive(Clone)]
pub struct FoldProbe {
  pub question: String,
}

impl Default for FoldProbe {
  /// The fold asked in its gate's own wording.
  fn default() -> Self {
    Self {
      question: QUESTIONS.fold.clone(),
    }
  }
}

impl FoldProbe {
  /// The fold as the checkpoint in this folder is asked it, the folder as the Laya server's health names it; the
  /// gate's own wording where none is named or the checkpoint learnt that one.
  pub fn for_checkpoint(folder: Option<&str>) -> Self {
    Self {
      question: wording_for(folder, FOLD_QUESTION, &QUESTIONS.fold),
    }
  }
}

impl Probe for FoldProbe {
  type Input = String;
  type Verdict = String;

  fn question(&self, input: &String) -> Result<Request, Failure> {
    Ok(Request {
      state: fold_state(input),
      questions: vec![(
        FOLD_QUESTION.to_owned(),
        Question::Noul {
          instructions: self.question.clone(),
        },
      )],
    })
  }

  fn read(&self, reply: &Reply) -> Result<Reading, Failure> {
    laya::noul_reading(reply, FOLD_QUESTION, "FOLD", "OPEN")
  }

  fn verdict_of(&self, label: &str) -> Option<String> {
    ["FOLD", "OPEN"].contains(&label).then(|| label.to_owned())
  }

  fn label_of(&self, verdict: &String) -> String {
    verdict.clone()
  }

  fn truth_of(&self, label: &str, _request: &Request) -> Option<Ordered> {
    Some(Ordered::map([(FOLD_QUESTION, Ordered::Flag(label == "FOLD"))]))
  }

  fn safe_label(&self) -> Option<&str> {
    None
  }
}
