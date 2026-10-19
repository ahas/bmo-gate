# The gate's codes

Every refusal the gate answers carries one of these codes beside an English sentence (`docs/boundary-api.md`,
「Wire conventions」). A caller decides on the code and never on the sentence. In the brain's family the same
codes are written in kebab-case.

## Every route

| Code | Status | When |
|---|---|---|
| `body_not_json` | 400 | the body is not JSON |
| `field_wrong` | 400 | a field of the body or the query is missing or not of the form it takes; the sentence names it |
| `unauthorized` | 401 | the token is missing or wrong |
| `route_absent` | 404 | no route answers the method and path |
| `not_ready` | 503 | the service is up but its database or its settings do not stand yet |
| `database` | 500 | the gate's database failed |
| `failed` | 500 | the gate failed while answering |
| `unit_failed` | 502 | a call the route needed on another unit failed; the sentence names the unit |

## Gate runs

| Code | Status | When |
|---|---|---|
| `stopped` | 409 | the run the request asked for was stopped by somebody |
| `no_gate` | 404 | the stage named is no gate of the gate order |
| `no_answer` | 502 | the gate's road gave no answer where the route needs one |

## Gate options

| Code | Status | When |
|---|---|---|
| `nothing_to_change` | 400 | a change names no field |
| `own_llm` | 400 | a change names thinking or the answer size, which are the gate's tier's |
| `timeout_out_of_range` | 400 | a wait outside one second to five minutes |
| `switch_not_boolean` | 400 | a switch sent as anything but true or false |
| `always_on` | 409 | a switch for a gate whose profile lets it not be switched off |
| `laya_mode_unknown` | 400 | a Laya mode that is none of `off`, `shadow`, `filter`, `asymmetric` |
| `laya_mode_refused` | 409 | a Laya mode the gate cannot run in; the refusal's own code is beside it |
| `laya_tau_out_of_range` | 400 | a τ outside the grid the gate's agreement is counted at |
| `laya_fallback_unknown` | 400 | a fallback LLM that is neither `none` nor a provider |

## Laya modes a gate may be refused

| Code | When |
|---|---|
| `no_probe` | the gate declares no Laya probe |
| `no_safe_verdict` | an asymmetric mode for a gate whose probe names no safe verdict |
| `no_checkpoint` | the Laya server named no checkpoint for the gate in its latest health check |
| `needs_tau` | a deciding mode with no τ to stand on |

## Documents and trials

| Code | Status | When |
|---|---|---|
| `document_unknown` | 400 | a document name that is no root and path |
| `language_unknown` | 400 | a target language the translator does not take |
| `prompt_too_long` | 400 | a trial's prompt past the length a turn takes |
