// harness/test_catalog_regions.mjs — scripts/split-catalog-regions.mjs.
//
// What must hold:
//   - the HBNS writer/reader round-trip exactly, and the CRC is IEEE CRC32
//     (checked against node:zlib when the runtime has it);
//   - regionOf matches the Rust `CatalogRegions::region_of` table
//     (crates/holtburger-manifest/src/v2.rs tests);
//   - on the REAL deployed eor-cell catalog: every region is written (empty
//     ones included), the union of regions is exactly the source catalog, and
//     a Holtburg ring needs ~tens of KB instead of ~15 MB;
//   - --write-manifest adds `catalog_regions` and changes nothing else.
//
// Run: cd apps/holtburger-web && node harness/test_catalog_regions.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOLT = path.resolve(HERE, "../../..");
const { crc32, parseCatalog, writeCatalog, regionOf, splitCatalogRegions, DEFAULT_REGION_TEMPLATE } =
  await import(pathToFileURL(path.join(HOLT, "scripts/split-catalog-regions.mjs")).href);

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

console.log("\nformat");
{
  const h = (n) => Buffer.alloc(16, n);
  const entries = [{ id: 0x01010100, hash: h(1), size: 300 }, { id: 0x0101fffe, hash: h(2), size: 20000 }, { id: 0xfeff0001, hash: h(3), size: 1 }];
  const buf = writeCatalog({ entries });
  const back = parseCatalog(buf);
  check("round-trip ids/sizes/hashes", JSON.stringify(back.entries.map((e) => [e.id, e.size, e.hash[0]])) ===
    JSON.stringify(entries.map((e) => [e.id, e.size, e.hash[0]])));
  if (typeof zlib.crc32 === "function") {
    check("CRC32 is IEEE (== node:zlib.crc32)", crc32(Buffer.from("holtburger")) === zlib.crc32(Buffer.from("holtburger")));
  } else {
    check("CRC32 known vector ('123456789' → 0xCBF43926)", crc32(Buffer.from("123456789")) === 0xcbf43926);
  }
  const empty = parseCatalog(writeCatalog({ entries: [] }));
  check("a zero-entry region catalog is valid", empty.entries.length === 0);
  const bad = Buffer.from(buf); bad[20] ^= 0xff;
  let threw = false; try { parseCatalog(bad); } catch { threw = true; }
  check("a corrupted body fails its CRC", threw);
}

console.log("\nregion math (mirrors the Rust table)");
check("Holtburg 0xA9B40024 → region 0x2b6", regionOf(0xa9b40024, 8) === 0x2b6);
check("LandBlockInfo shares its cells' region", regionOf(0xa9b4fffe, 8) === regionOf(0xa9b40100, 8));
check("corners 0 / 1023", regionOf(0x00000001, 8) === 0 && regionOf(0xffffffff, 8) === 1023);
check("x edge 0xA8 vs 0xA7", regionOf(0xa8b40001, 8) === 0x2b6 && regionOf(0xa7b40001, 8) === 20 * 32 + 22);

console.log("\nreal deployed catalog");
const DIST = path.join(HOLT, "dist");
const srcCat = path.join(DIST, "manifest", "eor-cell.bin");
if (!fs.existsSync(srcCat)) {
  console.log("  (dist not mounted — real-data checks not run)");
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "catregions-"));
  fs.mkdirSync(path.join(tmp, "manifest"));
  fs.copyFileSync(path.join(DIST, "manifest.json"), path.join(tmp, "manifest.json"));
  fs.symlinkSync(srcCat, path.join(tmp, "manifest", "eor-cell.bin"));
  const before = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
  const r = splitCatalogRegions({ dist: tmp, namespace: "eor/cell", lbBlock: 8, writeManifest: true, quiet: true });
  const files = fs.readdirSync(r.outDir);
  check("all 1024 regions written", files.length === 1024 && r.regionCount === 1024, String(files.length));
  const src = parseCatalog(fs.readFileSync(srcCat));
  let n = 0;
  const seen = new Set();
  let misplaced = 0;
  for (const f of files) {
    const reg = Number.parseInt(f, 16);
    for (const e of parseCatalog(fs.readFileSync(path.join(r.outDir, f))).entries) {
      n += 1; seen.add(e.id);
      if (regionOf(e.id, 8) !== reg) misplaced += 1;
    }
  }
  check("union of regions == the source catalog", n === src.entries.length && seen.size === src.entries.length,
    `${n} vs ${src.entries.length}`);
  check("every entry sits in its own region's file", misplaced === 0, String(misplaced));
  const ring = new Set();
  for (let x = 0xa9 - 5; x <= 0xa9 + 5; x += 1) for (let y = 0xb4 - 5; y <= 0xb4 + 5; y += 1) ring.add(regionOf(((x << 24) >>> 0) + (y << 16), 8));
  let ringBytes = 0;
  for (const reg of ring) ringBytes += fs.statSync(path.join(r.outDir, `${reg.toString(16).padStart(3, "0")}.bin`)).size;
  check(`Holtburg r5 ring = ${ring.size} regions, ${(ringBytes / 1024).toFixed(0)} KiB (vs ${(fs.statSync(srcCat).size / 1048576).toFixed(1)} MiB whole)`,
    ringBytes < 100 * 1024);
  const after = JSON.parse(fs.readFileSync(path.join(tmp, "manifest.json"), "utf8"));
  check("manifest gains catalog_regions for eor/cell",
    after.catalog_regions?.["eor/cell"]?.lb_block === 8 && after.catalog_regions["eor/cell"].url_template === DEFAULT_REGION_TEMPLATE);
  const strip = (m) => { const c = { ...m }; delete c.catalog_regions; return JSON.stringify(c); };
  check("…and nothing else in the manifest changed (bake identity intact)", strip(after) === strip(before));
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
