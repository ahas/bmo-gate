//! The translator's readings: a text with no part in another language stands as it is, a Korean one is read into
//! English part by part and kept, read back rather than asked again, and left unwhole and unkept where a part did
//! not come back; a reading kept by hand reads back in its language alone; a language no reader takes is none.
//! Hangul is counted out, never written into the test.

use std::sync::{Arc, Mutex};

use gate_runs::GateRequest;
use gate_stages::translator::{Ask, Read, Reader, keep, readings, recalled};

use crate::ground;

fn hangul(syllables: u32) -> String {
  (0..syllables).map(|at| char::from_u32(0xac00 + at * 29).unwrap()).collect()
}

// A stand-in translator answering each part asked into English as `answer` makes it, and the parts asked.
fn gate(
  answer: impl Fn(&str) -> Option<String> + Send + Sync + 'static,
) -> (Ask, Arc<Mutex<Vec<GateRequest>>>) {
  let asked: Arc<Mutex<Vec<GateRequest>>> = Arc::default();
  let held = Arc::clone(&asked);
  let ask: Ask = Arc::new(move |request: GateRequest| {
    let part = request.prompt.split_once("\n\n").map_or("", |(_, part)| part).to_owned();
    let answered = answer(&part);

    held.lock().unwrap().push(request);
    Box::pin(async move { answered })
  });

  (ask, asked)
}

#[tokio::test]
async fn a_korean_text_is_read_into_english_kept_and_read_back() {
  let ground = ground("english", None, Default::default()).await;
  let stages = &ground.stages;
  let korean = format!("{} {}.", hangul(4), hangul(3));
  let originals = vec!["Already English.".to_owned(), korean.clone()];
  let (ask, asked) = gate(|_| Some("In English.".to_owned()));

  let read = readings(stages, "en", &originals, &ask).await.unwrap();

  assert_eq!(
    read,
    [
      Read {
        text: "Already English.".into(),
        whole: true
      },
      Read {
        text: "In English.".into(),
        whole: true
      }
    ]
  );
  assert_eq!(asked.lock().unwrap().len(), 1);
  assert!(asked.lock().unwrap()[0].prompt.starts_with("Translate into English.\n\n"));
  assert!(asked.lock().unwrap()[0].alongside && !asked.lock().unwrap()[0].thinking);
  assert_eq!(recalled(stages, "en", &korean).await.as_deref(), Some("In English."));

  let again = readings(stages, "en", &originals, &ask).await.unwrap();

  assert_eq!(again, read);
  assert_eq!(asked.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_part_that_did_not_come_back_leaves_the_reading_unwhole_and_unkept() {
  let ground = ground("unwhole", None, Default::default()).await;
  let korean = format!("{} {}.", hangul(5), hangul(2));
  let (ask, _) = gate(|_| None);
  let read = readings(&ground.stages, "en", std::slice::from_ref(&korean), &ask).await.unwrap();

  assert_eq!(
    read,
    [Read {
      text: korean.clone(),
      whole: false
    }]
  );
  assert_eq!(recalled(&ground.stages, "en", &korean).await, None);
}

#[tokio::test]
async fn a_reading_kept_by_hand_reads_back_in_its_language_alone() {
  let ground = ground("kept", None, Default::default()).await;
  let korean = hangul(6);

  keep(&ground.stages, "en", &korean, "the worker's own English").await.unwrap();
  keep(&ground.stages, "en", &korean, "written again").await.unwrap();

  assert_eq!(recalled(&ground.stages, "en", &korean).await.as_deref(), Some("written again"));
  assert_eq!(recalled(&ground.stages, "ko", &korean).await, None);
}

#[tokio::test]
async fn a_language_no_reader_takes_is_none() {
  let ground = ground("language", None, Default::default()).await;
  let (ask, _) = gate(|_| None);

  assert_eq!(Reader::of("en"), Some(Reader::Worker));
  assert_eq!(Reader::of("ko"), Some(Reader::Record));
  assert!(readings(&ground.stages, "fr", &["x".to_owned()], &ask).await.is_none());
}

#[tokio::test]
async fn an_english_text_is_read_into_the_owners_language_by_the_record_reader() {
  let ground = ground("korean", None, Default::default()).await;
  let korean = format!("{} {}.", hangul(3), hangul(4));
  let answer = korean.clone();
  let (ask, asked) = gate(move |_| Some(answer.clone()));
  let read = readings(&ground.stages, "ko", &["The close ran every test.".to_owned(), hangul(5)], &ask)
    .await
    .unwrap();

  assert_eq!(
    read[0],
    Read {
      text: korean,
      whole: true
    }
  );
  assert_eq!(
    read[1],
    Read {
      text: hangul(5),
      whole: true
    }
  );
  assert!(asked.lock().unwrap()[0].prompt.starts_with("Translate into Korean.\n\n"));
  assert!(asked.lock().unwrap()[0].system.starts_with("the plain-writing rulebook\n\n"));
}
