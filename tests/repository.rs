//! Checks that span the repository: what its manifests may depend on, its layout and manifests, its one
//! version, where tests stand, and what no tracked file may hold (Hangul outside the prompts and the root
//! READMEs past the ledger, and the names a list kept outside the repository gives). Personal data is held by
//! the testbed's `personal-data` check, which the declaration enables.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};
use std::process::Command;

use serde_json::Value;

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

/// Shared crates of the single repository this one was separated from; what the gate needs of them lives
/// in-tree here.
const OLD_SHARED_CRATES: [&str; 14] = [
  "agent-host",
  "archive-pool",
  "archive-read",
  "bmo-lang",
  "bmo-markup",
  "bmo-policy",
  "bmo-tool",
  "fragment-desk",
  "harness-providers",
  "queue-read",
  "queue-rows",
  "room-acts",
  "seoul-clock",
  "test-support",
];

/// File names that declare a package or a project to some other build tool.
const OTHER_MANIFESTS: [&str; 12] = [
  "package.json",
  "bun.lock",
  "bun.lockb",
  "deno.json",
  "pnpm-workspace.yaml",
  "pyproject.toml",
  "setup.py",
  "go.mod",
  "Gemfile",
  "pom.xml",
  "build.gradle",
  "Makefile",
];

/// The ledger of Korean lines each file may hold.
const LEDGER: &str = "korean-ledger.json";

/// The variable naming the file of names no tracked file may hold: agents', people's and machines'. No
/// repository keeps such a list, so it is read from outside the checkout.
const NAMES_LIST: &str = "BMO_NAMES_LIST";

/// The Hangul blocks of Unicode: Jamo, compatibility Jamo, Jamo extended A and B, syllables, and the
/// halfwidth forms, named by code point so this file holds none of them.
const HANGUL: [(u32, u32); 6] = [
  (0x1100, 0x11FF),
  (0x3130, 0x318F),
  (0xA960, 0xA97F),
  (0xAC00, 0xD7AF),
  (0xD7B0, 0xD7FF),
  (0xFFA0, 0xFFDC),
];

fn metadata() -> Value {
  let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".to_owned());
  let output = Command::new(cargo)
    .args(["metadata", "--no-deps", "--format-version", "1"])
    .current_dir(ROOT)
    .output()
    .expect("cargo metadata runs");
  assert!(
    output.status.success(),
    "cargo metadata failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  serde_json::from_slice(&output.stdout).expect("cargo metadata answers JSON")
}

/// Every file git tracks or would track: the committed ones and the new ones it does not ignore.
fn tracked_files() -> Vec<String> {
  let output = Command::new("git")
    .args(["ls-files", "-z", "--cached", "--others", "--exclude-standard"])
    .current_dir(ROOT)
    .output()
    .expect("git ls-files runs");
  assert!(
    output.status.success(),
    "git ls-files failed: {}",
    String::from_utf8_lossy(&output.stderr)
  );
  let mut files: Vec<String> = String::from_utf8(output.stdout)
    .expect("tracked paths are UTF-8")
    .split('\0')
    .filter(|path| !path.is_empty())
    .filter(|path| Path::new(ROOT).join(path).is_file())
    .map(str::to_owned)
    .collect();
  files.sort();
  files.dedup();
  files
}

/// The text of a tracked file, or nothing when it is gone from the work tree or is not UTF-8 text.
fn text_of(path: &str) -> Option<String> {
  match fs::read(Path::new(ROOT).join(path)) {
    Ok(bytes) => String::from_utf8(bytes).ok(),
    Err(error) if error.kind() == ErrorKind::NotFound => None,
    Err(error) => panic!("{path} is unreadable: {error}"),
  }
}

fn tracked_texts() -> Vec<(String, String)> {
  tracked_files()
    .into_iter()
    .filter_map(|path| text_of(&path).map(|text| (path, text)))
    .collect()
}

fn file_name(path: &str) -> &str {
  Path::new(path).file_name().and_then(|name| name.to_str()).unwrap_or(path)
}

fn is_hangul(character: char) -> bool {
  let point = u32::from(character);
  HANGUL.iter().any(|&(first, last)| (first..=last).contains(&point))
}

/// Whether `path` is one of the root READMEs, which name the Korean one in their language line and give it whole.
fn is_root_readme(path: &str) -> bool {
  !path.contains('/') && path.starts_with("README") && path.ends_with(".md")
}

/// How many lines of `text` hold Hangul.
fn hangul_lines(text: &str) -> usize {
  text.lines().filter(|line| line.chars().any(is_hangul)).count()
}

fn is_word_character(character: char) -> bool {
  character.is_alphanumeric() || character == '_'
}

/// Whether `word` stands in `text` as a whole word, not as part of a longer one.
fn holds_word(text: &str, word: &str) -> bool {
  text.match_indices(word).any(|(start, found)| {
    let before = text[..start].chars().next_back();
    let after = text[start + found.len()..].chars().next();
    !before.is_some_and(is_word_character) && !after.is_some_and(is_word_character)
  })
}

fn names_list(names: &toml::Table, from: &str, key: &str) -> Vec<String> {
  names
    .get(key)
    .and_then(toml::Value::as_array)
    .map(|listed| {
      listed
        .iter()
        .map(|name| name.as_str().unwrap_or_else(|| panic!("{from}: `{key}` lists strings")).to_owned())
        .collect()
    })
    .unwrap_or_default()
}

/// Whether a file outside `tests/` is a test by its own name: a Bun or Node test file, or a Python one.
fn is_test_file_by_name(path: &str) -> bool {
  let name = file_name(path);
  name.contains(".test.")
    || name.contains(".spec.")
    || (name.starts_with("test_") && name.ends_with(".py"))
    || name.ends_with("_test.py")
}

/// Whether Rust source holds a test or a test module of its own.
fn holds_rust_test(text: &str) -> bool {
  text
    .lines()
    .map(str::trim_start)
    .any(|line| line.starts_with("#[cfg(test)]") || line.starts_with("#[test]"))
}

fn ledger() -> BTreeMap<String, usize> {
  let text = text_of(LEDGER).expect("the ledger is at the root");
  serde_json::from_str(&text).expect("the ledger is a JSON object from paths to counts")
}

#[test]
fn no_package_takes_an_old_shared_crate_name() {
  let metadata = metadata();
  let taken: Vec<&str> = metadata["packages"]
    .as_array()
    .expect("metadata lists packages")
    .iter()
    .map(|package| package["name"].as_str().expect("a package has a name"))
    .filter(|name| OLD_SHARED_CRATES.contains(name))
    .collect();
  assert!(taken.is_empty(), "packages named after old shared crates: {taken:?}");
}

#[test]
fn the_version_file_holds_the_workspaces_version() {
  let version = text_of("VERSION").expect("VERSION is at the root");
  assert_eq!(version.trim(), env!("CARGO_PKG_VERSION"));
  assert_eq!(bmo_gate::VERSION, version.trim());
}

#[test]
fn only_the_cargo_manifest_at_the_root() {
  let found: Vec<String> = fs::read_dir(ROOT)
    .expect("the repository root is readable")
    .map(|entry| entry.expect("a root entry is readable").file_name().to_string_lossy().into_owned())
    .filter(|name| OTHER_MANIFESTS.contains(&name.as_str()))
    .collect();
  assert!(found.is_empty(), "the root holds {found:?}; only the Cargo manifest belongs there");
}

#[test]
fn no_directory_is_named_after_its_parent() {
  let twins: Vec<String> = tracked_files()
    .into_iter()
    .filter(|path| {
      let parts: Vec<Component> = Path::new(path).components().collect();
      parts.windows(2).take(parts.len().saturating_sub(2)).any(|pair| pair[0] == pair[1])
    })
    .collect();
  assert!(twins.is_empty(), "these paths repeat a directory inside itself: {twins:?}");
}

#[test]
fn tests_stand_only_in_tests() {
  let outside: Vec<String> = tracked_texts()
    .into_iter()
    .filter(|(path, _)| !path.starts_with("tests/"))
    .filter(|(path, text)| is_test_file_by_name(path) || (path.ends_with(".rs") && holds_rust_test(text)))
    .map(|(path, _)| path)
    .collect();
  assert!(outside.is_empty(), "tests outside tests/: {outside:?}");
}

#[test]
fn a_test_is_told_by_its_name_and_its_attributes() {
  assert!(is_test_file_by_name("training/tooling/src/gguf-llm.test.ts"));
  assert!(is_test_file_by_name("tools/translate/test_tool.py"));
  assert!(!is_test_file_by_name("training/tooling/src/gguf-llm.ts"));
  assert!(holds_rust_test("fn a() {}\n  #[cfg(test)]\nmod tests {}"));
  assert!(!holds_rust_test("// a test of the clock\nfn a() {}"));
}

#[test]
fn no_file_outside_the_prompts_holds_more_hangul_than_the_ledger_allows() {
  let ledger = ledger();
  let found: Vec<String> = tracked_texts()
    .into_iter()
    .filter(|(path, _)| !path.starts_with("prompts/") && !is_root_readme(path))
    .filter_map(|(path, text)| {
      let held = hangul_lines(&text);
      let allowed = ledger.get(&path).copied().unwrap_or(0);
      (held > allowed).then(|| format!("{path}: {held} lines with Hangul, the ledger allows {allowed}"))
    })
    .collect();
  assert!(found.is_empty(), "these files hold Hangul past the ledger: {found:?}");
}

#[test]
fn the_ledger_names_only_tracked_files_with_counts() {
  let ledger = ledger();
  let tracked: BTreeSet<String> = tracked_texts().into_iter().map(|(path, _)| path).collect();
  let unknown: Vec<&String> = ledger.keys().filter(|path| !tracked.contains(*path)).collect();
  assert!(unknown.is_empty(), "these ledger entries name no tracked text file: {unknown:?}");
  let empty: Vec<&String> =
    ledger.iter().filter(|(_, allowed)| **allowed == 0).map(|(path, _)| path).collect();
  assert!(empty.is_empty(), "these ledger entries allow no line: {empty:?}");
}

#[test]
fn hangul_is_told_by_its_blocks() {
  let inside = [0x1100, 0x3131, 0xA960, 0xAC00, 0xD7A3, 0xD7B0, 0xFFA0].map(char::from_u32);
  let outside = [0x10FF, 0x3040, 0xABFF, 0xFFDD].map(char::from_u32);
  assert!(inside.into_iter().flatten().all(is_hangul));
  assert!(!outside.into_iter().flatten().any(is_hangul));
}

/// The names list, as `BMO_NAMES_LIST` names it: `words` matched as whole words ignoring case,
/// `exact_words` as whole words with their case kept, `anywhere` matched anywhere, and `allowed`, terms of
/// another unit's protocol that carry a name as part of themselves, set aside before the names are matched.
/// Where no list is named, the names are not checked here and the run says so.
#[test]
fn no_listed_names_in_tracked_files() {
  let Some(from) = std::env::var_os(NAMES_LIST) else {
    eprintln!("{NAMES_LIST} names no list; the names were not checked");
    return;
  };
  let from = from.to_string_lossy().into_owned();
  let names: toml::Table = fs::read_to_string(&from)
    .unwrap_or_else(|error| panic!("{from} is unreadable: {error}"))
    .parse()
    .unwrap_or_else(|error| panic!("{from} is not TOML: {error}"));
  let words: Vec<String> =
    names_list(&names, &from, "words").iter().map(|name| name.to_lowercase()).collect();
  let exact_words = names_list(&names, &from, "exact_words");
  let anywhere = names_list(&names, &from, "anywhere");
  let allowed = names_list(&names, &from, "allowed");
  let mut found = Vec::new();
  for (path, text) in tracked_texts() {
    let text = allowed.iter().fold(text, |text, term| text.replace(term.as_str(), " "));
    let lowered = text.to_lowercase();
    let held = words
      .iter()
      .filter(|name| holds_word(&lowered, name))
      .chain(exact_words.iter().filter(|name| holds_word(&text, name)))
      .chain(anywhere.iter().filter(|name| text.contains(name.as_str())));
    found.extend(held.map(|name| format!("{path}: {name}")));
  }
  assert!(found.is_empty(), "listed names in tracked files: {found:?}");
}
