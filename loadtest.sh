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
#   LOADTEST_TOKEN_URL          unset/empty = today's lobby-only behavior
#                               EXACTLY (no acquisition, no read mix; the
#                               summary still reports token=none); SET = ONE
#                               player token is acquired from the broker's
#                               /token BEFORE the run and each request
#                               round-robins the READ-DATA endpoints the Go
#                               app drives with a token — balance
#                               (/api/v2/balance?oc=&t=), history (/api/bets),
#                               details (/api/total-bets), config
#                               (/<code>/config) — plus the tokenless lobby
#                               catalog.  A read-only run NEVER spins
#                               (/<code>/spin) or mints
#                               (/client/player/fun-mode-token).  The summary
#                               gains a trailing token=<mint|store|none>
#                               (the SOURCE only — the raw token never
#                               appears in the summary or any script-emitted
#                               line, only inside request URLs)
#   LOADTEST_BROKER_SECRET      sent as `Authorization: Bearer <secret>` on
#                               the acquisition call
#   LOADTEST_REQUIRE_TOKEN      default 0: acquisition failure DEGRADES to
#                               lobby-only (a warning, token=none, exit code
#                               unchanged); 1: acquisition failure OR a
#                               UTC+7 read-window computation failure is
#                               exit 2 BEFORE any request
#   LOADTEST_GAME_CODE          default fortune-dragon — the gameCode the
#                               read APIs need
#   LOADTEST_OCS                default demo — the operator code (oc= /
#                               brandCode=)
#
# Exit codes: 0 success; 1 error share exceeds the threshold (lobby, and the
# game probe only when LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT is set), OR the
# achieved rps= falls below the throughput floor when LOADTEST_MIN_RPS_PERCENT
# > 0; 2 config error (non-positive / non-numeric RPS, concurrency outside
# 1..64, negative / non-numeric MAX_ERROR_PERCENT or MIN_RPS_PERCENT —
# detected BEFORE any request), ALSO when LOADTEST_REQUIRE_TOKEN=1 and the
# token acquisition failed or the UTC+7 read window could not be computed
# (also BEFORE any request).
set -u
# Numbers here are dot-decimal by contract: curl emits %{time_total} as
# 0.123456, and awk's printf "%.3f" builds the pacing sleeps and the summary's
# rps/err%/p50/p95/max. Under a comma-decimal locale (de_DE, vi_VN, …) bash's
# printf rejects the dot form ("invalid number") and awk emits commas, so the
# TSV and the summary silently corrupt. The workflow's env -i masks this by
# forcing C, but an operator running the script by hand must get the same
# numbers — so pin the C locale here, where the next reader will look.
export LC_ALL=C

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

# THE http-vs-https rule, in exactly ONE place (review S8): an IP[:port] or
# any explicitly ported target is http, an IP host without a port is http,
# every other target is https.  Both derivations — the lobby URL's SCHEME and
# the read APIs' READ_SCHEME — call this, so a rule change is a single edit
# and the two can never drift apart.
derive_scheme() { # <target> — prints "http" or "https"
  case "$1" in
    *:[0-9]*) printf 'http' ;;
    *)
      if is_ip "${1%%:*}"; then printf 'http'; else printf 'https'; fi
      ;;
  esac
}

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
  SCHEME="$(derive_scheme "$TARGET")"
fi
if [ -z "$HOST" ]; then
  if is_ip "$TARGET_HOST"; then
    HOST="$TARGET"
  else
    HOST="lobby.${TARGET#*.}"
  fi
fi
URL="$SCHEME://$HOST$REQ_PATH"

# ---- token broker + read-data mix (docs/spec-20261012-token-broker.md) -------
# LOADTEST_TOKEN_URL unset/empty => today's lobby-only behavior exactly.  Set
# => ONE player token is acquired from the broker BEFORE the run (bounded
# curl, a couple of retries, sed-parsed JSON — NO jq) and the lane loop
# round-robins the READ-DATA endpoints with it.  The raw token never appears
# in any script-emitted line; the summary only names the SOURCE.  Failure
# degrades to lobby-only with a warning (exit code unchanged) unless
# LOADTEST_REQUIRE_TOKEN=1 makes it fatal — exit 2 BEFORE any request.
TOKEN_URL="${LOADTEST_TOKEN_URL:-}"
BROKER_SECRET="${LOADTEST_BROKER_SECRET:-}"
REQUIRE_TOKEN="${LOADTEST_REQUIRE_TOKEN:-0}"
GAME_CODE="${LOADTEST_GAME_CODE:-fortune-dragon}"
OCS="${LOADTEST_OCS:-demo}"
PLAYER_TOKEN=""   # acquired token; empty = lobby-only (unset or degraded)
TOKEN_SRC="none"  # what the summary reports: mint|store|none — never the token
READ_START=""     # the UTC+7 operator-day window the history/details reads
READ_END=""       # need (the Go app's betsWindow), %-escaped like QueryEscape
READ_DAY=""       # that operator day (YYYY-MM-DD in UTC+7) — recomputed when
                  # the lane loop sees it roll (review S7)
READ_ROLLOVER=""  # UTC epoch of the NEXT operator-day midnight: once now >=
                  # this, the lane loop recomputes the window mid-run

# Fail-fast on a config combination that can only ever fail: a broker URL with
# REQUIRE_TOKEN=1 but no secret means the broker 401s every attempt, so the run
# would burn its acquisition retries and then exit 2 anyway. Catch it BEFORE
# any request so the operator gets the reason immediately. (Without
# REQUIRE_TOKEN=1 an empty secret is legal — it just degrades to lobby-only.)
if [ -n "$TOKEN_URL" ] && [ "$REQUIRE_TOKEN" = "1" ] && [ -z "$BROKER_SECRET" ]; then
  err "LOADTEST_TOKEN_URL is set with REQUIRE_TOKEN=1 but LOADTEST_BROKER_SECRET is empty — the broker would 401 every attempt; set the secret or drop REQUIRE_TOKEN"
  exit 2
fi

# The read APIs live on the API host (LOADTEST_TARGET itself — Go's apiHost),
# NOT on the derived lobby host; the scheme is the SAME rule the lobby
# derivation uses, via the one derive_scheme helper (review S8).
READ_HOST="$TARGET"
READ_SCHEME="$(derive_scheme "$TARGET")"

acquire_token() { # bounded, retrying; sets PLAYER_TOKEN + TOKEN_SRC, rc 1 on failure
  local attempt raw code body tok src
  for attempt in 1 2 3; do
    raw=""
    if [ -n "$BROKER_SECRET" ]; then
      raw="$(curl -sS --connect-timeout 10 --max-time 30 \
        -H "Authorization: Bearer $BROKER_SECRET" \
        -w $'\n%{http_code}' "$TOKEN_URL" 2>/dev/null || true)"
    else
      raw="$(curl -sS --connect-timeout 10 --max-time 30 \
        -w $'\n%{http_code}' "$TOKEN_URL" 2>/dev/null || true)"
    fi
    code="${raw##*$'\n'}"                       # the -w line: the HTTP status
    body=""
    case "$raw" in *$'\n'*) body="${raw%$'\n'*}" ;; esac
    case "$code" in
      2??)
        # sed, NOT jq — the runner must not grow a dependency for this.  The
        # broker answers {"token":"…","source":"mint"|"store"}; an unparseable
        # or sourceless response is a failure, never an invented token.
        tok="$(printf '%s' "$body" | sed -n 's/.*"token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
        src="$(printf '%s' "$body" | sed -n 's/.*"source"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
        case "$src" in
          mint|store)
            if [ -n "$tok" ]; then PLAYER_TOKEN="$tok"; TOKEN_SRC="$src"; return 0; fi
            ;;
        esac
        ;;
    esac
    [ "$attempt" -lt 3 ] && sleep "$attempt"
  done
  return 1
}

# The operator's day in UTC+7 — the Go app's betsWindow: start = that day's
# 17:00:00.000Z, end = the next day's 16:59:59.999Z, computed with GNU date.
# The explicit "UTC" anchors keep the arithmetic free of the runner's TZ.
# Called ONCE before the run, then AGAIN from inside the lane loop whenever
# the operator day has rolled past READ_ROLLOVER (review S7): Go recomputes
# betsWindow() per call, so a run crossing UTC+7 midnight must roll too
# instead of sending the previous operator day for its remaining minutes.
# Sets READ_DAY / READ_START / READ_END / READ_ROLLOVER only on SUCCESS; on
# failure it returns 1 and leaves any previous window fully intact — never a
# half-set one.
compute_read_window() {
  local day read_start read_end read_epoch
  day="$(date -u -d '+7 hours' '+%Y-%m-%d' 2>/dev/null || true)"
  case "$day" in
    [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9])
      read_start="$(date -u -d "$day 00:00:00 UTC -7 hours" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || true)"
      read_end="$(date -u -d "$day 00:00:00 UTC +17 hours -1 second" '+%Y-%m-%dT%H:%M:%S' 2>/dev/null || true)"
      # the rollover instant = local midnight + one local day.  An epoch this
      # system cannot produce only DISABLES the mid-run recompute — the
      # window itself is still good, so it is never a computation failure.
      read_epoch="$(date -u -d "$day 00:00:00 UTC -7 hours" '+%s' 2>/dev/null || true)"
      case "$read_epoch" in ''|*[!0-9]*) read_epoch="" ;; esac
      ;;
    *)
      return 1
      ;;
  esac
  [ -n "$read_start" ] && [ -n "$read_end" ] || return 1
  READ_DAY="$day"
  READ_START="$(printf '%s.000Z' "$read_start" | sed 's/:/%3A/g')"
  READ_END="$(printf '%s.999Z' "$read_end" | sed 's/:/%3A/g')"
  if [ -n "$read_epoch" ]; then
    READ_ROLLOVER=$((read_epoch + 86400))
  else
    READ_ROLLOVER=""
  fi
  return 0
}

if [ -n "$TOKEN_URL" ]; then
  if acquire_token; then
    if ! compute_read_window; then
      if [ "$REQUIRE_TOKEN" = 1 ]; then
        # LOADTEST_REQUIRE_TOKEN=1 => exit 2 BEFORE any request on ANY
        # acquisition-side failure (review W7): a token whose operator-day
        # window cannot be computed is as unusable as a failed acquisition, so
        # it gets the same fatal verdict — never a silent degrade that leaves
        # REQUIRE_TOKEN=1 running a tokenless lobby-only run green.
        err "could not compute the UTC+7 read window and LOADTEST_REQUIRE_TOKEN=1"
        exit 2
      else
        # a token without its window cannot drive history/details correctly:
        # fail safe back to today's lobby-only behavior, never a malformed read
        err "could not compute the UTC+7 read window - degrading to lobby-only (token=none)"
        PLAYER_TOKEN=""
        TOKEN_SRC="none"
      fi
    fi
  elif [ "$REQUIRE_TOKEN" = 1 ]; then
    err "token acquisition from LOADTEST_TOKEN_URL failed and LOADTEST_REQUIRE_TOKEN=1"
    exit 2
  else
    err "token acquisition from LOADTEST_TOKEN_URL failed - degrading to lobby-only (token=none)"
  fi
fi

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

# <lane-index> — the index seeds this lane's read-mix round-robin offset
# (review S9), so lanes never all start on the same endpoint class and the
# mix hits them out of phase instead of in lockstep.
lane() {
  local out last code t now_s now_i rem d url
  local idx="${1:-0}" rn="${1:-0}"
  while :; do
    now_s="$(now)"
    awk -v a="$now_s" -v b="$DEADLINE" 'BEGIN{exit !(a < b)}' || break
    url="$URL"
    if [ -n "$PLAYER_TOKEN" ]; then
      # review S7: the operator day may roll past UTC+7 midnight mid-run
      # (a run is up to 540 s, so a run can straddle 17:00 UTC).  Go's
      # betsWindow() recomputes PER CALL — recompute here too, or the run's
      # remaining minutes keep sending yesterday's operator day.  The guard
      # is a pure integer compare against the epoch already derived for the
      # window: zero extra forks per request, and the (two-fork) recompute
      # itself runs only when the day has actually moved.  On a failed
      # recompute the PREVIOUS window stays in force — never a malformed one.
      if [ -n "$READ_ROLLOVER" ]; then
        now_i="${now_s%%.*}"
        case "$now_i" in ''|*[!0-9]*) now_i=0 ;; esac
        if [ "$now_i" -ge "$READ_ROLLOVER" ] && compute_read_window; then
          log "read window rolled to the new UTC+7 operator day $READ_DAY (lane $idx)"
        fi
      fi
      # Read mix: each request takes the NEXT endpoint round-robin — balance,
      # history, details, config, then the tokenless lobby catalog, cycling.
      # The raw token lives only in these request URLs, never in script output.
      # Read-only by construction: spin (/…/spin) and the mint
      # (/client/player/fun-mode-token) are never in this rotation.
      rn=$((rn + 1))
      case "$rn" in
        1) url="$READ_SCHEME://$READ_HOST/api/v2/balance?oc=$OCS&t=$PLAYER_TOKEN" ;;
        2) url="$READ_SCHEME://$READ_HOST/api/bets?brandCode=$OCS&gameCode=$GAME_CODE&playerToken=$PLAYER_TOKEN&startDate=$READ_START&endDate=$READ_END&skip=0&limit=20" ;;
        3) url="$READ_SCHEME://$READ_HOST/api/total-bets?brandCode=$OCS&gameCode=$GAME_CODE&playerToken=$PLAYER_TOKEN&startDate=$READ_START&endDate=$READ_END" ;;
        4) url="$READ_SCHEME://$READ_HOST/$GAME_CODE/config?brandCode=$OCS&gameCode=$GAME_CODE&playerToken=$PLAYER_TOKEN" ;;
        *) url="$URL"; rn=0 ;;
      esac
    fi
    out="$(curl -sS -m 15 \
      -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' \
      -H 'Accept: application/json, text/plain, */*' \
      -H 'Accept-Language: en-US,en;q=0.9' \
      -H "Referer: $SCHEME://$HOST/" \
      -w '\n%{http_code} %{time_total}' \
      "$url" 2>/dev/null)"
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
  lane "$i" &   # the index seeds the lane's round-robin offset (review S9)
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
# token= names the SOURCE only (mint|store|none) — the raw token must never
# appear in the summary or any line this script emits.
printf 'summary: sent=%s ok=%s fail=%s duration=%s rps=%s err%%=%s p50=%s p95=%s max=%s game_err%%=%s minrps=%s token=%s\n' \
  "$sent" "$ok" "$fail" "$DUR" "$rps" "$errpct" "$p50" "$p95" "$pmax" "$g_err_field" "$floor" "$TOKEN_SRC"

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
