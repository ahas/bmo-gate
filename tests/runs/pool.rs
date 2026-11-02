//! How many runs of a gate stand at once, a run past them waiting in line, and the live board's hold on a run
//! while it goes.

use futures_util::FutureExt;
use gate_runs::live::{self, GateRun};
use gate_runs::pool::{Pools, bound};
use gate_runs::route::{Route, Way};

fn route(way: Way) -> Route {
  Route {
    key: "a-gate".into(),
    provider: "a-provider".into(),
    way,
    tier: "Simple".into(),
    mapping: None,
  }
}

#[test]
fn a_programs_road_stands_its_pools_bound_and_the_gateway_takes_turns() {
  assert_eq!(bound("a-gate", Way::Session), 1);
  assert_eq!(bound("another-gate", Way::Session), 1);
  assert_eq!(bound("a-gate", Way::Gateway), 1);
}

#[tokio::test]
async fn a_run_past_its_pool_waits_in_line_until_a_place_comes_free() {
  let pools = Pools::default();
  let gateway = route(Way::Gateway);
  let first = pools.take("a-gate", &gateway).await;
  let mut waiting = Box::pin(pools.take("a-gate", &gateway));

  assert!((&mut waiting).now_or_never().is_none(), "a run was given a place another holds");
  assert!(pools.take("another-gate", &gateway).now_or_never().is_some());
  drop(first);
  let second = waiting.await;

  let session = route(Way::Session);
  let held = pools.take("a-gate", &session).await;

  assert!(pools.take("a-gate", &session).now_or_never().is_none());
  drop((second, held));
}

#[test]
fn a_gate_run_stands_in_the_picture_while_it_is_held() {
  let run = GateRun {
    id: u64::MAX - 7,
    stage: "a-gate".to_owned(),
    chat_id: Some(-5),
    message_id: Some(9),
    started_at: 1,
  };
  let held = live::hold(run.clone());

  assert!(live::now().contains(&run));
  drop(held);
  assert!(!live::now().contains(&run));
}
