// Atlas + RouteRecorder unit tests (NavAtlas W2). Node-only, no browser/wasm:
// the recorder is a pure pose->route transform and the atlas is a pure store
// with an in-memory storage shim, so both run deterministically off fake
// poses. Mirrors rynth_navsim_test.cjs staging (ESM -> type:module tmpdir).
// Exits 1 on ANY failure.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0;
let fail = 0;
const rows = [];
async function t(id, name, fn) {
  try {
    await fn();
    pass++;
    rows.push([id, name, "PASS"]);
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    fail++;
    rows.push([id, name, "FAIL"]);
    console.log(`FAIL ${id} ${name}: ${e.message}`);
  }
}
const quiet = () => {};

// pose in webhost TryGetPlayerPose shape: full objCellId + local x,y,z.
const P = (lbWord, x, y, z = 0) => ({ objCellId: ((lbWord << 16) | 1) >>> 0, x, y, z });
const wxy = (lb, x, y) => [((lb >>> 24) & 0xff) * 192 + x, ((lb >>> 16) & 0xff) * 192 + y];

(async () => {
  const srcDir = path.join(__dirname, "rynth");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-atlas-"));
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(srcDir, f), path.join(tmpDir, f));
  }
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  const mod = (f) => import(pathToFileURL(path.join(tmpDir, f)).href);

  try {
    const [RR, AT] = await Promise.all([mod("route_recorder.js"), mod("atlas.js")]);
    const { RouteRecorder } = RR;
    const { Atlas, estimateRouteMs, RUN_SPEED_MS } = AT;

    const mkRec = () => new RouteRecorder({ log: quiet });
    // in-memory storage shim per test (fresh atlas isolation)
    const memStore = () => {
      const m = new Map();
      return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
    };
    const mkAtlas = (store) => new Atlas({ storage: store || memStore(), log: quiet });

    // ════ RouteRecorder ════
    await t("RR1", "straight walk RDP-collapses to 2 legs", () => {
      const r = mkRec();
      r.start({ from: P(0xa0b0, 0, 0), runRate: 1.5, runSkill: 240 });
      for (let x = 10; x <= 100; x += 10) r.sample(P(0xa0b0, x, 0));
      const route = r.finish({ ok: true, to: P(0xa0b0, 100, 0) });
      assert.ok(route, "route produced");
      assert.equal(route.legs.length, 2, `collinear -> 2 legs, got ${route.legs.length}`);
      assert.equal(route.runRateAtRecord, 1.5);
      assert.equal(route.runSkillAtRecord, 240);
      assert.equal(route.portalsUsed, 0);
      assert.ok(Math.abs(route.estUnits - 100) < 2, `~100u, got ${route.estUnits}`);
    });

    await t("RR2", "dog-leg keeps the corner (>=3 legs)", () => {
      const r = mkRec();
      r.start({ from: P(0xa0b0, 0, 0) });
      for (let x = 10; x <= 50; x += 10) r.sample(P(0xa0b0, x, 0));
      for (let y = 10; y <= 50; y += 10) r.sample(P(0xa0b0, 50, y));
      const route = r.finish({ ok: true, to: P(0xa0b0, 50, 50) });
      assert.ok(route.legs.length >= 3, `corner kept, got ${route.legs.length} legs`);
      // corner ~ (50,0) present
      assert.ok(route.legs.some((l) => Math.abs(l.x - 50) < 1 && Math.abs(l.y - 0) < 1), "corner leg present");
    });

    await t("RR3", "portal hop annotated, not counted in ground units", () => {
      const r = mkRec();
      r.start({ from: P(0xa0b0, 0, 0) });
      r.sample(P(0xa0b0, 10, 0));
      r.sample(P(0xa0b0, 20, 0));
      r.sample(P(0xf0f0, 5, 5)); // >30m world jump = portal
      r.sample(P(0xf0f0, 20, 5));
      r.sample(P(0xf0f0, 40, 5));
      const route = r.finish({ ok: true, to: P(0xf0f0, 40, 5) });
      assert.equal(route.portalsUsed, 1);
      const portalLeg = route.legs.find((l) => l.portal);
      assert.ok(portalLeg, "a portal leg exists");
      assert.equal(portalLeg.label, "portal");
      // ground units = ~20 (pre-portal) + ~35 (post) — NOT the giant hop distance
      assert.ok(route.estUnits < 200, `hop excluded from ground, got ${route.estUnits}u`);
    });

    await t("RR4", "finish(ok:false) discards -> null (not experience)", () => {
      const r = mkRec();
      r.start({ from: P(0xa0b0, 0, 0) });
      for (let x = 10; x <= 60; x += 10) r.sample(P(0xa0b0, x, 0));
      assert.equal(r.finish({ ok: false, reason: "died" }), null);
    });

    await t("RR5", "too-short walk -> null (< minLegs)", () => {
      const r = mkRec();
      r.start({ from: P(0xa0b0, 0, 0) });
      // no movement -> only the seed crumb -> 1 leg
      assert.equal(r.finish({ ok: true, to: P(0xa0b0, 0, 0) }), null);
    });

    await t("RR6", "notePortalHop dedups with auto-detected portal crumb", () => {
      const r = mkRec();
      r.start({ from: P(0xa0b0, 0, 0) });
      r.sample(P(0xa0b0, 15, 0));
      r.sample(P(0xf0f0, 5, 5)); // auto portal crumb
      r.notePortalHop({ before: P(0xa0b0, 15, 0), after: P(0xf0f0, 5, 5), label: "town portal" });
      r.sample(P(0xf0f0, 30, 5));
      const route = r.finish({ ok: true, to: P(0xf0f0, 30, 5) });
      assert.equal(route.portalsUsed, 1, "not double-counted");
      assert.equal(route.legs.filter((l) => l.portal).length, 1);
      assert.equal(route.legs.find((l) => l.portal).label, "town portal", "explicit label wins");
    });

    await t("RR7", "cell change forces a crumb even under spacing", () => {
      const r = mkRec();
      r.start({ from: P(0x0101, 190, 0) });
      r.sample(P(0x0101, 191, 0)); // 1m, under spacing, same lb -> dropped
      r.sample(P(0x0201, 2, 0)); // seam crossing: lb word changed, small jump -> kept
      r.sample(P(0x0201, 40, 0));
      const route = r.finish({ ok: true, to: P(0x0201, 40, 0) });
      assert.ok(route.legs.some((l) => (l.lb >>> 16) === 0x0201), "seam crumb captured");
    });

    // ════ estimateRouteMs (pure) ════
    await t("E1", "ETA = ground/speed + portal dwell; runRate scales", () => {
      const route = { legs: [{ lb: P(0, 0, 0).objCellId, x: 0, y: 0 }, { lb: P(0, 0, 0).objCellId, x: 400, y: 0 }] };
      const e1 = estimateRouteMs(route, { runRate: 1 });
      // 400u / (1*4.0 m/s) = 100s
      assert.ok(Math.abs(e1 - 100000) < 50, `~100s, got ${e1}`);
      const e2 = estimateRouteMs(route, { runRate: 2 });
      assert.ok(Math.abs(e2 - 50000) < 50, `2x speed -> half, got ${e2}`);
      assert.equal(RUN_SPEED_MS, 4.0);
    });

    await t("E2", "portal + vendor dwell added", () => {
      const c = P(0, 0, 0).objCellId;
      const route = {
        legs: [
          { lb: c, x: 0, y: 0 },
          { lb: c, x: 40, y: 0, portal: true, label: "portal" },
          { lb: c, x: 40, y: 0, label: "vendor Fredere" },
        ],
      };
      const e = estimateRouteMs(route, { runRate: 1 });
      // no ground (portal breaks the chain), + 4s portal + 10s vendor = 14s
      assert.ok(Math.abs(e - 14000) < 50, `14s dwell, got ${e}`);
    });

    // ════ Atlas ════
    const sample = (over = {}) => ({
      from: { lb: P(0xa0b0, 0, 0).objCellId, x: 0, y: 0, z: 0 },
      to: { lb: P(0xa0b0, 100, 0).objCellId, x: 100, y: 0, z: 0 },
      legs: [
        { lb: P(0xa0b0, 0, 0).objCellId, x: 0, y: 0, z: 0 },
        { lb: P(0xa0b0, 100, 0).objCellId, x: 100, y: 0, z: 0 },
      ],
      estUnits: 100,
      walkedMs: 30000,
      runRateAtRecord: 1,
      ...over,
    });

    await t("A1", "saveRoute assigns id+name; get by name AND id", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample());
      assert.ok(r.id && r.name, "id+name assigned");
      assert.equal(a.getRoute(r.name).id, r.id, "by name");
      assert.equal(a.getRoute(r.id).id, r.id, "by id");
      assert.equal(a.listRoutes().length, 1);
      assert.equal(r.schemaVersion, 1);
    });

    await t("A2", "nameRoute renames; duplicate names get #2", () => {
      const a = mkAtlas();
      const r1 = a.saveRoute(sample());
      const named = a.nameRoute(r1.id, "arwic-run");
      assert.equal(named.name, "arwic-run");
      const r2 = a.saveRoute({ ...sample(), name: "arwic-run" });
      assert.equal(r2.name, "arwic-run#2", "collision suffixed");
    });

    await t("A3", "recordResult(ok) bumps successCount + lastResult", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample());
      a.recordResult(r.name, { ok: true, actualMs: 26000 });
      const got = a.getRoute(r.id);
      assert.equal(got.successCount, 1);
      assert.equal(got.lastResult.ok, true);
      assert.equal(got.lastResult.actualMs, 26000);
    });

    await t("A4", "recordResult accepts id (main's request)", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample());
      const got = a.recordResult(r.id, { ok: false, reason: "wall" });
      assert.ok(got, "found by id");
      assert.equal(got.failCount, 1);
      assert.equal(got.lastResult.reason, "wall");
    });

    await t("A5", "two >2x overruns -> suspect", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample()); // est: 100u/4 = 25s
      a.recordResult(r.id, { ok: true, actualMs: 60000 }); // >2x25s -> strike 1
      assert.equal(a.getRoute(r.id).suspect, false);
      a.recordResult(r.id, { ok: true, actualMs: 70000 }); // strike 2
      assert.equal(a.getRoute(r.id).suspect, true, "suspect after 2 strikes");
      assert.equal(a.getRoute(r.id).overrunStrikes, 2);
    });

    await t("A6", "markValidated records offline verdict", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample());
      a.markValidated(r.id, { ok: false, failedLeg: 1, method: "spatial-sim" });
      const v = a.getRoute(r.id).validated;
      assert.equal(v.ok, false);
      assert.equal(v.failedLeg, 1);
      assert.equal(v.method, "spatial-sim");
    });

    await t("A7", "summaries: loc degrees + eta + flags", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample());
      a.markValidated(r.id, { ok: true });
      const s = a.summaries()[0];
      assert.equal(s.name, r.name);
      assert.equal(s.legs, 2);
      assert.ok(typeof s.from.ns === "number" && typeof s.to.ew === "number");
      assert.ok(Math.abs(s.etaMs - 25000) < 100, `eta ~25s, got ${s.etaMs}`);
      assert.equal(s.validated, true);
    });

    await t("A8", "persistence: fresh Atlas over same storage reloads routes", () => {
      const store = memStore();
      const a1 = mkAtlas(store);
      const r = a1.saveRoute(sample());
      a1.recordResult(r.id, { ok: true, actualMs: 26000 });
      const a2 = new Atlas({ storage: store, log: quiet });
      assert.equal(a2.listRoutes().length, 1, "reloaded from storage");
      assert.equal(a2.getRoute(r.id).successCount, 1, "counters persisted");
    });

    await t("A9", "exportAll/importAll round-trips into a clean atlas", () => {
      const a1 = mkAtlas();
      const r = a1.saveRoute(sample());
      const dump = a1.exportAll();
      const a2 = mkAtlas();
      const n = a2.importAll(dump);
      assert.equal(n, 1);
      assert.equal(a2.getRoute(r.id).name, r.name);
    });

    await t("A10", "remove deletes by name or id", () => {
      const a = mkAtlas();
      const r = a.saveRoute(sample());
      assert.equal(a.remove(r.name), true);
      assert.equal(a.listRoutes().length, 0);
      assert.equal(a.remove("nope"), false);
    });

    // ════ recorder -> atlas end-to-end ════
    await t("X1", "recorded route saves + estimates honestly", () => {
      const rec = mkRec();
      rec.start({ from: P(0xa0b0, 0, 0), runRate: 1 });
      for (let x = 10; x <= 200; x += 10) rec.sample(P(0xa0b0, x, 0));
      const route = rec.finish({ ok: true, to: P(0xa0b0, 200, 0) });
      const a = mkAtlas();
      const saved = a.saveRoute(route);
      const eta = a.estimateMs(saved.id, { runRate: 1 });
      assert.ok(Math.abs(eta - 50000) < 200, `200u/4 = 50s, got ${eta}`);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log("\n== rynth_atlas results ==");
  for (const [id, name, res] of rows) console.log(`${res.padEnd(5)} ${id.padEnd(4)} ${name}`);
  console.log(`\natlas: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
