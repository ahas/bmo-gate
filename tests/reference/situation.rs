//! The situation-rule matcher: an answer covering both questions of every rule, a label read back into its sides,
//! and a turn whose rules the matcher judged and whose events woke rows, what it matched and spent handed to the
//! brain.

use gate_ports::brain::{Condition, Event};
use gate_reference::situation::{Verdicts, event_entries, parse_answer, sides_of, situation_entries};
use gate_reference::{RoomKind, SituationTurn, Source};

use crate::fakes::memory;
use crate::ground;

#[test]
fn an_answer_covers_both_questions_of_every_rule() {
  let slugs = vec!["late".to_owned(), "quiet".to_owned()];
  let read =
    parse_answer("late applies: yes\nlate spent: no\nquiet applies: no\nquiet spent: yes", &slugs).unwrap();

  assert_eq!((read.applies, read.spent), (vec!["late".to_owned()], vec!["quiet".to_owned()]));
  assert!(parse_answer("late applies: yes\nlate spent: no", &slugs).is_none());
  assert!(
    parse_answer("late applies: yes\nlate applies: no\nquiet applies: no\nquiet spent: yes", &slugs)
      .is_none()
  );
}

#[test]
fn a_label_reads_back_into_its_two_sides() {
  let verdicts = Verdicts {
    applies: vec!["b".into(), "a".into()],
    spent: vec![],
    answers: None,
  };

  assert_eq!(verdicts.label(), "applies=a,b spent=none");
  assert_eq!(sides_of("applies=a,b spent=none"), Some((vec!["a".into(), "b".into()], vec![])));
}

fn turn() -> SituationTurn {
  SituationTurn {
    chat_id: 7,
    agent: "the-chat-agent".into(),
    message_id: Some(9),
    room: RoomKind::Owner,
    message_lines: vec!["Owner (id 5): still up?".into()],
    events: vec![Event {
      kind: "job-done".into(),
      item: Some(3),
    }],
    round: Some("round-2".into()),
    now: 100,
  }
}

#[tokio::test]
async fn a_rule_that_fits_attaches_its_action_and_what_matched_and_spent_go_to_the_brain() {
  let ground = ground("situation", |ask| {
    ask
      .input
      .starts_with("RULES:")
      .then(|| "late applies: yes\nlate spent: no\nold applies: no\nold spent: yes".to_owned())
  })
  .await;

  ground.brain.conditions.lock().unwrap().extend([
    Condition {
      slug: "late".into(),
      condition: "someone writes after midnight".into(),
      action: "say good night".into(),
    },
    Condition {
      slug: "old".into(),
      condition: "the release ships".into(),
      action: "tell the room".into(),
    },
  ]);

  let entries = situation_entries(&ground.reference, &turn(), &Default::default()).await.unwrap();

  assert_eq!(entries.len(), 1);
  assert_eq!(
    (entries[0].path.as_str(), entries[0].text.as_str()),
    ("situation-rule/late", "say good night")
  );
  assert_eq!(
    *ground.brain.matched.lock().unwrap(),
    [(vec!["late".to_owned()], vec!["old".to_owned()])]
  );
  assert!(
    ground.gateway.asked.lock().unwrap()[0]
      .input
      .contains("- late \u{2014} someone writes after midnight, say good night")
  );
  assert_eq!(
    ground
      .scratch
      .texts(
        "SELECT verdict FROM judgements WHERE stage = 'situation-rules' AND round = 'round-2'",
        vec![]
      )
      .await,
    ["applies=late spent=old"]
  );
}

#[tokio::test]
async fn a_row_an_event_wakes_attaches_by_the_event_alone() {
  let ground = ground("events", |_| None).await;

  ground.brain.woken.lock().unwrap().extend([
    memory(1, "situation", "on-deploy", "watch the deploy"),
    memory(2, "errand", "report-back", "report the job"),
  ]);

  let entries = event_entries(&ground.reference, &turn()).await;

  assert_eq!(
    entries.iter().map(|entry| (entry.path.as_str(), entry.source)).collect::<Vec<_>>(),
    [("situation-rule/on-deploy", Source::Situation), ("memory/report-back", Source::Memory)]
  );
  assert_eq!(ground.brain.events.lock().unwrap()[0].item, Some(3));
}

#[tokio::test]
async fn a_turn_whose_room_holds_no_rule_says_so() {
  let ground = ground("no-rules", |_| None).await;
  let entries = situation_entries(&ground.reference, &turn(), &Default::default()).await.unwrap();

  assert!(entries.is_empty());
  assert_eq!(
    ground
      .scratch
      .texts("SELECT verdict FROM judgements WHERE stage = 'situation-rules'", vec![])
      .await,
    ["SKIP: no candidates"]
  );
}
