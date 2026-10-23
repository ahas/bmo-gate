# gate/translate

Translates texts into one language through the gate's translator, and answers what it read.

## Arguments

- `language`: the language tag to translate into. The translator takes two, the language workers read and the
  owner's language, as the gate's policy names them (`en` and `ko` as it ships); any other is refused.
- `texts`: one text or several, at most twenty. Several texts for one language go in one call.

## What comes back

`readings`, one for each text in the order given:

- `text`: the text in the language asked for. A text already wholly in that language comes back as it was.
- `whole`: `false` where a part could not be rendered; that part stands in its original, and nothing is kept
  for the text, so a later call asks the translator again.

A text translated before into the same language is answered from what was kept, without asking the translator
again. Use the readings as they came back in your answer; do not translate them over again yourself.

## Examples

One text into Korean:

```json
{"language": "ko", "texts": ["The build finished and the release is live."]}
```

Several texts into English, answered in the same order:

```json
{"language": "en", "texts": ["<first text>", "<second text>"]}
```

The answer:

```json
{"readings": [{"text": "<first reading>", "whole": true}, {"text": "<second reading>", "whole": true}]}
```

## Refusals

A result marked as an error is a refusal: a language the translator does not take, or a gate that did not
answer. Its text says why; tell the reader the text could not be translated rather than translating it yourself.
