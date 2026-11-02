//! The rows a turn's events wake: each attaches by the event alone, its action under its own name.

use gate_ports::brain::Event;
use gate_reference::situation::event_entries;
use gate_reference::{SituationTurn, Source};

use super::ground;
use crate::reference::fakes::memory;

fn turn() -> SituationTurn {
  SituationTurn {
    chat_id: 7,
    agent: "the-chat-agent".into(),
    events: vec![Event {
      kind: "job-done".into(),
      item: Some(3),
    }],
  }
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
  assert!(ground.gateway.asked.lock().unwrap().is_empty(), "no model is asked");
}
