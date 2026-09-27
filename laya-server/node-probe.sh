#!/usr/bin/env bash
# What one training node carries, read and never changed (docs/training.md, 「The nodes」).
# One `key=value` a line, every value present — what is missing says `none` rather than
# leaving its line out, so the reader never has to tell an absent value from an absent line.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin:/usr/local/cuda/bin"

say() { printf '%s=%s\n' "$1" "${2:-none}"; }

say host "$(hostname)"
say os "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || uname -s)"
say kernel "$(uname -r)"

if command -v nvidia-smi >/dev/null 2>&1; then
  # The name carries spaces of its own, so the fields are cut on the comma and each one trimmed.
  IFS=',' read -r gpu total free <<<"$(nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits | head -1)"
  trim() { printf '%s' "$1" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'; }
  gpu="$(trim "${gpu:-}")"; total="$(trim "${total:-}")"; free="$(trim "${free:-}")"
  say gpu "${gpu:-none}"
  say vram_total_mb "${total:-none}"
  say vram_free_mb "${free:-none}"
  say gpu_procs "$(nvidia-smi --query-compute-apps=pid --format=csv,noheader | grep -c . || true)"
  say driver "$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
else
  say gpu none; say vram_total_mb none; say vram_free_mb none; say gpu_procs none; say driver none
fi

if command -v nvcc >/dev/null 2>&1; then
  say cuda "$(nvcc --version | sed -n 's/.*release \([0-9.]*\).*/\1/p' | head -1)"
else
  say cuda none
fi
say cuda_path "$([ -d /usr/local/cuda/bin ] && echo /usr/local/cuda/bin || echo none)"
say python "$(python3 -V 2>&1 | awk '{print $2}')"
say cc "$(command -v cc >/dev/null 2>&1 && cc --version | head -1 | awk '{print $1, $NF}' || echo none)"
say uv "$(command -v uv >/dev/null 2>&1 && uv --version | awk '{print $2}' || echo none)"
say disk_free_gb "$(df -BG --output=avail "$HOME" | tail -1 | tr -dc '0-9')"

venv="$here/.venv/bin/python"
if [ -x "$venv" ]; then
  say venv_python "$("$venv" -V 2>&1 | awk '{print $2}')"
  # Whether the venv stands on uv's own interpreter. One on the system python compiles against
  # whatever headers the system happens to carry, and a node without them fails its first kernel.
  managed="$(command -v uv >/dev/null 2>&1 && uv python dir 2>/dev/null || true)"
  base="$("$venv" -c 'import sys; print(sys.base_prefix)' 2>/dev/null || true)"
  if [ -n "$managed" ] && [ -n "$base" ]; then
    case "$base" in "$managed"/*) say venv_managed yes ;; *) say venv_managed no ;; esac
  else
    say venv_managed none
  fi
  "$venv" - <<'PY'
import importlib.metadata as meta
for name in ("laya", "torch", "transformers", "safetensors", "bitsandbytes", "numpy"):
    try:
        print(f"pkg.{name}={meta.version(name)}")
    except Exception:
        print(f"pkg.{name}=none")
PY
else
  say venv_python none
  say venv_managed none
  for name in laya torch transformers safetensors bitsandbytes numpy; do say "pkg.$name" none; done
fi

for file in finetune.py balance.py calibrate.py compare.py predict.py resume.py metrics.py pyproject.toml node-probe.sh node-setup.sh node-train.sh node-collect.sh; do
  if [ -f "$here/$file" ]; then
    say "sha.$file" "$(sha256sum "$here/$file" | awk '{print $1}')"
  else
    say "sha.$file" none
  fi
done

if [ -f "$here/setup.log" ]; then
  say setup_last "$(tail -1 "$here/setup.log" | tr -d '\r')"
else
  say setup_last none
fi
say setup_running "$(pgrep -f 'bmo-laya/node-setup.sh' >/dev/null 2>&1 && echo yes || echo no)"
