//! What a translation has to keep of a markdown text beyond its headings (`crate::markdown` counts those): its
//! blocks in their order, its lists, and its prose a block at a time. A document's part is held to its blocks, so a
//! blank line the translator adds or drops beside a heading or a list is no lost structure while a line of its own
//! is; a record put into the owner's language is checked by its lists and its prose, to tell a rendering that is
//! whole from one whose numbered lines ran into a paragraph or whose paragraphs came back as they went. Each is read
//! by a CommonMark reader with GitHub's extensions, as mdast holds them: a tight list's item holds its words as a
//! paragraph there.

use markdown::mdast::Node;
use markdown::{ParseOptions, to_mdast};

fn tree(source: &str) -> Vec<Node> {
  match to_mdast(source, &ParseOptions::gfm()) {
    Ok(Node::Root(root)) => root.children,
    _ => vec![],
  }
}

/// The blocks of a text in their order, each by its kind: a heading, a paragraph, a list item followed by the
/// blocks it holds, a table, a block quote followed by the blocks it holds, a code block, a break, and any other
/// block by a kind of its own. Blank lines between blocks and the way a paragraph's lines are wrapped are not part
/// of it.
pub fn block_shape(source: &str) -> Vec<&'static str> {
  kinds_of(&tree(source))
}

fn kinds_of(nodes: &[Node]) -> Vec<&'static str> {
  nodes
    .iter()
    .flat_map(|node| match node {
      Node::Heading(_) => vec!["heading"],
      Node::Paragraph(_) => vec!["paragraph"],
      Node::List(list) => list
        .children
        .iter()
        .flat_map(|item| {
          std::iter::once("list item").chain(kinds_of(item.children().map_or(&[][..], Vec::as_slice)))
        })
        .collect(),
      Node::Table(_) => vec!["table"],
      Node::Blockquote(quote) => std::iter::once("block quote").chain(kinds_of(&quote.children)).collect(),
      Node::Code(_) => vec!["code block"],
      Node::ThematicBreak(_) => vec!["break"],
      _ => vec!["other block"],
    })
    .collect()
}

/// The list items of a text, in order and nested as they stand, as one string two texts with the same items
/// share: "1,1,1" is three numbered items, "-(1,1),-" two bulleted ones whose first holds two numbered items.
/// How the items fall into lists is not part of it, since a label line or a blank line between them splits one
/// list in two or joins two into one with every item still its own.
pub fn list_shape(source: &str) -> String {
  shape_of(&tree(source)).join(",")
}

fn shape_of(nodes: &[Node]) -> Vec<String> {
  nodes
    .iter()
    .flat_map(|node| match node {
      Node::List(list) => list
        .children
        .iter()
        .map(|item| {
          let inner = shape_of(item.children().map_or(&[][..], Vec::as_slice)).join(",");
          let marker = if list.ordered { "1" } else { "-" };

          if inner.is_empty() { marker.to_owned() } else { format!("{marker}({inner})") }
        })
        .collect(),
      Node::Blockquote(quote) => shape_of(&quote.children),
      _ => vec![],
    })
    .collect()
}

/// The prose blocks of a text, each as written: its paragraphs, its headings' words, and the words of each list
/// item.
pub fn prose_blocks(source: &str) -> Vec<String> {
  blocks_of(source, &tree(source))
}

fn blocks_of(source: &str, nodes: &[Node]) -> Vec<String> {
  nodes
    .iter()
    .flat_map(|node| match node {
      Node::Paragraph(paragraph) => vec![written(source, &paragraph.children)],
      Node::Heading(heading) => vec![written(source, &heading.children)],
      Node::List(list) => list
        .children
        .iter()
        .flat_map(|item| blocks_of(source, item.children().map_or(&[][..], Vec::as_slice)))
        .collect(),
      Node::Blockquote(quote) => blocks_of(source, &quote.children),
      _ => vec![],
    })
    .collect()
}

// The words a block holds as the source writes them, from its first inline piece to its last.
fn written(source: &str, children: &[Node]) -> String {
  let start = children.first().and_then(Node::position).map(|at| at.start.offset);
  let end = children.last().and_then(Node::position).map(|at| at.end.offset);

  match (start, end) {
    (Some(start), Some(end)) => source.get(start..end).unwrap_or_default().trim().to_owned(),
    _ => String::new(),
  }
}
