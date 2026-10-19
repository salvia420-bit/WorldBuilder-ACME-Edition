// tests/rynth_vt_nav_model.test.mjs — W1-6 NAV: the pure route model and the
// nav-profile interop (rynth/vt/nav/route_model.js, nav_profiles.js).
//
// Covers PLAN §2.8 R1-R4, R12-R13, R21 and the `.nav`/`.af` file rules:
// advance tables per route type, nearest-Point start index, reversal,
// insert/delete index rules, sentinel-aware distances, the Follow `.nav`
// form, the `.af` vnd/tlk/flw re-typing, byte-stable `.nav` round trips and
// the NavProfiles store wrapper (overwrite, empty routes), the Follow leader
// trail (follow_trail.js) and executors.walkTargetWorld.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_nav_model.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const FIX = path.join(APP, "rynth/testdata/vt/nav");

const RM = await import("../rynth/vt/nav/route_model.js");
const NP = await import("../rynth/vt/nav/nav_profiles.js");
const nav = await import("../rynth/vt/nav/index.js");
const { degToWorld } = await import("../rynth/nav_file.js");

const { ROUTE, POINT, makeRoute, advance, startIndex, isEmpty, insert, removeAt, setActive, step, reverse, minDistM, pointWorld, skipDense } = RM;
const { parseNavVt, retypeAfPoint, parseAfNavsVt, writeNavVt, NavProfiles } = NP;

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

const pt = (ew, ns, extra = {}) => ({ type: POINT.Point, ew, ns, z: 0.4, ...extra });
const route3 = (routeType) => makeRoute({ routeType, points: [pt(33.6, 42.0), pt(33.7, 42.0), pt(33.8, 42.0)] });
const walk = (r, k) => {
  const seq = [r.activeIndex];
  for (let i = 0; i < k; i++) {
    r = advance(r);
    seq.push(r.finished ? "F" : r.activeIndex);
  }
  return { seq, r };
};
const world = (ew, ns) => degToWorld(ew, ns);

function fakeStore() {
  const m = new Map();
  return {
    m,
    list: () => [...m.values()].map((r) => ({ name: r.name, savedAt: r.savedAt, bytes: JSON.stringify(r).length })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())),
    get: (n) => (m.has(String(n).toLowerCase()) ? JSON.parse(JSON.stringify(m.get(String(n).toLowerCase()).value)) : null),
    put: (n, v) => {
      m.set(String(n).toLowerCase(), { name: n, savedAt: 1, value: JSON.parse(JSON.stringify(v)) });
      return { ok: true };
    },
    remove: (n) => {
      m.delete(String(n).toLowerCase());
      return { ok: true };
    },
  };
}

console.log("rynth_vt_nav_model");

// ── advance tables ─────────────────────────────────────────────────────────
await check("Circular wraps A B C A B C (R1)", () => {
  assert.deepEqual(walk(route3(ROUTE.Circular), 6).seq, [0, 1, 2, 0, 1, 2, 0]);
});
await check("Linear bounces A B C B A B, no endpoint revisit (R2, Q7)", () => {
  const { seq, r } = walk(route3(ROUTE.Linear), 6);
  assert.deepEqual(seq, [0, 1, 2, 1, 0, 1, 2]);
  assert.equal(r.linearDir, 1);
});
await check("Linear direction flips at the far end", () => {
  let r = route3(ROUTE.Linear);
  r = advance(advance(r));
  assert.equal(r.activeIndex, 2);
  r = advance(r);
  assert.equal(r.linearDir, -1);
  assert.equal(r.activeIndex, 1);
});
await check("single-point Linear finishes (fixes U7b H16) and reads empty", () => {
  let r = makeRoute({ routeType: ROUTE.Linear, points: [pt(33.6, 42.0)] });
  assert.equal(isEmpty(r), false);
  r = advance(r);
  assert.equal(r.finished, true);
  assert.equal(isEmpty(r), true);
  assert.equal(r.points.length, 1, "points kept on screen");
});
await check("Once ends finished with its points cleared (R4)", () => {
  const { seq, r } = walk(route3(ROUTE.Once), 3);
  assert.deepEqual(seq, [0, 1, 2, "F"]);
  assert.deepEqual(r.points, []);
  assert.equal(isEmpty(r), true);
});
await check("Follow: index stays 0; empty iff no follow target", () => {
  let r = makeRoute({ routeType: ROUTE.Follow, points: [] });
  assert.equal(isEmpty(r), true);
  r = makeRoute({ routeType: ROUTE.Follow, followTarget: { guid: 0x50000001, name: "Bob" } });
  assert.equal(isEmpty(r), false);
  assert.equal(advance(r).activeIndex, 0);
});
await check("advance on an empty route is a no-op", () => {
  const r = makeRoute({ routeType: ROUTE.Circular });
  assert.equal(advance(r).activeIndex, 0);
  assert.equal(isEmpty(r), true);
});

// ── start index ────────────────────────────────────────────────────────────
await check("start index = nearest Point for Circular/Linear; 0 for Once/Follow", () => {
  const pts = [
    { type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: "/vt echo x" },
    pt(33.6, 42.0),
    pt(33.9, 42.0),
    { type: POINT.Pause, ew: 33.91, ns: 42.0, z: 0, pauseMs: 100 },
  ];
  const pose = world(33.905, 42.0);
  assert.equal(startIndex(makeRoute({ routeType: ROUTE.Circular, points: pts }), pose), 2, "Point B, not the nearer Pause");
  assert.equal(startIndex(makeRoute({ routeType: ROUTE.Linear, points: pts }), pose), 2);
  assert.equal(startIndex(makeRoute({ routeType: ROUTE.Once, points: pts }), pose), 0);
  assert.equal(startIndex(makeRoute({ routeType: ROUTE.Circular, points: pts }), null), 0, "no pose");
  assert.equal(startIndex(makeRoute({ routeType: ROUTE.Circular, points: [pts[0]] }), pose), 0, "no Point at all");
});

// ── reverse ────────────────────────────────────────────────────────────────
await check("reverse(true): points reversed, index mirrored, linearDir kept so the walk turns around (R21, C#)", () => {
  let r = makeRoute({ routeType: ROUTE.Linear, points: [pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 4)] });
  r = setActive(r, 1);
  const a = r.points[1];
  const rr = reverse(r, true);
  assert.equal(rr.reversed, true);
  assert.equal(rr.activeIndex, 2);
  assert.equal(rr.points[2], a, "same waypoint object stays active");
  assert.deepEqual(rr.points.map((p) => p.ew), [4, 3, 2, 1]);
  assert.equal(rr.linearDir, r.linearDir, "linearDir untouched (CS/Meta/MetaManager.cs:1012-1023)");
  // Before: at waypoint 2 heading for 3. After the reversal the next waypoint is 1: the walk turned around.
  assert.equal(advance(r).points[advance(r).activeIndex].ew, 3);
  assert.equal(advance(rr).points[advance(rr).activeIndex].ew, 1, "Linear walk turns around");
  const c = setActive(makeRoute({ routeType: ROUTE.Circular, points: [pt(1, 1), pt(2, 2), pt(3, 3), pt(4, 4)] }), 1);
  const cr = reverse(c, true);
  assert.equal(advance(cr).points[advance(cr).activeIndex].ew, 1, "Circular walk turns around");
});
await check("reverse true/false are idempotent; no argument toggles", () => {
  const r = route3(ROUTE.Circular);
  const t1 = reverse(r, true);
  assert.equal(reverse(t1, true), t1, "true twice = one reversal");
  const f1 = reverse(t1, false);
  assert.equal(f1.reversed, false);
  assert.deepEqual(f1.points.map((p) => p.ew), r.points.map((p) => p.ew));
  assert.equal(reverse(r, false), r, "false on an unreversed route is a no-op");
  assert.equal(reverse(r).reversed, true);
  assert.equal(reverse(reverse(r)).reversed, false);
});

// ── insert / delete / set active ───────────────────────────────────────────
await check("insert End / Above / Below relative to the selected row (R12)", () => {
  const r = route3(ROUTE.Circular);
  const x = pt(9, 9);
  assert.equal(insert(r, x, "end", 1).index, 3);
  assert.equal(insert(r, x, "above", 1).index, 1);
  assert.equal(insert(r, x, "below", 1).index, 2);
  assert.equal(insert(r, x, "above", null).index, 3, "no selection = End");
  assert.equal(insert(r, x, "below", 99).index, 3, "bad selection = End");
  const ins = insert(r, x, "above", 1);
  assert.equal(ins.route.points[1], x);
  assert.equal(ins.route.dirty, true);
});
await check("inserting above the active waypoint keeps the same waypoint active", () => {
  let r = setActive(route3(ROUTE.Circular), 1);
  const active = r.points[1];
  r = insert(r, pt(9, 9), "above", 0).route;
  assert.equal(r.activeIndex, 2);
  assert.equal(r.points[r.activeIndex], active);
  r = insert(r, pt(8, 8), "end", null).route;
  assert.equal(r.activeIndex, 2, "inserting after it changes nothing");
});
await check("insert into a finished Once route revives it", () => {
  let r = walk(route3(ROUTE.Once), 3).r;
  r = insert(r, pt(1, 1), "end", null).route;
  assert.equal(r.finished, false);
  assert.equal(isEmpty(r), false);
  assert.equal(r.activeIndex, 0);
});
await check("delete the active row keeps min(i, n-1) (U7b H17)", () => {
  let r = setActive(route3(ROUTE.Circular), 1);
  assert.equal(removeAt(r, 1).activeIndex, 1);
  r = setActive(route3(ROUTE.Circular), 2);
  assert.equal(removeAt(r, 2).activeIndex, 1, "last row deleted → new last row");
  r = setActive(route3(ROUTE.Circular), 2);
  assert.equal(removeAt(r, 0).activeIndex, 1, "a row above shifts the index");
  r = setActive(route3(ROUTE.Circular), 0);
  assert.equal(removeAt(r, 2).activeIndex, 0, "a row below changes nothing");
  assert.equal(removeAt(r, 7), r, "out of range is a no-op");
  const one = makeRoute({ points: [pt(1, 1)] });
  assert.equal(removeAt(one, 0).activeIndex, 0);
  assert.equal(removeAt(one, 0).points.length, 0);
});
await check("setActive clamps; step wraps for Circular and clamps otherwise (R13)", () => {
  assert.equal(setActive(route3(ROUTE.Circular), 9).activeIndex, 2);
  assert.equal(setActive(route3(ROUTE.Circular), -3).activeIndex, 0);
  assert.equal(step(route3(ROUTE.Circular), -1).activeIndex, 2);
  assert.equal(step(setActive(route3(ROUTE.Circular), 2), 1).activeIndex, 0);
  assert.equal(step(route3(ROUTE.Linear), -1).activeIndex, 0);
  assert.equal(step(setActive(route3(ROUTE.Once), 2), 5).activeIndex, 2);
});

// ── distances ──────────────────────────────────────────────────────────────
await check("minDistM ignores sentinel points; Infinity without coordinates (Q8 metres)", () => {
  const r = makeRoute({
    points: [{ type: POINT.Chat, ew: 0, ns: 0, z: -1000 / 240, chat: "x" }, pt(0.5, 0), { type: POINT.Pause, ew: 0, ns: 0, z: 0, pauseMs: 1 }],
  });
  const pose = world(0.001, 0);
  const d = minDistM(r, pose);
  assert.ok(Math.abs(d - (0.5 - 0.001) * 240) < 1e-6, `got ${d}`);
  assert.equal(minDistM(makeRoute({ points: [{ type: POINT.Chat, ew: 0, ns: 0, z: 0, chat: "x" }] }), pose), Infinity);
  assert.equal(minDistM(r, null), Infinity);
});
await check("pointWorld: degrees ×240 metres; null for the 0,0 sentinel", () => {
  assert.equal(pointWorld({ type: 3, ew: 0, ns: 0, z: -1000 }), null);
  const w = pointWorld(pt(33.6, 42.0));
  const e = world(33.6, 42.0);
  assert.equal(w.wx, e.wx);
  assert.equal(w.wy, e.wy);
  assert.ok(Math.abs(w.z - 0.4 * 240) < 1e-9);
});
await check("skipDense skips Points inside the arrival radius, never an action point", () => {
  const r = makeRoute({ routeType: ROUTE.Circular, points: [pt(33.6, 42.0), pt(33.6001, 42.0), { type: POINT.Chat, ew: 33.6, ns: 42.0, z: 0, chat: "x" }, pt(33.6, 42.0)] });
  const out = skipDense(setActive(r, 1), world(33.6, 42.0), 3);
  assert.equal(out.route.activeIndex, 2, "stops on the Chat point");
  assert.equal(out.skipped, 1);
  const all = makeRoute({ routeType: ROUTE.Circular, points: [pt(33.6, 42.0), pt(33.6, 42.0)] });
  assert.equal(skipDense(all, world(33.6, 42.0), 3).skipped, 2, "bounded by the route length");
});

// ── .nav files ─────────────────────────────────────────────────────────────
await check("parseNavVt reads a Follow .nav (no count line; U7b H8)", () => {
  const r = parseNavVt(fs.readFileSync(path.join(FIX, "follow.nav"), "utf8"));
  assert.equal(r.ok, true, r.error);
  assert.equal(r.route.routeType, ROUTE.Follow);
  assert.deepEqual(r.route.followTarget, { guid: 1342177281, name: "Leader Bob" });
  assert.deepEqual(r.route.points, []);
});
await check("parseNavVt reads every waypoint type 0-9 with its trailer", () => {
  const r = parseNavVt(fs.readFileSync(path.join(FIX, "typed_points.nav"), "utf8"));
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.route.routeType, ROUTE.Linear);
  const p = r.route.points;
  assert.deepEqual(p.map((x) => x.type), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(p[1].guid, -2147483000 >>> 0);
  assert.equal(p[2].spellId, 1635);
  assert.equal(p[3].pauseMs, 1500);
  assert.equal(p[4].chat, "/vt opt set enablebuffing true");
  assert.equal(p[5].vendorId, 0x90000001);
  assert.equal(p[5].name, "Thomas the Merchant");
  assert.equal(p[6].name, "Portal to Holtburg");
  assert.equal(p[6].objectClass, 14);
  assert.equal(p[7].isTie, true);
  assert.equal(p[7].exitEW, 33.655);
  assert.equal(p[9].headingDeg, 270.5);
  assert.equal(p[9].holdShift, true);
  assert.equal(p[9].delayMs, 750.00003);
});
await check("parseNavVt rejects non-nav text and surfaces the stop-early warning", () => {
  assert.equal(parseNavVt("hello\r\n").ok, false);
  assert.equal(parseNavVt("").ok, false);
  const bad = "uTank2 NAV 1.2\r\n1\r\n2\r\n0\r\n1\r\n2\r\n3\r\n0\r\n42\r\n1\r\n2\r\n3\r\n0\r\n";
  const r = parseNavVt(bad);
  assert.equal(r.ok, true);
  assert.equal(r.route.points.length, 1);
  assert.match(r.warnings.join(" "), /unknown waypoint type 42/);
});
await check(".nav round trip is byte-stable for raw points (corpus + typed + follow + HoltburgTest)", () => {
  const files = [
    path.join(FIX, "VRTreeJump500Rat.nav"),
    path.join(FIX, "typed_points.nav"),
    path.join(FIX, "follow.nav"),
    path.join(APP, "rynth/testdata/HoltburgTest.nav"),
  ];
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const r = parseNavVt(text);
    assert.equal(r.ok, true, `${f}: ${r.error}`);
    const out = writeNavVt(r.route, { file: r.file });
    assert.deepEqual(out.warnings, [], f);
    assert.equal(out.text, text, `byte-stable: ${path.basename(f)}`);
  }
});
await check("the corpus route (VRTreeJump500Rat) parses as Once with jumps, pauses and sentinel chats", () => {
  const r = parseNavVt(fs.readFileSync(path.join(FIX, "VRTreeJump500Rat.nav"), "utf8"));
  assert.equal(r.route.routeType, ROUTE.Once);
  assert.equal(r.route.points.length, 101);
  const types = new Set(r.route.points.map((p) => p.type));
  for (const t of [0, 3, 4, 9]) assert.ok(types.has(t), `type ${t}`);
  assert.equal(r.route.points[0].chat, "/vt opt set navclosestoprange 0.000416666666666667");
  assert.equal(pointWorld(r.route.points[0]), null, "the 0,0,0 chat is a sentinel");
});
await check("writeNavVt drops ext.direction with a warning and writes signed guids for fresh points (H18, Q3)", () => {
  const route = {
    routeType: ROUTE.Circular,
    points: [
      { type: POINT.PortalLegacy, ew: 1, ns: 2, z: 0, guid: 0x90000001 },
      { type: POINT.OpenVendor, ew: 1, ns: 2, z: 0, vendorId: 0x80000002, name: "Vendor" },
      { type: POINT.Jump, ew: 1, ns: 2, z: 0, headingDeg: 90, holdShift: false, delayMs: 300, ext: { direction: "strafeleft" } },
    ],
  };
  const out = writeNavVt(route);
  const lines = out.text.split("\r\n");
  assert.equal(lines[0], "uTank2 NAV 1.2");
  assert.equal(lines[1], "1");
  assert.equal(lines[2], "3");
  assert.ok(lines.includes("-1879048191"), "portal guid signed");
  assert.ok(lines.includes("-2147483646"), "vendor guid signed");
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /direction=strafeleft/);
  const back = parseNavVt(out.text);
  assert.equal(back.route.points[0].guid, 0x90000001, "re-reads unsigned");
  assert.equal(back.route.points[2].ext, undefined, "no file encoding");
  assert.ok(out.text.endsWith("\r\n"));
});
await check("writeNavVt Follow form", () => {
  const out = writeNavVt({ routeType: ROUTE.Follow, points: [], followTarget: { guid: 0x90000001, name: "Bob" } });
  assert.equal(out.text, "uTank2 NAV 1.2\r\n3\r\nBob\r\n-1879048191\r\n");
  assert.deepEqual(parseNavVt(out.text).route.followTarget, { guid: 0x90000001, name: "Bob" });
});

// ── .af ────────────────────────────────────────────────────────────────────
await check("retypeAfPoint: vnd → 5, tlk → 7, a real ptl untouched", () => {
  const vnd = { type: 6, ew: 1, ns: 2, z: 0, name: "V", objectClass: 12, isTie: false, exitEW: 0, exitNS: 0, exitZ: 0 };
  const tlk = { ...vnd, name: "N", objectClass: 37 };
  const v = retypeAfPoint(vnd);
  assert.equal(v.type, POINT.OpenVendor);
  assert.equal(v.objectClass, undefined);
  assert.equal(v.name, "V");
  assert.equal(retypeAfPoint(tlk).type, POINT.NpcTalk);
  assert.equal(retypeAfPoint({ ...vnd, objectClass: 14 }).type, 6);
  const realNpc = { ...tlk, exitEW: 3, exitNS: 4, exitZ: 0.1 };
  assert.equal(retypeAfPoint(realNpc), realNpc, "a ptl to an NPC keeps type 6");
  const p0 = { type: 0, ew: 1, ns: 1, z: 0 };
  assert.equal(retypeAfPoint(p0), p0);
});
await check("parseAfNavsVt fixes vnd/tlk (guid, name, object position) and reads flw (U7b H9)", () => {
  const navs = parseAfNavsVt(fs.readFileSync(path.join(FIX, "shop_and_follow.af"), "utf8"));
  assert.deepEqual(Object.keys(navs).sort(), ["buddy", "shop"]);
  const shop = navs.shop;
  assert.equal(shop.routeType, ROUTE.Linear);
  assert.deepEqual(shop.points.map((p) => p.type), [0, 5, 7, 6, 2, 3, 4, 8, 9]);
  assert.equal(shop.points[1].vendorId, 0x8fff0001);
  assert.equal(shop.points[1].name, "Thomas the Merchant");
  assert.equal(shop.points[2].name, "Town Crier");
  assert.equal(shop.points[2].objectClass, 37);
  assert.equal(shop.points[2].exitEW, 33.655);
  assert.equal(shop.points[3].name, "Portal to Holtburg");
  assert.equal(shop.points[4].spellId, 1635);
  assert.equal(shop.points[5].pauseMs, 1500);
  assert.equal(shop.points[8].holdShift, true);
  assert.equal(navs.buddy.routeType, ROUTE.Follow);
  assert.deepEqual(navs.buddy.followTarget, { guid: 0x50000001, name: "Leader Bob" });
});
await check("parseAfNavsVt reads the metaf prt guid as HEX (NPortal X8; nav_file parses it as decimal)", () => {
  const af = "NAV: gate linear ~~ {\r\n\tpnt 1 2 0\r\n\tprt 1.5 2.5 0 7B000001\r\n\tprt 3 4 0 00000010\r\n~~ }\r\n";
  const navs = parseAfNavsVt(af);
  assert.deepEqual(navs.gate.points.map((p) => p.type), [0, 1, 1]);
  assert.equal(navs.gate.points[1].guid, 0x7b000001);
  assert.equal(navs.gate.points[2].guid, 0x10);
  const back = parseNavVt(writeNavVt(navs.gate).text);
  assert.equal(back.route.points[1].guid, 0x7b000001, "round-trips through .nav (signed Int32 on disk)");
});
await check("parseAfNavsVt reads a Follow NAVDATA block", () => {
  const af = "NAVDATA: lead 4 ~~ {\r\nuTank2 NAV 1.2\r\n3\r\nAlice\r\n1342177282\r\n~~ }\r\n";
  const navs = parseAfNavsVt(af);
  assert.equal(navs.lead.routeType, ROUTE.Follow);
  assert.deepEqual(navs.lead.followTarget, { guid: 1342177282, name: "Alice" });
});

// ── NavProfiles ────────────────────────────────────────────────────────────
await check("NavProfiles: overwrite by case-insensitive name; empty route allowed (R14)", () => {
  const store = fakeStore();
  const np = new NavProfiles({ store, now: () => 5 });
  assert.equal(np.put("Hunt", route3(ROUTE.Circular)).ok, true);
  assert.equal(np.put("hunt", makeRoute({ routeType: ROUTE.Once })).ok, true);
  assert.equal(store.m.size, 1);
  const p = np.get("HUNT");
  assert.equal(p.v, 1);
  assert.equal(p.routeType, ROUTE.Once);
  assert.deepEqual(p.points, []);
  assert.equal(p.savedAt, 5);
  assert.equal(np.list().length, 1);
  assert.equal(np.remove("Hunt").ok, true);
  assert.equal(np.get("Hunt"), null);
});
await check("NavProfiles: invalid names refused; missing profile → error", () => {
  const np = new NavProfiles({ store: fakeStore() });
  assert.equal(np.put("", route3(1)).ok, false);
  assert.equal(np.put("a/b", route3(1)).ok, false);
  assert.equal(np.put("x".repeat(81), route3(1)).ok, false);
  const ex = np.exportText("nope");
  assert.equal(ex.ok, false);
  assert.match(ex.error, /no nav profile/);
  assert.equal(new NavProfiles({ store: null }).put("a", route3(1)).ok, false);
});
await check("NavProfiles importText(.nav) → exportText is byte-stable for a CRLF corpus file", () => {
  const np = new NavProfiles({ store: fakeStore() });
  const text = fs.readFileSync(path.join(FIX, "VRTreeJump500Rat.nav"), "utf8");
  const imp = np.importText("VRTree", text);
  assert.equal(imp.ok, true, imp.error);
  const ex = np.exportText("vrtree");
  assert.equal(ex.ok, true);
  assert.equal(ex.text, text);
});
await check("NavProfiles importText(.af) picks the named section, else the first", () => {
  const np = new NavProfiles({ store: fakeStore() });
  const af = fs.readFileSync(path.join(FIX, "shop_and_follow.af"), "utf8");
  const r = np.importText("buddy", af);
  assert.equal(r.ok, true, r.error);
  assert.equal(np.get("buddy").routeType, ROUTE.Follow);
  const r2 = np.importText("Other", af);
  assert.equal(r2.ok, true);
  assert.match(r2.warnings.join(" "), /other section/);
  assert.equal(np.get("Other").points.length, 9);
  assert.equal(np.importText("x", "garbage").ok, false);
});
// ── FollowAroundCorners: the leader trail (follow_trail.js) ────────────────
const { FollowTrail, TRAIL_TUNING, trailPoint } = await import("../rynth/vt/nav/follow_trail.js");
const { walkTargetWorld } = await import("../rynth/vt/nav/executors.js");
const L = (x, y) => ({ cell: 0x7d640001, x, y, z: 0, wx: x, wy: y });
const xy = (tr) => tr.points.map((p) => [p.wx, p.wy]);

await check("FollowTrail: a leader running straight away keeps ONE point (no corner ahead); a turn over 15° keeps the corner; then a point every 5 m of straight run; < 1 m adds nothing; ≤ 1 sample per 250 ms", () => {
  const tr = new FollowTrail(7);
  const me = L(0, 0);
  let t = 0;
  const s = (x, y) => tr.sample((t += 250), L(x, y), me);
  for (let x = 10; x <= 30; x++) s(x, 0);
  assert.deepEqual(xy(tr), [[30, 0]], "in line with us: one leg");
  assert.equal(tr.next(), null, "no corner between us and them");
  s(30.5, 0);
  assert.deepEqual(xy(tr), [[30, 0]], "under 1 m");
  assert.equal(tr.sample(t + 100, L(40, 0), me), null, "too soon after the last sample");
  s(30, 3);
  assert.deepEqual(xy(tr), [[30, 0], [30, 3]], "a 90° turn keeps the corner");
  assert.deepEqual([tr.next().wx, tr.next().wy], [30, 0]);
  for (let y = 4; y <= 20; y++) s(30, y);
  assert.deepEqual(xy(tr), [[30, 0], [30, 5], [30, 10], [30, 15], [30, 20]], "a straight run: a point every 5 m");
  s(30.4, 22); // 11° off the line (the last leg is full: a new point)…
  assert.deepEqual(xy(tr).slice(-2), [[30, 20], [30.4, 22]]);
  s(30.8, 24); // …and the next one in line with it replaces it
  assert.deepEqual(xy(tr).slice(-2), [[30, 20], [30.8, 24]], "replaced, not added");
});

await check("FollowTrail.prune: a point within 1.5 m is reached; within 3 m and nearer the next point than it is, passed; beside a corner (not past it) it stays", () => {
  const tr = new FollowTrail(7);
  tr.points = [L(30, 0), L(30, 5), L(30, 10), L(30, 15)];
  assert.equal(tr.prune(L(29.2, 0.5)), 1, "reached");
  assert.equal(tr.prune(L(30.5, 7)), 1, "(30,5) passed on the way to (30,10)");
  assert.deepEqual(xy(tr), [[30, 10], [30, 15]]);
  const corner = new FollowTrail(7);
  corner.points = [L(30, 0), L(30, 10)];
  assert.equal(corner.prune(L(27.5, 0.2)), 0, "2.5 m short of the corner: the inside of the turn is not cut");
  assert.equal(corner.prune(null), 0);
});

await check("FollowTrail: a teleport (the leader or we move ≥ 30 m faster than 20 m/s) starts over at the leader; a long sampling gap is a walk, not a teleport; capped at maxPoints", () => {
  const tr = new FollowTrail(7);
  let t = 0;
  tr.sample((t += 250), L(10, 0), L(0, 0));
  tr.sample((t += 250), L(12, 0), L(0, 0));
  tr.sample((t += 250), L(12, 5), L(0, 0));
  assert.equal(tr.size, 2);
  assert.equal(tr.sample((t += 250), L(60, 5), L(0, 0)), "reset", "the leader: 48 m in 250 ms");
  assert.deepEqual(xy(tr), [[60, 5]]);
  tr.sample((t += 250), L(60, 8), L(0, 0));
  assert.equal(tr.size, 2);
  assert.equal(tr.sample((t += 250), L(60, 9), L(200, 0)), "reset", "we moved 200 m in 250 ms");
  assert.deepEqual(xy(tr), [[60, 9]]);
  assert.equal(tr.sample((t += 10_000), L(60, 49), L(200, 0)), "sampled", "40 m in 10 s (no samples during a fight): walked");
  const zig = new FollowTrail(1);
  for (let i = 0; i < 300; i++) zig.sample((t += 250), L(i * 2, i % 2 ? 3 : 0), L(-50, 0));
  assert.equal(zig.size, TRAIL_TUNING.maxPoints, "the oldest go");
  assert.deepEqual(xy(zig).at(-1), [598, 3]);
});

await check("FollowTrail.prune(me, join): a walk that (re)starts joins their path at the point nearest the follower (a tie: the later one) — their wander before it is dropped; walking, only the reached / passed prefix; keepLast keeps their last steps", () => {
  const tr = new FollowTrail(7);
  // their wander west of us, then away east around a corner
  tr.points = [L(-6, 2), L(-5, -3), L(-8, 1), L(-4, 4), L(2, 6), L(10, 6), L(10, 20)];
  const me = L(0, 5);
  assert.equal(tr.prune(me), 0, "walking: only the reached / passed prefix");
  assert.equal(tr.prune(me, true), 4, "(re)start: joined at (2,6), nearest us");
  assert.deepEqual(xy(tr), [[2, 6], [10, 6], [10, 20]]);
  const tie = new FollowTrail(7);
  tie.points = [L(3, 0), L(0, 10), L(-3, 0), L(-3, -10)];
  assert.equal(tie.prune(L(0, 0), true), 2, "a tie goes to the later point (further along their path)");
  assert.deepEqual(xy(tie), [[-3, 0], [-3, -10]]);
  const near = new FollowTrail(7);
  near.points = [L(-20, 0), L(-20, 10), L(3, 3)];
  near.prune(L(0, 0), true);
  assert.deepEqual(xy(near), [[3, 3]], "the leader is the nearest point: no corner ahead");
  assert.equal(near.next(), null);
  const k = new FollowTrail(7);
  k.points = [L(0, 0), L(1, 0), L(2, 0), L(3, 0), L(4, 0), L(5, 0)];
  k.keepLast(TRAIL_TUNING.holdKeep);
  assert.deepEqual(xy(k), [[2, 0], [3, 0], [4, 0], [5, 0]]);
  k.keepLast(TRAIL_TUNING.holdKeep);
  assert.equal(k.size, 4);
});

await check("FollowTrail: drop / reset; trailPoint keeps the cell for the router leg; walkTargetWorld = where a waypoint walks to (Portal/NPC at its object's recorded spot, in-place types null)", () => {
  const tr = new FollowTrail(1);
  tr.points = [L(0, 0), L(5, 0), L(10, 0)];
  tr.drop(tr.points[1]);
  assert.deepEqual(xy(tr), [[10, 0]]);
  tr.reset(L(3, 3));
  assert.deepEqual(xy(tr), [[3, 3]]);
  tr.reset();
  assert.equal(tr.size, 0);
  assert.equal(tr.lastLeader, null);
  const p = trailPoint({ objCellId: 0x7d640105, x: 10, y: 20, z: 5 });
  assert.deepEqual(p, { cell: 0x7d640105, x: 10, y: 20, z: 5, wx: 0x7d * 192 + 10, wy: 0x64 * 192 + 20 });
  assert.equal(trailPoint(null), null);
  assert.equal(trailPoint({ objCellId: 1, x: NaN, y: 0 }), null);
  const here = pointWorld(pt(33.6, 42.0));
  assert.deepEqual(walkTargetWorld(pt(33.6, 42.0)), here);
  assert.deepEqual(walkTargetWorld({ type: POINT.OpenVendor, ew: 33.6, ns: 42.0, z: 0.4 }), here);
  const portal = { type: POINT.PortalNPC, ew: 56.8, ns: 33.6, z: 0, name: "Baishi Portal", exitEW: 33.6, exitNS: 42.0 };
  assert.deepEqual(walkTargetWorld(portal), { wx: here.wx, wy: here.wy }, "the object's recorded position, not the stale own one");
  assert.deepEqual(walkTargetWorld({ ...portal, exitEW: 0, exitNS: 0 }), pointWorld(portal), "no object position: its own");
  for (const type of [POINT.Recall, POINT.Pause, POINT.Chat, POINT.Checkpoint, POINT.Jump]) assert.equal(walkTargetWorld({ type, ew: 33.6, ns: 42.0, z: 0 }), null, `type ${type} runs in place`);
  assert.equal(walkTargetWorld(pt(0, 0)), null, "the 0,0 sentinel");
  assert.equal(walkTargetWorld(null), null);
});

await check("barrel exports the package surface", () => {
  for (const k of ["ROUTE", "makeRoute", "advance", "parseNavVt", "parseAfNavsVt", "writeNavVt", "retypeAfPoint", "NavProfiles", "ActiveNav", "makeExecutor"]) {
    assert.ok(k in nav, k);
  }
});

console.log(fail === 0 ? `rynth_vt_nav_model: all ${pass} checks passed` : `rynth_vt_nav_model: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
