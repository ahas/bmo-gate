//! The console bundle the gate serves (`docs/api.md`, 「Console」): its manifest, read through bmo-ui's own reading,
//! its words, its module and stylesheet named by the digest of their bytes, the guard on every route its screens
//! use, and the translations it relays outside its prefix with their bounds.

use std::path::PathBuf;
use std::process::Command;

use gate_server::console::ConsoleBundle;
use gate_stages::translator::{BUSY_WAIT_SECONDS, CALL_ORIGINALS, STANDING_ORIGINALS};
use reqwest::header::{CACHE_CONTROL, CONTENT_TYPE, HeaderMap, RETRY_AFTER};
use reqwest::{Method, StatusCode};
use serde_json::{Map, Value, json};

use crate::{Ground, TOKEN, ground, ground_serving, refused};

const ROOT: &str = env!("CARGO_MANIFEST_DIR");

/// The bundle's words as `client/i18n/` holds them, each locale under its code, as its build writes them.
fn words() -> Value {
  let folder = PathBuf::from(ROOT).join("client/i18n");
  let mut locales = Map::new();

  for entry in std::fs::read_dir(&folder).unwrap() {
    let path = entry.unwrap().path();

    if path.extension().is_some_and(|extension| extension == "json") {
      let locale = path.file_stem().unwrap().to_string_lossy().into_owned();

      locales.insert(locale, serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap());
    }
  }

  Value::Object(locales)
}

/// A bundle folder of the test's own: a module and a stylesheet of the bytes given, and the bundle's own words.
fn folder(test: &str, module: &str, stylesheet: Option<&str>) -> PathBuf {
  let folder = std::env::temp_dir().join(format!("gate-bundle-{}-{test}", std::process::id()));

  std::fs::create_dir_all(&folder).unwrap();
  std::fs::write(folder.join("bundle.js"), module).unwrap();
  std::fs::write(folder.join("words.json"), serde_json::to_vec(&words()).unwrap()).unwrap();

  match stylesheet {
    Some(stylesheet) => std::fs::write(folder.join("bundle.css"), stylesheet).unwrap(),
    None => {
      let _ = std::fs::remove_file(folder.join("bundle.css"));
    }
  }

  folder
}

const MODULE: &str = "export default { routes: [] };\n";

const STYLESHEET: &str = ".flex{display:flex}\n";

async fn serving(test: &str) -> Ground {
  let bundle = ConsoleBundle::read(&folder(test, MODULE, Some(STYLESHEET))).unwrap();

  ground_serving(test, Some(bundle), |_| Some("CLEAN".into())).await
}

/// How a call reaches the gate: with the gate's token or none, and with the headers a console sets.
struct Caller<'a> {
  token: bool,
  role: Option<&'a str>,
  owner: Option<&'a str>,
}

const CONSOLE: Caller = Caller {
  token: true,
  role: Some("administrator"),
  owner: None,
};

const NO_TOKEN: Caller = Caller {
  token: false,
  role: Some("administrator"),
  owner: None,
};

const NO_ROLE: Caller = Caller {
  token: true,
  role: None,
  owner: None,
};

const MEMBER: Caller = Caller {
  token: true,
  role: Some("member"),
  owner: None,
};

async fn ask(
  ground: &Ground,
  caller: &Caller<'_>,
  method: Method,
  path: &str,
  body: Option<Value>,
) -> (StatusCode, HeaderMap, Vec<u8>) {
  let mut request = ground.client.request(method, format!("{}{path}", ground.address));

  if caller.token {
    request = request.bearer_auth(TOKEN);
  }
  if let Some(role) = caller.role {
    request = request.header("Owner-Role", role);
  }
  if let Some(owner) = caller.owner {
    request = request.header("Owner-Key", owner);
  }
  if let Some(body) = body {
    request = request.json(&body);
  }

  let response = request.send().await.unwrap();
  let status = response.status();
  let headers = response.headers().clone();

  (status, headers, response.bytes().await.unwrap().to_vec())
}

fn json_of(bytes: &[u8]) -> Value {
  serde_json::from_slice(bytes).unwrap()
}

#[tokio::test]
async fn the_manifest_is_answered_on_the_token_alone_and_keeps_the_contract() {
  let ground = serving("manifest").await;
  let (status, _, bytes) = ask(&ground, &NO_ROLE, Method::GET, "/console-manifest", None).await;
  let manifest = json_of(&bytes);

  assert_eq!(status, StatusCode::OK, "{manifest}");
  assert_eq!(
    (&manifest["name"], &manifest["title"], &manifest["screenPath"], &manifest["serviceName"]),
    (&json!("gates"), &json!("gates.title.gates"), &json!("/gates"), &json!("gate"))
  );
  assert_eq!(
    (&manifest["apiPrefix"], &manifest["words"]),
    (&json!("/console"), &json!("/console/words"))
  );
  assert_eq!((&manifest["role"], &manifest["ownerKey"]), (&json!("administrator"), &json!(false)));
  assert_eq!(
    (&manifest["events"], &manifest["websocket"], &manifest["pushKinds"]),
    (&json!(false), &json!(false), &json!([]))
  );
  assert_eq!(manifest["relays"], json!([{ "method": "POST", "path": "/translations" }]));
  assert!(manifest["bundle"].as_str().unwrap().starts_with("/console/bundle/"), "{manifest}");
  assert!(manifest["bundle"].as_str().unwrap().ends_with(".js"), "{manifest}");
  assert!(manifest["stylesheet"].as_str().unwrap().ends_with(".css"), "{manifest}");

  // bmo-ui's own reading of the manifest, beside the words it names its title in.
  let read = std::env::temp_dir().join(format!("gate-manifest-{}", std::process::id()));

  std::fs::create_dir_all(&read).unwrap();
  std::fs::write(read.join("manifest.json"), &bytes).unwrap();
  std::fs::write(read.join("words.json"), serde_json::to_vec(&words()).unwrap()).unwrap();

  let ran = Command::new("bun")
    .arg("tests/client/console-manifest.ts")
    .arg(read.join("manifest.json"))
    .arg(read.join("words.json"))
    .current_dir(ROOT)
    .output()
    .expect("bun runs");
  let said = format!("{}{}", String::from_utf8_lossy(&ran.stdout), String::from_utf8_lossy(&ran.stderr));

  assert!(ran.status.success(), "bmo-ui's reading refused the manifest:\n{said}");

  let (status, _, bytes) = ask(&ground, &NO_TOKEN, Method::GET, "/console-manifest", None).await;

  assert_eq!(status, StatusCode::UNAUTHORIZED);
  refused(&json_of(&bytes), "unauthorized");
}

#[tokio::test]
async fn the_module_and_the_stylesheet_are_named_by_their_bytes() {
  let first = ConsoleBundle::read(&folder("named-first", MODULE, Some(STYLESHEET)))
    .unwrap()
    .manifest();
  let again = ConsoleBundle::read(&folder("named-again", MODULE, Some(STYLESHEET)))
    .unwrap()
    .manifest();
  let module =
    ConsoleBundle::read(&folder("named-module", "export default { routes: [1] };\n", Some(STYLESHEET)))
      .unwrap()
      .manifest();
  let stylesheet = ConsoleBundle::read(&folder("named-stylesheet", MODULE, Some(".grid{display:grid}\n")))
    .unwrap()
    .manifest();
  let none = ConsoleBundle::read(&folder("named-none", MODULE, None)).unwrap().manifest();

  assert_eq!((&first.bundle, &first.stylesheet), (&again.bundle, &again.stylesheet));
  assert_ne!(module.bundle, first.bundle);
  assert_eq!(module.stylesheet, first.stylesheet);
  assert_ne!(stylesheet.stylesheet, first.stylesheet);
  assert_eq!(stylesheet.bundle, first.bundle);
  assert_eq!(none.stylesheet, None);
}

#[tokio::test]
async fn the_module_and_the_stylesheet_are_answered_to_the_consoles_reader() {
  let ground = serving("files").await;
  let manifest = ground.app.console.as_ref().unwrap().manifest();
  let (status, headers, bytes) = ask(&ground, &CONSOLE, Method::GET, &manifest.bundle, None).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(headers[CONTENT_TYPE], "text/javascript; charset=utf-8");
  assert!(headers[CACHE_CONTROL].to_str().unwrap().contains("immutable"));
  assert_eq!(bytes, MODULE.as_bytes());

  let stylesheet = manifest.stylesheet.unwrap();
  let (status, headers, bytes) = ask(&ground, &CONSOLE, Method::GET, &stylesheet, None).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(headers[CONTENT_TYPE], "text/css; charset=utf-8");
  assert_eq!(bytes, STYLESHEET.as_bytes());

  for (caller, status, code) in [
    (&NO_TOKEN, StatusCode::UNAUTHORIZED, "unauthorized"),
    (&NO_ROLE, StatusCode::FORBIDDEN, "forbidden"),
    (&MEMBER, StatusCode::FORBIDDEN, "forbidden"),
  ] {
    let (answered, _, bytes) = ask(&ground, caller, Method::GET, &manifest.bundle, None).await;

    assert_eq!(answered, status, "{code}");
    refused(&json_of(&bytes), code);
  }

  let (status, _, bytes) =
    ask(&ground, &CONSOLE, Method::GET, "/console/bundle/0123456789abcdef.js", None).await;

  assert_eq!(status, StatusCode::NOT_FOUND);
  refused(&json_of(&bytes), "not-found");
}

#[tokio::test]
async fn the_screens_reads_answer_as_their_routes_behind_the_readers_role() {
  let ground = serving("reads").await;

  for (screen, route) in [
    ("/console/gates", "/gates"),
    ("/console/laya", "/laya"),
    ("/console/trials?gateName=sanitizer", "/trials?gateName=sanitizer"),
  ] {
    let (status, _, bytes) = ask(&ground, &CONSOLE, Method::GET, screen, None).await;
    let (_, outside) = ground.get(route).await;

    assert_eq!(status, StatusCode::OK, "{screen}");
    assert_eq!(json_of(&bytes), outside, "{screen}");

    for (caller, status, code) in [
      (&NO_TOKEN, StatusCode::UNAUTHORIZED, "unauthorized"),
      (&NO_ROLE, StatusCode::FORBIDDEN, "forbidden"),
      (&MEMBER, StatusCode::FORBIDDEN, "forbidden"),
    ] {
      let (answered, _, bytes) = ask(&ground, caller, Method::GET, screen, None).await;

      assert_eq!(answered, status, "{screen} {code}");
      refused(&json_of(&bytes), code);
    }
  }
}

#[tokio::test]
async fn the_relayed_translations_answer_a_console_within_the_readers_role_and_a_unit_on_the_token() {
  let ground = serving("translations").await;
  let asked = json!({ "language": "en", "originals": ["Already in English.", ""] });

  let (status, _, unit) = ask(&ground, &NO_ROLE, Method::POST, "/translations", Some(asked.clone())).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(json_of(&unit)["readings"][0]["text"], "Already in English.");

  let (status, _, console) =
    ask(&ground, &CONSOLE, Method::POST, "/translations", Some(asked.clone())).await;

  assert_eq!(status, StatusCode::OK);
  assert_eq!(json_of(&console), json_of(&unit));

  let unknown = Caller {
    token: true,
    role: Some("owner"),
    owner: None,
  };

  for (caller, status, code) in [
    (&NO_TOKEN, StatusCode::UNAUTHORIZED, "unauthorized"),
    (&MEMBER, StatusCode::FORBIDDEN, "forbidden"),
    (&unknown, StatusCode::FORBIDDEN, "forbidden"),
  ] {
    let (answered, _, bytes) =
      ask(&ground, caller, Method::POST, "/translations", Some(asked.clone())).await;

    assert_eq!(answered, status, "{code}");
    refused(&json_of(&bytes), code);
  }

  let (status, _, bytes) =
    ask(&ground, &CONSOLE, Method::POST, "/console/translations", Some(asked.clone())).await;

  assert_eq!(status, StatusCode::NOT_FOUND);
  refused(&json_of(&bytes), "no-route");
}

#[tokio::test]
async fn a_translation_carries_at_most_its_bound_and_one_past_the_standing_bound_is_busy_with_a_wait() {
  let ground = serving("translations-bounds").await;
  let many: Vec<String> = (0..=CALL_ORIGINALS).map(|at| format!("Line {at}.")).collect();

  let (status, _, bytes) = ask(
    &ground,
    &NO_ROLE,
    Method::POST,
    "/translations",
    Some(json!({ "language": "en", "originals": many })),
  )
  .await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&json_of(&bytes), "too-many-originals");

  let standing: Vec<_> = (0..STANDING_ORIGINALS / CALL_ORIGINALS)
    .map(|_| ground.app.translations.admit(CALL_ORIGINALS).ok().unwrap())
    .collect();
  let asked = json!({ "language": "en", "originals": ["Already in English."] });
  let (status, headers, bytes) =
    ask(&ground, &NO_ROLE, Method::POST, "/translations", Some(asked.clone())).await;

  assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
  refused(&json_of(&bytes), "translator-busy");
  assert_eq!(headers.get(RETRY_AFTER).unwrap(), &BUSY_WAIT_SECONDS.to_string());

  drop(standing);

  let (status, _, _) = ask(&ground, &NO_ROLE, Method::POST, "/translations", Some(asked)).await;

  assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_trial_put_through_the_console_is_kept_under_the_owner_key() {
  let ground = serving("trial").await;
  let reader = Caller {
    token: true,
    role: Some("administrator"),
    owner: Some("42"),
  };
  let asked = json!({ "gateName": "sanitizer", "prompt": "Plain words." });
  let (status, _, bytes) =
    ask(&ground, &reader, Method::POST, "/console/trials", Some(asked.clone())).await;
  let trial = json_of(&bytes);

  assert_eq!(status, StatusCode::CREATED, "{trial}");
  assert_eq!(
    (&trial["gateName"], &trial["userName"], &trial["prompt"], &trial["answer"]),
    (&json!("sanitizer"), &json!(""), &json!("Plain words."), &json!("CLEAN"))
  );
  assert_eq!(
    ground
      .scratch
      .count("SELECT count(*) FROM web_gate_chats WHERE user_id = 42 AND user_name = ''", vec![])
      .await,
    1
  );

  let named = json!({ "gateName": "sanitizer", "prompt": "Plain words.", "userName": "someone" });
  let (status, _, bytes) = ask(&ground, &reader, Method::POST, "/console/trials", Some(named)).await;

  assert_eq!(status, StatusCode::BAD_REQUEST);
  refused(&json_of(&bytes), "bad-request");

  let (status, _, bytes) = ask(&ground, &NO_ROLE, Method::POST, "/console/trials", Some(asked)).await;

  assert_eq!(status, StatusCode::FORBIDDEN);
  refused(&json_of(&bytes), "forbidden");
}

#[tokio::test]
async fn the_words_are_answered_on_the_token_alone() {
  let ground = serving("words").await;
  let (status, _, bytes) = ask(&ground, &NO_ROLE, Method::GET, "/console/words", None).await;
  let answered = json_of(&bytes);

  assert_eq!(status, StatusCode::OK);
  assert_eq!(answered, words());

  for (locale, tree) in answered.as_object().unwrap() {
    assert!(tree["gates"]["title"]["gates"].is_string(), "{locale}");
  }

  let (status, _, _) = ask(&ground, &NO_TOKEN, Method::GET, "/console/words", None).await;

  assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_gate_serving_no_bundle_answers_no_manifest_and_still_its_screens_reads() {
  let ground = ground("no-bundle", |_| None).await;

  for path in ["/console-manifest", "/console/words", "/console/bundle/0123456789abcdef.js"] {
    let (status, _, bytes) = ask(&ground, &CONSOLE, Method::GET, path, None).await;

    assert_eq!(status, StatusCode::NOT_FOUND, "{path}");
    refused(&json_of(&bytes), "not-found");
  }

  let (status, _, _) = ask(&ground, &CONSOLE, Method::GET, "/console/gates", None).await;

  assert_eq!(status, StatusCode::OK);
}
