// E11 (2026-06-08) — plugin manifest-index generator + schema-validator test.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web && \
//     node test_plugin_index_gen.mjs
//
// Covers the three load-bearing exports of plugins/gen-index.mjs:
//   - validateAgainstSchema(value, schema) — minimal structural JSON-Schema
//     checker (required / type / enum / pattern / minLength / uniqueItems /
//     nested items+properties). Driven off the real schema file.
//   - build() — scans plugins/*.manifest.json, validates each, returns
//     stable-sorted descriptors + per-file results.
//   - serializeIndex(descriptors) — deterministic, byte-stable serializer.
//
// Pattern mirrors test_lifestone_popup.mjs (custom check/assertEq harness, no
// test-runner dependency). Pure file/JSON work — no DOM, no wasm shim needed.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath, join } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const genUrl = pathToFileURL(
  resolvePath(__dirname, "plugins/gen-index.mjs"),
).href;
const { validateAgainstSchema, build, serializeIndex } = await import(genUrl);

const SCHEMA = JSON.parse(
  readFileSync(join(__dirname, "plugins", "schemas", "plugin-manifest.json"), "utf8"),
);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}
function assertTrue(cond, label) {
  if (!cond) throw new Error(label);
}

// A minimal valid manifest used as a base for mutation tests.
function validManifest(over = {}) {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "0.1.0",
    entry: "./test-plugin.js",
    environments: ["browser"],
    slots: ["panel"],
    ...over,
  };
}

console.log("===========================================================");
console.log("E11 — plugin manifest-index generator + schema validator");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports validateAgainstSchema / build / serializeIndex", () => {
  assertTrue(typeof validateAgainstSchema === "function", "validateAgainstSchema not a function");
  assertTrue(typeof build === "function", "build not a function");
  assertTrue(typeof serializeIndex === "function", "serializeIndex not a function");
});

console.log("\n[2] validateAgainstSchema — happy path");

check("a fully-valid manifest produces zero errors", () => {
  assertEq(validateAgainstSchema(validManifest(), SCHEMA), [], "valid manifest");
});

check("optional fields may be omitted (only id/name/version required)", () => {
  assertEq(
    validateAgainstSchema({ id: "x", name: "X", version: "1.0.0" }, SCHEMA),
    [],
    "minimal manifest",
  );
});

console.log("\n[3] validateAgainstSchema — required keys");

check("missing required id is reported", () => {
  const errs = validateAgainstSchema({ name: "X", version: "1.0.0" }, SCHEMA);
  assertTrue(errs.some((e) => e.includes('required key "id"')), `got ${JSON.stringify(errs)}`);
});

check("missing required name AND version are BOTH reported (collect-all)", () => {
  const errs = validateAgainstSchema({ id: "x" }, SCHEMA);
  assertTrue(errs.some((e) => e.includes('"name"')), `name missing not reported: ${JSON.stringify(errs)}`);
  assertTrue(errs.some((e) => e.includes('"version"')), `version missing not reported: ${JSON.stringify(errs)}`);
});

console.log("\n[4] validateAgainstSchema — types");

check("non-string id reported as type error", () => {
  const errs = validateAgainstSchema(validManifest({ id: 42 }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("id:") && e.includes("type")), JSON.stringify(errs));
});

check("a null root manifest is rejected (not silently skipped)", () => {
  // A *.manifest.json file containing literal `null` parses to null; build()
  // must validate it so it can never slip into the index as a phantom plugin.
  const errs = validateAgainstSchema(null, SCHEMA);
  assertTrue(errs.length > 0, `null root should error, got ${JSON.stringify(errs)}`);
  assertTrue(errs.some((e) => e.includes("type")), `expected a type error, got ${JSON.stringify(errs)}`);
});

check("a non-object root manifest (e.g. 42 / []) is rejected", () => {
  assertTrue(validateAgainstSchema(42, SCHEMA).length > 0, "number root should error");
  assertTrue(validateAgainstSchema([], SCHEMA).length > 0, "array root should error");
});

check("non-array dependencies reported as type error", () => {
  const errs = validateAgainstSchema(validManifest({ dependencies: "inventory" }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("dependencies:") && e.includes("type")), JSON.stringify(errs));
});

check("non-boolean iconHidden reported", () => {
  const errs = validateAgainstSchema(validManifest({ iconHidden: "yes" }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("iconHidden:")), JSON.stringify(errs));
});

console.log("\n[5] validateAgainstSchema — pattern + minLength");

check("version not matching semver pattern is reported", () => {
  const errs = validateAgainstSchema(validManifest({ version: "v1" }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("version:") && e.includes("match")), JSON.stringify(errs));
});

check("System.Version 4-part shape (1.2.3.4) passes the version pattern", () => {
  assertEq(validateAgainstSchema(validManifest({ version: "1.2.3.4" }), SCHEMA), [], "4-part version");
});

check("id with illegal char (space) fails the id pattern", () => {
  const errs = validateAgainstSchema(validManifest({ id: "bad id" }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("id:") && e.includes("match")), JSON.stringify(errs));
});

check("empty name fails minLength", () => {
  const errs = validateAgainstSchema(validManifest({ name: "" }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("name:")), JSON.stringify(errs));
});

console.log("\n[6] validateAgainstSchema — enums + arrays");

check("environments enum rejects unknown value", () => {
  const errs = validateAgainstSchema(validManifest({ environments: ["desktop"] }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("environments[0]:") && e.includes("one of")), JSON.stringify(errs));
});

check("slots enum accepts the full allowed set", () => {
  assertEq(
    validateAgainstSchema(validManifest({ slots: ["bar", "hud", "panel", "overlay", "watcher"] }), SCHEMA),
    [],
    "all slots",
  );
});

check("slots uniqueItems rejects duplicates", () => {
  const errs = validateAgainstSchema(validManifest({ slots: ["panel", "panel"] }), SCHEMA);
  assertTrue(errs.some((e) => e.startsWith("slots:") && e.includes("unique")), JSON.stringify(errs));
});

console.log("\n[7] validateAgainstSchema — nested hotkeys objects");

check("valid hotkey object passes", () => {
  assertEq(
    validateAgainstSchema(validManifest({ hotkeys: [{ id: "toggle", default: "F5", label: "L" }] }), SCHEMA),
    [],
    "valid hotkey",
  );
});

check("hotkey missing required 'default' is reported at path", () => {
  const errs = validateAgainstSchema(validManifest({ hotkeys: [{ id: "toggle" }] }), SCHEMA);
  assertTrue(errs.some((e) => e.includes("hotkeys[0]") && e.includes('"default"')), JSON.stringify(errs));
});

check("hotkey with extra key rejected (additionalProperties:false)", () => {
  const errs = validateAgainstSchema(validManifest({ hotkeys: [{ id: "t", default: "F5", bogus: 1 }] }), SCHEMA);
  assertTrue(errs.some((e) => e.includes("hotkeys[0]") && e.includes("unexpected")), JSON.stringify(errs));
});

console.log("\n[8] build() — scans + validates the real plugins dir");

const built = build();

check("build() returns descriptors + results + schema", () => {
  assertTrue(Array.isArray(built.descriptors), "descriptors not array");
  assertTrue(Array.isArray(built.results), "results not array");
  assertTrue(built.schema && typeof built.schema === "object", "schema missing");
});

check("EVERY on-disk *.manifest.json passes schema validation (0 errors)", () => {
  const broken = built.results.filter((r) => r.errors.length > 0);
  assertEq(broken.map((r) => `${r.file}: ${r.errors.join("; ")}`), [], "broken manifests");
});

check("every descriptor has manifestPath + devPath pointing at a real stem", () => {
  for (const d of built.descriptors) {
    assertTrue(/^\.\/[a-z0-9.\-]+\.manifest\.json$/.test(d.manifestPath), `bad manifestPath ${d.manifestPath}`);
    const stem = d.manifestPath.replace(/^\.\//, "").replace(/\.manifest\.json$/, "");
    assertEq(d.devPath, `./${stem}.manifest.dev.json`, `devPath for ${stem}`);
  }
});

check("descriptors are stable-sorted by manifest id (corrected ordering)", () => {
  // build() sorts the VALID results by id; descriptors follow that order. The
  // id list must be strictly ascending. This is the fix vs the old hand-list,
  // which had examine-target before examine-floaty and spellbook before
  // spell-research-panel.
  // Code-point compare, matching build()'s host-independent sort (NOT
  // localeCompare, which is ICU/locale-sensitive and could reorder punctuation).
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const ids = built.results.filter((r) => r.errors.length === 0).map((r) => r.id);
  const sorted = [...ids].sort(cmp);
  assertEq(ids, sorted, "ids not ascending");
});

console.log("\n[9] serializeIndex() — determinism + parseability");

check("serializeIndex output is valid JSON and round-trips the descriptors", () => {
  const text = serializeIndex(built.descriptors);
  const parsed = JSON.parse(text);
  assertEq(parsed.plugins, built.descriptors, "round-trip descriptors");
  assertTrue(typeof parsed.$comment === "string" && parsed.$comment.includes("GENERATED"), "missing GENERATED comment");
});

check("serializeIndex is deterministic (byte-identical across calls)", () => {
  const a = serializeIndex(built.descriptors);
  const b = serializeIndex(built.descriptors);
  assertTrue(a === b, "two serializations differ");
});

check("serializeIndex ends with a single trailing newline", () => {
  const text = serializeIndex(built.descriptors);
  assertTrue(text.endsWith("}\n") && !text.endsWith("}\n\n"), "trailing newline contract");
});

check("the committed plugins/index.json matches freshly-generated output", () => {
  // This is the same invariant `gen-index.mjs --check` enforces in CI: the
  // checked-in index must equal what the generator produces right now.
  const onDisk = readFileSync(join(__dirname, "plugins", "index.json"), "utf8");
  const fresh = serializeIndex(built.descriptors);
  assertTrue(onDisk === fresh, "plugins/index.json is STALE — run: node plugins/gen-index.mjs");
});

console.log("\n===========================================================");
console.log(`PASS: ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log(`FAIL: ${failed}`);
  process.exit(1);
}
