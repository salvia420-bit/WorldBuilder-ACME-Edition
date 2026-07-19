// atlas_mirror.cjs disk-bridge tests (NavAtlas W2). Pure disk round-trip, no
// playwright: exercises writeAtlasJson/readAtlasJson/listMirrored against a
// throwaway dir. Exits 1 on ANY failure.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("./rynth/atlas_mirror.cjs");

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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-mirror-"));
const dump = JSON.stringify({
  key: "rynth.atlas.v1",
  version: 1,
  routes: [
    { id: "r_1", name: "holtburg->arwic", legs: [{ lb: 1, x: 0, y: 0 }, { lb: 1, x: 100, y: 0 }] },
    { id: "r_2", name: "arwic->cragstone", legs: [{ lb: 2, x: 0, y: 0 }, { lb: 2, x: 50, y: 0 }] },
  ],
});

try {
  t("M1", "write mirrors JSON + counts routes", () => {
    const res = M.writeAtlasJson(dump, { dir, account: "tailnet1" });
    assert.equal(res.routes, 2);
    assert.ok(fs.existsSync(res.file), "file written");
    assert.ok(fs.existsSync(path.join(dir, "tailnet1.meta.json")), "meta written");
  });

  t("M2", "read returns the exact JSON string back", () => {
    const back = M.readAtlasJson({ dir, account: "tailnet1" });
    assert.equal(back, dump, "byte-identical round-trip");
  });

  t("M3", "read of a missing account is null", () => {
    assert.equal(M.readAtlasJson({ dir, account: "nobody" }), null);
  });

  t("M4", "listMirrored excludes .meta files", () => {
    const list = M.listMirrored({ dir });
    assert.deepEqual(list.sort(), ["tailnet1"]);
  });

  t("M5", "account names are sanitized (no path escape)", () => {
    const res = M.writeAtlasJson(dump, { dir, account: "../../etc/passwd" });
    assert.ok(res.file.startsWith(dir), "stays inside mirror dir");
    assert.ok(!res.file.includes(".."), "traversal stripped");
  });

  t("M6", "invalid JSON is rejected, not written", () => {
    assert.throws(() => M.writeAtlasJson("{not json", { dir, account: "bad" }), /invalid JSON/);
    assert.equal(M.readAtlasJson({ dir, account: "bad" }), null, "nothing written");
  });

  t("M7", "write is atomic (no leftover .tmp files)", () => {
    M.writeAtlasJson(dump, { dir, account: "atomiccheck" });
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp."));
    assert.equal(leftovers.length, 0, "temp files cleaned up");
  });

  t("M8", "contract v2 fmt + portal/indoor flags survive the disk round-trip", () => {
    const v2dump = JSON.stringify({
      key: "rynth.atlas.v1",
      version: 1,
      routes: [
        {
          id: "r_v2",
          name: "arwic->holtburg",
          fmt: 2,
          legs: [
            { lb: 1, x: 0, y: 0, portal: true, label: "portal" },
            { lb: 459075, x: 70, y: -60, indoor: true },
          ],
        },
      ],
    });
    M.writeAtlasJson(v2dump, { dir, account: "v2acct" });
    const back = M.readAtlasJson({ dir, account: "v2acct" });
    const r = JSON.parse(back).routes[0];
    assert.equal(r.fmt, 2, "fmt preserved");
    assert.equal(r.legs[0].portal, true, "departure portal preserved");
    assert.equal(r.legs[0].label, "portal");
    assert.equal(r.legs[1].indoor, true, "indoor flag preserved");
  });
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\natlas_mirror: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
