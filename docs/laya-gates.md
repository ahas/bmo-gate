# The nine split gates

A specification of the ten Laya gates the reference road is divided into. It fixes, for each gate,
the input it receives, the question it asks Laya, the
answers it may give, and whether it is asymmetric — and beside those, the language mix and the answer
balance its distilled training data is to be drawn to.

- **This is a target specification, not a description of what runs.** Two of the ten have no gate
  code at all. Each section says which gates run and how.
- **What it is for:** the distilled data is generated against this document, the training and the
  verification are measured against it, and the structural split implements it. Where the built gate
  and this document differ, one of them is wrong and it is said so rather than quietly settled.
- **BMO's `docs/laya.md` is the canonical account of the filter as a gate asks it** — the modes, the
  τ comparison, the verdict record and the probe contract. This document adds no mechanism; it only
  says what each of the ten asks.
- **No τ is chosen here.** Choosing τ for a gate, and moving a gate off `shadow`, is 하스's and no
  job's (BMO's `docs/laya.md`, 「Who decides」).

## Question types

- **Two types only: `noul` and `choice`.** A `noul` question is answered yes or no; a `choice`
  question is answered with one of its named options. The `score` type exists in the client and no
  gate uses it, so no gate here asks one.
- **A gate may ask several questions of one input.** The three reference splits, the situation-rule
  matcher and the person-book search each ask one question per candidate, and the confidence the
  filter compares with τ is then the lowest of them.
- **What one call holds:** at most 128 questions, a state of at most 768 tokens and a question of at
  most 256. Every row of every gate's data fits inside that or it is not a row.

## The three transcript shapes

Three different line shapes are handed to gates today, and a gate's data is written in the shape
that gate really receives.

- **A message is one entry, not one line.** Its own text may carry newlines, and one answer of BMO's
  routinely runs to a dozen of them; those later lines stand without a prefix and belong to the
  entry above them. So a transcript stands in its gate's shape when the first line of it carries the
  prefix, and nothing is read off how many of the lines after it do — a real turn of a real room has
  far more continuation lines than prefixed ones, and weighing the two against each other refuses
  the very shape the gate is handed at every turn it runs. What that test refuses is a state that is
  prose rather than a transcript, and prose does not open with a sender and a number.
- **A message's own number may be negative.** The archive numbers some of what it holds from below,
  and both the shape and the test on it carry the number as given rather than one of their own.

- **The plain shape** — one line per message, the sender's name, the sender's number and the text:

  ```
  <보낸 사람 이름> (id <보낸 사람 번호>): <본문>
  ```

  The number reads `unknown` where the message carries none. There is no timestamp and no reply
  marker in this shape. It is what the three reference splits and the person-book search are given —
  the four gates that read a turn's messages only to pick documents out of a library.

- **The pipe shape** — one line per message, six fields, the reply marker last:

  ```
  <메시지 번호> | <시각> | <보낸 사람 번호> | <보낸 사람 이름> | <본문> [replies to <메시지 번호>]
  ```

  The time is an ISO 8601 instant at the Seoul offset, `YYYY-MM-DDTHH:MM:SS+09:00`. The trailing
  marker stands only on a message that is a reply. This is the shape the person-book writing road
  reads. No gate is given it.

- **The room shape** — what a gate reading a room's recent messages is handed: the time in brackets,
  the message's own number after a hash, the sender's name, the sender's number with an owner tag
  where the sender is 하스, the text, and then the notes the message carries:

  ```
  [<시각>] #<메시지 번호> <보낸 사람 이름> (id <보낸 사람 번호>, OWNER): <본문> <노트>…
  ```

  The time is an ISO 8601 instant in UTC. `, OWNER` stands only on 하스's own messages. A note is a
  bracketed English sentence appended after the text, one per thing the message carries — a reply,
  an attached image, an attached file. A reply's note names the message replied to and who sent it,
  or says the archive no longer holds it. A message with nothing attached and no reply carries no
  note at all. This is the shape the content gate reads, and the shape the reply-or-not gate is
  specified to take.

- **What 하스 asked for and what the gates get.** His instruction names 발신자 번호와 이름, 시각,
  답장 표시 as fields the data must carry, and his own rule is 「입력은 비모가 실제로 받는 형식 그대로」.
  The room shape carries every one of them, so the three gates that judge a room's situation — the
  situation-rule matcher, the content gate and the reply-or-not gate — are specified on it. The plain
  shape carries no time and no reply marker, and the four gates that receive it keep it as it is: the
  real shape governs, and those two fields are simply absent from their data.

- **Attachments** are placeholders in the text, not separate fields:

  | What arrived | What stands in the line |
  |---|---|
  | a photo | `[사진]`, the caption after it where there is one |
  | a voice message | `[음성 <분>:<초>]`, the minutes unpadded and the seconds two digits |
  | a file | `[파일 <파일 이름>]`, the name absent where the file carries none |
  | a sticker | `[스티커 <이모지> (<세트 이름>)]`, each part only where it exists |
  | a video | `[동영상 <분>:<초>]` |
  | a video note | `[동영상 메모 <분>:<초>]` |

- **Rooms come in three kinds** and the data carries all three: 하스's private room, a room with
  several people in it, and a room another AI sits in. Only the first two are told apart by the gates
  today — as `owner` and `group` — so a room with another AI in it is a `group` room whose speakers
  include one that is not a person. That distinction lives in the conversation rather than in a field,
  and the data carries it the same way.

- **BMO's own messages** are taken out of the lines handed to the reference splits and the
  person-book search, because those two are picking documents about the people who spoke. They stand
  in the lines the reply-or-not gate reads, since a message following BMO's own answer is exactly
  the case that gate has to judge.

## The language mix

`laya-multilingual` is one model, so each gate has one dataset and the languages are mixed inside it
in the proportion that gate really meets.

- **The three buckets:**
  - **Korean** — the prose is Korean throughout. English appears only as a borrowed word, an
    identifier, a path or a fragment shorter than a line.
  - **English** — the prose is English throughout, with no Korean sentence in it.
  - **Mixed** — Korean and English sentences stand together in one state, or a Korean message carries
    a block of English longer than one line: a log, a code block, a stack trace, a list of paths.
- **The share each gate is drawn to**, and why it is that share:

  | Gate | Korean | English | Mixed | Why |
  |---|---|---|---|---|
  | 시스템 문서 분류기 | 70% | 10% | 20% | the turn's own messages; the owner's room and the work rooms carry job reports written in English and command lines inside Korean sentences |
  | 방 규칙 분류기 | 80% | 5% | 15% | room rules are asked about in ordinary rooms, where English arrives as a borrowed word or a single pasted line |
  | 서고 지식 분류기 | 75% | 8% | 17% | the knowledge library holds working knowledge, so the turns that reach for it lean technical more often than an ordinary room's |
  | 상황 규칙 매칭기 | 80% | 5% | 15% | a situation is the room's own talk and a rule is written in the room's language |
  | 출력 서식 | 65% | 5% | 30% | BMO's answers are Korean by the answer-language rule and carry code blocks, paths and logs inside them more often than any other gate's input |
  | 답변 내용 게이트 | 75% | 5% | 20% | the candidate answer and a group room's recent messages together: BMO's Korean prose with technical fragments embedded |
  | 무해화 게이트 | 40% | 35% | 25% | what it reads is carried material — job prompts, fetched pages, documents, logs — whose English share is far larger than any room's |
  | 인물북 서칭 | 80% | 5% | 15% | the turn's own messages in a room where people are being talked about |
  | 응답 여부 판정기 | 80% | 5% | 15% | a room's recent talk, which is the room's own language |

- **The tolerance is ±5 points per bucket.** A generated dataset whose bucket falls outside that is
  regenerated for that gate rather than accepted.
- **Accuracy is measured per bucket, not only overall**, so a model that holds up in Korean and
  collapses in English is visible rather than averaged away.

## The answer balance

The real distribution of most of these gates is lopsided — a reference candidate is wanted far less
often than not — and data drawn to it teaches the model to give the common answer always, which
agrees with the gate as often as a real judgement and decides nothing. So the data is drawn balanced
and the lopsidedness is left to τ.

- **A yes/no gate:** each answer 50% of its questions, ±5 points.
- **A choice gate:** each option an equal share, ±5 points.
- **A gate that asks one question per candidate** counts its balance over questions, not over rows.
  Beside that, at least 1,000 training rows carry at least one yes and at least 1,000 carry none, so
  the model meets both the turn that wants a document and the turn that wants nothing.
- **The floors per gate:** at least 4,000 training rows, at least 1,000 rows or questions carrying the
  rarer answer, and at least 1,000 rows held out for evaluation.

## Which model writes the rows

Two models can write this data: `claude-opus-5` at medium effort, which costs tokens, and J3090's
`qwen3.8-27b`, which runs at home and costs none. 하스's word on the choice is 「괜찮으면 그냥 opus5
쓰지말고 qwen 쓰자」, so the question is only whether qwen is good enough, and that is settled by
measurement against the bar below rather than by reading a sample and forming an impression.

- **The bar is written before the pilot runs.** A bar set after the figures are in is not a bar.
- **The pilot:** about 100 rows for each of two gates chosen for their distance — 응답 여부 판정기, the
  simplest, and 답변 내용 게이트, the hardest — written by each model against the same specification and
  scored with the same audit.
- **The five figures, each read off what the model wrote rather than off what survived:**

  | Figure | What it says | qwen passes at |
  |---|---|---|
  | yield | the share of written rows that answered their own gate | at least 0.70 |
  | format breaks | the share refused for a transcript in the wrong shape, or unreadable as a row at all | at most 0.10 |
  | balance drift | how far the answers fell from the even split, at its furthest | at most 0.15 |
  | language drift | how far the languages fell from the gate's ratio, at its furthest | at most 0.15 |
  | repeats | the share of written rows that were a row already written | at most 0.05 |

- **Why these and not the audit's other share.** The generator refuses a bad row before it freezes,
  so the frozen rows always conform; the figure that says whether a model was any good is what it
  wrote before that filter, and only the run's own meta still holds it.
- **The bars are looser than the specification's own** — the finished dataset is held to ±0.05 on
  balance and language — because a 100-row pilot with a forced answer in each batch is a noisier
  thing than 7,500 rows, and the pilot is deciding a model rather than accepting a dataset.
- **What each outcome settles:**
  - qwen meets all five on both gates — the full generation runs on qwen, which is what 하스's
    conditional already decided.
  - qwen misses any one of them on either gate, and `claude-opus-5` meets them — the full generation
    runs on `claude-opus-5` at medium, which is this item's own stated baseline.
  - neither meets them — nothing is generated, and the question goes to 하스, since a dataset built
    on a model that cannot hold the format is worse than no dataset.

## What the first pilot measured

The pilot was run against the bar above: 100 rows of 응답 여부 판정기 and 100 of 답변 내용 게이트, on each
road, scored with the same audit.

| | qwen 응답 | qwen 내용 | opus 응답 | opus 내용 | passes at |
|---|---|---|---|---|---|
| yield | 0.75 | 0.75 | 0.83 | 0.86 | ≥ 0.70 |
| format breaks | 0.00 | 0.00 | 0.07 | 0.01 | ≤ 0.10 |
| balance drift | 0.50 | 0.50 | 0.21 | 0.20 | ≤ 0.15 |
| language drift | 0.20 | 0.25 | 0.15 | 0.18 | ≤ 0.15 |
| repeats | 0.00 | 0.00 | 0.00 | 0.00 | ≤ 0.05 |

- **Neither model met the bar**, and both missed the same two figures. That is the third outcome
  registered above, and it would send the choice to 하스 — except that both failures were the
  generator's rather than either model's, so the measurement says nothing about the models and the
  bar was applied to a broken instrument.
- **Why the balance drifted.** The batch plan drew the answer to lean on and the language to write in
  from the same batch number, and at five batches the two lined up exactly: every batch of one
  answer took one language. A language the model then could not write cost that answer every row it
  had, which is how a gate came out at 100% one answer. The plan now draws the language within the
  batches leaning on each answer, so no answer can be emptied by a language.
- **Why the language drifted.** A row's language was read off the whole transcript line, and a
  transcript line carries the sender's name. In a Korean room that name is Korean, so a line whose
  message was English still read as Korean and the row was refused. The language is now read off
  what was said, with the line's prefix taken off.
- **What the re-run showed.** qwen's 응답 여부 판정기 leg was run again with both repairs in, 100 rows on
  the same bar:

  | | first run | re-run | passes at |
  |---|---|---|---|
  | yield | 0.75 | 0.80 | ≥ 0.70 |
  | format breaks | 0.00 | 0.00 | ≤ 0.10 |
  | balance drift | 0.50 | 0.00 | ≤ 0.15 |
  | language drift | 0.20 | 0.20 | ≤ 0.15 |
  | repeats | 0.00 | 0.00 | ≤ 0.05 |
  | lost batches | 1 | 0 | none |

  The balance went from a gate answering one way every time to an exact half and half, which is the
  coupling repair showing up as a number rather than as an argument. What is left is the language,
  and its cause is now named: the English batch's rows were refused for translating the gate's own
  question text, which must stand verbatim whatever language the messages are in. Fixing that is
  what the bar is re-applied after, and until then no model has been measured cleanly on all five.
- **The measured costs stand whatever the verdict.** On the Claude road the held session worked:
  265,109 cache-read tokens against 90 of new input over fifteen batches, at $9.47. The J3090 road
  reported no tokens at all, because it keeps no session and the service returns no usage.

## What the clean pilot settled

Once the three instrument defects were repaired, the pilot was run again whole — 100 rows of each
gate on each road, same bar, same audit.

| | qwen 응답 | qwen 내용 | opus 응답 | opus 내용 | passes at |
|---|---|---|---|---|---|
| yield | 1.00 | 0.78 | 0.93 | 0.90 | ≥ 0.70 |
| format breaks | 0.00 | 0.00 | 0.01 | 0.03 | ≤ 0.10 |
| balance drift | 0.25 | 0.01 | 0.10 | 0.09 | ≤ 0.15 |
| language drift | 0.20 | 0.20 | 0.15 | 0.15 | ≤ 0.15 |
| repeats | 0.00 | 0.00 | 0.00 | 0.00 | ≤ 0.05 |
| lost batches | 1 | 0 | 0 | 0 | none |

- **`claude-opus-5` at medium effort met the bar in the pilot.** It meets all five on both gates;
  qwen misses the language on both and the balance on one. That is the second outcome registered
  above, reached by the rule rather than by preference. The rows themselves are written on the two
  roads `docs/gate-data.md` names, codex and J3090; no road carries claude.
- **What the language figure is worth.** At a hundred rows one batch is a fifth of the run, so a
  language drawn to five per cent cannot be hit at all and the drift cannot fall below about fifteen
  points however good the model is. opus reached the bar by mixing languages inside a batch rather
  than by hitting the ratio across batches. The figure separated the two models here, but it is a
  coarse instrument at this size and the full run's own ±0.05 is what actually governs the dataset.
- **What each road costs, measured.** The Claude road held its session as intended — 265,109
  cache-read tokens against 90 of new input — at $0.63 a twenty-row batch. The J3090 road returns no
  usage at all and keeps no session, and it ran about three times slower per batch.

## 1. 시스템 문서 분류기

- **Status:** a gate of its own, on the key `system-documents`, with a probe of its own.
- **Input:** the turn's messages in the plain shape, and the system references the room offers that
  BMO's narrowing keeps for the turn — the root documents named in the system reference index, and
  the lore pieces in a room that reads the lore. Each candidate carries its slug and the one line its
  index says about it. The input is BMO's own, byte for byte (`docs/reference-data.md`, 「The input」).
- **Question:** one yes/no per candidate — 「이 대화에 답하려면 이 참고 문서가 필요한가?」 — named by the
  candidate's own slug.
- **Answers:** the set of slugs answered yes, or none. Two verdicts agree when the two sets are equal.
- **Asymmetry:** none. Neither answer is the safe one: a document wrongly left out costs an answer
  written without it, and one wrongly carried costs prompt room, and neither is the kind of harm that
  makes a verdict settleable on its own.
- **Candidates per row:** 1 to 128 — whatever the narrowing keeps, capped at one Laya call. A room
  that does not read the lore offers only the system reference index's own slugs, which are few; a
  room that reads it offers the lore's chunks beside them, which are many. Both ends are real and the
  data carries both.

## 2. 방 규칙 분류기

- **Status:** a gate of its own, on the key `room-rules`, with a probe of its own.
- **Input:** the turn's messages in the plain shape, and the room's own rule pieces BMO's narrowing
  keeps for the turn as candidates, each with its slug and its index line. A room with no rulebook
  offers none and is not asked.
- **Question:** one yes/no per candidate — 「이 대화에 답하려면 이 방 규칙이 필요한가?」
- **Answers:** the set of slugs answered yes, or none.
- **Asymmetry:** none.
- **Candidates per row:** 1 to 128 — whatever the narrowing keeps.

## 3. 서고 지식 분류기

- **Status:** a gate of its own, on the key `library-knowledge`, with a probe of its own.
- **Input:** the turn's messages in the plain shape, and the knowledge library's pieces that this room
  may see — the ones its index marks for this room or as shared — that BMO's narrowing keeps for the
  turn, each with its slug and its index line.
- **Question:** one yes/no per candidate — 「이 대화에 답하려면 이 지식 문서가 필요한가?」
- **Answers:** the set of slugs answered yes, or none.
- **Asymmetry:** none.
- **Candidates per row:** 1 to 128 — whatever the narrowing keeps.

## 4. 상황 규칙 매칭기

- **Status:** a gate of its own, on the key `situation-rules`, with a probe of its own. It stands
  beside the reference gates rather than among them, and what it matches against is the room's
  standing memories that carry a condition — pairs whose actions attach only on a
  turn the condition fits (`docs/memories.md`).
- **Input:** the room's recent messages in the room shape as the situation, and the room's standing
  memories that carry a condition as candidates. A rule is a pair — the condition it waits for and the action it asks
  for — and both halves go in, named by the rule's own slug. It takes the room shape rather than the
  plain one because a condition waits on when something happened and a spent rule is one whose moment
  has passed, and neither can be read off lines that carry no time.
- **Questions:** two yes/no per rule, so a row of five rules asks ten.
  - 「이 규칙의 조건이 지금 상황에 맞는가?」
  - 「이 규칙은 이제 안 써도 되는가?」
- **Answers:** for each rule, whether it fires now and whether it is spent. A rule may fire and be
  spent in the same judgement — a rule that waited for one thing, got it, and has nothing left to do.
- **Asymmetry:** none. A rule wrongly fired and a rule wrongly retired are both corrected by the
  model that follows, and neither answer is cheap enough to settle alone.
- **Rules per row:** 2 to 8, which is 4 to 16 questions.

## 5. 출력 서식

- **Status:** BMO's one formatting gate, on the key `output-format`, whose provider is Laya: the
  fold is Laya's verdict alone, and the markup is the code's. It is declared by the dialect that
  folds.
- **Input:** the markdown as BMO wrote it, reduced so a message of any length fits one call — the
  reduction is fixed to the character, since BMO builds the same state from the same markdown:
  - the text is trimmed of the whitespace around it;
  - `head` — where the whole costs no more than 520 tokens in the generous count, the whole text;
    otherwise the longest opening costing at most 320, ended at the last line break where one falls
    in its latter half;
  - `tail` — empty where `head` holds the whole; otherwise the longest closing costing at most 200,
    begun after the first line break where one falls in its former half;
  - `chars`, the characters of the whole; `lines`, its lines that are not blank; `paragraphs`, its
    runs of lines that are not blank; `items`, the lines opening with a list mark (`-`, `*`, `+`,
    `•`, or a number of up to three digits and `.` or `)`); `headings`, the lines opening with one
    to six `#`; `code`, the fence lines halved and rounded up; `table`, the lines opening with `|`;
  - where escaping would carry the state past 768 tokens, both excerpt budgets are cut to three
    quarters, a half and a quarter in turn, and the first that fits — or the quarter — is the state.
- **What the judge reads:** the markdown whole, never the reduction (`docs/gate-data.md`, 「Judging
  the real rows」).
- **Question:** one yes/no — 「이 메시지는 채팅방에 접어서(펼치기 인용으로 감싸서) 보내야 하는가?」
- **Answers:** fold or open.
- **Asymmetry:** none. A wrongly folded message is a cosmetic error either way.
- **Note:** whether the converted text keeps the original, and tag validity, escaping and nesting,
  are the conversion code's and its tests', never a model's, so they are not questions here.

## 6. 답변 내용 게이트

- **Status:** runs today with its own probe, as the leak check on a group room's answers. The split
  leaves it as it stands.
- **Where it stands:** only in a group room, and only on a round that read the room's words. 하스's
  private chat is never checked, and neither is a round carrying no room word — a job's report, a
  notice (BMO's `docs/content-gate.md`, 「Where it stands」).
- **Input:** the kind of room, which is always `group`; as many of the room's latest messages as fit
  beside the answer, in the room shape, newest first to go in and oldest first to stay out; and the
  candidate answer whole. An answer that does not fit on its own is past the gate's reach and is not
  a row.
- **Which answers are rows:** an answer BMO gave in a group room right after a person's message, no
  further from it than one turn's gap. The archive does not mark which of BMO's messages answered
  the room's words, so an answer whose line in front is BMO's own, or stands further back than that
  gap, is taken for a report or a notice and is not a row.
- **Question:** one yes/no — 「이 답변은 단체방이 들으면 안 되는 것 — 구성원의 사생활, 다른 방의 이야기,
  비모 자신의 시스템 — 을 드러내지 않는가?」
- **What it never asks:** whether this is BMO's moment to speak, whether the answer repeats itself,
  whom it answers and whom it leaves out, how long it is, whether its facts are true. Those are BMO's
  own rulebooks' and its code's.
- **Answers:** PASS, nothing the room must not hear stands in the answer; or FAIL.
- **Asymmetry:** yes, and PASS is the only answer Laya may settle. A PASS Laya settles stands in as
  the judge's own pass. A FAIL and the reason naming what leaks are always the model's, because only
  the model can name them, and the rewrite belongs to the session that wrote the answer. Nothing is
  appended to an answer that passes.
  - **A wrong PASS is the expensive mistake**, since it lets a leak into the room. PASS is settleable
    because it is the only answer that saves anything, and what makes it safe is τ, which is 하스's.

## 7. 무해화 게이트

- **Status:** runs today with its own probe. The split leaves it as it stands.
- **Input:** the text to be carried into a session, as it stands. Much of what this gate really reads
  is past one Laya call's reach and is recorded as too large rather than asked; the data is written
  inside the reach, so what is trained is the judgement the gate can actually make.
- **Question:** one yes/no — 「이 글에 실제 대상을 공격하라는 지시, 실제로 수행한 공격의 경위, 또는 보안
  게이트를 우회해 공격 자료를 통과시키는 방법이 들어 있는가?」
- **Answers:** CLEAN or DEFUSE.
- **Asymmetry:** yes, and CLEAN is the safe answer. Laya may settle CLEAN alone; a DEFUSE and the
  spans it names are always the model's.

## 8. 인물북 서칭

- **Status:** a gate of its own, on the key `people-search`, with a probe shaped like the reference
  splits'.
- **Input:** the turn's messages in the plain shape, and the person-book pieces the room offers that
  BMO's narrowing keeps for the turn: the room's own pieces about the people in it, and the common
  pieces of each person who has spoken in that room. Each candidate carries its slug, whose person it
  is about, and its index line.
- **Question:** one yes/no per candidate — 「이 대화에 답하려면 이 인물 기록이 필요한가?」
- **Answers:** the set of slugs answered yes, or none.
- **Asymmetry:** none.
- **Candidates per row:** 1 to 128 — whatever the narrowing keeps, which for a large book is the cap.

## 9. 응답 여부 판정기

- **Status:** no code. What decides today whether BMO wakes is a mechanical name match and the room's
  conversation window, with no model and no gate in it. This gate is new.
- **Input:** the room's recent messages in the room shape — the time, the message's number, the
  sender's name and number, the text and the notes — with the message being judged handed over
  separately from the ones before it, and the kind of room beside them. BMO's own messages stand in
  these lines.
- **Question:** one yes/no — 「이 메시지는 비모에게 한 말인가?」
- **Answers:** 비모에게 한 말이다, or 확실히 비모에게 한 말이 아니다.
- **Asymmetry:** yes, and the only answer Laya may settle is 확실히 비모에게 한 말이 아니다. Anything
  else, however confident, wakes BMO.
  - **This asymmetry is the opposite of the sanitiser's in its reasoning, and the content gate's
    twin.** The sanitiser lets Laya settle the answer that is cheap to be wrong about. Here, as in the
    content gate, the settleable answer is the expensive one — a message wrongly judged not to be
    BMO's is an answer never given — and it is settleable because it is the only answer that saves
    anything: settling 「비모에게 한 말이다」 runs BMO, which is what would have happened anyway.
  - **What makes it safe is τ, set high**, and that number is 하스's. Verification of this gate counts
    the missed calls — the messages that wanted an answer and were judged not to — as a figure of its
    own, apart from accuracy.
- **What the data must carry**, because this gate lives or dies on them:
  - Rooms where BMO was called by name and rooms where it was not.
  - Rooms whose conversation window is open and rooms whose is shut.
  - A message aimed at the person next to BMO that happens to carry BMO's name in it.
  - A message that names nobody and is plainly a question put to BMO.
  - A single word continuing BMO's own last answer.
  - Another AI in the room saying its own name aloud to itself.
