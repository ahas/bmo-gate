//! A text's lists item by item and its prose a block at a time, as a record's rendering is checked by.

use gate_stages::markdown_shape::{list_shape, prose_blocks};

#[test]
fn lists_are_read_item_by_item_whatever_splits_them() {
  assert_eq!(list_shape("1. one\n2. two\n\n- three\n  1. four"), "1,1,-(1)");
  assert_eq!(list_shape("one and two run together"), "");
  assert_eq!(
    list_shape("Fixed:\n1. a\n2. b\n\nChecked:\n\n1. c\n2. d"),
    list_shape("Fixed:\n1. a\n2. b\n3. c\n4. d")
  );
}

#[test]
fn prose_is_read_a_block_at_a_time() {
  assert_eq!(
    prose_blocks("# Head\n\nA paragraph\nover two lines.\n\n- an item\n> quoted"),
    vec!["Head", "A paragraph\nover two lines.", "an item", "quoted"]
  );
}
