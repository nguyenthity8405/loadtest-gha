#!/usr/bin/env node
// loadtest-config.mjs — the GHA loadtest's config surface: scheme/host
// derivation, the UTC+7 operator-day read window and the env contract
// (parseConfig), moved VERBATIM out of loadtest.mjs when that file reached
// 999/1000 lines under check-line-limits.sh (the worker/loopdo.js split
// precedent). Behaviour is unchanged and every export is re-exported by
// loadtest.mjs, so no importer moves — the suites import from loadtest.mjs.
//
// SHIPPING (the reason this file can exist at all): the runner repo is a
// hard-coded Contents-API mirror, not a directory checkout — and
// scripts/gha-repo-sync.sh now mirrors FOUR files, this one included, on
// BOTH branches (:114 existence gate + :242-245 main + :317-320 trigger),
// gha-health.sh drift-checks it, and test-loadtest.mjs's shipping-coherence
// pins hold the set. Proven 2026-10-16 by experiment, not reasoning: `node
// ./loadtest.mjs` resolves `./loadtest-config.mjs` against the importing
// module's own URL in a directory holding ONLY the mirrored files — no
// package.json involved — and dies ERR_MODULE_NOT_FOUND only when the
// sibling is ABSENT. This file is never the entry point: the workflow runs
// `node ./loadtest.mjs`, which imports it.

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

// ── the per-token spin cap (operator's fleet-wide contract) ────────────────
// A token may be spun at most SPIN_CAP_PER_TOKEN times: at the cap the
// runner's doSpin gate (loadtest.mjs) triggers the run-scoped refill latch
// for a NEW token + NEW auth, and the fresh token's count starts at 0. A
// PLAIN constant on purpose: it lives here (not in loadtest.mjs) so the
// number ships inside the config surface the mirror carries, and it is
// deliberately NOT env-overridable — this file's env pattern serves
// parseConfig's loadtest knobs, never contract constants, and neither cap
// loadtest.mjs declares (GAME_WALL_CONSECUTIVE, SPIN_REFUSAL_CONSECUTIVE)
// is tunable either: the fleet-wide number must not drift per runner.
export const SPIN_CAP_PER_TOKEN = 60;

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
