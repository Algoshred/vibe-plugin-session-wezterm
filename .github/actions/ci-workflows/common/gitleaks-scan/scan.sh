#!/usr/bin/env bash
# See action.yml. Inputs via env: INPUT_FROM, INPUT_TO, INPUT_CONFIG,
# EVENT_NAME, PUSH_BEFORE, PUSH_AFTER. Runs inside the checkout.
set -euo pipefail

GITLEAKS_VERSION=8.28.0
GITLEAKS_SHA256=a65b5253807a68ac0cafa4414031fd740aeb55f54fb7e55f386acb52e6a840eb
out="${GITHUB_OUTPUT:-/dev/stdout}"
tmp="${RUNNER_TEMP:-$(mktemp -d)}"

# 1. The pinned binary (reused when an earlier step of the job installed it).
bin="$tmp/gitleaks-${GITLEAKS_VERSION}/gitleaks"
if [ ! -x "$bin" ]; then
  archive="$tmp/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  curl -fsSL --retry 3 -o "$archive" \
    "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
  echo "${GITLEAKS_SHA256}  ${archive}" | sha256sum -c -
  mkdir -p "$(dirname "$bin")"
  tar -xzf "$archive" -C "$(dirname "$bin")" gitleaks
  rm -f "$archive"
fi

if [ "$(git rev-parse --is-shallow-repository)" = "true" ]; then
  echo "::error::the checkout is shallow; use actions/checkout with fetch-depth: 0"
  exit 1
fi

# 2. The range.
zero=0000000000000000000000000000000000000000
from="${INPUT_FROM:-}"
to="${INPUT_TO:-HEAD}"
# The net change is measured up to what lands: the range tip for an explicit
# range, HEAD (GitHub's merge commit on a pull request) otherwise.
net_to="$to"
if [ -z "$from" ]; then
  to=HEAD
  net_to=HEAD
  case "${EVENT_NAME:-}" in
    pull_request | pull_request_target | merge_group)
      # actions/checkout checks out GitHub's merge commit: parent 1 is the base
      # tip, parent 2 the PR head.
      read -r -a parents <<< "$(git rev-list --parents -n 1 HEAD)"
      if [ "${#parents[@]}" -eq 3 ]; then
        from="${parents[1]}"
        to="${parents[2]}"
      elif [ "${#parents[@]}" -eq 2 ]; then
        from="${parents[1]}"
      else
        echo "::error::HEAD is a root commit or an octopus merge; refusing to guess the change set"
        exit 1
      fi
      ;;
    push)
      if [ -n "${PUSH_BEFORE:-}" ] && [ "$PUSH_BEFORE" != "$zero" ] && git cat-file -e "${PUSH_BEFORE}^{commit}" 2> /dev/null; then
        from="$PUSH_BEFORE"
        to="${PUSH_AFTER:-HEAD}"
      fi
      ;;
  esac
fi
for ref in "$from" "$to"; do
  if [ -n "$ref" ] && ! git rev-parse -q --verify "${ref}^{commit}" > /dev/null; then
    echo "::error::'${ref}' is not a commit in this checkout"
    exit 1
  fi
done

config=()
if [ -n "${INPUT_CONFIG:-}" ] && [ -f "$INPUT_CONFIG" ]; then
  config=("--config=$(pwd)/${INPUT_CONFIG}")
fi

# 3. Commits, every parent followed.
if [ -n "$from" ]; then
  echo "range=${from}..${to}" >> "$out"
  echo "Commit scan: $(git rev-list --count "${from}..${to}") commit(s) in ${from}..${to}, merged-in branches included"
  "$bin" git . --no-banner --redact --exit-code 1 "${config[@]}" "--log-opts=${from}..${to}"
else
  echo "range=full" >> "$out"
  echo "Commit scan: full history"
  "$bin" git . --no-banner --redact --exit-code 1 "${config[@]}"
fi

# 4. Net change: files as they land.
scan="$tmp/gitleaks-net-change"
rm -rf "$scan"
mkdir -p "$scan"
count=0
if [ -n "$from" ]; then
  list=(git diff --name-only --no-renames --diff-filter=AMT -z "$from" "$net_to")
else
  list=(git ls-tree -r -z --name-only "$net_to")
fi
while IFS= read -r -d '' f; do
  [ "$(git cat-file -t "${net_to}:$f" 2> /dev/null)" = blob ] || continue
  mkdir -p "$scan/$(dirname "$f")"
  git show "${net_to}:$f" > "$scan/$f"
  count=$((count + 1))
done < <("${list[@]}")
echo "net-change-files=${count}" >> "$out"
echo "Net-change scan: ${count} added or modified file(s) as they land"
if [ "$count" -gt 0 ]; then
  # The copy lives outside the checkout, so the repo's allowlist is passed explicitly.
  "$bin" dir "$scan" --no-banner --redact --exit-code 1 "${config[@]}"
fi
rm -rf "$scan"
