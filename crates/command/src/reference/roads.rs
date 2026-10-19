//! `reference roads` (docs/reference-selection.md, 「What it picks and what it costs, measured」): whether what a
//! gate is offered out of the fragment rows is what the index files themselves name, the two roads set side by side.
//!
//! The row road is the one a turn walks: the libraries are built out of the rows the brain answers. The file road
//! below reads the index files with the rules each library was read by, and is written out in full rather than
//! taken from the road, because a comparison against the code under test measures nothing. The files it can read
//! are the shipped pieces' — the system documents' index and the lore's, under the shipped folder; every other
//! library's index files are the brain's, which it serves as rows alone, so those gates are named unavailable.
//!
//! What is compared, for every room the receiver keeps and every room the reference record names: the candidates
//! the system documents' gate is offered, in the order it is offered them, and the body each resolves to.

use std::collections::BTreeSet;
use std::path::Path;

use gate_policy::fill_marks;
use gate_reference::Reference;
use gate_reference::fragments::{IndexEntry, index_entries};
use gate_reference::{pick, road};
use gate_stages::sql::all;
use gate_words::reference_benches as words;
use serde::Serialize;

use super::{counted_gates, db, road_of};
use crate::{Answered, Fault};

/// The gate whose index files are shipped, which the file road reads.
pub const SHIPPED_GATE: &str = "system-documents";

/// The gates whose index files are the brain's: every counted gate but the shipped one.
pub fn brain_gates() -> Vec<String> {
  counted_gates().into_iter().filter(|stage| stage != SHIPPED_GATE).collect()
}

#[derive(clap::Args, Debug)]
pub struct RoadsArgs {
  /// Another database's address.
  #[arg(long, allow_hyphen_values = true)]
  db: Option<String>,
  #[arg(long)]
  json: bool,
  #[arg(short = 'h', long)]
  help: bool,
}

/// One candidate as a road offers it.
struct Offer {
  slug: String,
  about: String,
  path: Option<String>,
}

impl Offer {
  // The candidate as one line, so two roads' offers are compared whole rather than slug by slug.
  fn line(&self) -> String {
    format!("{} \u{2014} {} [{}]", self.slug, self.about, self.path.as_deref().unwrap_or("no body"))
  }
}

/// Where two roads parted for one gate in one room: what only one of them offers, and where both offer the same
/// candidates, the first place their order parts.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Difference {
  pub chat_id: i64,
  pub stage: String,
  pub only_files: Vec<String>,
  pub only_rows: Vec<String>,
  pub order: Option<(String, String)>,
}

pub async fn run(args: RoadsArgs) -> Answered {
  if args.help {
    return Ok(vec![words::USAGE_ROADS.to_owned()]);
  }

  let (_, reference) = road_of(args.db.as_deref()).await?;

  roads(&reference, args.json).await
}

/// Every room the receiver keeps and the reference record names.
async fn rooms(reference: &Reference) -> Result<BTreeSet<i64>, Fault> {
  let mut rooms: BTreeSet<i64> = reference
    .receiver
    .titles()
    .await
    .map_err(|why| Fault::failed(format!("the receiver: {why}")))?
    .into_iter()
    .map(|room| room.chat_id)
    .collect();

  rooms.extend(
    all(db(reference), r#"SELECT DISTINCT "chat_id" FROM "reference_verdicts""#, vec![])
      .await
      .map_err(|why| Fault::failed(format!("the gate's database: {why}")))?
      .iter()
      .filter_map(|row| row.try_get::<i64>("", "chat_id").ok()),
  );

  Ok(rooms)
}

/// Both roads over every room, as the lines naming where they part, or as JSON.
pub async fn roads(reference: &Reference, json: bool) -> Answered {
  let rooms = rooms(reference).await?;
  let mut differences = vec![];
  let mut offers = 0;

  for &chat_id in &rooms {
    let rows: Vec<String> = road::gates_of(reference, chat_id, reference.chat_agent(), true)
      .await
      .map_err(|why| Fault::failed(format!("reference roads: {why}")))?
      .into_iter()
      .find(|gate| gate.stage == SHIPPED_GATE)
      .map(|gate| {
        pick::offered(&gate.libraries)
          .into_iter()
          .map(|offered| {
            Offer {
              slug: offered.slug,
              about: offered.about,
              path: offered.path,
            }
            .line()
          })
          .collect()
      })
      .unwrap_or_default();
    let on_files: Vec<String> = file_offers(reference.shipped.as_deref()).iter().map(Offer::line).collect();

    offers += rows.len();

    let only_files: Vec<String> = on_files.iter().filter(|line| !rows.contains(line)).cloned().collect();
    let only_rows: Vec<String> = rows.iter().filter(|line| !on_files.contains(line)).cloned().collect();
    let order = if only_files.is_empty() && only_rows.is_empty() {
      on_files
        .iter()
        .zip(&rows)
        .find(|(file, row)| file != row)
        .map(|(file, row)| (file.clone(), row.clone()))
    } else {
      None
    };

    if !only_files.is_empty() || !only_rows.is_empty() || order.is_some() {
      differences.push(Difference {
        chat_id,
        stage: SHIPPED_GATE.to_owned(),
        only_files,
        only_rows,
        order,
      });
    }
  }

  if json {
    #[derive(Serialize)]
    struct Written<'a> {
      rooms: usize,
      offers: usize,
      differences: &'a [Difference],
      unavailable: Vec<String>,
    }

    return Ok(vec![
      serde_json::to_string_pretty(&Written {
        rooms: rooms.len(),
        offers,
        differences: &differences,
        unavailable: brain_gates(),
      })
      .unwrap_or_default(),
    ]);
  }

  let mut lines = vec![format!(
    "rooms compared: {} \u{b7} candidates offered on the row road: {offers}",
    rooms.len()
  )];

  lines.extend(
    brain_gates()
      .iter()
      .map(|stage| fill_marks(words::ROADS_UNAVAILABLE, &[("stage", stage)])),
  );

  for difference in &differences {
    lines.push(format!(
      "chat {} \u{b7} {}{}",
      difference.chat_id,
      difference.stage,
      if difference.order.is_some() {
        " \u{b7} the same candidates in another order"
      } else {
        ""
      }
    ));

    if let Some((files, rows)) = &difference.order {
      lines.push(format!("  the files offer first: {files}"));
      lines.push(format!("  the rows offer first:  {rows}"));
    }

    lines.extend(difference.only_files.iter().map(|line| format!("  only the files offer: {line}")));
    lines.extend(difference.only_rows.iter().map(|line| format!("  only the rows offer: {line}")));
  }

  lines.push(if differences.is_empty() {
    "the two roads offer the same candidates in the same order, resolving to the same bodies".to_owned()
  } else {
    format!("{} gates differ", differences.len())
  });

  Ok(lines)
}

// The entries of an index file as the file road read them; none where it is not there.
fn read(path: &Path) -> Vec<IndexEntry> {
  std::fs::read_to_string(path).map(|text| index_entries(&text)).unwrap_or_default()
}

// A body's place under the shipped folder, where it is there.
fn body(shipped: &Path, path: &Path) -> Option<String> {
  shipped.join(path).exists().then(|| path.to_string_lossy().into_owned())
}

// The system documents' gate as its index files offer it: the reference documents' index, a document's body named
// for its slug in capitals, and the lore's index with its chunks, every room reading the lore. Nothing where no
// shipped folder is named.
fn file_offers(shipped: Option<&Path>) -> Vec<Offer> {
  let Some(shipped) = shipped else { return vec![] };
  let documents = read(&shipped.join("docs").join("reference-index.md")).into_iter().map(|entry| {
    let name = format!("{}.md", entry.slug.to_uppercase());

    Offer {
      path: body(shipped, Path::new(&name)),
      slug: entry.slug,
      about: entry.title,
    }
  });
  let lore = read(&shipped.join("docs").join("lore").join("index.md")).into_iter().map(|entry| {
    let chunk = Path::new("docs").join("lore").join("chunks").join(format!("{}.md", entry.slug));

    Offer {
      path: body(shipped, &chunk),
      slug: entry.slug,
      about: entry.title,
    }
  });

  documents.chain(lore).collect()
}
