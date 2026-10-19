//! The service's placement as the relay reads it: the nodes in the order they are asked, each at its own tunnel's
//! listen on the operations machine (docs/llm-server.md, 「The placement」). The file is the installers' as much as
//! the relay's, so it is held to the same reading they hold it to, and read again only when it changes.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::SystemTime;

use serde_json::{Map, Value};

/// The relay's own listen, which no node's tunnel may take.
pub const RELAY_LISTEN: &str = "127.0.0.1:18010";

/// The placement file's name under the data root's `placements/`.
pub const PLACEMENT_FILE: &str = "laya-service.json";

const SHAPE: &str = r#"{"nodes": [{"node": "<node>", "listen": "127.0.0.1:<port>", "cardModels": <a number, optional>, "hostCopy": "pinned|mapped, optional"}, …]}"#;

/// One node of the service: its registered name and where its tunnel lands on the operations machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServiceNode {
  pub node: String,
  pub listen: String,
}

pub fn placement_path(data_root: &Path) -> PathBuf {
  data_root.join("placements").join(PLACEMENT_FILE)
}

/// The placement as it stands now, or the refusal naming the file and the shape it wants.
pub fn read_placement(path: &Path) -> Result<Vec<ServiceNode>, String> {
  let shown = path.display();
  let wanted = format!("Write it in this shape: {SHAPE}");
  let text = match std::fs::read_to_string(path) {
    Ok(text) => text,
    Err(fault) if fault.kind() == std::io::ErrorKind::NotFound => {
      return Err(format!("{shown} is missing. {wanted}"));
    }
    Err(fault) => return Err(format!("{shown} could not be read: {fault}. {wanted}")),
  };
  let value: Value =
    serde_json::from_str(&text).map_err(|fault| format!("{shown} is not JSON ({fault}). {wanted}"))?;

  nodes_of(&value).map_err(|fault| format!("{shown} could not be read: {fault}. {wanted}"))
}

fn object_at<'a>(value: &'a Value, at: &str) -> Result<&'a Map<String, Value>, String> {
  value.as_object().ok_or_else(|| format!("{at} is not an object"))
}

// A registered node's name: what the node list calls it.
fn node_at(value: Option<&Value>, at: &str) -> Result<String, String> {
  let named = value.and_then(Value::as_str).filter(|name| {
    let mut chars = name.chars();

    chars.next().is_some_and(|first| first.is_ascii_lowercase() || first.is_ascii_digit())
      && chars.all(|one| one.is_ascii_lowercase() || one.is_ascii_digit() || one == '-')
  });

  named.map(str::to_owned).ok_or_else(|| format!("{at} is not a registered node's name"))
}

// A loopback listen of its own, above the reserved ports and apart from the relay's.
fn listen_at(value: Option<&Value>, at: &str) -> Result<String, String> {
  let listen = value
    .and_then(Value::as_str)
    .filter(|text| !text.trim().is_empty())
    .ok_or_else(|| format!("{at} is empty or not text"))?;
  let port = listen
    .strip_prefix("127.0.0.1:")
    .filter(|digits| (1..=5).contains(&digits.len()) && digits.chars().all(|one| one.is_ascii_digit()))
    .and_then(|digits| digits.parse::<u32>().ok())
    .unwrap_or(0);

  if !(1024..=65535).contains(&port) {
    return Err(format!("{at} is not of the shape 127.0.0.1:<port>"));
  }

  if listen == RELAY_LISTEN {
    return Err(format!("{at} takes the relay's own listen {RELAY_LISTEN}"));
  }

  Ok(listen.to_owned())
}

/// The nodes a placement's JSON lists, in order, or why it does not read as one.
pub fn nodes_of(value: &Value) -> Result<Vec<ServiceNode>, String> {
  let listed = object_at(value, "the file")?
    .get("nodes")
    .and_then(Value::as_array)
    .ok_or_else(|| "nodes is not a list".to_owned())?;

  if listed.is_empty() {
    return Err("nodes is empty".to_owned());
  }

  let mut nodes = Vec::with_capacity(listed.len());

  for (index, one) in listed.iter().enumerate() {
    let entry = object_at(one, &format!("nodes[{index}]"))?;
    let node = node_at(entry.get("node"), &format!("nodes[{index}].node"))?;
    let listen = listen_at(entry.get("listen"), &format!("nodes[{index}].listen"))?;

    if let Some(count) = entry.get("cardModels") {
      count
        .as_u64()
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("nodes[{index}].cardModels is not a whole number above 0"))?;
    }

    if let Some(kind) = entry.get("hostCopy") {
      kind
        .as_str()
        .filter(|kind| ["pinned", "mapped"].contains(kind))
        .ok_or_else(|| format!("nodes[{index}].hostCopy is pinned or mapped"))?;
    }

    nodes.push(ServiceNode { node, listen });
  }

  for key in ["node", "listen"] {
    let mut seen = HashSet::new();
    let named = nodes.iter().map(|one| if key == "node" { &one.node } else { &one.listen });

    if let Some(twice) = named.into_iter().find(|name| !seen.insert(*name)) {
      return Err(format!("{key} {twice} stands twice"));
    }
  }

  Ok(nodes)
}

/// The placement as it stands, read again only when its file's modification time changes. A placement that turns
/// unreadable keeps the last one read and says so once.
pub struct Watcher {
  path: PathBuf,
  held: Mutex<Held>,
}

struct Held {
  // The modification time last looked at, absent until the first look; a missing file is `Some(None)`.
  seen: Option<Option<SystemTime>>,
  nodes: Vec<ServiceNode>,
}

impl Watcher {
  pub fn new(path: PathBuf) -> Self {
    Watcher {
      path,
      held: Mutex::new(Held {
        seen: None,
        nodes: Vec::new(),
      }),
    }
  }

  pub fn nodes(&self) -> Vec<ServiceNode> {
    let changed = std::fs::metadata(&self.path).and_then(|meta| meta.modified()).ok();
    let mut held = self.held.lock().unwrap();

    if held.seen != Some(changed) {
      held.seen = Some(changed);

      match read_placement(&self.path) {
        Ok(nodes) => {
          let order: Vec<String> =
            nodes.iter().map(|one| format!("{}({})", one.node, one.listen)).collect();

          eprintln!("laya-relay: asking in the order {}", order.join(" -> "));
          held.nodes = nodes;
        }
        Err(fault) => eprintln!(
          "laya-relay: {fault}. This reading is passed over and the order read before stands (no node is asked where none was read)"
        ),
      }
    }

    held.nodes.clone()
  }
}
