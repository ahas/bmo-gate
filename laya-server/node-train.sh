#!/usr/bin/env bash
# One gate's training run on one node, in the four moves the driver makes (docs/training.md,
# 「One gate on one node」):
#
#   node-train.sh launch    <데이터> <체크포인트> <로그> [옵션…]   학습을 떼어 놓고 시작한다
#   node-train.sh resume    <체크포인트> <데이터> <로그> [옵션…]  끊긴 학습을 이어서 시작한다
#   node-train.sh calibrate <체크포인트> <데이터> <로그>          끝난 체크포인트의 온도를 맞춘다
#   node-train.sh state     <체크포인트> <로그>                   지금 어떤 상태인지 한 줄씩 말한다
#
# Every run is detached: the hub stops a command it is streaming and the stop reaches the whole
# process group, so a training that takes longer than that would die with the call that started it.
# What survives is `setsid nohup … &` with its output in a log the next call reads.
#
# Every run holds the node's shared card lock from before it touches the card until it ends, waiting
# for it where another service has it (docs/training.md, 「One gate on one node」). The lock is taken
# on a descriptor the run itself inherits, so it goes with the run's last process and nothing else.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$PATH:$HOME/.local/bin:/usr/local/cuda/bin"
python="$here/.venv/bin/python"
lock="$HOME/.gpu.lock"
held='exec 9>>"$0"; flock -n 9 || { echo "waiting for the card lock $0"; flock 9; }; exec "$@"'

verb="${1:-}"
shift || true

case "$verb" in
  launch)
    data="$1"; out="$2"; log="$3"; shift 3
    mkdir -p "$(dirname "$log")"
    cd "$here" || exit 1
    setsid nohup bash -c "$held" "$lock" "$python" finetune.py --data "$data" --out "$out" "$@" > "$log" 2>&1 < /dev/null &
    echo "launched pid=$!"
    ;;
  resume)
    out="$1"; data="$2"; log="$3"; shift 3
    mkdir -p "$(dirname "$log")"
    cd "$here" || exit 1
    # The log is appended to rather than replaced, so what the killed run said stays readable beside
    # what the resumed one says.
    setsid nohup bash -c "$held" "$lock" "$python" finetune.py --resume "$out" --data "$data" "$@" >> "$log" 2>&1 < /dev/null &
    echo "resumed pid=$!"
    ;;
  calibrate)
    out="$1"; data="$2"; log="$3"; shift 3
    mkdir -p "$(dirname "$log")"
    cd "$here" || exit 1
    setsid nohup bash -c "$held" "$lock" "$python" calibrate.py --model "$out" --data "$data" --write "$@" > "$log" 2>&1 < /dev/null &
    echo "calibrating pid=$!"
    ;;
  state)
    out="$1"; log="${2:-}"; calibrated="${3:-}"
    cd "$here" || exit 1
    running() { pgrep -af "$1" 2>/dev/null | grep -F -- "$out" | grep -v node-train | grep -c . ; }
    printf 'training=%s\n' "$([ "$(running finetune.py)" -gt 0 ] && echo yes || echo no)"
    printf 'calibrating=%s\n' "$([ "$(running calibrate.py)" -gt 0 ] && echo yes || echo no)"
    printf 'finished=%s\n' "$([ -f "$out/training_complete.json" ] && echo yes || echo no)"
    printf 'exists=%s\n' "$([ -d "$out" ] && echo yes || echo no)"
    newest="$(ls -1 "$out/steps" 2>/dev/null | grep -E '^step-[0-9]+$' | sort | tail -1)"
    printf 'step=%s\n' "${newest:-none}"
    printf 'checkpoints=%s\n' "$(ls -1 "$out/steps" 2>/dev/null | grep -cE '^step-[0-9]+$')"
    # A calibration counts as this run's only where its log is newer than the training that finished;
    # an older one belongs to a run that stood here before and says nothing about this one.
    if [ -n "$calibrated" ] && [ -f "$calibrated" ] && [ "$calibrated" -nt "$out/training_complete.json" ]; then
      printf 'calibrated=yes\n'
    else
      printf 'calibrated=no\n'
    fi
    if [ -n "$log" ] && [ -f "$log" ]; then
      printf 'lines=%s\n' "$(grep -c . "$log")"
      printf 'last=%s\n' "$(grep . "$log" | tail -1 | tr -d '\r' | cut -c1-200)"
    else
      printf 'lines=0\n'
      printf 'last=none\n'
    fi
    ;;
  *)
    echo "node-train.sh: launch | resume | calibrate | state" >&2
    exit 2
    ;;
esac
