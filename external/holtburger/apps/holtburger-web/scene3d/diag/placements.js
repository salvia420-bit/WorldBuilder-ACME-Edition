// scene3d/diag/placements.js — scene-graph placement diagnostic slice
//
// Read-only walker over `window.liveScene3d.{staticsGroup,
// buildingsGroup, entitiesGroup}`. Builds a per-LB placement list and
// diffs it against the WB.Terminal `dump-lb-expectations` oracle that
// diag.js loads into `diag.expected`.
//
// Complementary to the spawn-lifecycle diff in diag.js — that one
// answers "did the wire packet arrive + the rig mount?"; this one
// answers "is the scene graph putting renderable things where the
// oracle says they should be?".
//
// Walker semantics mirror validate_landblock_completeness.cjs's
// rendered-scene walk:
//   - InstancedMesh → expand via instanceMatrix.array, one record per
//     instance index (translation + uniform scale read straight from
//     the matrix; rotation extracted from normalized 3×3 trace)
//   - LOD            → walk highest-detail child (children[0])
//   - Mesh           → take position/quaternion/scale directly
//   - building Group → emit at placementGroup level (userData.isBuilding)
//   - entity root    → direct child of entitiesGroup
//
// Coords: per the world-frame convention (worldRoot.rotation.x = -π/2
// applied at the group level), per-mesh `position` is AC-world frame
// directly. No acToThree inverse. LB byte = floor(world / 192).
//
// NO wasm fetches. NO mutation of diag.expected. Defensive against
// `window.liveScene3d` being absent (returns `{error: "scene3d not
// ready"}`).

const METERS_PER_LB = 192.0;
const POS_TOLERANCE_M = 2.0;        // brief: >2m off → "misplaced"
const POS_TOLERANCE_SQ = POS_TOLERANCE_M * POS_TOLERANCE_M;

const hexLb = (lb) => "0x" + ((lb >>> 0).toString(16).padStart(8, "0"));

/** Coerce LB arg (number or "0xLLLL0000" string) to high-16 packed u32. */
function normalizeLb(lbId) {
  const raw = typeof lbId === "string" ? parseInt(lbId, 16) : lbId;
  return ((raw & 0xffff0000) >>> 0);
}

/** Coerce a modelId that may be "0x0100XXXX" or a number to u32. */
function normalizeModelId(m) {
  if (m == null) return 0;
  if (typeof m === "number") return m >>> 0;
  if (typeof m === "string") return (parseInt(m, 16) >>> 0) || 0;
  return 0;
}

const lbByte = (w) => Math.floor(w / METERS_PER_LB) & 0xff;
const lbKey  = (x, y) => (((x & 0xff) << 24) | ((y & 0xff) << 16)) >>> 0;

/**
 * Read translation + uniform scale + rotation-quat from an instance
 * matrix at offset `off`. Cheaper than three.js Matrix4.decompose
 * because we don't allocate. Quaternion via Shepperd's method (the
 * branch chase is the same one validate_landblock_completeness.cjs
 * lines 1023-1048 use).
 */
function readMatrix(arr, off, out) {
  const sx = Math.hypot(arr[off + 0], arr[off + 1], arr[off + 2]);
  const sy = Math.hypot(arr[off + 4], arr[off + 5], arr[off + 6]);
  const sz = Math.hypot(arr[off + 8], arr[off + 9], arr[off + 10]);
  out.x = arr[off + 12]; out.y = arr[off + 13]; out.z = arr[off + 14];
  out.scale = sx;
  const isx = sx ? 1 / sx : 0, isy = sy ? 1 / sy : 0, isz = sz ? 1 / sz : 0;
  const r00 = arr[off]*isx,    r01 = arr[off+4]*isy,  r02 = arr[off+8]*isz;
  const r10 = arr[off+1]*isx,  r11 = arr[off+5]*isy,  r12 = arr[off+9]*isz;
  const r20 = arr[off+2]*isx,  r21 = arr[off+6]*isy,  r22 = arr[off+10]*isz;
  const tr = r00 + r11 + r22;
  let s;
  if (tr > 0) {
    s = 0.5 / Math.sqrt(tr + 1.0);
    out.qw = 0.25 / s; out.qx = (r21 - r12) * s; out.qy = (r02 - r20) * s; out.qz = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
    out.qw = (r21 - r12) / s; out.qx = 0.25 * s; out.qy = (r01 + r10) / s; out.qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
    out.qw = (r02 - r20) / s; out.qx = (r01 + r10) / s; out.qy = 0.25 * s; out.qz = (r12 + r21) / s;
  } else {
    s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
    out.qw = (r10 - r01) / s; out.qx = (r02 + r20) / s; out.qy = (r12 + r21) / s; out.qz = 0.25 * s;
  }
}

/** Walk one staticsGroup child (Mesh / InstancedMesh / LOD). */
function visitStatic(node, out) {
  if (!node) return;
  if (node.isLOD && node.children?.length) return visitStatic(node.children[0], out);
  const modelId = normalizeModelId(node.userData?.modelId);
  if (node.isInstancedMesh) {
    const count = node.count | 0;
    const arr = node.instanceMatrix?.array;
    if (!arr) return;
    const t = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, scale: 1 };
    for (let i = 0; i < count; i++) {
      readMatrix(arr, i * 16, t);
      out.push({ source: "statics", modelId,
                 position: [t.x, t.y, t.z],
                 rotation: [t.qx, t.qy, t.qz, t.qw],
                 scale: t.scale, instanceIndex: i });
    }
    return;
  }
  if (node.isMesh) {
    const p = node.position, q = node.quaternion, s = node.scale;
    out.push({ source: "statics", modelId,
               position: [p.x, p.y, p.z],
               rotation: [q.x, q.y, q.z, q.w],
               scale: s.x });
  }
}

/** Walk one buildingsGroup child (a per-placement Group). */
function visitBuilding(node, out) {
  const ud = node?.userData;
  if (!ud || ud.isBuilding !== true) return;
  const p = node.position, q = node.quaternion, s = node.scale;
  out.push({ source: "buildings", modelId: normalizeModelId(ud.modelId),
             position: [p.x, p.y, p.z],
             rotation: [q.x, q.y, q.z, q.w],
             scale: s.x });
}

/** Walk one entitiesGroup child (an entity root Group). modelId IS wcid. */
function visitEntity(node, out) {
  if (!node) return;
  const p = node.position, q = node.quaternion, s = node.scale;
  out.push({ source: "entities",
             modelId: normalizeModelId(node.userData?.modelId),
             position: [p.x, p.y, p.z],
             rotation: [q.x, q.y, q.z, q.w],
             scale: s.x });
}

/** Walk the whole scene; optionally filter to one LB. */
function walkScene(lbFilter) {
  const live = window.liveScene3d;
  if (!live) return { error: "scene3d not ready" };
  const all = [];
  for (const c of live.staticsGroup?.children   ?? []) visitStatic(c, all);
  for (const c of live.buildingsGroup?.children ?? []) visitBuilding(c, all);
  for (const c of live.entitiesGroup?.children  ?? []) visitEntity(c, all);
  if (lbFilter == null) return all;
  const lb = normalizeLb(lbFilter);
  return all.filter((p) => lbKey(lbByte(p.position[0]), lbByte(p.position[1])) === lb);
}

/** Find the closest unclaimed observed placement with matching modelId. */
function closestMatch(observed, claimed, wantModelId, wx, wy, wz, claimPrefix) {
  let bestIdx = -1, bestDistSq = Infinity;
  for (let i = 0; i < observed.length; i++) {
    if (claimed.has(`${claimPrefix}${i}`)) continue;
    const o = observed[i];
    if (o.modelId !== wantModelId) continue;
    const dx = o.position[0] - wx, dy = o.position[1] - wy, dz = o.position[2] - wz;
    const dSq = dx*dx + dy*dy + dz*dz;
    if (dSq < bestDistSq) { bestDistSq = dSq; bestIdx = i; }
  }
  return { idx: bestIdx, distSq: bestDistSq };
}

export function attachPlacements(diag) {
  diag.placements = {
    walk(lbId) { return walkScene(lbId); },
    walkAll()  { return walkScene(null); },

    /**
     * Diff observed scene-graph placements vs `diag.expected` for one LB.
     * NPC missing-classification is intentionally lightweight here — the
     * spawn-lifecycle diff in `diag.diff(lbId)` owns the 5-mode classifier.
     */
    diff(lbId) {
      if (!window.liveScene3d) return { error: "scene3d not ready" };
      if (!diag.expected) return { error: "no expected oracle loaded; call diag.setExpected(...)" };

      const lb = normalizeLb(lbId);
      const lbX = (lb >>> 24) & 0xff;
      const lbY = (lb >>> 16) & 0xff;

      const observedAll = walkScene(lb);
      if (observedAll.error) return observedAll;
      const obStatics   = observedAll.filter((p) => p.source === "statics");
      const obBuildings = observedAll.filter((p) => p.source === "buildings");
      const obEntities  = observedAll.filter((p) => p.source === "entities");

      const exp = diag.expected;
      const expBuildings = Array.isArray(exp.buildings) ? exp.buildings : [];
      const expNpcs      = Array.isArray(exp.npcs)      ? exp.npcs      : [];
      const expScenery   = typeof exp.sceneryCount === "number" ? exp.sceneryCount : 0;

      const missing = [];
      const claimed = new Set();

      // ── buildings: oracle origins are world-frame (Vector3 Origin in
      //    LandblockDescriber.cs:101) — no LB-local conversion needed.
      for (const eb of expBuildings) {
        const wantModel = normalizeModelId(eb.modelId);
        const ox = eb.origin?.x ?? 0, oy = eb.origin?.y ?? 0, oz = eb.origin?.z ?? 0;
        const m = closestMatch(obBuildings, claimed, wantModel, ox, oy, oz, "b");
        const expectedSpec = { modelId: wantModel, origin: [ox, oy, oz], nameHint: eb.nameHint ?? null };
        if (m.idx < 0) {
          missing.push({ kind: "building", expected: expectedSpec,
                         classification: "building-not-rendered", detail: null });
        } else if (m.distSq > POS_TOLERANCE_SQ) {
          missing.push({ kind: "building", expected: expectedSpec,
                         classification: "building-misplaced",
                         detail: { observedPos: obBuildings[m.idx].position,
                                   distance: Math.sqrt(m.distSq) } });
          claimed.add(`b${m.idx}`);
        } else {
          claimed.add(`b${m.idx}`);
        }
      }
      const extra = [];
      for (let i = 0; i < obBuildings.length; i++) {
        if (claimed.has(`b${i}`)) continue;
        extra.push({ kind: "building", modelId: obBuildings[i].modelId,
                     position: obBuildings[i].position });
      }

      // ── npcs: oracle coords are LB-local → convert to world. Complementary
      //    to diag.diff lifecycle; we only ask "is something at the spot?".
      for (const en of expNpcs) {
        const wantWcid = (en.wcid >>> 0) || 0;
        const wx = lbX * METERS_PER_LB + (en.x ?? 0);
        const wy = lbY * METERS_PER_LB + (en.y ?? 0);
        const wz = en.z ?? 0;
        const m = closestMatch(obEntities, claimed, wantWcid, wx, wy, wz, "e");
        if (m.idx < 0 || m.distSq > POS_TOLERANCE_SQ) {
          missing.push({
            kind: "npc",
            expected: { wcid: wantWcid, name: en.name ?? null, worldPos: [wx, wy, wz] },
            classification: "npc-not-rendered",
            detail: m.idx < 0 ? null
                  : { observedPos: obEntities[m.idx].position, distance: Math.sqrt(m.distSq) },
          });
        } else {
          claimed.add(`e${m.idx}`);
        }
      }

      // ── scenery: count-only at v1 per brief.
      if (obStatics.length !== expScenery) {
        missing.push({
          kind: "scenery",
          expected: { count: expScenery },
          classification: "scenery-count-mismatch",
          detail: { observed: obStatics.length, delta: obStatics.length - expScenery },
        });
      }

      const summary = missing.reduce((acc, m) => {
        acc[m.classification] = (acc[m.classification] ?? 0) + 1; return acc;
      }, {});

      return {
        landblockId: hexLb(lb),
        expected: { buildings: expBuildings.length, scenery: expScenery, npcs: expNpcs.length },
        observed: { buildings: obBuildings.length, scenery: obStatics.length,
                    npcs: obEntities.length, statics: obStatics.length },
        missing, extra,
        ok: missing.length === 0,
        summary,
      };
    },
  };
}
