//! The document seeker: its instructions told its ceiling, an answer read to the known slugs within it, and an
//! index the road found too large cut in two and the halves' picks ranked again.

use std::sync::{Arc, Mutex};

use gate_policy::document_seek::DOCUMENT_SEEK;
use gate_stages::document_seek::{SeekEntry, is_slug, parse, seek, system};

fn entries(slugs: &[&str]) -> Vec<SeekEntry> {
  slugs
    .iter()
    .map(|slug| SeekEntry {
      slug: (*slug).to_owned(),
      line: format!("the {slug} entry"),
      group: None,
    })
    .collect()
}

#[test]
fn the_instructions_are_told_their_ceiling() {
  let told = system().unwrap();

  assert!(!told.contains("{{selectionCap}}"));
  assert!(told.contains(&DOCUMENT_SEEK.cap.to_string()));
}

#[test]
fn an_answer_names_known_slugs_once_within_the_ceiling() {
  let index = entries(&["a", "b", "c", "d", "e", "f", "g"]);

  assert_eq!(parse("- b\n* a.\nb\nzz", &index), Some(vec!["b".to_owned(), "a".to_owned()]));
  assert_eq!(parse("none", &index), Some(vec![]));
  assert_eq!(parse("nothing known", &index), None);
  assert_eq!(parse("a\nb\nc\nd\ne\nf\ng", &index).map(|picks| picks.len()), Some(DOCUMENT_SEEK.cap));
  assert!(is_slug("a-slug-1") && !is_slug("A Slug"));
}

#[tokio::test]
async fn an_index_cut_in_two_has_its_halves_picks_ranked_again() {
  let index = entries(&["a", "b", "c", "d"]);
  let asked: Arc<Mutex<Vec<String>>> = Arc::default();
  let system = Arc::new("seek".to_owned());
  let seen = Arc::clone(&asked);
  let picks = seek(&system, &index, "which?", move |request| {
    seen.lock().unwrap().push(request.prompt.clone());

    let answer = match request.split.as_ref() {
      // The whole index, too large: the gate run cuts it and asks each half.
      Some(split) if request.prompt.contains("b — ") && request.prompt.contains("c — ") => {
        let parts = split.halve().unwrap();
        let answers = parts
          .into_iter()
          .map(|part| match part {
            gate_runs::Piece::Asked(half) if half.prompt.contains("a — ") => Some("a".to_owned()),
            gate_runs::Piece::Asked(_) => Some("d".to_owned()),
            gate_runs::Piece::Answered(answer) => Some(answer),
          })
          .collect();

        split.join(answers)
      }
      // The picks alone, ranked again.
      _ => Some("d\na".to_owned()),
    };

    async move { answer }
  })
  .await;

  assert_eq!(picks, Some(vec!["d".to_owned(), "a".to_owned()]));
  assert_eq!(asked.lock().unwrap().len(), 2);
}
