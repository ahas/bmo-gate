//! A record put into the owner's language: which texts count as English, each rendering checked before it stands
//! and asked again with what is wrong named, a part kept and read back for the same English, and a part left in
//! its original where it stays wrong. The stand-in gate answers a part with its Latin letters in their fullwidth
//! forms, which no reading of the language takes for English; a Korean text a test needs is made of Hangul
//! syllables counted out, never written into the test.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use gate_runs::GateRequest;
use gate_stages::Reading;
use gate_stages::records::{Record, plain_words, record_system};
use gate_stages::translator::Ask;

use crate::{Ground, ground};

// What the stand-in gate was asked: the part, and the instructions it came under.
struct Asked {
  part: String,
  system: String,
}

type Asking = Arc<Mutex<Vec<Asked>>>;

// A stand-in for the translator gate: what each part comes back as, by the part and the instructions, and
// everything it was asked.
fn gate(answer: impl Fn(&str, &str) -> Option<String> + Send + Sync + 'static) -> (Ask, Asking) {
  let asked: Asking = Arc::default();
  let held = Arc::clone(&asked);
  let ask: Ask = Arc::new(move |request: GateRequest| {
    let part = request.prompt.split_once("\n\n").map_or("", |(_, part)| part).to_owned();
    let answered = answer(&part, &request.system);

    held.lock().unwrap().push(Asked {
      part,
      system: request.system,
    });
    Box::pin(async move { answered })
  });

  (ask, asked)
}

// What the stand-in gate answers for a part: the part with each Latin letter in its fullwidth form.
fn rendered(part: &str) -> String {
  part
    .chars()
    .map(|letter| {
      if letter.is_ascii_alphabetic() {
        char::from_u32(letter as u32 + 0xfee0).unwrap()
      } else {
        letter
      }
    })
    .collect()
}

// A Korean word of so many syllables, counted out from the first.
fn hangul(syllables: u32) -> String {
  (0..syllables).map(|at| char::from_u32(0xac00 + at * 29).unwrap()).collect()
}

// A Korean word of so many syllables that shares no syllable with `hangul`'s.
fn other(syllables: u32) -> String {
  (0..syllables).map(|at| char::from_u32(0xb098 + at * 31).unwrap()).collect()
}

// The mark a strand of a note opens with: a name and the word for whose share it is.
fn share_mark(syllables: u32) -> String {
  format!("{} \u{baab}:", hangul(syllables))
}

// A record's reading over a ground, its English test reading past the strand marks.
async fn record_ground(test: &str, wording: Option<&str>) -> Ground {
  let file = wording.map(|text| {
    let file = std::env::temp_dir().join(format!("gate-stages-wording-{}-{test}.md", std::process::id()));

    std::fs::write(&file, text).unwrap();
    file
  });

  ground(
    test,
    None,
    Reading {
      set_aside: vec![share_mark(2), share_mark(3)],
      wording: file,
    },
  )
  .await
}

async fn render(ground: &Ground, ask: Ask, text: &str) -> (Result<String, String>, Vec<String>) {
  let english = ground.stages.reading.english();
  let system = record_system(&ground.stages).await.unwrap();
  let mut record = Record::new(&ground.stages, system, ground.stages.reading.glossary(), &english, ask);
  let read = record.korean_of_record(text, None).await;

  (read, record.log)
}

#[tokio::test]
async fn a_workers_account_is_english_its_marks_and_code_past() {
  let ground = record_ground("account", None).await;
  let english = ground.stages.reading.english();
  let account = format!(
    "1. {} Restart the `bravo` mount once the disk is back.\n2. {} Pick the voice.",
    share_mark(2),
    share_mark(3)
  );

  assert!(english.written(&account));
  assert!(english.written("The suite rebuilds the server inside its 90-second crate guard"));

  for text in [
    format!("UI {} Pretendard", hangul(2)),
    format!("Lazy loading UI skeleton loader {}", hangul(2)),
    format!("LAB-APP field-map-restructure{} main{} {}", hangul(1), hangul(2), hangul(3)),
    hangul(7),
  ] {
    assert!(!english.written(&text), "the owner's Korean naming libraries is no English: {text}");
  }
}

#[test]
fn counts_only_ordinary_lowercase_words() {
  assert_eq!(plain_words("node-b: NVIDIA GeForce RTX 3080, (card max) x4, driver 580.178.04."), 3);
  assert_eq!(plain_words("the close ran (every) test."), 5);
}

#[tokio::test]
async fn a_rendering_is_kept_under_its_english_and_read_back_rather_than_asked_again() {
  let ground = record_ground("kept", None).await;
  let report = "Reports are now stored in Korean; commit `abc1234`.";
  let (ask, asked) = gate(|part, _| Some(rendered(part)));

  assert_eq!(render(&ground, Arc::clone(&ask), report).await.0, Ok(rendered(report)));
  assert_eq!(render(&ground, ask, report).await.0, Ok(rendered(report)));
  assert_eq!(asked.lock().unwrap().len(), 1);
  assert_eq!(asked.lock().unwrap()[0].part, report);
  assert!(asked.lock().unwrap()[0].system.starts_with("the plain-writing rulebook\n\n"));
}

#[tokio::test]
async fn a_text_the_gate_did_not_answer_stays_english() {
  let ground = record_ground("unanswered", None).await;
  let (ask, _) = gate(|_, _| None);

  assert_eq!(
    render(&ground, ask, "The close passed.").await.0,
    Err("the gate did not answer".to_owned())
  );
}

#[tokio::test]
async fn a_rendering_using_a_banned_term_is_asked_again_with_the_term_named() {
  let term = hangul(2);
  let ground = record_ground(
    "banned",
    Some(&format!("# Wording\n\n## Banned terms\n\n- ko · {term} → {}\n", hangul(4))),
  )
  .await;
  let first = format!("{term} {}.", hangul(3));
  let second = format!("{} {}.", other(3), other(2));
  let answers = [first, second.clone()];
  let calls = Arc::new(AtomicUsize::new(0));
  let (ask, asked) = gate(move |_, _| Some(answers[calls.fetch_add(1, Ordering::SeqCst).min(1)].clone()));

  assert_eq!(render(&ground, ask, "Tidied the toolbar.").await.0, Ok(second));
  assert!(asked.lock().unwrap()[1].system.contains(&term));
}

#[tokio::test]
async fn a_rendering_that_ran_numbered_lines_together_is_asked_again_and_left_where_it_keeps_doing_so() {
  let ground = record_ground("lists", None).await;
  let report = "1. The prebuild ran per crate.\n2. The guard now counts tests only.";
  let listed = format!(
    "1. {}\n2. {}",
    rendered("The prebuild ran per crate."),
    rendered("The guard now counts tests only.")
  );
  let run_together = rendered("The prebuild ran per crate and the guard now counts tests only.");
  let calls = Arc::new(AtomicUsize::new(0));
  let answer = listed.clone();
  let together = run_together.clone();
  let (ask, _) = gate(move |part, _| {
    let call = calls.fetch_add(1, Ordering::SeqCst) + 1;

    Some(if part.starts_with("1.") && call == 2 { answer.clone() } else { together.clone() })
  });

  assert_eq!(render(&ground, Arc::clone(&ask), report).await.0, Ok(listed));

  // Its own English, since a rendering made of the same English is read back rather than asked for.
  let merged = "1. The prebuild ran per crate.\n2. The guard now counts doc tests only.";
  let (always, _) = gate(move |_, _| Some(run_together.clone()));

  assert_eq!(
    render(&ground, always, merged).await.0,
    Err("its numbered or bulleted lines ran together 3 times".to_owned())
  );
}

#[tokio::test]
async fn a_paragraph_handed_back_in_english_is_asked_again() {
  let ground = record_ground("left", None).await;
  let summary = "The bot now renders what a job writes onto an item into Korean for the owner.";
  let tail = format!("{}\n1. {}.", hangul(3), hangul(5));
  let handed_back = format!("{summary}\n\n{tail}");
  let korean = format!("{}\n\n{tail}", rendered(summary));
  let answers = [handed_back, korean.clone()];
  let calls = Arc::new(AtomicUsize::new(0));
  let (ask, asked) = gate(move |_, _| Some(answers[calls.fetch_add(1, Ordering::SeqCst).min(1)].clone()));

  assert_eq!(
    render(&ground, ask, &format!("{summary}\n\nFixed\n1. Renders into Korean.")).await.0,
    Ok(korean)
  );
  assert!(
    asked.lock().unwrap()[1]
      .system
      .contains(&format!("It left these in English; translate them too:\n- {summary}"))
  );
}

#[tokio::test]
async fn a_rendering_that_splits_one_list_around_a_label_stands() {
  let ground = record_ground("split", None).await;
  let report = "Fixed:\n1. Moved the gate run.\n2. Kept the log line.\nChecked:\n1. Ran the touched tests.\n2. Read the log.";
  let (ask, _) = gate(|part, _| {
    let label = rendered("Checked:");

    Some(rendered(part).replace(&format!("\n{label}"), &format!("\n\n{label}\n")))
  });

  assert!(render(&ground, ask, report).await.0.is_ok());
}

#[tokio::test]
async fn a_line_of_names_and_figures_handed_back_is_its_rendering() {
  let ground = record_ground("figures", None).await;
  let figures = "node-b: NVIDIA GeForce RTX 3080, 10240 MiB, PCIe gen 4 (card max) x4, driver 580.178.04.";
  let (ask, asked) = gate(move |part, _| {
    Some(
      part
        .split("\n\n")
        .map(|block| if block == figures { block.to_owned() } else { rendered(block) })
        .collect::<Vec<_>>()
        .join("\n\n"),
    )
  });

  assert_eq!(
    render(&ground, ask, &format!("The card was read over ssh.\n\n{figures}")).await.0,
    Ok(format!("{}\n\n{figures}", rendered("The card was read over ssh.")))
  );
  assert_eq!(asked.lock().unwrap().len(), 1);
}

// A part rendered keeping its fenced blocks as written, as the record instructions ask, every other line rendered.
fn fences_kept(part: &str) -> String {
  let mut fenced = false;

  part
    .split('\n')
    .map(|line| {
      let kept = fenced || line.starts_with("```");

      if line.starts_with("```") {
        fenced = !fenced;
      }
      if kept { line.to_owned() } else { rendered(line) }
    })
    .collect::<Vec<_>>()
    .join("\n")
}

// A report quoting the owner in a fence, its English after it, and the quote it holds.
fn quoting_report() -> (String, String) {
  let quote = format!("{} {}", hangul(5), hangul(4));

  (
    format!(
      "The owner asked for this:\n\n```text\n{quote}\n```\n\nIn English: write the prompt in English from the start."
    ),
    quote,
  )
}

#[tokio::test]
async fn a_rendering_that_changed_a_fenced_quote_is_asked_again_and_stays_where_it_keeps_changing_it() {
  let ground = record_ground("fences", None).await;
  let (report, quote) = quoting_report();
  let mended = format!("{report} Mended.");
  let changed = format!("{report} Changed.");
  // A gate putting its own words in place of the quote, and minding the fence once told so where the part is the
  // mended one.
  let (ask, asked) = gate(move |part, system| {
    let told = system.contains("It changed a fenced block.");

    Some(if told && part.ends_with("Mended.") {
      fences_kept(part)
    } else {
      fences_kept(part).replace(&quote, &hangul(9))
    })
  });

  assert_eq!(render(&ground, Arc::clone(&ask), &mended).await.0, Ok(fences_kept(&mended)));
  assert_eq!(asked.lock().unwrap().len(), 2);
  assert_eq!(
    render(&ground, ask, &changed).await.0,
    Err("a fenced block came back changed 3 times".to_owned())
  );
  assert_eq!(asked.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn a_rendering_that_keeps_the_fenced_quote_stands_at_the_first_ask() {
  let ground = record_ground("quote", None).await;
  let (report, quote) = quoting_report();
  let (ask, asked) = gate(|part, _| Some(fences_kept(part)));
  let written = render(&ground, ask, &report).await.0.unwrap();

  assert!(written.contains(&format!("```text\n{quote}\n```")));
  assert_eq!(written, fences_kept(&report));
  assert_eq!(asked.lock().unwrap().len(), 1);
}
