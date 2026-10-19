#!/usr/bin/env bash
# A checkpoint made ready to be carried off the node it was made on (docs/training.md,
# 「Checkpoint naming and collection」):
#
#   node-collect.sh pack  <checkpoint> <package> [final|step]   packs it whole and says its size and hash
#   node-collect.sh clean <package>                             removes a package once it is carried off
#
# The transfer carries one file, and a checkpoint is a folder, so it travels as a single tar. It is
# not compressed: a safetensors file is already dense and gzip would spend minutes to save nothing.
#
# What travels is the model and not the machinery of a run:
#   final  — the finished checkpoint without its own `steps/` folder, those being the rolling saves,
#            which are collected under their own step numbers or not at all.
#   step   — a rolling save without its trainer state, which is several gigabytes of optimizer moments
#            and full-precision weights. A resume happens on the node that holds them; what has to
#            survive the node is the model, and the tunnel carries a file whole in memory, so a
#            multi-gigabyte tar is not a thing to send across it every time a run is carried on.
set -uo pipefail

export PATH="$PATH:$HOME/.local/bin"

verb="${1:-}"
shift || true

case "$verb" in
  pack)
    checkpoint="$1"; tarball="$2"; kind="${3:-step}"
    if [ ! -d "$checkpoint" ]; then
      echo "fault=no-checkpoint"
      exit 1
    fi
    mkdir -p "$(dirname "$tarball")"
    rm -f "$tarball"
    if [ "$kind" = "final" ]; then
      tar -cf "$tarball" -C "$checkpoint" --exclude=./steps . || { echo "fault=tar"; exit 1; }
    else
      tar -cf "$tarball" -C "$checkpoint" --exclude=./trainer_state.pt . || { echo "fault=tar"; exit 1; }
    fi
    printf 'packed=%s\n' "$tarball"
    printf 'bytes=%s\n' "$(stat -c %s "$tarball")"
    printf 'sha256=%s\n' "$(sha256sum "$tarball" | awk '{print $1}')"
    printf 'files=%s\n' "$(tar -tf "$tarball" | grep -vc '/$')"
    ;;
  clean)
    rm -f "$1"
    echo "cleaned=$1"
    ;;
  *)
    echo "node-collect.sh: pack | clean" >&2
    exit 2
    ;;
esac
