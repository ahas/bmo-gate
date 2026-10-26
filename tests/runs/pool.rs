//! How many runs of a gate stand at once, and the live board's hold on a run while it goes.

use gate_policy::gate_pool::GATE_POOL;
use gate_runs::live::{self, GateRun};
use gate_runs::pool::{Pools, bound};
use gate_runs::route::{Route, Way};
use tokio::time::{Duration, Instant};

fn route(way: Way) -> Route {
  Route {
    key: "a-gate".into(),
    laya: false,
    provider: "a-provider".into(),
    way,
    tier: "Simple".into(),
    mapping: None,
  }
}

#[test]
fn a_programs_road_stands_its_pools_bound_and_the_gateway_takes_turns() {
  assert_eq!(bound("translator", Way::Session), 4);
  assert_eq!(bound("output-format", Way::Session), GATE_POOL.size);
  assert_eq!(bound("translator", Way::Gateway), 1);
}

#[tokio::test]
async fn a_run_waits_for_its_place_no_longer_than_its_wait() {
  let pools = Pools::default();
  let gateway = route(Way::Gateway);
  let soon = || Instant::now() + Duration::from_millis(50);
  let first = pools.take("output-format", &gateway, soon()).await;

  assert!(first.is_some());
  assert!(pools.take("output-format", &gateway, soon()).await.is_none());
  assert!(pools.take("session-summary", &gateway, soon()).await.is_some());
  drop(first);
  assert!(pools.take("output-format", &gateway, soon()).await.is_some());

  let session = route(Way::Session);
  let held: Vec<_> = futures_util::future::join_all(
    (0..GATE_POOL.size).map(|_| pools.take("output-format", &session, soon())),
  )
  .await;

  assert!(held.iter().all(Option::is_some));
  assert!(pools.take("output-format", &session, soon()).await.is_none());
}

#[test]
fn a_gate_run_stands_in_the_picture_while_it_is_held() {
  let run = GateRun {
    id: u64::MAX - 7,
    stage: "session-summary".to_owned(),
    chat_id: Some(-5),
    message_id: Some(9),
    started_at: 1,
    cap_seconds: 60,
  };
  let held = live::hold(run.clone());

  assert!(live::now().contains(&run));
  drop(held);
  assert!(!live::now().contains(&run));
}
