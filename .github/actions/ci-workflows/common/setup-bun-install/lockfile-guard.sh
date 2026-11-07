#!/usr/bin/env bash
# Lockfile drift guard (ported from the svc pr-check.yml).
#
# Re-resolves the lockfile from the committed manifests in a scratch copy and
# fails when the result differs from the committed bun.lock. Every tracked
# package.json is copied with its path, so Bun workspaces resolve the same way
# they do in the checkout. Runs in the package directory.
set -euo pipefail

if [ ! -f package.json ] || [ ! -f bun.lock ]; then
  echo "No package.json/bun.lock here; skipping the drift check"
  exit 0
fi

scratch="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/lockfile-guard.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

copy() {
  mkdir -p "$scratch/$(dirname "$1")"
  cp -R "$1" "$scratch/$1"
}

copy bun.lock
copy package.json
for f in bunfig.toml .npmrc .bun-version; do
  if [ -f "$f" ]; then copy "$f"; fi
done
if [ -d patches ]; then copy patches; fi
# Workspace members: every other tracked package.json below this directory.
if git rev-parse --is-inside-work-tree > /dev/null 2>&1; then
  while IFS= read -r -d '' manifest; do
    case "$manifest" in
      package.json | node_modules/* | */node_modules/*) ;;
      */package.json) copy "$manifest" ;;
    esac
  done < <(git ls-files -z -- '*package.json')
fi

log="$scratch/.lockfile-guard.log"
if ! (cd "$scratch" && bun install --lockfile-only) > "$log" 2>&1; then
  echo "::error::bun install --lockfile-only failed while re-resolving bun.lock"
  cat "$log"
  exit 1
fi

if ! cmp -s "$scratch/bun.lock" bun.lock; then
  echo "::error::bun.lock is out of sync with package.json; regenerate it with 'bun install' and commit it"
  diff -u bun.lock "$scratch/bun.lock" | head -60 || true
  exit 1
fi
echo "bun.lock is in sync with package.json"
