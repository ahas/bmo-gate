//! What a translation has to keep of a markdown text beyond its headings (`crate::markdown` counts those): its
//! lists, and its prose a block at a time. A record put into the owner's language is checked by both, to tell a
//! rendering that is whole from one whose numbered lines ran into a paragraph or whose paragraphs came back as they
//! went. Both are read by a CommonMark reader with GitHub's extensions, as mdast holds them: a tight list's item
//! holds its words as a paragraph there.

use markdown::mdast::Node;
use markdown::{ParseOptions, to_mdast};

fn tree(source: &str) -> Vec<Node> {
  match to_mdast(source, &ParseOptions::gfm()) {
    Ok(Node::Root(root)) => root.children,
    _ => vec![],
  }
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
