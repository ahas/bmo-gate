import { printedWidth } from "../laya-nodes";

// A table laid out for a terminal: every column as wide as its widest cell, as a terminal prints it,
// the head, a rule under it, and the rows.
export function laidOut(head: readonly string[], body: readonly (readonly string[])[]): string[] {
  const widths = head.map((_, column) => Math.max(...[head, ...body].map((line) => printedWidth(line[column] ?? ""))));
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => cell + " ".repeat(Math.max(0, widths[column]! - printedWidth(cell)))).join("  ").trimEnd();

  return [line(head), line(widths.map((width) => "-".repeat(width))), ...body.map(line)];
}
