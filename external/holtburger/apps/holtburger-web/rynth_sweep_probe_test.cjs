// sweep_probe.js tests (NavAtlas W2.5). Node-only with a mock `probe` (plain
// functions) standing in for the wasm sweep exports — deterministic hit times.
// Exits 1 on ANY failure.
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

// router leg frame helper (lb full objCellId)
const L = (lbWord, x, y, z = 0, extra = {}) => ({ lb: ((lbWord << 16) | 1) >>> 0, x, y, z, ...extra });
const hit = (t, x = 0, y = 0, z = 0) => ({ t, x, y, z, normalX: -1, normalY: 0, normalZ: 0 });

(async () => {
  const srcDir = path.join(__dirname, "rynth");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-probe-"));
  for (const f of fs.readdirSync(srcDir)) {
    if (f.endsWith(".js") || f.endsWith(".json")) fs.copyFileSync(path.join(srcDir, f), path.join(tmpDir, f));
  }
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ type: "module" }));
  const SP = await import(pathToFileURL(path.join(tmpDir, "sweep_probe.js")).href);

  try {
    await t("P1", "clean sweep -> not blocked, segMeters reported", () => {
      const probe = { sweepStatics: () => undefined, sweepBuilding: () => undefined };
      const r = SP.probeSegment(probe, L(0x0101, 0, 0), L(0x0101, 40, 0));
      assert.equal(r.blocked, false);
      assert.equal(r.atMeters, null);
      assert.ok(Math.abs(r.segMeters - 40) < 1e-6);
    });

    await t("P2", "static hit -> blocked at t×segLen with kind + point", () => {
      const probe = { sweepStatics: () => hit(0.3, 12, 0, 0), sweepBuilding: () => undefined };
      const r = SP.probeSegment(probe, L(0x0101, 0, 0), L(0x0101, 40, 0));
      assert.equal(r.blocked, true);
      assert.ok(Math.abs(r.atMeters - 12) < 1e-6, `0.3×40=12m, got ${r.atMeters}`);
      assert.equal(r.hitKind, "static");
      assert.deepEqual(r.hitPoint, { x: 12, y: 0, z: 0 });
    });

    await t("P3", "earliest hit wins across static vs building", () => {
      const probe = { sweepStatics: () => hit(0.6), sweepBuilding: () => hit(0.25) };
      const r = SP.probeSegment(probe, L(0x0101, 0, 0), L(0x0101, 40, 0));
      assert.equal(r.hitKind, "building", "closer building beats farther static");
      assert.ok(Math.abs(r.atMeters - 10) < 1e-6);
    });

    await t("P4", "cell sweep only runs when cellIds given", () => {
      let cellCalled = false;
      const probe = { sweepStatics: () => undefined, sweepBuilding: () => undefined, sweepCell: () => ((cellCalled = true), hit(0.5)) };
      const r0 = SP.probeSegment(probe, L(0x0101, 0, 0), L(0x0101, 40, 0));
      assert.equal(cellCalled, false, "no cellIds -> no cell sweep");
      assert.equal(r0.blocked, false);
      const r1 = SP.probeSegment(probe, L(0x0101, 0, 0), L(0x0101, 40, 0), { cellIds: [0x01010101] });
      assert.equal(cellCalled, true);
      assert.equal(r1.hitKind, "cell");
    });

    await t("P5", "world-frame conversion: sweep receives lb-offset coords", () => {
      let got = null;
      const probe = { sweepStatics: (fx, fy, fz, tx, ty, tz, r, lb) => ((got = { fx, fy, tx, ty, lb }), undefined), sweepBuilding: () => undefined };
      SP.probeSegment(probe, L(0x0201, 10, 5, 90), L(0x0201, 30, 5, 90));
      // lbX=0x02=2 -> world x = 2*192 + 10 = 394; lbY=0x01=1 -> world y = 192+5 = 197
      assert.ok(Math.abs(got.fx - 394) < 1e-6, `world x, got ${got.fx}`);
      assert.ok(Math.abs(got.fy - 197) < 1e-6, `world y, got ${got.fy}`);
      assert.equal(got.lb, ((0x0201 << 16) | 1) >>> 0, "destination lb scoping");
    });

    await t("P6", "probeRoute returns the first blocked leg index", () => {
      // world-x = lbHighByte(0x01)*192 + local: leg starts are 192, 222, 252, 282.
      // Threshold 240 blocks only the leg starting at 252 (leg index 3).
      const probe = {
        sweepStatics: (fx) => (fx > 240 ? hit(0.4) : undefined),
        sweepBuilding: () => undefined,
      };
      const legs = [L(0x0101, 0, 0), L(0x0101, 30, 0), L(0x0101, 60, 0), L(0x0101, 90, 0)];
      const r = SP.probeRoute(probe, legs);
      assert.equal(r.blocked, true);
      assert.equal(r.leg, 3, "first leg whose start world-x > 240 is leg 3 (from local 60)");
    });

    await t("P7", "probeRoute skips portal legs (a hop is not walked)", () => {
      let calls = 0;
      const probe = { sweepStatics: () => (calls++, undefined), sweepBuilding: () => undefined };
      const legs = [L(0x0101, 0, 0), L(0x0101, 30, 0, 0, { portal: true }), L(0x4040, 10, 10)];
      SP.probeRoute(probe, legs);
      assert.equal(calls, 1, "portal leg (i=1) skipped; only leg 2 probed");
    });

    await t("P8", "probeFromSession frees each wasm CollisionHit", () => {
      let freed = 0;
      const wasmHit = () => ({ t: 0.5, x: 1, y: 2, z: 3, normalX: -1, normalY: 0, normalZ: 0, free: () => freed++ });
      const sh = {
        sweepSphereAgainstStatics: () => wasmHit(),
        sweepSphereAgainstBuildingMesh: () => undefined,
        sweepSphereAgainstCellMesh: () => undefined,
        terrainHeightAt: () => 90,
      };
      const probe = SP.probeFromSession(sh);
      const r = SP.probeSegment(probe, L(0x0101, 0, 0), L(0x0101, 40, 0));
      assert.equal(r.blocked, true);
      assert.equal(freed, 1, "wasm hit freed after copy");
    });

    await t("P9", "terrainProfile reports max rise/drop, skips unbaked", () => {
      const heights = [90, 91, 92, undefined, 80, 79]; // a drop after an unbaked gap
      let i = 0;
      const probe = { terrainHeightAt: () => heights[i++] };
      const prof = SP.terrainProfile(probe, L(0x0101, 0, 0), L(0x0101, 50, 0), { steps: 5 });
      assert.ok(prof.maxRise >= 1 - 1e-9, `rise 90->92 in steps, got ${prof.maxRise}`);
      assert.ok(Math.abs(prof.maxDrop - 1) < 1e-9, `drop 80->79 = 1 (gap resets), got ${prof.maxDrop}`);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nsweep_probe: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(`ERR ${e.stack || e.message}`);
  process.exit(1);
});
