// tests/rynth_vt_profiles.test.mjs — rynth/vt/settings profiles, named stores
// and the page-level VtSession (PLAN W1-2 SET, §3.5, §3.17, §4.7; covers P1-P6,
// P9, D6, D27).
//
// Pure node: spy Storage fakes (with and without key()/length enumeration), a
// fake window for `storage` events. No real localStorage, no network.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_profiles.test.mjs

import assert from "node:assert/strict";

const S = await import("../rynth/vt/settings/index.js");
const {
  ProfileStore, NamedStore, createVtOptions, createLiveCells, getVtSession, peekVtSession, HUD_BLOB_KEY,
  PROFILE_NAME_RE, SCHEMA,
} = S;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

let T = 1_800_000_000_000;
const now = () => T;
const logs = [];
const quiet = (m) => logs.push(m);

function spyStorage({ enumerable = true } = {}) {
  const m = new Map();
  const s = {
    quota: false,
    writes: [],
    removes: [],
    m,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      if (s.quota) {
        const e = new Error("Failed to execute 'setItem' on 'Storage': exceeded the quota.");
        e.name = "QuotaExceededError";
        e.code = 22;
        throw e;
      }
      s.writes.push(k);
      m.set(k, String(v));
    },
    removeItem(k) {
      s.removes.push(k);
      m.delete(k);
    },
  };
  if (enumerable) {
    Object.defineProperty(s, "length", { get: () => m.size });
    s.key = (i) => [...m.keys()][i] ?? null;
  }
  return s;
}

function fakeWin() {
  const handlers = new Map();
  return {
    handlers,
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
    },
    removeEventListener(type, fn) {
      handlers.get(type)?.delete(fn);
    },
    fire(type, evt) {
      for (const fn of [...(handlers.get(type) || [])]) fn(evt);
    },
  };
}

const store = (storage, scope = "1001", extra = {}) =>
  new ProfileStore({ storage, scope, charName: "Tester", now, log: quiet, ...extra });
const cur = (settings = {}, lists = {}, refs = {}) => ({ settings, lists, refs });
const sharedKey = (n) => `rynth.vt.v1.profile.shared.${n}`;
const charKey = (scope, n) => `rynth.vt.v1.profile.char.${scope}.${n}`;

// ── Default ────────────────────────────────────────────────────────────────
await check("Default is never written (spy storage), whatever is edited", () => {
  const storage = spyStorage();
  const p = store(storage);
  const o = createVtOptions({ profiles: p, now, log: quiet });
  const bot = { host: { nearbyRangeM: 60 }, combat: { enabled: true, priorities: {} }, loot: { enabled: true, minValue: 0 },
    vitals: { cfg: { healAtCombat: 60 } }, buffSpec: null };
  o.bindCells(createLiveCells(bot));
  o.applyToCells({ legacy: true });
  for (const [k, v] of [["HealAt", 70], ["AttackDistance", 0.1], ["EnableNav", true], ["ShowEditor", true], ["DoJiggle", 1]]) {
    assert.equal(o.set(k, v, { source: "command" }).ok, true);
  }
  o.setList("items", [{ guid: 1, name: "Wand", wcid: 2, kind: "caster", element: null, noBuffs: false }]);
  o.setRef("navProfile", "loop");
  o.noteLegacyEdit("lootMin", 10);
  bot.loot.minValue = 50;
  for (let i = 0; i < 4; i++) o.autosaveTick(T + i * 3000);
  o.flushNow();
  assert.deepStrictEqual(p.flush({ force: true }), { ok: true, wrote: false });
  assert.equal(o.applyPreset("vtank").ok, false);
  assert.equal(o.importHud().ok, false);
  assert.equal(o.setMineOnly(true).ok, false);
  assert.deepStrictEqual(storage.writes, [], "no setItem at all");
  assert.equal(p.active().writable, false);
  assert.equal(p.isUserProfileActive(), false);
});

await check("the Default overlay holds edits for the session (record() is the overlay)", () => {
  const p = store(spyStorage());
  assert.equal(p.record(), p.overlay());
  p.patch({ settings: { HealAt: 70, RingRange: 9 }, lists: { items: [1] }, refs: { navProfile: "a" } });
  assert.deepStrictEqual(p.overlay().settings, { HealAt: 70, RingRange: 9 });
  p.patch({ settings: { RingRange: undefined }, refs: { navProfile: null } });
  assert.deepStrictEqual(p.overlay().settings, { HealAt: 70 });
  assert.deepStrictEqual(p.overlay().refs, {});
  p.patch({ settings: { TopOffHP: 90 } }, { replace: true });
  assert.deepStrictEqual(p.overlay().settings, { TopOffHP: 90 });
  assert.equal(p.dirty, false, "the overlay is never dirty (never written)");
});

// ── [By char] / Save As / Mine Only ────────────────────────────────────────
await check("[By char] is created from the current live values on first select, then reused", () => {
  const storage = spyStorage();
  const p = store(storage, "1001");
  const o = createVtOptions({ profiles: p, now, log: quiet });
  const bot = { host: { nearbyRangeM: 60 }, vitals: { cfg: { healAtCombat: 77 } }, combat: { enabled: true, priorities: {} } };
  o.bindCells(createLiveCells(bot));
  const r = o.selectProfile("[By char]");
  assert.equal(r.ok, true);
  assert.deepStrictEqual(p.active(), { name: "[By char]", kind: "bychar", writable: true });
  const key = charKey("1001", "__bychar__");
  const rec = JSON.parse(storage.getItem(key));
  assert.equal(rec.settings.HealAt, 77);
  assert.equal(rec.kind, "bychar");
  assert.equal(rec.charName, "Tester");
  assert.deepStrictEqual(JSON.parse(storage.getItem("rynth.vt.v1.active.1001")), { name: "[By char]", kind: "bychar" });
  o.selectProfile("Default");
  assert.equal(bot.vitals.cfg.healAtCombat, 60, "Default pushes the schema default");
  assert.equal(storage.getItem("rynth.vt.v1.active.1001"), null, "Default = no marker");
  const savedAt = rec.savedAt;
  T += 1000;
  o.selectProfile("[By char]", "bychar");
  assert.equal(JSON.parse(storage.getItem(key)).savedAt, savedAt, "not recreated");
  assert.equal(bot.vitals.cfg.healAtCombat, 77, "its values are pushed back");
});

await check("Save As: name rules (no spaces, 1-40 chars) and reserved names; overwrite is case-insensitive", () => {
  const storage = spyStorage();
  const p = store(storage);
  for (const bad of ["has space", "", "x".repeat(41), "a.b", "a/b", "tab\tname", "Default", "default", "[By char]",
    "__bychar__", "__BYCHAR__", 42, null]) {
    const r = p.saveAs(bad, { current: cur() });
    assert.equal(r.ok, false, `refuse ${JSON.stringify(bad)}`);
    assert.ok(r.error, "with an error");
  }
  assert.deepStrictEqual(storage.writes, []);
  assert.ok(PROFILE_NAME_RE.test("My_Profile-1'"));
  assert.equal(p.saveAs("My_Profile-1'", { current: cur({ HealAt: 70 }) }).ok, true);
  assert.deepStrictEqual(p.active(), { name: "My_Profile-1'", kind: "shared", writable: true });
  assert.equal(JSON.parse(storage.getItem(sharedKey("My_Profile-1'"))).settings.HealAt, 70);
  assert.equal(p.saveAs("x".repeat(40), { current: cur() }).ok, true);
  // overwrite with different casing replaces the old key
  assert.equal(p.saveAs("farm", { current: cur({ HealAt: 1 }) }).ok, true);
  assert.equal(p.saveAs("Farm", { current: cur({ HealAt: 2 }) }).ok, true);
  assert.equal(storage.getItem(sharedKey("farm")), null);
  assert.equal(JSON.parse(storage.getItem(sharedKey("Farm"))).settings.HealAt, 2);
  // mineOnly ⇒ a [Char] profile of this scope
  assert.equal(p.saveAs("Solo", { mineOnly: true, current: cur() }).ok, true);
  assert.deepStrictEqual(p.active(), { name: "Solo", kind: "char", writable: true });
  assert.ok(storage.getItem(charKey("1001", "Solo")));
});

await check("Mine Only: shared → [Char] copy (shared kept); [Char] → shared; Default / [By char] rules", () => {
  const storage = spyStorage();
  const p = store(storage);
  assert.match(p.setMineOnly(true, { current: cur() }).error, /Default is read-only/);
  p.saveAs("Farm", { current: cur({ HealAt: 70 }) });
  assert.equal(p.setMineOnly(true, { current: cur({ HealAt: 71 }) }).ok, true);
  assert.deepStrictEqual(p.active(), { name: "Farm", kind: "char", writable: true });
  assert.ok(storage.getItem(sharedKey("Farm")), "the shared profile stays for other characters");
  assert.equal(JSON.parse(storage.getItem(charKey("1001", "Farm"))).settings.HealAt, 71);
  const labels = p.list().map((e) => e.label);
  assert.ok(labels.includes("Farm") && labels.includes("[Char] Farm"));
  assert.equal(p.setMineOnly(true, { current: cur() }).ok, true, "already character-only");
  const r = p.setMineOnly(false, { current: cur() });
  assert.equal(r.ok, false, "a shared Farm already exists");
  p.remove("Farm", "shared");
  assert.equal(p.setMineOnly(false, { current: cur({ HealAt: 72 }) }).ok, true);
  assert.deepStrictEqual(p.active(), { name: "Farm", kind: "shared", writable: true });
  assert.equal(storage.getItem(charKey("1001", "Farm")), null, "the [Char] copy moved");
  assert.equal(JSON.parse(storage.getItem(sharedKey("Farm"))).settings.HealAt, 72);
  p.select("[By char]", "bychar", { current: cur() });
  assert.equal(p.setMineOnly(true).ok, true);
  assert.equal(p.setMineOnly(false).ok, false);
});

await check("list order: Default, [By char], shared A-Z, then this character's [Char] profiles", () => {
  const storage = spyStorage();
  const p = store(storage, "1001");
  for (const n of ["Zeta", "alpha", "Mid"]) p.saveAs(n, { current: cur() });
  for (const n of ["Bravo", "Alpha"]) p.saveAs(n, { mineOnly: true, current: cur() });
  const other = store(storage, "2002");
  other.saveAs("Other", { mineOnly: true, current: cur() });
  other.select("[By char]", "bychar", { current: cur() });
  p.select("[By char]", "bychar", { current: cur() });
  assert.deepStrictEqual(p.list().map((e) => `${e.kind}:${e.label}`), [
    "default:Default", "bychar:[By char]", "shared:alpha", "shared:Mid", "shared:Zeta", "char:[Char] Alpha", "char:[Char] Bravo",
  ]);
  assert.ok(!other.list().some((e) => e.label === "[Char] Bravo"), "other characters' profiles are never listed");
  assert.ok(other.list().some((e) => e.label === "[Char] Other"));
  // select by label / by inferred kind (char before shared)
  assert.equal(p.select("[Char] Bravo").ok, true);
  assert.deepStrictEqual(p.active().kind, "char");
  assert.equal(p.select("alpha").ok, true);
  assert.equal(p.active().kind, "char", "a name in both scopes resolves to the character's own copy");
  assert.equal(p.active().name, "Alpha");
  assert.equal(p.select("ALPHA", "shared").ok, true);
  assert.deepStrictEqual([p.active().kind, p.active().name], ["shared", "alpha"]);
});

await check("two scopes are isolated; the active profile is restored on reload", () => {
  const storage = spyStorage();
  const a = store(storage, "1001");
  const b = store(storage, "2002");
  a.saveAs("Mine", { mineOnly: true, current: cur({ HealAt: 70 }) });
  assert.equal(a.active().name, "Mine");
  assert.equal(b.active().kind, "default", "another character keeps Default");
  assert.equal(b.select("Mine").ok, false, "not visible to another character");
  b.saveAs("Theirs", { current: cur({ HealAt: 50 }) });
  // reload: new stores on the same storage
  const a2 = store(storage, "1001");
  const b2 = store(storage, "2002");
  assert.deepStrictEqual(a2.active(), { name: "Mine", kind: "char", writable: true });
  assert.equal(a2.record().settings.HealAt, 70);
  assert.deepStrictEqual(b2.active(), { name: "Theirs", kind: "shared", writable: true });
  b2.select("Default");
  assert.equal(store(storage, "2002").active().kind, "default");
  // a marker pointing at a missing record falls back to Default
  storage.setItem("rynth.vt.v1.active.3003", JSON.stringify({ name: "Gone", kind: "shared" }));
  assert.equal(store(storage, "3003").active().kind, "default");
  storage.setItem("rynth.vt.v1.active.3004", "{not json");
  assert.equal(store(storage, "3004").active().kind, "default");
});

await check("remove(): stored profiles only; removing the active one selects Default", () => {
  const storage = spyStorage();
  const p = store(storage);
  p.saveAs("A", { current: cur() });
  p.saveAs("B", { current: cur() });
  assert.equal(p.remove("A", "shared").ok, true);
  assert.equal(storage.getItem(sharedKey("A")), null);
  assert.equal(p.active().name, "B");
  assert.equal(p.remove("B").ok, true);
  assert.equal(p.active().kind, "default");
  assert.equal(storage.getItem("rynth.vt.v1.active.1001"), null);
  assert.equal(p.remove("Default").ok, false);
  assert.equal(p.remove("Nope").ok, false);
  p.select("[By char]", "bychar", { current: cur() });
  assert.equal(p.remove("[By char]").ok, true);
  assert.equal(p.active().kind, "default");
});

await check("QuotaExceeded: {ok:false,error}, in-memory state kept, the next flush retries", () => {
  const storage = spyStorage();
  const p = store(storage);
  const o = createVtOptions({ profiles: p, now, log: quiet });
  o.saveAs("Main");
  storage.quota = true;
  const r = o.set("HealAt", 70, { source: "ui" });
  assert.equal(r.ok, true, "the value is applied");
  assert.match(r.saveError, /quota/i);
  assert.equal(o.getValue("HealAt"), 70, "kept in memory");
  assert.equal(p.dirty, true);
  assert.equal(JSON.parse(storage.getItem(sharedKey("Main"))).settings.HealAt, undefined);
  const f = p.flush();
  assert.equal(f.ok, false);
  assert.equal(f.wrote, false);
  assert.match(f.error, /quota/i);
  const sa = o.saveAs("Other");
  assert.equal(sa.ok, false);
  assert.equal(p.active().name, "Main", "a failed Save As changes nothing");
  storage.quota = false;
  T += 5000;
  o.autosaveTick(T);
  assert.equal(JSON.parse(storage.getItem(sharedKey("Main"))).settings.HealAt, 70, "retried");
  assert.equal(p.dirty, false);
  // NamedStore
  const ns = new NamedStore({ storage, prefix: "rynth.vt.v1.nav.", now, log: quiet });
  assert.equal(ns.put("loop", { v: 1 }).ok, true);
  storage.quota = true;
  const pr = ns.put("loop", { v: 2 });
  assert.equal(pr.ok, false);
  assert.match(pr.error, /quota/i);
  assert.deepStrictEqual(ns.get("loop"), { v: 1 }, "old value intact");
  storage.quota = false;
});

await check("storage events: the active record reloads when this tab has no unsaved edits", () => {
  const storage = spyStorage();
  const win = fakeWin();
  const p = store(storage, "1001", { win });
  const o = createVtOptions({ profiles: p, now, log: quiet });
  const bot = { host: { nearbyRangeM: 60 }, vitals: { cfg: { healAtCombat: 60 } }, combat: { enabled: true, priorities: {} } };
  o.bindCells(createLiveCells(bot));
  o.saveAs("Main");
  const events = [];
  o.onChange((e) => events.push(e));
  // another tab writes the same record
  const other = JSON.parse(storage.getItem(sharedKey("Main")));
  other.settings.HealAt = 80;
  other.lists.items = [{ guid: 1, name: "x" }];
  other.rev += 1;
  const text = JSON.stringify(other);
  storage.m.set(sharedKey("Main"), text);
  win.fire("storage", { key: sharedKey("Main"), newValue: text });
  assert.equal(p.record().settings.HealAt, 80);
  assert.equal(bot.vitals.cfg.healAtCombat, 80, "pushed to the live cell");
  assert.deepStrictEqual(events.map((e) => `${e.kind}:${e.key}:${e.source}`).sort(), ["list:items:external", "setting:HealAt:external"]);
  // unrelated keys are ignored
  win.fire("storage", { key: sharedKey("Other"), newValue: "{}" });
  win.fire("storage", { key: null, newValue: null });
  // unsaved local edits win
  p.patch({ settings: { HealAt: 65 } });
  const other2 = { ...other, settings: { HealAt: 90 } };
  win.fire("storage", { key: sharedKey("Main"), newValue: JSON.stringify(other2) });
  assert.equal(p.record().settings.HealAt, 65, "last writer wins; local edit kept");
  assert.ok(logs.some((l) => /another tab/.test(l)));
  // unsubscribe removes the window listener once nobody listens
  const p2 = store(storage, "1001", { win: fakeWin() });
  const un = p2.onExternalChange(() => {});
  assert.equal(p2._win.handlers.get("storage").size, 1);
  un();
  assert.equal(p2._win.handlers.get("storage").size, 0);
});

await check("storage-event reload: this tab's URL pins hold (another tab's save is not an operator action here)", () => {
  const storage = spyStorage();
  const win = fakeWin();
  const p = store(storage, "1001", { win });
  const o = createVtOptions({ profiles: p, now, log: quiet });
  o.saveAs("Main"); // made before the bot: record = defaults
  const bot = { host: { nearbyRangeM: 60 }, combat: { enabled: false, priorities: {} }, loot: { enabled: false, minValue: 0 },
    vitals: { cfg: { healAtCombat: 60 } }, buffSpec: null }; // ?botPersona=explorer boot
  o.bindCells(createLiveCells(bot));
  o.applyToCells({ legacy: true, urlPinned: new Set(["EnableCombat", "EnableLooting"]) });
  assert.equal(bot.combat.enabled, false);
  // another tab (no pins there) saves the shared profile: HealAt 80, Enable* at their defaults (true)
  const other = JSON.parse(storage.getItem(sharedKey("Main")));
  other.settings = { HealAt: 80 };
  other.rev += 1;
  const text = JSON.stringify(other);
  storage.m.set(sharedKey("Main"), text);
  win.fire("storage", { key: sharedKey("Main"), newValue: text });
  assert.equal(bot.vitals.cfg.healAtCombat, 80, "unpinned keys follow the other tab");
  assert.equal(bot.combat.enabled, false, "EnableCombat stays URL-pinned");
  assert.equal(bot.loot.enabled, false, "EnableLooting stays URL-pinned");
  // and the next autosave does not write the pinned live values into the profile
  T += 5000;
  o.autosaveTick(T);
  const rec = JSON.parse(storage.getItem(sharedKey("Main")));
  assert.equal("EnableCombat" in rec.settings, false);
  assert.equal(rec.settings.HealAt, 80);
});

await check("migrateHudBlob: read-only conversion of rynth.hud.settings.v1 (D27)", () => {
  const storage = spyStorage();
  assert.equal(ProfileStore.migrateHudBlob(storage, "1001", { now: T }), null, "no blob");
  storage.setItem(HUD_BLOB_KEY, JSON.stringify({
    vitals: { healAtCombat: 70, topOffHp: "90", bogus: 5, emergencyHp: 150, getManaAtCombat: 45.4, restamAtCombat: null },
    lootMin: 2500,
    buffs: [2, "24", -1, 2, 1.5],
    priorities: { " Drudge ": 30, rat: "2", bad: "x" },
    route: "atlas route",
    persona: "explorer",
  }));
  const writes = storage.writes.length;
  const m = ProfileStore.migrateHudBlob(storage, "1001", { now: T });
  assert.deepStrictEqual(m, {
    settings: { HealAt: 70, TopOffHP: 90, GetManaAt: 45, LootMinValue: 2500 },
    lists: { buffs: { spec: [2, 24], disabled: [], itemSpells: {} }, legacyPriorities: { drudge: 20, rat: 2 } },
  });
  assert.equal(storage.writes.length, writes, "read-only");
  storage.setItem(HUD_BLOB_KEY, JSON.stringify({ buffs: "auto" }));
  assert.deepStrictEqual(ProfileStore.migrateHudBlob(storage).lists.buffs.spec, "auto");
  storage.setItem(HUD_BLOB_KEY, JSON.stringify({ route: "x", persona: "grind" }));
  assert.equal(ProfileStore.migrateHudBlob(storage), null, "nothing usable");
  storage.setItem(HUD_BLOB_KEY, "{broken");
  assert.equal(ProfileStore.migrateHudBlob(storage), null);
  assert.equal(ProfileStore.migrateHudBlob(null), null);
  assert.equal(ProfileStore.migrateHudBlob({ getItem() { throw new Error("blocked"); } }), null);
});

await check("flush(): writes only when dirty (or forced), bumps rev, never for Default", () => {
  const storage = spyStorage();
  const p = store(storage);
  p.saveAs("Main", { current: cur() });
  const rev0 = JSON.parse(storage.getItem(sharedKey("Main"))).rev;
  assert.deepStrictEqual(p.flush(), { ok: true, wrote: false });
  p.patch({ settings: { HealAt: 70 } });
  assert.equal(p.dirty, true);
  T += 10;
  assert.deepStrictEqual(p.flush(), { ok: true, wrote: true });
  const rec = JSON.parse(storage.getItem(sharedKey("Main")));
  assert.equal(rec.rev, rev0 + 1);
  assert.equal(rec.savedAt, T);
  assert.equal(rec.v, 1);
  assert.deepStrictEqual(Object.keys(rec).sort(), ["kind", "lists", "name", "refs", "rev", "savedAt", "settings", "v"]);
  assert.deepStrictEqual(p.flush({ force: true }), { ok: true, wrote: true });
  // switching profiles flushes the outgoing one first
  p.patch({ settings: { HealAt: 71 } });
  p.select("Default");
  assert.equal(JSON.parse(storage.getItem(sharedKey("Main"))).settings.HealAt, 71);
});

// ── NamedStore ─────────────────────────────────────────────────────────────
await check("NamedStore: overwrite, case-insensitive names, sorted list, remove, invalid names", () => {
  const storage = spyStorage();
  const ns = new NamedStore({ storage, prefix: "rynth.vt.v1.nav.", now, log: quiet });
  assert.equal(ns.put("Loop One", { pts: [1] }).ok, true);
  assert.ok(storage.getItem("rynth.vt.v1.nav.loop one"), "key = prefix + lowercased name");
  T += 5;
  assert.equal(ns.put("LOOP ONE", { pts: [1, 2] }).ok, true, "overwrite");
  assert.deepStrictEqual(ns.get("loop one"), { pts: [1, 2] });
  assert.equal(ns.has("Loop one"), true);
  ns.put("alpha", { a: 1 });
  ns.put("Zed", { z: 1 });
  const l = ns.list();
  assert.deepStrictEqual(l.map((e) => e.name), ["alpha", "LOOP ONE", "Zed"]);
  assert.ok(l.every((e) => e.bytes > 0 && e.savedAt > 0));
  assert.equal(ns.remove("ALPHA").ok, true);
  assert.equal(ns.get("alpha"), null);
  assert.equal(ns.has("alpha"), false);
  for (const bad of ["", "   ", null, undefined, "a\nb", "x".repeat(201)]) assert.equal(ns.put(bad, 1).ok, false);
  assert.equal(ns.put("ok", undefined).ok, false);
  const cyc = {};
  cyc.self = cyc;
  assert.equal(ns.put("cyc", cyc).ok, false);
  // another prefix on the same storage is separate
  const meta = new NamedStore({ storage, prefix: "rynth.vt.v1.meta.", now, log: quiet });
  assert.deepStrictEqual(meta.list(), []);
  // empty NamedStore value allowed (an empty route is valid)
  assert.equal(ns.put("empty", { points: [] }).ok, true);
  // a corrupt record is skipped
  storage.setItem("rynth.vt.v1.nav.broken", "{nope");
  assert.equal(ns.get("broken"), null);
  assert.equal(ns.has("broken"), false, "has() agrees with get()/list() on an unreadable record");
  assert.ok(!ns.list().some((e) => e.name === "broken"));
});

await check("NamedStore / ProfileStore list on a non-enumerable Storage fake and on storage:null", () => {
  const bare = spyStorage({ enumerable: false });
  const a = new NamedStore({ storage: bare, prefix: "rynth.vt.v1.loot.", now, log: quiet });
  a.put("Salvage", { rules: [] });
  const b = new NamedStore({ storage: bare, prefix: "rynth.vt.v1.loot.", now, log: quiet });
  assert.deepStrictEqual(b.list().map((e) => e.name), ["Salvage"], "keys written through the module are remembered");
  bare.removeItem("rynth.vt.v1.loot.salvage");
  assert.deepStrictEqual(b.list(), []);
  const p = store(bare, "1001");
  p.saveAs("Shared1", { current: cur() });
  assert.ok(store(bare, "1001").list().some((e) => e.name === "Shared1"));
  const mem = new NamedStore({ storage: null, prefix: "rynth.vt.v1.nav.", now, log: quiet });
  mem.put("x", 1);
  assert.equal(mem.get("X"), 1);
  assert.deepStrictEqual(mem.list().map((e) => e.name), ["x"]);
  const pm = store(null, "1001");
  pm.saveAs("InMem", { current: cur({ HealAt: 70 }) });
  assert.equal(pm.record().settings.HealAt, 70);
  assert.ok(pm.list().some((e) => e.name === "InMem"));
  // a storage that throws on every call degrades to "nothing stored"
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } };
  const nb = new NamedStore({ storage: broken, prefix: "p.", now, log: quiet });
  assert.equal(nb.put("x", 1).ok, false);
  assert.equal(nb.get("x"), null);
  assert.deepStrictEqual(nb.list(), []);
  const pb = store(broken, "1");
  assert.equal(pb.active().kind, "default");
  assert.equal(pb.saveAs("A", { current: cur() }).ok, false);
});

// ── VtSession ──────────────────────────────────────────────────────────────
await check("getVtSession: one session per scope on win.__rynthVtSessions; attachCount; stores", () => {
  const win = {};
  const storage = spyStorage();
  const s1 = getVtSession(win, "1001", { storage, charName: "", now, log: quiet });
  assert.ok(win.__rynthVtSessions instanceof Map);
  const s2 = getVtSession(win, "1001", { storage, charName: "Tester", now, log: quiet });
  assert.equal(s1, s2, "same scope ⇒ same object");
  assert.equal(s1.charName, "Tester", "charName filled in once known");
  assert.equal(s1.attachCount, 0);
  const firstAttach = s1.attachCount++ === 0;
  const secondAttach = s2.attachCount++ === 0;
  assert.deepStrictEqual([firstAttach, secondAttach, s1.attachCount], [true, false, 2]);
  const s3 = getVtSession(win, 2002, { storage, now, log: quiet });
  assert.notEqual(s3, s1);
  assert.equal(s3.scope, "2002");
  assert.equal(peekVtSession(win, "1001"), s1);
  assert.equal(peekVtSession(win, "9999"), null);
  assert.equal(peekVtSession({}, "1001"), null);
  assert.equal(getVtSession(win, 0x80000001, { storage, now }).scope, "2147483649", "guid → decimal string");
  assert.equal(getVtSession(win, "", { storage, now }).scope, "pending");
  assert.equal(getVtSession(win, undefined, { storage, now }).scope, "pending");
  // the botScopeOf convention (x >>> 0) also for decimal strings: one session per character
  assert.equal(getVtSession(win, "-5", { storage, now }), getVtSession(win, -5, { storage, now }));
  assert.equal(getVtSession(win, "4294967291", { storage, now }), getVtSession(win, -5, { storage, now }));
  assert.equal(getVtSession(win, " 1001 ", { storage, now }), s1);
  assert.deepStrictEqual(["0", 0, 2 ** 32, "pending", "abc"].map(S.normaliseScope), ["pending", "pending", "pending", "pending", "abc"]);
  // shape
  for (const k of ["scope", "charName", "options", "profiles", "stores", "navState", "metaState", "meta", "varsSession",
    "attachCount", "createdAt", "ext"]) assert.ok(k in s1, `session.${k}`);
  assert.equal(s1.options.profiles, s1.profiles);
  assert.equal(s1.meta, null);
  assert.equal(s1.createdAt, T);
  s1.stores.nav.put("Loop", { v: 1, name: "Loop", routeType: 1, points: [] });
  s1.stores.meta.put("Farm", { v: 1 });
  s1.stores.loot.put("Salv", { version: 1 });
  assert.ok(storage.getItem("rynth.vt.v1.nav.loop"));
  assert.ok(storage.getItem("rynth.vt.v1.meta.farm"));
  assert.ok(storage.getItem("rynth.vt.v1.loot.salv"));
  // the Default overlay and session state survive a "rebind" (same session object)
  s1.options.set("HealAt", 70);
  s1.navState.index = 3;
  const again = getVtSession(win, "1001", { storage });
  assert.equal(again.options.getValue("HealAt"), 70);
  assert.equal(again.navState.index, 3);
  // a fresh page (new win) = a fresh session; Default overlay gone, stores persist
  const fresh = getVtSession({}, "1001", { storage, now });
  assert.equal(fresh.options.getValue("HealAt"), 60);
  assert.deepStrictEqual(fresh.stores.nav.get("loop").points, []);
});

await check("getVtSession: storage defaults to win.localStorage (guarded); null ⇒ in-memory", () => {
  const ls = spyStorage();
  const win = { localStorage: ls };
  const s = getVtSession(win, "1001", { now, log: quiet });
  s.options.saveAs("FromLs");
  assert.ok(ls.getItem(sharedKey("FromLs")));
  const blocked = {};
  Object.defineProperty(blocked, "localStorage", { get() { throw new Error("SecurityError"); } });
  const sb = getVtSession(blocked, "1001", { now, log: quiet });
  assert.equal(sb.options.saveAs("Mem").ok, true, "in-memory fallback");
  const sn = getVtSession({ localStorage: ls }, "1001", { storage: null, now, log: quiet });
  sn.options.saveAs("NotInLs");
  assert.equal(ls.getItem(sharedKey("NotInLs")), null);
  // no win at all still works (module-private registry)
  const a = getVtSession(null, "77", { storage: null, now });
  assert.equal(getVtSession(null, "77", { storage: null, now }), a);
  assert.ok(SCHEMA.length > 50);
});

console.log(fail === 0 ? `rynth_vt_profiles: all ${pass} checks passed` : `rynth_vt_profiles: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
