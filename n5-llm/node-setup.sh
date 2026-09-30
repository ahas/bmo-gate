#!/usr/bin/env bash
# The n5 text model's environment, stood up from what is already there (docs/n5-llm.md). It is run
# detached with its output in setup.log, because building llama.cpp and fetching the model take longer
# than the hub holds a streamed command open, and it says `N5-LLM-SETUP-DONE ok` or
# `N5-LLM-SETUP-DONE failed:<step>` on its last line, which is what the caller waits for.
#
# It is idempotent: what is already right is left alone and said so. It installs into the account
# alone — no sudo and nothing written to the account's shell profile. The memlock limit it checks is
# raised by hand (docs/n5-llm.md, 「The memlock limit」).
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin"
VENV_PYTHON="3.12"
UV_INSTALLER="https://astral.sh/uv/install.sh"

# The engine: upstream llama.cpp at a commit that reads the model's qwen35 tensors and its MTP head.
LLAMA_REPO="https://github.com/ggml-org/llama.cpp.git"
LLAMA_COMMIT="2a53ace3be21b1231d42019a278f14aebc65d49c"
LLAMA_DIR="$here/build/llama.cpp"
CUDA_BIN="/usr/local/cuda/bin"

# The model, fetched in ranges at once since one connection from this network is slow, and given its
# name only once its hash is the repository's.
MODEL_URL="https://huggingface.co/0bserverx/Qwen3.8-27B-Heretic-Abliterated-Uncensored-GGUF/resolve/main"
MODEL_FILE="RVN-IQ2_XS-multilingual-mtp.gguf"
MODEL_BYTES=9541912032
MODEL_SHA256="4ecdd5d7192cc146078baf601d085eed25acbd6784d9313ad3f955594217cf13"
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

standing="$(git -C "$LLAMA_DIR" rev-parse HEAD 2>/dev/null || true)"
if [ "$standing" = "$LLAMA_COMMIT" ] && [ -x "$LLAMA_DIR/build/bin/llama-server" ]; then
  step "llama.cpp already built at $LLAMA_COMMIT"
else
  step "building llama.cpp at $LLAMA_COMMIT"
  mkdir -p "$LLAMA_DIR" || fail engine-dir
  git -C "$LLAMA_DIR" init -q || fail engine-git
  git -C "$LLAMA_DIR" fetch -q --depth 1 "$LLAMA_REPO" "$LLAMA_COMMIT" || fail engine-fetch
  git -C "$LLAMA_DIR" checkout -q --force FETCH_HEAD || fail engine-checkout
  PATH="$CUDA_BIN:$PATH" cmake -S "$LLAMA_DIR" -B "$LLAMA_DIR/build" -G Ninja -DGGML_CUDA=ON \
    -DCMAKE_CUDA_ARCHITECTURES=89 -DCMAKE_BUILD_TYPE=Release -DLLAMA_CURL=OFF -DLLAMA_BUILD_TESTS=OFF || fail engine-configure
  PATH="$CUDA_BIN:$PATH" cmake --build "$LLAMA_DIR/build" --target llama-server -j "$(nproc)" || fail engine-build
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
