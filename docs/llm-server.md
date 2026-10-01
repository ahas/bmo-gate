# The Laya service on n6

Laya's gate checkpoints served on n6, behind an MCP server and an OpenAI-compatible API built the way
the J3090 guide (`bongjiwoo-beep/j3090-mcp-guide`) builds its own: an engine bound to the node's
loopback, a front beside it that is the only port leaving the machine, and a key on everything but
the health. This repository holds the service whole — the engine, the front, the units, the node
setup, the installer and the command that puts a checkpoint in service. BMO holds only the client
that asks it and the configuration of which gate asks (BMO's `docs/laya.md`).

## The machine

- **The card:** n6 is an RTX 4070 with 12,282 MiB (11.99 GiB), driver 595.58.03 (CUDA 13.2), on an
  i9-9900KF with 62 GiB of RAM and Ubuntu on kernel 5.15. The card is shared: Laya, BMO's voice and
  its songs each put their model on it only while they use it, under one lock (「The shared card
  lock」), and the text model's engine borrows a part of it while it runs. Nothing is trained there.
- **The account** is `labuser`. Everything the service is made of stands in it, under `~/bmo-laya`,
  `~/bmo-llm` and `~/.config/bmo-llm`, and none of it asks for sudo.

## The engine

- **What it is:** the Laya decision server of `laya-server/server.py` (`docs/laya-server.md` for its
  two calls, how it holds one checkpoint per gate and how the card is shared among them), unchanged,
  in `~/bmo-laya` on the venv the node setup builds there. It is the same venv, on the same uv
  Python, that a training node's setup builds.
- **Where it listens:** `127.0.0.1:7431`. It never leaves n6: the front is the only way to it.
- **Its token** is the service key, read as `LAYA_TOKEN` from the environment file. The engine checks
  it on both of its calls even behind the front, because n6 carries a second login account and its
  loopback is open to every process on the machine.
- **Which checkpoint answers which gate** is `LAYA_CHECKPOINTS` in `~/.config/bmo-laya/env` on n6
  (`docs/laya-server.md`, 「Which checkpoint answers which gate」). The checkpoints stand under
  `~/bmo-laya/checkpoints/<training gate>/<run>/step-<n>`, the layout of the collection on main-host.
- **Where the checkpoints wait:** every one in pinned host memory, from the moment it is loaded. A
  call puts its gate's checkpoint on the card, under the shared lock; as soon as the last decision in
  hand ends, every checkpoint is taken off again and the lock let go (`docs/laya-server.md`,
  「Sharing the card」).
- **How many checkpoints are on the card at once** while the engine holds it: as many as leave room
  for the decisions. The unit sets `LAYA_CARD_MODELS` to 8, the most it lets on, so calls that overlap
  keep every gate they ask on the card until the card is let go. The first decision that runs out
  of card has the least recently asked checkpoints taken off until it fits, and from then on the card
  holds that many.
- **The lock it takes** is `LAYA_GPU_LOCK=/home/labuser/.gpu.lock` in the unit.

## The shared card lock

n6's one card is shared by every service that runs a model there: Laya (this repository), BMO's
voice and BMO's songs. None of them keeps its model on the card while it is not using it, and they
take turns by one lock.

- **The lock:** an exclusive `flock` on `/home/labuser/.gpu.lock`, the same path for every service,
  opened with create so whoever comes first makes it. The file's content means nothing.
- **Taken before anything goes on the card:** a model's weights, a decision's or a generation's
  working memory. A service that has not got the lock puts nothing on the card.
- **Let go only once everything is off the card:** the weights dropped and the process's CUDA
  allocator cache emptied, so what the holder used is free for the next one. What a process may keep
  on the card without the lock is its CUDA context alone, a few hundred MiB that cannot be let go
  short of ending the process.
- **Held no longer than the use:** a holder lets go after a short idle time of its own, never keeps
  it between uses that are minutes apart, and holds it through one use however long that use is.
- **A process that dies lets go of it,** since the kernel drops a flock with its last open file, so
  a crash never leaves the card locked.
- **Waiting is each service's own choice.** The lock says only who is on the card:
  - Laya never waits. A call that finds the lock held elsewhere is answered 503 at once, saying the
    card is busy, so BMO's call ends as a Laya that is not reachable and goes the way its gate goes
    then (BMO's `docs/laya.md`). Laya's own start is the one exception: it waits for the lock to load
    and try its checkpoints, since it answers nothing before that anyway.
  - The voice and the songs choose for themselves whether they wait, and how long, in their own
    documents.
- **What a holder may assume:** no other service that follows the lock runs on the card while it
  holds the lock, so it may use the whole card less the other services' contexts and the text
  model's share.
- **The text model's share stands outside the lock.** While its engine runs, n6's card holds one of
  its parts, about 3.9 GB beside the other services' contexts, taken without the lock, since a hold
  of it would refuse every Laya call (`docs/n5-llm.md`, 「The cards it borrows」). It is sized to leave
  about 7.9 GB free: room for Laya's checkpoint and decision, and the 7 GB the voice asks for before
  a line.

## The front

One process on `127.0.0.1:8010`, the only port that leaves n6. It speaks to the engine with the
service key and to nothing else.

| Path | Key | What it does |
|---|---|---|
| `/health` | none, or bearer | without the key, 200 `{"status":"ok"}` when the engine answers its own health and 503 when it does not; with the key, the engine's own health whole |
| `/decide` | bearer | passed through to the engine: BMO's own call, answered exactly as the engine answers it |
| `/v1/models` | bearer | one model per gate served, named by the gate, with its checkpoint |
| `/v1/chat/completions` | bearer | one decision in the OpenAI chat shape (below) |
| `/mcp` | bearer | MCP over Streamable HTTP, stateless, JSON responses |

- **The key check:** every path but `/health` takes `Authorization: Bearer` with the service key,
  compared in constant time. A refusal is a bare 401 that repeats nothing of the request. `/health`
  given a wrong key answers as it does given none.
- **Stateless MCP:** every request stands alone. `initialize` and `tools/list` answer, and a bare
  `tools/call` with no `initialize` before it answers too.
- **Nothing of a request is logged:** no header and no body reaches a log line, in the front or the
  engine.
- **The engine not answering** — stopped, restarting, or still loading its checkpoints — is a 503
  on every path that needs it, at once, since its port refuses or does not take the connection
  within five seconds.
- **The engine holding a call** past thirty seconds without answering is a 504 on every path that
  needs it, saying that Laya did not answer in time, and the front hangs up on the engine, which then
  drops the call unasked if it has not reached it yet (`docs/laya-server.md`, 「The server」). A
  decision takes under a second, so only a line stuck behind something wrong meets the
  bound, and the 504 lets a caller tell a wait that ran out from an answer that went wrong.

### The model a caller names is the gate

A Laya decision is made by the gate's own checkpoint, so a caller never chooses a model: it names the
gate, and the gate's checkpoint answers. `/v1/models` lists the gates the engine serves as models,
each with `owned_by` `laya` and the checkpoint it is answered by. A gate no checkpoint serves is
refused by the engine as not served (404), whichever path asked.

### The OpenAI-compatible call

- **The request:** `model` is the gate; the last `user` message is the state, as text; `questions` is
  the named questions in the engine's own shape (`docs/laya-server.md`), carried as an extra field of
  the body — the OpenAI clients' `extra_body`. A request with no questions is refused as one the
  front cannot read (400).
- **The answer:** a `chat.completion` with one choice whose message content is the engine's own
  answer as JSON — `answers`, the tokens it read and `ms` — and a usage of zero tokens.
- **Streaming is not offered:** a decision is one answer made at once, so `stream: true` is refused
  (400) rather than dressed as a stream.
- **A refusal** keeps the engine's status (400, 404, 500 or 503), or the front's own 503 or 504, and
  carries the engine's reason in the OpenAI error shape, `{"error": {"message", "type", "code"}}`.

### The two tools

- **`laya_decide`** takes `gate`, `state` (text, an object or a list) and `questions`, asks the gate's
  checkpoint, and answers with the engine's answer as JSON text content. A refusal is a tool error
  carrying the engine's status and reason.
- **`laya_gates`** takes nothing and answers with the gates served and each one's checkpoint, which
  is what a session attached by MCP needs before it can name a gate.
- **The J3090 guide's six tools are not built:** each wraps one fixed prompt around a text model, and
  Laya is not one. What it answers is a decision about a state against named questions, which is
  what `laya_decide` asks.

## The units

All three are systemd user units in the n6 account. Each restarts itself on any exit, starts with
`default.target`, and reads `~/.config/bmo-llm/env`, which must exist. Linger is on for the account,
so they stand after a reboot with nobody logged in.

- **`bmo-llm-laya.service`** — the engine. It also reads `~/.config/bmo-laya/env`, the one place the
  gates are given their checkpoints, where one stands.
- **`bmo-llm-front.service`** — the front, started after the engine and wanting it.
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
  ProxyCommand is `llm-server/ws-dial.py`, run on the front's venv, which opens that WebSocket with
  the service key as its bearer and pipes ssh's input and output through it.
  - The ssh asks for one remote forward: main-host's `127.0.0.1:18010` to the front's
    `127.0.0.1:8010`. It fails outright if the forward cannot be made, and sends keepalives.
  - It checks main-host's host key against a pinned `~/.config/bmo-llm/known_hosts` under the name
    `main-host`, never by trust on first use.
  - Only the front's port crosses; the engine's never leaves n6.
- **The way in on the house side** is the service's own:
  - `llm-tunnel.ahas.io`, a Cloudflare CNAME to `home.example.org`, DNS only, which reaches NPM through
    the router's DMZ.
  - An NPM proxy host for that name: WebSocket upgrade on, the `ahas.io` wildcard certificate, and
    long read and send timeouts, forwarding to main-host port 18022. Its nginx config is
    `llm-server/llm-tunnel.ahas.io.conf`, with the row in NPM's table saying the same.
  - main-host's firewall opening port 18022 to NPM's address alone.
  - **The bridge** (`bmo-llm-bridge.service`, running `scripts/llm-bridge.ts`) listening on that port.
    It takes a WebSocket only when its bearer is the key of a service that rides the door, and then
    pipes it to main-host's own SSH on `127.0.0.1:22`. Anything else is refused before a byte reaches
    SSH.
  - **The door's list** is `$BMO_DATA_DIR/env/tunnel-door.keys` on main-host: one key file's path to
    a line, each a service's own key, which that service's installer adds. The bridge reads the list
    and every key file in it for each connection, and a key file that is missing or not `0600` admits
    nothing. The door carries this service and the text model's head on n5 (`docs/n5-llm.md`), each dialling
    with its own key and each allowed its own listen on main-host.
- **The main-host end** is one entry in the account's `authorized_keys` for n6's tunnel key, which
  is an ed25519 key made on n6 with no passphrase and kept at `0600`. The entry allows nothing but
  port forwarding (`restrict,port-forwarding`), lets the key listen only on `127.0.0.1:18010`
  (`permitlisten`), and forces `/usr/sbin/nologin` as its command. A remote forward lands on
  main-host's loopback and on nothing wider.
- **The service answers at `http://127.0.0.1:18010` on main-host,** with the five paths above. That
  is the address BMO's `BMO_LAYA_URL` names, and the one a Claude Code session attaches with
  `claude mcp add --transport http laya http://127.0.0.1:18010/mcp --header "Authorization: Bearer …"`.
- **The public name is the tunnel's door, never the service's.** What answers on it is the bridge, and
  what the bridge reaches is SSH, which still asks for n6's tunnel key under the restricted entry.
- **Why the door is inside the house:** every caller — BMO, this repository's own reference-data unit,
  and a Claude Code session — runs on main-host, where the tunnel lands. A public name, a proxy host
  and a certificate in front of the service would stand in front of no caller.
- **Why the key is still checked:** both ends of the tunnel are shared. n6 carries a second login
  account, and main-host's loopback is open to every process on the machine.

## The key

- **One key is the whole service's:** the Laya token BMO already asks with,
  `$BMO_DATA_DIR/env/laya.token` on main-host (without `BMO_DATA_DIR`,
  `~/.local/share/bmo/data/env/laya.token`): 32 random bytes as hex, kept at `0600`. The installer
  makes it once if there is none, never overwrites one, and refuses one found with any other
  permission rather than using it, since it may already have been read.
- **What checks it:** the bridge on main-host for the tunnel's WebSocket, where it stands in the
  door's list, the front for every call but the open health, and the engine behind the front.
- **On n6 it lives only in `~/.config/bmo-llm/env`,** at `0600`, as `LLM_KEY` for the front and the
  tunnel's dial and `LAYA_TOKEN` for the engine. That environment file is the only place it has on
  n6.
- **BMO and the bridge read it** from its file for each request and hold it nowhere else.
- **It appears nowhere else:** no document, log line, response, unit file, command line, test
  fixture or archive row. A check that needs it sends a header built from the file, never the key
  written into a command.

## Installing and updating

`bun scripts/llm-install.ts` from this checkout on main-host is the one way the service is put on n6
or updated. n6 is a jake node, so every step reaches it through the jake console, never by SSH. In
order, it:

1. Makes the key on main-host if there is none.
2. Makes the service's folders on n6, and the gates' settings file `~/.config/bmo-laya/env` naming no
   gate where there is none. An existing settings file is never overwritten.
3. Builds n6's environment file in a private `0600` file and carries it across with `jake upload`,
   then deletes the local copy. The key never rides a `jake exec` command line.
4. Uploads the front's files from `llm-server/` into `~/bmo-llm`, and the engine's —
   `server.py`, `bench.py`, `pyproject.toml` and `node-setup.sh` from `laya-server/` — into
   `~/bmo-laya`.
5. Runs the node setup detached with `setsid nohup`, because the hub stops a streamed command after
   five minutes, and waits for its last line: `LLM-SETUP-DONE ok`, or `LLM-SETUP-DONE failed:<step>`
   naming the step. The setup installs uv if it is missing, builds or repairs the front's venv and
   installs its packages, then runs the engine's own setup in `~/bmo-laya` and requires its
   `LAYA-SETUP-DONE ok`. Running it again changes nothing that already stands.
6. Makes n6's tunnel key if there is none and reads back only its public half.
7. Adds the restricted `authorized_keys` entry on main-host unless it is already there.
8. Names the key's file in the door's list, links the bridge unit on main-host, and enables and
   restarts it.
9. Pins main-host's host key in n6's `known_hosts` from main-host's own host key file.
10. Installs the three units, reloads the user manager and enables and starts them.
11. Waits until `http://127.0.0.1:18010/health` answers on main-host — which it does only once the
    engine has loaded and tried every checkpoint it names.

The name, the proxy host and the firewall opening are made once, by hand, as jake's hub's are, and the
installer leaves them alone:

- the CNAME `llm-tunnel` → `home.example.org` in the `ahas.io` zone, DNS only;
- the NPM row for `llm-tunnel.ahas.io` (forward `192.0.2.8x:18022`, certificate 76, WebSocket
  upgrade, the same advanced settings as the config) and `llm-server/llm-tunnel.ahas.io.conf`
  written under that row's id, then `nginx -t && nginx -s reload` inside NPM's container;
- `ufw allow from 192.168.0.101 to any port 18022 proto tcp` on main-host.

## Putting a checkpoint in service

`bun scripts/laya-serve.ts <training gate>/<run>/step-<n> [--gate <gate>]` carries one collected
checkpoint from the collection on main-host (`docs/training.md`, 「Checkpoint naming and
collection」) to n6.

- **The carrying:** the checkpoint is packed here as one tar and hashed, and crosses with
  `jake upload` in parts of 96 MB, since the hub turns away a request body past 128 MB. On n6 the parts
  are joined, checked against the hash, unpacked under a partial name and only then given their own,
  so a transfer cut short leaves nothing that reads as a checkpoint. A 647 MB checkpoint crosses in
  about a minute and a half. One already standing under that name is left as it is.
- **Naming it for a gate** is `--gate`: the gate's pair in `LAYA_CHECKPOINTS` is written, or
  replaced, and every other pair is left as it was; the engine is restarted and the command waits
  until its health names the gate with that checkpoint. Which checkpoint a gate is answered by is
  하스's choice, as its mode and τ are; without `--gate` the checkpoint is only carried.
- **A restart is a gap** of about fifteen seconds a checkpoint, during which the engine does not
  answer and every gate runs on its LLM alone.

## n6 carries no training

- **n6 is the service's machine.** Laya's training and measurement run on n2 to n5 only
  (`docs/training.md`). The Laya node commands refuse n6 by name, because its card is shared by the
  services that answer there and a training run would hold it for hours.
- **Putting training back on n6** takes, in order:
  1. Point BMO's `BMO_LAYA_URL` at another Laya server, since its calls would otherwise go
     unanswered.
  2. Stop and disable the three `bmo-llm-*` units.
  3. Add n6 to the training nodes.
  4. Restate this document and `docs/laya-server.md`.

## The checks

Run on main-host, in this order. The key is read from its file into a header and never written into
the command:

```sh
key() { printf 'Authorization: Bearer %s\n' "$(cat "${BMO_DATA_DIR:-$HOME/.local/share/bmo/data}/env/laya.token")"; }
mcp=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -H 'mcp-protocol-version: 2025-06-18')
```

1. **Health, without a key:** `curl -s http://127.0.0.1:18010/health` answers 200 and nothing more.
2. **Health, with the key:** `curl -s -H @<(key) http://127.0.0.1:18010/health` names every gate with
   its checkpoint and where it is, `pinned` or `card`, and whether the engine holds the card lock;
   between calls every gate is `pinned` and the lock is not held.
3. **The model list:** `curl -s -H @<(key) http://127.0.0.1:18010/v1/models` lists the served gates.
4. **The MCP handshake:** an `initialize` posted to `/mcp` answers with the server's capabilities,
   and `tools/list` names `laya_decide` and `laya_gates`.
   `curl -s -H @<(key) "${mcp[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"check","version":"1"}}}' http://127.0.0.1:18010/mcp`
5. **A tool call:** a bare `tools/call` of `laya_decide` for a served gate answers with the
   decision as text content.
   `curl -s -H @<(key) "${mcp[@]}" -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"laya_decide","arguments":{"gate":"room-rules","state":"내일 배포 일정을 다시 잡아 주세요.","questions":{"q":{"type":"noul","instructions":"이 메시지는 일정 변경 요청인가?"}}}}}' http://127.0.0.1:18010/mcp`
6. **The same answers as the checkpoints give anywhere else:** `laya-server/bench.py --url
   http://127.0.0.1:18010 --token-file <the key file> --gates <every served gate>` asks each gate in
   turn, and a decision's probabilities match what the same checkpoint answers on any other machine
   to the precision the card computes at.
