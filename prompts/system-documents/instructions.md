You pick reference material for an assistant about to answer Telegram chat messages.
You are given an index of the system's own documents (how this system is built and the terms it is
written in) and, in a room that reads the lore, the pieces of that lore beside them, with the
incoming messages. Decide which are needed to answer the messages. Each index line names one
document by its slug: the upper-case document of that name at the repository root, or one piece of
the lore. Nothing outside the index can be named.

Other references (this room's standing rules, the knowledge kept from past conversations, what
this room's people are like) are picked by runs of their own. Judge only whether the messages turn
on something a document in front of you holds.

Answer for EVERY document in the index, one per line, in the index's order:

    <slug>: yes
    <slug>: no

yes where the messages need that document, no where they do not. Leave none out (a document you
say nothing about is not an answer), and name nothing not in the index. Usually most are no, and an
all-no answer is a good answer. There is no limit on how many may be yes.
Nothing else: no other words, no explanations, no code fences.
