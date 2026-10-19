//! The gate's own policy, one part a file under `parts/`, each compiled in and read once on first use. A
//! part whose file does not read as its type is a fault of the build, which the policy's tests meet before
//! anything runs on it. The questions Laya is asked stand under the repository's `prompts/`, the one folder
//! Korean stands in, since Laya's checkpoints were trained on them as written.

use serde::de::DeserializeOwned;

pub mod document_seek;
pub mod gate_pool;
pub mod gates;
pub mod handover;
pub mod laya;
pub mod memories;
pub mod output_gate;
pub mod profiles;
pub mod prompts;
pub mod reference;

/// A line of the policy with each `{name}` it holds filled in, every one at once so a value that itself
/// holds a mark is left as it is; a mark nothing names stays.
pub fn fill_marks(line: &str, values: &[(&str, &str)]) -> String {
  let mut out = String::new();
  let mut rest = line;

  while let Some(open) = rest.find('{') {
    out.push_str(&rest[..open]);

    let after = &rest[open + 1..];
    let name_end = after
      .find(|character: char| !(character.is_ascii_alphanumeric() || character == '_'))
      .unwrap_or(after.len());
    let value = (name_end > 0 && after[name_end..].starts_with('}'))
      .then(|| values.iter().find(|(name, _)| *name == &after[..name_end]))
      .flatten();

    match value {
      Some((_, value)) => {
        out.push_str(value);
        rest = &after[name_end + 1..];
      }
      None => {
        out.push('{');
        rest = after;
      }
    }
  }

  out + rest
}

/// One part read from its file's text.
pub fn read<T: DeserializeOwned>(file: &str, text: &str) -> T {
  toml::from_str(text).unwrap_or_else(|error| panic!("the gate's policy {file} does not read: {error}"))
}

/// A part of the policy, compiled in from its file under `parts/` and read once on first use:
/// `part!(pub GATE_ORDER: GateOrder = "gates.toml");`
#[macro_export]
macro_rules! part {
  ($vis:vis $name:ident: $type:ty = $file:literal) => {
    $vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
      $crate::read($file, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/parts/", $file)))
    });
  };
}
