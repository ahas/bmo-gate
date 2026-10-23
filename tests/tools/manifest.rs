//! Each tool's manifest read as the tool host reads it: its folder's name, the protocol, the executable it runs,
//! its entries' schemas and manual standing beside it, and the deployment that places it.

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

fn table(path: &Path) -> toml::Table {
  fs::read_to_string(path)
    .unwrap_or_else(|error| panic!("{} reads: {error}", path.display()))
    .parse()
    .unwrap_or_else(|error| panic!("{} is TOML: {error}", path.display()))
}

fn tools() -> Vec<PathBuf> {
  let mut found: Vec<PathBuf> = fs::read_dir(Path::new(ROOT).join("tools"))
    .expect("tools/ stands")
    .map(|entry| entry.expect("a tool folder reads").path())
    .filter(|path| path.is_dir())
    .collect();
  found.sort();
  found
}

fn strings(value: Option<&toml::Value>) -> Vec<String> {
  value
    .and_then(toml::Value::as_array)
    .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_owned)).collect())
    .unwrap_or_default()
}

fn declaration() -> toml::Table {
  table(&Path::new(ROOT).join("testbed.toml"))
}

#[test]
fn the_declaration_checks_the_tools_by_their_manifests() {
  let declaration = declaration();

  assert_eq!(declaration["tools"].get("dir").and_then(toml::Value::as_str), Some("tools"));
  assert!(!tools().is_empty(), "tools/ holds a tool");
}

#[test]
fn every_manifest_reads_as_the_tool_host_reads_it() {
  let binaries = strings(declaration()["build"].get("binaries"));

  for folder in tools() {
    let manifest = table(&folder.join("tool.toml"));
    let tool = manifest["tool"].as_table().expect("[tool] is a table");
    let name = folder.file_name().unwrap().to_string_lossy().into_owned();

    assert_eq!(tool["name"].as_str(), Some(name.as_str()), "{name}: the tool is named as its folder");
    assert_eq!(tool["protocol"].as_integer(), Some(1), "{name}: it speaks protocol 1");
    assert!(tool["timeout"].as_integer().unwrap_or(0) > 0, "{name}: its timeout is more than 0");

    let run = strings(tool.get("run"));
    let executable = run.first().unwrap_or_else(|| panic!("{name}: its run command names something"));
    let crate_manifest = table(&folder.join("Cargo.toml"));
    let built: Vec<String> = crate_manifest["bin"]
      .as_array()
      .expect("the tool's crate declares its executable")
      .iter()
      .filter_map(|bin| bin.get("name").and_then(toml::Value::as_str).map(str::to_owned))
      .collect();

    assert!(built.contains(executable), "{name}: its crate builds {executable}");
    assert!(binaries.contains(executable), "{name}: the release's bin/ holds {executable}");

    let entries = manifest["entry"].as_array().expect("[[entry]] is an array of tables");
    assert!(!entries.is_empty(), "{name}: it declares an entry");

    for entry in entries {
      assert!(
        entry
          .get("description")
          .and_then(toml::Value::as_str)
          .is_some_and(|text| !text.is_empty())
      );
      assert!(
        !strings(entry.get("capabilities")).is_empty(),
        "{name}: each entry asks for a capability"
      );

      for key in ["input", "output"] {
        let Some(file) = entry.get(key).and_then(toml::Value::as_str) else {
          assert_ne!(key, "input", "{name}: each entry names its input schema");
          continue;
        };
        let schema: Value = serde_json::from_str(&fs::read_to_string(folder.join(file)).unwrap())
          .unwrap_or_else(|error| panic!("{name}: {file} is JSON: {error}"));
        assert_eq!(schema["type"], "object", "{name}: {file} is an object's schema");
      }

      if let Some(manual) = entry.get("manual").and_then(toml::Value::as_str) {
        assert!(folder.join(manual).is_file(), "{name}: its manual {manual} stands in its folder");
      }
    }
  }
}

#[test]
fn the_translator_entry_is_a_read_only_call_of_the_gate() {
  let manifest = table(&Path::new(ROOT).join("tools/translate/tool.toml"));
  let entries = manifest["entry"].as_array().unwrap();
  let entry = &entries[0];
  let full = format!("{}/{}", entry["namespace"].as_str().unwrap(), entry["name"].as_str().unwrap());

  assert_eq!(entries.len(), 1);
  assert_eq!(full, gate_translate_tool::ENTRY);
  assert_eq!(strings(entry.get("capabilities")), ["gate.translate"]);
  assert_eq!(entry["hints"].get("read_only").and_then(toml::Value::as_bool), Some(true));
  assert!(entry.get("grant").is_none());

  let input: Value = serde_json::from_str(
    &fs::read_to_string(Path::new(ROOT).join("tools/translate/translate.json")).unwrap(),
  )
  .unwrap();
  assert_eq!(input["required"], serde_json::json!(["language", "texts"]));
  assert_eq!(input["properties"]["texts"]["items"]["type"], "string");
}

#[test]
fn the_deployment_places_the_translator_with_its_files() {
  let steps = declaration()["deploy"]["step"]
    .as_array()
    .expect("the deployment declares its steps")
    .clone();
  let placing = steps
    .iter()
    .filter_map(|step| step.get("command").and_then(toml::Value::as_str))
    .find(|command| command.contains("bmo pocket put tools/translate/.placed"))
    .expect("a deploy step places the translator's tool");

  assert!(placing.contains("--service bmo-gate"));
  assert!(placing.contains("--allow gate.translate"));
  for file in [
    "bin/gate-translate-tool",
    "tools/translate/tool.toml",
    "tools/translate/*.json",
    "tools/translate/manual.md",
  ] {
    assert!(placing.contains(file), "the step copies {file}");
  }
}
