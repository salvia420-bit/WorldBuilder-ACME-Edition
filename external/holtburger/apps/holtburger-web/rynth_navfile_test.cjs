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
      // 42 is not a real NTypeID (metaf Core/Enums.cs: 0..9, plus VTank's own
      // 99 "Other") — type 9 (Jump) is now a KNOWN, parsed type (2026-07-20
      // nav_import corpus survey found real VTank .nav files using it), so the
      // "unknown type" placeholder moved to a value that stays unknown.
      const text = ["uTank2 NAV 1.2", "2", "2", "0", "1", "1", "0.5", "0", "42", "1", "1", "0.5", "0"].join("\r\n") + "\r\n";
      const parsed = NF.parseNav(text);
      assert.equal(parsed.points.length, 1, "stopped before the type-42 point");
      assert.match(parsed.warning, /unknown waypoint type 42/);
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
        "pau 33.7 42.1 0.4 5000",
        "rcl 33.6 42.08 0.39 {Lifestone Recall}",
        "~~ }",
      ].join("\n");
      const navs = NF.parseAfNavs(af);
      assert.ok(navs.patrol, "extracted NAV: section");
      assert.equal(navs.patrol.routeType, 1); // circular
      const types = navs.patrol.points.map((p) => p.type);
      assert.deepEqual(types, [0, 3, 2], "pnt/pau/rcl mapped");
      // FORMAT (metaf NPause.ImportFromMetAF): "pau myx myy myz
      // PauseInMilliseconds" — a real, captured position + ms duration
      // (2026-07-21 sentinel-cleanup: the old parser hardcoded ew:0,ns:0,z:0
      // and misread the x-coordinate as pauseMs*1000, corrupting every real
      // corpus pau line with real coordinates into a fake teleport).
      assert.equal(navs.patrol.points[1].ew, 33.7, "pause x preserved");
      assert.equal(navs.patrol.points[1].ns, 42.1, "pause y preserved");
      assert.equal(navs.patrol.points[1].z, 0.4, "pause z preserved");
      assert.equal(navs.patrol.points[1].pauseMs, 5000, "pause ms read directly (not seconds*1000)");
      assert.equal(navs.patrol.points[2].spellId, 1635, "lifestone recall id");
    });

    await t("F16", "embedded .af NAV: pau with a genuine VTank no-position sentinel (0 0 -1000) round-trips as-is", () => {
      const af = ["NAV: p2 once ~~ {", "pau 0 0 -1000 1000", "~~ }"].join("\n");
      const navs = NF.parseAfNavs(af);
      assert.equal(navs.p2.points[0].ew, 0);
      assert.equal(navs.p2.points[0].ns, 0);
      assert.equal(navs.p2.points[0].z, -1000);
      assert.equal(navs.p2.points[0].pauseMs, 1000);
    });

    // ── navPointToLeg map-edge clamp (2026-07-21 sentinel-cleanup gap 4) ────
    // aerbax-south-gate.nav point 475's real recorded EW=-101.958914493521
    // converts to wx=-2.14 — a real waypoint essentially AT the map's west
    // edge, not off it. The un-clamped formula wrapped a negative landblock
    // index via JS's int32 `&0xff` to landblock byte 255 (the FAR side of
    // the map), producing a ~49,000m false "teleport" leg — the corpus's
    // map-edge-wraparound failure cluster.
    await t("F13", "navPointToLeg clamps a just-negative world X to landblock 0 instead of wrapping to landblock 255", () => {
      const leg = NF.navPointToLeg(-101.958914493521, 51.1827315648397, 0.0000208333134651184);
      const lbX = (leg.lb >>> 24) & 0xff;
      assert.equal(lbX, 0, `expected landblock byte 0 (map edge), got ${lbX} (wx≈-2.14 should clamp, not wrap)`);
      assert.ok(leg.x >= 0 && leg.x < 24, `expected a small in-range local x, got ${leg.x}`);
    });

    await t("F14", "navPointToLeg clamps a just-over-the-edge world coordinate to landblock 255, not wrapped to 0", () => {
      // EW just past the formula's positive edge (wx a hair >= MAP_SIZE_M).
      const overEdgeEw = (NF.MAP_SIZE_M / 24 - 1019.5) / 10 + 0.001;
      const leg = NF.navPointToLeg(overEdgeEw, 0, 0);
      const lbX = (leg.lb >>> 24) & 0xff;
      assert.equal(lbX, 255, `expected landblock byte 255 (map edge), got ${lbX}`);
    });

    await t("F15", "navPointToLeg is unchanged for an ordinary in-range coordinate (no clamp side effect)", () => {
      const leg = NF.navPointToLeg(-101.386705207825, -34.0266930898031, -0.149979162216187);
      const worldX = ((leg.lb >>> 24) & 0xff) * 192 + leg.x;
      const worldY = ((leg.lb >>> 16) & 0xff) * 192 + leg.y;
      assert.ok(Math.abs(worldX - 135.19) < 0.01, `expected worldX≈135.19, got ${worldX}`);
      assert.ok(Math.abs(worldY - 16301.59) < 0.01, `expected worldY≈16301.59, got ${worldY}`);
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
