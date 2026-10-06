// scene3d/part_degrade.js — ?partDegrade: retail per-part GfxObjDegradeInfo distance pick for
// entity rigs (2026-10-06).
//
// RETAIL (acclient.c, read 2026-10-06):
//  - CPhysicsPart::LoadGfxObjArray (:314892): a part whose GfxObj names a GfxObjDegradeInfo
//    (0x11) holds one GfxObj per degrade level — gfxobj[i] = degrades[i].gfxobj_id, NULL for id 0.
//  - CPhysicsPart::UpdateViewerDistance (:315098): distance = |viewer - part sort centre| /
//    gfxobj_scale.z. The PLAYER's own parts always take level 0; every other part asks
//    GfxObjDegradeInfo::get_degrade (:332356) and draws gfxobj[deg_level] — nothing when NULL.
//  - get_degrade: d' = max(|d| - Render::s_rDegradeDistance, 0) (50.0, :45516). deg_mul >= 0: walk
//    the levels while d' >= ideal + (max - ideal) * deg_mul; deg_mul < 0: while d' >= ideal +
//    (ideal - min) * deg_mul; walking off the end picks the LAST level.
//
// IN THE DATA (base portal.dat): a human body part such as 0x0100004E -> 0x110006C6 carries levels
// at ideal 3 / 5 / 7 / 15 / 84 and then a NULL level, so retail stops drawing a human's body
// parts beyond 50 + 84 = 134 m. Creature and prop chains differ; the same rule applies.
//
// OURS (step 1, this module): the NULL-level hide. The rig keeps drawing the part mesh it was
// built with (a human part's level 0 is a client_highres.dat GfxObj the base DATs do not carry,
// and the in-between levels would need their own rig geometry); when retail's pick for a part
// lands on a NULL level, that part's meshes are hidden. deg_mul is held at 0 — retail's neutral
// point (retail nudges it with frame rate, Render::CalcDegLevel, acclient.c:380231). The distance is measured
// to the entity ROOT over the root's world scale: a rig's parts sit within ~1-2 m of it, and a
// hidden part's own matrices go stale under ?skipHiddenMatrix.
//
// Hiding is per MESH with an ownership mark, never `partGroup.visible` (dismember.js owns that)
// and never layers (the indoor depth split re-stamps them): a mesh this module hid carries
// `userData.__degHid`; only those are restored, so a mesh hidden for any other reason (e.g. a
// fully translucent surface, setup_rig.js) stays hidden.
//
// `?partDegrade=on` opts in — DEFAULT OFF until a 1070 look check (built and node-tested
// 2026-10-06; the box was in use, so no live run). Needs the wasm that fills ModelMesh.didDegrade
// for entity parts (src/lib.rs `inner_to_wasm_animation_data`); an older pkg/ reports 0 and
// nothing changes.

/** Render::s_rDegradeDistance (acclient.c:45516). */
export const DEGRADE_DISTANCE = 50.0;
/** Tick period (s). The NULL-level boundary is a slow, distant edge. */
export const PART_DEGRADE_INTERVAL_S = 0.1;

/**
 * Retail `GfxObjDegradeInfo::get_degrade` (acclient.c:332356) with force_level == -1 and
 * degrades enabled.
 * @param {Array<{gfx:number, min:number, ideal:number, max:number}>} levels
 * @param {number} distance viewer -> part, already over the part scale
 * @param {number} [degMul=0] Render::deg_mul
 * @param {number} [offset=DEGRADE_DISTANCE] Render::s_rDegradeDistance
 * @returns {number} level index, -1 for an empty chain
 */
export function selectDegradeLevel(levels, distance, degMul = 0, offset = DEGRADE_DISTANCE) {
  const n = levels ? levels.length : 0;
  if (n === 0) return -1;
  const d = Math.max(Math.abs(distance) - offset, 0);
  if (degMul >= 0) {
    for (let i = 0; i < n; i++) {
      const L = levels[i];
      if (!(d >= L.ideal - (L.ideal - L.max) * degMul)) return i;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const L = levels[i];
      if (!((L.ideal - L.min) * degMul + L.ideal <= d)) return i;
    }
  }
  return n - 1;
}

/** Parse `fetch_gfx_obj_degrade_info` JSON into level records (null when empty / malformed). */
export function parseDegradeInfo(json) {
  let o = json;
  if (typeof json === "string") {
    try { o = JSON.parse(json); } catch (_) { return null; }
  }
  const src = o && Array.isArray(o.degrades) ? o.degrades : null;
  if (!src || src.length === 0) return null;
  return src.map((g) => ({
    gfx: (g.gfx_obj_id ?? 0) >>> 0,
    mode: (g.degrade_mode ?? 0) >>> 0,
    min: +g.min_dist,
    ideal: +g.ideal_dist,
    max: +g.max_dist,
  }));
}

/** Is `mesh` a rig mesh of a part (setup_rig / dismember / replacement naming)? */
function isRigMesh(m) {
  return !!(m && m.isMesh && typeof m.name === "string" && m.name.startsWith("part_"));
}

/**
 * Hide or restore one part group's rig meshes. Restores only meshes this module hid.
 * @returns {number} meshes changed
 */
export function setPartDegradeHidden(partGroup, hide) {
  const ch = partGroup && partGroup.children;
  if (!ch) return 0;
  let n = 0;
  for (let i = 0; i < ch.length; i++) {
    const m = ch[i];
    if (!isRigMesh(m)) continue;
    const ud = m.userData || (m.userData = {});
    if (hide) {
      if (m.visible) { m.visible = false; ud.__degHid = true; n++; }
    } else if (ud.__degHid) {
      m.visible = true;
      ud.__degHid = false;
      m.matrixWorldNeedsUpdate = true;
      n++;
    }
  }
  return n;
}

/** `?partDegrade=on|1|true|yes` opts in. DEFAULT OFF (pending the 1070 look check). */
export function partDegradeEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = (new URLSearchParams(window.location.search).get("partDegrade") || "").toLowerCase();
    return v === "on" || v === "1" || v === "true" || v === "yes";
  } catch (_) {
    return false;
  }
}

export class PartDegrade {
  /**
   * @param {object} o
   * @param {(did:number) => (Promise<string>|string)} o.fetchInfo `fetch_gfx_obj_degrade_info`
   * @param {number} [o.degMul=0]
   */
  constructor({ fetchInfo, degMul = 0 } = {}) {
    this._fetch = fetchInfo;
    this.degMul = degMul;
    /** Live A/B seam (`window.__partDegrade.off = true`): the next tick restores every hidden
     *  part and the module then idles until `off` is cleared. */
    this.off = false;
    /** did -> levels | null (no usable chain) | Promise (loading) */
    this._chains = new Map();
    this.stats = { ticks: 0, rigs: 0, parts: 0, hiddenParts: 0, changedMeshes: 0, chains: 0, chainErrors: 0, lastTickMs: 0 };
  }

  /** Levels for a chain DID, or null while loading / when absent. Starts the load once. */
  levelsFor(did) {
    did >>>= 0;
    if (did === 0) return null;
    const c = this._chains.get(did);
    if (c !== undefined) return c && typeof c.then === "function" ? null : c;
    if (typeof this._fetch !== "function") return null;
    const p = Promise.resolve()
      .then(() => this._fetch(did))
      .then((json) => {
        const lv = parseDegradeInfo(json);
        this._chains.set(did, lv);
        this.stats.chains++;
        return lv;
      }, () => {
        this._chains.set(did, null);
        this.stats.chainErrors++;
        return null;
      });
    this._chains.set(did, p);
    return null;
  }

  /**
   * Apply the pick to one rig.
   * @param {Array<object>} parts the rig's part Groups (`userData.didDegrade` set at build)
   * @param {number} distance camera -> rig, over the rig's scale
   * @param {boolean} isPlayer the player's own parts never degrade
   * @returns {number} parts hidden after this call
   */
  applyRig(parts, distance, isPlayer) {
    let hidden = 0;
    for (let p = 0; p < parts.length; p++) {
      const pg = parts[p];
      if (!pg) continue;
      const ud = pg.userData;
      const did = ud ? ud.didDegrade >>> 0 : 0;
      let hide = false;
      if (did !== 0 && !isPlayer) {
        const levels = this.levelsFor(did);
        if (levels) {
          const i = selectDegradeLevel(levels, distance, this.degMul);
          hide = i >= 0 && levels[i].gfx === 0;
        }
      }
      if (hide !== (ud ? ud.__degHidden === true : false)) {
        this.stats.changedMeshes += setPartDegradeHidden(pg, hide);
        if (ud) ud.__degHidden = hide;
      }
      if (hide) hidden++;
    }
    return hidden;
  }

  /**
   * One pass over the live rigs.
   * @param {Iterable<{guid:number, root:object, parts:Array<object>}>} instances
   * @param {{x:number, y:number, z:number}} cam camera WORLD position
   * @param {number} localGuid the player's guid (0 = unknown)
   */
  tick(instances, cam, localGuid) {
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    let rigs = 0, parts = 0, hidden = 0;
    for (const inst of instances) {
      const root = inst && inst.root;
      const ps = inst && inst.parts;
      if (!root || !ps || ps.length === 0 || !root.matrixWorld) continue;
      const e = root.matrixWorld.elements;
      const scale = Math.hypot(e[0], e[1], e[2]) || 1;
      const d = Math.hypot(e[12] - cam.x, e[13] - cam.y, e[14] - cam.z) / scale;
      // `off` = treat every rig like the player's: nothing degrades, hidden parts come back.
      const isPlayer = this.off || (localGuid !== 0 && (inst.guid >>> 0) === localGuid);
      rigs++;
      parts += ps.length;
      hidden += this.applyRig(ps, d, isPlayer);
    }
    const s = this.stats;
    s.ticks++;
    s.rigs = rigs;
    s.parts = parts;
    s.hiddenParts = hidden;
    s.lastTickMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - t0;
  }
}
