#!/usr/bin/env bash
# loadtest.sh — the bash loadtest that runs inside GitHub Actions
# (.github/workflows/loadtest.yml in the runner repo; template at
# workflows/loadtest.yml here). Fired by the 5-minute cron push from
# scripts/gha-trigger.sh on the Fly machine.
#
# Env contract (docs/spec-20261011-gha-cron-loadtest.md):
#   LOADTEST_TARGET             default apig.rg-lgna.com
#   LOADTEST_RPS                default 5 — the workflow injects deploy.env's
#                               value (synced by scripts/gha-repo-sync.sh)
#   LOADTEST_DURATION_SECS      default 120, HARD-CLAMPED to <= 540 so a run
#                               fits the 10-minute Actions budget (visible in
#                               the summary as duration=540 when clamped)
#   LOADTEST_CONCURRENCY        default 4 — lanes; each paces rps/lanes req/s;
#                               CEILING of 64: above it is a config error
#                               (exit 2 before any request), exactly 64 is
#                               accepted
#   LOADTEST_MAX_ERROR_PERCENT  default 50 (applied only when unset/empty) —
#                               a NON-NEGATIVE integer; 0 is a legal value.
#                               Exit 1 iff the error share STRICTLY exceeds
#                               it (0 => ANY failure trips; 100 == 100 exits
#                               0); a negative or non-numeric value is a
#                               config error (exit 2 before any request)
#   LOADTEST_LOBBY_SCHEME       default derived: http for an IP[:port] target,
#                               https otherwise
#   LOADTEST_LOBBY_HOST         default derived from LOADTEST_TARGET: an
#                               IP[:port] target IS the lobby host itself over
#                               http (mirror of the Go app's envDomain
#                               fallback — no env domain, so no
#                               lobby.<domain> derivation), any other target
#                               gets lobby.<env domain>; when BOTH scheme and
#                               host are set they win
#   LOADTEST_PATH               default /api/v1/lobby-available-games?oc=demo&l=en
#   LOADTEST_LOG                default loadtest-results.tsv — one
#                               "<status>\t<time_total>" line per request
#
# Exit codes: 0 success; 1 error share exceeds the threshold; 2 config error
# (non-positive / non-numeric RPS, concurrency outside 1..64, negative /
# non-numeric MAX_ERROR_PERCENT — detected BEFORE any request).
set -u

err() { printf 'loadtest.sh: %s\n' "$*" >&2; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

TARGET="${LOADTEST_TARGET:-apig.rg-lgna.com}"
RPS="${LOADTEST_RPS:-5}"
LANES="${LOADTEST_CONCURRENCY:-4}"
DUR="${LOADTEST_DURATION_SECS:-120}"
MAXERR="${LOADTEST_MAX_ERROR_PERCENT:-50}"
SCHEME="${LOADTEST_LOBBY_SCHEME:-}"
HOST="${LOADTEST_LOBBY_HOST:-}"
REQ_PATH="${LOADTEST_PATH:-/api/v1/lobby-available-games?oc=demo&l=en}"
LOG="${LOADTEST_LOG:-loadtest-results.tsv}"

# ---- config validation (exit 2 BEFORE any request) --------------------------
positive_number() { awk -v v="$1" 'BEGIN{exit !(v ~ /^[0-9]+(\.[0-9]+)?$/ && v+0 > 0)}' 2>/dev/null; }

# dotted-quad IPv4 check (used for the lobby derivation below); awk's numeric
# coercion also keeps absurd digit strings from overflowing shell arithmetic.
is_ip() { awk -v v="$1" 'BEGIN{n = split(v, a, "."); if (n != 4) exit 1; for (i = 1; i <= 4; i++) if (a[i] !~ /^[0-9]+$/ || a[i] + 0 > 255) exit 1; exit 0}' 2>/dev/null; }

if ! positive_number "$RPS"; then
  err "LOADTEST_RPS must be a positive number, got [$RPS]"
  exit 2
fi
case "$LANES" in
  ''|*[!0-9]*) err "LOADTEST_CONCURRENCY must be a positive integer, got [$LANES]"; exit 2 ;;
esac
if ! awk -v v="$LANES" 'BEGIN{exit !(v + 0 <= 64)}'; then
  err "LOADTEST_CONCURRENCY must be at most 64, got [$LANES]"
  exit 2
fi
if [ "$LANES" -lt 1 ]; then
  err "LOADTEST_CONCURRENCY must be a positive integer, got [$LANES]"
  exit 2
fi
case "$DUR" in ''|*[!0-9]*) DUR=120 ;; esac   # non-integer duration -> default
[ "$DUR" -ge 1 ] || DUR=1
[ "$DUR" -gt 540 ] && DUR=540                 # hard clamp: fit the 10-min Actions budget
# Non-negative integer only: 0 is legal (ANY failure then trips the gate),
# -5 / abc are config errors. The default above applies to unset/empty only.
case "$MAXERR" in
  ''|*[!0-9]*) err "LOADTEST_MAX_ERROR_PERCENT must be a non-negative integer, got [$MAXERR]"; exit 2 ;;
esac

# ---- lobby URL ---------------------------------------------------------------
# Both scheme and host set explicitly => they win; otherwise each derives from
# TARGET: an IP[:port] target is the lobby host itself over http (mirror of
# the Go app's envDomain fallback — no env domain, so no lobby.<domain>), any
# other target derives https and lobby.<env domain>, e.g. apig.rg-lgna.com ->
# lobby.rg-lgna.com.
TARGET_HOST="${TARGET%%:*}"
if [ -z "$SCHEME" ]; then
  case "$TARGET" in
    *:[0-9]*) SCHEME=http ;;
    *)
      if is_ip "$TARGET_HOST"; then SCHEME=http; else SCHEME=https; fi
      ;;
  esac
fi
if [ -z "$HOST" ]; then
  if is_ip "$TARGET_HOST"; then
    HOST="$TARGET"
  else
    HOST="lobby.${TARGET#*.}"
  fi
fi
URL="$SCHEME://$HOST$REQ_PATH"

# ---- pace --------------------------------------------------------------------
# Each of the LANES lanes paces its share of the budget: one request every
# LANES/RPS seconds, sleep-based, until the deadline.
INTERVAL="$(awk -v r="$RPS" -v l="$LANES" 'BEGIN{printf "%.4f", l/r}')"

if ! : > "$LOG" 2>/dev/null; then
  err "cannot write results log at $LOG"
  exit 2
fi

now() { # fractional epoch (integer fallback where %N is unsupported)
  local t
  t="$(date +%s.%N 2>/dev/null || true)"
  case "$t" in
    [0-9]*.[0-9]*) printf '%s' "$t" ;;
    *) date +%s ;;
  esac
}

lane() {
  local out last code t now_s rem d
  while :; do
    now_s="$(now)"
    awk -v a="$now_s" -v b="$DEADLINE" 'BEGIN{exit !(a < b)}' || break
    out="$(curl -sS -m 15 \
      -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
      -H 'Accept: application/json, text/plain, */*' \
      -H 'Accept-Language: en-US,en;q=0.9' \
      -H "Referer: $SCHEME://$HOST/" \
      -w '\n%{http_code} %{time_total}' \
      "$URL" 2>/dev/null)"
    last="$(printf '%s\n' "$out" | tail -n1)"
    code="${last%% *}"
    t="${last##* }"
    case "$code" in [0-9][0-9][0-9]) ;; *) code=000 ;; esac
    case "$t" in ''|*[!0-9.]*) t=0 ;; esac
    printf '%s\t%.6f\n' "$code" "$t" >> "$LOG"
    # pace: sleep the lane's share of the budget, capped at the remaining time
    rem="$(awk -v a="$DEADLINE" -v b="$(now)" 'BEGIN{r = a - b; if (r < 0) r = 0; printf "%.3f", r}')"
    if ! awk -v r="$rem" 'BEGIN{exit !(r > 0.05)}'; then
      break
    fi
    d="$(awk -v i="$INTERVAL" -v r="$rem" 'BEGIN{printf "%.3f", (i < r) ? i : r}')"
    sleep "$d"
  done
}

pids=()
cleanup() { local p; for p in ${pids[@]+"${pids[@]}"}; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

DEADLINE="$(awk -v s="$(now)" -v d="$DUR" 'BEGIN{printf "%.3f", s + d}')"
log "loadtest start: $URL rps=$RPS lanes=$LANES duration=${DUR}s (target=$TARGET)"

for ((i = 1; i <= LANES; i++)); do
  lane &
  pids+=($!)
done
for p in ${pids[@]+"${pids[@]}"}; do
  wait "$p" || true
done
pids=()
trap - EXIT

# ---- summary -----------------------------------------------------------------
# p50/p95 by nearest rank over the sorted per-request times; max is the last.
tab="$(printf '\t')"
read -r sent ok fail p50 p95 pmax <<<"$(sort -t"$tab" -k2,2n "$LOG" | awk -F'\t' '
  function ceil(x, p) { p = int(x); if (p < x) p++; return p }
  { n++; if ($1 + 0 >= 200 && $1 + 0 < 300) ok++; else fail++; times[n] = $2 + 0 }
  END {
    if (n == 0) { print "0 0 0 0.0 0.0 0.0"; exit }
    printf "%d %d %d %.3f %.3f %.3f\n", n, ok + 0, fail + 0, times[ceil(0.5 * n)], times[ceil(0.95 * n)], times[n]
  }')"
rps="$(awk -v s="$sent" -v d="$DUR" 'BEGIN{printf "%.1f", (d > 0) ? s / d : 0}')"
errpct="$(awk -v f="$fail" -v s="$sent" 'BEGIN{printf "%.1f", (s > 0) ? 100 * f / s : 0}')"
printf 'summary: sent=%s ok=%s fail=%s duration=%s rps=%s err%%=%s p50=%s p95=%s max=%s\n' \
  "$sent" "$ok" "$fail" "$DUR" "$rps" "$errpct" "$p50" "$p95" "$pmax"

# STRICTLY exceeds the threshold => failure (100% errors with a threshold of
# 100 does NOT exceed it).
if awk -v f="$fail" -v s="$sent" -v m="$MAXERR" 'BEGIN{e = (s > 0) ? 100 * f / s : 0; exit !(e > m)}'; then
  err "error share exceeds LOADTEST_MAX_ERROR_PERCENT=$MAXERR"
  exit 1
fi
exit 0
