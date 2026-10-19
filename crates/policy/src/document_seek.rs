//! The document seeker over the documents viewer's index: the most entries it picks for one question.

use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentSeek {
  pub cap: usize,
}

crate::part!(pub DOCUMENT_SEEK: DocumentSeek = "document-seek.toml");
