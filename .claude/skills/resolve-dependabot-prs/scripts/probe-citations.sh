#!/usr/bin/env bash
# Find what a dependency bump could invalidate, before running a gate on it.
#
# Two questions, both answered by grep over TRACKED files only (a lockfile match is noise):
#
#   1. Which dated probe comments name this package? Those are measured claims about a system this
#      repo does not control, and a bump is exactly the event that can falsify one. The gate cannot
#      see a comment, so this is the only thing that surfaces them.
#   2. Which files cite the CURRENT version string? Those are citations that must move WITH the bump,
#      or the bump re-stales prose that was correct a moment ago.
#
# Usage:
#   probe-citations.sh eve 0.38.3
#   probe-citations.sh @aws-sdk/client-bedrock-runtime 3.1111.0
#   probe-citations.sh @biomejs/biome 2.5.8

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "usage: probe-citations.sh <package-name> [current-version]" >&2
  exit 2
fi

PKG="$1"
VERSION="${2:-}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

# The bare name without a scope, because a comment usually writes `eve 0.38.3`, not the scoped spec.
BARE="${PKG##*/}"

echo "=== dated probes naming '${BARE}' ==="
echo "Each is a measured claim a bump can falsify. Re-verify or re-date before taking the bump."
echo
if ! git grep -n -i -E "(probed|measured|verified)[^.]{0,80}\\b${BARE}\\b|\\b${BARE}\\b[^.]{0,80}(probed|measured|verified)" \
  -- '*.ts' '*.mjs' '*.md' '*.json' '*.toml' '*.yml' '*.yaml' \
  ':!pnpm-lock.yaml' ':!**/dist/**' ':!.erpaval/**'; then
  echo "(none — no dated probe names this package)"
fi

echo
echo "=== every mention of '${BARE}' in prose or config ==="
if ! git grep -n -E "\\b${BARE}\\b" \
  -- '*.md' '*.toml' '*.yml' '*.yaml' \
  ':!pnpm-lock.yaml' ':!CHANGELOG.md' ':!**/dist/**'; then
  echo "(none)"
fi

if [ -n "$VERSION" ]; then
  echo
  echo "=== files citing the current version '${VERSION}' ==="
  echo "These must move with the bump. A package.json hit is the bump itself; anything else is a citation."
  if ! git grep -n -F "${VERSION}" \
    -- . ':!pnpm-lock.yaml' ':!CHANGELOG.md' ':!**/dist/**'; then
    echo "(none)"
  fi
fi

echo
echo "=== reminders ==="
echo "- .erpaval/solutions/** is excluded from the probe sweep on purpose: a lesson records what was"
echo "  true when written and is not a citation to update. Read it, do not rewrite it."
echo "- A dated probe may stay at its measured version. What is NOT acceptable is a probe whose claim"
echo "  the new version contradicts. Check the claim, then either re-date it or fix the code."
