//! The translator's readings: a text with no part in another language stands as it is, a Korean one is read into
//! English part by part and kept, read back rather than asked again, and left unwhole and unkept where a part did
//! not come back; a reading kept by hand reads back in its language alone; a language no reader takes is none, and
//! which language each reader takes is the policy's. The intake takes no more originals in one reading than one
//! carries, none past the bound of those standing, and holds the parts out at once across readings to its lanes.
//! Hangul is counted out, never written into the test.

use std::sync::{Arc, Mutex};

use gate_policy::translation::{TRANSLATION, Translation};
use gate_stages::translator::{
  Ask, Asked, CALL_ORIGINALS, Intake, Purpose, Ran, Read, Reader, STANDING_ORIGINALS, Turned, keep,
  readings, recalled,
};

use crate::ground;

fn hangul(syllables: u32) -> String {
  (0..syllables).map(|at| char::from_u32(0xac00 + at * 29).unwrap()).collect()
}

// A stand-in translation line answering each part asked as `answer` makes it, and the parts asked.
fn gate(answer: impl Fn(&str) -> Option<String> + Send + Sync + 'static) -> (Ask, Arc<Mutex<Vec<Asked>>>) {
  let asked: Arc<Mutex<Vec<Asked>>> = Arc::default();
  let held = Arc::clone(&asked);
  let ask: Ask = Arc::new(move |request: Asked| {
    let answered = answer(&request.text);

    held.lock().unwrap().push(request);
    Box::pin(async move {
      match answered {
        Some(text) => Ran::Translated(text),
        None => Ran::Unanswered("the stand-in gave no answer".to_owned()),
      }
    })
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

  let read = readings(stages, &Intake::of_policy(), "en", &originals, &ask).await.unwrap();

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
  assert_eq!(
    {
      let asked = asked.lock().unwrap();

      (asked[0].purpose, asked[0].target.clone())
    },
    (Purpose::Worker, "en".to_owned()),
    "a part read into the worker's language is the line's worker purpose"
  );
  assert_eq!(recalled(stages, "en", &korean).await.as_deref(), Some("In English."));

  let again = readings(stages, &Intake::of_policy(), "en", &originals, &ask).await.unwrap();

  assert_eq!(again, read);
  assert_eq!(asked.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_part_that_did_not_come_back_leaves_the_reading_unwhole_and_unkept() {
  let ground = ground("unwhole", None, Default::default()).await;
  let korean = format!("{} {}.", hangul(5), hangul(2));
  let (ask, _) = gate(|_| None);
  let read = readings(&ground.stages, &Intake::of_policy(), "en", std::slice::from_ref(&korean), &ask)
    .await
    .unwrap();

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

  assert_eq!(Reader::of(&TRANSLATION.worker_language), Some(Reader::Worker));
  assert_eq!(Reader::of(&TRANSLATION.owner_language), Some(Reader::Record));
  assert!(
    readings(&ground.stages, &Intake::of_policy(), "fr", &["x".to_owned()], &ask)
      .await
      .is_none()
  );
}

#[tokio::test]
async fn an_english_text_is_read_into_the_owners_language_by_the_record_reader() {
  let ground = ground("korean", None, Default::default()).await;
  let korean = format!("{} {}.", hangul(3), hangul(4));
  let answer = korean.clone();
  let (ask, asked) = gate(move |_| Some(answer.clone()));
  let read = readings(
    &ground.stages,
    &Intake::of_policy(),
    "ko",
    &["The close ran every test.".to_owned(), hangul(5)],
    &ask,
  )
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
  assert_eq!(
    {
      let asked = asked.lock().unwrap();

      (asked[0].purpose, asked[0].target.clone())
    },
    (Purpose::Record, "ko".to_owned()),
    "a part read into the owner's language is the line's record purpose"
  );
}

#[test]
fn a_deployment_whose_owner_reads_another_language_has_the_record_reader_take_that_one() {
  let policy = Translation {
    worker_language: "en".to_owned(),
    owner_language: "ja".to_owned(),
    latin_per_hangul: TRANSLATION.latin_per_hangul,
    record_attempts: TRANSLATION.record_attempts,
    lanes: TRANSLATION.lanes,
    language_names: [("en", "English"), ("ja", "Japanese")]
      .into_iter()
      .map(|(tag, name)| (tag.to_owned(), name.to_owned()))
      .collect(),
  };

  assert_eq!(Reader::under(&policy, "ja"), Some(Reader::Record));
  assert_eq!(Reader::under(&policy, "en"), Some(Reader::Worker));
  assert_eq!(Reader::under(&policy, "ko"), None);
  assert_eq!(Reader::Record.language(&policy), "ja");
  assert_eq!(Reader::Worker.language(&policy), "en");
}

#[test]
fn the_intake_takes_one_readings_originals_up_to_its_bounds_and_frees_them_when_dropped() {
  let intake = Intake::new(4, STANDING_ORIGINALS);

  assert_eq!(intake.admit(CALL_ORIGINALS + 1).err(), Some(Turned::TooMany));

  let standing: Vec<_> = (0..STANDING_ORIGINALS / CALL_ORIGINALS)
    .map(|_| intake.admit(CALL_ORIGINALS).ok().unwrap())
    .collect();

  assert_eq!(intake.admit(1).err(), Some(Turned::Full));
  assert!(intake.admit(0).is_ok());

  drop(standing);
  assert!(intake.admit(CALL_ORIGINALS).is_ok());
}

#[tokio::test]
async fn readings_standing_together_hold_no_more_parts_out_than_the_intakes_lanes() {
  let ground = ground("lanes", None, Default::default()).await;
  let out = Arc::new(Mutex::new((0usize, 0usize)));
  let held = Arc::clone(&out);
  let ask: Ask = Arc::new(move |_: Asked| {
    let held = Arc::clone(&held);

    Box::pin(async move {
      {
        let mut counts = held.lock().unwrap();

        counts.0 += 1;
        counts.1 = counts.1.max(counts.0);
      }
      tokio::time::sleep(std::time::Duration::from_millis(20)).await;
      held.lock().unwrap().0 -= 1;

      Ran::Translated("In English.".to_owned())
    })
  });
  let intake = Intake::new(2, STANDING_ORIGINALS);
  let first: Vec<String> = (0..3).map(|at| format!("{} {at}.", hangul(3 + at))).collect();
  let second: Vec<String> = (0..3).map(|at| format!("{} {at}!", hangul(6 + at))).collect();

  let (one, other) = tokio::join!(
    readings(&ground.stages, &intake, "en", &first, &ask),
    readings(&ground.stages, &intake, "en", &second, &ask)
  );

  assert!(one.unwrap().iter().chain(other.unwrap().iter()).all(|read| read.whole));
  assert_eq!(out.lock().unwrap().1, 2);
}
