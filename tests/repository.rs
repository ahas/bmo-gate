//! Checks that span the repository: what its manifests may depend on, its layout and manifests, its one
//! version, the testbed's declaration, where tests stand, and what no tracked file may hold (Hangul outside the
//! prompts past the ledger, and the names a list kept outside the repository gives). Personal data is held by
//! its own check (`tests/personal_data.rs`).

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path};
use std::process::Command;

use pulldown_cmark::{Event, Options, Parser, Tag, TagEnd};
use serde_json::Value;

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

/// The only `bmo-*` packages a manifest here may depend on: the base libraries, and the gate's own contract
/// package.
const BASE_LIBRARIES: [&str; 4] = ["bmo-chat", "bmo-chat-client", "bmo-ui", "bmo-gate-client"];

/// The testbed's test kit, which a Bun project may take as a dev-dependency beside the base libraries.
const TEST_KIT: &str = "@bmo-testbed/testkit";

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

/// The dependency lists of a Bun or Node manifest.
const PACKAGE_DEPENDENCY_LISTS: [&str; 4] =
  ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/// The tables a testbed declaration may hold beside its two top-level keys.
const TESTBED_TABLES: [&str; 8] =
  ["test", "projects", "tools", "check", "build", "deploy", "runner", "events"];

/// The ledger of Korean lines each file may hold.
const LEDGER: &str = "korean-ledger.json";

/// The folder Korean stands in: what the gates are told and the questions Laya is asked, worded as the models
/// read them. Every other file is held to the ledger.
const PROMPTS: &str = "prompts/";

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

/// Whether a dependency named `name` is one of another repository's packages that is not a base library.
fn is_foreign_bmo(name: &str) -> bool {
  let name = name.to_lowercase().replace('_', "-");
  let bmo = name.starts_with("bmo-") || name.starts_with("@bmo/") || name.starts_with("@bmo-");
  bmo && !BASE_LIBRARIES.contains(&name.as_str()) && name != TEST_KIT
}

/// Every dependency a Bun or Node manifest names, in every one of its lists.
fn package_dependencies(manifest: &Value) -> Vec<String> {
  PACKAGE_DEPENDENCY_LISTS
    .iter()
    .filter_map(|list| manifest.get(list).and_then(Value::as_object))
    .flat_map(|names| names.keys().cloned())
    .collect()
}

/// Every requirement a Python project names: its dependencies, its optional ones and its dependency groups.
/// A requirement is kept as written; whether it names another repository's package is read off its start.
fn python_requirements(project: &toml::Table) -> Vec<String> {
  let strings = |value: Option<&toml::Value>| -> Vec<String> {
    value
      .and_then(toml::Value::as_array)
      .map(|listed| listed.iter().filter_map(toml::Value::as_str).map(str::to_owned).collect())
      .unwrap_or_default()
  };
  let groups = |value: Option<&toml::Value>| -> Vec<String> {
    value
      .and_then(toml::Value::as_table)
      .map(|table| table.values().flat_map(|group| strings(Some(group))).collect())
      .unwrap_or_default()
  };
  let declared = project.get("project").and_then(toml::Value::as_table);
  let mut found = strings(declared.and_then(|table| table.get("dependencies")));
  found.extend(groups(declared.and_then(|table| table.get("optional-dependencies"))));
  found.extend(groups(project.get("dependency-groups")));
  found
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

/// The first cell of every body row of the README's table whose first header cell is `Folder`, without the
/// code span's marks and the trailing slash.
fn readme_folders(readme: &str) -> BTreeSet<String> {
  let mut folders = BTreeSet::new();
  let mut in_head = false;
  let mut cell = 0usize;
  let mut text = String::new();
  let mut is_folder_table = false;
  let mut header_first = None::<String>;
  for event in Parser::new_ext(readme, Options::ENABLE_TABLES) {
    match event {
      Event::Start(Tag::Table(_)) => {
        is_folder_table = false;
        header_first = None;
      }
      Event::Start(Tag::TableHead) => {
        in_head = true;
        cell = 0;
      }
      Event::End(TagEnd::TableHead) => {
        in_head = false;
        is_folder_table = header_first.as_deref() == Some("Folder");
      }
      Event::Start(Tag::TableRow) => cell = 0,
      Event::Start(Tag::TableCell) => text.clear(),
      Event::End(TagEnd::TableCell) => {
        if in_head && cell == 0 {
          header_first = Some(text.trim().to_owned());
        } else if !in_head && is_folder_table && cell == 0 {
          folders.insert(text.trim().trim_end_matches('/').to_owned());
        }
        cell += 1;
      }
      Event::Text(piece) | Event::Code(piece) => text.push_str(&piece),
      _ => {}
    }
  }
  folders
}

fn ledger() -> BTreeMap<String, usize> {
  let text = text_of(LEDGER).expect("the ledger is at the root");
  serde_json::from_str(&text).expect("the ledger is a JSON object from paths to counts")
}

#[test]
fn cargo_depends_on_no_bmo_package_but_the_base_libraries() {
  let metadata = metadata();
  let mut refused = Vec::new();
  for package in metadata["packages"].as_array().expect("metadata lists packages") {
    let owner = package["name"].as_str().expect("a package has a name");
    for dependency in package["dependencies"].as_array().expect("a package lists its dependencies") {
      let name = dependency["name"].as_str().expect("a dependency has a name");
      if is_foreign_bmo(name) || OLD_SHARED_CRATES.contains(&name) {
        refused.push(format!("{owner} -> {name}"));
      }
    }
  }
  assert!(refused.is_empty(), "dependencies outside the base libraries: {refused:?}");
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
fn bun_projects_depend_on_no_bmo_package_but_the_base_libraries() {
  let mut refused = Vec::new();
  for path in tracked_files().into_iter().filter(|path| file_name(path) == "package.json") {
    let manifest: Value = serde_json::from_str(&text_of(&path).expect("a manifest is text"))
      .unwrap_or_else(|error| panic!("{path} is not JSON: {error}"));
    refused.extend(
      package_dependencies(&manifest)
        .into_iter()
        .filter(|name| is_foreign_bmo(name))
        .map(|name| format!("{path} -> {name}")),
    );
  }
  assert!(refused.is_empty(), "Bun dependencies outside the base libraries: {refused:?}");
}

#[test]
fn python_projects_depend_on_no_bmo_package_but_the_base_libraries() {
  let mut refused = Vec::new();
  for path in tracked_files().into_iter().filter(|path| file_name(path) == "pyproject.toml") {
    let project: toml::Table = text_of(&path)
      .expect("a manifest is text")
      .parse()
      .unwrap_or_else(|error| panic!("{path} is not TOML: {error}"));
    refused.extend(
      python_requirements(&project)
        .into_iter()
        .filter(|requirement| is_foreign_bmo(requirement.trim()))
        .map(|requirement| format!("{path} -> {requirement}")),
    );
  }
  assert!(refused.is_empty(), "Python dependencies outside the base libraries: {refused:?}");
}

#[test]
fn a_foreign_bmo_package_is_told_from_a_base_library() {
  assert!(is_foreign_bmo("bmo-receiver"));
  assert!(is_foreign_bmo("@bmo/policy"));
  assert!(is_foreign_bmo("bmo_policy>=1"));
  assert!(!is_foreign_bmo("bmo-ui"));
  assert!(!is_foreign_bmo(TEST_KIT));
  assert!(!is_foreign_bmo("torch==2.14.1"));
}

#[test]
fn the_version_file_holds_the_workspaces_version() {
  let version = text_of("VERSION").expect("VERSION is at the root");
  assert_eq!(version.trim(), env!("CARGO_PKG_VERSION"));
  assert_eq!(bmo_gate::VERSION, version.trim());
}

#[test]
fn the_testbed_declaration_is_in_the_testbeds_format() {
  let declaration: toml::Table = text_of("testbed.toml")
    .expect("testbed.toml is at the root")
    .parse()
    .expect("testbed.toml is TOML");
  let strange: Vec<&String> = declaration
    .keys()
    .filter(|key| !["testbed", "name"].contains(&key.as_str()) && !TESTBED_TABLES.contains(&key.as_str()))
    .collect();

  assert_eq!(declaration.get("testbed").and_then(toml::Value::as_integer), Some(0));
  assert!(strange.is_empty(), "testbed.toml holds keys its format does not name: {strange:?}");
  for key in TESTBED_TABLES.iter().filter(|key| declaration.contains_key(**key)) {
    assert!(declaration[*key].is_table(), "`{key}` in testbed.toml is a table");
  }
  assert_eq!(
    declaration["test"].get("languages").and_then(toml::Value::as_array),
    Some(&vec![toml::Value::from("cargo"), toml::Value::from("bun")])
  );
  assert_eq!(
    declaration["check"].get("base_libraries").and_then(toml::Value::as_array),
    Some(&BASE_LIBRARIES.iter().map(|&name| toml::Value::from(name)).collect())
  );
  assert_eq!(declaration["check"].get("korean_ledger").and_then(toml::Value::as_str), Some(LEDGER));
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
fn the_readme_names_every_top_level_folder_and_no_other() {
  let standing: BTreeSet<String> = tracked_files()
    .into_iter()
    .filter_map(|path| path.split_once('/').map(|(folder, _)| folder.to_owned()))
    .collect();
  let named = readme_folders(&text_of("README.md").expect("README.md is at the root"));
  assert_eq!(named, standing, "the README's folder table and the top-level folders differ");
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
  assert!(is_test_file_by_name("training/tooling/src/laya.test.ts"));
  assert!(is_test_file_by_name("runtime/laya-server/test_server.py"));
  assert!(!is_test_file_by_name("runtime/laya-server/server.py"));
  assert!(holds_rust_test("fn a() {}\n  #[cfg(test)]\nmod tests {}"));
  assert!(!holds_rust_test("// a test of the clock\nfn a() {}"));
}

#[test]
fn no_file_outside_the_prompts_holds_more_hangul_than_the_ledger_allows() {
  let ledger = ledger();
  let found: Vec<String> = tracked_texts()
    .into_iter()
    .filter(|(path, _)| !path.starts_with(PROMPTS))
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
