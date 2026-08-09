# T02 findings — manifest strict-parser sweep + private fetch-caller sweep (T12 inputs)

Sweeps executed 2026-08-08 per SPEC §3 T02 (sources: pass 9 Q3 / H-09.2a; pass 11 Q3 +
F-11.6). Every row below was read-verified this session (file opened, parse behavior
confirmed — not grep-inferred). T10-owned files (`apps/holtburger-tools/**`,
`crates/holtburger-manifest/**`, `scripts/serve.py`) were swept at COMMITTED state via
`git show HEAD:<path>` because T10 has uncommitted WIP in them; live-tree lines may
drift as T10 lands.

Scope note on "manifest.json": the repo contains SEVEN distinct manifest classes that
match a naive `rg manifest.json`. Table 1 covers the **dist world manifest**
(`dist/manifest.json` — the file gaining v2+ additive fields per SPEC §1.1). §1.3
disposes of the other classes so future sweeps don't re-litigate them.

---

## 1. Sweep 1 — manifest.json readers: strict vs tolerant

**Verdict (answers pass 9 Q3): ZERO strict parsers of the dist world manifest exist
anywhere in the repo.** Additive v2+ fields (`world_index`, `pack_url_template`) are
safe against every reader found. `#[serde(deny_unknown_fields)]` appears NOWHERE in the
workspace (`rg -g '*.rs' deny_unknown_fields` → only comments explicitly declining it:
`apps/holtburger-tools/src/bin/scenery-bake.rs:858,1910`,
`apps/holtburger-tools/src/bin/scenery-cross-check.rs:130`). The only version-strict
site is the intended `UnsupportedVersion` guard (version ∉ {1,2}) — exactly the
"deployed clients hard-fail on version ≠ 1,2" premise SPEC §1.1 already carries.

### 1.1 The single Rust parse path (serves BOTH wasm instances + native tests)

| # | reader | evidence | classification |
|---|--------|----------|----------------|
| 1 | `ManifestResourceSource::connect` — the ONLY code that parses dist-manifest JSON | `crates/holtburger-resource-http/src/manifest_source.rs:341-365`: `ManifestVersionProbe` sniff (`:344-346`) → route v1 (`:348-356`) / v2 (`:358-363`) / `Err(UnsupportedVersion)` (`:364`; error defined `:160-162`, message `:175-178` "expects 1 or 2") | TOLERANT of unknown fields; STRICT on version sentinel (by design, matches SPEC §1.1 presence-routing plan) |
| 2 | `ManifestV2` struct | `crates/holtburger-manifest/src/v2.rs` (@HEAD): `#[derive(Serialize, Deserialize, ...)]` at `:141` (BootPackV2), `:189-190` (ManifestV2), `:239-242` (probe) — no `deny_unknown_fields` anywhere in the crate | TOLERANT — serde default ignores unknown keys. Proven in-tree: test `version_probe_sniffs_all_versions` parses `{"version": 2, "anything": "else"}` (`v2.rs:495-498`) |
| 3 | v1 `Manifest` struct | `crates/holtburger-manifest/src/lib.rs:68-69` (+ `:91`, `:101`, `:114` sub-structs) — plain serde derives | TOLERANT (only reachable when `version: 1`) |
| 4 | main-thread wasm entry | `apps/holtburger-web/src/global_source.rs:60-63` `init_resource_source(manifest_url)` → `ManifestResourceSource::connect`; URL supplied by `index.html:1638` (`MANIFEST_URL = "../../dist/manifest.json"`) at `index.html:2694` | delegates to row 1 — no JS-side parse |
| 5 | bake-worker wasm entry (2nd instance, SAME code) | `scene3d/bake_worker.js:170` `await init_resource_source(msg.manifestUrl)`; URL threaded from `index.html:2778` `configureBakeWorker({ manifestUrl: MANIFEST_URL })` | delegates to row 1 |

The "two wasm-side parse paths" of the task charge are two *instances* of ONE parser —
there is no divergent second implementation to audit. (The per-namespace catalog
binaries are magic/version-strict — `crates/holtburger-manifest/src/catalog.rs:57`
`CATALOG_MAGIC`, `:115-116` reject-unknown-version, `:218` magic check @HEAD — but they
are a separate wire object (`manifest/<slug>.bin`), untouched by manifest.json additive
fields.)

### 1.2 JS / Node / tooling readers of the dist manifest

| # | reader | evidence | classification |
|---|--------|----------|----------------|
| 6 | service worker bake-identity gate | `service-worker.js:216-247` `currentBakeId`: `res.json()` then `m?.boot_pack?.sha256 ?? ""`, `m?.catalog_version ?? ""`, `m?.generated_at ?? ""` (`:227-230`); all-absent → null → `bakeGateAllowsCache` returns false (`:281-284`) = serve network, never throw | TOLERANT; fails SAFE (no-cache) if fields vanish. Gate is deleted by SW v3 (SPEC §1.1) |
| 7 | diag integrity surface | `scene3d/diag/integrity.js:88-122` `verifyManifests`: fetch + `resp.json()` (`:90-92`), optional-chained `manifest?.boot_pack?.url` (`:110`), missing fields → diag row `"manifest missing boot_pack.{url,sha256}"` (`:115-119`), never throws | TOLERANT (diagnostic-only) |
| 8 | smoke harness | `apps/holtburger-web/smoke_test.cjs:2338-2347`: `JSON.parse` → mutates `catalog_url_template` + `shard_url_template` only → re-`stringify` (unknown fields round-trip verbatim) | TOLERANT |
| 9 | soa/aos parity test | `tests/soa_aos_parity.test.cjs:377-396`: `fs.existsSync(manifestPath)` presence gate only, then URL → `wasm.init_resource_source(manifestUrl)` (`:410`) | TOLERANT (presence + delegate) |
| 10 | SW bake-gate test | `test_service_worker_bake_gate.mjs:139-180`: writes its OWN v2 fixture manifests; never reads a real one | N/A (fixture-driven; retires with the SW-v3 gate deletion — T12 handoff) |
| 11 | presence-gate scripts (6) | `capture_phase_d_spawns.cjs:78`, `capture_f41_hudriffa.cjs:241`, `capture_world_expand_e2e.cjs:204`, `validate_event_completeness.cjs:191`, `validate_landblock_completeness.cjs:186`, `investigate_followon4.cjs:21` — all `fs.existsSync(...manifest.json)` then hand the URL to wasm | TOLERANT (never parse) |
| 12 | URL-delegator probes (5) | `probe_mite_mtable.cjs:31`, `probe_phase11_normals.cjs:26`, `diagnostics/classifier.html:251`, `probe_academy_bake.html:41`, `probe_academy_envcells.html:39` — URL → `init_resource_source` | TOLERANT (delegate to row 1) |
| 13 | serve.py (@HEAD — T10-owned) | `scripts/serve.py:92` `REQUIRED_FILE = ["manifest.json"]`; health check `:211-215` is `f.is_file()` PRESENCE only; `:625` header rule matches the *path string*, never the body. JSON is never parsed | TOLERANT |
| 14 | proxy.cjs | `scripts/proxy.cjs:67-73`: immutable-class decision is a URL regex (`/^\/dist\/shards\//`); manifest body never parsed | TOLERANT |
| 15 | dat-shard (@HEAD — T10-owned) | `apps/holtburger-tools/src/bin/dat-shard.rs:137` — WRITER only | N/A |
| 16 | sharding tests (@HEAD — T10-owned) | `apps/holtburger-tools/tests/sharding.rs`: consume the in-memory `Manifest` from `shard_bundle` (`:71-91`) — same tolerant structs; **`v2_top_level_manifest_under_5kb` (`:236-250`) asserts the EMITTED manifest.json < 5 KB** | TOLERANT as a parser; size-STRICT as an emission gate — see finding S-1 |

### 1.3 Excluded manifest classes (different files; enumerated so they stay excluded)

- **plugin manifests** — `plugins/*.manifest.json` + `plugins/index.json` (+
  `plugins/schemas/plugin-manifest.json`, `plugins/gen-index.mjs`, `plugins/loader.js:857`
  `fetchManifestIndex`, `tests/plugin_*.cjs`, `tests/keymap_manifest.test.cjs`). UI
  plugin system; no relation to the dist manifest.
- **icon manifest** — `data/icon-manifest.json` (`ui/ac_icon_cache.js:269` reader,
  `scripts/build_icon_manifest.py:49` writer).
- **tex-overrides manifest** — `data/tex-overrides/manifest.json`
  (`scene3d/tex_overrides.js:25,66`; wasm transport `src/texture_overrides.rs:13`).
- **terrain-bc7 tier manifest** — `scene3d/assets/terrain_bc7/manifest.json`
  (`scene3d/terrain_bc7.js:269-315`). ⚠ The ONE genuinely strict manifest parser
  found in the sweep: it THROWS unless `Object.keys(m.layers).length ===
  TERRAIN_BC7_DEPTH` (33) and validates `tileSize`/`levels`
  (`terrain_bc7.js:292-300`) — fail-soft to flag-no-op (`:315`). Strict on ITS OWN
  schema, not the dist manifest; see finding S-2 for the T10/T12 implication.
- **pbr-terrain manifest** — `scene3d/assets/pbr_terrain/manifest.json`
  (`scene3d/adapter.js:1588-1590,1628`; opt-in `?pbrTerrain`).
- **texchan suite manifest** — `dist/suite/texchan-manifest.json`
  (`scene3d/suite_assets.js:268-277`, `harness/test_texchan_decode.mjs:20`,
  `crates/holtburger-dat/examples/bake_texchan.rs:180` writer /
  `verify_texchan.rs:112-114` reader — the reader is `serde_json::from_slice(...)
  .unwrap_or_default()`, maximally tolerant).
- **terrain-macro manifest** — `scene3d/assets/terrain_macro/manifest.json`
  (`generate.py:279` writer only).

### 1.4 Sweep-1 findings for T12 (and one for T10)

- **S-0 (the answer):** additive v2+ fields are SAFE repo-wide. No reader breaks; the
  serde structs ignore unknown keys; every non-Rust consumer either checks presence,
  round-trips, or optional-chains. Pass 9 Q3 / H-09.2a can be closed.
- **S-1 (for T10):** `sharding.rs:236-250` asserts emitted `manifest.json` < 5 KB —
  the only size-strict manifest gate in the tree. `world_index` +
  `pack_url_template` additions are tens of bytes (fine), but T10 should keep this
  assert in view when extending emission.
- **S-2 (for T10/T12):** if the t128 single-file slice (SPEC D-12.6) is wired through
  the existing terrain-bc7 manifest shape, `terrain_bc7.js:292-296`'s exact-33-layer
  and `levels >= 2` checks are the strict contract the new emission must satisfy —
  or the loader must be replaced outright (it is also the F-11.6 fetch site slated
  for controller routing; see row F-1).
- **S-3 (for T12):** the SW bake-identity gate composes its id from
  `boot_pack.sha256 : catalog_version : generated_at` (`service-worker.js:227-231`).
  Any future manifest that drops all three degrades to gate-null = never-serve-cache
  (`:282-284`) — safe but cache-dead. SW v3 deletes the gate; until then, keep the
  three fields present (the v2+additive plan does).

---

## 2. Sweep 2 — private fetch callers outside the future PackFetchController

Method: `rg 'fetch\(|XMLHttpRequest|new Request\('` over `scene3d/` + `index.html`,
plus `TextureLoader|ImageLoader|loadAsync|new Image\(|importScripts` for non-fetch
network loads, plus `fetch_bytes` over the wasm crate (`apps/holtburger-web/src/lib.rs`
— the wasm instances fetch with browser `fetch` under the hood via
`holtburger_resource_http::fetch_bytes`, `crates/holtburger-resource-http/src/http.rs:44`).
`scene3d/net_worker.js` / `scene3d/keepalive_worker.js` contain no fetch sites.

**Verdict (answers pass 11 Q3): the F-11.6 class has SIX world-data members beyond the
known terrain one** — per-LB scenery JSONL, per-LB spawns JSONL, per-LB events JSONL,
per-artifact suite bins, the vfx catalog, and `wcid_to_setup.json` — plus a tail of
static-asset and diagnostic fetchers that should stay OUTSIDE the controller, and one
external-origin fetch on the bare-default boot (stars.bin).

### 2.1 World/dist data — must route through controller lanes or retire (T12/ST10)

| # | caller (file:line) | URL pattern | bytes class | T12 disposition |
|---|--------------------|-------------|-------------|-----------------|
| F-1 | `scene3d/terrain_bc7.js:288` (`loadTerrainBc7Manifest`) + `:325` (`_fetchPayload`) | `scene3d/assets/terrain_bc7/<tier>/manifest.json` + per-payload HBC7 (~30/channel; `DEFAULT_BASE` `:89`) | 0.63 MB/channel t128; 44 MiB/channel t1024 | THE known F-11.6 member. t128 → 2 single-CAS-file fetches on lane B (D-12.6); t1024 stays per-payload on lane T — both THROUGH the controller. Strict layer-count check noted in S-2 |
| F-2 | wasm `fetch_landblock_scenery` — `src/lib.rs:3305` (fetch at `:3318`); freeze-hash gate `:3472-3474`; sha-log `:3513-3523`; base set by `scene3d/statics.js:397` (`SCENERY_BASE_URL` `:371`) | `dist/scenery/0x<lb>.scenery.jsonl` (+ `bake-source.sha256`) | ~KB–tens of KB per LB, per-LB cadence, BOTH wasm instances | Content moves into tile-pack PLACEMENTS/inline records (SPEC §1.1); reads via PackSource; direct fetch retires with the legacy lane's world traffic (ST10) |
| F-3 | wasm spawns `fetch_one_lb` — `src/lib.rs:4233` (fetch at `:4246`); sha-log `:4308-4318` | `dist/spawns/0x<lb>.spawns.jsonl` | per-LB cadence | Tile-pack SPAWNS section (zstd JSONL v1, SPEC §1.1); same retirement path as F-2 |
| F-4 | `scene3d/spawns.js:217-219` (`wcid_to_setup.json` one-shot) | `dist/spawns/wcid_to_setup.json` | one file, boot-adjacent | CORE/commons pack member or lane-B controller fetch; do not leave as a private one-off |
| F-5 | `scene3d/audio/baked_ambient_source.js:167-168` (base `EVENTS_BASE_URL` `:31`) | `dist/events/0x<lb>.events.jsonl` | per-LB cadence | Tile-pack EVENTS section (SPEC §1.1); route through controller until pack flip |
| F-6 | wasm `fetch_suite_artifact` `src/lib.rs:3720` (fetch `:3734`) + `fetch_suite_artifact_by_key` `:3764` (fetch `:3777`); base via `scene3d/suite_assets.js:30` (`init_suite_base_url`); JS manifest read `suite_assets.js:277` | `dist/suite/<stem>.bin` + `texchan-manifest.json` | per-artifact (content-hashed stems) | ⚠ SPEC GAP — see finding F-A below |
| F-7 | `scene3d/vfx_catalog.js:144` (`_catalogUrl` = `:59` default) | `dist/vfx/visual_descriptors.jsonl` | one JSONL, fail-soft (`:150-151`) | CORE pack member or lane-B controller fetch |
| F-8 | legacy record lane — `crates/holtburger-resource-http` (`http.rs:44` `fetch_bytes`; manifest_source prefetch) | `manifest.json`, `boot.hba`, `shards/…`, `manifest/<slug>.bin` | the 885k-record population | NOT a bypass — this IS the designed permanent legacy lane (SPEC §1.1), concurrency share 8 under the global cap at T12 |

### 2.2 Static app assets — leave as static (SW v3 `/scene3d/assets/` SWR class)

| # | caller | URL pattern | notes |
|---|--------|-------------|-------|
| F-9 | `scene3d/terrain_macro.js:150-161` (`Image()`) | `scene3d/assets/terrain_macro/macro_<key>.png` | 9 MB PNG set; already the SW SWR precedent (`service-worker.js:293-302` `isSwrCacheable`) |
| F-10 | `scene3d/adapter.js:1408-1420` (`loadDetailTileCache`), `:1487-1491`, `:1603-1607` | `scene3d/assets/detail/`, `assets/pbr_terrain/*.png` (+ manifest `:1628`) | detail tiles + opt-in `?pbrTerrain` |
| F-11 | `scene3d/cloud_overlay.js:335-345` (fetch, R8 noise `.bin`), `:365` (TextureLoader), `:382` | `scene3d/assets/clouds/` | volumetric cloud noise + weather maps |
| F-12 | `scene3d/atmosphere_runtime.js:34,68-75` (takram `PrecomputedTexturesLoader`) | `scene3d/assets/atmosphere/*.exr` | sky LUTs; GPU-bake fallback on failure |
| F-13 | `scene3d/ac_moons.js:396-401` (TextureLoader) | `scene3d/assets/moons/{albarel,rezarel}.png` | |
| F-14 | `scene3d/selection_brackets.js:165-171,225-228` (`Image()`) | `scene3d/assets/ui_brackets/corner_*.png` | |
| F-15 | `scene3d/xu7_textures.js:409-421` | `scene3d/transcoder/basis_transcoder.js` (fetch+eval `:414-419`) + `.wasm` via emscripten `locateFile` (`:421`) | 1.04 MB wasm, stable-named. ST4 moves transcode into the texture worker → the WORKER needs its own copy; ST-SHELL should decide hash-vs-stable naming (T11/T14 handoff) |
| F-16 | data JSON tables: `index.html:2216` (xp-tables), `scene3d/index.js:1925` (surface-colors), `scene3d/terrain.js:502` (terrain_palette), `scene3d/diag/cast.js:517` + `diag/combat.js:43` (motion-command-names), `scene3d/entities.js:7595-7600` (playscript-canonical map), `scene3d/tex_overrides.js:66,80` (opt-in), `plugins/api.js:154` (spell-components) | `data/*.json` | app-static; bundle candidates at ST-SHELL, never controller traffic |
| F-17 | `index.html:2266` (`WebAssembly.compileStreaming(fetch(__hbWasmUrl))`) | `pkg/holtburger_web_bg.wasm` | shell class — ST-SHELL owns |

### 2.3 External-origin and diagnostic fetchers

| # | caller | URL | notes |
|---|--------|-----|-------|
| F-18 | `scene3d/atmosphere_sky.js:176-179` stars.bin | **EXTERNAL** `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/<tag>/packages/atmosphere/assets/stars.bin` (`vendor/takram/three-atmosphere.js:5724`) | ⚠ see finding F-B — fires on bare-default boots |
| F-19 | `index.html:5924` server list | **EXTERNAL** `https://raw.githubusercontent.com/acresources/serverslist/master/Servers.xml` (`:5775-5778`) | login-UI convenience, localStorage-cached 1 h (`:5777`); network config, not world data — leave, but name it in T12's "known external origins" list |
| F-20 | diag-only: `scene3d/diag.js:319-323` (`loadExpected`), `scene3d/diag/pvs.js:180` (oracle), `scene3d/diag/integrity.js:43,90,133,184` (spot-checks + sha sidecars), `index.html:2819` (`dist/_health.json`, dev banner) | harness-supplied / dist sidecars | diagnostic surfaces; stay OUTSIDE the controller (their traffic must not perturb lane accounting; runs using them are already taint-class) |

Audio note: sound WAV bytes flow through wasm `fetchWave` (`src/lib.rs:54443-54444`)
→ the record lane (F-8), not a private HTTP path — no separate audio fetch track
exists (the "audio?" in the task charge resolves to F-5 events JSONL + F-8 records).

### 2.4 Sweep-2 findings for T12

- **F-A — SPEC gap (candidate DEVIATION input for T12's brief, not a SPEC edit):**
  the suite-artifact track (F-6) has a §1.4 residency budget (SUITE 16 MiB) but NO
  fetch-lane assignment in SPEC §1.1 — `fetch_suite_artifact` is a wasm-side direct
  fetch that will bypass the controller's global cap unless T12 assigns it a lane
  (natural fit: legacy-lane share, or lane R). The texchan sidecar corpus is R-09
  (post-v1), but the FETCH routing decision lands at T12 regardless.
- **F-B — external-origin fetch on the bare-default boot:** `AtmosphereSky` is
  constructed WITHOUT `starsUrl` (`scene3d/index.js:5442-5447`), so stars.bin loads
  from the takram GitHub media CDN by default (F-18); no local copy exists in the
  tree (`find . -name stars.bin` → none). Fail-soft (`atmosphere_sky.js:198` warn,
  sky renders without stars) — but it is an unbudgeted, third-party-origin,
  non-`no-transform` dependency that contradicts §1.1's HTTP contract assumptions
  and adds cold-boot jitter to BOOT-666 request counts. Cheap fix (out of T02
  scope): vendor stars.bin into `scene3d/assets/` and pass `starsUrl`.
- **F-C — the wasm instances are fetch actors:** F-2/F-3/F-6 fire from BOTH wasm
  instances (main + bake worker — `bake_worker.js:170` init gives the worker its own
  scenery/spawns/suite caches and fetch paths). SPEC §1.1's "wasm instances never
  fetch packs" invariant therefore requires T12 to either (a) plumb these tracks
  through JS-side controller fetch + `insert_pack`-style admission, or (b) except
  them explicitly until their ST10 retirement. Today they self-cap only via the
  shared `fetch_sem` semaphore (`manifest_source.rs:330-334`) on the main instance's
  source.
- **F-D — request-count arithmetic:** at boot the non-terrain JSONL tracks add
  roughly (ring LBs × up to 3 files) requests on today's path (404s for empty LBs
  return fast but still count against HTTP concurrency); they are absent from the
  pass 3 S8.1 boot table for the same reason terrain was (F-11.6's "nobody added a
  request row"). They disappear into tile packs at ST2 — but the comparative
  cold-boot arm at GATE-WIRE-BOOT should EXPECT the legacy arm's request count to
  include them (BOOT-666 per-component table will make this visible).
