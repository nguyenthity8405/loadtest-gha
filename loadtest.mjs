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
// DRAINED WALLET (a deliberate DIVERGENCE from Go — Go parks a drained
// worker BY DESIGN and recovers only via IP rotation replacing the machine
// (controller.go:1502 os.Exit → fresh Fly machine); takeFromStore exists
// but is not drain-triggered and never reaches a parked worker, so it is
// NOT the recovery model here): a source=mint spin reporting an exhausted
// wallet arms ONE run-scoped re-acquisition — the
// shared postgres store behind the broker serves every platform, and the
// operator's architecture says a platform that needs a token READS one
// from that store when it's needed. mint => the run resumes spins (every lane
// re-authorizes once: the session was bound to the old token); store => the
// three-level rule holds and the remainder reads; failure => a warning and
// honest reads, NEVER a different exit code. One attempt per run, shared by
// every lane: the broker enforces a 5s mint spacing gate, so N lanes
// draining together must not stampede it. A source=store run never
// re-acquires — it is ALREADY the read-only fallback.
//
// Orthogonal to (and layered ON TOP of) that rule: GAME_WALL_CONSECUTIVE
// game-path responses carrying the WAF "Error Code: 3000" signature degrade
// the WHOLE run to lobby-only for the remainder — GitHub's egress is walled
// on the game path while the CATALOG path (the apig gateway) stays
// reachable (docs/bug-20261012-gha-keeps-firing-a-walled-game-path.md). mix= still
// names the source-selected mode; the summary reports the degradation as
// wall=game-path. The ORTHOGONAL spin-side refusal guard (SPIN_REFUSAL_CONSECUTIVE) is the per-game sibling: N consecutive provider-403 bet verdicts degrade that game's spin slots to reads, reported as refusal=<game[+game…]> — one entry per refusing game (Go's badGames holds more than one title).
//
// The runner NEVER mints (/client/player/fun-mode-token) and never holds a
// fleet token: supply is broker acquisitions only — one before the run plus
// at most ONE mid-run re-acquisition when a source=mint wallet drains.
//
// PER-TOKEN SPIN CAP (the operator's fleet-wide contract; the constant lives
// in ./loadtest-config.mjs so it ships with the config surface): a token is
// spun at most SPIN_CAP_PER_TOKEN (60) times — doSpin counts REAL spin POSTs
// only (read actions and skipped/substituted slots never count) and its
// PRE-DISPATCH gate at the cap fires the SAME run-scoped refill latch the
// wallet drain uses: mint => a fresh token + epoch bump (every lane
// re-authorizes once) and the count restarts at 0; store => the three-level
// rule holds and the remainder reads; failure or a spent latch => honest
// reads with the cap still enforced — never a 61st spin on the old token,
// never a second acquisition.
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
//   LOADTEST_MIN_RPS_RETRIES    default 2 — extra measurement windows (each
//                               LOADTEST_DURATION_SECS long) run when the
//                               first window misses the floor; the BEST
//                               printed rps across windows is judged — one
//                               slow window cannot fail a healthy run. 0
//                               restores the single-window gate; clamped to
//                               5, and retry windows never push total load
//                               time past 540 s (the Actions budget), so at
//                               duration=540 no retry fits
//   LOADTEST_LOBBY_SCHEME       default derived: http for an IP[:port] target,
//                               https otherwise (ONE rule, shared with the
//                               read APIs — ported from bash derive_scheme)
//   LOADTEST_LOBBY_HOST         default derived from LOADTEST_TARGET: the
//                               games API GATEWAY — apig.rg-lgna.com, the
//                               "apig" sub-domain (the lobby host is dead:
//                               it answers an HTML 403 block page, probed
//                               2026-10-21). An IP[:port] target serves the
//                               path itself; the sandbox family has no apig
//                               host, so its own API host serves it there
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
//                               BEFORE the run (plus at most ONE mid-run
//                               re-acquisition when a source=mint wallet
//                               drains) and the mode follows its source:
//                               mint => full mix, store => read GETs
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
// probe only when its threshold is set), OR the BEST achieved rps= across up
// to 1+LOADTEST_MIN_RPS_RETRIES measurement windows falls below the
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

// ── the ONE local import — the config/derivation module ────────────────────
// parseConfig / deriveScheme / isIPv4 / computeReadWindow moved VERBATIM to
// ./loadtest-config.mjs when this file reached 999/1000 lines (the
// worker/loopdo.js split precedent). The runner repo receives the sibling
// BESIDE this file: gha-repo-sync.sh's :114 existence gate and BOTH mirror
// cycles (main + trigger) ship it, gha-health.sh drift-checks it, so
// `./loadtest-config.mjs` resolves in the runner checkout exactly as it
// does here. Proven by experiment 2026-10-16, not by reasoning: a scratch
// directory holding ONLY the mirror set (this file + the sibling, NO
// package.json, NO node_modules) ran `node ./loadtest.mjs` to a full
// summary — ESM resolves a ./relative specifier against the importing
// module's own URL with no package.json involved — while the same file
// WITHOUT the sibling died ERR_MODULE_NOT_FOUND. The failure mode was
// always file ABSENCE, so test-loadtest.mjs's shipping-coherence pins now
// allow exactly this ONE sibling (and pin the sync script's shipping set
// to carry it) instead of demanding node:-only specifiers.
import { acquireToken, computeReadWindow, httpRequest, parseBrokerAnswer, parseConfig, releaseLentToken, sleep, SPIN_CAP_PER_TOKEN } from './loadtest-config.mjs';
// Re-exported so every existing importer — the node --test suites import
// them from HERE — keeps resolving them from loadtest.mjs unchanged; no
// test or tool ever imports the sibling directly.
export { acquireToken, computeReadWindow, deriveScheme, httpRequest, isIPv4, parseBrokerAnswer, parseConfig, releaseLentToken, sleep, SPIN_CAP_PER_TOKEN } from './loadtest-config.mjs';

// ── the weighted mix (port of worker/mix.js — the test pins the two copies) ──
// loadtest.mjs is mirrored into the runner repo alone (gha-repo-sync.sh ships
// only gha-runner/*), so it cannot import worker/mix.js at run time; the
// table is a PORT and scripts/tests/test-loadtest.mjs asserts it equals the
// Worker's — one table, three surfaces (Go types.go W*, worker/mix.js, here).
//
// The mix is BET-FIRST (the operator's 2026-10-26 direction, mirrored from
// Go): spin is the majority on its own, the reads together are smaller than
// it, and new-token carries real weight so a wallet the gateway refused can
// be replaced while the run keeps betting. WSS is absent by design: it runs
// outside the HTTP budget in Go (WSSPercent), so every slot here is HTTP.
export const ACTIONS = [
  { name: 'spin', weight: 55 },
  { name: 'config', weight: 5 },
  { name: 'balance', weight: 5 },
  { name: 'auth', weight: 5 },
  { name: 'history', weight: 4 },
  { name: 'details', weight: 4 },
  { name: 'lobby', weight: 4 },
  { name: 'env-config', weight: 4 },
  { name: 'client-config', weight: 4 },
  { name: 'new-token', weight: 10 },
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

// ── scheme/host derivation, the UTC+7 operator-day window, the env contract ─
// isIPv4 / deriveScheme / computeReadWindow / parseConfig live in
// ./loadtest-config.mjs now (the split above) — moved VERBATIM, behaviour
// unchanged, re-exported from the import block. They are pure functions
// with no run-time dependencies, which is exactly why they are the half
// that could leave: everything that talks to the network, judges a
// response or prints the summary stays in THIS file.
// ── HTTP + the broker client ──────────────────────────────────────────────
// httpRequest, sleep and acquireToken live in ./loadtest-config.mjs now (the
// 2026-10-21 split, the second time this file hit the 1000-line cap): the
// bounded request, the retrying broker client and the answer parser are one
// seam — the BROKER PROTOCOL — and they are pure enough to travel with the
// config. Everything that judges a response or prints the summary stays in
// THIS file.
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

// ── the game-path egress wall ─────────────────────────────────────────────
// GitHub's Azure egress (AS8075) is WAF-blocked on the GAME PATH: every apig
// game request answers the gateway's "Error Code: 3000" wall (HTTP 400/403
// with that body) while the LOBBY host stays reachable — a live run summary
// read sent=427 ok=288 fail=139 err%=32.6 mix=full game_err%=100.0, i.e. ~40%
// of the budget fired at a surface that provably refuses this egress BEFORE
// the request is sent. Same principle as Go's callReadOnly and the error-rate
// rotation guard (internal/loadtest/games.go): never keep sending to a
// surface that has PROVEN it will refuse you.
//
// GAME_WALL_CONSECUTIVE = 3: high enough that a single flaky 400 (or a
// wallet/session verdict 400 — those are NOT walls) cannot degrade a healthy
// run, low enough that a walled run stops burning its doomed budget within
// ~3 game-path slots instead of the observed ~40% of the run.
export const GAME_WALL_CONSECUTIVE = 3;

// The DISCRIMINATING wall marker. The gateway's other error text — the
// generic "Error processing your request" envelope — also wraps ordinary
// wallet, session and provider verdicts (loadtest-stderr.log:2276 shows
// "...Insufficient balance" inside it; provider-403-game-never-banned.md
// documents a 403 carrying the phrase on a healthy egress). The phrase alone
// must NOT count toward degradation: 3 consecutive wallet verdicts would flip
// wall.degraded and silently end the run's spin coverage on a HEALTHY egress.
// Only "Error Code: 3000" identifies the egress wall. worker/catalog.js
// keeps the phrase too, but there it feeds classify → 'unverified' (the safe
// direction — it never bans a game), never a degradation trigger.
export const WALL_MARKERS = ['Error Code: 3000'];

// isWallBody: ONLY the discriminating "Error Code: 3000" text matches — a body carrying just
// the JSON ("code":3000) variant does NOT (deliberate: worker/catalog.test.js pins that shape
// a NON-wall, and the live wall bodies carry the phrase — e.out, bug-20261011 fleet mints).
function isWallBody(text) {
  return typeof text === 'string' && WALL_MARKERS.some((m) => text.includes(m));
}

// isWallResponse: the signature must ride the wall's OWN statuses (400/403).
// Status alone judges nothing — a 400 "Insufficient balance" is a wallet
// verdict, not an egress verdict — and the body alone judges nothing either.
// Deliberately narrow: a non-wall 400/403 resets the consecutive counter
// instead of counting toward degradation.
export function isWallResponse(res) {
  return !!res && (res.status === 400 || res.status === 403) && isWallBody(res.text);
}

// isDemoBetRefusal — provider error code 1305, the demo-bet refusal: "this egress may not place bets in demo mode" (2026-10-15: SPIN=0/325 while every read succeeded; the same payload answered 201 from a non-Brazil egress — the verdict keys on WHERE the request leaves, not what it sends). Go dispatches a 4xx carrying it to its OWN class ahead of every other branch (stats.go demoBetRefusal → "DEMO_1305", commits 7659177/8b1ffeb; worker/bridge.js isDemoBetRefusal is the JS port, d723540/2142cc1) because a demo refusal and a blocked egress demand OPPOSITE responses (stop rotating vs rotate): this surface counts them apart as demo1305= in the summary while they stay inside fail= (an ordinary HTTP failure for the error-rate guard — Go's own rule) and fail403= (a 1305 IS an HTTP 403: Go counts the transport-level 403 and classifies the verdict separately). BOTH gateway spellings match, gated to a 4xx exactly like Go/bridge.js, and the trailing \b keeps "Error Code: 13050" and "code":11305 from ever matching; the literal is Go's rxDemoBetCode VERBATIM (test-loadtest-go-sentinels.mjs reads it out of stats.go as text, so a phrasing change there is decided on the same change here), and none of this can reach the wall — isWallResponse above still judges "Error Code: 3000" ALONE, untouched, so a 1305 run never degrades to lobby-only and never reads as egress refused.
export function isDemoBetRefusal(res) { const s = Number(res?.status); if (!Number.isInteger(s) || s < 400 || s >= 500) return false; return /"code"\s*:\s*"?\s*1305\b|Error\s+Code:\s*1305\b/.test(typeof res?.text === 'string' ? res.text : ''); }

// SPIN_REFUSAL_CONSECUTIVE: N CONSECUTIVE bet-endpoint 403s WITHOUT the wall marker are
// that GAME's provider verdict (docs/bugs/provider-403-game-never-banned.md — the reads
// prove the session/egress healthy), so THAT game's spin slots become reads for the rest
// of the run, one-way like the wall. A "Error Code: 3000" 403 belongs to the wall streak
// only, a wallet/session verdict at any status judges nothing (banGameOnFailure's
// exclusion), a DEMO_1305 verdict judges nothing either (Go's isTokenVerdictBody arm,
// eb92051 — the drain owns it at loadtest.mjs:489; live 2026-10-20 runs ended
// refusal=fortune-dragon off ONE wallet's verdicts), and non-spin answers judge nothing
// either (the gate at noteRefusal below).
export const SPIN_REFUSAL_CONSECUTIVE = 3;

// ── the per-game refusal LIST (Go's badGames — the set bans more than one title) ─────
// ONE streak + one ban PER GAME CODE, keyed by the game path segment the REQUEST
// carried (gameOf), never by config: a first refusal is never end-of-story — a second
// game that starts refusing trips ITS OWN streak while healthy siblings keep betting,
// and the trip cost stays N evidence bets per game: one warning per banned game, ever.
export function makeRefusalGuard(warn = () => {}) { const streaks = new Map(), banned = new Set(); return {
  note(game, res) { if (game === '' || banned.has(game)) return; // no game key, no judgement; a banned game is never re-judged (one-way)
    if (res.status === 403 && !isWallResponse(res) && !isSpentTokenBody(res.text) && !isSessionInvalidBody(res.text) && !isDemoBetRefusal(res)) {
      const n = (streaks.get(game) ?? 0) + 1;
      if (n >= SPIN_REFUSAL_CONSECUTIVE) { banned.add(game); warn(`the game ${game} refused ${SPIN_REFUSAL_CONSECUTIVE} consecutive spins (provider 403) - its spin slots become reads for the rest of the run`); } else streaks.set(game, n);
    } else streaks.set(game, 0);
  },
  has: (game) => banned.has(game), list: () => [...banned].sort().join('+') || 'none',
}; }

// ── URLs (verbatim shapes from the Go call sites — PROVEN on the gateway) ──
// gamePathBase is THE game-path shape: configUrl/spinUrl build on it, and the wall streak judges only URLs under it (isGamePathUrl). gameOf is the refusal list's per-game key — the {code} segment a URL hit, read ONLY for spin requests (the noteRefusal gate), so a URL with no segment under its host can never name, or ban, a game.
const gamePathBase = (api, code) => `${api}/${code}/`; const gameOf = (url) => (url.match(/^[a-z]+:\/\/[^/]+\/([^/?#]+)\//) ?? [])[1] ?? '';
const balanceUrl = (ctx) => `${ctx.api}/api/v2/balance?oc=${ctx.cfg.ocs}&t=${ctx.token}`;
const historyUrl = (ctx) => { const w = ctx.window(); return `${ctx.api}/api/bets?brandCode=${ctx.cfg.ocs}&gameCode=${ctx.cfg.gameCode}&playerToken=${ctx.token}&startDate=${w.start}&endDate=${w.end}&skip=0&limit=20`; };
const detailsUrl = (ctx) => { const w = ctx.window(); return `${ctx.api}/api/total-bets?brandCode=${ctx.cfg.ocs}&gameCode=${ctx.cfg.gameCode}&playerToken=${ctx.token}&startDate=${w.start}&endDate=${w.end}`; };
const configUrl = (ctx) =>
  `${gamePathBase(ctx.api, ctx.cfg.gameCode)}config?brandCode=${ctx.cfg.ocs}&gameCode=${ctx.cfg.gameCode}&playerToken=${ctx.token}`;
const spinUrl = (ctx) => `${gamePathBase(ctx.api, ctx.cfg.gameCode)}spin`;
const authUrl = (ctx) => `${ctx.api}/client/player/authorize-game`;

// ── actions ───────────────────────────────────────────────────────────────
async function doAuthorize(ctx, state) {
  const res = await ctx.send(authUrl(ctx), {
    action: 'auth', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Plain JSON, exactly the three fields the game client posts (Go
    // fireAuthorize); the gateway rejects a gzipped body with HTTP 400.
    body: JSON.stringify({ gameCode: ctx.cfg.gameCode, brandCode: ctx.cfg.ocs, playerToken: ctx.token }),
  });
  state.authorized = res.status === 200 || res.status === 201;
  return res;
}

async function doConfig(ctx, state) { const res = await ctx.send(configUrl(ctx), { action: 'config' }); if (res.status === 200) applyStake(state, res.text); return res; }

async function doBalance(ctx) { return ctx.send(balanceUrl(ctx), { action: 'balance' }); }
async function doHistory(ctx) { return ctx.send(historyUrl(ctx), { action: 'history' }); }
async function doDetails(ctx) { return ctx.send(detailsUrl(ctx), { action: 'details' }); }

// doLobby hits the games API gateway — apig.rg-lgna.com, the "apig"
// sub-domain (the lobby host is dead: it answers an HTML 403 block page,
// probed 2026-10-21). On a TRANSPORT failure it retries the configured
// target host once — that host serves the identical catalog path (Go's
// lobbyCatalogURLs last hop), so a DNS/dead-gateway blip does not eat the
// slot. The retry is SKIPPED when the two URLs are the same host (the
// default target IS the gateway): re-sending it would burn a second slot on
// a request the first one already proved unreachable. Both attempts are
// recorded: one TSV line per real request.
async function doLobby(ctx) {
  const res = await ctx.send(ctx.cfg.lobbyUrl, { action: 'lobby' });
  if (res.status === 0 && ctx.cfg.lobbyFallbackUrl && ctx.cfg.lobbyFallbackUrl !== ctx.cfg.lobbyUrl) {
    return ctx.send(ctx.cfg.lobbyFallbackUrl, { action: 'lobby' });
  }
  return res;
}

// doSpin places one bet. It returns { substituted: true } when no usable
// stake could be loaded: the caller spends the slot on an honest read — a
// config with no usable betSize degrades the slot, it never guesses.
async function doSpin(ctx, state) {
  // Config must be loaded before spinning; fetch on demand rather than
  // skipping (Go callSpin fires config when the stake is missing).
  if (state.betSize <= 0) await doConfig(ctx, state);
  if (state.betSize <= 0) return { substituted: true }; if (ctx.refusal.has(ctx.cfg.gameCode)) return { substituted: true }; // LAST-moment re-check: the trip may land while the stake fetch above is in flight — the loop-level check runs before doSpin and cannot see across that await; a bet never dispatched is never recorded (in-flight bets keep their honest record) and the caller substitutes a real read, so the slot is spent truthfully either way
  // PER-TOKEN SPIN CAP gate — BEFORE the dispatch, so the cap is a hard 60:
  // a slot that would be the 61st spin on this token first fires the SAME
  // run-scoped refill latch the wallet drain uses (ctx.reacquire — ONE
  // acquisition per run, shared with every lane), then re-checks whether a
  // NEW token actually arrived: doRefill resets ctx.spins only when it
  // replaces ctx.token, so a mint refill (count 0, mode full) dispatches the
  // next spin on the FRESH token — its epoch bump re-authorizes every lane
  // (syncToken) — while a store refill (mode read), a failed refill or a
  // spent latch (count still >= cap) substitutes an honest read: never a
  // 61st spin on the old token, never a second acquisition.
  if (ctx.spins >= SPIN_CAP_PER_TOKEN) {
    await ctx.reacquire();
    if (ctx.mode !== 'full' || ctx.spins >= SPIN_CAP_PER_TOKEN) return { substituted: true };
  }
  ctx.spins += 1; // a REAL spin POST about to be issued with the current token: the increment is BEFORE ctx.send, so an issued-but-refused/failed (000) bet counts too — the cap counts REQUESTS ISSUED with the token; skipped slots (the substitutions above) and read actions never reach this line
  const spunToken = ctx.token; // the token this verdict will be ABOUT
  const res = await ctx.send(spinUrl(ctx), {
    action: 'spin', method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // The exact payload the game client posts to the gateway — the six
    // fields internal/loadtest/api_contract_test.go pins; baseBet is NOT
    // sent (the server derives it).
    body: JSON.stringify({
      gameCode: ctx.cfg.gameCode,
      brandCode: ctx.cfg.ocs,
      playerToken: spunToken,
      betSize: state.betSize,
      betLevel: state.betLevel,
      walletType: 'CASH',
    }),
  });
  if (res.status === 200 || res.status === 201) return { spun: true };
  if (isSpentTokenBody(res.text) || isDemoBetRefusal(res)) {
    // Only a verdict about the CURRENT token arms the degrade: a sibling
    // lane's mid-run refill may have swapped ctx.token while this spin was
    // in flight, and that stale answer must not re-degrade a healthy lane
    // (Go callReadOnly: keep the token for reads, degrade the spin slots).
    // The 1305 arm is the operator's out-of-spins verdict (2026-10-20): the
    // gateway accepted ~11 bets per wallet then refused every further one
    // (137389 of 138403 spins on a live compose node), so a wallet that
    // draws it is spent exactly like a dry balance — 4xx-gated inside
    // isDemoBetRefusal, counted in demo1305= by the same classifier the
    // summary has always used.
    if (spunToken === ctx.token) state.noBalance = true;
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
    case 'history': return doHistory(ctx);
    case 'details': return doDetails(ctx);
    case 'balance': return doBalance(ctx);
    case 'config': return doConfig(ctx, state);
    case 'lobby': default: return doLobby(ctx);
  }
}

// The non-spin full-mix actions.
async function doFullAction(ctx, state, action) {
  switch (action) {
    case 'auth': return doAuthorize(ctx, state);
    case 'new-token':
      // Go's WNewTok slot is the last-resort token refill; the runner never
      // mints, so the slot refreshes the SESSION — a re-authorize, which is
      // the only session refresh this surface has.
      return doAuthorize(ctx, state);
    case 'config': return doConfig(ctx, state);
    case 'balance': return doBalance(ctx);
    case 'history': return doHistory(ctx);
    case 'details': return doDetails(ctx);
    case 'lobby': return doLobby(ctx);
    case 'env-config': {
      const url = ctx.cfg.gameHost ? `${ctx.cfg.gameHost}/env-config.js?isFun=true` : '';
      if (!url) return null; // no derivable client host: the action is off (Go parity)
      return ctx.send(url, { action: 'env-config' });
    }
    case 'client-config': {
      const url = ctx.cfg.gameHost ? `${ctx.cfg.gameHost}/config.json?isFun=true` : '';
      if (!url) return null;
      return ctx.send(url, { action: 'client-config' });
    }
    default: return doLobby(ctx);
  }
}

// ── one lane ──────────────────────────────────────────────────────────────
// Each lane paces its share of the budget (one request every lanes/rps
// seconds) until the deadline — the bash loop's shape, await-based.
async function runLane(ctx, idx, deadline) {
  // Per-lane session: authorized/noBalance/stake, exactly Go's Session fields
  // the mix reacts to. epoch mirrors ctx.epoch (the token generation this
  // lane last synced against); registered so a refill can clear the drain.
  const state = { authorized: false, noBalance: false, betSize: -1, betLevel: 1, epoch: 0 };
  ctx.laneStates.push(state);
  // syncToken: a mid-run refill swaps ctx.token, and the gateway session is
  // bound to the token it was authorized with — so each lane re-authorizes
  // exactly once per token epoch, before its next full-mix slot.
  const syncToken = async () => {
    if (state.epoch === ctx.epoch) return;
    state.epoch = ctx.epoch;
    state.authorized = false;
    state.betSize = -1; // the stake config is re-derived under the new token
    await doAuthorize(ctx, state);
  };
  const rng = mulberry32((MIX_SEED_BASE + idx * LANE_PHASE) >>> 0);
  let rr = idx; // read-mode rotation offset, seeded by the lane index (de-phased lanes)
  const intervalMs = (ctx.cfg.lanes / ctx.cfg.rps) * 1000;

  if (ctx.mode === 'full' && !ctx.wall.degraded) {
    // Bootstrap like Go's worker: authorize once per lane, then load the stake config; both are
    // real requests and both are recorded. The !degraded term is DEFENSIVE — unreachable today:
    // Promise.all creates every lane in one tick and each lane's first await is this
    // doAuthorize, so no response has landed when the guard is evaluated. It protects the
    // invariant only if wall detection ever moves ahead of lane launch (e.g. a boot-time probe).
    await doAuthorize(ctx, state);
    await doConfig(ctx, state);
  }

  while (Date.now() < deadline) {
    if (ctx.token) ctx.rollWindow(idx);
    if (ctx.wall.degraded) {
      // wall-detected → lobby-only: the orthogonal, one-way fallback on top
      // of the three-level rule (full|read → wall → lobby, mirroring mint-
      // empty → read-only). The slot still issues a REAL request on the
      // reachable surface, so sent/rps/err% stay the true accounting of what
      // was actually sent — the doomed game-path requests stop, nothing is
      // hidden.
      await doLobby(ctx);
    } else if (ctx.mode === 'full') {
      // A sibling lane may have refilled a drained wallet mid-run: re-sync
      // this lane's session to the current token epoch first.
      await syncToken(state);
      let action = pickAction(rng);
      if (action === 'spin' && state.noBalance) {
        // The wallet-level three-level rule, with the operator's refill door
        // (the shared-DB architecture — deliberately NOT Go's takeFromStore,
        // which is not drain-triggered and never reaches a parked worker):
        // ONE run-scoped re-acquire — never one per
        // lane, the broker enforces a 5s mint spacing gate. A mint refill
        // that clears the drain resumes the spin mix; any other outcome
        // (broker dry/down, or the refill itself drained) keeps this lane
        // on honest reads for the rest of the run — the slot still issues a
        // real request, so the RPS budget and counters stay truthful.
        if ((await ctx.reacquire()) && !state.noBalance) {
          await syncToken(state); // the refill bumped the epoch
          action = pickAction(rng);
        } else {
          action = null; // degraded to reads: substitute the slot below
        }
      }
      if (action === 'spin' && ctx.refusal.has(ctx.cfg.gameCode)) action = null; // the game proved it refuses its bets — this slot becomes an honest read, still a real request (Go callReadOnly's shape). This check runs BEFORE doSpin; doSpin re-checks immediately before dispatch, because its stake-fetch await sits between this line and ctx.send (the trip can land inside that window — test-loadtest-refusal.mjs's pre-dispatch-window pin)
      if (action === 'spin') {
        const r = await doSpin(ctx, state);
        if (r.substituted) await doRead(ctx, state, rng);
      } else if (action !== null) {
        if ((await doFullAction(ctx, state, action)) === null) await doRead(ctx, state, rng); // an underivable/off client host must still spend its slot on a REAL read request (the wall/drain degradation shape) — never a silently burned slot
      } else {
        await doRead(ctx, state, rng);
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
// Test seam: { env, fetchFn, out, errOut, acquireDelayMs, retryBudgetSecs }.
// out/errOut receive the EMITTED LINES (no timestamp) so tests can assert
// the token-leak invariant on exactly what the script prints;
// retryBudgetSecs (default 540 — the Actions budget) bounds the minrps
// retry windows' total load time and exists as a seam so the suite can
// exercise the bound at 1-2 s durations instead of 540.
export async function runLoadtest({ env = {}, fetchFn, out, errOut, acquireDelayMs = 1000, retryBudgetSecs = 540 } = {}) {
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
  // mint => full mix; a BETTABLE store row (the broker's "spinnable" flag)
  // => full mix too — it is a NON-EXHAUSTED wallet, so a run that could not
  // mint may still bet; a drained store row => read GETs; none => lobby-only.
  // The raw token never enters an emitted line — only the SOURCE name.
  let token = '';
  let tokenSrc = 'none';
  let mode = 'lobby';
  // The FLEET-WIDE spin count of the row in hand: the runner's own
  // SPIN_CAP_PER_TOKEN budget starts from it (Go baselines the same way), so
  // a borrowed row that already carries spins cannot be pushed past the cap.
  let tokenSpins = 0;
  // The row borrowed from the broker, if any: the broker owns the store, so
  // the runner has no store access and hands the row back through the
  // broker's release endpoint (with the spin count this run used).
  let lent = null;
  if (cfg.tokenUrl !== '') {
    const got = await acquireToken(cfg, fetchFn ?? globalThis.fetch, acquireDelayMs);
    if (got) {
      token = got.token;
      tokenSrc = got.source;
      tokenSpins = got.spins;
      mode = got.source === 'mint' || got.spinnable ? 'full' : 'read';
      if (got.source === 'store') lent = { token: got.token, spins: got.spins, spinnable: got.spinnable };
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
  const fails = { wall: 0, generic: 0, other: 0 }, fail403 = {}, demo1305 = { n: 0 }; // fails=wall/generic/other = the failure-body classes; fail403 = the per-action 403 tally (WHICH action the provider-403 lands on); demo1305 = the "Error Code: 1305" verdicts counted apart as their own class (DEMO_1305 — a demo-bet refusal is a different diagnosis from a blocked egress and must stay readable as such, reported as demo1305=)
  const record = (res, action) => {
    records.push({ status: res.status, secs: res.secs });
    if (res.status < 200 || res.status >= 300) fails[isWallResponse(res) ? 'wall' : res.text.includes('Error processing your request') ? 'generic' : 'other'] += 1; if (res.status === 403) fail403[action ?? 'unknown'] = (fail403[action ?? 'unknown'] ?? 0) + 1; if (isDemoBetRefusal(res)) demo1305.n += 1; // the 4xx gate lives INSIDE isDemoBetRefusal, so a 1305-shaped success or a 5xx/304 rider is never counted
    try {
      // 3-digit status, exactly the bash TSV: curl -w %{http_code} recorded
      // 000 for a refused/timed-out request, and every consumer of
      // loadtest-results.tsv parses <status> as 3 digits.
      appendFileSync(cfg.log, `${String(res.status).padStart(3, '0')}\t${res.secs.toFixed(6)}\n`);
    } catch {
      // a failed append must not kill the run — the summary still counts it
    }
  };
  const referer = `${cfg.scheme}://${cfg.host}/`;
  // ── game-path wall detection ─────────────────────────────────────────────
  // Run-level state, like Go's error-rate rotation guard: the wall is a fact
  // about THIS EGRESS, not about one lane, so the lanes that prove it degrade
  // every lane. The counter is shared across lanes and judges the GAME PATH
  // ONLY (isGamePathUrl) — a healthy game-path answer resets it, auth/balance/
  // history/details/lobby answers are not evidence and never touch it (before,
  // ANY non-wall answer wiped the streak, so 3 CONSECUTIVE walls never piled
  // up — a live run burned ~40% of its budget on the walled path, wall=none).
  const wall = { consecutive: 0, degraded: false };
  const isGamePathUrl = (url) => url.startsWith(gamePathBase(`${cfg.readScheme}://${cfg.readHost}`, cfg.gameCode));
  const noteWall = (url, res) => {
    if (wall.degraded || !isGamePathUrl(url)) return;
    if (isWallResponse(res)) {
      wall.consecutive += 1;
      if (wall.consecutive >= GAME_WALL_CONSECUTIVE) {
        wall.degraded = true;
        fail(`game-path egress wall detected (${GAME_WALL_CONSECUTIVE} consecutive "Error Code: 3000" refusals) — degrading to lobby-only for the rest of the run`);
      }
    } else {
      wall.consecutive = 0;
    }
  };

  const refusal = makeRefusalGuard(fail); // THIS run's list, keyed by the game path segment each spin request actually carried (gameOf) — one streak + one ban per game, never one shared flag: a second refusing game trips ITS OWN streak while cfg.gameCode keeps betting, and answers to other games (or non-spin answers, gated here) never reset a streak (5944c9b, now per game)
  const noteRefusal = (action, res, url) => { if (action === 'spin') refusal.note(gameOf(url), res); };
  const send = async (url, opts = {}) => {
    const res = await httpRequest(fetchFn, url, { ...opts, headers: browserHeaders(referer, opts.headers ?? {}) });
    record(res, opts.action);
    // Detection runs AFTER the record: every pre-detection request stays
    // counted truthfully — the wall stops FUTURE doomed requests, it never
    // hides past ones.
    noteWall(url, res); noteRefusal(opts.action, res, url);
    return res;
  };

  // ── mid-run refill (ONE re-acquire per run, shared by every lane) ────────
  // The shared postgres store behind the broker serves every platform, so a
  // fresh token IS available mid-run — the operator's architecture: a
  // platform that needs a token READS one from the store when it's needed.
  // Deliberate divergence from Go, which parks a drained worker BY DESIGN
  // and recovers only via IP rotation (games.go:758-763, :1293, :2453-2456;
  // controller.go:1502) — Go's takeFromStore is not drain-triggered and
  // never reaches a parked worker. The latch is per-run and run-scoped like
  // `wall`: the synchronous attempted-flag flip happens before the first await, so
  // concurrent lanes draining together fire exactly ONE bounded
  // re-acquisition (the broker enforces a 5s mint spacing gate) and every
  // other lane awaits the same promise. One attempt per run by design — a
  // failed refill degrades to honest reads (a warning, never a different
  // exit code), and a second mint wallet draining again degrades the same
  // way. Only source=mint runs ever get here: full mode is unreachable for
  // store (read) and missing (lobby) tokens, and a store-refill result
  // holds the three-level rule (store => read) for the remainder.
  // ── the drain marker (the summary's drain= field) ─────────────────────────
  // wall='s counterpart for the wallet: wall= names WHY the game share
  // dropped, drain= names WHAT the wallet did — a run that stopped betting
  // must never hide behind mix=full token=mint (the wall= precedent; the
  // token=/mix= rules are untouched). Values: none (never drained) |
  // refill-ok (re-acquire minted; resumed) | refill-store (store fallback;
  // reads) | refill-failed (attempted, failed; reads) | no-refill (no
  // acquisition left — door closed or latch spent, a SECOND drain; reads).
  const drain = { state: 'none' };
  const refill = { attempted: false };
  let refillPromise = null;
  const doRefill = async () => {
    if (cfg.tokenUrl === '') {
      drain.state = 'no-refill'; // no acquisition door: lobby-only by contract
      return false;
    }
    // The row in hand is spent (its wallet drained) — hand it back with the
    // drain verdict so the fleet does not lease a dead wallet again.
    if (lent) {
      await releaseLentToken(fetchFn ?? globalThis.fetch, cfg, lent.token, ctx.spins, true);
      lent = null;
    }
    const got = await acquireToken(cfg, fetchFn ?? globalThis.fetch, acquireDelayMs);
    if (!got) {
      drain.state = 'refill-failed';
      fail('the wallet drained and the re-acquisition from LOADTEST_TOKEN_URL failed - reading for the rest of the run');
      return false;
    }
    ctx.token = got.token; // the raw token lives only on the wire and in memory — never in an emitted line
    ctx.spins = got.spins; // the fresh row starts its own SPIN_CAP_PER_TOKEN budget, BASELINED on the fleet-wide count it already carries
    if (got.source === 'mint' || got.spinnable) {
      drain.state = 'refill-ok';
      ctx.epoch += 1; // every lane re-authorizes once (syncToken) before its next spin
      // Fresh wallet: the old drain verdict was about the old token.
      for (const s of ctx.laneStates) s.noBalance = false;
      emit('token source=mint re-acquired after the wallet drained - resuming spins');
      if (got.source === 'store') lent = { token: got.token, spins: got.spins, spinnable: got.spinnable };
      return true;
    }
    // A DRAINED store row: read-only by design — the three-level rule holds
    // (store => read) for the rest of the run.
    drain.state = 'refill-store';
    tokenSrc = got.source;
    mode = 'read';
    ctx.mode = 'read';
    emit('token source=store re-acquired after the wallet drained - reading for the rest of the run');
    if (got.source === 'store') lent = { token: got.token, spins: got.spins, spinnable: got.spinnable };
    return false;
  };
  const reacquire = () => {
    if (!refill.attempted) {
      refill.attempted = true; // flipped synchronously: a racing lane cannot double-fire
      refillPromise = doRefill();
    } else if (drain.state === 'refill-ok') {
      // The attempt has settled as mint, so this is a NEW drain on the
      // refilled wallet — a SECOND drain: no third acquisition, and the
      // marker must say so (settling already cleared every lane's verdict).
      drain.state = 'no-refill';
    }
    return refillPromise;
  };

  const ctx = {
    cfg,
    token,
    mode,
    wall, refusal,
    send,
    epoch: 0, // token generation: bumped by a successful refill, synced per lane
    spins: tokenSpins, // REAL spin POSTs issued with the CURRENT token — the SPIN_CAP_PER_TOKEN budget (BASELINED on the row's fleet-wide count), reset by doRefill when a fresh token lands
    laneStates: [], // every lane's session state, so a refill can clear the drain
    reacquire,
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

  // GO PARITY (internal/loadtest/ws.go:167-189, probeStatus): the per-game client host is PROBED ONCE at startup — a transport failure or a non-200 turns the env-config/client-config actions OFF for the whole run, never re-sent (the live run 38667921184's status=000:50 was EXACTLY those draws: the seeded mix's 8% lands on fortune-dragon.<env domain>, which has NO DNS record — never keep sending to a surface that has proven it cannot answer, GAME_WALL_CONSECUTIVE's principle). The probe is OUT of TSV/summary accounting like the broker acquisition and the gameprobe, and an off action substitutes a real read in runLane; the verdict is summary-visible as clientcfg=(on|off).
  if (mode === 'full' && cfg.gameHost !== '') { const probe = await httpRequest(fetchFn ?? globalThis.fetch, `${cfg.gameHost}/config.json?isFun=true`, { headers: browserHeaders(`${cfg.gameHost}/`) }); if (probe.status !== 200) { fail(`client host ${cfg.gameHost} did not answer config.json (status=${String(probe.status).padStart(3, '0')}) - env-config/client-config actions are off for the rest of the run`); cfg.gameHost = ''; } }
  // ── the measurement window(s): the minrps floor's retry re-measure ──────
  // ONE window IS the historical run. The retry windows exist so ONE slow
  // measurement window cannot fail an otherwise healthy run (GHA run
  // 39340443070, 2026-10-19: rps=3.6 vs minrps=4.2 at err%=0.7 while
  // neighbouring runs read 5.2-6.2 — a slow-window flake, not an app
  // defect). Contract: IDENTICAL behaviour when the first window clears the
  // floor (no extra request, the summary byte-identical — the loop can only
  // continue by emitting the notice below); when it misses, up to
  // LOADTEST_MIN_RPS_RETRIES extra windows (each cfg.dur long) are measured
  // and the BEST printed rps is judged — a flake recovers, a dead target
  // still fails. Bounded twice: the knob is clamped to 5 in parseConfig,
  // and retry windows never push total load time past the 540 s Actions
  // budget (retryBudgetSecs's default — the same literal loadtest-config.
  // mjs clamps LOADTEST_DURATION_SECS to), so at duration=540 no retry
  // fits and the worst case is exactly today's worst case. The token,
  // wall/refusal state and per-token spin count carry across windows (one
  // run, one token, one cap); lane sessions re-bootstrap per window, and
  // the game probe below still runs once per run.
  const floor = cfg.minrps > 0 ? (cfg.rps * cfg.minrps) / 100 : null;
  const loadWindow = async () => {
    const startMs = Date.now();
    const sentBefore = records.length;
    await Promise.all(Array.from({ length: cfg.lanes }, (_, i) => runLane(ctx, i + 1, startMs + cfg.dur * 1000)));
    const sentNow = records.length - sentBefore;
    return sentNow > 0 ? sentNow / cfg.dur : 0;
  };
  // The gate judges the PRINTED rps (one decimal), so the retry decision
  // compares the same two printed numbers — the loop and the gate can never
  // disagree about what "below the floor" means.
  const belowFloor = (rps) => floor !== null && Number(rps.toFixed(1)) < Number(floor.toFixed(1));
  emit(`loadtest start: ${cfg.lobbyUrl} rps=${cfg.rps} lanes=${cfg.lanes} duration=${cfg.dur}s (target=${cfg.target})`);
  let bestRps = await loadWindow();
  let windows = 1, minrpsRetriesUsed = 0;
  while (belowFloor(bestRps) && minrpsRetriesUsed < cfg.minrpsRetries && (windows + 1) * cfg.dur <= retryBudgetSecs) {
    minrpsRetriesUsed += 1;
    windows += 1;
    emit(`minrps floor missed (rps ${bestRps.toFixed(1)} < ${floor.toFixed(1)}) - re-measuring (retry ${minrpsRetriesUsed}/${cfg.minrpsRetries})`);
    const measured = await loadWindow();
    if (measured > bestRps) bestRps = measured;
  }

  // ── game-path probe ─────────────────────────────────────────────────────
  // AFTER the loop — once per run, never per lane — probe /{code}/config: the
  // GHA egress is the only runtime still getting clean 200s, so this is the
  // only sensor that can surface the gateway's game-path "Error Code: 3000"
  // verdict before the lobby itself fails. Sequential, bounded, REPORT-ONLY
  // unless a threshold is set (the wall must be VISIBLE, not flapping the
  // workflow red). Probe requests do NOT enter the TSV/summary accounting
  // (bash parity). DECISION (c) — NOT skipped when the refusal guard trips: the probe hits balonismo (the default LOADTEST_GAME_PROBE_CODE — the workflow sets none), a DIFFERENT game from the refused cfg.gameCode, and its standing failure is a 400 on the legacy paramless URL (run 38675032529: statuses="400,400,400" while refusal=fortune-dragon) — skipping would delete the only 3000-wall sensor on a false premise, and relabelling game_err%= would falsify a true count of probes sent/failed (test-loadtest-refusal.mjs pins: probes still run, target balonismo, game_err% unchanged).
  let gSent = 0, gFail = 0;
  const gStatuses = [], gBodies = [];
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

  // ── hand the borrowed row back ───────────────────────────────────────────
  // The broker owns the store, so the runner cannot return a borrowed row
  // itself — it tells the broker how many spins the run placed on it and
  // whether the wallet drained, and the broker records that and frees the
  // row. A row that did not drain goes back BETTABLE (its remaining balance
  // is fleet supply again); one that drained goes back drained, so no
  // machine leases a dead wallet. Best-effort: a failed release costs
  // accuracy, never the wallet — the lease lapses and the row returns anyway.
  if (lent) {
    const drained = !lent.spinnable || ctx.laneStates.some((s) => s.noBalance);
    await releaseLentToken(fetchFn ?? globalThis.fetch, cfg, lent.token, ctx.spins, drained);
    lent = null;
  }

  // ── summary ─────────────────────────────────────────────────────────────
  // p50/p95 by nearest rank over the sorted per-request times; max is the
  // last. Fields APPEND, never reorder: the trailing minrps=/token=/mix=
  // (full|read|lobby — the mode, never the token), the wall= verdict
  // (none|game-path — WHY the game share dropped, when it did) and the
  // drain= verdict (none|refill-ok|refill-store|refill-failed|no-refill —
  // WHAT the wallet did when it drained, so mix=full never silently sits
  // over a run that stopped betting). Then the three CLASSIFICATION fields: status=<code>:<count> is the run's recorded-status histogram (000-padded, ascending — the TSV's own shape), and fails=wall:W,generic:G,other:O splits the failures by BODY — W is what the wall mechanism itself would claim (isWallResponse: "Error Code: 3000" on 400/403), G the generic "Error processing your request" envelope that also wraps ordinary wallet/session/provider verdicts, O everything else (a 000 has no body) — so an err% like the live 35.3% is classifiable from ONE line, never from truncated logs. Then fail403=<action>:<n>[,<action>:<n>]* is the per-action tally of the HTTP 403s THEMSELVES — the live "WHICH action do the 152x403 land on" question (spin => WAF/per-game rejection, the read APIs => session/token expiry, spread => systemic) — only actions that saw at least one 403, alphabetical, "-" when there are none (a transport 000 has no status to tally; it stays in other=). Then refusal=<game[+game…]|none> — the per-game refusal LIST's verdict (wall='s per-game sibling; Go's badGames bans more than one title): EACH game that refused SPIN_REFUSAL_CONSECUTIVE consecutive bet-endpoint 403s — no wall marker, no wallet/session verdict inside — had ITS OWN spin slots degrade to reads for the rest of the run, listed sorted and '+'-joined (one entry per refusing game, whitespace-free so every [^ ]+ parser key still holds), the run's own game named by its bare name exactly as before. Finally clientcfg=(on|off) — the client-host startup probe's verdict (ws.go probeStatus parity): off names a per-game client host that could not serve config.json — non-resolving or refusing — so its env-config/client-config draws stopped for the run (the live status=000:50 class), holding its slot right before the newest field. And LAST, demo1305=<n> — the count of recorded 4xx responses carrying provider error code 1305 in either gateway spelling, the class Go dispatches ahead of every other branch (stats.go demoBetRefusal → "DEMO_1305", commits 7659177/8b1ffeb; worker/bridge.js isDemoBetRefusal is the JS port — this surface was the fourth, and before it a demo-mode bet refusal was indistinguishable from a blocked egress HERE). The two demand opposite responses (stop rotating vs rotate), so the verdict is counted apart from the wall (isWallResponse still judges "Error Code: 3000" alone — a 1305 run never trips the streak, never degrades to lobby-only, never reads as egress refused), while every 1305 stays INSIDE the err% it is (an ordinary HTTP failure for the error-rate guard — Go's own rule for the class) and inside fail403= (it IS an HTTP 403: Go counts the transport-level 403 and classifies the verdict separately) — a run whose only failures are 1305 reads demo1305=<n> beside fail=<n>, attributed rather than lumped. Appended LAST; no parsed field moved.
  const sent = records.length, statusHist = records.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  const okCount = records.filter((r) => r.status >= 200 && r.status < 300).length;
  const failCount = sent - okCount;
  const times = records.map((r) => r.secs).sort((a, b) => a - b);
  const ceil = (x) => (Number.isInteger(x) ? x : Math.floor(x) + 1);
  const rank = (p) => (sent === 0 ? 0 : times[ceil(p * sent) - 1]);
  // rps= is the BEST per-window rate (identical to the historical sent/dur
  // whenever there is exactly one window) — the number the throughput gate
  // judges, so gate and summary can never disagree. sent/ok/fail/err%/p50/
  // p95/max/status=/fails=/fail403=/demo1305= keep covering EVERY request of
  // EVERY window (nothing hidden); duration= keeps its per-window meaning
  // (whole load time = duration x windows, visible via the appended
  // windows=/retry= below).
  const rps = bestRps;
  const errPct = sent > 0 ? (100 * failCount) / sent : 0;
  const gErrField = cfg.gprobeCode === '' ? '-' : gSent > 0 ? ((100 * gFail) / gSent).toFixed(1) : '0.0';
  const rpsPrinted = rps.toFixed(1);
  log(
    `summary: sent=${sent} ok=${okCount} fail=${failCount} duration=${cfg.dur} rps=${rpsPrinted} err%=${errPct.toFixed(1)} ` +
      `p50=${rank(0.5).toFixed(3)} p95=${rank(0.95).toFixed(3)} max=${sent === 0 ? '0.0' : times[times.length - 1].toFixed(3)} ` +
      `game_err%=${gErrField} minrps=${floor === null ? 'off' : floor.toFixed(1)} token=${tokenSrc} mix=${mode} ` +
      `wall=${wall.degraded ? 'game-path' : 'none'} drain=${drain.state} status=${Object.entries(statusHist).map(([s, n]) => `${String(s).padStart(3, '0')}:${n}`).join(',')} fails=wall:${fails.wall},generic:${fails.generic},other:${fails.other} fail403=${Object.keys(fail403).length === 0 ? '-' : Object.entries(fail403).sort(([a], [b]) => (a < b ? -1 : 1)).map(([a, n]) => `${a}:${n}`).join(',')} refusal=${refusal.list()} clientcfg=${cfg.gameHost === '' ? 'off' : 'on'} demo1305=${demo1305.n}${windows > 1 ? ` windows=${windows} retry=${minrpsRetriesUsed}` : ''}`, // windows=/retry= APPEND last, only when a retry really ran: a single-window run is byte-identical to the historical shape (the smoke tools parse by key; every pre-existing key keeps its slot)
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
  // summary can never disagree; floor=off (MINRPS=0) skips the gate. rps is
  // the BEST of up to 1+MIN_RPS_RETRIES windows (the retry loop above).
  if (floor !== null && Number(rpsPrinted) < Number(floor.toFixed(1))) {
    fail(`achieved rps ${rpsPrinted}${windows > 1 ? ` (best of ${windows} windows)` : ''} is below the throughput floor ${floor.toFixed(1)} (LOADTEST_MIN_RPS_PERCENT=${cfg.minrps} of LOADTEST_RPS=${cfg.rps})`);
    return 1;
  }
  return 0;
}

async function main() { process.exitCode = await runLoadtest({ env: process.env, fetchFn: globalThis.fetch }); } // one statement — identical behaviour, and it pays the line budget the 1305 classifier above spent

// Run only when executed directly — `node --test` imports this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`loadtest.mjs: fatal: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
}
