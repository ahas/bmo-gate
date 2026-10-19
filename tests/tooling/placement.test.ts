import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { nodeAt, objectAt, PlacementRefused, placementPath, readPlacement } from "../../training/tooling/src/placement";
import { scratchDir } from "./scratch";

import type { PlacementFile } from "../../training/tooling/src/placement";

// The reading every service's placement goes through: the file under the data root, refused rather than
// guessed. Each service's own shape is checked beside the service.

const ONE_NODE: PlacementFile<string> = {
  file: "one-node.json",
  shape: '{"node": "<node>"}',
  read: (value) => nodeAt(objectAt(value, "the file").node, "node"),
};

function rootWith(text: string | null): string {
  const root = scratchDir("bmo-placement-");
  if (text !== null) {
    mkdirSync(join(root, "placements"));
    writeFileSync(placementPath(ONE_NODE.file, root), text);
  }
  return root;
}

describe("a service's placement", () => {
  test("is the service's own reading of its file under the data root", () => {
    expect(readPlacement(ONE_NODE, rootWith('{"node": "node-a"}'))).toBe("node-a");
  });

  test("missing, not JSON, or not the shape, is refused naming the file and the shape it wants", () => {
    for (const [text, fault] of [[null, "is missing"], ["{node", "is not JSON"], ['{"node": "Node A"}', "node is not a registered node's name"]] as const) {
      const root = rootWith(text);
      const read = () => readPlacement(ONE_NODE, root);

      expect(read).toThrow(PlacementRefused);
      expect(read).toThrow(fault);
      expect(read).toThrow(placementPath(ONE_NODE.file, root));
      expect(read).toThrow(ONE_NODE.shape);
    }
  });
});
