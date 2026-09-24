#!/usr/bin/env bash
# The training environment on one node, stood up from what is already there (docs/training.md,
# 「The nodes」). It is run detached with its output in setup.log, because
# installing torch takes longer than the hub holds a streamed command open, and it says
# `LAYA-SETUP-DONE ok` or `LAYA-SETUP-DONE failed:<step>` on its last line, which is what the caller
# waits for.
#
# It is idempotent: what is already right is left alone and said so. It installs into the account
# alone — no sudo, no system package, and nothing written to the account's shell profile. CUDA goes on
# the PATH of this run and of a training run, not of the account.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin:/usr/local/cuda/bin"
# uv's managed interpreter, rather than the system python, so every node's venv is the same one.
VENV_PYTHON="3.12"
UV_INSTALLER="https://astral.sh/uv/install.sh"

step() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf 'LAYA-SETUP-DONE failed:%s\n' "$1"; exit 1; }

cd "$here" || fail cd

if command -v uv >/dev/null 2>&1; then
  step "uv already here: $(uv --version)"
else
  step "installing uv into the account"
  curl -LsSf "$UV_INSTALLER" | sh >/dev/null 2>&1 || fail uv-install
  export PATH="$PATH:$HOME/.local/bin"
  command -v uv >/dev/null 2>&1 || fail uv-missing-after-install
  step "uv installed: $(uv --version)"
fi

# A venv standing on the system python is not the venv this script makes: it compiles against the
# system's headers, which one node carries and the next does not. It is made again on uv's own.
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

step "what stands now"
"$here/.venv/bin/python" - <<'PY' || true
import importlib.metadata as meta
for name in ("laya", "torch", "transformers", "safetensors"):
    try:
        print(f"  {name} {meta.version(name)}")
    except Exception:
        print(f"  {name} none")
PY

printf 'LAYA-SETUP-DONE ok\n'
