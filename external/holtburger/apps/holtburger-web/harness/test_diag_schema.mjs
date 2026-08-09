// harness/test_diag_schema.mjs — Tier-1 lint for the diag-surface registry
// (SPEC §1.7 / pass-10 D-10.1 point 2, D-10.3; T01 deliverable).
//
// Pure Node, no browser, no wasm. Run: node harness/test_diag_schema.mjs
// Exit 0 = registry clean AND the lint's own negative checks hold.
//
// Three parts:
//   A. validateRegistry() over the REAL registry must be green.
//   B. Evidence re-verification: every `current` surface's cited file:line is
//      opened and the surface's bare name must appear within ±5 lines — so a
//      registration site that moves or dies makes THIS lint fail instead of
//      the registry silently rotting (the read-verify rule, mechanical).
//   C. Negative checks: hand-built bad registries must FAIL for the right
//      reason (a lint that cannot say NO proves nothing).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REGISTRY, SCALE_TAGS, RESERVED_NAMES,
  validateRegistry, validateField, getSurface, listSurfaces,
} from "./lib/diag_schema.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..");

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`  FAIL ${label}`); }
};

// ── A. the real registry lints green ───────────────────────────────────────
{
  const { ok: clean, errors } = validateRegistry();
  for (const e of errors) console.error(`  registry error: ${e}`);
  ok(clean, `registry validates (${errors.length} errors)`);
  ok(REGISTRY.length >= 10, `registry has surfaces (${REGISTRY.length})`);
  // The task-required current surfaces are all present.
  for (const name of ["__bc7Stats", "__xu7Stats", "__terrainBc7Stats", "__diag.wasmMem", "__diag.render", "__hbWasmMemory"]) {
    ok(getSurface(name)?.status === "current", `current surface registered: ${name}`);
  }
  // The pass-10 S3 new-architecture names are reserved until their stage
  // lands them (registry rule: the reserved schema IS the normative target).
  for (const name of ["__diag.residency", "__diag.pools", "__texStats", "__diag.geometry", "__prewarmStats"]) {
    ok(RESERVED_NAMES.includes(name), `reserved name claimed: ${name}`);
  }
  // Landed at their stage (T21/ST8 flipped these reserved -> current with
  // the reserved field schemas kept intact + stage-A additions; T12/ST2
  // did the same for __hbFetch).
  for (const name of ["__framePhase", "__frameWork", "__hbFetch"]) {
    ok(getSurface(name)?.status === "current", `stage surface landed current: ${name}`);
  }
  // Same-name-successor rule is exercised by the real data.
  ok(getSurface("__atlasStats")?.successor === "__diag.pools", "__atlasStats -> __diag.pools successor link");
  ok(getSurface("__landblockLru.getStats")?.successor === "__diag.residency", "__landblockLru.getStats -> __diag.residency successor link");
  // Vocabulary is the closed S1 set (spot checks, both directions).
  for (const t of ["resident", "submitted", "wire", "in-world", "preview-complete", "converged", "moving", "heap", "wasmLinear", "cpuMirror", "vramEst", "pinned", "leased"]) {
    ok(SCALE_TAGS.includes(t), `S1 tag present: ${t}`);
  }
  ok(!SCALE_TAGS.includes("total") && !SCALE_TAGS.includes("live"), "no off-vocabulary tags leaked in");
}

// ── B. evidence re-verification against the live tree ──────────────────────
{
  for (const s of REGISTRY) {
    if (s.status !== "current") continue;
    const m = /^(\S+):(\d+)$/.exec(s.evidence || "");
    if (!m) { ok(false, `${s.name}: unparseable evidence`); continue; }
    const file = path.join(APP_ROOT, m[1]);
    const line = Number(m[2]);
    let lines;
    try {
      lines = readFileSync(file, "utf8").split("\n");
    } catch (e) {
      ok(false, `${s.name}: evidence file unreadable: ${m[1]}`);
      continue;
    }
    // Probe token: for "__diag.x" surfaces the discriminating token is "x"
    // ("__diag" appears everywhere); for other dotted names ("__landblockLru
    // .getStats") it is the window-global FIRST segment.
    const segs = s.name.split(".");
    const bare = segs[0] === "__diag" ? segs[1] : segs[0];
    const lo = Math.max(0, line - 6);
    const hi = Math.min(lines.length, line + 5);
    const hit = lines.slice(lo, hi).some((l) => l.includes(bare));
    ok(hit, `${s.name}: "${bare}" appears near ${m[1]}:${line}`);
  }
}

// ── C. the lint can say NO ─────────────────────────────────────────────────
{
  const base = { status: "current", reads: "object", evidence: "index.html:1", availability: "boot" };
  const expectErr = (registry, needle, label) => {
    const { ok: clean, errors } = validateRegistry(registry);
    ok(!clean && errors.some((e) => e.includes(needle)), `${label} (want error containing "${needle}")`);
  };

  // counter priced without ms unit
  expectErr(
    [{ ...base, name: "__bad1", fields: { draws: { kind: "counter", unit: "count", attribution: true } } }],
    "counts are never priced", "attribution on a count fails",
  );
  // Ms-suffixed name with wrong unit
  expectErr(
    [{ ...base, name: "__bad2", fields: { transcodeMs: { kind: "counter", unit: "count" } } }],
    "ends in Ms but unit", "Ms suffix / unit mismatch fails",
  );
  // Bytes-suffixed name with wrong unit
  expectErr(
    [{ ...base, name: "__bad3", fields: { poolBytes: { kind: "level", unit: "count" } } }],
    "ends in Bytes but unit", "Bytes suffix / unit mismatch fails",
  );
  // bytes without a scale tag (the 2x trap)
  expectErr(
    [{ ...base, name: "__bad4", fields: { poolBytes: { kind: "level", unit: "bytes" } } }],
    "must declare at least one @scale", "untagged bytes fails",
  );
  // unknown scale tag
  expectErr(
    [{ ...base, name: "__bad5", fields: { poolBytes: { kind: "level", unit: "bytes", scale: ["total"] } } }],
    'unknown scale tag "total"', "off-vocabulary tag fails",
  );
  // missing kind
  expectErr(
    [{ ...base, name: "__bad6", fields: { x: { unit: "count" } } }],
    "kind must be one of", "missing kind fails",
  );
  // retiring surface without a successor
  expectErr(
    [{ ...base, name: "__bad7", retiresAt: "ST9", fields: { x: { kind: "level", unit: "count" } } }],
    "without a successor", "retiresAt without successor fails",
  );
  // retiring surface whose successor is not registered
  expectErr(
    [{ ...base, name: "__bad8", retiresAt: "ST9", successor: "__ghost", fields: { x: { kind: "level", unit: "count" } } }],
    "is not registered", "unregistered successor fails",
  );
  // duplicate names
  expectErr(
    [
      { ...base, name: "__dup", fields: { x: { kind: "level", unit: "count" } } },
      { ...base, name: "__dup", fields: { x: { kind: "level", unit: "count" } } },
    ],
    "duplicate surface name", "duplicate name fails",
  );
  // current surface without file:line evidence
  expectErr(
    [{ ...base, name: "__bad9", evidence: "somewhere in the tree", fields: { x: { kind: "level", unit: "count" } } }],
    "must cite evidence", "prose evidence fails",
  );
  // empty fields without opaque
  expectErr(
    [{ ...base, name: "__bad10", fields: {} }],
    "not marked opaque", "field-less non-opaque surface fails",
  );
  // opaque without a note
  expectErr(
    [{ ...base, name: "__bad11", opaque: true, fields: {} }],
    "must carry a note", "note-less opaque surface fails",
  );
  // reserved without a spec citation
  expectErr(
    [{ name: "__bad12", status: "reserved", reads: "object", availability: "reserved:STn", fields: { x: { kind: "level", unit: "count" } } }],
    "must cite its spec", "spec-less reserved surface fails",
  );

  // validateField directly: a clean field is clean.
  ok(validateField("__s", "linkStatusMs", { kind: "counter", unit: "ms", attribution: true }).length === 0,
    "attribution on a *Ms counter is legal");
  ok(validateField("__s", "bytes", { kind: "counter", unit: "bytes", scale: ["wire"] }).length === 0,
    "bare 'bytes' name with @wire is legal");
  // listSurfaces filters
  ok(listSurfaces("reserved").length === RESERVED_NAMES.length, "listSurfaces(reserved) matches RESERVED_NAMES");
}

console.log(`diag-schema lint: ${passed} passed, ${failed} failed (registry: ${REGISTRY.length} surfaces, ${SCALE_TAGS.length} tags)`);
if (failed === 0) {
  console.log("DIAG-SCHEMA ✅");
  process.exit(0);
} else {
  console.error("DIAG-SCHEMA ❌");
  process.exit(1);
}
