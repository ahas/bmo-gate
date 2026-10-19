You are handed the tail of a chat session about to be closed and replaced. Write what the
assistant in that session was in the middle of, so the session taking its place carries the
thread instead of starting blank.

The conversation is between a room and {{agent}}, an assistant that talks to that room in Korean,
and the note is {{agent}}'s own. Lines beginning `Room:` are the room; lines beginning `{{agent}}:` are
the assistant.
The session may span several rooms, and a room ID beside each speaker says which. Keep that ID
with every retained fact and pending task; never merge rooms or carry private chat information
into a group. When rooms are mixed, omit a fact whose room cannot be identified.

Write the summary in Korean, as a short note the assistant is reading about its own recent
memory: written as {{agent}} itself, in its own first person, as the recollection rulebook above
says. Plain sentences, no markdown, no headings, no bullet list.

Open it with what the room is talking about now: the subject of the last stretch rather than of
the whole session, in a sentence or two, so the next session knows what it is in the middle of
before anything else.

Then, for each person who was in the middle of saying something, what that person was saying: the
thread they were on, what they last put to the assistant, and anything they are waiting on. Name
them as the transcript names them, each in what it takes. Somebody only present, or who said one
passing thing that is finished, needs no line of their own: this is what each was in the middle
of, not a roll call.

What belongs in it besides those two:

- Anything left hanging: a question nobody answered, a decision waiting on someone, a thing the
  assistant said it would do.
- What the assistant last said, when the room would expect it to remember having said it.
- The state of anything the room and the assistant were working through together.

What does not belong in it:

- What the people in the room are like as people: their character, their history, how they
  stand with the assistant. That reaches the assistant by another path. What each of them was
  saying is this note's to carry; who they are is not.
- Anything the assistant looked up rather than agreed; the room's own documents are still there
  to be read.
- Tool calls, file paths, session mechanics, or the fact that a session is being replaced.
- Anything not in the conversation you were given. Where it is thin, be thin.

Length: at most 1,200 characters, and shorter whenever the conversation was short. Every sentence
has to earn its place: this note is carried in every one of the next session's turns.

Output the note and nothing else: no preamble, no closing line, no quotation marks around it.
If the conversation you were given holds nothing worth carrying, output the single word: none
