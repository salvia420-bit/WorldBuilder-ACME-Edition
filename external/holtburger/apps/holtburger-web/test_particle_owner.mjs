// A11-S2 (unification survey 2026-06-11) — `?particleOwner=on` headless test.
//
// Drives the owner-keyed emitter lifecycle facade
// (`scene3d/particles/owner_registry.js`) with a fake ParticleManager
// (no THREE, no DAT). Covers the ROADMAP-required LEAK ASSERTION (the
// underlying manager table returns to baseline after spawn/despawn churn)
// plus the retail semantics the facade owns: object-scoped explicit
// handles (per-CPhysicsObj table, acclient.h:31040-31045), per-owner
// replace (acclient.c:329383-329393) and blocking (acclient.c:329528-329565)
// semantics, scoped Destroy(14)/Stop(15), owner-policy partial teardown
// (PlayEffect FIFO/reaper), and the despawn-vs-in-flight-create race
// (epoch tombstones).
//
// Run with:
//   cd apps/holtburger-web/
//   node test_particle_owner.mjs

import {
  ParticleOwnerRegistry,
  ownerRegistry,
  particleOwnerOn,
  particleOwnerRetireOn,
  _resetParticleOwnerFlagForTests,
} from "./scene3d/particles/owner_registry.js";

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

/** Fake ParticleManager — mirrors the real API surface the facade touches
 *  (`addEmitter` async + auto-id, `destroyParticleEmitter`,
 *  `stopParticleEmitter`, `particleTable`). `gate` lets a test hold an
 *  addEmitter mid-flight to exercise the despawn/supersede races. */
class FakeManager {
  constructor() {
    this.nextEmitterId = 1;
    this.particleTable = new Map();
    this.stopped = new Set();
    this.gate = null; // when set to a Promise, addEmitter awaits it
  }
  async addEmitter(req) {
    if (this.gate) await this.gate;
    // Mirrors the real manager contract under the facade: emitterId is
    // always 0 (facade-owned scoping) → auto-assign.
    const id = req.emitterId !== 0 ? req.emitterId : this.nextEmitterId++;
    this.particleTable.set(id, { req });
    return id;
  }
  destroyParticleEmitter(id) {
    return this.particleTable.delete(id);
  }
  stopParticleEmitter(id) {
    if (!this.particleTable.has(id)) return false;
    this.stopped.add(id);
    return true;
  }
  /** What ParticleManager.tick() does when an emitter FINISHES on its own
   *  (stopped && no particles): drop it and fire `onEmitterRemoved`. */
  retire(id) {
    if (!this.particleTable.delete(id)) return false;
    if (typeof this.onEmitterRemoved === "function") this.onEmitterRemoved(id, this);
    return true;
  }
}

// ---- 1. flag parse ---------------------------------------------------
{
  _resetParticleOwnerFlagForTests();
  globalThis.location = { search: "?particleOwner=on" };
  check("flag: ?particleOwner=on parses true", particleOwnerOn() === true);
  _resetParticleOwnerFlagForTests();
  globalThis.location = { search: "?particleOwner=off" };
  check("flag: =off parses false", particleOwnerOn() === false);
  _resetParticleOwnerFlagForTests();
  globalThis.location = { search: "?nosw=1" };
  check("flag: absent among other params parses true (default ON)", particleOwnerOn() === true);
  // A bare URL has an EMPTY search string. It must read the documented
  // default too — the old `location?.search` truthiness gate made it OFF.
  _resetParticleOwnerFlagForTests();
  globalThis.location = { search: "" };
  check("flag: bare URL (empty search) parses true (default ON)", particleOwnerOn() === true);
  globalThis.location = { search: "?particleOwner=off" };
  check("flag: parse is cached", particleOwnerOn() === true);
  _resetParticleOwnerFlagForTests();
  delete globalThis.location;
  check("flag: no location (Node) parses false", particleOwnerOn() === false);
  _resetParticleOwnerFlagForTests();
}

// ---- 2. auto-id registration + destroyAllForOwner --------------------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const a = await reg.addEmitter(101, mgr, { emitterId: 0 });
  const b = await reg.addEmitter(101, mgr, { emitterId: 0 });
  const c = await reg.addEmitter(202, mgr, { emitterId: 0 });
  check("auto-id: three live emitters in the manager table", mgr.particleTable.size === 3);
  check("auto-id: unique underlying ids", new Set([a, b, c]).size === 3 && a !== 0);
  check("auto-id: per-owner counts", reg.emitterCountForOwner(101) === 2 && reg.emitterCountForOwner(202) === 1);
  const n = reg.destroyAllForOwner(101);
  check("destroyAllForOwner: destroys only that owner's emitters", n === 2 && mgr.particleTable.size === 1);
  check("destroyAllForOwner: owner record dropped", reg.emitterCountForOwner(101) === 0 && reg.ownerCount === 1);
  reg.destroyAllForOwner(202);
  check("destroyAllForOwner: table back to baseline", mgr.particleTable.size === 0 && reg.ownerCount === 0);
}

// ---- 3. object-scoped explicit handles (no cross-owner collision) ----
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  // Both owners' scripts author the SAME handle 5 — retail keeps them in
  // separate per-object tables; the facade must too.
  const idA = await reg.addEmitter(1, mgr, { emitterId: 5 });
  const idB = await reg.addEmitter(2, mgr, { emitterId: 5 });
  check("scoped: same handle on two owners → two live emitters", mgr.particleTable.size === 2);
  check("scoped: distinct underlying ids", idA !== idB && idA !== 0 && idB !== 0);
  // Destroy(14) by handle on owner 1 must not touch owner 2's emitter.
  const destroyed = reg.destroyEmitter(1, 5);
  check("scoped destroy: kills only owner 1's emitter", destroyed === true && mgr.particleTable.size === 1 && mgr.particleTable.has(idB));
  check("scoped destroy: unknown handle no-ops", reg.destroyEmitter(1, 99) === false);
  reg.destroyAllForOwner(2);
}

// ---- 4. per-owner replace (non-blocking) ------------------------------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const first = await reg.addEmitter(7, mgr, { emitterId: 9 });
  const second = await reg.addEmitter(7, mgr, { emitterId: 9, blocking: false });
  check("replace: old emitter destroyed before new (one live)", mgr.particleTable.size === 1);
  check("replace: new id live, old gone", mgr.particleTable.has(second) && !mgr.particleTable.has(first));
  check("replace: handle re-points to the new id", reg.destroyEmitter(7, 9) === true && mgr.particleTable.size === 0);
}

// ---- 5. per-owner blocking (no replace, returns 0) ---------------------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const first = await reg.addEmitter(7, mgr, { emitterId: 9 });
  const refused = await reg.addEmitter(7, mgr, { emitterId: 9, blocking: true });
  check("blocking: refused create returns 0", refused === 0);
  check("blocking: original emitter untouched", mgr.particleTable.size === 1 && mgr.particleTable.has(first));
  // Same handle on a DIFFERENT owner is not blocked (per-object tables).
  const other = await reg.addEmitter(8, mgr, { emitterId: 9, blocking: true });
  check("blocking: other owner with same handle allowed", other !== 0 && mgr.particleTable.size === 2);
  reg.destroyAllForOwner(7);
  reg.destroyAllForOwner(8);
}

// ---- 6. stop routing ----------------------------------------------------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const id = await reg.addEmitter(3, mgr, { emitterId: 4 });
  check("stop: scoped handle routes stopParticleEmitter", reg.stopEmitter(3, 4) === true && mgr.stopped.has(id));
  check("stop: no teardown (emitter still live)", mgr.particleTable.has(id));
  check("stop: unknown owner no-ops", reg.stopEmitter(99, 4) === false);
  reg.destroyAllForOwner(3);
}

// ---- 6b. StopParticle racing an in-flight create (2026-10-07) ----------
// The windup hand trails: CreateParticle on the forward pass, StopParticle on
// the backward pass ~0.3 s later — sooner than a cold emitter build. Retail's
// create is synchronous, so the stop must still reach the emitter.
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  let release;
  mgr.gate = new Promise((res) => { release = res; });
  const pending = reg.addEmitter(21, mgr, { emitterId: 19 });
  check("stop-race: a stop during the in-flight create is accepted", reg.stopEmitter(21, 19) === true);
  release();
  mgr.gate = null;
  const id = await pending;
  check("stop-race: the create still resolves", id !== 0 && mgr.particleTable.has(id));
  check("stop-race: the pending stop is applied on resolve", mgr.stopped.has(id));
  // A later create on the same handle is a fresh emitter — not pre-stopped.
  const again = await reg.addEmitter(21, mgr, { emitterId: 19 });
  check("stop-race: a later create on the handle is not pre-stopped", again !== 0 && !mgr.stopped.has(again));
  reg.destroyAllForOwner(21);
}

// ---- 7. despawn racing an in-flight create (epoch tombstone) -----------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  let release;
  mgr.gate = new Promise((res) => { release = res; });
  const pending = reg.addEmitter(55, mgr, { emitterId: 0 });
  // Owner despawns BEFORE the create resolves — even though no record
  // existed yet, the epoch tombstone must catch the late resolve.
  reg.destroyAllForOwner(55);
  release();
  const id = await pending;
  check("race: late resolve returns 0", id === 0);
  check("race: late emitter self-destroyed (table at baseline)", mgr.particleTable.size === 0);
  check("race: no owner record leaked", reg.ownerCount === 0);
}

// ---- 8. explicit-id replace racing an in-flight create (supersede) -----
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  let release1;
  mgr.gate = new Promise((res) => { release1 = res; });
  const p1 = reg.addEmitter(6, mgr, { emitterId: 2 });
  mgr.gate = null;
  // Replace fires while the first create is still pending.
  const id2 = await reg.addEmitter(6, mgr, { emitterId: 2 });
  release1();
  const id1 = await p1;
  check("supersede: first (replaced) create returns 0", id1 === 0);
  check("supersede: only the replacement is live", id2 !== 0 && mgr.particleTable.size === 1 && mgr.particleTable.has(id2));
  check("supersede: handle resolves to the replacement", reg.destroyEmitter(6, 2) === true && mgr.particleTable.size === 0);
}

// ---- 9. destroySome (PlayEffect FIFO-evict / reaper owner-policy) ------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const a = await reg.addEmitter(11, mgr, { emitterId: 0 });
  const b = await reg.addEmitter(11, mgr, { emitterId: 0 });
  const c = await reg.addEmitter(11, mgr, { emitterId: 0 });
  const n = reg.destroySome(11, [a, b]);
  check("destroySome: destroys exactly the listed ids", n === 2 && mgr.particleTable.size === 1 && mgr.particleTable.has(c));
  check("destroySome: idempotent on already-destroyed ids", reg.destroySome(11, [a, b]) === 0);
  check("destroySome: owner still tracked while ids remain", reg.emitterCountForOwner(11) === 1);
  reg.destroySome(11, [c]);
  check("destroySome: owner record pruned when empty", reg.ownerCount === 0 && mgr.particleTable.size === 0);
}

// ---- 10. mixed-manager owners (world + statics) -------------------------
{
  const reg = new ParticleOwnerRegistry();
  const world = new FakeManager();
  const statics = new FakeManager();
  await reg.addEmitter("static:1", statics, { emitterId: 0 });
  await reg.addEmitter(42, world, { emitterId: 0 });
  reg.destroyAllForOwner("static:1");
  check("mixed: static owner teardown leaves world manager alone", statics.particleTable.size === 0 && world.particleTable.size === 1);
  check("mixed: ownerKeys iterates live owners", [...reg.ownerKeys()].length === 1);
  reg.destroyAllForOwner(42);
}

// ---- 11. LEAK ASSERTION — spawn/despawn churn returns to baseline -------
{
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const baselineTable = mgr.particleTable.size;
  for (let round = 0; round < 20; round++) {
    const owners = [];
    for (let o = 0; o < 5; o++) {
      const key = round * 100 + o;
      owners.push(key);
      // Mix anonymous + explicit-handle + replace-on-same-handle churn.
      await reg.addEmitter(key, mgr, { emitterId: 0 });
      await reg.addEmitter(key, mgr, { emitterId: 1 });
      await reg.addEmitter(key, mgr, { emitterId: 1 }); // replace
      await reg.addEmitter(key, mgr, { emitterId: 1, blocking: true }); // refused
    }
    for (const key of owners) reg.destroyAllForOwner(key);
  }
  check("leak: manager table back to baseline after churn", mgr.particleTable.size === baselineTable, `size=${mgr.particleTable.size}`);
  check("leak: zero live owners after churn", reg.ownerCount === 0);
  check("leak: diag counters balance", reg.addCount === reg.destroyCount, `add=${reg.addCount} destroy=${reg.destroyCount}`);
}

// ---- 12. failure path ----------------------------------------------------
{
  const reg = new ParticleOwnerRegistry();
  const failing = {
    async addEmitter() { throw new Error("boom"); },
    destroyParticleEmitter() { return false; },
    stopParticleEmitter() { return false; },
  };
  const id = await reg.addEmitter(13, failing, { emitterId: 3 });
  check("failure: throwing manager resolves 0 (never throws)", id === 0);
  check("failure: pending token cleared (no owner leak)", reg.ownerCount === 0);
  check("failure: null manager returns 0", (await reg.addEmitter(13, null, {})) === 0);
}

// ---- 13. PORTAL-SWIRL (2026-08-10) sibling-prune race ---------------------
// Two CreateParticle hooks from ONE script in ONE tick, the portal shape:
// the SLOW create (real GfxObj) enters first and awaits; the FAST one fails
// instantly (retail's `hwGfxObjId === 0` destroy sentinel) and used to
// `_pruneOwner` the shared record out of `_owners`, so the slow create
// resolved into the `liveRec !== rec` tombstone and destroyed a good emitter.
// With `?particleOwnerPending` ON (default) the record survives the failure.
{
  const reg = new ParticleOwnerRegistry();
  const destroyed = [];
  let next = 100;
  const mgr = {
    async addEmitter(req) {
      // hwGfxObjId 0 ⇒ the real manager returns 0 without awaiting anything.
      if ((req.emitterInfo.hwGfxObjId >>> 0) === 0) return 0;
      await new Promise((r) => setTimeout(r, 20)); // geometry + material fetch
      return ++next;
    },
    destroyParticleEmitter(id) { destroyed.push(id); return true; },
    stopParticleEmitter() { return false; },
  };
  const OWNER = 0x77d6406a; // Yaraq "Portal to Town Network"
  const slow = reg.addEmitter(OWNER, mgr, {
    emitterInfo: { id: 0x320002cd, hwGfxObjId: 0x010016c8 }, emitterId: 0,
  });
  const fast = reg.addEmitter(OWNER, mgr, {
    emitterInfo: { id: 0x320002d6, hwGfxObjId: 0 }, emitterId: 0,
  });
  const [swirl, inert] = await Promise.all([slow, fast]);
  check("sibling-race: the swirl emitter survives its sibling's fast failure",
    swirl !== 0, `id=${swirl}`);
  check("sibling-race: inert (hwGfxObjId 0) sibling still returns 0", inert === 0);
  check("sibling-race: nothing destroyed", destroyed.length === 0, `destroyed=[${destroyed}]`);
  check("sibling-race: owner holds exactly the swirl", reg.emitterCountForOwner(OWNER) === 1);
  // A real despawn mid-flight must STILL tombstone the late create.
  const late = reg.addEmitter(OWNER, mgr, {
    emitterInfo: { id: 0x320002cd, hwGfxObjId: 0x010016c8 }, emitterId: 0,
  });
  reg.destroyAllForOwner(OWNER);
  check("sibling-race: despawn still tombstones an in-flight create",
    (await late) === 0);
  check("sibling-race: no owner record leaked after despawn", reg.ownerCount === 0);
}

// ---- 15. PLIFECYCLE-3 natural retirement (`?particleOwnerRetire`) ---------
// Retail ParticleManager::UpdateParticles removes a finished emitter from the
// object's particle_table (acclient.c:329516-329520) and
// CreateBlockingParticleEmitter refuses only on a LIVE entry (:329528-329565).
{
  check("retire flag: no location (Node) → default ON", particleOwnerRetireOn() === true);
  const reg = new ParticleOwnerRegistry();
  const mgr = new FakeManager();
  const first = await reg.addEmitter(7, mgr, { emitterId: 9, blocking: true });
  check("retire: blocking create on a free handle succeeds", first !== 0);
  check("retire: registry installed the manager callback", typeof mgr.onEmitterRemoved === "function");
  check("retire: a second blocking create is refused while the emitter is live",
    (await reg.addEmitter(7, mgr, { emitterId: 9, blocking: true })) === 0);
  mgr.retire(first); // the finite emitter drained and tick() removed it
  check("retire: the drained emitter is gone from the owner record", reg.emitterCountForOwner(7) === 0);
  const again = await reg.addEmitter(7, mgr, { emitterId: 9, blocking: true });
  check("retire: blocking create on the same handle is accepted again (retail table miss)",
    again !== 0 && again !== first && mgr.particleTable.has(again), `id=${again}`);
  reg.destroyAllForOwner(7);

  // Anonymous emitters: the owner's id map stops growing and the record prunes.
  const a = await reg.addEmitter(31, mgr, { emitterId: 0 });
  const b = await reg.addEmitter(31, mgr, { emitterId: 0 });
  check("retire: two anonymous emitters tracked", reg.emitterCountForOwner(31) === 2);
  mgr.retire(a);
  check("retire: count drops as each one finishes", reg.emitterCountForOwner(31) === 1);
  mgr.retire(b);
  check("retire: count returns to 0", reg.emitterCountForOwner(31) === 0);
  check("retire: the empty owner record is pruned", reg.ownerCount === 0);
  check("retire: diag counter", reg.retiredCount === 3, `retired=${reg.retiredCount}`);

  // Emitter ids are allocated PER MANAGER: the same numeric id on a second
  // manager must not be touched by the first manager's retirement.
  const other = new FakeManager();
  const onWorld = await reg.addEmitter(40, mgr, { emitterId: 0 });
  other.nextEmitterId = onWorld;
  const onStatics = await reg.addEmitter("static:40", other, { emitterId: 0 });
  check("retire: setup — same numeric id on two managers", onWorld === onStatics);
  mgr.retire(onWorld);
  check("retire: only the retiring manager's owner loses it",
    reg.emitterCountForOwner(40) === 0 && reg.emitterCountForOwner("static:40") === 1);
  // Explicit destroys (which never fire the callback) forget the id too, so
  // the reverse map cannot grow with spawn/despawn churn.
  reg.destroyAllForOwner("static:40");
  for (let i = 0; i < 10; i++) {
    const k = await reg.addEmitter(41, mgr, { emitterId: 0 });
    if (i % 2) reg.destroySome(41, [k]);
  }
  reg.destroyAllForOwner(41);
  check("retire: reverse map is empty after explicit destroys (no growth)",
    reg._byMgr.get(other).size === 0 && reg._byMgr.get(mgr).size === 0,
    `statics=${reg._byMgr.get(other).size} world=${reg._byMgr.get(mgr).size}`);

  // Another registry on the same manager CHAINS rather than replaces.
  const reg2 = new ParticleOwnerRegistry();
  const shared = new FakeManager();
  const x = await reg.addEmitter(50, shared, { emitterId: 0 });
  const y = await reg2.addEmitter(51, shared, { emitterId: 0 });
  shared.retire(x);
  shared.retire(y);
  check("retire: two registries on one manager both hear their retirements",
    reg.emitterCountForOwner(50) === 0 && reg2.emitterCountForOwner(51) === 0);

  // `=off` escape: legacy bookkeeping (the handle stays bound after a drain).
  globalThis.location = { search: "?particleOwnerRetire=off" };
  _resetParticleOwnerFlagForTests();
  try {
    check("retire flag: =off parses false", particleOwnerRetireOn() === false);
    const legacyReg = new ParticleOwnerRegistry();
    const legacyMgr = new FakeManager();
    const id = await legacyReg.addEmitter(7, legacyMgr, { emitterId: 9, blocking: true });
    check("retire off: no callback installed", legacyMgr.onEmitterRemoved === undefined);
    legacyMgr.retire(id);
    check("retire off: legacy — the drained handle still refuses blocking creates",
      (await legacyReg.addEmitter(7, legacyMgr, { emitterId: 9, blocking: true })) === 0);
  } finally {
    delete globalThis.location;
    _resetParticleOwnerFlagForTests();
  }
  globalThis.location = { search: "?particleOwnerRetire=0" };
  _resetParticleOwnerFlagForTests();
  check("retire flag: =0 parses false", particleOwnerRetireOn() === false);
  globalThis.location = { search: "?particleOwnerRetire=false" };
  _resetParticleOwnerFlagForTests();
  check("retire flag: =false parses false", particleOwnerRetireOn() === false);
  globalThis.location = { search: "" };
  _resetParticleOwnerFlagForTests();
  check("retire flag: bare URL → ON", particleOwnerRetireOn() === true);
  delete globalThis.location;
  _resetParticleOwnerFlagForTests();
}

// ---- 14. singleton exists -------------------------------------------------
check("singleton: shared ownerRegistry exported", ownerRegistry instanceof ParticleOwnerRegistry);

console.log(`\n[test_particle_owner] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
