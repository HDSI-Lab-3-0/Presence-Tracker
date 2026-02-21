#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="$ROOT_DIR/rust-agent/src"
MAX_LOC=1000

if [ ! -d "$TARGET_DIR" ]; then
  echo "rust-agent/src not found"
  exit 1
fi

TOTAL_LOC=$(find "$TARGET_DIR" -name '*.rs' -type f -print0 | xargs -0 wc -l | tail -n 1 | awk '{print $1}')

echo "Rust LOC: $TOTAL_LOC"
if [ "$TOTAL_LOC" -gt "$MAX_LOC" ]; then
  echo "ERROR: rust-agent/src exceeds ${MAX_LOC} LOC"
  exit 1
fi

echo "OK: rust-agent/src within ${MAX_LOC} LOC"
