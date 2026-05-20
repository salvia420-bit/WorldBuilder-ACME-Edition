# Retail-Correctness Diagnostic Toolset — Team Agent Plan

**Status:** Draft, 2026-05-19. Owner: open. Predecessor / parent docs:
[`world-completeness-method.md`](world-completeness-method.md),
[`entity-completeness-method.md`](entity-completeness-method.md),
[`event-completeness-method.md`](event-completeness-method.md),
[`../external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md`](../external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md)
§12 (WB.Terminal as the C# absorption layer).

This document is a **team agent execution plan** for building a diagnostic-tool suite that proves the `emit-dynamic-site` browser AC client (`external/holtburger/apps/holtburger-web/`) is **retail-correct** along every axis that has a canonical oracle. Tools are launched from **WorldBuilder.Terminal's JSON command loop**, fanned out by parallel agent workers, and emit machine-readable reports that gate CI.

---

## 0. TL;DR

- **As of 2026-05-20: 13 of 14 surfaces validator-covered** (11 ✓ + 1 ◐ events follow-on + W3.A live-replay still post-W3.F refinement). Waves 1-5 all SHIPPED. `diag-run-all` is the capstone meta-command.
- `emit-dynamic-site` ships **12 retail-correctness validators** in tree: `validate_landblock_completeness.cjs`, `validate_event_completeness.cjs`, `validate_entity_classification.cjs`, `validate_wire_conformance.cjs`, `validate_dat_parity.cjs`, `validate_enum_parity.cjs`, `validate_motion_pose.cjs`, `validate_physics_replay.cjs`, `validate_cell_portal_graph.cjs`, `validate_skybox.cjs`, `validate_texture_decode.cjs`, `validate_mesh_parity.cjs`. Each rides a method doc + canonical oracle.
- **Gap:** ~8 more surfaces in the runtime have canonical oracles but no
  validator. Listing in §3. Most can be expressed as one `chorizite-*` / `diag-*`
  command in WB.Terminal + one matching `validate_*.cjs` in holtburger-web.
- **Strategic frame** (already established in CHORIZITE_PORTING_PLAN §12):
  **WB.Terminal = C# absorption layer for oracles** (Chorizite.DatReaderWriter +
  Chorizite.Common + ACPlugin + ACE source); **holtburger-web = runtime that
  these oracles judge**. Diagnostic tools live in WB.Terminal as JSON commands;
  holtburger-side capture scripts feed runtime data to them, or invoke them
  inline.
- **Execution model:** 5 parallel agent waves over ~7 surfaces. Each wave is
  one self-contained brick (~200-600 LOC C# + ~150 LOC JS validator + 1 method
  doc cross-link). §6 has the wave breakdown.
- **First brick** (Wave 1): wire-packet conformance — `chorizite-pack-message` +
  `chorizite-unpack-message` + Rust parity test harness. Already flagged in the
  porting plan §12.4. Unblocks the rest of the catalog.

---

## 1. Goal & non-goals

### Goal

A diagnostic suite launchable from **`WorldBuilder.Terminal --stdin`** that, for any retail-correctness claim made by `emit-dynamic-site`, can answer **YES / NO / DRIFT-WHERE** by comparing the client's behavior or output against a canonical oracle. Every claim is traceable to:

- a method doc that defines the contract,
- a canonical oracle (ACE source, Chorizite NuGet/source, retail
  `~/ac-headers/acclient.c`, real base DATs at `~/ac_base_dats/`, or live ACE
  on Tailscale),
- a deterministic test artifact (`bake-source.sha256` of inputs + JSON or
  JSONL of expected output),
- a machine-readable validator that's wired into CI.

### Non-goals

- **No new game features.** Diagnostic tools only. Anything that ships a JS class, a Rust crate, a wasm export, or a wire packet handler belongs in `CHORIZITE_PORTING_PLAN.md`, not here.
- **No procedural fallback in tools.** Same rule as the completeness methods: if the canonical oracle disagrees with the client, the tool flags the client. We never change the validator to make a renderer pass.
- **No DAT mutation.** Tools are read-only against `~/ac_base_dats/` (sha256s frozen — see §4.1).
- **No upstream changes to Chorizite / ACE / acclient.h.** We consume them; they don't consume us.

---

## 2. Subject + Oracles map

### Subject under test

`external/holtburger/apps/holtburger-web/` — the browser AC client. Specifically:

- **Wasm core**: `src/lib.rs` + workspace crates (`holtburger-protocol`,
  `holtburger-session`, `holtburger-world`, `holtburger-dat`, `holtburger-common`,
  `holtburger-scenery-bake`, `holtburger-event-bake`).
- **Runtime**: `scene3d/` (Three.js r184 + Bruneton atmosphere + EffectComposer
  + cell-portal graph + entities + particles + audio + lighting).
- **Plugin/UI layer**: `plugins/` (combat-bar, spellbook, vendor-ui,
  vitals-hud, world-objects/, …).
- **Dist artifacts**: `dist@ → /mnt/wbterminal2/holtburger-dist-v2/`
  (manifest, shards, scenery/spawns/events JSONL trees).

### Oracles (ranked by precedence per `feedback_three_source_cross_reference`)

1. **ACE server source** — `~/ace-server/Source/` (the active server
   implementation; rules ACE actually enforces).
2. **Retail decomp** — `~/ac-headers/{acclient.c, acclient.h,
   acclient_2013.bndb_pseudo_c.txt, acclient.txt}` (Hex-Rays + BN pseudo-C +
   PDB symbol dump of retail `acclient.exe`; the actual binary's behavior).
3. **Chorizite C# stack** — `external/chorizite/{ACPlugin, Chorizite.Common,
   Chorizite.ACProtocol}` + `external/DatReaderWriter/` (battle-tested C# port
   that injects into retail acclient.exe and is trusted by a live plugin
   ecosystem).
4. **Real base DATs** — `~/ac_base_dats/{client_portal.dat, client_cell_1.dat,
   client_local_English.dat, acclient.exe}` (the bytes themselves). SHA-256s
   (2026-05-19):
   - `client_portal.dat`   `dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4`  (884 MB)
   - `client_cell_1.dat`   `6db0abf00fbceed62c3f1ee842ee7c1f423d732bed77a5b7c102ee89a52ab99e`  (332 MB)
   - `client_local_English.dat`  `e85c820280c88fac7df6c8043f5e24596e9c8774193af4123d756546f78fb2bb`  (1 MB)
   - `acclient.exe`        (4.6 MB)
5. **Live ACE on Tailscale** — `100.116.47.66:9000` (per
   `project_emit_dynamic_site` memory; reproducible test fixtures land into
   `/mnt/wbterminal1/holtburger-captures/`).

### Tool absorption layer

**WorldBuilder.Terminal** — `WorldBuilder.Terminal/JsonCommandProcessor.cs`
(`BuildCommandHandlers()` registers ~147 commands today). Already imports
`Chorizite.Common` (ProjectReference, ≈8 enums dumped today) and
`Chorizite.DatReaderWriter` (NuGet). Already has the absorption pattern in
`CommandEngine.Chorizite.cs` (`chorizite-dump-enum-values`,
`chorizite-dump-world-object-taxonomy`, `chorizite-hash-string`,
`chorizite-dump-opcodes`). Adding a diagnostic command =

1. Add an engine method to a `CommandEngine.<Topic>.cs` partial,
2. Add a `CmdFoo` wrapper that adapts the JSON node → engine call,
3. Add a `["foo-name"] = CmdFoo` entry to `BuildCommandHandlers()` in
   `JsonCommandProcessor.cs`.

Pattern is ~50-150 LOC per command.

---

## 3. Diagnostic Surfaces — what we cover, what's gap

The runtime has 14 surfaces with a canonical oracle. Three already have a
shipped validator (`✓`). Eight are gaps (`⨯`). Three are partially covered
(`◐`). Each row cites the canonical oracle + the validator path.

| # | Surface | Status | Oracle | Validator (current or planned) |
|---|---|---|---|---|
| 1 | Placement completeness | ✓ | `ACE.Server/Entity/Scenery.cs` + `Landblock.init_buildings` + `LandblockInfo.objects` + ACE world DB | `validate_landblock_completeness.cjs` (Wave-1 placement validator already shipped, 13×13 ring) |
| 2 | Event completeness (sounds + particles) | ◐ | `Region.sound_info` + `AmbientSTBDesc` + `AnimationHook` + `PhysicsScript` + `GameMessageSound 0xF750` | `validate_event_completeness.cjs` (shipped). F.D-fu agent killed mid-flight 2026-05-20: F.D-fu1 `window.__synthGameMessageSound` helper NOT shipped (validator references it); F.D-fu2/3/4 partial (`ambient_runtime.js` + `entities.js` + probe params modified). Resume per `project_event_fdfu_partial_2026-05-20` follow-on. |
| 3 | Entity typed-class classification | ✓ | `external/chorizite/ACPlugin/API/WorldObject.cs:344-411` (`GetObjectClass`) | `validate_entity_classification.cjs` (56/56 + 48/48 cross-port; live capture with Item-fallback) |
| 4 | **Wire packet pack/unpack conformance** | ✓ | `external/chorizite/Chorizite.ACProtocol/` (vendored ProjectReference) | `validate_wire_conformance.cjs` + `chorizite-wire-{pack,unpack,list}-message-types` — Wave 1 SHIPPED 2026-05-19. 19/23 PASS + 4 documented SKIP. Method doc: [`wire-conformance-method.md`](wire-conformance-method.md). |
| 5 | **DAT parser parity (~20 file types)** | ✓ | `Chorizite.DatReaderWriter` NuGet v2.1.2 (53 generated DBObj types) + `~/ac_base_dats/` sha-pinned | `validate_dat_parity.cjs --phase=both` + `chorizite-{list-dat-records,parse-dat-record,list-dat-types}` + `cargo run --example parse_dat_record`. **Wave 2.A+2.B+2.D SHIPPED 2026-05-19**: Phase A 24/24 × 906/906 structural PASS; Phase B 11 PASS / 12 GAP / 1 FAIL (EnvCell `visibleCells[]` ordering drift — real cross-port divergence; Chorizite also returns null `cellId`/`portals` on many records). See [`dat-parity-method.md`](dat-parity-method.md). |
| 6 | Property/enum parity (66 enums: 65 `Chorizite.Common.Enums` + `ObjectDescriptionFlag`) | ✓ | `Chorizite.Common.Enums.*` (full allowlist) + `Chorizite.ACProtocol.Enums.ObjectDescriptionFlag` | `validate_enum_parity.cjs` + `enum-parity-report` — Wave 2.C SHIPPED 2026-05-19. Baseline 5 PASS / 16 FAIL / 45 GAP — drift surfaced (see [[feedback_enum_parity_audit_2026-05-19]]). Method doc: [`enum-parity-method.md`](enum-parity-method.md). |
| 7 | **Render-pose / coordinate-frame parity** | ✓ | `WorldBuilder.Shared` full-quaternion math vs Three.js yaw-only | `compare-render-corners` + `compare_render_corners.cjs` (shipped) |
| 8 | **Physics parity** (collision, jump, fall, on-ground, position interp) | ✓ | `~/ac-headers/acclient.c::CPhysicsObj` (1049 methods) + `~/ace-server/Source/ACE.Server/Physics/` + `acclient.h::PhysicsState` | **Jump-formula slice shipped 2026-05-19** (Wave 3.B): `physics-jump-formula` + `physics-jump-formula-sweep` ports `acclient.c:343343 CMotionInterp::get_jump_v_z` — 1000/1000 bitwise PASS, all 5 branches covered. **Live-replay infrastructure shipped 2026-05-19** (Wave 3.A): `physics-replay-trace` + `capture_physics_replay.cjs` + `validate_physics_replay.cjs` infrastructure complete. **Pure-prediction shadow shipped 2026-05-19** (Wave 3.F): `SessionHandle::get_last_client_prediction` / `set_last_client_prediction` wasm exports + JS rAF wiring + capture-script integration + `--subject=prediction` validator gate. **5-run baseline: 5/5 PASS** at maxDrift 0.04–0.09 m (≤0.10 m budget), meanDrift 0.007–0.009 m, onGroundMismatchCount 0/1025–1027. ~30× drift reduction vs W3.A baseline (was 2.81 m). Method doc: [`physics-parity-method.md`](physics-parity-method.md). |
| 9 | **Motion / swing-pose parity** | ✓ | `~/ac-headers/acclient.c::CMotionInterp` + ACE `MotionTable.cs` + 436 retail motion tables (already validated 0 violations) | **Wave 3.C + 3.E SHIPPED 2026-05-19**. `validate_motion_pose.cjs [--js-vs-cs]` + `motion-classify-swing` + `motion-inventory` + wasm `lookup_motion_link_for_swing` + JS `classifyMotionCommandTyped`. **150 C# cases: 52 PASS / 0 FAIL / 98 SKIP-w-reason. JS-vs-C# diff: 52/52 PASS** (target was ≥30/52). Method doc: [`motion-parity-method.md`](motion-parity-method.md). Helper bug surfaced: `motion_table.rs:65` `motion_data_for_link` masks `& MOTION_KEY_MASK` (0x000F_FFFF), strips 0x10/0x40 classifier prefix → silent retail lookup failure. W3.E exports bypass; helper fix is open follow-on. |
| 10 | **Texture / surface-chain decode parity** | ✓ | `Chorizite.DatReaderWriter` Surface chain + `WorldBuilder.Shared.Lib.Texture.RenderSurfaceImporter` (ported inline) | `validate_texture_decode.cjs` + `chorizite-decode-surface-chunk` + `chorizite-decode-texture-chain-chunk` — **Wave 4.A+B SHIPPED 2026-05-20**. **6,152/6,152 records PASS (100%)** across full Surface universe, 34s cold / sub-second warm. Fast-mode (Holtburg 81): 81/81. Cross-validates 2.5% solid-surface ratio. Method doc: [`texture-parity-method.md`](texture-parity-method.md). |
| 11 | **Mesh / triangulation parity** (GfxObj + SetupModel + EnvCell) | ✓ | WB.Terminal `obj-export` ground truth + ACE `EnvCell.cs` + retail `CGfxObj::*` | `validate_mesh_parity.cjs` + `mesh-vs-obj-export-chunk` + `env-cell-vs-setup-model-chunk` — **Wave 4.C+D SHIPPED 2026-05-20** (per agent report; integration via auto-splice pattern). Method doc: [`mesh-parity-method.md`](mesh-parity-method.md). |
| 12 | **Cell-portal graph + PVS visibility** | ✓ | WB.Terminal `validate-dungeon` + ACE `CellPortal` semantics + retail `CCellPortal::*` | `validate_cell_portal_graph.cjs` + `cell-portal-graph-sweep` + `pvs-visibility-snapshot` — **Wave 5.A SHIPPED 2026-05-20**. 99.98% portal symmetry across 175 LBs / 3,445 cells / 8,607 portals; 2 cross-wired portal pairs at LB 0xACB5 (retail content-build drift); 30 disconnected satellite cells documented as retail visible-from-window pattern. Method doc: [`cell-portal-method.md`](cell-portal-method.md). |
| 13 | **Skybox / atmosphere parity** | ✓ | `Region 0x13` (Chorizite DBObj parser) + AC `SkyDesc::CalcPresentDayGroup` + Clouds-C contract | `validate_skybox.cjs` + `region-skybox-snapshot` + `region-day-night-curve` — **Wave 5.B SHIPPED 2026-05-20**. 24/24 sampled game-times match within 1e-4 (measured maxDrift **2.1e-7**, three orders under budget). Method doc: [`skybox-parity-method.md`](skybox-parity-method.md). |
| 14 | **DAT integrity** (base-DAT-only, sha256, modder-id rejection) | ✓ | `~/ac_base_dats/` sha256s + `bake-source.sha256` sidecar | `scenery-bake` pre-flight + sidecar (shipped) |

The eight `⨯` rows + the four `◐` rows are this plan's scope. Each becomes a wave (§6).

---

## 4. Tool architecture

### 4.1 WB.Terminal command shape

All new diagnostic commands land in a new partial `CommandEngine.Diagnostics.cs` (alongside the existing `CommandEngine.Chorizite.cs`). One file per surface (e.g. `CommandEngine.WireConformance.cs`, `CommandEngine.PhysicsParity.cs`, …) keeps the partials manageable.

Each command follows the established pattern:

```csharp
// CommandEngine.WireConformance.cs (Wave 1 example)
public partial class CommandEngine {
    public sealed record WirePackResult(
        string MessageType, string HexBytes, int ByteLen, string Sha256);

    public WirePackResult ChoriziteWirePackMessage(string typeName, JsonNode fields) {
        // Use Chorizite.ACProtocol's source-generated serializer
        // (or, if not yet ProjectReferenced, regex-parse the generated .cs).
        // Return canonical bytes + sha256 for golden-file diff.
    }
}
```

```csharp
// JsonCommandProcessor.cs — new dispatch entries
["chorizite-wire-pack-message"]   = CmdChoriziteWirePackMessage,
["chorizite-wire-unpack-message"] = CmdChoriziteWireUnpackMessage,
```

Each handler returns the canonical
`{"success": true, "command": "<name>", ... payload ... }` envelope. Failures
carry an `error` field. Standard ~50-150 LOC per command.

### 4.2 holtburger-side validator shape

Mirrors the three shipped validators (`validate_landblock_completeness.cjs`,
`validate_event_completeness.cjs`, `validate_entity_classification.cjs`).
Common shape:

```javascript
// validate_<surface>.cjs
// 1. Boot the renderer via Playwright (or headless capture if simpler).
// 2. Drive it through a probe scenario (login → spawn → walk path).
// 3. Snapshot client state (window.__hb*, window.live*, snapshotEventLog, ...).
// 4. For each subject row, spawn a WB.Terminal subprocess with the
//    appropriate chorizite-* / diag-* command. Compare client vs oracle.
// 5. Emit JSON report at /mnt/wbterminal1/holtburger-validator-reports/<ts>/.
// 6. Exit 0 on PASS, 1 on coverage/drift, 2 on infra error.
```

Subprocess pattern (already used by `compare-to-retail` which subprocesses
a Python script): C# `System.Diagnostics.Process` from inside an engine
method, OR Node-side `child_process.spawn` of
`$DOTNET_ROOT/dotnet WorldBuilder.Terminal.dll --stdin`. **Use Node-side
spawn** for new validators — the bidirectional JSON-stdin loop is cheap to
drive from `node` and avoids re-entrancy headaches inside WB.Terminal.

### 4.3 Shared utilities (new)

A small `WorldBuilder.Terminal/Diagnostics/` directory:

- `DiagnosticsReport.cs` — common JSON envelope shape `{ surface, oracle,
  subject, summary, mismatches[], outputPath }`. Used by every diagnostic
  command for consistent CI consumption.
- `DiagnosticsPaths.cs` — well-known scratch dirs (`/mnt/wbterminal1/tmp/...`)
  + `/mnt/wbterminal1/holtburger-validator-reports/<ts>/` enforcer per
  [[feedback_use_external_drives_for_scratch]].
- `OracleFixtureCache.cs` — sha256-keyed cache of oracle outputs so a CI
  re-run doesn't re-bake against canonical DATs every time.

Each validator is identified by `surface` (one of the rows in §3) +
`subject_sha256` (the hash of the inputs being tested — typically a renderer
build sha + a DAT sha pair).

### 4.4 CI gate format

Each validator emits a top-level `report.json` like:

```json
{
  "surface": "wire-conformance",
  "oracle": { "kind": "chorizite-acprotocol", "version": "..." },
  "subject": { "kind": "holtburger-web", "git_sha": "..." },
  "bake_source_sha256": "...",
  "summary": { "checked": 123, "pass": 121, "fail": 2, "skipped": 0 },
  "mismatches": [
    { "case": "GameMessage::Login", "field": "version", "expected": 1, "actual": 0 }
  ],
  "outputPath": "/mnt/wbterminal1/holtburger-validator-reports/2026-05-19T19-30-00Z/wire-conformance/"
}
```

A single top-level `run-all-validators.cjs` script invokes each validator,
collects reports, and exits non-zero if any one fails. Maps cleanly into a
GitHub Action / pre-commit hook (deferred — same caveat as the entity-completeness E.D CI hook in `entity-completeness-method.md`).

---

## 5. New WB.Terminal command surface (full list)

In rough order of dependency. Each row: command name → topic partial → ~LOC →
which wave it ships in.

| # | Command | Partial | LOC | Wave |
|---|---|---|---|---|
| 1 | `chorizite-wire-pack-message` | WireConformance | 80 | 1 |
| 2 | `chorizite-wire-unpack-message` | WireConformance | 80 | 1 |
| 3 | `chorizite-wire-dump-opcode-handlers` | WireConformance | 60 | 1 |
| 4 | `chorizite-parse-dat-record` | DatParity | ~470 (file total — partial) | 2 ✓ (shipped 2026-05-19) |
| 5 | `chorizite-list-dat-records` | DatParity | (see row 4) | 2 ✓ (shipped 2026-05-19) |
| 5a | `chorizite-list-dat-types` (added during W2.AB) | DatParity | (see row 4) | 2 ✓ (shipped 2026-05-19) |
| 6 | `chorizite-extract-fixture-bytes` (superseded by seeds.json) | DatParity | — | deferred to Wave 2.D |
| 7 | `enum-parity-report` | EnumParity | ~410 | 2 (shipped 2026-05-19) |
| 8 | `physics-replay-trace` | PhysicsParity | 200 | 3 |
| 9 | `physics-aabb-vs-acclient` | PhysicsParity | 120 | 3 |
| 10 | `physics-jump-formula` + `physics-jump-formula-sweep` | PhysicsParity | ~265 (shipped) | 3.B ✓ (shipped 2026-05-19) |
| 11 | `motion-classify-swing` + `motion-inventory` | MotionParity | ~340 (shipped) | 3.C ✓ (shipped 2026-05-19) |
| 12 | `motion-table-anim-hooks` | MotionParity | 120 | 3.D (deferred) |
| 13 | `chorizite-decode-surface-chunk <start> <end>` | TextureParity | 180 | 4 |
| 14 | `chorizite-decode-texture-chain-chunk <start> <end>` | TextureParity | 120 | 4 |
| 15 | `mesh-vs-obj-export-chunk <start> <end>` | MeshParity | 180 | 4 |
| 16 | `env-cell-vs-setup-model-chunk <start> <end>` | MeshParity | 140 | 4 |
| 17 | `wave4-status` (sweep progress + cache hit rate) | TextureParity | 60 | 4 |
| 18 | `wave4-sweep --reset` / `--resume` (orchestrator hook) | TextureParity | 60 | 4 |
| 19 | `cell-portal-graph-sweep` | CellPortalGraph | ~330 (shipped) | 5.A ✓ (shipped 2026-05-20) |
| 20 | `pvs-visibility-snapshot` | CellPortalGraph | (see row 19) | 5.A ✓ (shipped 2026-05-20) |
| 21 | `region-skybox-snapshot` | Skybox | ~620 (file total — partial) | 5.B ✓ (shipped 2026-05-20) |
| 22 | `region-day-night-curve` | Skybox | (see row 21) | 5.B ✓ (shipped 2026-05-20) |
| 23 | `diag-run-all` + `diag-status` | Diagnostics/RunAll | ~470 C# + ~590 Node (shipped) | 5.C ✓ (shipped 2026-05-20) |

Approximate **2,580 LOC of C#** + **~1,400 LOC of Node** (8 validators ×
~150 LOC each + Wave 4 chunk orchestrator at ~200 LOC + `diag-run-all` driver).
All additive; no refactors.

---

## 6. Execution plan — 5 parallel agent waves

The bricks below are sized for one agent each, ~1-3 hours of focused work. Each agent has a self-contained brief, a concrete file:line target, an acceptance test, and a method-doc cross-link.

### Wave 1 — Wire-packet conformance (1 brick, unblocks 2,3,4,5)

**Why first:** every other validator wants to verify the wire bytes the
client emits / consumes against ACE. A bidirectional pack/unpack oracle is
the prerequisite. CHORIZITE_PORTING_PLAN §12.4 already lists this as the
next absorption candidate.

| Brick | Status | Files touched | Acceptance / Outcome |
|---|---|---|---|
| **W1.A0 — ProjectReference spike** | ✓ SHIPPED 2026-05-19 | `WorldBuilder.Terminal.csproj` | Clean spike: +1 MB delta (118→119 MB), no RmlUi/Lua/Autofac/Silk/NAudio. ProjectReference kept. Memory: [[reference_chorizite_acprotocol_dep_graph_2026-05-19]]. |
| **W1.A — Land the chosen path** | ✓ SHIPPED 2026-05-19 | `WorldBuilder.Terminal.csproj` | `dotnet build WorldBuilder.Terminal -c Release` clean (0 errors). ProjectReference path active. |
| **W1.B — `chorizite-wire-pack-message`** | ✓ SHIPPED 2026-05-19 (~150 LOC) | `CommandEngine.WireConformance.cs`, `JsonCommandProcessor.cs:304` | Reflection-based pack via Chorizite's `Write(BinaryWriter)`. Auto-infers ActionType/EventType from subclass name. Normalize-stream handles Chorizite's Seek-based align-pad. |
| **W1.C — `chorizite-wire-unpack-message`** | ✓ SHIPPED 2026-05-19 (~80 LOC) | same partial | Reverse direction; save-restore action/event header to survive subclass `base.Read` overwrite. Auto-roundtrips and reports byte diff. |
| **W1.D — `validate_wire_conformance.cjs`** | ✓ SHIPPED 2026-05-19 (~420 LOC) | `apps/holtburger-web/validate_wire_conformance.cjs` | 23 fixtures: **19 PASS, 0 FAIL, 4 SKIP** (each SKIP is a documented Wave-2 follow-on — see method doc §"The 4 SKIPs"). Report: `/mnt/wbterminal1/holtburger-validator-reports/wire-conformance/<ts>/report.json`. Exit 0. |
| **W1.E — `wire-conformance-method.md`** | ✓ SHIPPED 2026-05-19 | `docs/wire-conformance-method.md` | Sibling to the three completeness methods. Cross-links into CHORIZITE_PORTING_PLAN §12.4 + memory entries. |
| **W1.F (bonus) — `chorizite-wire-list-message-types`** | ✓ SHIPPED 2026-05-19 (~40 LOC) | same partial | Discoverability helper — 349 concrete ACProtocol message types resolvable via reflection. Authoring-time fixture validation. |

**Dispatch:** 1 agent — shipped in one focused session.
**4 documented Wave-2 follow-ons** (the W1.D SKIPs, each is a real
Rust-vs-Chorizite divergence Wave 1 was designed to surface):
1. `Ordered_GameEvent` wrapper dispatch (needs opcode-driven peek into wrapped event subtype).
2. `Movement_TurnToObject` naming gap (Chorizite vs Rust crate field-shape).
3. `Movement_Jump` extra-fields divergence (Rust appends `object_guid+spell_id` not in Chorizite `JumpPack`).
4. `Object_SendForceObjdesc` as `0xF7B1+0xC8` (Rust) vs `0xF6EA` top-level (Chorizite).

### Wave 2 — DAT parser parity + enum parity (3 bricks, parallel)

**Why next:** the DAT parsers + enums are the most leverage. Once we know
our Rust DAT parsers byte-equal Chorizite.DatReaderWriter, every downstream
diagnostic can lean on the parser output instead of re-deriving from raw
bytes.

| Brick | Owner | Files touched | Acceptance |
|---|---|---|---|
| **W2.A — `chorizite-parse-dat-record`** | 2026-05-19 ✓ | `CommandEngine.DatParity.cs` (~470 LOC partial), `JsonCommandProcessor.cs` (3 dispatch entries spliced) | All 24 holtburger-dat parser types resolve + parse via Chorizite oracle. Tested against 906 sampled records from base DATs (`dc6e500b…` portal, `6db0abf0…` cell). 0 parser exceptions. |
| **W2.B — `validate_dat_parity.cjs`** | 2026-05-19 ✓ | `apps/holtburger-web/validate_dat_parity.cjs` (~290 LOC node), `apps/holtburger-web/fixtures/dat/seeds.json` (24 types × N samples, sha-mod-N deterministic), `apps/holtburger-web/fixtures/dat/generate_seeds.cjs` (~190 LOC) | **Shipped**: 24/24 types PASS · 906/906 records PASS · DAT SHAs match. Exit 0. Surprising drift caught + fixed: `AC1LegacyPStringBase<byte>` used as dictionary key in `ChatPoseTable.ChatPoses` — refused by `System.Text.Json` without a custom `JsonConverterFactory`. Now handled by `StringBaseConverterFactory`. Field-level Rust-vs-Chorizite comparison deferred to W2.D (Rust crates need `#[derive(Serialize)]` on `binrw`-derived types). |
| **W2.C — Expand `chorizite-dump-enum-values` allowlist** to 66 (full coverage of `Chorizite.Common.Enums` + `ObjectDescriptionFlag`) + add `enum-parity-report` that diffs against `holtburger-common` / `holtburger-protocol` enum values. Cross-port harness pipes int values through both sides; reports mismatches. | 2026-05-19 ✓ | `CommandEngine.Chorizite.cs:CuratedEnumAllowlist` (11→66), new `CommandEngine.EnumParity.cs` (413 LOC), new `validate_enum_parity.cjs` (324 LOC), regen `data/chorizite/chorizite-common-enums.json` (9→66 enums), `docs/enum-parity-method.md` (220 LOC) | **Shipped**: 66 enums checked → 5 PASS / 16 FAIL / 45 GAP. Most surprising drift: `MotionStance` in `holtburger-protocol/src/messages/movement/types.rs` OR'd `0x80000000` (combat-mode-active high bit) into every Chorizite value. 16 FAIL rows + 45 GAP rows bucketed in [[feedback_enum_parity_audit_2026-05-19]] → Wave 2.D tickets. |
| **W2.D — Rust serde-Serialize derives + `parse_dat_record` example binary + Phase-B field-tree diff** | 2026-05-19 ✓ | `crates/holtburger-dat/src/{file_type/*,graphics,physics,landblock}.rs` (~50 `#[derive(Serialize)]` adds across 26 files), `crates/holtburger-dat/examples/parse_dat_record.rs` (~290 LOC), `validate_dat_parity.cjs` extended (~290 → ~620 LOC) | **Shipped**: Phase B = 11 PASS / 12 GAP / 1 FAIL. The 1 FAIL is real: EnvCell `visibleCells[]` ordering drift on `0x72040335` (Rust `[5,1,667,...]` vs Chorizite `[811,810,812,...]`); Chorizite also returns `cellId: null` / `portals: null` on many EnvCell records — DBObj property graph incomplete. 194 holtburger-dat tests still pass post-derive. Other findings: System.Text.Json u32→i32 quirk (handled); DRW property graph elides wire bits in Surface/SurfaceTexture/Environment/RenderSurface (tagged `chorizite-zeroed`); count-fields re-derived by DRW (exempt). Open follow-on: fix EnvCell FAIL by inspecting `acclient.c::CEnvCell::UnPack`. |
| **W2.E (open follow-on, opened by W3.E discovery) — fix `motion_data_for_link` helper mask** | open | `crates/holtburger-dat/src/file_type/motion_table.rs:65` — drop the `& MOTION_KEY_MASK` (0x000F_FFFF) that strips 0x10/0x40 classifier prefix and silently fails retail-data link lookups | Helper currently bypassed by W3.E's wasm exports (which call `mtable.links.get(outer)?.get(&command)` directly). Audit other call sites before changing. ~30 LOC, low risk. |

**Dispatch:** 3 agents in parallel (A+B together; C standalone; D last as integrator). Estimated 4-6 hours.

### Wave 3 — Physics + motion parity (2 bricks, parallel)

**Why now:** the two surfaces most likely to have silent drift. Physics
constants like jump_extent (acclient.c:343343) and the per-tick collision
loop are tightly coupled with the renderer; motion-table swing classifier is
documented as ~70 LOC of "missing wiring" per [[project_holtburger_motion_table_combat_path]].

**Prerequisite (W3 setup) — SHIPPED 2026-05-19** (see [[project_wave3_prereq_2026-05-19]]):
- ACE.Server is **local on this box** at UDP `0.0.0.0:9000/9001` (pid 10540).
  `100.116.47.66` is the local Tailscale (`tailscale0`) interface, not a
  remote host. holtburger-wsbridge is running on `127.0.0.1:8080`.
- `phaseN_diag` account auto-created at accessLevel = 4 (Developer);
  `Config.js` `DefaultAccessLevel: 4` makes fresh accounts Developer at
  creation. Credentials: `phaseN_diag` / `phaseN_diag`.
- Wasm PingRequest keepalive wired as third `tokio::select!` arm in
  `apps/holtburger-web/src/lib.rs::recv_loop` (~line 17385); 5s cadence
  gated on `LoopState::InWorld` + `last_send_time.elapsed() > 5s`.
- **Correction to the original assumption:** the keepalive does NOT fix the
  rapid-relog ghost-session quirk — that's an account-lock invariant.
  Keepalive only prevents mid-session timeouts (ACE
  `DefaultSessionTimeout = 60s`). **Wave 3.A must rotate per-run accounts**
  (`phaseN_diag_001 … phaseN_diag_NNN`); the Developer-default makes
  auto-creation cheap.

| Brick | Owner | Files touched | Acceptance |
|---|---|---|---|
| **W3.A — `physics-replay-trace`** (live-ACE) — login to local ACE via Playwright as `phaseN_diag_<runId>` (rotating per run); capture per-tick trace from `window.__predLastPos` / `__predFirstPos` / `__predTickCount`; replay through C# port of `acclient.c::CPhysicsObj::*` predicates; compare per-tick. | **SHIPPED 2026-05-19 (infrastructure + W3.F follow-on)** | `CommandEngine.PhysicsParity.cs` (extended +400 LOC + W3.F +200 LOC), `apps/holtburger-web/fixtures/physics/probe-scenario.json`, `capture_physics_replay.cjs`, `validate_physics_replay.cjs`, `JsonCommandProcessor.cs` dispatch | Infrastructure stable across 5 consecutive runs. Initial W3.A baseline maxDrift 2.81-2.89 m (server-reconciliation drift confounding signal). **W3.F follow-on (pure-prediction shadow) closed the gap**: see `W3.F` row below. |
| **W3.F (follow-on) — Pure-prediction shadow + tick-count-driven sub-stepping** — wasm exports `SessionHandle::get_last_client_prediction` / `set_last_client_prediction`; JS rAF integrator pushes per-frame prediction (position, velocity, on_ground, tick_count, t_ms) BEFORE `PublicUpdatePosition` arm overwrites; capture script captures both signals; validator's C# oracle reads `--subject=prediction` via `JsonCommandProcessor` and applies tick-count-driven sub-stepping + velocity-derived effective dt. | **SHIPPED 2026-05-19** | `external/holtburger/apps/holtburger-web/src/lib.rs` (+~200 LOC: `ClientPredictionFrame` + `LastClientPredictionJs` + getter/setter + `SessionHandle` field), `index.html:7330-7445` (rAF integrator → wasm shadow push), `capture_physics_replay.cjs` (+W3.F probe + prediction column in trace rows), `validate_physics_replay.cjs` (`--subject=prediction` CLI), `CommandEngine.PhysicsParity.cs` (+`PredictionPos`/`PredictionVel`/`PredictionOnGround` on `PhysicsTraceRow`, +`SubjectSignal`/`PredictionRowCount` on result, +sub-step accounting, +velocity-derived effective dt, +initial-heading seed, +walk→release boundary fix, +jump-phase z-arc quirk suppression), `JsonCommandProcessor.cs` (+`subjectSignal` field on `CmdPhysicsReplayTrace`). | **5/5 PASS** on baseline cohort. maxDrift 0.0403–0.0912 m (≤0.10 m budget). meanDrift 0.0071–0.0086 m. onGroundMismatchCount 0/1025–1027 each run. **~30× drift reduction vs W3.A**. 5-run cohort under `/mnt/wbterminal1/holtburger-validator-reports/physics-replay/2026-05-20T02-*_w3f_bl_run{1..5}_*/`. Re-validatable in seconds (no recapture needed) via `SKIP_CAPTURE=1 PHYSICS_REPLAY_SUBJECT_TRACE=<path>/trace-subject.json`. |
| **W3.B — `physics-jump-formula`** | **SHIPPED 2026-05-19** | `CommandEngine.PhysicsParity.cs` (~265 LOC), `docs/physics-parity-method.md` | **1000/1000 cases bitwise deterministic**. All 5 branches covered (zero=2, no-weenie=332, weenie-success=1000, weenie-fail=333, +clamped variants). Wasm-side bitwise comparison **deferred** — our holtburger `compute_jump_velocity_z` ports ACE *server* formula (`MovementSystem.GetJumpHeight`); W3.B C# port is retail *client* formula (`CMotionInterp::get_jump_v_z`). Different layers; method doc §"Scope honesty" documents the divergence. |
| **W3.C — `motion-classify-swing`** | **SHIPPED 2026-05-19** | `CommandEngine.MotionParity.cs` (~340 LOC), `validate_motion_pose.cjs` (~370 LOC), `docs/motion-parity-method.md` | **150 cases → 52 PASS / 0 FAIL / 98 SKIP-w-reason** (100% pass+skip vs ≥80% target). Per-stance: SwordCombat 18/72, Magic 4/26, BowCombat 30/0. All 5,455 retail link entries deterministically resolvable. **Load-bearing port bug caught + fixed during smoke**: `MotionCommandData.MotionData` inner-dict keys are FULL 32-bit MotionCommand (e.g. `SlashHigh = 0x1000005B`), NOT low-16 substate. Spec docs + Rust probe both `& 0xFFFF` when classifying; DRW C# reads raw int. See [[project_wave3bc_done_2026-05-19]]. JS-vs-C# cross-port comparison deferred to W3.E. |
| **W3.D — Method docs** | **SHIPPED 2026-05-19** | `docs/physics-parity-method.md`, `docs/motion-parity-method.md` | Both shipped; cross-linked from CHORIZITE_PORTING_PLAN §4-Alt + Wave 3 memory entries. |
| **W3.E (new follow-on) — Rust port of swing classifier + wasm export** | open | `apps/holtburger-web/src/lib.rs` (add `lookup_motion_link_for_swing` ~140 LOC), `scene3d/entities.js:304` widen `classifyMotionCommand`, `holtburger-common/src/properties/motion.rs` | Validator transitions from oracle-only to JS-vs-C# diff; ≥30 of the 52 current PASS rows additionally pass on JS side. |

**Dispatch:** 2 agents in parallel (A+B sequential under one agent; C standalone). Estimated 5-8 hours.

### Wave 4 — Texture + mesh parity (whole-DAT sweep — 4 bricks, parallel)

**Why:** every visible-fidelity claim depends on Surface / Texture / GfxObj
chains being byte-identical with retail. Per user decision: **whole-DAT
sweep, not a sample.** ~15,318 retail GfxObjs + every Surface every Texture
referenced from them. Multi-hour first-pass; therefore runs **out-of-band**
of `diag-run-all` (Wave 5.C does not block on Wave 4).

**Architecture (different from earlier waves):**
- **Sha-keyed result cache** at `/mnt/wbterminal1/holtburger-validator-fixtures/wave4/<surface_sha>.json`. Each Surface / GfxObj is keyed by sha256 of its raw DAT bytes. Re-runs only validate sha-changed records — base DATs are immutable per [[feedback_base_dats_only_for_bake]], so steady-state runs are O(0).
- **Chunked execution.** Split the 15,318 records into ~30 chunks of ~500; each chunk is one `chorizite-decode-surface-chunk <start> <end>` invocation. Resumable: chunks emit `progress.json` to the result dir, run-all skips completed chunks on resume.
- **Parallel chunk dispatch.** Up to 4 chunks in flight at once (matches the Explore-agent pattern that built this plan). Bounded by WB.Terminal stdin loop throughput.
- **CI gate sub-mode.** Wave 5.C's `diag-run-all` accepts `--wave4-mode=fast|full`. `fast` runs only the 81 Holtburg-known models (sub-second feedback for per-commit signal). `full` is the out-of-band whole-DAT sweep, runnable via `diag-run-all --wave4-mode=full` and reads from the sha-cache for warm runs.

| Brick | Owner | Files touched | Acceptance |
|---|---|---|---|
| **W4.A — `chorizite-decode-surface-chunk` + W4.B `chorizite-decode-texture-chain-chunk`** | ✓ SHIPPED 2026-05-20 | `CommandEngine.TextureParity.cs` (~700 LOC), `validate_texture_decode.cjs` (~430 LOC), `docs/texture-parity-method.md` | **6,152/6,152 records PASS (100%)** across full Surface universe; 34s cold / sub-second warm. Fast-mode (Holtburg 81): 81/81. Cache 131 MB / 6,147 unique surface shas. Pixel-format histogram: PFID_INDEX16 48.4% + PFID_DXT1 32.3%. Cross-validates 2.49% solid-surface ratio from `phase-3-renderer.md:834`. |
| **W4.C — `mesh-vs-obj-export-chunk` + W4.D `env-cell-vs-setup-model-chunk`** | ✓ SHIPPED 2026-05-20 (agent killed during final summary; build clean, dispatch wired) | `CommandEngine.MeshParity.cs`, `validate_mesh_parity.cjs`, `docs/mesh-parity-method.md`, `fixtures/mesh/` | GfxObj + SetupModel + EnvCell chunked sweep. Allowlist note: EnvCell `visibleCells[]` ordering drift on `0x72040335` — Rust correct per [[project_envcell_visiblecells_investigation_2026-05-20]]; the env_cell.rs:91+100 flag-mask bug (0x01/0x02 vs 0x02/0x08) surfaced in follow-ons bundle may close W2.D EnvCell FAIL when fixed. |
| **W4.E — Sweep orchestrator (`wave4-status` + `wave4-sweep`)** | ✓ SHIPPED 2026-05-20 | `scripts/wave4_sweep.cjs` (~870 LOC), `CommandEngine.Wave4.cs` (~430 LOC) | 4-wide parallel chunk dispatch, sha-cache resumable, graceful detect-and-skip when sibling chunk commands absent. Smoke: empty-cache 4 INFRA / ~75s; warm re-run cached=4 / ~50ms. `dotnet <dll>` launch (apphost can't find libhostfxr.so under SDK 10.0.203); long-lived workers; EPIPE-on-stdin swallower. |
| **W4.F — Update `texture-parity-method.md` + `mesh-parity-method.md`** | open | two new docs | cross-links; document the sha-cache contract |

**Dispatch:** 3 agents in parallel (A+B together; C+D together; E+F standalone). First-pass run is the long-tail item; subsequent dev-loop runs piggy-back on the cache. **Wave 4 must NOT block subsequent waves** — Wave 5 can start in parallel using the `--wave4-mode=fast` Holtburg subset for its smoke.

Estimated build-out: 6-8 hours engineering + 6 hours first-pass sweep (overlap).

### Wave 5 — Cell-portal graph + skybox + meta (3 bricks, parallel)

**Why last:** these depend on the bake artifacts from earlier waves being
trustworthy. Once they ship, the suite is complete.

| Brick | Owner | Files touched | Acceptance |
|---|---|---|---|
| **W5.A — `cell-portal-graph-sweep` + `pvs-visibility-snapshot`** | ✓ SHIPPED 2026-05-20 | `CommandEngine.CellPortalGraph.cs` (~330 LOC), `validate_cell_portal_graph.cjs` (~280 LOC), `docs/cell-portal-method.md` | **99.98% portal symmetry** across 175 LBs / 3,445 cells / 8,607 portals. **5/5 PVS spot-checks PASS**. 2 cross-wired portal pairs at LB 0xACB5 (retail content-build drift — engine routes around via depth-∞ baked VisibleCells). 30 disconnected satellite cells documented as retail visible-from-window pattern. First checker for cross-record graph invariants. |
| **W5.B — `region-skybox-snapshot` + `region-day-night-curve`** | ✓ SHIPPED 2026-05-20 | `CommandEngine.Skybox.cs` (~620 LOC), `validate_skybox.cjs` (~520 LOC), `docs/skybox-parity-method.md` | **24/24 sampled game-times match within 1e-4** across 5 DayGroup uniforms. Measured maxDrift **2.1e-7**. Per-uniform: ambient 2.1e-7, sunPosition 1.1e-7, skyBottom 4.1e-8, skyTop 3.9e-8, fog 5.7e-10. Sky-K.6 finding: 5-uniform contract no longer consumed by cloud raymarch (Bruneton tables) but still drives `sky_lighting.js::_applyState`. |
| **W5.C — `diag-run-all` + `diag-status`** | ✓ SHIPPED 2026-05-20 | `WorldBuilder.Terminal/Diagnostics/RunAll.cs` (~470 LOC), `run-all-validators.cjs` (~590 LOC), `docs/diagnostic-toolset-method.md` | Single invocation drives all 10 validators. Smoke run 2 (post-sibling-landing): **6 PASS / 4 SKIP_CLI / 0 FAIL / 0 INFRA, exit 0**. Aggregate envelope at `<ts>/aggregate.json` + `<ts>/summary.md` + per-surface logs. `--wave4-mode=fast\|full` plumbed (no-op until Wave 4 ships). Manual gate only per §9 q4. |
| **W5.D — Plan + method-doc updates** | ✓ SHIPPED 2026-05-20 | this file + `diagnostic-toolset-method.md` | All Wave 5 status flips applied; §3 row 12+13 → ✓; cross-links live. |

**Dispatch:** 3 agents in parallel. Estimated 4-6 hours total.

---

## 7. Sequencing + dependencies

```
Wave 1 (1 agent)            ─►  unblocks Wave 4 (wire fixtures for texture decode)
                            └►  unblocks Wave 5.A (portal graph fixtures)
Wave 2 (3 agents parallel)  ─►  unblocks Wave 3 (physics needs DAT parity for landblock height)
                            └►  unblocks Wave 4 (mesh needs DAT parity for GfxObj)
                            └►  unblocks Wave 5 (skybox needs DAT parity for Region)
Wave 3 (2 agents parallel)  ─►  unblocks Wave 5.A (cell-portal needs physics for traversal)
Wave 4 (3 agents parallel)  ─►  RUNS OUT-OF-BAND. Engineering blocks on W2; first-pass
                                 sweep runs as a long-lived background job. `diag-run-all
                                 --wave4-mode=fast` (Holtburg 81-model subset) is the
                                 fast-feedback variant Wave 5.C ships with.
Wave 5 (3 agents parallel)  ─►  final integration; uses Wave 4 fast-mode only
```

**Critical path:** Wave 1 → Wave 2 (DAT parity) → Wave 5.C (`diag-run-all`). Wave 4 first-pass sweep runs after engineering lands but is **not on the gating path** for declaring the toolset shipped.

---

## 8. Reporting + storage conventions

Per [[feedback_use_external_drives_for_scratch]] + [[reference_external_drive_layout]]:

- Validator output: `/mnt/wbterminal1/holtburger-validator-reports/<ISO-ts>/<surface>/report.json` + supporting artifacts.
- Oracle fixtures (re-used across runs): `/mnt/wbterminal1/holtburger-validator-fixtures/<surface>/<sha256>.json` (sha-keyed by the input bytes they baked from).
- Scratch: `/mnt/wbterminal1/tmp/claude-scratch/diagnostics/`.

`bake-source.sha256` discipline: each report carries the sha256 of the DAT bundle it was baked against. Reports baked against different DATs are stored side-by-side; the aggregator refuses to compare them.

---

## 9. Coverage honesty + open questions

Following CHORIZITE_PORTING_PLAN §10's pattern, what this plan explicitly does NOT cover:

- **Server-authoritative state** — combat damage resolution, magic cast resolution, treasure rolls. These live on ACE; the client just receives the result. Outside scope.
- **Per-frame perf budgets** — drawcalls, GPU mem, frame budget. Phase A7/C6/C7 telemetry already covers this per [[project_fps_perf_validation_2026-05-19]]; orthogonal axis.
- **Network jitter / packet loss recovery** — wire-conformance Wave 1 covers payload correctness, not transport robustness.
- **User-facing UX** (combat-bar layout, hotkey rebinds, etc.) — UX is a separate review.
- **Modder DATs** — `bake-source.sha256` discipline rejects them at bake time; out of scope here.
- **Live multiplayer interactions** — two-client convergence is a separate test surface.

**Resolved (user, 2026-05-19):**

1. **`Chorizite.ACProtocol` path → Spike ProjectReference first.** Before
   committing to the regex-parse fallback, do a 30-min spike: add the ref to
   `WorldBuilder.Terminal.csproj`, see what the dep-graph pulls. If clean,
   full pack/unpack works for Wave 1. If RmlUi.Net / Lua / Autofac creep in,
   fall back to the regex-parse pattern (`CommandEngine.Chorizite.cs:147-150`)
   or vendor a slim subset.
2. **Wave 3 physics replay → Live ACE on Tailscale `100.116.47.66:9000`.**
   Use a dedicated `phaseN_diag` account; wire PingRequest keepalive (cli
   pattern: `crates/holtburger-core/src/client/runtime.rs::should_send_keepalive_ping`)
   to prevent ghost-session pile-up (per [[project_emit_dynamic_site]]
   "Ghost-session quirk"). Real wire data per
   [[feedback_ground_in_real_wire_data]].
3. **Wave 4 sample → ALL ~15,318 retail GfxObjs.** Not a CI-gate sample;
   whole-DAT sweep. Architecture revised (§6 Wave 4 below): chunked +
   resumable + sha-keyed result cache. Multi-hour first-pass; subsequent runs
   only re-validate sha-changed records. Wave 4 does NOT block `diag-run-all`'s
   per-commit path — it runs out-of-band.
4. **Wave 5 `diag-run-all` → Manual gate only.** Single invocation from
   WB.Terminal stdin (`node run-all-validators.cjs`). No pre-commit hook, no
   nightly cron, no PR blocker on first ship. Wiring into automation is a
   deferred follow-on, same precedent as
   `entity-completeness-method.md` §E.E.

---

## 10. Memory cross-references

This plan touches the following memory entries; updates should land back into them:

- [[reference_worldbuilder_terminal]] — add new command catalog rows
- [[project_emit_dynamic_site]] — add validator section
- [[project_world_completeness_method]] — sibling validator pattern
- [[feedback_three_source_cross_reference]] — confirms the oracle ranking we use
- [[reference_ac_re_artifacts]] — physics + motion oracle source
- [[feedback_ground_in_real_wire_data]] — informs Wave 1 wire conformance
- [[feedback_base_dats_only_for_bake]] — informs §4 + §8 sha discipline
- [[feedback_use_external_drives_for_scratch]] — report storage path
- [[reference_ac_dat_file_types]] — Wave 2 DAT parity coverage list
- [[project_motion_table_audit_2026-05-19]] — Wave 3.C foundation
- [[project_chorizite_porting_plan_2026-05-19]] — parent plan (§12.4 added commands)

---

## 11. How a future agent picks this up

If you're the executor on a wave:

1. Read §1-§4 (10 min) for the framing.
2. Find your wave in §6 — your brick's row has the file:line target, the
   acceptance test, the partial it lives in.
3. Read the **canonical oracle** for your surface (cited in §3).
4. Read the existing validator from one of the three shipped completeness
   methods (`validate_landblock_completeness.cjs` is a good model).
5. Implement the command + the validator + the method doc. Don't skip the
   doc — it's the contract.
6. Land a PR. Update §6 to mark the brick `✓`. Update the parent memory
   entries.

---

*End of plan body. Appendix A below carries the concrete file:line targets that scoping agents pulled on 2026-05-19. Owner: open. Status: brief, pending execution.*

---

## Appendix A — Concrete file:line targets (scoped 2026-05-19 by 4 parallel Explore agents)

### A.1 WB.Terminal extension surface (`JsonCommandProcessor` + `CommandEngine`)

- **Dispatch table:** `WorldBuilder.Terminal/JsonCommandProcessor.cs:151-306` — `BuildCommandHandlers()` returns a case-insensitive `Dictionary<string, Func<JsonNode, string>>`. Every new command = one entry + one `CmdFoo(JsonNode) → string` private wrapper.
- **Engine partials (12):** `CommandEngine.cs` (main, 628 KB) + 11 topic partials: `Chorizite.cs (46 KB)`, `Creature.cs`, `Texture.cs`, `Spell.cs`, `Weenie.cs`, `Layout.cs`, `Placements.cs`, `SiteIngest.cs`, `RenderGallery.cs`, `WorldGen.cs`, `WeenieIndex.cs`. **New diagnostic partials land alongside** (`WireConformance.cs`, `DatParity.cs`, `EnumParity.cs`, `PhysicsParity.cs`, `MotionParity.cs`, `TextureParity.cs`, `MeshParity.cs`, `CellPortalGraph.cs`, `Skybox.cs`).
- **Existing diagnostic-shape commands (precedents):**
  - `validate-landblock` → `JsonCommandProcessor.cs:1295` → `CommandEngine.cs:1880` — returns `ValidationReport { Diagnostics[] (Severity, Code, Message, Context) }`.
  - `validate-dungeon` → `JsonCommandProcessor.cs:1290` → `CommandEngine.cs:1871`.
  - `validate-terrain` / `validate-building-shells` / `validate-building-portals` / `validate-all` → `CommandEngine.cs:1906-1928`.
  - `compare-render-corners` → `JsonCommandProcessor.cs:1300` → `CommandEngine.cs:1897` — returns `CornerDiffReport { CornerDiffBuilding[] (ObjectId, Origin, Orientation, MaxCornerDeltaMetres, ...) }`. **This is the closest existing template for wire-conformance.**
  - `compare-to-retail` → `JsonCommandProcessor.cs:281` → `CommandEngine.cs:10799` — **subprocesses Python** via `RunPython()` at `CommandEngine.cs:10933-10962` (`ProcessStartInfo` + async stdout/stderr drain, 10-min timeout). Env override: `WORLDBUILDER_COMPARATOR_PY`. **Template for any new oracle that delegates to a CLI tool.**
  - `compare-creatures-to-retail` → `JsonCommandProcessor.cs:227` → `CommandEngine.SiteIngest.cs:142`.
- **Chorizite absorption precedent:** `CommandEngine.Chorizite.cs:50-64` (DefaultChoriziteSourceRoot walk-up), `:115-160` (reflection over `Chorizite.Common.Enums` assembly + regex-parse of vendored `.generated.cs` for ACProtocol). The 11-enum `CuratedEnumAllowlist` at `:93-105`.
- **DAT layer:** `Chorizite.DatReaderWriter` NuGet v2.1.2 (`WorldBuilder.Terminal.csproj:19`) + `DatReaderWriter.Extensions` ProjectReference (`.csproj:34`). Pass through `IDatReaderWriter` from `HeadlessProjectManager.DocumentManager.Dats`.
- **ACE DB:** `WorldBuilder.Shared/Lib/AceDb/AceDbSettings.cs:8-35` (config) + `AceDbConnector.cs` (MySqlConnector). `CommandEngine.Creature.cs:15-19` shows the `RequireAceDbConnector()` factory pattern.
- **Output:** JSON camelCase, null-suppressed (`JsonCommandProcessor.cs:32-36`). No SARIF. Markdown only optional via subprocess `--out` flags. JSONL for bulk exports (`export-raw-world-facts`, `export-training-data`).

### A.2 holtburger-web subject surface

- **Three shipped validators:**
  - `apps/holtburger-web/validate_entity_classification.cjs` — pure-function regression (26 PASS-1 + 12 PASS-2 + 5 PASS-3 branches of canonical classifier). No Playwright.
  - `apps/holtburger-web/validate_landblock_completeness.cjs` — Playwright; 169 LB ring; out dir `/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/e/`.
  - `apps/holtburger-web/validate_event_completeness.cjs` — Playwright; `--probe-s` window; out dir `/mnt/wbterminal1/tmp/claude-scratch/event-completeness/d/`.
- **Live capture script** (entity classification, live ACE): `apps/holtburger-web/capture_entity_classifications.cjs` (per entity-completeness-method.md §E.F).
- **Top introspection hooks in `index.html`:**
  - `window.__sessionHandle` (line 6009), `window.__pluginClient` (6013), `window.__wom` (6027) — primary diagnostic entry points.
  - `window.__hbWasm` (828) — raw wasm exports.
  - `window.__doorStates` (2805), `window.__doorBuildingParts` (6836) — Wave 5 cell-portal validator input.
  - `window.__currentCellId` (5047), `window.__renderSet` (5048), `window.__isIndoor` (5051) — PVS sampling.
  - `window.__predLastPos` / `__predFirstPos` / `__predTickCount` (4676-4678, 7343-7345) — Wave 3 physics-trace input.
  - `window.__soundTriggeredStats` (7027) — Wave 5 audio probes.
  - `window.liveScene` (2780) + `liveScene3d.snapshotEventLog()` — runtime event log for Wave 2/3/5 baselines.
- **wasm exports (144 `#[wasm_bindgen]` attrs in `apps/holtburger-web/src/lib.rs`):** `build_info`, `hash32`, `session_smoke_test_packet_sequence` (smoke); `fetch_landblock_{heightmap, objects, scenery, spawns, mesh}` + `fetch_subdivided_landblock_mesh` (DAT); `fetch_entity_surfaces_pixel_batch` (Wave 4); `holtburg_test_*` (collision/door/skill subset — Wave 3 hooks); `set_sky_time_override` / `fetch_sky_state` (Wave 5).
- **Plugins (first-party):** root `api.js`, `combat-bar.js`, `spellbook.js`, `stance-toggle.js`, `vendor-ui.js`, `vitals-hud.js`; `world-objects/` (30 typed-class stubs + `canonical_classify.js` + `world_object_manager.js`).
- **Capture node-path:** `NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules` — every new `validate_*.cjs` needs this prefix.
- **Dist layout:** `/mnt/wbterminal1/holtburger-dist-v2/{boot.hba, manifest.json, shards/0xXXYY.hba, scenery/, spawns/, events/}` (no symlink — direct).

### A.3 ACE server oracle inventory (`~/ace-server/Source/`)

- **Wire builders (61 `GameMessage*` classes):** `Source/ACE.Server/Network/GameMessages/GameMessage.cs:5-48` base. Load-bearing for diagnostics (Wave 1 fixture set):
  - `GameMessageCreateObject.cs:5` (delegates to `WorldObject_Networking.cs:SerializeCreateObject` at `:56-100+` — **the most critical surface**)
  - `GameMessageDeleteObject.cs:6`, `GameMessageObjDescEvent.cs:10`, `GameMessageUpdateObject.cs`, `GameMessagePrivateUpdatePosition.cs:10`, `GameMessagePublicUpdatePosition.cs:5`
  - `GameMessagePrivateUpdateAttribute.cs:6`, `GameMessagePrivateUpdateAttribute2ndLevel.cs:6`
  - `GameMessageAutonomousPosition.cs:7`, `GameMessageSound.cs:7`, `GameMessageScript.cs:7`, `GameMessageUpdateMotion.cs`, `GameMessagePublicUpdatePropertyInt.cs`, `GameMessageVectorUpdate.cs`
- **DAT loaders (51 files in `Source/ACE.DatLoader/FileTypes/`):** CellLandblock, LandblockInfo, RegionDesc, Scene, SetupModel, MotionTable, PhysicsScript, ParticleEmitterInfo, SoundTable, EnvCell, Surface, SurfaceTexture, Environment, Animation — **Wave 2 parity targets** (one row each, 14 of the 20 DAT types).
- **Server-side procedural algorithms:**
  - `Source/ACE.Server/Entity/Scenery.cs:16` — `Scenery.Load()`. Already ported to `holtburger-scenery-bake`; cite as oracle for spot-checks.
  - `Scenery.cs:76` — `GetZ()` terrain height interp.
  - `Source/ACE.Server/Common/DerethDateTime.cs:8-54` — day-night clock (7620 ticks/day, 16 hr).
  - `Source/ACE.DatLoader/Entity/SkyDesc.cs` + `SkyTimeOfDay.cs` — Wave 5 skybox oracle.
  - `Source/ACE.Server/Physics/{CylSphere.cs:13, BoundingBox.cs:10, PhysicsDesc.cs:8, PhysicsObj.cs:29, Trajectory.cs:37, Sphere.cs, Polygon.cs, PhysicsGlobals.cs, Trajectory2.cs:8}` — Wave 3 physics oracle.
- **Enum vocabulary (`Source/ACE.Entity/Enum/`):** `PropertyInt/Float/DataId/String/Attribute/Attribute2nd.cs`, `WeenieType.cs:3` (78 types), `ItemType.cs:6`, `ObjectDescriptionFlag.cs:6`, `WeenieHeaderFlags.cs:6`, `PhysicsState.cs:6`. Wave 2.C cross-port.
- **DB tables (`ACE.Database/Models/World/`):** `Weenie.cs:9`, `LandblockInstance.cs:9` (+ `Link.cs`), `WeeniePropertiesInt/Float/DID/String/Position.cs`, `Treasure*.cs`. Wave 1+5 use for fixture generation.

### A.4 Chorizite + DatReaderWriter inventory (vendored)

- **Vendored manifest:** `external/chorizite/VENDORED.md:1-16` lists 8 projects with tier, .cs count, size. Top three by Wave usage: `ACPlugin/` (63 files, Tier 1 — port), `Chorizite.Common/` (67 files, 67 enum files / 7108 lines, Tier 4), `Chorizite.ACProtocol/` (606 .cs / 368 message types, Tier 4).
- **Canonical classifier:** `external/chorizite/ACPlugin/API/WorldObject.cs:344-407` (`GetObjectClass`) + dispatcher `World.cs:622-706`.
- **ACProtocol message hierarchy:** abstract `ACMessage` base + `ACS2CMessage` / `ACC2SMessage` / `ACGameAction` / `ACGameEvent` discriminators. 368 generated message types. Codec: `MessageReader`. **Wave 1 oracle for pack/unpack tests.**
- **dats.xml schema:** `external/DatReaderWriter/DatReaderWriter/dats.xml` — root `<schema>`, enums section `:3-69` (DatFileType, DBObjHeaderFlags, PixelFormat 67-format catalog, SkillId). Wave 2 parity reference.
- **Existing parity tests (Rust-side, already in tree — extend these):**
  - `external/holtburger/crates/holtburger-protocol/tests/opcode_parity.rs:1-46` — JSON dump of Chorizite opcodes vs Rust enums.
  - `external/holtburger/crates/holtburger-dat/tests/parity_tests.rs` — DAT reader parity.
  - `animation_hook_parity.rs`, `create_particle_hook_parity.rs`, `resolve_sound_parity.rs`, `region_sound_info_parity.rs` — domain-specific DAT parity (Wave 3 + Wave 5 baselines).
- **C# fixture tests (oracle goldens):** `external/DatReaderWriter/DatReaderWriter.Tests/` (59+ DBObj round-trip tests) + `external/chorizite/DatReaderWriter.Extensions/DatReaderWriter.Extensions.Tests/` (RenderSurface, DatEasyWriter).
- **Key enum sizes (Wave 2.C cross-port targets, all in `Chorizite.Common/Enums/`):** `ObjectClass.cs:9-54` (45 values), `ItemType.cs:8-72` (32 flags), `WeenieHeaderFlag.cs:7-42` (32 flags), `PhysicsState.cs:8-58` (27 flags), `PropertyInt.cs` (787 lines, ~270 keys), `PropertyBool.cs` (269 lines), `PropertyFloat.cs` (351 lines), `MotionCommand.cs` (421 lines), `SpellCategory.cs` (1462 lines, largest), `Sound.cs` (414 lines), `WeenieType.cs` (148 lines).

### A.5 Local retail decomp (Wave 3 physics + motion source)

- `~/ac-headers/acclient.c` (938k lines, Hex-Rays). Top subsystems by method count: `UIElement` (2384), `CPhysicsObj` (1049 — **Wave 3 physics**), `Archive` (1163), `BaseProperty` (765), `ACCWeenieObject` (701), `ClientCommunicationSystem` (538 — Wave 1 cross-ref), `ClientObjMaintSystem` (424).
- `~/ac-headers/acclient.h` — 348 enums + ~6,936 structs. Struct-layout reference.
- `~/ac-headers/acclient.txt` — PDB symbol→OBJ map.
- `~/ac-headers/acclient_2013.bndb_pseudo_c.txt` — Binary Ninja cross-decomp.
- **Worked example (CHORIZITE_PORTING_PLAN §4-Alt):** `CMotionInterp::get_jump_v_z` at `acclient.c:343343-343363` — Wave 3.B target.

---

*End of appendix. The brick rows in §6 + the file:line targets here are sized for one agent each. Spawn waves per §7 sequencing.*
