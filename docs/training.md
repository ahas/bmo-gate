# The tooling

The Bun project in `training/tooling/`, which the deployment installs into the release and whose commands run on
the operations machine. What it does now is place a GGUF model on a node, filling the units under
`runtime/gguf-llm/` and carrying the files and keys there (`docs/gguf-llm.md`). Its tests stand under
`tests/tooling/`.

## The tooling and its settings

- **Its settings are one TOML file:** the one `BMO_GATE_TOOLING_SETTINGS` names, else `tooling.toml` in the
  tooling's folder, which a deployment links from the data root's `env/` and git never holds. It is read by Bun's
  own TOML reading. A missing file is no settings at all; one that is not TOML stops the command, naming the file.
- **`data_root`** is the runtime data root everything here reads and writes under. `BMO_DATA_DIR` names it ahead
  of the file, as the unit sets it; with neither, a command that needs it stops and says so.
- **`node_command`** is the node unit's command as a list of words, its configuration flag among them, which
  `node --target <node>` is put after to read one node's connection (the node unit's `docs/nodes.md`,
  「Registering and changing a node」).
- **`node_console`** is the program a console node is driven through, run by bun: `exec -a <agent> <command>`
  runs a command, `upload <local> <remote> -a <agent>` carries a file to the node and `download <remote> <local>
  -a <agent>` brings one back.
- **`tunnel_url`, `tunnel_login` and `tunnel_host`** are the tunnel's public name, the login on the operations
  machine as `<account>@<host>`, and the name its host key is pinned under, which the GGUF engine's installer
  writes into each node's environment file (`docs/gguf-llm.md`, 「The tunnel and the key」 and 「Installing and
  updating」).
- **A key a command needs and the file does not give** stops the command with a message naming the key and the
  file; no key falls back to a value of the tooling's own.

## Calls on a node

- **A call on a node waits for its end:** a command until it exits, a file carried either way until its copy
  ends. No call is stopped for the time it takes; the hub's own end of a streamed command is the hub's, and comes
  back as the call's failure.
- **A transfer that failed is made once more** before its caller hears of it, since what breaks one is most often
  the connection of the moment.
- **An ssh node's login keeps its connection alive,** asking the node every thirty seconds, so a node that has gone
  ends the call; connecting to it ends when ssh's own connect does.
