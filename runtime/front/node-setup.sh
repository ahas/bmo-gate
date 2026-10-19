#!/usr/bin/env bash
# The Laya service's environment on its node, stood up from what is already there (docs/llm-server.md).
# It is run detached with its output in setup.log, because installing torch for the engine takes longer
# than the hub holds a streamed command open, and it says `LLM-SETUP-DONE ok` or
# `LLM-SETUP-DONE failed:<step>` on its last line, which is what the caller waits for.
#
# It is idempotent: what is already right is left alone and said so. It installs into the account
# alone — no sudo, no system package, and nothing written to the account's shell profile.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The engine's folder, where the installer puts the Laya server and its own setup.
engine="$HOME/bmo-laya"
export PATH="$PATH:$HOME/.local/bin"
# uv's managed interpreter, rather than the system python, so the venv carries its own headers.
VENV_PYTHON="3.12"
UV_INSTALLER="https://astral.sh/uv/install.sh"

step() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
fail() { printf 'LLM-SETUP-DONE failed:%s\n' "$1"; exit 1; }

cd "$here" || fail cd

if command -v uv >/dev/null 2>&1; then
  step "uv already here: $(uv --version)"
else
  step "installing uv into the account"
  curl -LsSf "$UV_INSTALLER" | env UV_NO_MODIFY_PATH=1 sh >/dev/null 2>&1 || fail uv-install
  command -v uv >/dev/null 2>&1 || fail uv-missing-after-install
  step "uv installed: $(uv --version)"
fi

# A venv standing on the system python, or on an interpreter no longer there, is not the venv this
# script makes. It is made again on uv's own.
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

step "installing what pyproject pins"
VIRTUAL_ENV="$here/.venv" uv pip install --system-certs -r "$here/pyproject.toml" || fail install

step "what stands now"
"$here/.venv/bin/python" - <<'PY' || true
import importlib.metadata as meta
for name in ("mcp", "starlette", "uvicorn", "httpx", "websockets"):
    try:
        print(f"  {name} {meta.version(name)}")
    except Exception:
        print(f"  {name} none")
PY

# The engine's venv is the one a training node's setup builds, so it is that setup that builds it.
[ -f "$engine/node-setup.sh" ] || fail engine-files
step "setting up the engine in $engine"
engine_said="$(bash "$engine/node-setup.sh" 2>&1)"
printf '%s\n' "$engine_said" | sed 's/^/  engine: /'
printf '%s\n' "$engine_said" | tail -n 1 | grep -qx 'LAYA-SETUP-DONE ok' || fail engine

printf 'LLM-SETUP-DONE ok\n'
