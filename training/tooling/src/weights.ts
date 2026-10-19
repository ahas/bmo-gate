import { readFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./roots";

// Where Laya's checkpoints stand, as the repository's `weights/checkpoints.toml` declares it, read by Bun's own
// TOML reading: the collection under the runtime data root and the store on a service node.

export interface CheckpointFolders {
  /** The collection, relative to the runtime data root. */
  collection: string;
  /** The store on a service node, relative to the account's home. */
  nodeStore: string;
}

export function checkpointFolders(): CheckpointFolders {
  const path = join(repositoryRoot(), "weights", "checkpoints.toml");
  const declared = Bun.TOML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const text = (key: string): string => {
    const value = declared[key];

    if (typeof value !== "string" || value.trim() === "" || value.startsWith("/")) {
      throw new Error(`${key} in ${path} is not a relative folder`);
    }

    return value;
  };

  return { collection: text("collection"), nodeStore: text("node_store") };
}
