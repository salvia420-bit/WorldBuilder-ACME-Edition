// Wave 4.B (2026-05-28) — remote-entity buff/debuff dispatch smoke test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_remote_buffs.mjs
//
// Validates the Wave 4.B per-target enchantment plumbing:
//
//   wire (kind=46) → buffs-hud refreshEntityFromSnapshot →
//   getEntityBuffSummary → nameplate-sprite badge ready
//
// The wasm layer is exercised indirectly via the `__test`
// `refreshEntityFromSnapshot` helper exposed by `plugins/buffs-hud.js`
// — we feed it a synthetic snapshot for a non-self GUID and assert:
//
//   1. The per-entity Map fills with the right (layeredId → record) shape.
//   2. The (category, layer) tiebreak keeps the highest-Power entry.
//   3. `getEntityBuffSummary(guid)` returns the right classified counts
//      (BENEFICIAL bit → buff; additive negative → debuff; COOLDOWN bit
//      → cooldown).
//   4. The change-listener fires synchronously with the affected GUID.
//   5. Subsequent updates replace (not concat) the per-target snapshot.
//   6. An empty snapshot clears the entry.
//   7. `window.__buffsHudGetEntitySummary` is wired (the nameplate-sprite
//      lookup surface).
//
// Independent of any 3D / Three.js path; the nameplate sprite layer is
// exercised by smoke captures, not unit tests.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim (verbatim from test_status_indicators.mjs) ─
function installDomShim() {
  if (typeof globalThis.document !== "undefined") return;
  const elementProto = {
    appendChild(c) { this.children = this.children || []; this.children.push(c); c.parentNode = this; return c; },
    removeChild(c) {
      if (!this.children) return;
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },
    setAttribute(k, v) { this.attrs = this.attrs || {}; this.attrs[k] = v; },
    removeAttribute(k) { if (this.attrs) delete this.attrs[k]; },
    getAttribute(k) { return this.attrs?.[k] ?? null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
    classList: undefined,
    dataset: undefined,
    style: undefined,
    get isConnected() { return true; },
  };
  function mkClassList() {
    const set = new Set();
    return {
      add(c) { set.add(c); },
      remove(c) { set.delete(c); },
      contains(c) { return set.has(c); },
      toggle(c, force) {
        const desired = force === undefined ? !set.has(c) : !!force;
        if (desired) set.add(c); else set.delete(c);
        return desired;
      },
    };
  }
  function mkEl() {
    const base = {
      children: [],
      attrs: {},
      style: {},
      dataset: {},
      classList: mkClassList(),
      parentNode: null,
      ownerDocument: null,
    };
    const el = Object.create(elementProto);
    Object.assign(el, base);
    Object.defineProperty(el, "innerHTML", {
      get() { return this._innerHTML || ""; },
      set(v) { this._innerHTML = v; this.children = []; },
    });
    return el;
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: () => {
      const el = mkEl();
      el.ownerDocument = globalThis.document;
      return el;
    },
    getElementById: () => null,
  };
  globalThis.window = globalThis;
  globalThis.setInterval = () => 0;
  globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.clearTimeout = () => {};
  globalThis.fetch = () => Promise.resolve({
    ok: false,
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  });
}

installDomShim();

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

const buffsUrl = pathToFileURL(
  resolvePath(__dirname, "plugins/buffs-hud.js")
).href;
const {
  manifest,
  classifyEnchantment,
  getEntityEnchantments,
  getEntityBuffSummary,
  onEntityEnchantmentsChange,
  clearEntityEnchantments,
  __test,
} = await import(buffsUrl);
const { refreshEntityFromSnapshot, ETF, state } = __test;

console.log("===========================================================");
console.log("Wave 4.B — remote-entity buff/debuff dispatch smoke test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("manifest carries id=buffs-hud", () => {
  if (manifest.id !== "buffs-hud") {
    throw new Error(`bad manifest.id: ${manifest.id}`);
  }
});

check("exports getEntityEnchantments + getEntityBuffSummary", () => {
  if (typeof getEntityEnchantments !== "function") {
    throw new Error("getEntityEnchantments missing");
  }
  if (typeof getEntityBuffSummary !== "function") {
    throw new Error("getEntityBuffSummary missing");
  }
});

check("exports onEntityEnchantmentsChange + clearEntityEnchantments", () => {
  if (typeof onEntityEnchantmentsChange !== "function") {
    throw new Error("onEntityEnchantmentsChange missing");
  }
  if (typeof clearEntityEnchantments !== "function") {
    throw new Error("clearEntityEnchantments missing");
  }
});

check("globals wired for nameplate-sprite layer", () => {
  if (typeof globalThis.window.__buffsHudGetEntitySummary !== "function") {
    throw new Error("window.__buffsHudGetEntitySummary missing");
  }
  if (typeof globalThis.window.__buffsHudGetEntityEnchantments !== "function") {
    throw new Error("window.__buffsHudGetEntityEnchantments missing");
  }
  if (typeof globalThis.window.__buffsHudOnEntityChange !== "function") {
    throw new Error("window.__buffsHudOnEntityChange missing");
  }
});

console.log("\n[2] refreshEntityFromSnapshot — single buff ingestion");

const DRUDGE_GUID = 0xDEAD0001;
const PLAYER_GUID = 0xCAFE1234;

const strengthBuff = {
  spellId: 1158,
  spellCategory: 12,
  layer: 0,
  power: 200,
  startTime: 1000,
  duration: 600,
  casterGuid: PLAYER_GUID,
  type: ETF.BENEFICIAL | ETF.ADDITIVE | ETF.ATTRIBUTE | ETF.SINGLE_STAT,
  statKey: 1,
  statValue: 60,
};

const weaknessDebuff = {
  spellId: 3,
  spellCategory: 13,
  layer: 0,
  power: 200,
  startTime: 1010,
  duration: 120,
  casterGuid: PLAYER_GUID,
  type: ETF.ADDITIVE | ETF.ATTRIBUTE,
  statKey: 1,
  statValue: -60,
};

check("Strength buff lands on the drudge's enchantment map", () => {
  refreshEntityFromSnapshot(DRUDGE_GUID, [strengthBuff]);
  const list = getEntityEnchantments(DRUDGE_GUID);
  if (list.length !== 1) {
    throw new Error(`expected 1 enchantment, got ${list.length}`);
  }
  if (list[0].spellId !== 1158) {
    throw new Error(`expected spellId 1158, got ${list[0].spellId}`);
  }
  if ((list[0].type & ETF.BENEFICIAL) === 0) {
    throw new Error("expected BENEFICIAL bit set");
  }
});

check("getEntityBuffSummary returns { buffs: 1, debuffs: 0, cooldowns: 0 }", () => {
  const sum = getEntityBuffSummary(DRUDGE_GUID);
  if (sum.buffs !== 1) throw new Error(`expected 1 buff, got ${sum.buffs}`);
  if (sum.debuffs !== 0) throw new Error(`expected 0 debuffs, got ${sum.debuffs}`);
  if (sum.cooldowns !== 0) throw new Error(`expected 0 cooldowns, got ${sum.cooldowns}`);
  if (sum.total !== 1) throw new Error(`expected total 1, got ${sum.total}`);
});

console.log("\n[3] Listener fires on update");

let listenerHits = [];
const dispose = onEntityEnchantmentsChange((guid) => listenerHits.push(guid));
check("subscriber attached without throwing", () => {
  if (typeof dispose !== "function") {
    throw new Error("subscribe should return a dispose fn");
  }
});

check("synthetic update fires listener with correct GUID", () => {
  listenerHits.length = 0;
  refreshEntityFromSnapshot(DRUDGE_GUID, [strengthBuff, weaknessDebuff]);
  if (listenerHits.length === 0) {
    throw new Error("listener was not called");
  }
  // Last fire should be the GUID we updated.
  if (listenerHits[listenerHits.length - 1] !== DRUDGE_GUID) {
    throw new Error(
      `listener got guid ${listenerHits[listenerHits.length - 1]}, expected ${DRUDGE_GUID}`,
    );
  }
});

check("after update: summary reflects 1 buff + 1 debuff", () => {
  const sum = getEntityBuffSummary(DRUDGE_GUID);
  if (sum.buffs !== 1) throw new Error(`buffs=${sum.buffs}`);
  if (sum.debuffs !== 1) throw new Error(`debuffs=${sum.debuffs}`);
  if (sum.cooldowns !== 0) throw new Error(`cooldowns=${sum.cooldowns}`);
});

console.log("\n[4] Per-(category, layer) tiebreak — higher Power wins");

const weaknessLow = { ...weaknessDebuff, power: 50, spellId: 4 };
const weaknessHigh = { ...weaknessDebuff, power: 500, spellId: 5 };

check("two debuffs in same category — only the higher-power wins", () => {
  refreshEntityFromSnapshot(DRUDGE_GUID, [strengthBuff, weaknessLow, weaknessHigh]);
  const list = getEntityEnchantments(DRUDGE_GUID);
  // Expect: strengthBuff + weaknessHigh (weaknessLow loses tiebreak).
  if (list.length !== 2) {
    throw new Error(`expected 2 enchantments after tiebreak, got ${list.length}`);
  }
  const hasHigh = list.some((e) => e.spellId === 5);
  const hasLow = list.some((e) => e.spellId === 4);
  if (!hasHigh) throw new Error("higher-power weakness should win tiebreak");
  if (hasLow) throw new Error("lower-power weakness should lose tiebreak");
});

console.log("\n[5] Two entities — index keeps them separate");

const GOLEM_GUID = 0xDEAD0002;
const cooldownSpell = {
  spellId: 666,
  spellCategory: 0,
  layer: 0,
  power: 0,
  startTime: 1020,
  duration: 60,
  casterGuid: 0,
  type: ETF.COOLDOWN,
  statKey: 0x101,
  statValue: 0,
};

check("a different GUID gets its own bucket", () => {
  refreshEntityFromSnapshot(GOLEM_GUID, [cooldownSpell]);
  const golem = getEntityBuffSummary(GOLEM_GUID);
  if (golem.cooldowns !== 1) throw new Error(`golem cooldowns=${golem.cooldowns}`);
  if (golem.buffs !== 0) throw new Error(`golem buffs=${golem.buffs}`);
  // Drudge's bucket should be unaffected.
  const drudge = getEntityBuffSummary(DRUDGE_GUID);
  if (drudge.buffs !== 1) throw new Error(`drudge buffs=${drudge.buffs}`);
});

console.log("\n[6] Empty snapshot clears the entry");

check("empty array → entry removed", () => {
  refreshEntityFromSnapshot(GOLEM_GUID, []);
  const sum = getEntityBuffSummary(GOLEM_GUID);
  if (sum.total !== 0) throw new Error(`expected total 0, got ${sum.total}`);
  // Drudge unaffected.
  const drudge = getEntityBuffSummary(DRUDGE_GUID);
  if (drudge.buffs !== 1) throw new Error(`drudge corrupted: buffs=${drudge.buffs}`);
});

console.log("\n[7] window.__buffsHudGetEntitySummary parity");

check("global getter returns the same data as the exported one", () => {
  const direct = getEntityBuffSummary(DRUDGE_GUID);
  const viaGlobal = globalThis.window.__buffsHudGetEntitySummary(DRUDGE_GUID);
  if (direct.buffs !== viaGlobal.buffs) {
    throw new Error("buffs mismatch direct vs global");
  }
  if (direct.debuffs !== viaGlobal.debuffs) {
    throw new Error("debuffs mismatch direct vs global");
  }
  if (direct.total !== viaGlobal.total) {
    throw new Error("total mismatch direct vs global");
  }
});

console.log("\n[8] clearEntityEnchantments drops every entry");

check("hard reset clears all buckets", () => {
  refreshEntityFromSnapshot(GOLEM_GUID, [cooldownSpell]);
  if (getEntityBuffSummary(GOLEM_GUID).cooldowns !== 1) {
    throw new Error("golem not re-seeded");
  }
  clearEntityEnchantments();
  if (getEntityBuffSummary(GOLEM_GUID).total !== 0) {
    throw new Error("golem bucket not cleared");
  }
  if (getEntityBuffSummary(DRUDGE_GUID).total !== 0) {
    throw new Error("drudge bucket not cleared");
  }
});

console.log("\n[9] Dispose listener stops further callbacks");

check("dispose detaches the subscriber", () => {
  dispose();
  listenerHits.length = 0;
  refreshEntityFromSnapshot(DRUDGE_GUID, [strengthBuff]);
  if (listenerHits.length !== 0) {
    throw new Error("listener fired after dispose");
  }
});

console.log("\n===========================================================");
console.log(`Wave 4.B — ${passed} passed, ${failed} failed`);
console.log("===========================================================");

if (failed > 0) process.exit(1);
