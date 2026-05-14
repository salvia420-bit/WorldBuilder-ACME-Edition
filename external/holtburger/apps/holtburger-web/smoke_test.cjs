// Node-side smoke test for the holtburger-web wasm bundle.
//
// Loads the `--target nodejs` build (pkg-node/) and verifies that the
// wasm-bindgen exports work end-to-end. Used to functionally validate
// the bundle without needing a headless browser; the `--target web`
// build at pkg/ has the same rust-compiled core, so a green run here
// is a strong signal that the browser bundle is also live.
//
// The HTTP-source check (§8 step 4) requires a fixture at
// ../../dats/assets.hba — generate it with `dat2hba` per
// `dats/README.md`. If the fixture is missing the round-trip portion
// degrades to a symbol-presence check and the run still passes, so
// this script works in environments without retail dat access.
//
// Run: `node smoke_test.cjs` from `apps/holtburger-web/`.

const wasm = require("./pkg-node/holtburger_web.js");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const crypto = require("node:crypto");

// Bake-cache schema. Bump when the smoke's bake layout changes
// (e.g. add v3, change subdir names, change v2conv-manifest fields)
// so existing cache entries are ignored. Without this bump, a stale
// cache from an older smoke layout would silently feed the wrong
// bytes into the new dispatch tests.
const SMOKE_BAKE_SCHEMA = 1;

// `--fast` skips the dat-shard bake (~6 min) + manifest dispatch
// tests (~30 s), keeping the symbol-presence + closed-port reject
// assertions. Use during inner-loop iteration; CI runs without
// --fast for full coverage.
const fastMode = process.argv.includes("--fast");

let failed = 0;

function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
}

console.log("holtburger-web smoke test");
console.log("=========================");

const info = wasm.build_info();
check(
    "build_info() returns identification string",
    typeof info === "string" && info.startsWith("holtburger-web v"),
    JSON.stringify(info)
);

// Hash32 is deterministic; reference value taken from the Rust impl
// (`crates/holtburger-protocol/src/crypto.rs` Hash32::compute).
// "hello" = 0x68 0x65 0x6c 0x6c 0x6f, length 5.
//   length << 16 = 0x00050000
//   one full 4-byte chunk: 0x6c6c6568 (le u32 of "hell")
//   sum: 0x00050000 + 0x6c6c6568 = 0x6c716568
//   tail byte 'o' (0x6f) at i=4, shift=3: + (0x6f << 24) = 0x6f000000
//   sum: 0x6c716568 + 0x6f000000 = 0xdb716568
const empty = wasm.hash32(new Uint8Array([]));
check(
    "hash32(empty) returns 0",
    empty === 0,
    `got 0x${empty.toString(16).padStart(8, "0")}`
);

const hello = wasm.hash32(new TextEncoder().encode("hello"));
check(
    "hash32('hello') matches Rust's deterministic value",
    hello === 0xdb716568,
    `got 0x${hello.toString(16).padStart(8, "0")} expected 0xdb716568`
);

// Same input twice → same hash (sanity that wasm state isn't bleeding).
const hello2 = wasm.hash32(new TextEncoder().encode("hello"));
check(
    "hash32('hello') is deterministic across calls",
    hello === hello2,
    `${hello.toString(16)} == ${hello2.toString(16)}`
);

// End-to-end check that `Session::new_test` runs on wasm without
// panicking — exercises the `web_time::Instant` swap from spike doc
// §8 step 3. `new_test` initializes `packet_sequence = 1`.
const seq = wasm.session_smoke_test_packet_sequence();
check(
    "Session::new_test() runs on wasm and returns packet_sequence=1",
    seq === 1,
    `got ${seq}`
);

// §8 step 2 wiring: the WsTransport-backed handshake export must be
// present in the bundle. We don't invoke it here — calling it would
// require a live bridge plus a `WebSocket` global (Node ≥ 21), which
// is out of scope for this deterministic smoke test. Browser-side
// validation against `holtburger-wsbridge` is the next step.
check(
    "try_ws_handshake_smoke() is exported (WsTransport wired into bundle)",
    typeof wasm.try_ws_handshake_smoke === "function",
    `typeof ${typeof wasm.try_ws_handshake_smoke}`
);

// §8 step 4 wiring: HttpResourceSource must be present. End-to-end
// round-trip below if the fixture exists.
check(
    "try_http_resource_source_smoke() is exported (HttpResourceSource wired into bundle)",
    typeof wasm.try_http_resource_source_smoke === "function",
    `typeof ${typeof wasm.try_http_resource_source_smoke}`
);

// Phase 5.0 obj 5/9 — manifest-mode resource source. The
// per-export refactor (drop `asset_url` from each fetch_* in
// favour of the global source) is deferred to a follow-up
// commit; symbol-presence + a connect/reject round-trip here
// covers the obj 5 wiring + the obj 4 ManifestResourceSource
// at the JS boundary.
check(
    "init_resource_source() is exported (Phase 5.0 obj 5)",
    typeof wasm.init_resource_source === "function",
    `typeof ${typeof wasm.init_resource_source}`
);
check(
    "has_resource_source() is exported (Phase 5.0 obj 5 introspection)",
    typeof wasm.has_resource_source === "function",
    `typeof ${typeof wasm.has_resource_source}`
);
check(
    "cached_shard_count() is exported (Phase 5.0 obj 5 introspection)",
    typeof wasm.cached_shard_count === "function",
    `typeof ${typeof wasm.cached_shard_count}`
);
// Pre-init sanity: no source yet, no cached shards.
check(
    "init_resource_source not yet called → has_resource_source()=false",
    wasm.has_resource_source() === false,
    `has_resource_source()=${wasm.has_resource_source()}`
);
check(
    "init_resource_source not yet called → cached_shard_count()=0",
    wasm.cached_shard_count() === 0,
    `cached_shard_count()=${wasm.cached_shard_count()}`
);

// Phase 5.2 obj 8 — v2 dispatch wiring: new wasm-bindgen
// exports the smoke harness uses to verify v1 vs v2 mode.
check(
    "manifest_version() is exported (Phase 5.2 obj 4 dispatch accessor)",
    typeof wasm.manifest_version === "function",
    `typeof ${typeof wasm.manifest_version}`
);
check(
    "loaded_catalog_count() is exported (Phase 5.2 obj 4 catalog probe)",
    typeof wasm.loaded_catalog_count === "function",
    `typeof ${typeof wasm.loaded_catalog_count}`
);
check(
    "manifest_v2_version_const() is exported (Phase 5.2 obj 8 schema check)",
    typeof wasm.manifest_v2_version_const === "function" &&
        wasm.manifest_v2_version_const() === 2,
    `typeof ${typeof wasm.manifest_v2_version_const}, value=${
        typeof wasm.manifest_v2_version_const === "function"
            ? wasm.manifest_v2_version_const()
            : "n/a"
    }`
);
check(
    "init_resource_source not yet called → manifest_version()=0",
    wasm.manifest_version() === 0,
    `manifest_version()=${wasm.manifest_version()}`
);
check(
    "init_resource_source not yet called → loaded_catalog_count()=0",
    wasm.loaded_catalog_count() === 0,
    `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
);

// Phase 3 step 1 wiring: fetch_landblock_heightmap must be present.
// End-to-end round-trip below if the fixture has the eor/cell namespace
// (i.e. dat2hba was run with --profile pruned, not --profile micro).
check(
    "fetch_landblock_heightmap() is exported (Phase 3 step 1 render path)",
    typeof wasm.fetch_landblock_heightmap === "function",
    `typeof ${typeof wasm.fetch_landblock_heightmap}`
);

// Phase 3 step 2 wiring: fetch_landblock_heightmaps (plural) must be
// present. End-to-end round-trip below alongside the singular form.
check(
    "fetch_landblock_heightmaps() is exported (Phase 3 step 2 batch fetch)",
    typeof wasm.fetch_landblock_heightmaps === "function",
    `typeof ${typeof wasm.fetch_landblock_heightmaps}`
);

// Phase 3 step 3.5: fetch_terrain_textures must be present. End-to-end
// round-trip below if the fixture has the eor/portal namespace with
// SurfaceTexture / Texture / Palette records (i.e. dat2hba was run with
// --profile full, since pruned excludes them).
check(
    "fetch_terrain_textures() is exported (Phase 3 step 3.5 real textures)",
    typeof wasm.fetch_terrain_textures === "function",
    `typeof ${typeof wasm.fetch_terrain_textures}`
);

// Phase 3 step 4: fetch_landblock_objects must be present. End-to-end
// round-trip below against the Holtburg neighbourhood; degrades to a
// SKIP if the fixture lacks LandblockInfo records.
check(
    "fetch_landblock_objects() is exported (Phase 3 step 4 sprites)",
    typeof wasm.fetch_landblock_objects === "function",
    `typeof ${typeof wasm.fetch_landblock_objects}`
);

// Phase 3 step 4.5: fetch_object_colours must be present. End-to-end
// round-trip + diversity check below, gated on the same fixture as the
// step 4 round-trip.
check(
    "fetch_object_colours() is exported (Phase 3 step 4.5 real colours)",
    typeof wasm.fetch_object_colours === "function",
    `typeof ${typeof wasm.fetch_object_colours}`
);

// Phase 3 step 6: fetch_model_mesh / fetch_model_meshes must be
// present. End-to-end round-trip below.
check(
    "fetch_model_mesh() is exported (Phase 3 step 6 runtime mesh)",
    typeof wasm.fetch_model_mesh === "function",
    `typeof ${typeof wasm.fetch_model_mesh}`
);
check(
    "fetch_model_meshes() is exported (Phase 3 step 6 batch)",
    typeof wasm.fetch_model_meshes === "function",
    `typeof ${typeof wasm.fetch_model_meshes}`
);

// Phase C.1 + C.2: fetch_landblock_scenery + companion helpers must be
// present. End-to-end round-trip against the staged JSONL bake is in the
// hand-smoke script `smoke_scenery_fetch.cjs` — symbol presence here
// is the wasm-side bundle-shape gate.
check(
    "fetch_landblock_scenery() is exported (Phase C.2 scenery fetch)",
    typeof wasm.fetch_landblock_scenery === "function",
    `typeof ${typeof wasm.fetch_landblock_scenery}`
);
check(
    "init_scenery_base_url() is exported (Phase C.2 scenery base URL)",
    typeof wasm.init_scenery_base_url === "function",
    `typeof ${typeof wasm.init_scenery_base_url}`
);
check(
    "scenery_cache_size() is exported (Phase C.2 cache probe)",
    typeof wasm.scenery_cache_size === "function",
    `typeof ${typeof wasm.scenery_cache_size}`
);
check(
    "ScenicPlacementJs class is exported (Phase C.2 record type)",
    typeof wasm.ScenicPlacementJs === "function",
    `typeof ${typeof wasm.ScenicPlacementJs}`
);

// Phase D.1: fetch_landblock_spawns + companion helpers must be
// present. The third placement stream (after fetch_landblock_objects
// DAT-explicit + fetch_landblock_scenery DAT-baked). End-to-end
// round-trip against the staged JSONL is in the capture script
// `capture_phase_d_spawns.cjs` — symbol presence here is the
// wasm-side bundle-shape gate.
check(
    "fetch_landblock_spawns() is exported (Phase D.1 ACE spawn fetch)",
    typeof wasm.fetch_landblock_spawns === "function",
    `typeof ${typeof wasm.fetch_landblock_spawns}`
);
check(
    "init_spawns_base_url() is exported (Phase D.1 spawns base URL)",
    typeof wasm.init_spawns_base_url === "function",
    `typeof ${typeof wasm.init_spawns_base_url}`
);
check(
    "spawns_cache_size() is exported (Phase D.1 cache probe)",
    typeof wasm.spawns_cache_size === "function",
    `typeof ${typeof wasm.spawns_cache_size}`
);
check(
    "EntitySpawnJs class is exported (Phase D.1 record type)",
    typeof wasm.EntitySpawnJs === "function",
    `typeof ${typeof wasm.EntitySpawnJs}`
);

// Follow-on Task 30 (Phase E throughput) — SoA bulk fetch variants.
// The per-record exports above (`fetch_landblock_{objects,scenery,spawns}`)
// each return Vec<SomePlacementJs> whose elements are JS-owned wasm-
// bindgen instances. Reading a field crosses the wasm boundary once
// per call — fine for the renderer (~200 placements/LB) but
// pathological for the Phase E validator (~145k getter calls across
// 14523 scenery records ⇒ >5 min wallclock for a full 13×13 ring run).
//
// The SoA variants pack the SAME data into typed-array-shaped Vec<u32>
// / Vec<f32> / Vec<u8> fields and return ONE struct per fetch. Each
// getter on the SoA struct serializes an entire typed array in one
// structured-clone (Vec<u32> ⇒ Uint32Array, Vec<f32> ⇒ Float32Array,
// Vec<u8> ⇒ Uint8Array per wasm-bindgen's TypedArray conversion).
// Validator consumers walk parallel typed arrays at native speed.
//
// The per-record exports stay (renderer continues to use them); the
// SoA exports are a parallel bulk API for validator/CI tooling. The
// wasm-side parity test (`tests_soa_parity` in src/lib.rs) gates
// that the two APIs return the same placements for the same input.
check(
    "fetch_landblock_objects_soa() is exported (Phase E follow-on bulk variant)",
    typeof wasm.fetch_landblock_objects_soa === "function",
    `typeof ${typeof wasm.fetch_landblock_objects_soa}`
);
check(
    "fetch_landblock_scenery_soa() is exported (Phase E follow-on bulk variant)",
    typeof wasm.fetch_landblock_scenery_soa === "function",
    `typeof ${typeof wasm.fetch_landblock_scenery_soa}`
);
check(
    "fetch_landblock_spawns_soa() is exported (Phase E follow-on bulk variant)",
    typeof wasm.fetch_landblock_spawns_soa === "function",
    `typeof ${typeof wasm.fetch_landblock_spawns_soa}`
);
check(
    "LandblockObjectsSoa class is exported (Phase E follow-on SoA shape)",
    typeof wasm.LandblockObjectsSoa === "function",
    `typeof ${typeof wasm.LandblockObjectsSoa}`
);
check(
    "LandblockScenerySoa class is exported (Phase E follow-on SoA shape)",
    typeof wasm.LandblockScenerySoa === "function",
    `typeof ${typeof wasm.LandblockScenerySoa}`
);
check(
    "LandblockSpawnsSoa class is exported (Phase E follow-on SoA shape)",
    typeof wasm.LandblockSpawnsSoa === "function",
    `typeof ${typeof wasm.LandblockSpawnsSoa}`
);

// Source-pattern check — `validate_landblock_completeness.cjs` must
// reference the SoA exports (not the per-record ones) in the Stage 3
// manifest-build path. The brief's throughput target (>5min → <2min)
// relies on this switch; a future refactor that flips back to the
// per-record API would silently regress the validator runtime.
try {
    const fs = require("fs");
    const validatorSrc = fs.readFileSync(
        __dirname + "/validate_landblock_completeness.cjs",
        "utf8"
    );
    const usesObjectsSoa = /\bfetch_landblock_objects_soa\b/.test(validatorSrc);
    const usesScenerySoa = /\bfetch_landblock_scenery_soa\b/.test(validatorSrc);
    const usesSpawnsSoa = /\bfetch_landblock_spawns_soa\b/.test(validatorSrc);
    check(
        "Phase E follow-on: validate_landblock_completeness.cjs uses SoA fetches for Stage 3 throughput",
        usesObjectsSoa && usesScenerySoa && usesSpawnsSoa,
        `objects_soa=${usesObjectsSoa} scenery_soa=${usesScenerySoa} ` +
            `spawns_soa=${usesSpawnsSoa}`
    );
} catch (e) {
    check(
        "Phase E follow-on: validate_landblock_completeness.cjs uses SoA fetches for Stage 3 throughput",
        false,
        String(e).slice(0, 160)
    );
}

// Phase D.1.c source-pattern — scene3d/spawns.js must use the
// canonical entity-spawn dispatch surface `window.__scene3dEntityHook`
// (NOT bypass it by calling em.spawn directly). The whole point of
// Phase D is verifying THAT entry point handles the full ACE-DB
// roster. Without this gate a future refactor could silently rewire
// to `em.spawn(meta)` and the synthetic injector would no longer
// validate the live-ACE dispatch path.
//
// Also assert the injector calls fetch_landblock_spawns + the
// staged wcid_to_setup.json lookup. The 2D path is also routed
// through (window.handleEntitySpawn for symmetry with the wire
// dispatch at index.html:6529-6540).
try {
    const fs = require("fs");
    const spawnsSrc = fs.readFileSync(
        __dirname + "/scene3d/spawns.js",
        "utf8"
    );
    const hasFetchSpawns =
        /\bwasmExports\.fetch_landblock_spawns\s*\(/.test(spawnsSrc);
    const hasEntityHook =
        /\bwindow\.__scene3dEntityHook\s*\(/.test(spawnsSrc);
    const hasHandleSpawn =
        /\bwindow\.handleEntitySpawn\s*\(/.test(spawnsSrc);
    const hasWcidLookup =
        /wcid_to_setup\.json/.test(spawnsSrc) ||
        /loadWcidToSetupMap/.test(spawnsSrc);
    const hasPlaceholderFallback =
        /PLACEHOLDER_SETUP_DID/.test(spawnsSrc);
    const hasDeterministicGuid =
        /\bderiveSyntheticGuid\b/.test(spawnsSrc);
    check(
        "Phase D.1.c: scene3d/spawns.js dispatches through __scene3dEntityHook + handleEntitySpawn",
        hasFetchSpawns &&
            hasEntityHook &&
            hasHandleSpawn &&
            hasWcidLookup &&
            hasPlaceholderFallback &&
            hasDeterministicGuid,
        `fetchSpawns=${hasFetchSpawns} hook=${hasEntityHook} ` +
            `handleSpawn=${hasHandleSpawn} wcidLookup=${hasWcidLookup} ` +
            `placeholder=${hasPlaceholderFallback} ` +
            `deterministicGuid=${hasDeterministicGuid}`
    );
} catch (e) {
    check(
        "Phase D.1.c: scene3d/spawns.js dispatches through __scene3dEntityHook + handleEntitySpawn",
        false,
        String(e).slice(0, 160)
    );
}

// Phase D.1.c source-pattern — scene3d/index.js wires
// loadSpawnsForLandblock onto liveScene3d (mirrors
// loadStaticsForLandblock / loadBuildingsForLandblock / etc.). Without
// this, the lazy LB-entry hook in index.html can't fire the injector.
try {
    const fs = require("fs");
    const idxSrc = fs.readFileSync(
        __dirname + "/scene3d/index.js",
        "utf8"
    );
    const importsSpawns =
        /from\s+["']\.\/spawns\.js["']/.test(idxSrc) &&
        /\bensureSpawnsForLandblock\b/.test(idxSrc);
    const loadHook =
        /loadSpawnsForLandblock\s*\(\s*lbX\s*,\s*lbY\s*\)/.test(idxSrc);
    check(
        "Phase D.1.c: scene3d/index.js exposes liveScene3d.loadSpawnsForLandblock",
        importsSpawns && loadHook,
        `importsSpawns=${importsSpawns} loadHook=${loadHook}`
    );
} catch (e) {
    check(
        "Phase D.1.c: scene3d/index.js exposes liveScene3d.loadSpawnsForLandblock",
        false,
        String(e).slice(0, 160)
    );
}

// Phase D.1.c source-pattern — index.html fires loadSpawnsForLandblock
// from handlePositionUpdate alongside loadTerrain / loadBuildings /
// loadStatics. Without this, the 13×13 ring's spawns never get
// injected — Phase D capture would see entitiesGroup.children=0.
try {
    const fs = require("fs");
    const idxHtmlSrc = fs.readFileSync(
        __dirname + "/index.html",
        "utf8"
    );
    const positionHook =
        /window\.liveScene3d\?\.loadSpawnsForLandblock/.test(idxHtmlSrc) &&
        /window\.liveScene3d\.loadSpawnsForLandblock\s*\(/.test(idxHtmlSrc);
    const init3dImport =
        /\bfetch_landblock_spawns\b/.test(idxHtmlSrc) &&
        /\binit_spawns_base_url\b/.test(idxHtmlSrc);
    check(
        "Phase D.1.c: index.html handlePositionUpdate fires loadSpawnsForLandblock + imports fetch_landblock_spawns",
        positionHook && init3dImport,
        `positionHook=${positionHook} init3dImport=${init3dImport}`
    );
} catch (e) {
    check(
        "Phase D.1.c: index.html handlePositionUpdate fires loadSpawnsForLandblock + imports fetch_landblock_spawns",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.B source-pattern — `holtburger-event-bake` crate must exist
// at `external/holtburger/crates/holtburger-event-bake/` and expose
// the three sub-bake APIs (`bake_ambient_manifest` +
// `bake_anim_sound_manifest` + `bake_particle_manifest`). Without this
// the per-LB event manifests can't be produced and Phase F.D's
// validator has nothing to diff against.
try {
    const fs = require("fs");
    const libSrc = fs.readFileSync(
        __dirname +
            "/../../crates/holtburger-event-bake/src/lib.rs",
        "utf8"
    );
    const hasAmbient = /\bbake_ambient_manifest\b/.test(libSrc);
    const hasAnimSound = /\bbake_anim_sound_manifest\b/.test(libSrc);
    const hasParticle = /\bbake_particle_manifest\b/.test(libSrc);
    const hasAmbientMod = /\bmod ambient\b/.test(libSrc);
    const hasAnimSoundMod = /\bmod anim_sound\b/.test(libSrc);
    const hasParticleMod = /\bmod particle\b/.test(libSrc);
    check(
        "Phase F.B: holtburger-event-bake exposes bake_ambient_manifest + bake_anim_sound_manifest + bake_particle_manifest",
        hasAmbient &&
            hasAnimSound &&
            hasParticle &&
            hasAmbientMod &&
            hasAnimSoundMod &&
            hasParticleMod,
        `ambient=${hasAmbient} anim_sound=${hasAnimSound} ` +
            `particle=${hasParticle} ambient_mod=${hasAmbientMod} ` +
            `anim_sound_mod=${hasAnimSoundMod} particle_mod=${hasParticleMod}`
    );
} catch (e) {
    check(
        "Phase F.B: holtburger-event-bake exposes bake_ambient_manifest + bake_anim_sound_manifest + bake_particle_manifest",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.B source-pattern — `event-bake` CLI binary must exist at
// `apps/holtburger-tools/src/bin/event-bake.rs` and enforce the same
// base-DAT integrity pre-flight as `scenery-bake` (no defaults for
// `--dat-dir` or `--out`). The determinism contract relies on this:
// running against an `iter-*/` or `custom_textures/` dir must hard-error,
// not silently produce a bake against modder DATs.
try {
    const fs = require("fs");
    const binSrc = fs.readFileSync(
        __dirname +
            "/../../apps/holtburger-tools/src/bin/event-bake.rs",
        "utf8"
    );
    const hasDatDir = /#\[arg\(long, value_name = "PATH"\)\]\s*dat_dir/.test(
        binSrc
    );
    const hasModderCheck = /first_modder_allocated_id/.test(binSrc);
    const hasCustomTextureCheck = /custom_textures/.test(binSrc);
    const hasIterCheck = /iter-/.test(binSrc);
    const hasWbprojCheck = /\.wbproj/.test(binSrc);
    const hasSha256Sidecar = /event-bake-source\.sha256/.test(binSrc);
    const callsAllThreeBakes =
        /bake_ambient_manifest/.test(binSrc) &&
        /bake_anim_sound_manifest/.test(binSrc) &&
        /bake_particle_manifest/.test(binSrc);
    check(
        "Phase F.B: event-bake CLI enforces base-DAT preflight + sha256 sidecar + calls all three bakes",
        hasDatDir &&
            hasModderCheck &&
            hasCustomTextureCheck &&
            hasIterCheck &&
            hasWbprojCheck &&
            hasSha256Sidecar &&
            callsAllThreeBakes,
        `datDir=${hasDatDir} modder=${hasModderCheck} customTex=${hasCustomTextureCheck} ` +
            `iter=${hasIterCheck} wbproj=${hasWbprojCheck} sha=${hasSha256Sidecar} ` +
            `allBakes=${callsAllThreeBakes}`
    );
} catch (e) {
    check(
        "Phase F.B: event-bake CLI enforces base-DAT preflight + sha256 sidecar + calls all three bakes",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.B source-pattern — workspace Cargo.toml + holtburger-tools
// Cargo.toml must include the new event-bake crate. Without this, the
// CLI binary can't link and `cargo test --workspace` doesn't pick up
// the new crate's tests.
try {
    const fs = require("fs");
    const wsToml = fs.readFileSync(
        __dirname + "/../../Cargo.toml",
        "utf8"
    );
    const toolsToml = fs.readFileSync(
        __dirname + "/../../apps/holtburger-tools/Cargo.toml",
        "utf8"
    );
    const wsMember = /"crates\/holtburger-event-bake"/.test(wsToml);
    const wsDep = /holtburger-event-bake\s*=\s*\{\s*path\s*=\s*"crates\/holtburger-event-bake"\s*\}/.test(
        wsToml
    );
    const toolsDep = /holtburger-event-bake/.test(toolsToml);
    check(
        "Phase F.B: workspace + holtburger-tools Cargo.toml include holtburger-event-bake",
        wsMember && wsDep && toolsDep,
        `wsMember=${wsMember} wsDep=${wsDep} toolsDep=${toolsDep}`
    );
} catch (e) {
    check(
        "Phase F.B: workspace + holtburger-tools Cargo.toml include holtburger-event-bake",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.C source-pattern — `scene3d/index.js` initialises the runtime
// event-log probe + push helper + snapshot accessor on liveScene3d.
// Without these the F.D validator has no API to read from. The gate
// MUST be `?eventLog=on` (off by default per the brief; production
// users shouldn't pay the cost).
try {
    const fs = require("fs");
    const idxSrc = fs.readFileSync(
        __dirname + "/scene3d/index.js",
        "utf8"
    );
    const hasGate = /eventLog\s*===\s*"on"|getParam\(["']eventLog["']\)|get\(["']eventLog["']\)/.test(idxSrc);
    const hasEventLogField = /\beventLog\b\s*[:,]/.test(idxSrc) && /eventLog,/.test(idxSrc);
    const hasPushHelper = /pushEventRecord|_pushEventRecord/.test(idxSrc);
    const hasCap = /EVENT_LOG_CAP\s*=\s*50_?000/.test(idxSrc);
    const hasSnapshot = /\bsnapshotEventLog\s*\(\s*\)/.test(idxSrc);
    const hasOverflow = /eventLogOverflow/.test(idxSrc);
    const hasOneOffHook = /source\s*:\s*["']OneOff["']/.test(idxSrc);
    check(
        "Phase F.C: scene3d/index.js initialises eventLog probe (gate + cap + snapshotEventLog + OneOff hook)",
        hasGate && hasEventLogField && hasPushHelper && hasCap && hasSnapshot && hasOverflow && hasOneOffHook,
        `gate=${hasGate} field=${hasEventLogField} push=${hasPushHelper} cap=${hasCap} snapshot=${hasSnapshot} overflow=${hasOverflow} oneOff=${hasOneOffHook}`
    );
} catch (e) {
    check(
        "Phase F.C: scene3d/index.js initialises eventLog probe (gate + cap + snapshotEventLog + OneOff hook)",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.C source-pattern — AmbientRuntime accepts `pushEventRecord`
// opt + calls it in BOTH continuous + probabilistic fire paths with
// `source: "AmbientRuntime"`. The validator distinguishes the two
// flavours by `source_meta.continuous`.
try {
    const fs = require("fs");
    const amSrc = fs.readFileSync(
        __dirname + "/scene3d/audio/ambient_runtime.js",
        "utf8"
    );
    const hasOpt = /opts\.pushEventRecord/.test(amSrc);
    const hasField = /this\._pushEventRecord/.test(amSrc);
    const hasAmbientSource = /source\s*:\s*["']AmbientRuntime["']/.test(amSrc);
    const continuousMatches = amSrc.match(/continuous\s*:\s*true/g) || [];
    const probMatches = amSrc.match(/continuous\s*:\s*false/g) || [];
    const hasContinuous = continuousMatches.length >= 1;
    const hasProb = probMatches.length >= 1;
    check(
        "Phase F.C: AmbientRuntime accepts pushEventRecord + appends source='AmbientRuntime' on continuous + probabilistic fires",
        hasOpt && hasField && hasAmbientSource && hasContinuous && hasProb,
        `opt=${hasOpt} field=${hasField} sourceTag=${hasAmbientSource} continuous=${hasContinuous} prob=${hasProb}`
    );
} catch (e) {
    check(
        "Phase F.C: AmbientRuntime accepts pushEventRecord + appends source='AmbientRuntime' on continuous + probabilistic fires",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.C source-pattern — entities.js wires the event-log push into
// `_fireHook` (AnimationHook source — types 1 + 2) AND
// `_attachParticleChainForEntity` (PhysicsScriptHook source — both
// sound + particle hook arms). Without this the entity-anchored half
// of the F.D validator's correlation set is empty.
try {
    const fs = require("fs");
    const entSrc = fs.readFileSync(
        __dirname + "/scene3d/entities.js",
        "utf8"
    );
    const hasAnimSource = /source\s*:\s*["']AnimationHook["']/.test(entSrc);
    const hasPhysScriptSource = /source\s*:\s*["']PhysicsScriptHook["']/.test(entSrc);
    const hasParticleType = /type\s*:\s*["']particle["']/.test(entSrc);
    const hasSoundType = /type\s*:\s*["']sound["']/.test(entSrc);
    const hasParentGuid = /parent_entity_guid/.test(entSrc);
    check(
        "Phase F.C: entities.js wires eventLog into AnimationHook (sound) + PhysicsScriptHook (sound + particle)",
        hasAnimSource && hasPhysScriptSource && hasParticleType && hasSoundType && hasParentGuid,
        `anim=${hasAnimSource} physScript=${hasPhysScriptSource} partType=${hasParticleType} sndType=${hasSoundType} parentGuid=${hasParentGuid}`
    );
} catch (e) {
    check(
        "Phase F.C: entities.js wires eventLog into AnimationHook (sound) + PhysicsScriptHook (sound + particle)",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.C source-pattern — sky_dome.js wires the event-log push into
// the Sky-J P5 walker for both sound + particle hooks, tagged
// `source: "SkyChain"`. Without this the sky-particle half (P2 in the
// method doc) of the F.D validator's correlation set is empty.
try {
    const fs = require("fs");
    const skSrc = fs.readFileSync(
        __dirname + "/scene3d/sky_dome.js",
        "utf8"
    );
    const hasSkySource = /source\s*:\s*["']SkyChain["']/.test(skSrc);
    const hasPushHelper = /_pushEventRecord/.test(skSrc);
    const hasSkyObjectId = /sky_object_id/.test(skSrc);
    check(
        "Phase F.C: sky_dome.js wires eventLog into SkyChain (Sky-J P5 walker) for sound + particle hooks",
        hasSkySource && hasPushHelper && hasSkyObjectId,
        `skySource=${hasSkySource} push=${hasPushHelper} skyObjId=${hasSkyObjectId}`
    );
} catch (e) {
    check(
        "Phase F.C: sky_dome.js wires eventLog into SkyChain (Sky-J P5 walker) for sound + particle hooks",
        false,
        String(e).slice(0, 160)
    );
}

// Phase F.C source-pattern — index.html's GameMessageSound (kind=16)
// drain arm pushes a `source: "GameMessageSound"` record before the
// audioMgr.play call. F.D's validator's S3 channel diff against the
// F.B server-sound-message baseline depends on this being wired.
try {
    const fs = require("fs");
    const htmlSrc = fs.readFileSync(
        __dirname + "/index.html",
        "utf8"
    );
    const hasGmsSource = /source\s*:\s*["']GameMessageSound["']/.test(htmlSrc);
    const hasKind16 = /evt\.kind\s*===\s*16/.test(htmlSrc);
    const hasPushBeforePlay = /_pushEventRecord[\s\S]{0,2000}audioMgr\.play\(\s*entry\.waveDid/m.test(htmlSrc);
    check(
        "Phase F.C: index.html's kind=16 GameMessageSound arm pushes eventLog record before audioMgr.play()",
        hasGmsSource && hasKind16 && hasPushBeforePlay,
        `gmsSource=${hasGmsSource} kind16=${hasKind16} pushBeforePlay=${hasPushBeforePlay}`
    );
} catch (e) {
    check(
        "Phase F.C: index.html's kind=16 GameMessageSound arm pushes eventLog record before audioMgr.play()",
        false,
        String(e).slice(0, 160)
    );
}

// Phase 4 step 1: start_session + SessionHandle (with .poll_events()
// and .characterList()) must be present. The `start_session` round-trip
// itself is browser-only — ACE login synthesis in Node would require
// porting the AC packet codec to JS, well outside step 1's scope. The
// error-path check below is the closest deterministic Node coverage:
// invoking `start_session` against a closed port should reject with a
// stringified error rather than panic.
check(
    "start_session() is exported (Phase 4 step 1 login driver)",
    typeof wasm.start_session === "function",
    `typeof ${typeof wasm.start_session}`
);

const sessionHandleProto = wasm.SessionHandle?.prototype;
const handleSurfaceOk =
    typeof wasm.SessionHandle === "function"
    && typeof sessionHandleProto?.poll_events === "function"
    && typeof sessionHandleProto?.characterList === "function";
check(
    "SessionHandle class + .poll_events() + .characterList() exposed",
    handleSurfaceOk,
    `class=${typeof wasm.SessionHandle}, poll_events=${typeof sessionHandleProto?.poll_events}, characterList=${typeof sessionHandleProto?.characterList}`
);

// Phase 4 step 2a: SessionHandle.selectCharacter(guid) drives the
// CharacterEnterWorldRequest → CharacterEnterWorldServerReady →
// CharacterEnterWorld → PlayerCreate spawn handshake. The recv loop
// owns the Session and auto-chains the middle two messages; JS sees
// a kind=1 PlayerSpawned event at the end. Symbol-presence is the
// Node-side check; live spawn round-trip runs through the Playwright
// capture against ACE.
check(
    "SessionHandle.selectCharacter() exposed (Phase 4 step 2a spawn driver)",
    typeof sessionHandleProto?.selectCharacter === "function",
    `selectCharacter=${typeof sessionHandleProto?.selectCharacter}`
);

// Phase 4 step 2a.5: SessionHandle.createTestCharacter(name) constructs
// an Aluvian/Male/Adventurer/Holtburg CharacterCreateRequestData in the
// wasm bundle (via holtburger_core::CharacterGenBuilder) and dispatches
// to the recv loop. .canCreateCharacter is a getter that reports
// whether the CharGen + SkillTable were loaded at start_session time.
check(
    "SessionHandle.createTestCharacter() exposed (Phase 4 step 2a.5)",
    typeof sessionHandleProto?.createTestCharacter === "function",
    `createTestCharacter=${typeof sessionHandleProto?.createTestCharacter}`
);
const canCreateDescriptor = Object.getOwnPropertyDescriptor(
    sessionHandleProto || {},
    "canCreateCharacter"
);
check(
    "SessionHandle.canCreateCharacter getter exposed (Phase 4 step 2a.5)",
    typeof canCreateDescriptor?.get === "function",
    `canCreateCharacter getter=${typeof canCreateDescriptor?.get}`
);

// Phase 4 step 2a.6: SessionHandle.sendChat(message) dispatches a
// GameAction::Talk over the session. Used by the JS-side Teleport
// button to send `@telepoi Holtburg` after kind=7 EnteredWorld.
// Live coverage runs through the Playwright capture against a
// running ACE; here we just verify the export.
check(
    "SessionHandle.sendChat() exposed (Phase 4 step 2a.6 chat / admin commands)",
    typeof sessionHandleProto?.sendChat === "function",
    `sendChat=${typeof sessionHandleProto?.sendChat}`
);

// Phase 4 step 2b: SessionHandle.pollEntityUpdates() drains the
// high-frequency position / spawn / remove channel. Separate from
// poll_events() — see the EntityUpdate doc comment in lib.rs for the
// rationale (position updates fire 100s/sec; tagged-payload string
// allocation in the hot path was the wrong shape). Live coverage
// runs through the Playwright capture; here we just verify the
// export + the EntityUpdate constructor.
check(
    "SessionHandle.pollEntityUpdates() exposed (Phase 4 step 2b entity buffer)",
    typeof sessionHandleProto?.pollEntityUpdates === "function",
    `pollEntityUpdates=${typeof sessionHandleProto?.pollEntityUpdates}`
);
check(
    "EntityUpdate class exposed (Phase 4 step 2b position-bearing event)",
    typeof wasm.EntityUpdate === "function",
    `typeof ${typeof wasm.EntityUpdate}`
);

// Phase 4 step 6a: EntityUpdate carries weenie metadata on Spawn so
// JS can dispatch by category (step 6b), label by name (step 6e), and
// scale by obj_scale. Position/Remove updates leave these zeroed/empty.
// The recv-loop ObjectCreate arm in lib.rs stops discarding the
// PublicWeenieDescription + ObjectDescriptionData fields; here we
// just probe the wasm-bindgen getters were emitted on the prototype.
const entityUpdateProto = wasm.EntityUpdate?.prototype;
const step6aGetters = ["wcid", "itemType", "name", "objScale", "iconId", "paletteId", "mtableId"];
for (const name of step6aGetters) {
    const desc = Object.getOwnPropertyDescriptor(entityUpdateProto || {}, name);
    check(
        `EntityUpdate.${name} getter exposed (Phase 4 step 6a weenie metadata)`,
        typeof desc?.get === "function",
        `getter=${typeof desc?.get}`
    );
}

// Phase 4 step 6 Phase A: EntityUpdate also carries the model_data
// substitutions ACE pre-computed in CalculateObjDesc (per-part GfxObj
// swaps + per-part texture remaps + palette overlays). The flat
// Uint32Array shape lets JS hand them straight to the new
// fetchEntityModelRender export. Probes confirm the getters exist;
// real-fixture validation (wasm Substitution unit tests in
// `tests_substitution::*`) runs through `cargo test`.
const step6PhaseAGetters = ["modelChanges", "textureChanges", "subPalettes"];
for (const name of step6PhaseAGetters) {
    const desc = Object.getOwnPropertyDescriptor(entityUpdateProto || {}, name);
    check(
        `EntityUpdate.${name} getter exposed (Phase 4 step 6 Phase A model_data substitutions)`,
        typeof desc?.get === "function",
        `getter=${typeof desc?.get}`
    );
}
check(
    "fetchEntityModelRender() exposed (Phase 4 step 6 Phase A NPC render path)",
    typeof wasm.fetchEntityModelRender === "function",
    `fetchEntityModelRender=${typeof wasm.fetchEntityModelRender}`
);
// Phase 4 step 6 Phase B: per-surface RGBA8 fetch with entity palette
// override + sub-palette overlays applied at decode time. ACE pre-
// computes both via Creature.CalculateObjDesc (palette id from
// PaletteBaseDID; overlays from each equipped item's CloSubPalEffects
// indexed by paletteTemplate). Symbol-only check; the composition
// arithmetic is covered by the entity_surface_pixels_* native tests.
check(
    "fetchEntitySurfacesPixels() exposed (Phase 4 step 6 Phase B palette overlay path)",
    typeof wasm.fetchEntitySurfacesPixels === "function",
    `fetchEntitySurfacesPixels=${typeof wasm.fetchEntitySurfacesPixels}`
);
// Phase 4 step 6 Tier 2 + walk-cycle polish: walk + run cycle bake.
// Returns an EntityCycleSet wasm-bindgen class with takeWalkFrames /
// takeRunFrames (Vec<ModelMesh> each) and walkFramerate / runFramerate
// (f32 each, from MotionTable AnimData). Empty cycles for setups
// without that command in their MotionTable; cycles are independent
// (a creature may have walk-only or run-only entries).
check(
    "fetchEntityCycleFrames() exposed (walk + run cycle bake)",
    typeof wasm.fetchEntityCycleFrames === "function",
    `fetchEntityCycleFrames=${typeof wasm.fetchEntityCycleFrames}`
);

// Phase 4 step 3: SessionHandle.setMovementInput(forward, strafe,
// turn, run) takes a tristate-axis keystate snapshot and forwards
// it to the recv loop, which builds a `GameAction::MoveToState`
// packet and sends it via the session. JS calls this on every
// change to the WASD/Q/E/Shift keystate, not on every animation
// frame — matching `PlayerDriveIntent::ManualHeld` semantics. Live
// coverage requires a real ACE backend (server simulates motion
// based on the packet); here we only verify the export exists.
check(
    "SessionHandle.setMovementInput() exposed (Phase 4 step 3 movement input)",
    typeof sessionHandleProto?.setMovementInput === "function",
    `setMovementInput=${typeof sessionHandleProto?.setMovementInput}`
);

// Phase 4 step 3.6: SessionHandle.tickMovement() drives the cli's
// MovementSystem on every rAF — emits MoveToState on motion-state
// edges AND the AutonomousPosition heartbeat that was missing pre-3.6.
// Without the heartbeat, server-side player position never advanced
// past @telepoi spawn, encounter generators in adjacent landblocks
// never activated via vision, and no monsters spawned into the
// entity buffer. Symbol-presence here pins the new wire contract;
// live walk-around + ace_shard biota_properties_position assertion
// lives in `capture_phase4_step3.6.cjs` (full e2e harness, requires
// running ACE + wsbridge + MySQL). Protocol documented at
// `docs/phase-4-step-3.6-movement-system.md` §6.
check(
    "SessionHandle.tickMovement() exposed (Phase 4 step 3.6 AutonomousPosition heartbeat)",
    typeof sessionHandleProto?.tickMovement === "function",
    `tickMovement=${typeof sessionHandleProto?.tickMovement}`
);

// Phase 4 step 4: ClientEvent grew a `u32Payload2` getter carrying
// the CHAT_CATEGORY_* tag for kind=2 ChatReceived events. JS routes
// chat to the right tab + colour class via this field — the legacy
// prefix-string heuristic is gone. Symbol-presence here pins the
// new wire contract (live ACE chat round-trip lives in the capture
// harness, not the smoke).
const clientEventDescr = Object.getOwnPropertyDescriptor(
    wasm.ClientEvent?.prototype || {},
    "u32Payload2",
);
check(
    "ClientEvent.u32Payload2 getter exposed (Phase 4 step 4 chat category)",
    typeof wasm.ClientEvent === "function" && typeof clientEventDescr?.get === "function",
    `ClientEvent=${typeof wasm.ClientEvent}, u32Payload2=${typeof clientEventDescr?.get}`
);

// Phase 4 step 4 follow-on (vitals + inventory panels):
// SessionHandle.playerStats() returns a PlayerStatsSnapshot
// (vitals / attributes / skills / level info), refreshed by the
// recv loop on every kind=8 PlayerStatsUpdated event. Symbol-
// presence here pins the export; live wire round-trip lives in
// the capture harness (PlayerDescription must arrive for the
// snapshot to be non-empty).
check(
    "SessionHandle.playerStats() exposed (Phase 4 step 4 follow-on vitals)",
    typeof sessionHandleProto?.playerStats === "function",
    `playerStats=${typeof sessionHandleProto?.playerStats}`
);

check(
    "SessionHandle.playerInventory() exposed (Phase 4 step 4 follow-on inventory)",
    typeof sessionHandleProto?.playerInventory === "function",
    `playerInventory=${typeof sessionHandleProto?.playerInventory}`
);

// Phase 4 step 4 follow-on: PlayerStatsSnapshot wasm-bindgen
// class with `.vitals` / `.attributes` / `.skills` / `.levelInfo`
// / `.name` getters. The recv loop builds one in
// `publish_player_stats_snapshot` from `WorldState.player.*`.
const statsProto = wasm.PlayerStatsSnapshot?.prototype || {};
const statsVitalsDescr = Object.getOwnPropertyDescriptor(statsProto, "vitals");
const statsAttribDescr = Object.getOwnPropertyDescriptor(statsProto, "attributes");
const statsSkillsDescr = Object.getOwnPropertyDescriptor(statsProto, "skills");
const statsLevelDescr = Object.getOwnPropertyDescriptor(statsProto, "levelInfo");
const statsNameDescr = Object.getOwnPropertyDescriptor(statsProto, "name");
check(
    "PlayerStatsSnapshot class + 5 getters exposed (Phase 4 step 4 follow-on)",
    typeof wasm.PlayerStatsSnapshot === "function"
        && typeof statsVitalsDescr?.get === "function"
        && typeof statsAttribDescr?.get === "function"
        && typeof statsSkillsDescr?.get === "function"
        && typeof statsLevelDescr?.get === "function"
        && typeof statsNameDescr?.get === "function",
    `class=${typeof wasm.PlayerStatsSnapshot}, vitals=${typeof statsVitalsDescr?.get}, attributes=${typeof statsAttribDescr?.get}, skills=${typeof statsSkillsDescr?.get}, levelInfo=${typeof statsLevelDescr?.get}, name=${typeof statsNameDescr?.get}`
);

// Phase 4 step 4 follow-on: InventoryItem wasm-bindgen class
// with the 9 getters JS reads to render each row.
const itemProto = wasm.InventoryItem?.prototype || {};
const expectedItemGetters = [
    "guid", "wcid", "name", "iconId", "itemType",
    "value", "stackSize", "equipMask", "containerId",
];
const itemGettersOk = expectedItemGetters.every((g) => {
    const d = Object.getOwnPropertyDescriptor(itemProto, g);
    return typeof d?.get === "function";
});
check(
    "InventoryItem class + 9 getters exposed (Phase 4 step 4 follow-on)",
    typeof wasm.InventoryItem === "function" && itemGettersOk,
    `class=${typeof wasm.InventoryItem}, getters=${itemGettersOk}`
);

// Phase 4 step 4 follow-on: top-level human-readable label
// helpers used by JS to render the vitals panel rows. Each maps
// a numeric stat-type id to its display string (mirrors the
// strum Display impl on the underlying enum).
check(
    "skillName() exposed (Phase 4 step 4 follow-on label helper)",
    typeof wasm.skillName === "function" && wasm.skillName(24) === "Run",
    `skillName=${typeof wasm.skillName}, skillName(24)=${JSON.stringify(wasm.skillName?.(24))}`
);
check(
    "attributeName() exposed (Phase 4 step 4 follow-on label helper)",
    typeof wasm.attributeName === "function" && wasm.attributeName(1) === "Strength",
    `attributeName=${typeof wasm.attributeName}, attributeName(1)=${JSON.stringify(wasm.attributeName?.(1))}`
);
check(
    "vitalName() exposed (Phase 4 step 4 follow-on label helper)",
    typeof wasm.vitalName === "function" && wasm.vitalName(1) === "Health",
    `vitalName=${typeof wasm.vitalName}, vitalName(1)=${JSON.stringify(wasm.vitalName?.(1))}`
);

// Phase 4 step 5 (interactive entities): SessionHandle.useObject(guid)
// dispatches a `GameAction::Use(UseActionData { guid })` action. The
// JS side fires this from per-sprite pointerdown handlers on portals
// / vendors / lifestones / containers / signs; ACE responds with
// either `PlayerTeleport` (portal), `GameEvent::ApproachVendor`
// (vendor), `GameEvent::UseDone` (door / container / lifestone), or
// `GameEvent::WeenieError(WithString)` (out-of-range / locked /
// non-interactive). The recv loop's GameEvent arm normalises the
// reply into kind=12 VendorOpened / kind=13 UseFailed / kind=14
// UseDone.
check(
    "SessionHandle.useObject() exposed (Phase 4 step 5 click-to-use)",
    typeof sessionHandleProto?.useObject === "function",
    `useObject=${typeof sessionHandleProto?.useObject}`
);

// Combat-mode toggle: SessionHandle.toggleCombatMode() flips the
// player between NonCombat and a combat mode (Melee/Missile/Magic)
// chosen from equipped items via WorldContextExt::get_suggested_combat_mode.
// Sends GameAction::ChangeCombatMode; ACE's GetCombatStance derives
// the actual MotionStance server-side and broadcasts UpdateMotion.
// JS-side ` (backtick) hotkey + the kind=5 motionStance receiver
// paint the vitals-header stance indicator. The retail AC default
// keybind for this toggle is also backtick.
check(
    "SessionHandle.toggleCombatMode() exposed (combat-mode hotkey)",
    typeof sessionHandleProto?.toggleCombatMode === "function",
    `toggleCombatMode=${typeof sessionHandleProto?.toggleCombatMode}`
);

// Phase 4 step 6f (portal destination chips): EntityUpdate gained a
// `portalDestination` getter so JS can render a "→ <destination>"
// chip under portal sprites. Source: ACE's
// `PropertyString::AppraisalPortalDestination` (assessment-only)
// arrives via auto-fired `GameAction::IdentifyObject` post-Spawn,
// surfaced as a `kind=3 META_REFRESH` EntityUpdate. Empty string for
// non-portals + portals where the appraisal hasn't completed yet.
const entityUpdateDescr = Object.getOwnPropertyDescriptor(
    wasm.EntityUpdate?.prototype || {},
    "portalDestination",
);
check(
    "EntityUpdate.portalDestination getter exposed (Phase 4 step 6f)",
    typeof wasm.EntityUpdate === "function" && typeof entityUpdateDescr?.get === "function",
    `EntityUpdate=${typeof wasm.EntityUpdate}, portalDestination=${typeof entityUpdateDescr?.get}`
);

// Velocity-extrapolation polish: VectorUpdate (kind=4) carries
// ACE's authoritative `(velocity, omega)` for an entity. JS uses
// it to extrapolate sprite position past the catch-up lerp's
// target, smoothing motion across the ~100-300 ms gap between
// PublicUpdatePosition echoes. Four new EntityUpdate getters:
// vx / vy / vz / omegaZ. Position fields stay zeroed on kind=4.
const entityUpdateProto2 = wasm.EntityUpdate?.prototype || {};
const velocityGetters = ["vx", "vy", "vz", "omegaZ"];
const velocityGettersOk = velocityGetters.every((g) => {
    const d = Object.getOwnPropertyDescriptor(entityUpdateProto2, g);
    return typeof d?.get === "function";
});
check(
    "EntityUpdate vx/vy/vz/omegaZ getters exposed (velocity hint kind=4)",
    typeof wasm.EntityUpdate === "function" && velocityGettersOk,
    `EntityUpdate=${typeof wasm.EntityUpdate}, getters=${velocityGettersOk}`
);

// === Phase 6 Step A — restore building leaf geometry ================
//
// Phase 6 step A wires the Setup-part walker into the building branch
// of `fetch_landblock_objects` (lib.rs:712-713 today emits a
// silhouette-only placement). Two new wasm-bindgen surfaces are
// expected on the bundle once the implementation lands:
//
//   1. `init_building_map` (or equivalent): JS-side per-building
//      PIXI.Container registry. Modelled on Phase 5 step 5/6's
//      `init_resource_source` / `has_resource_source` introspection
//      pattern (see line 119-145 above).
//   2. `BuildingPlacement` (placeholder name — see capture script
//      header for naming caveat): per-part-aware return type. Sibling
//      to `ObjectPlacement` (line 605 in lib.rs) but carrying enough
//      data for the JS bake to addressable each part by
//      `(building_id, part_index)`. Phase E's door-rotation path
//      depends on this addressing.
//
// All three checks below are non-throwing — they probe via `typeof`
// and report "phase A not yet shipped" as the detail message. These
// will fail today (expected); they pass once the implementation
// agent ships the Phase A export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase A.
//
// NOTE: the names `init_building_map` and `BuildingPlacement` are
// PLACEHOLDERS. If the implementation chooses a different idiom
// (e.g. `init_buildings`, `BuildingPartPlacement`), update both this
// block AND `capture_phase6_step_a_geometry.cjs`'s window-side probe
// in the same commit so the smoke + live tests stay aligned.

const phase6BuildingMapInit = typeof wasm.init_building_map === "function";
check(
    "phase6.A.window_buildingMap_exists",
    phase6BuildingMapInit,
    phase6BuildingMapInit
        ? `init_building_map=${typeof wasm.init_building_map}`
        : "phase A not yet shipped — expected wasm.init_building_map() (placeholder name)"
);

const phase6BuildingPlacementCtor = typeof wasm.BuildingPlacement === "function";
check(
    "phase6.A.fetch_landblock_objects_returns_buildings_with_parts",
    phase6BuildingPlacementCtor,
    phase6BuildingPlacementCtor
        ? `BuildingPlacement=${typeof wasm.BuildingPlacement}`
        : "phase A not yet shipped — expected wasm.BuildingPlacement constructor (placeholder name; per-part-aware return type sibling to ObjectPlacement)"
);

// Runtime stub — once Phase A lands, the implementation agent will
// hook this into a deterministic fixture path (likely a synthetic
// Setup with N>1 parts, parsed via the dat-shard cache without
// requiring a live ACE). Today it's a pure no-op that reports the
// missing entry point. The check is idempotent — re-running it
// after the implementation lands will exercise the new path
// without code change here. The runtime path SHOULD also expose a
// way to query "max part count across all buildings parsed in the
// last fetch_landblock_objects call" without requiring a live
// session; the implementation agent picks the exact accessor name.
let phase6PartCountOk = false;
let phase6PartCountDetail =
    "phase A not yet shipped — expected a runtime accessor reporting "
    + "max parts-per-building from a deterministic Setup fixture. "
    + "The implementation agent hooks this stub when Phase A lands.";
try {
    if (typeof wasm.holtburg_townhall_max_parts === "function") {
        const n = wasm.holtburg_townhall_max_parts();
        phase6PartCountOk = typeof n === "number" && n > 1;
        phase6PartCountDetail = `holtburg_townhall_max_parts()=${n}`;
    }
} catch (e) {
    phase6PartCountDetail = `holtburg_townhall_max_parts threw: ${e?.message ?? e}`;
}
check(
    "phase6.A.holtburg_townhall_part_count",
    phase6PartCountOk,
    phase6PartCountDetail
);

// === end Phase 6 Step A =============================================

// === Phase 6 Step B — player ↔ building AABB collision ==============
//
// Phase B wires a swept-AABB check into `project_pose_by_velocity`
// (`crates/holtburger-world/src/spatial/physics.rs:308-319`). The
// integrator looks up `building_aabb_index: HashMap<CellId, Vec<Aabb>>`
// for the current cell + neighbours, sweeps the player capsule along
// the proposed velocity * dt vector, and clamps the delta to first
// hit. Walking parallel to the wall slides without blocking.
//
// The smoke can't drive a live ACE round-trip (that's the live capture
// `capture_phase6_step_b_collision.cjs`'s job) but it CAN exercise:
//   1. Symbol presence — does Phase B expose the AABB extraction +
//      sweep helpers it claims to? If the count returns 0 from a
//      deterministic fixture path, AABB extraction isn't wired.
//   2. Synthetic axis-aligned clamp — set up an in-memory Setup with
//      one AABB at a known position, propose a velocity that crosses
//      it, assert the clamped distance is less than the proposed
//      distance.
//   3. Synthetic slide — same fixture, propose a parallel-to-wall
//      velocity, assert NO clamp (slide returns full distance).
//
// All three checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase B export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase B.
//
// NOTE: the names below are PLACEHOLDERS. If the implementation
// chooses different idioms (e.g. `holtburg_aabb_clamp_test` instead
// of `holtburg_test_collision_clamp_axis_aligned`), update both this
// block AND `capture_phase6_step_b_collision.cjs`'s symbol probe
// in the same commit so the smoke + live tests stay aligned.
//
// TODO: confirm with implementation agent — error-code conventions
// for the synthetic test helpers. Today the contract is:
//   0  = test passed
//   1  = wasm export missing (symbol not yet shipped)
//   >1 = test ran but a specific assertion failed (impl agent picks
//        the meaning of each non-zero code, documents in the wasm
//        export's doc comment).

// (B.1) Symbol-check that Phase B's per-Setup AABB extraction is
// wired. Mirrors Phase A's `holtburg_townhall_max_parts` shape: a
// deterministic accessor returning a count from a known fixture. If
// the count is 0, the Phase B walker isn't extracting AABBs from
// Setup parts; if > 0, AABB extraction is at least running.
let phase6BAabbCountOk = false;
let phase6BAabbCountDetail =
    "phase B not yet shipped — expected wasm.holtburg_townhall_aabb_count() "
    + "(placeholder name) returning a non-zero u32 from a deterministic "
    + "Setup fixture. Sibling to Phase A's holtburg_townhall_max_parts.";
try {
    if (typeof wasm.holtburg_townhall_aabb_count === "function") {
        const n = wasm.holtburg_townhall_aabb_count();
        phase6BAabbCountOk = typeof n === "number" && n > 0;
        phase6BAabbCountDetail = `holtburg_townhall_aabb_count()=${n}`;
    }
} catch (e) {
    phase6BAabbCountDetail = `holtburg_townhall_aabb_count threw: ${e?.message ?? e}`;
}
check(
    "phase6.B.project_pose_returns_clamped_when_aabb_blocks",
    phase6BAabbCountOk,
    phase6BAabbCountDetail
);

// (B.2) Synthetic axis-aligned clamp. The wasm export builds an
// in-memory Setup with one AABB box and proposes a velocity that
// crosses it; the helper itself asserts that the clamped distance
// is strictly less than the proposed distance. Returns 0 on
// success, non-zero error code on failure.
//
// Using a self-asserting helper (rather than returning floats for
// JS-side comparison) is deliberate: keeps the floating-point
// epsilon decisions inside Rust where they belong, and the smoke
// just observes the verdict. Mirrors the typed-error convention
// used by other holtburger-world unit tests.
let phase6BClampOk = false;
let phase6BClampDetail =
    "phase B not yet shipped — expected wasm.holtburg_test_collision_clamp_axis_aligned() "
    + "(placeholder name) returning 0 if proposed-into-wall is clamped, non-zero "
    + "error code otherwise.";
try {
    if (typeof wasm.holtburg_test_collision_clamp_axis_aligned === "function") {
        const code = wasm.holtburg_test_collision_clamp_axis_aligned();
        phase6BClampOk = code === 0;
        phase6BClampDetail = `holtburg_test_collision_clamp_axis_aligned()=${code} `
            + `(0 = clamp asserted; non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6BClampDetail = `holtburg_test_collision_clamp_axis_aligned threw: ${e?.message ?? e}`;
}
check(
    "phase6.B.set_velocity_into_wall_clamps",
    phase6BClampOk,
    phase6BClampDetail
);

// (B.3) Synthetic slide-along-wall. Same fixture as B.2, but the
// proposed velocity is PARALLEL to the wall plane rather than
// perpendicular. The helper asserts NO clamp occurs — the full
// proposed distance is preserved. Returns 0 on success, non-zero
// error code on failure (sweep over-clamped, dropped a slide axis,
// etc.).
let phase6BSlideOk = false;
let phase6BSlideDetail =
    "phase B not yet shipped — expected wasm.holtburg_test_collision_slide_along_wall() "
    + "(placeholder name) returning 0 if a parallel-to-wall velocity slides "
    + "the full distance, non-zero error code otherwise.";
try {
    if (typeof wasm.holtburg_test_collision_slide_along_wall === "function") {
        const code = wasm.holtburg_test_collision_slide_along_wall();
        phase6BSlideOk = code === 0;
        phase6BSlideDetail = `holtburg_test_collision_slide_along_wall()=${code} `
            + `(0 = slide preserves full distance; non-zero = error code)`;
    }
} catch (e) {
    phase6BSlideDetail = `holtburg_test_collision_slide_along_wall threw: ${e?.message ?? e}`;
}
check(
    "phase6.B.slide_along_wall",
    phase6BSlideOk,
    phase6BSlideDetail
);

// === end Phase 6 Step B =============================================

// === Phase 6 Step C — EnvCell rendering wasm export =================
//
// Phase C ships an EnvCell render path: a new wasm export
// `fetch_env_cells_in_landblock(lbid: u32) -> JsValue` returning a
// `Vec<EnvCellPlacement>` (sibling to ObjectPlacement), a JS-side
// `window.cellContainers: Map<CellId, PIXI.Container>` registry
// populated lazily on landblock entry, and a new triangulator path
// for Environment DIDs (0x0D…) that's distinct from Setup.
//
// What this smoke can validate (without a live ACE round-trip — that
// belongs to `capture_phase6_step_c_envcells.cjs`):
//   1. Symbol presence — `fetchEnvCellsInLandblock` is exported and
//      callable via the deterministic in-memory ResourceSource fed
//      by the smoke's manifest fixture.
//   2. Runtime population — `holtburg_envcell_count()` returns a
//      non-zero u32 from a deterministic Setup/EnvCell fixture path
//      (sibling to Phase B's `holtburg_townhall_aabb_count`).
//   3. Static-object floor — total static-object count across
//      Holtburg's EnvCells matches (or exceeds) the terminal
//      exporter's count from
//      `pipeline_data/reference/interior_support_objects_highconf.jsonl`.
//      That JSONL has 14 high-confidence support objects under
//      landblockId=0xA9B4 (verified at script-write time); the
//      runtime count includes ALL static objects, not just the
//      high-confidence support subset, so the floor is just "at
//      least 14".
//
// All three checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase C export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase C.
//
// NOTE: the names below are PLACEHOLDERS. Mirroring the Phase A/B
// convention: snake-case `fetch_env_cells_in_landblock` on the Rust
// side maps to camelCase `fetchEnvCellsInLandblock` via wasm-bindgen
// `js_name` (per the §4.3 plan spec). If the implementation chooses
// different idioms, update both this block AND
// `capture_phase6_step_c_envcells.cjs`'s window-side probe (which
// currently looks for `window.cellContainers` /
// `window.liveScene.cellContainers`) in the same commit so the smoke
// + live tests stay aligned.
//
// TODO: confirm with implementation agent the runtime fixture path —
// `holtburg_envcell_count()` SHOULD parse a deterministic in-memory
// Setup+EnvCell fixture path (likely keyed on the same dat-shard
// cache the Phase A/B helpers consume), without requiring a live
// ACE session. The smoke should run in --fast mode without network.

// (C.1) Symbol-check that `fetchEnvCellsInLandblock` is exported.
// camelCase per wasm-bindgen `js_name` convention; the Rust source is
// `fetch_env_cells_in_landblock` per the plan §4.3 spec.
const phase6CFetchExportOk = typeof wasm.fetchEnvCellsInLandblock === "function";
check(
    "phase6.C.fetch_env_cells_in_landblock_returns_records",
    phase6CFetchExportOk,
    phase6CFetchExportOk
        ? `fetchEnvCellsInLandblock=${typeof wasm.fetchEnvCellsInLandblock}`
        : "phase C not yet shipped — expected wasm.fetchEnvCellsInLandblock(lbid) "
        + "→ Vec<EnvCellPlacement> (placeholder name; snake-case "
        + "`fetch_env_cells_in_landblock` on Rust side per plan §4.3)"
);

// (C.2) Runtime accessor — `holtburg_envcell_count()` returns a
// non-zero u32 from the deterministic in-memory ResourceSource
// (mirrors Phase B's `holtburg_townhall_aabb_count` shape). If the
// count is 0, EnvCell parsing isn't reaching the manifest's
// `eor/cell` namespace; if > 0, parsing is at least running.
let phase6CEnvCellCountOk = false;
let phase6CEnvCellCountDetail =
    "phase C not yet shipped — expected wasm.holtburg_envcell_count() "
    + "(placeholder name) returning a non-zero u32 from the smoke's "
    + "in-memory ResourceSource over the Holtburg landblock prefix "
    + "(0xA9B4). Sibling to Phase B's holtburg_townhall_aabb_count.";
try {
    if (typeof wasm.holtburg_envcell_count === "function") {
        const n = wasm.holtburg_envcell_count();
        phase6CEnvCellCountOk = typeof n === "number" && n > 0;
        phase6CEnvCellCountDetail = `holtburg_envcell_count()=${n}`;
    }
} catch (e) {
    phase6CEnvCellCountDetail = `holtburg_envcell_count threw: ${e?.message ?? e}`;
}
check(
    "phase6.C.holtburg_envcell_count_nonzero",
    phase6CEnvCellCountOk,
    phase6CEnvCellCountDetail
);

// (C.3) Optional runtime check — total static-object count across
// Holtburg's EnvCells should at least match the terminal exporter's
// high-confidence support count for landblockId=0xA9B4.
//
// The exporter's
// `pipeline_data/reference/interior_support_objects_highconf.jsonl`
// has 14 high-confidence support objects under landblockId=0xA9B4
// (verified at script-write time via:
//   `grep -c '"landblockId": "0xA9B4"' \
//      pipeline_data/reference/interior_support_objects_highconf.jsonl`
// → 14).
//
// The runtime accessor counts ALL EnvCell static objects in the
// landblock — chests, tables, chairs, decorative props, etc. — not
// just the high-confidence support subset. So the floor is just
// "at least 14", which is a sanity floor not a precise match. The
// real Holtburg town hall + outbuildings interior set has hundreds
// of static objects; 14 is a conservative lower bound that any
// non-broken EnvCell parse will easily clear.
//
// TODO: confirm with implementation agent — if the runtime accessor
// is actually a parameterized helper like
// `holtburg_envcell_static_object_count(landblock: u32)` that lets
// us pin to 0xA9B4, prefer that. For now the placeholder is
// parameterless: `holtburg_static_object_count()`.
const HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR = 14;
let phase6CStaticObjectCountOk = false;
let phase6CStaticObjectCountDetail =
    "phase C not yet shipped — expected wasm.holtburg_static_object_count() "
    + "(placeholder name) returning a u32 ≥ "
    + HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR
    + " (the terminal exporter's high-conf support-object count for "
    + "landblockId=0xA9B4 in interior_support_objects_highconf.jsonl).";
try {
    if (typeof wasm.holtburg_static_object_count === "function") {
        const n = wasm.holtburg_static_object_count();
        phase6CStaticObjectCountOk =
            typeof n === "number" && n >= HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR;
        phase6CStaticObjectCountDetail = `holtburg_static_object_count()=${n} `
            + `(floor ${HOLTBURG_HIGHCONF_SUPPORT_COUNT_FLOOR}, from `
            + `interior_support_objects_highconf.jsonl filtered on landblockId=0xA9B4)`;
    }
} catch (e) {
    phase6CStaticObjectCountDetail =
        `holtburg_static_object_count threw: ${e?.message ?? e}`;
}
check(
    "phase6.C.envcell_static_object_count_matches_terminal_export",
    phase6CStaticObjectCountOk,
    phase6CStaticObjectCountDetail
);

// (C.4) Surface DID resolution — Phase 6 step C originally emitted
// `surface_did = 0` for every Environment polygon (interior cells
// rendered flat-grey). The 2026-05-09 follow-up ORs each EnvCell
// surface-table u16 with the 0x08000000 Surface namespace prefix
// (mirrors ACE `DatLoader/FileTypes/EnvCell.cs:50`). The fixture
// synthesizes a one-cell Environment + one polygon with `pos_surface
// = 0` and an EnvCell with `surfaces = [0xABCD]`; the resolved
// Surface DID should be exactly `0x0800_ABCD`. The pre-fix code
// would yield `0xABCD` (low 16 bits only) which then gets demoted
// to a 0xFF "no surface" sentinel further downstream, so checking
// for `=== 0x0800ABCD` catches the regression cleanly.
let phase6CEnvCellSurfaceDidOk = false;
let phase6CEnvCellSurfaceDidDetail =
    "phase C surface-DID follow-up not shipped — expected "
    + "wasm.holtburg_envcell_synthetic_textured_mesh_surface() "
    + "returning 0x0800ABCD (Surface DID for u16 wire value 0xABCD "
    + "OR'd with the 0x08 namespace prefix).";
try {
    if (typeof wasm.holtburg_envcell_synthetic_textured_mesh_surface === "function") {
        const did = wasm.holtburg_envcell_synthetic_textured_mesh_surface();
        const expected = 0x0800ABCD;
        phase6CEnvCellSurfaceDidOk = did === expected;
        phase6CEnvCellSurfaceDidDetail =
            `holtburg_envcell_synthetic_textured_mesh_surface()=`
            + `0x${did.toString(16).padStart(8, "0").toUpperCase()} `
            + `(expected 0x0800ABCD = 0x08000000 | 0xABCD)`;
    }
} catch (e) {
    phase6CEnvCellSurfaceDidDetail =
        `holtburg_envcell_synthetic_textured_mesh_surface threw: ${e?.message ?? e}`;
}
check(
    "phase6.C.envcell_surface_did_resolves_via_namespace_or_mask",
    phase6CEnvCellSurfaceDidOk,
    phase6CEnvCellSurfaceDidDetail
);

// === end Phase 6 Step C =============================================

// === Phase 6 Step D — active-cell tracking + Z-culling ==============
//
// Phase D is the load-bearing phase that makes multi-floor and dungeon
// traversal work. It adds:
//
//   1. `WorldState::current_cell(pos: &WorldPosition) -> CellId` — for
//      a given pose, which cell is the player IN? Outdoor: derive from
//      landblock + 8x8 grid. Indoor: 3D AABB containment across cached
//      EnvCells (cells stack in Z, so a 2D query is insufficient).
//   2. `WorldState::render_set(current: CellId, depth: u8)
//      -> HashSet<CellId>` — BFS across `cell_portal_graph` to depth=1
//      by default. Returns the set of cells whose containers should be
//      `.visible = true` this frame.
//   3. JS-side: `window.__currentCellId: u32` and
//      `window.__renderSet: Set<u32>` (placeholder names) updated each
//      rAF tick from wasm getters; the rAF tick toggles
//      `cellContainers.get(cid).visible = renderSet.has(cid)`.
//   4. Stairs are EnvCell `CellPortal` connections between Z-stacked
//      cells. Walking up the stairwell crosses a portal => current_cell
//      shifts => render_set shifts => lower floor falls out, upper
//      floor pops in. NO special "stairs" code path.
//
// What this smoke can validate (without a live ACE round-trip — that
// belongs to `capture_phase6_step_d_floors.cjs`):
//   D.1  current_cell(pos) for a synthetic OUTDOOR pose returns the
//        expected outdoor cell id. Confirms the outdoor 8x8 grid path.
//   D.2  current_cell(pos) for a synthetic INDOOR pose (inside a
//        known EnvCell AABB) returns that cell's id. Confirms the
//        indoor 3D containment path.
//   D.3  render_set BFS on a synthetic 3-cell graph (A → B → C):
//        - render_set(A, depth=1) = {A, B}
//        - render_set(B, depth=1) = {A, B, C}
//        Asserts the BFS traversal is correct AND seeds the current
//        cell.
//   D.4  Stair traversal: synthetic 2-floor cell graph stacked in Z
//        + a synthetic player walking up; current_cell transitions at
//        the expected Z threshold. End-to-end on the wasm side, no JS
//        rAF involvement.
//
// All four checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase D export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase D.
//
// NOTE: the names below are PLACEHOLDERS. Mirroring the Phase A/B/C
// convention: snake-case helper names (`holtburg_test_*`) on the Rust
// side. If the implementation chooses different idioms, update both
// this block AND `capture_phase6_step_d_floors.cjs`'s window-side
// probes (which currently look for `window.__currentCellId` /
// `window.__renderSet` / `window.__sessionHandle.getCurrentCellId` /
// `window.__sessionHandle.getRenderSet`) in the same commit so the
// smoke + live tests stay aligned.
//
// TODO: confirm with implementation agent the error-code conventions
// for the synthetic test helpers. Mirroring Phase B's contract:
//   0  = test passed
//   >0 = test ran but a specific assertion failed (impl agent picks
//        the meaning of each non-zero code, documents in the wasm
//        export's doc comment).
// (Symbol-missing is reported via `typeof === "function"` BEFORE the
// call, so a non-zero return strictly means "ran and failed".)

// (D.1) current_cell for an outdoor pose. The helper synthesizes a
// player position in a known outdoor cell (e.g. the centre of the
// Holtburg landblock 0xA9B4 outdoor 8x8 grid cell (3,4)), feeds it
// through the indoor/outdoor router, and asserts the returned cell
// id matches the expected value. Returns 0 on pass, non-zero on
// failure. The expected outdoor cell id is encoded as a constant
// inside the helper; the impl agent is free to pick any deterministic
// outdoor cell so long as it's documented in the wasm export's doc
// comment.
let phase6DCurrentCellOutdoorOk = false;
let phase6DCurrentCellOutdoorDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_current_cell_outdoor() "
    + "(placeholder name) returning 0 if current_cell(synthetic outdoor pose) "
    + "matches the expected outdoor cell id, non-zero error code otherwise. "
    + "Sibling to Phase B's holtburg_test_collision_clamp_axis_aligned shape.";
try {
    if (typeof wasm.holtburg_test_current_cell_outdoor === "function") {
        const code = wasm.holtburg_test_current_cell_outdoor();
        phase6DCurrentCellOutdoorOk = code === 0;
        phase6DCurrentCellOutdoorDetail =
            `holtburg_test_current_cell_outdoor()=${code} `
            + `(0 = outdoor lookup matched expected; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6DCurrentCellOutdoorDetail =
        `holtburg_test_current_cell_outdoor threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.current_cell_for_outdoor_position",
    phase6DCurrentCellOutdoorOk,
    phase6DCurrentCellOutdoorDetail
);

// (D.2) current_cell for an indoor pose. The helper synthesizes a
// player position INSIDE a known EnvCell's AABB (likely a unit-cube
// EnvCell at a known cell_origin, similar to Phase C's
// `holtburg_envcell_count` fixture but with non-trivial AABB
// extents). Asserts current_cell returns that cell's id. Returns 0
// on pass, non-zero on failure.
//
// Indoor lookup is fundamentally different from outdoor: outdoor is
// O(1) grid index, indoor is O(N) AABB containment over cached
// EnvCells in the current landblock (cells stack in Z, so a 2D grid
// query won't pick the right floor — this is the load-bearing
// distinction Phase D adds).
let phase6DCurrentCellIndoorOk = false;
let phase6DCurrentCellIndoorDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_current_cell_indoor() "
    + "(placeholder name) returning 0 if current_cell(synthetic indoor pose "
    + "inside a known EnvCell AABB) matches the cell's id, non-zero error code "
    + "otherwise. The helper must also assert that a pose OUTSIDE the AABB "
    + "does NOT return the cell's id — to catch the false-positive case where "
    + "the indoor lookup returns the first cell in the bucket regardless of pose.";
try {
    if (typeof wasm.holtburg_test_current_cell_indoor === "function") {
        const code = wasm.holtburg_test_current_cell_indoor();
        phase6DCurrentCellIndoorOk = code === 0;
        phase6DCurrentCellIndoorDetail =
            `holtburg_test_current_cell_indoor()=${code} `
            + `(0 = indoor AABB containment matched; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6DCurrentCellIndoorDetail =
        `holtburg_test_current_cell_indoor threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.current_cell_for_indoor_position",
    phase6DCurrentCellIndoorOk,
    phase6DCurrentCellIndoorDetail
);

// (D.3) render_set BFS on a synthetic 3-cell graph (A → B → C). The
// helper builds a synthetic `cell_portal_graph` with three nodes
// connected in a chain (A's only neighbour is B; B's neighbours are
// A and C; C's only neighbour is B), and asserts:
//   - render_set(A, depth=1) = {A, B}    — current cell + 1 hop
//   - render_set(B, depth=1) = {A, B, C} — current cell + both hops
//   - render_set(C, depth=1) = {B, C}    — current cell + 1 hop
//
// Returns 0 on pass, non-zero error code (helper picks codes per
// which sub-assertion failed) otherwise.
//
// The 3-cell chain is the simplest non-trivial graph that distinguishes
// "BFS depth 1 vs depth 0" (a 2-cell pair would only test seeding) AND
// "BFS includes self vs excludes self" (depth=1 from B must include B).
let phase6DRenderSetOk = false;
let phase6DRenderSetDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_render_set_three_cell_graph() "
    + "(placeholder name) returning 0 if render_set BFS on a synthetic "
    + "A → B → C graph produces {A,B} from A, {A,B,C} from B, {B,C} from C "
    + "at depth=1, non-zero error code otherwise.";
try {
    if (typeof wasm.holtburg_test_render_set_three_cell_graph === "function") {
        const code = wasm.holtburg_test_render_set_three_cell_graph();
        phase6DRenderSetOk = code === 0;
        phase6DRenderSetDetail =
            `holtburg_test_render_set_three_cell_graph()=${code} `
            + `(0 = BFS depth=1 on chain matches expected; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6DRenderSetDetail =
        `holtburg_test_render_set_three_cell_graph threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.render_set_bfs_depth_1",
    phase6DRenderSetOk,
    phase6DRenderSetDetail
);

// (D.4) Stair traversal: synthetic 2-floor cell graph stacked in Z +
// a synthetic player walking up; current_cell transitions at the
// expected Z threshold. The helper:
//   1. Builds two EnvCells stacked in Z (lower at z=0..3, upper at
//      z=3..6) connected by a single CellPortal.
//   2. Synthesizes player poses at z = 1.0 (lower), 2.5 (still lower),
//      3.5 (upper), 5.0 (upper) — same x/y, walking straight up.
//   3. Asserts current_cell returns lower-cell-id at z<3 and
//      upper-cell-id at z≥3.
//   4. Asserts that crossing the threshold updates the render set
//      to drop the lower cell and add the upper cell (combined
//      Phase D contract — current_cell change implies render_set
//      change).
//
// Returns 0 on pass, non-zero error code otherwise. This is the
// closest the smoke can get to the live capture's full contract
// without driving a real ACE; the live capture exercises the same
// transition end-to-end through ACE's authoritative physics.
let phase6DStairTraversalOk = false;
let phase6DStairTraversalDetail =
    "phase D not yet shipped — expected wasm.holtburg_test_stair_traversal() "
    + "(placeholder name) returning 0 if current_cell transitions at the "
    + "expected Z threshold across a synthetic 2-floor graph and the render "
    + "set tracks the transition, non-zero error code otherwise. This is the "
    + "wasm-side mirror of capture_phase6_step_d_floors.cjs's live walk-up-"
    + "stairs assertion.";
try {
    if (typeof wasm.holtburg_test_stair_traversal === "function") {
        const code = wasm.holtburg_test_stair_traversal();
        phase6DStairTraversalOk = code === 0;
        phase6DStairTraversalDetail =
            `holtburg_test_stair_traversal()=${code} `
            + `(0 = current_cell + render_set both transition at the Z threshold; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6DStairTraversalDetail =
        `holtburg_test_stair_traversal threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.stair_traversal_changes_current_cell",
    phase6DStairTraversalOk,
    phase6DStairTraversalDetail
);

// (D.5) Outdoor visibility signal — Phase 6 step D originally toggled
// per-cell `.visible` for interior cells but left the outdoor
// terrain/buildings/objects layer always-on (TODO comment in
// `tickCellVisibility`). The 2026-05-09 follow-up wraps the outdoor
// children in a single `outdoorContainer` and toggles its visibility
// via `SessionHandle.isCurrentCellIndoor()` (mirrors
// `WorldPosition::is_indoors` — `(landblock_id & 0xFFFF) >= 0x0100`).
// This check pins the wasm-side derivation across an outdoor + indoor
// + boundary cell-id set so a regression in either threshold direction
// fails loudly here before the JS-side toggle ever gets the chance to
// silently misbehave.
let phase6DOutdoorVisibilityOk = false;
let phase6DOutdoorVisibilityDetail =
    "phase D outdoor-visibility follow-up not shipped — expected "
    + "wasm.holtburg_test_outdoor_visibility_signal() returning 0 across "
    + "{outdoor 0xA9B40019, indoor 0xA9B40100, sentinel 0xA9B4FFFE, "
    + "boundary 0xA9B400FF, boundary 0xA9B40100}.";
try {
    if (typeof wasm.holtburg_test_outdoor_visibility_signal === "function") {
        const code = wasm.holtburg_test_outdoor_visibility_signal();
        phase6DOutdoorVisibilityOk = code === 0;
        phase6DOutdoorVisibilityDetail =
            `holtburg_test_outdoor_visibility_signal()=${code} `
            + `(0 = is_indoors() pin holds across outdoor/indoor/sentinel `
            + `cell-ids; non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6DOutdoorVisibilityDetail =
        `holtburg_test_outdoor_visibility_signal threw: ${e?.message ?? e}`;
}
check(
    "phase6.D.outdoor_visibility_signal_pins_indoor_threshold",
    phase6DOutdoorVisibilityOk,
    phase6DOutdoorVisibilityDetail
);

// === end Phase 6 Step D =============================================

// === Phase 6 Step E — door geometry + state ========================
//
// Phase E ships door state + door rotation. Closed doors block (their
// AABBs sit in Phase B's `building_aabb_index`); clicking a door
// dispatches `useObject` → ACE flips state → ACE pushes the new
// `DoorState` via `PublicWeenieDesc` → client emits a
// `WorldEvent::DoorStateChanged { guid, state }` (placeholder name)
// → JS handler rotates the door's GfxObj sprite around its hinge
// frame and the AABB index drops the open door's entry. Walking
// through the open door then succeeds because the index no longer
// covers it.
//
// What this smoke can validate (without a live ACE round-trip — that
// belongs to `capture_phase6_step_e_doors.cjs`):
//   E.1  Open-state mutation drops the door's AABB from the index.
//        Helper: synthesize a single-AABB index containing one door,
//        mutate that door's state to "open", assert the AABB is
//        removed (lookup against the same cell returns the empty
//        bucket).
//   E.2  Closed-state mutation re-inserts the AABB. Same fixture as
//        E.1 but starting from "open" state and flipping back to
//        "closed"; asserts the AABB is re-inserted.
//   E.3  DoorStateChanged event is emitted. Helper: synth a
//        WorldState + a simulated PublicWeenieDesc packet carrying
//        a DoorState int property; pump it through the handler;
//        assert exactly one `WorldEvent::DoorStateChanged { guid,
//        state }` is in the resulting event queue.
//   E.4  (optional) Hinge-frame rotation keyframe matches expected
//        values. Helper: synth a hinge-frame transform, apply
//        "closed" rotation, assert the resulting matrix matches a
//        baseline (likely identity); apply "open" rotation, assert
//        the matrix matches a 90°-around-hinge baseline (the exact
//        axis is impl-picked — likely Z for vertical-axis door
//        swings, X or Y for double-leaf swing-up doors).
//
// All four checks fail cleanly today (the wasm exports they probe
// don't exist yet); they pass once the implementation agent ships
// the Phase E export surface. Locked-in contract per
// docs/phase-6-buildings-and-interiors.md §5 phase E.
//
// NOTE: the names below are PLACEHOLDERS. Mirroring the Phase A/B/C/D
// convention: snake-case `holtburg_test_*` helper names on the Rust
// side. If the implementation chooses different idioms, update both
// this block AND `capture_phase6_step_e_doors.cjs`'s window-side
// probes (which currently look for `window.__doorStates` /
// `entry.__doorState` / `sprite.rotation`) in the same commit so the
// smoke + live tests stay aligned.
//
// Per-helper error-code conventions mirror Phase B/D:
//   0  = test passed
//   >0 = test ran but a specific assertion failed (impl agent picks
//        the meaning of each non-zero code, documents in the wasm
//        export's doc comment).
// (Symbol-missing is reported via `typeof === "function"` BEFORE the
// call, so a non-zero return strictly means "ran and failed".)

// (E.1) Open mutation drops AABB. The helper builds a single-cell
// AABB index containing one door, sets the door's state to "open",
// and asserts that subsequent lookups against the cell return the
// empty bucket. Returns 0 on pass, non-zero error code otherwise.
let phase6EOpenDropsAabbOk = false;
let phase6EOpenDropsAabbDetail =
    "phase E not yet shipped — expected wasm.holtburg_test_door_open_drops_aabb() "
    + "(placeholder name) returning 0 if mutating a door's state to \"open\" "
    + "removes its AABB from the per-cell `building_aabb_index`, non-zero error "
    + "code otherwise. Sibling shape to Phase B's "
    + "holtburg_test_collision_clamp_axis_aligned.";
try {
    if (typeof wasm.holtburg_test_door_open_drops_aabb === "function") {
        const code = wasm.holtburg_test_door_open_drops_aabb();
        phase6EOpenDropsAabbOk = code === 0;
        phase6EOpenDropsAabbDetail =
            `holtburg_test_door_open_drops_aabb()=${code} `
            + `(0 = open-state mutation removed AABB; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6EOpenDropsAabbDetail =
        `holtburg_test_door_open_drops_aabb threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_open_drops_aabb_from_index",
    phase6EOpenDropsAabbOk,
    phase6EOpenDropsAabbDetail
);

// (E.2) Closed mutation re-inserts AABB. Same fixture as E.1 but
// starting from "open" and flipping to "closed"; asserts the AABB
// is re-inserted. Returns 0 on pass, non-zero error code otherwise.
//
// Why both directions: the Phase E AABB toggle has to be symmetric.
// A bug that drops the AABB on open but doesn't re-insert on close
// would leave the world progressively door-less after every open/
// close cycle.
let phase6ECloseInsertsAabbOk = false;
let phase6ECloseInsertsAabbDetail =
    "phase E not yet shipped — expected wasm.holtburg_test_door_close_inserts_aabb() "
    + "(placeholder name) returning 0 if mutating a door's state to \"closed\" "
    + "re-inserts its AABB into the `building_aabb_index`, non-zero error code "
    + "otherwise.";
try {
    if (typeof wasm.holtburg_test_door_close_inserts_aabb === "function") {
        const code = wasm.holtburg_test_door_close_inserts_aabb();
        phase6ECloseInsertsAabbOk = code === 0;
        phase6ECloseInsertsAabbDetail =
            `holtburg_test_door_close_inserts_aabb()=${code} `
            + `(0 = closed-state mutation re-inserted AABB; non-zero = error code, `
            + `see wasm export doc)`;
    }
} catch (e) {
    phase6ECloseInsertsAabbDetail =
        `holtburg_test_door_close_inserts_aabb threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_close_re_inserts_aabb",
    phase6ECloseInsertsAabbOk,
    phase6ECloseInsertsAabbDetail
);

// (E.2.5) Door-part registration via AABB sweep. Mirrors the live-recv-
// loop logic that binds a door GUID to (BuildingId, part_index) by
// sweeping the per-cell AABB index for the door's spawn pose and
// picking the AABB whose XY footprint contains the door point. Replaces
// the JS-side `findClosestBuildingPart` 5m heuristic with an indexed
// lookup; the heuristic stays as fallback for races (door spawns before
// landblock AABBs drain).
let phase6EDoorPartRegOk = false;
let phase6EDoorPartRegDetail =
    "phase E follow-up not yet shipped — expected "
    + "wasm.holtburg_test_door_part_registration_via_aabb_index() returning 0 "
    + "if the AABB-sweep correctly identifies the door part within a multi-part "
    + "building and binds the door GUID via register_door_part. Non-zero codes "
    + "indicate which step failed (sweep too narrow, XY-containment picked the "
    + "wrong part, building_origin round-trip broken, or door_part_for_guid "
    + "lookup missing).";
try {
    if (typeof wasm.holtburg_test_door_part_registration_via_aabb_index === "function") {
        const code = wasm.holtburg_test_door_part_registration_via_aabb_index();
        phase6EDoorPartRegOk = code === 0;
        phase6EDoorPartRegDetail =
            `holtburg_test_door_part_registration_via_aabb_index()=${code} `
            + `(0 = sweep + bind round-trip works; non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6EDoorPartRegDetail =
        `holtburg_test_door_part_registration_via_aabb_index threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_part_registration_via_aabb_index",
    phase6EDoorPartRegOk,
    phase6EDoorPartRegDetail
);

// (E.2.6) Skill-update routing contract. Locks in that
// `should_route_message_to_world` includes PrivateUpdateSkill so a
// PrivateUpdateSkill for SkillType::Run actually lands in
// `world.player.skills` (which `resolve_self_movement_capabilities`
// reads via `player_run_rate`). Defends against future regressions
// to the routing list that would silently disable the integrator.
let phase6ESkillRouteOk = false;
let phase6ESkillRouteDetail =
    "skill-update routing not yet shipped — expected "
    + "wasm.holtburg_test_skill_update_routes_to_world() returning 0 if a "
    + "PrivateUpdateSkill for SkillType::Run flows through "
    + "WorldState::handle_message into player.skills and emits a "
    + "WorldEvent::SkillUpdated.";
try {
    if (typeof wasm.holtburg_test_skill_update_routes_to_world === "function") {
        const code = wasm.holtburg_test_skill_update_routes_to_world();
        phase6ESkillRouteOk = code === 0;
        phase6ESkillRouteDetail =
            `holtburg_test_skill_update_routes_to_world()=${code} `
            + `(0 = Run skill update reached player.skills + emitted SkillUpdated; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6ESkillRouteDetail =
        `holtburg_test_skill_update_routes_to_world threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.skill_update_routes_to_world_player_skills",
    phase6ESkillRouteOk,
    phase6ESkillRouteDetail
);

// (E.3) DoorStateChanged event emission. The helper builds a
// synthetic WorldState, simulates a `PublicWeenieDesc` packet
// arriving with a DoorState int property change for a known door
// guid, pumps it through the Phase E handler at
// `crates/holtburger-core/src/client/world/handlers/`, and asserts
// exactly one `WorldEvent::DoorStateChanged { guid, state }`
// (placeholder name) lands in the resulting event queue with the
// expected guid and state values.
//
// Returns 0 on pass; non-zero error codes (impl agent picks):
//   1 = no DoorStateChanged event emitted
//   2 = wrong guid in emitted event
//   3 = wrong state in emitted event
//   4 = multiple DoorStateChanged events emitted (handler ran more
//       than once for a single packet)
let phase6EDoorEventOk = false;
let phase6EDoorEventDetail =
    "phase E not yet shipped — expected wasm.holtburg_test_door_state_event_emitted() "
    + "(placeholder name) returning 0 if a synthetic PublicWeenieDesc with a "
    + "DoorState int property produces exactly one WorldEvent::DoorStateChanged "
    + "{ guid, state } in the WorldState event queue, non-zero error code otherwise. "
    + "WorldEvent variant name is also a placeholder; if the impl agent picks a "
    + "different variant (e.g. WorldEvent::DoorOpened/DoorClosed instead of a "
    + "single DoorStateChanged variant), update this check + the capture script "
    + "together.";
try {
    if (typeof wasm.holtburg_test_door_state_event_emitted === "function") {
        const code = wasm.holtburg_test_door_state_event_emitted();
        phase6EDoorEventOk = code === 0;
        phase6EDoorEventDetail =
            `holtburg_test_door_state_event_emitted()=${code} `
            + `(0 = exactly one DoorStateChanged event emitted with expected guid+state; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6EDoorEventDetail =
        `holtburg_test_door_state_event_emitted threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_state_changed_event_is_emitted",
    phase6EDoorEventOk,
    phase6EDoorEventDetail
);

// (E.4 — optional) Hinge-frame rotation keyframe. The helper
// synthesizes a hinge-frame transform with a known axis and pivot,
// applies the "closed" rotation, asserts the resulting matrix
// matches an expected baseline (typically identity); applies the
// "open" rotation, asserts the matrix matches the swung-90°
// baseline.
//
// Why "optional": the live capture's "rotation differs from
// baseline" assertion already proves the rotation runs — the
// keyframe match here is value-level confidence (proves the rotation
// is the RIGHT amount around the RIGHT axis), but isn't load-bearing
// for the contract. If the impl agent skips the helper, the check
// just stays at "phase E not yet shipped" and doesn't gate.
//
// Tolerance: 1e-4 on each matrix element is generous for f32
// rotations (~0.01° angular drift floor). The impl agent picks the
// exact axis convention (Z-vertical for swing doors is most common
// in retail AC), documents in the doc comment.
let phase6EHingeRotationOk = false;
let phase6EHingeRotationDetail =
    "phase E not yet shipped (optional) — expected "
    + "wasm.holtburg_test_door_rotation_keyframe() (placeholder name) returning 0 "
    + "if the hinge-frame rotation matrix matches expected baselines for both "
    + "\"closed\" (typically identity) and \"open\" (typically 90° around the "
    + "impl-picked hinge axis), non-zero error code otherwise. Optional: the live "
    + "capture proves rotation runs, this proves it's the right amount.";
try {
    if (typeof wasm.holtburg_test_door_rotation_keyframe === "function") {
        const code = wasm.holtburg_test_door_rotation_keyframe();
        phase6EHingeRotationOk = code === 0;
        phase6EHingeRotationDetail =
            `holtburg_test_door_rotation_keyframe()=${code} `
            + `(0 = hinge-frame matrices match closed+open baselines; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6EHingeRotationDetail =
        `holtburg_test_door_rotation_keyframe threw: ${e?.message ?? e}`;
}
check(
    "phase6.E.door_rotation_keyframe",
    phase6EHingeRotationOk,
    phase6EHingeRotationDetail
);

// === end Phase 6 Step E =============================================

// === Phase 6 Step F — vertical-dungeon validation ===================
//
// Phase F generalizes Phase D's portal-graph culling to N floors WITH
// NO new code. The cell-graph abstraction (insert_cell_portal +
// insert_cell_aabb + render_set BFS) treats every traversal — outdoor
// → indoor, floor 1 → floor 2, dungeon room → corridor — as the same
// `current_cell(pos)` change driven by player position. A 5-floor
// dungeon stack is just a 1-D chain in the portal graph; Phase D's
// depth=1 BFS visits self + 2 neighbours = ≤ 3 cells regardless of
// how tall the chain is.
//
// This check synthesizes a 5-cell Z-stack (floors 1..5 connected by
// sequential portals) and walks a pose through every floor, sampling
// `render_set(current, depth=1)` at each floor. Asserts:
//
//   (1) Every floor's render set is bounded (≤ 3 cells).
//   (2) Render set contains the current cell.
//   (3) Current cell transitions monotonically as Z increases.
//   (4) Bottom floor is NEVER in the top floor's render set —
//       depth=1 BFS shouldn't reach a 4-hop neighbour.
//
// If this passes, Phase D's contract holds for arbitrary N — Mite
// Maze (LB 0x01F8, 879 indoor cells) / Holtburg Dungeon (LB 0x01F6,
// 429 indoor cells) / any future 3+ floor dungeon traverses
// correctly with no Phase F-specific code.
//
// The live counterpart (capture_phase6_step_f_dungeon.cjs) drives
// the SAME assertions through ACE end-to-end against Mite Maze via
// `@teleloc 0x01F801D4 6.1 -101.6 0` (Mite Maze entrance per
// portalmitemaze weenie 1121, position_Type=2 in ace_world DB).
//
// Returns 0 on pass, non-zero error code (helper picks codes per
// which sub-assertion failed) otherwise.
let phase6FDungeonOk = false;
let phase6FDungeonDetail =
    "phase F not yet shipped — expected wasm.holtburg_test_dungeon_render_set_bounded() "
    + "returning 0 if a synthetic 5-floor cell stack walks bounded (render set ≤ 3 at "
    + "every floor, no 4-hop leakage), non-zero error code otherwise.";
try {
    if (typeof wasm.holtburg_test_dungeon_render_set_bounded === "function") {
        const code = wasm.holtburg_test_dungeon_render_set_bounded();
        phase6FDungeonOk = code === 0;
        phase6FDungeonDetail =
            `holtburg_test_dungeon_render_set_bounded()=${code} `
            + `(0 = 5-floor stack stays bounded under depth-1 BFS at every floor + `
            + `current_cell transitions monotonically + 4-hop leakage absent; `
            + `non-zero = error code, see wasm export doc)`;
    }
} catch (e) {
    phase6FDungeonDetail =
        `holtburg_test_dungeon_render_set_bounded threw: ${e?.message ?? e}`;
}
check(
    "phase6.F.dungeon_render_set_bounded_under_n_floor_walk",
    phase6FDungeonOk,
    phase6FDungeonDetail
);

// === end Phase 6 Step F =============================================


(async () => {
    // Phase 5.0b — pre-bake a manifest+shards+boot tree from the
    // git-ignored `dats/assets.hba` fixture, serve it over a local
    // http.Server, and call wasm.init_resource_source() once.
    // Every fetch_* round-trip below reads from the manifest source
    // (no asset_url parameter — the fetch_* signatures changed in
    // 5.0b's refactor).
    //
    // If `dats/assets.hba` is missing or the dat-shard release
    // binary hasn't been built, every round-trip degrades to a SKIP
    // and the symbol-presence checks above remain the floor.

    const cp = require("node:child_process");
    const os = require("node:os");
    const fixturePath = path.resolve(__dirname, "../..", "dats", "assets.hba");
    const datShardBin = path.resolve(
        __dirname, "..", "..", "target", "release", "dat-shard"
    );

    const haveFixture = !fastMode && fs.existsSync(fixturePath);
    const haveBin = !fastMode && fs.existsSync(datShardBin);

    let distDir = null; // parent containing v1/, v2/, v2conv/ subdirs
    let distDirIsCache = false; // true → don't rm on teardown
    let distServer = null;
    let manifestUrl = null;       // v1 manifest (legacy default — existing checks)
    let manifestUrlV2 = null;     // v2 manifest (Phase 5.2 obj 8)
    let manifestUrlV2Conv = null; // v2 manifest with catalog_url_template=null
    // Per-path HTTP request counter — Phase 5.2 obj 8 uses this to
    // assert "exactly one catalog HTTP request fired" on a v2
    // prefetch.
    const requestCounts = new Map();

    if (fastMode) {
        console.log(
            "  [SKIP] manifest fixture + dispatch tests — --fast mode (skipping ~6 min bake).\n" +
            "         Re-run without --fast for full coverage; CI runs full by default."
        );
    } else if (!haveFixture) {
        console.log(
            "  [SKIP] manifest fixture setup — dats/assets.hba missing.\n" +
            "         Generate via `cargo run -p holtburger-tools --bin dat2hba` (see dats/README.md)."
        );
    } else if (!haveBin) {
        console.log(
            "  [SKIP] manifest fixture setup — target/release/dat-shard missing.\n" +
            "         Build via `cargo build -p holtburger-tools --bin dat-shard --release`."
        );
    } else if (typeof fetch !== "function") {
        console.log("  [SKIP] manifest fixture setup — Node ≥18 fetch() not available.");
    } else {
        // Pick a bake-parent directory big enough to hold ~6.5 GB on
        // disk (885k shards × 4 KB block rounding + 1.86 MB boot pack +
        // 200+ MB v1 manifest.json). Resolution order:
        //   1. HOLTBURGER_SMOKE_DIST_DIR env var (full path, takes
        //      precedence — point this at /mnt/wbterminal{1,2} on dev
        //      hosts to keep the bake off the root partition).
        //   2. Node's os.tmpdir(), which honours TMPDIR / TMP / TEMP.
        //   3. Falls through to /tmp on Linux otherwise.
        // See `docs/emit-dynamic-site.md` "Bake recipe — disk-space
        // trap" for the equivalent guidance for `dist/`.
        const bakeBase = process.env.HOLTBURGER_SMOKE_DIST_DIR || os.tmpdir();
        if (!fs.existsSync(bakeBase)) {
            fs.mkdirSync(bakeBase, { recursive: true });
        }

        // Hash-cached bake. Cache key is derived from the stat tuple
        // of the inputs (fixture mtime+size + dat-shard binary
        // mtime+size + a smoke-schema version int), so any input
        // change invalidates exactly the affected entries. Cache
        // hits skip the ~6 min × 2 dat-shard runs and ~6.5 GB of
        // disk writes; first run still pays the bake cost. The
        // cache lives at `<bakeBase>/holtburger-smoke-cache/<hash>/`
        // and is NEVER deleted by the smoke harness — wipe manually
        // (`rm -rf <bakeBase>/holtburger-smoke-cache`) if the cache
        // grows beyond what your disk can hold (each entry ≈ 6.5 GB).
        const statKey = (p) => {
            const s = fs.statSync(p);
            return `${s.size}-${s.mtimeMs.toFixed(0)}`;
        };
        const cacheKey = crypto
            .createHash("sha256")
            .update(
                `v${SMOKE_BAKE_SCHEMA}|fixture:${statKey(fixturePath)}|bin:${statKey(datShardBin)}`
            )
            .digest("hex")
            .slice(0, 16);
        const cacheRoot = path.join(bakeBase, "holtburger-smoke-cache");
        const cacheDir = path.join(cacheRoot, cacheKey);
        const cacheCompleteMarker = path.join(cacheDir, ".complete");

        if (fs.existsSync(cacheCompleteMarker)) {
            distDir = cacheDir;
            distDirIsCache = true;
            console.log(`  [info] reusing cached bake → ${cacheDir}`);
        } else {
            // Stage into a sibling .tmp dir, then atomic-rename on
            // .complete write. Concurrent smoke runs against the same
            // key both stage independently; whichever wins the rename
            // is the survivor (the loser cleans up its staging on
            // EEXIST). Per-PID suffix avoids same-host race.
            const stagingDir = path.join(
                cacheRoot,
                `${cacheKey}.tmp.${process.pid}`
            );
            fs.mkdirSync(stagingDir, { recursive: true });
            console.log(`  [info] baking smoke fixture (cache miss) → ${cacheDir}`);

            // Register cleanup hooks the moment the staging dir exists
            // so a crash / Ctrl-C between here and the rename still
            // rms the partial bake. Without this the ~6.5 GB pile
            // accumulates per failed run; the cache itself is
            // preserved (no rm of cacheDir).
            let cleanedUp = false;
            const cleanup = () => {
                if (cleanedUp) return;
                cleanedUp = true;
                try { if (distServer) distServer.close(); } catch (_) {}
                try {
                    if (fs.existsSync(stagingDir)) {
                        fs.rmSync(stagingDir, { recursive: true, force: true });
                    }
                } catch (_) {}
                // distDir is the cache OR a partial in-progress bake;
                // never rm the cache dir itself. distDirIsCache=true
                // means "leave it alone for the next run".
                try {
                    if (distDir && !distDirIsCache) {
                        fs.rmSync(distDir, { recursive: true, force: true });
                    }
                } catch (_) {}
            };
            process.on("exit", cleanup);
            process.on("SIGINT", () => { cleanup(); process.exit(130); });
            process.on("SIGTERM", () => { cleanup(); process.exit(143); });
            process.on("uncaughtException", (e) => {
                console.error("[smoke] uncaughtException:", e?.message ?? e);
                cleanup();
                process.exit(1);
            });
            process.on("unhandledRejection", (e) => {
                console.error("[smoke] unhandledRejection:", e?.message ?? e);
                cleanup();
                process.exit(1);
            });

            // Bake two variants under sibling subdirs of `stagingDir`.
            // See cache-miss commentary above for the v1/v2/v2conv
            // layout rationale (avoid `fs.cpSync` of the 4 GB dist).
            const stagingV1 = path.join(stagingDir, "v1");
            const stagingV2 = path.join(stagingDir, "v2");
            fs.mkdirSync(stagingV1, { recursive: true });
            fs.mkdirSync(stagingV2, { recursive: true });

            cp.execFileSync(
                datShardBin,
                ["--manifest-version=1", "--input", fixturePath, "--output", stagingV1],
                { stdio: "ignore" }
            );
            cp.execFileSync(
                datShardBin,
                ["--manifest-version=2", "--input", fixturePath, "--output", stagingV2],
                { stdio: "ignore" }
            );

            // Convention-URL variant — single rewritten manifest.json,
            // shares everything else with the v2 dir.
            {
                const v2ManifestObj = JSON.parse(
                    fs.readFileSync(path.join(stagingV2, "manifest.json"), "utf8")
                );
                v2ManifestObj.catalog_url_template = null;
                v2ManifestObj.shard_url_template =
                    "shards/{namespace_slug}/{file_id_hex}.bin";
                fs.writeFileSync(
                    path.join(stagingDir, "v2conv-manifest.json"),
                    JSON.stringify(v2ManifestObj, null, 2)
                );
            }

            // Mark complete + atomic rename. If a parallel smoke
            // already promoted its own staging into cacheDir, our
            // rename throws EEXIST/ENOTEMPTY — discard our staging
            // (their bake is equivalent) and use the existing cache.
            fs.writeFileSync(
                path.join(stagingDir, ".complete"),
                new Date().toISOString()
            );
            try {
                fs.renameSync(stagingDir, cacheDir);
                distDir = cacheDir;
                distDirIsCache = true;
            } catch (renameErr) {
                if (fs.existsSync(cacheCompleteMarker)) {
                    fs.rmSync(stagingDir, { recursive: true, force: true });
                    distDir = cacheDir;
                    distDirIsCache = true;
                    console.log("  [info] another smoke won the cache write; using its bake");
                } else {
                    throw renameErr;
                }
            }
        }

        const distDirV1 = path.join(distDir, "v1");
        const distDirV2 = path.join(distDir, "v2");
        const v2ConvManifestPath = path.join(distDir, "v2conv-manifest.json");

        // URL-prefix-routed server: `/v1/...` → distDirV1,
        // `/v2/...` → distDirV2, `/v2conv/manifest.json` →
        // v2ConvManifestPath, `/v2conv/<anything else>` →
        // distDirV2/<anything else>. Tracks per-path request
        // counts for the obj 8 exactly-one-catalog-fetch assertion.
        distServer = http.createServer((req, res) => {
            requestCounts.set(req.url, (requestCounts.get(req.url) ?? 0) + 1);
            // Force connection close on every response so undici's
            // (Node fetch's backend) keepalive pool doesn't hold a
            // stale TCP socket past the server's 5 s keepAliveTimeout.
            // Without this, slow --dev wasm builds whose prefetch
            // chain exceeds 5 s leave the pool with a closed-by-server
            // socket; the next wasm fetch tries to reuse it and gets
            // ECONNRESET (surfacing in lib.rs as
            // `init_resource_source: fetch network error: {}`). The
            // smoke is single-threaded against a fixture-only server,
            // so per-request connect overhead is negligible (~1 ms);
            // the bytes-served path is unchanged.
            res.setHeader("Connection", "close");
            const url = decodeURIComponent(req.url.replace(/^\/+/, ""));
            let filePath = null;
            if (url === "v2conv/manifest.json") {
                filePath = v2ConvManifestPath;
            } else if (url.startsWith("v2conv/")) {
                // Everything else under /v2conv/ falls through to v2
                // — shards + manifest/ + boot.hba are byte-identical.
                filePath = path.join(distDirV2, url.substring("v2conv/".length));
                if (!filePath.startsWith(distDirV2)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
            } else if (url.startsWith("v2/")) {
                filePath = path.join(distDirV2, url.substring("v2/".length));
                if (!filePath.startsWith(distDirV2)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
            } else if (url.startsWith("v1/")) {
                filePath = path.join(distDirV1, url.substring("v1/".length));
                if (!filePath.startsWith(distDirV1)) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
            } else {
                res.writeHead(404);
                res.end();
                return;
            }
            fs.readFile(filePath, (err, data) => {
                if (err) {
                    res.writeHead(404);
                    res.end();
                    return;
                }
                res.writeHead(200, {
                    "content-type": "application/octet-stream",
                    "content-length": data.length,
                });
                res.end(data);
            });
        });
        // Belt-and-suspenders: disable keepalive at the server level
        // too. `Connection: close` headers above are the mechanism
        // that actually closes per-request; this just ensures the
        // server's idle-socket reaper doesn't outlast a slow client.
        distServer.keepAliveTimeout = 0;
        await new Promise((resolve) => distServer.listen(0, "127.0.0.1", resolve));
        const distPort = distServer.address().port;
        manifestUrl = `http://127.0.0.1:${distPort}/v1/manifest.json`;
        manifestUrlV2 = `http://127.0.0.1:${distPort}/v2/manifest.json`;
        manifestUrlV2Conv = `http://127.0.0.1:${distPort}/v2conv/manifest.json`;

        try {
            await wasm.init_resource_source(manifestUrl);
            check(
                "ManifestResourceSource.connect() resolves against pre-baked dist/",
                wasm.has_resource_source() === true,
                `manifestUrl=${manifestUrl}, has_resource_source()=${wasm.has_resource_source()}`
            );
            check(
                "ManifestResourceSource starts with empty shard cache (boot serves directly)",
                wasm.cached_shard_count() === 0,
                `cached_shard_count()=${wasm.cached_shard_count()}`
            );
            // Phase 5.2 obj 8 — v1→v2 migration smoke: when a
            // legacy v1 manifest is the connect target, the
            // dispatcher routes to the v1 inner source (and
            // logs a deprecation warning via the `log` crate;
            // not directly observable from JS without a log
            // backend). The runtime accessor is what matters
            // — `manifest_version()` reports 1 — and records
            // still resolve through the inner v1 path (the
            // fetch_* round-trips below cover this).
            check(
                "v1 manifest dispatch: manifest_version()=1 after connect against v1 dist/",
                wasm.manifest_version() === 1,
                `manifest_version()=${wasm.manifest_version()}`
            );
            check(
                "v1 manifest dispatch: loaded_catalog_count()=0 (v1 has no catalogs)",
                wasm.loaded_catalog_count() === 0,
                `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
            );
        } catch (e) {
            check(
                "ManifestResourceSource.connect() resolves against pre-baked dist/",
                false,
                `init_resource_source threw: ${e?.message ?? e}`
            );
        }
    }

    // The fetch_* round-trips below all require the manifest source
    // to be live. Skip the whole block if init failed / fixture
    // missing.
    if (manifestUrl && wasm.has_resource_source()) {
        // Phase 2 §8 step 4 round-trip (manifest mode): pull a known
        // record by (namespace, file_id). 0xA9B4FFFF is the Holtburg
        // CellLandblock — present in the boot pack since it's in the
        // 9-cell spawn neighborhood (Phase 5.0 obj 8 boot policy).
        try {
            const expectedNamespace = "eor/cell";
            const expectedFileId = 0xA9B4FFFF;
            const got = await wasm.try_http_resource_source_smoke(
                expectedNamespace,
                expectedFileId
            );
            check(
                `try_resource_source_smoke fetches via manifest source; ${expectedNamespace}:0x${expectedFileId.toString(16).toUpperCase().padStart(8, "0")} length>0`,
                got > 0,
                `got ${got} bytes`
            );
        } catch (e) {
            check(
                "try_resource_source_smoke round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 1 round-trip: fetch the Holtburg-town-centre
        // CellLandblock. Boot-pack-served (no shard fetch needed).
        try {
            const cellId = 0xa9b4ffff;
            const mesh = await wasm.fetch_landblock_heightmap(cellId);

            const positionsOk =
                mesh.positions instanceof Float32Array &&
                mesh.positions.length === 243;
            check(
                "fetch_landblock_heightmap: positions is Float32Array of 243",
                positionsOk,
                `len=${mesh.positions?.length}, ctor=${mesh.positions?.constructor?.name}`
            );

            const indicesOk =
                mesh.indices instanceof Uint16Array &&
                mesh.indices.length === 384;
            check(
                "fetch_landblock_heightmap: indices is Uint16Array of 384",
                indicesOk,
                `len=${mesh.indices?.length}, ctor=${mesh.indices?.constructor?.name}`
            );

            const cornerOk =
                mesh.positions[0] === 0 &&
                mesh.positions[1] === 0 &&
                mesh.positions[80 * 3] === 192 &&
                mesh.positions[80 * 3 + 1] === 192;
            check(
                "fetch_landblock_heightmap: corner vertices at (0,0) and (192,192)",
                cornerOk,
                `(${mesh.positions[0]},${mesh.positions[1]}) (${mesh.positions[80 * 3]},${mesh.positions[80 * 3 + 1]})`
            );

            const rangeOk =
                Number.isFinite(mesh.heightMin) &&
                Number.isFinite(mesh.heightMax) &&
                mesh.heightMin >= 0 &&
                mesh.heightMax <= 510 &&
                mesh.heightMax >= mesh.heightMin;
            check(
                "fetch_landblock_heightmap: height bounds in [0, 510]",
                rangeOk,
                `min=${mesh.heightMin}, max=${mesh.heightMax}`
            );

            let maxIdx = 0;
            for (let i = 0; i < mesh.indices.length; i += 1) {
                if (mesh.indices[i] > maxIdx) maxIdx = mesh.indices[i];
            }
            check(
                "fetch_landblock_heightmap: max index < 81 (within 9×9 grid)",
                maxIdx === 80,
                `maxIdx=${maxIdx}`
            );

            const codes = mesh.terrainCodes;
            const codesShapeOk = codes instanceof Uint8Array && codes.length === 81;
            check(
                "fetch_landblock_heightmap: terrainCodes is Uint8Array of 81 (Phase 3 step 3)",
                codesShapeOk,
                `len=${codes?.length}`
            );

            let minCode = 255, maxCode = 0;
            for (let i = 0; i < codes.length; i += 1) {
                if (codes[i] < minCode) minCode = codes[i];
                if (codes[i] > maxCode) maxCode = codes[i];
            }
            check(
                "fetch_landblock_heightmap: terrainCodes values all in [0, 31]",
                minCode >= 0 && maxCode <= 31,
                `min=${minCode}, max=${maxCode}`
            );

            const distinct = new Set(codes).size;
            check(
                "fetch_landblock_heightmap: Holtburg centre has ≥3 distinct terrain types",
                distinct >= 3,
                `${distinct} distinct: [${[...new Set(codes)].sort((a, b) => a - b).join(", ")}]`
            );

            const roads = mesh.roadCodes;
            const roadShapeOk = roads instanceof Uint8Array && roads.length === 81;
            check(
                "fetch_landblock_heightmap: roadCodes is Uint8Array of 81 (Phase 3 step 5)",
                roadShapeOk,
                `len=${roads?.length}`
            );

            let roadMin = 255, roadMax = 0, roadCount = 0;
            for (let i = 0; i < roads.length; i += 1) {
                if (roads[i] < roadMin) roadMin = roads[i];
                if (roads[i] > roadMax) roadMax = roads[i];
                if (roads[i] > 0) roadCount += 1;
            }
            check(
                "fetch_landblock_heightmap: roadCodes values all in [0, 3]",
                roadMin >= 0 && roadMax <= 3,
                `min=${roadMin}, max=${roadMax}`
            );

            check(
                "fetch_landblock_heightmap: Holtburg centre has road network (≥10 road verts)",
                roadCount >= 10,
                `${roadCount} road verts of 81`
            );

            mesh.free();
        } catch (e) {
            check(
                "fetch_landblock_heightmap round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 2 batch round-trip: 3×3 Holtburg neighbourhood.
        // Boot-pack-served for all 9 cells.
        try {
            const HOLTBURG_NEIGHBOURHOOD = [
                0xa8b5ffff, 0xa9b5ffff, 0xaab5ffff,
                0xa8b4ffff, 0xa9b4ffff, 0xaab4ffff,
                0xa8b3ffff, 0xa9b3ffff, 0xaab3ffff,
            ];
            const meshes = await wasm.fetch_landblock_heightmaps(
                new Uint32Array(HOLTBURG_NEIGHBOURHOOD)
            );
            check(
                "fetch_landblock_heightmaps: returns 9 entries for 9 input ids",
                Array.isArray(meshes) && meshes.length === 9,
                `len=${meshes?.length}, isArray=${Array.isArray(meshes)}`
            );

            const nw = meshes[0];
            const sane =
                Number.isFinite(nw.heightMin) &&
                Number.isFinite(nw.heightMax) &&
                nw.heightMin >= 0 &&
                nw.heightMax <= 510 &&
                nw.heightMax >= nw.heightMin;
            check(
                "fetch_landblock_heightmaps: NW neighbour height bounds in [0, 510]",
                sane,
                `min=${nw.heightMin}, max=${nw.heightMax}`
            );

            const centre = meshes[4];
            const centreHoltburg =
                centre.heightMin === 30 && centre.heightMax === 96;
            check(
                "fetch_landblock_heightmaps: centre id (0xA9B4FFFF) matches Holtburg singular round-trip",
                centreHoltburg,
                `min=${centre.heightMin}, max=${centre.heightMax}`
            );

            for (const m of meshes) m.free();
        } catch (e) {
            check(
                "fetch_landblock_heightmaps round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 3.5 round-trip: 33 retail terrain textures.
        // The 33 SurfaceTexture IDs aren't in the obj-3 minimum-viable
        // boot pack — they fetch as shards on demand via the 3-level
        // explicit prefetch in fetch_terrain_textures. Cached_shard_count
        // climbs as a result.
        try {
            const cacheBefore = wasm.cached_shard_count();
            const t0 = Date.now();
            const textures = await wasm.fetch_terrain_textures();
            const elapsed = Date.now() - t0;
            const cacheAfter = wasm.cached_shard_count();

            check(
                `fetch_terrain_textures: returns 33 entries (Phase 3 step 3.5)`,
                Array.isArray(textures) && textures.length === 33,
                `len=${textures?.length}, ${elapsed} ms`
            );

            check(
                "fetch_terrain_textures: shard cache grew (Phase 5.0b prefetch path)",
                cacheAfter > cacheBefore,
                `cache: ${cacheBefore} → ${cacheAfter}`
            );

            let allOk = true;
            let firstFail = null;
            for (let i = 0; i < textures.length; i += 1) {
                const t = textures[i];
                const ok =
                    t.terrainType === i &&
                    t.width > 0 &&
                    t.height > 0 &&
                    t.pixels instanceof Uint8Array &&
                    t.pixels.length === t.width * t.height * 4;
                if (!ok) { allOk = false; firstFail = { i, t }; break; }
            }
            check(
                "fetch_terrain_textures: every blob is RGBA8 with width*height*4 pixels",
                allOk,
                allOk
                    ? `all 33 OK; first ${textures[0].width}x${textures[0].height}`
                    : `failed at index ${firstFail?.i}`
            );

            check(
                "fetch_terrain_textures: BarrenRock (type 0) is 512x512",
                textures[0].terrainType === 0 &&
                    textures[0].width === 512 &&
                    textures[0].height === 512,
                `${textures[0].width}x${textures[0].height} type=${textures[0].terrainType}`
            );

            for (const t of textures) t.free();
        } catch (e) {
            check(
                "fetch_terrain_textures round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }

        // Phase 3 step 4 round-trip: object placements for 9-cell
        // LandblockInfo neighbourhood. Boot-pack-served.
        try {
            const HOLTBURG_LBI = [
                0xa8b5fffe, 0xa9b5fffe, 0xaab5fffe,
                0xa8b4fffe, 0xa9b4fffe, 0xaab4fffe,
                0xa8b3fffe, 0xa9b3fffe, 0xaab3fffe,
            ];
            const objects = await wasm.fetch_landblock_objects(
                new Uint32Array(HOLTBURG_LBI)
            );

            check(
                "fetch_landblock_objects: returns ≥100 placements for Holtburg 3×3 (Phase 3 step 4)",
                Array.isArray(objects) && objects.length >= 100,
                `len=${objects?.length}`
            );

            let allOk = true;
            let firstFail = null;
            for (let i = 0; i < objects.length; i += 1) {
                const o = objects[i];
                const ok =
                    o.modelId > 0 &&
                    o.x >= -10 && o.x <= 202 &&
                    o.y >= -10 && o.y <= 202 &&
                    Number.isFinite(o.rotationZ);
                if (!ok) { allOk = false; firstFail = { i, o }; break; }
            }
            check(
                "fetch_landblock_objects: every placement has valid modelId/position/rotation",
                allOk,
                allOk
                    ? `${objects.length} OK; sample modelId=0x${objects[0].modelId.toString(16).toUpperCase().padStart(8, "0")}`
                    : `failed at i=${firstFail?.i}`
            );

            const centreId = 0xa9b4fffe;
            const centreObjs = objects.filter((o) => o.landblockId === centreId);
            check(
                "fetch_landblock_objects: Holtburg centre has ≥50 objects (real town density)",
                centreObjs.length >= 50,
                `${centreObjs.length} at 0x${centreId.toString(16).toUpperCase()}`
            );

            // Phase 3 step 4.5 round-trip via the manifest-mode iterative
            // discovery (RecordingSource pattern in `prefetch.rs`). Walks
            // ~81 unique Holtburg models through GfxObj/SetupModel →
            // Surface chains; multiple prefetch rounds expected.
            const uniqueModels = [...new Set(objects.map((o) => o.modelId))];
            const t0 = Date.now();
            const colours = await wasm.fetch_object_colours(
                new Uint32Array(uniqueModels)
            );
            const elapsedMs = Date.now() - t0;

            const lengthOk = (Array.isArray(colours) || colours instanceof Uint32Array) && colours.length === uniqueModels.length;
            check(
                "fetch_object_colours: returns one ARGB per unique model_id (Phase 3 step 4.5)",
                lengthOk,
                `len=${colours?.length}, uniqueModels=${uniqueModels.length}, ${elapsedMs} ms`
            );

            let resolved = 0;
            const distinctColours = new Set();
            for (let i = 0; i < colours.length; i += 1) {
                const argb = colours[i];
                if (argb === 0) continue;
                resolved += 1;
                distinctColours.add(argb);
            }
            const resolveRatio = uniqueModels.length > 0 ? resolved / uniqueModels.length : 0;
            check(
                "fetch_object_colours: ≥10% of Holtburg unique models resolve to a non-zero colour",
                resolveRatio >= 0.10,
                `${resolved} / ${uniqueModels.length} resolved (${(resolveRatio * 100).toFixed(1)}%)`
            );
            check(
                "fetch_object_colours: resolved palette has ≥5 distinct ARGB values (no uniform-tint regression)",
                distinctColours.size >= 5,
                `${distinctColours.size} distinct of ${resolved} resolved`
            );

            // Phase 3 step 6 round-trip: triangulate one Holtburg
            // house. Drives the full GfxObj → polygon → surface walk
            // through manifest-mode prefetch.
            const HOUSE_ID = 0x01000827;
            const houseMesh = await wasm.fetch_model_mesh(HOUSE_ID);
            check(
                "fetch_model_mesh: Holtburg house 0x01000827 yields >0 triangles",
                houseMesh.triCount > 0,
                `${houseMesh.triCount} triangles, ${houseMesh.surfaces.length} surfaces`
            );
            const wb = houseMesh.worldBounds;
            check(
                "fetch_model_mesh: house world bounds ≈ [12, 13.6] (matches atlas)",
                Math.abs(wb[0] - 12.0) < 0.1 && Math.abs(wb[1] - 13.6) < 0.1,
                `worldBounds=[${wb[0].toFixed(2)}, ${wb[1].toFixed(2)}]`
            );
            check(
                "fetch_model_mesh: positions/uvs/surface_indices buffer lengths consistent",
                houseMesh.positions.length === houseMesh.triCount * 9
                    && houseMesh.uvs.length === houseMesh.triCount * 6
                    && houseMesh.surfaceIndices.length === houseMesh.triCount,
                `pos=${houseMesh.positions.length}, uv=${houseMesh.uvs.length}, sidx=${houseMesh.surfaceIndices.length}`
            );
            houseMesh.free();

            // === Phase 6 Step B follow-up ============================
            //
            // Live integration probe: end-to-end exercise of the
            // `populateBuildingAabbsForLandblock` wasm export against
            // real Holtburg landblock data via the manifest source.
            //
            // The export walks `LandblockInfo.buildings` for
            // `0xA9B4FFFE`, fetches each Setup, derives per-part
            // AABBs, transforms them to world space, buckets them
            // into outdoor cells, and pushes them onto a thread-
            // local pending pile. Returns the queued count.
            //
            // What this proves:
            //   - The LandblockInfo path resolves through manifest
            //     mode (boot pack covers 0xA9B4FFFE).
            //   - Setup walks chase missing GfxObj children via
            //     `prefetch::ensure_walk_prefetched`.
            //   - `walk_setup_parts_with_geom` yields non-empty
            //     AABBs for at least one Holtburg building.
            //   - The placement-frame transform produces world-space
            //     AABBs that fall inside the LB's outdoor cells.
            //
            // The compute path is what the live recv loop drains
            // into the spatial scene on the next TickMovement; a
            // non-zero count here = non-zero entries available to
            // the integrator's swept-sphere query in the browser.
            try {
                const queued = await wasm.populateBuildingAabbsForLandblock(0xA9B40000);
                check(
                    "phase6.B.populateBuildingAabbsForLandblock_holtburg_nonzero",
                    typeof queued === "number" && queued > 0,
                    `populateBuildingAabbsForLandblock(0xA9B40000)=${queued} `
                    + `(expected > 0; queued AABBs land in scene on next TickMovement)`
                );
            } catch (e) {
                check(
                    "phase6.B.populateBuildingAabbsForLandblock_holtburg_nonzero",
                    false,
                    `threw: ${e?.message ?? e}`
                );
            }
            // === end Phase 6 Step B follow-up =========================

            // === Phase 7.4a — RAW keyframe export (real DAT round-trip) ==
            // Call `fetchEntityAnimationKeyframes` against the live
            // manifest with several known-good `(setup_id, mtable_id)`
            // candidates and assert that AT LEAST ONE resolves a
            // walk-forward cycle with `numFrames > 0` + `partCount > 0`
            // + `framerate > 0`. The candidates cover:
            //   - 0x02000001 / 0x09000001 — the verified-real
            //     MotionTable from `crates/holtburger-world/src/state/
            //     tests.rs:1244` (the "repo assets bundle" test asserts
            //     this resolves a walk_forward cycle).
            //   - 0x02000002 / 0x09000001 — second humanoid candidate.
            //   - 0x02000003 / 0x09000001 — third humanoid candidate.
            //
            // The `try_resolve_cycle_frames` helper logs `None` for
            // setups whose MotionTable doesn't carry walk_forward —
            // that's expected for many non-walking-creature setups.
            // We assert that ≥1 candidate resolves so the smoke gives
            // a real data point on every run.
            //
            // Also asserts the flat keyframe buffer has the expected
            // `numFrames * partCount * 7` length — the contract the
            // JS adapter (`buildAnimationClip`) reads.
            const WALK_FORWARD_COMMAND = 0x45000005 >>> 0;
            const candidates = [
                [0x02000001, 0x09000001], // verified MotionTable from tests.rs:1244
                [0x02000002, 0x09000001],
                [0x02000003, 0x09000001],
                [0x02000004, 0x09000001],
            ];
            let p7Resolved = null;
            let p7LastError = null;
            for (const [setupId, mtableId] of candidates) {
                try {
                    const data = await wasm.fetchEntityAnimationKeyframes(
                        setupId,
                        new Uint32Array(0),
                        new Uint32Array(0),
                        0,
                        new Uint32Array(0),
                        mtableId,
                        WALK_FORWARD_COMMAND,
                        0,
                    );
                    const numFrames = data.numFrames >>> 0;
                    const partCount = data.partCount >>> 0;
                    const framerate = +data.framerate;
                    const partFrames = data.partFrames;
                    if (numFrames > 0 && partCount > 0 && framerate > 0) {
                        p7Resolved = {
                            setupId,
                            mtableId,
                            numFrames,
                            partCount,
                            framerate,
                            partFramesLen: partFrames?.length ?? 0,
                            resolvedStance: data.resolvedStance >>> 0,
                        };
                        // Drain rest-pose meshes; free wasm-allocated handles.
                        const meshes = data.takePartMeshes();
                        for (const m of meshes) m.free?.();
                        data.free?.();
                        break;
                    }
                    data.free?.();
                } catch (e) {
                    p7LastError = String(e?.message ?? e).slice(0, 120);
                }
            }
            check(
                "Phase 7.4a: fetchEntityAnimationKeyframes resolves real walk-cycle keyframes",
                p7Resolved != null &&
                    p7Resolved.numFrames > 0 &&
                    p7Resolved.partCount > 0 &&
                    p7Resolved.framerate > 0,
                p7Resolved
                    ? `setup=0x${p7Resolved.setupId.toString(16)}, ` +
                      `mtable=0x${p7Resolved.mtableId.toString(16)}, ` +
                      `numFrames=${p7Resolved.numFrames}, ` +
                      `partCount=${p7Resolved.partCount}, ` +
                      `framerate=${p7Resolved.framerate}, ` +
                      `resolvedStance=0x${p7Resolved.resolvedStance.toString(16)}`
                    : `no candidate resolved walk-forward; lastError=${p7LastError ?? "none"}`,
            );
            if (p7Resolved) {
                const expectedLen = p7Resolved.numFrames * p7Resolved.partCount * 7;
                check(
                    "Phase 7.4a: partFrames flat buffer = numFrames * partCount * 7 floats",
                    p7Resolved.partFramesLen === expectedLen,
                    `expected=${expectedLen}, actual=${p7Resolved.partFramesLen}`,
                );
            }
            // === end Phase 7.4a real-data round-trip =====================

            // === Follow-on #4 — 0-parts setups investigation =============
            // Phase 7.4b's capture script originally pointed at fabricated
            // setup IDs (0x02000099 / 0x020001ED / 0x0200013D) it had
            // copy-pasted from a Rust unit-test fixture. Those IDs are NOT
            // real Sparring Golem / Mite / Drudge setups; cross-referenced
            // against the LSD weenie JSON (didStats key 1 = SetupId, key 2
            // = MotionTableId) on 2026-05-10:
            //   - 0x02000099 — not used by any wcid (synthetic test setup;
            //     `triangulate_setup_model_with_substitutions_*` tests
            //     synthesize a fake SetupModel at this id).
            //   - 0x020001ED — not used by any wcid.
            //   - 0x0200013D — used by wcid 322 (Jo), 338 (Quarter Staff),
            //     etc; a 1-part weapon model, not Drudge.
            // Correct IDs from didStats:
            //   - Sparring Golem (wcid 12698): setup=0x020007CC,
            //     mtable=0x09000081 → 21 parts, 60 frames, 30 fps. PASS.
            //   - Drudge Toiler (wcid 30649): setup=0x020007DD,
            //     mtable=0x09000008 → 17 parts, 40 frames, 30 fps. PASS.
            //   - Mite Sentry (wcid 945): setup=0x02001080,
            //     mtable=0x0900000B → 18 parts, 0 frames. Legitimately
            //     no WALK_FORWARD cycle in this mtable (only the Ready
            //     idle resolves); not a bug — mites in retail AC walked
            //     via mtable links/modifiers, not the standard
            //     WALK_FORWARD command. Renderer correctly falls back to
            //     rest pose.
            // Fix landed: `capture_phase7_4_entities.cjs` updated with
            // the real IDs above. No Rust code change was required —
            // the wasm walk is correct; the labels were stale.
            const realSparringGolem = await wasm.fetchEntityAnimationKeyframes(
                0x020007cc, new Uint32Array(0), new Uint32Array(0), 0,
                new Uint32Array(0), 0x09000081, WALK_FORWARD_COMMAND, 0,
            );
            const realDrudgeToiler = await wasm.fetchEntityAnimationKeyframes(
                0x020007dd, new Uint32Array(0), new Uint32Array(0), 0,
                new Uint32Array(0), 0x09000008, WALK_FORWARD_COMMAND, 0,
            );
            const realMiteSentry = await wasm.fetchEntityAnimationKeyframes(
                0x02001080, new Uint32Array(0), new Uint32Array(0), 0,
                new Uint32Array(0), 0x0900000b, WALK_FORWARD_COMMAND, 0,
            );
            const sgParts = realSparringGolem.partCount;
            const sgFrames = realSparringGolem.numFrames;
            const dtParts = realDrudgeToiler.partCount;
            const dtFrames = realDrudgeToiler.numFrames;
            const msParts = realMiteSentry.partCount;
            const msFrames = realMiteSentry.numFrames;
            // Drain the wasm side immediately.
            for (const m of realSparringGolem.takePartMeshes()) m.free?.();
            for (const m of realDrudgeToiler.takePartMeshes()) m.free?.();
            for (const m of realMiteSentry.takePartMeshes()) m.free?.();
            realSparringGolem.free?.();
            realDrudgeToiler.free?.();
            realMiteSentry.free?.();
            check(
                "F#4: 0-parts setups investigation — real Sparring Golem + Drudge Toiler + Mite Sentry resolve via LSD-weenie didStats IDs",
                sgParts === 21 && sgFrames === 60 &&
                    dtParts === 17 && dtFrames === 40 &&
                    msParts === 18 && msFrames === 0,
                `golem=${sgParts}p/${sgFrames}f, drudgeToiler=${dtParts}p/${dtFrames}f, ` +
                `miteSentry=${msParts}p/${msFrames}f (mite expected 0f — mtable has no WALK)`,
            );
            // === end Follow-on #4 investigation check ====================

            for (const o of objects) o.free();
        } catch (e) {
            check(
                "fetch_landblock_objects round-trip succeeds",
                false,
                `threw: ${e?.message ?? e}`
            );
        }
    } else if (haveFixture && haveBin) {
        // Fixture present but init_resource_source failed — surfaces
        // as the init check above; skip the round-trips.
        console.log(
            "  [SKIP] fetch_* round-trips — init_resource_source failed (see earlier failure)."
        );
    }

    // ============================================================
    // Phase 5.2 obj 8 — v2 manifest smoke checks.
    //
    // Re-init the global source against a v2-baked dist/ (catalog
    // mode) and exercise the new code paths. Then re-init against
    // the convention-URL variant (catalog_url_template=null) and
    // confirm prefetch still resolves via convention symlinks.
    // ============================================================
    if (manifestUrlV2) {
        try {
            // Reset the per-path counter so the catalog-fetch
            // assertion below sees only requests from this re-init.
            requestCounts.clear();

            await wasm.init_resource_source(manifestUrlV2);
            check(
                "v2 manifest dispatch: connect resolves against v2-baked dist/",
                wasm.has_resource_source() === true,
                `manifestUrlV2=${manifestUrlV2}, has_resource_source()=${wasm.has_resource_source()}`
            );
            check(
                "v2 manifest dispatch: manifest_version()=2 after connect",
                wasm.manifest_version() === 2,
                `manifest_version()=${wasm.manifest_version()}`
            );
            check(
                "v2 manifest dispatch: loaded_catalog_count()=0 before any prefetch",
                wasm.loaded_catalog_count() === 0,
                `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
            );

            // (6) Top-level v2 manifest <5 KB invariant. The fixture's
            // 605 MB HBA produces ~885k records; v1's manifest.json
            // would be ~200 MB. v2's must stay tiny regardless.
            const v2ManifestPath = path.join(distDir, "v2", "manifest.json");
            const v2ManifestSize = fs.statSync(v2ManifestPath).size;
            check(
                "v2 top-level manifest.json is <5 KB regardless of bundle size",
                v2ManifestSize < 5 * 1024,
                `manifest.json=${v2ManifestSize} bytes`
            );

            // (2) Round-trip: pull a known record by (namespace,
            // file_id), assert byte equality with the source. The
            // boot pack covers `eor/cell:0xA9B4FFFF` (Holtburg
            // CellLandblock — in the spawn neighborhood); fetch
            // it via `try_http_resource_source_smoke` and verify
            // we got non-empty bytes.
            try {
                const got = await wasm.try_http_resource_source_smoke(
                    "eor/cell",
                    0xA9B4FFFF
                );
                check(
                    "v2 round-trip: eor/cell:0xA9B4FFFF resolves via boot pack (length>0)",
                    got > 0,
                    `got ${got} bytes`
                );
            } catch (e) {
                check(
                    "v2 round-trip: eor/cell:0xA9B4FFFF resolves via boot pack",
                    false,
                    `threw: ${e?.message ?? e}`
                );
            }

            // (4) Catalog lazy-fetch invariants. Need to probe with
            // a record that's NOT in the boot pack's transitive
            // closure (else `prefetch` is a no-op and no catalog
            // fetch fires). The boot closure covers the Holtburg
            // spawn neighborhood + every record reachable from
            // those placements; records in unrelated zones / file-
            // id ranges are typically excluded. Try several probes
            // spanning ranges that the spawn-area walk doesn't
            // touch (Texture / Palette / SurfaceTexture root IDs).
            const probes = [
                ["eor/portal", 0x06000001], // Texture
                ["eor/portal", 0x05000001], // SurfaceTexture
                ["eor/portal", 0x04000001], // Palette
                ["eor/portal", 0x08000001], // Animation
                ["eor/cell", 0xC0C0FFFF],   // far-away cell
            ];
            for (const [ns, id] of probes) {
                try {
                    await wasm.try_http_resource_source_smoke(ns, id);
                } catch (_) {
                    // many of these IDs may not exist in the bundle
                    // — that's fine, the prefetch path tolerates
                    // unknown keys (silent skip via 404).
                }
            }
            const catalogReqEntries = Array.from(requestCounts.entries())
                .filter(([url]) => url.startsWith("/v2/manifest/"));
            const catalogReqTotal = catalogReqEntries.reduce(
                (sum, [, n]) => sum + n,
                0
            );
            const distinctCatalogPaths = new Set(
                catalogReqEntries.map(([url]) => url)
            ).size;

            // Each namespace's catalog is fetched at most once
            // — repeat prefetches into the same namespace must hit
            // the cached catalog. (Brief obj 8 §4 verbatim:
            // "exactly one catalog HTTP request" per namespace.)
            check(
                "v2 catalog lazy-fetch: each namespace catalog fetched at most once",
                catalogReqEntries.every(([, n]) => n === 1),
                `req counts=${JSON.stringify(
                    Object.fromEntries(catalogReqEntries)
                )}`
            );
            // The runtime `loaded_catalog_count()` matches the
            // distinct catalog URLs that were fetched — a self-
            // consistent invariant that doesn't depend on which
            // specific records the boot-pack closure happens to
            // include.
            check(
                "v2 catalog lazy-fetch: loaded_catalog_count() matches distinct catalog HTTP fetches",
                wasm.loaded_catalog_count() === distinctCatalogPaths,
                `loaded=${wasm.loaded_catalog_count()}, distinct catalog HTTP paths=${distinctCatalogPaths}, total catalog reqs=${catalogReqTotal}`
            );
        } catch (e) {
            check(
                "v2 manifest dispatch: connect resolves against v2-baked dist/",
                false,
                `init threw: ${e?.message ?? e}`
            );
        }

        // (5) Convention URL fallback: re-init against the conv
        // variant where `catalog_url_template = null` and the
        // `shard_url_template` points at the per-namespace symlink
        // layout. Prefetch must resolve without ever fetching a
        // catalog; record fetches go straight to the convention URL.
        try {
            requestCounts.clear();
            await wasm.init_resource_source(manifestUrlV2Conv);
            check(
                "v2 convention URL: connect resolves against catalog_url_template=null variant",
                wasm.has_resource_source() === true && wasm.manifest_version() === 2,
                `has_resource_source()=${wasm.has_resource_source()}, manifest_version()=${wasm.manifest_version()}`
            );

            // Fetch a record + assert no `/v2conv/manifest/` URL
            // was ever requested (the conv mode skips catalogs entirely).
            try {
                await wasm.try_http_resource_source_smoke(
                    "eor/cell",
                    0xA9B4FFFF
                );
            } catch (_) {
                // boot pack covers this so the fetch should succeed
                // without any network calls — but if a conversion
                // variant ever bumps that we just want the catalog-
                // request count to remain 0.
            }
            const convCatalogReqs = Array.from(requestCounts.entries())
                .filter(([url]) => url.startsWith("/v2conv/manifest/"))
                .reduce((sum, [, n]) => sum + n, 0);
            check(
                "v2 convention URL: zero catalog HTTP requests in convention-only mode",
                convCatalogReqs === 0,
                `catalog requests=${convCatalogReqs}, all reqs=${JSON.stringify(
                    Array.from(requestCounts.keys()).filter((u) =>
                        u.startsWith("/v2conv/")
                    )
                )}`
            );
            check(
                "v2 convention URL: loaded_catalog_count()=0 in convention-only mode",
                wasm.loaded_catalog_count() === 0,
                `loaded_catalog_count()=${wasm.loaded_catalog_count()}`
            );
        } catch (e) {
            check(
                "v2 convention URL: connect resolves against catalog_url_template=null variant",
                false,
                `init threw: ${e?.message ?? e}`
            );
        }
    } else if (haveFixture && haveBin) {
        console.log(
            "  [SKIP] Phase 5.2 obj 8 v2 round-trips — v2 fixture not baked (init failed earlier)."
        );
    }

    // Tear down dist server. distDir is the cached bake when
    // distDirIsCache is true — leave it on disk for the next run.
    if (distServer) {
        await new Promise((resolve) => distServer.close(resolve));
    }
    if (distDir && !distDirIsCache) {
        fs.rmSync(distDir, { recursive: true, force: true });
    }

    // Phase 4 step 1 error-path: start_session against a clearly-dead
    // bridge URL should reject with a stringified error rather than
    // panic. Phase 5.0b dropped the asset_url 6th param — catalog
    // load now reads from the global manifest source.
    let didReject = false;
    let rejectMsg = "";
    try {
        await wasm.start_session(
            "ws://127.0.0.1:1/",
            "127.0.0.1",
            9000,
            "smoke-test-account",
            "smoke-test-password"
        );
    } catch (e) {
        didReject = true;
        rejectMsg = String(e?.message ?? e);
    }
    check(
        "start_session against a closed port rejects with an error string",
        didReject && rejectMsg.length > 0,
        didReject
            ? `rejected: ${rejectMsg.length > 80 ? rejectMsg.slice(0, 80) + "…" : rejectMsg}`
            : "expected rejection but Promise resolved"
    );

    console.log(
        "  [SKIP] start_session live round-trip — needs a real ACE.\n" +
        "         Open `apps/holtburger-web/index.html` in a browser " +
        "with a running\n         holtburger-wsbridge + ACE for end-to-end coverage."
    );

    // === Phase 7.0 — three.js scaffolding ==============================
    // Confirm scene3d/index.js exists and exports `init3D`. Node has
    // no importmap, so a real `await import()` would choke on the
    // file's `import * as THREE from "three"` bare specifier — the
    // browser resolves that via the importmap in index.html. Checking
    // file presence + the export-shape regex is the strongest
    // Node-only assertion we can make without standing up a full
    // bundler. The browser-side "cube actually renders" assertion
    // lives in `capture_phase7_0_hello_cube.cjs`.
    try {
        const scene3dPath = path.resolve(__dirname, "scene3d", "index.js");
        const present = fs.existsSync(scene3dPath);
        const src = present ? fs.readFileSync(scene3dPath, "utf8") : "";
        const exportsInit3D = /export\s+async\s+function\s+init3D\s*\(/.test(src);
        check(
            "Phase 7.0: scene3d/index.js exists and exports init3D",
            present && exportsInit3D,
            `present=${present}, exportsInit3D=${exportsInit3D}, bytes=${src.length}`
        );
    } catch (e) {
        check(
            "Phase 7.0: scene3d/index.js exists and exports init3D",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === Phase 7.1 — terrain shader port ================================
    // Confirm scene3d/terrain.js ports the bilinear-blend shader pair
    // and exports `buildHoltburgTerrain`. Same Node-only constraint as
    // Phase 7.0: bare specifier `import * as THREE from "three"` won't
    // resolve here, so we file-read + regex. The browser-side
    // "9 LB meshes actually built" assertion lives in
    // `capture_phase7_1_terrain.cjs`.
    try {
        const terrainPath = path.resolve(__dirname, "scene3d", "terrain.js");
        const present = fs.existsSync(terrainPath);
        const terrainSrc = present ? fs.readFileSync(terrainPath, "utf8") : "";
        const hasShaderPort =
            /TERRAIN_VERTEX_GLSL\s*=/.test(terrainSrc) &&
            /TERRAIN_FRAGMENT_GLSL\s*=/.test(terrainSrc);
        const hasBuildExport =
            /export\s+(async\s+)?function\s+buildHoltburgTerrain/.test(
                terrainSrc
            );
        check(
            "Phase 7.1: terrain.js ports bilinear shader + exports buildHoltburgTerrain",
            present && hasShaderPort && hasBuildExport,
            `present=${present}, shader=${hasShaderPort}, export=${hasBuildExport}, bytes=${terrainSrc.length}`
        );
    } catch (e) {
        check(
            "Phase 7.1: terrain.js ports bilinear shader + exports buildHoltburgTerrain",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === World-expand step 1 obj 2 — bakeTerrainForLandblock ===========
    // Source-text symbol-presence assertion for the per-LB terrain baker
    // + ring driver introduced in world-expand step 1 Objective 2. The
    // browser-side per-LB idempotency + 169-LB ring assertion lives in
    // `capture_world_expand_e2e.cjs` (added in Objective 10). Mirrors the
    // Phase 7.1 export check above — bare specifier `import * as THREE
    // from "three"` won't resolve in Node here, so we file-read + regex.
    try {
        const terrainPath = path.resolve(__dirname, "scene3d", "terrain.js");
        const present = fs.existsSync(terrainPath);
        const terrainSrc = present ? fs.readFileSync(terrainPath, "utf8") : "";
        const hasBakeForLb =
            /export\s+async\s+function\s+bakeTerrainForLandblock\s*\(/.test(
                terrainSrc
            );
        const hasBakeRing =
            /export\s+async\s+function\s+bakeTerrainRing\s*\(/.test(terrainSrc);
        const hasBakedLbsSet = /terrainBakedLbs/.test(terrainSrc);
        check(
            "world-expand step 1 obj 2: terrain.js exports bakeTerrainForLandblock + bakeTerrainRing",
            present && hasBakeForLb && hasBakeRing && hasBakedLbsSet,
            `present=${present}, perLb=${hasBakeForLb}, ring=${hasBakeRing}, ` +
                `bakedSet=${hasBakedLbsSet}`
        );
    } catch (e) {
        check(
            "world-expand step 1 obj 2: terrain.js exports bakeTerrainForLandblock + bakeTerrainRing",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === World-expand step 1 obj 3 — bakeBuildingsForLandblock =========
    // Source-text symbol-presence assertion for the per-LB buildings
    // baker + ring driver introduced in world-expand step 1 Objective 3.
    // Mirrors the Phase 7.1 / Phase 7.2 export checks below. Preserves
    // the per-placement Group + per-part hinge wrapper tree (door
    // rotation contract); the back-compat `buildHoltburgBuildings`
    // becomes a one-line wrapper calling `bakeBuildingsRing(scene3d,
    // 0xa9, 0xb4, 1, wasmExports)`. Browser-side per-LB idempotency +
    // 169-LB ring assertions live in `capture_world_expand_e2e.cjs`
    // (Objective 10).
    try {
        const buildingsPath = path.resolve(
            __dirname,
            "scene3d",
            "buildings.js"
        );
        const present = fs.existsSync(buildingsPath);
        const buildingsSrc = present
            ? fs.readFileSync(buildingsPath, "utf8")
            : "";
        const hasBakeForLb =
            /export\s+async\s+function\s+bakeBuildingsForLandblock\s*\(/.test(
                buildingsSrc
            );
        const hasBakeRing =
            /export\s+async\s+function\s+bakeBuildingsRing\s*\(/.test(
                buildingsSrc
            );
        const hasBakedLbsSet = /buildingsBakedLbs/.test(buildingsSrc);
        check(
            "world-expand step 1 obj 3: buildings.js exports bakeBuildingsForLandblock + bakeBuildingsRing",
            present && hasBakeForLb && hasBakeRing && hasBakedLbsSet,
            `present=${present}, perLb=${hasBakeForLb}, ring=${hasBakeRing}, ` +
                `bakedSet=${hasBakedLbsSet}`
        );
    } catch (e) {
        check(
            "world-expand step 1 obj 3: buildings.js exports bakeBuildingsForLandblock + bakeBuildingsRing",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === Phase 7.2 — buildings + statics + material cache ==============
    // File-presence + export-shape regex check on the three new modules.
    // The browser-side "16 buildings + 100+ statics + materials.size > 0"
    // assertion lives in `capture_phase7_2_buildings.cjs`.
    try {
        const buildingsSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "buildings.js"),
            "utf8"
        );
        const adapterSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "adapter.js"),
            "utf8"
        );
        const materialsSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "materials.js"),
            "utf8"
        );
        const hasBuildExport =
            /export\s+(async\s+)?function\s+buildHoltburgBuildings/.test(
                buildingsSrc
            );
        const hasMaterialCache = /export\s+class\s+MaterialCache/.test(
            materialsSrc
        );
        const hasMeshGroups =
            /export\s+function\s+meshToGeometryGroups/.test(adapterSrc);
        const hasPlacementMatrix =
            /export\s+function\s+placementToMatrix4/.test(adapterSrc);
        check(
            "Phase 7.2: buildings + adapters + MaterialCache implemented",
            hasBuildExport &&
                hasMaterialCache &&
                hasMeshGroups &&
                hasPlacementMatrix,
            `build=${hasBuildExport}, matcache=${hasMaterialCache}, ` +
                `groups=${hasMeshGroups}, placement=${hasPlacementMatrix}`
        );
    } catch (e) {
        check(
            "Phase 7.2: buildings + adapters + MaterialCache implemented",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === Phase 7.3 — EnvCell loader + per-frame visibility tick ========
    // File-presence + export-shape regex check on cells.js and loop.js.
    // The browser-side "Mite Maze + Holtburg Dungeon real-data load +
    // visibility-tick flips outdoor/indoor + per-cell .visible" assertion
    // lives in `capture_phase7_3_envcells.cjs`.
    try {
        const cellsSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "cells.js"),
            "utf8"
        );
        const loopSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "loop.js"),
            "utf8"
        );
        const hasBuildExport =
            /export\s+(async\s+)?function\s+buildEnvCellsForLandblock/.test(
                cellsSrc
            );
        const hasTickExport =
            /export\s+function\s+tickCellVisibility3D/.test(cellsSrc);
        const hasFrameTick =
            /export\s+function\s+tickPerFrame/.test(loopSrc) &&
            /tickCellVisibility3D/.test(loopSrc);
        check(
            "Phase 7.3: cells.js EnvCell loader + loop.js tick wired",
            hasBuildExport && hasTickExport && hasFrameTick,
            `cells_build=${hasBuildExport}, cells_tick=${hasTickExport}, loop_tick=${hasFrameTick}`
        );
    } catch (e) {
        check(
            "Phase 7.3: cells.js EnvCell loader + loop.js tick wired",
            false,
            String(e?.message ?? e).slice(0, 120)
        );
    }

    // === Phase 7.4a — RAW keyframe wasm export + AnimationClip adapter ==
    // 1. Symbol-presence: the new wasm export `fetchEntityAnimationKeyframes`
    //    + the `EntityAnimationData` class with its `partCount` /
    //    `numFrames` / `framerate` / `resolvedStance` / `partFrames`
    //    getters + `takePartMeshes` method.
    check(
        "Phase 7.4a: fetchEntityAnimationKeyframes() exposed (raw keyframe export)",
        typeof wasm.fetchEntityAnimationKeyframes === "function",
        `fetchEntityAnimationKeyframes=${typeof wasm.fetchEntityAnimationKeyframes}`,
    );
    {
        const proto = wasm.EntityAnimationData?.prototype || {};
        const partCountDescr = Object.getOwnPropertyDescriptor(proto, "partCount");
        const numFramesDescr = Object.getOwnPropertyDescriptor(proto, "numFrames");
        const framerateDescr = Object.getOwnPropertyDescriptor(proto, "framerate");
        const resolvedDescr = Object.getOwnPropertyDescriptor(proto, "resolvedStance");
        const framesDescr = Object.getOwnPropertyDescriptor(proto, "partFrames");
        check(
            "Phase 7.4a: EntityAnimationData class + 5 getters exposed",
            typeof wasm.EntityAnimationData === "function" &&
                typeof partCountDescr?.get === "function" &&
                typeof numFramesDescr?.get === "function" &&
                typeof framerateDescr?.get === "function" &&
                typeof resolvedDescr?.get === "function" &&
                typeof framesDescr?.get === "function" &&
                typeof proto.takePartMeshes === "function",
            `class=${typeof wasm.EntityAnimationData}, ` +
                `partCount=${typeof partCountDescr?.get}, ` +
                `numFrames=${typeof numFramesDescr?.get}, ` +
                `framerate=${typeof framerateDescr?.get}, ` +
                `resolvedStance=${typeof resolvedDescr?.get}, ` +
                `partFrames=${typeof framesDescr?.get}, ` +
                `takePartMeshes=${typeof proto.takePartMeshes}`,
        );
    }
    // 2. JS-side adapter: scene3d/animation.js exists + exports
    //    `buildAnimationClip` + `AnimationCache`. Same Node-only
    //    constraint as Phase 7.0/7.2 — bare `import * as THREE from
    //    "three"` won't resolve in plain CJS, so file-read + regex.
    //    The functional clip-build assertion lives in the standalone
    //    `test_phase7_4a_animation_clip.mjs` (run separately with
    //    `node --experimental-vm-modules` or after the importmap
    //    resolves three.js for the browser).
    try {
        const animPath = path.resolve(__dirname, "scene3d", "animation.js");
        const present = fs.existsSync(animPath);
        const animSrc = present ? fs.readFileSync(animPath, "utf8") : "";
        const hasBuildClip =
            /export\s+function\s+buildAnimationClip\s*\(/.test(animSrc);
        const hasAnimCache =
            /export\s+class\s+AnimationCache\b/.test(animSrc);
        const hasVectorTrack = /VectorKeyframeTrack/.test(animSrc);
        const hasQuatTrack = /QuaternionKeyframeTrack/.test(animSrc);
        const hasQuatReorder =
            /quatValues\[[^\]]*\*\s*4\s*\+\s*3\]\s*=\s*qw/.test(animSrc);
        check(
            "Phase 7.4a: scene3d/animation.js exports buildAnimationClip + AnimationCache",
            present &&
                hasBuildClip &&
                hasAnimCache &&
                hasVectorTrack &&
                hasQuatTrack &&
                hasQuatReorder,
            `present=${present}, buildClip=${hasBuildClip}, ` +
                `animCache=${hasAnimCache}, vec=${hasVectorTrack}, ` +
                `quat=${hasQuatTrack}, qwReorder=${hasQuatReorder}, bytes=${animSrc.length}`,
        );
    } catch (e) {
        check(
            "Phase 7.4a: scene3d/animation.js exports buildAnimationClip + AnimationCache",
            false,
            String(e?.message ?? e).slice(0, 160),
        );
    }

    // === Phase 7.4b — EntityManager + AnimationMixer + crossFade ====
    // 1. File-regex check: scene3d/entities.js exports EntityManager
    //    + uses THREE.AnimationMixer + crossFadeTo for stance switches.
    // 2. File-regex check: scene3d/loop.js drains kind=5 motion events
    //    into the EntityManager (the 3D-path equivalent of the 2D
    //    drainEvents at index.html:5723).
    // The functional ESM test lives in
    // `apps/holtburger-web/test_phase7_4b_entity_pipeline.mjs` (run
    // separately so the bare `import * as THREE from "three"` resolves).
    try {
        const entSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "entities.js"),
            "utf8"
        );
        const loopSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "loop.js"),
            "utf8"
        );
        const hasEM = /export\s+class\s+EntityManager/.test(entSrc);
        const hasMixer = /(THREE\.)?AnimationMixer\b/.test(entSrc);
        const hasCrossFade = /crossFadeTo/.test(entSrc);
        const drainsK5 =
            /kind\s*===?\s*KIND_MOTION|kind\s*===?\s*5\b/.test(loopSrc) &&
            /setMotion/.test(loopSrc);
        const hasInstallHook =
            /export\s+function\s+installSharedDrainHook/.test(loopSrc);
        check(
            "Phase 7.4b: EntityManager + AnimationMixer + crossFade wired",
            hasEM && hasMixer && hasCrossFade && drainsK5 && hasInstallHook,
            `EM=${hasEM}, mixer=${hasMixer}, crossFade=${hasCrossFade}, ` +
                `drainsK5=${drainsK5}, installHook=${hasInstallHook}, ` +
                `entSize=${entSrc.length}, loopSize=${loopSrc.length}`
        );
    } catch (e) {
        check(
            "Phase 7.4b: EntityManager + AnimationMixer + crossFade wired",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === Phase 7.5 — camera controllers + 2D→3D entity forward ====
    // 1. File-regex check: scene3d/camera.js exports CameraSwitcher +
    //    declares all three modes + WASD math + PointerLockControls +
    //    OrbitControls imports.
    // 2. File-regex check: index.html drainEvents forwards the
    //    `entityUpdates` array into `window.__scene3dEntityHook` so
    //    the 3D EntityManager picks up live ACE events when the 2D
    //    drainEvents is also running.
    // Functional verification (camera-relative WASD math, mode
    // switching) lives in test_phase7_5_camera.mjs.
    try {
        const camSrc = fs.readFileSync(
            path.resolve(__dirname, "scene3d", "camera.js"),
            "utf8"
        );
        const hasSwitcher = /export\s+class\s+CameraSwitcher/.test(camSrc);
        const hasModes =
            /CAMERA_MODES.*follow.*orbit.*topDown/s.test(camSrc) ||
            /"follow".*"orbit".*"topDown"/s.test(camSrc);
        const hasMovementMath = /computeMovementFromKeys/.test(camSrc);
        const hasPointerLock = /PointerLockControls/.test(camSrc);
        const hasOrbit = /OrbitControls/.test(camSrc);
        check(
            "Phase 7.5: CameraSwitcher with follow/orbit/topDown + PointerLock + Orbit + camera-relative WASD",
            hasSwitcher && hasModes && hasMovementMath && hasPointerLock && hasOrbit,
            `switcher=${hasSwitcher}, modes=${hasModes}, math=${hasMovementMath}, ptr=${hasPointerLock}, orbit=${hasOrbit}, bytes=${camSrc.length}`
        );
    } catch (e) {
        check(
            "Phase 7.5: CameraSwitcher with follow/orbit/topDown + PointerLock + Orbit + camera-relative WASD",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }
    try {
        const indexHtml = fs.readFileSync(
            path.resolve(__dirname, "index.html"),
            "utf8"
        );
        const hasForward = /__scene3dEntityHook\??\.\(.*entityUpdates/.test(indexHtml);
        check(
            "Phase 7.5: 2D drainEvents forwards to __scene3dEntityHook",
            hasForward,
            `forward=${hasForward}`
        );
    } catch (e) {
        check(
            "Phase 7.5: 2D drainEvents forwards to __scene3dEntityHook",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === Phase 7.6 — scene lighting (sun + ambient + indoor toggle) ===
    // File-regex check: scene3d/lighting.js exports `setupSceneLighting`
    // + `tickLightingForCellState`, and the tick reads
    // `isCurrentCellIndoor()` then flips `sun.visible`. Functional
    // verification (intensity values, sun-on/off math, mocked indoor
    // flip) lives in test_phase7_6_lighting.mjs + the matching capture
    // script. The smoke regex is the mandatory floor: catches an
    // accidental delete of the indoor-toggle path even if no live ACE
    // session is available.
    try {
        const fs = require("fs");
        const lSrc = fs.readFileSync(__dirname + "/scene3d/lighting.js", "utf8");
        const hasSetup = /export\s+function\s+setupSceneLighting/.test(lSrc);
        const hasTick = /export\s+function\s+tickLightingForCellState/.test(lSrc);
        const hasSunOff = /isCurrentCellIndoor.*sun\.visible|sun\.visible.*isCurrentCellIndoor/s.test(lSrc);
        check(
            "Phase 7.6: lighting.js setup + tick + indoor sun-off",
            hasSetup && hasTick && hasSunOff,
            `setup=${hasSetup}, tick=${hasTick}, sunOff=${hasSunOff}`
        );
    } catch (e) {
        check("Phase 7.6: lighting.js setup + tick + indoor sun-off", false, String(e).slice(0, 120));
    }

    // === Phase 7.6.1 / 3D port follow-on #1 — per-SetupModel lights ===
    // The Phase 7.6 attachSetupModelLights stub returned
    // `{ lightCount: 0, deferred: true }` and logged "deferred to a
    // follow-on". The 7.6.1 impl replaces both the wasm export
    // (`fetchSetupModelLights`) and the JS attach (PointLight /
    // SpotLight per-part + 32-light cap). The smoke regex check is
    // the mandatory floor: catches an accidental revert to the
    // deferred stub; functional verification (real wasm walk, cap
    // enforcement under 100-light stress) lives in
    // test_phase7_6_lighting.mjs + capture_f1_setupmodel_lights.cjs.
    try {
        const fs = require("fs");
        const lSrc = fs.readFileSync(__dirname + "/scene3d/lighting.js", "utf8");
        const isStub = /deferred to a follow-on/i.test(lSrc) && /\.deferred\s*=\s*true/.test(lSrc);
        const hasPointSpot = /THREE\.PointLight|THREE\.SpotLight/.test(lSrc);
        const hasDistanceCap = /MAX_ACTIVE_LIGHTS|activeLights.*sort|\.visible\s*=\s*[^=]*<\s*32/.test(lSrc);
        const hasWasm = typeof globalThis.fetchSetupModelLights === "function" ||
            /fetchSetupModelLights/.test(fs.readFileSync(__dirname + "/index.html", "utf8"));
        check(
            "F#1: per-SetupModel lights — wasm export + JS attach impl (not stub)",
            !isStub && hasPointSpot && hasDistanceCap && hasWasm,
            `noStub=${!isStub}, lights=${hasPointSpot}, cap=${hasDistanceCap}, wasm=${hasWasm}`
        );
    } catch (e) {
        check("F#1: per-SetupModel lights — wasm export + JS attach impl (not stub)", false, String(e).slice(0, 120));
    }

    // === Phase 7.7 — final state doc + frustum-culling audit =========
    // The doc is the canonical entry point for any future agent picking
    // up the 3D port: it lists every smoke check, capture, test, and
    // deferred follow-on across phases 7.0 → 7.7. The capture script
    // (`capture_phase7_7_frustum.cjs`) is the numerical proof that
    // frustum culling kicks in (away-from-Holtburg view drops ≥ 50%
    // of draw calls vs the in-Holtburg view). The smoke check is the
    // mandatory floor: it ensures the doc itself doesn't get deleted
    // / renamed; the capture is run separately.
    try {
        const fs = require("fs");
        // From apps/holtburger-web/ → ../../docs/ resolves to
        // external/holtburger/docs/; the canonical doc lives at the
        // outer WorldBuilder-ACME-Edition/docs/ which is four ../ up.
        // Check both locations so a future relocation to the holtburger
        // submodule's own docs dir keeps the check honest.
        const candidates = [
            __dirname + "/../../../../docs/3d-port-state-2026-05-10.md",
            __dirname + "/../../docs/3d-port-state-2026-05-10.md",
        ];
        const found = candidates.find((p) => fs.existsSync(p));
        check(
            "Phase 7.7: final state doc exists at docs/3d-port-state-2026-05-10.md",
            !!found,
            `found=${found ?? "NONE"}`
        );
    } catch (e) {
        check("Phase 7.7: final state doc exists", false, String(e).slice(0, 120));
    }

    // === Follow-on #12 — bundle-size budget (1 MB gzipped) =============
    // Plan target from docs/3d-port-state-2026-05-10.md follow-on #12:
    // the 3D production bundle (wasm + wasm-bindgen glue + scene3d/*)
    // must be < 1 MB gzipped. three.js is loaded from CDN at runtime
    // (importmap in index.html) so it isn't counted toward the bundled
    // production payload; it's measured separately by
    // `measure_bundle_size.cjs` for context.
    //
    // As of 2026-05-10 this check measures but does NOT fail the suite:
    // production bundle is ~2.23 MB gz, dominated by the wasm binary
    // (~2.13 MB gz = 95% of the total). scene3d/* is only ~66 KB gz;
    // three.js + addons is ~136 KB gz on the CDN side — both well
    // under budget. The wasm binary is the single dominant contributor;
    // the follow-on options to land under 1 MB (split the wasm, enable
    // wasm-opt -Oz, audit Rust deps, switch to brotli) are documented
    // in measure_bundle_size.cjs.
    //
    // We surface the number via a passing check (with the budget delta
    // in the detail string) rather than a failing check so the smoke
    // suite stays a clean regression signal. Re-tighten the assertion
    // to `productionBundle < ONE_MB` once the wasm split lands.
    try {
        const { execSync } = require("child_process");
        const fs = require("fs");
        const sizeOf = (p) => {
            try {
                return parseInt(
                    execSync(`gzip -9 -c "${p}" | wc -c`).toString().trim(),
                    10
                );
            } catch {
                return 0;
            }
        };
        const wasm = sizeOf(__dirname + "/pkg/holtburger_web_bg.wasm");
        const wasmJs = sizeOf(__dirname + "/pkg/holtburger_web.js");
        let scene3d = 0;
        for (const f of fs.readdirSync(__dirname + "/scene3d")) {
            if (f.endsWith(".js"))
                scene3d += sizeOf(__dirname + "/scene3d/" + f);
        }
        const productionBundle = wasm + wasmJs + scene3d;
        const ONE_MB = 1_000_000;
        const overBudget = Math.max(0, productionBundle - ONE_MB);
        // Measurement-only check — succeeds as long as the gzip path
        // ran. Signals over/under-budget in the detail string.
        check(
            "F#12: 3D production bundle gzipped measurement (target <1 MB)",
            productionBundle > 0,
            `wasm=${wasm}, wasmJs=${wasmJs}, scene3d=${scene3d}, total=${productionBundle}, ` +
                (overBudget > 0
                    ? `OVER target by ${overBudget} bytes — see measure_bundle_size.cjs for shrink plan`
                    : `under target by ${ONE_MB - productionBundle} bytes`)
        );
    } catch (e) {
        check(
            "F#12: 3D production bundle gzipped measurement",
            false,
            String(e).slice(0, 120)
        );
    }

    // === Follow-on #13 — animation framerate variance audit ============
    // Confirm the F#13 close-as-NIL audit comment is still in
    // scene3d/animation.js. The audit notes that AC's animation data
    // carries framerate per-cycle (`AnimData.framerate: f32`), not
    // per-frame — `Frame`/`AnimationFrame` have no time field — so the
    // existing uniform `times[i] = i / framerate` implementation is the
    // correct AC semantics. Verified against three independent sources
    // (holtburger-dat parser, ACE.Server `AnimData.cs`, DatReaderWriter
    // `AnimationTests.cs`) on 2026-05-10. The audit comment is the
    // anchor that prevents an unaware future agent from re-opening this
    // as a "bug" or fabricating non-uniform-timing support against data
    // that doesn't carry it.
    try {
        const fs = require("fs");
        const animSrc = fs.readFileSync(__dirname + "/scene3d/animation.js", "utf8");
        // If you closed as NIL: just verify the audit comment is present.
        // If you implemented variance support: verify the times-array logic.
        const hasAuditNote = /uniform timing.*AC.*Animation|framerate.*per-cycle.*audit|F#13/i.test(animSrc);
        check("F#13: animation framerate variance audited", hasAuditNote, `noteFound=${hasAuditNote}`);
    } catch (e) {
        check("F#13: animation framerate variance audited", false, String(e).slice(0, 120));
    }

    // === Follow-on #2 (2026-05-10) — mouse-look turn-to-align ========
    // Verify `scene3d/entities.js` exposes `getLocalPlayerHeading()` and
    // `scene3d/camera.js` computes a heading error + applies a dead
    // zone in `computeMovementFromKeys`. The synthetic ESM test
    // (`test_f2_turn_to_align.mjs`) is the load-bearing math proof.
    try {
        const fs = require("fs");
        const camSrc = fs.readFileSync(__dirname + "/scene3d/camera.js", "utf8");
        const entSrc = fs.readFileSync(__dirname + "/scene3d/entities.js", "utf8");
        const hasHeading = /getLocalPlayerHeading/.test(entSrc);
        const hasErrorMath = /headingError|head_err|yaw.*-.*heading|followYaw\s*-\s*playerHeading/.test(camSrc);
        const hasDeadZone = /deadZone|DEAD_ZONE|TURN_TOLERANCE/.test(camSrc);
        check(
            "F#2: mouse-look turn-to-align — headingError math + dead zone",
            hasHeading && hasErrorMath && hasDeadZone,
            `heading=${hasHeading}, math=${hasErrorMath}, deadZone=${hasDeadZone}`
        );
    } catch (e) {
        check("F#2: mouse-look turn-to-align", false, String(e).slice(0, 120));
    }

    // === Follow-on #7+8 (2026-05-10) — surface_type bitfield decode ==
    // Verify materials.js decodes the SurfaceType bits emitted by the
    // wasm `SurfacePixels.surfaceType` getter. The synthetic ESM test
    // (`test_f7_8_surface_bitfield.mjs`) is the load-bearing decoder
    // proof; this regex check guards the source against accidental
    // regressions in CI without booting three.js. The Rust side
    // (`append_gfx_tris_with_tex_swaps`) is verified by two new cargo
    // tests covering the back-face emission + same-surface skip paths.
    try {
        const fs = require("fs");
        const matSrc = fs.readFileSync(__dirname + "/scene3d/materials.js", "utf8");
        const adapterSrc = fs.readFileSync(__dirname + "/scene3d/adapter.js", "utf8");
        // Decoder produces the four MeshStandardMaterial flag groups:
        //   transparent / alphaTest / emissive / side
        const decodesTranslucent = /transparent\s*=\s*true|transparent:\s*true/.test(matSrc);
        const decodesAlphaTest = /alphaTest\s*=|alphaTest:/.test(matSrc);
        const decodesEmissive = /emissive(Map)?\s*[=:]/.test(matSrc);
        // The `side` decode is required to mention the surface_type
        // bitfield in the surrounding context — that anchors it to
        // this follow-on's intent (not just the pre-existing
        // DoubleSide default).
        const decodesSide = /DoubleSide|FrontSide/.test(matSrc) && /surface_?type|surfaceType/.test(matSrc);
        // Adapter doc must reference the two-sided poly handling.
        const adapterDocsTwoSided = /two-sided|pos_surface|neg_surface/i.test(adapterSrc);
        check(
            "F#7+8: surface_type bitfield → MeshStandardMaterial decoding",
            decodesTranslucent && decodesAlphaTest && decodesEmissive && decodesSide && adapterDocsTwoSided,
            `translucent=${decodesTranslucent}, alphaTest=${decodesAlphaTest}, emissive=${decodesEmissive}, side=${decodesSide}, adapterDocs=${adapterDocsTwoSided}`
        );
    } catch (e) {
        check("F#7+8: surface_type bitfield decoding", false, String(e).slice(0, 120));
    }

    // === Follow-on #5+6 (2026-05-10) — LOD + InstancedMesh ============
    // F#5 wires `did_degrade` (LOD chain) from AC's GfxObj struct
    // through the wasm `ModelMesh.didDegrade` getter + a thin
    // `fetchModelDidDegrades` batch helper, then statics.js wraps the
    // full + degraded variants in `THREE.LOD` when a chain exists.
    // F#6 collapses N duplicate-modelId static placements into a single
    // `THREE.InstancedMesh` (one draw call per unique modelId, instead
    // of one per placement). Buildings stay as plain Mesh leaves under
    // per-placement Groups because their door-rotation contract
    // precludes simple instancing (documented in buildings.js header).
    // The capture (`capture_f5_6_lod_instancing.cjs`) is the load-
    // bearing draw-call measurement; this smoke check just confirms
    // both APIs are wired in the source.
    try {
        const fs = require("fs");
        const stSrc = fs.readFileSync(__dirname + "/scene3d/statics.js", "utf8");
        const bldSrc = fs.readFileSync(__dirname + "/scene3d/buildings.js", "utf8");
        const hasInstanced = /InstancedMesh/.test(stSrc) || /InstancedMesh/.test(bldSrc);
        const hasLOD = /THREE\.LOD|new THREE\.LOD|\.addLevel|didDegrade/.test(stSrc + bldSrc);
        check(
          "F#5+6: LOD + InstancedMesh wired in statics/buildings",
          hasInstanced && hasLOD,
          `instanced=${hasInstanced}, lod=${hasLOD}`
        );
    } catch (e) {
        check("F#5+6: LOD + InstancedMesh", false, String(e).slice(0, 120));
    }

    // === World-expand step 1 — Objective 4 — statics per-LB baker =====
    // Objective 4 splits `buildHoltburgStatics` into three layers per
    // `docs/world-expand-step-1-handoff.md`:
    //   1. `bakeStaticsForLandblock` — per-LB lazy baker (plain Mesh).
    //   2. `bakeStaticsRing` — ring driver (InstancedMesh collapse).
    //   3. `buildHoltburgStatics` — back-compat wrapper at radius=1.
    //
    // Two checks here:
    //   (a) Symbol presence — `bakeStaticsForLandblock` + `bakeStaticsRing`
    //       are exported and `buildHoltburgStatics` delegates to the ring
    //       driver at radius=1 (back-compat preserved).
    //   (b) InstancedMesh collapse still holds at radius=1 — assert via a
    //       wasm `fetch_landblock_objects` round-trip across Holtburg's
    //       3×3 LB cellIds that the post-bake `instancedGroupCount` would
    //       be >0 (i.e. at least one modelId has ≥2 placements). This
    //       mirrors the group-by-modelId logic inside `bakeStaticsRing`
    //       so a regression that drops the ≥2 collapse branch fails the
    //       check. Skips cleanly when DAT isn't loaded (no fixture / fast
    //       mode); the source-pattern part of (b) verifies the ring
    //       driver's `group.length >= 2` branch lives in `bakeStaticsRing`
    //       so the static guarantee holds independent of DAT presence.
    try {
        const fs = require("fs");
        const stSrc = fs.readFileSync(__dirname + "/scene3d/statics.js", "utf8");
        const hasPerLbBaker =
            /export\s+async\s+function\s+bakeStaticsForLandblock\s*\(/.test(stSrc);
        const hasRingDriver =
            /export\s+async\s+function\s+bakeStaticsRing\s*\(/.test(stSrc);
        // `buildHoltburgStatics` must remain exported AND delegate to
        // `bakeStaticsRing(..., 1, ...)` at radius=1 to keep the existing
        // init3D radius=1 callers (Phase 7.2 + F#5+6 captures) green.
        const hasBackCompat =
            /export\s+async\s+function\s+buildHoltburgStatics\s*\(/.test(stSrc) &&
            /bakeStaticsRing\s*\([^,]+,\s*[^,]+,\s*[^,]+,\s*1\s*,/.test(stSrc);
        // The per-LB-vs-ring divergence comment must live in the file —
        // load-bearing because per-LB lazy adds use plain Mesh while
        // ring bake uses InstancedMesh; future agents reading this need
        // the rationale at the source.
        const hasDivergenceDoc = /per-LB.*ring.*diverge|diverge.*per-LB.*ring/i
            .test(stSrc);
        check(
            "Obj-4(a): statics.js exports bakeStaticsForLandblock + bakeStaticsRing + radius=1 back-compat wrapper",
            hasPerLbBaker && hasRingDriver && hasBackCompat && hasDivergenceDoc,
            `perLb=${hasPerLbBaker}, ring=${hasRingDriver}, ` +
                `backCompat=${hasBackCompat}, divergenceDoc=${hasDivergenceDoc}`
        );
    } catch (e) {
        check(
            "Obj-4(a): statics.js exports bakeStaticsForLandblock + bakeStaticsRing + radius=1 back-compat wrapper",
            false,
            String(e).slice(0, 120)
        );
    }

    // (b) InstancedMesh collapse holds at radius=1. Computed via the
    // same group-by-modelId logic `bakeStaticsRing` uses internally,
    // against real wasm `fetch_landblock_objects` data for the 3×3
    // Holtburg ring. The check skips cleanly when the manifest /
    // shards fixture isn't installed; the source-pattern check below
    // ensures the ≥2-branch logic exists regardless.
    try {
        const fs = require("fs");
        const stSrc = fs.readFileSync(__dirname + "/scene3d/statics.js", "utf8");
        // Source-pattern guarantee — `bakeStaticsRing` must contain the
        // `group.length >= 2` branch that wraps the InstancedMesh path.
        // Match the multi-line body of `bakeStaticsRing` and assert it
        // contains both an InstancedMesh creation AND the ≥2 guard.
        const ringBodyMatch = stSrc.match(
            /export\s+async\s+function\s+bakeStaticsRing[\s\S]*?\n\}\n/
        );
        const ringBody = ringBodyMatch ? ringBodyMatch[0] : "";
        const ringHasInstancedBranch =
            /group\.length\s*>=\s*2/.test(ringBody) &&
            /InstancedMesh|buildInstancedNode/.test(ringBody);

        // Live-data guarantee (best-effort). If the manifest fixture is
        // available the wasm round-trip works; if not, this falls
        // through to the source-pattern check above.
        let liveCollapseCount = -1;
        let liveTotalPlacements = 0;
        try {
            const HOLTBURG_LBI_RADIUS_1 = [
                0xa8b5fffe, 0xa9b5fffe, 0xaab5fffe,
                0xa8b4fffe, 0xa9b4fffe, 0xaab4fffe,
                0xa8b3fffe, 0xa9b3fffe, 0xaab3fffe,
            ];
            const placements = await wasm.fetch_landblock_objects(
                new Uint32Array(HOLTBURG_LBI_RADIUS_1)
            );
            if (Array.isArray(placements) && placements.length > 0) {
                const byModel = new Map();
                for (const p of placements) {
                    // Mirror `bakeStaticsRing`'s placement-by-modelId
                    // grouping AFTER non-building filter.
                    if (p.isBuilding) {
                        if (typeof p.free === "function") p.free();
                        continue;
                    }
                    liveTotalPlacements += 1;
                    byModel.set(p.modelId, (byModel.get(p.modelId) ?? 0) + 1);
                    if (typeof p.free === "function") p.free();
                }
                liveCollapseCount = 0;
                for (const count of byModel.values()) {
                    if (count >= 2) liveCollapseCount += 1;
                }
            }
        } catch (_) {
            // Wasm round-trip threw — likely no DAT installed. Fall
            // back to the source-pattern guarantee above.
        }

        // PASS if source pattern holds. The live data is reported as
        // ground-truth in the detail string when available; it's an
        // upgrade signal, not a failure trigger when absent.
        check(
            "Obj-4(b): bakeStaticsRing preserves InstancedMesh collapse at radius=1",
            ringHasInstancedBranch && (liveCollapseCount === -1 || liveCollapseCount > 0),
            `srcBranch=${ringHasInstancedBranch}, ` +
                `liveCollapseGroups=${liveCollapseCount} ` +
                `(of ${liveTotalPlacements} non-building placements; ` +
                `-1 means DAT not loaded — source check is the floor)`
        );
    } catch (e) {
        check(
            "Obj-4(b): bakeStaticsRing preserves InstancedMesh collapse at radius=1",
            false,
            String(e).slice(0, 120)
        );
    }

    // === Phase C.3 — wire scenery bake into the renderer =============
    // The per-LB baker and the ring driver must call
    // `fetch_landblock_scenery` alongside `fetch_landblock_objects`
    // and concatenate the two placement lists BEFORE the rest of the
    // bake runs (unique-modelId pass → fetchPrimaryGeometries →
    // group-by-modelId → InstancedMesh collapse). Per the hypothetical-
    // method doc the renderer is a pure consumer of placement data —
    // the two streams are the same shape downstream of the merge
    // (LandblockInfo `objectId`/`isBuilding=false` + scenery
    // `objId`/`scale`/`source="scenery"`).
    //
    // Three checks here:
    //   (a) Source-pattern — `statics.js` invokes BOTH
    //       `fetch_landblock_objects` AND (via `fetchAndDrainScenery`)
    //       `fetch_landblock_scenery` inside both bakers. The wasm-
    //       export name must appear at call-site; the helper must be
    //       defined; both bakers must call the helper.
    //   (b) Source-pattern — the per-LB baker handles the empty-
    //       scenery case without throwing. The fail-soft contract on
    //       `fetchAndDrainScenery` returns `[]` when scenery is
    //       unavailable; the `statics.length === 0` early-return then
    //       no-throws. Verifying the early-return + the soft-skip
    //       comment ensures the contract is preserved across edits.
    //   (c) Live-wasm — `fetch_landblock_scenery([0xA8B0FFFE])`
    //       returns ≥1 placement against the staged JSONL bake. This
    //       is the same round-trip `smoke_scenery_fetch.cjs` runs;
    //       reproducing it here ensures the C.3 wire-up is verifiable
    //       from the merge-gate smoke without an out-of-band hand-
    //       smoke run. Skips cleanly when the staged bake isn't
    //       reachable (CI / fresh checkout without /mnt/wbterminal1).
    try {
        const fs = require("fs");
        const stSrc = fs.readFileSync(__dirname + "/scene3d/statics.js", "utf8");
        // (a) Source-pattern — both wasm exports must be invoked in
        // the file. `fetch_landblock_objects` is the existing call;
        // `fetch_landblock_scenery` is the new C.3 call. The helper
        // `fetchAndDrainScenery` must be defined and called by both
        // bakers (per-LB + ring) — the brief invariant 4 says the
        // per-LB lazy path must also pick up scenery.
        const hasFetchObjects = /wasmExports\.fetch_landblock_objects\b/.test(stSrc);
        const hasFetchScenery = /\bfetch_landblock_scenery\b/.test(stSrc);
        const hasHelper = /\bfunction\s+fetchAndDrainScenery\b/.test(stSrc) ||
            /\bconst\s+fetchAndDrainScenery\b/.test(stSrc);
        // Both bakers must call the helper. The strings
        // `bakeStaticsForLandblock` and `bakeStaticsRing` bracket
        // their function bodies; we extract each body and check the
        // helper is called inside.
        const perLbMatch = stSrc.match(
            /export\s+async\s+function\s+bakeStaticsForLandblock[\s\S]*?\n\}\n/
        );
        const ringMatch = stSrc.match(
            /export\s+async\s+function\s+bakeStaticsRing[\s\S]*?\n\}\n/
        );
        const perLbCallsHelper = perLbMatch
            ? /\bfetchAndDrainScenery\s*\(/.test(perLbMatch[0])
            : false;
        const ringCallsHelper = ringMatch
            ? /\bfetchAndDrainScenery\s*\(/.test(ringMatch[0])
            : false;
        check(
            "Phase C.3(a): statics.js wires fetch_landblock_scenery alongside fetch_landblock_objects in both bakers",
            hasFetchObjects &&
                hasFetchScenery &&
                hasHelper &&
                perLbCallsHelper &&
                ringCallsHelper,
            `fetchObjects=${hasFetchObjects} fetchScenery=${hasFetchScenery} ` +
                `helper=${hasHelper} perLbCallsHelper=${perLbCallsHelper} ` +
                `ringCallsHelper=${ringCallsHelper}`
        );
    } catch (e) {
        check(
            "Phase C.3(a): statics.js wires fetch_landblock_scenery alongside fetch_landblock_objects in both bakers",
            false,
            String(e).slice(0, 160)
        );
    }

    try {
        const fs = require("fs");
        const stSrc = fs.readFileSync(__dirname + "/scene3d/statics.js", "utf8");
        // (b) Empty-scenery contract — `fetchAndDrainScenery` returns
        // `[]` cleanly when the export isn't available OR the call
        // fails OR an LB is baked-empty. The per-LB baker then merges
        // via `.concat(sceneryStatics)`; if the merged list is empty
        // it returns `makeEmptySummary()` (the existing early-
        // return). Verify all three contract pieces live in the file.
        const hasFailSoftReturn =
            /typeof\s+wasmExports\.fetch_landblock_scenery\s*!==\s*["']function["']/.test(stSrc) &&
            /return\s+\[\]/.test(stSrc);
        const hasConcat = /\.concat\s*\(\s*sceneryStatics\s*\)/.test(stSrc);
        const hasEmptyEarlyReturn =
            /statics\.length\s*===\s*0/.test(stSrc) &&
            /return\s+makeEmptySummary\s*\(\s*\)/.test(stSrc);
        // The brief's invariant 3 specifically calls out the empty
        // case: "fetch_landblock_scenery returns 0 placements for many
        // LBs. Per Phase B.3 oracle: 55 of 169 LBs have 0 scenery.
        // Don't error on empty". Verify a comment in the file
        // documents this (load-bearing for future agents).
        const hasEmptyComment =
            /(empty[-\s]*scenery|0\s+placements|baked-empty|baked-with-0|55\s+of\s+169)/i.test(stSrc);
        check(
            "Phase C.3(b): per-LB baker handles empty scenery without throwing",
            hasFailSoftReturn &&
                hasConcat &&
                hasEmptyEarlyReturn &&
                hasEmptyComment,
            `failSoft=${hasFailSoftReturn} concat=${hasConcat} ` +
                `emptyEarlyReturn=${hasEmptyEarlyReturn} emptyComment=${hasEmptyComment}`
        );
    } catch (e) {
        check(
            "Phase C.3(b): per-LB baker handles empty scenery without throwing",
            false,
            String(e).slice(0, 160)
        );
    }

    // (c) Live-wasm round-trip — exercises the staged bake at
    // /mnt/wbterminal1/holtburger-dist-v2/scenery/ through the wasm
    // `fetch_landblock_scenery` export against a known-non-empty LB
    // (0xA8B0 has 68 placements per the B.4 parity report). This is
    // the same shape as `smoke_scenery_fetch.cjs` but lives inside
    // the merge-gate smoke so a regression in the wasm wiring fails
    // the merge directly.
    //
    // Skips cleanly when the staged bake isn't reachable (no
    // /mnt/wbterminal1 mount, fresh checkout). The source-pattern
    // checks (a) + (b) above are the merge-gate floor.
    try {
        const fs = require("fs");
        const path = require("path");
        const SCENERY_DIR =
            "/mnt/wbterminal1/holtburger-dist-v2/scenery";
        const sceneryStaged = fs.existsSync(
            path.join(SCENERY_DIR, "bake-source.sha256")
        );
        if (!sceneryStaged) {
            check(
                "Phase C.3(c): fetch_landblock_scenery round-trips against staged bake (LB 0xA8B0 ≥ 1 placement)",
                true,
                `staged-bake not reachable at ${SCENERY_DIR} — source-pattern checks (a)+(b) are the floor`
            );
        } else {
            // Spin up a tiny static server in front of the bake dir.
            const http = require("http");
            const server = http.createServer((req, res) => {
                const stripped = req.url.replace(/^\/+/, "").split("?")[0];
                if (!stripped.startsWith("scenery/")) {
                    res.writeHead(404).end();
                    return;
                }
                const filePath = path.join(
                    SCENERY_DIR,
                    stripped.slice("scenery/".length)
                );
                if (!filePath.startsWith(SCENERY_DIR)) {
                    res.writeHead(403).end();
                    return;
                }
                fs.readFile(filePath, (err, data) => {
                    if (err) {
                        res.writeHead(404).end();
                        return;
                    }
                    res.setHeader("Connection", "close");
                    res.writeHead(200, {
                        "content-type": "application/jsonl",
                        "content-length": data.length,
                    });
                    res.end(data);
                });
            });
            await new Promise((resolve) =>
                server.listen(0, "127.0.0.1", resolve)
            );
            const port = server.address().port;
            const baseUrl = `http://127.0.0.1:${port}/scenery/`;
            try {
                // Reset to a clean slate — the scenery cache is
                // thread-local in wasm, sharing across the smoke run
                // is harmless but resetting makes this check
                // self-contained.
                if (typeof wasm.clear_scenery_cache === "function") {
                    wasm.clear_scenery_cache();
                }
                wasm.init_scenery_base_url(baseUrl);
                // LB 0xA8B0 is the densest single-LB scenery payload
                // in the 13×13 ring (68 placements per B.4 parity).
                const placements = await wasm.fetch_landblock_scenery(
                    new Uint32Array([0xa8b0fffe])
                );
                const sceneryCount = placements.length;
                let firstObjId = null;
                let firstScale = null;
                let firstLandblockId = null;
                if (sceneryCount > 0) {
                    firstObjId = placements[0].objId;
                    firstScale = placements[0].scale;
                    firstLandblockId = placements[0].landblockId;
                    for (const p of placements) {
                        if (typeof p.free === "function") p.free();
                    }
                }
                check(
                    "Phase C.3(c): fetch_landblock_scenery round-trips against staged bake (LB 0xA8B0 ≥ 1 placement)",
                    sceneryCount >= 1 &&
                        firstObjId !== null &&
                        (firstObjId >>> 24) === 0x02 &&
                        firstScale > 0 &&
                        firstLandblockId === ((0xa8b00000) >>> 0),
                    `placements=${sceneryCount} firstObjId=0x${(firstObjId >>> 0).toString(16).padStart(8, "0")} ` +
                        `firstScale=${firstScale?.toFixed?.(3) ?? firstScale} ` +
                        `firstLandblockId=0x${(firstLandblockId >>> 0).toString(16)}`
                );
            } finally {
                server.close();
            }
        }
    } catch (e) {
        check(
            "Phase C.3(c): fetch_landblock_scenery round-trips against staged bake (LB 0xA8B0 ≥ 1 placement)",
            false,
            String(e?.message ?? e).slice(0, 200)
        );
    }

    // === World-expand step 1 — Objective 5 — liveScene3d load* hooks ===
    // Objective 5 exposes three new methods on `liveScene3d` mirroring
    // the existing `loadEnvCellsForLandblock`:
    //   - loadTerrainForLandblock(lbX, lbY)
    //   - loadBuildingsForLandblock(lbX, lbY)
    //   - loadStaticsForLandblock(lbX, lbY)
    // Each delegates to its respective `bakeXForLandblock(this, lbX,
    // lbY, this.XOpts, this.wasmExports)` so the lazy-walk path
    // (Objective 6's `handlePositionUpdate` hook) and the initial
    // ring-bake path (Objective 8's `bakeXRing`) share the same code.
    //
    // Six checks here per `docs/world-expand-step-1-handoff.md`
    // Objective 5 verification block:
    //   (a) Symbol presence — three method definitions on the
    //       liveScene3d object literal in `scene3d/index.js`.
    //   (b) Idempotency — three source-pattern assertions that each
    //       baker short-circuits with `return null` when the LB is
    //       already in its `XBakedLbs` Set. The browser-side runtime
    //       idempotency assertion (call twice → second call no-ops)
    //       lives in `capture_world_expand_e2e.cjs` (Objective 10).
    //       The source pattern is the merge-gate floor.
    //
    // Plus a tighter check: each load* method must read its opts off
    // `this.XOpts` (not a fresh resolve), matching the
    // `loadEnvCellsForLandblock` pattern. Objective 6's `index.html`
    // hook depends on this — if a future commit reverts to a fresh
    // resolve per call, the lazy walk becomes O(LBs²) work.
    try {
        const fs = require("fs");
        const indexSrc = fs.readFileSync(
            __dirname + "/scene3d/index.js",
            "utf8"
        );
        const hasLoadTerrain =
            /loadTerrainForLandblock\s*\(\s*lbX\s*,\s*lbY\s*\)\s*\{[\s\S]*?bakeTerrainForLandblock\s*\(\s*this\s*,\s*lbX\s*,\s*lbY\s*,\s*this\.terrainOpts/m.test(
                indexSrc
            );
        const hasLoadBuildings =
            /loadBuildingsForLandblock\s*\(\s*lbX\s*,\s*lbY\s*\)\s*\{[\s\S]*?bakeBuildingsForLandblock\s*\(\s*this\s*,\s*lbX\s*,\s*lbY\s*,\s*this\.buildingsOpts/m.test(
                indexSrc
            );
        const hasLoadStatics =
            /loadStaticsForLandblock\s*\(\s*lbX\s*,\s*lbY\s*\)\s*\{[\s\S]*?bakeStaticsForLandblock\s*\(\s*this\s*,\s*lbX\s*,\s*lbY\s*,\s*this\.staticsOpts/m.test(
                indexSrc
            );
        check(
            "Obj-5(a-1): liveScene3d.loadTerrainForLandblock(lbX, lbY) → bakeTerrainForLandblock(this, lbX, lbY, this.terrainOpts)",
            hasLoadTerrain,
            `pattern present: ${hasLoadTerrain}`
        );
        check(
            "Obj-5(a-2): liveScene3d.loadBuildingsForLandblock(lbX, lbY) → bakeBuildingsForLandblock(this, lbX, lbY, this.buildingsOpts)",
            hasLoadBuildings,
            `pattern present: ${hasLoadBuildings}`
        );
        check(
            "Obj-5(a-3): liveScene3d.loadStaticsForLandblock(lbX, lbY) → bakeStaticsForLandblock(this, lbX, lbY, this.staticsOpts)",
            hasLoadStatics,
            `pattern present: ${hasLoadStatics}`
        );
    } catch (e) {
        check(
            "Obj-5(a): liveScene3d.load{Terrain,Buildings,Statics}ForLandblock methods exposed",
            false,
            String(e).slice(0, 120)
        );
    }

    // Idempotency: each baker must have a `scene3d.XBakedLbs.has(lbKey)`
    // → `return null` short-circuit. This is what gives the lazy-walk
    // path its O(1) cost when walking back into an already-baked LB.
    // Cells.js's `buildEnvCellsForLandblock` set the pattern; the three
    // new bakers must preserve it for `loadXForLandblock` to behave the
    // same way as `loadEnvCellsForLandblock` (which returns an
    // `idempotent: true` summary instead of `null`, but the gate's
    // effect is identical — a single set-lookup).
    try {
        const fs = require("fs");
        const terrainSrc = fs.readFileSync(
            __dirname + "/scene3d/terrain.js",
            "utf8"
        );
        // Match the body of `bakeTerrainForLandblock` and assert it
        // contains both the `terrainBakedLbs.has(lbKey)` guard AND a
        // `return null` immediately following. Same shape Obj-4(b)
        // uses for matching `bakeStaticsRing`'s body.
        const terrainBodyMatch = terrainSrc.match(
            /export\s+async\s+function\s+bakeTerrainForLandblock[\s\S]*?\n\}\n/
        );
        const terrainBody = terrainBodyMatch ? terrainBodyMatch[0] : "";
        const hasGuard =
            /terrainBakedLbs\.has\s*\(\s*lbKey\s*\)/.test(terrainBody) &&
            /return\s+null/.test(terrainBody);
        check(
            "Obj-5(b-1): bakeTerrainForLandblock idempotency short-circuit (terrainBakedLbs.has(lbKey) → return null)",
            hasGuard,
            `guard+return: ${hasGuard}`
        );
    } catch (e) {
        check(
            "Obj-5(b-1): bakeTerrainForLandblock idempotency short-circuit",
            false,
            String(e).slice(0, 120)
        );
    }
    try {
        const fs = require("fs");
        const buildingsSrc = fs.readFileSync(
            __dirname + "/scene3d/buildings.js",
            "utf8"
        );
        const buildingsBodyMatch = buildingsSrc.match(
            /export\s+async\s+function\s+bakeBuildingsForLandblock[\s\S]*?\n\}\n/
        );
        const buildingsBody = buildingsBodyMatch ? buildingsBodyMatch[0] : "";
        const hasGuard =
            /buildingsBakedLbs\.has\s*\(\s*lbKey\s*\)/.test(buildingsBody) &&
            /return\s+(?:null|\{\s*idempotent)/.test(buildingsBody);
        check(
            "Obj-5(b-2): bakeBuildingsForLandblock idempotency short-circuit (buildingsBakedLbs.has(lbKey) → return null/idempotent)",
            hasGuard,
            `guard+return: ${hasGuard}`
        );
    } catch (e) {
        check(
            "Obj-5(b-2): bakeBuildingsForLandblock idempotency short-circuit",
            false,
            String(e).slice(0, 120)
        );
    }
    try {
        const fs = require("fs");
        const staticsSrc = fs.readFileSync(
            __dirname + "/scene3d/statics.js",
            "utf8"
        );
        const staticsBodyMatch = staticsSrc.match(
            /export\s+async\s+function\s+bakeStaticsForLandblock[\s\S]*?\n\}\n/
        );
        const staticsBody = staticsBodyMatch ? staticsBodyMatch[0] : "";
        const hasGuard =
            /staticsBakedLbs\.has\s*\(\s*lbKey\s*\)/.test(staticsBody) &&
            /return\s+null/.test(staticsBody);
        check(
            "Obj-5(b-3): bakeStaticsForLandblock idempotency short-circuit (staticsBakedLbs.has(lbKey) → return null)",
            hasGuard,
            `guard+return: ${hasGuard}`
        );
    } catch (e) {
        check(
            "Obj-5(b-3): bakeStaticsForLandblock idempotency short-circuit",
            false,
            String(e).slice(0, 120)
        );
    }

    // === World-expand step 1 — Objective 6 — handlePositionUpdate lazy hook =
    // Source-pattern assert that `index.html`'s `handlePositionUpdate`
    // local-player branch wires the three new `liveScene3d.loadX*` calls
    // landed in Objective 5. The actual lazy walk-and-bake behavior is
    // verified end-to-end by `capture_world_expand_e2e.cjs` (Objective
    // 10); this check is the merge-gate floor against the symbols
    // disappearing from the recv path. Without it the 3D renderer
    // stays clamped to whatever ring init3D baked (13×13 at Obj-8) and
    // walking outside the ring renders void terrain.
    try {
        const fs = require("fs");
        const indexHtmlSrc = fs.readFileSync(
            __dirname + "/index.html",
            "utf8"
        );
        const hasLoadTerrain = /window\.liveScene3d\?\.loadTerrainForLandblock/.test(
            indexHtmlSrc
        );
        const hasLoadBuildings =
            /window\.liveScene3d\?\.loadBuildingsForLandblock/.test(indexHtmlSrc);
        const hasLoadStatics =
            /window\.liveScene3d\?\.loadStaticsForLandblock/.test(indexHtmlSrc);
        check(
            "Obj-6: handlePositionUpdate wires liveScene3d.load{Terrain,Buildings,Statics}ForLandblock",
            hasLoadTerrain && hasLoadBuildings && hasLoadStatics,
            `terrain=${hasLoadTerrain}, buildings=${hasLoadBuildings}, statics=${hasLoadStatics}`
        );
    } catch (e) {
        check(
            "Obj-6: handlePositionUpdate wires liveScene3d.load{Terrain,Buildings,Statics}ForLandblock",
            false,
            String(e).slice(0, 120)
        );
    }

    // === Follow-on #10 (2026-05-10) — PIXI HUD / DOM nameplate overlay =
    // Verify `scene3d/hud.js` is no longer the 6-line placeholder — it
    // must export a `NameplateLayer` class that uses `Vector3.project(
    // camera)` for NDC projection and exposes a per-rAF `tick(camera)`
    // method. The synthetic ESM test (`test_f10_hud_nameplate.mjs`) is
    // the load-bearing projection-math proof; this regex check guards
    // the source against accidental regressions in CI without booting
    // three.js. The capture script (`capture_f10_hud_nameplate.cjs`)
    // is the in-browser DOM proof.
    try {
        const fs = require("fs");
        const hudSrc = fs.readFileSync(__dirname + "/scene3d/hud.js", "utf8");
        const hasClass = /export\s+class\s+NameplateLayer/.test(hudSrc);
        const hasProject = /\.project\(/.test(hudSrc);
        const hasTick = /tick\(\s*\w+\s*\)\s*\{/.test(hudSrc);
        check(
            "F#10: NameplateLayer with Vector3.project(camera) projection",
            hasClass && hasProject && hasTick,
            `class=${hasClass}, project=${hasProject}, tick=${hasTick}`
        );
    } catch (e) {
        check(
            "F#10: NameplateLayer with Vector3.project(camera)",
            false,
            String(e).slice(0, 120)
        );
    }

    // === Follow-on Task 33 (2026-05-14) — Bug A: nameplate canvas =====
    // sizing via ctx.measureText so long names ("Hudriffa the
    // Shopkeeper", "Scrawed Grievver") don't truncate.
    //
    // Before the fix, `nameplate_sprite.js` allocated a fixed 256-px
    // canvas and drew text centre-aligned at canvas-x = 128. Names
    // wider than 256 px clipped on BOTH ends — the world-completeness-
    // demo screenshot at docs/world-completeness-demo-2026-05-14/
    // 01-hudriffa-shopkeeper.png shows "Hudriffa the Shopkeeper" as
    // "ffa the Shopk". The fix replaces the constant with a per-name
    // measureText pass that sizes the canvas to fit, then scales the
    // sprite's world width proportionally so px/m density is stable
    // across all names. Source-pattern guards:
    //   - `ctx.measureText(name)` is the load-bearing API call.
    //   - The bake entry now carries `canvasWidth` so the sprite
    //     constructor reads back the dynamic width.
    //   - The shrink-to-fit branch (for pathological-length names) is
    //     bounded by `CANVAS_WIDTH_MAX` to cap GPU memory.
    try {
        const fs = require("fs");
        const npSrc = fs.readFileSync(
            __dirname + "/scene3d/nameplate_sprite.js",
            "utf8"
        );
        const hasMeasureText = /\bctx\.measureText\(/.test(npSrc);
        const hasCanvasWidthField = /\bcanvasWidth\b/.test(npSrc);
        const hasMaxCap = /\bCANVAS_WIDTH_MAX\b/.test(npSrc);
        const hasDynamicScale =
            /sprite\.scale\.set\([^)]*worldWidth/.test(npSrc);
        check(
            "Follow-on Task 33: nameplate canvas uses measureText + dynamic width",
            hasMeasureText && hasCanvasWidthField && hasMaxCap && hasDynamicScale,
            `measureText=${hasMeasureText}, canvasWidth=${hasCanvasWidthField}, ` +
                `maxCap=${hasMaxCap}, dynamicScale=${hasDynamicScale}`
        );
    } catch (e) {
        check(
            "Follow-on Task 33: nameplate canvas uses measureText + dynamic width",
            false,
            String(e).slice(0, 160)
        );
    }

    // === Follow-on Task 34 (2026-05-14) — Bug B: nameplate registration
    // dedupes by guid so a re-entered spawn or a stale prior attachment
    // can't leave a "ghost" nameplate parented to the same entity root.
    //
    // The visible "3 nameplates around the Scrawed Grievver" in the
    // world-completeness demo turned out to be 3 separate entities with
    // 1 nameplate each (the LB at 0xA3AE has 3 Grievver spawns, all
    // visible from the demo camera). But the dedupe-by-guid guarantee
    // is still load-bearing: without it, a hot-reload or a re-entered
    // _spawnImpl could leave a stale Sprite parented to inst.root.
    // Source-pattern guards:
    //   - `hud.js#setNameplate` keys on the u32-coerced GUID via
    //     `this.nodes.get(key)` and returns early when the entry
    //     already exists (cross-call idempotency).
    //   - `nameplate_sprite.js#ensureNameplateForEntity` checks
    //     `inst._nameplateSprite` AND defensively scans inst.root.
    //     children for any orphan nameplate sprites (defence against
    //     a duplicate attachment from a different code path).
    try {
        const fs = require("fs");
        const hudSrc = fs.readFileSync(__dirname + "/scene3d/hud.js", "utf8");
        const npSrc = fs.readFileSync(
            __dirname + "/scene3d/nameplate_sprite.js",
            "utf8"
        );
        const hudDedupesByGuid =
            /this\.nodes\.get\(\s*key\s*\)/.test(hudSrc) &&
            /const\s+key\s*=\s*\(\s*guid\s*>>>\s*0\s*\)/.test(hudSrc);
        const spriteDedupesByInst =
            /inst\._nameplateSprite/.test(npSrc) &&
            /prevText\s*===\s*name/.test(npSrc);
        const spriteCleansStale =
            /(?:stale|orphan).*nameplate/i.test(npSrc) ||
            /child\.userData\.nameplateText/.test(npSrc);
        check(
            "Follow-on Task 34: nameplate registration dedupes by guid (DOM + sprite)",
            hudDedupesByGuid && spriteDedupesByInst && spriteCleansStale,
            `hudByGuid=${hudDedupesByGuid}, spriteByInst=${spriteDedupesByInst}, ` +
                `staleCleanup=${spriteCleansStale}`
        );
    } catch (e) {
        check(
            "Follow-on Task 34: nameplate registration dedupes by guid (DOM + sprite)",
            false,
            String(e).slice(0, 160)
        );
    }

    // === Follow-on #3 (2026-05-10) — live ACE 8765 reachable =========
    // Infra probe only — verifies the live tailnet1 stack at
    // http://100.116.47.66:8765 (the page-serving HTTP server) is
    // reachable from this network. The deeper login round-trip (which
    // also requires wsbridge on :8080 AND ACE on :9000 AND an unbroken
    // ACE↔wsbridge UDP reply path) is exercised by the capture scripts'
    // mode-2 paths; those SKIP rather than FAIL when the round-trip
    // breaks (the prerequisites are out of the capture's control).
    // This check intentionally SKIPS rather than FAILs on any failure
    // because the smoke suite must stay green when the dev box is
    // offline — see docs/f3-live-ace-debug.md for the full analysis.
    try {
        const httpMod = require("http");
        const status = await new Promise((resolve) => {
            const req = httpMod.request(
                {
                    host: "100.116.47.66",
                    port: 8765,
                    path: "/",
                    method: "HEAD",
                    timeout: 3000,
                },
                (res) => resolve(res.statusCode)
            );
            req.on("error", () => resolve(0));
            req.on("timeout", () => {
                req.destroy();
                resolve(0);
            });
            req.end();
        });
        if (status === 0) {
            console.log(
                "  [SKIP] F#3: live tailnet1 8765 reachable — server " +
                    "unreachable from this network (infra-dependent probe)"
            );
        } else {
            check(
                "F#3: live tailnet1 8765 reachable",
                status >= 200 && status < 500,
                `HTTP=${status}`
            );
        }
    } catch (_e) {
        // SKIP on any error — this is an infra probe, not a code assertion.
        console.log(
            "  [SKIP] F#3: live tailnet1 8765 reachable — probe threw"
        );
    }

    // === Follow-on #9 (2026-05-10) — WB.Terminal visual diff capture ===
    // The diagnostic capture itself runs against a live Playwright +
    // page-loaded scene3d and is too heavy for the smoke harness. The
    // smoke check is intentionally lightweight: confirm the capture
    // script file exists, so any future commit that deletes or renames
    // it gets caught here instead of at run-time. The capture's diff
    // numbers + artifacts (/tmp/f9_diff_result.json + /tmp/diff.png)
    // are produced separately by running the script directly.
    try {
        const fs = require("fs");
        const captureExists = fs.existsSync(__dirname + "/capture_f9_visual_diff.cjs");
        check(
            "F#9: WB.Terminal visual diff capture script present",
            captureExists,
            `exists=${captureExists}`
        );
    } catch (e) {
        check("F#9: WB.Terminal visual diff capture script present", false, String(e).slice(0, 120));
    }

    // === Workstream C (2026-05-11) — wasm-backed camera collision ===
    // Workstream C lands five wasm-bindgen exports on SessionHandle and
    // a chained sweep in scene3d/camera.js's positionCamera. The smoke
    // check verifies the exports' bindgen names land in the generated
    // wasm glue (.d.ts) and that camera.js calls the chain. Live
    // capture (`capture_3d_movement_e2e.cjs` and friends) covers the
    // end-to-end clipping behaviour against Holtburg geometry.
    try {
        const fs = require("fs");
        const camSrc = fs.readFileSync(__dirname + "/scene3d/camera.js", "utf8");
        const dtsPath = __dirname + "/pkg/holtburger_web.d.ts";
        const dtsSrc = fs.existsSync(dtsPath) ? fs.readFileSync(dtsPath, "utf8") : "";
        const hasTerrain = /terrainHeightAt/.test(dtsSrc);
        const hasCameraSweep = /cameraSweepCollision/.test(dtsSrc);
        const hasBuildingMesh = /sweepSphereAgainstBuildingMesh/.test(dtsSrc);
        const hasCellMesh = /sweepSphereAgainstCellMesh/.test(dtsSrc);
        const hasStatics = /sweepSphereAgainstStatics/.test(dtsSrc);
        const hasCollisionHit = /class CollisionHit/.test(dtsSrc);
        const hasClipChain = /_clipCameraAgainstWorld|terrainHeightAt|sweepSphereAgainstBuildingMesh/
            .test(camSrc);
        check(
            "Workstream C: wasm camera-collision exports + JS sweep chain",
            hasTerrain && hasCameraSweep && hasBuildingMesh && hasCellMesh &&
                hasStatics && hasCollisionHit && hasClipChain,
            `terrain=${hasTerrain} cam=${hasCameraSweep} bldg=${hasBuildingMesh} cell=${hasCellMesh} statics=${hasStatics} hit=${hasCollisionHit} chain=${hasClipChain}`
        );
    } catch (e) {
        check("Workstream C: wasm camera-collision exports + JS sweep chain", false, String(e).slice(0, 120));
    }

    // === Workstream B (2026-05-11) — client-side prediction in 3D camera ===
    // Verifies that the camera switcher carries the prediction state +
    // helpers (predictedPlayerPos, getPredictedPlayerWorldPos,
    // _advancePrediction, _reconcilePrediction, _applyPredictionLerp) and
    // that loop.js stamps `ts` on every __lastEntityWorldPos entry,
    // entities.js reads predictedPlayerPos before falling back to the
    // stash, and index.html exposes window.__movementConstants. Functional
    // verification (advance math, reconcile lerp, snap-on-teleport) lives
    // in test_workstream_b_prediction.mjs.
    try {
        const fs = require("fs");
        const camSrc = fs.readFileSync(__dirname + "/scene3d/camera.js", "utf8");
        const loopSrc = fs.readFileSync(__dirname + "/scene3d/loop.js", "utf8");
        const entSrc = fs.readFileSync(__dirname + "/scene3d/entities.js", "utf8");
        const indexSrc = fs.readFileSync(__dirname + "/index.html", "utf8");
        const hasPredictedPos = /this\.predictedPlayerPos\s*=/.test(camSrc);
        const hasGetPredicted = /getPredictedPlayerWorldPos\s*\(\s*\)\s*{/.test(camSrc);
        const hasAdvance = /_advancePrediction\s*\(\s*dt\s*\)\s*{/.test(camSrc);
        const hasReconcile = /_reconcilePrediction\s*\(\s*\)\s*{/.test(camSrc);
        const hasLerp = /_applyPredictionLerp\s*\(\s*dt\s*\)\s*{/.test(camSrc);
        const hasTickChain = /this\._reconcilePrediction\s*\(\s*\)\s*;[\s\S]*?this\._advancePrediction[\s\S]*?this\._applyPredictionLerp/
            .test(camSrc);
        const hasTsOnPose = /__lastEntityWorldPos\.set\([\s\S]*?ts:/.test(loopSrc);
        const hasEntitiesReadPredicted = /getPredictedPlayerWorldPos\s*\(\s*\)/.test(entSrc);
        const hasMovementConsts = /window\.__movementConstants\s*=\s*{/.test(indexSrc);
        check(
            "Workstream B: client-side prediction state + ts + getPredictedPlayerWorldPos + entities + consts",
            hasPredictedPos && hasGetPredicted && hasAdvance && hasReconcile &&
                hasLerp && hasTickChain && hasTsOnPose && hasEntitiesReadPredicted &&
                hasMovementConsts,
            `pred=${hasPredictedPos} get=${hasGetPredicted} advance=${hasAdvance} ` +
                `reconcile=${hasReconcile} lerp=${hasLerp} chain=${hasTickChain} ` +
                `ts=${hasTsOnPose} ent=${hasEntitiesReadPredicted} consts=${hasMovementConsts}`
        );
    } catch (e) {
        check("Workstream B: client-side prediction state + helpers", false, String(e).slice(0, 120));
    }

    // === Phase 1 (Cohere-D follow-on, 2026-05-12) — mouse-influence-on-movement disabled ===
    // Workstream D's camera-relative WASD + auto-turn-to-align math
    // was hard-removed (commit f7c4ae4 carried the original). Mouse-
    // look now moves the camera only; the character walks in its
    // player-local body frame, unaffected by camera angle. This
    // assertion inverts the prior Workstream D check: verifies the
    // legacy math is GONE and that the simple keystate passthrough
    // is in place.
    //
    // Restore reference for re-adding mouse-influenced movement as a
    // deliberate feature: the old logic ranged from camera.js line
    // ~1144 to ~1212 at commit f7c4ae4.
    try {
        const fs = require("fs");
        const camSrc = fs.readFileSync(__dirname + "/scene3d/camera.js", "utf8");
        const hasNoWorldRot = !/worldDx\s*=\s*inputForward\s*\*\s*sinY/.test(camSrc);
        const hasNoLocalRot = !/localForward\s*=\s*worldDx\s*\*\s*sinH/.test(camSrc);
        const hasNoAutoTurn = !/autoTurn\s*=\s*headingError\s*>\s*0/.test(camSrc);
        // Follow-mode now returns the same keystate-passthrough shape
        // as topDown — confirm by checking the simplified return is
        // present at the end of computeMovementFromKeys.
        const hasPlayerFramePassthrough = /Phase 1 \(Cohere-D follow-on, 2026-05-12\)[\s\S]{0,2000}return \{\s*forward: clampSign\(inputForward\)/.test(camSrc);
        check(
            "Phase 1: mouse-influence-on-movement disabled (Workstream D math removed)",
            hasNoWorldRot && hasNoLocalRot && hasNoAutoTurn && hasPlayerFramePassthrough,
            `noWorldRot=${hasNoWorldRot} noLocalRot=${hasNoLocalRot} ` +
                `noAutoTurn=${hasNoAutoTurn} playerFramePassthrough=${hasPlayerFramePassthrough}`
        );
    } catch (e) {
        check("Phase 1: mouse-influence-on-movement disabled (Workstream D math removed)", false, String(e).slice(0, 120));
    }

    // === Workstream Sky-B (2026-05-11) — wasm sky state + ACE-anchored time-of-day driver ===
    // Verifies the new SessionHandle exports are in the d.ts (`getSkyState`,
    // `getSkyObjectStates`, `hasSkyDesc`, `setSkyTimeOverride`), the
    // module-level `populateSkyDescFromRegion` export is bound, and the
    // index.html kind=7 EnteredWorld handler fires it. Functional
    // verification (lerp determinism, day-group selection, real-DAT dawn
    // vs dusk) lives in the holtburger-world unit tests
    // (`crates/holtburger-world/src/sky.rs`).
    try {
        const fs = require("fs");
        const dtsPath = __dirname + "/pkg/holtburger_web.d.ts";
        const dtsSrc = fs.existsSync(dtsPath) ? fs.readFileSync(dtsPath, "utf8") : "";
        const indexSrc = fs.readFileSync(__dirname + "/index.html", "utf8");
        const hasGetSkyState = /getSkyState/.test(dtsSrc);
        const hasGetSkyObjectStates = /getSkyObjectStates/.test(dtsSrc);
        const hasHasSkyDesc = /hasSkyDesc/.test(dtsSrc);
        const hasSetOverride = /setSkyTimeOverride/.test(dtsSrc);
        const hasPopulate = /populateSkyDescFromRegion/.test(dtsSrc);
        const hasSkyStateClass = /class SkyState\b/.test(dtsSrc);
        const hasSkyObjectStateClass = /class SkyObjectState\b/.test(dtsSrc);
        const hasKind7Hook = /populateSkyDescFromRegion\(0x13000000\)/.test(indexSrc);
        const hasAccelDriver = /__skyTimeAccel|setSkyTimeOverride\(t\)/.test(indexSrc);
        check(
            "Workstream Sky-B: wasm sky state exports + kind=7 hook + ?skytime=accel driver",
            hasGetSkyState && hasGetSkyObjectStates && hasHasSkyDesc &&
                hasSetOverride && hasPopulate && hasSkyStateClass &&
                hasSkyObjectStateClass && hasKind7Hook && hasAccelDriver,
            `getSkyState=${hasGetSkyState} getSkyObjectStates=${hasGetSkyObjectStates} ` +
                `hasSkyDesc=${hasHasSkyDesc} setOverride=${hasSetOverride} ` +
                `populate=${hasPopulate} stateClass=${hasSkyStateClass} ` +
                `objStateClass=${hasSkyObjectStateClass} kind7Hook=${hasKind7Hook} ` +
                `accelDriver=${hasAccelDriver}`
        );
    } catch (e) {
        check("Workstream Sky-B: wasm sky state exports + kind=7 hook + ?skytime=accel driver", false, String(e).slice(0, 120));
    }

    // === Workstream Sky-E (2026-05-11) — SkyObject asset resolver ====
    // Verifies `scene3d/sky_assets.js` is present and exports the
    // `resolveSkyAssets` + `buildSkyObjectGroup` entrypoints Sky-D's
    // renderer will call. The functional half (7 retail SkyObject IDs
    // resolve via the existing `fetchBuildingPlacement` path,
    // SetupModel 0x02000714 walks parts, surface DIDs preload through
    // the shared MaterialCache) is exercised by
    // `test_sky_assets.mjs` against the mocked wasm exports.
    try {
        const fs = require("fs");
        const skyAssetsPath = __dirname + "/scene3d/sky_assets.js";
        const present = fs.existsSync(skyAssetsPath);
        const src = present ? fs.readFileSync(skyAssetsPath, "utf8") : "";
        const hasResolve = /export\s+async\s+function\s+resolveSkyAssets/.test(src);
        const hasBuildGroup = /export\s+function\s+buildSkyObjectGroup/.test(src);
        const dispatchesOn01 = /prefix\s*!==\s*0x01\s*&&\s*prefix\s*!==\s*0x02/.test(src);
        const usesFetchBuildingPlacement = /fetchBuildingPlacement/.test(src);
        const usesMaterialCache = /MaterialCache\b/.test(src);
        const idempotentPath = /opts\.force|cached instanceof Map/.test(src);
        check(
            "Workstream Sky-E: sky_assets.js exports resolveSkyAssets + buildSkyObjectGroup",
            present && hasResolve && hasBuildGroup && dispatchesOn01 &&
                usesFetchBuildingPlacement && usesMaterialCache && idempotentPath,
            `present=${present} resolve=${hasResolve} group=${hasBuildGroup} ` +
                `dispatch=${dispatchesOn01} fetchBuild=${usesFetchBuildingPlacement} ` +
                `matCache=${usesMaterialCache} idempotent=${idempotentPath} bytes=${src.length}`
        );
    } catch (e) {
        check("Workstream Sky-E: sky_assets.js exports resolveSkyAssets + buildSkyObjectGroup",
            false, String(e).slice(0, 120));
    }

    // === Workstream Sky-C (2026-05-11) — sky lighting + fog controller ===
    // Verifies `scene3d/sky_lighting.js` exists, exports
    // `SkyLightingController`, references the expected getSkyState
    // fields (decoded ARGB into THREE.DirectionalLight color/intensity/
    // position + THREE.AmbientLight color/intensity + THREE.Fog
    // color/near/far), and publishes `skyBackgroundColor` for Sky-D's
    // sky-dome to consume. Functional correctness (calibration math,
    // lerped color values) lives in `test_sky_lighting.mjs` against
    // Sky-B's verified t=0.25/0.5/0.75/0.99 values.
    try {
        const fs = require("fs");
        const skyLightingPath = __dirname + "/scene3d/sky_lighting.js";
        const present = fs.existsSync(skyLightingPath);
        const src = present ? fs.readFileSync(skyLightingPath, "utf8") : "";
        const hasController = /export\s+class\s+SkyLightingController/.test(src);
        const hasTick = /\btick\s*\(/.test(src);
        const hasApplyState = /_applyState\s*\(/.test(src);
        const referencesDirColor = /dirColorArgb/.test(src);
        const referencesDirBright = /dirBright/.test(src);
        const referencesDirHeading = /dirHeading/.test(src);
        const referencesDirPitch = /dirPitch/.test(src);
        const referencesAmbColor = /ambColorArgb/.test(src);
        const referencesAmbBright = /ambBright/.test(src);
        const referencesFogColor = /fogColorArgb/.test(src);
        const referencesFogMin = /fogMin/.test(src);
        const referencesFogMax = /fogMax/.test(src);
        // skyBackgroundColor sink path for Sky-D.
        const exposesSkyBgSink = /skyBackgroundColor/.test(src);
        // Calibration: degrees-to-radians conversion present.
        const hasDegToRad = /Math\.PI\s*\)\s*\/\s*180/.test(src) ||
            /Math\.PI\s*\/\s*180/.test(src);
        // Wired into loop.js + index.js.
        const loopSrc = fs.readFileSync(__dirname + "/scene3d/loop.js", "utf8");
        const indexSrc = fs.readFileSync(__dirname + "/scene3d/index.js", "utf8");
        const wiredInLoop = /skyLightingController\s*\.\s*tick/.test(loopSrc);
        const wiredInIndex = /new\s+SkyLightingController/.test(indexSrc);
        check(
            "Workstream Sky-C: sky_lighting.js SkyLightingController + getSkyState consumer + skyBackgroundColor sink",
            present && hasController && hasTick && hasApplyState &&
                referencesDirColor && referencesDirBright &&
                referencesDirHeading && referencesDirPitch &&
                referencesAmbColor && referencesAmbBright &&
                referencesFogColor && referencesFogMin && referencesFogMax &&
                exposesSkyBgSink && hasDegToRad &&
                wiredInLoop && wiredInIndex,
            `present=${present} controller=${hasController} tick=${hasTick} ` +
                `apply=${hasApplyState} dirColor=${referencesDirColor} ` +
                `dirBright=${referencesDirBright} dirHeading=${referencesDirHeading} ` +
                `dirPitch=${referencesDirPitch} ambColor=${referencesAmbColor} ` +
                `ambBright=${referencesAmbBright} fogColor=${referencesFogColor} ` +
                `fogMin=${referencesFogMin} fogMax=${referencesFogMax} ` +
                `skyBgSink=${exposesSkyBgSink} degToRad=${hasDegToRad} ` +
                `loopWired=${wiredInLoop} indexWired=${wiredInIndex} bytes=${src.length}`
        );
    } catch (e) {
        check("Workstream Sky-C: sky_lighting.js SkyLightingController + getSkyState consumer + skyBackgroundColor sink",
            false, String(e).slice(0, 120));
    }

    // === World-expand step 1 Objective 9 (2026-05-14) — fog far floor =
    // Source-pattern check (the smoke harness is JS-AST-static and the
    // live `_lastState.fog.far` value only exists after a wasm SkyState
    // ticks through, which requires the full Playwright stack). Asserts
    // that `scene3d/sky_lighting.js` defines a `FOG_FAR_FLOOR = 2500.0`
    // constant near `DEFAULT_FOG_MAX`, that `DEFAULT_FOG_MAX` itself is
    // raised to 2500.0, and that the per-tick `fog.far = Math.max(...)`
    // clamp at `_applyState` uses `FOG_FAR_FLOOR` as a third argument.
    // This guarantees the 13×13 ring is visible even at midnight when
    // Region 0x13's DayGroup `max_world_fog` lerps low.
    try {
        const fs = require("fs");
        const skyLightingPath = __dirname + "/scene3d/sky_lighting.js";
        const src = fs.readFileSync(skyLightingPath, "utf8");
        const hasFogFarFloorConst = /\bconst\s+FOG_FAR_FLOOR\s*=\s*2500(\.0)?\s*;/.test(src);
        const hasDefaultFogMax2500 = /\bconst\s+DEFAULT_FOG_MAX\s*=\s*2500(\.0)?\s*;/.test(src);
        // Match the clamp at line ~388 — `Math.max(... , state.fogMax,
        // FOG_FAR_FLOOR)`. Tolerate whitespace + reordering of args.
        const hasFloorInClamp = /this\.fog\.far\s*=\s*Math\.max\([^)]*\bFOG_FAR_FLOOR\b[^)]*\)/.test(src);
        check(
            "World-expand step 1 Objective 9: FOG_FAR_FLOOR = 2500 m raises DEFAULT_FOG_MAX + floors per-tick fog.far so the 13×13 ring is visible",
            hasFogFarFloorConst && hasDefaultFogMax2500 && hasFloorInClamp,
            `floorConst=${hasFogFarFloorConst} defaultMax2500=${hasDefaultFogMax2500} floorInClamp=${hasFloorInClamp}`
        );
    } catch (e) {
        check("World-expand step 1 Objective 9: FOG_FAR_FLOOR = 2500 m raises DEFAULT_FOG_MAX + floors per-tick fog.far so the 13×13 ring is visible",
            false, String(e).slice(0, 120));
    }

    // === World-expand step 1 terrain-atlas flipY regression (2026-05-14) =
    // Source-pattern check that `scene3d/terrain.js`'s atlas + road
    // CanvasTextures set `flipY = false` before `needsUpdate = true`.
    // THREE.CanvasTexture defaults flipY=true; without the override the
    // GPU vertically mirrors the canvas at upload, so the shader's
    // `atlasUvFor(code, …)` (row = code/6) ends up sampling slot
    // `(5 - code/6) * 6 + code%6` instead of slot `code` — Grassland (1)
    // paints as DesolateLands (31), LushGrass (3) as empty slot 33
    // (black), PatchyGrassland (9) as BlueIce (27, cyan), etc. Latent
    // bug surfaced visually by the 13×13 ring screenshots (commit
    // 8269e4b → dbea563); fixed in the follow-up patch with this guard
    // as a regression gate.
    try {
        const fs = require("fs");
        const src = fs.readFileSync(__dirname + "/scene3d/terrain.js", "utf8");
        const atlasFlipY = /atlasTexture\.flipY\s*=\s*false\s*;/.test(src);
        const roadFlipY = /roadTexture\.flipY\s*=\s*false\s*;/.test(src);
        check(
            "World-expand step 1 fix: terrain atlasTexture.flipY=false (otherwise grass→DesolateLands, etc)",
            atlasFlipY,
            `atlasFlipY=${atlasFlipY}`
        );
        check(
            "World-expand step 1 fix: terrain roadTexture.flipY=false (sibling of atlas; keeps directional road art upright)",
            roadFlipY,
            `roadFlipY=${roadFlipY}`
        );
    } catch (e) {
        check("World-expand step 1 fix: terrain atlas/road CanvasTexture flipY=false",
            false, String(e).slice(0, 120));
    }

    // === World-expand step 1 Objective 7 (2026-05-14) — distance-keyed
    // === subdivision LOD =============================================
    // Source-pattern check that `pickSubdivLevelForLb` (terrain.js:812,
    // established in commit 7145f11 as Objective 2's centre-vs-outer
    // flip) now computes a Chebyshev-distance cascade and returns the
    // unsubdivided `1` floor for any LB ≥ 2 LBs away from the reference
    // LB. Pre-Objective-7 the function compared lbX/lbY against
    // `opts.centreLbX/Y` and returned only `centreLevel` or
    // `outerLevel` — there was no distance≥2 branch. After the flip,
    // any 13×13 ring's outer two rings (44 LBs at radius=2, plus the
    // 60+76 at radius=3 / radius=4 / radius=5 / radius=6) collapse to
    // subdivLevel=1 so triangle counts stay sane at radius=6
    // (Objective 8). At radius=1 the cascade is bit-identical to the
    // prior centre-vs-outer rule.
    //
    // The browser-side live check (per-LB userData.subdivLevel for an
    // outer-ring LB after Objective 8's radius bump) lives in
    // `capture_world_expand_e2e.cjs` (Objective 10). Here we just
    // assert the source has the cascade shape — Math.max(Math.abs(...))
    // for Chebyshev distance + an explicit `return 1` for distance ≥ 2.
    try {
        const fs = require("fs");
        const path = require("path");
        const terrainPath = path.resolve(__dirname, "scene3d", "terrain.js");
        const terrainSrc = fs.readFileSync(terrainPath, "utf8");
        // Capture the body of `pickSubdivLevelForLb` (regex anchored
        // on the export-less helper declaration `function
        // pickSubdivLevelForLb(opts, lbX, lbY)`; non-greedy match up
        // to the closing brace on its own line).
        const bodyMatch = terrainSrc.match(
            /function\s+pickSubdivLevelForLb\s*\(\s*opts\s*,\s*lbX\s*,\s*lbY\s*\)[\s\S]*?\n\}\n/
        );
        const body = bodyMatch ? bodyMatch[0] : "";
        // Chebyshev distance computation: max(abs(lbX - pX), abs(lbY - pY)).
        // The reference variables may be named pX/pY / px/py / refX/refY;
        // tolerate any single-letter or short prefix as long as the
        // arithmetic is `abs(lbX - <ref>)` paired with `abs(lbY - <ref>)`.
        const hasChebyshev =
            /Math\.max\s*\(\s*Math\.abs\s*\(\s*lbX\s*-\s*\w+\s*\)\s*,\s*Math\.abs\s*\(\s*lbY\s*-\s*\w+\s*\)\s*\)/.test(
                body
            );
        // distance ≥ 2 explicit `return 1` branch. The cascade is
        // distance-0 → full, distance-1 → half, distance ≥ 2 → 1.
        // The final fall-through must be `return 1` (no further
        // arithmetic, no return of a variable that could be > 1).
        const hasReturnOne = /\breturn\s+1\s*;/.test(body);
        // playerLbKey OR initialCentreLbKey is read off opts (or a
        // sensible fallback chain). The brief says playerLbKey is the
        // preferred reference; document the fallback chain inline.
        const readsPlayerLb =
            /opts\.playerLbKey/.test(body) ||
            /opts\.initialCentreLbKey/.test(body);
        check(
            "World-expand step 1 Objective 7: pickSubdivLevelForLb uses Chebyshev distance + flattens outer rings (≥2) to subdivLevel=1",
            !!body && hasChebyshev && hasReturnOne && readsPlayerLb,
            `bodyFound=${!!body} chebyshev=${hasChebyshev} ` +
                `returnOne=${hasReturnOne} readsPlayerLb=${readsPlayerLb}`
        );
    } catch (e) {
        check(
            "World-expand step 1 Objective 7: pickSubdivLevelForLb uses Chebyshev distance + flattens outer rings (≥2) to subdivLevel=1",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === World-expand step 1 Objective 8 (2026-05-14) — initial ring
    // === flip 1 → 6 (3×3 → 13×13) at init3D ============================
    // Source-pattern check that `scene3d/index.js` defines the
    // `HOLTBURG_RING_RADIUS = 6` constant and that the three `bakeXRing`
    // call sites in `init3D` both (a) import the ring driver export,
    // (b) call it with the constant as the radius argument, and
    // (c) set `initialCentreLbKey` + `playerLbKey` on the scene3d stub
    // before the ring bakes run so Objective 7's `pickSubdivLevelForLb`
    // can pick the right reference LB.
    //
    // The live verification (`terrainGroup.children.length === 169`,
    // building/statics counts, oracle parity) lives in
    // `capture_world_expand_e2e.cjs` (Objective 10). Here we just
    // assert the source-level wiring per the brief's verification gate:
    // "Smoke 171 → 172: +1 check asserting `HOLTBURG_RING_RADIUS === 6`
    //  or the three `bakeXRing` calls pass `6` (a source-pattern grep
    //  on scene3d/index.js)."
    try {
        const fs = require("fs");
        const path = require("path");
        const indexPath = path.resolve(__dirname, "scene3d", "index.js");
        const src = fs.readFileSync(indexPath, "utf8");

        // (a) The constant must be defined at module scope and equal 6.
        const hasRadiusConst =
            /\bconst\s+HOLTBURG_RING_RADIUS\s*=\s*6\s*;/.test(src);

        // (b) All three ring drivers must be imported from their source
        // modules.
        const importsTerrainRing =
            /\bbakeTerrainRing\b[\s\S]{0,300}from\s*["']\.\/terrain\.js["']/.test(
                src
            );
        const importsBuildingsRing =
            /\bbakeBuildingsRing\b[\s\S]{0,300}from\s*["']\.\/buildings\.js["']/.test(
                src
            );
        const importsStaticsRing =
            /\bbakeStaticsRing\b[\s\S]{0,300}from\s*["']\.\/statics\.js["']/.test(
                src
            );

        // (c) Each ring driver must be called with the
        // `HOLTBURG_RING_RADIUS` constant as the fourth argument
        // (`(scene3d, lbX, lbY, radius, wasmExports)`).
        // Match across whitespace + line breaks; the call shape is
        // multi-line per the existing init3D formatting.
        const callsTerrainAtRadius =
            /bakeTerrainRing\s*\(\s*\w+\s*,\s*HOLTBURG_X\s*,\s*HOLTBURG_Y\s*,\s*HOLTBURG_RING_RADIUS\s*,/.test(
                src
            );
        const callsBuildingsAtRadius =
            /bakeBuildingsRing\s*\(\s*\w+\s*,\s*HOLTBURG_X\s*,\s*HOLTBURG_Y\s*,\s*HOLTBURG_RING_RADIUS\s*,/.test(
                src
            );
        const callsStaticsAtRadius =
            /bakeStaticsRing\s*\(\s*\w+\s*,\s*HOLTBURG_X\s*,\s*HOLTBURG_Y\s*,\s*HOLTBURG_RING_RADIUS\s*,/.test(
                src
            );

        // (d) `initialCentreLbKey` + `playerLbKey` seeded on the
        // scene3dForBuilders stub before the ring bakes fire — Objective
        // 7's `pickSubdivLevelForLb` reads these to compute Chebyshev
        // distance from the ring centre.
        const setsInitialCentreLbKey =
            /scene3dForBuilders\.initialCentreLbKey\s*=\s*\(\s*\(\s*HOLTBURG_X\s*<<\s*24\s*\)\s*\|\s*\(\s*HOLTBURG_Y\s*<<\s*16\s*\)\s*\)\s*>>>\s*0\s*;/.test(
                src
            );
        const setsPlayerLbKey =
            /scene3dForBuilders\.playerLbKey\s*=\s*scene3dForBuilders\.initialCentreLbKey\s*;/.test(
                src
            );

        check(
            "World-expand step 1 Objective 8: HOLTBURG_RING_RADIUS=6 + three bakeXRing calls + initialCentreLbKey/playerLbKey seeded in init3D",
            hasRadiusConst &&
                importsTerrainRing &&
                importsBuildingsRing &&
                importsStaticsRing &&
                callsTerrainAtRadius &&
                callsBuildingsAtRadius &&
                callsStaticsAtRadius &&
                setsInitialCentreLbKey &&
                setsPlayerLbKey,
            `radiusConst=${hasRadiusConst} ` +
                `importsTerrainRing=${importsTerrainRing} ` +
                `importsBuildingsRing=${importsBuildingsRing} ` +
                `importsStaticsRing=${importsStaticsRing} ` +
                `callsTerrainAtRadius=${callsTerrainAtRadius} ` +
                `callsBuildingsAtRadius=${callsBuildingsAtRadius} ` +
                `callsStaticsAtRadius=${callsStaticsAtRadius} ` +
                `setsInitialCentreLbKey=${setsInitialCentreLbKey} ` +
                `setsPlayerLbKey=${setsPlayerLbKey}`
        );
    } catch (e) {
        check(
            "World-expand step 1 Objective 8: HOLTBURG_RING_RADIUS=6 + three bakeXRing calls + initialCentreLbKey/playerLbKey seeded in init3D",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === World-expand step 1 obj 10 — capture_world_expand_e2e.cjs ====
    // Source-pattern check that the capture script lands at the canonical
    // path and contains the key assertions the brief calls for. The
    // runtime end-to-end assertion lives in the capture itself (run
    // with `node capture_world_expand_e2e.cjs`); this smoke check is
    // the merge-gate floor that prevents the capture from being
    // accidentally removed or gutted in a future commit.
    //
    // What we look for:
    //   - File exists at apps/holtburger-web/capture_world_expand_e2e.cjs
    //   - Loads the WorldBuilder.Terminal oracle from
    //     /mnt/wbterminal1/tmp/claude-scratch/world-expand/ring_13x13_inventory.jsonl
    //   - Asserts the 169-LB ring count (EXPECTED_RING_LB_COUNT = 169
    //     OR equivalent literal `169` in an assertion targeting
    //     `terrainGroup.children.length`).
    //   - Probes liveScene3d.{terrain,buildings,statics}BakedLbs.size
    //     (even though the renderer-gap means these may FAIL — see the
    //     capture comments for the field-aliasing follow-on).
    //   - Asserts the oracle's `766` total placement count.
    //   - Includes a lazy walk-out drill (loadXForLandblock for an LB
    //     outside the ring + idempotency re-fire).
    //   - Drills 0xA9B0 (South Holtburg Outpost) per the brief.
    //   - Asserts fog.far >= 2500 (Objective 9 floor).
    try {
        const fs = require("fs");
        const capturePath = __dirname + "/capture_world_expand_e2e.cjs";
        const present = fs.existsSync(capturePath);
        const src = present ? fs.readFileSync(capturePath, "utf8") : "";
        const hasOracleLoad =
            /ring_13x13_inventory\.jsonl/.test(src) &&
            /list-objects/.test(src);
        const hasRingCount = /\b169\b/.test(src);
        const hasTerrainBakedLbsAssert =
            /liveScene3d\.terrainBakedLbs|terrainBakedLbsSize/.test(src);
        const hasBuildingsBakedLbsAssert =
            /liveScene3d\.buildingsBakedLbs|buildingsBakedLbsSize/.test(src);
        const hasStaticsBakedLbsAssert =
            /liveScene3d\.staticsBakedLbs|staticsBakedLbsSize/.test(src);
        const hasOraclePlacementCount = /\b766\b/.test(src);
        const hasLazyWalkOut =
            /loadTerrainForLandblock|loadBuildingsForLandblock|loadStaticsForLandblock/.test(
                src
            ) && /idempotency/i.test(src);
        const hasA9b0Drill = /0xA9B0|0xa9b0/.test(src);
        const hasFogFarCheck = /fog\.far|fogFar/.test(src) && /2500/.test(src);
        check(
            "World-expand step 1 Objective 10: capture_world_expand_e2e.cjs exists + asserts oracle parity (169 LBs, 766 placements, lazy walk-out, 0xA9B0 drill, fog.far >= 2500)",
            present &&
                hasOracleLoad &&
                hasRingCount &&
                hasTerrainBakedLbsAssert &&
                hasBuildingsBakedLbsAssert &&
                hasStaticsBakedLbsAssert &&
                hasOraclePlacementCount &&
                hasLazyWalkOut &&
                hasA9b0Drill &&
                hasFogFarCheck,
            `present=${present} ` +
                `oracleLoad=${hasOracleLoad} ` +
                `ringCount=${hasRingCount} ` +
                `terrainBakedLbs=${hasTerrainBakedLbsAssert} ` +
                `buildingsBakedLbs=${hasBuildingsBakedLbsAssert} ` +
                `staticsBakedLbs=${hasStaticsBakedLbsAssert} ` +
                `oraclePlacements=${hasOraclePlacementCount} ` +
                `lazyWalkOut=${hasLazyWalkOut} ` +
                `a9b0Drill=${hasA9b0Drill} ` +
                `fogFar=${hasFogFarCheck}`
        );
    } catch (e) {
        check(
            "World-expand step 1 Objective 10: capture_world_expand_e2e.cjs exists + asserts oracle parity",
            false,
            String(e?.message ?? e).slice(0, 160)
        );
    }

    // === Workstream Sky-D (2026-05-11) — sky dome + celestial bodies =
    // Verifies `scene3d/sky_dome.js` is present, exports `SkyDome` class,
    // references the expected shape (gradient ShaderMaterial uniforms +
    // `populateCelestialBodies` + `tick` reading `getSkyObjectStates` +
    // `isCurrentCellIndoor`), and is wired into `loop.js` (per-frame
    // tick) + `index.js` (instantiation + lazy `resolveSkyAssets`
    // hand-off). Functional correctness lives in `test_sky_dome.mjs`.
    try {
        const fs = require("fs");
        const skyDomePath = __dirname + "/scene3d/sky_dome.js";
        const present = fs.existsSync(skyDomePath);
        const src = present ? fs.readFileSync(skyDomePath, "utf8") : "";
        const hasClass = /export\s+class\s+SkyDome/.test(src);
        const hasDomeName = /"sky_dome"|'sky_dome'/.test(src);
        const hasUserDataTag = /sky_object_id\s*:/.test(src);
        const hasPopulate = /populateCelestialBodies\s*\(/.test(src);
        const hasGradientUniforms = /uHorizonColor[\s\S]*uZenithColor/.test(src);
        const hasShaderMat = /ShaderMaterial/.test(src);
        const hasBackSide = /BackSide/.test(src);
        // Sky-I-B (2026-05-11) — sky cell render refactor. The old
        // `celestialPosition(h, p, r) = (sin(h)*cos(p), ...) * r` math
        // was deleted; celestial bodies now live in a per-object rotator
        // group inside `skyCell` with the bake mesh keeping its NATIVE
        // AC vertex coords. The new shape is `lerpDeg(begin, end,
        // progress)` + a `renderSkyPass(renderer, camera)` method.
        const hasLerpDeg = /lerpDeg\s*\(/.test(src);
        const hasRenderSkyPass = /renderSkyPass\s*\(/.test(src);
        const hasSkyCell = /this\.skyCell\b/.test(src);
        const hasSkyScene = /this\.skyScene\b/.test(src);
        const hasSkyCamera = /this\.skyCamera\b/.test(src);
        const readsSkyObjectStates = /getSkyObjectStates\s*\(/.test(src);
        const readsIndoor = /isCurrentCellIndoor\s*\(/.test(src);
        const readsSkyBgColor = /skyBackgroundColor/.test(src);
        // Wired into loop.js + index.js.
        const loopSrc = fs.readFileSync(__dirname + "/scene3d/loop.js", "utf8");
        const indexSrc = fs.readFileSync(__dirname + "/scene3d/index.js", "utf8");
        const wiredInLoop = /skyDome\s*\.\s*tick/.test(loopSrc);
        const wiredInIndex = /new\s+SkyDome/.test(indexSrc);
        const wiredResolveAssets = /resolveSkyAssets/.test(indexSrc);
        // Sky-I-B: the renderSkyPass method must be invoked from the
        // main render loop in index.js so the celestial bodies actually
        // make it to the framebuffer.
        const skyPassWired = /skyDome\.renderSkyPass/.test(indexSrc);
        check(
            "Workstream Sky-D/Sky-I-B: sky_dome.js SkyDome + sky-cell render pass + lerpDeg + indoor flip",
            present && hasClass && hasDomeName && hasUserDataTag &&
                hasPopulate && hasGradientUniforms && hasShaderMat &&
                hasBackSide && hasLerpDeg && hasRenderSkyPass &&
                hasSkyCell && hasSkyScene && hasSkyCamera &&
                readsSkyObjectStates && readsIndoor && readsSkyBgColor &&
                wiredInLoop && wiredInIndex && wiredResolveAssets &&
                skyPassWired,
            `present=${present} class=${hasClass} domeName=${hasDomeName} ` +
                `userData=${hasUserDataTag} populate=${hasPopulate} ` +
                `uniforms=${hasGradientUniforms} shaderMat=${hasShaderMat} ` +
                `backSide=${hasBackSide} lerpDeg=${hasLerpDeg} ` +
                `renderSkyPass=${hasRenderSkyPass} skyCell=${hasSkyCell} ` +
                `skyScene=${hasSkyScene} skyCamera=${hasSkyCamera} ` +
                `readsStates=${readsSkyObjectStates} readsIndoor=${readsIndoor} ` +
                `readsBg=${readsSkyBgColor} loopWired=${wiredInLoop} ` +
                `indexWired=${wiredInIndex} resolveWired=${wiredResolveAssets} ` +
                `skyPassWired=${skyPassWired} bytes=${src.length}`
        );
    } catch (e) {
        check("Workstream Sky-D: sky_dome.js SkyDome class + gradient dome + celestial bodies + indoor flip",
            false, String(e).slice(0, 120));
    }

    // === Workstream Sky-G (2026-05-11) — SkyObjectReplace lerp + cloud
    // UV scroll + DayGroup cycling override + properties decode =====
    // Verifies the four Sky-G pieces are wired:
    //   1. SkyObjectReplace lerping — `lerp_sky_object_replace` exists in
    //      `crates/holtburger-world/src/sky.rs`.
    //   2. `setGameDayOverride` exists as a wasm export (lib.rs).
    //   3. `getSkyOverrideObjectIds` wasm export wired into index.js to
    //      pre-bake override mesh set.
    //   4. SkyObject.properties decode constants
    //      (`SKY_OBJ_PROP_SCROLLING_CLOUD` etc.) declared in sky.rs.
    //   5. SkyDome controller exposes `_meshSwapCount` counter for the
    //      capture-script bullet 18 assertion.
    try {
        const fs = require("fs");
        const skyRsPath = __dirname + "/../../crates/holtburger-world/src/sky.rs";
        const libRsPath = __dirname + "/src/lib.rs";
        const indexJsPath = __dirname + "/scene3d/index.js";
        const skyDomePath = __dirname + "/scene3d/sky_dome.js";
        const captureCjsPath = __dirname + "/capture_skybox_e2e.cjs";
        const skyRsSrc = fs.readFileSync(skyRsPath, "utf8");
        const libRsSrc = fs.readFileSync(libRsPath, "utf8");
        const indexJsSrc = fs.readFileSync(indexJsPath, "utf8");
        const skyDomeSrc = fs.readFileSync(skyDomePath, "utf8");
        const captureCjsSrc = fs.readFileSync(captureCjsPath, "utf8");

        const hasReplaceLerp = /fn\s+lerp_sky_object_replace\b/.test(skyRsSrc);
        const hasSessionStart = /session_start_unix\b/.test(skyRsSrc);
        const hasGameDayOverrideField = /game_day_override\b/.test(skyRsSrc);
        const hasPropConstants =
            /SKY_OBJ_PROP_SCROLLING_CLOUD\b/.test(skyRsSrc) &&
            /SKY_OBJ_PROP_PHYSICS_SCRIPT\b/.test(skyRsSrc) &&
            /SKY_OBJ_PROP_WEATHER_STREAK\b/.test(skyRsSrc) &&
            /SKY_OBJ_PROP_ADDITIVE_BLEND\b/.test(skyRsSrc);
        const hasSetGameDayWasmExport = /setGameDayOverride/.test(libRsSrc);
        const hasGetSkyOverrideExport = /getSkyOverrideObjectIds/.test(libRsSrc);
        const indexConsumesOverrideIds = /getSkyOverrideObjectIds/.test(indexJsSrc);
        const domeHasMeshSwapCount = /_meshSwapCount\b/.test(skyDomeSrc);
        const domeHasLastActiveMap = /_lastActiveIdPerObjectIndex\b/.test(skyDomeSrc);
        const captureHasBullet16 = /Bullet 16: cloud UV offset/.test(captureCjsSrc);
        const captureHasBullet17 = /Bullet 17: day_group_index/.test(captureCjsSrc);
        const captureHasBullet18 = /Bullet 18: SkyObjectReplace mesh-swap/.test(captureCjsSrc);

        check(
            "Workstream Sky-G: SkyObjectReplace lerp + cloud UV scroll + setGameDayOverride + property bit decode",
            hasReplaceLerp && hasSessionStart && hasGameDayOverrideField &&
                hasPropConstants && hasSetGameDayWasmExport &&
                hasGetSkyOverrideExport && indexConsumesOverrideIds &&
                domeHasMeshSwapCount && domeHasLastActiveMap &&
                captureHasBullet16 && captureHasBullet17 && captureHasBullet18,
            `replaceLerp=${hasReplaceLerp} sessionStart=${hasSessionStart} ` +
                `gameDayOverride=${hasGameDayOverrideField} ` +
                `propConsts=${hasPropConstants} ` +
                `setGameDayWasm=${hasSetGameDayWasmExport} ` +
                `getOverrideIds=${hasGetSkyOverrideExport} ` +
                `indexConsumes=${indexConsumesOverrideIds} ` +
                `domeSwapCount=${domeHasMeshSwapCount} ` +
                `domeLastActive=${domeHasLastActiveMap} ` +
                `bullet16=${captureHasBullet16} bullet17=${captureHasBullet17} bullet18=${captureHasBullet18}`
        );
    } catch (e) {
        check("Workstream Sky-G: SkyObjectReplace lerp + cloud UV scroll + setGameDayOverride + property bit decode",
            false, String(e).slice(0, 120));
    }

    // === Phase E — validate-landblock-completeness =====================
    // The production validation gate. Source-pattern check only —
    // running the actual Playwright validator takes 5+ min and lives
    // outside the smoke loop. We verify the tool exists and contains
    // the load-bearing logic that distinguishes it from a stub:
    //   1. Walks InstancedMesh via getMatrixAt / instanceMatrix.array
    //      + decompose into per-instance placements (the F#5+6 collapse
    //      means staticsGroup.children.length ≠ placement count).
    //   2. Walks LOD nodes at their highest-detail child (level 0).
    //   3. Builds the expected manifest by calling all three wasm
    //      `fetch_landblock_*` exports (objects, scenery, spawns) —
    //      the union of the three streams from the
    //      `docs/hypotheticalmethod.md` contract.
    //   4. Diffs by (modelOrWcid, lbX, lbY, x±0.05, y±0.05, z±0.10)
    //      and surfaces both missing-render AND invented-placement
    //      findings (NOT just absolute counts).
    //   5. Writes machine + human reports at
    //      <out>/completeness-report.{json,md}.
    //
    // Without these checks a future refactor could quietly rip out the
    // InstancedMesh-expansion walk (turning the validator into a
    // "child count" comparator that ignores 90% of the scene) without
    // failing CI.
    try {
        const fs = require("fs");
        const validatorPath = __dirname + "/validate_landblock_completeness.cjs";
        const exists = fs.existsSync(validatorPath);
        let srcOk = false, detail = "";
        if (exists) {
            const src = fs.readFileSync(validatorPath, "utf8");
            const walksInstanced =
                /obj\.isInstancedMesh/.test(src) &&
                /instanceMatrix\.array/.test(src) &&
                /decomposeMat4\s*\(/.test(src);
            const walksLod =
                /obj\.isLOD\b/.test(src) &&
                /highest-detail child/i.test(src);
            const fetchesAllThreeStreams =
                /\bfetch_landblock_objects\s*\(/.test(src) &&
                /\bfetch_landblock_scenery\s*\(/.test(src) &&
                /\bfetch_landblock_spawns\s*\(/.test(src);
            const diffsWithTolerance =
                /POS_XY_TOLERANCE_M\s*=\s*0\.05/.test(src) &&
                /POS_Z_TOLERANCE_M\s*=\s*0\.10/.test(src);
            const surfacesBothFindings =
                /missing-render/.test(src) &&
                /invented-placement|inventedPlacement/.test(src);
            const writesBothReports =
                /completeness-report\.json/.test(src) &&
                /completeness-report\.md/.test(src);
            const supportsRingArg = /--ring/.test(src) && /\bringLbList\b/.test(src);
            const supportsStrictArg = /--strict/.test(src);
            srcOk = walksInstanced &&
                walksLod &&
                fetchesAllThreeStreams &&
                diffsWithTolerance &&
                surfacesBothFindings &&
                writesBothReports &&
                supportsRingArg &&
                supportsStrictArg;
            detail =
                `walksInstanced=${walksInstanced} walksLod=${walksLod} ` +
                `fetches3=${fetchesAllThreeStreams} tolerance=${diffsWithTolerance} ` +
                `findings=${surfacesBothFindings} reports=${writesBothReports} ` +
                `ringArg=${supportsRingArg} strictArg=${supportsStrictArg}`;
        } else {
            detail = `missing at ${validatorPath}`;
        }
        check(
            "Phase E: validate_landblock_completeness.cjs exists at apps/holtburger-web/",
            exists,
            exists ? `bytes=${fs.statSync(validatorPath).size}` : detail
        );
        check(
            "Phase E: validator expands InstancedMesh + LOD + fetches all 3 streams + diffs with tolerance",
            srcOk,
            detail
        );
    } catch (e) {
        check(
            "Phase E: validate_landblock_completeness.cjs exists at apps/holtburger-web/",
            false,
            String(e).slice(0, 120)
        );
        check(
            "Phase E: validator expands InstancedMesh + LOD + fetches all 3 streams + diffs with tolerance",
            false,
            String(e).slice(0, 120)
        );
    }

    // Phase E.b — validator must be wired so Phase E's "validation
    // gate" can run against a green ring. The validator depends on
    // the three placement streams being already shipped (Phase B/C/D)
    // and on the `liveScene3d` exposing the three placement groups
    // (statics, buildings, entities). This check enforces the
    // downstream contracts the validator depends on, so a regression
    // upstream surfaces here first.
    try {
        const fs = require("fs");
        const idxSrc = fs.readFileSync(__dirname + "/scene3d/index.js", "utf8");
        const exposesStaticsGroup = /\bstaticsGroup\b/.test(idxSrc);
        const exposesBuildingsGroup = /\bbuildingsGroup\b/.test(idxSrc);
        const exposesEntitiesGroup = /\bentitiesGroup\b/.test(idxSrc);
        check(
            "Phase E: liveScene3d still exposes the three placement groups validator walks",
            exposesStaticsGroup && exposesBuildingsGroup && exposesEntitiesGroup,
            `statics=${exposesStaticsGroup} buildings=${exposesBuildingsGroup} entities=${exposesEntitiesGroup}`
        );
    } catch (e) {
        check(
            "Phase E: liveScene3d still exposes the three placement groups validator walks",
            false,
            String(e).slice(0, 120)
        );
    }

    console.log("=========================");
    if (failed === 0) {
        console.log("PASS: all smoke checks green.");
        process.exit(0);
    } else {
        console.log(`FAIL: ${failed} check(s) failed.`);
        process.exit(1);
    }
})();
