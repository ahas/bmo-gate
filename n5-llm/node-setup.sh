#!/usr/bin/env bash
# The text model's environment on a training node, stood up from what is already there
# (docs/n5-llm.md). The same setup runs on n2 to n5, since the nodes carry the same card; the model,
# the engine commit and the CUDA architecture are one for all of them. It is run detached with its
# output in setup.log, because building llama.cpp and fetching the model take longer than the hub
# holds a streamed command open, and it says `N5-LLM-SETUP-DONE ok` or `N5-LLM-SETUP-DONE
# failed:<step>` on its last line, which is what the caller waits for.
#
# It is idempotent: what is already right is left alone and said so. It installs into the account
# alone — no sudo and nothing written to the account's shell profile. The memlock limit it checks is
# raised by hand (docs/n5-llm.md, 「The memlock limit」).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin"
VENV_PYTHON="3.12"
UV_INSTALLER="https://astral.sh/uv/install.sh"

# The engine: upstream llama.cpp at a commit that reads the model's qwen35 tensors and its MTP head,
# with the patch that computes the attention over a KV store in host memory on the card, a prompt's
# batches and an answer's tokens alike, while the card has room for the store and on the CPU otherwise,
# and keeps the recurrent state on the card.
# The stamp beside the build names the commit and the patch it was built from.
LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"
LLAMA_COMMIT="2a53ace3be21b1231d42019a278f14aebc65d49c"
LLAMA_DIR="$here/build/llama.cpp"
LLAMA_PATCH="$here/llama-nkvo.patch"
LLAMA_STAMP="$LLAMA_DIR/build/n5-llm-build"
CUDA_BIN="/usr/local/cuda/bin"

# The model, fetched in ranges at once since one connection from this network is slow, and given its
# name only once its hash is the repository's.
MODEL_URL="https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/resolve/main"
MODEL_FILE="RVN-IQ3_XXS-multilingual-mtp.gguf"
MODEL_BYTES=11637691872
MODEL_SHA256="338955bd8d67908afb4093b8a7b386dcfcd6eb6184a2171e5d6731c1d296abf6"
RANGES=16

step() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf 'N5-LLM-SETUP-DONE failed:%s\n' "$1"; exit 1; }

cd "$here" || fail cd

if command -v uv >/dev/null 2>&1; then
  step "uv already here: $(uv --version)"
else
  step "installing uv into the account"
  curl -LsSf "$UV_INSTALLER" | env UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 || fail uv-install
  command -v uv >/dev/null 2>&1 || fail uv-missing-after-install
fi

if [ -x "$here/.venv/bin/python" ]; then
  step "venv already here: $("$here/.venv/bin/python" -V 2>&1)"
else
  step "making the venv on python $VENV_PYTHON"
  uv venv --managed-python --python "$VENV_PYTHON" "$here/.venv" || fail venv
fi
step "installing what pyproject pins"
VIRTUAL_ENV="$here/.venv" uv pip install -r "$here/pyproject.toml" || fail install

[ -f "$LLAMA_PATCH" ] || fail engine-patch-missing
wanted="$LLAMA_COMMIT $(sha256sum "$LLAMA_PATCH" | cut -d' ' -f1)"
if [ "$(cat "$LLAMA_STAMP" 2>/dev/null)" = "$wanted" ] && [ -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  step "llama.cpp already built at $LLAMA_COMMIT with its patch"
else
  step "building llama.cpp at $LLAMA_COMMIT with its patch"
  # cmake and ninja on the account's PATH and nvcc in the CUDA path are host packages installed by
  # hand, like the memlock limit (docs/n5-llm.md). Checked here so a node without them says which is
  # missing rather than failing at the first command that needs it.
  command -v cmake >/dev/null 2>&1 || fail cmake-missing
  command -v ninja >/dev/null 2>&1 || fail ninja-missing
  { [ -x "$CUDA_BIN/nvcc" ] || command -v nvcc >/dev/null 2>&1; } || fail nvcc-missing
  mkdir -p "$LLAMA_DIR" || fail engine-dir
  git -C "$LLAMA_DIR" init -q || fail engine-git
  if [ "$(git -C "$LLAMA_DIR" rev-parse HEAD 2>/dev/null)" != "$LLAMA_COMMIT" ]; then
    git -C "$LLAMA_DIR" fetch -q --depth 1 "$LLAMA_REPO" "$LLAMA_COMMIT" || fail engine-fetch
  fi
  # A forced checkout drops whatever patch the tree carried before, so the one applied is this one.
  git -C "$LLAMA_DIR" checkout -q --force "$LLAMA_COMMIT" || fail engine-checkout
  git -C "$LLAMA_DIR" apply "$LLAMA_PATCH" || fail engine-patch
  rm -f "$LLAMA_STAMP"
  PATH="$CUDA_BIN:$PATH" cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" -G Ninja -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES=89 -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF || fail engine-configure
  PATH="$CUDA_BIN:$PATH" cmake --build "$LLAMA_DIR/build" --target llama-server -j "$(nproc)" || fail engine-build
  printf '%s\n' "$wanted" > "$LLAMA_STAMP" || fail engine-stamp
fi

fetch_range() {
  local i=$1 part=$2 out=$3 first last want have
  first=$(( i * part )); last=$(( (i + 1) * part - 1 ))
  [ "$last" -ge "$MODEL_BYTES" ] && last=$(( MODEL_BYTES - 1 ))
  want=$(( last - first + 1 ))
  for _ in $(seq 1 30); do
    have=$(stat -c %s "$out" 2>/dev/null || echo 0)
    [ "$have" -ge "$want" ] && return 0
    curl -sS -L --fail -r "$(( first + have ))-$last" "$MODEL_URL/$MODEL_FILE" >> "$out" || sleep 5
  done
  return 1
}

model="$here/models/$MODEL_FILE"
if [ -f "$model" ]; then
  step "model already here: $MODEL_FILE"
else
  step "fetching $MODEL_FILE in $RANGES ranges"
  mkdir -p "$model.ranges" || fail model-dir
  part=$(( (MODEL_BYTES + RANGES - 1) / RANGES ))
  for i in $(seq 0 $(( RANGES - 1 ))); do fetch_range "$i" "$part" "$model.ranges/$i" & done
  wait
  for i in $(seq 0 $(( RANGES - 1 ))); do cat "$model.ranges/$i"; done > "$model.part" || fail model-join
  [ "$(stat -c %s "$model.part")" = "$MODEL_BYTES" ] || fail model-size
  [ "$(sha256sum "$model.part" | cut -d' ' -f1)" = "$MODEL_SHA256" ] || fail model-hash
  mv "$model.part" "$model" && rm -rf "$model.ranges" || fail model-name
fi

# The front locks the whole model, and a unit cannot lock more than the user manager's own hard limit.
manager="$(pgrep -u "$(id -u)" -x systemd | head -n 1)"
limit="$(awk '/^Max locked memory/ { print $5 }' "/proc/$manager/limits" 2>/dev/null)"
if [ "$limit" != "unlimited" ] && { [ -z "$limit" ] || [ "$limit" -lt "$MODEL_BYTES" ]; }; then
  step "the user manager may lock ${limit:-an unknown number of} bytes, less than the model's $MODEL_BYTES"
  fail memlock
fi
step "the user manager may lock $limit bytes"

printf 'N5-LLM-SETUP-DONE ok\n'
