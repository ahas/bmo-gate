//! The translator's languages and how its readings weigh a text (`docs/api.md`, 「Translations」;
//! `docs/boundary-api.md`, 「For bmo-job」): the language a worker reads and the owner's language, which two of
//! its readers put a text into, the name each language the translator takes is asked for by, the scripts each other
//! language a person reads the console in is written in, how many Latin letters a
//! Hangul syllable is weighed against before a text counts as English, how many times a part put into the owner's
//! language is asked for before what is still wrong with it decides, and how many parts of the readings standing
//! are out at the agency's translation line at once.

use std::collections::BTreeMap;

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Translation {
  pub worker_language: String,
  pub owner_language: String,
  pub latin_per_hangul: usize,
  pub record_attempts: usize,
  pub lanes: usize,
  pub language_names: BTreeMap<String, String>,
  pub language_scripts: BTreeMap<String, Vec<String>>,
}

impl Translation {
  /// The name the translator is asked for a language by, or none for a language it does not take.
  pub fn language_name(&self, language: &str) -> Option<&str> {
    self.language_names.get(language).map(String::as_str)
  }

  /// The scripts a language other than the worker's and the owner's is written in, by their Unicode names, where the
  /// translator takes it: none for a language the policy names no name or no scripts for.
  pub fn language_scripts(&self, language: &str) -> Option<&[String]> {
    self.language_name(language)?;

    self
      .language_scripts
      .get(language)
      .map(Vec::as_slice)
      .filter(|scripts| !scripts.is_empty())
  }
}

crate::part!(pub TRANSLATION: Translation = "translation.toml");
