#!/usr/bin/env bash
# Update the local nextop monorepo.
# Defaults to the sibling nextop/ directory two levels above data-analysis/.
# Override with NEXTOP_REPO_PATH environment variable.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DEFAULT_NEXTOP="$(cd "$SCRIPT_DIR/../../../nextop" 2>/dev/null && pwd)" || DEFAULT_NEXTOP=""
NEXTOP_PATH="${NEXTOP_REPO_PATH:-$DEFAULT_NEXTOP}"

if [[ -z "$NEXTOP_PATH" || ! -d "$NEXTOP_PATH/.git" ]]; then
  DEST="${NEXTOP_REPO_PATH:-$(cd "$SCRIPT_DIR/../../.." && pwd)/nextop}"
  echo "nextop repo not found. Cloning into $DEST …"
  git clone https://github.com/nextop-os/nextop "$DEST"
  echo "Cloned. Commit: $(git -C "$DEST" rev-parse --short HEAD)"
else
  ORIGIN="$(git -C "$NEXTOP_PATH" remote get-url origin 2>/dev/null || echo 'unknown')"
  echo "Pulling nextop from $ORIGIN …"
  git -C "$NEXTOP_PATH" pull --ff-only
  echo "Done. Commit: $(git -C "$NEXTOP_PATH" rev-parse --short HEAD)"
fi
