//! How often Laya agrees with each gate's LLM (`docs/laya.md`, 「Agreement」), read back from the verdict record:
//! per gate, over its pairs where both gave a verdict — or, for a gate settled one question at a time, over its
//! questions — the agreement, and at each tau of the grid the share Laya would settle and the agreement within it.
//! It is what the owner reads before choosing a gate's tau and moving it off shadow.

use gate_markup::text::{count_text, fixed};
use gate_policy::fill_marks;
use gate_policy::profiles::PROFILES;
use gate_words::laya_agreement as words;
use sea_orm::{DatabaseConnection, DbErr};
use serde::Serialize;
use serde_json::Value;

use crate::sql::all;

/// The confidences the agreement is counted at, as the console's agent management screen counts them.
pub const TAU_GRID: [f64; 7] = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.99];

/// One recorded pair without its input, which is what the agreement is counted from.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct PairRow {
  pub stage: String,
  pub confidence: Option<f64>,
  pub llm_verdict: Option<String>,
  pub laya_verdict: Option<String>,
  pub laya_safe: Option<bool>,
  pub llm_safe: Option<bool>,
  pub failure: Option<String>,
}

/// One tau of a gate settled one question at a time: how many of its compared questions Laya was that sure of,
/// and how many of those it answered as the LLM did.
#[derive(Clone, Debug, PartialEq)]
pub struct TallyAt {
  pub tau: f64,
  pub sure: usize,
  pub agreed: usize,
}

/// A gate settled one question at a time, counted over its questions: of those Laya answered, how many it
/// settled for the gate; of those the LLM's verdict also speaks of, how many Laya answered as the LLM did; and
/// the same at each tau, by the question's own confidence.
#[derive(Clone, Debug, PartialEq)]
pub struct QuestionTally {
  pub stage: String,
  pub asked: usize,
  pub settled: usize,
  pub compared: usize,
  pub agreed: usize,
  pub by_tau: Vec<TallyAt>,
}

/// One gate's figures at one tau.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct AgreementAt {
  pub tau: f64,
  /// The share of pairs Laya would settle at this tau, and how often it agrees with the LLM on them.
  pub coverage: Option<f64>,
  pub agreement: Option<f64>,
  /// For a gate with a safe verdict: how many pairs Laya called safe at this tau, and how often the LLM called
  /// them safe too.
  pub safe_count: Option<usize>,
  pub safe_agreement: Option<f64>,
}

/// What a gate's figures are counted over.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Unit {
  Pair,
  Question,
}

/// One gate's agreement between Laya and its LLM.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Agreement {
  pub stage: String,
  pub unit: Unit,
  /// The pairs compared, or for a gate counted by question its questions compared.
  pub pairs: usize,
  pub failures: usize,
  pub agreement: Option<f64>,
  pub by_tau: Vec<AgreementAt>,
  /// For a gate counted by question: the share of the questions Laya answered that it settled for the gate.
  pub settled: Option<f64>,
}

fn share(part: usize, whole: usize) -> Option<f64> {
  (whole > 0).then(|| part as f64 / whole as f64)
}

/// Every recorded pair of the gate named, or of every gate, oldest first.
pub async fn read_pairs(db: &DatabaseConnection, stage: Option<&str>) -> Result<Vec<PairRow>, DbErr> {
  let rows = all(
    db,
    r#"SELECT "stage", "confidence", "llm_verdict", "laya_verdict", "laya_safe", "llm_safe", "failure"
       FROM "laya_verdicts" WHERE ($1::text IS NULL OR "stage" = $1) ORDER BY "id""#,
    vec![stage.map(str::to_owned).into()],
  )
  .await?;
  let flag = |row: &sea_orm::QueryResult, column: &str| {
    row.try_get::<Option<i64>>("", column).ok().flatten().map(|value| value != 0)
  };

  Ok(
    rows
      .iter()
      .map(|row| PairRow {
        stage: row.try_get("", "stage").unwrap_or_default(),
        confidence: row.try_get("", "confidence").ok().flatten(),
        llm_verdict: row.try_get("", "llm_verdict").ok().flatten(),
        laya_verdict: row.try_get("", "laya_verdict").ok().flatten(),
        laya_safe: flag(row, "laya_safe"),
        llm_safe: flag(row, "llm_safe"),
        failure: row.try_get("", "failure").ok().flatten(),
      })
      .collect(),
  )
}

/// One question of a row the LLM's verdict says what it should have been: how sure Laya was of its answer, and
/// whether that answer in the LLM's terms is what the LLM said; none where either side gave nothing to compare.
pub struct Compared {
  pub confidence: Option<f64>,
  pub agrees: Option<bool>,
}

fn parsed(text: &str) -> Value {
  serde_json::from_str(text).unwrap_or(Value::Null)
}

// How many questions a row's answers hold: an object's members, an array's items, or the one value.
fn question_count(answers: &Value) -> usize {
  match answers {
    Value::Array(items) => items.len(),
    Value::Object(members) => members.len(),
    _ => 1,
  }
}

// The members of a JSON object, or an array's items under their places.
fn entries(value: &Value) -> Vec<(String, &Value)> {
  match value {
    Value::Object(members) => members.iter().map(|(key, value)| (key.clone(), value)).collect(),
    Value::Array(items) => items.iter().enumerate().map(|(at, value)| (at.to_string(), value)).collect(),
    _ => vec![],
  }
}

fn member<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
  match value {
    Value::Object(members) => members.get(key),
    Value::Array(items) => key.parse::<usize>().ok().and_then(|at| items.get(at)),
    _ => None,
  }
}

/// The questions of a row the LLM's verdict speaks of, each compared.
pub fn compared_questions(laya: &str, truths: Option<&str>) -> Vec<Compared> {
  let laya = parsed(laya);
  let Some(truths) = truths.map(parsed) else { return vec![] };

  if !(laya.is_object() || laya.is_array()) || !(truths.is_object() || truths.is_array()) {
    return vec![];
  }

  let mut compared = vec![];

  for (key, truth) in entries(&truths) {
    let Some(answer) = member(&laya, &key) else { continue };

    match answer.get("type").and_then(Value::as_str) {
      Some("noul") => {
        let noul = answer.get("noul").and_then(Value::as_f64);

        compared.push(Compared {
          confidence: noul.map(|noul| noul.max(1.0 - noul)),
          agrees: match (truth.as_bool(), noul) {
            (None, _) => Some(false),
            (Some(_), None) => None,
            (Some(truth), Some(noul)) => Some((noul >= 0.5) == truth),
          },
        });
      }
      Some("choice") => {
        let choice = answer.get("choice").filter(|choice| !choice.is_null());

        compared.push(Compared {
          confidence: answer.get("confidence").and_then(Value::as_f64),
          agrees: match (truth.as_str(), choice) {
            (None, _) => Some(false),
            (Some(_), None) => None,
            (Some(truth), Some(choice)) => Some(choice.as_str() == Some(truth)),
          },
        });
      }
      _ => {}
    }
  }

  compared
}

/// The gates settled one question at a time, as their profiles declare them.
pub fn settled_each() -> Vec<String> {
  PROFILES
    .profile
    .iter()
    .filter(|profile| profile.laya_each)
    .map(|profile| profile.key.clone())
    .collect()
}

/// The question tallies of the gates named, over the rows where Laya answered; a gate with no answered row has
/// no tally.
pub async fn read_question_tallies(
  db: &DatabaseConnection,
  stages: &[String],
  stage: Option<&str>,
) -> Result<Vec<QuestionTally>, DbErr> {
  if stages.is_empty() {
    return Ok(vec![]);
  }

  let rows = all(
    db,
    r#"SELECT "stage", "used", "laya", "llm_answers" FROM "laya_verdicts"
       WHERE "failure" IS NULL AND "laya" IS NOT NULL AND ($1::text IS NULL OR "stage" = $1)
       ORDER BY "stage", "id""#,
    vec![stage.map(str::to_owned).into()],
  )
  .await?;
  let mut tallies: Vec<QuestionTally> = vec![];

  for row in &rows {
    let stage: String = row.try_get("", "stage").unwrap_or_default();

    if !stages.contains(&stage) {
      continue;
    }

    let used: Option<String> = row.try_get("", "used").ok().flatten();
    let laya: String = row.try_get::<Option<String>>("", "laya").ok().flatten().unwrap_or_default();
    let truths: Option<String> = row.try_get("", "llm_answers").ok().flatten();
    let at = match tallies.iter().position(|tally| tally.stage == stage) {
      Some(at) => at,
      None => {
        tallies.push(QuestionTally {
          stage: stage.clone(),
          asked: 0,
          settled: 0,
          compared: 0,
          agreed: 0,
          by_tau: TAU_GRID
            .iter()
            .map(|&tau| TallyAt {
              tau,
              sure: 0,
              agreed: 0,
            })
            .collect(),
        });
        tallies.len() - 1
      }
    };
    let tally = &mut tallies[at];
    let count = question_count(&parsed(&laya));

    tally.asked += count;

    if used.as_deref() == Some("laya") {
      tally.settled += count;
    }

    for Compared { confidence, agrees } in compared_questions(&laya, truths.as_deref()) {
      tally.compared += 1;

      if agrees == Some(true) {
        tally.agreed += 1;
      }

      for point in &mut tally.by_tau {
        if confidence.is_some_and(|confidence| confidence >= point.tau) {
          point.sure += 1;

          if agrees == Some(true) {
            point.agreed += 1;
          }
        }
      }
    }
  }

  Ok(tallies)
}

// A gate's agreement counted question by question; its failures are still its pairs whose Laya call failed.
fn question_agreement(tally: &QuestionTally, all: &[&PairRow]) -> Agreement {
  Agreement {
    stage: tally.stage.clone(),
    unit: Unit::Question,
    pairs: tally.compared,
    failures: all.iter().filter(|row| row.failure.is_some()).count(),
    agreement: share(tally.agreed, tally.compared),
    by_tau: TAU_GRID
      .iter()
      .map(|&tau| {
        let at = tally.by_tau.iter().find(|one| one.tau == tau);
        let sure = at.map_or(0, |at| at.sure);

        AgreementAt {
          tau,
          coverage: share(sure, tally.compared),
          agreement: share(at.map_or(0, |at| at.agreed), sure),
          safe_count: None,
          safe_agreement: None,
        }
      })
      .collect(),
    settled: share(tally.settled, tally.asked),
  }
}

/// Each gate's agreement, in the order of the gates' names, over the pairs where both gave a verdict; a pair
/// whose Laya call failed is counted as a failure and in nothing else. A gate with a tally among `questions`
/// is counted over its questions instead.
pub fn agreement(rows: &[PairRow], questions: &[QuestionTally]) -> Vec<Agreement> {
  let mut stages: Vec<&str> = rows.iter().map(|row| row.stage.as_str()).collect();

  stages.sort_unstable();
  stages.dedup();

  stages
    .into_iter()
    .map(|stage| {
      let all: Vec<&PairRow> = rows.iter().filter(|row| row.stage == stage).collect();

      if let Some(tally) = questions.iter().find(|one| one.stage == stage) {
        return question_agreement(tally, &all);
      }

      let pairs: Vec<&PairRow> = all
        .iter()
        .copied()
        .filter(|row| {
          row.failure.is_none()
            && row.laya_verdict.is_some()
            && row.llm_verdict.is_some()
            && row.confidence.is_some()
        })
        .collect();
      let agrees = |row: &&&PairRow| row.laya_verdict == row.llm_verdict;
      let safe_known = pairs.iter().any(|row| row.laya_safe.is_some());

      Agreement {
        stage: stage.to_owned(),
        unit: Unit::Pair,
        pairs: pairs.len(),
        failures: all.iter().filter(|row| row.failure.is_some()).count(),
        agreement: share(pairs.iter().filter(agrees).count(), pairs.len()),
        by_tau: TAU_GRID
          .iter()
          .map(|&tau| {
            let sure: Vec<&&PairRow> =
              pairs.iter().filter(|row| row.confidence.unwrap_or_default() >= tau).collect();
            let safe: Vec<&&&PairRow> = sure.iter().filter(|row| row.laya_safe == Some(true)).collect();

            AgreementAt {
              tau,
              coverage: share(sure.len(), pairs.len()),
              agreement: share(
                sure.iter().filter(|row| row.laya_verdict == row.llm_verdict).count(),
                sure.len(),
              ),
              safe_count: safe_known.then_some(safe.len()),
              safe_agreement: if safe_known {
                share(safe.iter().filter(|row| row.llm_safe == Some(true)).count(), safe.len())
              } else {
                None
              },
            }
          })
          .collect(),
        settled: None,
      }
    })
    .collect()
}

fn percent_text(value: Option<f64>) -> String {
  value.map_or_else(|| "\u{2014}".to_owned(), |value| format!("{}%", fixed(value * 100.0, 1)))
}

/// The agreement as the owner reads it: a block per gate, its pairs and failures, then a line per tau with the
/// share Laya would settle and how often it agrees there — and, for a gate with a safe verdict, how many Laya
/// called safe and how often the LLM did too.
pub fn agreement_lines(agreements: &[Agreement]) -> Vec<String> {
  if agreements.is_empty() {
    return vec![words::NONE.to_owned()];
  }

  let mut lines = vec![];

  for gate in agreements {
    let safe = gate.by_tau.iter().any(|at| at.safe_count.is_some());
    let unit = match gate.unit {
      Unit::Question => words::QUESTIONS,
      Unit::Pair => words::PAIRS,
    };
    let settled = gate.settled.map_or_else(String::new, |settled| {
      fill_marks(words::SETTLED, &[("share", &percent_text(Some(settled)))])
    });

    lines.push(fill_marks(
      words::GATE,
      &[
        ("stage", &gate.stage),
        ("counted", &fill_marks(unit, &[("count", &count_text(gate.pairs))])),
        ("failures", &count_text(gate.failures)),
        ("agreement", &percent_text(gate.agreement)),
        ("settled", &settled),
      ],
    ));
    lines.push(format!("{}{}", words::HEAD, if safe { words::SAFE_HEAD } else { "" }));

    for at in &gate.by_tau {
      let mut cells = vec![
        format!("  {}", fixed(at.tau, 2)),
        format!("{:>7}", percent_text(at.coverage)),
        format!("{:>7}", percent_text(at.agreement)),
      ];

      if safe {
        cells.push(format!("{:>9}", count_text(at.safe_count.unwrap_or_default())));
        cells.push(format!("{:>12}", percent_text(at.safe_agreement)));
      }

      lines.push(cells.join("  "));
    }
  }

  lines
}
