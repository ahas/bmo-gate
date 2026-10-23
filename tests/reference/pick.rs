//! A picker's answer read against what it was offered: every candidate's verdict, or a list of slugs or none; and
//! the verdict line a run of it writes, a keyword first and never the answer itself.

use gate_reference::pick::{
  Selection, named_of, parse_selection, parse_verdicts, run_verdict, selection_of, selection_verdict,
};

fn offered(slugs: &[&str]) -> Vec<String> {
  slugs.iter().map(|slug| (*slug).to_owned()).collect()
}

#[test]
fn an_answer_covering_exactly_its_candidates_is_read() {
  let candidates = offered(&["a", "b-c"]);

  assert_eq!(
    parse_verdicts("a: yes\nb-c no", &candidates),
    Some(vec![("a".into(), true), ("b-c".into(), false)])
  );
  assert_eq!(parse_verdicts("a: yes", &candidates), None);
  assert_eq!(parse_verdicts("a: yes\nb-c: no\nd: yes", &candidates), None);
  assert_eq!(parse_verdicts("a: yes\na: no\nb-c: no", &candidates), None);
}

#[test]
fn a_named_answer_reads_slugs_or_none() {
  assert_eq!(parse_selection("None"), Some(Selection::nothing()));
  assert_eq!(
    parse_selection("p1-a\np2-b").map(|selection| selection.slugs),
    Some(offered(&["p1-a", "p2-b"]))
  );
  assert_eq!(parse_selection("not a slug"), None);
}

#[test]
fn a_verdict_answer_reads_as_its_keyword_and_a_sentence_as_unreadable() {
  let candidates = offered(&["a", "b-c"]);
  let verdict = |answer: &str| {
    let parsed = selection_of(parse_verdicts(answer, &candidates));

    run_verdict(Some(answer), parsed.as_ref(), selection_verdict)
  };

  assert_eq!(verdict("a: yes\nb-c: no"), "PICK: a");
  assert_eq!(verdict("a: yes\nb-c: yes"), "PICK: a, b-c");
  assert_eq!(verdict("a: no\nb-c: no"), "NONE");
  assert_eq!(verdict("Tonight I would pick a quiet film, and no spoilers."), "UNREADABLE");
  assert_eq!(verdict("Here you go:\na: yes\nb-c: no"), "UNREADABLE");
  assert_eq!(verdict("```\na: yes\nb-c: no\n```"), "UNREADABLE");
  assert_eq!(run_verdict(None, None::<&Selection>, selection_verdict), "NO-ANSWER");
}

#[test]
fn a_named_answer_reads_as_its_keyword_and_a_sentence_as_unreadable() {
  let candidates = offered(&["p1-a", "c2-b"]);
  let verdict = |answer: &str| {
    let parsed = named_of(parse_selection(answer), &candidates);

    run_verdict(Some(answer), parsed.as_ref(), selection_verdict)
  };

  assert_eq!(verdict("c2-b\np1-a"), "PICK: c2-b, p1-a");
  assert_eq!(verdict("none"), "NONE");
  assert_eq!(verdict("Nobody here needs a piece, I think."), "UNREADABLE");
}
