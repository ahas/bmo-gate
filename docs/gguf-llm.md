# A GGUF model on a node

Any model file in llama.cpp's GGUF format, stood up on one node under llama.cpp's server and reached from the
operations machine through the tunnel door, from configuration alone: the file is an entry of the agency's model
catalogue, and where and how it is served is the installer's settings. No unit is written by hand and no model,
node or address stands in the code. The engine's name is `gguf-llm`: the name an entry gives as its engine, the
name the installer is called by and the service a node's row in the node list may reserve the node for.

## What the installer is

- **`training/tooling/scripts/gguf-llm-install.ts --model <entry>`,** run with bun on the operations machine. It
  runs from any working folder; the tooling's settings it reads are its release's (`docs/training.md`, 「The
  tooling and its settings」), so the deployment's tree is the one to run it from.
- **What a model choice calls:** the agency's `model use` runs it with the entry's name and the archive the
  choice was made in as `BMO_DB_PATH` (the agency's `docs/model-catalogue.md`, 「Choosing a model for an
  engine」). Its last line is what the choice records: on success, the address the registration reaches the
  engine at, the name the engine serves the file under and the key file the registration is given.
- **`--dry-run`** writes nothing anywhere, on the node or the operations machine, and prints every file an install
  would write, each under the path it would stand at and its mode, the key standing as the name of its file; with
  `--out <folder>` it writes the same files under that folder as well, the node's under `node/` and the operations
  machine's under `operations/`. It says too when an install would be refused for the node's reservation.
- **`--uninstall`** stops, disables and removes the two units, removes the instance's settings folder with its keys
  and every file of its folder but the models, takes the tunnel's entry out of the operations machine's
  `authorized_keys`, takes its key out of the door's list and removes its key. The model files stay on the node, as
  every file once served does, and the catalogue is left as it stands.

## What it reads

- **The catalogue entry,** printed by the catalogue's verb the settings name with `--entry <entry> --json`, in the
  archive `BMO_DB_PATH` names where it is set. Of it the installer reads:
  - `file`, a plain name ending in `.gguf`, the file under the instance's models folder, and the name the engine
    serves it under, the file's name without `.gguf`;
  - `bytes` and `sha256`, which the file is held to before the engine is started;
  - `source`, the `https` address the file is fetched from where it is missing; any other source fetches nothing,
    and the file must already stand;
  - `engine`, which must be `gguf-llm` or none; an entry another engine serves is refused;
  - `registration`, which must be given: it names the settings that say where and how the file is served;
  - `label`, which the units' descriptions carry.
  The entry's generation defaults are not read: they are the file's own record, and a request is sampled with
  what its caller names and the engine's defaults below.
- **The installer's settings,** `env/gguf-llm.toml` under the data root, read by Bun's TOML reading at every run. A
  missing file, a missing key or a value of the wrong shape refuses the run, naming the file and the key; no value
  falls back to one of the installer's own.
  - `catalogue_command`, the catalogue's verb as a list of words, which `--entry` and `--placed` are put after.
  - `[nodes.<node>]`, one table for each node an engine may stand on, by its name in the node list, giving paths
    under the account's home on that node: `llama_server`, the llama.cpp server the engine runs; `dial_python`, an
    interpreter that imports `websockets`; and `dial_script`, the WebSocket dial the tunnel's ssh rides
    (`docs/llm-server.md`, 「The tunnel」).
  - `[registrations.<registration>]`, one table for each registration served, giving:
    - `name`, the instance's name: its folder `~/<name>` and settings folder `~/.config/<name>` on the node, its units
      `<name>-engine.service` and `<name>-tunnel.service`, and its key `env/<name>.token` under the data root;
    - `node`, the node it stands on, which `[nodes]` must give;
    - `listen`, `127.0.0.1:<port>`, where its tunnel lands on the operations machine, and so where the registration
      reaches it;
    - `port`, the engine's port on the node's loopback;
    - `context`, the tokens of the one store the slots share; `parallel`, the slots; `slot_context`, where given,
      the tokens each slot is held to in that store; `cache_type`, the store's type for keys and values alike;
      `gpu_layers`, the layers put on the card; `flash_attn`, the server's flash attention mode;
    - `flags`, the server's further arguments as a list of words: the chat template, the engine's own sampling
      defaults and the like.
  - No two registrations share a name or a listen, and no two on one node share an engine port. Every word a unit
    carries is one plain word, with no whitespace, quote, `%` or `$`, and every path is under the home.
- **The tooling's settings** for what every node service shares: `node_command` and `node_console`, how a node is
  reached, and `tunnel_url`, `tunnel_login` and `tunnel_host`, the door (`docs/training.md`, 「The tooling and its
  settings」). `tunnel_login` is the account and host the tunnel logs in as, `<account>@<host>`.
- **The node's row in the node list,** read for its connection and its role. A node whose row reserves it for
  services that do not include `gguf-llm` is refused before anything reaches it.

## The units

- **Two templates under `runtime/gguf-llm/`,** `engine.service` and `tunnel.service`, are filled with the entry's
  and the settings' values, each `{{mark}}` by its value; a mark with no value refuses the run. A label's `%` is
  written as a unit reads it.
- **The engine** runs the node's llama.cpp server on the file in the models folder, under the served name, bound to
  the node's loopback at the registration's port, with the key file in the settings folder as its API key, and the
  registration's context, slots, store, card layers, flash attention and further arguments. The file and the
  served name are read from the settings folder's `engine.env`.
- **The tunnel** holds one `ssh -N` remote forward from `LISTEN` on the operations machine to the engine's port, riding
  the WebSocket dial to `TUNNEL_URL` with `LLM_KEY` as its bearer, logged in as `TUNNEL_LOGIN` and checking the host
  key pinned under `TUNNEL_HOST`. Every value of the door is read from the settings folder's `env`; no unit names a
  host, an account or an address.

## Installing and updating

Each run, for the entry's registration, in order:

1. Refuses a node reserved for other services.
2. Makes the instance's key under the data root's `env/` if there is none, as the Laya service's key is made
   (`docs/llm-server.md`, 「The key」).
3. Makes `~/<name>/models` and `~/.config/<name>` on the node, the latter the account's alone.
4. Carries the settings folder's files across, each made privately here first and set to `0600` there: `env`, with
   the key as `LLM_KEY`, the listen as `LISTEN` and the door's three; `key`, the key alone, which the engine reads;
   and `engine.env`, the file and its served name. The key never rides a command line.
5. Carries the node setup, its settings `setup.env` and the two filled units into `~/<name>`.
6. Runs the node setup detached and waits for its last line, `GGUF-LLM-SETUP-DONE ok` or
   `GGUF-LLM-SETUP-DONE failed:<step>`. The setup checks that the node's llama.cpp server, the dial's interpreter
   with `websockets` and the dial stand; leaves a file whose size and recorded hash match alone; and otherwise
   fetches the file from its source where it is missing or short, resuming a partial fetch, holds it to its size,
   hashes it and records the hash beside it. A file whose hash does not match is set aside under a `.mismatch`
   name and the setup fails at `sha256`.
7. Makes the tunnel's key on the node if there is none, lets it in on the operations machine for the listen alone,
   names the instance's key file in the door's list and pins the operations machine's host key on the node, as the
   Laya service's install does (`docs/llm-server.md`, 「Installing and updating」, steps 7 to 10).
8. Installs the two units, reloads the user manager, enables them and restarts them.
9. Waits until the listen answers `/health` on the operations machine, then records the node in the entry with the
   catalogue's `--placed <entry> <node>`.

What already stands is left as it is, so a run is repeated as often as one likes; a repeat restarts the engine.
Choosing another entry of the same registration serves the new file on the same instance, and the file served before
stays in the models folder.

## What a registration is given

The registration reaches the engine at `http://<listen>/v1/chat/completions`, with the node's name as the address's
label and the instance's key file as its key, and asks for the model by its served name.
