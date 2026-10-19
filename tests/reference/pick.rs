//! A picker's answer read against what it was offered: every candidate's verdict, or a list of slugs or none.

use gate_reference::pick::{Selection, parse_selection, parse_verdicts};

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
