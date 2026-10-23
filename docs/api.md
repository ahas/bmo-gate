# The gate's API

**Fixed in 0.1.0-rev.1.** This document and `docs/openapi.json` are the gate's canonical public API. The
OpenAPI document is generated from the contract's own types and a test fails where the committed document
differs from what the code generates. The Rust crate `bmo-gate-client` and the TypeScript package under
`package/` are made from that one document; a caller uses them and writes no client of its own.

The wire format and the API design rules are the common ones of bmo-chat's `docs/conventions.md`; this
document states only what is the gate's. Every route is grouped by the resource it acts on, and no section is
written for one caller.

## Common rules

- **Auth.** Every route takes `Authorization: Bearer <token>`; a missing or wrong token is 401 `unauthorized`.
- **Keys** are camelCase. **Times** are one integer of epoch milliseconds. **Ids** are signed 64-bit integers:
  a room is `roomId`, a message `messageId`, a person `personId`.
- **Pages** are `{"items": [...], "more": boolean}`. A list takes one cursor, `before` or `after`, and
  `limit`: 100 where none is given, at most 500.
- **Errors** are a non-2xx status and `{"code", "error"}`, the code kebab-case and stable, the error one
  English sentence. A refusal is answered by status too; no 2xx carries a refusal flag.
- **The gate names no caller.** A gate is `gateName`, an agent `agentName`; both are the names the caller
  registered, and the gate reads no meaning into either.
- **No personal data** enters a route or an answer beyond the opaque ids and names a caller hands over.

## Health

`GET /health` answers `ready`, `reason` (null when ready), `version` and `laya` (`up`, `down` or `off`, the
Laya relay's last answer).

## Gates

| Route | Request | Answer |
|---|---|---|
| `GET /gates` | | a page of the gate order, each `gateName`, `part` (`pre`, `post` or `apart`), `step`, `condition` or null, `switchable`, `layaProbe`, `defaultLayaMode` and `answerTokens` |
| `GET /options/{gateName}` | | `timeoutMs`, `layaMode`, `layaTau`, `layaProbe`, `switchable`, `enabled`, `layaFallback`, `effective` (`thinking`, `answerTokens`, `timeoutMs`, `layaMode`, `layaTau`) and `defaults` |
| `POST /options/{gateName}` | any of `timeoutMs`, `layaMode`, `layaTau`, `enabled`, `layaFallback`; a Laya field sent null goes back to the default | `gateName` and `options`, the gate's route as a run reads it (`provider`, `model`, `laya`, `timeoutMs`, `setAt`) |
| `POST /options/copied` | `agentName` (the companion), `fromAgentName` (the chat agent) | 204 |

- **A gate's options** are its wait, its switch where its profile lets it be switched off, its Laya mode, τ
  and fallback LLM (`docs/laya.md`). What it thinks and how much it may answer are its tier's on its road; a
  change naming either is refused `own-llm`.
- **Copying options** writes the `fromAgentName` agent's rows under `agentName` as they stand, so the
  companion's gates run on the same options from its first turn. An agent with no rows copies nothing and is
  no refusal.
- **A mode the gate cannot run in** is refused with the reason's own code: `no-probe`, `no-safe-verdict`,
  `no-checkpoint` or `needs-tau`.

## Laya

`GET /laya` answers `health` (`state`, `model`, `device`, `vramBytes`, `loadMs`, `versions`, `address`,
`checkMs`, `checkedAt`, `answeredAt`), `gates` (each `gateName`, `mode`, `tau`, `agreement` or null,
`checkpoint` or null, and `refused`, each mode the gate may not run in with its code), `modes` and `taus`.
An agreement carries `gateName`, `unit` (`pair` or `question`), `pairs`, `failures`, `agreement`, `byTau`
(each `tau`, `coverage`, `agreement`, `safeCount`, `safeAgreement`) and `settled`.

## Judgements

| Route | Request | Answer |
|---|---|---|
| `GET /judgements` | `roomId`, `gateName`, `from` and `to` (epoch milliseconds) narrow the list; `before` and `limit` page it, newest first | a page of judgements |
| `POST /judgements` | `roomId`, `messageId?`, `gateName`, `verdict`, `detail?`, `ms?`, `round?` | 201, the judgement as written |
| `POST /judgements/attached` | `roomId`, `messageId`, `since` (epoch milliseconds) | 204 |

- **A judgement** is a decision written into a room's log: a round's skip, a re-ask, an answer sent. It is
  written as it comes, with the moment it was written.
- **A judgement's roads** are its gate's road records of the same round, or of the same message where either
  names no round, that fall within the time the judgement took, give or take five seconds; each road goes to
  one judgement. Its `offers` are the offers record of its round. Both are empty on a judgement as `POST`
  answers it and filled on a judgement as `GET` answers it.
- **The attach** puts a round's judgements under the message that answered it: every judgement of the room
  written at or after `since` and standing under no message yet is put under `messageId`. A caller asks it
  once the answer is sent, `since` being the moment the round began.

## Reference

`POST /reference/selected` takes a turn's envelope:

| Field | What it is |
|---|---|
| `roomId` | the room |
| `messageId?` | the message the turn is about |
| `lines` | the room's recent messages in the room shape, each a string |
| `speakerIds` | the people whose words the turn answers |
| `situation?` | `agentName`, `roomKind` (`owner` or `group`), `events` (each `kind` and `itemId?`), `nowAt` |
| `holds?` | names the turn is held to |
| `round?` | the round the turn belongs to |
| `peopleSpoke` | whether anyone spoke |
| `answered?` | the answer already sent, where one was |
| `offGates` | the gates switched off for the agent |
| `lore?` | whether the room reads the lore, true where absent |
| `records` | whether the turn's offers and verdicts are written |

It answers `entries`, each `path`, `text` and `source` (`document`, `person`, `rule`, `situation`,
`knowledge`, `memory`, `room` or `archive`).

- **A turn's reference** is the reference gates, the person-book search and the situation-rule matcher run
  over the envelope, each on its own road, and the pieces they pick read from the brain. A gate named in
  `offGates` is not asked. Where `records` is true the turn's offers and verdicts are written.

## Sanitiser

| Route | Request | Answer |
|---|---|---|
| `POST /sanitised` | `text`, `label`, `roomId?`, `messageId?` | `text`, `changed` |
| `POST /sanitiser/documents` | `path`, `text` | `text`, the text to keep |

- **The sanitiser** defuses the smallest spans that carry security-intrusion material and leaves the rest as
  it was. Words with nothing worth judging come back as they are; where the sanitiser has no answer, the words
  that made them worth judging are blanked. A verdict is kept under the message where `messageId` names one.
- **A document's sanitising** reads the text an editor changed and answers the text to keep. A text with
  nothing worth judging comes back as it is.
- A run stopped by somebody is 409 `stopped`.

## Sheets

`POST /sheets/judge` takes `agentName`, `part` (`common` or `room`), `roomId` (null for the common part),
`personId`, `pieces` (each `path` and `text`), `ceiling` and `registration` or null. It answers `sheet`, or
null where none came.

- **A sheet's judgement** is the person-book summariser: one person's sheet of one part, written from the
  pieces handed in and held under `ceiling` characters, on the registration named where one is, else on the
  gate's own road.

## Translations

| Route | Request | Answer |
|---|---|---|
| `POST /translations` | `language`, `originals` | `readings`, each `text` and `whole` |
| `GET /translations/kept` | `language`, `originals` (a comma-separated list) | a page of `original` and `text` |
| `PUT /translations/kept` | `language`, `original`, `text` | 200, the translation kept |

- **A language** is a language tag. A translation is kept under its original and its language, so the same
  original is never translated twice into one language.
- **Reading kept translations** never asks the translator; the page holds one entry for each original with a
  translation kept in the language.
- **Translating** answers one reading for each original, in the order given: an original with no part in
  another language stands as it is; any other has its parts in another language translated, each part
  standing beside the rest as it did, and is kept; a part the translator could not render stays in its
  original, the reading is not `whole`, and nothing is kept for it.
- **Keeping a translation** keeps `text` as the reading of `original` in the language, in place of any kept
  before.

## Knowledge

| Route | Request | Answer |
|---|---|---|
| `POST /knowledge/selected` | `agentName`, `roomId`, `lines` | `pieces`, each `path` and `text` |
| `POST /knowledge/work` | `roomId`, `lines` | the same pick for the chat agent |

Both pick, from the brain's libraries the agent may be offered in the room, the pieces a piece of work's own
lines call for. The narrowing, the pick and the count of what was attached are the gate's. A pick that fails
costs the work its reference and nothing else.

## Runs

`POST /stages/{gateName}/runs` takes `prompt`, `system?`, `roomId?`, `messageId?`, `agentName?`, `thinking?`
(true where absent) and `alongside?` (false where absent). It answers `answer` (the gate's text, or null where
its road gave none) and `ms`.

- **One run of one gate,** for a unit that reads the answer itself. The run goes on the gate's road with the
  gate's options and is recorded as a road like any gate run.
- **The instructions** are the gate's own where `system` is absent. A name that is not a gate is 404
  `no-gate`; a gate switched off answers null without asking any road.

## Formats

`POST /formats/decided` takes `roomId` and `text`, one part of a reply as the dialect divided it, in markdown.
It answers `markup`, the markup the part goes out as, or null to send its plain text.

- **The output gate** (`docs/output-gate.md`) reads the part as the `telegram-html` dialect reads it, folds it
  where the gate says FOLD, and hands back the first candidate the structure check passes. Its decision is
  written into the room's log, and a candidate the check refuses is kept as a format case. It never fails a
  part.

## Trials

| Route | Request | Answer |
|---|---|---|
| `GET /trials` | `gateName`, `after` or `before`, `limit`; oldest first | a page of trials |
| `POST /trials` | `gateName`, `prompt`, `userName` | 201, the trial |

A trial is `id`, `gateName`, `userName`, `prompt`, `answer` or null, `ms` and `createdAt`. It puts one prompt
to one gate as a turn would, records no judgement, and keeps the trial. A prompt is at most a million
characters; a longer one is 413 `too-large`.

## Documents

| Route | Request | Answer |
|---|---|---|
| `POST /documents/sought` | `question`, `entries` (each `slug`, `line`, `group?`) | `picks`, the slugs chosen; 502 `no-answer` where the seeker gave none |
| `POST /documents/translations` | `document`, `version`, `target`, `partCount`, `wanted` (each `part` and `text`) | 202 with `taken`, the parts queued |
| `GET /documents/translations/state` | `document`, `target` | `pending`, `failure` (`reason`, `provider`, `model`) or null |
| `GET /documents/translations/parts` | `document`, `version`, `target` | a page of `part`, `text` and `failed` |

- **A translation of a document** is queued part by part; each part is kept once it comes back with its
  structure kept, asked once more where it lost it, and kept as failed where it lost it twice.
- A document name is a root and a path, a `/` between them; anything else is 422 `document-unknown`. A target
  the translator does not take is 422 `language-unknown`.

## Events

`GET /events` is the gate's one stream, as server-sent events. An event's `event` field is its kind and its
`id` field its number; its data is `{"id", "kind", "at", "data"}`, the inner `data` being the member the
event tells of. The kinds are `judgement.created`, `document-translation.changed` and `laya.changed`. A
reader that falls behind loses what it missed and reads the collections again.

## The document

`docs/openapi.json` is the machine form of this contract: every route, its body, its query, its answers and
the codes it can answer with. It is generated by `cargo run -p bmo-gate-client --bin gate-openapi`, and
`tests/api.rs` fails where the committed file and the generated one differ. The Rust crate
`crates/client` and the TypeScript package under `package/` are its two clients.
