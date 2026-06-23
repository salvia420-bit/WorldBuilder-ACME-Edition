I have everything I need. Here is my buildable spec for slice **13 — Legacy-Safety Lint**.

---

# Build Spec — Legacy-Safety Lint (codify THE RULE as automated CI)

## Goal

Turn THE RULE (design doc §1.2) from prose into a **mechanical CI gate** that fails the build when any visual-behavior component reads a server-replicated/mutable input or writes a wire/physics/replicated field. Three enforcement layers:

1. **Declarative manifest** — every component exports a frozen `manifest` declaring its `reads[]`/`writes[]` from a *closed capability vocabulary*.
2. **Static source lint** — scans each component module's source for forbidden symbols (denylist) and verifies that every write surface touched is declared in the manifest.
3. **Desync-proof regression test** — codifies the in-tree proof that a render-time transform write *cannot* reach the wire (`setPose`'s `copy()` stomp), so the architectural guarantee is locked against future edits to `entities.js`.

All three run as Node `.test.cjs` children under the existing `harness/run-js-headless.mjs` aggregator (`harness/run-js-headless.mjs:72-98`), which already `process.exit(1)`s on any child failure — so this is a true CI gate, no new infra.

---

## Design

### 1. THE RULE — formalization

A component is a tuple `C = (reads, writes, tick)`. It is **legacy-safe** iff:

```
reads(C)  ⊆ ALLOWED_READS      ∧   reads(C)  ∩ FORBIDDEN_READS  = ∅
writes(C) ⊆ ALLOWED_WRITES     ∧   writes(C) ∩ FORBIDDEN_WRITES = ∅
∧  tick(C) is a pure function of (static inputs, client clock)   // determinism
```

Capability vocabulary (the *only* legal tokens in a manifest):

#### `ALLOWED_READS` — static / derived + client clock
| Token | Meaning | In-tree source (file:line) |
|---|---|---|
| `dat.geometry` | part vertex positions / AABB | `wind_rig.js:59 partBBox(positions)` |
| `dat.setupModel` | rest/hinge frames, holding_locations, part frames | `wind_rig.js:113 buildBboxRig(partBoxes, hingeFrames)` |
| `dat.surface` | SurfaceCategory / texture stats | `materials.js:138` JS mirror |
| `weenie.props` | ItemType/WeaponType/MaterialType/spell-DIDs (offline classifier only) | classifier input |
| `pose.authoritative` | object's **current** server pos/heading, READ-ONLY snapshot | `inst.root.position`, `inst.root.quaternion` (read) |
| `hash.instance` | deterministic per-instance `hash01(guid)` | `wind_rig.js:199 hash01` |
| `clock.frame` | shared client wall-clock | `loop.js:804 scene3d.frameTime.tsSec` / `performance.now()` |
| `client.substate` | read-only client-derived UI/action substate (e.g. `drawAmount`) | `entities.js` ranged-action substate (slice 06) |

#### `ALLOWED_WRITES` — render-time transforms / cloned uniforms the server neither stores nor replicates
| Token | Meaning | In-tree source (file:line) |
|---|---|---|
| `render.partTransform` | per-part **Group** local position/quaternion on a live instance | `animated_scenery.js:607-609, 628-629` |
| `render.rootTransform.stomped` | `inst.root.quaternion`/`position` ONLY via the omega-accum re-apply pattern the server `copy()` overwrites | `entities.js:2177-2179, 4206-4208` |
| `material.clonedUniform` | uniform on a **cloned** (owned) material: `uTime`, emissive, opacity, color, roughness, `map.offset` | `entities.js:2155 registerOwnedMaterial`; `loop.js:828 mat.uniforms.uTime.value` |
| `material.cacheKey.perSet` | `customProgramCacheKey` keyed on the patch **SET** (userData flags), never per-instance | `materials.js:262 _patchSetCacheKey`, `:281 _installPatchSetCacheKey` |
| `light.intensity` | modulate an EXISTING light's `.intensity` only | (torch flicker; never `.visible`/count) |

#### `FORBIDDEN_READS` (hard fail)
- Any server-replicated/mutable field beyond the `pose.authoritative` snapshot (replicated stat, inventory, vital, the wire pose value itself).
- Non-deterministic inputs in `tick`: `Math.random()` (banned in the rig sandbox, `wind_rig.js:21`), argless `Date.now()`/`new Date()` for animation phase (clock-fallback only).
- Reading **another** entity's replicated state to drive an effect (couples render to wire).

#### `FORBIDDEN_WRITES` (hard fail)
| Forbidden surface | Why | Grounded symbol |
|---|---|---|
| Wire / C2S send | server would replicate it | `wasmExports.enqueue*`, `wasmExports.send*`, any C2S enqueue |
| Physics / collision | server-authoritative BSP | `wasmExports.*Collision*` (e.g. `enqueueClearLandblockCollision`), `setPosition(`, `moveTo(`, `teleport`, gravity/velocity on physics state |
| Replicated transform (the wire pose) | the value the server stores | writing `inst` server-pose fields / the position frame |
| **Light COUNT** change | forces MeshStandard relink → frame freeze | `light.visible` toggle, push/pop on the light array (`MAX_ACTIVE_LIGHTS=32`) |
| **Per-instance** `customProgramCacheKey` | shader-link explosion (#1 cold-load cost) | `_patchSetCacheKey` reading any per-instance value |

### 2. The component read/write manifest schema

Every component module exports a frozen `manifest` next to its `attach`/`tick`. JSON-serializable so the offline C# `vfx export` (slice 12) can echo it into `visual_archetype_rules.jsonl` for audit.

```jsonc
// component manifest (one per registered VisualComponent)
{
  "id": "procMotion.windBend",        // matches the registry key
  "mech": "A",                        // "A" (CPU keyframe) | "B" (GPU begin_vertex) | "frag" | "light" | "particle"
  "reads":  ["dat.geometry", "dat.setupModel", "hash.instance", "clock.frame"],
  "writes": ["render.partTransform"],
  "deterministic": true,              // tick is pure(static, clock) — lint asserts no Math.random/Date.now in tick
  "lightCountDelta": 0,               // MUST be 0 for every component (relink-freeze rule)
  "cacheKeyScope": "set"              // "set" | "none"; never "instance"
}
```

Reference shape (pseudo-TS):

```ts
type ReadCap  = "dat.geometry"|"dat.setupModel"|"dat.surface"|"weenie.props"
              | "pose.authoritative"|"hash.instance"|"clock.frame"|"client.substate";
type WriteCap = "render.partTransform"|"render.rootTransform.stomped"
              | "material.clonedUniform"|"material.cacheKey.perSet"|"light.intensity";

interface ComponentManifest {
  id: string;
  mech: "A"|"B"|"frag"|"light"|"particle";
  reads: ReadCap[];
  writes: WriteCap[];
  deterministic: true;          // structurally required true
  lightCountDelta: 0;           // structurally required 0
  cacheKeyScope: "set"|"none";  // never "instance"
}
```

The shipped tree-wind component, expressed as a manifest (the round-trip proof — it already obeys the rule):
```jsonc
{ "id":"procMotion.windBend", "mech":"A",
  "reads":["dat.geometry","dat.setupModel","hash.instance","clock.frame"],
  "writes":["render.partTransform"],
  "deterministic":true, "lightCountDelta":0, "cacheKeyScope":"none" }
```
— matches its actual behavior: reads `partBBox` geometry (`wind_rig.js:59`) + hinge frames (`:113`) + `hash01` (`:199`) + the player clock; writes only per-part Group transforms (`animated_scenery.js:607-609`); no light, no cache key.

### 3. Lint / test design — three layers

#### Layer A — manifest conformance (pure, fast)
For each registered component manifest:
```
assert reads  ⊆ ALLOWED_READS
assert writes ⊆ ALLOWED_WRITES
assert reads  ∩ FORBIDDEN_READS  = ∅
assert writes ∩ FORBIDDEN_WRITES = ∅
assert deterministic === true
assert lightCountDelta === 0
assert cacheKeyScope !== "instance"
```
A token outside the closed vocabulary is itself a failure (catches typos / smuggled capabilities).

#### Layer B — static source lint (denylist scan)
Resolve each component's source file from a registry (`scene3d/vfx/components/*.js`). Read the source text and run a **denylist regex scan** scoped to that file (plain Node, no AST dep needed — the surfaces are syntactically distinctive). Any match that is not on an explicit `// vfx-lint-allow: <reason>` line is a failure:

```js
const FORBIDDEN_SOURCE = [
  // wire / collision writes
  /wasmExports\s*\.\s*(enqueue|send)[A-Za-z]*/,
  /wasmExports\s*\.\s*\w*[Cc]ollision\w*/,
  /\.(setPosition|moveTo|teleport)\s*\(/,
  // non-determinism in a component
  /Math\s*\.\s*random\s*\(/,
  /Date\s*\.\s*now\s*\(|new\s+Date\s*\(\s*\)/,
  // light count mutation
  /\.\s*visible\s*=/,                       // on a light (flagged for manual review via allow-comment if not a light)
  /(lights|pointLights|dirLights)\s*\.\s*(push|pop|splice|length\s*=)/,
  // per-instance cache key
  /customProgramCacheKey\s*=[^;]*\b(guid|instanceId|instanceHash)\b/,
];
```
Plus a **write-declaration cross-check**: if the source assigns to `*.uniforms.*.value` or `*.parts[*].position/quaternion` or `*.root.quaternion`, the corresponding write cap (`material.clonedUniform` / `render.partTransform` / `render.rootTransform.stomped`) **must** appear in the manifest. Undeclared writes fail. This prevents a manifest from lying.

#### Layer C — desync-proof regression (codify the in-tree guarantee)
Re-implement the `setPose` contract (mirroring `tests/remote_interp_ownership.test.cjs`, which re-implements pure contracts rather than importing `entities.js`) and assert the stomp:

```js
// Mirrors entities.js:2159-2180 setPose()
function setPoseContract(root, serverQuat, omegaAccumQ) {
  root.quaternion = serverQuat.clone();          // copy() STOMPS prior value (entities.js:2161)
  if (omegaAccumQ) root.quaternion = premultiply(omegaAccumQ, root.quaternion); // :2178
  return root.quaternion;
}
check("render-time rotation write is stomped by next server pose copy", () => {
  const root = { quaternion: someEffectWrittenSpin() };    // a component wrote a spin
  const out = setPoseContract(root, SERVER_Q, /*omega*/ null);
  assert.deepEqual(out, SERVER_Q);   // the effect's write is GONE — server pose wins, cannot leak to wire
});
check("omega spin survives ONLY because it is re-derived client-side each frame, never from root", () => {
  const out = setPoseContract({quaternion: GARBAGE}, SERVER_Q, OMEGA_Q);
  assert.deepEqual(out, premultiply(OMEGA_Q, SERVER_Q)); // re-applied from _omegaAccumQ, not read back from root
});
```
This locks the proof: a render-time transform write is one-way (wire→`setPose`→`root`); nothing reads `root` back to the wire, and the server `copy()` (`entities.js:2161`, `:4196`) overwrites any effect write every position update. If a future edit ever makes `root.quaternion` flow *into* a wire-send, the cross-check in Layer B catches the write and this test documents why it must not.

#### Optional Layer D — dev-time runtime guard (`?vfxLintRuntime=on`)
Wrap each component's `tick` context object in a `Proxy` whose `set` trap throws on any property outside the declared `writes` surface, and whose `get` trap throws on `Math.random`/forbidden reads. Off by default (zero prod cost); a belt-and-suspenders catch for dynamic property access the static scan can't see.

---

## Integration seams (file:line)

- **Component registry / source root the lint enumerates:** new `scene3d/vfx/components/*.js`; the shipped tree-wind component is `tree_wind.js` + `wind_rig.js` + the `animated_scenery.js` player (`animated_scenery.js:580-609` advance+copy).
- **Allowed-write surfaces the lint must recognize:**
  - per-part Group transform: `animated_scenery.js:607-609`, `:628-629`
  - cloned/owned material registry: `entities.js:2076` (init), `:2155 registerOwnedMaterial`, `:2402` (dispose loop)
  - uTime uniform write: `loop.js:828` (driven from `tickTerrainUTime` `loop.js:817`, called `loop.js:1605`)
  - cache-key-per-set: `materials.js:262 _patchSetCacheKey`, `:281 _installPatchSetCacheKey`, `:292 _chainBeforeCompile`
- **Forbidden-write symbols to denylist (grounded):** `wasmExports.enqueueClearLandblockCollision` and the `wasmExports.enqueue*/send*` family (enumerated from `scene3d/*.js`).
- **Desync proof source:** `entities.js:2159-2180` (`setPose` copy + omega re-apply) and `entities.js:4196-4208` (remote-path copy + omega re-apply).
- **CI registration:** add to the TIER1 list in `harness/run-js-headless.mjs:72-98`:
  ```js
  { flag: "vfxLegacySafety", file: "tests/vfx_legacy_safety_lint.test.cjs" },
  ```
  The runner spawns each as `node <file>` (cwd = app root) and `process.exit`es non-zero if any fails — matching the `.test.cjs` convention (`tests/remote_interp_ownership.test.cjs` tail: `if (failed > 0) process.exit(1)`).

---

## Edge cases & legacy-safety check (per THE RULE)

- **`pose.authoritative` is read-only by construction.** The lint allows reading `inst.root.position/quaternion` but Layer B flags any *assignment* to them unless declared `render.rootTransform.stomped`. The desync test (Layer C) proves that even a declared stomped-write cannot leak.
- **MECH-A vs MECH-B both covered.** MECH-A writes Group transforms (`render.partTransform`); MECH-B writes `transformed` inside a `begin_vertex` patch on a cloned material (`material.clonedUniform` + `material.cacheKey.perSet`). Both are render-time-only; neither touches collision (the BSP is server-side, untouched).
- **Cache-key explosion guard.** Layer A asserts `cacheKeyScope !== "instance"`; Layer B regex catches a `customProgramCacheKey` that interpolates `guid`/`instanceHash`. This codifies the `materials.js:262` design (key reads only per-SET userData flags).
- **Light-count freeze guard.** `lightCountDelta` structurally pinned to 0; `.visible=`/array-mutation on lights denylisted. Torch flicker must declare `light.intensity` only.
- **Determinism / bake sandbox.** `Math.random`/`Date.now` denylisted *inside component modules* (not the whole repo — decorative `sky_dome.js:187`/`cloud_overlay.js:163` are out of scope). Per-instance variation must come from `hash01` (`wind_rig.js:199`), exactly as tree-wind does.
- **Shadow/depth pass.** A weathering/emissive component that patches the main material must NOT patch the `customDepthMaterial` — Layer B flags a write to a depth/shadow material without an allow-comment (coordinates with slice 08).
- **False positives** are escape-hatched per-line with `// vfx-lint-allow: <reason>`, which the scanner logs (no silent suppression) so the audit trail survives.

## GPU cost

**Zero runtime GPU cost.** This is an offline/CI lint plus a build-time manifest check. Layers A–C run in Node with no browser, no wasm, no GPU (sibling of `harness/cargo-tests.mjs`). The optional Layer D runtime guard is dev-only behind `?vfxLintRuntime=on` and adds only Proxy trap overhead on component-context property access (never shipped enabled). The lint's *purpose* is to protect the GPU budget indirectly — by mechanically forbidding the two cost bombs (per-instance cache keys = shader-link explosion; light-count changes = relink freeze) at PR time rather than discovering them in a 1070 eye-test.

## Build checklist

1. **Add the capability vocabulary** as a shared constant module `scene3d/vfx/lint_caps.js` (or a `.cjs` mirror for the test): the four frozen Sets `ALLOWED_READS`, `ALLOWED_WRITES`, `FORBIDDEN_READS`, `FORBIDDEN_WRITES` exactly as tabled above, plus the `FORBIDDEN_SOURCE` regex array.
2. **Define the `ComponentManifest` shape** and require every component module to `export const manifest` (frozen). Author the `procMotion.windBend` manifest for the shipped tree-wind component and colocate it (re-export from `tree_wind.js` or a new `scene3d/vfx/components/wind_bend.js` wrapper) — this is the round-trip seed.
3. **Write Layer A (manifest conformance)** in `tests/vfx_legacy_safety_lint.test.cjs`: iterate a registry of `{id, sourcePath, manifest}`; run the seven set/scalar assertions; use the `check()` + `passed/failed` + `process.exit(1)` convention from `tests/remote_interp_ownership.test.cjs`.
4. **Write Layer B (static source scan)** in the same file: `fs.readFileSync` each `sourcePath`, run the `FORBIDDEN_SOURCE` regexes line-by-line skipping `// vfx-lint-allow:` lines, and run the write-declaration cross-check (assignments → required write caps). Fail with the offending `file:line` quoted.
5. **Write Layer C (desync proof)** in the same file: re-implement `setPoseContract` mirroring `entities.js:2159-2180`; assert the stomp and the omega-re-apply, with code comments citing `entities.js:2161`/`:2178`/`:4196`.
6. **Register the test** in `harness/run-js-headless.mjs` TIER1 list (after line 86, alongside the other `tests/*.test.cjs` entries): `{ flag: "vfxLegacySafety", file: "tests/vfx_legacy_safety_lint.test.cjs" }`.
7. **Verify the round-trip:** run `node harness/run-js-headless.mjs --only=vfxLegacySafety` — the shipped tree-wind manifest must pass all three layers green, proving the rule is satisfiable by the existing archetype #1.
8. **Negative tests (lock the gate):** add three deliberately-violating fixture manifests/sources under `tests/fixtures/vfx_lint_bad/` (one forbidden read `Math.random` in tick, one forbidden write `wasmExports.enqueue…`, one `cacheKeyScope:"instance"`) and assert the lint *fails* on each — confirming CI would actually block a violation, not just pass clean input.
9. **(Optional) Layer D** dev guard: implement the Proxy-wrapped tick context behind `?vfxLintRuntime=on`, gated like `treeWindEnabled()` (`tree_wind.js:33`), defaulting off.
10. **Wire into slice 12's `vfx export`:** have `CommandEngine.Vfx.cs` emit each archetype's component manifests into `visual_archetype_rules.jsonl` so the C# offline side and the JS lint share one source of truth for the capability declarations.
