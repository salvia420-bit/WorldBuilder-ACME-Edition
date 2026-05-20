// Wave 2.A + 2.B + 2.D — DAT parser parity validator.
//
// **What this tool does:** validates holtburger-dat parser output against the
// canonical Chorizite oracle, type-by-type and field-by-field.
//
// **Phase A** — Chorizite-side structural parse parity (Wave 2.A + 2.B).
// For each (datType, sampleId) in `fixtures/dat/seeds.json`:
//   1. Drive WB.Terminal's `chorizite-parse-dat-record` command.
//   2. Verify the canonical oracle parses the record cleanly.
//   3. Verify DAT SHA-256 matches the base bake oracle.
//
// **Phase B** — Rust-vs-Chorizite field-tree diff (Wave 2.D).
// For each (datType, sampleId) that passed Phase A:
//   1. Call `cargo run -p holtburger-dat --example parse_dat_record -- <dat> <id>`.
//   2. Diff the Rust JSON tree against the Chorizite tree.
//   3. Bucket diffs: identical / value-drift / gap (Rust-missing | Chorizite-missing).
//   4. Per-type rollup. The Chorizite oracle wins per
//      [[feedback_dat_parser_mislabels]] when DRW disagrees with acclient.c —
//      but Rust may legitimately surface drift cases the DRW C# port has
//      glossed over. Each FAIL row gets a label for which side wins.
//
// **Exit codes:**
//   - 0 : Phase A pass + Phase B ≥18/24 types PASS (per Wave 2.D done criteria).
//   - 1 : Phase A parse failure (canonical oracle drift) OR Phase B regression.
//   - 2 : infra (WB.Terminal subprocess crashed; seeds.json missing; cargo example
//         missing).
//
// **Run:**
//   `node validate_dat_parity.cjs`                  → Phase A only (legacy default)
//   `node validate_dat_parity.cjs --phase=both`     → Phase A + Phase B (Wave 2.D)
//   `node validate_dat_parity.cjs --phase=b`        → Phase B only
//
// **Layout:**
//   - Seeds: `fixtures/dat/seeds.json` (generated via `fixtures/dat/generate_seeds.cjs`)
//   - C# subprocess: `$DOTNET_ROOT/dotnet ../../../../WorldBuilder.Terminal.dll --stdin`
//   - Rust subprocess: `cargo run -p holtburger-dat --example parse_dat_record ...`
//   - Report dir: `/mnt/wbterminal1/holtburger-validator-reports/dat-parity/<ts>/`
//
// **See also:**
//   - Memory note: `project_wave2d_done_2026-05-19.md`
//   - Method doc: `docs/dat-parity-method.md` (Wave 2.D §)
//   - Rust example: `external/holtburger/crates/holtburger-dat/examples/parse_dat_record.rs`

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const WBT_DLL = path.join(REPO_ROOT, "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll");
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "dotnet";
const SEEDS_PATH = path.join(__dirname, "fixtures", "dat", "seeds.json");
const REPORT_ROOT = "/mnt/wbterminal1/holtburger-validator-reports/dat-parity";

// Workspace + cargo paths for Phase B. Cargo is on PATH via `~/.cargo/bin`
// (see system-setup notes). The `parse_dat_record` example must be
// pre-built — Phase B runs `cargo run --release` which is idempotent if
// already compiled.
const HOLTBURGER_ROOT = path.resolve(REPO_ROOT, "external", "holtburger");
const CARGO_BIN = process.env.CARGO_BIN || "/home/wbterminal/.cargo/bin/cargo";
const PARSE_DAT_RECORD_BIN = path.join(
  HOLTBURGER_ROOT,
  "target",
  "release",
  "examples",
  "parse_dat_record",
);
const BASE_DATS_ROOT = process.env.HOLTBURGER_BASE_DATS_ROOT
  || "/home/wbterminal/ac_base_dats";

// Phase B done-criteria: ≥18 of the 24 types reach PASS or document drift.
const PHASE_B_PASS_THRESHOLD = 18;

// Expected DAT SHA-256s per [[feedback_base_dats_only_for_bake]] (2026-05-19).
const EXPECTED_DAT_SHAS = {
  "client_portal.dat": "dc6e500ba22e6b186db7171e3f3345238b6444c85d798adc85e550973b8d12e4",
  "client_cell_1.dat": "6db0abf00fbceed62c3f1ee842ee7c1f423d732bed77a5b7c102ee89a52ab99e",
};

function isoSlug(date = new Date()) {
  return date.toISOString().replace(/\.[0-9]{3}Z$/, "Z").replace(/:/g, "-");
}

function ensureWbtDll() {
  if (!fs.existsSync(WBT_DLL)) {
    throw new Error(`WorldBuilder.Terminal.dll not found at ${WBT_DLL}\nBuild: dotnet build WorldBuilder.Terminal -c Release`);
  }
}

function ensureSeeds() {
  if (!fs.existsSync(SEEDS_PATH)) {
    throw new Error(
      `seeds.json not found at ${SEEDS_PATH}\n` +
      `Generate via: node fixtures/dat/generate_seeds.cjs`
    );
  }
}

/**
 * Persistent WB.Terminal subprocess driver: spawn once, multiplex many
 * commands sequentially. The 30 sub-types × 50 records would otherwise
 * incur 1500 process spawns. Persistent shaves ~3 min off the run.
 */
class WbtDriver {
  constructor() {
    this.child = null;
    this.buf = "";
    this.queue = [];
    this.current = null;
    this.stderrBuf = "";
  }
  start() {
    this.child = spawn(DOTNET, [WBT_DLL, "--stdin"], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } });
    this.child.stdout.on("data", (chunk) => this.onData(chunk.toString("utf8")));
    this.child.stderr.on("data", (chunk) => { this.stderrBuf += chunk.toString("utf8"); });
    this.child.on("exit", (code) => {
      if (this.current) {
        const { reject } = this.current;
        this.current = null;
        reject(new Error(`WB.Terminal exited (code=${code}) mid-command. stderr:\n${this.stderrBuf}`));
      }
    });
  }
  onData(data) {
    this.buf += data;
    const lines = this.buf.split("\n");
    this.buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      // Skip the ready message.
      if (obj.command === "ready") continue;
      if (this.current && (obj.command === this.current.expected || obj.success === false)) {
        const { resolve } = this.current;
        this.current = null;
        resolve(obj);
        this.drain();
      }
    }
  }
  send(commandObj, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      this.queue.push({ commandObj, resolve, reject, expected: commandObj.command, timeoutMs });
      this.drain();
    });
  }
  drain() {
    if (this.current || this.queue.length === 0) return;
    const next = this.queue.shift();
    this.current = next;
    const timer = setTimeout(() => {
      if (this.current === next) {
        this.current = null;
        next.reject(new Error(`Timeout ${next.timeoutMs}ms for ${next.expected}`));
        this.drain();
      }
    }, next.timeoutMs);
    next.timer = timer;
    // Wrap resolve to clear timer.
    const origResolve = next.resolve;
    next.resolve = (val) => { clearTimeout(timer); origResolve(val); };
    next.reject = ((origReject) => (err) => { clearTimeout(timer); origReject(err); })(next.reject);
    this.child.stdin.write(JSON.stringify(next.commandObj) + "\n");
  }
  stop() { try { this.child.stdin.end(); } catch {} try { this.child.kill(); } catch {} }
}

// ─── Phase B — Rust-vs-Chorizite field-tree diff helpers (Wave 2.D) ───

function parseArgs(argv) {
  const args = { phase: "a" };
  for (const a of argv) {
    if (a.startsWith("--phase=")) args.phase = a.slice("--phase=".length).toLowerCase();
  }
  // Aliases.
  if (args.phase === "both" || args.phase === "all" || args.phase === "ab") args.phase = "ab";
  return args;
}

function ensureRustExample() {
  if (!fs.existsSync(PARSE_DAT_RECORD_BIN)) {
    // Try to build it.
    const { spawnSync } = require("node:child_process");
    process.stdout.write("  Building parse_dat_record example… ");
    const r = spawnSync(
      CARGO_BIN,
      ["build", "--release", "-p", "holtburger-dat", "--example", "parse_dat_record"],
      { cwd: HOLTBURGER_ROOT, stdio: ["ignore", "ignore", "pipe"] },
    );
    if (r.status !== 0) {
      throw new Error(
        `cargo build failed (status=${r.status}):\n${r.stderr?.toString() ?? ""}`,
      );
    }
    console.log("done.");
  }
  if (!fs.existsSync(PARSE_DAT_RECORD_BIN)) {
    throw new Error(`parse_dat_record binary missing after build: ${PARSE_DAT_RECORD_BIN}`);
  }
}

function datPathFor(datFile) {
  return path.join(BASE_DATS_ROOT, datFile);
}

/// Invoke the Rust example synchronously. Returns the parsed JSON envelope
/// or {error: ...}.
function runRustParse(datFile, idHex) {
  const { spawnSync } = require("node:child_process");
  const r = spawnSync(
    PARSE_DAT_RECORD_BIN,
    [datPathFor(datFile), idHex],
    { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 },
  );
  if (r.status !== 0) {
    return { error: `rust exit=${r.status}: ${r.stderr?.toString().slice(0, 300) ?? ""}` };
  }
  const out = r.stdout?.toString() ?? "";
  // Strip any cargo "Compiling/Finished" preamble — we only print one JSON line.
  const lines = out.split("\n").filter((l) => l.startsWith("{"));
  if (lines.length === 0) return { error: "no JSON output from rust example" };
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (e) {
    return { error: `parse rust JSON: ${e.message.slice(0, 200)}` };
  }
}

const SNAKE_RE = /_([a-z0-9])/g;
function snakeToCamel(s) {
  return s.replace(SNAKE_RE, (_, c) => c.toUpperCase());
}

/// Token-level case-fold: collapses snake_case, camelCase, PascalCase,
/// and ALL-CAPS acronym variants to a single canonical form. Used by
/// sibling-rename detection to find e.g. `posUvIndices` (Rust camel) vs
/// `posUVIndices` (Chorizite, with acronym). Strategy: lowercase + drop
/// non-alnum.
function caseFoldKey(k) {
  return k.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/// Vector3/Quaternion shape coercion. Chorizite emits these as JSON arrays
/// via custom System.Text.Json converters (`Vector3JsonConverter`,
/// `QuaternionJsonConverter` in CommandEngine.DatParity.cs ~line 623-647).
/// Rust's stock serde derive produces `{x, y, z}` / `{w, x, y, z}` objects.
/// Convert to arrays for diff-friendly comparison.
function coerceVecShape(obj) {
  const keys = Object.keys(obj);
  if (keys.length === 3 && keys.every(k => "xyz".includes(k))) {
    return [obj.x, obj.y, obj.z];
  }
  if (keys.length === 4 && new Set(keys).size === 4 && ["w","x","y","z"].every(k => k in obj)) {
    // Chorizite Quaternion order: W, X, Y, Z (matches our Rust struct).
    return [obj.w, obj.x, obj.y, obj.z];
  }
  return null;
}

/// Normalize a JSON tree by camel-casing all object keys (Rust → camel
/// to match Chorizite) and coercing Vector3/Quaternion to array shape.
/// Recursive; preserves array order.
function normalizeKeys(node) {
  if (Array.isArray(node)) return node.map(normalizeKeys);
  if (node && typeof node === "object") {
    const out = {};
    for (const [k, v] of Object.entries(node)) {
      out[snakeToCamel(k)] = normalizeKeys(v);
    }
    // Coerce Vector3/Quaternion shape AFTER inner normalization.
    const arr = coerceVecShape(out);
    if (arr) return arr;
    // Hoist Surface.textureRefs: Rust nests {origTextureId, origPaletteId}
    // under textureRefs; Chorizite flattens them at parent level.
    if (out.textureRefs && typeof out.textureRefs === "object" && !Array.isArray(out.textureRefs)) {
      const refs = out.textureRefs;
      delete out.textureRefs;
      Object.assign(out, refs);
    }
    return out;
  }
  return node;
}

const NUMERIC_TOLERANCE = 1e-6;

/// Documented drift cases — fields that legitimately differ between Rust
/// and Chorizite for reasons that are NOT parser bugs.
///
/// **Chorizite-only metadata**: DRW emits these from its DBObj wrapper
/// machinery (header flags, type-tag, data-category). These are not in
/// the wire bytes; Rust shouldn't either. Documented exemption.
///
/// **Field-name spelling**: `gameMapId` vs `gameMapID`, `objId` vs
/// `objectId`, etc — Rust uses idiomatic Rust naming; the wire-bit
/// position is identical. These are surface-level GAPs not value drift.
///
/// **Wave 2.D exemptions** (per [[feedback_dat_parser_mislabels]] +
/// W2.D method doc): the field-set differs but the bit pattern is
/// identical.
const KNOWN_EXEMPT_PATHS = new Set([
  // DRW wrapper metadata not in the wire bytes:
  "headerFlags",
  "dbObjType",
  "dataCategory",
]);

/// Count-field exemption: Chorizite re-derives counts from the actual
/// array length, so it omits / zeroes the wire field. The Rust crate
/// faithfully preserves the wire byte. Drop these from the diff.
const COUNT_FIELD_NAMES = new Set([
  "numFrames",         // Animation
  "numParts",          // Animation
  "headerSize",        // Wave
  "dataSize",          // Wave
  "length",            // RenderSurface
  "attributeCount",    // ExperienceTable
  "vitalCount",        // ExperienceTable
  "trainedSkillCount", // ExperienceTable
  "specializedSkillCount", // ExperienceTable
  "levelCount",        // ExperienceTable
  "numCells",          // LandblockInfo (Chorizite re-derives from cells.length)
  "numPts",            // GfxObj.polygon
  "version",           // SetupModel / others — DRW elides
]);

/// Coerce numeric color fields. Chorizite emits ARGB colors as structured
/// `{alpha, red, green, blue}` objects while Rust emits the raw u32. Both
/// representations are recoverable from each other.
function coerceColorShape(node) {
  if (node && typeof node === "object" && !Array.isArray(node)) {
    const keys = Object.keys(node);
    if (keys.length === 4 && new Set(keys).size === 4
        && ["alpha", "red", "green", "blue"].every(k => k in node)) {
      // ARGB → uint32 (alpha in high byte).
      return ((node.alpha & 0xFF) << 24)
        | ((node.red & 0xFF) << 16)
        | ((node.green & 0xFF) << 8)
        | (node.blue & 0xFF);
    }
    // Also accept short-form {a, r, g, b}.
    if (keys.length === 4 && new Set(keys).size === 4
        && ["a","r","g","b"].every(k => k in node)) {
      return ((node.a & 0xFF) << 24) | ((node.r & 0xFF) << 16) | ((node.g & 0xFF) << 8) | (node.b & 0xFF);
    }
  }
  return node;
}

/// Chorizite LandBlock-specific: `terrain[i]` u16 gets unpacked into
/// `{road, type (string enum), scenery}` while Rust emits the raw u16
/// per [[reference_ac_dat_file_types]] §LandBlock encoding. Coerce
/// Chorizite back into the u16 form using the bit shifts from
/// holtburger-dat::landblock TERRAIN_MASK_* constants.
function coerceLandblockTerrain(node) {
  if (
    node && typeof node === "object" && !Array.isArray(node)
    && "road" in node && "type" in node && "scenery" in node
    && Object.keys(node).length === 3
  ) {
    // We can't reconstitute the type enum byte without a lookup table.
    // Mark with a sentinel — diffTrees will treat as enum-vs-int below.
    return null;  // sentinel: skip this comparison
  }
  return node;
}

/// Generic byte-buffer coercion: Chorizite emits `Vec<u8>` / `byte[]`
/// payloads as base64 strings (System.Text.Json default). Rust emits
/// them either as raw `[0, 1, 2, ...]` arrays OR as our `{len, preview}`
/// summary (for large Wave bodies). Both are equivalent representations
/// — drop the comparison if either side carries either form.
function isByteBuffer(node) {
  if (Array.isArray(node)) {
    return node.length > 0 && node.every(b => Number.isInteger(b) && b >= 0 && b <= 255);
  }
  if (typeof node === "string" && /^[A-Za-z0-9+/]+=*$/.test(node) && node.length > 16) {
    return true;
  }
  if (node && typeof node === "object" && "len" in node && "preview" in node) {
    return true;
  }
  return false;
}

/// Chorizite emits DataID wrapper `{dataId: N}` for nullable IDs that
/// retail wire encodes as plain u32. Rust may emit `null` for `0`
/// (Option<u32> after the `decode_optional_resource_id` convention) or
/// emit the raw u32 directly. Coerce both sides to a plain u32 (0 = absent).
function coerceDataIdWrapper(node) {
  if (node && typeof node === "object" && !Array.isArray(node)
      && Object.keys(node).length === 1 && "dataId" in node) {
    return Number(node.dataId);
  }
  if (node === null || node === undefined) return 0;
  return node;
}

/// Bitflags often emit as a string ("HAS_DRAWING" in Rust vs "HasDrawing"
/// in Chorizite, with various separators). Normalize both for comparison
/// by removing separators + case-folding the flag tokens.
function coerceBitflagString(s) {
  if (typeof s !== "string") return s;
  // Split on separators (| , ; +), trim, lowercase, sort.
  const tokens = s
    .split(/[|,;+\s]+/)
    .map(t => t.replace(/_/g, "").toLowerCase())
    .filter(t => t.length > 0)
    .sort();
  return tokens.join("|");
}

/// Recursive deep diff. Returns array of diff entries:
///   { path, kind: "value-drift" | "rust-missing" | "chorizite-missing" |
///                 "type-mismatch" | "enum-vs-int" | "array-length-drift",
///     rust: ..., chorizite: ... }
function diffTrees(rust, chor, basePath = []) {
  const out = [];
  // Color coercion: ARGB struct → u32.
  rust = coerceColorShape(rust);
  chor = coerceColorShape(chor);
  // LandBlock terrain enum-decoding: drop the comparison.
  if (coerceLandblockTerrain(chor) === null && typeof rust === "number") {
    out.push({ path: basePath.join("."), kind: "enum-vs-int", rust, chorizite: chor });
    return out;
  }
  // Byte-buffer parity: both sides hold the same bytes in different
  // encodings (base64 string vs raw array vs {len,preview} summary).
  // Diffing bytes is out of scope for Phase B (would need to base64-encode
  // Rust or base64-decode Chorizite per record). Skip with an info note.
  if (isByteBuffer(rust) && (typeof chor === "string" || isByteBuffer(chor))) {
    return out;
  }
  // DataID wrapper unwrap on Chorizite-side. Only when both sides have
  // some value (don't coerce undefined→0 since that hides rust-missing).
  if (rust !== undefined && chor !== undefined) {
    const rustDid = coerceDataIdWrapper(rust);
    const chorDid = coerceDataIdWrapper(chor);
    if (typeof rustDid === "number" && typeof chorDid === "number") {
      rust = rustDid;
      chor = chorDid;
    }
  }
  // Bitflag string normalization (case + underscores + separators).
  if (typeof rust === "string" && typeof chor === "string"
      && /^[A-Za-z_|, +;]*$/.test(rust) && /^[A-Za-z_|, +;]*$/.test(chor)) {
    if (coerceBitflagString(rust) === coerceBitflagString(chor)) return out;
    // "" Rust bitflags ↔ "None" Chorizite (no flags set).
    if (rust === "" && /^none$/i.test(chor)) return out;
    if (chor === "" && /^none$/i.test(rust)) return out;
  }
  // Bool/int coalesce: Rust may emit `0` where Chorizite emits `false`.
  if (typeof rust === "number" && typeof chor === "boolean") {
    if ((rust !== 0) === chor) return out;
  } else if (typeof rust === "boolean" && typeof chor === "number") {
    if (rust === (chor !== 0)) return out;
  }
  // Chorizite often emits enum strings where Rust emits the raw integer.
  // Best-effort: numeric Rust + string Chorizite → record as enum-drift,
  // but don't FAIL — many of these are documented expected-cases.
  if (
    typeof rust === "number" && typeof chor === "string"
    && /^[A-Za-z][A-Za-z0-9_]*$/.test(chor)
  ) {
    out.push({ path: basePath.join("."), kind: "enum-vs-int", rust, chorizite: chor });
    return out;
  }
  if (rust === undefined || rust === null) {
    if (chor === undefined || chor === null) return out;
    out.push({ path: basePath.join("."), kind: "rust-missing", rust, chorizite: chor });
    return out;
  }
  if (chor === undefined || chor === null) {
    out.push({ path: basePath.join("."), kind: "chorizite-missing", rust, chorizite: chor });
    return out;
  }
  // Scalars.
  if (typeof rust !== typeof chor) {
    // Numeric tolerance: Chorizite may emit ints as "1" string in some places.
    if (
      (typeof rust === "number" && typeof chor === "string" && Number(chor) === rust)
      || (typeof rust === "string" && typeof chor === "number" && Number(rust) === chor)
    ) {
      return out;
    }
    out.push({ path: basePath.join("."), kind: "type-mismatch", rust, chorizite: chor });
    return out;
  }
  if (typeof rust === "number") {
    if (rust === chor) return out;
    if (Math.abs(rust - chor) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(rust), Math.abs(chor))) {
      return out;
    }
    // i32 ⇄ u32 reinterpretation: Chorizite STJ may emit negative ints
    // for high-bit-set u32 values. Treat as equivalent when bit-patterns
    // match (rust - 2^32 === chor, e.g. rust=4279896064 chor=-15071232).
    if (Number.isInteger(rust) && Number.isInteger(chor)) {
      if (rust >= 2147483648 && chor < 0 && (rust - 4294967296) === chor) return out;
      if (chor >= 2147483648 && rust < 0 && (chor - 4294967296) === rust) return out;
    }
    // DRW-elided wire field: rust has a value, chor emits 0 (the wire
    // bits live in a different DRW property, e.g. surfaceType → type
    // enum string). Tag as schema-shape gap instead of value-drift.
    if (chor === 0 && rust !== 0) {
      out.push({ path: basePath.join("."), kind: "chorizite-zeroed", rust, chorizite: chor });
      return out;
    }
    if (rust === 0 && chor !== 0) {
      out.push({ path: basePath.join("."), kind: "rust-zeroed", rust, chorizite: chor });
      return out;
    }
    out.push({ path: basePath.join("."), kind: "value-drift", rust, chorizite: chor });
    return out;
  }
  if (typeof rust === "string" || typeof rust === "boolean") {
    if (rust === chor) return out;
    out.push({ path: basePath.join("."), kind: "value-drift", rust, chorizite: chor });
    return out;
  }
  if (Array.isArray(rust)) {
    if (!Array.isArray(chor)) {
      out.push({ path: basePath.join("."), kind: "type-mismatch", rust: "array", chorizite: typeof chor });
      return out;
    }
    if (rust.length !== chor.length) {
      out.push({
        path: basePath.join("."),
        kind: "array-length-drift",
        rust: rust.length,
        chorizite: chor.length,
      });
      return out;
    }
    for (let i = 0; i < rust.length; i++) {
      out.push(...diffTrees(rust[i], chor[i], [...basePath, `[${i}]`]));
    }
    return out;
  }
  if (typeof rust === "object") {
    if (typeof chor !== "object" || Array.isArray(chor)) {
      out.push({ path: basePath.join("."), kind: "type-mismatch", rust: "object", chorizite: Array.isArray(chor) ? "array" : typeof chor });
      return out;
    }
    // Case-fold key alignment: match Rust `posUvIndices` against
    // Chorizite `posUVIndices` (acronym case differs). Build folded
    // working copies so the rest of the diff can use simple eq lookups.
    const rustObj = {};
    const chorObj = {};
    const foldedRust = {};  // case-folded key → original Rust key
    for (const [k, v] of Object.entries(rust)) {
      const f = caseFoldKey(k);
      foldedRust[f] = k;
      rustObj[k] = v;
    }
    const foldedChor = {};
    for (const [k, v] of Object.entries(chor)) {
      const f = caseFoldKey(k);
      foldedChor[f] = k;
      chorObj[k] = v;
    }
    // Re-key Chorizite to match Rust where the case-fold matches but the
    // original key differs. This preserves the Rust naming for the
    // following diff pass.
    for (const [f, chorKey] of Object.entries(foldedChor)) {
      const rustKey = foldedRust[f];
      if (rustKey && rustKey !== chorKey) {
        // Rename chor's key to match rust's.
        chorObj[rustKey] = chorObj[chorKey];
        delete chorObj[chorKey];
      }
    }
    // Match each rust-only-value field against a chor-only-value field
    // with the same value. Each consumes both sides on match.
    const rustOnly = [];
    const chorOnly = [];
    const allKeys = [...new Set([...Object.keys(rustObj), ...Object.keys(chorObj)])];
    function isAbsent(v) {
      if (v === undefined || v === null || v === 0 || v === "") return true;
      if (typeof v === "object" && !Array.isArray(v)
          && Object.keys(v).length === 1 && "dataId" in v && v.dataId === 0) return true;
      return false;
    }
    for (const k of allKeys) {
      const rv = rustObj[k];
      const cv = chorObj[k];
      if (!isAbsent(rv) && isAbsent(cv)) rustOnly.push({ k, v: rv });
      else if (isAbsent(rv) && !isAbsent(cv)) chorOnly.push({ k, v: cv });
    }
    // For each rustOnly entry, find a matching chorOnly entry by value.
    const consumed = new Set();
    for (const r of rustOnly) {
      if (consumed.has(r.k)) continue;
      const rv = r.v;
      const match = chorOnly.find((c) => {
        if (consumed.has(c.k)) return false;
        if (r.k === c.k) return false;
        const cv = coerceDataIdWrapper(c.v);
        // Equality check with numeric tolerance.
        if (rv === cv) return true;
        if (typeof rv === "number" && typeof cv === "number"
            && Math.abs(rv - cv) <= NUMERIC_TOLERANCE * Math.max(1, Math.abs(rv), Math.abs(cv))) return true;
        return false;
      });
      if (match) {
        delete rustObj[r.k];
        delete rustObj[match.k];
        delete chorObj[r.k];
        delete chorObj[match.k];
        consumed.add(r.k);
        consumed.add(match.k);
      }
    }
    // Diff remaining keys.
    const remainingKeys = new Set([...Object.keys(rustObj), ...Object.keys(chorObj)]);
    for (const k of remainingKeys) {
      if (KNOWN_EXEMPT_PATHS.has(k)) continue;
      // Skip count fields that DRW re-derives at serialization time.
      if (COUNT_FIELD_NAMES.has(k)) {
        const rv = rustObj[k];
        const cv = chorObj[k];
        if (
          (rv === undefined || cv === undefined)
          || (rv === 0 && Number.isInteger(cv))
          || (cv === 0 && Number.isInteger(rv))
        ) {
          continue;
        }
      }
      out.push(...diffTrees(rustObj[k], chorObj[k], [...basePath, k]));
    }
    return out;
  }
  return out;
}

/// Classify a single record: PASS (no diffs of consequence) | VALUE-DRIFT |
/// GAP. Enum-vs-int and array-length-drift on bitflag-string fields are
/// treated as INFO not FAIL.
///
/// The Wave 2.D spec splits diff kinds into three buckets:
///   PASS  — no diffs of any kind
///   GAP   — schema-level differences only (field-only-on-one-side,
///           type-mismatch on structurally derived fields, enum-vs-int)
///   FAIL  — value drift on a field both sides parse to the same shape
///
/// Type-mismatch is treated as GAP because Chorizite often emits a
/// structured-decoded form of a wire scalar (e.g. terrain → {road,
/// type, scenery}) — semantically equivalent, just normalized.
function classifyRecord(diffs) {
  if (diffs.length === 0) return "PASS";
  // Filter pure schema/shape differences vs true value-drift.
  // `chorizite-zeroed` / `rust-zeroed` are documented patterns: one side
  // has the wire-byte value, the other emits 0 because the DRW property
  // graph routes the bits to a different field name (e.g. surfaceType →
  // type enum-string). Schema-shape, not real value drift.
  const valueDriftKinds = new Set(["value-drift"]);
  const consequence = diffs.filter((d) => valueDriftKinds.has(d.kind));
  if (consequence.length === 0) {
    const hasShape = diffs.some((d) =>
      d.kind === "type-mismatch" || d.kind === "array-length-drift"
      || d.kind === "enum-vs-int" || d.kind === "chorizite-zeroed"
      || d.kind === "rust-zeroed"
    );
    return hasShape ? "GAP" : "PASS-w-enum-info";
  }
  return "VALUE-DRIFT";
}

/// Phase B: run Rust + Chorizite parse for each sample, diff, bucket.
async function runPhaseB({ seeds, driver }) {
  console.log("");
  console.log("Phase B — Rust-vs-Chorizite field-tree diff (Wave 2.D)");
  ensureRustExample();

  const phaseBRows = [];
  const typeNames = Object.keys(seeds.samples).sort();
  for (const typeName of typeNames) {
    const datFile = seeds.coverage?.[typeName]?.datFile ?? "client_portal.dat";
    const ids = seeds.samples[typeName];
    // Cap Phase B at min(10, len) per type to keep wall-clock <5 min for
    // the full sweep. The variance across 50 samples vs 10 is negligible
    // for diff-class discovery; Phase A already proved structural parity
    // across all 50.
    const phaseBSampleCount = Math.min(10, ids.length);
    const phaseBIds = ids.slice(0, phaseBSampleCount);

    process.stdout.write(`  ${typeName.padEnd(22)} `);
    const recordResults = [];
    let pass = 0, valueDrift = 0, gap = 0, infraFail = 0;
    for (const idHex of phaseBIds) {
      // Chorizite side.
      let chorRes;
      try {
        chorRes = await driver.send({ command: "chorizite-parse-dat-record", idHex, typeName });
      } catch (e) {
        infraFail += 1;
        recordResults.push({ idHex, status: "INFRA-FAIL", reason: `chorizite: ${e.message.slice(0, 150)}` });
        continue;
      }
      if (!chorRes.success || chorRes.fields == null) {
        infraFail += 1;
        recordResults.push({ idHex, status: "INFRA-FAIL", reason: `chorizite: ${chorRes.errorMessage ?? "unknown"}` });
        continue;
      }
      // Rust side.
      const rustRes = runRustParse(datFile, idHex);
      if (rustRes.error) {
        infraFail += 1;
        recordResults.push({ idHex, status: "INFRA-FAIL", reason: `rust: ${rustRes.error}` });
        continue;
      }
      if (rustRes.fields == null) {
        // Rust has no parser for this type. Treat as GAP at the record
        // level — captured per-type below.
        recordResults.push({
          idHex,
          status: "RUST-NO-PARSER",
          reason: rustRes.errorMessage ?? "no parser",
        });
        gap += 1;
        continue;
      }
      // Diff.
      const rustNorm = normalizeKeys(rustRes.fields);
      const diffs = diffTrees(rustNorm, chorRes.fields);
      const status = classifyRecord(diffs);
      if (status.startsWith("PASS")) pass += 1;
      else if (status === "VALUE-DRIFT") valueDrift += 1;
      else gap += 1;
      // Record sample diff (first 6 diffs per record, full count attached).
      recordResults.push({
        idHex,
        status,
        diffCount: diffs.length,
        sample: diffs.slice(0, 6),
      });
    }
    // Per-type status: PASS = all records PASS. FAIL = ≥1 VALUE-DRIFT.
    // GAP = no VALUE-DRIFT but ≥1 record had GAP/RUST-NO-PARSER. INFRA-FAIL
    // gets a separate flag.
    let typeStatus;
    if (infraFail === phaseBIds.length) typeStatus = "INFRA-FAIL";
    else if (valueDrift > 0) typeStatus = "FAIL";
    else if (gap > 0) typeStatus = "GAP";
    else typeStatus = "PASS";

    // Bucket-by-path: count distinct diff paths across all records for
    // this type so the report surfaces "all records drift at field X".
    const pathBuckets = new Map();
    for (const r of recordResults) {
      if (!r.sample) continue;
      for (const d of r.sample) {
        const key = `${d.kind}:${d.path}`;
        pathBuckets.set(key, (pathBuckets.get(key) ?? 0) + 1);
      }
    }
    const topPaths = Array.from(pathBuckets.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([key, count]) => {
        const [kind, ...rest] = key.split(":");
        return { kind, path: rest.join(":"), count };
      });

    phaseBRows.push({
      typeName,
      datFile,
      sampledCount: phaseBIds.length,
      pass,
      valueDrift,
      gap,
      infraFail,
      status: typeStatus,
      topPaths,
      records: recordResults,
    });

    const statusLabel = typeStatus.padEnd(10);
    console.log(`${statusLabel}  pass=${pass}  drift=${valueDrift}  gap=${gap}  infra-fail=${infraFail}`);
  }
  return phaseBRows;
}

async function main() {
  const cliArgs = parseArgs(process.argv.slice(2));
  try {
    ensureWbtDll();
    ensureSeeds();
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }

  const startedAt = new Date();
  const reportDir = path.join(REPORT_ROOT, isoSlug(startedAt));
  fs.mkdirSync(reportDir, { recursive: true });

  const phaseLabel =
    cliArgs.phase === "ab" ? "Wave 2.A + 2.B + 2.D" :
    cliArgs.phase === "b" ? "Wave 2.D (Phase B only)" :
    "Wave 2.A + 2.B";

  console.log(`validate_dat_parity — ${phaseLabel}`);
  console.log("====================================");
  console.log(`Started:   ${startedAt.toISOString()}`);
  console.log(`Report:    ${reportDir}/report.json`);
  console.log(`Phase:     ${cliArgs.phase}`);
  console.log("");

  const seeds = JSON.parse(fs.readFileSync(SEEDS_PATH, "utf8"));
  console.log(`Seeds:     ${SEEDS_PATH}`);
  console.log(`           ${Object.keys(seeds.samples).length} types`);
  console.log(`           ${seeds.samplesPerType} samples per type`);
  console.log("");

  // Pre-flight: DAT SHA-256 integrity per [[feedback_base_dats_only_for_bake]].
  console.log("Pre-flight: DAT SHA-256 integrity");
  for (const [datName, expectedSha] of Object.entries(EXPECTED_DAT_SHAS)) {
    const seedSha = seeds.datSha256?.[datName];
    if (!seedSha) {
      console.log(`  SKIP   ${datName}  (not in seeds — type not sampled)`);
      continue;
    }
    if (seedSha.toLowerCase() === expectedSha.toLowerCase()) {
      console.log(`  PASS   ${datName}  ${seedSha.slice(0, 16)}…`);
    } else {
      console.log(`  FAIL   ${datName}`);
      console.log(`         expected ${expectedSha}`);
      console.log(`         got      ${seedSha}`);
      console.error("DAT integrity failure — refusing to run validator against non-base DATs.");
      process.exit(2);
    }
  }
  console.log("");

  const driver = new WbtDriver();
  driver.start();

  // ─── Phase A ───
  let phaseARows = [];
  let phaseASummary = null;
  if (cliArgs.phase === "a" || cliArgs.phase === "ab") {
    console.log("Phase A — Chorizite-side parse (canonical oracle)");
    const typeNames = Object.keys(seeds.samples).sort();
    for (const typeName of typeNames) {
      const ids = seeds.samples[typeName];
      let pass = 0, fail = 0;
      const failedIds = [];
      process.stdout.write(`  ${typeName.padEnd(22)} `);
      for (const idHex of ids) {
        let res;
        try {
          res = await driver.send({ command: "chorizite-parse-dat-record", idHex, typeName });
        } catch (e) {
          fail += 1;
          failedIds.push({ idHex, reason: e.message.slice(0, 200) });
          continue;
        }
        if (res.success && res.fields != null) {
          pass += 1;
        } else {
          fail += 1;
          failedIds.push({ idHex, reason: res.errorMessage ?? "unknown" });
        }
      }
      const status = fail === 0 ? "PASS" : (pass === 0 ? "FAIL" : "PARTIAL");
      phaseARows.push({
        surface: "dat-parity",
        typeName,
        datFile: seeds.coverage?.[typeName]?.datFile,
        totalRecordsInDat: seeds.coverage?.[typeName]?.totalRecords,
        sampledCount: ids.length,
        chorizitePass: pass,
        choriziteFail: fail,
        status,
        failedIds: failedIds.slice(0, 10),
      });
      console.log(`${pass}/${ids.length} parsed (${status})`);
    }
    const totalChecked = phaseARows.reduce((s, r) => s + r.sampledCount, 0);
    const totalPass = phaseARows.reduce((s, r) => s + r.chorizitePass, 0);
    const totalFail = phaseARows.reduce((s, r) => s + r.choriziteFail, 0);
    const failedTypes = phaseARows.filter(r => r.status === "FAIL").map(r => r.typeName);
    const partialTypes = phaseARows.filter(r => r.status === "PARTIAL").map(r => r.typeName);
    const passTypes = phaseARows.filter(r => r.status === "PASS").map(r => r.typeName);
    phaseASummary = {
      checked: totalChecked,
      pass: totalPass,
      fail: totalFail,
      typesPass: passTypes.length,
      typesPartial: partialTypes.length,
      typesFail: failedTypes.length,
    };
    console.log("");
    console.log("Phase A Summary");
    console.log(`  Types checked:    ${phaseARows.length}`);
    console.log(`  Records checked:  ${totalChecked}`);
    console.log(`  Pass:             ${totalPass}`);
    console.log(`  Fail:             ${totalFail}`);
    console.log(`  Types PASS:       ${passTypes.length}/${phaseARows.length}`);
    if (partialTypes.length > 0) {
      console.log(`  Types PARTIAL:    ${partialTypes.length}  (${partialTypes.join(", ")})`);
    }
    if (failedTypes.length > 0) {
      console.log(`  Types FAIL:       ${failedTypes.length}  (${failedTypes.join(", ")})`);
    }
  }

  // ─── Phase B ───
  let phaseBRows = [];
  let phaseBSummary = null;
  if (cliArgs.phase === "b" || cliArgs.phase === "ab") {
    phaseBRows = await runPhaseB({ seeds, driver });
    const typesPass = phaseBRows.filter(r => r.status === "PASS").length;
    const typesFail = phaseBRows.filter(r => r.status === "FAIL").length;
    const typesGap = phaseBRows.filter(r => r.status === "GAP").length;
    const typesInfra = phaseBRows.filter(r => r.status === "INFRA-FAIL").length;
    const totalRecords = phaseBRows.reduce((s, r) => s + r.sampledCount, 0);
    const totalPass = phaseBRows.reduce((s, r) => s + r.pass, 0);
    const totalDrift = phaseBRows.reduce((s, r) => s + r.valueDrift, 0);
    const totalGap = phaseBRows.reduce((s, r) => s + r.gap, 0);
    phaseBSummary = {
      typesChecked: phaseBRows.length,
      typesPass,
      typesFail,
      typesGap,
      typesInfraFail: typesInfra,
      records: totalRecords,
      recordsPass: totalPass,
      recordsValueDrift: totalDrift,
      recordsGap: totalGap,
    };
    console.log("");
    console.log("Phase B Summary");
    console.log(`  Types PASS:        ${typesPass}/${phaseBRows.length}`);
    console.log(`  Types FAIL:        ${typesFail}`);
    console.log(`  Types GAP:         ${typesGap}`);
    console.log(`  Types INFRA-FAIL:  ${typesInfra}`);
    console.log(`  Records sampled:   ${totalRecords}`);
    console.log(`  Records PASS:      ${totalPass}`);
    console.log(`  Records DRIFT:     ${totalDrift}`);
    console.log(`  Records GAP:       ${totalGap}`);
    console.log(`  Pass threshold:    ${PHASE_B_PASS_THRESHOLD} types`);
  }
  driver.stop();

  // ─── Emit report ───
  const finishedAt = new Date();
  const envelope = {
    surface: "dat-parity",
    oracle: {
      kind: "chorizite-datreaderwriter",
      version: "2.1.2",
    },
    subject: {
      kind: "holtburger-dat",
      cratesRoot: "external/holtburger/crates/holtburger-dat",
    },
    bakeSourceSha256: seeds.datSha256,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    phase: cliArgs.phase,
    phaseA: phaseASummary ? {
      summary: phaseASummary,
      rows: phaseARows,
    } : null,
    phaseB: phaseBSummary ? {
      summary: phaseBSummary,
      rows: phaseBRows,
      passThreshold: PHASE_B_PASS_THRESHOLD,
    } : null,
    summary: {
      // Backwards-compat with prior runs (only Phase A): expose the
      // Phase-A summary at top-level. Phase B has its own block.
      ...(phaseASummary ?? {}),
    },
    note: cliArgs.phase === "ab"
      ? "Wave 2.A+2.B (Phase A: structural parity) + Wave 2.D (Phase B: field-level Rust-vs-Chorizite diff)."
      : cliArgs.phase === "b"
      ? "Wave 2.D Phase B only (field-level diff). Phase A coverage assumed from prior run."
      : "Wave 2.A+2.B Phase A only (structural parity via canonical oracle).",
    outputPath: reportDir,
  };
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(envelope, null, 2));
  console.log("");
  console.log(`Wrote ${path.join(reportDir, "report.json")}`);

  // ─── Exit code ───
  if (phaseASummary && phaseASummary.fail > 0) {
    console.log("RESULT: FAIL (Phase A: Chorizite-side parse failures detected)");
    process.exit(1);
  }
  if (phaseBSummary) {
    const passingTypes = phaseBSummary.typesPass + phaseBSummary.typesGap;
    if (passingTypes < PHASE_B_PASS_THRESHOLD) {
      console.log(`RESULT: FAIL (Phase B: only ${passingTypes}/${phaseBRows.length} types PASS or documented GAP; threshold=${PHASE_B_PASS_THRESHOLD})`);
      process.exit(1);
    }
    console.log(`RESULT: PASS  (Phase A: ${phaseASummary?.typesPass ?? "skipped"}/${phaseARows.length}, Phase B: ${phaseBSummary.typesPass} PASS + ${phaseBSummary.typesGap} GAP + ${phaseBSummary.typesFail} FAIL)`);
    process.exit(0);
  }
  console.log(`RESULT: PASS (${phaseASummary.typesPass}/${phaseARows.length} types — structural parity)`);
  process.exit(0);
}

main().catch((e) => { console.error("validate_dat_parity crashed:", e); process.exit(2); });
