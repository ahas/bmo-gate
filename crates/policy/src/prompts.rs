//! What each gate is told: the instruction files under the repository's `prompts/`, one folder a gate,
//! compiled in so a release carries the instructions its code was written against. A file is read trimmed, and
//! its `{{name}}` marks are filled by `render`.

macro_rules! prompt {
  ($path:literal) => {
    ($path, include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../prompts/", $path)))
  };
}

/// Every instruction file, by its path under `prompts/`.
pub const FILES: [(&str, &str); 21] = [
  prompt!("document-seek/instructions.md"),
  prompt!("library-knowledge/answer.md"),
  prompt!("library-knowledge/instructions.md"),
  prompt!("output-gate/telegram-html/format.md"),
  prompt!("people-search/answer.md"),
  prompt!("people-search/instructions.md"),
  prompt!("people-standing/instructions.md"),
  prompt!("room-rules/answer.md"),
  prompt!("room-rules/instructions.md"),
  prompt!("sanitizer/instructions.md"),
  prompt!("session-summary/chat.md"),
  prompt!("session-summary/worker.md"),
  prompt!("situation-rules/answer.md"),
  prompt!("situation-rules/instructions.md"),
  prompt!("system-documents/answer.md"),
  prompt!("system-documents/instructions.md"),
  prompt!("translator/instructions.md"),
  prompt!("translator/record.md"),
  prompt!("translator/worker.md"),
  prompt!("voice-polish/instructions.md"),
  prompt!("voice-reading/instructions.md"),
];

/// The file at a path under `prompts/`, trimmed; none where no such file is compiled in.
pub fn read(path: &str) -> Option<&'static str> {
  FILES.iter().find(|(name, _)| *name == path).map(|(_, text)| text.trim())
}

/// A gate's own instructions: `instructions.md` in its folder.
pub fn instructions(stage: &str) -> Option<&'static str> {
  read(&format!("{stage}/instructions.md"))
}

/// The answer file a gate's request closes on, `answer.md` in its folder: the shape it answers in, said after
/// the material it judges. None for a gate that has none.
pub fn answer(stage: &str) -> Option<&'static str> {
  read(&format!("{stage}/answer.md"))
}

/// A text's `{{name}}` marks filled with what is named, any other left as it stands.
pub fn render(template: &str, values: &[(&str, &str)]) -> String {
  let mut out = String::new();
  let mut rest = template;

  while let Some(open) = rest.find("{{") {
    out.push_str(&rest[..open]);

    let after = &rest[open + 2..];
    let name_end = after
      .find(|character: char| !(character.is_alphanumeric() || character == '_'))
      .unwrap_or(after.len());
    let value = (name_end > 0 && after[name_end..].starts_with("}}"))
      .then(|| values.iter().find(|(name, _)| *name == &after[..name_end]))
      .flatten();

    match value {
      Some((_, value)) => {
        out.push_str(value);
        rest = &after[name_end + 2..];
      }
      None => {
        out.push_str("{{");
        rest = after;
      }
    }
  }

  out + rest
}
