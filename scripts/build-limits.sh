#!/usr/bin/env bash
#
# build-limits.sh — bound the native thread pools and cross-repo concurrency of
# the frontend toolchain.
#
# Why this exists
# ---------------
# Vite 8 bundles with rolldown, whose Rust core sizes its rayon pool from
# `availableParallelism()`. On the 16-core dev VM a single `vite build` peaks at
# ~71 OS threads (44 rolldown-worker + 17 rayon + 4 libuv + 4 V8). Vitest
# independently forks `availableParallelism() - 1` worker *processes*. Nothing in
# the toolchain accounts for the fact that this box runs 40 app shells and ~110
# other repos, so pushing several repos at once (lefthook `pre-push` runs the
# full `sanity` chain per repo) put ~280 runnable threads on 16 cores.
#
# Rolldown exposes no thread knob of its own — ROLLDOWN_NUM_THREADS,
# ROLLDOWN_MAX_THREADS and NAPI_RS_THREAD_POOL_SIZE were all measured as no-ops.
# RAYON_NUM_THREADS is the only lever that works, and build wall time is flat
# from 2 to 16 rayon threads, so capping it costs nothing.
#
# Usage
# -----
#   bash scripts/build-limits.sh <command> [args...]            # thread caps only
#   bash scripts/build-limits.sh --gate <command> [args...]     # caps + machine-wide slot
#
# `--gate` additionally takes one of a small number of machine-wide semaphore
# slots, so concurrent `sanity` runs in *different* repos queue rather than
# thrash. The wait is bounded: on timeout the command runs anyway, degraded but
# never blocked.
#
# Tunables (env)
# --------------
#   BOFF_BUILD_THREADS   thread budget per build      (default: cores/4, clamped 2..8)
#   BOFF_BUILD_SLOTS     concurrent gated commands    (default: cores/8, clamped 1..4)
#   BOFF_BUILD_WAIT      max seconds to wait for slot (default: 900)
#   BOFF_BUILD_NO_GATE=1 disable the semaphore entirely
#
# CI is unaffected: each runner is its own machine, so the semaphore is
# uncontended, and the caps derive from that runner's own core count.

set -uo pipefail

GATE=0
if [ "${1:-}" = "--gate" ]; then
  GATE=1
  shift
fi

if [ "$#" -eq 0 ]; then
  echo "build-limits.sh: no command given" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Thread budget
# ---------------------------------------------------------------------------

detect_cores() {
  if command -v nproc >/dev/null 2>&1; then
    nproc
  elif command -v getconf >/dev/null 2>&1; then
    getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4
  else
    echo 4
  fi
}

clamp() { # clamp <value> <min> <max>
  local v=$1 lo=$2 hi=$3
  [ "$v" -lt "$lo" ] && v=$lo
  [ "$v" -gt "$hi" ] && v=$hi
  echo "$v"
}

CORES=$(detect_cores)
case "$CORES" in ''|*[!0-9]*) CORES=4 ;; esac

THREADS=${BOFF_BUILD_THREADS:-$(clamp $((CORES / 4)) 2 8)}
case "$THREADS" in ''|*[!0-9]*) THREADS=4 ;; esac
[ "$THREADS" -lt 1 ] && THREADS=1

# rolldown / oxc rayon pool — the dominant contributor, and the only knob that
# rolldown actually honours.
export RAYON_NUM_THREADS="$THREADS"

# libuv's blocking pool (fs + dns). 4 is the Node default; only shrink it.
UV_SIZE=$THREADS
[ "$UV_SIZE" -gt 4 ] && UV_SIZE=4
export UV_THREADPOOL_SIZE="$UV_SIZE"

# V8 platform workers (background compile/GC). Appended so an existing
# NODE_OPTIONS (e.g. --max-old-space-size) is preserved, and skipped if the
# caller already pinned the pool size.
case "${NODE_OPTIONS:-}" in
  *--v8-pool-size*) : ;;
  *) export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--v8-pool-size=$THREADS" ;;
esac

export BOFF_BUILD_THREADS="$THREADS"

# Vitest forks one worker *process* per core and has no env knob for the pool
# size, so bound it on the command line. Applied here rather than in each repo's
# vitest.config.ts so all 40 app shells share one definition, and skipped if the
# caller already passed an explicit --maxWorkers.
case " $* " in
  *" vitest "*)
    case " $* " in
      *--maxWorkers*|*--max-workers*) : ;;
      *) set -- "$@" "--maxWorkers=$THREADS" "--minWorkers=1" ;;
    esac
    ;;
esac

# ---------------------------------------------------------------------------
# Machine-wide semaphore
# ---------------------------------------------------------------------------
#
# N slot files, each guarded by flock. We poll the slots and run the command as a
# child (never exec) so this shell keeps the lock fd open for the command's whole
# lifetime and releases it on exit — including on Ctrl-C.

SLOT_FD=""

acquire_slot() {
  local slots=$1 deadline=$2 i

  # Namespaced by UID so multiple users on one box never fight over the same files.
  local lock_dir="${TMPDIR:-/tmp}/boff-build-slots-$(id -u)"
  mkdir -p "$lock_dir" 2>/dev/null || return 1

  local announced=0
  while :; do
    for ((i = 1; i <= slots; i++)); do
      local fd
      # Explicit numeric fds are inherited predictably; {fd} auto-allocation is
      # marked close-on-exec by bash, which would silently drop the lock.
      fd=$((200 + i))
      eval "exec $fd>'$lock_dir/slot-$i.lock'" 2>/dev/null || continue
      if flock -n "$fd" 2>/dev/null; then
        SLOT_FD=$fd
        return 0
      fi
      eval "exec $fd>&-" 2>/dev/null || true
    done

    [ "$(date +%s)" -ge "$deadline" ] && return 1

    if [ "$announced" -eq 0 ]; then
      echo "[build-limits] all $slots build slots busy — queueing (set BOFF_BUILD_NO_GATE=1 to skip)" >&2
      announced=1
    fi
    sleep 3
  done
}

release_slot() {
  [ -n "$SLOT_FD" ] || return 0
  eval "exec $SLOT_FD>&-" 2>/dev/null || true
  SLOT_FD=""
}

# Re-entrancy: `sanity` is gated and calls `build`, which is also gated. Without
# this guard a nested call would block forever waiting for a second slot while
# its own parent holds the only one. An ancestor's slot covers the whole subtree.
if [ "$GATE" -eq 1 ] && [ "${BOFF_BUILD_SLOT_HELD:-0}" = "1" ]; then
  GATE=0
fi

if [ "$GATE" -eq 1 ] && [ "${BOFF_BUILD_NO_GATE:-0}" != "1" ] && command -v flock >/dev/null 2>&1; then
  SLOTS=${BOFF_BUILD_SLOTS:-$(clamp $((CORES / 8)) 1 4)}
  case "$SLOTS" in ''|*[!0-9]*) SLOTS=2 ;; esac
  [ "$SLOTS" -lt 1 ] && SLOTS=1

  WAIT=${BOFF_BUILD_WAIT:-900}
  case "$WAIT" in ''|*[!0-9]*) WAIT=900 ;; esac

  if ! acquire_slot "$SLOTS" "$(( $(date +%s) + WAIT ))"; then
    echo "[build-limits] slot wait exceeded ${WAIT}s — running without a slot" >&2
  fi
  export BOFF_BUILD_SLOT_HELD=1
  trap release_slot EXIT INT TERM
fi

# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

"$@" &
CHILD=$!
# Forward signals so Ctrl-C reaches the build rather than orphaning it.
trap 'kill -TERM "$CHILD" 2>/dev/null' INT TERM
wait "$CHILD"
STATUS=$?
release_slot
exit "$STATUS"
