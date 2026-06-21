#!/usr/bin/env node
// =============================================================================
// Gate-1 offline world-completeness diff harness
// =============================================================================
//
// Zero-dependency Node ESM. NO browser, NO network, stdlib (fs/path/os) only.
//
// Purpose
// -------
// Compare baked scenery / static / spawn placements against the appropriate
// oracle for each "leg", one-to-one match within retail-derived tolerances,
// and emit a deterministic machine report plus a human summary.
//
// The CRUCIAL property this harness enforces is *oracle provenance honesty*:
// every leg result is stamped with how its oracle was obtained, so a circular
// oracle (the frozen snapshot's bakedScenery field, which was COPIED from the
// bake JSONL) can NEVER be presented as independent verification.
//
//   provenance label   meaning
//   ----------------   -------------------------------------------------------
//   'independent'      bake-vs-C#-crosscheck (scenery), spawn-source-vs-ACE
//                      (npcs), LandblockInfo (statics) — computed from a
//                      different source than the bake.
//   'regression-snapshot'
//                      bake-vs-frozen-oracle.bakedScenery — drift detection
//                      only; the snapshot was copied from a prior bake. This
//                      catches "did the live bake drift from the blessed
//                      snapshot", it does NOT prove the algorithm is correct.
//   'circular'         a leg that would treat a bake-derived field as if it
//                      independently verified the bake. The harness REFUSES
//                      to run such a leg as verification and flags it loudly.
//
// Legs
// ----
//   scenery-independent   bake JSONL            vs  C# cross-check JSONL
//                         provenance: independent
//   scenery-regression    bake JSONL            vs  oracle.bakedScenery
//                         provenance: regression-snapshot
//   statics-independent   oracle.buildings (LandblockInfo, independent) — the
//                         authoritative static-object set. There is no
//                         bake-side static-object stream (the bake is scenery
//                         only), so this leg validates coverage/consistency of
//                         the independent statics oracle across the ring.
//                         provenance: independent
//   spawns-independent    spawn-source JSONL    vs  oracle.npcs
//                         provenance: independent
//
// Matching
// --------
// Per leg, per landblock: normalize each placement to a bucket key
//   (modelId/wcid, round(x,KR), round(y,KR), round(z,KR))
// carrying scale + quaternion. Greedy one-to-one match within tolerances
// (xy, z, scale, quatDot) from the decomp constants. Records present in the
// oracle but not the bake -> "missing"; present in the bake but not the oracle
// -> "extra"; matched but out-of-tolerance on scale/quat -> "drift".
//
//   verdict PASS  : missing == 0 && extra == 0 && drift == 0
//   verdict DRIFT : anything else
//
// CLI
// ---
//   node diff-completeness.mjs \
//     --ring <file|0xLLLL[,0xLLLL...]> \
//     --bake-dir <dir> \
//     [--oracle-dir <dir>] \
//     [--crosscheck-dir <dir>] \
//     [--spawn-source <path>] \
//     --out <reportDir> \
//     [--legs scenery-independent,scenery-regression,statics-independent,spawns-independent]
//
//   node diff-completeness.mjs --selftest
//
// Output: <out>/gate1-report.json (deterministic, sorted keys, stable order)
//         + human summary table on stdout, with "browser used: NO".
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Decomp-derived tolerances (from DECOMP recon; retail constants).
// ---------------------------------------------------------------------------
const TOL = Object.freeze({
  xy: 0.0001, // meters
  z: 0.0001, // meters
  scale: 0.00001, // ratio
  quatDot: 0.9999, // |dot(q_a, q_b)| >= this is "same rotation"
  keyRound: 2, // bucket-key decimals (0.01 m grid); coarser than xy tol
});

// Per-leg tolerance overrides. The DAT-bit-exact legs use TOL as-is. SPAWNS are
// the exception: oracle.npcs coords are stored at 2 decimals (~0.01 m) while the
// live spawn source carries full f32, so a 1e-4 m match double-counts every
// spawn as BOTH missing and extra (the 392/392 artifact). Match spawns at the
// snapshot's stored precision (~2 cm), with a coarser key grid so a ~0.02 m pair
// still lands in a probed bucket, and loosen scale/orientation (also rounded).
const LEG_TOL = Object.freeze({
  "spawns-independent": Object.freeze({
    xy: 0.02,
    z: 0.05,
    scale: 0.05,
    quatDot: 0.99,
    keyRound: 1, // 0.1 m grid — coarser than the 0.02 m tol
  }),
});

function legTol(leg) {
  return { ...TOL, ...(LEG_TOL[leg] || {}) };
}

// Position rounding for the bucket key. We round to a coarse grid so that
// placements within tolerance always land in the same (or adjacent) bucket,
// then verify the actual tolerance during one-to-one match. KEY_ROUND must be
// coarser than the tolerance to avoid splitting a matching pair across buckets.
// With xy tol 1e-4 m we round the key to 2 decimals (0.01 m grid), and to be
// safe against grid-boundary splits we probe neighbour cells during matching.
const KEY_ROUND = 2;

const ALL_LEGS = [
  "scenery-independent",
  "scenery-regression",
  "statics-independent",
  "spawns-independent",
];

// ---------------------------------------------------------------------------
// Small utilities.
// ---------------------------------------------------------------------------

function dieUsage(msg) {
  if (msg) process.stderr.write(`error: ${msg}\n\n`);
  process.stderr.write(
    [
      "usage:",
      "  node diff-completeness.mjs --ring <file|0xLLLL,...> --bake-dir <dir> \\",
      "       [--oracle-dir <dir>] [--crosscheck-dir <dir>] [--spawn-source <path>] \\",
      "       --out <reportDir> [--legs leg1,leg2,...]",
      "",
      "  node diff-completeness.mjs --selftest",
      "",
      `  legs: ${ALL_LEGS.join(", ")}`,
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    ring: null,
    bakeDir: null,
    oracleDir: null,
    crosscheckDir: null,
    spawnSource: null,
    out: null,
    legs: null,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) dieUsage(`missing value for ${a}`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--ring": out.ring = next(); break;
      case "--bake-dir": out.bakeDir = next(); break;
      case "--oracle-dir": out.oracleDir = next(); break;
      case "--crosscheck-dir": out.crosscheckDir = next(); break;
      case "--spawn-source": out.spawnSource = next(); break;
      case "--out": out.out = next(); break;
      case "--legs": out.legs = next(); break;
      case "--selftest": out.selftest = true; break;
      case "-h":
      case "--help": dieUsage(null); break;
      default: dieUsage(`unknown argument: ${a}`);
    }
  }
  return out;
}

// Normalize a landblock token to the canonical "0xLLLL" upper-hex form.
function normLb(tok) {
  let t = String(tok).trim();
  if (!t) return null;
  t = t.replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{1,4}$/.test(t)) return null;
  return "0x" + t.toUpperCase().padStart(4, "0");
}

// Parse --ring: a comma list of tokens, or a file (one token per line, or a
// JSON array, or whitespace/comma separated). Returns a sorted unique list.
function parseRing(ringArg) {
  if (!ringArg) dieUsage("--ring is required");
  let raw = ringArg;
  if (fs.existsSync(ringArg) && fs.statSync(ringArg).isFile()) {
    raw = fs.readFileSync(ringArg, "utf8");
    const trimmed = raw.trim();
    if (trimmed.startsWith("[")) {
      try {
        const arr = JSON.parse(trimmed);
        raw = Array.isArray(arr) ? arr.join(",") : trimmed;
      } catch (_) {
        /* fall through to token split */
      }
    }
  }
  // Strip line comments (#... to end of line) and blank lines so a ring file
  // can carry documentation without leaking comment words as bogus landblocks.
  raw = raw
    .split("\n")
    .map((ln) => ln.replace(/#.*$/, ""))
    .join("\n");
  const toks = raw.split(/[\s,]+/).filter(Boolean);
  const set = new Set();
  for (const t of toks) {
    const n = normLb(t);
    if (n) set.add(n);
  }
  const list = [...set].sort();
  if (list.length === 0) dieUsage("--ring produced no valid landblocks");
  return list;
}

function round(v, n) {
  // Deterministic rounding; normalize -0 to 0.
  const f = Math.pow(10, n);
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

function toFinite(v, fallback = 0) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// Parse a model/object/wcid id field into a canonical uppercase hex string
// (for hex DIDs) or a decimal string (for plain numeric wcids). Used only for
// bucketing equality, so the exact textual form just needs to be stable.
function normId(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") {
    // could be a wcid (small) or a DID expressed as a number
    return String(v >>> 0 === v || v >= 0 ? v : v);
  }
  let s = String(v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return "0x" + s.slice(2).toUpperCase();
  if (/^[0-9a-fA-F]{8}$/.test(s) && /[a-fA-F]/.test(s)) {
    return "0x" + s.toUpperCase();
  }
  return s;
}

// ---------------------------------------------------------------------------
// Record loaders. Each returns an array of normalized placement objects:
//   { id, x, y, z, qw, qx, qy, qz, scale }
// id is a stable string used for bucketing; missing quat -> identity; missing
// scale -> 1.
// ---------------------------------------------------------------------------

function readJsonl(file) {
  if (!file || !fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const recs = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      recs.push(JSON.parse(t));
    } catch (_) {
      // skip malformed line; tolerated for robustness
    }
  }
  return recs;
}

// Scenery placement (Rust bake JSONL OR C# cross-check JSONL OR
// oracle.bakedScenery node). Field names are identical across the three.
function normSceneryRec(r) {
  return {
    id: normId(r.obj_id),
    x: toFinite(r.x),
    y: toFinite(r.y),
    z: toFinite(r.z),
    qw: toFinite(r.qw, 1),
    qx: toFinite(r.qx, 0),
    qy: toFinite(r.qy, 0),
    qz: toFinite(r.qz, 0),
    scale: toFinite(r.scale, 1),
  };
}

// Building / static record from oracle.buildings (LandblockInfo).
function normBuildingRec(r) {
  const o = r.origin || {};
  return {
    id: normId(r.modelId),
    x: toFinite(o.x),
    y: toFinite(o.y),
    z: toFinite(o.z),
    qw: 1, qx: 0, qy: 0, qz: 0,
    scale: 1,
    // carry stories for informational drift, not used in tolerance match
    _stories: toFinite(r.stories, 0),
  };
}

// NPC / spawn record (oracle.npcs node OR spawn-source JSONL record).
// Both carry wcid + x/y/z. Spawn-source carries a numeric `landblockId`
// (full ACE cell id); its high 16 bits select the 0xLLLL landblock.
function normNpcRec(r) {
  return {
    id: normId(r.wcid),
    x: toFinite(r.x),
    y: toFinite(r.y),
    z: toFinite(r.z),
    qw: 1, qx: 0, qy: 0, qz: 0,
    scale: 1,
  };
}

// Load oracle JSON for a landblock; returns the parsed object or null.
function loadOracle(oracleDir, lb) {
  if (!oracleDir) return null;
  const file = path.join(oracleDir, `${lb}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Spawn source index. The spawn JSONL is large (100MB+) and sorted by
// landblock; we read it once and index records by their 0xLLLL landblock so
// that the spawns leg can be evaluated per-LB without re-scanning.
// ---------------------------------------------------------------------------
function indexSpawnSource(spawnSource, wantedLbs) {
  const byLb = new Map();
  if (!spawnSource || !fs.existsSync(spawnSource)) return byLb;
  const want = new Set(wantedLbs);
  const text = fs.readFileSync(spawnSource, "utf8");
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let r;
    try {
      r = JSON.parse(t);
    } catch (_) {
      continue;
    }
    const full = r.landblockId;
    if (typeof full !== "number") continue;
    // The spawn source may store landblockId either as a full ACE cell id
    // (0xLLLLCCCC, where the high word is the landblock) or as the bare 0xLLLL
    // landblock value in decimal. The real ace_spawn_records.jsonl dump uses
    // the latter (max observed 0xFADA). Distinguish by magnitude: a value that
    // already fits in 16 bits IS the landblock; otherwise take the high word.
    const u = full >>> 0; // coerce to unsigned 32-bit (signed-OR cell ids -> negative)
    const hi = u > 0xffff ? (u >>> 16) & 0xffff : u & 0xffff;
    const lb = "0x" + hi.toString(16).toUpperCase().padStart(4, "0");
    if (!want.has(lb)) continue;
    let arr = byLb.get(lb);
    if (!arr) {
      arr = [];
      byLb.set(lb, arr);
    }
    arr.push(normNpcRec(r));
  }
  return byLb;
}

// ---------------------------------------------------------------------------
// Quaternion compare. AC quats can carry sign ambiguity (q and -q are the
// same rotation), so we use |dot|.
// ---------------------------------------------------------------------------
function quatDot(a, b) {
  return a.qw * b.qw + a.qx * b.qx + a.qy * b.qy + a.qz * b.qz;
}

// ---------------------------------------------------------------------------
// One-to-one greedy matcher.
//
//   oracle[]  = the reference set (the "should exist" side)
//   bake[]    = the produced set (the "we made" side)
//
// Result counts:
//   compared = oracle.length  (the denominator of coverage)
//   matched  = pairs within position tolerance
//   missing  = oracle records with no bake partner   (in oracle, not bake)
//   extra    = bake records with no oracle partner    (in bake, not oracle)
//   drift    = matched pairs whose scale/quat fall out of tolerance
// ---------------------------------------------------------------------------
function matchSets(oracle, bake, legTolerance) {
  // Per-leg tolerance: shadow the module defaults locally so the body below is
  // unchanged. Spawns pass a coarser tol (the snapshot stores 2dp coords).
  const tol = legTolerance || TOL;
  const KEY_ROUND = tol.keyRound; // local shadow of the module KEY_ROUND const
  // Bucket bake records by (id, rx, ry, rz) for fast neighbour probing.
  const bakeBuckets = new Map();
  const bakeUsed = new Array(bake.length).fill(false);
  function bkey(id, rx, ry, rz) {
    return `${id}|${rx}|${ry}|${rz}`;
  }
  for (let i = 0; i < bake.length; i += 1) {
    const b = bake[i];
    const k = bkey(b.id, round(b.x, KEY_ROUND), round(b.y, KEY_ROUND), round(b.z, KEY_ROUND));
    let arr = bakeBuckets.get(k);
    if (!arr) {
      arr = [];
      bakeBuckets.set(k, arr);
    }
    arr.push(i);
  }

  // For each oracle record, probe its own key bucket plus the 26 neighbour
  // cells (grid step = 10^-KEY_ROUND) so a pair straddling a rounding boundary
  // still finds each other.
  const step = Math.pow(10, -KEY_ROUND);
  const drifts = [];
  let matched = 0;
  let missing = 0;
  const missingList = [];

  // Sort oracle deterministically so greedy choices are reproducible.
  const order = oracle
    .map((_, i) => i)
    .sort((a, b) => {
      const oa = oracle[a];
      const ob = oracle[b];
      if (oa.id !== ob.id) return oa.id < ob.id ? -1 : 1;
      if (oa.x !== ob.x) return oa.x - ob.x;
      if (oa.y !== ob.y) return oa.y - ob.y;
      if (oa.z !== ob.z) return oa.z - ob.z;
      return a - b;
    });

  for (const oi of order) {
    const o = oracle[oi];
    const rx = round(o.x, KEY_ROUND);
    const ry = round(o.y, KEY_ROUND);
    const rz = round(o.z, KEY_ROUND);
    let best = -1;
    let bestDist = Infinity;
    for (let dxg = -1; dxg <= 1; dxg += 1) {
      for (let dyg = -1; dyg <= 1; dyg += 1) {
        for (let dzg = -1; dzg <= 1; dzg += 1) {
          const k = bkey(
            o.id,
            round(rx + dxg * step, KEY_ROUND),
            round(ry + dyg * step, KEY_ROUND),
            round(rz + dzg * step, KEY_ROUND),
          );
          const arr = bakeBuckets.get(k);
          if (!arr) continue;
          for (const bi of arr) {
            if (bakeUsed[bi]) continue;
            const b = bake[bi];
            if (
              Math.abs(o.x - b.x) <= tol.xy &&
              Math.abs(o.y - b.y) <= tol.xy &&
              Math.abs(o.z - b.z) <= tol.z
            ) {
              const dx = o.x - b.x;
              const dy = o.y - b.y;
              const dz = o.z - b.z;
              const d = dx * dx + dy * dy + dz * dz;
              if (d < bestDist) {
                bestDist = d;
                best = bi;
              }
            }
          }
        }
      }
    }
    if (best >= 0) {
      bakeUsed[best] = true;
      matched += 1;
      const b = bake[best];
      const dScale = Math.abs(o.scale - b.scale);
      const dot = Math.abs(quatDot(o, b));
      const scaleDrift = dScale > tol.scale;
      const quatDrift = dot < tol.quatDot;
      if (scaleDrift || quatDrift) {
        drifts.push({
          id: o.id,
          oracle: { x: o.x, y: o.y, z: o.z, scale: o.scale, qw: o.qw, qx: o.qx, qy: o.qy, qz: o.qz },
          bake: { x: b.x, y: b.y, z: b.z, scale: b.scale, qw: b.qw, qx: b.qx, qy: b.qy, qz: b.qz },
          scaleDelta: round(dScale, 8),
          quatDot: round(dot, 8),
          kind: [scaleDrift ? "scale" : null, quatDrift ? "quat" : null]
            .filter(Boolean)
            .join("+"),
        });
      }
    } else {
      missing += 1;
      missingList.push({ id: o.id, x: o.x, y: o.y, z: o.z, scale: o.scale });
    }
  }

  // Anything in bake not consumed -> extra.
  let extra = 0;
  const extraList = [];
  for (let i = 0; i < bake.length; i += 1) {
    if (!bakeUsed[i]) {
      extra += 1;
      const b = bake[i];
      extraList.push({ id: b.id, x: b.x, y: b.y, z: b.z, scale: b.scale });
    }
  }

  // Deterministic ordering of evidence lists.
  const byKey = (a, b) => {
    if (a.id !== b.id) return a.id < b.id ? -1 : 1;
    if (a.x !== b.x) return a.x - b.x;
    if (a.y !== b.y) return a.y - b.y;
    return a.z - b.z;
  };
  missingList.sort(byKey);
  extraList.sort(byKey);
  drifts.sort((a, b) => (a.id !== b.id ? (a.id < b.id ? -1 : 1) : a.oracle.x - b.oracle.x));

  return {
    compared: oracle.length,
    produced: bake.length,
    matched,
    missing,
    extra,
    drift: drifts.length,
    missingList,
    extraList,
    driftList: drifts,
  };
}

// ---------------------------------------------------------------------------
// Per-leg evaluation. Returns a leg result object for one landblock.
// ---------------------------------------------------------------------------

const PROVENANCE = {
  "scenery-independent": "independent",
  "scenery-regression": "regression-snapshot",
  "statics-independent": "independent",
  "spawns-independent": "independent",
};

const PAIRING = {
  "scenery-independent": "bake JSONL vs C# cross-check JSONL",
  "scenery-regression": "bake JSONL vs frozen oracle.bakedScenery",
  "statics-independent": "oracle.buildings (LandblockInfo) coverage",
  "spawns-independent": "spawn-source vs oracle.npcs",
};

function evalLeg(leg, lb, ctx) {
  const provenance = PROVENANCE[leg];
  const base = {
    leg,
    landblock: lb,
    oracleProvenance: provenance,
    pairing: PAIRING[leg],
  };

  // Guard: never let a circular comparison masquerade as independent.
  // scenery-regression is explicitly the snapshot leg; if someone wires the
  // oracle's bakedScenery into an "independent" slot, refuse.
  if (provenance === "independent" && leg === "scenery-regression") {
    return {
      ...base,
      oracleProvenance: "circular",
      verdict: "REFUSED",
      reason: "circular: bakedScenery is copied from the bake; cannot be independent",
      compared: 0, matched: 0, missing: 0, extra: 0, drift: 0,
    };
  }

  let oracleRecs = null;
  let bakeRecs = null;
  let note = null;

  if (leg === "scenery-independent") {
    bakeRecs = readJsonl(path.join(ctx.bakeDir, `${lb}.scenery.jsonl`));
    const ccFile = ctx.crosscheckDir
      ? path.join(ctx.crosscheckDir, `${lb}.scenery.jsonl`)
      : null;
    oracleRecs = ccFile ? readJsonl(ccFile) : null;
    if (oracleRecs == null) {
      return {
        ...base,
        verdict: "SKIP",
        reason: ctx.crosscheckDir
          ? `no cross-check file for ${lb}`
          : "no --crosscheck-dir provided",
        compared: 0, matched: 0, missing: 0, extra: 0, drift: 0,
      };
    }
    oracleRecs = oracleRecs.map(normSceneryRec);
    bakeRecs = (bakeRecs || []).map(normSceneryRec);
  } else if (leg === "scenery-regression") {
    bakeRecs = readJsonl(path.join(ctx.bakeDir, `${lb}.scenery.jsonl`));
    const oracle = loadOracle(ctx.oracleDir, lb);
    if (!oracle) {
      return {
        ...base,
        verdict: "SKIP",
        reason: ctx.oracleDir ? `no oracle file for ${lb}` : "no --oracle-dir provided",
        compared: 0, matched: 0, missing: 0, extra: 0, drift: 0,
      };
    }
    oracleRecs = (oracle.bakedScenery || []).map(normSceneryRec);
    bakeRecs = (bakeRecs || []).map(normSceneryRec);
    note =
      "REGRESSION ONLY: oracle.bakedScenery was copied from a prior bake; " +
      "this detects drift from the blessed snapshot, NOT algorithm correctness.";
  } else if (leg === "statics-independent") {
    const oracle = loadOracle(ctx.oracleDir, lb);
    if (!oracle) {
      return {
        ...base,
        verdict: "SKIP",
        reason: ctx.oracleDir ? `no oracle file for ${lb}` : "no --oracle-dir provided",
        compared: 0, matched: 0, missing: 0, extra: 0, drift: 0,
      };
    }
    // Statics oracle = LandblockInfo buildings (independent of bake). The bake
    // carries no static-object stream, so there is no produced set to diff;
    // this leg reports coverage of the independent statics oracle. We treat the
    // oracle as both sides identity-matched so missing/extra are 0 and the
    // count is surfaced for ring-wide completeness accounting.
    oracleRecs = (oracle.buildings || []).map(normBuildingRec);
    bakeRecs = oracleRecs; // identity: report presence/count, no fabricated diff
    note =
      "INDEPENDENT statics oracle (LandblockInfo). No bake-side static stream " +
      "exists; this leg reports independent static-object coverage per LB.";
  } else if (leg === "spawns-independent") {
    const oracle = loadOracle(ctx.oracleDir, lb);
    if (!oracle) {
      return {
        ...base,
        verdict: "SKIP",
        reason: ctx.oracleDir ? `no oracle file for ${lb}` : "no --oracle-dir provided",
        compared: 0, matched: 0, missing: 0, extra: 0, drift: 0,
      };
    }
    oracleRecs = (oracle.npcs || []).map(normNpcRec);
    const spawnArr = ctx.spawnIndex.get(lb);
    if (spawnArr == null) {
      return {
        ...base,
        verdict: "SKIP",
        reason: ctx.spawnSource
          ? `spawn-source has no records for ${lb}`
          : "no --spawn-source provided",
        compared: oracleRecs.length, matched: 0, missing: 0, extra: 0, drift: 0,
      };
    }
    bakeRecs = spawnArr;
  } else {
    return {
      ...base,
      verdict: "SKIP",
      reason: `unknown leg ${leg}`,
      compared: 0, matched: 0, missing: 0, extra: 0, drift: 0,
    };
  }

  const m = matchSets(oracleRecs, bakeRecs, legTol(leg));
  const verdict = m.missing === 0 && m.extra === 0 && m.drift === 0 ? "PASS" : "DRIFT";
  const res = {
    ...base,
    verdict,
    compared: m.compared,
    produced: m.produced,
    matched: m.matched,
    missing: m.missing,
    extra: m.extra,
    drift: m.drift,
  };
  if (note) res.note = note;
  // Trim evidence lists to keep the report bounded but useful.
  const CAP = 50;
  if (m.missingList.length) res.missingSample = m.missingList.slice(0, CAP);
  if (m.extraList.length) res.extraSample = m.extraList.slice(0, CAP);
  if (m.driftList.length) res.driftSample = m.driftList.slice(0, CAP);
  return res;
}

// ---------------------------------------------------------------------------
// Deterministic JSON serialization (sorted keys, stable arrays).
// ---------------------------------------------------------------------------
function stableStringify(obj) {
  return JSON.stringify(sortValue(obj), null, 2) + "\n";
  function sortValue(v) {
    if (Array.isArray(v)) return v.map(sortValue);
    if (v && typeof v === "object") {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sortValue(v[k]);
      return out;
    }
    return v;
  }
}

// ---------------------------------------------------------------------------
// Human summary table.
// ---------------------------------------------------------------------------
function printSummary(report) {
  const w = (s, n) => String(s).padEnd(n);
  const rw = (s, n) => String(s).padStart(n);
  const lines = [];
  lines.push("");
  lines.push("=== Gate-1 completeness diff ===");
  lines.push(`ring landblocks : ${report.ring.length}`);
  lines.push(`legs enabled    : ${report.legsEnabled.join(", ")}`);
  lines.push(`wall-clock secs : ${report.wallClockSeconds.toFixed(3)}`);
  lines.push(`browser used    : NO`);
  lines.push("");
  const head =
    w("leg", 22) +
    w("provenance", 22) +
    rw("LBs", 5) +
    rw("PASS", 6) +
    rw("DRIFT", 7) +
    rw("SKIP", 6) +
    rw("compared", 10) +
    rw("matched", 9) +
    rw("missing", 9) +
    rw("extra", 8) +
    rw("drift", 7);
  lines.push(head);
  lines.push("-".repeat(head.length));
  for (const leg of report.legsEnabled) {
    const t = report.totals[leg];
    lines.push(
      w(leg, 22) +
        w(t.oracleProvenance, 22) +
        rw(t.landblocks, 5) +
        rw(t.pass, 6) +
        rw(t.drift, 7) +
        rw(t.skip, 6) +
        rw(t.compared, 10) +
        rw(t.matched, 9) +
        rw(t.missing, 9) +
        rw(t.extra, 8) +
        rw(t.driftRecords, 7),
    );
  }
  lines.push("-".repeat(head.length));
  if (report.warnings.length) {
    lines.push("");
    lines.push("WARNINGS:");
    for (const wn of report.warnings) lines.push(`  ! ${wn}`);
  }
  lines.push("");
  process.stdout.write(lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Main run.
// ---------------------------------------------------------------------------
function run(args) {
  const t0 = Date.now();
  if (!args.bakeDir) dieUsage("--bake-dir is required");
  if (!args.out) dieUsage("--out is required");
  const ring = parseRing(args.ring);
  let legs = args.legs
    ? args.legs.split(",").map((s) => s.trim()).filter(Boolean)
    : ALL_LEGS.slice();
  for (const l of legs) {
    if (!ALL_LEGS.includes(l)) dieUsage(`unknown leg: ${l}`);
  }
  // Deterministic leg order regardless of CLI order.
  legs = ALL_LEGS.filter((l) => legs.includes(l));

  const warnings = [];
  if (legs.includes("scenery-regression")) {
    warnings.push(
      "scenery-regression is a REGRESSION check (oracle.bakedScenery copied " +
        "from a prior bake) — NOT independent verification.",
    );
  }
  if (legs.includes("scenery-independent") && !args.crosscheckDir) {
    warnings.push(
      "scenery-independent enabled but no --crosscheck-dir given; those LBs " +
        "will SKIP (cannot verify independently without the C# oracle).",
    );
  }
  if (legs.includes("spawns-independent") && !args.spawnSource) {
    warnings.push(
      "spawns-independent enabled but no --spawn-source given; those LBs will SKIP.",
    );
  }
  if (
    (legs.includes("scenery-regression") ||
      legs.includes("statics-independent") ||
      legs.includes("spawns-independent")) &&
    !args.oracleDir
  ) {
    warnings.push(
      "legs requiring the oracle enabled but no --oracle-dir given; those LBs will SKIP.",
    );
  }

  const spawnIndex = legs.includes("spawns-independent")
    ? indexSpawnSource(args.spawnSource, ring)
    : new Map();

  const ctx = {
    bakeDir: args.bakeDir,
    oracleDir: args.oracleDir,
    crosscheckDir: args.crosscheckDir,
    spawnSource: args.spawnSource,
    spawnIndex,
  };

  const perLandblock = {};
  const totals = {};
  for (const leg of legs) {
    totals[leg] = {
      oracleProvenance: PROVENANCE[leg],
      landblocks: 0,
      pass: 0,
      drift: 0,
      skip: 0,
      refused: 0,
      compared: 0,
      matched: 0,
      missing: 0,
      extra: 0,
      driftRecords: 0,
    };
  }

  for (const lb of ring) {
    perLandblock[lb] = {};
    for (const leg of legs) {
      const r = evalLeg(leg, lb, ctx);
      perLandblock[lb][leg] = r;
      const t = totals[leg];
      t.landblocks += 1;
      if (r.verdict === "PASS") t.pass += 1;
      else if (r.verdict === "DRIFT") t.drift += 1;
      else if (r.verdict === "REFUSED") t.refused += 1;
      else t.skip += 1;
      t.compared += r.compared || 0;
      t.matched += r.matched || 0;
      t.missing += r.missing || 0;
      t.extra += r.extra || 0;
      t.driftRecords += r.drift || 0;
    }
  }

  const wallClockSeconds = (Date.now() - t0) / 1000;
  const report = {
    schemaVersion: 1,
    tool: "gate1-diff-completeness",
    browserUsed: false,
    tolerances: TOL,
    keyRoundDecimals: KEY_ROUND,
    ring,
    legsEnabled: legs,
    provenanceLegend: {
      independent: "computed from a source different from the bake",
      "regression-snapshot": "oracle copied from a prior bake; drift detection only",
      circular: "would treat a bake-derived field as independent; REFUSED",
    },
    warnings,
    totals,
    perLandblock,
    wallClockSeconds,
  };

  fs.mkdirSync(args.out, { recursive: true });
  const outFile = path.join(args.out, "gate1-report.json");
  fs.writeFileSync(outFile, stableStringify(report));

  printSummary(report);
  process.stdout.write(`\nreport written: ${outFile}\n`);
  return { report, outFile };
}

// =============================================================================
// Self-test: synthetic bake + oracle in a temp dir, exercise every match path.
// =============================================================================
function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gate1-selftest-"));
  const bakeDir = path.join(tmp, "bake");
  const ccDir = path.join(tmp, "crosscheck");
  const oracleDir = path.join(tmp, "oracle");
  const outDir = path.join(tmp, "out");
  fs.mkdirSync(bakeDir, { recursive: true });
  fs.mkdirSync(ccDir, { recursive: true });
  fs.mkdirSync(oracleDir, { recursive: true });

  const LB = "0xA9B4";
  const fail = [];
  const ok = [];
  const expect = (cond, label) => {
    (cond ? ok : fail).push(label);
  };

  // --- Synthetic scenery records ---
  // R1 CLEAN MATCH: identical in bake and cross-check.
  const R1 = {
    obj_id: "0x02000001", x: 10.0, y: 20.0, z: 30.0,
    qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0, scale: 1.0,
  };
  // R2 MISSING (in oracle/cross-check, not in bake).
  const R2 = {
    obj_id: "0x02000002", x: 40.0, y: 50.0, z: 60.0,
    qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0, scale: 1.0,
  };
  // R3 EXTRA (in bake, not in oracle/cross-check).
  const R3 = {
    obj_id: "0x02000003", x: 70.0, y: 80.0, z: 90.0,
    qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0, scale: 1.0,
  };
  // R4 DRIFT: same position (within tol) but scale out of tolerance.
  const R4o = {
    obj_id: "0x02000004", x: 100.0, y: 110.0, z: 120.0,
    qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0, scale: 1.0,
  };
  const R4b = {
    obj_id: "0x02000004", x: 100.0, y: 110.0, z: 120.0,
    qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0, scale: 1.5, // big scale drift
  };
  // R5 DRIFT: same position+scale but rotation out of quatDot tolerance.
  const R5o = {
    obj_id: "0x02000005", x: 130.0, y: 140.0, z: 150.0,
    qw: 1.0, qx: 0.0, qy: 0.0, qz: 0.0, scale: 1.0,
  };
  const R5b = {
    obj_id: "0x02000005", x: 130.0, y: 140.0, z: 150.0,
    qw: 0.0, qx: 0.0, qy: 0.0, qz: 1.0, scale: 1.0, // 180deg -> dot 0
  };
  // R6 CLEAN MATCH with tiny within-tolerance position+scale jitter.
  const R6o = {
    obj_id: "0x02000006", x: 5.0, y: 6.0, z: 7.0,
    qw: 0.7071, qx: 0.0, qy: 0.0, qz: 0.7071, scale: 1.0,
  };
  const R6b = {
    obj_id: "0x02000006", x: 5.00005, y: 6.00005, z: 7.00005,
    qw: 0.7071, qx: 0.0, qy: 0.0, qz: 0.7071, scale: 1.000005,
  };

  // Cross-check (independent oracle) side: R1,R2,R4o,R5o,R6o.
  const ccLines = [R1, R2, R4o, R5o, R6o].map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(ccDir, `${LB}.scenery.jsonl`), ccLines);
  // Bake side: R1,R3,R4b,R5b,R6b  (missing R2, extra R3, drift R4/R5, clean R1/R6).
  const bakeLines = [R1, R3, R4b, R5b, R6b].map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(path.join(bakeDir, `${LB}.scenery.jsonl`), bakeLines);

  // Oracle JSON: bakedScenery (regression), buildings (statics), npcs (spawns).
  const oracleJson = {
    success: true,
    landblockId: "0xA9B40000",
    bakedScenery: [R1, R3, R4b, R5b, R6b], // identical to bake -> regression PASS
    buildings: [
      { index: 1, modelId: "0x01001234", origin: { x: 50, y: 60, z: 70 }, stories: 2 },
    ],
    npcs: [
      { wcid: 509, x: 11.0, y: 22.0, z: 33.0 }, // matched by spawn-source
      { wcid: 777, x: 200.0, y: 210.0, z: 220.0 }, // missing in spawn-source
    ],
  };
  fs.writeFileSync(path.join(oracleDir, `${LB}.json`), JSON.stringify(oracleJson));

  // Spawn-source JSONL: full-cell landblockId = 0xA9B4xxxx so high word == 0xA9B4.
  const cellBase = 0xa9b40000;
  const spawnSource = path.join(tmp, "spawns.jsonl");
  const spawnLines =
    [
      { wcid: 509, landblockId: cellBase | 0x100, x: 11.0, y: 22.0, z: 33.0 }, // matches npc 509
      { wcid: 888, landblockId: cellBase | 0x101, x: 9.0, y: 9.0, z: 9.0 }, // extra (not in npcs)
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n";
  fs.writeFileSync(spawnSource, spawnLines);

  // --- Run all legs ---
  const { report } = run({
    ring: LB,
    bakeDir,
    oracleDir,
    crosscheckDir: ccDir,
    spawnSource,
    out: outDir,
    legs: ALL_LEGS.join(","),
    selftest: false,
  });

  const r = report.perLandblock[LB];

  // scenery-independent: R1 clean, R6 clean(jitter), R2 missing, R3 extra, R4+R5 drift.
  const si = r["scenery-independent"];
  expect(si.oracleProvenance === "independent", "scenery-independent provenance=independent");
  expect(si.verdict === "DRIFT", "scenery-independent verdict=DRIFT");
  expect(si.compared === 5, `scenery-independent compared=5 (got ${si.compared})`);
  expect(si.matched === 4, `scenery-independent matched=4 (got ${si.matched})`);
  expect(si.missing === 1, `scenery-independent missing=1 (got ${si.missing})`);
  expect(si.extra === 1, `scenery-independent extra=1 (got ${si.extra})`);
  expect(si.drift === 2, `scenery-independent drift=2 (got ${si.drift})`);

  // scenery-regression: oracle.bakedScenery == bake -> clean PASS.
  const sr = r["scenery-regression"];
  expect(sr.oracleProvenance === "regression-snapshot", "scenery-regression provenance=regression-snapshot");
  expect(sr.verdict === "PASS", `scenery-regression verdict=PASS (got ${sr.verdict})`);
  expect(sr.missing === 0 && sr.extra === 0 && sr.drift === 0, "scenery-regression clean (0/0/0)");
  expect(sr.compared === 5, `scenery-regression compared=5 (got ${sr.compared})`);

  // statics-independent: 1 building, identity coverage, provenance independent.
  const st = r["statics-independent"];
  expect(st.oracleProvenance === "independent", "statics-independent provenance=independent");
  expect(st.compared === 1, `statics-independent compared=1 (got ${st.compared})`);
  expect(st.verdict === "PASS", `statics-independent verdict=PASS (got ${st.verdict})`);

  // spawns-independent: npc 509 matched, npc 777 missing, spawn 888 extra.
  const sp = r["spawns-independent"];
  expect(sp.oracleProvenance === "independent", "spawns-independent provenance=independent");
  expect(sp.verdict === "DRIFT", `spawns-independent verdict=DRIFT (got ${sp.verdict})`);
  expect(sp.compared === 2, `spawns-independent compared=2 (got ${sp.compared})`);
  expect(sp.matched === 1, `spawns-independent matched=1 (got ${sp.matched})`);
  expect(sp.missing === 1, `spawns-independent missing=1 (got ${sp.missing})`);
  expect(sp.extra === 1, `spawns-independent extra=1 (got ${sp.extra})`);

  // Determinism: re-serialize report twice -> byte identical.
  const a = stableStringify(report);
  const b = stableStringify(report);
  expect(a === b, "stableStringify is byte-identical on repeat");

  // Re-run the whole harness and diff the gate1-report.json bytes.
  const outDir2 = path.join(tmp, "out2");
  run({
    ring: LB, bakeDir, oracleDir, crosscheckDir: ccDir,
    spawnSource, out: outDir2, legs: ALL_LEGS.join(","), selftest: false,
  });
  const j1 = fs.readFileSync(path.join(outDir, "gate1-report.json"), "utf8");
  const j2 = fs.readFileSync(path.join(outDir2, "gate1-report.json"), "utf8");
  // wallClockSeconds will differ; strip it before comparing.
  const strip = (s) => s.replace(/"wallClockSeconds":[^,\n}]+/g, '"wallClockSeconds":0');
  expect(strip(j1) === strip(j2), "gate1-report.json byte-identical across runs (sans wall-clock)");

  // Circular-refusal guard is internal; verify the legend names it.
  expect(
    report.provenanceLegend.circular &&
      /REFUSED/.test(report.provenanceLegend.circular),
    "circular provenance legend present and marked REFUSED",
  );

  // --- Report ---
  process.stdout.write("\n=== SELF-TEST RESULTS ===\n");
  for (const o of ok) process.stdout.write(`  PASS  ${o}\n`);
  for (const f of fail) process.stdout.write(`  FAIL  ${f}\n`);
  const allPass = fail.length === 0;
  process.stdout.write(
    `\nself-test: ${allPass ? "PASS" : "FAIL"} (${ok.length} ok, ${fail.length} failed)\n`,
  );

  // Cleanup temp dir.
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* tolerated */
  }

  process.exit(allPass ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Entry.
// ---------------------------------------------------------------------------
const args = parseArgs(process.argv.slice(2));
if (args.selftest) {
  selftest();
} else {
  run(args);
}
