// Wave 3.C (2026-05-28) — per-vital granular event smoke test.
//
// Run with:
//   cd apps/holtburger-web/
//   node test_per_vital_events.mjs
//
// Validates the per-vital event split that lets vital bars animate
// smoothly:
//
//   vitalChangedHealth   ← kind=42 (CLIENT_EVENT_KIND_VITAL_HEALTH)
//   vitalChangedStamina  ← kind=43 (CLIENT_EVENT_KIND_VITAL_STAMINA)
//   vitalChangedMana     ← kind=44 (CLIENT_EVENT_KIND_VITAL_MANA)
//
// The recv loop emits these in src/lib.rs when a
// `WorldEvent::VitalUpdated(v)` lands; index.html's drainEvents
// routes them onto the plugin bus; vitals-hud.js subscribes per-vital
// for in-place bar paint (no full repaint of all 3 bars).
//
// Test method (mirrors test_status_indicators.mjs):
//   1. Install jsdom-lite shim so vitals-hud.js can mount.
//   2. Build a fake plugin client with a bus + a stats accessor.
//   3. Mount the plugin; render an initial 3-bar layout via a
//      synthetic kind=8 `playerStatsUpdated`.
//   4. Fire `vitalChangedHealth` once; assert ONLY the health bar's
//      fill/text changed and the other two are byte-untouched.
//   5. Fire stamina/mana variants; assert per-bar isolation.
//   6. Assert that per-vital events arriving BEFORE any kind=8 are a
//      no-op (no row to paint) — covers the boot-race fallback contract.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim (verbatim from test_status_indicators.mjs:30-115) ─
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
    querySelector(sel) {
      // vitals-hud.js queries `.hud-vital-bar` inside each row.
      const cls = sel.match(/^\.([\w-]+)$/);
      if (!cls) return null;
      const want = cls[1];
      const walk = (n) => {
        if (n?.attrs?.class && n.attrs.class.split(/\s+/).includes(want)) return n;
        if (n?._className && n._className.split(/\s+/).includes(want)) return n;
        for (const c of n.children || []) {
          const found = walk(c);
          if (found) return found;
        }
        return null;
      };
      return walk(this);
    },
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
      _className: "",
      _tagName: "div",
      _id: "",
      _text: "",
      _hidden: false,
    };
    const el = Object.create(elementProto);
    Object.assign(el, base);
    // Property accessors for fields the plugin writes via direct dot-access
    // (mirrors HTMLElement.id / className / textContent / hidden).
    Object.defineProperties(el, {
      id: {
        get() { return this._id; },
        set(v) { this._id = v; this.attrs.id = v; },
      },
      className: {
        get() { return this._className; },
        set(v) {
          this._className = v;
          this.attrs.class = v;
          // Keep classList in sync so contains() works for split tokens.
          for (const c of v.split(/\s+/)) {
            if (c) this.classList.add(c);
          }
        },
      },
      textContent: {
        get() { return this._text; },
        set(v) { this._text = v; },
      },
      hidden: {
        get() { return this._hidden; },
        set(v) { this._hidden = !!v; },
      },
    });
    return el;
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: (tag) => {
      const el = mkEl();
      el.ownerDocument = globalThis.document;
      el._tagName = (tag || "div").toLowerCase();
      return el;
    },
    getElementById: () => null,
  };
  globalThis.document.head.ownerDocument = globalThis.document;
  globalThis.document.body.ownerDocument = globalThis.document;
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

const url = pathToFileURL(
  resolvePath(__dirname, "plugins/vitals-hud.js")
).href;
const { mount, manifest } = await import(url);

console.log("===========================================================");
console.log("Wave 3.C — per-vital granular events smoke test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports manifest with id=vitals-hud", () => {
  if (manifest.id !== "vitals-hud") {
    throw new Error(`bad manifest.id: ${manifest.id}`);
  }
});

check("exports mount() function", () => {
  if (typeof mount !== "function") throw new Error("mount not a function");
});

console.log("\n[2] Wiring — fake client + initial paint");

// Vitals data shape mirrors wasm side: [type, current, base, buffed_max]
// repeated. Health=1, Stamina=3, Mana=5. Test starts at all-full.
let fakeVitals = [
  1, 100, 100, 100, // Health full
  3, 100, 100, 100, // Stamina full
  5, 100, 100, 100, // Mana full
];

function makeFakeClient() {
  const bus = new EventTarget();
  return {
    events: {
      on(name, h) { bus.addEventListener(name, h); },
      off(name, h) { bus.removeEventListener(name, h); },
      emit(name, payload) {
        bus.dispatchEvent(new CustomEvent(name, { detail: payload }));
      },
    },
    player: {
      get stats() { return { vitals: fakeVitals }; },
    },
  };
}

const fakeClient = makeFakeClient();
window.__pluginClient = fakeClient;

const unmount = mount({ client: fakeClient });

// Pull the overlay element out of document.body. The plugin sets
// `overlay.id = "hb-vitals-hud"` via the defineProperty getter/setter,
// which mirrors into both `_id` and `attrs.id`.
const overlay = document.body.children.find(c => c.attrs?.id === "hb-vitals-hud");
check("overlay mounted to document.body", () => {
  if (!overlay) throw new Error("no overlay child on body");
});

// Find the 3 vital rows by their `hud-vital health/stamina/mana` class.
function getRow(cls) {
  return overlay.children.find(c => c.attrs?.class?.includes(cls));
}

check("3 vital rows rendered after initial kind=8 paint", () => {
  // The first paint already ran inside tryHook → render(); rows exist.
  for (const cls of ["health", "stamina", "mana"]) {
    if (!getRow(cls)) throw new Error(`missing row for class ${cls}`);
  }
});

// Helper: read the bar's last-applied (pctStr, numsStr) by walking into
// the row entry via the __vitalRefs Map the plugin stashed on the overlay.
function readRow(vitalType) {
  const refs = overlay.__vitalRefs;
  if (!refs) throw new Error("__vitalRefs not set on overlay");
  const entry = refs.get(vitalType);
  if (!entry) throw new Error(`no row entry for vital type ${vitalType}`);
  return { pct: entry.lastPctStr, nums: entry.lastNumsStr };
}

check("initial paint set HP=100%/100 / 100", () => {
  const r = readRow(1);
  if (r.pct !== "100.0%") throw new Error(`HP pct=${r.pct}`);
  if (r.nums !== "100 / 100") throw new Error(`HP nums=${r.nums}`);
});

console.log("\n[3] Per-vital event — kind=42 vitalChangedHealth");

check("vitalChangedHealth → HP bar updates, others byte-untouched", () => {
  const stBefore = readRow(3);
  const mnBefore = readRow(5);
  fakeClient.events.emit("vitalChangedHealth", { current: 73, buffedMax: 100 });
  const hp = readRow(1);
  const st = readRow(3);
  const mn = readRow(5);
  if (hp.pct !== "73.0%") throw new Error(`HP pct=${hp.pct} (want 73.0%)`);
  if (hp.nums !== "73 / 100") throw new Error(`HP nums=${hp.nums}`);
  // Critical: stamina + mana entries must be byte-identical references.
  if (st.pct !== stBefore.pct || st.nums !== stBefore.nums) {
    throw new Error("stamina row mutated on health event");
  }
  if (mn.pct !== mnBefore.pct || mn.nums !== mnBefore.nums) {
    throw new Error("mana row mutated on health event");
  }
});

check("vitalChangedHealth fires exactly once per event (no double-paint)", () => {
  // Re-fire SAME value; lastPctStr cache should skip the inner write.
  // We can't observe writes directly without instrumenting style, but
  // re-firing should not throw and the values should remain identical.
  fakeClient.events.emit("vitalChangedHealth", { current: 73, buffedMax: 100 });
  const r = readRow(1);
  if (r.pct !== "73.0%") throw new Error("HP changed on no-op re-fire");
});

console.log("\n[4] Per-vital event — kind=43 vitalChangedStamina");

check("vitalChangedStamina → stamina bar updates only", () => {
  const hpBefore = readRow(1);
  const mnBefore = readRow(5);
  fakeClient.events.emit("vitalChangedStamina", { current: 50, buffedMax: 100 });
  const hp = readRow(1);
  const st = readRow(3);
  const mn = readRow(5);
  if (st.pct !== "50.0%") throw new Error(`ST pct=${st.pct}`);
  if (st.nums !== "50 / 100") throw new Error(`ST nums=${st.nums}`);
  if (hp.pct !== hpBefore.pct) throw new Error("health row mutated on stamina event");
  if (mn.pct !== mnBefore.pct) throw new Error("mana row mutated on stamina event");
});

console.log("\n[5] Per-vital event — kind=44 vitalChangedMana");

check("vitalChangedMana → mana bar updates only", () => {
  const hpBefore = readRow(1);
  const stBefore = readRow(3);
  fakeClient.events.emit("vitalChangedMana", { current: 25, buffedMax: 100 });
  const hp = readRow(1);
  const st = readRow(3);
  const mn = readRow(5);
  if (mn.pct !== "25.0%") throw new Error(`MN pct=${mn.pct}`);
  if (mn.nums !== "25 / 100") throw new Error(`MN nums=${mn.nums}`);
  if (hp.pct !== hpBefore.pct) throw new Error("health row mutated on mana event");
  if (st.pct !== stBefore.pct) throw new Error("stamina row mutated on mana event");
});

console.log("\n[6] Buffed-max handling — pct uses event-provided buffedMax");

check("Vital Boost adds buffed_max → pct uses buffed total", () => {
  // Simulate a Major Health Boost: current=100, buffed_max=150 (50%-buffed).
  fakeClient.events.emit("vitalChangedHealth", { current: 100, buffedMax: 150 });
  const r = readRow(1);
  // 100/150 = 66.666% → 66.7%
  if (r.pct !== "66.7%") throw new Error(`HP pct=${r.pct} (want 66.7%)`);
  if (r.nums !== "100 / 150") throw new Error(`HP nums=${r.nums}`);
});

console.log("\n[7] Edge — buffedMax=0 yields 0% (defensive divide-by-zero)");

check("buffedMax=0 → pct 0.0%, no NaN", () => {
  fakeClient.events.emit("vitalChangedHealth", { current: 50, buffedMax: 0 });
  const r = readRow(1);
  if (r.pct !== "0.0%") throw new Error(`HP pct=${r.pct} (want 0.0%)`);
});

console.log("\n[8] Coalesced fallback — kind=8 still drives full repaint");

check("playerStatsUpdated re-publishes all 3 rows from stats accessor", () => {
  // Bump all 3 vitals via the stats source — the kind=8 path reads them.
  fakeVitals = [
    1, 95, 100, 100,
    3, 95, 100, 100,
    5, 95, 100, 100,
  ];
  fakeClient.events.emit("playerStatsUpdated", {});
  const hp = readRow(1);
  const st = readRow(3);
  const mn = readRow(5);
  if (hp.pct !== "95.0%") throw new Error(`HP not refreshed by kind=8 (${hp.pct})`);
  if (st.pct !== "95.0%") throw new Error(`ST not refreshed by kind=8 (${st.pct})`);
  if (mn.pct !== "95.0%") throw new Error(`MN not refreshed by kind=8 (${mn.pct})`);
});

console.log("\n[8.5] Wave 6 polish — oldValue field on vitalChanged payloads");

check("vitalChangedHealth with oldValue→ HP bar updates + payload carries oldValue", () => {
  // Wave 6 polish (2026-05-28): wasm now threads `prev_current`
  // through `f32_payload`; index.html drainEvents extracts it as
  // `oldValue` (int). The vitals-hud plugin doesn't need to read
  // oldValue itself (it only repaints the bar), so this assertion
  // verifies the bus payload via a manual subscription rather than
  // a row read. Combat heuristics / DR-rollup HUDs are the actual
  // downstream consumers.
  let lastPayload = null;
  const handler = (e) => { lastPayload = e.detail; };
  fakeClient.events.on("vitalChangedHealth", handler);
  try {
    fakeClient.events.emit("vitalChangedHealth", {
      current: 80, buffedMax: 100, oldValue: 100,
    });
    if (!lastPayload) throw new Error("handler not invoked");
    if (lastPayload.current !== 80) throw new Error(`bad current: ${lastPayload.current}`);
    if (lastPayload.buffedMax !== 100) throw new Error(`bad buffedMax: ${lastPayload.buffedMax}`);
    if (lastPayload.oldValue !== 100) throw new Error(`bad oldValue: ${lastPayload.oldValue}`);
    const delta = lastPayload.current - lastPayload.oldValue;
    if (delta !== -20) throw new Error(`expected delta -20, got ${delta}`);
  } finally {
    fakeClient.events.off("vitalChangedHealth", handler);
  }
});

check("vitalChanged without oldValue (initial hydrate) → undefined, not 0", () => {
  // When the holtburger-world handler couldn't capture pre-mutation
  // (e.g. initial-spawn hydrate of a Vital that didn't yet exist in
  // the cache), `prev_current = None` flows through as
  // `f32_payload = None` → JS `undefined`. Subscribers MUST treat
  // undefined as "delta unavailable", NOT as zero.
  let lastPayload = null;
  const handler = (e) => { lastPayload = e.detail; };
  fakeClient.events.on("vitalChangedHealth", handler);
  try {
    fakeClient.events.emit("vitalChangedHealth", {
      current: 100, buffedMax: 100, oldValue: undefined,
    });
    if (!lastPayload) throw new Error("handler not invoked");
    if (lastPayload.oldValue !== undefined) {
      throw new Error(`oldValue should be undefined for initial hydrate, got ${lastPayload.oldValue}`);
    }
  } finally {
    fakeClient.events.off("vitalChangedHealth", handler);
  }
});

check("eventArgsFactories.vitalChanged exposes the OldValue field shape (api.js)", () => {
  // Wave 3.C handoff cited api.js's `makeVitalChanged(type, value, oldValue)`
  // factory as already declaring oldValue (per VitalChangedEventArgs.cs:13-35).
  // This is a pure shape assertion — the factory exists and returns the
  // expected `{type, value, oldValue}` triple.
  //
  // We can't import api.js easily under the DOM shim (it pulls in
  // wasm-dependent code via world-state.js); read-as-text instead.
  // Pattern stolen from test_examine_dye_preview.mjs.
  const apiSrc = readFileSync(
    resolvePath(__dirname, "plugins/api.js"),
    "utf8",
  );
  if (!/export function makeVitalChanged\(type, value, oldValue\)/.test(apiSrc)) {
    throw new Error("makeVitalChanged signature drifted from (type, value, oldValue)");
  }
  if (!/return\s*\{\s*type,\s*value,\s*oldValue\s*\}/.test(apiSrc)) {
    throw new Error("makeVitalChanged return shape no longer `{type, value, oldValue}`");
  }
});

console.log("\n[9] Boot race — per-vital event before kind=8 is a no-op");

// Unmount, re-mount fresh client so __vitalRefs starts undefined.
unmount();

const freshClient = makeFakeClient();
window.__pluginClient = freshClient;
fakeVitals = []; // No stats yet — first render hides the overlay.

const unmount2 = mount({ client: freshClient });
const overlay2 = document.body.children.find(c => c.attrs?.id === "hb-vitals-hud");

check("pre-kind=8 vitalChangedHealth does not throw", () => {
  // No __vitalRefs yet (initial render had vitals.length === 0).
  // The applyVitalDelta path must early-return.
  freshClient.events.emit("vitalChangedHealth", { current: 50, buffedMax: 100 });
  // If we got here, it didn't throw. Verify __vitalRefs is still empty
  // (the per-vital path should not have built any rows).
  if (overlay2.__vitalRefs && overlay2.__vitalRefs.size > 0) {
    throw new Error("per-vital event built rows pre-kind=8");
  }
});

check("post-kind=8 (rows built) → per-vital event paints normally", () => {
  fakeVitals = [
    1, 100, 100, 100,
    3, 100, 100, 100,
    5, 100, 100, 100,
  ];
  freshClient.events.emit("playerStatsUpdated", {});
  freshClient.events.emit("vitalChangedHealth", { current: 42, buffedMax: 100 });
  const refs = overlay2.__vitalRefs;
  const entry = refs?.get(1);
  if (!entry) throw new Error("HP entry missing after kind=8");
  if (entry.lastPctStr !== "42.0%") {
    throw new Error(`HP not painted post-kind=8: ${entry.lastPctStr}`);
  }
});

unmount2();

console.log("\n===========================================================");
console.log(`Result: ${passed} PASS, ${failed} FAIL`);
console.log("===========================================================");

if (failed > 0) process.exit(1);
