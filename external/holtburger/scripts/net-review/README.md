# scripts/net-review — verification harness from the net-review-20260709 review

Five artifacts authored by review part A16 (16-agent review of the net-transport-worker
era, master @ 8e686c8c), landed verbatim; `ci-smoke.sh` is the executable wiring for
`ci-smoke.md`. The review synthesis (findings R-1…R-19, fix plan, decision criteria)
lives off-repo in the review job dir (`net-review-20260709/SYNTHESIS.md`).

| file | purpose | decides |
|---|---|---|
| `white-texture-detector.mjs` | classify every entity-part material: shared-fallback (GREY) / no-map-white / map-white-texels / map-not-uploadable / emissive-white; transition journal | S1 (white textures); ci-smoke S3 |
| `tn-teleport-freeze-probe.mjs` | stage-attributed timeline of a Town Network teleport (tLanded / tResidencyPeak / tEvictDrained / tFramesRecovered + longtasks) | S2 attribution; bisect with `--query` arms |
| `networker-ab.mjs` + `networker-ab.sh` | N boots × `?netWorker=0/1`: wire rates, movement speed, rubber-band snaps, 10 s-freeze survival | netWorker A/B + "slows down while running" |
| `marketplace-ab-1070.md` | GTX-1070 CDP A/B recipe, master vs marketplace-freeze-fix; M1 p95 / M2 programs / M3 fps with KEEP/REVERT thresholds | S3 (Phase 3 — 1070 only) |
| `ci-smoke.md` / `ci-smoke.sh` | per-land regression net: S0 wasm size+staleness, S1 boot, S2 zero console.error, S3 whiteNow==0, S4 keepalive | every land |

## Standing rules (from the review's live-verification queue — violating these voids a run)
- `?nosw=1` on EVERY dev URL (the service worker caches index.html/shards across restarts).
- `&adaptiveRes=off` on every measurement arm unless adaptive-res is itself under test.
- Record wasm bytes+mtime in every run's meta; release ≈ 4.2–4.7 MB, dev ≈ 17–19 MB (S0 catches this).
- Gate on `__bootState === 'in-world'` (or present in `__bootStateHistory`) AND `getLocalPlayerPose() != null`. Never gate session probes on `'ready'`.
- Re-poll `window.liveScene3d` after every teleport (transiently nulled).
- ≥60 s between relogin arms (ACE ghost-session window) until a clean-logoff Disconnect packet lands.
- SwiftShader (laptop) cannot see shader-link stalls (`isReady()` hardwired true) — program/link
  conclusions need the 1070; fresh `--user-data-dir` per arm there (Chrome's disk program cache
  is often exactly what's under test).
- Prereqs: `scripts/serve.py` on :8765 (prefer `--check` over `--allow-missing` — a partial
  world silently corrupts results) and local ACE on 127.0.0.1:9000. Boot library:
  `apps/holtburger-web/harness/lib/boot.mjs` (override with `BOOT_MJS=`).
