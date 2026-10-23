//! The translator's languages and how its readings weigh a text (`docs/api.md`, 「Translations」;
//! `docs/boundary-api.md`, 「For bmo-job」): the language a worker reads and the owner's language, which the two
//! readers put a text into, the name each language the translator takes is asked for by, how many Latin letters a
//! Hangul syllable is weighed against before a text counts as English, and how many times a part put into the
//! owner's language is asked for before what is still wrong with it decides.

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Translation {
  pub worker_language: String,
  pub owner_language: String,
  pub latin_per_hangul: usize,
  pub record_attempts: usize,
  pub language_names: BTreeMap<String, String>,
}

impl Translation {
  /// The name the translator is asked for a language by, or none for a language it does not take.
  pub fn language_name(&self, language: &str) -> Option<&str> {
    self.language_names.get(language).map(String::as_str)
  }
}

crate::part!(pub TRANSLATION: Translation = "translation.toml");
