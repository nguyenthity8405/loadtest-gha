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
#   LOADTEST_MIN_RPS_PERCENT    default 0 = DISABLED (today's behaviour
#                               preserved exactly) — a NON-NEGATIVE INTEGER
#                               percentage of LOADTEST_RPS.  When > 0 the run
#                               exits 1 if the ACHIEVED rps= (the same number
#                               the summary prints) is below LOADTEST_RPS *
#                               percent / 100, so a throttled runner whose
#                               requests all succeed cannot pass CI.  A
#                               negative or non-numeric value is a config
#                               error (exit 2 before any request).  The
#                               summary line gains ONE trailing field,
#                               minrps=<x.x> (the computed floor) or
#                               minrps=off when disabled.
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
#   LOADTEST_GAME_PROBE_COUNT   default 3 — probes sent AFTER the lobby loop
#                               completes (once per run, never per lane,
#                               never DURING the loop), sequential and bounded
#   LOADTEST_GAME_PROBE_SCHEME  default https
#   LOADTEST_GAME_PROBE_HOST    default apig.rg-lgna.com
#   LOADTEST_GAME_PROBE_CODE    default balonismo; an EXPLICITLY EMPTY value
#                               disables the probe ("gameprobe: skipped", zero
#                               probe requests); the run probes
#                               <scheme>://<host>/<code>/config with the same
#                               browser-header, -m 15 curl the lobby lanes use
#   LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT
#                               unset/empty = REPORT-ONLY: the probe never
#                               changes the exit code (the game-path 3000 wall
#                               must be VISIBLE, not flapping the workflow
#                               red); SET = exit 1 iff the game error share
#                               STRICTLY exceeds it (the lobby gate's rule)
#
# Exit codes: 0 success; 1 error share exceeds the threshold (lobby, and the
# game probe only when LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT is set), OR the
# achieved rps= falls below the throughput floor when LOADTEST_MIN_RPS_PERCENT
# > 0; 2 config error (non-positive / non-numeric RPS, concurrency outside
# 1..64, negative / non-numeric MAX_ERROR_PERCENT or MIN_RPS_PERCENT —
# detected BEFORE any request).
set -u

err() { printf 'loadtest.sh: %s\n' "$*" >&2; }
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

TARGET="${LOADTEST_TARGET:-apig.rg-lgna.com}"
RPS="${LOADTEST_RPS:-5}"
LANES="${LOADTEST_CONCURRENCY:-4}"
DUR="${LOADTEST_DURATION_SECS:-120}"
MAXERR="${LOADTEST_MAX_ERROR_PERCENT:-50}"
MINRPS="${LOADTEST_MIN_RPS_PERCENT:-0}"
SCHEME="${LOADTEST_LOBBY_SCHEME:-}"
HOST="${LOADTEST_LOBBY_HOST:-}"
REQ_PATH="${LOADTEST_PATH:-/api/v1/lobby-available-games?oc=demo&l=en}"
LOG="${LOADTEST_LOG:-loadtest-results.tsv}"
GPROBE_COUNT="${LOADTEST_GAME_PROBE_COUNT:-3}"
GPROBE_SCHEME="${LOADTEST_GAME_PROBE_SCHEME:-https}"
GPROBE_HOST="${LOADTEST_GAME_PROBE_HOST:-apig.rg-lgna.com}"
# '-' (NOT ':-'): an explicitly EMPTY code is the documented disable.
GPROBE_CODE="${LOADTEST_GAME_PROBE_CODE-balonismo}"
# Empty (= unset) means report-only; only a SET value gates the exit code.
GPROBE_MAXERR="${LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT-}"

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
# Same rule as MAX_ERROR_PERCENT: 0 (the default above, applied to
# unset/empty only) DISABLES the throughput floor, any other non-negative
# integer is a percentage of LOADTEST_RPS; -5 / abc are config errors.
case "$MINRPS" in
  ''|*[!0-9]*) err "LOADTEST_MIN_RPS_PERCENT must be a non-negative integer, got [$MINRPS]"; exit 2 ;;
esac
# The game probe's knobs get the same discipline (exit 2 before any request).
case "$GPROBE_COUNT" in
  ''|*[!0-9]*) err "LOADTEST_GAME_PROBE_COUNT must be a non-negative integer, got [$GPROBE_COUNT]"; exit 2 ;;
esac
if [ -n "$GPROBE_MAXERR" ]; then
  case "$GPROBE_MAXERR" in
    *[!0-9]*) err "LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT must be a non-negative integer, got [$GPROBE_MAXERR]"; exit 2 ;;
  esac
fi

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

# ---- game-path probe --------------------------------------------------------
# AFTER the lobby loop — once per run, never per lane, never DURING it — probe
# <scheme>://<host>/<code>/config: the GHA egress (GitHub Azure AS8075) is the
# only runtime still getting clean 200s, so this probe is the only sensor that
# can surface the gateway's game-path "Error Code: 3000" verdict (a generic
# HTTP 400 whose BODY carries the refusal) before the lobby itself fails.
# Sequential and bounded: COUNT curls x the lanes' own -m 15 timeout.
# Report-only by default; the exit-code effect is checked in the gate below.
g_sent=0
g_ok=0
g_fail=0
g_statuses=""
g_bodies=""
if [ -z "$GPROBE_CODE" ]; then
  g_err_field="-"
  printf 'gameprobe: skipped\n'
else
  g_url="$GPROBE_SCHEME://$GPROBE_HOST/$GPROBE_CODE/config"
  g_i=0
  while [ "$g_i" -lt "$GPROBE_COUNT" ]; do
    g_i=$((g_i + 1))
    g_raw="$(curl -sS -m 15 \
      -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
      -H 'Accept: application/json, text/plain, */*' \
      -H 'Accept-Language: en-US,en;q=0.9' \
      -H "Referer: $GPROBE_SCHEME://$GPROBE_HOST/" \
      -w '\n%{http_code}' \
      "$g_url" 2>/dev/null)"
    g_code="$(printf '%s\n' "$g_raw" | tail -n1)"
    case "$g_code" in [0-9][0-9][0-9]) ;; *) g_code=000 ;; esac
    # everything before the final "\n<code>" is the response body
    g_body=""
    case "$g_raw" in *$'\n'*) g_body="${g_raw%$'\n'*}" ;; esac
    g_sent=$((g_sent + 1))
    g_statuses="${g_statuses:+$g_statuses,}$g_code"
    case "$g_code" in
      2??) g_ok=$((g_ok + 1)) ;;
      *)
        g_fail=$((g_fail + 1))
        # the verdict lives in the BODY (a generic 400 says nothing): keep the
        # first ~40 chars of each non-2xx body, flattened to one line
        g_snip="$(printf '%s' "$g_body" | tr '\n\r\t' '   ' | cut -c1-40)"
        [ -n "$g_snip" ] || g_snip="-"
        g_bodies="${g_bodies:+$g_bodies,}$g_snip"
        ;;
    esac
  done
  [ -n "$g_bodies" ] || g_bodies="-"
  printf 'gameprobe: sent=%s ok=%s fail=%s statuses="%s" bodies="%s"\n' \
    "$g_sent" "$g_ok" "$g_fail" "$g_statuses" "$g_bodies"
  g_err_field="$(awk -v f="$g_fail" -v s="$g_sent" 'BEGIN{printf "%.1f", (s > 0) ? 100 * f / s : 0}')"
fi

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
# Throughput floor: LOADTEST_RPS * percent / 100, one decimal — "off" when
# MINRPS is 0 (the disabled default), so the summary always reports the gate.
floor="$(awk -v r="$RPS" -v p="$MINRPS" 'BEGIN{if (p + 0 > 0) printf "%.1f", r * p / 100; else printf "off"}')"
printf 'summary: sent=%s ok=%s fail=%s duration=%s rps=%s err%%=%s p50=%s p95=%s max=%s game_err%%=%s minrps=%s\n' \
  "$sent" "$ok" "$fail" "$DUR" "$rps" "$errpct" "$p50" "$p95" "$pmax" "$g_err_field" "$floor"

# STRICTLY exceeds the threshold => failure (100% errors with a threshold of
# 100 does NOT exceed it).
if awk -v f="$fail" -v s="$sent" -v m="$MAXERR" 'BEGIN{e = (s > 0) ? 100 * f / s : 0; exit !(e > m)}'; then
  err "error share exceeds LOADTEST_MAX_ERROR_PERCENT=$MAXERR"
  exit 1
fi
# The game probe is REPORT-ONLY by default — the 3000 wall must be VISIBLE,
# not flapping the workflow red against a wall the operators haven't moved
# yet.  Only an explicitly SET threshold gates, with the lobby gate's STRICTLY
# -exceeds rule (100% == 100 exits 0).
if [ -n "$GPROBE_MAXERR" ] && awk -v f="$g_fail" -v s="$g_sent" -v m="$GPROBE_MAXERR" 'BEGIN{e = (s > 0) ? 100 * f / s : 0; exit !(e > m)}'; then
  err "game probe error share exceeds LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT=$GPROBE_MAXERR"
  exit 1
fi
# Throughput gate: a THROTTLED runner whose requests all succeed (err%=0.0)
# must not pass CI.  Compared against the printed rps= itself, so the gate and
# the summary never disagree; floor=off (MINRPS=0) skips the gate entirely.
if [ "$floor" != off ] && ! awk -v a="$rps" -v f="$floor" 'BEGIN{exit !(a + 0 >= f + 0)}'; then
  err "achieved rps $rps is below the throughput floor $floor (LOADTEST_MIN_RPS_PERCENT=$MINRPS of LOADTEST_RPS=$RPS)"
  exit 1
fi
exit 0
