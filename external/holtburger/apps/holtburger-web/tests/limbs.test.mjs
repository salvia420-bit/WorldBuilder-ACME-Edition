// limbs.test.mjs — the Phase-2 limb registry + visual limp (`?limbDamage`).
//
// NEW 2026-08-03. Until today `scene3d/limbs.js` (923 lines, DEFAULT-ON since
// the 2026-08-02 owner flip, never eye-tested) had ZERO test coverage — and it
// shipped two unused test seams, `_setLimbRegistryForTests` and
// `_resetLimbFlagCacheForTests`, that no suite had ever called. That absence is
// why the pivot defect below could sit in a default-on rig writer unnoticed.
//
// The headline lock is §5: a leg whose HIP slot falls outside the rest-origin
// array must never reach `position.set()`. `leg.hip` is a SETUP slot index
// drawn from `parentIndex`, whose length is independent of `inst.parts.length`,
// while the only upstream length check validates the origins against
// `parts.length` — so the pivot read could run off the end and hand
// `applyLimbLimp` `[undefined, undefined, undefined]`. The resulting NaN was
// PERMANENT: `_resolveBase` remembers what we wrote and compares with `===`,
// which no NaN can ever satisfy, so the next frame re-derived its base from the
// NaN it had just been given, forever. An entity's part simply vanished.
//
// Everything here is pure — limbs.js imports no `three`, so this runs under
// bare node with no stub loader.
//
// Run: node tests/limbs.test.mjs   (from apps/holtburger-web/)

// The flag reader is memoised and lazy, and reads `window.location.search`.
// Install the DOM shim BEFORE the import so §1 sees a real absent-param read.
globalThis.window = { location: { search: "" } };

const {
  PARENT_ROOT,
  MIN_LEG_GAP,
  LIMP_PERIOD_S,
  LIMP_MAX_ANGLE,
  LIMP_MAX_DIP,
  limbDamageEnabled,
  _resetLimbFlagCacheForTests,
  buildChains,
  chainScore,
  splitLegChains,
  tagLeg,
  classifyLimbs,
  minZOfBoxUnderFrame,
  partMinZFromInstance,
  ensureLimbRegistry,
  getLimbRegistry,
  clearLimbRegistryCache,
  _setLimbRegistryForTests,
  setLimbDamage,
  clearLimbDamage,
  restoreLimbPose,
  applyLimbLimp,
} = await import("../scene3d/limbs.js");

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}
const near = (a, b, eps = 1e-9) => Number.isFinite(a) && Math.abs(a - b) <= eps;

/* ── duck-typed rig fixtures (limbs.js never imports three) ───────────── */

function makeGroup() {
  return {
    position: {
      x: 0, y: 0, z: 0,
      set(a, b, c) { this.x = a; this.y = b; this.z = c; return this; },
    },
    quaternion: {
      x: 0, y: 0, z: 0, w: 1,
      set(a, b, c, d) { this.x = a; this.y = b; this.z = c; this.w = d; return this; },
    },
    children: [],
  };
}

/**
 * A rig of `nParts` part Groups, each carrying one surface mesh stamped with
 * its own `userData.partIndex` (the filter `partMinZFromInstance` uses to keep
 * a wielded child entity's sword out of the host part's box). Point boxes, so
 * a part's lowest rest Z is exactly its rest origin Z.
 */
function makeInst(nParts, originZs, { originSlots = nParts } = {}) {
  const parts = [];
  for (let p = 0; p < nParts; p++) {
    const g = makeGroup();
    g.children.push({
      geometry: { boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } } },
      userData: { partIndex: p },
    });
    parts.push(g);
  }
  const origins = new Float32Array(originSlots * 3);
  const orients = new Float32Array(originSlots * 4);
  for (let p = 0; p < Math.min(nParts, originSlots); p++) {
    origins[p * 3 + 2] = originZs[p] ?? 0;
    orients[p * 4 + 0] = 1; // AC wire order (qw, qx, qy, qz) — identity
  }
  return { parts, _restOrigins: origins, _restOrientations: orients, _setupId: 0 };
}

/* ── 1. the flag is DEFAULT-ON ────────────────────────────────────────── */
section("flag polarity (url-flags.md:798 — default ON, `!== \"off\"`)");
{
  _resetLimbFlagCacheForTests();
  window.location.search = "";
  ok(limbDamageEnabled() === true, "an ABSENT ?limbDamage reads ON (owner default-on 2026-08-02)");
  _resetLimbFlagCacheForTests();
  window.location.search = "?limbDamage=off";
  ok(limbDamageEnabled() === false, "?limbDamage=off is the escape hatch");
  _resetLimbFlagCacheForTests();
  window.location.search = "?limbDamage=1";
  ok(limbDamageEnabled() === true, "a non-'off' value stays ON (this is NOT a strict opt-in)");
  _resetLimbFlagCacheForTests();
  window.location.search = "?limbDamage=on";
  ok(limbDamageEnabled() === true, "?limbDamage=on is ON");
}

/* ── 2. chain building ────────────────────────────────────────────────── */
section("buildChains");
{
  // 0=root, 1←0, 2←1, 3←0 : leaves are 2 and 3.
  const pi = [PARENT_ROOT, 0, 1, 0];
  const { rootIndex, chains, leaves } = buildChains(pi);
  ok(rootIndex === 0, "the first PARENT_ROOT slot is the root");
  ok(leaves.join(",") === "2,3", `leaves are the slots nobody parents (got ${leaves})`);
  ok(chains.length === 2 && chains[0].join(">") === "0>1>2", "chains are emitted root-first");
  ok(chains[1].join(">") === "0>3", "a one-hop chain is still a chain");

  ok(buildChains([]).chains.length === 0, "an empty parent index yields nothing");
  ok(buildChains(null).rootIndex === -1, "a null parent index is handled");

  // A cyclic parent index must terminate, not hang.
  const cyc = buildChains([1, 2, 1]);
  ok(cyc.chains.length === 1 && cyc.chains[0].length <= 3, "a cycle terminates via the seen-set + step cap");
  // An out-of-range parent terminates the walk (malformed DAT).
  const oor = buildChains([PARENT_ROOT, 99]);
  ok(oor.chains.some((c) => c[c.length - 1] === 1), "an out-of-range parent ends the chain instead of throwing");
}

/* ── 3. scoring + the leg split ───────────────────────────────────────── */
section("chainScore / splitLegChains");
{
  ok(chainScore([0, 1, 2], [5, 1, 0.2]) === 0.2, "a chain scores by its LOWEST non-root part");
  ok(chainScore([0, 1], [0]) === undefined, "an unscorable chain returns undefined");
  ok(chainScore([0], [0, 1]) === undefined, "a root-only chain is unscorable (length < 2)");
  ok(chainScore([0, 1, 2], new Map([[1, 0.9], [2, 0.3]])) === 0.3, "a Map works as well as an array");
  ok(chainScore([0, 1, 2], [5, NaN, 0.4]) === 0.4, "a non-finite part score is skipped, not adopted");

  // Biped: two legs at ~0, two arms high. The gap sits at index 1 (lower half).
  ok(splitLegChains([0.0, 0.05, 1.2, 1.3]).join(",") === "0,1", "biped: the two low chains are the legs");
  // Quadruped: four legs, eight chains.
  const quad = splitLegChains([0.23, 0.3, 0.4, 0.86, 1.4, 1.5, 1.6, 1.7]);
  ok(quad.length === 4, `quadruped: four legs (got ${quad.length})`);
  // Degenerate rigs must refuse to classify rather than invent legs.
  ok(splitLegChains([1, 1, 1, 1]).length === 0, "a flat distribution (a prop/chest) yields NO legs");
  ok(splitLegChains([0, 5]).length === 0, "a single-leg split is rejected (legCount < 2)");
  ok(splitLegChains([]).length === 0, "no scores, no legs");
  ok(splitLegChains([0, 0.05, 1.2, 1.3], { minGap: 2 }).length === 0, "a gap under minGap is refused");
  ok(MIN_LEG_GAP === 0.1, "MIN_LEG_GAP is the documented 0.1 m");

  ok(tagLeg(-1, 1, false).side === "L" && tagLeg(-1, 1, false).end === null,
    "a biped leg gets a side but no fore/aft (both legs share a station)");
  ok(tagLeg(1, -1, true).side === "R" && tagLeg(1, -1, true).end === "B", "a multi-leg rig gets both tags");
}

/* ── 4. rest-pose geometry probe ──────────────────────────────────────── */
section("minZOfBoxUnderFrame / partMinZFromInstance");
{
  // Identity frame: lowest Z is the box min plus the origin.
  ok(near(minZOfBoxUnderFrame([-1, -1, -2], [1, 1, 3], [0, 0, 0, 1], [0, 0, 10]), 8),
    "identity frame: minZ = box.min.z + origin.z");
  // 90° about X maps +Y onto +Z, so the box's Y extent now drives minZ. Rotating
  // ONLY the min corner would give the wrong answer here — the corner sweep is
  // what makes this right.
  const s = Math.SQRT1_2;
  ok(near(minZOfBoxUnderFrame([-1, -4, 0], [1, 4, 0], [s, 0, 0, s], [0, 0, 0]), -4, 1e-6),
    "a rotated box sweeps all eight corners (the Y extent becomes the Z extent)");

  const inst = makeInst(3, [1.0, 0.0, 0.5]);
  const mz = partMinZFromInstance(inst);
  ok(mz && near(mz[1], 0) && near(mz[2], 0.5), "per-part lowest rest Z reads the rest arrays, not live transforms");
  // A wielded child entity parented under a part must not poison the box.
  inst.parts[1].children.push({
    geometry: { boundingBox: { min: { x: 0, y: 0, z: -99 }, max: { x: 0, y: 0, z: -99 } } },
    userData: { partIndex: 7 }, // someone else's part index
  });
  ok(near(partMinZFromInstance(inst)[1], 0), "a foreign child (a wielded sword) is filtered out by partIndex");
  ok(partMinZFromInstance({ parts: [] }) === null, "no parts ⇒ no probe");
  ok(partMinZFromInstance({ parts: [makeGroup()], _restOrigins: new Float32Array(1) }) === null,
    "a short rest array ⇒ no probe");
}

/* ── 5. REGRESSION: an out-of-range hip must not NaN the rig ──────────── */
section("out-of-range hip slot (2026-08-03 regression lock)");
{
  clearLimbRegistryCache();
  // 8 SETUP slots, but only 5 decoded parts / 5 rest origins. Slots 6 and 7 are
  // the two legs' HIPS — named by the chains, absent from `parts` and past the
  // end of `_restOrigins`. This is the shape the guard exists for.
  //   0: root      1←6 (leg A leaf)   2←7 (leg B leaf)
  //   3←0, 4←0 (two high chains)      5: root (unscorable stub)
  //   6←0, 7←0 (the two hips)
  const parentIndex = new Uint32Array([PARENT_ROOT, 6, 7, 0, 0, PARENT_ROOT, 0, 0]);
  const inst = makeInst(5, [1.0, 0.0, 0.05, 1.2, 1.3]);
  inst._setupId = 0xbadf00d;

  const reg = await ensureLimbRegistry(0xbadf00d, inst, {
    fetchSetupParentIndex: async () => parentIndex,
  });
  ok(!!reg, "the registry still builds — an unreachable hip is not a build failure");
  ok(reg.legs.length === 2, `both low chains classify as legs (got ${reg.legs.length})`);
  ok(reg.legs.every((l) => l.hip >= inst.parts.length),
    "the fixture really does put the hips outside the decoded part array");
  ok(reg.legs.every((l) => l.pivot === null),
    "an out-of-range hip yields pivot === null, NOT [undefined, undefined, undefined]");

  // Now drive the per-frame path. `parts[6]` / `parts[7]` do not exist, so the
  // pivot fallback is the ONLY branch available — pre-fix this wrote NaN into
  // part 1 and part 2 and could never recover.
  _resetLimbFlagCacheForTests();
  window.location.search = "?limbDamage=on";
  for (const leg of reg.legs) setLimbDamage(inst, leg.leaf, 1.0);
  const before = inst.parts.map((g) => ({ ...g.position }));
  let applied = false;
  for (let f = 0; f < 3; f++) applied = applyLimbLimp(inst, 1 / 60) || applied;

  ok(applied === false, "a leg with no usable pivot applies no offset at all");
  const finite = inst.parts.every((g) =>
    Number.isFinite(g.position.x) && Number.isFinite(g.position.y) && Number.isFinite(g.position.z) &&
    Number.isFinite(g.quaternion.x) && Number.isFinite(g.quaternion.w));
  ok(finite, "NO part transform is NaN after three frames (pre-fix: parts 1 and 2 were NaN on frame 1)");
  const unchanged = inst.parts.every((g, i) =>
    g.position.x === before[i].x && g.position.y === before[i].y && g.position.z === before[i].z);
  ok(unchanged, "the untouched rig is left byte-identical");
}

/* ── 6. the limp itself ───────────────────────────────────────────────── */
section("applyLimbLimp — offsets, math, anti-drift");
{
  clearLimbRegistryCache();
  _resetLimbFlagCacheForTests();
  window.location.search = "?limbDamage=on";

  const SETUP = 0x1234;
  const inst = makeInst(3, [1.0, 0.5, 0.0]);
  inst._setupId = SETUP;
  inst.parts[1].position.set(0, 0, 0.5); // hip
  inst.parts[2].position.set(0, 0.25, 0.0); // foot, 0.25 m forward of the hip
  // Hand-seeded registry via the seam that shipped unused since 2026-08-02.
  _setLimbRegistryForTests(SETUP, {
    setupId: SETUP,
    parentIndex: [PARENT_ROOT, 0, 1],
    rootIndex: 0,
    chains: [[0, 1, 2]],
    partMinZ: [1.0, 0.5, 0.0],
    legs: [{
      chainIndex: 0, parts: [0, 1, 2], movable: [1, 2], hip: 1, leaf: 2,
      side: "R", end: null, score: 0, phaseOffset: 0, pivot: [0, 0, 0.5],
    }],
  });

  ok(applyLimbLimp(inst, 1 / 60) === false, "an undamaged entity is a two-line bail-out");
  ok(setLimbDamage(inst, 2, 0.8) === true, "setLimbDamage reports the change");
  ok(setLimbDamage(inst, 2, 0.8) === true, "…and is idempotent-safe to re-arm");

  const dt = 0.2;
  const rootBefore = { ...inst.parts[0].position };
  ok(applyLimbLimp(inst, dt) === true, "a damaged leg applies an offset");

  // Independent re-derivation of the documented transform.
  const sev = 0.8;
  const w = 0.5 - 0.5 * Math.cos((dt * Math.PI * 2) / LIMP_PERIOD_S);
  const theta = sev * LIMP_MAX_ANGLE * w;
  const dip = -sev * LIMP_MAX_DIP * w;
  const [px, py, pz] = [0, 0, 0.5];
  const vy = 0.25 - py;
  const vz = 0.0 - pz;
  const expY = py + (vy * Math.cos(theta) - vz * Math.sin(theta));
  const expZ = pz + (vy * Math.sin(theta) + vz * Math.cos(theta)) + dip;
  const foot = inst.parts[2].position;
  ok(near(foot.x, 0, 1e-12), "the swing is a pure +X rotation: the X coordinate never moves");
  ok(near(foot.y, expY, 1e-12), `the foot swings to the sagittal solution (${foot.y} vs ${expY})`);
  ok(near(foot.z, expZ, 1e-12), "…and sinks by severity × LIMP_MAX_DIP × w");
  // The hip is the pivot, so it only sinks.
  ok(near(inst.parts[1].position.y, 0, 1e-12) && near(inst.parts[1].position.z, 0.5 + dip, 1e-12),
    "the hip pivots in place and takes only the dip");
  // Quaternion: premultiplied by (sin(θ/2), 0, 0, cos(θ/2)) on an identity base.
  ok(near(inst.parts[2].quaternion.x, Math.sin(theta / 2), 1e-12) &&
     near(inst.parts[2].quaternion.w, Math.cos(theta / 2), 1e-12),
    "the part orientation is the base premultiplied by the X half-angle quaternion");
  // The shared root/torso part must NEVER move — moving it drags the body.
  ok(rootBefore.x === inst.parts[0].position.x &&
     rootBefore.y === inst.parts[0].position.y &&
     rootBefore.z === inst.parts[0].position.z &&
     inst.parts[0].quaternion.w === 1,
    "the root part (chain[0]) is excluded from `movable` and is byte-identical");

  /* Anti-drift: with NO external pose writer, a second frame must re-use the
   * remembered base rather than integrating its own output. Pre-`_resolveBase`
   * this folded the creature in half within a second. */
  const afterFrame1 = { ...foot };
  applyLimbLimp(inst, 1e-9); // advance the phase by ~nothing
  ok(Math.abs(foot.y - afterFrame1.y) < 1e-6 && Math.abs(foot.z - afterFrame1.z) < 1e-6,
    "a frozen rig does not integrate its own offset (the _resolveBase latch holds)");

  // An external writer (the mixer) DOES get adopted as the new base. Write a
  // DIFFERENT pose than last frame's base, or the assertion cannot tell the
  // two branches of `_resolveBase` apart at all: re-writing the same numbers
  // produces the same output whether the latch fires or not.
  inst.parts[2].position.set(0, 0.40, 0.0);
  applyLimbLimp(inst, 1e-9);
  ok(inst.parts[2].position.y > afterFrame1.y + 0.1,
    `a fresh mixer pose is adopted as the NEW base (${inst.parts[2].position.y.toFixed(4)} vs ` +
    `${afterFrame1.y.toFixed(4)} — a stale base would reproduce the old value)`);

  /* Restore + clear */
  restoreLimbPose(inst);
  // 0.40 — the LAST base adopted above, which is exactly the point: restore
  // replays what we remembered, not what the part was posed at on frame 1.
  ok(near(inst.parts[2].position.y, 0.40, 1e-7) && near(inst.parts[2].position.z, 0, 1e-7),
    "restoreLimbPose writes the remembered pre-offset transform back");
  setLimbDamage(inst, 2, 1);
  applyLimbLimp(inst, 0.1);
  ok(setLimbDamage(inst, 2, 0) === true, "severity <= 0 clears the entry");
  ok(near(inst.parts[2].position.y, 0.40, 1e-7), "…and restores the rig it had bent");
  ok(inst._limbDamage.size === 0, "the damage map is emptied");
  clearLimbDamage(inst);
  ok(inst._limbDamage.size === 0, "clearLimbDamage on an already-clean entity is a no-op");
}

/* ── 7. flag-off is inert ─────────────────────────────────────────────── */
section("flag off");
{
  _resetLimbFlagCacheForTests();
  window.location.search = "?limbDamage=off";
  const inst = makeInst(3, [1, 0.5, 0]);
  inst._setupId = 0x1234;
  inst._limbDamage = new Map([[2, 1]]);
  inst.parts[2].position.set(0, 0.25, 0);
  ok(applyLimbLimp(inst, 0.2) === false, "?limbDamage=off bails on the first line");
  ok(inst.parts[2].position.y === 0.25, "…and writes nothing");
  _resetLimbFlagCacheForTests();
  window.location.search = "";
}

/* ── 8. registry caching ──────────────────────────────────────────────── */
section("registry cache");
{
  clearLimbRegistryCache();
  const inst = makeInst(4, [1.0, 0.0, 0.05, 1.3]);
  let fetches = 0;
  const wasm = {
    fetchSetupParentIndex: async () => {
      fetches++;
      return new Uint32Array([PARENT_ROOT, 0, 0, 0]);
    },
  };
  const [a, b] = await Promise.all([
    ensureLimbRegistry(0x55, inst, wasm),
    ensureLimbRegistry(0x55, inst, wasm),
  ]);
  ok(fetches === 1, `concurrent spawns share ONE wasm fetch (got ${fetches})`);
  ok(a === b, "…and the same registry object");
  ok(getLimbRegistry(0x55) === a, "the sync accessor returns the cached registry");
  ok(getLimbRegistry(0xdead) === null, "an unbuilt setup reads null, never undefined");

  // An empty parent index is a PERMANENT null (no hierarchy in that Setup).
  await ensureLimbRegistry(0x56, inst, { fetchSetupParentIndex: async () => new Uint32Array(0) });
  ok(getLimbRegistry(0x56) === null, "a hierarchy-less Setup caches as null");
  ok(await ensureLimbRegistry(0, inst, wasm) === null, "setup id 0 is refused");
  clearLimbRegistryCache();
  ok(getLimbRegistry(0x55) === null, "clearLimbRegistryCache drops everything");
}

console.log(`\nlimbs: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
