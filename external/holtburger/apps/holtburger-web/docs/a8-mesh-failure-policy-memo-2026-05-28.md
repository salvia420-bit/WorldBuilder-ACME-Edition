# A8 — Mesh-conversion failure policy memo

Decision needed: what should happen when `meshToGeometryGroups(partMesh)` throws for one part of an entity's setup?

## The failure path today

Site: `scene3d/animation.js:443-459` (batched-prewarm path) and `scene3d/entities.js:1422-1432` (legacy fallback path).

```js
for (let p = 0; p < partMeshes.length; p += 1) {
  const partMesh = partMeshes[p];
  if (!partMesh) { partGroups[p] = { groups: [], surfaceDids: [] }; continue; }
  try {
    partGroups[p] = meshToGeometryGroups(partMesh);
  } catch (e) {
    partGroups[p] = { groups: [], surfaceDids: [] };
    try { window.__diag?.assets?.onMeshError?.({ partIndex: p, setupId, error: e }); } catch (_) {}
  }
  if (typeof partMesh.free === "function") { try { partMesh.free(); } catch (_) {} }
}
```

What happens:
1. Throw is caught, swallowed (the original error is recorded to `__diag.assets.meshErrors[]` but doesn't propagate).
2. Returns an empty `{ groups: [], surfaceDids: [] }` stub for that part.
3. Spawn continues — the entity gets a `THREE.Group` root, its userData (wcid, landblockId, name), and all OTHER parts that converted cleanly.
4. The failed part is a part-Group with no mesh children — invisible, but the transform / part-index slot exists.
5. Picking, nameplate, combat, audio all see the entity as live.

Net effect: the entity is interactable but cosmetically incomplete. A drudge missing its right arm. A weapon-bearing NPC with no weapon. A vendor with no head.

## Frequency / impact

Unknown — `__diag.assets.meshErrors[]` exists (capped at `assets.maxErrors`) but no scheduled telemetry pull. Recommended first step regardless of choice: run a long traversal session and read `__diag.assets.meshErrors` to see (a) how often this fires, (b) which setups dominate, (c) whether the same setup retries cleanly on next spawn or fails consistently.

## Options

### Option A — Fail the spawn entirely on any part-conversion throw

If any `meshToGeometryGroups` call throws, abort the spawn: don't add the entity to `entityMap`, don't build the rig, log a higher-severity diag event.

**Pros**
- Visual failures are immediately obvious (entity is just missing, operator notices).
- No partial-render artifacts to chase down later.
- Forces fixes upstream — when something fails consistently, the entity stops appearing entirely until the underlying setup bug is solved.

**Cons**
- Breaks ACE-client consistency. Server thinks the entity is in the scene; client renders nothing.
- Lost interactability: can't click, can't target, can't trade with that vendor, can't talk to that NPC.
- Disproportionate response — losing one cosmetic part (a tail, a hat) means losing the whole NPC.
- One bad setup can cascade: if 5 NPCs share a broken setup, all 5 vanish.
- Combat NPCs vanishing mid-fight = mob de-sync, possible exploit surface.

### Option B — Per-part `_missingGeom` flag, current visual behavior

Keep current "render best-effort with empty parts" behavior. Add a `_missingGeom: true` flag on the part Group's userData (or a per-entity `inst._missingPartIndices: Set<number>`).

Downstream consumers can check the flag:
- Picking: skip raycast hit on missing parts.
- Nameplate: optional "incomplete render" indicator in the corner.
- Combat: skip attached-effect lookups (e.g. weapon swing-hook trigger on the right-hand part).
- Telemetry: a periodic sweep can count `inst._missingPartIndices.size` per entity.

**Pros**
- Entity stays interactable. Server/client consistency preserved.
- Failure is visible but bounded.
- Builds on the existing `__diag.assets.onMeshError` telemetry — adds the per-entity state that telemetry was missing.
- Implementation is local: animation.js sets the flag, downstream uses it on a case-by-case basis.

**Cons**
- "Cosmetically broken" entities can shipping unnoticed (current behavior, but now with a tracker).
- Adds state to track across 3-4 consumers (picking, nameplate, combat, telemetry sweep).

### Option C — Tiered policy by entity importance

Combine A and B:
- For local player + combat-engaged NPCs → fail the spawn (Option A).
- For static / cosmetic / ambient entities → best-effort with flag (Option B).

Criticality classifier — likely a function of `meta.itemType` bitmask:
- `ITEM_TYPE_CREATURE` + has combat stance → critical.
- `ITEM_TYPE_PORTAL`, `ITEM_TYPE_LIFE_STONE`, `ITEM_TYPE_CONTAINER` → critical (interactable).
- `ITEM_TYPE_CLOTHING`, environmental flair → best-effort.

**Pros**
- Balances safety (critical things fail loud) with UX (cosmetic things fail silently).

**Cons**
- Adds a classification step every spawn.
- "Critical" is a fuzzy line and will get litigated.
- Edge case: a critical entity that fails to spawn means the server expects it but the client doesn't have it. Combat can't engage a ghost mob. Still a desync, just a different shape.

### Option D — Per-part flag (B) + magenta placeholder in `?debug=1`

Option B's data model, plus: in dev mode (`?debug=1`), replace the empty part with a bright-magenta wireframe cube as a visible placeholder. Production keeps the empty current behavior.

**Pros**
- Developers see breakage instantly during dev / capture-script runs.
- Production stays clean (no shipping magenta).
- Telemetry + visual signal both available.
- Same data model as B; the visual is a debug-mode override.

**Cons**
- Slightly more code (the magenta-placeholder generator + the flag plumbing).
- Two render paths to keep in sync (dev vs prod).

## Recommendation

**Option D**, with two qualifications:

1. **Run a telemetry pull first.** Before choosing implementation effort, drive a long capture session and dump `__diag.assets.meshErrors`. If the count is < 10 per session, this is rare enough that B's "silent best-effort" is fine and the magenta placeholder might never trigger in practice. If the count is > 100, this is a real production issue that needs investigation regardless of which option ships.

2. **Don't ship the magenta placeholder until you've decided when it's acceptable.** Some captures land in user-facing demos and "wireframe cube where the vendor's head goes" is not a great look. Gate it explicitly behind `?debug=1` or `?diag=1`, never trigger by default.

Reasoning: Option D gives both the developer signal (loud failure in dev) and the operator signal (telemetry surface), without breaking ACE-client consistency the way Option A does. Option C's "critical" classifier is too fuzzy to define cleanly. Option B is fine but loses the visible-failure signal that catches bugs early.

## Implementation sketch (Option D)

**File: `scene3d/animation.js:443-459`** — set the flag on conversion failure:

```js
let missingPartIndices = null;
for (let p = 0; p < partMeshes.length; p += 1) {
  const partMesh = partMeshes[p];
  if (!partMesh) {
    partGroups[p] = { groups: [], surfaceDids: [] };
    continue;
  }
  try {
    partGroups[p] = meshToGeometryGroups(partMesh);
  } catch (e) {
    partGroups[p] = { groups: [], surfaceDids: [], _missing: true };
    if (!missingPartIndices) missingPartIndices = [];
    missingPartIndices.push(p);
    try { window.__diag?.assets?.onMeshError?.({ partIndex: p, setupId, error: e }); } catch (_) {}
  }
  if (typeof partMesh.free === "function") { try { partMesh.free(); } catch (_) {} }
}
// Cache the per-setup missing-part list alongside partGroups so spawns
// of this setup don't re-throw — they fail consistently with same parts.
if (missingPartIndices) {
  cacheEntry.missingPartIndices = missingPartIndices;
}
```

**File: `scene3d/entities.js`** — at the part-Group construction site, check the flag and (if debug mode) attach a magenta placeholder:

```js
if (partGroups[p]?._missing) {
  inst._missingPartIndices ??= new Set();
  inst._missingPartIndices.add(p);
  if (typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("debug") === "1") {
    const placeholder = _buildMissingGeomPlaceholder(); // magenta wireframe cube
    partGroup.add(placeholder);
  }
}
```

**Helper**: `_buildMissingGeomPlaceholder()` — a `THREE.Mesh` with `BoxGeometry(0.5, 0.5, 0.5)` + `MeshBasicMaterial({ color: 0xff00ff, wireframe: true })`. Static module-scope so all placeholders share one geometry / material.

**Downstream consumers** (incremental, can land in later PRs):
- `scene3d/picking.js`: when raycasting hits a part, check `inst._missingPartIndices?.has(partIdx)` and skip.
- `scene3d/nameplate_sprite.js`: optional `⚠` corner badge if `inst._missingPartIndices?.size > 0`.
- Combat (entities.js link-play): skip `_tryPlayLink` overlays attached to a missing part.

Total: ~50 LoC across 1-3 files for the core flag plumbing; consumers are opt-in additions.

## Decision needed

1. Run telemetry pull first? (Recommended — answer ≤ 1 session.)
2. Of the four options, which one?
3. If D: ship the flag plumbing now and defer downstream consumers, or land everything together?

Until you decide, the current behavior (empty stub + telemetry) is the de-facto status quo. The bug is "we don't know when this fires"; the telemetry is wired but un-monitored.
