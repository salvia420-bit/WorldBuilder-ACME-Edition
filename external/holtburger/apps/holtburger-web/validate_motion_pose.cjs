// Wave 3.C + 3.E — motion swing-pose classifier validator.
//
// **What this tool does:** drives WorldBuilder.Terminal's
// `motion-classify-swing` command across 30 sampled creature motion tables
// × 5 (stance × attackHeight) combos = 150 cases. Emits a per-run JSON
// artifact under
// `/mnt/wbterminal1/holtburger-validator-reports/motion-pose/<ISO-ts>/`.
//
// **Contract** (per
// `external/holtburger/docs/swing-classification-spec-2026-05-19.md`):
//   1. The classifier reads `MotionTable.Links[outerKey]` where
//      `outerKey = (stance & 0xFFFF) << 16 | 0x0003` (Ready substate).
//   2. For attackHeight ∈ {High=1, Med=2, Low=3} OR Magic stance, it walks
//      a candidate list and returns the first matching swing.
//   3. Every retail link has exactly 1 anim (5,455/5,455 in the audit).
//
// **Wave 3.E (2026-05-19):** when run with `--js-vs-cs`, the validator
// additionally drives the JS path through the wasm-pack `--target nodejs`
// bundle at `pkg-nodejs/`. Each (motionTableId, stance, attackHeight)
// case walks the same candidate list (mirrored from C# `CandidatesByHeight`
// + `MagicCandidates`) and calls `parseMotionLinkForSwingBytes(bytes,
// stance, command)` on the same DAT bytes — first hit wins. Result diffs
// against the C# oracle's resolvedMotionCmd + animId + lowFrame +
// highFrame + framerate. The validator's report.json gets a top-level
// `jsVsCs` section with per-case diff status.
//
// **Exit codes:**
//   - 0 : ≥80% of cases PASS or have a documented `no-link-for-stance`
//         reason (per spec §2.1 missile stances have no swing links).
//   - 1 : >20% FAIL — real port drift; investigate before merging.
//   - 2 : Infra error (WB.Terminal subprocess crashed; splice not landed yet).
//
// **Run:**
//   - `node validate_motion_pose.cjs`              (C# oracle only)
//   - `node validate_motion_pose.cjs --js-vs-cs`   (oracle + JS-vs-C# diff)
//
// **Splice dependency:** this validator dispatches
// `motion-classify-swing` and `motion-inventory`; both depend on the
// `WAVE3BC_DISPATCH_PENDING.patch` splice landing in
// `JsonCommandProcessor.cs` (shipped 2026-05-19). For `--js-vs-cs`, the
// wasm-pack nodejs bundle must exist at `pkg-nodejs/holtburger_web.js`
// (built via `wasm-pack build --release --target nodejs --out-dir pkg-nodejs`).

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const mkdir = promisify(fs.mkdir);

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = path.join(
  REPO_ROOT,
  "WorldBuilder.Terminal",
  "bin",
  "Release",
  "net8.0",
  "WorldBuilder.Terminal.dll"
);
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "dotnet";

const REPORT_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/motion-pose";

// ────── stance + attackHeight combos to validate ──────
//
// 5 combos per creature. Each (stance × height) combination is checked.
// Stances chosen to exercise both melee + magic paths + a known-missile
// stance (BowCombat) that the spec promises will return `no-link-for-stance`.
const CASE_COMBOS = [
  { stance: 0x8000003e, stanceName: "SwordCombat", attackHeight: 1, expectMissing: false },
  { stance: 0x8000003e, stanceName: "SwordCombat", attackHeight: 2, expectMissing: false },
  { stance: 0x8000003e, stanceName: "SwordCombat", attackHeight: 3, expectMissing: false },
  { stance: 0x80000049, stanceName: "Magic", attackHeight: 1, expectMissing: false },
  { stance: 0x8000003f, stanceName: "BowCombat", attackHeight: 1, expectMissing: true },
];

// ────── known high-value motion tables to include in the sample ──────
//
// Per memory `project_holtburger_phase_k1_pass_2026-05-17`: "@create 7 drudge"
// was the live ACE smoke creature. Other known-meaningful tables:
//   - 0x09000001 → Human/character (the spec's canonical table)
//   - 0x09000202 → DRW EOR test fixture (per MotionTableTests.cs:58-78)
// Hand-picked list:
const KNOWN_TABLES = [
  0x09000001,
  0x09000202,
];

function isoSlug(date = new Date()) {
  return date
    .toISOString()
    .replace(/\.[0-9]{3}Z$/, "Z")
    .replace(/:/g, "-");
}

// ────── Wave 3.E — JS-side candidate lists ──────
//
// Mirrors `WorldBuilder.Terminal/CommandEngine.MotionParity.cs:122-177`
// `CandidatesByHeight` + `MagicCandidates`. The C# oracle picks the
// first candidate that resolves in `MotionTable.Links[outer]`; the JS
// side walks the same list in the same order so a passing C# case maps
// to the same `resolvedMotionCmd` on the JS side.
//
// **NOTE:** these values come straight from
// `external/chorizite/Chorizite.Common/Enums/MotionCommand.cs`. Any drift
// here would surface as a per-row mismatch in the jsVsCs section of the
// validator's report.json.
const JS_CANDIDATES_BY_HEIGHT = {
  // AttackHeight.High = 1
  1: [
    0x10000062, // AttackHigh1
    0x1000005b, // SlashHigh
    0x1000005a, // ThrustHigh
    0x10000065, // AttackHigh2
    0x10000068, // AttackHigh3
    0x10000121, // DoubleSlashHigh
    0x10000127, // DoubleThrustHigh
    0x10000124, // TripleSlashHigh
    0x1000012a, // TripleThrustHigh
    0x10000173, // OffhandSlashHigh
    0x10000176, // OffhandThrustHigh
  ],
  // AttackHeight.Medium = 2
  2: [
    0x10000063, // AttackMed1
    0x1000005c, // SlashMed
    0x10000058, // ThrustMed
    0x10000066, // AttackMed2
    0x10000069, // AttackMed3
    0x10000120, // DoubleSlashMed
    0x10000126, // DoubleThrustMed
    0x10000123, // TripleSlashMed
    0x10000129, // TripleThrustMed
    0x10000174, // OffhandSlashMed
    0x10000177, // OffhandThrustMed
  ],
  // AttackHeight.Low = 3
  3: [
    0x10000064, // AttackLow1
    0x1000005d, // SlashLow
    0x10000059, // ThrustLow
    0x10000067, // AttackLow2
    0x1000006a, // AttackLow3
    0x1000011f, // DoubleSlashLow
    0x10000125, // DoubleThrustLow
    0x10000122, // TripleSlashLow
    0x10000128, // TripleThrustLow
    0x10000175, // OffhandSlashLow
    0x10000178, // OffhandThrustLow
  ],
};

const JS_MAGIC_CANDIDATES = [
  0x4000002b, // MagicBlast
  0x4000002c, // MagicSelfHead
  0x4000002d, // MagicSelfHeart
];

// Magic-stance discriminator: stance==Magic (0x80000049) OR low-16==0x49
function isMagicStance(stance) {
  return stance === 0x80000049 || (stance & 0xffff) === 0x49;
}

// ────── Wave 3.E — Minimal Node DAT reader ──────
//
// Standalone reader that opens `client_portal.dat`, walks the B-tree to
// resolve a file ID, and returns the (decompressed) bytes. Implements
// just enough of the format to extract motion tables:
//   - Header at byte 0x140 (320). The `root_offset` field is at offset
//     0x140 + 0x20 (= 0x160). See `crates/holtburger-dat/src/lib.rs`
//     DatHeader struct.
//   - B-tree nodes are 1716 bytes: 62 × u32 child pointers + u32 entry
//     count + entries (24 bytes: bit_flags, id, offset, size, timestamp,
//     version).
//   - Each "file" is chained 1024-byte blocks; first 4 bytes of each
//     block are the next-block pointer (0 = end-of-chain).
//   - Compressed entries (bit_flags & 0x01) carry a 4-byte raw output
//     size prefix + LRS-LZSS body. See `decompress_lrs` in utils.rs.
//
// Caches the DatDatabase across calls so we open `client_portal.dat`
// once per validator run.
const DAT_PATH = "/home/wbterminal/ac_base_dats/client_portal.dat";
const DAT_HEADER_OFFSET = 0x140;
// DatHeader struct layout (see crates/holtburger-dat/src/lib.rs:170-190):
//   magic u32 @ 0
//   block_size u32 @ 4
//   file_size u32 @ 8
//   dataset u32 @ 12
//   subset u32 @ 16
//   free_head u32 @ 20
//   free_tail u32 @ 24
//   free_count u32 @ 28
//   root_offset u32 @ 32   ← what we need
const DAT_ROOT_OFFSET_FIELD_OFFSET = 0x140 + 32;
const DAT_BLOCK_SIZE_FIELD_OFFSET = 0x140 + 4;
const DAT_NODE_SIZE = 1716;
const DAT_ENTRY_SIZE = 24;
const DAT_DIRECTORY_BRANCHES = 62;

let _datCache = null;
function openDat() {
  if (_datCache) return _datCache;
  const fd = fs.openSync(DAT_PATH, "r");
  // Read just enough of the header to get block_size + root_offset.
  // Header lives at file offset DAT_HEADER_OFFSET (0x140). The buffer
  // starts at 0x140, so subtract DAT_HEADER_OFFSET from the absolute
  // DAT_*_FIELD_OFFSET constants to get the buffer-relative offset.
  const headerBuf = Buffer.alloc(0x100);
  fs.readSync(fd, headerBuf, 0, headerBuf.length, DAT_HEADER_OFFSET);
  const blockSize = headerBuf.readUInt32LE(DAT_BLOCK_SIZE_FIELD_OFFSET - DAT_HEADER_OFFSET);
  const rootOffset = headerBuf.readUInt32LE(DAT_ROOT_OFFSET_FIELD_OFFSET - DAT_HEADER_OFFSET);
  // Walk the B-tree and collect every (id → entry) into a Map.
  const fileTable = new Map();
  walkNode(fd, blockSize, rootOffset, fileTable);
  _datCache = { fd, blockSize, fileTable };
  return _datCache;
}
function readBlockChain(fd, blockSize, offset, size) {
  // Each "block" is `blockSize` bytes total, of which the first 4 bytes
  // are the next-block-offset (0 = end-of-chain) and the remaining
  // `blockSize - 4` are payload. The header `size` is the total payload
  // length (across the chain).
  const out = Buffer.alloc(size);
  let outOff = 0;
  let remaining = size;
  let cur = offset;
  const blockPayload = blockSize - 4;
  while (remaining > 0) {
    const ptrBuf = Buffer.alloc(4);
    fs.readSync(fd, ptrBuf, 0, 4, cur);
    const nextAddr = ptrBuf.readUInt32LE(0);
    if (nextAddr === 0) {
      fs.readSync(fd, out, outOff, remaining, cur + 4);
      remaining = 0;
    } else {
      const toRead = Math.min(remaining, blockPayload);
      fs.readSync(fd, out, outOff, toRead, cur + 4);
      outOff += toRead;
      remaining -= toRead;
      cur = nextAddr;
    }
  }
  return out;
}
function walkNode(fd, blockSize, offset, fileTable) {
  if (offset === 0) return;
  const nodeBuf = readBlockChain(fd, blockSize, offset, DAT_NODE_SIZE);
  const branches = [];
  for (let i = 0; i < DAT_DIRECTORY_BRANCHES; i++) {
    branches.push(nodeBuf.readUInt32LE(i * 4));
  }
  const entryCountOffset = DAT_DIRECTORY_BRANCHES * 4;
  const entryCount = nodeBuf.readUInt32LE(entryCountOffset);
  for (let i = 0; i < entryCount; i++) {
    const base = entryCountOffset + 4 + i * DAT_ENTRY_SIZE;
    const entry = {
      bit_flags: nodeBuf.readUInt32LE(base + 0),
      id: nodeBuf.readUInt32LE(base + 4),
      offset: nodeBuf.readUInt32LE(base + 8),
      size: nodeBuf.readUInt32LE(base + 12),
    };
    fileTable.set(entry.id, entry);
  }
  if (branches[0] !== 0) {
    for (let i = 0; i <= entryCount; i++) {
      if (branches[i] !== 0) walkNode(fd, blockSize, branches[i], fileTable);
    }
  }
}
function decompressLrs(input) {
  // Mirrors `crates/holtburger-dat/src/utils.rs::decompress_lrs`. LRS is
  // a simple LZSS variant: control byte's 8 bits select per-byte between
  // literal (push input byte) and back-ref (offset+length from already-
  // emitted output). First 4 bytes carry the decompressed-output size.
  if (input.length < 4) return Buffer.from(input);
  const outputSize = input.readUInt32LE(0);
  const data = input.subarray(4);
  const output = Buffer.alloc(outputSize);
  let outIdx = 0;
  let controlByte = 0;
  let controlBit = 0;
  let inputIdx = 0;
  while (outIdx < outputSize && inputIdx < data.length) {
    if (controlBit === 0) {
      controlByte = data[inputIdx];
      inputIdx += 1;
      controlBit = 0x80;
    }
    if ((controlByte & controlBit) !== 0) {
      if (inputIdx + 1 >= data.length) break;
      const b1 = data[inputIdx];
      const b2 = data[inputIdx + 1];
      inputIdx += 2;
      const refOffset = b1 | ((b2 & 0xf0) << 4);
      const refLength = (b2 & 0x0f) + 2;
      if (refOffset === 0) break;
      for (let i = 0; i < refLength && outIdx < outputSize; i++) {
        output[outIdx] = output[Math.max(0, outIdx - refOffset)];
        outIdx += 1;
      }
    } else {
      output[outIdx] = data[inputIdx];
      outIdx += 1;
      inputIdx += 1;
    }
    controlBit >>= 1;
  }
  return output.subarray(0, outIdx);
}
function getMotionTableBytes(motionTableId) {
  const { fd, blockSize, fileTable } = openDat();
  const entry = fileTable.get(motionTableId);
  if (!entry) return null;
  const raw = readBlockChain(fd, blockSize, entry.offset, entry.size);
  if ((entry.bit_flags & 0x01) !== 0) {
    return decompressLrs(raw);
  }
  return raw;
}

function ensureWbtDll() {
  if (!fs.existsSync(WBT_DLL)) {
    throw new Error(
      `WorldBuilder.Terminal.dll not found at ${WBT_DLL}\n` +
        `Build it first:  dotnet build WorldBuilder.Terminal -c Release`
    );
  }
}

/**
 * Drive WB.Terminal stdin loop with a single command and return the parsed
 * response. Same shape as validate_enum_parity.cjs:runWbtCommand.
 */
function runWbtCommand(commandObj, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    let stdoutBuf = "";
    let stderrBuf = "";
    let resolved = false;
    const expectedCmd = commandObj.command;
    const settled = (handler) => {
      if (resolved) return;
      resolved = true;
      try { child.kill(); } catch (_) {}
      handler();
    };
    const timer = setTimeout(() => {
      settled(() =>
        reject(new Error(
          `WB.Terminal subprocess timeout after ${timeoutMs}ms\n` +
          `stderr: ${stderrBuf}\nstdout: ${stdoutBuf}`))
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdoutBuf += chunk.toString("utf8");
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch (e) { continue; }
        if (obj.command === expectedCmd) {
          if (obj.success === false) {
            clearTimeout(timer);
            settled(() =>
              reject(new Error(
                `WB.Terminal reported failure on "${expectedCmd}": ${obj.error ?? JSON.stringify(obj)}\n` +
                `If the message is "Unknown command", the WAVE3BC_DISPATCH_PENDING.patch ` +
                `splice hasn't been applied to JsonCommandProcessor.cs yet.`))
            );
            return;
          }
          clearTimeout(timer);
          settled(() => resolve(obj));
          return;
        }
        // Unknown-command response shape (no "command" field, has "error").
        if (obj.success === false && (obj.error || obj.command === "unknown")) {
          clearTimeout(timer);
          settled(() =>
            reject(new Error(
              `WB.Terminal returned error: ${JSON.stringify(obj)}\n` +
              `Likely "Unknown command" — apply WAVE3BC_DISPATCH_PENDING.patch first.`))
          );
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderrBuf += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timer); settled(() => reject(err)); });
    child.on("exit", (code) => {
      if (resolved) return;
      clearTimeout(timer);
      settled(() =>
        reject(new Error(
          `WB.Terminal subprocess exited (code=${code}) without emitting "${expectedCmd}" response.\n` +
          `stderr: ${stderrBuf}\nstdout buffered: ${stdoutBuf}`))
      );
    });
    child.stdin.write(JSON.stringify(commandObj) + "\n");
    // Don't close stdin — let the subprocess emit then we kill on settle.
  });
}

/**
 * Deterministic sample of motion-table IDs given the full inventory.
 *
 * Strategy:
 *   1. Always include KNOWN_TABLES.
 *   2. For the remainder, sort the inventory by hex-id ascending and pick
 *      every Nth entry to reach 30 total. This is reproducible across
 *      runs (no RNG) and gives even coverage of the 0x09000000-0x0900FFFF
 *      range (per spec §8.1 there are 436 tables across this range).
 */
function sampleMotionTables(inventory, targetCount = 30) {
  const known = new Set(KNOWN_TABLES.map((id) => `0x${id.toString(16).padStart(8, "0").toUpperCase()}`));
  const result = [];
  // 1. Add known tables (filtered to those that have ≥1 link).
  for (const entry of inventory) {
    if (known.has(entry.id) && entry.linkCount > 0) result.push(entry);
  }
  // 2. Stride through the remainder.
  const remaining = inventory.filter((e) => !known.has(e.id) && e.linkCount > 0);
  if (result.length < targetCount && remaining.length > 0) {
    const stride = Math.max(1, Math.floor(remaining.length / (targetCount - result.length)));
    for (let i = 0; i < remaining.length && result.length < targetCount; i += stride) {
      result.push(remaining[i]);
    }
  }
  return result;
}

/**
 * Wave 3.E — JS-side classifier driver.
 *
 * For a given `(motionTableBytes, stance, attackHeight)`, walks the same
 * candidate list the C# oracle walks and returns the first hit. Mirrors
 * `CommandEngine.MotionParity.cs:316-340` (the foreach over candidates).
 *
 * Returns `{ resolvedMotionCmd, animId, lowFrame, highFrame, framerate,
 *           linkClass, failureReason }` mirroring the C# oracle's
 * SwingClassifyResult shape — so the diff comparison is field-by-field
 * trivial.
 */
function jsClassifySwing(mod, motionTableBytes, stance, attackHeight) {
  const candidates = isMagicStance(stance)
    ? JS_MAGIC_CANDIDATES
    : JS_CANDIDATES_BY_HEIGHT[attackHeight] ?? [];
  if (candidates.length === 0) {
    return {
      resolvedMotionCmd: null,
      animId: null,
      lowFrame: null,
      highFrame: null,
      framerate: null,
      linkClass: "Unknown",
      failureReason: `unknown-attack-height (got ${attackHeight})`,
    };
  }
  for (const candidate of candidates) {
    const result = mod.parseMotionLinkForSwingBytes(
      motionTableBytes,
      stance >>> 0,
      candidate >>> 0
    );
    if (result) {
      // Pick the link-class string mirror of C# `SwingLinkClass`. The
      // wasm side returns `kind` ∈ {"swing", "cast", "unknown"} and
      // `height` ∈ {"High","Medium","Low",""}. Map to C# enum tokens.
      const isMagic = result.kind === "cast";
      const linkClass = isMagic
        ? "Magic_Cast"
        : result.height === "High"
          ? "Melee_High"
          : result.height === "Medium"
            ? "Melee_Medium"
            : result.height === "Low"
              ? "Melee_Low"
              : "Unknown";
      const out = {
        resolvedMotionCmd: result.resolvedCommand >>> 0,
        animId: result.animId,
        lowFrame: result.lowFrame,
        highFrame: result.highFrame,
        framerate: result.framerate,
        linkClass,
        failureReason: null,
      };
      // wasm-bindgen returns an owned object; explicitly free to avoid
      // leaking wasm memory across the 150-case sweep.
      try { result.free(); } catch (_) {}
      return out;
    }
  }
  return {
    resolvedMotionCmd: null,
    animId: null,
    lowFrame: null,
    highFrame: null,
    framerate: null,
    linkClass: "Unknown",
    failureReason: "no-candidate-matched",
  };
}

/**
 * Wave 3.E — compare a C# oracle result to the JS-side result. Returns
 * `{ status, mismatches[] }` where status is "match"|"differ"|"cs-only"|
 * "js-only"|"both-missing". mismatches[] lists field-level deltas.
 *
 * **Normalization.** The C# JSON serializer emits uint values as
 * hex-prefixed strings (e.g. `"0x1000005B"`); the JS-side wasm returns
 * plain numbers (`268435547`). Same VALUE, different shape. We
 * normalize to unsigned-int via `>>> 0` (which coerces strings via
 * `Number()` first) for the comparisons. Float fields (`framerate`) use
 * a tolerance-based diff because float→string→float round-trip can
 * introduce 1 ULP drift.
 */
function normalizeUint(v) {
  if (v == null) return null;
  if (typeof v === "number") return v >>> 0;
  if (typeof v === "string") return Number(v) >>> 0;
  return null;
}
function diffJsVsCs(csResp, jsResp) {
  const mismatches = [];
  const csResolved = csResp.resolvedMotionCmd != null;
  const jsResolved = jsResp.resolvedMotionCmd != null;
  if (csResolved && jsResolved) {
    // Both sides resolved — diff field by field after normalization.
    const csCmd = normalizeUint(csResp.resolvedMotionCmd);
    const jsCmd = normalizeUint(jsResp.resolvedMotionCmd);
    if (csCmd !== jsCmd) {
      mismatches.push({
        field: "resolvedMotionCmd",
        cs: csResp.resolvedMotionCmd,
        js: jsResp.resolvedMotionCmd,
      });
    }
    const csAnim = normalizeUint(csResp.animId);
    const jsAnim = normalizeUint(jsResp.animId);
    if (csAnim !== jsAnim) {
      mismatches.push({ field: "animId", cs: csResp.animId, js: jsResp.animId });
    }
    if (csResp.lowFrame !== jsResp.lowFrame) {
      mismatches.push({ field: "lowFrame", cs: csResp.lowFrame, js: jsResp.lowFrame });
    }
    if (csResp.highFrame !== jsResp.highFrame) {
      mismatches.push({ field: "highFrame", cs: csResp.highFrame, js: jsResp.highFrame });
    }
    if (Math.abs((csResp.framerate ?? 0) - (jsResp.framerate ?? 0)) > 1e-3) {
      mismatches.push({
        field: "framerate",
        cs: csResp.framerate,
        js: jsResp.framerate,
      });
    }
    if (csResp.linkClass !== jsResp.linkClass) {
      mismatches.push({
        field: "linkClass",
        cs: csResp.linkClass,
        js: jsResp.linkClass,
      });
    }
    return {
      status: mismatches.length === 0 ? "match" : "differ",
      mismatches,
    };
  }
  if (csResolved && !jsResolved) {
    return { status: "cs-only", mismatches: [{ field: "resolved", cs: csResp.resolvedMotionCmd, js: null }] };
  }
  if (!csResolved && jsResolved) {
    return { status: "js-only", mismatches: [{ field: "resolved", cs: null, js: jsResp.resolvedMotionCmd }] };
  }
  // Both missing — agreement on absence is still agreement.
  return { status: "both-missing", mismatches: [] };
}

async function main() {
  try { ensureWbtDll(); } catch (e) {
    console.error(e.message); process.exit(2);
  }

  // Wave 3.E flag — opt-in JS-vs-C# diff phase. When on, also drives
  // the wasm-pack nodejs bundle through the same cases.
  const jsVsCsEnabled = process.argv.includes("--js-vs-cs");

  // Lazy wasm load — only when --js-vs-cs is on, since pkg-nodejs has to
  // exist (built separately via `wasm-pack build --release --target
  // nodejs --out-dir pkg-nodejs`).
  let wasmMod = null;
  if (jsVsCsEnabled) {
    const pkgPath = path.join(__dirname, "pkg-nodejs", "holtburger_web.js");
    if (!fs.existsSync(pkgPath)) {
      console.error(
        `\nERROR: --js-vs-cs requires the nodejs wasm bundle at ${pkgPath}\n` +
        `Build it with:\n` +
        `  cd ${__dirname} && wasm-pack build --release --target nodejs --out-dir pkg-nodejs\n`
      );
      process.exit(2);
    }
    // eslint-disable-next-line global-require, import/no-dynamic-require
    wasmMod = require(pkgPath);
    if (typeof wasmMod.parseMotionLinkForSwingBytes !== "function") {
      console.error(
        `\nERROR: pkg-nodejs missing parseMotionLinkForSwingBytes — rebuild after the W3.E lib.rs changes land.\n`
      );
      process.exit(2);
    }
  }

  const startedAt = new Date();
  const reportDir = path.join(REPORT_ROOT, isoSlug(startedAt));
  await mkdir(reportDir, { recursive: true });

  console.log(`validate_motion_pose — Wave 3.C${jsVsCsEnabled ? " + 3.E (JS-vs-C# diff)" : ""}`);
  console.log("===============================");
  console.log(`Started:   ${startedAt.toISOString()}`);
  console.log(`Report:    ${reportDir}/report.json`);
  console.log("");

  // ── Step 1: ask WB.Terminal for the motion-table inventory ───────────────
  let invResp;
  try {
    invResp = await runWbtCommand({ command: "motion-inventory" });
  } catch (e) {
    console.error("INFRA ERROR — motion-inventory failed:");
    console.error(e.message);
    const inf = {
      surface: "motion-pose",
      summary: { checked: 0, pass: 0, fail: 0, skipped: 0 },
      startedAt: startedAt.toISOString(),
      infraError: e.message,
    };
    fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(inf, null, 2));
    process.exit(2);
  }
  const inventory = invResp.entries ?? [];
  console.log(`Inventory: ${inventory.length} motion tables in retail portal.dat`);

  // ── Step 2: sample 30 tables deterministically ───────────────────────────
  const sample = sampleMotionTables(inventory, 30);
  console.log(`Sample:    ${sample.length} tables (${KNOWN_TABLES.length} known + stride)`);
  console.log("");

  // ── Step 3: classify each (table × combo) pair ───────────────────────────
  const cases = [];
  let passCount = 0;
  let failCount = 0;
  let skipCount = 0;
  for (const entry of sample) {
    const idNum = parseInt(entry.id, 16);
    for (const combo of CASE_COMBOS) {
      const caseId = `${entry.id}.${combo.stanceName}.h${combo.attackHeight}`;
      let resp;
      try {
        resp = await runWbtCommand({
          command: "motion-classify-swing",
          motionTableId: idNum,
          stance: combo.stance,
          attackHeight: combo.attackHeight,
        });
      } catch (e) {
        console.error(`  EXCEPTION on ${caseId}: ${e.message.split("\n")[0]}`);
        cases.push({
          caseId,
          motionTableId: entry.id,
          stance: combo.stance,
          stanceName: combo.stanceName,
          attackHeight: combo.attackHeight,
          status: "infra-error",
          error: e.message,
        });
        failCount++;
        continue;
      }
      // Classify the outcome.
      let status, note;
      const resolved = resp.resolvedMotionCmd != null;
      if (resolved) {
        // Good swing returned. PASS for melee/magic stances; FAIL for missile
        // (BowCombat / etc.) because spec says missile stances should have
        // no swing links.
        if (combo.expectMissing) {
          status = "fail";
          note = `expected no-link-for-stance, got cmd=${resp.resolvedMotionCmd}`;
          failCount++;
        } else {
          status = "pass";
          note = `resolved ${resp.resolvedMotionCmd} (${resp.linkClass})`;
          passCount++;
        }
      } else {
        // No swing returned. SKIP for expected-missing combos (missile
        // stances + monsters without that stance entirely). FAIL only if
        // we expected a swing AND the table has links (so the table CAN
        // swing in SOMETHING, just not this stance).
        const failure = resp.failureReason ?? "(unknown)";
        if (combo.expectMissing) {
          status = "pass";
          note = `expected-missing confirmed (${failure})`;
          passCount++;
        } else if (failure.startsWith("no-link-for-stance")) {
          // This is "creature has motion table but no link for that
          // stance" — a legitimate skip (e.g. a NonCombat-only monster
          // doesn't have SwordCombat swings). Count as skip not fail.
          status = "skip-stance-not-supported";
          note = failure;
          skipCount++;
        } else {
          status = "fail";
          note = failure;
          failCount++;
        }
      }
      // Wave 3.E — JS-side parity check (when --js-vs-cs flag is on).
      let jsVsCs = null;
      if (jsVsCsEnabled) {
        let motionTableBytes;
        try {
          motionTableBytes = getMotionTableBytes(idNum);
        } catch (err) {
          jsVsCs = {
            status: "infra-error",
            note: `DAT extract failed: ${err.message?.split("\n")[0] ?? err}`,
            mismatches: [],
          };
        }
        if (jsVsCs === null) {
          if (motionTableBytes == null) {
            jsVsCs = {
              status: "infra-error",
              note: "motion-table-bytes-not-in-dat",
              mismatches: [],
            };
          } else {
            let jsResp;
            try {
              jsResp = jsClassifySwing(
                wasmMod,
                motionTableBytes,
                combo.stance,
                combo.attackHeight
              );
            } catch (err) {
              jsResp = null;
              jsVsCs = {
                status: "js-exception",
                note: `wasm threw: ${err.message?.split("\n")[0] ?? err}`,
                mismatches: [],
              };
            }
            if (jsResp) {
              const diff = diffJsVsCs(resp, jsResp);
              jsVsCs = {
                status: diff.status,
                note:
                  diff.status === "match"
                    ? `js+cs agree (cmd=${jsResp.resolvedMotionCmd ?? "null"})`
                    : `${diff.status} — ${diff.mismatches.length} field deltas`,
                mismatches: diff.mismatches,
                jsResolvedMotionCmd: jsResp.resolvedMotionCmd,
                jsAnimId: jsResp.animId,
                jsLowFrame: jsResp.lowFrame,
                jsHighFrame: jsResp.highFrame,
                jsFramerate: jsResp.framerate,
                jsLinkClass: jsResp.linkClass,
                jsFailureReason: jsResp.failureReason,
              };
            }
          }
        }
      }
      cases.push({
        caseId,
        motionTableId: entry.id,
        stance: combo.stance,
        stanceName: combo.stanceName,
        attackHeight: combo.attackHeight,
        expectMissing: combo.expectMissing,
        status,
        note,
        resolvedMotionCmd: resp.resolvedMotionCmd,
        linkClass: resp.linkClass,
        animId: resp.animId,
        lowFrame: resp.lowFrame,
        highFrame: resp.highFrame,
        framerate: resp.framerate,
        failureReason: resp.failureReason,
        jsVsCs,
      });
    }
  }

  const total = cases.length;
  const passPct = total > 0 ? (passCount / total) * 100 : 0;

  console.log("");
  console.log(`Total cases:  ${total}`);
  console.log(`Pass:         ${passCount} (${passPct.toFixed(1)}%)`);
  console.log(`Fail:         ${failCount}`);
  console.log(`Skip:         ${skipCount}  (stance not supported for that creature)`);
  console.log("");

  // Per-stance summary
  const byStance = {};
  for (const c of cases) {
    if (!byStance[c.stanceName]) byStance[c.stanceName] = { pass: 0, fail: 0, skip: 0 };
    if (c.status === "pass") byStance[c.stanceName].pass++;
    else if (c.status === "fail" || c.status === "infra-error") byStance[c.stanceName].fail++;
    else byStance[c.stanceName].skip++;
  }
  console.log("Per-stance:");
  for (const [s, v] of Object.entries(byStance)) {
    console.log(`  ${s.padEnd(20)} pass=${v.pass}  fail=${v.fail}  skip=${v.skip}`);
  }
  console.log("");

  if (failCount > 0) {
    console.log("FAIL cases (first 10):");
    for (const c of cases.filter((c) => c.status === "fail" || c.status === "infra-error").slice(0, 10)) {
      console.log(`  ✗ ${c.caseId.padEnd(35)} ${c.note}`);
    }
    console.log("");
  }

  // ── Wave 3.E — JS-vs-C# diff summary ───────────────────────────────────
  let jsVsCsSummary = null;
  if (jsVsCsEnabled) {
    const csPassRows = cases.filter((c) => c.status === "pass");
    const csPassRowsResolved = csPassRows.filter(
      (c) => c.resolvedMotionCmd != null
    );
    const csPassRowsExpectMissing = csPassRows.filter(
      (c) => c.resolvedMotionCmd == null && c.expectMissing
    );
    const jsMatches = csPassRowsResolved.filter(
      (c) => c.jsVsCs && c.jsVsCs.status === "match"
    );
    const jsDiffers = csPassRowsResolved.filter(
      (c) => c.jsVsCs && c.jsVsCs.status === "differ"
    );
    const jsCsOnly = csPassRowsResolved.filter(
      (c) => c.jsVsCs && c.jsVsCs.status === "cs-only"
    );
    const jsErrors = csPassRowsResolved.filter(
      (c) =>
        c.jsVsCs &&
        (c.jsVsCs.status === "infra-error" || c.jsVsCs.status === "js-exception")
    );
    // expect-missing PASS rows (BowCombat etc.) — both sides should
    // return null. Counts as "JS-side pass" if both agree on no swing.
    const expectMissingBothMissing = csPassRowsExpectMissing.filter(
      (c) => c.jsVsCs && c.jsVsCs.status === "both-missing"
    );
    // Skip rows: same — both sides return null.
    const csSkipRows = cases.filter((c) => c.status === "skip-stance-not-supported");
    const skipBothMissing = csSkipRows.filter(
      (c) => c.jsVsCs && c.jsVsCs.status === "both-missing"
    );
    // "JS-side pass" total = resolved match + expect-missing both-missing.
    const jsSidePassTotal = jsMatches.length + expectMissingBothMissing.length;

    jsVsCsSummary = {
      enabled: true,
      csPassRowsTotal: csPassRows.length,
      csPassRowsWithResolvedSwing: csPassRowsResolved.length,
      csPassRowsExpectMissing: csPassRowsExpectMissing.length,
      jsMatchOnResolvedCases: jsMatches.length,
      jsDifferOnResolvedCases: jsDiffers.length,
      jsCsOnlyResolvedCases: jsCsOnly.length,
      jsInfraErrorOnResolvedCases: jsErrors.length,
      jsExpectMissingBothMissing: expectMissingBothMissing.length,
      jsSidePassTotal,
      csSkipRowsTotal: csSkipRows.length,
      bothMissingOnSkipCases: skipBothMissing.length,
      target: ">= 30 of 52 C# PASS rows match on JS side",
      targetMet: jsSidePassTotal >= 30,
    };

    console.log("Wave 3.E — JS-vs-C# parity:");
    console.log(`  C# PASS rows total:                  ${csPassRows.length}`);
    console.log(`  ↳ with resolved swing:               ${csPassRowsResolved.length}`);
    console.log(`    ↳ JS matches C# field-by-field:    ${jsMatches.length}`);
    console.log(`    ↳ JS differs from C#:              ${jsDiffers.length}`);
    console.log(`    ↳ JS missing where C# resolved:    ${jsCsOnly.length}`);
    console.log(`    ↳ JS infra error:                  ${jsErrors.length}`);
    console.log(`  ↳ expect-missing (e.g. BowCombat):   ${csPassRowsExpectMissing.length}`);
    console.log(`    ↳ JS+C# both-missing (matches):    ${expectMissingBothMissing.length}`);
    console.log(`  ─────────────────────────────────`);
    console.log(`  JS-side total agreement:             ${jsSidePassTotal} / ${csPassRows.length}`);
    console.log(`  Target (≥30 of 52):                  ${jsSidePassTotal >= 30 ? "MET ✓" : "NOT MET ✗"}`);
    console.log(`  C# skip rows with JS both-missing:   ${skipBothMissing.length} / ${csSkipRows.length}`);
    console.log("");

    if (jsDiffers.length > 0) {
      console.log("JS-vs-C# DIFFER cases (first 10):");
      for (const c of jsDiffers.slice(0, 10)) {
        const fields = (c.jsVsCs.mismatches || [])
          .map((m) => `${m.field}: cs=${m.cs}, js=${m.js}`)
          .join("; ");
        console.log(`  Δ ${c.caseId.padEnd(35)} ${fields}`);
      }
      console.log("");
    }
    if (jsCsOnly.length > 0) {
      console.log("JS-missing-where-CS-resolved (first 10):");
      for (const c of jsCsOnly.slice(0, 10)) {
        console.log(
          `  ↑ ${c.caseId.padEnd(35)} cs=${c.resolvedMotionCmd}, js=null (${c.jsVsCs.jsFailureReason ?? "?"})`
        );
      }
      console.log("");
    }
  }

  // ── Step 4: emit canonical report.json ───────────────────────────────────
  const finishedAt = new Date();
  const envelope = {
    surface: "motion-pose",
    oracle: {
      kind: "wb-terminal-motion-parity",
      method: "swing-classification-spec-2026-05-19.md",
      dat: "/home/wbterminal/ac_base_dats/client_portal.dat",
    },
    subject: {
      kind: "holtburger-rust-crates",
      note: jsVsCsEnabled
        ? "Wave 3.E live: JS path drives the pkg-nodejs wasm bundle " +
          "(parseMotionLinkForSwingBytes) over the same DAT bytes and " +
          "candidate list as the C# oracle. See jsVsCs section + per-case " +
          ".jsVsCs field for the diff. Browser-side caller is " +
          "scene3d/entities.js::classifyMotionCommandTyped (widening of the " +
          "coarse classifyMotionCommand)."
        : "Wave 3.C oracle-only mode. Pass --js-vs-cs to also drive the " +
          "JS path via the pkg-nodejs wasm bundle (Wave 3.E).",
    },
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    motionTableSample: sample.map((e) => e.id),
    knownTablesIncluded: KNOWN_TABLES.map((id) => `0x${id.toString(16).padStart(8, "0").toUpperCase()}`),
    summary: {
      checked: total,
      pass: passCount,
      fail: failCount,
      skipped: skipCount,
      passPct: Number(passPct.toFixed(2)),
    },
    perStance: byStance,
    jsVsCs: jsVsCsSummary,
    cases,
    outputPath: reportDir,
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(envelope, null, 2));
  console.log(`Wrote ${path.join(reportDir, "report.json")}`);
  console.log("");

  // ── Exit ────────────────────────────────────────────────────────────────
  // PASS if ≥80% of cases pass-or-skip-with-reason (matches the brief's
  // done criterion #4).
  const passOrSkipPct = total > 0 ? ((passCount + skipCount) / total) * 100 : 0;
  console.log(`Pass+skip rate: ${passOrSkipPct.toFixed(1)}% (target: ≥80%)`);
  if (passOrSkipPct < 80) {
    console.log("RESULT: FAIL (>20% of cases failed)");
    process.exit(1);
  }
  console.log(`RESULT: PASS (${passCount} pass, ${skipCount} skip-with-reason, ${failCount} fail)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("validate_motion_pose crashed:", e);
  process.exit(2);
});
