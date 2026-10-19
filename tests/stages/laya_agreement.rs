//! How often Laya agrees with each gate's LLM: pairs counted per gate with failures apart, the safe verdict's own
//! count, a gate settled one question at a time counted by question, and the lines the owner reads.

use gate_stages::laya_agreement::{
  PairRow, QuestionTally, TAU_GRID, TallyAt, Unit, agreement, agreement_lines, compared_questions,
};
use gate_words::laya_agreement as words;

fn pair(stage: &str, confidence: f64, laya: &str, llm: &str) -> PairRow {
  PairRow {
    stage: stage.to_owned(),
    confidence: Some(confidence),
    laya_verdict: Some(laya.to_owned()),
    llm_verdict: Some(llm.to_owned()),
    ..PairRow::default()
  }
}

#[test]
fn pairs_are_counted_per_gate_with_failures_apart_and_each_tau_its_own_share() {
  let rows = [
    pair("b", 0.95, "FOLD", "FOLD"),
    pair("b", 0.55, "FOLD", "OPEN"),
    PairRow {
      stage: "b".to_owned(),
      failure: Some("timeout".to_owned()),
      ..PairRow::default()
    },
    pair("a", 0.7, "OPEN", "OPEN"),
  ];
  let figures = agreement(&rows, &[]);

  assert_eq!(figures.iter().map(|one| one.stage.as_str()).collect::<Vec<_>>(), ["a", "b"]);

  let b = &figures[1];

  assert_eq!((b.pairs, b.failures, b.agreement), (2, 1, Some(0.5)));
  assert_eq!((b.by_tau[0].coverage, b.by_tau[0].agreement), (Some(1.0), Some(0.5)));
  assert_eq!((b.by_tau[1].coverage, b.by_tau[1].agreement), (Some(0.5), Some(1.0)));
  assert_eq!(b.by_tau[6].coverage, Some(0.0));
  assert_eq!(b.by_tau[6].agreement, None);
  assert_eq!(b.by_tau[0].safe_count, None);
}

#[test]
fn a_gate_with_a_safe_verdict_counts_how_often_the_llm_called_laya_s_safe_pairs_safe() {
  let rows = [
    PairRow {
      laya_safe: Some(true),
      llm_safe: Some(true),
      ..pair("s", 0.9, "SAFE", "SAFE")
    },
    PairRow {
      laya_safe: Some(true),
      llm_safe: Some(false),
      ..pair("s", 0.9, "SAFE", "UNSAFE")
    },
  ];
  let at = &agreement(&rows, &[])[0].by_tau[4];

  assert_eq!((at.safe_count, at.safe_agreement), (Some(2), Some(0.5)));
}

#[test]
fn a_question_tally_stands_in_for_the_pairs_of_a_gate_settled_one_question_at_a_time() {
  let rows = [pair("q", 0.9, "x", "y")];
  let tally = QuestionTally {
    stage: "q".to_owned(),
    asked: 4,
    settled: 1,
    compared: 2,
    agreed: 1,
    by_tau: TAU_GRID
      .iter()
      .map(|&tau| TallyAt {
        tau,
        sure: 1,
        agreed: 1,
      })
      .collect(),
  };
  let gate = &agreement(&rows, &[tally])[0];

  assert_eq!(
    (gate.unit, gate.pairs, gate.agreement, gate.settled),
    (Unit::Question, 2, Some(0.5), Some(0.25))
  );
  assert_eq!((gate.by_tau[0].coverage, gate.by_tau[0].agreement), (Some(0.5), Some(1.0)));
}

#[test]
fn a_question_compares_laya_s_answer_in_the_llm_s_terms() {
  let laya = r#"{"a":{"type":"noul","noul":0.2},"b":{"type":"choice","choice":"x","confidence":0.8},"c":{"type":"noul","noul":0.9}}"#;
  let truths = r#"{"a":false,"b":"y","c":"no"}"#;
  let compared = compared_questions(laya, Some(truths));

  assert_eq!(
    compared.iter().map(|one| one.agrees).collect::<Vec<_>>(),
    [Some(true), Some(false), Some(false)]
  );
  assert_eq!(compared[0].confidence, Some(0.8));
  assert!(compared_questions(laya, None).is_empty());
}

#[test]
fn the_lines_carry_a_block_per_gate_and_a_line_per_tau() {
  let lines = agreement_lines(&agreement(&[pair("a", 0.7, "OPEN", "OPEN")], &[]));

  assert_eq!(lines.len(), 2 + TAU_GRID.len());
  assert!(lines[0].starts_with("a: "));
  assert!(lines[0].contains("100.0%"));
  assert_eq!(lines[2], "  0.50   100.0%   100.0%");
  assert_eq!(agreement_lines(&[]), [words::NONE]);
}
