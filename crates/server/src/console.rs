//! The console bundle the gate serves (`docs/api.md`, 「Console」): its module, its stylesheet and its words, read
//! from the folder the settings name, and the manifest a console attaches it by. The module's and the stylesheet's
//! paths are named by the digest of their bytes, so either changes whenever its bytes do.

use std::path::Path;

use bmo_gate_client::{ConsoleManifest, ConsoleRole};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

/// The bundle's name, which is also its words' namespace.
pub const NAME: &str = "gates";

/// The path of the gate's API every call the screens make stands under, and the route their files stand under.
pub const API_PREFIX: &str = "/console";

/// The least role a reader holds to open the screens, the floor of every route under the API prefix.
pub const ROLE: ConsoleRole = ConsoleRole::Administrator;

/// The header a console names the reader's role in.
pub const OWNER_ROLE: &str = "owner-role";

/// The header a console names the reader's owner key in: their user on the account service.
pub const OWNER_KEY: &str = "owner-key";

/// The module's file in the bundle's folder.
pub const MODULE: &str = "bundle.js";

/// The stylesheet's file in the bundle's folder, where the bundle has one.
pub const STYLESHEET: &str = "bundle.css";

/// The words' file in the bundle's folder.
pub const WORDS: &str = "words.json";

/// One file the gate answers under `/console/bundle/`: its name, the digest of its bytes and its kind, and the bytes.
pub struct BundleFile {
  pub name: String,
  pub bytes: Vec<u8>,
}

impl BundleFile {
  fn of(bytes: Vec<u8>, extension: &str) -> Self {
    let digest = format!("{:x}", Sha256::digest(&bytes));

    Self {
      name: format!("{}.{extension}", &digest[..16]),
      bytes,
    }
  }

  /// The path of the gate's API the file is answered at.
  pub fn path(&self) -> String {
    format!("{API_PREFIX}/bundle/{}", self.name)
  }
}

/// The bundle as its folder holds it.
pub struct ConsoleBundle {
  pub module: BundleFile,
  pub stylesheet: Option<BundleFile>,
  pub words: Map<String, Value>,
}

fn read_file(folder: &Path, name: &str) -> Result<Vec<u8>, String> {
  let path = folder.join(name);

  std::fs::read(&path).map_err(|why| format!("the console bundle's {}: {why}", path.display()))
}

impl ConsoleBundle {
  /// The bundle a folder holds: its module and its words, and its stylesheet where it has one.
  pub fn read(folder: &Path) -> Result<Self, String> {
    let module = BundleFile::of(read_file(folder, MODULE)?, "js");
    let stylesheet = if folder.join(STYLESHEET).exists() {
      Some(BundleFile::of(read_file(folder, STYLESHEET)?, "css"))
    } else {
      None
    };
    let words = serde_json::from_slice(&read_file(folder, WORDS)?)
      .map_err(|why| format!("the console bundle's words are not a JSON object: {why}"))?;

    Ok(Self {
      module,
      stylesheet,
      words,
    })
  }

  /// The manifest a console attaches the bundle by.
  pub fn manifest(&self) -> ConsoleManifest {
    ConsoleManifest {
      name: NAME.to_owned(),
      title: format!("{NAME}.title.gates"),
      icon: "i-material-symbols-balance".to_owned(),
      screen_path: "/gates".to_owned(),
      service_name: "gate".to_owned(),
      bundle: self.module.path(),
      stylesheet: self.stylesheet.as_ref().map(BundleFile::path),
      words: format!("{API_PREFIX}/words"),
      api_prefix: API_PREFIX.to_owned(),
      role: ROLE,
      owner_key: false,
      events: false,
      websocket: false,
      push_kinds: Vec::new(),
    }
  }

  /// The file a name under `/console/bundle/` stands for, with its media type; none for a name that is not the
  /// current digest of either.
  pub fn file(&self, name: &str) -> Option<(&BundleFile, &'static str)> {
    if self.module.name == name {
      return Some((&self.module, "text/javascript; charset=utf-8"));
    }

    self
      .stylesheet
      .as_ref()
      .filter(|stylesheet| stylesheet.name == name)
      .map(|stylesheet| (stylesheet, "text/css; charset=utf-8"))
  }
}
