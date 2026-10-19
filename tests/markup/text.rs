//! The small readings the records share: a grouped count, a period of months, the fenced blocks of a markdown
//! text and its prose.

use gate_markup::text::{count_text, fenced_blocks, period_of, prose};

#[test]
fn a_count_is_grouped_by_thousands() {
  assert_eq!(count_text(0), "0");
  assert_eq!(count_text(999), "999");
  assert_eq!(count_text(1_000), "1,000");
  assert_eq!(count_text(1_234_567), "1,234,567");
}

#[test]
fn a_period_is_one_month_or_a_span() {
  assert_eq!(period_of(Some("2026-03-01"), None), Some("2026-03".into()));
  assert_eq!(period_of(None, Some("2026-04-02")), Some("2026-04".into()));
  assert_eq!(period_of(Some("2026-03-01"), Some("2026-03-30")), Some("2026-03".into()));
  assert_eq!(period_of(Some("2026-03-01"), Some("2026-05-30")), Some("2026-03~2026-05".into()));
  assert_eq!(period_of(None, None), None);
  assert_eq!(period_of(Some("2026"), None), None);
}

#[test]
fn a_fenced_block_is_read_whole_fence_and_all() {
  let text = "Before.\n\n```rust\nlet a = 1;\n```\n\nBetween.\n\n~~~~\nx\n~~~~\n";

  assert_eq!(fenced_blocks(text), ["```rust\nlet a = 1;\n```", "~~~~\nx\n~~~~"]);
  assert!(fenced_blocks("    indented code\n").is_empty());
  assert!(fenced_blocks("no code at all").is_empty());
}

#[test]
fn prose_reads_past_code_and_links() {
  let read = prose("A `span` and [a link](https://example.com) stay out.\n\n```\ncode\n```\n\n- an item\n");

  assert!(read.contains("A  and  stay out."), "{read}");
  assert!(read.contains("an item"), "{read}");
  assert!(!read.contains("code") && !read.contains("span") && !read.contains("link"), "{read}");
}
