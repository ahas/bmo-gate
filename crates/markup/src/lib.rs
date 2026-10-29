//! The text the gate reads and checks: the dash net under the writing rules, the net of the words the owner
//! banned, the English test, the readings of a web address, and the small readings the records share. Every
//! length here is counted as Telegram counts it, in UTF-16 units, and every space and trim is JavaScript's, so a
//! text reads the same here as on the side that sends it.

pub mod dashes;
pub mod english;
pub mod js;
pub mod text;
pub mod web_address;
pub mod wording;
