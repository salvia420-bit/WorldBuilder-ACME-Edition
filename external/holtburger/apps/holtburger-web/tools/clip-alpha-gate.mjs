#!/usr/bin/env node
// tools/clip-alpha-gate.mjs — the BAKE/INGEST-side twin of the runtime
// CLIP-ALPHA guard (`bc7ClipAlphaGateFor` in scene3d/bc7_textures.js).
//
// WHY THIS EXISTS (2026-10-07)
// ----------------------------
// The owner's "grass isnt transparent and has black background" (reed clumps,
// Surface 0x080000A1 / rs 0x0600385A) was a `holtburger/tex-xu7` record that
// lost its ClipMap transparency: retail `ImgTex::CopyIntoData`
// (acclient.c:365907) clears a ClipMap paletted texel whose index is < 8, the
// Remacri corpus behind the xu7 lane was exported before our exporter learned
// that rule (494b1aea), and basisu then faithfully encoded an opaque image.
// The encoders are not at fault — bc7cli and basisu encode the alpha they are
// handed — so the gate belongs where a payload ENTERS the dist: compare every
// alpha-sampling Surface's DAT-truth cutout against the payload a lane would
// ship for its RenderSurface, using the SAME decision code the client runs
// (`bc7AlphaFloor`, `clipCutFor` mirrors `clipAlphaCutOf`).
//
// WHAT IT DOES
//   * DAT truth from a portal DAT (`--dat`, B-tree read) or a dist's
//     `eor/portal` namespace (`--truth-dist`), decoded with the client's rules
//     (holtburger-dat texture.rs: ClipMap paletted index < 8 -> alpha 0, DXT1
//     punch-through, DXT3/5 alpha, A8R8G8B8 / A4R4G4B4 alpha; A8 and the
//     lscape formats decode opaque, as the client does).
//   * Payloads from a dist namespace (`--lane-dist <dist> --ns <ns>`) or an
//     ingest directory (`--xu7-dir` of `<rsId>.ktx2`, `--bc7-dir` of
//     `<rsId>.hbc7`). xu7 payloads are transcoded with the vendored basisu
//     transcoder, exactly as the client does.
//   * A row is REFUSED when the Surface's decoded albedo has a texel under its
//     cut and the payload's BC7 alpha floor is >= the cut.
//
// OUTPUTS
//   --out <file.jsonl>       one row per checked Surface (refused or not)
//   --exclude-out <file>     the refused RenderSurface ids, one per line
//   --filtered-dir <dir>     (dir lanes only) a symlink farm of the ingest dir
//                            WITHOUT the refused ids — feed it to
//                            `dat-shard --tex-xu7 <dir>` / `--tex-bc7 <dir>`;
//                            the client then falls back to the next lane
//                            (xu7 -> tex-bc7) for those surfaces.
//   --fail-on-refusal        exit 1 when anything is refused (CI gate).
//
// RE-BAKE RECIPE for the tex-xu7 lane (measured 2026-10-07; not run here):
//   1. Gate the CURRENT ingest corpus (xu7-ingest/*.ktx2 are symlinks into
//      xubc7-corpus/*-lossless, re-encoded 2026-08-09 by texfix-fringe, which
//      already fixes 226 of the 254 refused rows the served dist ships):
//        node tools/clip-alpha-gate.mjs --dat ~/ac_base_dats/client_portal.dat \
//          --xu7-dir /mnt/wbterminal2/xu7-ingest \
//          --filtered-dir /mnt/wbterminal2/xu7-ingest-clipsafe \
//          --exclude-out /mnt/wbterminal2/xu7-ingest-clipsafe.refused.txt
//      -> 3,963 linked, 22 RenderSurfaces left out (28 Surfaces). A left-out id
//         has no xu7 record, so the client takes its tex-bc7 record, which
//         keeps the cutout for every one of them.
//   2. Re-ingest the lane from the filtered dir, e.g. a namespace-only staging
//      run (dat-shard accepts `--tex-xu7` without `--input`):
//        target/release/dat-shard --tex-xu7 /mnt/wbterminal2/xu7-ingest-clipsafe \
//          --output <staging> --manifest-version 2
//      then copy <staging>/manifest/holtburger-tex-xu7.bin and the new
//      <staging>/shards/** into the dist (shards are content-addressed, so the
//      copy is additive) — or re-run the full dist bake with that --tex-xu7.
//   3. Verify: --truth-dist <dist> --lane-dist <dist> --ns holtburger/tex-xu7
//      --fail-on-refusal must exit 0. Then load with ?nosw=1 (the service
//      worker caches shards).
//   A real re-encode of the 22 left-out ids (rather than dropping them) needs
//   a keyed source: the corrected retail-res export in
//   /mnt/wbterminal2/tex-reexport-2026-07-30/<rs>.png, colour-bled under the
//   cleared texels, upscaled, then the nearest-x4 DAT mask re-imposed before
//   `basisu -xubc7` (xubc7-corpus/encode_lossless.sh).
//
// EXAMPLES (read-only; heavy only in the sense of transcoding ~700 payloads,
// ~20 s, one core):
//   node tools/clip-alpha-gate.mjs --truth-dist /mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2 \
//        --lane-dist /mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2 --ns holtburger/tex-xu7
//   node tools/clip-alpha-gate.mjs --dat ~/ac_base_dats/client_portal.dat \
//        --xu7-dir /mnt/wbterminal2/xu7-ingest --filtered-dir /mnt/wbterminal2/xu7-ingest-clipsafe \
//        --exclude-out /mnt/wbterminal2/xu7-clip-refused.txt

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bc7AlphaFloor, parseHbc7 } from "../scene3d/bc7_textures.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

// Surface (0x08) type bits — ACE SurfaceType.cs.
export const SURFACE = Object.freeze({
  Base1Image: 0x2,
  Base1ClipMap: 0x4,
  Translucent: 0x10,
  Alpha: 0x100,
  InvAlpha: 0x200,
  Additive: 0x10000,
});

// RenderSurface pixel formats (holtburger-dat texture.rs SurfacePixelFormat).
export const PF = Object.freeze({
  R8G8B8: 20, A8R8G8B8: 21, R5G6B5: 23, A4R4G4B4: 26, A8: 28, P8: 41, INDEX16: 101,
  LSCAPE_R8G8B8: 243, LSCAPE_ALPHA: 244, RAW_JPEG: 500,
  DXT1: 827611204, DXT2: 844388420, DXT3: 861165636, DXT4: 877942852, DXT5: 894720068,
});
const PF_NAME = Object.fromEntries(Object.entries(PF).map(([k, v]) => [v, k]));

// --------------------------------------------------------------------------
// record readers
// --------------------------------------------------------------------------

/**
 * Read-only B-tree reader for a retail portal DAT (the same directory walk
 * test_terrain_round.mjs uses for the cell DAT). `read(id)` -> Uint8Array |
 * null; `ids(typeByte)` -> ascending ids whose top byte matches.
 */
export function openPortalDat(file) {
  const fd = fs.openSync(file, "r");
  const hdr = Buffer.alloc(36);
  fs.readSync(fd, hdr, 0, 36, 0x140);
  const blockSize = hdr.readUInt32LE(4);
  const root = hdr.readUInt32LE(32);
  const readAt = (len, off) => {
    const b = Buffer.alloc(len);
    fs.readSync(fd, b, 0, len, off);
    return b;
  };
  const readData = (offset, size) => {
    const out = Buffer.alloc(size);
    let cur = offset;
    let done = 0;
    while (done < size) {
      const next = readAt(4, cur).readUInt32LE(0);
      const take = next === 0 ? size - done : Math.min(size - done, blockSize - 4);
      readAt(take, cur + 4).copy(out, done);
      done += take;
      cur = next;
    }
    return out;
  };
  const node = (off) => {
    const d = readData(off, 1716);
    const count = d.readUInt32LE(248);
    const leaf = d.readUInt32LE(0) === 0;
    const entries = [];
    for (let i = 0; i < count; i += 1) {
      const e = 252 + 24 * i;
      entries.push({ id: d.readUInt32LE(e + 4), offset: d.readUInt32LE(e + 8), size: d.readUInt32LE(e + 12) });
    }
    const branches = [];
    if (!leaf) for (let i = 0; i <= count; i += 1) branches.push(d.readUInt32LE(4 * i));
    return { leaf, entries, branches };
  };
  const find = (id) => {
    let off = root;
    for (let depth = 0; off && depth < 32; depth += 1) {
      const n = node(off);
      let i = 0;
      for (; i < n.entries.length; i += 1) {
        if (n.entries[i].id === id) return n.entries[i];
        if (n.entries[i].id > id) break;
      }
      if (n.leaf) return null;
      off = n.branches[i];
    }
    return null;
  };
  return {
    read(id) {
      const e = find(id >>> 0);
      if (!e) return null;
      const b = readData(e.offset, e.size);
      return new Uint8Array(b.buffer, b.byteOffset, b.length);
    },
    ids(typeByte) {
      const out = [];
      const walk = (off, depth) => {
        if (!off || depth > 32) return;
        const n = node(off);
        for (let i = 0; i < n.entries.length; i += 1) {
          if (!n.leaf) walk(n.branches[i], depth + 1);
          if (n.entries[i].id >>> 24 === typeByte) out.push(n.entries[i].id >>> 0);
        }
        if (!n.leaf) walk(n.branches[n.entries.length], depth + 1);
      };
      walk(root, 0);
      return out.sort((a, b) => a - b);
    },
    close() {
      fs.closeSync(fd);
    },
  };
}

/** Parse one v2 per-namespace catalog (`HBNS`, crates/holtburger-manifest
 *  catalog.rs): id -> { sha (hex, as the shard file is named), size }. */
export function readNamespaceCatalog(file) {
  const b = fs.readFileSync(file);
  if (b.toString("latin1", 0, 4) !== "HBNS") throw new Error(`not an HBNS catalog: ${file}`);
  const shaLen = b[5] & 1 ? 32 : 16;
  const count = b.readUInt32LE(8);
  let o = 16;
  let id = 0;
  const uleb = () => {
    let v = 0;
    let s = 0;
    let x;
    do {
      x = b[o++];
      v += (x & 0x7f) * 2 ** s;
      s += 7;
    } while (x & 0x80);
    return v;
  };
  const map = new Map();
  for (let i = 0; i < count; i += 1) {
    id = (id + uleb()) >>> 0;
    const sha = b.toString("hex", o, o + shaLen);
    o += shaLen;
    map.set(id, { sha, size: uleb() });
  }
  return map;
}

/** Read records out of a v2 dist (catalog + CAS shards, one record per shard). */
export function openDistRecords(root) {
  const cats = new Map();
  const cat = (ns) => {
    if (!cats.has(ns)) {
      const f = path.join(root, "manifest", ns.replace("/", "-") + ".bin");
      cats.set(ns, fs.existsSync(f) ? readNamespaceCatalog(f) : new Map());
    }
    return cats.get(ns);
  };
  return {
    has: (ns, id) => cat(ns).has(id >>> 0),
    ids: (ns) => [...cat(ns).keys()].sort((a, b) => a - b),
    read(ns, id) {
      const e = cat(ns).get(id >>> 0);
      if (!e) return null;
      const f = path.join(root, "shards", e.sha.slice(0, 2), e.sha + ".bin");
      const b = fs.readFileSync(f);
      if (b.length !== e.size) throw new Error(`${f}: ${b.length} B, catalog says ${e.size}`);
      return new Uint8Array(b.buffer, b.byteOffset, b.length);
    },
  };
}

// --------------------------------------------------------------------------
// DAT truth
// --------------------------------------------------------------------------

/**
 * The alpha plane the CLIENT decodes for one RenderSurface (0x06), plus its
 * shape. `read(id)` returns a raw DAT record. `clip` = some Base1ClipMap
 * Surface references it (retail's index < 8 rule is a Surface property).
 * @returns {{w:number,h:number,fmt:string,hasPalette:boolean,alpha:Uint8Array|null}|null}
 */
export function decodeAlphaPlane(read, rsId, clip) {
  const b = read(rsId >>> 0);
  if (!b || b.length < 24) return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const w = v.getInt32(8, true);
  const h = v.getInt32(12, true);
  const fmt = v.getUint32(16, true);
  const len = v.getInt32(20, true);
  if (!(w > 0 && h > 0) || len < 0 || 24 + len > b.length) return null;
  const src = b.subarray(24, 24 + len);
  const n = w * h;
  const out = { w, h, fmt: PF_NAME[fmt] || String(fmt), hasPalette: false, alpha: new Uint8Array(n) };
  const a = out.alpha;
  switch (fmt) {
    case PF.R8G8B8: case PF.R5G6B5: case PF.LSCAPE_R8G8B8: case PF.RAW_JPEG:
    case PF.A8: case PF.LSCAPE_ALPHA: // client decodes these two as opaque greyscale
      a.fill(255);
      return out;
    case PF.A8R8G8B8:
      if (src.length < n * 4) return null;
      for (let i = 0; i < n; i += 1) a[i] = src[i * 4 + 3];
      return out;
    case PF.A4R4G4B4:
      if (src.length < n * 2) return null;
      for (let i = 0; i < n; i += 1) a[i] = (src[i * 2 + 1] >> 4) * 17;
      return out;
    case PF.P8: case PF.INDEX16: {
      out.hasPalette = true;
      const wide = fmt === PF.INDEX16;
      if (src.length < n * (wide ? 2 : 1) || 24 + len + 4 > b.length) return null;
      const pal = read(v.getUint32(24 + len, true));
      if (!pal) return null;
      const pv = new DataView(pal.buffer, pal.byteOffset, pal.byteLength);
      const count = Math.max(0, pv.getInt32(4, true));
      for (let i = 0; i < n; i += 1) {
        const idx = wide ? src[i * 2] | (src[i * 2 + 1] << 8) : src[i];
        if (clip && idx < 8) a[i] = 0;
        else a[i] = idx < count ? pal[8 + 4 * idx + 3] : 255;
      }
      return out;
    }
    case PF.DXT1: case PF.DXT2: case PF.DXT3: case PF.DXT4: case PF.DXT5: {
      const bs = fmt === PF.DXT1 ? 8 : 16;
      const bw = Math.ceil(w / 4);
      const bh = Math.ceil(h / 4);
      if (src.length < bw * bh * bs) return null;
      const vals = new Uint8Array(16);
      for (let by = 0; by < bh; by += 1) {
        for (let bx = 0; bx < bw; bx += 1) {
          const o = (by * bw + bx) * bs;
          if (fmt === PF.DXT1) {
            const c0 = src[o] | (src[o + 1] << 8);
            const c1 = src[o + 2] | (src[o + 3] << 8);
            const idx = (src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24)) >>> 0;
            for (let t = 0; t < 16; t += 1) vals[t] = c0 <= c1 && ((idx >>> (2 * t)) & 3) === 3 ? 0 : 255;
          } else if (fmt === PF.DXT2 || fmt === PF.DXT3) {
            for (let t = 0; t < 16; t += 1) vals[t] = ((src[o + (t >> 1)] >> ((t & 1) * 4)) & 0xf) * 17;
          } else {
            const a0 = src[o];
            const a1 = src[o + 1];
            const tab = [a0, a1];
            if (a0 > a1) for (let k = 1; k < 7; k += 1) tab.push(Math.floor(((7 - k) * a0 + k * a1) / 7));
            else {
              for (let k = 1; k < 5; k += 1) tab.push(Math.floor(((5 - k) * a0 + k * a1) / 5));
              tab.push(0, 255);
            }
            for (let t = 0; t < 16; t += 1) {
              const bit = 16 + 3 * t; // index bits start at byte 2
              const byte = o + (bit >> 3);
              const sel = ((src[byte] | (src[byte + 1] << 8)) >> (bit & 7)) & 7;
              vals[t] = tab[sel];
            }
          }
          for (let t = 0; t < 16; t += 1) {
            const x = bx * 4 + (t & 3);
            const y = by * 4 + (t >> 2);
            if (x < w && y < h) a[y * w + x] = vals[t];
          }
        }
      }
      return out;
    }
    default:
      out.alpha = null; // undecodable here (the client may still render it)
      return out;
  }
}

/** The client's cut (scene3d/bc7_textures.js `clipAlphaCutOf`) for a Surface,
 *  derived from its type bits the way `applySurfaceRenderState` /
 *  `applyClipMapRenderState` build the material: the blend branch is tested
 *  BEFORE ClipMap, so a blended ClipMap is a 128 cut, not an alpha test. */
export function clipCutFor({ clip, blended, hasPalette }) {
  if (blended) return 128;
  if (clip) return hasPalette ? 100 : 200; // CLIPMAP_ALPHA_REF_PALETTED / _DDS
  return 0;
}

/**
 * DAT-truth facts for one Surface: null when it is solid-colour, ignores map
 * alpha, or its RenderSurface cannot be decoded here.
 */
export function surfaceAlphaFacts(read, surfaceId) {
  const sb = read(surfaceId >>> 0);
  if (!sb || sb.length < 8) return null;
  const sv = new DataView(sb.buffer, sb.byteOffset, sb.byteLength);
  const type = sv.getUint32(0, true);
  if (!(type & (SURFACE.Base1Image | SURFACE.Base1ClipMap))) return null;
  const clip = !!(type & SURFACE.Base1ClipMap);
  const blended = !!(type & (SURFACE.Translucent | SURFACE.Alpha | SURFACE.InvAlpha | SURFACE.Additive));
  if (!clip && !blended) return null; // a plain image never samples map alpha
  const st = read(sv.getUint32(4, true));
  if (!st || st.length < 13) return null;
  const tv = new DataView(st.buffer, st.byteOffset, st.byteLength);
  const count = tv.getInt32(9, true);
  if (count <= 0 || 13 + 4 * count > st.length) return null;
  const rs = tv.getUint32(13 + 4 * (count - 1), true); // highest-res rung
  const plane = decodeAlphaPlane(read, rs, clip);
  if (!plane || !plane.alpha) return null;
  const cut = clipCutFor({ clip, blended, hasPalette: plane.hasPalette });
  let below = 0;
  for (let i = 0; i < plane.alpha.length; i += 1) if (plane.alpha[i] < cut) below += 1;
  return {
    surfaceId: surfaceId >>> 0, type, rs, clip, blended, cut,
    fmt: plane.fmt, w: plane.w, h: plane.h, hasPalette: plane.hasPalette,
    below, keyed: below > 0, alpha: plane.alpha,
  };
}

// --------------------------------------------------------------------------
// payloads
// --------------------------------------------------------------------------

let _xu7 = null;
/** Lazily load the client's xu7 module + the vendored basisu transcoder. */
export async function loadXu7Transcoder() {
  if (_xu7) return _xu7;
  const xu7 = await import("../scene3d/xu7_textures.js");
  const require2 = createRequire(path.join(APP_ROOT, "x.js"));
  const BASIS = require2(path.join(APP_ROOT, "scene3d/transcoder/basis_transcoder.js"));
  if (typeof globalThis.window === "undefined") {
    globalThis.window = { location: { search: "?xu7Budget=off&texWorkers=off" } };
  }
  xu7._setXu7ModuleForTest(BASIS().then((m) => {
    m.initializeBasis();
    return m;
  }));
  await xu7.xu7Transcoder();
  _xu7 = xu7;
  return xu7;
}

/** bytes -> parsed `{width,height,levels}` for either container. */
export async function parsePayload(bytes, kind) {
  if (!bytes || bytes.length === 0) return null;
  if (kind === "xu7") return (await loadXu7Transcoder()).transcodeXu7(bytes);
  return parseHbc7(bytes);
}

/** Does this payload drop the cutout? `{refused, floor}`. */
export function judgePayload(facts, parsed) {
  const floor = bc7AlphaFloor(parsed, facts.cut);
  return { floor, refused: !!facts.keyed && floor >= 0 && floor >= facts.cut };
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function parseArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    if (k === "fail-on-refusal") o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

const hex8 = (v) => "0x" + (v >>> 0).toString(16).toUpperCase().padStart(8, "0");

async function main() {
  const o = parseArgs(process.argv.slice(2));
  let read;
  if (o.dat) {
    const dat = openPortalDat(o.dat);
    read = (id) => dat.read(id);
    read.surfaceIds = () => dat.ids(0x08);
  } else if (o["truth-dist"]) {
    const d = openDistRecords(o["truth-dist"]);
    read = (id) => {
      try { return d.read("eor/portal", id); } catch (_) { return null; }
    };
    read.surfaceIds = () => d.ids("eor/portal").filter((id) => id >>> 24 === 0x08);
  } else {
    console.error("need --dat <client_portal.dat> or --truth-dist <dist>");
    process.exit(2);
  }
  let lane;
  if (o["lane-dist"]) {
    const d = openDistRecords(o["lane-dist"]);
    const ns = o.ns || "holtburger/tex-xu7";
    const kind = ns.endsWith("xu7") ? "xu7" : "hbc7";
    lane = { name: ns, kind, has: (rs) => d.has(ns, rs), bytes: (rs) => d.read(ns, rs) };
  } else if (o["xu7-dir"] || o["bc7-dir"]) {
    const dir = o["xu7-dir"] || o["bc7-dir"];
    const kind = o["xu7-dir"] ? "xu7" : "hbc7";
    const ext = kind === "xu7" ? ".ktx2" : ".hbc7";
    const file = (rs) => path.join(dir, hex8(rs) + ext);
    lane = {
      name: dir, kind, dir, ext,
      has: (rs) => fs.existsSync(file(rs)),
      bytes: (rs) => new Uint8Array(fs.readFileSync(file(rs))),
    };
  } else {
    console.error("need --lane-dist <dist> [--ns <namespace>] or --xu7-dir <dir> or --bc7-dir <dir>");
    process.exit(2);
  }
  const only = o.surfaces ? new Set(o.surfaces.split(",").map((s) => parseInt(s, 16) >>> 0)) : null;
  const rows = [];
  const memo = new Map();
  let eligible = 0;
  let keyed = 0;
  for (const sid of read.surfaceIds()) {
    if (only && !only.has(sid)) continue;
    const f = surfaceAlphaFacts(read, sid);
    if (!f) continue;
    eligible += 1;
    if (!f.keyed) continue;
    keyed += 1;
    if (!lane.has(f.rs)) continue;
    if (!memo.has(f.rs)) {
      let parsed = null;
      try { parsed = await parsePayload(lane.bytes(f.rs), lane.kind); } catch (_) { parsed = null; }
      memo.set(f.rs, parsed ? { parsed: null, width: parsed.width, height: parsed.height, floor255: bc7AlphaFloor(parsed) } : null);
    }
    const p = memo.get(f.rs);
    if (!p) continue;
    const refused = p.floor255 >= 0 && p.floor255 >= f.cut;
    rows.push({
      surface: hex8(sid), type: "0x" + f.type.toString(16), rs: hex8(f.rs), fmt: f.fmt, w: f.w, h: f.h,
      clip: f.clip, blended: f.blended, cut: f.cut, below: f.below,
      belowPct: +((100 * f.below) / (f.w * f.h)).toFixed(2),
      fullyTransparent: f.below === f.w * f.h,
      payload: { lane: lane.name, w: p.width, h: p.height, floor: p.floor255 },
      refused,
    });
  }
  const refusedRows = rows.filter((r) => r.refused);
  const refusedRs = [...new Set(refusedRows.map((r) => r.rs))].sort();
  const byFmt = {};
  for (const r of refusedRows) byFmt[r.fmt] = (byFmt[r.fmt] || 0) + 1;
  if (o.out) fs.writeFileSync(o.out, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  if (o["exclude-out"]) fs.writeFileSync(o["exclude-out"], refusedRs.join("\n") + (refusedRs.length ? "\n" : ""));
  if (o["filtered-dir"]) {
    if (!lane.dir) {
      console.error("--filtered-dir needs a directory lane (--xu7-dir / --bc7-dir)");
      process.exit(2);
    }
    const out = o["filtered-dir"];
    fs.mkdirSync(out, { recursive: true });
    const drop = new Set(refusedRs.map((s) => s.toLowerCase()));
    let linked = 0;
    let dropped = 0;
    for (const name of fs.readdirSync(lane.dir).sort()) {
      if (!name.endsWith(lane.ext)) continue;
      if (drop.has(name.slice(0, -lane.ext.length).toLowerCase())) { dropped += 1; continue; }
      const target = fs.realpathSync(path.join(lane.dir, name));
      const link = path.join(out, name);
      try { fs.unlinkSync(link); } catch (_) { /* fresh */ }
      fs.symlinkSync(target, link);
      linked += 1;
    }
    console.log(`filtered-dir ${out}: ${linked} linked, ${dropped} refused ids left out`);
  }
  const summary = {
    lane: lane.name, eligibleSurfaces: eligible, keyedSurfaces: keyed, checked: rows.length,
    refusedSurfaces: refusedRows.length, refusedRenderSurfaces: refusedRs.length,
    refusedFullyTransparent: refusedRows.filter((r) => r.fullyTransparent).length,
    refusedBlended: refusedRows.filter((r) => r.blended).length, refusedByFormat: byFmt,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (o["fail-on-refusal"] && refusedRows.length > 0) process.exit(1);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(2);
  });
}
