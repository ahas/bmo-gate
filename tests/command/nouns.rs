//! The nouns the command declares, and how it reads its words: the mouth group's `translate`, and the words it
//! does not carry end with two.

use clap::Parser;
use gate_command::{Cli, NOUNS, dispatch, ended};

fn parsed(words: &[&str]) -> Result<Cli, clap::Error> {
  Cli::try_parse_from(std::iter::once("bmo-gate").chain(words.iter().copied()))
}

#[tokio::test]
async fn translate_is_the_one_noun_declared() {
  let lines = dispatch(parsed(&["nouns"]).unwrap().noun).await.unwrap();

  assert_eq!(lines, ["translate\thome"]);
  assert_eq!(NOUNS, ["translate\thome"]);
}

#[test]
fn the_translate_word_reads_as_the_translate_noun() {
  assert!(matches!(
    parsed(&["translate", "--text", "hello"]).unwrap().noun,
    gate_command::Noun::Translate(_)
  ));
}

#[test]
fn words_no_noun_carries_end_with_two() {
  for words in [&["gate", "eval"][..], &["reference", "nowhere"], &["nowhere"]] {
    assert_eq!(parsed(words).unwrap_err().exit_code(), 2, "{words:?}");
  }
}

#[tokio::test]
async fn health_and_records_are_no_noun_and_answer_zero_on_their_own() {
  assert!(matches!(parsed(&["health"]).unwrap().noun, gate_command::Noun::Health));
  assert_eq!(ended(Ok(vec!["a".into()])), (vec!["a".to_owned()], None, 0));
}
