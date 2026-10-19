//! A JSON value whose objects keep the order their keys were written in, read and written: what Laya is asked and
//! what its record keeps are digested as text, so an object's keys go in the order they were set, as JavaScript
//! writes them, a key set again keeping the place it first took.

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

/// One value, its objects in the order written.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum Ordered {
  Null,
  Flag(bool),
  Number(serde_json::Number),
  Text(String),
  List(Vec<Ordered>),
  Map(IndexMap<String, Ordered>),
}

impl Ordered {
  /// A text value.
  pub fn text(value: impl Into<String>) -> Self {
    Self::Text(value.into())
  }

  /// An object of these entries in this order, a key written again keeping the place it first took.
  pub fn map<K: Into<String>>(entries: impl IntoIterator<Item = (K, Ordered)>) -> Self {
    let mut map = IndexMap::new();

    for (key, value) in entries {
      map.insert(key.into(), value);
    }

    Self::Map(map)
  }

  /// The entries of an object, none for any other value.
  pub fn entries(&self) -> Option<&IndexMap<String, Ordered>> {
    match self {
      Self::Map(map) => Some(map),
      _ => None,
    }
  }

  pub fn as_text(&self) -> Option<&str> {
    match self {
      Self::Text(text) => Some(text),
      _ => None,
    }
  }
}
