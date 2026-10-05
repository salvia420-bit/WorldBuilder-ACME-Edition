// harness/wasm_source.cjs — source text of the wasm crate for static
// (text-pin) tests.
//
// recv_loop was split out of src/lib.rs into src/session/** (2026-10-05):
// command arms live in src/session/commands/*.rs and inbound message arms in
// src/session/messages/*.rs. Tests that pin Rust source text read the whole
// crate — src/lib.rs followed by every src/**/*.rs module (sorted, each
// preceded by a `// ==== <path> ====` marker line) — so a pin keeps passing as
// long as the code exists SOMEWHERE in the crate.
"use strict";
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");

function rustPaths(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...rustPaths(p));
    else if (ent.name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** src/lib.rs first, then every other src/**\/*.rs (sorted). */
function readWasmSource(appRoot = APP_ROOT) {
  const src = path.join(appRoot, "src");
  const lib = path.join(src, "lib.rs");
  const rest = rustPaths(src).filter((p) => p !== lib).sort();
  return [lib, ...rest]
    .map((p) => `// ==== ${path.relative(appRoot, p)} ====\n` + fs.readFileSync(p, "utf8"))
    .join("\n");
}

module.exports = { readWasmSource };
