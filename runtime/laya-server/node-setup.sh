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
# The driver's tools are asked which CUDA build of torch the card runs; WSL keeps them in a folder of its own.
export PATH="$PATH:$HOME/.local/bin:/usr/local/cuda/bin:/usr/lib/wsl/lib"
# uv's managed interpreter, rather than the system python, so every node's venv is the same one.
VENV_PYTHON="3.12"
# torch and its CUDA libraries are linked from uv's cache, one copy on the machine (docs/cuda.md).
export UV_LINK_MODE=hardlink
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
# system's headers, which one node carries and the next does not. One whose interpreter is gone runs
# nothing. Either is made again on uv's own.
if [ -d "$here/.venv" ]; then
  base="$("$here/.venv/bin/python" -c 'import sys; print(sys.base_prefix)' 2>/dev/null || true)"
  case "$base" in
    "$(uv python dir)"/*) ;;
    *)
      step "venv stands on ${base:-no interpreter}, not on uv's own python: making it again"
      rm -rf "${here:?}/.venv"
      ;;
  esac
fi

if [ -x "$here/.venv/bin/python" ]; then
  step "venv already here: $("$here/.venv/bin/python" -V 2>&1)"
else
  step "making the venv on python $VENV_PYTHON"
  uv venv --system-certs --managed-python --python "$VENV_PYTHON" "$here/.venv" || fail venv
fi

step "installing what pyproject pins, torch built for the CUDA this driver runs"
VIRTUAL_ENV="$here/.venv" uv pip install --system-certs --torch-backend auto -r "$here/pyproject.toml" || fail install

step "what stands now"
"$here/.venv/bin/python" - <<'PY' || true
import importlib.metadata as meta
for name in ("laya", "torch", "transformers", "safetensors"):
    try:
        print(f"  {name} {meta.version(name)}")
    except Exception:
        print(f"  {name} none")
PY
"$here/.venv/bin/python" -c 'import torch; print(f"  torch built for CUDA {torch.version.cuda}")' 2>/dev/null || true
# Two links or more: the cache and this venv share the CUDA libraries, so the machine holds them once.
shared="$(find "$here"/.venv/lib/python*/site-packages/nvidia -type f -name '*.so*' -printf '%s %n %f\n' 2>/dev/null | sort -n | tail -n 1)"
if [ -n "$shared" ]; then
  read -r _ links name <<<"$shared"
  step "largest CUDA library $name: $links links"
fi

printf 'LAYA-SETUP-DONE ok\n'
