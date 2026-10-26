//! `gate laya-agreement` read off the gate's database: a block per gate, one gate alone, the figures as JSON in the
//! console's snake_case, and nothing recorded said as such.

use gate_command::laya_agreement::read;
use serde_json::Value;

use crate::scratch::Scratch;

async fn pair(scratch: &Scratch, stage: &str, confidence: f64, laya: &str, llm: &str) {
  scratch
    .run(
      r#"INSERT INTO laya_verdicts (stage, input_hash, input, confidence, llm_verdict, laya_verdict, mode, used, created_at)
         VALUES ($1, 'h', 'i', $2, $3, $4, 'shadow', 'llm', 1)"#,
      vec![stage.into(), confidence.into(), llm.into(), laya.into()],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn each_gate_is_a_block_and_one_gate_is_read_alone() {
  let scratch = Scratch::new().await;

  pair(&scratch, "output-format", 0.95, "FOLD", "FOLD").await;
  pair(&scratch, "output-format", 0.55, "OPEN", "FOLD").await;
  pair(&scratch, "output-decide", 0.9, "NONE", "NONE").await;

  let (lines, note) = read(scratch.db(), None, false).await.unwrap();

  assert_eq!(note, None);
  assert!(
    lines
      .iter()
      .any(|line| line.starts_with("output-format: pairs 2 \u{b7} failures 0 \u{b7} agreement 50")),
    "{lines:?}"
  );
  assert!(lines.iter().any(|line| line.starts_with("output-decide: ")));

  let (alone, _) = read(scratch.db(), Some("output-decide"), false).await.unwrap();

  assert!(alone.iter().all(|line| !line.starts_with("output-format")));
}

#[tokio::test]
async fn the_figures_read_as_json_in_snake_case() {
  let scratch = Scratch::new().await;

  pair(&scratch, "output-format", 0.95, "FOLD", "FOLD").await;

  let (lines, _) = read(scratch.db(), None, true).await.unwrap();
  let figures: Value = serde_json::from_str(&lines[0]).unwrap();

  assert_eq!(figures[0]["stage"], "output-format");
  assert_eq!(figures[0]["unit"], "pair");
  assert!(figures[0]["by_tau"].as_array().is_some_and(|taus| taus.len() == 7));
  assert!(figures[0]["by_tau"][0].as_object().unwrap().contains_key("safe_count"));
}

#[tokio::test]
async fn nothing_recorded_is_said() {
  let scratch = Scratch::new().await;

  assert_eq!(read(scratch.db(), None, false).await.unwrap().0, ["No Laya verdicts are recorded yet."]);
}
