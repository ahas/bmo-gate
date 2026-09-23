#!/usr/bin/env bash
# The house LLM service's environment on n6, stood up from what is already there (docs/llm-server.md).
# It is run detached with its output in setup.log, because installing vLLM and downloading the model
# take longer than the hub holds a streamed command open, and it says `LLM-SETUP-DONE ok` or
# `LLM-SETUP-DONE failed:<step>` on its last line, which is what the caller waits for.
#
# It is idempotent: what is already right is left alone and said so. It installs into the account
# alone — no sudo, no system package, and nothing written to the account's shell profile.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin"
# uv's managed interpreter, rather than the system python, so the venv carries its own headers.
VENV_PYTHON="3.12"
UV_INSTALLER="https://astral.sh/uv/install.sh"
export HF_HOME="$here/hf"

step() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf 'LLM-SETUP-DONE failed:%s\n' "$1"; exit 1; }

cd "$here" || fail cd

# The model is the one the vLLM unit serves, read out of that unit so the two cannot name different ones.
model="$(sed -n 's/^ExecStart=.* serve \([^ ]*\) .*/\1/p' "$here/bmo-llm-vllm.service")"
[ -n "$model" ] || fail model-name

if command -v uv >/dev/null 2>&1; then
  step "uv already here: $(uv --version)"
else
  step "installing uv into the account"
  curl -LsSf "$UV_INSTALLER" | env UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 || fail uv-install
  command -v uv >/dev/null 2>&1 || fail uv-missing-after-install
  step "uv installed: $(uv --version)"
fi

# A venv standing on the system python is not the venv this script makes. It is made again on uv's own.
if [ -x "$here/.venv/bin/python" ]; then
  base="$("$here/.venv/bin/python" -c 'import sys; print(sys.base_prefix)' 2>/dev/null || true)"
  case "$base" in
    "$(uv python dir)"/*) ;;
    *)
      step "venv stands on $base, not on uv's own python: making it again"
      rm -rf "${here:?}/.venv"
      ;;
  esac
fi

if [ -x "$here/.venv/bin/python" ]; then
  step "venv already here: $("$here/.venv/bin/python" -V 2>&1)"
else
  step "making the venv on python $VENV_PYTHON"
  uv venv --managed-python --python "$VENV_PYTHON" "$here/.venv" || fail venv
fi

step "installing what pyproject pins"
VIRTUAL_ENV="$here/.venv" uv pip install -r "$here/pyproject.toml" || fail install

step "downloading $model into $HF_HOME"
"$here/.venv/bin/python" - "$model" <<'PY' || fail model-download
import sys
from huggingface_hub import snapshot_download

print(snapshot_download(sys.argv[1]))
PY

step "what stands now"
"$here/.venv/bin/python" - <<'PY' || true
import importlib.metadata as meta
for name in ("vllm", "torch", "mcp", "starlette", "uvicorn", "httpx", "websockets"):
    try:
        print(f"  {name} {meta.version(name)}")
    except Exception:
        print(f"  {name} none")
PY

printf 'LLM-SETUP-DONE ok\n'
