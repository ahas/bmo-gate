//! `gate format-cases` read off the gate's database: a page newest first with each case cut, one case whole, and the
//! answers when there is nothing to show.

use gate_command::Fault;
use gate_command::format_cases::read;

use crate::scratch::Scratch;

async fn case(scratch: &Scratch, at: i64, chat: Option<i64>, attempt: i64, text: &str) {
  scratch
    .run(
      r#"INSERT INTO format_cases (at, chat_id, message_id, stage, attempt, reason, text, markup, closing)
         VALUES ($1, $2, $3, 'output-format', $4, 'unclosed <b>', $5, '<b>open', NULL)"#,
      vec![at.into(), chat.into(), chat.map(|_| 9_i64).into(), attempt.into(), text.into()],
    )
    .await
    .unwrap();
}

#[tokio::test]
async fn a_page_shows_the_newest_cases_first_each_cut_to_what_recognises_it() {
  let scratch = Scratch::new().await;
  let long = "x".repeat(2_000);

  case(&scratch, 1_700_000_000, Some(7), 0, "older").await;
  case(&scratch, 1_700_000_100, None, 2, &long).await;

  let lines = read(scratch.db(), 20, None).await.unwrap();

  assert_eq!(lines[0], "2 of 2 case(s), newest first");
  assert!(lines[2].starts_with(
    "#2 2023-11-14T22:15:00.000Z \u{b7} no room \u{b7} no message \u{b7} output-format \u{b7} attempt 2\n"
  ));
  assert!(lines[2].contains(&format!("the message:\n{}\u{2026}\n", "x".repeat(1_500))));
  assert!(lines[4].contains(
    "room 7 \u{b7} message 9 \u{b7} output-format \u{b7} the markup the code made, checked once"
  ));
  assert!(
    lines[4].ends_with("reason: unclosed <b>\nthe message:\nolder\nthe markup the gate made:\n<b>open")
  );
  assert_eq!(read(scratch.db(), 1, None).await.unwrap()[0], "1 of 2 case(s), newest first");
}

#[tokio::test]
async fn one_case_is_shown_whole_and_a_case_not_there_is_said() {
  let scratch = Scratch::new().await;
  let long = "y".repeat(2_000);

  case(&scratch, 1_700_000_000, Some(7), 1, &long).await;

  let whole = read(scratch.db(), 20, Some(1)).await.unwrap();

  assert!(whole[0].contains(&long));
  assert!(!whole[0].contains('\u{2026}'));
  assert_eq!(read(scratch.db(), 20, Some(5)).await, Err(Fault::failed("No case #5.")));
}

#[tokio::test]
async fn nothing_recorded_is_said_and_a_limit_below_one_is_refused() {
  let scratch = Scratch::new().await;

  assert_eq!(read(scratch.db(), 20, None).await.unwrap(), ["No format cases are recorded."]);
  assert!(matches!(read(scratch.db(), 0, None).await, Err(Fault::Words(_))));
}
