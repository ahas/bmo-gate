//! The watch on what attaches: shares counted per gate's turns, an alarm only past the line over the day and its
//! latest half, the row's words, and a pass raising a row under the piece's key and telling the owner.

use gate_ports::job::Raised;
use gate_reference::attachments::{
  ALARM_MINIMUM, Alarm, AttachRow, RECENT_MS, Share, alarms, judgement, pass, row_title, shares,
};

use crate::fakes::FakeJob;
use crate::ground;

const NOW: i64 = 1_800_000_000_000;

/// A gate asked on so many turns, attaching a piece on the first few of them. The turns stand a
/// minute apart and the last of them at `latest`; `first` is the message number the first is given.
fn turns(stage: &str, asked: i64, pieces: &[(&str, i64)], first: i64, latest: i64) -> Vec<AttachRow> {
  let mut rows = Vec::new();

  for turn in 0..asked {
    let at = latest - (asked - 1 - turn) * 60_000;
    let row = |slug: &str, attached: bool| AttachRow {
      stage: stage.to_owned(),
      chat_id: -1,
      message_id: Some(first + turn),
      slug: slug.to_owned(),
      attached: Some(attached),
      at,
    };

    rows.push(row("never", false));

    for &(slug, hits) in pieces {
      rows.push(row(slug, turn < hits));
    }
  }

  rows
}

#[test]
fn counts_the_turns_a_gate_was_asked_and_the_ones_that_attached_each_piece_largest_share_first() {
  let rows = [
    turns("system-documents", 10, &[("structure", 9), ("wording", 1)], 0, NOW - 60),
    turns("room-rules", 4, &[("greeting", 1)], 0, NOW - 60),
  ]
  .concat();
  let found: Vec<(String, String, usize, usize)> = shares(&rows)
    .into_iter()
    .map(|one| (one.stage, one.slug, one.attached, one.asked))
    .collect();

  assert_eq!(
    found,
    [
      ("system-documents".into(), "structure".into(), 9, 10),
      ("room-rules".into(), "greeting".into(), 1, 4),
      ("system-documents".into(), "wording".into(), 1, 10),
    ]
  );
}

#[test]
fn a_piece_past_the_line_on_a_gate_asked_often_enough_is_an_alarm_and_nothing_below_either() {
  let minimum = ALARM_MINIMUM as i64;
  let rows = [
    turns(
      "system-documents",
      minimum + 10,
      &[("structure", minimum + 5), ("wording", 3)],
      0,
      NOW - 60,
    ),
    turns("room-rules", minimum - 1, &[("greeting", minimum - 1)], 0, NOW - 60),
  ]
  .concat();
  let found: Vec<String> = alarms(&rows, NOW).into_iter().map(|one| one.key()).collect();

  assert_eq!(found, ["reference-attach:system-documents:structure"]);
}

// A fix goes live in the middle of the day: the turns before it still stand in the day's count, and
// the piece has already come down on the turns after it.
#[test]
fn a_piece_past_the_line_over_the_day_but_not_over_its_latest_half_is_left() {
  let before = turns("system-documents", 30, &[("structure", 30)], 0, NOW - RECENT_MS - 3_600_000);

  assert!(
    alarms(
      &[before.clone(), turns("system-documents", 30, &[("structure", 2)], 100, NOW - 60)].concat(),
      NOW
    )
    .is_empty()
  );

  let still = alarms(
    &[before, turns("system-documents", 30, &[("structure", 12)], 100, NOW - 60)].concat(),
    NOW,
  );
  let alarm = &still[0];

  assert_eq!(
    (alarm.share.asked, alarm.share.attached, alarm.recent.asked, alarm.recent.attached),
    (60, 42, 30, 12)
  );
}

fn alarm() -> Alarm {
  Alarm {
    share: Share {
      stage: "people-search".into(),
      slug: "c10000001-told".into(),
      asked: 47,
      attached: 18,
      share: 18.0 / 47.0,
    },
    recent: Share {
      stage: "people-search".into(),
      slug: "c10000001-told".into(),
      asked: 20,
      attached: 9,
      share: 9.0 / 20.0,
    },
  }
}

#[test]
fn the_row_says_which_gate_and_piece_both_shares_and_what_its_job_is_to_do() {
  let judgement = judgement(&alarm());

  assert_eq!(
    row_title(&alarm()),
    "Fix a reference piece that attaches too often: people-search c10000001-told"
  );
  assert!(judgement.starts_with(
    "The people-search reference gate attached c10000001-told on 18 of 47 turns (38%) over the last day, and on 9 of 20 turns (45%) over its latest half. The line is 30%."
  ));
  assert!(judgement.contains("report the attach rate before and after the fix"));
}

#[tokio::test]
async fn a_pass_raises_a_row_tells_the_owner_and_leaves_the_piece_alone_for_a_day() {
  let ground = ground("watch", |_| None).await;
  let job = FakeJob::default();
  let file = ground.shipped.join("attachments.json");

  for turn in 0..30_i64 {
    for (slug, attached) in [("structure", turn < 25), ("never", false)] {
      ground
        .scratch
        .run(
          "INSERT INTO reference_verdicts (stage, chat_id, message_id, slug, attached, created_at) VALUES ('system-documents', -1, $1, $2, $3, $4)",
          vec![turn.into(), slug.into(), i64::from(attached).into(), (NOW - turn * 60).into()],
        )
        .await
        .unwrap();
    }
  }

  assert_eq!(pass(&ground.reference, &job, 99, &file, NOW).await.unwrap(), [1900]);

  let raised = job.raised.lock().unwrap().clone();
  let notices = ground.receiver.notices.lock().unwrap().clone();

  assert_eq!(raised.len(), 1);
  assert_eq!((raised[0].2, raised[0].3.as_str()), (99, "reference-attach:system-documents:structure"));
  assert_eq!(notices[0].0, "attachment-alarm");
  assert_eq!(notices[0].1["row"], 1900);
  assert_eq!(notices[0].1["slug"], "structure");

  assert!(pass(&ground.reference, &job, 99, &file, NOW + 60).await.unwrap().is_empty());
  assert_eq!(job.raised.lock().unwrap().len(), 1);

  *job.answer.lock().unwrap() = Raised {
    id: 1900,
    raised: false,
  };

  assert!(pass(&ground.reference, &job, 99, &file, NOW + 25 * 3_600).await.unwrap().is_empty());
  assert_eq!(job.raised.lock().unwrap().len(), 1, "the day's turns have aged out of the window");
}
