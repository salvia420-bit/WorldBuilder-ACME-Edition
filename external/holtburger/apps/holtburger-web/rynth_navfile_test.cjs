// nav_file.js tests (NavAtlas W2.4). REAL VTank routes (rynth/testdata/*.nav,
// pulled from the Discord archive) drive the byte-stable round-trip; synthetic
// cases cover atlas<->nav conversion, the trailer table, and embedded .af. No
// browser/wasm. Exits 1 on ANY failure.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0;
let fail = 0;
async function t(id, name, fn) {
  try {
    await fn();
    pass++;
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${id} ${name}: ${e.message}`);
  }
}

const FIXTURES = path.join(__dirname, "rynth", "testdata");

(async () => {
  const srcDir = path.join(__dirname, "rynth");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-navfile-"));
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(srcDir, f), path.join(tmpDir, f));
  }
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  const NF = await import(pathToFileURL(path.join(tmpDir, "nav_file.js")).href);

  try {
    // ── byte-stable round-trip against REAL VTank routes ──
    for (const file of ["HoltburgTest.nav", "muleall.nav", "MatronHive.nav"]) {
      await t(`RT-${file}`, `real route round-trips byte-for-byte`, () => {
        const orig = fs.readFileSync(path.join(FIXTURES, file), "utf8");
        const parsed = NF.parseNav(orig);
        assert.equal(parsed.warning, null, `clean parse: ${parsed.warning}`);
        assert.equal(parsed.points.length, parsed.pointCount, "all points parsed");
        const back = NF.writeNav(parsed);
        assert.equal(back, orig, "writeNav(parseNav(x)) === x");
      });
    }

    await t("F1", "trailer table matches Nav_DeepDive §0b", () => {
      const { trailerLineCount: tlc, NavPointType: T } = NF;
      assert.equal(tlc(T.Recall), 1);
      assert.equal(tlc(T.Pause), 1);
      assert.equal(tlc(T.Chat), 1);
      assert.equal(tlc(T.OpenVendor), 2);
      assert.equal(tlc(T.PortalNPC), 6);
      assert.equal(tlc(T.Npc), 6);
      assert.equal(tlc(T.Point), 0);
    });

    await t("F2", "HoltburgTest parses Point + Pause(1000ms) trailers", () => {
      const parsed = NF.parseNav(fs.readFileSync(path.join(FIXTURES, "HoltburgTest.nav"), "utf8"));
      assert.equal(parsed.routeType, 1); // Circular
      const pauses = parsed.points.filter((p) => p.type === 3);
      assert.ok(pauses.length >= 1, "has a Pause point");
      assert.equal(pauses[0].pauseMs, 1000, "pause trailer read as ms");
    });

    await t("F3", "muleall parses Chat command trailer", () => {
      const parsed = NF.parseNav(fs.readFileSync(path.join(FIXTURES, "muleall.nav"), "utf8"));
      const chats = parsed.points.filter((p) => p.type === 4);
      assert.ok(chats.length >= 1, "has Chat points");
      assert.ok(/^\/ub givep/.test(chats[0].chat), `chat cmd read: ${chats[0].chat}`);
    });

    await t("F4", "MatronHive parses Recall spellId trailer", () => {
      const parsed = NF.parseNav(fs.readFileSync(path.join(FIXTURES, "MatronHive.nav"), "utf8"));
      assert.equal(parsed.routeType, 4); // Once
      const recalls = parsed.points.filter((p) => p.type === 2);
      assert.ok(recalls.length >= 1, "has a Recall point");
      assert.equal(recalls[0].spellId, 1636, "lifestone recall spellId");
    });

    await t("F5", "coord conversion: HoltburgTest first point -> Holtburg lb 0xA9B4", () => {
      const parsed = NF.parseNav(fs.readFileSync(path.join(FIXTURES, "HoltburgTest.nav"), "utf8"));
      const p0 = parsed.points[0];
      const leg = NF.navPointToLeg(p0.ew, p0.ns, p0.z);
      assert.equal((leg.lb >>> 16) & 0xffff, 0xa9b4, `Holtburg landblock, got ${((leg.lb >>> 16) & 0xffff).toString(16)}`);
      assert.ok(Math.abs(leg.z - p0.z * 240) < 1e-6, "z = navZ*240");
      assert.ok(leg.x >= 0 && leg.x < 192 && leg.y >= 0 && leg.y < 192, "local coords in-landblock");
    });

    await t("F6", "leg<->navPoint round-trips (deg + z)", () => {
      const leg = { lb: (((0xa9 << 24) | (0xb4 << 16) | 0x21) >>> 0) >>> 0, x: 33.6, y: 42.08, z: 94.0 };
      const np = NF.legToNavPoint(leg.lb, leg.x, leg.y, leg.z);
      const back = NF.navPointToLeg(np.ew, np.ns, np.navZ);
      assert.ok(Math.abs(back.x - leg.x) < 1e-3 && Math.abs(back.y - leg.y) < 1e-3, "x/y stable");
      assert.ok(Math.abs(back.z - leg.z) < 1e-3, "z stable");
    });

    await t("F7", "navToRoute: real route -> atlas legs with portal/vendor labels", () => {
      const parsed = NF.parseNav(fs.readFileSync(path.join(FIXTURES, "MatronHive.nav"), "utf8"));
      const route = NF.navToRoute(parsed, { name: "matron-hive" });
      assert.equal(route.legs.length, parsed.points.length);
      assert.equal(route.source, "import-nav");
      // the Recall waypoint becomes a portal leg
      assert.ok(route.legs.some((l) => l.portal && /recall/.test(l.label || "")), "recall -> portal leg");
      assert.ok(route.from.lb && route.to.lb, "endpoints set");
    });

    await t("F8", "routeToNav -> parseNav round-trips a synthesized atlas route", () => {
      const c = (((0xa9 << 24) | (0xb4 << 16) | 0x21) >>> 0) >>> 0;
      const route = {
        legs: [
          { lb: c, x: 30, y: 40, z: 94 },
          { lb: c, x: 60, y: 40, z: 94, portal: true, label: "portal Town Network" },
          { lb: c, x: 60, y: 70, z: 94, label: "vendor Fredere" },
        ],
      };
      const parsed = NF.routeToNav(route);
      const text = NF.writeNav(parsed);
      const reparsed = NF.parseNav(text);
      assert.equal(reparsed.warning, null);
      assert.equal(reparsed.points.length, 3);
      assert.equal(reparsed.points[0].type, 0); // Point
      assert.equal(reparsed.points[1].type, 6); // PortalNPC
      assert.equal(reparsed.points[1].name, "Town Network");
      assert.equal(reparsed.points[2].type, 5); // OpenVendor
      assert.equal(reparsed.points[2].name, "Fredere");
    });

    await t("F9", "unknown waypoint type stops cleanly (no desync)", () => {
      const text = ["uTank2 NAV 1.2", "2", "2", "0", "1", "1", "0.5", "0", "9", "1", "1", "0.5", "0"].join("\r\n") + "\r\n";
      const parsed = NF.parseNav(text);
      assert.equal(parsed.points.length, 1, "stopped before the type-9 point");
      assert.match(parsed.warning, /unknown waypoint type 9/);
    });

    await t("F10", "embedded .af NAVDATA verbatim block -> parsed nav", () => {
      const nav = ["uTank2 NAV 1.2", "2", "1", "0", "33.6", "42.08", "0.39", "0"];
      const af = [
        "1",
        "~~ Meta by RynthAi",
        `NAVDATA: myroute ${nav.length} ~~ {`,
        ...nav,
        "~~ }",
      ].join("\n");
      const navs = NF.parseAfNavs(af);
      assert.ok(navs.myroute, "extracted route by name");
      assert.equal(navs.myroute.points.length, 1);
      assert.equal(navs.myroute.points[0].type, 0);
    });

    await t("F12", "fmt-2 flags (fmt, indoor) have no .nav representation — export byte-identical", () => {
      const c = (((0xa9 << 24) | (0xb4 << 16) | 0x21) >>> 0) >>> 0;
      // Same geometry + portal/label; the v2 copy adds route.fmt and per-leg indoor.
      const base = {
        legs: [
          { lb: c, x: 30, y: 40, z: 94 },
          { lb: c, x: 60, y: 40, z: 94, portal: true, label: "portal Town Network" },
          { lb: c, x: 60, y: 70, z: 94 },
        ],
      };
      const v2 = {
        fmt: 2,
        legs: [
          { lb: c, x: 30, y: 40, z: 94, indoor: true },
          { lb: c, x: 60, y: 40, z: 94, portal: true, label: "portal Town Network", indoor: true },
          { lb: c, x: 60, y: 70, z: 94 },
        ],
      };
      const a = NF.writeNav(NF.routeToNav(base));
      const b = NF.writeNav(NF.routeToNav(v2));
      assert.equal(b, a, "fmt/indoor dropped -> identical .nav bytes");
    });

    await t("F11", "embedded .af NAV: token section -> points", () => {
      const af = [
        "NAV: patrol circular ~~ {",
        "pnt 33.6 42.08 0.39",
        "pau 5",
        "rcl 33.6 42.08 0.39 {Lifestone Recall}",
        "~~ }",
      ].join("\n");
      const navs = NF.parseAfNavs(af);
      assert.ok(navs.patrol, "extracted NAV: section");
      assert.equal(navs.patrol.routeType, 1); // circular
      const types = navs.patrol.points.map((p) => p.type);
      assert.deepEqual(types, [0, 3, 2], "pnt/pau/rcl mapped");
      assert.equal(navs.patrol.points[1].pauseMs, 5000, "pause seconds->ms");
      assert.equal(navs.patrol.points[2].spellId, 1635, "lifestone recall id");
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nnav_file: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
