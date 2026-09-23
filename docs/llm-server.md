# The house LLM service on n6

A small open model served on n6 behind an OpenAI-compatible API and an MCP front, for BMO's gates to
ask. This repository holds the service whole — the front, the units, the node setup and the
installer. BMO holds only the client that asks it and the configuration of which gate asks (BMO's
`docs/own-llm.md`, where this service is the member named `n6`).

## The machine and the model

- **The card:** n6 is an RTX 4070 with 12,282 MiB (11.99 GiB), driver 595.58.03 (CUDA 13.2), on an
  i9-9900KF with 62 GiB of RAM and Ubuntu on kernel 5.15. Nothing else holds the card.
- **The model:** `RedHatAI/Qwen3.5-4B-quantized.w4a16` — Qwen3.5-4B with INT4 weights and BF16
  activations, served text-only under the name `qwen3.5-4b`, with a 32,768-token context.
- **Why this one:**
  - Qwen3.5 uses hybrid attention: only 8 of its 32 layers are full attention, with 4 KV heads of
    256. A token of context costs 32 KiB of KV cache, so three full 32K contexts fit on this card
    beside the weights.
  - It speaks the same chat template and thinking switch (`enable_thinking`) as J3090's model, so
    BMO's one own-LLM client speaks to both.
  - The checkpoint is 4.92 GiB on disk with the vision tower, which text-only loading leaves out.
- **What does not fit, and why it is not served:**
  - The 27B class J3090 serves: its 4-bit weights alone exceed the card.
  - Qwen3.5-9B at W4A16: the checkpoint keeps its embeddings and linear-attention layers in BF16, so
    its weights stay near 9.3 GiB even text-only. That leaves under 1 GiB for KV and activations,
    which is one request and an out-of-memory error on the second.
  - Qwen3-8B-AWQ: every one of its 36 layers is full attention with 8 KV heads, so a token of
    context costs 144 KiB and not even one 32K sequence fits beside the weights.
  - Qwen3.5-9B as a GGUF under llama.cpp fits, but it is a second engine. Its model list does not
    report the context length BMO reads, and n6 has no CUDA toolkit to build it with.

## How the card is divided

- **Budget:** `--gpu-memory-utilization 0.85`, which is 10.19 GiB of the card. 11.6 GiB is free, so
  about 1.4 GiB stays unclaimed.
- **Weights:** at most 4.9 GiB.
- **Activations, CUDA graphs and the sampler:** about 1.5 GiB at a batch of 8,192 tokens. vLLM
  measures this itself at start.
- **The KV and state pool:** what is left, about 3.8 GiB.
- **Three full-context sequences:** 3 × 32,768 tokens × 32 KiB is 3.0 GiB of KV. The linear-attention
  state is fixed per sequence, about 50 MiB each. That leaves about 0.65 GiB, roughly 20K tokens.
- **The start log is the ground truth.** vLLM prints the maximum concurrency it can hold at 32,768
  tokens per request. It must read at least 3.0x. If it reads lower, `--max-num-seqs` is set to
  what the log states, and this section states the measured figure.

## The engine

- **vLLM,** installed from its wheels, which carry their own CUDA runtime. The driver is newer than
  any runtime they carry, and the W4A16 Marlin kernels run on this card's generation (sm_89).
- **Where it lives:** `~/bmo-llm/.venv`, a uv venv on uv's own Python 3.12, never on the system's.
  The model is downloaded into `~/bmo-llm/hf`, which the environment file names as `HF_HOME`, by
  the node setup. vLLM starts with the hub switched off, so a start never waits on the network.
- **Nothing is compiled on the node.** vLLM samples with its own PyTorch sampler rather than
  FlashInfer's, whose kernels are built on first use with the node's toolchain; a start therefore
  never waits on a build and never fails for a compiler the account lacks. The venv's own `bin`
  stands first on the unit's path, so any program vLLM runs is the venv's.
- **Its arguments:**
  - `serve RedHatAI/Qwen3.5-4B-quantized.w4a16`
  - `--served-model-name qwen3.5-4b`
  - `--host 127.0.0.1 --port 8000`
  - `--max-model-len 32768`
  - `--max-num-seqs 3`
  - `--max-num-batched-tokens 8192`
  - `--gpu-memory-utilization 0.85`
  - `--language-model-only` — the vision tower is not loaded.
  - `--reasoning-parser qwen3` — a thinking answer's reasoning is kept out of the message content,
    which is the field BMO reads.
- **Its key:** vLLM answers only calls that carry the service key, which it reads as `VLLM_API_KEY`
  from the environment file. The key is never passed as an argument, because a command line is
  visible to every account on the machine.

## The front

One process on `127.0.0.1:8010`, the only port that leaves n6.

| Path | Key | What it does |
|---|---|---|
| `/health` | none | 200 when vLLM's own health answers, 503 when it does not |
| `/v1/chat/completions` | bearer | passed through to vLLM, streamed when the request asks for a stream |
| `/v1/models` | bearer | passed through to vLLM: one model, with its `max_model_len` |
| `/mcp` | bearer | MCP over Streamable HTTP, stateless, JSON responses |

- **The key check:** every path but `/health` takes `Authorization: Bearer` with the service key,
  compared in constant time. A refusal is a bare 401 that repeats nothing of the request.
- **Stateless MCP:** every request stands alone. `initialize` and `tools/list` answer, and a bare
  `tools/call` with no `initialize` before it answers too, because that is how BMO calls it.
- **Nothing of a request is logged:** no header and no body reaches a log line.

### The one tool

- **`llm_query`** takes `prompt` (required), `system` and `max_tokens`, asks the served model with
  thinking off, and answers with the model's text as text content. No model is named: the service
  serves one.
- **Refusals:** when vLLM refuses a request for its size, the tool answers an error whose text
  carries `400 Bad Request`, the wording BMO reads as "too large". Any other failure is an error
  with no upstream body in it.
- **Thinking** is not a tool argument. A caller that wants it posts to `/v1/chat/completions` with
  `chat_template_kwargs.enable_thinking` on.

### The five tools not built

The J3090 guide's router carries six tools. Only `llm_query` is built, because it is the only one a
caller asks.

- **`summarize`, `translate`, `classify`, `extract`, `judge`:** each is a fixed prompt wrapped
  around the same model. BMO's gates carry their own instructions and parse their own answers. The
  session summary, the translator, the reference classifiers and the output judges all send those
  instructions through `llm_query`, and none of them reads `judge`'s score shape. A tool no caller
  names is a surface kept up for nothing.

## The units

All three are systemd user units in the n6 account. Each restarts itself on any exit, starts with
`default.target`, and reads `~/.config/bmo-llm/env`, which must exist. Linger is on for the account,
so they stand after a reboot with nobody logged in.

- **`bmo-llm-vllm.service`** — vLLM with the arguments above, given a long start timeout for the
  model load.
- **`bmo-llm-front.service`** — the front, started after vLLM and wanting it.
- **`bmo-llm-tunnel.service`** — the reverse tunnel below.

One more unit stands on main-host, in the account there, linked from this checkout like the other
units this repository runs on main-host:

- **`bmo-llm-bridge.service`** — the tunnel's door on main-host, below.

## The door

- **n6 and the house cannot see each other.** n6 sits on its own network (192.0.2.21/23), and no
  path runs from main-host to it.
- **n6's network lets only HTTPS out.** A connection to an SSH port anywhere is opened and then
  carries nothing — main-host's forwarded SSH port and github.com's alike — while HTTPS passes, which
  is how the jake agent on n6 reaches its hub.
- **So n6 dials the house over HTTPS, and SSH rides inside it.** The tunnel unit holds an `ssh -N`
  connection to main-host whose bytes travel in a WebSocket to `wss://llm-tunnel.ahas.io/`: ssh's
  ProxyCommand is `llm-server/ws-dial.py`, run on the service's own venv, which opens that WebSocket
  with the service key as its bearer and pipes ssh's input and output through it.
  - The ssh asks for one remote forward: main-host's `127.0.0.1:18010` to the front's
    `127.0.0.1:8010`. It fails outright if the forward cannot be made, and sends keepalives.
  - It checks main-host's host key against a pinned `~/.config/bmo-llm/known_hosts` under the name
    `main-host`, never by trust on first use.
  - Only the front's port crosses; vLLM's never leaves n6.
- **The way in on the house side** is the service's own:
  - `llm-tunnel.ahas.io`, a Cloudflare CNAME to `home.example.org`, DNS only, which reaches NPM through
    the router's DMZ.
  - An NPM proxy host for that name: WebSocket upgrade on, the `ahas.io` wildcard certificate, and
    long read and send timeouts, forwarding to main-host port 18022. Its nginx config is
    `llm-server/llm-tunnel.ahas.io.conf`, with the row in NPM's table saying the same.
  - main-host's firewall opening port 18022 to NPM's address alone.
  - **The bridge** (`bmo-llm-bridge.service`, running `scripts/llm-bridge.ts`) listening on that port.
    It takes a WebSocket only when its bearer is the service key, read from its file for each
    connection, and then pipes it to main-host's own SSH on `127.0.0.1:22`. Anything else is refused
    before a byte reaches SSH.
- **The main-host end** is one entry in the account's `authorized_keys` for n6's tunnel key, which
  is an ed25519 key made on n6 with no passphrase and kept at `0600`. The entry allows nothing but
  port forwarding (`restrict,port-forwarding`), lets the key listen only on `127.0.0.1:18010`
  (`permitlisten`), and forces `/usr/sbin/nologin` as its command. A remote forward lands on
  main-host's loopback and on nothing wider.
- **The service answers at `http://127.0.0.1:18010` on main-host,** with the four paths above.
- **The public name is the tunnel's door, never the service's.** What answers on it is the bridge, and
  what the bridge reaches is SSH, which still asks for n6's tunnel key under the restricted entry.
- **Why the door is inside the house:** every caller — BMO, and a Claude Code session attached with
  `claude mcp add --transport http` — runs on main-host, where the tunnel lands. A public name, a
  proxy host and a certificate would stand in front of no caller.
- **Why the key is still checked:** both ends of the tunnel are shared. n6 carries a second login
  account, and main-host's loopback is open to every process on the machine.

## The key

- **Made once, on main-host,** as `$BMO_DATA_DIR/env/n6.key` (without `BMO_DATA_DIR`,
  `~/.local/share/bmo/data/env/n6.key`): 32 random bytes as hex, written under umask 077 and kept at
  `0600`. An existing key is never overwritten, and one found with any other permission is refused
  rather than used, since it may already have been read.
- **On n6 it lives only in `~/.config/bmo-llm/env`,** at `0600`, as `LLM_KEY` for the front and
  `VLLM_API_KEY` for vLLM. That environment file is the only place it has on n6.
- **BMO reads it** from its file for each request and holds it nowhere else, and so does the bridge.
- **It appears nowhere else:** no document, log line, response, unit file, command line, test
  fixture or archive row. A check that needs it sends a header built from the file, never the key
  written into a command.

## Installing and updating

`bun scripts/llm-install.ts` from this checkout on main-host is the one way the service is put on n6
or updated. n6 is a jake node, so every step reaches it through the jake console, never by SSH. In
order, it:

1. Makes the key on main-host if there is none.
2. Builds n6's environment file in a private `0600` file and carries it across with `jake upload`,
   then deletes the local copy. The key never rides a `jake exec` command line.
3. Uploads `llm-server/`.
4. Runs the node setup detached with `setsid nohup`, because the hub stops a streamed command after
   five minutes, and waits for its last line: `LLM-SETUP-DONE ok`, or `LLM-SETUP-DONE failed:<step>`
   naming the step. The setup installs uv if it is missing, builds or repairs the venv, installs the
   packages and downloads the model. Running it again changes nothing that already stands.
5. Makes n6's tunnel key if there is none and reads back only its public half.
6. Adds the restricted `authorized_keys` entry on main-host unless it is already there.
7. Links the bridge unit on main-host, and enables and restarts it.
8. Pins main-host's host key in n6's `known_hosts` from main-host's own host key file.
9. Installs the three units, reloads the user manager and enables and starts them.
10. Waits until `http://127.0.0.1:18010/health` answers on main-host.

The name, the proxy host and the firewall opening are made once, by hand, as jake's hub's are, and the
installer leaves them alone:

- the CNAME `llm-tunnel` → `home.example.org` in the `ahas.io` zone, DNS only;
- the NPM row for `llm-tunnel.ahas.io` (forward `192.0.2.8x:18022`, certificate 76, WebSocket
  upgrade, the same advanced settings as the config) and `llm-server/llm-tunnel.ahas.io.conf`
  written under that row's id, then `nginx -t && nginx -s reload` inside NPM's container;
- `ufw allow from 192.168.0.101 to any port 18022 proto tcp` on main-host.

## n6 carries no training

- **n6 is the service's machine.** Laya's training and measurement run on n2 to n5 only
  (`docs/laya-train-run.md`). The Laya node commands refuse n6 by name, because vLLM holds 85% of its
  card and a training run there would fail at its first allocation.
- **Putting training back on n6** takes, in order:
  1. Move every BMO route off the `n6` provider, since its calls would otherwise go unanswered.
  2. Stop and disable the three `bmo-llm-*` units.
  3. Add n6 to the training nodes.
  4. Restate this document and `docs/laya-server.md`.

## The checks

Run on main-host, in this order. The key is read from its file into a header and never written into
the command:

```sh
key() { printf 'Authorization: Bearer %s\n' "$(cat "${BMO_DATA_DIR:-$HOME/.local/share/bmo/data}/env/n6.key")"; }
mcp=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18')
```

1. **Health, without a key:** `curl -s http://127.0.0.1:18010/health` answers 200.
2. **The model list:** `curl -s -H @<(key) http://127.0.0.1:18010/v1/models` lists `qwen3.5-4b`
   with `max_model_len` 32768.
3. **The MCP handshake:** an `initialize` posted to `/mcp` answers with the server's capabilities,
   and `tools/list` names `llm_query` alone.
   `curl -s -H @<(key) "${mcp[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' http://127.0.0.1:18010/mcp`
4. **A tool call:** a bare `tools/call` of `llm_query` with a short prompt answers with text
   content.
   `curl -s -H @<(key) "${mcp[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"llm_query","arguments":{"prompt":"한 단어로 답해: 하늘의 색은?","max_tokens":16}}}' http://127.0.0.1:18010/mcp`
5. **A real gate call:** in a copy of BMO's archive with `room-rules` routed to `n6`
   (BMO's `docs/own-llm.md`), one run of BMO's own gate road for `room-rules`, with that gate's
   system prompt, leaves a gate-road row on provider `n6`, model `qwen3.5-4b`, answered. BMO's live
   gates stay on the routes 하스 chose for them; putting one on `n6` is that same choice.
