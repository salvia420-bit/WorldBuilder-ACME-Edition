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
  globalThis.location = { search: "" };
  check("flag: absent parses false (default OFF)", particleOwnerOn() === false);
  check("flag: parse is cached", particleOwnerOn() === false);
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

// ---- 13. singleton exists -------------------------------------------------
check("singleton: shared ownerRegistry exported", ownerRegistry instanceof ParticleOwnerRegistry);

console.log(`\n[test_particle_owner] ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
