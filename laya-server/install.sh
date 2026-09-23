#!/usr/bin/env bash
# Puts the Laya decision server on home-pc, or brings it up to date there (docs/laya-server.md).
# Run on main-host from this checkout: bash laya-server/install.sh
# It needs no sudo on home-pc: uv lives in the account, and the unit is a user unit.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
node="${LAYA_NODE:-ahas@192.0.2.8x}"
key="${LAYA_NODE_KEY:-$HOME/.ssh/id_bmo_node}"
data_dir="${BMO_DATA_DIR:-$HOME/.local/share/bmo/data}"
token_file="$data_dir/env/laya.token"
port="${LAYA_PORT:-7431}"
ssh_to() { ssh -i "$key" -o BatchMode=yes "$node" "$@"; }

# The token is made once on main-host and copied across; a token already there is kept.
if [[ ! -s "$token_file" ]]; then
  mkdir -p "$(dirname "$token_file")"
  (umask 077 && head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$token_file")
fi
chmod 600 "$token_file"

ssh_to 'mkdir -p ~/bmo-laya ~/.config/bmo-laya ~/.config/systemd/user'
scp -q -i "$key" -o BatchMode=yes "$here/server.py" "$here/pyproject.toml" "$here/bench.py" "$here/finetune.py" "$here/calibrate.py" "$here/resume.py" "$here/metrics.py" "$node:bmo-laya/"
scp -q -i "$key" -o BatchMode=yes "$here/bmo-laya.service" "$node:.config/systemd/user/bmo-laya.service"
ssh_to 'umask 077 && cat > ~/.config/bmo-laya/token && chmod 600 ~/.config/bmo-laya/token' < "$token_file"

ssh_to bash -s <<'REMOTE'
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || curl -LsSf https://astral.sh/uv/install.sh | sh
cd ~/bmo-laya
[[ -d .venv ]] || uv venv -q -p 3.12 .venv
uv pip install -q -p .venv -r pyproject.toml
# The unit's own settings file: an empty checkpoint means the hub model.
[[ -f ~/.config/bmo-laya/env ]] || printf 'LAYA_CHECKPOINT=\n' > ~/.config/bmo-laya/env
systemctl --user daemon-reload
systemctl --user enable bmo-laya.service
systemctl --user restart bmo-laya.service
REMOTE

# The model is loaded before the port opens, so the first health answer is the proof it is up.
for _ in $(seq 1 90); do
  if curl -fsS -m 3 -H "Authorization: Bearer $(cat "$token_file")" "http://${node#*@}:$port/health" >/dev/null 2>&1; then
    echo "bmo-laya is up on ${node#*@}:$port"
    exit 0
  fi
  sleep 2
done
echo "bmo-laya did not answer on ${node#*@}:$port; read journalctl --user -u bmo-laya on the node" >&2
exit 1
