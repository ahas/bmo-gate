//! A document's translation: the gate's own words in place of a translation are none, a part asked again where its
//! first answer lost the structure, and an order queued, each part written as a row and told to the screens.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use gate_stages::document_translation::{Kept, Order, Outcome, Queue, translate_part};

use crate::fakes::completion;
use crate::ground;

#[tokio::test]
async fn the_gates_own_words_are_no_translation() {
  let order = "Item #7 Keep the report on the item.\n\nRead it with `todo --show 7`.\n\nTo do\n1. Attach tests.\n2. Report back.";
  let system = Arc::new(String::new());
  let own = [
    format!("English translation:\n\n---\n\n{order}"),
    format!("{order}\n\nLet me know if anything else needs translating."),
    "I am a translation agent.\n\nThis reads as a task for me, not a text to translate.\n\nPlease send the text to translate."
      .to_owned(),
    "Item #7 asks to keep the report on the item, attach tests and report back.".to_owned(),
  ];

  for answer in &own {
    let outcome =
      translate_part(order, "en", &system, Kept::Whole, |_| async { Some(answer.clone()) }).await;

    assert_eq!(outcome, Outcome::Mismatch, "{answer}");
  }

  let asked = AtomicUsize::new(0);
  let answers = [own[0].clone(), order.to_owned()];
  let outcome = translate_part(order, "en", &system, Kept::Whole, |_| {
    let answer = answers.get(asked.fetch_add(1, Ordering::SeqCst)).cloned();

    async move { answer }
  })
  .await;

  assert_eq!(outcome, Outcome::Translated(order.to_owned()));
}

#[tokio::test]
async fn an_order_is_queued_each_part_written_and_told_to_the_screens() {
  let ground = ground("document", None, Default::default()).await;
  let queue = Queue::default();
  let mut heard = ground.stages.events.subscribe();

  ground
    .gateway
    .answers(vec![completion("First, in Korean."), completion("Second, in Korean.")]);

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

    assert_eq!(event.kind, "document-translation");
    assert_eq!(event.body["document"], "docs/a.md");
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
