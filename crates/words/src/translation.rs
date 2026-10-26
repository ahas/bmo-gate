//! What a document translation's part records where the translator gave it nothing to keep, and why a part was
//! kept as failed.

/// The translator gave no answer.
pub const UNANSWERED: &str = "The translator did not answer.";
/// Somebody stopped the translation.
pub const STOPPED: &str = "The translation was stopped.";
/// The translation could not be written down.
pub const UNWRITTEN: &str = "The translation could not be written down.";

/// A part kept as failed because its last answer did not keep the part's headings at each depth.
pub const LOST_HEADINGS: &str =
  "The translation did not keep the part's headings: {source} became {translated}.";
/// A part kept as failed because its last answer had more or fewer blocks than the part.
pub const LOST_BLOCKS: &str = "The translation has {translated} blocks where the part has {source}.";
/// A part kept as failed because a block of its last answer is of another kind than the part's in its place.
pub const LOST_BLOCK: &str =
  "The translation has a {translated} where the part's block {at} is a {source}.";
/// The note a part is asked again under once its answer lost the part's structure; `{lost}` says what it lost.
pub const ASK_AGAIN: &str = "Your last translation of this part did not keep its structure: {lost} Translate the part again, whole, keeping every heading, block and inline code span of the part where it stands.";
/// A part kept as failed because its last answer did not carry an inline code span of the part word for word.
pub const LOST_CODE: &str = "The translation did not keep the inline code {span} as written.";
