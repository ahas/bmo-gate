//! `gate bench`: a pinned set replayed through a stand-in gateway one call at a time, two ceilings asked in turn
//! with their order alternating, every call written down as it ended, and a run summed up per ceiling.

use gate_command::Fault;
use gate_command::gate_bench::{
  AnswerItem, BenchSet, CallRecord, Replay, bench_folder, ceilings, estimated_tokens, percentile, replay,
  set_path, summary,
};
use gate_ports::PortError;
use gate_stages::output::GATE_KEY;

use crate::fakes::completion;
use crate::ground;

// An answer long enough to fold, with marks of its own: many lines of a list.
fn long_answer() -> String {
  (0..30)
    .map(|at| format!("- step **{at}** of the plan, said in full"))
    .collect::<Vec<_>>()
    .join("\n")
}

fn pin(data_root: &std::path::Path, answers: &[(&str, &str)]) {
  let set = BenchSet {
    made_at: "2026-10-19T00:00:00.000Z".into(),
    answers: answers
      .iter()
      .enumerate()
      .map(|(at, (kind, text))| AnswerItem {
        kind: "answer".into(),
        id: format!("a:7:{at}"),
        chat_id: 7,
        message_id: at as i64,
        chat_kind: (*kind).into(),
        text: (*text).into(),
      })
      .collect(),
  };

  std::fs::create_dir_all(bench_folder(data_root)).unwrap();
  std::fs::write(set_path(data_root), serde_json::to_string(&set).unwrap()).unwrap();
}

fn records(data_root: &std::path::Path, label: &str) -> Vec<CallRecord> {
  std::fs::read_to_string(bench_folder(data_root).join(format!("bench-{label}.jsonl")))
    .unwrap()
    .lines()
    .map(|line| serde_json::from_str(line).unwrap())
    .collect()
}

#[test]
fn a_percentile_is_the_lower_value_where_it_falls_between_two() {
  assert_eq!(percentile(&[], 50), 0);
  assert_eq!(percentile(&[30, 10, 20, 40], 50), 30);
  assert_eq!(percentile(&[30, 10, 20, 40], 90), 40);
}

#[test]
fn an_answer_is_weighed_in_estimated_tokens_and_ceilings_are_one_or_two_numbers() {
  assert_eq!(estimated_tokens("abc"), 1);
  assert_eq!(estimated_tokens("\u{c548}\u{b155}"), 2);
  assert_eq!(ceilings("4096").unwrap(), [4096]);
  assert_eq!(ceilings("1024, 4096").unwrap(), [1024, 4096]);

  for wrong in ["", "a", "1,2,3"] {
    assert!(matches!(ceilings(wrong), Err(Fault::Words(_))), "{wrong}");
  }
}

#[tokio::test]
async fn every_foldable_part_is_asked_at_each_ceiling_in_turn_and_written_down() {
  let ground = ground("bench-run").await;

  pin(
    &ground.data_root,
    &[("owner", &long_answer()), ("group", "short"), ("group", &long_answer())],
  );
  ground.gateway.answers(vec![
    completion("FOLD"),
    completion("OPEN\nbecause"),
    Err(PortError::Refused {
      unit: "the model gateway",
      call: "chat completion",
      status: 408,
      code: "timeout".into(),
      error: "timed out".into(),
    }),
    completion(""),
  ]);

  let given = Replay {
    label: "before".into(),
    registration: "a-registration".into(),
    share: "45000".into(),
    ceilings: vec![1024, 4096],
    offset: 0,
    limit: 1_000,
  };

  assert_eq!(replay(&ground.stages, &ground.data_root, &given).await, Ok(vec![]));

  let written = records(&ground.data_root, "before");
  let asked = ground.gateway.asked.lock().unwrap().clone();
  let seen: Vec<(i64, &str, &str)> = written
    .iter()
    .map(|one| (one.ceiling, one.item.as_str(), one.outcome.as_str()))
    .collect();

  assert_eq!(
    seen,
    [
      (1024, "a:7:0", "answered"),
      (4096, "a:7:0", "answered"),
      (1024, "a:7:2", "timeout"),
      (4096, "a:7:2", "error")
    ]
  );
  assert_eq!(written[1].verdict.as_deref(), Some("OPEN"));
  assert_eq!((written[0].answer_tokens, written[0].cut), (Some(2), Some(false)));
  assert!(
    asked
      .iter()
      .all(|one| one.model == "a-registration" && !one.thinking && one.wait.as_millis() == 45_000)
  );
  assert_eq!(asked.iter().map(|one| one.max_tokens).collect::<Vec<_>>(), [1024, 4096, 1024, 4096]);
  assert!(written.iter().all(|one| one.stage == GATE_KEY));
}

#[tokio::test]
async fn the_gate_s_own_wait_is_asked_for_by_profile_and_a_set_not_pinned_is_said() {
  let ground = ground("bench-profile").await;
  let given = Replay {
    label: "p".into(),
    registration: "a-registration".into(),
    share: "profile".into(),
    ceilings: vec![4096],
    offset: 0,
    limit: 1,
  };

  assert!(
    matches!(replay(&ground.stages, &ground.data_root, &given).await, Err(Fault::Failed { said, .. }) if said.starts_with("No bench set at"))
  );

  pin(&ground.data_root, &[("owner", &long_answer())]);
  ground.gateway.answers(vec![completion("FOLD")]);
  replay(&ground.stages, &ground.data_root, &given).await.unwrap();

  assert_eq!(ground.gateway.asked.lock().unwrap()[0].wait.as_millis(), 30_000);

  let wrong = Replay {
    share: "soon".into(),
    ..given
  };

  assert!(matches!(replay(&ground.stages, &ground.data_root, &wrong).await, Err(Fault::Words(_))));
}

#[test]
fn a_run_is_summed_up_per_ceiling_and_written_beside_it() {
  let data_root = crate::folder("bench-summary");
  let call = |ceiling: i64, ms: i64, outcome: &str, tokens: Option<i64>| CallRecord {
    item: format!("a:7:{ms}"),
    stage: GATE_KEY.into(),
    ceiling,
    ms,
    outcome: outcome.into(),
    verdict: None,
    answer_tokens: tokens,
    cut: tokens.map(|tokens| tokens >= ceiling),
  };
  let lines: Vec<String> = [
    call(1024, 100, "answered", Some(1024)),
    call(1024, 300, "answered", Some(10)),
    call(1024, 900, "timeout", None),
    call(4096, 200, "error", None),
  ]
  .iter()
  .map(|one| serde_json::to_string(one).unwrap())
  .collect();

  std::fs::create_dir_all(bench_folder(&data_root)).unwrap();
  std::fs::write(bench_folder(&data_root).join("bench-l.jsonl"), lines.join("\n")).unwrap();

  let said = summary(&data_root, "l").unwrap();

  assert_eq!(said[0], "# gate bench \u{b7} l");
  assert!(said[2].starts_with("4 calls, 4 items, read "));
  assert_eq!(
    said[6],
    format!("| {GATE_KEY} | 1024 | 3 | 2 | 300 | 300 | 900 | 1 | 0 | 1024 | 1024 | 1 |")
  );
  assert_eq!(said[7], format!("| {GATE_KEY} | 4096 | 1 | 0 | 0 | 0 | 200 | 0 | 1 | 0 | 0 | 0 |"));
  assert!(bench_folder(&data_root).join("bench-l.md").exists());
  assert!(matches!(summary(&data_root, "none"), Err(Fault::Failed { .. })));
}
