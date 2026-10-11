# loadtest-gha runner

What runs: `loadtest.sh`, a pure-bash loadtest against the lobby catalog
surface (`/api/v1/lobby-available-games`) at `LOADTEST_RPS` requests/second
spread over `LOADTEST_CONCURRENCY` lanes. Every request is a browser-header
curl (`-m 15`) recorded as one `<status>\t<time_total>` line in
`loadtest-results.tsv`; the run ends with a `summary:` line (sent/ok/fail/
duration/rps/err%/p50/p95/max) and exits 1 when the error share STRICTLY
exceeds `LOADTEST_MAX_ERROR_PERCENT`.

How the cron triggers it: every 5 minutes a tiny Fly machine (app
`gha-trigger`, `fly.gha-trigger.toml` in the source repo) runs
`scripts/gha-trigger-loop.sh` → `scripts/gha-trigger.sh`, which pushes a `tmp`
commit on the `trigger` branch through the GitHub Contents API. Every push
fires the `loadtest` workflow on all branches. The run is capped at 10
minutes twice over: job-level `timeout-minutes: 10` plus a hard
`LOADTEST_DURATION_SECS <= 540` clamp inside `loadtest.sh`.

Keeping it in sync: `scripts/gha-repo-sync.sh` (source repo) mirrors this
directory into the runner repo and injects `LOADTEST_RPS` from `deploy.env`
into the workflow env — the same single RPS source of truth the Go fleet's
`scripts/staggered-deploy.sh` uses.

Run it locally (no GitHub needed):

```bash
LOADTEST_RPS=5 LOADTEST_DURATION_SECS=30 bash loadtest.sh
# point at another host, tune the pass/fail gate:
LOADTEST_TARGET=api.example.test LOADTEST_DURATION_SECS=60 \
  LOADTEST_MAX_ERROR_PERCENT=10 bash loadtest.sh
```

Source repo spec: `docs/spec-20261011-gha-cron-loadtest.md`.
