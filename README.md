# loadtest-gha runner

What runs: `loadtest.mjs`, the Node loadtest against the lobby catalog
surface (`/api/v1/lobby-available-games`) at `LOADTEST_RPS` requests/second
spread over `LOADTEST_CONCURRENCY` lanes — plus the token-gated mix when the
broker hands the run a token (source=mint ⇒ the full weighted games mix,
source=store ⇒ read-only GETs, no token ⇒ lobby-only). Every request is a
browser-header `fetch` (15 s timeout) recorded as one `<status>\t<time>`
line in `loadtest-results.tsv`; the run ends with a `summary:` line
(sent/ok/fail/duration/rps/err%/p50/p95/max) and exits 1 when the error
share STRICTLY exceeds `LOADTEST_MAX_ERROR_PERCENT`.

How the cron triggers it: every 5 minutes a tiny Fly machine (app
`gha-trigger`, `fly.gha-trigger.toml` in the source repo) runs
`scripts/gha-trigger-loop.sh` → `scripts/gha-trigger.sh`, which pushes a `tmp`
commit through the GitHub Contents API — on `main` in the deployed config
(`GHA_BRANCH=main` app secret; the script default is `trigger`). Every push
to `main` or `trigger` fires the `loadtest` workflow. The run is capped at 10
minutes twice over: job-level `timeout-minutes: 10` plus a hard
`LOADTEST_DURATION_SECS <= 540` clamp inside `loadtest.mjs`.

Keeping it in sync: `scripts/gha-repo-sync.sh` (source repo) mirrors this
directory into the runner repo and injects `LOADTEST_RPS` from `deploy.env`
into the workflow env — the same single RPS source of truth the Go fleet's
`scripts/staggered-deploy.sh` uses.

Run it locally (no GitHub needed):

```bash
LOADTEST_RPS=5 LOADTEST_DURATION_SECS=30 node loadtest.mjs
# point at another host, tune the pass/fail gate; an IP/hostname that is not
# the production domain needs the catalog override (the derived
# apig.<env-domain> would never resolve):
LOADTEST_TARGET=api.example.test LOADTEST_LOBBY_HOST=api.example.test \
  LOADTEST_LOBBY_SCHEME=https LOADTEST_DURATION_SECS=60 \
  LOADTEST_MAX_ERROR_PERCENT=10 node loadtest.mjs
```

Tests: `node --test scripts/tests/test-loadtest.mjs` (in the source repo —
the Node suite that replaced the retired bash harness; bash cannot execute a
`.mjs`, and the Node suite carries every invariant the bash harness pinned).

Source repo spec: `docs/spec-20261011-gha-cron-loadtest.md`.
