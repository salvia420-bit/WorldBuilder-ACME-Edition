// scene3d/vehicle/airframe.js — the vehicle's looks as data (vehicles DESIGN §5.1 rule 2, HBV1 v2 Parts + PartRoles).
//
// The server's VehicleProfile lists retail parts (a Setup 0x02… or GfxObj 0x01… placed in the vehicle frame: x right,
// y forward, z up; origin = the ground under the main wheels) and a role per part. The Hellcat is built from Asheron's
// Call items: a fuselage of barrels behind a steel-keg cowling, an open bucket for the cockpit, tower-shield wings, kite-
// shield tips and tail, three Spadones for the propeller behind a round-shield spinner, crossbows in the wings, wands
// for the lightning rails, steel kegs for the bombs, round shields for wheels. A capable client draws THIS instead of
// the retail stand-in (the Drudge Balloon every retail client sees), which it hides (render-only).
//
// Roles (VehiclePartRole): 0 static; 1 propeller (spins about the vehicle's y axis through the hub = the first
// propeller part's offset); 2 gear (drawn while Parked / Takeoff / Landing); 3 canopy (hidden in the cockpit view);
// 4 | (weapon << 16) ordnance (drawn while that weapon is loaded: the state's missile / bomb masks by kind ordinal).
// The Gear parts are authored for the taildragger's parked stance: the parked aircraft is tipped GEAR_PITCH tail-down
// about the main wheels' contact line (the most forward Gear part) — presentation only, eased in and out.
//
// Geometry: every part decoded through the near tier's own path (wasm fetchBuildingPlacement → meshToGeometryGroups),
// placed, and MERGED per (bucket, material) once per profile — ~25 meshes for 56 parts; the materials are the shared
// lit statics materials of the material cache (never disposed here; no new program). Instances (one per vehicle)
// share the template's geometry; the template is freed by dispose().
//
// `?vehicleAirframe=off` (exact) draws the stand-in as before.

import { meshToGeometryGroups } from "../adapter.js";
import { surfacePixelsFetcher } from "../bake_worker_client.js";
import { materialCanCastShadow } from "../materials.js";
import { prewarmSubtree } from "../bake_prewarm.js";
import { geomBundlesActive, assembleModels as assembleGeomBundles, bundleToPartGroups } from "../geom_bundles.js";

export const PART_ROLE = Object.freeze({ STATIC: 0, PROPELLER: 1, GEAR: 2, CANOPY: 3, ORDNANCE: 4 });
export const GEAR_PITCH = (11 * Math.PI) / 180;
/** Parked stance blend time constant (s): the tail lifts as the take-off starts, settles on touchdown. */
export const GEAR_TAU = 0.35;
/** Propeller: rad/s at idle and the extra at full throttle (34°/frame at 60 fps: visibly spinning, not strobing). */
export const PROP = Object.freeze({ idle: 6, full: 30 });
const MODE_PARKED = 0, MODE_TAKEOFF = 1, MODE_LANDING = 3;

export function airframeEnabled(search) {
  try { return new URLSearchParams(search || "").get("vehicleAirframe") !== "off"; } catch (_) { return true; }
}

export const roleKind = (r) => (r >>> 0) & 0xffff;
export const roleWeapon = (r) => ((r >>> 0) >>> 16) & 0xff;

/** True when the profile carries a composite airframe (parts beyond the stand-in itself, with roles). */
export function hasComposite(profile) {
  const parts = profile?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return false;
  if (parts.length === 1 && (parts[0].did >>> 0) === (profile.standInSetup >>> 0)) return false;
  return true;
}

/** {kind, ordinal}: the weapon's kind and its index among the profile's weapons of that kind. */
export function kindOrdinal(profile, weaponIndex) {
  const ws = profile?.weapons || [];
  const w = ws[weaponIndex];
  if (!w) return { kind: 0, ordinal: -1 };
  let ord = 0;
  for (let i = 0; i < weaponIndex; i++) if (ws[i] && ws[i].kind === w.kind) ord++;
  return { kind: w.kind, ordinal: ord };
}

/** Is weapon `w` loaded, by the state's masks (+ a local "fired" set the pilot marks before the next state)? */
export function weaponLoaded(profile, w, missileMask, bombMask, localSpent) {
  if (localSpent && localSpent.has(w)) return false;
  const { kind, ordinal } = kindOrdinal(profile, w);
  if (ordinal < 0) return true;
  if (kind === 2) return Number.isFinite(missileMask) ? ((missileMask >>> ordinal) & 1) === 1 : true;
  if (kind === 3) return Number.isFinite(bombMask) ? ((bombMask >>> ordinal) & 1) === 1 : true;
  return true;
}

/** The main wheels' contact line (y of the most forward Gear part), or null without gear. */
export function gearPivotY(profile) {
  const parts = profile?.parts || [];
  const roles = profile?.partRoles || [];
  let y = null;
  for (let i = 0; i < parts.length; i++) {
    if (roleKind(roles[i] ?? 0) !== PART_ROLE.GEAR) continue;
    const oy = parts[i].offset?.[1];
    if (Number.isFinite(oy) && (y === null || oy > y)) y = oy;
  }
  return y;
}

/** Gear stance target for a mode: 1 = sitting on its wheels (tail down), 0 = flying level. */
export function gearTarget(mode, agl) {
  if (mode === MODE_PARKED) return 1;
  if (mode === MODE_LANDING && Number.isFinite(agl) && agl < 1.5) return 1;
  return 0;
}

function _getCachedMat(mc, sid) {
  if (!mc || !sid) return null;
  if (mc.materials instanceof Map) {
    if (!mc.materials.has(sid)) return null;
    return typeof mc.getCached === "function" ? mc.getCached(sid) : mc.materials.get(sid);
  }
  if (typeof mc.getCached === "function") {
    const m = mc.getCached(sid);
    if (m && (!mc.fallbackMaterial || m !== mc.fallbackMaterial)) return m;
  }
  return null;
}

/**
 * Decode one retail model into [{geometry, material, doubleSided}] in the model's own frame (the Setup's placement
 * frames applied). Shared by the airframe and the quarrels. Returns [] when the client cannot decode (tests, no wasm).
 */
export async function decodeModel(live, THREE, did, preAssembled = null) {
  const wasm = live?.wasmExports;
  const mc = live?.materialCache;
  if (!THREE || !mc) return [];

  const modelDid = did >>> 0;
  let partList = null;

  // Fast path: try resident HBG1 geometry bundles first.
  if (geomBundlesActive()) {
    try {
      const bMap = preAssembled || (await assembleGeomBundles([modelDid]));
      const b = bMap?.byModel ? bMap.byModel.get(modelDid) : bMap?.get?.(modelDid);
      if (b) {
        const bpg = bundleToPartGroups(b, bMap?.buffer);
        if (bpg && Array.isArray(bpg.parts)) {
          partList = bpg.parts.map((pt) => ({
            hinge: pt.hinge || null,
            groups: (pt.groups || []).map((grp) => ({
              geometry:
                grp.geometry?.index && typeof grp.geometry.toNonIndexed === "function"
                  ? grp.geometry.toNonIndexed()
                  : grp.geometry,
              surfaceDid: Number(grp.surfaceDid ?? 0) >>> 0,
              doubleSided: !!grp.doubleSided,
            })),
          }));
        } else if (Array.isArray(bpg)) {
          partList = [
            {
              hinge: null,
              groups: bpg.map((grp) => ({
                geometry:
                  grp.geometry?.index && typeof grp.geometry.toNonIndexed === "function"
                    ? grp.geometry.toNonIndexed()
                    : grp.geometry,
                surfaceDid: Number(grp.surfaceDid ?? 0) >>> 0,
                doubleSided: !!grp.doubleSided,
              })),
            },
          ];
        }
      }
    } catch (_) { /* fall through to wasm placement fetch */ }
  }

  // Fallback: fetch placement via urgent lane so airframe decode isn't starved by background bakes.
  if (!partList) {
    if (!wasm || typeof wasm.fetchBuildingPlacement !== "function") return [];
    let placement = null;
    try {
      placement = await wasm.fetchBuildingPlacement(modelDid, true);
    } catch (_) {
      return [];
    }
    if (!placement) return [];
    if (typeof placement.partGroups === "function") {
      const groups = placement.partGroups() || [];
      try { placement.free?.(); } catch (_) { /* freed */ }
      partList = [
        {
          hinge: null,
          groups: groups.map((grp) => ({
            geometry: grp.geometry,
            surfaceDid: Number(grp.surfaceDid ?? 0) >>> 0,
            doubleSided: !!grp.doubleSided,
          })),
        },
      ];
    } else {
      const partCount = placement.partCount | 0;
      const partMeshes = partCount ? placement.takePartMeshes() : [];
      const hinge = typeof placement.takePartHingeFrames === "function" ? placement.takePartHingeFrames() : [];
      try { placement.free?.(); } catch (_) { /* freed */ }
      partList = [];
      for (let i = 0; i < partCount; i++) {
        const wm = partMeshes[i];
        if (!wm) continue;
        try {
          const { groups, surfaceDids } = meshToGeometryGroups(wm);
          const normGroups = [];
          for (let g = 0; g < (groups?.length || 0); g++) {
            const grp = groups[g];
            normGroups.push({
              geometry: grp.geometry,
              surfaceDid: Number(grp.surfaceDid || surfaceDids?.[g] || 0) >>> 0,
              doubleSided: !!grp.doubleSided,
            });
          }
          partList.push({ hinge: hinge[i] || null, groups: normGroups });
        } catch (_) { /* a part that does not build is left out */ }
        try { wm.free?.(); } catch (_) { /* freed */ }
      }
    }
  }

  const fetchPixels = surfacePixelsFetcher(wasm);
  const urgentFetchPixels = (dids) => fetchPixels(dids, true);

  // Batch preload all uncached surface textures for this model on the urgent lane.
  const missingSidsSet = new Set();
  for (let i = 0; i < partList.length; i++) {
    const groups = partList[i].groups || [];
    for (let g = 0; g < groups.length; g++) {
      const sid = Number(groups[g].surfaceDid) >>> 0;
      if (sid !== 0 && !_getCachedMat(mc, sid)) {
        missingSidsSet.add(sid);
      }
    }
  }
  const missingSids = [...missingSidsSet];
  if (missingSids.length > 0 && typeof mc.preload === "function") {
    try {
      await mc.preload(missingSids, urgentFetchPixels);
    } catch (_) { /* per-group get falls back cleanly */ }
  }

  const out = [];
  const m = new THREE.Matrix4();
  for (let i = 0; i < partList.length; i++) {
    const { hinge: h, groups } = partList[i];
    m.identity();
    if (h) m.compose(new THREE.Vector3(h.x, h.y, h.z), new THREE.Quaternion(h.qx, h.qy, h.qz, h.qw), new THREE.Vector3(1, 1, 1));
    try {
      for (let g = 0; g < (groups?.length || 0); g++) {
        const grp = groups[g];
        const sid = Number(grp.surfaceDid ?? 0) >>> 0;
        // eslint-disable-next-line no-await-in-loop
        const material = _getCachedMat(mc, sid) || (await mc.get(sid, urgentFetchPixels));
        if (!grp.geometry || !material) continue;
        if (h) grp.geometry.applyMatrix4(m);
        out.push({ geometry: grp.geometry, material, doubleSided: !!grp.doubleSided });
      }
    } catch (_) { /* a part that does not build is left out */ }
  }
  return out;
}

/** Merge non-indexed geometries (position / normal / uv) into one. */
export function mergeGeometries(THREE, geoms) {
  let n = 0;
  for (const g of geoms) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  let o = 0;
  for (const g of geoms) {
    const c = g.attributes.position.count;
    pos.set(g.attributes.position.array.subarray(0, c * 3), o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array.subarray(0, c * 3), o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array.subarray(0, c * 2), o * 2);
    o += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/**
 * The composite airframes of every vehicle this client draws.
 * @param {{liveScene3d: object, THREE: object}} deps
 */
export function createAirframes(deps = {}) {
  const live = deps.liveScene3d;
  const THREE = deps.THREE;
  const templates = new Map(); // profileKey → {status, buckets: [{key, meshes:[{geometry, material, cast}]}], hub, pivotY, error}
  const instances = new Map(); // guid → instance
  const stats = { built: 0, failed: 0, instances: 0, buckets: 0, meshes: 0 };

  function templateKey(profile) {
    return `${profile.profileKey}|${(profile.parts || []).length}`;
  }

  async function buildTemplate(profile) {
    const parts = profile.parts || [];
    const roles = profile.partRoles || [];
    let preAssembled = null;
    if (geomBundlesActive() && parts.length > 0) {
      try {
        preAssembled = await assembleGeomBundles(parts.map((m) => m.did >>> 0));
      } catch (_) {
        preAssembled = null;
      }
    }
    const uniqueDids = [...new Set(parts.map((p) => p.did >>> 0))];
    const models = new Map(); // did → decoded pieces (shared geometry: cloned per placement below)
    await Promise.all(
      uniqueDids.map(async (did) => {
        models.set(did, await decodeModel(live, THREE, did, preAssembled));
      })
    );
    // hub = the first propeller part's offset (the spinner's / blades' common pivot)
    let hub = null;
    for (let i = 0; i < parts.length; i++) if (roleKind(roles[i] ?? 0) === PART_ROLE.PROPELLER) { hub = parts[i].offset; break; }
    const buckets = new Map(); // bucketKey → Map(material → [geoms])
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3(), quat = new THREE.Quaternion(), scl = new THREE.Vector3();
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const role = roles[i] ?? 0;
      const kind = roleKind(role);
      const bucket = kind === PART_ROLE.PROPELLER ? "prop" : kind === PART_ROLE.GEAR ? "gear" : kind === PART_ROLE.CANOPY ? "canopy"
        : kind === PART_ROLE.ORDNANCE ? `ord:${roleWeapon(role)}` : "static";
      const o = p.offset || [0, 0, 0];
      // the propeller in the hub's frame (its group spins about the hub)
      pos.set(o[0] - (bucket === "prop" && hub ? hub[0] : 0), o[1] - (bucket === "prop" && hub ? hub[1] : 0), o[2] - (bucket === "prop" && hub ? hub[2] : 0));
      const r = p.rotation || [1, 0, 0, 0]; // W, X, Y, Z
      quat.set(r[1], r[2], r[3], r[0]).normalize();
      const s = Number.isFinite(p.scale) && p.scale > 0 ? p.scale : 1;
      scl.set(s, s, s);
      m.compose(pos, quat, scl);
      for (const piece of models.get(p.did >>> 0) || []) {
        const g = piece.geometry.clone();
        g.applyMatrix4(m);
        let byMat = buckets.get(bucket);
        if (!byMat) buckets.set(bucket, (byMat = new Map()));
        let list = byMat.get(piece.material);
        if (!list) byMat.set(piece.material, (list = []));
        list.push(g);
      }
    }
    // the decoded originals are no longer needed (each placement merged a transformed clone)
    for (const pieces of models.values()) for (const piece of pieces) { try { piece.geometry.dispose(); } catch (_) {} }
    const out = [];
    for (const [key, byMat] of buckets) {
      const meshes = [];
      for (const [material, geoms] of byMat) {
        const merged = mergeGeometries(THREE, geoms);
        for (const g of geoms) { try { g.dispose(); } catch (_) {} }
        meshes.push({ geometry: merged, material, cast: materialCanCastShadow(material) });
      }
      out.push({ key, meshes });
      stats.meshes += meshes.length;
    }
    stats.buckets += out.length;
    return { buckets: out, hub, pivotY: gearPivotY(profile) };
  }

  function templateFor(profile) {
    const key = templateKey(profile);
    let t = templates.get(key);
    if (!t) {
      t = { status: "building", buckets: null, hub: null, pivotY: null, error: null, promise: null };
      templates.set(key, t);
      t.promise = buildTemplate(profile).then((r) => {
        Object.assign(t, r);
        t.status = t.buckets.length ? "ready" : "failed";
        if (t.status === "ready") {
          stats.built++;
          try {
            const grp = new THREE.Group();
            for (const b of t.buckets) {
              for (const mm of b.meshes) {
                const m = new THREE.Mesh(mm.geometry, mm.material);
                m.castShadow = mm.cast;
                m.receiveShadow = true;
                grp.add(m);
              }
            }
            prewarmSubtree(live, grp).catch(() => {});
          } catch (_) { /* best effort */ }
        } else {
          stats.failed++;
        }
      }).catch((e) => {
        t.status = "failed";
        t.error = String(e && e.message ? e.message : e);
        stats.failed++;
        console.warn("[vehicles] airframe build failed (the stand-in stays):", t.error);
      });
    }
    return t;
  }

  function instantiate(guid, profile, t) {
    const root = new THREE.Group();
    root.name = `vehicle-airframe-${(guid >>> 0).toString(16)}`;
    const body = new THREE.Group(); // tipped tail-down when parked (about the main wheels' contact line)
    root.add(body);
    const groups = { static: body, gear: new THREE.Group(), canopy: new THREE.Group(), prop: new THREE.Group() };
    body.add(groups.gear, groups.canopy, groups.prop);
    if (t.hub) groups.prop.position.set(t.hub[0], t.hub[1], t.hub[2]);
    const ordnance = new Map(); // weapon index → Group
    for (const b of t.buckets) {
      let parent = groups[b.key];
      if (!parent && b.key.startsWith("ord:")) {
        const w = Number(b.key.slice(4));
        parent = new THREE.Group();
        body.add(parent);
        ordnance.set(w, parent);
      }
      for (const mm of b.meshes) {
        const mesh = new THREE.Mesh(mm.geometry, mm.material);
        mesh.castShadow = mm.cast;
        mesh.receiveShadow = true;
        mesh.name = `airframe-${b.key}`;
        parent.add(mesh);
      }
    }
    live.worldRoot.add(root);
    stats.instances++;
    return { guid: guid >>> 0, profile, t, root, body, groups, ordnance, propAngle: 0, gear: 1, lastMode: null, visible: true };
  }

  return {
    /** The vehicle's airframe instance (built on first call; null while its template decodes or when it failed). */
    ensure(v) {
      if (!THREE || !live?.worldRoot || !v?.profile || !hasComposite(v.profile)) return null;
      const g = v.guid >>> 0;
      let inst = instances.get(g);
      if (inst) return inst;
      const t = templateFor(v.profile);
      if (t.status !== "ready") return null;
      inst = instantiate(g, v.profile, t);
      instances.set(g, inst);
      return inst;
    },
    /** Is the template for this profile still decoding / failed / ready? */
    status(profile) { return profile ? (templates.get(templateKey(profile))?.status ?? "none") : "none"; },
    get(guid) { return instances.get(guid >>> 0) ?? null; },
    /**
     * Pose one airframe for this frame. pose = {x, y, z, heading, pitch, bank, mode}; o = {q: [w,x,y,z] orientation,
     * dt, throttle, agl, cockpit, missileMask, bombMask, localSpent}.
     */
    pose(inst, pose, o) {
      const r = inst.root;
      r.position.set(pose.x, pose.y, pose.z);
      r.quaternion.set(o.q[1], o.q[2], o.q[3], o.q[0]);
      // parked stance: tail down about the main wheels' contact line
      const dt = Math.max(0, Math.min(0.25, o.dt || 0));
      const target = gearTarget(pose.mode, o.agl);
      inst.gear += (target - inst.gear) * (1 - Math.exp(-dt / GEAR_TAU));
      if (Math.abs(target - inst.gear) < 1e-3) inst.gear = target;
      const tilt = inst.t.pivotY === null ? 0 : GEAR_PITCH * inst.gear;
      const b = inst.body;
      if (tilt !== inst.lastTilt) {
        inst.lastTilt = tilt;
        const py = inst.t.pivotY ?? 0;
        b.rotation.set(tilt, 0, 0);
        // rotate about (0, py, 0): position = pivot − R·pivot
        b.position.set(0, py - py * Math.cos(tilt), -py * Math.sin(tilt));
      }
      inst.groups.gear.visible = pose.mode === MODE_PARKED || pose.mode === MODE_TAKEOFF || pose.mode === MODE_LANDING;
      inst.groups.canopy.visible = !o.cockpit;
      // propeller
      const thr = Number.isFinite(o.throttle) ? Math.max(0, Math.min(1, o.throttle)) : (pose.mode === MODE_PARKED ? 0 : 0.7);
      inst.propAngle = (inst.propAngle + (PROP.idle + PROP.full * thr) * dt) % (2 * Math.PI);
      inst.groups.prop.rotation.set(0, inst.propAngle, 0);
      for (const [w, grp] of inst.ordnance) grp.visible = weaponLoaded(inst.profile, w, o.missileMask, o.bombMask, o.localSpent);
      return tilt;
    },
    /** The parked tilt (radians, nose up) last applied to this vehicle (the seat follows it). */
    tiltOf(guid) { return instances.get(guid >>> 0)?.lastTilt ?? 0; },
    /** A station's ordnance meshes in the vehicle frame (the falling bomb is drawn with them). */
    ordnanceMeshes(guid, weapon) {
      const inst = instances.get(guid >>> 0);
      const grp = inst?.ordnance.get(weapon);
      return grp ? grp.children.filter((c) => c.isMesh) : [];
    },
    templateBucket(profile, key) {
      const t = templates.get(templateKey(profile));
      return t?.buckets?.find((b) => b.key === key) ?? null;
    },
    remove(guid) {
      const inst = instances.get(guid >>> 0);
      if (!inst) return false;
      instances.delete(guid >>> 0);
      try { inst.root.parent?.remove(inst.root); } catch (_) { /* gone */ }
      stats.instances--;
      return true;
    },
    stats: () => ({ ...stats, templates: [...templates.entries()].map(([k, t]) => ({ key: k, status: t.status, error: t.error })), live: instances.size }),
    dispose() {
      for (const g of [...instances.keys()]) this.remove(g);
      for (const t of templates.values()) {
        for (const b of t.buckets || []) for (const mm of b.meshes) { try { mm.geometry.dispose(); } catch (_) {} }
      }
      templates.clear();
    },
  };
}
