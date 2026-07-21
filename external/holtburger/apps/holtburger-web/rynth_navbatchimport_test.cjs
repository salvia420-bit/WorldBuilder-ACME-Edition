#!/usr/bin/env node
// rynth_navbatchimport_test.cjs — unit tests for rynth/nav_batch_import.cjs's
// pure helpers (2026-07-21, rynth-integration gap 4: importer sentinel
// cleanup, route-segmenting continuation). The nav_file.js pau-parser bug and
// nav_import.js's no-position-sentinel fixup handle the coordinate-level
// artifacts; this covers the remaining piece — splitting the EXPORTED
// hb-route-v1 JSON at a genuine internal >=HOP_DISCONTINUITY_M hop (a real
// portal/recall/corrupted-waypoint teleport) into independently-walkable
// segments, so one unwalkable hop mid-route no longer fails the whole file.
//
// Run: node rynth_navbatchimport_test.cjs   (exits 1 on any FAIL)
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

let pass = 0;
let fail = 0;
function t(id, name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS ${id} ${name}`);
  } catch (e) {
    fail++;
    console.log(`FAIL ${id} ${name}: ${e.message}`);
  }
}

const NB = require("./rynth/nav_batch_import.cjs");

// Minimal atlas-shaped route: lb=0 for every leg so worldXY(lb,x,y) === (x,y)
// directly (toHbLegs just adds the landblock corner, which is 0 here) —
// keeps the fixture's world coordinates exactly the numbers written below.
function route(legs, { name = "r", navType = "linear" } = {}) {
  return { name, navType, legs: legs.map((l) => ({ lb: 0, x: l.x, y: l.y, z: l.z ?? 0, portal: !!l.portal, meta: l.meta })) };
}

(() => {
  // ── splitAtHops: pure segmenting logic ──────────────────────────────────
  t("SPLIT1", "no internal hop -> a single segment (identity)", () => {
    const legs = NB.toHbLegs(route([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }]));
    const segs = NB.splitAtHops(legs, 500);
    assert.equal(segs.length, 1);
    assert.equal(segs[0].length, 3);
  });

  t("SPLIT2", "one internal >=500m hop -> two segments, split boundary right after the hop leg", () => {
    const legs = NB.toHbLegs(route([{ x: 0, y: 0 }, { x: 10, y: 0, portal: true }, { x: 10000, y: 0 }, { x: 10010, y: 0 }]));
    const segs = NB.splitAtHops(legs, 500);
    assert.equal(segs.length, 2, `expected 2 segments, got ${segs.length}`);
    assert.equal(segs[0].length, 2, "segment 1 ends AT the hop leg (the re-anchor point)");
    assert.equal(segs[1].length, 2, "segment 2 starts fresh at the post-hop leg");
    assert.equal(segs[0][1].x, 10, "segment 1's last leg is the hop leg itself");
    assert.equal(segs[1][0].x, 10000, "segment 2's first leg is the post-hop waypoint");
  });

  t("SPLIT3", "two internal hops -> three segments", () => {
    const legs = NB.toHbLegs(
      route([{ x: 0, y: 0 }, { x: 5000, y: 0 }, { x: 5010, y: 0 }, { x: 20000, y: 0 }, { x: 20005, y: 0 }])
    );
    const segs = NB.splitAtHops(legs, 500);
    assert.equal(segs.length, 3, `expected 3 segments, got ${segs.length}`);
    assert.equal(segs.reduce((n, s) => n + s.length, 0), 5, "no leg lost across the split");
  });

  t("SPLIT4", "a hop just under the threshold does not split", () => {
    const legs = NB.toHbLegs(route([{ x: 0, y: 0 }, { x: 499, y: 0 }, { x: 998, y: 0 }]));
    const segs = NB.splitAtHops(legs, 500);
    assert.equal(segs.length, 1, "499m gaps stay under the 500m threshold");
  });

  // ── writeHbRouteFiles: file-naming zero-behavior-change contract ────────
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rynth-navbatch-"));
  try {
    t("WRITE1", "a clean route (no internal hop) writes EXACTLY ONE file at the pre-existing name — no __seg suffix", () => {
      const r = route([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }], { name: "clean" });
      const written = NB.writeHbRouteFiles(r, [], "corpus/clean.nav", null, tmpDir, 500);
      assert.deepEqual(written, ["corpus__clean.nav.json"], `expected the unsuffixed filename, got ${JSON.stringify(written)}`);
      const j = JSON.parse(fs.readFileSync(path.join(tmpDir, written[0]), "utf8"));
      assert.equal(j.schema, "hb-route-v1");
      assert.equal(j.legs.length, 3);
      assert.equal(j.name, "clean", "name unchanged for a single-segment route");
    });

    t("WRITE2", "a route with one internal hop fans out into __seg1/__seg2 files, legs conserved", () => {
      const r = route([{ x: 0, y: 0 }, { x: 10, y: 0, portal: true }, { x: 10000, y: 0 }, { x: 10010, y: 0 }], { name: "hoppy" });
      const written = NB.writeHbRouteFiles(r, [], "corpus/hoppy.nav", null, tmpDir, 500);
      assert.deepEqual(written.sort(), ["corpus__hoppy.nav__seg1.json", "corpus__hoppy.nav__seg2.json"].sort());
      let totalLegs = 0;
      for (const f of written) {
        const j = JSON.parse(fs.readFileSync(path.join(tmpDir, f), "utf8"));
        assert.equal(j.schema, "hb-route-v1");
        totalLegs += j.legs.length;
        assert.ok(/route split into 2 segments/.test(j.warnings.join(" ")), `expected a split-notice warning in ${f}`);
      }
      assert.equal(totalLegs, 4, "every leg from the original route is preserved across the segment files");
    });

    t("WRITE3", "an .af section name is preserved as a prefix ahead of __segN", () => {
      const r = route([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20000, y: 0 }], { name: "afroute:navA" });
      const written = NB.writeHbRouteFiles(r, [], "corpus/some.af", "navA", tmpDir, 500);
      assert.deepEqual(written.sort(), ["corpus__some.af__navA__seg1.json", "corpus__some.af__navA__seg2.json"].sort());
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  console.log(`\nnav_batch_import: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
