#!/usr/bin/env bash
# A GGUF model's node made ready for its engine (docs/gguf-llm.md in the gate's repository): what the units
# run is checked to stand, and the model file is fetched where it is missing and checked against its size
# and SHA-256. It is run detached with its output in setup.log, since a fetch takes longer than a hub
# holds a streamed command open, and it says `GGUF-LLM-SETUP-DONE ok` or `GGUF-LLM-SETUP-DONE failed:<step>`
# on its last line, which is what the installer waits for.
#
# It is idempotent: a file whose size and recorded hash already match is left alone. It installs into the
# account alone, with no sudo and nothing written to the account's shell profile.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

step() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf 'GGUF-LLM-SETUP-DONE failed:%s\n' "$1"; exit 1; }

cd "$here" || fail cd
# MODEL_FILE, MODEL_BYTES, MODEL_SHA256, MODEL_SOURCE, LLAMA_SERVER, DIAL_PYTHON and DIAL_SCRIPT, the
# paths under the account's home, as the installer wrote them.
# shellcheck source=/dev/null
. "$here/setup.env" || fail settings

[ -x "$HOME/$LLAMA_SERVER" ] || fail llama-server
[ -x "$HOME/$DIAL_PYTHON" ] || fail dial-python
[ -f "$HOME/$DIAL_SCRIPT" ] || fail dial-script
"$HOME/$DIAL_PYTHON" -c 'import websockets' >/dev/null 2>&1 || fail dial-websockets
step "the engine and the tunnel's dial stand"

mkdir -p "$here/models" || fail models
model="$here/models/$MODEL_FILE"
recorded="$model.sha256"
size() { stat -c %s "$1" 2>/dev/null || echo 0; }

if [ "$(size "$model")" = "$MODEL_BYTES" ] && [ "$(cut -d' ' -f1 "$recorded" 2>/dev/null)" = "$MODEL_SHA256" ]; then
  step "$MODEL_FILE stands, checked already"
  printf 'GGUF-LLM-SETUP-DONE ok\n'
  exit 0
fi

if [ "$(size "$model")" != "$MODEL_BYTES" ]; then
  [ -n "$MODEL_SOURCE" ] || fail no-source
  part="$model.part"
  if [ "$(size "$part")" != "$MODEL_BYTES" ]; then
    step "fetching $MODEL_FILE"
    curl -L --fail --silent --show-error --retry 5 --retry-delay 10 -C - -o "$part" "$MODEL_SOURCE" || fail fetch
  fi
  [ "$(size "$part")" = "$MODEL_BYTES" ] || fail size
  mv "$part" "$model" || fail place
fi

step "checking $MODEL_FILE"
hash="$(sha256sum "$model" | cut -d' ' -f1)"
if [ "$hash" != "$MODEL_SHA256" ]; then
  mv "$model" "$model.mismatch"
  fail sha256
fi
(cd "$here/models" && sha256sum "$MODEL_FILE" > "$MODEL_FILE.sha256") || fail record
step "$MODEL_FILE checked"

printf 'GGUF-LLM-SETUP-DONE ok\n'
