//! The situation-rule matcher and the rows a turn's events wake (the brain's `docs/memories.md`;
//! `docs/reference-selection.md`): for each of a room's standing rules, whether its condition fits this situation
//! and whether the rule is done with — asked of the matcher's model with Laya beside it as its mode says, or of
//! Laya where its road is Laya — the action of every rule that fits attached, and what matched and what is spent
//! handed to the brain. A row waiting on one of the turn's events attaches by the event alone. The matcher has no
//! fallback of its own: the conditions are not handed over in place of a verdict.

use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use gate_markup::js;
use gate_policy::fill_marks;
use gate_policy::laya::QUESTIONS;
use gate_policy::prompts;
use gate_policy::reference::REFERENCE;
use gate_ports::brain::Condition;
use gate_runs::records::{self, Judgement};
use gate_runs::{GateError, GateRequest, route};
use gate_stages::laya::{self, LayaRun, NONE_LABEL, PairKept, Probe, Question, Reading, Reply, Request};
use gate_stages::ordered::Ordered;
use regex::Regex;
use sea_orm::DatabaseConnection;

use crate::fragments::{self, Verdict};
use crate::memories;
use crate::pick::{run_verdict, verdict_line};
use crate::{Entry, Reference, RoomKind, SituationTurn, Source};

/// The matcher's key.
pub const STAGE: &str = "situation-rules";

/// Whether the matcher thinks: judging rules against a situation needs no thinking, as picking slugs does not.
pub const THINKS: bool = false;

/// One rule as the matcher is asked about it: its name, the condition it waits for and the action it asks for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
  pub slug: String,
  pub condition: String,
  pub action: String,
}

impl Candidate {
  fn of(rule: &Condition) -> Self {
    Self {
      slug: rule.slug.clone(),
      condition: rule.condition.clone(),
      action: rule.action.clone(),
    }
  }

  // The pair as one phrase, which both questions are asked about.
  fn text(&self) -> String {
    format!("{}, {}", self.condition, self.action)
  }
}

/// One turn as the matcher is asked it.
#[derive(Clone, Debug)]
pub struct Asked {
  pub room: RoomKind,
  pub message_lines: Vec<String>,
  pub candidates: Vec<Candidate>,
}

/// What the matcher said: the rules whose condition fits, the rules that are done with, and what it said of
/// each where it answered for every one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verdicts {
  pub applies: Vec<String>,
  pub spent: Vec<String>,
  pub answers: Option<Vec<(String, bool, bool)>>,
}

impl Verdicts {
  fn nothing() -> Self {
    Self {
      applies: vec![],
      spent: vec![],
      answers: None,
    }
  }

  fn of_answers(answers: Vec<(String, bool, bool)>) -> Self {
    Self {
      applies: answers
        .iter()
        .filter(|(_, applies, _)| *applies)
        .map(|(slug, _, _)| slug.clone())
        .collect(),
      spent: answers.iter().filter(|(_, _, spent)| *spent).map(|(slug, _, _)| slug.clone()).collect(),
      answers: Some(answers),
    }
  }

  /// Both sides as one comparable label.
  pub fn label(&self) -> String {
    format!("applies={} spent={}", laya::set_label(&self.applies), laya::set_label(&self.spent))
  }

  /// The verdict line of what was said: both sides after their keyword, or the keyword for nothing where no rule
  /// applies and none is spent.
  pub fn verdict(&self) -> String {
    let words = &REFERENCE.verdicts;

    if self.applies.is_empty() && self.spent.is_empty() {
      words.nothing.clone()
    } else {
      verdict_line(&format!("{}: {}", words.matched, self.label()))
    }
  }
}

static ANSWER_LINE: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!(r"(?i)^([a-z0-9-]+)[{0}]+(applies|spent)[{0}]*:[{0}]*(yes|no)$", js::SPACE))
    .expect("an answer line")
});
static SIDES: LazyLock<Regex> = LazyLock::new(|| {
  Regex::new(&format!(r"^applies=([^{0}]+) spent=([^{0}]+)$", js::SPACE)).expect("a label's sides")
});

/// The matcher's answer read against the rules it was offered: both questions for every one of them, or none.
pub fn parse_answer(answer: &str, slugs: &[String]) -> Option<Verdicts> {
  let mut read: Vec<(String, bool)> = vec![];

  for line in answer.split('\n').map(js::trim).filter(|line| !line.is_empty()) {
    let found = ANSWER_LINE.captures(line)?;
    let slug = &found[1];
    let key = format!("{slug}:{}", found[2].to_lowercase());

    if !slugs.iter().any(|offered| offered == slug) || read.iter().any(|(seen, _)| *seen == key) {
      return None;
    }

    read.push((key, found[3].eq_ignore_ascii_case("yes")));
  }

  let offered: Vec<&String> = slugs.iter().fold(vec![], |mut seen, slug| {
    if !seen.contains(&slug) {
      seen.push(slug);
    }

    seen
  });

  if read.len() != offered.len() * 2 {
    return None;
  }

  let said = |key: String| read.iter().find(|(seen, _)| *seen == key).map(|(_, yes)| *yes);

  Some(Verdicts::of_answers(
    offered
      .into_iter()
      .map(|slug| {
        (
          slug.clone(),
          said(format!("{slug}:applies")).unwrap_or_default(),
          said(format!("{slug}:spent")).unwrap_or_default(),
        )
      })
      .collect(),
  ))
}

/// A label's two sides, as sets in their order.
pub fn sides_of(label: &str) -> Option<(Vec<String>, Vec<String>)> {
  let found = SIDES.captures(label)?;
  let set =
    |part: &str| if part == NONE_LABEL { vec![] } else { part.split(',').map(str::to_owned).collect() };

  Some((set(&found[1]), set(&found[2])))
}

/// The matcher as Laya asks it: two yes/no per rule, the state carrying the room's kind beside the situation.
#[derive(Clone, Copy, Debug)]
pub struct SituationProbe;

fn room_word(room: RoomKind) -> &'static str {
  match room {
    RoomKind::Owner => "owner",
    RoomKind::Group => "group",
  }
}

impl Probe for SituationProbe {
  type Input = Asked;
  type Verdict = Verdicts;

  fn question(&self, input: &Asked) -> Result<Request, laya::Failure> {
    if input.candidates.is_empty() {
      return Err("too-large");
    }

    let situation = &QUESTIONS.situation;
    let room = room_word(input.room);
    let mut questions = vec![];

    for candidate in &input.candidates {
      let about = fill_marks(&situation.about, &[("slug", &candidate.slug), ("rule", &candidate.text())]);

      questions.push((
        format!("{}:applies", candidate.slug),
        laya::fit_question(Question::Noul {
          instructions: format!("{} {about}", situation.applies),
        }),
      ));
      questions.push((
        format!("{}:spent", candidate.slug),
        laya::fit_question(Question::Noul {
          instructions: format!("{} {about}", situation.spent),
        }),
      ));
    }

    let state_of = |kept: &[String]| {
      Ordered::map([
        ("room", Ordered::text(room)),
        ("situation", Ordered::List(kept.iter().map(Ordered::text).collect())),
      ])
    };

    Ok(Request {
      state: state_of(&laya::fit_messages(&input.message_lines, state_of)),
      questions,
    })
  }

  fn read(&self, reply: &Reply) -> Result<Reading, laya::Failure> {
    let (mut applies, mut spent) = (vec![], vec![]);
    let mut confidence: f64 = 1.0;

    for (id, _) in &reply.answers {
      let reading = laya::noul_reading(reply, id, "yes", "no")?;
      let (slug, question) = id.rsplit_once(':').unwrap_or((id.as_str(), ""));

      if reading.label == "yes" {
        if question == "applies" { &mut applies } else { &mut spent }.push(slug.to_owned());
      }

      confidence = confidence.min(reading.confidence);
    }

    Ok(Reading {
      label: Verdicts {
        applies,
        spent,
        answers: None,
      }
      .label(),
      confidence,
    })
  }

  fn verdict_of(&self, label: &str) -> Option<Verdicts> {
    sides_of(label).map(|(applies, spent)| Verdicts {
      applies,
      spent,
      answers: None,
    })
  }

  fn label_of(&self, verdict: &Verdicts) -> String {
    verdict.label()
  }

  fn truth_of(&self, label: &str, request: &Request) -> Option<Ordered> {
    let (applies, spent) = sides_of(label)?;

    Some(Ordered::map(request.questions.iter().map(|(id, _)| {
      let (slug, question) = id.rsplit_once(':').unwrap_or((id.as_str(), ""));
      let side = if question == "applies" { &applies } else { &spent };

      (id.clone(), Ordered::Flag(side.iter().any(|one| one == slug)))
    })))
  }

  fn safe_label(&self) -> Option<&str> {
    None
  }
}

/// One call's prompt: the rules it may answer about, then the situation to judge them against, and the answer
/// file closing them where there is one.
pub fn request(
  system: &str,
  answer: &str,
  candidates: &[Candidate],
  message_lines: &[String],
) -> GateRequest {
  let mut lines = vec!["RULES:".to_owned()];

  lines.extend(
    candidates
      .iter()
      .map(|candidate| format!("- {} \u{2014} {}", candidate.slug, candidate.text())),
  );
  lines.push(String::new());
  lines.push("SITUATION:".to_owned());
  lines.extend(message_lines.iter().cloned());

  if !answer.is_empty() {
    lines.extend([String::new(), answer.to_owned()]);
  }

  let mut asked = GateRequest::new(system, lines.join("\n"));

  asked.thinking = THINKS;
  asked
}

/// Where a matched row's action stands in a turn's log.
pub fn rule_path(slug: &str) -> String {
  format!("situation-rule/{slug}")
}

// One side of what a run said of each rule, a row per rule and question.
async fn keep(
  db: &DatabaseConnection,
  chat_id: i64,
  message_id: Option<i64>,
  laya_side: bool,
  verdicts: &Verdicts,
) {
  let Some(answers) = &verdicts.answers else { return };
  let rows: Vec<Verdict> = answers
    .iter()
    .flat_map(|(slug, applies, spent)| {
      [("applies", *applies), ("spent", *spent)].map(|(question, said)| (slug, question, said))
    })
    .map(|(slug, question, said)| Verdict {
      stage: STAGE.to_owned(),
      chat_id,
      message_id,
      slug: format!("{slug}:{question}"),
      llm: (!laya_side).then_some(said),
      laya: laya_side.then_some(said),
      attached: None,
    })
    .collect();

  fragments::record_verdicts(db, &rows).await;
}

/// One turn of the matcher: asked, its judgement and each rule's verdicts written, and what it said handed
/// back; none where it gave no reading. A stop is raised.
pub async fn judge(
  reference: &Reference,
  turn: &SituationTurn,
  candidates: &[Candidate],
) -> Result<Option<Verdicts>, GateError> {
  if candidates.is_empty() {
    return Ok(None);
  }

  let stages = &reference.stages;
  let db = &stages.runs.db;
  let (chat_id, message_id, round) = (turn.chat_id, turn.message_id, turn.round.as_deref());
  let message_lines = &turn.message_lines;
  let slugs: Vec<String> = candidates.iter().map(|candidate| candidate.slug.clone()).collect();
  let system = prompts::instructions(STAGE)
    .map(str::to_owned)
    .ok_or_else(|| format!("{STAGE}: its instructions are not among the prompts"));
  let ask = |fallback: bool| {
    let (system, slugs) = (system.clone(), slugs.clone());

    async move {
      let started = std::time::Instant::now();
      let answer_file = prompts::answer(STAGE).unwrap_or_default();
      let mut asked = request(&system.map_err(GateError::Fault)?, answer_file, candidates, message_lines);

      asked.chat_id = Some(chat_id);
      asked.message_id = message_id;
      asked.round = round.map(str::to_owned);
      asked.laya_fallback = fallback;

      let answer = stages.runs.run(STAGE, &asked).await?;
      let parsed = answer.as_deref().and_then(|answer| parse_answer(answer, &slugs));
      let verdict = run_verdict(answer.as_deref(), parsed.as_ref(), Verdicts::verdict);

      records::judgement(
        db,
        &Judgement {
          chat_id,
          message_id,
          stage: STAGE,
          verdict: &verdict,
          detail: answer.as_deref(),
          ms: Some(started.elapsed().as_millis() as i64),
          round,
        },
      )
      .await;

      if let (Some(answer), None) = (&answer, &parsed) {
        let shown = js::chars(js::trim(answer));

        eprintln!(
          "situation rules: chat {chat_id} gave an unreadable answer: {}",
          js::text(&shown[..js::within(&shown, 200)])
        );
      }

      if let Some(parsed) = &parsed {
        keep(db, chat_id, message_id, false, parsed).await;
      }

      Ok(parsed)
    }
  };
  // Laya's side of each rule's rows, out of the pair its answer is kept as.
  let kept: PairKept = {
    let (db, slugs) = (db.clone(), slugs.clone());

    Arc::new(move |label, _request| {
      let (db, slugs) = (db.clone(), slugs.clone());

      Box::pin(async move {
        let Some((applies, spent)) = label.as_deref().and_then(sides_of) else { return };
        let answers = slugs
          .iter()
          .map(|slug| (slug.clone(), applies.contains(slug), spent.contains(slug)))
          .collect();

        keep(&db, chat_id, message_id, true, &Verdicts::of_answers(answers)).await;
      })
    })
  };
  let run = LayaRun {
    kept: Some(kept),
    ..LayaRun::of(STAGE, Some(chat_id), message_id)
  };
  let input = Asked {
    room: turn.room,
    message_lines: message_lines.to_vec(),
    candidates: candidates.to_vec(),
  };

  if !route::read(&stages.runs, STAGE).await?.laya {
    return laya::judge_with_laya(stages, &run, &SituationProbe, &input, |_| ask(false)).await;
  }

  let started = std::time::Instant::now();
  let decided =
    laya::judge_on_laya(stages, &run, &SituationProbe, &input, Verdicts::nothing(), |_| ask(true)).await?;
  let failure = decided.failure.unwrap_or_default();
  let detail = match decided.decided_by {
    laya::DecidedBy::Laya => "Laya".to_owned(),
    laya::DecidedBy::Llm => fill_marks(&REFERENCE.decided.by_fallback, &[("failure", failure)]),
    laya::DecidedBy::Default => fill_marks(&REFERENCE.situation.nothing_matched, &[("failure", failure)]),
  };

  records::judgement(
    db,
    &Judgement {
      chat_id,
      message_id,
      stage: STAGE,
      verdict: &decided.verdict.verdict(),
      detail: Some(&detail),
      ms: Some(started.elapsed().as_millis() as i64),
      round,
    },
  )
  .await;

  Ok(Some(decided.verdict))
}

fn fault(why: impl std::fmt::Display) -> GateError {
  GateError::Fault(why.to_string())
}

/// The actions of the rules whose conditions fit the turn, within the matcher's allowance, what matched and what
/// is spent handed to the brain. A rule the round already carries is not offered again.
pub async fn situation_entries(
  reference: &Reference,
  turn: &SituationTurn,
  holds: &HashSet<String>,
) -> Result<Vec<Entry>, GateError> {
  let rules: Vec<Condition> = memories::candidates(reference, turn.chat_id, &turn.agent)
    .await
    .map_err(fault)?
    .into_iter()
    .filter(|rule| !holds.contains(&rule_path(&rule.slug)))
    .collect();

  if turn.message_lines.is_empty() {
    return Ok(vec![]);
  }

  if rules.is_empty() {
    crate::road::no_candidates(reference, turn.chat_id, turn.message_id, turn.round.as_deref(), STAGE)
      .await;
    return Ok(vec![]);
  }

  let candidates: Vec<Candidate> = rules.iter().map(Candidate::of).collect();
  let Some(verdict) = judge(reference, turn, &candidates).await? else {
    return Ok(vec![]);
  };
  let rule_of = |slug: &String| rules.iter().rev().find(|rule| rule.slug == *slug);

  memories::matched(reference, turn.chat_id, &turn.agent, &verdict.applies, &verdict.spent)
    .await
    .map_err(fault)?;

  for slug in &verdict.spent {
    println!("situation rules: chat {} retired {slug} — the matcher read it as spent", turn.chat_id);
  }

  let budget = REFERENCE.situation.budget;
  let mut entries = vec![];
  let mut taken = 0;

  for slug in &verdict.applies {
    let Some(rule) = rule_of(slug) else { continue };
    let size = js::units(&rule.action);

    if taken + size > budget {
      eprintln!(
        "situation rules: chat {} passes over {slug} at {size} characters, which does not fit what is left of its {budget}",
        turn.chat_id
      );
      continue;
    }

    taken += size;
    entries.push(Entry {
      path: rule_path(slug),
      text: rule.action.clone(),
      source: Source::Situation,
      fragment: None,
    });
  }

  Ok(entries)
}

/// The rows the turn's events wake, each attaching its action under its own name within the matcher's allowance;
/// no model is asked. A room whose rows cannot be read this turn loses them and nothing else.
pub async fn event_entries(reference: &Reference, turn: &SituationTurn) -> Vec<Entry> {
  let woken = match memories::woken(reference, turn.chat_id, &turn.agent, &turn.events).await {
    Ok(woken) => woken,
    Err(why) => {
      eprintln!("situation rules: chat {} events could not be read: {why}", turn.chat_id);
      return vec![];
    }
  };
  let budget = REFERENCE.situation.budget;
  let mut entries = vec![];
  let mut taken = 0;

  for memory in woken {
    let size = js::units(&memory.action);

    if taken + size > budget {
      eprintln!(
        "situation rules: chat {} passes over {} at {size} characters, which does not fit what is left of its {budget}",
        turn.chat_id, memory.slug
      );
      continue;
    }

    taken += size;
    entries.push(if memory.kind == "situation" {
      Entry {
        path: rule_path(&memory.slug),
        text: memory.action,
        source: Source::Situation,
        fragment: None,
      }
    } else {
      Entry {
        path: format!("memory/{}", memory.slug),
        text: memory.action,
        source: Source::Memory,
        fragment: None,
      }
    });
  }

  entries
}
