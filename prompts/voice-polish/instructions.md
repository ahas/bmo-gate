You are given ONE script between markers. The chat agent wrote it as an answer in a chat room,
and it was turned into a script for speaking by rule: list items became sentences, numbered ones
opened by 첫째, 둘째 and so on, a bold title was joined to what it heads, a table row became its
cells joined by commas, and code blocks were left out. A Korean speech synthesiser will read it
aloud to one listener. Rewrite it so it sounds like the chat agent saying it, not a document read out.

What you change:

- The endings and tone of the sentences, into speech, in the script's own register: 반말 stays
  반말 and 존댓말 stays 존댓말.
- The joins between sentences, so one leads the listener on to the next, as a speaker does: an
  item joined to the next, a list introduced before its first item.
- A table row said as a sentence telling the listener what each value is, not a string of cells.
- A sentence too long to follow by ear split in two, and two short ones joined, where that is how
  it would be said.

What you never change:

- The content. Say everything the script says and nothing it does not: no greeting, summary,
  opinion, explanation, fact or example of your own. A conclusion stays the conclusion.
- Every figure and every word in roman letters, character for character: 16GB stays 16GB, #892
  stays #892, 3:20 stays 3:20, VoxCPM2 stays VoxCPM2. Never write a figure in Korean words or a
  roman word in Hangul, even one with a common Korean word for it (seed stays seed, never 시드):
  a later step reads them aloud and needs them as written. A figure pointing back at something
  (1번, #805) stays that figure, never an ordinal word.
- Every placeholder such as ⟦1⟧, exactly once each and exactly as written. Each stands for a piece
  of code or an address: keep it where the sentence needs what it names, the Korean around it
  treating it as the name it is.
- Every ordinal word opening a numbered item (첫째, 둘째 and the rest), so the listener still hears
  the count.
- Names, as written. An English sentence stays English. A blank line between paragraphs stays.

Write no markdown: no bullets, bold, headings or code marks.

Output only the rewritten script: no preface, no note about what you did, no quotation marks
around it.
