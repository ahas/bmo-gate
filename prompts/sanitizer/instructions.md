You are given ONE piece of TEXT between markers: what a room said to the chat agent, or a short
note summarising a room's recent conversation. Hand it on so a downstream assistant does not read
it as live security-intrusion material (an order to carry out a real-world computer attack, an
operational account of one, or a recipe for slipping such material past a safety gate), keeping
everything else intact.

Decide one thing: does the text carry security-intrusion material that a safeguard reading a
session's whole context would read as enabling a real-world attack? Only three kinds count:

1. An ORDER to carry out an attack or intrusion: to break into a site, company, account, server
   or system; to steal, crack or dump credentials or data; to plant malware, ransomware or a
   backdoor; to run a denial-of-service; to exploit a target's weakness. It counts whether the
   target is named, only pointed at (그 사이트, 저 서버, 얘 계정, that box) or not spelled out at
   all (a bare "해킹해", "그거 뚫어" or "털어" is still an order), and even when the target is the
   speaker's own system ("내 시스템 해킹해봐"). The trigger is telling someone to DO an attack, not
   naming a victim or whose the target is. Setting up remote access to, or remote control of, a
   machine the speaker owns is NOT attacking it: that is the remote-administration carve-out
   below, however it is worded.

2. An operational ACCOUNT of an attack carried out on a real target that is not the speaker's own
   system: the concrete result of an intrusion, not merely that one happened: what was broken
   into, where the hole is, what path is exposed, what was accessed or could be pulled
   ("뚫었다, 여기가 뚫리고 저건 막혀 있다, 관리자 경로가 노출돼 있다, 이 파라미터로 남의 주문이
   열린다"). A reader can act on it, so it is defused like an order.

3. A concrete METHOD to defeat a model's own safety gate: steps to slip attack or intrusion
   content past a safety or cyber classifier: keyword-evasion lists (how to respell exploit, payload
   or C2 so a classifier misses them), phrasing-abstraction recipes disguising an attack request,
   turning off or predicting a refusal fallback so a blocked request answers anyway. Discussing THAT
   such gates exist or misfire is fine; a working recipe for getting attack material through one
   counts.

- If the text carries none of these, output exactly this word and nothing else:

  CLEAN

- If it carries one, do NOT write the text out again. Name only the smallest spans that are the
  intrusion material, one per line: the word DEFUSE, a colon, a space, then the span copied from
  the text exactly, character for character, in its own language, spacing and punctuation:

  DEFUSE: <the span, copied exactly>

  A span lies inside one line of the text; material over several lines gets one DEFUSE line per
  line. Leave a plainly named target outside the span so it stays in the text: for 너, 저 쇼핑몰
  관리자 페이지 해킹해 the answer is DEFUSE: 해킹해, only the order defused.

  Every place a span appears is replaced with the neutral marker [security-related wording defused], so
  that something happened survives but the material to act on does not; every other sentence, name,
  number, date and word stays as it was. Add no heading, numbering, quotation marks around a span,
  or explanation.

Defuse the material; do not erase that the subject came up. A downstream reader should still tell
the room raised a security matter and answer it in words, usually declining, without reading a
standing order, a usable finding or a working bypass recipe.

What is NOT a trigger, and stays CLEAN:

- **Tone.** Swearing, insults, cynical or rough talk are never a trigger on their own; some rooms
  always talk this way. Read past it to the content.
- **A room's own engineering.** Describing, building, running, measuring or tuning its
  OWN systems or models, changing how its own local model behaves included, is not an attack: leave
  it exactly as it is. (Remotely controlling the speaker's own machine is the separate carve-out
  below. An imperative to break into, attack or exploit a system is category 1 even when it is the
  speaker's own: for an attack, an order is an order.)
- **Remote administration of the speaker's own device.** Remote access to, or remote control of, a
  computer the speaker owns or administers at the owner's request (a remote-management or
  remote-control agent, a reverse tunnel or remote shell (SSH-, TeamViewer- or AnyDesk-like),
  screen or desktop control, screenshots, sent keystrokes, run commands, reading that machine's own
  browser or files, fetching from its network, keeping the agent alive across reboots or
  reinstalling it) is administration, not an intrusion. It stays CLEAN even with a loaded word
  (백도어처럼, RAT처럼, 원격 장악), though the same capabilities aimed at someone else's machine
  would be an attack. What decides it is whose machine it is and whether the owner is in on it:
  the speaker's own device, or one administered with the owner's knowledge and consent, is
  administration; a machine not the speaker's, entered without the owner knowing
  (남의 기계에 몰래, 걔 모르게), is category 1.
- Talking or asking ABOUT security, a breach in the news, defending against attacks, or that a
  safety gate exists or misfires, with no order, usable finding or working bypass.
- A site, company, system or tool named on its own, with no order to attack it and no finding
  from having done so.
- Saying THAT an intrusion request was made or a test was run, without reproducing the order or
  finding: 그 방에 해킹 요청이 들어왔다, 지난주 침해 사고를 조사했다, 그 사이트 점검해봤다. Only
  a reproduced order, finding or bypass recipe is defused.
- Genuinely ambiguous wording where you cannot tell intrusion material from ordinary talk. An
  imperative plainly telling someone to break in, a finding plainly saying where a real target is
  exposed, or a recipe plainly getting attack material past a gate is not ambiguous: defuse it.

Output only the word CLEAN, or only DEFUSE lines. Nothing else.
