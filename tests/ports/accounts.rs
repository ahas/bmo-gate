//! The account service port: a person's home path and the paths of their posts read with the service's token and
//! the person as the login, a person placed in no unit read as none, and the units named the farthest first.

use axum::http::Method;
use gate_ports::accounts::{Accounts, HttpAccounts, OrgUnit, Placement};
use serde_json::json;

use super::peer;
use crate::support::stub::Stub;

fn unit(id: i64, name: &str) -> OrgUnit {
  OrgUnit {
    id,
    name: name.into(),
  }
}

#[tokio::test]
async fn a_persons_placement_is_their_home_path_and_their_posts_paths() {
  let stub = Stub::start().await;
  let accounts = HttpAccounts::new(peer(&stub, "accounts-token"));

  stub.answer(
    Method::GET,
    "/users/31/unit",
    200,
    json!({
      "user": "31", "unit": { "id": 3, "name": "Team" }, "company": { "id": 1, "name": "Company" },
      "path": [{ "id": 1, "name": "Company" }, { "id": 3, "name": "Team" }]
    }),
  );
  stub.answer(
    Method::GET,
    "/users/31/posts",
    200,
    json!({ "posts": [{
      "unit": { "id": 4, "name": "Post team" }, "path": [{ "id": 1, "name": "Company" }, { "id": 4, "name": "Post team" }],
      "role": null, "head": false, "since": 1, "by": null
    }] }),
  );

  let placement = accounts.placement(31).await.unwrap().expect("a placement");

  assert_eq!(placement.company, unit(1, "Company"));
  assert_eq!(placement.path, [unit(1, "Company"), unit(3, "Team")]);
  assert_eq!(placement.posts, [vec![unit(1, "Company"), unit(4, "Post team")]]);

  let posts = stub.one("/users/31/posts");

  assert_eq!(posts.bearer().as_deref(), Some("accounts-token"));
  assert_eq!(posts.header("Owner-Key").as_deref(), Some("31"));
}

#[tokio::test]
async fn a_person_placed_in_no_unit_has_no_placement() {
  let stub = Stub::start().await;
  let accounts = HttpAccounts::new(peer(&stub, "t"));

  stub.answer(
    Method::GET,
    "/users/32/unit",
    404,
    json!({ "code": "not-found", "error": "no user 32" }),
  );

  assert_eq!(accounts.placement(32).await.unwrap(), None);
  assert!(stub.seen().iter().all(|seen| seen.path != "/users/32/posts"));
}

#[test]
fn the_units_go_the_farthest_first_posts_off_the_home_path_ahead_of_it() {
  let placement = Placement {
    company: unit(1, "Company"),
    path: vec![unit(1, "Company"), unit(2, "Division"), unit(3, "Team")],
    posts: vec![
      vec![unit(1, "Company"), unit(5, "Other division"), unit(6, "Post team")],
      vec![unit(1, "Company"), unit(5, "Other division"), unit(7, "Second post")],
      vec![unit(1, "Company"), unit(2, "Division")],
    ],
  };
  let ids: Vec<i64> = placement.farthest_first().iter().map(|unit| unit.id).collect();

  assert_eq!(ids, [5, 6, 7, 1, 2, 3]);
}
