// scene3d/cell_static_merge.js — ?cellStaticMerge: one draw per (EnvCell, material) for the
// cell's static props (2026-10-06, 1070 perf campaign, item "draw-count cuts").
//
// WHY. cells.js builds every interior prop (furniture, shelves, lanterns, crates) as its own
// `THREE.Mesh(sharedGeometry, material | material[])`, and three issues one draw per
// geometry group — so a room with ten props in three materials costs ~10-20 draws instead of
// 3. The 1070 census (2026-10-06 handoff) counted ~351 cell-static draws at Holtburg against
// an estimated ~200 (cell, material) pairs; each draw costs ~25 µs of main-thread submission.
// The props never move (animated ones are peeled to the animated-scenery path before this
// runs), so their triangles can be baked into cell-local space once, per material.
//
// WHAT. For one cell container: every visible `userData.isCellStatic` Mesh child is split
// into its geometry groups, each group's triangles are transformed into the container's
// space (positions by the prop's placement matrix, normals by its normal matrix), and
// appended to a bucket keyed by (material, attribute layout). Each bucket becomes ONE Mesh.
// The original Mesh is replaced IN PLACE by an empty Group carrying the same name,
// transform and userData — lighting.js anchors a prop's Setup lights (lanterns, braziers) on
// the `isCellStatic` children of a cell container, and that contract must not change.
//
// The merged buffers are per-cell copies (the source geometries are shared per DID across
// cells, so they are never disposed here); the caller registers the returned geometries as
// per-landblock disposables. `?cellStaticMerge=on` opts in (default OFF until a 1070 look
// check: interiors through doorways at Holtburg, a dungeon room, a lantern's light).

/** `?cellStaticMerge=on|1|true|yes` opts in. DEFAULT OFF. */
export function cellStaticMergeEnabled() {
  try {
    if (typeof window === "undefined" || !window.location) return false;
    const v = (new URLSearchParams(window.location.search).get("cellStaticMerge") || "").toLowerCase();
    return v === "on" || v === "1" || v === "true" || v === "yes";
  } catch (_) {
    return false;
  }
}

const SUPPORTED = ["position", "normal", "uv", "uv1", "color", "acBakedLight"];

/** Attribute layout key: the attributes a merged bucket carries, with their shape. */
function layoutOf(geometry) {
  const parts = [];
  for (const name of SUPPORTED) {
    const a = geometry.getAttribute(name);
    if (a) parts.push(`${name}:${a.itemSize}:${a.normalized ? 1 : 0}:${a.array.constructor.name}`);
  }
  return parts.join("|");
}

/** Can this mesh be merged? Plain static triangle meshes with supported attributes only. */
function mergeable(m) {
  if (!m || !m.isMesh || m.isInstancedMesh || m.isBatchedMesh || m.isSkinnedMesh) return false;
  if (!m.visible || !m.userData || m.userData.isCellStatic !== true) return false;
  const g = m.geometry;
  if (!g || !g.getAttribute || !g.getAttribute("position")) return false;
  if (g.morphAttributes && Object.keys(g.morphAttributes).length) return false;
  for (const name of Object.keys(g.attributes)) {
    if (!SUPPORTED.includes(name)) return false;
    if (g.attributes[name].isInterleavedBufferAttribute) return false;
  }
  return true;
}

/**
 * The triangle ranges a mesh draws, as [{ material, start, count }] in INDEX units when the
 * geometry is indexed, VERTEX units otherwise — three r184's own group resolution.
 */
function rangesOf(m) {
  const g = m.geometry;
  const total = g.index ? g.index.count : g.attributes.position.count;
  const dr = g.drawRange || { start: 0, count: Infinity };
  const clip = (s, c) => {
    const a = Math.max(s, dr.start), b = Math.min(s + c, dr.start + dr.count, total);
    return b > a ? [a, b - a] : null;
  };
  const out = [];
  if (Array.isArray(m.material)) {
    for (const grp of g.groups || []) {
      const mat = m.material[grp.materialIndex];
      if (!mat) continue;
      const r = clip(grp.start, grp.count);
      if (r) out.push({ material: mat, start: r[0], count: r[1] });
    }
  } else if (m.material) {
    const r = clip(0, total);
    if (r) out.push({ material: m.material, start: r[0], count: r[1] });
  }
  return out;
}

/**
 * Merge one cell container's static props.
 * @param {typeof import("three")} THREE
 * @param {import("three").Object3D} container the cell container (props are its direct children)
 * @param {object} [o]
 * @param {(mat:object)=>boolean} [o.canCastShadow] cast-shadow predicate per material
 * @param {boolean} [o.shadow] shadows enabled (receiveShadow on merged meshes, cast per material)
 * @param {(m:object)=>boolean} [o.renderable] extra filter (default: every material renders)
 * @returns {{ props:number, ranges:number, meshes:number, geometries:Array<object>, skipped:number }}
 */
export function mergeCellStatics(THREE, container, o = {}) {
  const stats = { props: 0, ranges: 0, meshes: 0, geometries: [], skipped: 0 };
  if (!container || !Array.isArray(container.children)) return stats;
  const props = container.children.filter((c) => c && c.userData && c.userData.isCellStatic === true && c.isMesh);
  const take = [];
  for (const m of props) { if (mergeable(m)) take.push(m); else stats.skipped++; }
  if (take.length === 0) return stats;

  // bucket key: material object + attribute layout (a bucket's attributes must line up)
  const buckets = new Map();
  const matIds = new Map();
  const keyOf = (mat, layout) => {
    let id = matIds.get(mat);
    if (id === undefined) { id = matIds.size; matIds.set(mat, id); }
    return `${id}|${layout}`;
  };
  const _m = new THREE.Matrix4(), _n = new THREE.Matrix3(), _v = new THREE.Vector3();
  for (const m of take) {
    m.updateMatrix();
    const layout = layoutOf(m.geometry);
    for (const r of rangesOf(m)) {
      const k = keyOf(r.material, layout);
      let b = buckets.get(k);
      if (!b) { b = { material: r.material, layout, items: [], verts: 0 }; buckets.set(k, b); }
      b.items.push({ mesh: m, start: r.start, count: r.count });
      b.verts += r.count;
      stats.ranges++;
    }
  }
  stats.props = take.length;

  for (const b of buckets.values()) {
    const g0 = b.items[0].mesh.geometry;
    const names = SUPPORTED.filter((n) => g0.getAttribute(n));
    const out = {};
    for (const n of names) {
      const a = g0.getAttribute(n);
      out[n] = { size: a.itemSize, normalized: a.normalized, array: new a.array.constructor(b.verts * a.itemSize) };
    }
    let w = 0;
    for (const it of b.items) {
      const g = it.mesh.geometry;
      _m.copy(it.mesh.matrix);
      _n.getNormalMatrix(_m);
      const idx = g.index ? g.index.array : null;
      for (let i = 0; i < it.count; i++, w++) {
        const v = idx ? idx[it.start + i] : it.start + i;
        for (const n of names) {
          const a = g.getAttribute(n), s = a.itemSize, dst = out[n].array, src = a.array;
          if (n === "position") {
            _v.set(src[v * 3], src[v * 3 + 1], src[v * 3 + 2]).applyMatrix4(_m);
            dst[w * 3] = _v.x; dst[w * 3 + 1] = _v.y; dst[w * 3 + 2] = _v.z;
          } else if (n === "normal") {
            _v.set(src[v * 3], src[v * 3 + 1], src[v * 3 + 2]).applyMatrix3(_n).normalize();
            dst[w * 3] = _v.x; dst[w * 3 + 1] = _v.y; dst[w * 3 + 2] = _v.z;
          } else {
            for (let c = 0; c < s; c++) dst[w * s + c] = src[v * s + c];
          }
        }
      }
    }
    const geom = new THREE.BufferGeometry();
    for (const n of names) geom.setAttribute(n, new THREE.BufferAttribute(out[n].array, out[n].size, out[n].normalized));
    geom.computeBoundingSphere();
    geom.computeBoundingBox();
    geom.userData = { __cellStaticMerged: true };
    const mesh = new THREE.Mesh(geom, b.material);
    mesh.name = `cellstatic-merged-${container.userData?.cellId != null ? (container.userData.cellId >>> 0).toString(16).padStart(8, "0") : "x"}-${stats.meshes}`;
    mesh.userData = { isCellStaticMerged: true, cellId: container.userData?.cellId, props: new Set(b.items.map((it) => it.mesh)).size };
    if (o.shadow) {
      mesh.castShadow = typeof o.canCastShadow === "function" ? !!o.canCastShadow(b.material) : true;
      mesh.receiveShadow = true;
    }
    container.add(mesh);
    stats.geometries.push(geom);
    stats.meshes++;
  }

  // Replace each merged prop by an empty anchor Group: same name / transform / userData, so the
  // light scan (lighting.js recordCellStatics) and anything else keyed on the prop still finds it.
  for (const m of take) {
    const anchor = new THREE.Group();
    anchor.name = m.name;
    anchor.position.copy(m.position);
    anchor.quaternion.copy(m.quaternion);
    anchor.scale.copy(m.scale);
    anchor.userData = { ...m.userData, mergedInto: true };
    const i = container.children.indexOf(m);
    container.remove(m);
    container.add(anchor);
    // keep sibling order stable (anchors take their prop's slot)
    if (i >= 0) {
      const at = container.children.indexOf(anchor);
      container.children.splice(at, 1);
      container.children.splice(i, 0, anchor);
    }
  }
  return stats;
}
