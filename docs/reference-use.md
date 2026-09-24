# Whether the answer used what was attached

The four reference gates — `system-documents`, `room-rules`, `library-knowledge` and
`people-search` — each pick pieces out of a library for a turn to carry. Their Laya checkpoints were
scored against the LLM gate's own picks, and the LLM gate picks more than a turn uses, so agreement
with it cannot say which of the two is right. What settles it is the answer BMO actually sent: a
piece the answer drew on was needed, a piece it never touched was not. This document is the
canonical statement of that judgement — what is paired with what, what the judge is asked and in
which words, how the figures are read off it, and the shape its verdicts take as training gold.

## What a turn is made of

- **The candidates are the verdict record's own.** BMO's reference record keeps one row per
  candidate a gate was offered on a turn: the gate, the room, the message, the slug, the LLM's yes or
  no, Laya's where it was asked, and whether the piece actually reached the prompt
  (BMO's `docs/reference-selection.md`, 「What is recorded」). A turn is one room and one message
  across all four gates.
- **Attached means reached the prompt.** A piece the LLM wanted and the character line then dropped
  was never in front of the answer, so it is judged as offered, not as attached.
- **A turn whose record never said what attached is left out.** Rows written before the record
  carried the attachment hold a yes with no word on whether it reached the prompt, and such a yes
  cannot be told apart from one the safety line dropped. Those turns are counted and not judged.
- **The person-book search records only what it named.** A person-book candidate its LLM passed over
  has no row, so its offered set is read out of the probe input the Laya record kept for that turn;
  a turn with neither has only its named pieces.
- **The body of an attached piece is read through its fragment row**, whose path is relative to
  BMO's live checkout for the system documents and the lore, and to the brain for the rest
  (BMO's `docs/fragments.md`). The body is read as it stands when the judgement is made. The record
  keeps no copy, so a piece rewritten between the turn and the judgement is judged in its new words;
  the run records a hash of every body it read so a later run can tell whether the same words were
  judged.
- **The reply is the first run of BMO's own messages after the turn**, within thirty minutes of it,
  taken whole up to the next message somebody else sends. Two messages BMO answered together share
  that reply, because they did share it. A turn with no reply inside the bound is left out and
  counted, since there is nothing to judge a piece's use against.
- **The judge sees the turn itself, not the room.** The turn's own messages — the run of unanswered
  messages ending at it, as the gates read it — and the reply. A session carries earlier turns'
  pieces in its context, so a reply can draw on a piece attached before; the labels below are
  written so that case lands on the piece rather than on the turn.
- **What goes to the judge leaves the rooms the way a row does.** The turn's messages are in the
  plain shape with every name and number but BMO's replaced, and the reply, every body and every
  index line are scrubbed of keys, addresses and numbers (`docs/gate-data.md`, 「What leaves the
  rooms」). A body still carries what the piece is about, since that is what is being judged.

## The judgement

One item per turn, several turns to a batch, on the codex road the real rows are judged on
(`docs/gate-data.md`, 「The codex road」), holding no thread for the same reason judging holds none.
Every candidate of every gate the turn asked is answered, and each answer is one word.

- **An attached piece is answered with one of three words.** These three lines are the judge's
  instructions word for word, and the code's prompt carries them unchanged:
  - `used` — 답이 이 문서에만 있는 내용(사실, 수치, 이름, 절차, 규칙)을 실제로 가져다 썼다.
  - `related` — 답의 주제와는 맞닿아 있지만, 이 문서가 없었어도 답이 그대로였다.
  - `unused` — 답이 이 문서와 상관이 없다.
- **A piece offered and not attached is answered with one of two**, read off its index line alone,
  which is as far as a piece the answer never saw can be judged:
  - `needed` — 답이 이 문서가 다룰 내용을 담고 있거나, 이 문서가 없어서 틀리거나 모자랐다.
  - `not-needed` — 답에 이 문서가 필요하지 않았다.
- **Nothing in the item says which side picked what.** The judge is not told the LLM's yes or
  Laya's; an attached piece is marked attached because the answer saw its body and an offered one
  did not, and that is the only difference the judge is shown.
- **The bounds of one item.** A reply is cut at 8,000 characters and an attached body at 6,000; a
  batch holds at most eight turns and 60,000 characters of items, always taking one turn however
  long it is.
- **An answer is read per candidate and a gap is not a no.** A candidate the judge left unanswered,
  or answered with a word not offered for its kind, has no label and stays out of every figure.

## The figures

- **The gold of a candidate.** `used` and `needed` are yes; `unused` and `not-needed` are no;
  `related` is contested and stands out of every comparison of sets, since either answer about it is
  defensible.
- **Over-selection** of a gate is the share of its attached pieces judged `unused`, with `related`
  counted beside it rather than inside it.
- **Missing** of a gate is the number of turns where some piece it did not attach was judged
  `needed`, and the number of such pieces, beside the turns it was asked on.
- **Laya is asked again, not read back.** The recorded probe input of each turn and gate is put to
  the Laya server as it serves now, so a score belongs to the checkpoint serving the gate today and
  not to whichever one answered when the turn ran. A gate the server does not serve has no Laya
  figure.
- **Laya's verdict on a turn** is the set of candidates it gives a yes at or above even odds, and its
  confidence on the turn is the lowest of its per-candidate confidences — which is what a gate in
  `filter` compares with τ (BMO's `docs/laya.md`).
- **At each τ** the figures are the share of turns Laya would settle, and of those, how many its set
  matched: against the use gold on the uncontested candidates, and against the LLM gate's own set,
  the old measure kept beside the new one. The LLM gate's own accuracy against the use gold is read
  off the same turns, so the two are held to one bar.
- **A gate goes to `filter` on these figures only by 하스's word.** Where he has named a bar, the
  measure says whether the gate cleared it at some τ on both counts, and at which τ it covers most
  turns while doing so.

## The training shape

The use verdicts are gold a reference gate can be trained on, in the shape every frozen row takes
(`docs/gate-data.md`, 「A run folder」).

- **The state is the turn rebuilt as the real rows build it** — the turn's messages in the plain
  shape, with every name and number but BMO's replaced and every secret scrubbed
  (`docs/gate-data.md`, 「What leaves the rooms」). The recorded probe input carries the room's real
  names and is never written into a row.
- **The questions are that turn's own**, as its probe asked them.
- **The gold of a question** is a yes/no distribution: yes at 0.95 for `used` and `needed`, no at
  0.95 for `unused` and `not-needed`, and an even half for `related`. A question the judge left
  unlabelled leaves its row out, because a row with a hole in its gold is a row the training cannot
  read.
- **The row's id and split** are its input's hash and the split that hash fixes, as for every real
  row, so the same turn lands in the same split whichever gold it carries.
- **Every row is checked against its gate's specification** before it is written, and a refused row
  is counted by its reason.

## A run and its folder

`bun scripts/reference-use.ts <run>` measures, and a bare run name resolves under the runtime data
root's `reference-use/` folder, never inside this checkout.

- `batches/<n>.json` — each judged batch, frozen the moment its answer lands with the turns it
  carried, the labels read out of it, the raw answer and the tokens it spent. A turn is judged once:
  a run taken up again, or run again after the record has grown, plans batches over the turns no
  frozen batch carries and leaves the frozen ones as they are.
- `turns.jsonl` — one line per turn: its gates, every candidate with the LLM's yes or no, whether
  it attached, and the judge's label.
- `laya.jsonl` — Laya's fresh answer for each turn and gate it serves.
- `gates/<gate>/train.jsonl`, `calibration.jsonl`, `test.jsonl` — the training rows.
- `report.json` — every figure above, per gate and per τ, with the calls made and the tokens spent.

## What the first run measured

Run `2026-09-24`: every turn BMO's reference record held that day, 224 of them. 21 predate the
attachment column and were left out; none lacked a message or a reply. 203 turns were judged in 56
calls of `gpt-5.6-terra` at high effort — 966,596 fresh input tokens, 622,592 read from the cache
and 233,386 of output with the reasoning counted in, which is about 4,800 fresh and 1,150 out a
turn. Laya was asked again 609 times, none failing.

- **What the LLM gates attached and the answer did not use:**

  | Gate | Turns | Attached | used | related | unused | Over-selection | Turns missing a piece |
  |---|---|---|---|---|---|---|---|
  | `system-documents` | 203 | 195 | 19 | 134 | 42 | 22% | 3 |
  | `room-rules` | 203 | 96 | 12 | 30 | 54 | 56% | 41 |
  | `library-knowledge` | 203 | 129 | 6 | 30 | 93 | 72% | 48 |
  | `people-search` | 134 | 230 | 72 | 97 | 61 | 27% | 24 |

- **Each side's whole set against the use gold, on every turn:**

  | Gate | LLM gate | Laya | Laya against the LLM gate |
  |---|---|---|---|
  | `system-documents` (`real-1-hand2`) | 80% | 13% | 22% |
  | `room-rules` (`real-1-hand`) | 64% | 60% | 60% |
  | `library-knowledge` (`real-1-hand`) | 46% | 51% | 41% |

- **No gate clears 98% on both counts at any τ** that settles more than one turn. The best Laya does
  against the use gold is `library-knowledge` at 0.8 (69 turns, 75%) and `room-rules` at 0.7 (96
  turns, 83%).
- **`system-documents` on `real-1-hand2`** answers yes to `structure` on nearly every turn and to
  `wording` on 164 of 199, where the LLM gate and the use judge both say no to `wording` almost
  always; it is never at 0.9 or above on a whole turn. Its calibration figure — 0.985 balanced — rests
  on seven yes answers among 11,248 test questions.
- **`people-search` has no Laya figure and no training row.** Its probe was `too-large` on 219 of 224
  turns, because a room offers more person-book pieces than one Laya call carries, so no probe input
  was recorded. Its offered set is therefore only the pieces its record names, and its missing count
  is read off that partial set.
- **What `needed` is worth.** It is read off an index line alone, and a session carries pieces from
  earlier turns, so a reply can hold a piece's content without the piece being attached that turn.
  The missing counts above are the upper reach of what the gates left out, not a floor.
- **Training rows written:** 203 each for `system-documents`, `room-rules` and `library-knowledge`,
  none refused; none for `people-search`.
