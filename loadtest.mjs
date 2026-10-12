#!/usr/bin/env node
// loadtest.mjs — the GitHub-Actions cron loadtest, in Node. Replaces the
// bash loadtest.sh outright (deleted — bash cannot execute a .mjs; the Node
// suite scripts/tests/test-loadtest.mjs carries every invariant the old
// bash harness pinned, and gha-health.sh's drift check mirrors THIS file).
//
// WHY Node: the runner now runs the FULL games-mode mix whenever the broker
// hands it a freshly minted, spinnable wallet (docs/spec-20261012-full-loadtest-
// all-platforms.md). That needs a weighted action table, JSON stake derivation
// from /{code}/config and six-field spin POST bodies — fragile through bash
// `sed`, and the repo's test culture for this shape is already `node --test`
// with an injected fetchFn (worker/, vercel/). Node 20 ships on ubuntu-latest.
//
// THE THREE-LEVEL RULE (the point of the rewrite; Go's callReadOnly is the
// reference implementation in internal/loadtest/games.go):
//   broker source=mint  => mix=full: the weighted spin-dominant mix, real
//                          bets with a config-derived stake.
//   broker source=store => mix=read: the mint FAILED, this is a drained
//                          read-only row from postgres — only the read GETs.
//   no token            => mix=lobby: the tokenless lobby catalog only.
// The bash version ran the read mix even on source=mint — it could never
// spin, which is exactly the defect this file exists to remove.
//
// The runner NEVER mints (/client/player/fun-mode-token) and never holds a
// fleet token: supply is one broker acquisition before the run.
//
// Env contract (docs/spec-20261011-gha-cron-loadtest.md — preserved from the
// bash script unless noted):
//   LOADTEST_TARGET             default apig.rg-lgna.com
//   LOADTEST_RPS                default 5 — the workflow injects deploy.env's
//                               value (synced by scripts/gha-repo-sync.sh)
//   LOADTEST_DURATION_SECS      default 120, HARD-CLAMPED to <= 540 so a run
//                               fits the 10-minute Actions budget (visible in
//                               the summary as duration=540 when clamped)
//   LOADTEST_CONCURRENCY        default 4 lanes; CEILING of 64 (above it is a
//                               config error, exit 2 before any request)
//   LOADTEST_MAX_ERROR_PERCENT  default 50 — a NON-NEGATIVE integer; exit 1
//                               iff the error share STRICTLY exceeds it
//   LOADTEST_MIN_RPS_PERCENT    default 0 = DISABLED — a NON-NEGATIVE integer
//                               percentage of LOADTEST_RPS; when > 0 the run
//                               exits 1 if the achieved rps= (the number the
//                               summary prints) is below the floor
//   LOADTEST_LOBBY_SCHEME       default derived: http for an IP[:port] target,
//                               https otherwise (ONE rule, shared with the
//                               read APIs — ported from bash derive_scheme)
//   LOADTEST_LOBBY_HOST         default derived from LOADTEST_TARGET:
//                               IP[:port] IS the lobby host over http, any
//                               other target gets lobby.<env domain>
//   LOADTEST_PATH               default /api/v1/lobby-available-games?oc=demo&l=en
//   LOADTEST_LOG                default loadtest-results.tsv — one
//                               "<status>\t<time_seconds>" line per request
//   LOADTEST_GAME_PROBE_COUNT   default 3 — probes sent AFTER the loop, once
//                               per run, sequential and bounded
//   LOADTEST_GAME_PROBE_SCHEME  default https
//   LOADTEST_GAME_PROBE_HOST    default apig.rg-lgna.com
//   LOADTEST_GAME_PROBE_CODE    default balonismo; an EXPLICITLY EMPTY value
//                               disables the probe ("gameprobe: skipped")
//   LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT
//                               unset/empty = REPORT-ONLY (the game-path 3000
//                               wall must be VISIBLE, not flapping the
//                               workflow red); SET = exit 1 iff the probe
//                               error share STRICTLY exceeds it
//   LOADTEST_TOKEN_URL          unset/empty = lobby-only behavior exactly (no
//                               acquisition; summary token=none); SET = ONE
//                               player token is acquired from the broker
//                               BEFORE the run and the mode follows its
//                               source: mint => full mix, store => read GETs
//   LOADTEST_BROKER_SECRET      sent as `Authorization: Bearer <secret>` on
//                               the acquisition call
//   LOADTEST_REQUIRE_TOKEN      default 0: acquisition failure DEGRADES to
//                               lobby-only (warning, token=none, exit code
//                               unchanged); 1: acquisition failure is exit 2
//                               BEFORE any request
//   LOADTEST_GAME_CODE          default fortune-dragon — the gameCode the
//                               games and read APIs need
//   LOADTEST_OCS                default demo — the operator code (oc=/brandCode=)
//
// Exit codes: 0 success; 1 error share exceeds the threshold (and the game
// probe only when its threshold is set), OR the achieved rps= falls below the
// throughput floor when LOADTEST_MIN_RPS_PERCENT > 0; 2 config error — bad
// RPS, concurrency outside 1..64, negative/non-numeric thresholds, an
// unwritable results log, or REQUIRE_TOKEN=1 with a failed acquisition — all
// detected BEFORE any request.
//
// INVARIANT: the raw token NEVER appears in any line this script emits (log,
// warning, summary) — only the SOURCE name (mint|store|none). The token
// travels only inside request URLs and POST bodies, exactly like the bash.

import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// ── the weighted mix (port of worker/mix.js — the test pins the two copies) ──
// loadtest.mjs is mirrored into the runner repo alone (gha-repo-sync.sh ships
// only gha-runner/*), so it cannot import worker/mix.js at run time; the
// table is a PORT and scripts/tests/test-loadtest.mjs asserts it equals the
// Worker's — one table, three surfaces (Go types.go W*, worker/mix.js, here).
//
// Weight sits on the READ APIs rather than on minting: a pooled token is only
// replaced when a spin reports an exhausted wallet, so new-token is a
// last-resort refill and not traffic. WSS is absent by design: it runs
// outside the HTTP budget in Go (WSSPercent), so every slot here is HTTP.
export const ACTIONS = [
  { name: 'spin', weight: 31 },
  { name: 'config', weight: 15 },
  { name: 'balance', weight: 11 },
  { name: 'auth', weight: 9 },
  { name: 'history', weight: 9 },
  { name: 'details', weight: 9 },
  { name: 'lobby', weight: 7 },
  { name: 'env-config', weight: 4 },
  { name: 'client-config', weight: 4 },
  { name: 'new-token', weight: 1 },
];

export const TOTAL_WEIGHT = ACTIONS.reduce((sum, a) => sum + a.weight, 0); // 100

// MIX_SEED_BASE seeds each lane's PRNG (lane i: base + i*GOLDEN), so the mix
// is DETERMINISTIC — reproducible runs, assertable distribution — and lanes
// start out of phase instead of drawing in lockstep (the bash seeded its
// round-robin offset with the lane index for the same reason).
export const MIX_SEED_BASE = 0x5eed;
const LANE_PHASE = 0x9e3779b9;

// mulberry32: small, fast, seedable (verbatim port of worker/mix.js).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// pickAction mirrors Go's cumulative scan exactly: draw n in [0, total), walk
// the table subtracting each weight until the remainder falls inside one.
export function pickAction(rng, table = ACTIONS, total = TOTAL_WEIGHT) {
  if (total <= 0) return 'lobby';
  let n = Math.floor(rng() * total);
  for (const entry of table) {
    if (entry.weight <= 0) continue;
    if (n < entry.weight) return entry.name;
    n -= entry.weight;
  }
  return 'lobby';
}

// ── the WAF fingerprint ───────────────────────────────────────────────────
// REQUIRED on every request: the WAF 403s non-browser fingerprints
// (docs/bug-20261010-apig-403-linux-ua.md). Same set the bash curl sent.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function browserHeaders(referer, extra = {}) {
  return {
    'User-Agent': BROWSER_UA,
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer,
    ...extra,
  };
}

// ── scheme/host derivation (the ONE http-vs-https rule, from the bash) ─────
export function isIPv4(host) {
  const parts = String(host).split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => /^[0-9]+$/.test(p) && Number(p) <= 255);
}

// An IP[:port] or any explicitly ported target is http, an IP host without a
// port is http, every other target is https. Both the lobby URL and the read
// APIs call this, so the rule lives in exactly one place.
export function deriveScheme(target) {
  const t = String(target);
  if (/:[0-9]/.test(t)) return 'http';
  return isIPv4(t.split(':')[0]) ? 'http' : 'https';
}

// ── the UTC+7 operator-day window (Go's betsWindow, ported) ────────────────
// start = that day 17:00:00.000Z, end = next day 16:59:59.999Z, colons
// escaped like QueryEscape (the wire form the bash emitted). rolloverMs is
// the NEXT operator-day start: lanes recompute the window mid-run once now
// passes it (a run is up to 540 s, so it can straddle 17:00 UTC — Go
// recomputes betsWindow() per call for the same reason).
export function computeReadWindow(now = new Date()) {
  const shifted = new Date(now.getTime() + 7 * 3600_000);
  const dayStartMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 7 * 3600_000;
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
  const wire = (ms) => new Date(ms).toISOString().replace(/:/g, '%3A');
  return {
    day,
    start: wire(dayStartMs),
    end: wire(dayStartMs + 86_400_000 - 1),
    rolloverMs: dayStartMs + 86_400_000,
  };
}

// ── config (env contract) ─────────────────────────────────────────────────
// Every validation mirrors the bash one-for-one: a config error is returned,
// never thrown, and the caller exits 2 BEFORE any request.
export function parseConfig(env) {
  const get = (k, dflt) => (env[k] === undefined || env[k] === '' ? dflt : env[k]);
  const err = (message) => ({ ok: false, error: message });

  const target = get('LOADTEST_TARGET', 'apig.rg-lgna.com');
  const rpsRaw = get('LOADTEST_RPS', '5');
  const lanesRaw = get('LOADTEST_CONCURRENCY', '4');
  const durRaw = env.LOADTEST_DURATION_SECS === undefined ? '120' : env.LOADTEST_DURATION_SECS;
  const maxerrRaw = get('LOADTEST_MAX_ERROR_PERCENT', '50');
  const minrpsRaw = get('LOADTEST_MIN_RPS_PERCENT', '0');
  const gprobeCountRaw = get('LOADTEST_GAME_PROBE_COUNT', '3');
  const gprobeScheme = get('LOADTEST_GAME_PROBE_SCHEME', 'https');
  const gprobeHost = get('LOADTEST_GAME_PROBE_HOST', 'apig.rg-lgna.com');
  // '-' semantics, ported: only an UNSET code gets the default; an explicitly
  // EMPTY value is the documented probe disable.
  const gprobeCode = env.LOADTEST_GAME_PROBE_CODE === undefined ? 'balonismo' : env.LOADTEST_GAME_PROBE_CODE;
  // Empty (unset OR set-empty) = report-only; only a SET value gates.
  const gprobeMaxerr = env.LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT ?? '';

  const isPosNum = (v) => /^[0-9]+(\.[0-9]+)?$/.test(v) && Number(v) > 0;
  const isNonNegInt = (v) => /^[0-9]+$/.test(v);

  if (!isPosNum(rpsRaw)) return err(`LOADTEST_RPS must be a positive number, got [${rpsRaw}]`);
  if (!isNonNegInt(lanesRaw) || Number(lanesRaw) < 1) return err(`LOADTEST_CONCURRENCY must be a positive integer, got [${lanesRaw}]`);
  if (Number(lanesRaw) > 64) return err(`LOADTEST_CONCURRENCY must be at most 64, got [${lanesRaw}]`);
  if (!isNonNegInt(maxerrRaw)) return err(`LOADTEST_MAX_ERROR_PERCENT must be a non-negative integer, got [${maxerrRaw}]`);
  if (!isNonNegInt(minrpsRaw)) return err(`LOADTEST_MIN_RPS_PERCENT must be a non-negative integer, got [${minrpsRaw}]`);
  if (!isNonNegInt(gprobeCountRaw)) return err(`LOADTEST_GAME_PROBE_COUNT must be a non-negative integer, got [${gprobeCountRaw}]`);
  if (gprobeMaxerr !== '' && !isNonNegInt(gprobeMaxerr)) return err(`LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT must be a non-negative integer, got [${gprobeMaxerr}]`);

  // A non-integer duration falls back to the default; sub-second clamps up,
  // anything over the 10-minute Actions budget clamps to 540.
  let dur = isNonNegInt(durRaw) ? Number(durRaw) : 120;
  if (dur < 1) dur = 1;
  if (dur > 540) dur = 540;

  const tokenUrl = env.LOADTEST_TOKEN_URL ?? '';
  const brokerSecret = env.LOADTEST_BROKER_SECRET ?? '';
  const requireToken = get('LOADTEST_REQUIRE_TOKEN', '0') === '1';
  // Fail fast on the combination that can only ever fail: a broker URL with
  // REQUIRE_TOKEN=1 but no secret means the broker 401s every attempt and the
  // run would exit 2 anyway — catch it BEFORE any request (bash parity).
  if (tokenUrl !== '' && requireToken && brokerSecret === '') {
    return err('LOADTEST_TOKEN_URL is set with REQUIRE_TOKEN=1 but LOADTEST_BROKER_SECRET is empty — the broker would 401 every attempt; set the secret or drop REQUIRE_TOKEN');
  }

  // Lobby derivation: both scheme and host set explicitly => they win;
  // otherwise each derives from TARGET (an IP[:port] target IS the lobby host
  // over http — mirror of Go's envDomain fallback; anything else derives
  // lobby.<env domain>, e.g. apig.rg-lgna.com -> lobby.rg-lgna.com).
  const targetHost = target.split(':')[0];
  const scheme = env.LOADTEST_LOBBY_SCHEME || deriveScheme(target);
  let host = env.LOADTEST_LOBBY_HOST;
  if (!host) host = isIPv4(targetHost) ? target : `lobby.${target.includes('.') ? target.slice(target.indexOf('.') + 1) : target}`;
  const reqPath = get('LOADTEST_PATH', '/api/v1/lobby-available-games?oc=demo&l=en');
  const lobbyUrl = `${scheme}://${host}${reqPath}`;

  // The games/read APIs live on the API host (LOADTEST_TARGET itself — Go's
  // apiHost), NOT on the derived lobby host.
  const readScheme = deriveScheme(target);
  const readHost = target;
  // The per-game client host that serves env-config.js / config.json (Go's
  // fun.gameHost): <game>.<env domain>. No derivable domain (an IP target)
  // => '' and those two actions are off, exactly like Go with an empty
  // gameHost — never a request to an invented path.
  const gameCode = get('LOADTEST_GAME_CODE', 'fortune-dragon');
  const gameHost = isIPv4(targetHost)
    ? ''
    : `${readScheme}://${gameCode}.${target.includes('.') ? target.slice(target.indexOf('.') + 1) : target}`;

  return {
    ok: true,
    cfg: {
      target,
      rps: Number(rpsRaw),
      lanes: Number(lanesRaw),
      dur,
      maxerr: Number(maxerrRaw),
      minrps: Number(minrpsRaw),
      scheme,
      host,
      lobbyUrl,
      lobbyFallbackUrl: `${readScheme}://${readHost}${reqPath}`,
      reqPath,
      log: get('LOADTEST_LOG', 'loadtest-results.tsv'),
      gprobeCount: Number(gprobeCountRaw),
      gprobeScheme,
      gprobeHost,
      gprobeCode,
      gprobeMaxerr,
      tokenUrl,
      brokerSecret,
      requireToken,
      gameCode,
      ocs: get('LOADTEST_OCS', 'demo'),
      readScheme,
      readHost,
      gameHost,
    },
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────
// One bounded request: 15 s per load-test call (the bash curl -m 15), 30 s
// for the broker (its --max-time 30). A transport failure answers status 000
// / t=0 — the bash recorded exactly that for a failed curl, so a dead target
// inflates err% instead of hanging the lane.
async function httpRequest(fetchFn, url, { method = 'GET', body, headers, timeoutMs = 15000 } = {}) {
  const started = performance.now();
  try {
    const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) init.body = body;
    const resp = await fetchFn(url, init);
    let text = '';
    try {
      text = await resp.text();
    } catch {
      // unreadable body: the STATUS still counts, the verdict body is empty
    }
    return { status: resp.status, text, secs: (performance.now() - started) / 1000 };
  } catch {
    return { status: 0, text: '', secs: 0 };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// acquireToken: 3 bounded attempts (bash parity), retries sleeping 1x/2x the
// delay. An unparseable or sourceless 2xx body is a FAILURE — never an
// invented token; source must be exactly mint or store.
async function acquireToken(cfg, fetchFn, delayMs) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await httpRequest(fetchFn, cfg.tokenUrl, {
      headers: cfg.brokerSecret ? { Authorization: `Bearer ${cfg.brokerSecret}` } : {},
      timeoutMs: 30_000,
    });
    if (res.status >= 200 && res.status < 300) {
      try {
        const parsed = JSON.parse(res.text);
        const token = typeof parsed?.token === 'string' ? parsed.token : '';
        const source = typeof parsed?.source === 'string' ? parsed.source : '';
        if ((source === 'mint' || source === 'store') && token !== '') return { token, source };
      } catch {
        // fall through to the retry
      }
    }
    if (attempt < 3) await sleep(attempt * delayMs);
  }
  return null;
}

// ── verdicts (ports of Go games.go markTokenState helpers) ─────────────────
// A spin body says the WALLET is done: the lane keeps its token but every
// later spin slot becomes a read (Go callReadOnly) — one doomed spin per
// lane, never one per request.
function isSpentTokenBody(text) {
  if (text.includes('Insufficient balance')) return true;
  if (text.includes('"code":1603') || text.includes('"code": 1603')) return true;
  return text.toLowerCase().includes('insufficient fund');
}

// A spin body says the SESSION is dead (expired): the token is fine, so the
// lane re-authorizes and keeps spinning (Go discards the session and
// bootstraps a fresh one).
function isSessionInvalidBody(text) {
  return text.includes('Invalid player session');
}

// minPositive: the smallest strictly-positive entry of a bet list — the
// minimum stake the game actually allows; null when the list holds no usable
// entry (empty, all zero/negative). NEVER guess a stake: a guessed betSize is
// a known gateway 400.
function minPositive(opts) {
  if (!Array.isArray(opts)) return null;
  let best = null;
  for (const o of opts) {
    const value = typeof o?.value === 'number' ? o.value : NaN;
    if (!(value > 0)) continue;
    if (best === null || value < best) best = value;
  }
  return best;
}

// applyStake derives the spin stake from a /{code}/config body (Go
// fireConfig): betSize = smallest usable entry (none => -1, spin disabled),
// betLevel = smallest usable entry (default 1). An unparseable body keeps
// the previous stake — the next config action retries it.
function applyStake(state, text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return;
  }
  const bs = minPositive(v?.betSizes);
  state.betSize = bs === null ? -1 : bs;
  state.betLevel = minPositive(v?.betLevels) ?? 1;
}

// ── URLs (verbatim shapes from the Go call sites — PROVEN on the gateway) ──
const balanceUrl = (ctx) => `${ctx.api}/api/v2/balance?oc=${ctx.cfg.ocs}&t=${ctx.token}`;
const historyUrl = (ctx) => {
  const w = ctx.window();
  return `${ctx.api}/api/bets?brandCode=${ctx.cfg.ocs}&gameCode=${ctx.cfg.gameCode}&playerToken=${ctx.token}&startDate=${w.start}&endDate=${w.end}&skip=0&limit=20`;
};
const detailsUrl = (ctx) => {
  const w = ctx.window();
  return `${ctx.api}/api/total-bets?brandCode=${ctx.cfg.ocs}&gameCode=${ctx.cfg.gameCode}&playerToken=${ctx.token}&startDate=${w.start}&endDate=${w.end}`;
};
const configUrl = (ctx) =>
  `${ctx.api}/${ctx.cfg.gameCode}/config?brandCode=${ctx.cfg.ocs}&gameCode=${ctx.cfg.gameCode}&playerToken=${ctx.token}`;
const spinUrl = (ctx) => `${ctx.api}/${ctx.cfg.gameCode}/spin`;
const authUrl = (ctx) => `${ctx.api}/client/player/authorize-game`;

// ── actions ───────────────────────────────────────────────────────────────
async function doAuthorize(ctx, state) {
  const res = await ctx.send(authUrl(ctx), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Plain JSON, exactly the three fields the game client posts (Go
    // fireAuthorize); the gateway rejects a gzipped body with HTTP 400.
    body: JSON.stringify({ gameCode: ctx.cfg.gameCode, brandCode: ctx.cfg.ocs, playerToken: ctx.token }),
  });
  state.authorized = res.status === 200 || res.status === 201;
  return res;
}

async function doConfig(ctx, state) {
  const res = await ctx.send(configUrl(ctx));
  if (res.status === 200) applyStake(state, res.text);
  return res;
}

async function doBalance(ctx) {
  return ctx.send(balanceUrl(ctx));
}
async function doHistory(ctx) {
  return ctx.send(historyUrl(ctx));
}
async function doDetails(ctx) {
  return ctx.send(detailsUrl(ctx));
}

// doLobby hits the derived lobby host; on a TRANSPORT failure it retries the
// apig host once — that host serves the identical catalog path (Go's
// lobbyCatalogURLs last hop), so a DNS/dead-lobby-host blip does not eat the
// slot. Both attempts are recorded: one TSV line per real request.
async function doLobby(ctx) {
  const res = await ctx.send(ctx.cfg.lobbyUrl);
  if (res.status === 0) return ctx.send(ctx.cfg.lobbyFallbackUrl);
  return res;
}

// doSpin places one bet. It returns { substituted: true } when no usable
// stake could be loaded: the caller spends the slot on an honest read — a
// config with no usable betSize degrades the slot, it never guesses.
async function doSpin(ctx, state) {
  // Config must be loaded before spinning; fetch on demand rather than
  // skipping (Go callSpin fires config when the stake is missing).
  if (state.betSize <= 0) await doConfig(ctx, state);
  if (state.betSize <= 0) return { substituted: true };
  const res = await ctx.send(spinUrl(ctx), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The exact payload the game client posts to the gateway — the six
    // fields internal/loadtest/api_contract_test.go pins; baseBet is NOT
    // sent (the server derives it).
    body: JSON.stringify({
      gameCode: ctx.cfg.gameCode,
      brandCode: ctx.cfg.ocs,
      playerToken: ctx.token,
      betSize: state.betSize,
      betLevel: state.betLevel,
      walletType: 'CASH',
    }),
  });
  if (res.status === 200 || res.status === 201) return { spun: true };
  if (isSpentTokenBody(res.text)) {
    state.noBalance = true; // keep the token for reads, degrade the spin slots
    return { spun: true, degraded: true };
  }
  if (isSessionInvalidBody(res.text)) await doAuthorize(ctx, state); // dead session, fine token
  return { spun: true };
}

// The read endpoints a token (spent or store-sourced) can still serve —
// Go's readActions, minus nothing: no bet, no mint, ever.
const READ_ACTIONS = ['history', 'config', 'balance', 'details', 'lobby'];

async function doRead(ctx, state, rng, name) {
  const action = name ?? READ_ACTIONS[Math.floor(rng() * READ_ACTIONS.length)];
  switch (action) {
    case 'history':
      return doHistory(ctx);
    case 'details':
      return doDetails(ctx);
    case 'balance':
      return doBalance(ctx);
    case 'config':
      return doConfig(ctx, state);
    case 'lobby':
    default:
      return doLobby(ctx);
  }
}

// The non-spin full-mix actions.
async function doFullAction(ctx, state, action) {
  switch (action) {
    case 'auth':
      return doAuthorize(ctx, state);
    case 'new-token':
      // Go's WNewTok slot is the last-resort token refill; the runner never
      // mints, so the slot refreshes the SESSION — a re-authorize, which is
      // the only session refresh this surface has.
      return doAuthorize(ctx, state);
    case 'config':
      return doConfig(ctx, state);
    case 'balance':
      return doBalance(ctx);
    case 'history':
      return doHistory(ctx);
    case 'details':
      return doDetails(ctx);
    case 'lobby':
      return doLobby(ctx);
    case 'env-config': {
      const url = ctx.cfg.gameHost ? `${ctx.cfg.gameHost}/env-config.js?isFun=true` : '';
      if (!url) return null; // no derivable client host: the action is off (Go parity)
      return ctx.send(url);
    }
    case 'client-config': {
      const url = ctx.cfg.gameHost ? `${ctx.cfg.gameHost}/config.json?isFun=true` : '';
      if (!url) return null;
      return ctx.send(url);
    }
    default:
      return doLobby(ctx);
  }
}

// ── one lane ──────────────────────────────────────────────────────────────
// Each lane paces its share of the budget (one request every lanes/rps
// seconds) until the deadline — the bash loop's shape, await-based.
async function runLane(ctx, idx, deadline) {
  // Per-lane session: authorized/noBalance/stake, exactly Go's Session fields
  // the mix reacts to.
  const state = { authorized: false, noBalance: false, betSize: -1, betLevel: 1 };
  const rng = mulberry32((MIX_SEED_BASE + idx * LANE_PHASE) >>> 0);
  let rr = idx; // read-mode rotation offset, seeded by the lane index (de-phased lanes)
  const intervalMs = (ctx.cfg.lanes / ctx.cfg.rps) * 1000;

  if (ctx.mode === 'full') {
    // Bootstrap like Go's worker: authorize once per lane, then load the
    // stake config; both are real requests and both are recorded.
    await doAuthorize(ctx, state);
    await doConfig(ctx, state);
  }

  while (Date.now() < deadline) {
    if (ctx.token) ctx.rollWindow(idx);
    if (ctx.mode === 'full') {
      const action = pickAction(rng);
      if (action === 'spin') {
        if (state.noBalance) {
          // The wallet-level form of the three-level rule: this lane's spin
          // slots become reads for the rest of the run (Go callReadOnly) —
          // the slot still issues a real request, so the RPS budget and the
          // success counters stay honest.
          await doRead(ctx, state, rng);
        } else {
          const r = await doSpin(ctx, state);
          if (r.substituted) await doRead(ctx, state, rng);
        }
      } else {
        await doFullAction(ctx, state, action);
      }
    } else if (ctx.mode === 'read') {
      // The bash round-robin, ported exactly: balance, history, details,
      // config, lobby, cycling — offset by the lane index so lanes never
      // walk the rotation in lockstep. Read-only by construction: spin and
      // authorize are not in this rotation.
      rr += 1;
      const name = rr === 1 ? 'balance' : rr === 2 ? 'history' : rr === 3 ? 'details' : rr === 4 ? 'config' : 'lobby';
      if (rr > 4) rr = 0;
      await doRead(ctx, state, rng, name);
    } else {
      await doLobby(ctx);
    }
    // pace: the lane's share of the budget, capped at the remaining time;
    // stop when the remainder is too small to be worth a request (bash: rem
    // <= 0.05 s breaks the loop).
    const rem = deadline - Date.now();
    if (rem <= 50) break;
    await sleep(Math.min(intervalMs, rem));
  }
}

// ── the run ───────────────────────────────────────────────────────────────
// Test seam: { env, fetchFn, out, errOut, acquireDelayMs }. out/errOut receive
// the EMITTED LINES (no timestamp) so tests can assert the token-leak
// invariant on exactly what the script prints.
export async function runLoadtest({ env = {}, fetchFn, out, errOut, acquireDelayMs = 1000 } = {}) {
  const log = out ?? ((line) => console.log(line));
  const warn = errOut ?? ((line) => console.error(line));
  const stamp = () => `${new Date().toISOString().slice(0, 19)}Z`;
  const emit = (line) => log(`${stamp()} ${line}`);
  const fail = (line) => warn(`loadtest.mjs: ${line}`);

  const parsed = parseConfig(env);
  if (!parsed.ok) {
    fail(parsed.error);
    return 2;
  }
  const cfg = parsed.cfg;

  // The results log must be writable BEFORE any request (bash: exit 2).
  try {
    writeFileSync(cfg.log, '');
  } catch {
    fail(`cannot write results log at ${cfg.log}`);
    return 2;
  }

  // ── token acquisition and the mode decision ─────────────────────────────
  // mint => full mix; store => read GETs; none => lobby-only. The raw token
  // never enters an emitted line — only the SOURCE name.
  let token = '';
  let tokenSrc = 'none';
  let mode = 'lobby';
  if (cfg.tokenUrl !== '') {
    const got = await acquireToken(cfg, fetchFn ?? globalThis.fetch, acquireDelayMs);
    if (got) {
      token = got.token;
      tokenSrc = got.source;
      mode = got.source === 'mint' ? 'full' : 'read';
    } else if (cfg.requireToken) {
      fail('token acquisition from LOADTEST_TOKEN_URL failed and LOADTEST_REQUIRE_TOKEN=1');
      return 2;
    } else {
      fail('token acquisition from LOADTEST_TOKEN_URL failed - degrading to lobby-only (token=none)');
    }
  }

  let window = computeReadWindow();

  // ── recording (one TSV line per real request) ───────────────────────────
  const records = [];
  const record = (status, secs) => {
    records.push({ status, secs });
    try {
      // 3-digit status, exactly the bash TSV: curl -w %{http_code} recorded
      // 000 for a refused/timed-out request, and every consumer of
      // loadtest-results.tsv parses <status> as 3 digits.
      appendFileSync(cfg.log, `${String(status).padStart(3, '0')}\t${secs.toFixed(6)}\n`);
    } catch {
      // a failed append must not kill the run — the summary still counts it
    }
  };
  const referer = `${cfg.scheme}://${cfg.host}/`;
  const send = async (url, opts = {}) => {
    const res = await httpRequest(fetchFn, url, { ...opts, headers: browserHeaders(referer, opts.headers ?? {}) });
    record(res.status, res.secs);
    return res;
  };

  const ctx = {
    cfg,
    token,
    mode,
    send,
    api: `${cfg.readScheme}://${cfg.readHost}`,
    window: () => window,
    // The operator day may roll past UTC+7 midnight mid-run; recompute once
    // now passes the rollover (Go betsWindow() recomputes per call). A failed
    // recompute cannot happen here (pure arithmetic) — the guard shape stays
    // so a future clock edge keeps the previous window rather than a
    // half-set one.
    rollWindow: (laneIdx) => {
      if (Date.now() < window.rolloverMs) return;
      const w = computeReadWindow(new Date());
      if (w && w.day !== window.day) {
        window = w;
        emit(`read window rolled to the new UTC+7 operator day ${w.day} (lane ${laneIdx})`);
      }
    },
  };

  const startMs = Date.now();
  const deadline = startMs + cfg.dur * 1000;
  emit(`loadtest start: ${cfg.lobbyUrl} rps=${cfg.rps} lanes=${cfg.lanes} duration=${cfg.dur}s (target=${cfg.target})`);
  await Promise.all(Array.from({ length: cfg.lanes }, (_, i) => runLane(ctx, i + 1, deadline)));

  // ── game-path probe ─────────────────────────────────────────────────────
  // AFTER the loop — once per run, never per lane — probe /{code}/config: the
  // GHA egress is the only runtime still getting clean 200s, so this is the
  // only sensor that can surface the gateway's game-path "Error Code: 3000"
  // verdict before the lobby itself fails. Sequential, bounded, REPORT-ONLY
  // unless a threshold is set (the wall must be VISIBLE, not flapping the
  // workflow red). Probe requests do NOT enter the TSV/summary accounting
  // (bash parity).
  let gSent = 0;
  let gFail = 0;
  const gStatuses = [];
  const gBodies = [];
  if (cfg.gprobeCode === '') {
    log('gameprobe: skipped');
  } else {
    const gUrl = `${cfg.gprobeScheme}://${cfg.gprobeHost}/${cfg.gprobeCode}/config`;
    for (let i = 0; i < cfg.gprobeCount; i++) {
      const res = await httpRequest(fetchFn ?? globalThis.fetch, gUrl, {
        headers: browserHeaders(`${cfg.gprobeScheme}://${cfg.gprobeHost}/`),
      });
      gSent += 1;
      gStatuses.push(res.status);
      if (res.status >= 200 && res.status < 300) continue;
      gFail += 1;
      // The verdict lives in the BODY (a generic 400 says nothing): keep the
      // first ~40 chars of each non-2xx body, flattened to one line.
      gBodies.push(res.text.replace(/[\n\r\t]/g, ' ').slice(0, 40) || '-');
    }
    log(`gameprobe: sent=${gSent} ok=${gSent - gFail} fail=${gFail} statuses="${gStatuses.join(',')}" bodies="${gBodies.length > 0 ? gBodies.join(',') : '-'}"`);
  }

  // ── summary ─────────────────────────────────────────────────────────────
  // p50/p95 by nearest rank over the sorted per-request times; max is the
  // last. Fields APPEND, never reorder: the trailing minrps=/token= and the
  // new mix= (full|read|lobby — the mode, never the token).
  const sent = records.length;
  const okCount = records.filter((r) => r.status >= 200 && r.status < 300).length;
  const failCount = sent - okCount;
  const times = records.map((r) => r.secs).sort((a, b) => a - b);
  const ceil = (x) => (Number.isInteger(x) ? x : Math.floor(x) + 1);
  const rank = (p) => (sent === 0 ? 0 : times[ceil(p * sent) - 1]);
  const rps = sent > 0 ? sent / cfg.dur : 0;
  const errPct = sent > 0 ? (100 * failCount) / sent : 0;
  const gErrField = cfg.gprobeCode === '' ? '-' : gSent > 0 ? ((100 * gFail) / gSent).toFixed(1) : '0.0';
  const floor = cfg.minrps > 0 ? (cfg.rps * cfg.minrps) / 100 : null;
  const rpsPrinted = rps.toFixed(1);
  log(
    `summary: sent=${sent} ok=${okCount} fail=${failCount} duration=${cfg.dur} rps=${rpsPrinted} err%=${errPct.toFixed(1)} ` +
      `p50=${rank(0.5).toFixed(3)} p95=${rank(0.95).toFixed(3)} max=${sent === 0 ? '0.0' : times[times.length - 1].toFixed(3)} ` +
      `game_err%=${gErrField} minrps=${floor === null ? 'off' : floor.toFixed(1)} token=${tokenSrc} mix=${mode}`,
  );

  // ── gates (STRICTLY exceeds, bash parity: 100% errors with a threshold of
  // 100 does NOT trip it) ─────────────────────────────────────────────────
  if (errPct > cfg.maxerr) {
    fail(`error share exceeds LOADTEST_MAX_ERROR_PERCENT=${cfg.maxerr}`);
    return 1;
  }
  if (cfg.gprobeMaxerr !== '' && gSent > 0 && (100 * gFail) / gSent > Number(cfg.gprobeMaxerr)) {
    fail(`game probe error share exceeds LOADTEST_GAME_PROBE_MAX_ERROR_PERCENT=${cfg.gprobeMaxerr}`);
    return 1;
  }
  // Throughput floor: compared against the PRINTED rps, so the gate and the
  // summary can never disagree; floor=off (MINRPS=0) skips the gate.
  if (floor !== null && Number(rpsPrinted) < Number(floor.toFixed(1))) {
    fail(`achieved rps ${rpsPrinted} is below the throughput floor ${floor.toFixed(1)} (LOADTEST_MIN_RPS_PERCENT=${cfg.minrps} of LOADTEST_RPS=${cfg.rps})`);
    return 1;
  }
  return 0;
}

async function main() {
  const code = await runLoadtest({ env: process.env, fetchFn: globalThis.fetch });
  process.exitCode = code;
}

// Run only when executed directly — `node --test` imports this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`loadtest.mjs: fatal: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
}
