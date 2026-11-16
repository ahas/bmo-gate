# gate/reference_index, gate/reference_piece, gate/reference_search

The brain's index as you read it yourself: what the brain holds for the room beyond what your turn carried.
Reading it is a choice, never a duty: read it when the answer needs something you do not already hold, and
speak of nothing you have not read as fact.

## The index

`gate/reference_index` answers five groups in order: `system-documents`, `room-rules`, `knowledge`, `people` and
`room-memories`. Each group says how many of its entries this session has not read (`unread`), one sentence where
something in it changed in the last three days (`hint`), and its entries: the `slug`, what it `holds`, and when to
read it (`readWhen`, null where its title does not say).

```json
{}
```

## A piece

`gate/reference_piece` reads one entry whole by its `slug` and its `group`, and records it as read in this
session, so the next index counts it read.

```json
{"slug": "<slug>", "group": "knowledge"}
```

## A search

`gate/reference_search` matches the words of `query` against every group's entries and answers the closest
first, at most `limit` (8 where absent, 24 at most). It asks no model: name the words the entry would hold.

```json
{"query": "release checklist", "limit": 5}
```

## The room and the session

Each call reads your own brain, for the turn's room and session; name `room` only to read another room. Naming a
room never reaches another agent's brain. A result marked as an error is a refusal: its text says why.
