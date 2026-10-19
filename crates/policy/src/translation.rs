//! How the translator's readings weigh a text (`docs/boundary-api.md`, 「For bmo-job」): how many Latin letters a
//! Hangul syllable is weighed against before a text counts as English, and how many times a part put into the
//! owner's language is asked for before what is still wrong with it decides.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Translation {
  pub latin_per_hangul: usize,
  pub record_attempts: usize,
}

crate::part!(pub TRANSLATION: Translation = "translation.toml");
