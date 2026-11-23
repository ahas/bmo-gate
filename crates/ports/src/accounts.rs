//! The account service port (`docs/boundary-api.md`, 「The account service」): where a person stands in their
//! organisation, and whether the delegation chain lets them read a shared layer of brains, read from bmo-web's
//! server in its conventions — camelCase bodies, its server's token, a user named by the digits of their id.

use futures_util::future::BoxFuture;
use serde::Deserialize;

use crate::http::{Answer, Caller, Peer};

/// One organisation unit as the account service names it: its number and its name.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct OrgUnit {
  pub id: i64,
  pub name: String,
}

/// Where a person stands: their company, the units from it down to their home unit, and the path of each unit they
/// hold a post in, from the company down to it, in the order the service answers them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
  pub company: OrgUnit,
  pub path: Vec<OrgUnit>,
  pub posts: Vec<Vec<OrgUnit>>,
}

impl Placement {
  /// The person's units in the order an org brain read names them, the farthest first
  /// (`docs/reference-selection.md`, 「What an organisation hands its members」): the units of the posts' paths
  /// standing on no other path named, then the company down to the home unit; each unit once.
  pub fn farthest_first(&self) -> Vec<OrgUnit> {
    let on_home = |unit: &OrgUnit| self.path.iter().any(|home| home.id == unit.id);
    let mut units: Vec<OrgUnit> = Vec::new();

    for unit in self.posts.iter().flatten().filter(|unit| !on_home(unit)) {
      if !units.iter().any(|named| named.id == unit.id) {
        units.push(unit.clone());
      }
    }

    units.extend(self.path.iter().cloned());
    units
  }
}

/// The chain's kind saying whether the org brains are read for a person (the brain's `docs/design.md`, 「The layers
/// a reading takes」).
pub const ORGANISATION_LAYER: &str = "brain.organisation";

/// The chain's kind saying whether the platform's base is read for a person.
pub const BASE_LAYER: &str = "brain.global";

/// Every call the gate makes on the account service.
pub trait Accounts: Send + Sync {
  /// Where the person stands, or none where the service places them in no unit.
  fn placement(&self, user: i64) -> BoxFuture<'_, Answer<Option<Placement>>>;

  /// Whether the layer the chain's kind names is read for the person: what the kind resolves to, and read where
  /// the service holds no such kind or no such person, as the kind's default is.
  fn reads<'a>(&'a self, user: i64, layer: &'a str) -> BoxFuture<'a, Answer<bool>>;
}

/// No account service: every person stands in no unit, so no org brain is read, and every layer reads as its
/// default does.
pub struct NoAccounts;

impl Accounts for NoAccounts {
  fn placement(&self, _user: i64) -> BoxFuture<'_, Answer<Option<Placement>>> {
    Box::pin(async { Ok(None) })
  }

  fn reads<'a>(&'a self, _user: i64, _layer: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async { Ok(true) })
  }
}

#[derive(Deserialize)]
struct Resolved {
  #[serde(default)]
  value: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct UserUnit {
  company: OrgUnit,
  path: Vec<OrgUnit>,
}

#[derive(Deserialize)]
struct Post {
  path: Vec<OrgUnit>,
}

#[derive(Deserialize)]
struct Posts {
  posts: Vec<Post>,
}

/// The account service over HTTP.
#[derive(Clone, Debug)]
pub struct HttpAccounts {
  caller: Caller,
}

impl HttpAccounts {
  pub fn new(peer: Peer) -> Self {
    Self {
      caller: Caller::new("the account service", peer),
    }
  }
}

impl Accounts for HttpAccounts {
  fn placement(&self, user: i64) -> BoxFuture<'_, Answer<Option<Placement>>> {
    Box::pin(async move {
      let user = user.to_string();
      let Some(home) = self
        .caller
        .get_or_nothing::<UserUnit>("a person's unit", &["users", &user, "unit"], &[])
        .await?
      else {
        return Ok(None);
      };
      let posts: Posts = self
        .caller
        .get_with("a person's posts", &["users", &user, "posts"], &[], &[("Owner-Key", &user)])
        .await?;

      Ok(Some(Placement {
        company: home.company,
        path: home.path,
        posts: posts.posts.into_iter().map(|post| post.path).collect(),
      }))
    })
  }

  fn reads<'a>(&'a self, user: i64, layer: &'a str) -> BoxFuture<'a, Answer<bool>> {
    Box::pin(async move {
      let person = user.to_string();
      let resolved = self
        .caller
        .get_or_nothing::<Resolved>(
          "whether a layer is read",
          &["chain", "kinds", layer, "resolve"],
          &[("person", &person)],
        )
        .await?;

      Ok(
        resolved
          .and_then(|resolved| resolved.value)
          .and_then(|value| value.as_bool())
          .unwrap_or(true),
      )
    })
  }
}
