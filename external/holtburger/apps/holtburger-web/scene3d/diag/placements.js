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

/**
 * Global-greedy bipartite matcher between expected and observed lists.
 *
 * Per-expected greedy is suboptimal on multi-instance models: with 30
 * "Door" placements expected and 30 observed, the first-claimed expected
 * grabs whichever observed happens to come closest, which can force
 * later expected entries to pair against far-away leftovers. This walks
 * ALL candidate pairs in ascending distance order, claiming both sides
 * stably — equivalent to the "global nearest neighbour matching"
 * heuristic and within a small constant of true Hungarian-optimal for
 * the position-matching problem (where the true optimum has lots of
 * close pairs and few far ones).
 *
 * Complexity: O(N*M) for pair enumeration + O(N*M log N*M) sort, where
 * N=|expected|, M=|observed|. For Holtburg N≈100, M≈250 → ~25K pair
 * compute + ~25K log sort = sub-millisecond.
 *
 * Returns `Map<expectedIdx, { observedIdx, distSq }>` for matched
 * pairs only. Expected entries without a same-modelId observed
 * counterpart get no entry (caller treats them as not-rendered).
 */
function globalNearestMatch(expected, observed, modelIdOf, posOf) {
  const pairs = [];
  for (let i = 0; i < expected.length; i++) {
    const em = modelIdOf(expected[i]);
    const ep = posOf(expected[i]);
    if (em == null || !ep) continue;
    for (let j = 0; j < observed.length; j++) {
      if (observed[j].modelId !== em) continue;
      const op = observed[j].position;
      const dx = op[0] - ep[0];
      const dy = op[1] - ep[1];
      const dz = op[2] - ep[2];
      pairs.push({ i, j, dSq: dx*dx + dy*dy + dz*dz });
    }
  }
  pairs.sort((a, b) => a.dSq - b.dSq);
  const result = new Map();
  const claimedExp = new Set();
  const claimedObs = new Set();
  for (const p of pairs) {
    if (claimedExp.has(p.i) || claimedObs.has(p.j)) continue;
    claimedExp.add(p.i);
    claimedObs.add(p.j);
    result.set(p.i, { observedIdx: p.j, distSq: p.dSq });
  }
  return result;
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
      const extra = [];

      // ── buildings: oracle origins are world-frame — global-greedy
      //    pair against same-modelId observed entries. Eliminates the
      //    multi-instance crosstalk the per-row matcher produced on
      //    LBs with N identical building models (warden barracks etc).
      const bMatches = globalNearestMatch(
        expBuildings, obBuildings,
        (eb) => normalizeModelId(eb.modelId),
        (eb) => [eb.origin?.x ?? 0, eb.origin?.y ?? 0, eb.origin?.z ?? 0],
      );
      const bClaimed = new Set();
      for (let i = 0; i < expBuildings.length; i++) {
        const eb = expBuildings[i];
        const wantModel = normalizeModelId(eb.modelId);
        const ox = eb.origin?.x ?? 0, oy = eb.origin?.y ?? 0, oz = eb.origin?.z ?? 0;
        const expectedSpec = { modelId: wantModel, origin: [ox, oy, oz], nameHint: eb.nameHint ?? null };
        const m = bMatches.get(i);
        if (!m) {
          missing.push({ kind: "building", expected: expectedSpec,
                         classification: "building-not-rendered", detail: null });
        } else if (m.distSq > POS_TOLERANCE_SQ) {
          missing.push({ kind: "building", expected: expectedSpec,
                         classification: "building-misplaced",
                         detail: { observedPos: obBuildings[m.observedIdx].position,
                                   distance: Math.sqrt(m.distSq) } });
          bClaimed.add(m.observedIdx);
        } else {
          bClaimed.add(m.observedIdx);
        }
      }
      for (let i = 0; i < obBuildings.length; i++) {
        if (bClaimed.has(i)) continue;
        extra.push({ kind: "building", modelId: obBuildings[i].modelId,
                     position: obBuildings[i].position });
      }

      // ── npcs: oracle coords LB-local → world. Same global-greedy
      //    treatment so multi-instance wcids (Door=412, Royal Guard=
      //    37518) pair stably. We still defer 5-mode classification
      //    to diag.diff(lbId); this surface only flags "rendered or not".
      const nMatches = globalNearestMatch(
        expNpcs, obEntities,
        (en) => (en.wcid >>> 0) || 0,
        (en) => [
          lbX * METERS_PER_LB + (en.x ?? 0),
          lbY * METERS_PER_LB + (en.y ?? 0),
          en.z ?? 0,
        ],
      );
      const nClaimed = new Set();
      for (let i = 0; i < expNpcs.length; i++) {
        const en = expNpcs[i];
        const wantWcid = (en.wcid >>> 0) || 0;
        const wx = lbX * METERS_PER_LB + (en.x ?? 0);
        const wy = lbY * METERS_PER_LB + (en.y ?? 0);
        const wz = en.z ?? 0;
        const m = nMatches.get(i);
        if (!m || m.distSq > POS_TOLERANCE_SQ) {
          missing.push({
            kind: "npc",
            expected: { wcid: wantWcid, name: en.name ?? null, worldPos: [wx, wy, wz] },
            classification: "npc-not-rendered",
            detail: !m ? null
                  : { observedPos: obEntities[m.observedIdx].position, distance: Math.sqrt(m.distSq) },
          });
          if (m) nClaimed.add(m.observedIdx);
        } else {
          nClaimed.add(m.observedIdx);
        }
      }

      // ── scenery: prefer per-placement diff against oracle.bakedScenery[]
      //    (Wave-2 oracle — `{obj_id, x, y, z, scale, ...}` LB-local).
      //    Global-greedy pairing — multi-instance models like grass tufts
      //    or rocks would crosstalk badly under per-row matching.
      const expBakedScenery = Array.isArray(exp.bakedScenery) ? exp.bakedScenery : null;
      if (expBakedScenery) {
        const sMatches = globalNearestMatch(
          expBakedScenery, obStatics,
          (es) => normalizeModelId(es.obj_id),
          (es) => [
            lbX * METERS_PER_LB + (es.x ?? 0),
            lbY * METERS_PER_LB + (es.y ?? 0),
            es.z ?? 0,
          ],
        );
        const sClaimed = new Set();
        for (let i = 0; i < expBakedScenery.length; i++) {
          const es = expBakedScenery[i];
          const wantModel = normalizeModelId(es.obj_id);
          const wx = lbX * METERS_PER_LB + (es.x ?? 0);
          const wy = lbY * METERS_PER_LB + (es.y ?? 0);
          const wz = es.z ?? 0;
          const expectedSpec = { obj_id: wantModel, worldPos: [wx, wy, wz], scale: es.scale ?? 1 };
          const m = sMatches.get(i);
          if (!m) {
            missing.push({ kind: "scenery", expected: expectedSpec,
                           classification: "scenery-not-rendered", detail: null });
          } else if (m.distSq > POS_TOLERANCE_SQ) {
            missing.push({ kind: "scenery", expected: expectedSpec,
                           classification: "scenery-misplaced",
                           detail: { observedPos: obStatics[m.observedIdx].position,
                                     distance: Math.sqrt(m.distSq) } });
            sClaimed.add(m.observedIdx);
          } else {
            sClaimed.add(m.observedIdx);
          }
        }
        // Reconcile LandblockInfo loose objects. The renderer renders them
        // into staticsGroup too (fetch_landblock_objects), but the oracle
        // carries only their COUNT (sceneryCount = expScenery), not positions,
        // so they can't be position-matched the way bakedScenery/buildings are.
        // The first `expScenery` UNCLAIMED observed statics are those
        // LandblockInfo objects (count-reconciled — they come through the same
        // DAT-exact pipeline as buildings, which we DO position-match and which
        // pass); only unclaimed beyond that are true "extra". Fewer unclaimed
        // than expScenery ⇒ some LandblockInfo objects didn't render (a real
        // shortfall). (Position-matching these too would need the oracle to
        // emit the LandblockInfo object list, not just sceneryCount.)
        const unclaimedStatics = [];
        for (let i = 0; i < obStatics.length; i++) {
          if (!sClaimed.has(i)) unclaimedStatics.push(i);
        }
        const lbiReconciled = Math.min(unclaimedStatics.length, expScenery);
        for (let k = lbiReconciled; k < unclaimedStatics.length && (k - lbiReconciled) < 25; k++) {
          const i = unclaimedStatics[k];
          extra.push({ kind: "scenery", modelId: obStatics[i].modelId,
                       position: obStatics[i].position });
        }
        if (unclaimedStatics.length < expScenery) {
          missing.push({ kind: "scenery",
            expected: { landblockInfoObjects: expScenery },
            classification: "scenery-not-rendered",
            detail: { reconciledStatics: unclaimedStatics.length,
                      shortfall: expScenery - unclaimedStatics.length } });
        }
      } else if (obStatics.length !== expScenery) {
        // Legacy count-only fallback.
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
