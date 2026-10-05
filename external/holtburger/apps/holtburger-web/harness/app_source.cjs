// harness/app_source.cjs — source text of the client's boot orchestrator for
// static (text-pin) tests.
//
// index.html's inline <script type="module"> was split into ES modules under
// app/ (2026-10-05): the ClientEvent dispatcher, the per-frame entity drain,
// chat/slash commands, the server picker, the autoLogin orchestrator, …
// Tests that pin source text used to read index.html alone; they now read the
// whole orchestrator — index.html followed by every app/*.js module (sorted,
// each preceded by a `// ==== app/<name> ====` marker line) — so a pin keeps
// passing as long as the code exists SOMEWHERE in the boot orchestrator.
//
// CommonJS so both the .cjs suites (require) and the .mjs suites (import)
// can use it.
"use strict";
const fs = require("fs");
const path = require("path");

const APP_ROOT = path.resolve(__dirname, "..");

/** Every app/*.js module path, sorted (absolute). */
function appModulePaths(appRoot = APP_ROOT) {
  const dir = path.join(appRoot, "app");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => path.join(dir, f));
}

/** index.html + every app/*.js, concatenated. */
function readAppSource(appRoot = APP_ROOT) {
  const parts = [fs.readFileSync(path.join(appRoot, "index.html"), "utf8")];
  for (const p of appModulePaths(appRoot)) {
    parts.push(`// ==== app/${path.basename(p)} ====`);
    parts.push(fs.readFileSync(p, "utf8"));
  }
  return parts.join("\n");
}

/** One app/ module's source (name with or without the .js suffix). */
function readAppModule(name, appRoot = APP_ROOT) {
  const f = name.endsWith(".js") ? name : `${name}.js`;
  return fs.readFileSync(path.join(appRoot, "app", f), "utf8");
}

module.exports = { APP_ROOT, appModulePaths, readAppSource, readAppModule };
