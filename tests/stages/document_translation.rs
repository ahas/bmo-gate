//! A document's translation: the gate's own words in place of a translation are none, a translation laid out anew is
//! one, what an answer lost is said, a part asked again where its first answer lost the structure, and an order
//! queued, each part written as a row — or kept as failed with why — and told to the screens.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use gate_stages::document_translation::{Kept, Lost, Order, Outcome, Queue, translate_part};
use gate_stages::translator::{Ask, Purpose, Ran};

use super::ground;

// A stand-in translation line answering each ask with the next of `answers`, and no answer once they run out.
fn line(answers: Vec<String>) -> Ask {
  let asked = Arc::new(AtomicUsize::new(0));

  Arc::new(move |_| {
    let answer = answers.get(asked.fetch_add(1, Ordering::SeqCst)).cloned();

    Box::pin(async move { answer.map_or_else(|| Ran::Unanswered("none left".to_owned()), Ran::Translated) })
  })
}

#[tokio::test]
async fn the_gates_own_words_are_no_translation() {
  let order = "Item #7 Keep the report on the item.\n\nRead it with `todo --show 7`.\n\nTo do\n1. Attach tests.\n2. Report back.";
  let own = [
    format!("English translation:\n\n---\n\n{order}"),
    format!("{order}\n\nLet me know if anything else needs translating."),
    "I am a translation agent.\n\nThis reads as a task for me, not a text to translate.\n\nPlease send the text to translate."
      .to_owned(),
    "Item #7 asks to keep the report on the item, attach tests and report back.".to_owned(),
  ];

  for answer in &own {
    let outcome =
      translate_part(order, "en", Purpose::Document, Kept::Whole, None, &line(vec![answer.clone(); 2]))
        .await;

    assert!(matches!(outcome, Outcome::Mismatch(_)), "{answer}");
  }

  let answers = vec![own[0].clone(), order.to_owned()];
  let outcome = translate_part(order, "en", Purpose::Document, Kept::Whole, None, &line(answers)).await;

  assert_eq!(outcome, Outcome::Translated(order.to_owned()));
}

// A part with its headings directly above their words, a paragraph wrapped over two lines and a list straight under
// the line that opens it.
const PLAN: &str = "## Plan\nWe walk to the lake at noon\nand bring water.\n\nWhat to take:\n- a hat\n- a map\n\n## Later\nRest by the lake, then read `notes.md`.";

#[test]
fn a_translation_laid_out_anew_keeps_the_parts_structure() {
  let laid_out = "## Plan, rendered\n\nWe walk to the lake at noon and bring water.\n\nWhat to take:\n\n- a hat, rendered\n\n- a map, rendered\n\n## Later, rendered\n\nRest by the lake, then read `notes.md`, rendered.";

  assert_eq!(Kept::Whole.lost(PLAN, laid_out), None);
}

#[test]
fn what_an_answer_lost_of_the_parts_structure_is_said() {
  let introduced = format!("Here is the translation:\n\n{PLAN}");
  let lost = Kept::Whole.lost(PLAN, &introduced).unwrap();

  assert_eq!(
    lost,
    Lost::Blocks {
      source: 9,
      translated: 10
    }
  );
  assert_eq!(lost.to_string(), "The translation has 10 blocks where the part has 9.");
  assert_eq!(
    Kept::Whole.lost(PLAN, &PLAN.replace("`notes.md`", "the notes")),
    Some(Lost::Code("`notes.md`".into()))
  );
  assert_eq!(
    Kept::Whole.lost(PLAN, &PLAN.replace("## Later\n", "")).map(|lost| lost.to_string()),
    Some("The translation did not keep the part's headings: 2:2 became 2:1.".into())
  );
  assert_eq!(
    Kept::Whole.lost("Intro.\n\n- one", "Intro.\n\n> one"),
    Some(Lost::Block {
      at: 2,
      source: "list item",
      translated: "block quote"
    })
  );
  assert_eq!(Kept::Headings.lost(PLAN, &introduced), None);
}

#[tokio::test]
async fn a_part_that_lost_its_structure_twice_is_kept_as_failed_with_why() {
  let ground = ground("document-failed", Default::default()).await;
  let queue = Queue::default();
  let mut heard = ground.stages.events.subscribe();
  let introduced = format!("Here is the translation:\n\n{PLAN}");

  ground.agency.translates(&[&introduced, &introduced]);
  queue.order(
    &ground.stages,
    Order {
      document: "docs/plan.md".into(),
      version: "v1".into(),
      target: "ko".into(),
      parts: 1,
      wanted: vec![(0, PLAN.into())],
    },
  );
  tokio::time::timeout(Duration::from_secs(10), heard.recv()).await.unwrap().unwrap();

  assert_eq!(
    ground
      .scratch
      .texts(
        "SELECT failure FROM document_translations WHERE document = 'docs/plan.md' AND failed = 1 AND text IS NULL",
        vec![]
      )
      .await,
    ["The translation has 10 blocks where the part has 9."]
  );
}

#[tokio::test]
async fn an_order_is_queued_each_part_written_and_told_to_the_screens() {
  let ground = ground("document", Default::default()).await;
  let queue = Queue::default();
  let mut heard = ground.stages.events.subscribe();

  ground.agency.translates(&["First, in Korean.", "Second, in Korean."]);

  let taken = queue.order(
    &ground.stages,
    Order {
      document: "docs/a.md".into(),
      version: "v1".into(),
      target: "ko".into(),
      parts: 2,
      wanted: vec![(0, "First.".into()), (1, "Second.".into())],
    },
  );

  assert_eq!(taken, 2);

  for _ in 0..2 {
    let event = tokio::time::timeout(Duration::from_secs(10), heard.recv()).await.unwrap().unwrap();

    assert_eq!(event.kind, "document-translation.changed");
    assert_eq!(event.data["document"], "docs/a.md");
  }

  assert_eq!(queue.state("docs/a.md", "ko").pending, 0);
  assert_eq!(
    ground
      .scratch
      .count(
        "SELECT count(*) FROM document_translations WHERE document = 'docs/a.md' AND failed = 0",
        vec![]
      )
      .await,
    2
  );
}

#[tokio::test]
async fn a_part_past_the_lines_window_is_asked_in_halves_and_joined() {
  let ground = ground("document-halves", Default::default()).await;
  let queue = Queue::default();
  let mut heard = ground.stages.events.subscribe();
  let part = "The first paragraph of the part.\n\nThe second paragraph of the part.";

  *ground.agency.window_chars.lock().unwrap() = Some(40);
  ground.agency.translates(&["First, in Korean.", "Second, in Korean."]);
  queue.order(
    &ground.stages,
    Order {
      document: "docs/b.md".into(),
      version: "v1".into(),
      target: "ko".into(),
      parts: 1,
      wanted: vec![(0, part.into())],
    },
  );
  tokio::time::timeout(Duration::from_secs(10), heard.recv()).await.unwrap().unwrap();

  let asked = ground.agency.translations.lock().unwrap().clone();

  assert_eq!(asked.len(), 3, "the whole refused, then each half: {asked:?}");
  assert!(asked.iter().all(|ask| ask.purpose == "document" && ask.language == "Korean"));
  assert_eq!(
    ground
      .scratch
      .texts(
        "SELECT text FROM document_translations WHERE document = 'docs/b.md' AND failed = 0",
        vec![]
      )
      .await,
    ["First, in Korean.\n\nSecond, in Korean."]
  );
}

#[tokio::test]
async fn a_part_asked_again_carries_a_note_naming_what_its_last_answer_lost() {
  let order = "Item #7 Keep the report on the item.\n\nRead it with `todo --show 7`.";
  let notes = Arc::new(std::sync::Mutex::new(Vec::<Option<String>>::new()));
  let held = Arc::clone(&notes);
  let answers = [format!("Here it is:\n\n{order}"), order.to_owned()];
  let asked = Arc::new(AtomicUsize::new(0));
  let ask: Ask = Arc::new(move |request| {
    held.lock().unwrap().push(request.note.clone());
    let answer = answers.get(asked.fetch_add(1, Ordering::SeqCst)).cloned();

    Box::pin(async move { answer.map_or_else(|| Ran::Unanswered("none left".to_owned()), Ran::Translated) })
  });

  let outcome = translate_part(order, "en", Purpose::Document, Kept::Whole, None, &ask).await;

  assert_eq!(outcome, Outcome::Translated(order.to_owned()));

  let notes = notes.lock().unwrap().clone();

  assert_eq!(notes[0], None, "the first ask carries no note");
  assert!(
    notes[1]
      .as_deref()
      .is_some_and(|note| note.contains("did not keep its structure") && note.contains("blocks")),
    "{notes:?}"
  );
}
