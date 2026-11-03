# Gates

## No gate stands

- **The gate order is empty.** The gate order is where each gate stands against a chat turn, and it is declared
  once in the gate's own policy (`docs/layout.md`). It holds no gate: the agent formats its own reply and keeps
  its own session, so neither the formatting gate nor the session summariser is asked at a turn.
- **Every list of gates is read from the order,** through `GET /gates` (`docs/boundary-api.md`), so every list is
  empty with it. A gate's options, a stage run and a trial serve no gate either: a name that is no gate of the
  order is refused `no-gate`.
- **A gate is a model-only run of the gate's:** one prompt in, one text out, no shell, no tool and no session of
  its own. A run goes out on the provider order of the role its profile names (「Where a gate's runs go out」
  below), and what reaches a model on each road is `docs/boundary-api.md`, 「How a gate run reaches a model」.
  No gate of the order runs.

## Where a gate's runs go out

- **A gate's profile names a role of the agency's,** and its runs go out on that role's provider order (the
  agency's `docs/agent-roles.md` and `docs/provider-order.md`). No gate is a role, and the agency seeds none for
  a gate and chooses no provider for one (its `docs/own-llm.md`, 「Gates are not agency's runs」): the role a
  profile names is one the owner keeps on the agency's control port for it. A gate whose role the agency does
  not hold has no road, and a run of it is refused as a fault of the road.
- **A run reads its role as it starts** (`GET /roles/{roleName}`, `docs/boundary-api.md`, 「bmo-agency」) and goes
  out on the role's active provider, with the model, the effort, the thinking and the answer ceiling the order's
  entry names there. Where the role names no active provider that is on, the run goes out on the first entry of the
  order whose provider is on; where no provider of the order is on, it stands on the order's first provider with
  nothing to run on there, and the gate has no answer.
- **A role whose order is empty gives a gate no road.** Such a role follows the supervisor that asks it, and no
  supervisor asks a gate run.
- **A run its caller puts on one provider** goes out on the role's entry for that provider where the provider is
  on, and has nothing to run on where the order holds no entry for it or it is off. **A run its caller puts on
  one registration** goes to the first provider whose models are registrations, with that registration as its
  model and the effort, the thinking and the answer ceiling the role's entry for that provider names.
- **What a gate thinks and how much it may answer are its role's,** never an option of the gate's
  (`docs/api.md`, 「Gates」).
- **No gate stands in the order,** so no profile names a role and no run reads one.

## What a turn is served with

The gate is still the gate stage of a turn. A turn is served with:

- **its reference,** which attaches with no pick: the head of each speaker's sheet, the room's due memories and
  the rows the turn's events wake (`docs/reference-selection.md`, 「What a turn is given」), and the brain's index,
  its pieces and a search of it, which the agent reads the rest of its brain through;
- **the translator,** for a text or a document that needs another language, which is asked of the agency's
  translation line part by part (`docs/boundary-api.md`, 「The translation line」);
- **its judgements and road records,** which the service writes as it is told them and as the agency's road
  events arrive.

A translation is no gate. The translator keeps the translations route, the kept translations and a document's
translation queue, and the gate order holds no translator. The sanitizer and the other pre-gate work a turn
carries are the agency's and another unit's, and are not asked of this service.

## What a turn records

- **A judgement** is a decision written into a room's log: a round's skip, a re-ask, an answer sent. It is
  written as it comes, with the moment it was written (`POST /judgements`), and read back by `GET /judgements`.
- **The `draft` stage is the gate's own.** The receiver tells each row of a round's draft process; the gate
  writes one judgement for each row the receiver tells, and judges nothing of what was asked or answered.
  `draft` is no gate: it stands in no part of the gate order, runs no model and has no options. Every row the
  receiver tells leaves one judgement, whatever its kind and whatever its number, and no row is waited for or
  taken to stand before another:

  | Verdict | Row |
  |---|---|
  | `ROUND <number> <name>: <outcome>` | any row but the end — a turn, a question, an item or a check: its number in the process, its question's name, or its kind where it names none, and how it ended (`answered`, `skip` or `failed`) |
  | `END: <outcome>` | the end: `message`, `skip`, `withheld`, `ceiling-message` or `ceiling-skip` |

  Its detail is `answerChars=<n> changed=<true|false> ms=<n>`, and after it, past a semicolon, what the receiver
  said of the row where it said anything: for the end, the row of the process table the turn read and the checks
  that withheld the text. The judgement carries the round, stands in the round's room, and is put under the
  round's message the way the round's other judgements are: where one of the round's judgements already stands
  under a message it is written under that message, and otherwise it waits for the receiver's attach
  (`POST /judgements/attached`).
- **The history reads a judgement by its gate's name, whether the order holds that gate or not** (`GET
  /judgements`); nothing else reads a judgement of a gate the order does not hold.
