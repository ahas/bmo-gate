//! The nouns the command declares, and how it reads its words: a noun's flags, a noun it does not carry, the usage
//! a noun prints for `--help`, and the code each kind of ending leaves.

use clap::Parser;
use gate_command::{Cli, Fault, GateNoun, NOUNS, Noun, dispatch, ended};

fn parsed(words: &[&str]) -> Result<Cli, clap::Error> {
  Cli::try_parse_from(std::iter::once("bmo-gate").chain(words.iter().copied()))
}

#[tokio::test]
async fn nouns_are_declared_one_a_line_two_words_apart_by_a_space() {
  let lines = dispatch(parsed(&["nouns"]).unwrap().noun).await.unwrap();

  assert_eq!(
    lines,
    [
      "gate eval",
      "gate bench",
      "gate laya-agreement",
      "gate format-cases",
      "reference compare",
      "reference inputs",
      "reference narrowing",
      "reference replay",
      "reference roads",
      "reference waste",
    ]
  );
  assert_eq!(lines, NOUNS);
}

#[test]
fn each_noun_reads_its_own_flags() {
  let Noun::Gate(GateNoun::Eval(eval)) =
    parsed(&["gate", "eval", "status", "--set", "v2", "--gate", "translator"]).unwrap().noun
  else {
    panic!("not gate eval");
  };

  assert_eq!(
    (eval.command.as_deref(), eval.set(), eval.gates.as_slice()),
    (Some("status"), "v2", &["translator".to_owned()][..])
  );

  let Noun::Gate(GateNoun::FormatCases(cases)) =
    parsed(&["gate", "format-cases", "--limit", "5"]).unwrap().noun
  else {
    panic!("not gate format-cases");
  };

  assert_eq!((cases.limit, cases.show), (Some(5), None));

  let Noun::Gate(GateNoun::Bench(bench)) = parsed(&["gate", "bench", "run", "--label", "a"]).unwrap().noun
  else {
    panic!("not gate bench");
  };

  assert_eq!(
    (
      bench.owner_answers,
      bench.room_answers,
      bench.share_ms.as_str(),
      bench.answer_tokens.as_str()
    ),
    (30, 20, "45000", "4096")
  );
  assert!(
    matches!(parsed(&["gate", "laya-agreement", "--json"]).unwrap().noun, Noun::Gate(GateNoun::LayaAgreement(one)) if one.json)
  );
}

#[test]
fn words_no_noun_carries_end_with_two() {
  for words in [
    &["gate", "nowhere"][..],
    &["reference", "nowhere"],
    &["gate", "format-cases", "--limit", "many"],
  ] {
    assert_eq!(parsed(words).unwrap_err().exit_code(), 2, "{words:?}");
  }
}

#[tokio::test]
async fn help_prints_a_noun_s_whole_usage_without_reading_any_settings() {
  for (words, opens) in [
    (&["gate", "eval", "--help"][..], "usage: bmo gate eval"),
    (&["gate", "bench", "--help"], "usage: bmo gate bench"),
    (&["gate", "laya-agreement", "-h"], "usage: bmo gate laya-agreement"),
    (&["gate", "format-cases", "--help"], "usage: bmo gate format-cases"),
    (&["reference", "compare", "--help"], "usage: bmo reference compare"),
    (&["reference", "inputs", "-h"], "usage: bmo reference inputs"),
    (&["reference", "narrowing", "--help"], "usage: bmo reference narrowing"),
    (&["reference", "replay", "--help"], "usage: bmo reference replay"),
    (&["reference", "roads", "--help"], "usage: bmo reference roads"),
    (&["reference", "waste", "--help"], "usage: bmo reference waste"),
  ] {
    let lines = dispatch(parsed(words).unwrap().noun).await.unwrap();

    assert!(lines[0].starts_with(opens), "{words:?}");
  }
}

#[tokio::test]
async fn wrong_words_end_with_two_and_failed_work_with_one() {
  let no_command = dispatch(parsed(&["gate", "bench"]).unwrap().noun).await;
  let unknown = dispatch(parsed(&["gate", "eval", "frobnicate"]).unwrap().noun).await;
  let unpinned = dispatch(parsed(&["gate", "bench", "make-set"]).unwrap().noun).await;

  assert_eq!(ended(no_command).2, 2);
  assert!(matches!(unknown, Err(Fault::Words(said)) if said.starts_with("Unknown command: frobnicate")));
  assert!(
    matches!(&unpinned, Err(Fault::Failed { said, .. }) if said.contains("the receiver serves no route"))
  );
  assert_eq!(ended(unpinned).2, 1);
  assert_eq!(ended(Ok(vec!["a".into()])), (vec!["a".to_owned()], None, 0));

  let unnamed = dispatch(parsed(&["reference", "compare"]).unwrap().noun).await;

  assert!(matches!(unnamed, Err(Fault::Words(said)) if said.contains("needs --runs")));
}
