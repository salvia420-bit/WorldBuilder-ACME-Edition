// tests/rig_mesh_alias.test.mjs — `?rigMeshAlias` (scene3d/setup_rig.js
// `installRigMeshAlias`): identity surface meshes of rig parts share their
// part's matrixWorld. Lane notes: docs/2026-10-26-rust-rig.md §10.
//
// Two identical worlds, A (three's walk) and B (alias walk), driven through the
// same frames; skip_hidden_matrix installed as in production.
//   S  synthetic rigs with every special case — identity / offset / hidden
//      meshes, an InstancedMesh, a mesh with a child, a mesh with its own
//      updateMatrix, a held item (nested rig) under a part, a light and a
//      camera under parts, a hidden part, a world-frozen part with −0 / NaN
//      injected into its world matrix — and every mutation that must drop or
//      survive the alias: poses, root moves, hides / shows, dislocation
//      (quaternion + position writes), reparent part→part, rig→rig, attach to
//      the entities group (debris) and back, strip + restore, equip swap,
//      scale / pivot / Euler / applyMatrix4 / matrixAutoUpdate writes,
//      skip-hidden off, direct updateMatrixWorld calls. After every walk: every
//      node's matrix, matrixWorld and matrixWorldNeedsUpdate compared, and
//      every mesh's matrixWorld against three's product
//      `multiplyMatrices(parent.matrixWorld, matrix)`. Differences are split
//      into SIGNED-ZERO-ONLY (+0 vs −0, reported) and REAL (fail) — and, for
//      hidden meshes, the documented "follows its part" staleness (reported).
//   R  the reader audit between walks: raycasts (no refresh) right after a
//      walk and after a part-only refresh (partFrames-style), Box3 (refresh),
//      root.updateWorldMatrix(false, true) (rig radius / shadow-only casters),
//      partFrames reads — what each sees with the alias, counted.
//   E  an EntityManager A/B (real spawn path, fake wasm) with walks, motion
//      changes, the jump tween, a frozen corpse pose, dismember's real
//      dislocatePart / clearDislocations / restoreParts, hides, a mesh moved
//      to another entity's part and back.
//
// Run: node tests/rig_mesh_alias.test.mjs

globalThis.window = { location: { search: "" } };
globalThis.requestAnimationFrame = () => 0; // dismember's re-assert loop: not needed here

const THREE = await import("three");
const rig = await import("../scene3d/setup_rig.js");
const { installSkipHiddenMatrix } = await import("../scene3d/skip_hidden_matrix.js");
installSkipHiddenMatrix(THREE, { force: true });

let passed = 0, failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail != null && detail !== "" ? " — " + detail : ""}`);
  if (ok) passed += 1; else failed += 1;
}

// ---------------------------------------------------------------------------
// Comparison with signed-zero accounting
// ---------------------------------------------------------------------------
const tally = { nodes: 0, meshes: 0, zeroSign: 0, zeroSignSites: [], real: [], hiddenStale: 0, flag: [] };
// a, b: Matrix4.elements. Returns "same" | "zero" (only ±0 differ) | "real".
function classify(a, b) {
  let zero = false;
  for (let i = 0; i < 16; i += 1) {
    if (Object.is(a[i], b[i])) continue;
    if (a[i] === b[i]) { zero = true; continue; } // +0 vs −0
    if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
    return "real";
  }
  return zero ? "zero" : "same";
}
const _prod = new THREE.Matrix4();
function noteZero(where) {
  tally.zeroSign += 1;
  if (tally.zeroSignSites.length < 8) tally.zeroSignSites.push(where);
}
function drawn(o) {
  for (let x = o; x; x = x.parent) if (x.visible === false) return false;
  return true;
}

// Walk A and B in parallel: same shape, then per node compare.
function compareWorlds(tag, A, B) {
  const sa = [A.scene], sb = [B.scene];
  let n = 0;
  while (sa.length) {
    const x = sa.pop(), y = sb.pop();
    if (!y || x.children.length !== y.children.length || x.type !== y.type) {
      tally.real.push(`${tag}: tree shape at node ${n}`);
      return;
    }
    n += 1;
    tally.nodes += 1;
    const isMesh = x.isMesh === true;
    // local matrix
    const cm = classify(x.matrix.elements, y.matrix.elements);
    if (cm === "real") tally.real.push(`${tag}: node ${n} (${x.type} ${x.name}) matrix`);
    else if (cm === "zero") noteZero(`${tag}: node ${n} (${x.type} ${x.name}) matrix`);
    // world matrix
    const cw = classify(x.matrixWorld.elements, y.matrixWorld.elements);
    if (cw !== "same") {
      if (isMesh && !drawn(y) && cw === "real") tally.hiddenStale += 1; // documented: B follows its part
      else if (cw === "zero") noteZero(`${tag}: node ${n} (${x.type} ${x.name}) matrixWorld`);
      else tally.real.push(`${tag}: node ${n} (${x.type} ${x.name}${isMesh ? ", mesh" : ""}) matrixWorld`);
    }
    if (x.matrixWorldNeedsUpdate !== y.matrixWorldNeedsUpdate) {
      tally.flag.push(`${tag}: node ${n} (${x.type}) matrixWorldNeedsUpdate ${x.matrixWorldNeedsUpdate} vs ${y.matrixWorldNeedsUpdate}`);
    }
    if (isMesh && y.parent && y.matrixWorldAutoUpdate !== undefined) {
      tally.meshes += 1;
      // B's mesh world vs three's product of B's parent world and B's local
      // matrix — the value three would have written (for a visible mesh; a
      // hidden one in A keeps its last value, see hiddenStale).
      _prod.multiplyMatrices(y.parent.matrixWorld, y.matrix);
      const cp = classify(_prod.elements, y.matrixWorld.elements);
      if (cp === "zero") noteZero(`${tag}: node ${n} B mesh vs product`);
      else if (cp === "real" && drawn(y)) tally.real.push(`${tag}: node ${n} B mesh vs parent × matrix`);
    }
    for (let i = 0; i < x.children.length; i += 1) { sa.push(x.children[i]); sb.push(y.children[i]); }
  }
}

// ---------------------------------------------------------------------------
// S — synthetic worlds
// ---------------------------------------------------------------------------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const GEOMS = [new THREE.BoxGeometry(0.3, 0.3, 0.6), new THREE.SphereGeometry(0.2, 8, 6), new THREE.ConeGeometry(0.15, 0.4, 8)];
const MAT = new THREE.MeshBasicMaterial();

function buildWorld(alias) {
  rig.__setRigMeshAliasForTest(alias);
  const r = rng(0xbadc0de);
  const rnd = (k = 1) => (r() * 2 - 1) * k;
  const quat = () => new THREE.Quaternion(rnd(), rnd(), rnd(), rnd()).normalize();
  const scene = new THREE.Scene();
  const world = new THREE.Group();
  world.rotation.x = -Math.PI / 2;
  world.position.set(0, -2.5, 0);
  scene.add(world);
  const group = new THREE.Group();
  world.add(group);
  const rigs = [];
  const mkPart = (root) => {
    const g = new THREE.Group();
    g.position.set(rnd(0.4), rnd(0.4), 0.2 + r() * 1.5);
    g.quaternion.copy(quat());
    root.add(g);
    rig.installRigMeshAlias(THREE, g);
    return g;
  };
  for (let k = 0; k < 5; k += 1) {
    const root = new THREE.Group();
    root.name = `rig${k}`;
    root.position.set(k * 2.5 - 5, rnd(2), rnd(0.5));
    root.quaternion.copy(quat());
    if (k === 3) root.scale.set(1.25, 1.25, 1.25);
    group.add(root);
    const parts = [];
    for (let p = 0; p < 8; p += 1) {
      const g = mkPart(root);
      g.name = `rig${k}_part${p}`;
      parts.push(g);
      for (let m = 0; m < 3; m += 1) {
        const mesh = new THREE.Mesh(GEOMS[m], MAT);
        mesh.name = `rig${k}_part${p}_mesh${m}`;
        if (m === 2 && p % 3 === 0) mesh.position.set(0.02, 0, 0); // a non-identity surface
        if ((k + p + m) % 7 === 0) mesh.visible = false; // fully translucent surface
        g.add(mesh);
      }
    }
    // Specials that must stay on three's path.
    const inst = new THREE.InstancedMesh(GEOMS[0], MAT, 2);
    inst.name = `rig${k}_instanced`;
    parts[2].add(inst);
    const withKid = new THREE.Mesh(GEOMS[1], MAT);
    withKid.name = `rig${k}_meshWithChild`;
    withKid.add(new THREE.Mesh(GEOMS[2], MAT));
    parts[3].add(withKid);
    const own = new THREE.Mesh(GEOMS[1], MAT);
    own.name = `rig${k}_ownUpdateMatrix`;
    own.updateMatrix = function () { THREE.Object3D.prototype.updateMatrix.call(this); };
    parts[4].add(own);
    parts[6].add(new THREE.PointLight());
    const cam = new THREE.PerspectiveCamera();
    cam.position.set(0, 0.05, 0.1);
    parts[6].add(cam);
    // A held item: a nested rig root under a part, its parts aliased too.
    const held = new THREE.Group();
    held.name = `rig${k}_held`;
    held.position.set(0.05, 0, 0.12);
    held.quaternion.copy(quat());
    const hp = mkPart(held);
    hp.add(new THREE.Mesh(GEOMS[0], MAT));
    hp.add(new THREE.Mesh(GEOMS[2], MAT));
    parts[5].add(held);
    rigs.push({ root, parts, held, hp });
  }
  // A world-frozen part (matrixWorldAutoUpdate off) whose world we can poison.
  const frozenPart = rigs[4].parts[0];
  frozenPart.matrixWorldAutoUpdate = false;
  return { scene, world, group, rigs, frozenPart, rnd, quat };
}

const steps = [];
function mutate(S, f) {
  const { rigs, group } = S;
  // Poses + root motion every frame (deterministic per frame index).
  const r = rng(1000 + f);
  const rnd = (k = 1) => (r() * 2 - 1) * k;
  for (const { root, parts } of rigs) {
    root.position.x += 0.01;
    root.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 0.01));
    for (let p = 0; p < parts.length; p += 1) {
      if (p === 0 && root === rigs[4].root) continue;
      parts[p].position.set(rnd(0.4), rnd(0.4), 0.2 + r() * 1.5);
      parts[p].quaternion.set(rnd(), rnd(), rnd(), 1).normalize();
    }
  }
  const m0 = (k, p, m) => rigs[k].parts[p].children.find((c) => c.name === `rig${k}_part${p}_mesh${m}`);
  switch (f) {
    // (after the warm-up: a non-aliased mesh is offered the alias on one walk in eight)
    case 14: rigs[0].parts[1].children[0].visible = false; rigs[1].parts[2].children[1].visible = false; break;
    case 17: rigs[0].parts[1].children[0].visible = true; rigs[1].parts[2].children[1].visible = true; break;
    case 12: { // dismember dislocation: quaternion then position on the part's meshes
      for (const c of rigs[2].parts[3].children) if (c.isMesh) { c.quaternion.set(0.1, 0, 0, 0.995); c.position.set(0.01, 0.02, 0); }
      break;
    }
    case 18: for (const c of rigs[2].parts[3].children) if (c.isMesh) { c.quaternion.set(0, 0, 0, 1); c.position.set(0, 0, 0); } break;
    case 20: rigs[0].parts[3].add(m0(0, 0, 1)); break; // reparent part→part (same rig)
    case 22: rigs[1].parts[4].add(m0(0, 0, 0)); break; // to another rig
    case 24: group.attach(m0(1, 5, 0)); break; // detach as debris (attach decomposes the world pose)
    case 28: { // back from debris: restore the identity local pose, re-add
      const d = group.children.find((c) => c.name === "rig1_part5_mesh0");
      if (d) { d.position.set(0, 0, 0); d.quaternion.set(0, 0, 0, 1); d.scale.set(1, 1, 1); rigs[1].parts[5].add(d); }
      break;
    }
    case 26: { // poison the frozen part's world matrix with a −0
      S.frozenPart.matrixWorld.copy(S.frozenPart.parent.matrixWorld).multiply(S.frozenPart.matrix);
      S.frozenPart.matrixWorld.elements[4] = -0;
      break;
    }
    case 30: { // equip swap: a part's surfaces replaced
      const g = rigs[3].parts[2];
      for (const c of g.children.slice()) if (c.isMesh && !c.isInstancedMesh) g.remove(c);
      for (let m = 0; m < 2; m += 1) { const nm = new THREE.Mesh(GEOMS[m], MAT); nm.name = `rig3_part2_new${m}`; g.add(nm); }
      break;
    }
    case 31: S.frozenPart.matrixWorld.elements[9] = NaN; break;
    case 33: m0(2, 1, 1).scale.set(1.5, 1, 1); break;
    case 34: S.frozenPart.matrixWorldAutoUpdate = true; break;
    case 36: m0(2, 1, 1).scale.set(1, 1, 1); break;
    case 38: m0(3, 1, 0).pivot = new THREE.Vector3(0, 0, 0.1); break;
    case 40: m0(3, 1, 0).pivot = null; break;
    case 42: m0(4, 2, 1).rotation.set(0.1, 0, 0); break;
    case 44: m0(4, 2, 1).rotation.set(0, 0, 0); break;
    case 46: m0(0, 5, 0).matrixAutoUpdate = true; break; // someone flips a flag while aliased
    case 48: m0(0, 6, 1).applyMatrix4(new THREE.Matrix4().makeTranslation(0.05, 0, 0)); break;
    case 50: rigs[1].parts[6].visible = false; break;
    case 53: rigs[1].parts[6].visible = true; break;
    case 55: rigs[2].root.visible = false; break;
    case 57: rigs[2].root.visible = true; break;
    default: break;
  }
}

function runS() {
  console.log("=== S: synthetic worlds, alias walk vs three's walk ===");
  const A = buildWorld(false);
  const B = buildWorld(true);
  rig.__setRigMeshAliasForTest(true);
  const s0 = rig.rigMeshAliasStats();
  const shm = globalThis.window.__skipHiddenMatrix;
  for (let f = 0; f < 60; f += 1) {
    mutate(A, f);
    mutate(B, f);
    if (f === 45 && shm) shm.on = false;
    if (f === 47 && shm) shm.on = true;
    A.scene.updateMatrixWorld();
    B.scene.updateMatrixWorld();
    compareWorlds(`frame ${f}`, A, B);
    if (f === 58) {
      for (const S of [A, B]) { S.rigs[0].root.updateMatrixWorld(true); S.world.updateMatrixWorld(); }
      compareWorlds("direct updateMatrixWorld calls", A, B);
    }
    steps.push(f);
  }
  const s1 = rig.rigMeshAliasStats();
  check(`S: ${steps.length} walks, ${tally.nodes} node visits — no REAL difference in any matrix`, tally.real.length === 0,
    tally.real.slice(0, 4).join(" | "));
  check("S: matrixWorldNeedsUpdate identical on every node (hidden ones included)", tally.flag.length === 0, tally.flag.slice(0, 3).join(" | "));
  check(`S: signed-zero-only differences: ${tally.zeroSign}`, tally.zeroSign === 0, tally.zeroSignSites.join(" | "));
  console.log(`  (S: hidden aliased meshes whose world followed their part where three left the last visible walk: ${tally.hiddenStale} mesh-frames)`);
  check("S: the alias did the work (meshes shared, specials delegated, drops happened)",
    s1.shared - s0.shared > 2000 && s1.aliased - s0.aliased > 80 && s1.unaliased - s0.unaliased > 5 && s1.unclean - s0.unclean > 0,
    `shared ${s1.shared - s0.shared}, aliased ${s1.aliased - s0.aliased}, unaliased ${s1.unaliased - s0.unaliased}, unclean ${s1.unclean - s0.unclean}, delegated ${s1.delegated - s0.delegated}`);
  const r0 = B.rigs[0];
  const special = (name) => { let o = null; B.scene.traverse((x) => { if (x.name === name) o = x; }); return o; };
  check("S: specials never aliased (instanced, mesh with a child, own updateMatrix)",
    !rig.rigMeshAliased(special("rig0_instanced")) && !rig.rigMeshAliased(special("rig0_meshWithChild")) &&
    !rig.rigMeshAliased(special("rig0_ownUpdateMatrix")));
  const id = r0.parts[2].children.find((c) => c.name === "rig0_part2_mesh0");
  const off = r0.parts[0].children.find((c) => c.name === "rig0_part0_mesh2");
  check("S: an identity mesh is aliased, an offset one is not", rig.rigMeshAliased(id) && !rig.rigMeshAliased(off),
    `${rig.rigMeshAliased(id)} / ${rig.rigMeshAliased(off)}`);
  const deb = B.group.children.find((c) => c.name === "rig1_part5_mesh0");
  check("S: a mesh detached to the entities group (debris) is no longer aliased", !deb || !rig.rigMeshAliased(deb));
  return { A, B };
}

// ---------------------------------------------------------------------------
// R — readers between walks
// ---------------------------------------------------------------------------
function runReaders(A, B) {
  console.log("=== R: reader audit between walks ===");
  const rc = new THREE.Raycaster();
  const rays = [];
  for (let i = 0; i < 24; i += 1) {
    rays.push([new THREE.Vector3(-8 + i * 0.7, 8, 0.2 * (i % 5)), new THREE.Vector3(0.05 * (i % 3), -1, 0.02).normalize()]);
  }
  const hitsOf = (S, visibleOnly) => {
    const out = [];
    for (const [o, d] of rays) {
      rc.set(o, d);
      const hits = rc.intersectObjects(S.group.children, true);
      for (const h of hits) {
        if (visibleOnly && !drawn(h.object)) continue; // picking.js discards hidden hits
        out.push(`${h.object.name}@${h.distance}`);
      }
    }
    return out.join(";");
  };
  // (1) right after a walk, no refresh: picking's situation (it runs between frames)
  for (const S of [A, B]) { S.scene.updateMatrixWorld(); }
  const after = hitsOf(A, true) === hitsOf(B, true);
  check("R1: raycast right after a walk (no refresh) — same hits (picking's situation)", after);
  // (2) a part-only refresh (partFrames-style updateWorldMatrix on parts after a pose), then raycast
  const poseAndRefreshParts = (S) => {
    for (const { parts } of S.rigs) {
      for (const g of parts) {
        g.position.x += 0.07;
        g.updateWorldMatrix(true, false);
      }
    }
  };
  poseAndRefreshParts(A); poseAndRefreshParts(B);
  const ha = hitsOf(A, true), hb = hitsOf(B, true);
  const fresher = ha !== hb;
  console.log(`  (R2: after a part-only refresh, a raycast with no refresh sees ${fresher ? "DIFFERENT (B: the part's fresh pose; A: the mesh's last walk)" : "the same"} hits — the documented 'fresher' case; no app reader raycasts inside the tick)`);
  check("R2: the fresher-values case is real and detected (documentation check)", fresher);
  // (3) Box3.setFromObject (occlusion box, carnage impact point): refreshes every node
  const boxes = (S) => S.rigs.map(({ root }) => {
    const b = new THREE.Box3().setFromObject(root);
    return [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z];
  });
  const ba = boxes(A), bb = boxes(B);
  let boxReal = 0, boxZero = 0;
  for (let i = 0; i < ba.length; i += 1) {
    for (let k = 0; k < 6; k += 1) {
      if (Object.is(ba[i][k], bb[i][k])) continue;
      if (ba[i][k] === bb[i][k]) boxZero += 1; else boxReal += 1;
    }
  }
  check("R3: Box3.setFromObject (refreshes every node) — same boxes", boxReal === 0, `real ${boxReal}, ±0 ${boxZero}`);
  // (4) root.updateWorldMatrix(false, true) then mesh worlds (lighting rig radius, shadow-only casters)
  for (const S of [A, B]) for (const { root } of S.rigs) root.updateWorldMatrix(false, true);
  const before = tally.real.length, beforeZero = tally.zeroSign;
  compareWorlds("R4 root.updateWorldMatrix(false, true)", A, B);
  check("R4: root.updateWorldMatrix(false, true) — every mesh world identical", tally.real.length === before && tally.zeroSign === beforeZero,
    tally.real.slice(before, before + 3).join(" | "));
  // (5) partFrames proxy (particle anchors, hooks) reads PARTS
  const fa = rig.createPartFramesProxy(THREE, A.rigs[0].parts), fb = rig.createPartFramesProxy(THREE, B.rigs[0].parts);
  let pfSame = true;
  for (let i = 0; i < A.rigs[0].parts.length; i += 1) {
    const x = fa[i], y = fb[i];
    if (!(Object.is(x.position.x, y.position.x) && Object.is(x.position.y, y.position.y) && Object.is(x.position.z, y.position.z) &&
      Object.is(x.quaternion.w, y.quaternion.w))) pfSame = false;
  }
  check("R5: partFrames proxy (particle anchors / hooks) — same part frames", pfSame);
}

// ---------------------------------------------------------------------------
// E — EntityManager A/B through the real spawn path
// ---------------------------------------------------------------------------
async function runEntities() {
  console.log("=== E: EntityManager A/B (real spawn, dismember helpers) ===");
  const { EntityManager } = await import("../scene3d/entities.js");
  const { installFakeMotionSequence } = await import("../harness/lib/fake_motion_sequence.mjs");
  const dismember = await import("../scene3d/dismember.js");
  const gen = await import("../tools/rust_parity/gen_rig.mjs");
  installFakeMotionSequence();
  const descs = gen.buildRigDescriptors();
  const byName = (n) => descs.find((d) => d.name === n).desc;
  const READY = 0x41000003, WALK = 0x45000005, ONESHOT = 0x10000058;
  const clips = { [READY]: byName("human-17p-identity-root"), [WALK]: byName("human-17p-run"), [ONESHOT]: { ...byName("human-17p-run"), rootFrames: null } };
  const partMesh = (p) => ({
    triCount: 1,
    positions: new Float32Array([p * 0.1, 0, 0, p * 0.1 + 0.5, 0, 0, p * 0.1 + 0.25, 0.5, 0]),
    uvs: new Float32Array([0, 0, 1, 0, 0.5, 1]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    surfaceIndices: new Uint8Array([0]),
    surfaces: new Uint32Array([0x08001234]),
  });
  const wasmExports = {
    async fetchEntityAnimationKeyframes(_s, _mc, _tc, _pal, _subs, _mt, cmd, stance, fromMotion) {
      cmd >>>= 0;
      const d = fromMotion >>> 0 ? null : clips[cmd];
      const n = d ? d.numFrames : 0;
      const meshes = Array.from({ length: 17 }, (_, p) => partMesh(p));
      const out = {
        partCount: 17, numFrames: n, framerate: n ? 30 : 0, duration: n / 30,
        frameTimes: Float32Array.from({ length: n }, (_, f) => f / 30),
        segmentStarts: n ? Uint32Array.of(0) : new Uint32Array(0),
        segmentCounts: n ? Uint32Array.of(n) : new Uint32Array(0),
        resolvedStance: stance || 0x3d,
        partFrames: d ? d.partFrames : new Float32Array(0),
        takePartMeshes() { return meshes.splice(0); },
        takeHooks() { return []; },
      };
      if (d && d.posFrames !== undefined) out.posFrames = d.posFrames;
      if (d && d.rootFrames) out.rootFrames = d.rootFrames;
      return out;
    },
    async fetchEntitySurfacesPixels(dids) {
      return dids.map(() => ({ pixels: new Uint8Array(16).fill(255), width: 2, height: 2 }));
    },
  };
  const meta = (guid, x) => ({
    guid, modelId: 0x02000001, mtableId: 0x09000001, landblockId: 0xa9b40001, x, y: 10, z: 0,
    qw: 1, qx: 0, qy: 0, qz: 0, paletteId: 0, motionCommand: READY, motionStance: 0, objScale: 1, name: "t",
    wcid: 1, itemType: 0x10, iconId: 0,
    modelChanges: new Uint32Array(0), textureChanges: new Uint32Array(0), subPalettes: new Uint32Array(0),
  });
  const mk = async (alias) => {
    rig.__setRigMeshAliasForTest(alias);
    const scene = new THREE.Scene();
    const world = new THREE.Group();
    world.rotation.x = -Math.PI / 2;
    scene.add(world);
    const group = new THREE.Group();
    world.add(group);
    const em = new EntityManager({ entitiesGroup: group, materialCache: null }, wasmExports);
    const a = await em.spawn(meta(0x50000401, 10));
    const b = await em.spawn(meta(0x50000402, 13));
    em._tweenClockMs = 1000;
    // Shape the rig like a real one: a non-identity surface and a hidden one.
    a.parts[7].children[0].position.set(0.03, 0, 0);
    a.parts[8].children[0].visible = false;
    return { scene, world, group, em, a, b };
  };
  const A = await mk(false);
  const B = await mk(true);
  rig.__setRigMeshAliasForTest(true);
  const sE0 = rig.rigMeshAliasStats();
  const both = async (fn) => { await fn(A); await fn(B); };
  let ticks = 0;
  const tick = (tag, n = 1) => {
    for (let i = 0; i < n; i += 1) {
      A.em.tick(0.016); B.em.tick(0.016);
      A.scene.updateMatrixWorld(); B.scene.updateMatrixWorld();
      compareWorlds(`E ${tag} tick ${i}`, A, B);
      ticks += 1;
    }
  };
  const r0 = tally.real.length, z0 = tally.zeroSign;
  tick("idle", 8);
  await both((X) => X.em.setMotion(X.a.guid, WALK, 0x3d));
  tick("walk", 12);
  await both((X) => X.em._tryUnifiedCycleOneShot(X.b.guid, 0x02000001, 0x09000001, ONESHOT, 0x3d));
  tick("one-shot", 10);
  await both((X) => X.em._applyHumanJumpPose(X.a));
  tick("jump tween", 6);
  // dismember: dislocation writes quaternion + position on a part's meshes
  await both((X) => { dismember.dislocatePart(X.a, 10, { severity: 0.8, chainParts: [11, 12], rand: rng(42) }); });
  tick("dislocated", 6);
  await both((X) => { dismember.clearDislocations(X.a); });
  tick("dislocation cleared", 6);
  // strip a limb (dismember's _stripPartForPass shape) and heal it (restoreParts)
  await both((X) => {
    const part = X.a.parts[4];
    const meshes = part.children.filter((c) => c.isMesh && c.geometry);
    X.a._dismemberStash = new Map([[4, meshes]]);
    for (const m of meshes) part.remove(m);
    X.a.parts[5].visible = false;
    X.a._dismemberHidden = new Set([5]);
  });
  tick("limb stripped", 6);
  await both((X) => { dismember.restoreParts(X.a); });
  tick("limb restored", 6);
  // a mesh moved to the other entity's part and back (corpse carry-over shape)
  await both((X) => { X.b.parts[2].add(X.a.parts[2].children[0]); });
  tick("mesh carried over", 4);
  await both((X) => { X.a.parts[2].add(X.b.parts[2].children[X.b.parts[2].children.length - 1]); });
  tick("mesh carried back", 4);
  // hides: a degraded part, a culled rig
  await both((X) => { X.b.parts[1].visible = false; X.b.root.visible = false; });
  tick("hidden", 4);
  await both((X) => { X.b.parts[1].visible = true; X.b.root.visible = true; });
  tick("shown", 4);
  // frozen corpse pose (ragdoll) over the playhead
  const frozen = { n: 17, pos: new Float32Array(17 * 3).map((_, i) => (i % 5) * 0.1), quat: new Float32Array(17 * 4).map((_, i) => (i % 4 === 3 ? 1 : 0)) };
  await both((X) => { X.a._ragdollFrozenPose = frozen; });
  tick("frozen corpse pose", 6);
  const sE1 = rig.rigMeshAliasStats();
  check(`E: ${ticks} ticks — no REAL difference in any matrix`, tally.real.length === r0, tally.real.slice(r0, r0 + 4).join(" | "));
  check(`E: signed-zero-only differences: ${tally.zeroSign - z0}`, tally.zeroSign === z0, tally.zeroSignSites.slice(0, 4).join(" | "));
  check("E: the B entities' meshes were aliased and re-validated", sE1.shared - sE0.shared > 1000 && sE1.unaliased - sE0.unaliased > 0,
    `shared ${sE1.shared - sE0.shared}, aliased ${sE1.aliased - sE0.aliased}, unaliased ${sE1.unaliased - sE0.unaliased}`);
  check("E: flag-off manager untouched (its parts walk three's way)",
    !Object.prototype.hasOwnProperty.call(A.a.parts[0], "updateMatrixWorld") && Object.prototype.hasOwnProperty.call(B.a.parts[0], "updateMatrixWorld"));
  A.em.dispose(); B.em.dispose();
}

console.log("rig mesh alias — ?rigMeshAlias vs three's walk");
const { A, B } = runS();
runReaders(A, B);
await runEntities();
rig.__setRigMeshAliasForTest(undefined);
console.log(`  totals: ${tally.nodes} node comparisons, ${tally.meshes} mesh-vs-product checks, ${tally.zeroSign} signed-zero-only, ${tally.hiddenStale} hidden-mesh staleness mesh-frames`);
console.log("===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");
process.exit(failed > 0 ? 1 : 0);
