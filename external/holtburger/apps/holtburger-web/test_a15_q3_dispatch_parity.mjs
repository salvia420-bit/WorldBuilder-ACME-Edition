// A15-Q3 (2026-06-12, SQ3 spec §5) — acceptance gate for the unified
// entity-update dispatcher.
//
//   PART 1 — call-sequence parity: over synthetic plain-JS updates for
//            kinds 0,1,2,3,4,5,6,7,8,9 (every field set), the unified
//            `dispatchEntityUpdate` produces the same EntityManager call
//            sequence as the legacy direct-drain arm
//            (`_legacyDirectDrainArm`) for the shared kinds.
//   PART 2 — flag gating: D2 (FU-1 wield nudge) fires only under
//            em._wieldHandAttach; D4 (FU-3 server-swing pose) fires only
//            under ?serverSwing=on + local guid + attack-class cmd.
//   PART 3 — D3 (?dispatchParity=on): the F6-2 swing echo is swallowed
//            ONLY when the flag is on AND consumeLocalSwingEcho returns
//            true; otherwise setMotion runs.
//   PART 4 — lifetime: the drainEntityEvents3D wrapper frees each handle
//            exactly once; the shared-drain hook path NEVER frees.
//            dispatchEntityUpdate never throws on a hostile update.
//   PART 5 — ?legacyDirectDrain=on routes to the verbatim legacy arm
//            (observable: no __lastEntityWorldPos pos-slot stash, which
//            only the unified core performs on KIND_POSITION).
//
// loop.js imports three-dependent modules (entities.js etc.), so this
// test source-transforms it: strip the import statements, prepend no-op
// stubs for the imported names, append test-only exports for the two
// module-private drain functions. The SHIPPED module surface is
// unchanged — the extra exports exist only in the transformed copy.
// Flag constants are read once at module load, so each flag config is a
// separate (salted) data-URL import with window.location.search preset.
//
// Run:
//   cd apps/holtburger-web/
//   node test_a15_q3_dispatch_parity.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// ---------------------------------------------------------------------
// Source transform: strip imports, stub the imported names, export the
// module-private drain functions for the lifetime/routing assertions.
// ---------------------------------------------------------------------
const rawLoop = readFileSync(joinPath(__dirname, "scene3d", "loop.js"), "utf8");
const stripped = rawLoop.replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*$/gm, "");
const stubs = `
// test stubs for stripped imports (test_a15_q3_dispatch_parity.mjs)
const tickCellVisibility3D = () => {};
const tickPvsLoadExpansion = () => {};
const tickLightingForCellState = () => {};
const getTerrainVisualZ = (sc, x, y, z) => z; // identity: unified setPose args == legacy
const cullTerrainGroup = () => {};
const BUILDINGS_SHADOW_RANGE_SQ_M = 0;
const STATICS_SHADOW_RANGE_SQ_M = 0;
const cullStaticsGroup = () => {};
const tickFrustumCull = () => {};
const setCullers = () => {};
const tickEntityRenderVisibility = () => {};
const tickPortalSpace = () => {};
const cloneEntityUpdate = (u) => ({ ...u });
const weatherForState = () => null;
const wxUpdateFromDayGroup = () => {};
// A8-M3: loop.js imports the pure ClientEvent dispatcher factory (kind=17
// visibility) and installs it in installSharedDrainHook; out of scope for
// this entity-update parity test (covered by test_a8_m3_kind17_dispatch.mjs).
const createClientEventDispatcher = () => () => false;
`;
const transformed =
  stubs + stripped +
  "\nexport { drainEntityEvents3D as __testDrain, _legacyDirectDrainArm as __testLegacyArm };\n";

async function loadLoopModule(search, salt) {
  // Flag IIFEs read window.location.search at module load — set it first.
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search };
  const src = `// salt:${salt}\n${transformed}`;
  const url = "data:text/javascript;base64," + Buffer.from(src).toString("base64");
  return import(url);
}

// ---------------------------------------------------------------------
// Mock EntityManager: records every dispatch-relevant method call.
// ---------------------------------------------------------------------
function makeEm(opts = {}) {
  const calls = [];
  const rec = (name) => (...args) => { calls.push([name, ...args]); };
  const em = {
    calls,
    spawn: rec("spawn"),
    remove: rec("remove"),
    setPose: rec("setPose"),
    setVelocity: (v) => calls.push(["setVelocity", { ...v }]), // scratch is mutated in place — snapshot
    setMotion: rec("setMotion"),
    setLocalStance: rec("setLocalStance"),
    setStickyTarget: rec("setStickyTarget"),
    setEntityRunRate: rec("setEntityRunRate"),
    applyTurnDirective: rec("applyTurnDirective"),
    applyAppearance: rec("applyAppearance"),
    attachChildToParent: rec("attachChildToParent"),
    setSwingPose: rec("setSwingPose"),
    consumeLocalSwingEcho: (g, c) => {
      calls.push(["consumeLocalSwingEcho", g, c]);
      return opts.echoConsumed === true;
    },
    _markWielderDirty: rec("_markWielderDirty"),
  };
  if (opts.wieldHandAttach) em._wieldHandAttach = true;
  return em;
}

const LOCAL_GUID = 0x50000001;
const REMOTE_GUID = 0x80000123;

function upd(kind, extra = {}) {
  return {
    kind,
    guid: REMOTE_GUID,
    modelId: 0x02000111,
    landblockId: 0xa9b40021, // outdoor cell (low16 < 0x100)
    x: 12.5, y: -3.25, z: 7.0,
    qw: 0.5, qx: 0.1, qy: 0.2, qz: 0.3,
    wcid: 31069, itemType: 0x10, name: "Drudge Skulker",
    objScale: 1.4, iconId: 0x06001234, paletteId: 0x04000abc,
    mtableId: 0x09000def, physicsTranslucency: 0.4, placementId: 3,
    motionCommand: 0x44000007, motionStance: 0x3d, motionSpeed: 1.75,
    isAutonomous: true,
    vx: 4.0, vy: -1.0, vz: 0.25, omegaZ: 0.9,
    modelChanges: Uint32Array.from([1, 0x02000222]),
    textureChanges: Uint32Array.from([0, 0x05000001]),
    subPalettes: Uint32Array.from([0x04000abc, 0, 256]),
    physicsScriptDid: 0x33000077, soundTableDid: 0x20000001,
    ...extra,
  };
}

function fakeSession(updates) {
  let drained = false;
  return {
    pollEntityUpdates() {
      if (drained) return [];
      drained = true;
      return updates;
    },
  };
}

const sceneStub = { useSharedDrain: false, entityManager: null };

// Normalize a call list to name+first-arg signature for sequence compare.
const sig = (calls) => calls.map((c) => `${c[0]}(${typeof c[1] === "object" ? "obj" : c[1]})`).join(" | ");

// =====================================================================
console.log("PART 1 — call-sequence parity: unified core vs legacy arm");
{
  globalThis.window = { getLocalPlayerGuid: () => LOCAL_GUID };
  const mod = await loadLoopModule("", "p1-default");
  const sequence = [
    upd(1),                                        // SPAWN
    upd(0),                                        // POSITION (remote, outdoor)
    upd(4),                                        // VELOCITY
    upd(5),                                        // MOTION (remote, autonomous)
    upd(5, { guid: LOCAL_GUID, isAutonomous: true }), // MOTION local echo → stance only
    upd(8),                                        // MOTION_ACTION (remote)
    upd(9),                                        // TURN
    upd(6),                                        // APPEARANCE
    upd(7),                                        // ATTACH
    upd(3),                                        // META_REFRESH (no-op)
    upd(2),                                        // REMOVE
  ];

  const emUnified = makeEm();
  const sc1 = { ...sceneStub, entityManager: emUnified };
  for (const u of sequence) mod.dispatchEntityUpdate(sc1, emUnified, u);

  delete globalThis.window.__lastEntityWorldPos;
  const emLegacy = makeEm();
  const sc2 = { ...sceneStub, entityManager: emLegacy };
  mod.__testLegacyArm(sc2, fakeSession(sequence.map((u) => ({ ...u }))));

  // Legacy KIND_MOTION_ACTION calls consumeLocalSwingEcho unconditionally
  // (the F6-2 dedup shipped unflagged in the dead arm); the unified core
  // gates it behind ?dispatchParity (off here). Drop that probe call from
  // the legacy trace — with echoConsumed=false the subsequent setMotion is
  // identical, so the EFFECTFUL sequences must match exactly.
  const legacyEffectful = emLegacy.calls.filter((c) => c[0] !== "consumeLocalSwingEcho");
  check("effectful EntityManager call sequences identical (shared kinds)",
    sig(emUnified.calls) === sig(legacyEffectful),
    sig(emUnified.calls) !== sig(legacyEffectful)
      ? `unified=[${sig(emUnified.calls)}] legacy=[${sig(legacyEffectful)}]` : undefined);
  check("unified core never called consumeLocalSwingEcho with flag off",
    !emUnified.calls.some((c) => c[0] === "consumeLocalSwingEcho"));
  check("local MOTION echo → setLocalStance, not setMotion (B9 skip kept)",
    emUnified.calls.some((c) => c[0] === "setLocalStance" && c[1] === LOCAL_GUID) &&
    !emUnified.calls.some((c) => c[0] === "setMotion" && c[1] === LOCAL_GUID && c[2] === (0x44000007 >>> 0)));
  // D1: __diag tap fires per update (it only ever lived in the dead arm).
  let tapped = 0;
  globalThis.window.__diag = { wire: { onEntityUpdate: () => { tapped += 1; } } };
  mod.dispatchEntityUpdate(sc1, emUnified, upd(0));
  check("D1: __diag.wire.onEntityUpdate tap fires from the unified core", tapped === 1, `got ${tapped}`);
  delete globalThis.window.__diag;
  // Pos-slot stash (live-arm-only feature, now also on the direct path).
  check("KIND_POSITION stashes __lastEntityWorldPos pos-slot (x=world)",
    globalThis.window.__lastEntityWorldPos?.get(REMOTE_GUID)?.x === 0xa9 * 192.0 + 12.5);
}

// =====================================================================
console.log("PART 2 — D2/D4 fire only under their flags");
{
  globalThis.window = { getLocalPlayerGuid: () => LOCAL_GUID };
  const modOff = await loadLoopModule("", "p2-off");
  const modOn = await loadLoopModule("?serverSwing=on", "p2-on");

  // D2 (FU-1): rides em._wieldHandAttach (set by entities.js under
  // ?wieldHandAttach=on) — flag carried on the manager, not re-read here.
  const emNoWield = makeEm();
  modOff.dispatchEntityUpdate({ entityManager: emNoWield }, emNoWield, upd(1));
  check("D2 inert without em._wieldHandAttach",
    !emNoWield.calls.some((c) => c[0] === "_markWielderDirty"));
  const emWield = makeEm({ wieldHandAttach: true });
  modOff.dispatchEntityUpdate({ entityManager: emWield }, emWield, upd(1));
  check("D2 fires _markWielderDirty(guid) after spawn under _wieldHandAttach",
    emWield.calls.findIndex((c) => c[0] === "spawn") === 0 &&
    emWield.calls.some((c) => c[0] === "_markWielderDirty" && c[1] === REMOTE_GUID));

  // D4 (FU-3): local guid + attack-class cmd (low16 0x51..0x6E) + flag on.
  const atk = upd(8, { guid: LOCAL_GUID, motionCommand: 0x44000060 });
  const emSwingOff = makeEm();
  modOff.dispatchEntityUpdate({ entityManager: emSwingOff }, emSwingOff, { ...atk });
  check("D4 inert with ?serverSwing off (setMotion still fires)",
    !emSwingOff.calls.some((c) => c[0] === "setSwingPose") &&
    emSwingOff.calls.some((c) => c[0] === "setMotion"));
  const emSwingOn = makeEm();
  modOn.dispatchEntityUpdate({ entityManager: emSwingOn }, emSwingOn, { ...atk });
  check("D4 fires setSwingPose for local attack cmd under ?serverSwing=on",
    emSwingOn.calls.some((c) => c[0] === "setSwingPose" && c[1] === LOCAL_GUID));
  const emSwingRemote = makeEm();
  modOn.dispatchEntityUpdate({ entityManager: emSwingRemote }, emSwingRemote, upd(8, { motionCommand: 0x44000060 }));
  check("D4 stays local-only (remote guid → no setSwingPose)",
    !emSwingRemote.calls.some((c) => c[0] === "setSwingPose"));
  const emNotAttack = makeEm();
  modOn.dispatchEntityUpdate({ entityManager: emNotAttack }, emNotAttack, upd(8, { guid: LOCAL_GUID, motionCommand: 0x44000050 }));
  check("D4 excludes non-attack cmd 0x50 (FallDown)",
    !emNotAttack.calls.some((c) => c[0] === "setSwingPose"));
}

// =====================================================================
console.log("PART 3 — D3 echo dedup gated on ?dispatchParity=on");
{
  globalThis.window = { getLocalPlayerGuid: () => LOCAL_GUID };
  const modOff = await loadLoopModule("", "p3-off");
  const modOn = await loadLoopModule("?dispatchParity=on", "p3-on");
  const swing = () => upd(8, { guid: LOCAL_GUID, motionCommand: 0x44000060 });

  const emA = makeEm({ echoConsumed: true });
  modOff.dispatchEntityUpdate({ entityManager: emA }, emA, swing());
  check("flag OFF: echo NOT swallowed even when consumable (setMotion fires)",
    emA.calls.some((c) => c[0] === "setMotion") &&
    !emA.calls.some((c) => c[0] === "consumeLocalSwingEcho"));

  const emB = makeEm({ echoConsumed: true });
  modOn.dispatchEntityUpdate({ entityManager: emB }, emB, swing());
  check("flag ON + echo consumed: setMotion swallowed (F6-2)",
    emB.calls.some((c) => c[0] === "consumeLocalSwingEcho") &&
    !emB.calls.some((c) => c[0] === "setMotion"));

  const emC = makeEm({ echoConsumed: false });
  modOn.dispatchEntityUpdate({ entityManager: emC }, emC, swing());
  check("flag ON + no pending echo: setMotion proceeds",
    emC.calls.some((c) => c[0] === "setMotion"));

  const emD = makeEm({ echoConsumed: true });
  modOn.dispatchEntityUpdate({ entityManager: emD }, emD, upd(8, { motionCommand: 0 }));
  check("flag ON + cmd 0: neither probe nor setMotion",
    !emD.calls.some((c) => c[0] === "consumeLocalSwingEcho" || c[0] === "setMotion"));
}

// =====================================================================
console.log("PART 4 — lifetime: wrapper frees exactly once, hook never; no throws");
{
  globalThis.window = { getLocalPlayerGuid: () => LOCAL_GUID };
  const mod = await loadLoopModule("", "p4");

  let freed = 0;
  const u = upd(5);
  u.free = () => { freed += 1; };
  const em1 = makeEm();
  mod.__testDrain({ useSharedDrain: false, entityManager: em1 }, fakeSession([u]));
  check("wrapper frees each handle exactly once", freed === 1, `got ${freed}`);
  check("wrapper dispatched through the unified core (setMotion observed)",
    em1.calls.some((c) => c[0] === "setMotion"));

  let hookFreed = 0;
  const u2 = upd(5);
  u2.free = () => { hookFreed += 1; };
  const em2 = makeEm();
  const sc = { useSharedDrain: false, entityManager: em2 };
  mod.installSharedDrainHook(sc);
  check("installSharedDrainHook sets useSharedDrain", sc.useSharedDrain === true);
  globalThis.window.__scene3dEntityHook([u2]);
  check("hook path dispatches but NEVER frees",
    em2.calls.some((c) => c[0] === "setMotion") && hookFreed === 0, `freed=${hookFreed}`);
  // late-binding: hook resolves entityManager at call time.
  const em3 = makeEm();
  sc.entityManager = em3;
  globalThis.window.__scene3dEntityHook(upd(4));
  check("hook resolves entityManager at CALL time (post-swap manager hit)",
    em3.calls.some((c) => c[0] === "setVelocity"));
  // never-throws contract: hostile update (getter throws), null, junk kind.
  let threw = false;
  const realWarn = console.warn; // the contract warn is expected — mute it
  console.warn = () => {};
  try {
    mod.dispatchEntityUpdate(sc, em3, { get kind() { throw new Error("hostile"); } });
    mod.dispatchEntityUpdate(sc, em3, null);
    mod.dispatchEntityUpdate(sc, em3, upd(0xff));
  } catch (_) { threw = true; }
  finally { console.warn = realWarn; }
  check("dispatchEntityUpdate never throws (hostile/null/unknown-kind)", !threw);
}

// =====================================================================
console.log("PART 5 — ?legacyDirectDrain=on routes to the verbatim legacy arm");
{
  globalThis.window = { getLocalPlayerGuid: () => LOCAL_GUID };
  const mod = await loadLoopModule("?legacyDirectDrain=on", "p5");
  delete globalThis.window.__lastEntityWorldPos;
  let freed = 0;
  const u = upd(0);
  u.free = () => { freed += 1; };
  const em = makeEm();
  mod.__testDrain({ useSharedDrain: false, entityManager: em }, fakeSession([u]));
  check("legacy arm still dispatches (setPose) and frees once",
    em.calls.some((c) => c[0] === "setPose") && freed === 1, `freed=${freed}`);
  check("legacy arm has NO pos-slot stash (proves legacy body ran, not unified)",
    !globalThis.window.__lastEntityWorldPos);
  // useSharedDrain still wins over the hatch (live 3D unaffected either way).
  const em4 = makeEm();
  mod.__testDrain({ useSharedDrain: true, entityManager: em4 }, fakeSession([upd(0)]));
  check("useSharedDrain early-return fires before the hatch (live mode inert)",
    em4.calls.length === 0);
}

// =====================================================================
console.log(`\nA15-Q3 dispatch parity: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
