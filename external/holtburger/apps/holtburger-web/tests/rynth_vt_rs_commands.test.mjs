// tests/rynth_vt_rs_commands.test.mjs — the /rs command dispatcher (PLAN W1-5
// CMD §3.7, §6 W1-5; covers K1-K7, R14-R22, M26).
//
// Every guide command line G:216-224, G:123 and the G:304-315 death-runback
// lines run against FAKE services shaped like the §3 contracts (ActiveNav,
// VtOptions/ProfileStore, MetaEngine, VtLayer.library, VtActions, the host,
// the HUD bridge). No other vt package is imported (C2). Pure node.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_rs_commands.test.mjs

import assert from "node:assert/strict";

const M = await import("../rynth/vt/cmd/index.js");
const { RS_PREFIXES, parseRsLine, createRsDispatcher, parseCoords, parseJumpArgs, COMPAT, poseToCoords } = M;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 5).join("\n       ") : e}`);
  }
}

// ── fakes ────────────────────────────────────────────────────────────────────
const ME = 0x50000001;
const POSE = { objCellId: 0xa9b40019, x: 84, y: 12, z: 48, heading: 0 }; // Holtburg-ish; z 48 m → 0.2 nav units

function pt(type, extra = {}) {
  return { type, ew: 1, ns: 2, z: 0, flag: "0", ...extra };
}

function fakeNav() {
  const calls = [];
  const profiles = {
    runback: { name: "runback", routeType: 4, points: [pt(0), pt(0), pt(0)] },
    fighting: { name: "fighting", routeType: 1, points: [pt(0), pt(0)] },
  };
  const st = {
    route: { name: null, routeType: 1, points: [], activeIndex: 0, reversed: false, followTarget: null, paused: null },
    enabled: false,
  };
  const nav = {
    calls,
    st,
    get enabled() {
      return st.enabled;
    },
    setEnabled(on) {
      calls.push(["setEnabled", on]);
      st.enabled = !!on;
      return { ok: true, enabled: !!on };
    },
    resume() {
      calls.push(["resume"]);
      st.route.paused = null;
      return { ok: true };
    },
    hasRoute: () => st.route.points.length > 0 || !!st.route.followTarget,
    isEmpty: () => !nav.hasRoute(),
    route: () => JSON.parse(JSON.stringify(st.route)),
    status: () => ({
      name: st.route.name,
      type: st.route.routeType,
      i: st.route.activeIndex,
      n: st.route.points.length,
      exec: null,
      lastResult: null,
      reversed: st.route.reversed,
      followTarget: st.route.followTarget,
      enabled: st.enabled,
      paused: st.route.paused,
    }),
    save(name) {
      calls.push(["save", name]);
      return { ok: true };
    },
    loadByName(name) {
      calls.push(["loadByName", name]);
      const p = profiles[name];
      if (!p) return { ok: false, error: `no nav profile named "${name}"` };
      st.route = { name: p.name, routeType: p.routeType, points: p.points.slice(), activeIndex: 0, reversed: false, followTarget: null, paused: null };
      return { ok: true, warnings: [] };
    },
    clear() {
      calls.push(["clear"]);
      st.route = { ...st.route, points: [], activeIndex: 0 };
      return { ok: true };
    },
    add(point, opts) {
      calls.push(["add", point, opts]);
      st.route.points.push(point);
      return st.route.points.length - 1;
    },
    addHere(type, fields, opts) {
      calls.push(["addHere", type, fields, opts]);
      st.route.points.push(pt(type, fields));
      return { ok: true, index: st.route.points.length - 1 };
    },
    removeAt(i) {
      calls.push(["removeAt", i]);
      st.route.points.splice(i, 1);
      return { ok: true };
    },
    setActive(i) {
      calls.push(["setActive", i]);
      st.route.activeIndex = i;
      return { ok: true, index: i };
    },
    step(d) {
      calls.push(["step", d]);
      st.route.activeIndex = (st.route.activeIndex + d + st.route.points.length) % Math.max(1, st.route.points.length);
      return { ok: true, index: st.route.activeIndex };
    },
    setType(t) {
      calls.push(["setType", t]);
      st.route.routeType = t;
      return { ok: true, routeType: t };
    },
    setFollowTarget(t) {
      calls.push(["setFollowTarget", t]);
      st.route.followTarget = t;
      if (t) st.route.routeType = 3;
      return { ok: true };
    },
    reverse(flag) {
      calls.push(["reverse", flag]);
      st.route.reversed = flag === undefined ? !st.route.reversed : !!flag;
      return st.route.reversed;
    },
    requestJump(req) {
      calls.push(["requestJump", req]);
      return { ok: true, queued: false };
    },
  };
  return nav;
}

const VT_NAMES = {
  enablebuffing: "EnableBuffing",
  enablenav: "EnableNavigation",
  enablenavigation: "EnableNavigation",
  enablecombat: "EnableCombat",
  enablelooting: "EnableLooting",
  enablemeta: "EnableMeta",
  attackdistance: "MonsterRange",
  monsterrange: "MonsterRange",
  meleeattackpower: "MeleeAttackPower",
  missileattackpower: "MissileAttackPower",
};
function fakeOptions() {
  const store = {
    EnableBuffing: false,
    EnableNavigation: false,
    EnableCombat: false,
    EnableLooting: true,
    EnableMeta: false,
    MonsterRange: 40,
    MeleeAttackPower: 0.6,
    MissileAttackPower: 0.6,
  };
  const calls = [];
  const bag = new Map();
  const profileList = [
    { name: "Default", kind: "default", label: "Default" },
    { name: "__bychar__", kind: "bychar", label: "[By char]" },
    { name: "Farm", kind: "shared", label: "Farm" },
  ];
  let active = { name: "Default", kind: "default", writable: false };
  const lbf = (name) => String(name).toLowerCase() === "attackdistance";
  const opts = {
    calls,
    store,
    bag: {
      get: (n) => bag.get(String(n).toLowerCase()),
      set: (n, v) => bag.set(String(n).toLowerCase(), v),
      has: (n) => bag.has(String(n).toLowerCase()),
    },
    get(name, o = {}) {
      calls.push(["get", name, o]);
      const k = VT_NAMES[String(name).toLowerCase()];
      if (!k) return { ok: false, error: `unknown option ${name}` };
      const v = o.vtUnits && lbf(name) ? store[k] / 240 : store[k];
      return { ok: true, value: v, key: k };
    },
    set(name, raw, o = {}) {
      calls.push(["set", name, raw, o]);
      const k = VT_NAMES[String(name).toLowerCase()];
      if (!k) return { ok: false, error: `unknown option ${name}` };
      let v = raw;
      if (typeof store[k] === "boolean") v = /^(true|on|yes|1)$/i.test(String(raw));
      else v = Number(raw);
      if (lbf(name)) v = Math.round(v * 240 * 10000) / 10000;
      store[k] = v;
      const shown = lbf(name) ? String(Number((v / 240).toPrecision(7))) : String(v);
      return { ok: true, value: v, key: k, echo: `[RynthSuite] Set option ${String(name).trim()} = ${shown}` };
    },
    list(filter) {
      calls.push(["list", filter]);
      return Object.keys(store)
        .filter((k) => !filter || k.toLowerCase().includes(String(filter).toLowerCase()))
        .map((k) => ({ key: k, vtName: k === "MonsterRange" ? "AttackDistance" : k, value: store[k], vtValue: k === "MonsterRange" ? store[k] / 240 : store[k], inert: false }));
    },
    profiles: { list: () => profileList, active: () => active },
    selectProfile(name, kind) {
      calls.push(["selectProfile", name, kind]);
      const p = profileList.find((x) => x.name.toLowerCase() === String(name).toLowerCase() || x.label.toLowerCase() === String(name).toLowerCase());
      if (!p && kind !== "char") return { ok: false, error: `no profile named "${name}"` };
      active = p ? { name: p.name, kind: p.kind, writable: p.kind !== "default" } : { name, kind: "char", writable: true };
      return { ok: true, active };
    },
    saveAs(name, { mineOnly = false } = {}) {
      calls.push(["saveAs", name, mineOnly]);
      if (!/^[A-Za-z0-9_'-]{1,40}$/.test(name)) return { ok: false, error: `invalid profile name "${name}" (letters, digits, _ ' - only, no spaces)` };
      active = { name, kind: mineOnly ? "char" : "shared", writable: true };
      return { ok: true, active };
    },
    applyPreset(n) {
      calls.push(["applyPreset", n]);
      return active.kind === "default" ? { ok: false, error: "Default is read-only — Save As first" } : { ok: true, applied: ["x"] };
    },
    importHud() {
      calls.push(["importHud"]);
      return active.kind === "default" ? { ok: false, imported: [], error: "Default is read-only — Save As first" } : { ok: true, imported: ["HealAt", "buffs"] };
    },
  };
  return opts;
}

function fakeHost(over = {}) {
  const calls = [];
  const rec = (name, ret) => (...a) => {
    calls.push([name, ...a]);
    return typeof ret === "function" ? ret(...a) : ret;
  };
  const h = {
    calls,
    portal: false,
    GetPlayerId: () => ME,
    TryGetPlayerPose: () => ({ ...POSE }),
    IsPortalSpaceActive: () => h.portal,
    TryGetFellowshipInfo: () => ({ name: "Fel", leaderGuid: 0x50000009, open: true, isLocked: false, members: [{ guid: 0x50000009, name: "Leader Larry", level: 50 }, { guid: ME, name: "Me", level: 40 }] }),
    FindNearbyByName: (name, o = {}) => (String(name).toLowerCase() === "bob" ? [{ guid: 0x50000042, name: "Bob", dist: 4 }] : []),
    TryGetObjectName: (g) => ({ [0x50000009]: "Leader Larry", [0x50000042]: "Bob" })[g] ?? null,
    TryGetKnownSpells: () => [2931, 48],
    TryGetSpellRecord: (id) => ({ 2931: { id, name: "Recall Aphus Lassel", isSelfTargeted: true }, 48: { id, name: "Primary Portal Recall", isSelfTargeted: true } })[id] ?? null,
    GetSelectedId: () => 0,
    FellowshipCreate: rec("FellowshipCreate", true),
    FellowshipSetOpen: rec("FellowshipSetOpen", true),
    FellowshipQuit: rec("FellowshipQuit", true),
    FellowshipRecruit: rec("FellowshipRecruit", true),
    LogOffCharacter: rec("LogOffCharacter", true),
    ForceResetBusyCount: rec("ForceResetBusyCount"),
    StopCompletely: rec("StopCompletely", true),
    CancelAttack: rec("CancelAttack", true),
    ChangeCombatMode: rec("ChangeCombatMode", true),
    RecallToLifestone: rec("RecallToLifestone", true),
    RecallAllegianceHometown: rec("RecallAllegianceHometown", true),
    InvokeChatParser: rec("host.InvokeChatParser", true),
    WriteToChatWindow: rec("host.WriteToChatWindow", true),
    ...over,
  };
  return h;
}

function fakeActions() {
  const calls = [];
  const inv = [
    { guid: 0x70000001, name: "Mana Stone", stackSize: 1, wcid: 2434, itemType: 0x80000, equipMask: 0 },
    { guid: 0x70000002, name: "Pyreal", stackSize: 25, wcid: 273, itemType: 0x40, equipMask: 0 },
    { guid: 0x70000003, name: "Brood Matron Jaw", stackSize: 1, wcid: 9999, itemType: 0x80, equipMask: 0 },
    { guid: 0x70000004, name: "Licorice Rat", stackSize: 3, wcid: 4000, itemType: 0x20, equipMask: 0 },
    { guid: 0x70000005, name: "Wand of Frost", stackSize: 1, wcid: 5000, itemType: 0x8000, equipMask: 0x1000000 },
  ];
  const land = [
    { guid: 0x80000101, name: "Behdo Yii", dist: 3 },
    { guid: 0x80000102, name: "Town Network Portal", dist: 9 },
    { guid: 0x80000103, name: "Shopkeeper", dist: 5 },
    { guid: 0x50000042, name: "Bob", dist: 4 },
  ];
  const classes = { 0x80000101: 37, 0x80000102: 14, 0x80000103: 25, 0x50000042: 24 };
  const rec = (name, fn) => (...a) => {
    calls.push([name, ...a]);
    return fn(...a);
  };
  let lootTries = 0;
  const matches = (n, want, { partial = false, regex = false } = {}) =>
    regex ? new RegExp(want, "i").test(n) : partial ? n.toLowerCase().includes(String(want).toLowerCase()) : n.toLowerCase() === String(want).toLowerCase();
  const A = {
    calls,
    lootReady: false,
    findInventoryByName: (name, o) => inv.filter((r) => matches(r.name, name, o)).map((r) => ({ guid: r.guid, name: r.name, stack: r.stackSize, wcid: r.wcid, containerId: 0 })),
    findNearestByName: (name, o) => land.filter((x) => matches(x.name, name, o)).sort((a, b) => a.dist - b.dist)[0] ?? null,
    findAllByName: (name, o) => land.filter((x) => matches(x.name, name, o)),
    inventory: () => inv.slice(),
    landscape: () => land.slice(),
    objectClassOf: (g) => classes[g] ?? 0,
    use: rec("use", () => ({ ok: true })),
    useOn: rec("useOn", () => ({ ok: true })),
    give: rec("give", () => ({ ok: true })),
    select: rec("select", () => ({ ok: true })),
    equip: rec("equip", () => ({ ok: true })),
    unequip: rec("unequip", () => ({ ok: true })),
    drop: rec("drop", () => ({ ok: true })),
    lootFromOpen: rec("lootFromOpen", (name) => {
      lootTries++;
      return A.lootReady ? { ok: true, guid: 0x70000099, name } : { ok: false, error: "no container is open", retry: true };
    }),
    castById: rec("castById", () => 0),
    setCombatState: rec("setCombatState", () => ({ ok: true })),
    face: rec("face", (d) => ({ ok: true, headingDeg: Number(d) })),
    get lootTries() {
      return lootTries;
    },
  };
  return A;
}

function fakeMeta() {
  const calls = [];
  return {
    calls,
    state: "Default",
    enabled: false,
    enterState(s, why) {
      calls.push(["enterState", s, why]);
      this.state = s;
    },
    setDebug(on) {
      calls.push(["setDebug", on]);
    },
  };
}

function fakeLibrary() {
  const calls = [];
  return {
    calls,
    listMetas: () => [{ name: "BGAugGem" }, { name: "ColRings" }],
    loadMeta: (n) => (calls.push(["loadMeta", n]), n === "missing" ? { ok: false, error: `no meta named "${n}"` } : { ok: true, warnings: [] }),
    listLoot: () => [{ name: "VendorSnob" }],
    loadLoot: (n) => (calls.push(["loadLoot", n]), /\.utl$/i.test(n) ? { ok: false, error: `no loot profile named "${n}"` } : { ok: true }),
    clearLoot: () => (calls.push(["clearLoot"]), { ok: true }),
  };
}

/** A whole world: ctx + every fake, plus the printed lines and chat-parser calls. */
function world({ withBot = true, held = false, hud = null, extraVt = {} } = {}) {
  const printed = [];
  const parser = [];
  let t = 1_800_000_000_000;
  const host = fakeHost();
  const nav = fakeNav();
  const options = fakeOptions();
  const actions = fakeActions();
  const meta = fakeMeta();
  const library = fakeLibrary();
  const quests = { calls: [], refresh() { this.calls.push("refresh"); return true; } };
  const expr = {
    evaluate: (src) =>
      src.trim() === "1+2"
        ? 3
        : src.includes("bad[")
          ? { t: "err", msg: 'Call to unknown function "bad"' }
          : src.includes("wobjectgetplayer")
            ? { t: "wobj", guid: ME, name: "Me" }
            : src.trim(),
  };
  const buff = { calls: [], forceRebuff() { this.calls.push("force"); }, cancelForceRebuff() { this.calls.push("cancel"); } };
  const control = {
    calls: [],
    stopped: held,
    resume() { this.calls.push("resume"); this.stopped = false; },
    stop(o) { this.calls.push(["stop", o]); this.stopped = true; },
    isStopped() { return this.stopped; },
  };
  const session = { options, ext: {} };
  const vt = { options, nav, navProfiles: { list: () => [{ name: "fighting" }, { name: "runback" }] }, meta, library, quests, expr, actions, session, ...extraVt };
  const bot = withBot ? { host, vt, buff, control, kernel: { get operatorHeld() { return control.stopped; } } } : null;
  const W = {
    host, nav, options, actions, meta, library, quests, buff, control, session, bot, printed, parser,
    advance(ms) { t += ms; return t; },
    get now() { return t; },
  };
  W.ctx = {
    print: (text, category) => printed.push({ text, category }),
    now: () => t,
    bot: () => bot,
    vt: () => (bot ? bot.vt : null),
    session: () => session,
    hud: () => hud,
    host: () => host,
    operatorHeld: () => (bot ? control.stopped : false),
    openPanel: (tab) => (W.openedTab = tab ?? "(default)", Promise.resolve()),
    invokeChatParser: (line) => (parser.push(line), true),
  };
  W.rs = createRsDispatcher({ getCtx: () => W.ctx });
  W.run = (line, source = "chat") => W.rs.run(line, { source });
  W.texts = () => printed.map((p) => p.text);
  return W;
}

const lastLine = (r) => r.lines[r.lines.length - 1]?.text;

// ── parse / prefixes ─────────────────────────────────────────────────────────
await check("RS_PREFIXES: exactly rs vt ra mt ub, read-only", () => {
  assert.deepEqual([...RS_PREFIXES].sort(), ["mt", "ra", "rs", "ub", "vt"]);
  assert.throws(() => RS_PREFIXES.add("xx"));
  assert.throws(() => RS_PREFIXES.delete("rs"));
  assert.ok(RS_PREFIXES.has("rs"));
});

await check("parseRsLine: slash and bare (!bot) forms, lowercased verb, raw rest", () => {
  assert.deepEqual(parseRsLine("/rs nav load  run back"), { prefix: "rs", verb: "nav", args: ["load", "run", "back"], rest: "load  run back", raw: "/rs nav load  run back" });
  const b = parseRsLine("vt Opt SET EnableNav true");
  assert.equal(b.prefix, "vt");
  assert.equal(b.verb, "opt");
  assert.deepEqual(b.args, ["SET", "EnableNav", "true"]);
  assert.equal(parseRsLine("/RS help").prefix, "rs");
  const m = parseRsLine("/ub mexec $x = 1 +  2");
  assert.equal(m.rest, "$x = 1 +  2", "inner whitespace kept for mexec");
  assert.equal(parseRsLine("/rs").verb, "");
  for (const bad of ["/rsx foo", "/say hi", "@rs opt list", "hello", "/ls", "", "   ", null, 42]) assert.equal(parseRsLine(bad), null, String(bad));
});

await check("wouldHandle: every slash /rs /vt /ra /mt /ub line, nothing else", () => {
  const { rs } = world();
  for (const p of ["rs", "vt", "ra", "mt", "ub"]) {
    assert.equal(rs.wouldHandle(`/${p} anything at all`), true, p);
    assert.equal(rs.wouldHandle(`  /${p.toUpperCase()}`), true, p);
  }
  for (const l of ["rs opt list", "/ls", "/t bob, hi", "@vt opt", "say /rs", "/rsfoo"]) assert.equal(rs.wouldHandle(l), false, l);
});

// ── G:216-224 (Route tab command line) ──────────────────────────────────────
await check("G:216 /rs nav save <name> → ActiveNav.save", () => {
  const W = world();
  const r = W.run("/rs nav save myroute");
  assert.equal(r.handled, true);
  assert.equal(r.error, undefined);
  assert.deepEqual(W.nav.calls.find((c) => c[0] === "save"), ["save", "myroute"]);
  assert.match(lastLine(r), /myroute/);
});

await check("G:217 /rs nav load <name> is synchronous: the route is non-empty within the same run()", () => {
  const W = world();
  assert.equal(W.nav.isEmpty(), true);
  const r = W.run("/rs nav load runback");
  assert.equal(W.nav.isEmpty(), false, "loaded before run() returned");
  assert.equal(r.pending, undefined, "no async work for nav load");
  assert.deepEqual(W.nav.calls[0], ["loadByName", "runback"]);
  assert.equal(W.nav.calls.some((c) => c[0] === "setEnabled"), false, "nav load never changes EnableNavigation (G:304-306)");
  const bad = W.run("/rs nav load nowhere");
  assert.match(bad.error, /no nav profile named "nowhere"/);
});

await check("G:218 /rs addnavpt <coords>: N/S/E/W, comma, signed, z, end-append, bounds", () => {
  const W = world();
  W.run("/rs addnavpt 12.3N 41.5E");
  let [, p, o] = W.nav.calls.at(-1);
  assert.deepEqual([p.type, p.ns, p.ew], [0, 12.3, 41.5]);
  assert.equal(p.z, POSE.z / 240, "Z = pose.z / 240 (nav units, fixes C# metres)");
  assert.deepEqual(o, { mode: "end" });
  W.run("/rs addnavpt 12.3S, 41.5W");
  [, p] = W.nav.calls.at(-1);
  assert.deepEqual([p.ns, p.ew], [-12.3, -41.5]);
  W.run("/vt addnavpt -12.3 41.5");
  [, p] = W.nav.calls.at(-1);
  assert.deepEqual([p.ns, p.ew], [-12.3, 41.5]);
  W.run("/rs addnavpt 12.3n,41.5e 0.5");
  [, p] = W.nav.calls.at(-1);
  assert.deepEqual([p.ns, p.ew, p.z], [12.3, 41.5, 0.5]);
  W.run("/vt addnavpt 41.53N, 34.46E, 0.20Z"); // corpus: ChatExpr `/vt addnavpt `+$tempCoords
  [, p] = W.nav.calls.at(-1);
  assert.deepEqual([p.ns, p.ew, p.z], [41.53, 34.46, 0.2]);
  const n = W.nav.calls.length;
  const r = W.run("/rs addnavpt 120N 1E");
  assert.match(r.error, /within ±102/);
  assert.equal(W.nav.calls.length, n, "out of bounds adds nothing");
});

await check("G:218 /rs addnavpt with no coordinates = the current pose", () => {
  const W = world();
  W.run("/rs addnavpt");
  const [, p] = W.nav.calls.at(-1);
  const here = poseToCoords(POSE);
  assert.ok(Math.abs(p.ns - here.ns) < 1e-9 && Math.abs(p.ew - here.ew) < 1e-9);
  assert.equal(p.z, 0.2);
});

await check("G:219 /rs addnavcheckpoint → type 8 at the pose, appended", () => {
  const W = world();
  const r = W.run("/rs addnavcheckpoint");
  assert.deepEqual(W.nav.calls.at(-1), ["addHere", 8, {}, { mode: "end" }]);
  assert.match(lastLine(r), /checkpoint 1/);
});

await check("G:220 /rs jump <heading> <true|false> <ms> (VTank form, in place)", () => {
  const W = world();
  W.run("/rs jump 90 true 500");
  assert.deepEqual(W.nav.calls.at(-1), ["requestJump", { headingDeg: 90, shift: true, ms: 500, direction: "none" }]);
  W.run("/vt jump false 250");
  assert.deepEqual(W.nav.calls.at(-1)[1], { headingDeg: null, shift: false, ms: 250, direction: "none" });
  const r = W.run("/rs jump 400 true 10");
  assert.match(r.error, /heading/);
  const r2 = W.run("/rs jump 10 true 5000");
  assert.match(r2.error, /0-1000/);
});

await check("jump disambiguation: /ub jumpsw 90 500 (UB), /ra jump 90 (= hold 90), /rs jump 90.5 (heading)", () => {
  const W = world();
  W.run("/ub jumpsw 90 500");
  assert.deepEqual(W.nav.calls.at(-1), ["requestJump", { headingDeg: 90, shift: true, ms: 500, direction: "forward" }]);
  W.run("/ra jump 90");
  assert.deepEqual(W.nav.calls.at(-1)[1], { headingDeg: null, shift: false, ms: 90, direction: "none" }, "one integer = hold (C# quirk)");
  W.run("/rs jump 90.5");
  assert.equal(W.nav.calls.at(-1)[1].headingDeg, 90.5);
  W.run("/ub jumpz");
  assert.equal(W.nav.calls.at(-1)[1].direction, "strafeleft");
  W.run("/ub jumpc 45 100");
  assert.deepEqual(W.nav.calls.at(-1)[1], { headingDeg: 45, shift: false, ms: 100, direction: "straferight" });
  assert.equal(parseJumpArgs("jumpq", []).ok, false);
  assert.equal(parseJumpArgs("jump", ["1", "2", "3"]).ok, false);
});

await check("G:221-222 /rs addnavjump [heading] [shift] [charge] [direction]", () => {
  const W = world();
  W.run("/rs addnavjump 90 true 500");
  assert.deepEqual(W.nav.calls.at(-1), ["addHere", 9, { headingDeg: 90, holdShift: true, delayMs: 500 }, { mode: "end" }]);
  W.run("/rs addnavjump 270 false 200 strafeleft");
  assert.deepEqual(W.nav.calls.at(-1)[2], { headingDeg: 270, holdShift: false, delayMs: 200, direction: "strafeleft" });
  W.run("/rs addnavjump");
  assert.deepEqual(W.nav.calls.at(-1)[2], { holdShift: false, delayMs: 0 }, "heading omitted → ActiveNav uses the current heading");
  const r = W.run("/rs addnavjump 90 sideways");
  assert.match(r.error, /sideways/);
});

await check("G:223-224 /rs reverseroute true|false|toggle + reverseroutequery", () => {
  const W = world();
  W.run("/rs nav load fighting");
  let r = W.run("/rs reverseroute true");
  assert.deepEqual(W.nav.calls.at(-1), ["reverse", true]);
  assert.equal(lastLine(r), "[RynthSuite] reverseroute = true");
  r = W.run("/rs reverseroutequery");
  assert.deepEqual(r.lines.map((l) => l.text), ["true"]);
  W.run("/rs reverseroute true");
  assert.equal(W.run("/vt reverseroutequery").lines[0].text, "true", "true is idempotent");
  W.run("/rs reverseroute false");
  assert.equal(W.run("/rs reverseroutequery").lines[0].text, "false");
  W.run("/rs reverseroute");
  assert.deepEqual(W.nav.calls.at(-1), ["reverse", undefined], "no argument toggles");
  assert.equal(W.run("/rs reverseroutequery").lines[0].text, "true");
  assert.match(W.run("/rs reverseroute maybe").error, /usage/);
});

// ── G:123 ───────────────────────────────────────────────────────────────────
await check("G:123 /vt listmonstervariables prints G:125-134 with DYNAMIC tags", () => {
  const W = world();
  const r = W.run("/vt listmonstervariables");
  const text = r.lines.map((l) => l.text).join("\n");
  for (const v of ["true", "false", "name", "typeid", "species", "maxhp", "range", "hasshield", "setting_x", "metastate"]) {
    assert.match(text, new RegExp(`\\b${v}\\b`), v);
  }
  for (const v of ["range", "hasshield", "setting_x", "metastate"]) assert.match(text, new RegExp(`${v} \\(DYNAMIC\\)`), v);
  for (const v of ["name", "species", "maxhp"]) assert.doesNotMatch(text, new RegExp(`${v} \\(DYNAMIC\\)`), v);
  // Same output under /rs.
  assert.deepEqual(W.run("/rs listmonstervariables").lines, r.lines);
});

// ── G:304-315 (the guide's death/runback example, as chat lines) ────────────
await check("G:304-315 runback lines apply synchronously to nav and options; nothing reaches the game", () => {
  const W = world();
  const lines = [
    "/vt nav load runback",
    "/vt opt set enablebuffing true",
    "/vt opt set enablenav true",
    "/vt nav load fighting",
    "/vt opt set enablecombat true",
  ];
  const results = lines.map((l) => W.run(l, "meta"));
  for (const r of results) assert.equal(r.error, undefined, r.lines.map((x) => x.text).join(" | "));
  assert.equal(W.nav.route().name, "fighting");
  assert.equal(W.options.store.EnableBuffing, true);
  assert.equal(W.options.store.EnableNavigation, true);
  assert.equal(W.options.store.EnableCombat, true);
  assert.equal(lastLine(results[1]), "[RynthSuite] Set option enablebuffing = true");
  assert.deepEqual(W.options.calls.find((c) => c[0] === "set"), ["set", "enablebuffing", "true", { source: "command" }]);
  assert.deepEqual(W.parser, [], "no line reaches the chat parser / ACE");
});

await check("/vt ≡ /rs: identical results for the same verbs", () => {
  const A = world();
  const B = world();
  for (const v of ["help", "opt get AttackDistance", "nav load runback", "nav status", "reverseroute", "reverseroutequery", "echo hi there", "refresh", "foo"]) {
    const ra = A.run(`/rs ${v}`);
    const rb = B.run(`/vt ${v}`);
    const norm = (r) => r.lines.map((l) => l.text.replace(/\/(rs|vt)\b/g, "/X"));
    assert.deepEqual(norm(rb), norm(ra), v);
  }
});

// ── options (K3) ─────────────────────────────────────────────────────────────
await check("opt set echo text; unknown option → error and NO write", () => {
  const W = world();
  const r = W.run("/rs opt set AttackDistance 0.0833");
  assert.equal(lastLine(r), "[RynthSuite] Set option AttackDistance = 0.0833");
  assert.equal(W.options.store.MonsterRange, 19.992);
  const before = JSON.stringify(W.options.store);
  const u = W.run("/rs opt set NoSuchOption 5");
  assert.match(u.error, /unknown option NoSuchOption/);
  assert.equal(JSON.stringify(W.options.store), before);
  assert.equal(W.options.bag.has("NoSuchOption"), false, "the meta bag is not written by /rs opt (D19)");
  // fallback echo when the authority returns none
  W.options.set = (n, v) => ({ ok: true, value: v });
  assert.equal(lastLine(W.run("/rs opt set enablenav true")), "[RynthSuite] Set option enablenav = true");
});

await check("opt get (VTank units) / list / remember / restore", () => {
  const W = world();
  assert.equal(lastLine(W.run("/rs opt get AttackDistance")), "[RynthSuite] AttackDistance = 0.1666667");
  assert.deepEqual(W.options.calls.at(-1), ["get", "AttackDistance", { vtUnits: true }]);
  assert.match(W.run("/rs opt get bogus").error, /unknown option bogus/);
  W.options.bag.set("MyMetaFlag", 7);
  assert.equal(lastLine(W.run("/rs opt get MyMetaFlag")), "[RynthSuite] MyMetaFlag = 7 (meta option)");
  const l = W.run("/rs opt list range");
  assert.ok(l.lines.some((x) => x.text === "  AttackDistance (MonsterRange) = 0.1666667"), l.lines.map((x) => x.text).join("|"));
  W.run("/mt opt remember MeleeAttackPower");
  W.run("/rs opt set MeleeAttackPower 0.9");
  assert.equal(W.options.store.MeleeAttackPower, 0.9);
  const rr = W.run("/ub opt restore MeleeAttackPower");
  assert.equal(rr.error, undefined);
  assert.equal(W.options.store.MeleeAttackPower, 0.6);
  assert.ok(W.session.ext.rsRemembered instanceof Map, "remembered values live in the page session (survive rebinds)");
  assert.match(W.run("/rs opt restore EnableMeta").error, /nothing remembered/);
});

await check("setattackbar sets both attack powers", () => {
  const W = world();
  W.run("/vt setattackbar 0.25");
  assert.equal(W.options.store.MeleeAttackPower, 0.25);
  assert.equal(W.options.store.MissileAttackPower, 0.25);
  assert.match(W.run("/vt setattackbar 2").error, /usage/);
});

// ── settings (K6) ────────────────────────────────────────────────────────────
await check("/vt settings loadchar Quest Profile passes 'Quest Profile' as one name", () => {
  const W = world();
  W.run("/vt settings loadchar Quest Profile");
  assert.deepEqual(W.options.calls.at(-1), ["selectProfile", "Quest Profile", "char"]);
  const s = W.run("/vt settings savechar Quest Profile");
  assert.deepEqual(W.options.calls.at(-1), ["saveAs", "Quest Profile", true]);
  assert.match(s.error, /no spaces/, "a name with spaces fails the Save As rule with a clear error");
});

await check("settings list / load / saveas [mine] / preset / importhud", () => {
  const W = world();
  const l = W.run("/rs settings list");
  assert.deepEqual(l.lines.map((x) => x.text).slice(1), ["  * Default", "    [By char]", "    Farm"]);
  assert.match(W.run("/rs settings preset vtank").error, /Save As first/, "refused on Default");
  W.run("/rs settings saveas Farm2 mine");
  assert.deepEqual(W.options.calls.at(-1), ["saveAs", "Farm2", true]);
  W.run("/rs settings saveas Farm3");
  assert.deepEqual(W.options.calls.at(-1), ["saveAs", "Farm3", false]);
  assert.equal(W.run("/rs settings preset vtank").error, undefined);
  assert.match(lastLine(W.run("/rs settings importhud")), /imported 2/);
  W.run("/rs settings load Farm");
  assert.deepEqual(W.options.calls.at(-1), ["selectProfile", "Farm", undefined]);
});

await check("/vt refresh succeeds (corpus CapNavPoints idiom)", () => {
  const W = world();
  const r = W.run("/vt refresh");
  assert.equal(r.error, undefined);
  assert.equal(lastLine(r), "[RynthSuite] refresh: nothing to do on web");
});

// ── unknown verbs eaten, nothing to the game ────────────────────────────────
await check("unknown verbs are eaten with a local error for all five prefixes", () => {
  const W = world();
  for (const p of ["rs", "vt", "ra", "mt", "ub"]) {
    const r = W.run(`/${p} foo bar`);
    assert.equal(r.handled, true, p);
    assert.equal(r.error, `unknown /${p} command 'foo'`, p);
    assert.equal(lastLine(r), `[RynthSuite] unknown /${p} command 'foo'`, p);
  }
  assert.deepEqual(W.parser, []);
  assert.equal(W.host.calls.filter((c) => c[0] === "host.InvokeChatParser").length, 0);
  // /ub prepclick (corpus) is not a verb either
  assert.match(W.run("/ub prepclick yes").error, /unknown \/ub command 'prepclick'/);
  // the loot-profile give exists but is not supported on web
  assert.match(W.run("/ub igp salvage to Bob").error, /not supported on web/);
});

await check("no local verb ever calls ctx.invokeChatParser", () => {
  const W = world();
  const lines = [
    "/rs help", "/rs opt list", "/rs opt get EnableNav", "/rs opt set EnableNav true", "/rs settings list", "/rs refresh",
    "/rs nav load runback", "/rs nav status", "/rs nav list", "/rs nav type linear", "/rs nav next", "/rs nav setcurrent 1",
    "/rs addnavpt", "/rs addnavcheckpoint", "/rs addnavjump 10", "/rs jump 10 true 10", "/rs reverseroute", "/rs reverseroutequery",
    "/rs follow Bob", "/rs follow off", "/rs meta load BGAugGem", "/rs meta list", "/rs meta state", "/rs setmetastate dead",
    "/rs mexec 1+2", "/rs listmonstervariables", "/rs echo hi", "/rs setattackbar 0.5", "/rs loot load VendorSnob", "/rs loot none",
    "/rs loot list", "/rs forcebuff", "/rs cancelbuff", "/ra power 50", "/ra cast 2931", "/ra use Mana Stone", "/ra clearbusy",
    "/ra panic", "/mt combatstate peace", "/mt face 90", "/mt use closestnpc", "/mt givep brood to Behdo", "/mt drop Pyreal",
    "/mt equip Wand of Frost", "/mt fellow open", "/mt send /vt echo local", "/ub usep licorice rat", "/ub mexec 1+2", "/ub delay 5 /rs echo later",
  ];
  for (const l of lines) W.run(l);
  W.advance(10);
  W.rs.pump(W.now);
  assert.deepEqual(W.parser, [], W.parser.join(" | "));
  assert.equal(W.host.calls.filter((c) => c[0] === "host.InvokeChatParser").length, 0);
});

// ── motion verbs ─────────────────────────────────────────────────────────────
await check("motion verbs (jump, nav start, follow, face) are refused while operator-held and in portal space", () => {
  const W = world({ held: true });
  for (const l of ["/rs jump 90 true 100", "/ub jumpsw", "/rs nav start", "/rs follow Bob", "/mt face 90", "/ub face 280"]) {
    const r = W.run(l);
    assert.match(r.error ?? "", /refused: the bot is paused/, l);
  }
  assert.equal(W.nav.calls.some((c) => c[0] === "requestJump" || c[0] === "setFollowTarget" || (c[0] === "setEnabled" && c[1] === true)), false);
  assert.equal(W.actions.calls.some((c) => c[0] === "face"), false);
  // stopping navigation and follow off stay allowed while held
  assert.equal(W.run("/rs nav stop").error, undefined);
  assert.equal(W.run("/rs follow off").error, undefined);
  const P = world();
  P.host.portal = true;
  assert.match(P.run("/rs jump 10 true 10").error, /portal space/);
  assert.match(P.run("/rs nav start").error, /portal space/);
  P.host.portal = false;
  assert.equal(P.run("/rs nav start").error, undefined);
  assert.deepEqual(P.nav.calls.slice(-2), [["setEnabled", true], ["resume"]], "nav start = EnableNavigation true + clear paused");
});

// ── /ub delay queue ──────────────────────────────────────────────────────────
await check("/ub delay 500 /rs echo x fires after pump(+500), not before; waits while held", () => {
  const W = world();
  const r = W.run("/ub delay 500 /rs echo x");
  assert.equal(r.error, undefined);
  assert.equal(W.rs.pendingDelayed(), 1);
  W.rs.pump(W.advance(499));
  assert.equal(W.texts().includes("x"), false);
  W.rs.pump(W.advance(1));
  assert.equal(W.texts().includes("x"), true);
  assert.equal(W.rs.pendingDelayed(), 0);
  // V-7: not pumped while the operator holds the bot
  W.run("/ub delay 0 /rs echo y");
  W.control.stopped = true;
  W.rs.pump(W.advance(1000));
  assert.equal(W.texts().includes("y"), false);
  W.control.stopped = false;
  W.rs.pump(W.advance(1));
  assert.equal(W.texts().includes("y"), true);
  // a plain line goes through the chat chain (here: the game)
  W.run("/ub delay 0 hello world");
  W.rs.pump(W.advance(1));
  assert.deepEqual(W.parser, ["hello world"]);
  assert.match(W.run("/ub delay soon /rs echo z").error, /usage/);
});

// ── compat verbs → VtActions ─────────────────────────────────────────────────
await check("compat use/select verbs call the right VtActions (incl. /ub → /mt rewrite)", () => {
  const W = world();
  W.run("/ub usep licorice rat");
  assert.deepEqual(W.actions.calls.at(-1), ["use", 0x70000004]);
  W.run("/mt useip pyreal");
  assert.deepEqual(W.actions.calls.at(-1), ["use", 0x70000002]);
  W.run("/mt use closestvendor");
  assert.deepEqual(W.actions.calls.at(-1), ["use", 0x80000103]);
  W.run("/mt use closestportal");
  assert.deepEqual(W.actions.calls.at(-1), ["use", 0x80000102]);
  W.run("/ra use Mana Stone on Bob");
  assert.deepEqual(W.actions.calls.at(-1), ["useOn", 0x70000001, 0x50000042]);
  W.run("/ra uselp network");
  assert.deepEqual(W.actions.calls.at(-1), ["use", 0x80000102]);
  W.run("/mt selectp behdo");
  assert.deepEqual(W.actions.calls.at(-1), ["select", 0x80000101]);
  assert.match(W.run("/mt use Nothing Here").error, /not found/);
});

await check("compat give/loot/drop/equip/cast/combatstate/face", () => {
  const W = world();
  W.run("/mt givep brood to Behdo");
  assert.deepEqual(W.actions.calls.at(-1), ["give", 0x70000003, 0x80000101, 1]);
  W.run("/ra give Pyreal to Bob");
  assert.deepEqual(W.actions.calls.at(-1), ["give", 0x70000002, 0x50000042, 25]);
  W.run("/mt drop Pyreal");
  assert.deepEqual(W.actions.calls.at(-1), ["drop", 0x70000002]);
  W.run("/mt equipp wand");
  assert.deepEqual(W.actions.calls.at(-1), ["equip", 0x70000005]);
  W.run("/mt dequip Wand of Frost");
  assert.deepEqual(W.actions.calls.at(-1), ["unequip", 0x70000005]);
  assert.match(W.run("/mt dequip Pyreal").error, /wielded item not found/);
  W.run("/mt combatstate peace");
  assert.deepEqual(W.actions.calls.at(-1), ["setCombatState", "peace"]);
  W.run("/ub face 280");
  assert.deepEqual(W.actions.calls.at(-1), ["face", "280"]);
  W.run("/mt cast 2931");
  assert.deepEqual(W.actions.calls.at(-1), ["castById", 2931, null]);
  W.run("/mt cast Recall Aphus Lassel");
  assert.deepEqual(W.actions.calls.at(-1), ["castById", 2931, null], "by known spell name");
  W.run("/mt castp primary portal on Bob");
  assert.deepEqual(W.actions.calls.at(-1), ["castById", 48, 0x50000042]);
  W.run("/ra cast 48");
  assert.deepEqual(W.actions.calls.at(-1), ["castById", 48, null]);
  assert.match(W.run("/mt cast Unknown Spell").error, /spell not found/);
});

await check("/mt loot waits for the container (pump), /ra givea queues paced gives", () => {
  const W = world();
  const r = W.run("/mt loot Brood Jaw");
  assert.equal(r.error, undefined);
  assert.match(lastLine(r), /waiting/);
  W.actions.lootReady = true;
  W.rs.pump(W.advance(100));
  assert.ok(W.texts().some((t) => /looting Brood Jaw/.test(t)));
  const before = W.actions.calls.filter((c) => c[0] === "give").length;
  W.run("/ra giveap a to Bob"); // matches Mana Stone, Pyreal, Brood Matron Jaw, Licorice Rat, Wand
  W.rs.pump(W.advance(200));
  W.rs.pump(W.advance(50)); // < 150 ms gap → nothing
  W.rs.pump(W.advance(150));
  assert.equal(W.actions.calls.filter((c) => c[0] === "give").length - before, 2);
});

await check("/ra power, clearbusy, panic, myquests; /mt logoff", () => {
  const W = world();
  W.run("/ra power 75");
  assert.equal(W.options.store.MeleeAttackPower, 0.75);
  assert.equal(W.options.store.MissileAttackPower, 0.75);
  assert.match(W.run("/ra power auto").error, /not supported/);
  W.run("/ra clearbusy");
  assert.ok(W.host.calls.some((c) => c[0] === "ForceResetBusyCount"));
  W.run("/ra panic");
  assert.ok(W.host.calls.some((c) => c[0] === "ChangeCombatMode" && c[1] === 1));
  W.run("/ub myquests");
  assert.deepEqual(W.quests.calls, ["refresh"]);
  W.run("/mt logoff");
  assert.ok(W.host.calls.some((c) => c[0] === "LogOffCharacter"));
  // no tracker (bot not running): /myquests still reaches ACE through the chat parser
  const N = world({ withBot: false });
  N.run("/ra myquests");
  assert.deepEqual(N.parser, ["/myquests"]);
});

await check("/mt fellow uses the host Fellowship* members and never emits a /fellowship line (critic B3)", () => {
  const W = world();
  for (const l of ["/mt fellow create Hunters", "/mt fellow open", "/mt fellow close", "/mt fellow disband", "/mt fellow quit", "/mt fellow recruit Bob"]) {
    const r = W.run(l);
    assert.equal(r.error, undefined, l);
  }
  const got = W.host.calls.filter((c) => c[0].startsWith("Fellowship"));
  assert.deepEqual(got, [
    ["FellowshipCreate", "Hunters", true],
    ["FellowshipSetOpen", true],
    ["FellowshipSetOpen", false],
    ["FellowshipQuit", true],
    ["FellowshipQuit", false],
    ["FellowshipRecruit", 0x50000042],
  ]);
  const everything = [...W.parser, ...W.texts(), ...W.host.calls.map((c) => c.join(" "))].join("\n");
  assert.doesNotMatch(everything, /\/fellowship/i);
  assert.match(W.run("/mt fellow recruit Nobody").error, /not in sight/);
});

await check("/mt send: /rs-family lines stay local, other text goes to the game", () => {
  const W = world();
  W.run("/mt send /vt echo local");
  assert.ok(W.texts().includes("local"));
  assert.deepEqual(W.parser, []);
  W.run("/mt send /t Bob, hi");
  assert.deepEqual(W.parser, ["/t Bob, hi"]);
});

// ── meta / loot / mexec through the layer ─────────────────────────────────────
await check("meta load / loot load|none|list go through vt().library; meta state verbs hit the engine", () => {
  const W = world();
  W.run("/vt meta load BGAugGem");
  assert.deepEqual(W.library.calls.at(-1), ["loadMeta", "BGAugGem"]);
  assert.match(W.run("/vt meta load missing").error, /no meta named/);
  assert.match(lastLine(W.run("/rs meta list")), /BGAugGem, ColRings/);
  W.run("/rs loot load VendorSnob");
  assert.deepEqual(W.library.calls.at(-1), ["loadLoot", "VendorSnob"]);
  const b = W.run("/vt loot load Basic.utl"); // corpus form: the file name with its extension
  assert.equal(b.error, undefined);
  assert.deepEqual(W.library.calls.slice(-2), [["loadLoot", "Basic.utl"], ["loadLoot", "Basic"]]);
  assert.equal(lastLine(b), '[RynthSuite] loot profile "Basic" loaded');
  W.run("/rs loot none");
  assert.deepEqual(W.library.calls.at(-1), ["clearLoot"]);
  assert.match(lastLine(W.run("/vt loot list")), /VendorSnob/);
  W.run("/vt setmetastate dead");
  assert.deepEqual(W.meta.calls.at(-1), ["enterState", "dead", "command"]);
  assert.equal(lastLine(W.run("/rs meta state")), "[RynthSuite] meta state: dead (meta disabled)");
  W.run("/rs meta enable");
  assert.equal(W.meta.enabled, true);
  W.run("/rs meta debug off");
  assert.deepEqual(W.meta.calls.at(-1), ["setDebug", false]);
});

await check("mexec prints [<type>] <value> and [Error] for an evaluation error", () => {
  const W = world();
  assert.equal(lastLine(W.run("/rs mexec 1+2")), "[Number] 3");
  assert.equal(lastLine(W.run("/vt mexec hello world")), "[String] hello world");
  assert.equal(lastLine(W.run("/ub mexec bad[1]")), '[Error] Call to unknown function "bad"');
  assert.equal(lastLine(W.run("/vt mexec wobjectgetplayer[]")), "[WorldObject] 0x50000001: Me");
});

// ── no bot / HUD / run control ───────────────────────────────────────────────
await check("without a bot: opt and settings act on the session; nav/meta answer 'start the bot first'", () => {
  const W = world({ withBot: false });
  assert.equal(W.run("/rs opt set EnableNav true").error, undefined);
  assert.equal(W.options.store.EnableNavigation, true);
  assert.equal(W.run("/rs settings list").error, undefined);
  for (const l of ["/rs nav load runback", "/rs addnavpt", "/rs jump 1 true 1", "/rs meta load x", "/rs setmetastate x", "/rs mexec 1", "/rs loot list", "/rs reverseroutequery"]) {
    assert.match(W.run(l).error ?? "", /start the bot first/, l);
  }
});

await check("start / stop / toggle: HUD bridge (pending) else bot.control; neither → hint", async () => {
  const hudCalls = [];
  const hud = {
    start: async () => (hudCalls.push("start"), { ok: true }),
    stop: async () => (hudCalls.push("stop"), { ok: true }),
    toggleRun: async () => (hudCalls.push("toggle"), { ok: false, error: "not in the world yet" }),
  };
  const W = world({ hud });
  const r = W.run("/rs start");
  assert.ok(r.pending instanceof Promise);
  await r.pending;
  assert.deepEqual(hudCalls, ["start"]);
  assert.ok(W.texts().includes("[RynthSuite] macro running"));
  await W.run("/vt stop").pending;
  await W.run("/rs toggle").pending;
  assert.deepEqual(hudCalls, ["start", "stop", "toggle"]);
  assert.ok(W.texts().some((t) => /toggle: not in the world yet/.test(t)));
  const B = world();
  B.run("/rs stop");
  assert.equal(B.control.stopped, true);
  B.run("/rs start");
  assert.equal(B.control.stopped, false);
  assert.deepEqual(B.control.calls.map((c) => (Array.isArray(c) ? c[0] : c)), ["stop", "resume"]);
  const N = world({ withBot: false });
  assert.match(N.run("/rs start").error, /open the RynthSuite HUD or use \?bot=1/);
});

await check("forcebuff / cancelforcebuff / cancelbuff → bot.buff", () => {
  const W = world();
  W.run("/rs forcebuff");
  W.run("/vt cancelbuff");
  W.run("/ra cancelforcebuff");
  assert.deepEqual(W.buff.calls, ["force", "cancel", "cancel"]);
});

await check("nav subverbs: start/stop/status/type/setcurrent/next/prev/delete/clear/list", () => {
  const W = world();
  W.run("/rs nav load fighting");
  W.run("/rs nav type once");
  assert.deepEqual(W.nav.calls.at(-1), ["setType", 4]);
  W.run("/rs nav setcurrent 2");
  assert.deepEqual(W.nav.calls.at(-1), ["setActive", 1], "1-based for the user");
  W.run("/rs nav prev");
  assert.deepEqual(W.nav.calls.at(-1), ["step", -1]);
  W.run("/rs nav delete 1");
  assert.deepEqual(W.nav.calls.at(-1), ["removeAt", 0]);
  assert.match(W.run("/rs nav delete 9").error, /usage/);
  assert.match(lastLine(W.run("/rs nav status")), /"fighting", Once, 1\/1, disabled/);
  assert.match(lastLine(W.run("/rs nav list")), /fighting, runback/);
  W.run("/rs nav stop");
  assert.deepEqual(W.nav.calls.at(-1), ["setEnabled", false]);
  W.run("/rs nav clear");
  assert.deepEqual(W.nav.calls.at(-1), ["clear"]);
});

await check("follow <name>|leader|off sets the Follow target and enables navigation", () => {
  const W = world();
  W.run("/rs follow Bob");
  assert.deepEqual(W.nav.calls.find((c) => c[0] === "setFollowTarget"), ["setFollowTarget", { guid: 0x50000042, name: "Bob" }]);
  assert.ok(W.nav.calls.some((c) => c[0] === "setEnabled" && c[1] === true));
  W.run("/ra follow leader");
  assert.deepEqual(W.nav.calls.filter((c) => c[0] === "setFollowTarget").at(-1), ["setFollowTarget", { guid: 0x50000009, name: "Leader Larry" }]);
  W.run("/ub follow off");
  assert.deepEqual(W.nav.calls.at(-1), ["setFollowTarget", null]);
  assert.match(W.run("/rs follow Ghost").error, /not in sight/);
});

await check("ui [tab] opens the panel (pending); tell source returns lines without printing", async () => {
  const W = world();
  const r = W.run("/rs ui monsters");
  await r.pending;
  assert.equal(W.openedTab, "monsters");
  const n = W.printed.length;
  const t = W.run("/rs opt get AttackDistance", "tell");
  assert.equal(W.printed.length, n, "tell: the caller replies, nothing printed");
  assert.equal(t.lines[0].text, "[RynthSuite] AttackDistance = 0.1666667");
  const c = W.run("/rs echo printed", "console");
  assert.equal(W.printed.at(-1).text, "printed");
  assert.equal(c.lines[0].category, 0);
});

await check("help lists every guide verb; /ra /mt /ub help list their tables", () => {
  const W = world();
  const text = W.run("/rs help").lines.map((l) => l.text).join("\n");
  for (const v of ["nav save", "addnavpt", "addnavcheckpoint", "jump", "addnavjump", "reverseroute", "reverseroutequery", "listmonstervariables", "opt list", "settings", "mexec", "start", "forcebuff"]) {
    assert.ok(text.includes(v), v);
  }
  assert.equal(W.run("/rs").lines[0].text, W.run("/rs help").lines[0].text, "bare /rs = help");
  assert.match(W.run("/mt help").lines.map((l) => l.text).join("\n"), /fellow create/);
  assert.match(W.run("/ub").lines.map((l) => l.text).join("\n"), /delay <ms> <command>/);
  assert.ok(W.rs.help().length > 20);
  assert.ok(COMPAT.ub.has("usep") && COMPAT.ub.has("jumpsw") && !COMPAT.ub.has("prepclick"));
});

await check("runChat chain: /rs-family local, /ls and /ah shims, everything else → the game", () => {
  const W = world();
  W.rs.runChat("/vt echo via chain");
  assert.ok(W.texts().includes("via chain"));
  W.rs.runChat("/ls");
  W.rs.runChat("/lifestone");
  W.rs.runChat("/ah");
  assert.equal(W.host.calls.filter((c) => c[0] === "RecallToLifestone").length, 2);
  assert.equal(W.host.calls.filter((c) => c[0] === "RecallAllegianceHometown").length, 1);
  W.rs.runChat("/hr");
  W.rs.runChat("  plain words  ");
  assert.deepEqual(W.parser, ["/hr", "plain words"]);
});

await check("never throws: a throwing getCtx, a non-RS line, a throwing service", () => {
  const rs = createRsDispatcher({ getCtx: () => { throw new Error("boom"); } });
  const r = rs.run("/rs nav load x");
  assert.equal(r.handled, true);
  assert.match(r.error, /start the bot first/);
  assert.deepEqual(rs.run("/say hi"), { handled: false, lines: [] });
  rs.pump(1);
  const W = world();
  W.nav.loadByName = () => { throw new Error("kaput"); };
  const k = W.run("/rs nav load runback");
  assert.match(k.error, /kaput/);
});

await check("parseCoords table", () => {
  const ok = (s, ns, ew, z) => {
    const p = parseCoords(s.split(" "));
    assert.equal(p.ok, true, `${s}: ${p.error}`);
    assert.equal(p.ns, ns, s);
    assert.equal(p.ew, ew, s);
    assert.equal(p.z, z, s);
  };
  ok("12.3N 41.5E", 12.3, 41.5, undefined);
  ok("41.5E 12.3N", 12.3, 41.5, undefined);
  ok("12.3S, 41.5W", -12.3, -41.5, undefined);
  ok("12.3s,41.5w", -12.3, -41.5, undefined);
  ok("-12.3 41.5", -12.3, 41.5, undefined);
  ok("12.3 N 41.5 W", 12.3, -41.5, undefined);
  ok("12.3n,41.5e 0.5", 12.3, 41.5, 0.5);
  ok("102S 102W", -102, -102, undefined);
  ok("41.53N, 34.46E, 0.20Z", 41.53, 34.46, 0.2); // `/vt addnavpt `+$tempCoords (expression coordinates string)
  ok("41.53|-34.46|0.2", 41.53, -34.46, 0.2); // RynthAi internal form
  ok("41.53|-34.46", 41.53, -34.46, undefined);
  ok("0.5Z 1S 2E", -1, 2, 0.5);
  for (const bad of ["", "12.3N", "12N 13S", "1E 2W", "102.1N 0E", "-1N 2E", "abc 1", "1 2 3 4", "N 1E", "1N 2E 3Z 4", "1N 2E 3Z 4Z", "200|1"]) {
    assert.equal(parseCoords(bad.split(" ")).ok, false, bad);
  }
});

console.log(fail === 0 ? `rynth_vt_rs_commands: all ${pass} checks passed` : `rynth_vt_rs_commands: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
