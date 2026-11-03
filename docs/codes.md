# The gate's codes

Every refusal the gate answers carries one of these codes beside one English sentence (`docs/api.md`,
「Common rules」). A caller decides on the code and never on the sentence. Codes are kebab-case, in step with
the camelCase keys.

## Every route

| Code | Status | When |
|---|---|---|
| `bad-request` | 400 | the body or the query is not the shape the route takes; the sentence names what is wrong |
| `unauthorized` | 401 | the token is missing or wrong |
| `no-route` | 404 | no route answers the method and path |
| `not-found` | 404 | the route is right, but nothing stands at the key the path names |
| `conflict` | 409 | the request conflicts with what stands |
| `too-large` | 413 | the body is over the route's ceiling |
| `failed` | 500 | the gate failed while answering, its database among it |
| `upstream-failed` | 502 | a call the route needed on another unit failed; the sentence names it |
| `not-ready` | 503 | the service is up but cannot answer yet |

## Gate runs

| Code | Status | When |
|---|---|---|
| `stopped` | 409 | the run the request asked for was stopped by somebody |
| `no-gate` | 404 | the gate named is none of the gate order |

## Gate options

| Code | Status | When |
|---|---|---|
| `nothing-to-change` | 400 | a change names no field |
| `own-llm` | 422 | a change names thinking or the answer size, which are the gate's role's |
| `switch-not-boolean` | 422 | a switch sent as anything but true or false |
| `always-on` | 422 | a switch for a gate whose profile lets it not be switched off |

## Documents and translations

| Code | Status | When |
|---|---|---|
| `document-unknown` | 422 | a document name that is no root and path |
| `language-unknown` | 422 | a language the translator does not take: for a translation neither the worker's nor the owner's, for a document's translation one the policy names no language for (`docs/api.md`, 「Translations」 and 「Documents」) |
| `too-many-originals` | 400 | a translation names more originals than one call carries (`docs/api.md`, 「Translations」) |
