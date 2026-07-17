# wbt-sidecar — WorldBuilder.Terminal oracle for the rynth AI director

An HTTP sidecar (Node, no build step) that owns one long-lived
`WorldBuilder.Terminal --stdin` process and exposes its 216-command JSON REPL
to the browser-side AI director (`rynth/ai/tools/wbt.js`), plus playtest
ticket filing. Same conventions as `apps/rynthnav-sidecar`: 127.0.0.1 bind,
permissive CORS, `/health`, well-formed JSON on every branch.

This is what gives the LLM playtester its world knowledge: weenie/spell
lookups, `describe-landblock` before walking into an area, asset-graph and
validator queries, ACE-DB probes — the bot figures out what to ask; the
sidecar just makes the oracle reachable from the page.

## Run

```sh
node apps/wbt-sidecar/wbt_sidecar.cjs                # defaults below
scripts/wbt-sidecar-boot.sh                          # idempotent, cron @reboot
node apps/wbt-sidecar/wbt_sidecar_test.cjs           # 28-check E2E (mock WBT, no dotnet)
```

Env: `WBT_LISTEN` (127.0.0.1:8768), `WBT_DOTNET` (~/.local/bin/dotnet),
`WBT_DLL` (WorldBuilder.Terminal Release net8.0 DLL), `WBT_PROJECT` (a
`.wbproj` to `load` at boot — required for project-scoped reads like
`spell-list`/`get-height`; without it DAT-independent commands still work),
`WBT_CMD_TIMEOUT` (ms, default 120000), `WBT_TICKETS_DIR`
(/mnt/wbterminal2/playtest-tickets, falls back to ~/.wbt-playtest-tickets),
`WBT_ALLOW` ("all" or comma list to widen), `WBT_DENY` (comma list to narrow),
`WBT_SPAWN` (full spawn-command override; tests use it to run `mock_wbt.cjs`).

## Endpoints

- `GET /health` → `{ ok, ready, pid, uptimeMs, served, project, ticketsDir, policy }`
- `GET /catalog?filter=` → `{ ok, commands: [{name, args, description, allowed}] }`
  (live `help` output, cached; `allowed` reflects the policy below)
- `POST /command` — body IS the WBT JSON command object (flat fields, e.g.
  `{"command":"describe-landblock","lbX":42,"lbY":33}`); optional `timeoutMs`
  is consumed by the sidecar, not forwarded. → `{ ok:true, response }` |
  `{ ok:false, error }` (403 when the policy refuses).
- `POST /ticket` — `{ title, body, severity?, character?, position?, context? }`
  → `{ ok, id, file }`. Written as one JSON file per ticket + appended to
  `tickets.jsonl` in the tickets dir.
- `GET /tickets?limit=` → newest-first list for the developer.

## Policy

Deny-by-default with a curated **read-only allowlist** (~59 commands: get-*/
list-*/describe/query/validate/diag/spell-get/asset-refs/…, curated from the
live catalog and then code-audited 2026-07-17 — see `READ_ALLOW` in
`wbt_sidecar.cjs`). Terrain/DAT/DB mutation, imports/exports, ingest jobs and
`load` are operator-only; `quit` is always refused (it kills the child).
`WBT_ALLOW=all` opens the command list for a trusted local setup.

**Argument screening** (write-audit 2026-07-17, applied to EVERY /command
regardless of WBT_ALLOW): output-path args (`out`, `outputPath`, …) are
refused outright — the audited commands (render-preview, mine-strings,
region-/scene-export-json, pvs-visibility-snapshot) all return their payload
inline without them, and with them they are an arbitrary-file-overwrite
primitive. Input-path args (`datPath`, `otherDat`, `otherJson`, `path`, …)
must resolve under `WBT_DAT_ROOTS` (default `~/ac_base_dats`, colon-
separated) so the bot can't point the DAT parser at arbitrary files.
Three commands failed the audit outright and were dropped from the
allowlist: `compute-vanilla-baseline` (writes a file even with no args),
`dump-lb-expectations` (output path effectively required), and
`difficulty-gradient` (input path is its whole purpose). `WBT_UNSAFE_ARGS=1`
disables screening for trusted operator drivers — never set it for the bot.

## Protocol notes

WBT `--stdin` speaks JSON-line: one `{"command":"ready"}` banner at boot, then
exactly one JSON response line per command line. The sidecar strictly
serializes commands (one in flight; queue behind), so "next stdout line" IS
the response. A per-command timeout means wedged-or-desynced — the sidecar
kills and respawns WBT (5 s backoff) rather than risk pairing later responses
with the wrong requests. The child restarts automatically on crash.
