# Output gate

How the formatting gate runs, which every message meant for people passes before it reaches a room.

## How the work is divided

- **The writer:** the agent writes markdown, and the sending path's code turns it into the marks the
  room's dialect accepts — for the `telegram-html` dialect, Telegram HTML
  (the agency's `prompts/rules/telegram-markup.md`, "What markdown becomes").
- **The dialect decides whether there is a gate at all.** A dialect that declares no fold decision,
  `plain` among them, runs no gate; its rooms get the marks stripped and nothing is asked of a model
  (bmo-chat's `docs/protocol.md`).
- **The gate:** one gate, `output-format`, which decides one thing — whether the message is folded.
  It writes no character and no mark, and no model reads the converted text to check it.
- **The code makes the characters and tags.** The conversion, the escaping, the structure check and
  the fold's shape are code, and their correctness is held by that code's tests, not by a model. So
  the original's characters structurally cannot change while passing the gate.
- **Who decides the fold is the gate's provider.** Its initial road is Laya
  (`docs/laya.md`, 「A gate whose provider is Laya」): one call to the fold checkpoint, which reads the
  message reduced to its opening, its closing and its counts, so a message of any length is asked.
  The gate may instead be put on an LLM road in the agent management screen; it then asks that one
  model the same question, with Laya beside it as its Laya mode says.
- **The rulebooks:** the fold judgement is the agency's `prompts/rules/formatting-judgement.md`. On an LLM road
  the gate reads it and the agency's `prompts/rules/answer-shape.md` on every call; on the Laya road the
  checkpoint was trained on verdicts made by that judgement.
- **No model reads this document.** It is a procedure document for whoever works on the gate;
  what a model must know lives only in the rulebooks.
- **The answer as written:** every answer comes here as the session wrote it, through the outgoing
  sanitiser alone. This document covers only what happens after that.

## Conversion

Code turns markdown into HTML, and every sending path does it the same way in front of the gate —
conversation answers and job reports that pass the gate, alerts that do not, and photo captions.

- **An allow list.**
  - The converter emits only these tags: bold, italic, strikethrough, spoiler, inline code, code
    block (with language), link, quote, and the fold's expandable quote.
  - Things with no matching tag, such as headings, lists, tables and rules, lie flat as plain text.
  - HTML written in the answer is escaped as characters.
  - What becomes what is in the rulebook.
- **One reading makes three things:** the HTML to send to Telegram, the plain text with the marks
  stripped, and the list of chunks that folding and splitting use. The plain-text fallback and the
  HTML come from the same reading, so they cannot disagree.
- **Marks and tags never overlap in one place.** A mark is either consumed where it made formatting,
  or, left unpaired, stays as characters without a tag. Inline marks pair only within one line.
- **Line breaks stay as written.**
  - Telegram shows text line by line, so markdown's paragraph-merging reading is not used.
  - A line indented four spaces is not code either; a code block comes only from a fence.
  - Because of this, and because of asterisk pairs attached to Hangul, the converter is the
    dialect's own code, not a general markdown library.
- **Conversion does the escaping.** Characters outside tags, characters inside tags and link addresses
  are all escaped by the conversion, and the structure check reads them again.
- **The one-bold rule is measured by code after conversion.** When there are several bolds, all stay
  only if each occupies its whole line (not counting a leading list mark or number); otherwise only
  the first bold stays.

## Splitting

- **The limit:** the room's dialect names it. One Telegram message holds 4096 characters after
  parsing, and the figures below are that dialect's.
- **Longer text is split before conversion,** on the markdown original.
- **Where it splits:** where a reader pauses — the last blank line inside the window, else a line break,
  else a space.
- **How a piece is measured:** after conversion. If the longer of the piece's visible HTML characters
  and its plain text exceeds 4096, the window shrinks and the piece is cut again.
- **Inside a code block:** the earlier piece closes the fence and the later piece reopens it with the
  same language, so no piece has unbalanced markup.
- **A line longer than the window:** cutting at a space avoids spaces inside inline code, links and
  formatting pairs. Only a single pair longer than the window has no space to avoid, and it stays as
  characters in both pieces.
- **Each piece is converted and passes the gate on its own,** the first one answering what the
  whole answered. A text longer than one message is never cut short and never refused, whether it
  answers a room or is a message the chat agent sends on its own.
- **The words the owner sends from the web console** take the same division on the reader's side.
- **Photo captions** have a much smaller limit of their own and are never folded.

## What passes through

- **Everything people actually read:**
  - conversation answers (including answers a session writes from search and browse results)
  - job reports
  - what the chat agent says to a room
- **Only text going out on a dialect that folds.**
  - An answer to what the owner said through the web console in their private chat goes back on the console's
    own road, which asks for no fold, so it passes neither the gate nor conversion.
  - A room whose dialect is `plain` is the same case: its words go out with the marks stripped and no
    step of this document runs.
  - The markdown stays in the room's record as written and shows in the console (the receiver's
    `docs/unified-bmo.md`, 「Console conversation in the private chat」).
  - In a group room, the answer goes to the room even when the owner spoke from the console, so it passes
    everything that room's dialect asks for.

Of the text going out on a folding dialect, two kinds are not asked. Both still go through
conversion.

1. **Short operational alerts.**
   - Fixed phrases such as restart, searching and going-to-rest alerts.
   - The failure text a runner writes when a job produced no report of its own.
   - If conversion made formatting or a fold, that HTML goes out; otherwise the plain text goes.
2. **Short one-line messages.**
   - A message with no line break and no more than 120 characters has nothing to fold, so nothing is
     asked.
   - If conversion made tags and the structure check passes, that HTML goes; otherwise the plain text.

## Steps

1. **Fold candidate.**
   - Code tries the folding rules (the agency's `prompts/rules/formatting-judgement.md`) on the chunk list.
   - If nothing is worth folding, there is no fold and the gate is not asked.
2. **Decide.**
   - Only for a message that can be folded, the gate is asked once whether to fold it: `FOLD` or
     `OPEN`.
   - On the Laya road the answer is the checkpoint's yes or no, whatever its confidence; on an LLM
     road it is the model's one word.
   - It judges the kind of message (informational or conversational) and whether it pushes the screen
     away.
3. **Structure check.**
   - Code reads the chosen markup's tags back — the folded candidate on `FOLD`, the converted markup on
     `OPEN`. It checks four things:
     1. only tags the rulebook allows were used
     2. tags open and close in pairs
     3. there is no nesting the rulebook forbids — between formatting such as bold and code or code
        blocks, or between a quote and an expandable quote
     4. there is no unescaped `<`, `>` or `&` outside tags
   - All four are facts settled by reading, not judgements, so no model is asked.
   - Markup the converter made that fails here is a converter defect, and markup Telegram would refuse.
4. **Send.**
   - The markup that passed goes out. A message carrying neither formatting nor a fold goes out as
     plain text.

## Failure and fallback

### When the gate cannot answer

- **The fold is not guessed at.** A gate on Laya that Laya gives no verdict for — out of reach,
  timed out, refusing, answering in a shape it was not asked for, a message it could not be asked
  about — asks its fallback LLM once (`docs/laya.md`, 「A gate whose provider is Laya」). A gate that
  still has no verdict, or an LLM road that did not answer in time or answered something
  unreadable, decides `OPEN`, which is
  the gate's stated default: the message goes out unfolded with all the writer's formatting.
- **It is said, not swallowed.** The failure is logged as the gate's error, its judgement line reads
  that the default was taken and why, and on the Laya road the failure kind is recorded with the
  pair (`docs/laya.md`, 「The verdict record」), so the console's Laya health and the record show it.
- **No other provider is asked instead.** A gate on the Laya road never falls back to an LLM, and a
  gate on an LLM road never falls back to Laya; the road is what the owner chose.
- **A stop:** a gate somebody stopped ends where it stands, and the message goes out as the writer
  wrote it, unfolded (the agency's `docs/own-llm.md`, 「A gate somebody stopped is not a gate with no answer」).

### When the structure check fails

- **The folded candidate fails:** it is written as one case in the case collection, and the converted
  markup is checked in its place.
- **The converted markup fails:** it is written as a case, and the plain text goes out.
- **What a case holds** is the reason the code wrote: which tag was inside which, which tag was not
  closed, which tag the rulebook does not know, which character was not escaped.

### The case collection

- **Where:** the gate's `format_cases` table; one line is one structure-check failure.
- **What a line holds:** when, which answer in which room, which candidate failed and why (folded = 1,
  unfolded = 2), and the target message's full markdown original and that candidate.
- **Reading it:** `bmo gate format-cases` prints the newest cases, twenty unless `--limit <n>` names another number, each
  message and candidate cut to its first 1,500 characters; `--show <id>` shows one case uncut. It prints
  English.
- **Retention:** lines older than ninety days are swept, as the service starts and once a day after. Converter
  work reads the last few weeks of failures, and the full messages are most of a line's bulk.
- **Nobody is told:** neither the room nor the owner.

### Other failures

- **Failure of the gate path itself** — anything the code throws on the way — sends the converted
  markup if it passes the structure check, otherwise plain text. The message arrives in every case.
- **Telegram refuses formatting the gate passed:** the plain text the same conversion made is sent
  instead. The markdown original is never sent raw.

### What the archive keeps

- **A room whose dialect has no formatting** gets the conversion's plain text without the gate, and where its
  chat service echoes what was sent, that room's record keeps that plain text.
- **A folding room's record** always keeps the markdown original as written, piece by piece.
  Formatting is how the room sees it; the session and the console read the original again.

## Cost

- **One question per message that can be folded,** and none for a message with nothing to fold. The
  structure check is code, so it costs no call.
- **On the Laya road** the question is one Laya call, tens of milliseconds (`docs/laya.md`, 「The server
  it asks」), and costs no model tokens.
- **On an LLM road** it is one gate run by the one road the work key names; with no answer within its time
  limit the gate takes its default (the agency's `docs/own-llm.md`, 「A gate has one road」).
  - **The system prompt:** the gate's instructions under its `output-gate` prompt folder, in a folder
    named for the folding dialect they judge for, then the agency's `prompts/rules/formatting-judgement.md` and
    the agency's `prompts/rules/answer-shape.md`. The dialect's own module declares the gate — the name it is known
    by, the model it runs on, what stands in its prompt and its Laya probe — so a road that brings a
    dialect of its own brings its gate with it.
  - **The user prompt:** only the converted HTML.
  - **Caching:** only the message at the tail changes per call. On the Claude road the head hits the
    prompt cache, which the cache warmer keeps warm, one prefix per folding dialect (the cache warmer's
    `docs/api.md`). A gate on the Laya road warms nothing.
  - **Nothing else is loaded.** A gate run carries no tools, skills or slash commands, MCP servers, or
    settings and instruction files from any work tree or the user configuration, and keeps no session.


## The replay bench

`bmo gate bench` measures the gate's road on the chat agent's own answers, so a change to the gate or its road
is put in numbers on the same pinned set before and after.

- **The set is pinned once:** `make-set` takes the chat agent's latest answers, thirty in the owner's room and
  twenty in group rooms unless `--owner-answers` and `--room-answers` say otherwise, from the conversation
  source (`docs/gate-data.md`, 「The conversation source」). The receiver serves no route for a room's messages
  yet, so `make-set` says the source is unavailable and pins nothing. A set stands under the data root's
  `gate-bench` folder as `bench-set.json`: when it was made, and each answer's room, message, room kind and
  text.
- **A run replays it under a label:** `run --label <name> --registration <name>` cuts each answer into the
  parts its dialect sends, and asks the gate about each part that can be folded, one call at a time and never
  two at once, with the gate's own instructions and request. Each call goes straight to the registration
  through the agency's model gateway, with thinking off, the gate's sampling, and the wait `--share-ms` names
  (45 seconds unless named; `profile` is the gate's own wait for the chat agent). A road that does not answer
  is recorded as it failed, never walked on.
- **Two ceilings are compared side by side:** `--answer-tokens` names the answer's ceiling, 4,096 unless named;
  two joined by a comma ask every call at each in turn, the order alternating call by call, so a queue that
  moves over minutes lands on both alike. `--offset` and `--limit` take a stretch of the set.
- **What a call records,** one line in `bench-<label>.jsonl` beside the set: the answer and the gate, the
  ceiling, the milliseconds, how it ended, the first line of the answer, and the answer's size in estimated
  tokens with whether it stood at the ceiling.
- **The summary,** `summary --label <name>`, is one table line per ceiling: calls, answered, the median and
  90th-percentile milliseconds of the answered ones, the longest, timeouts, other failures, the 90th-percentile
  and largest answer sizes and how many stood at the ceiling. It is printed and written beside the run as
  `bench-<label>.md`.

## Record

- **One judgement line per decision** in the judgement record (`judgements`), under `output-format`:
  the verdict, or the default taken and why, with the milliseconds taken, attached to the message
  answered.
- **On the Laya road** the question and Laya's answer are a row of the verdict record
  (`laya_verdicts`), with no LLM verdict beside it; the input it keeps is the reduced message the
  checkpoint was asked about.
- **On an LLM road** which road answered — provider, model, answered or timed out — is kept in the
  gate road record (`gate_roads`), under the round of the answer it judged, so the answer's token chip
  counts it.
- **The send** of one answer to a room — the gate and the Telegram request together — is kept as a
  verdict line of the `send` stage.
