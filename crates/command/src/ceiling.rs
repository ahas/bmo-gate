//! The ceiling a noun's answer is held under, and the one wording for saying what was left out of it: the longest
//! run of items from the front whose rendering fits, the rest named in the noun's own terms.

use gate_markup::text::count_text;

/// The most characters one answer holds before it is cut.
pub const MAX_ANSWER_CHARS: usize = 30_000;

/// How a noun names what it cut: the unit it counts, how to ask for the rest, and the ceiling.
#[derive(Clone, Copy, Debug)]
pub struct Said<'a> {
  pub unit: &'a str,
  pub how: &'a str,
  pub limit: usize,
}

impl<'a> Said<'a> {
  pub fn new(unit: &'a str, how: &'a str) -> Self {
    Self {
      unit,
      how,
      limit: MAX_ANSWER_CHARS,
    }
  }
}

/// What fitted under the ceiling, and the line saying what was left out, where something was.
#[derive(Debug, PartialEq)]
pub struct Capped<'a, T> {
  pub kept: &'a [T],
  pub left: usize,
  pub note: Option<String>,
}

// Characters are code points, the units a reader counts in.
fn chars(text: &str) -> usize {
  text.chars().count()
}

/// The longest run of `items` from the front whose rendering fits under the ceiling. `render` returns exactly what
/// the noun would print for a run, so the ceiling holds the answer itself. Where even one item is over the ceiling
/// nothing is kept: half an item is not an item.
pub fn cap_items<'a, T>(items: &'a [T], render: impl Fn(&[T]) -> String, said: Said<'_>) -> Capped<'a, T> {
  if chars(&render(items)) <= said.limit {
    return Capped {
      kept: items,
      left: 0,
      note: None,
    };
  }

  // The largest run that fits, found by halving: a longer run is a longer answer.
  let mut fits = 0;
  let mut over = items.len();

  while over - fits > 1 {
    let middle = (fits + over) / 2;

    if chars(&render(&items[..middle])) <= said.limit {
      fits = middle;
    } else {
      over = middle;
    }
  }

  let left = items.len() - fits;
  let limit = count_text(said.limit);
  let note = if fits == 0 {
    format!(
      "-- one of the {} alone is over the {limit}-character ceiling, so nothing was given. {}",
      said.unit, said.how
    )
  } else {
    format!(
      "-- cut at the {limit}-character ceiling: {} of {} {}. For the other {}: {}",
      count_text(fits),
      count_text(items.len()),
      said.unit,
      count_text(left),
      said.how,
    )
  };

  Capped {
    kept: &items[..fits],
    left,
    note: Some(note),
  }
}
