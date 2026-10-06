#!/usr/bin/env node
// scripts/split-catalog-regions.mjs — regional namespace catalogs (2026-10-06).
//
// WHY: `manifest/eor-cell.bin` is 805k entries / 15.4 MB and does not compress
// (truncated sha256s: 14 MB on the wire). The client fetches it on the FIRST
// lookup of any cell record — terrain heightmaps included — and that lookup
// round waits for all of it: ~3 min at 666 kbps before a single cell shard can
// be requested, for a Holtburg session that needed 296 entries. This splits a
// namespace catalog into one HBNS catalog per lb_block×lb_block landblock
// region (holtburger-manifest `CatalogRegions`), so a session fetches only the
// regions it stands in (Holtburg ring: 6 regions, ~25 KB).
//
// Output (additive — the whole-namespace catalog stays for older clients):
//   <dist>/manifest/regions/<namespace_slug>/<region:03x>.bin   EVERY region,
//       empty ones as valid zero-entry catalogs (the client treats a region
//       404 as a deploy fault, never as "absent" — see manifest_source.rs)
//   <dist>/manifest.json  gains  "catalog_regions": { "<ns>": {
//       "url_template": "manifest/regions/{namespace_slug}/{region}.bin",
//       "lb_block": 8 } }        (only with --write-manifest)
//
// Region of a file id: (lbx / B) * (256 / B) + (lby / B), lbx = id >> 24,
// lby = (id >> 16) & 0xFF — must match `CatalogRegions::region_of` (Rust).
// The catalog format is HBNS v1 (crates/holtburger-manifest/src/catalog.rs):
// 16-byte header, ULEB128 id deltas + sha256 prefix + ULEB128 size, CRC32
// (IEEE) footer + "SNBH". Every written file is re-read and CRC-checked, and
// the union of regions is checked to equal the source catalog before
// manifest.json is touched.
//
// USAGE
//   node scripts/split-catalog-regions.mjs [--dist <dir>] [--namespace eor/cell]
//        [--lb-block 8] [--write-manifest] [--quiet]
// Test: apps/holtburger-web/harness/test_catalog_regions.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

export const DEFAULT_REGION_TEMPLATE = "manifest/regions/{namespace_slug}/{region}.bin";
const MAGIC = Buffer.from("HBNS");
const TRAILING = Buffer.from("SNBH");

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function readUleb(buf, pos) {
  let v = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("ULEB128 runs past the end");
    const b = buf[pos++];
    v += (b & 0x7f) * 2 ** shift;
    if (b < 0x80) return [v, pos];
    shift += 7;
    if (shift > 35) throw new Error("ULEB128 too long");
  }
}
function writeUleb(out, v) {
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
}

/** Parse an HBNS v1 catalog. Returns { version, flags, hashLen, entries:[{id, hash:Buffer, size}] }. */
export function parseCatalog(buf) {
  if (buf.length < 24) throw new Error("catalog shorter than header + footer");
  if (!buf.subarray(0, 4).equals(MAGIC)) throw new Error("bad magic");
  if (!buf.subarray(buf.length - 4).equals(TRAILING)) throw new Error("bad trailing magic");
  const version = buf[4];
  const flags = buf[5];
  if (version !== 1) throw new Error(`unsupported catalog version ${version}`);
  const body = buf.subarray(0, buf.length - 8);
  const stored = buf.readUInt32LE(buf.length - 8);
  if (crc32(body) !== stored) throw new Error("CRC mismatch");
  const count = buf.readUInt32LE(8);
  const hashLen = flags & 1 ? 32 : 16;
  const entries = new Array(count);
  let pos = 16;
  let id = 0;
  for (let i = 0; i < count; i += 1) {
    let d;
    [d, pos] = readUleb(body, pos);
    id += d;
    const hash = body.subarray(pos, pos + hashLen);
    pos += hashLen;
    let size;
    [size, pos] = readUleb(body, pos);
    entries[i] = { id, hash, size };
  }
  if (pos !== body.length) throw new Error(`${body.length - pos} trailing bytes in the entry stream`);
  return { version, flags, hashLen, entries };
}

/** Serialize entries (ascending id) as an HBNS v1 catalog. */
export function writeCatalog({ version = 1, flags = 0, entries }) {
  const head = Buffer.alloc(16);
  MAGIC.copy(head, 0);
  head[4] = version;
  head[5] = flags;
  head.writeUInt32LE(entries.length, 8);
  const parts = [head];
  let prev = 0;
  for (const e of entries) {
    if (e.id < prev) throw new Error("entries must be ascending");
    const pre = [];
    writeUleb(pre, e.id - prev);
    parts.push(Buffer.from(pre), e.hash);
    const post = [];
    writeUleb(post, e.size);
    parts.push(Buffer.from(post));
    prev = e.id;
  }
  const body = Buffer.concat(parts);
  const foot = Buffer.alloc(8);
  foot.writeUInt32LE(crc32(body), 0);
  TRAILING.copy(foot, 4);
  return Buffer.concat([body, foot]);
}

export function regionOf(id, lbBlock) {
  const perAxis = 256 / lbBlock;
  const lbx = Math.floor(id / 0x1000000) & 0xff;
  const lby = (id >>> 16) & 0xff;
  return Math.floor(lbx / lbBlock) * perAxis + Math.floor(lby / lbBlock);
}

const slug = (ns) => ns.replaceAll("/", "-");

export function splitCatalogRegions({
  dist = path.join(ROOT, "dist"),
  namespace = "eor/cell",
  lbBlock = 8,
  writeManifest = false,
  quiet = false,
} = {}) {
  if (!(lbBlock >= 1 && lbBlock <= 256 && (lbBlock & (lbBlock - 1)) === 0)) {
    throw new Error(`lb_block ${lbBlock} must be a power of two in 1..256`);
  }
  const manifestPath = path.join(dist, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.catalog_url_template) throw new Error("manifest declares no catalog_url_template");
  if (!(manifest.namespaces || []).includes(namespace)) throw new Error(`namespace ${namespace} not declared`);
  const srcRel = manifest.catalog_url_template.replace("{namespace_slug}", slug(namespace));
  const src = parseCatalog(fs.readFileSync(path.join(dist, srcRel)));

  const regionCount = (256 / lbBlock) ** 2;
  const buckets = Array.from({ length: regionCount }, () => []);
  for (const e of src.entries) buckets[regionOf(e.id, lbBlock)].push(e);

  const outDir = path.join(dist, DEFAULT_REGION_TEMPLATE.replace("{namespace_slug}", slug(namespace)).replace("/{region}.bin", ""));
  // Write to a staging dir and swap in, so a live server never serves a
  // half-written region set.
  const stage = `${outDir}.staging-${process.pid}`;
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  let total = 0;
  let bytes = 0;
  let maxBytes = 0;
  for (let r = 0; r < regionCount; r += 1) {
    const buf = writeCatalog({ version: src.version, flags: src.flags, entries: buckets[r] });
    const back = parseCatalog(buf); // CRC + structure round-trip
    if (back.entries.length !== buckets[r].length) throw new Error(`region ${r} round-trip lost entries`);
    fs.writeFileSync(path.join(stage, `${r.toString(16).padStart(3, "0")}.bin`), buf);
    total += back.entries.length;
    bytes += buf.length;
    maxBytes = Math.max(maxBytes, buf.length);
  }
  if (total !== src.entries.length) throw new Error(`regions hold ${total} entries, source has ${src.entries.length}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(outDir), { recursive: true });
  fs.renameSync(stage, outDir);

  if (writeManifest) {
    const next = { ...manifest };
    next.catalog_regions = {
      ...(manifest.catalog_regions || {}),
      [namespace]: { url_template: DEFAULT_REGION_TEMPLATE, lb_block: lbBlock },
    };
    const tmp = `${manifestPath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
    fs.renameSync(tmp, manifestPath);
  }
  if (!quiet) {
    console.log(
      `[split-catalog-regions] ${namespace}: ${src.entries.length} entries → ${regionCount} regions ` +
        `(lb_block ${lbBlock}) under ${path.relative(dist, outDir)}/ — ${(bytes / 1048576).toFixed(1)} MiB total, ` +
        `largest ${(maxBytes / 1024).toFixed(0)} KiB${writeManifest ? "; manifest.json updated" : ""}`
    );
  }
  return { regionCount, entries: total, bytes, maxBytes, outDir };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k, d) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  try {
    splitCatalogRegions({
      dist: path.resolve(arg("--dist", path.join(ROOT, "dist"))),
      namespace: arg("--namespace", "eor/cell"),
      lbBlock: Number(arg("--lb-block", "8")),
      writeManifest: process.argv.includes("--write-manifest"),
      quiet: process.argv.includes("--quiet"),
    });
  } catch (e) {
    console.error(`[split-catalog-regions] FAILED: ${e.message}`);
    process.exit(1);
  }
}
