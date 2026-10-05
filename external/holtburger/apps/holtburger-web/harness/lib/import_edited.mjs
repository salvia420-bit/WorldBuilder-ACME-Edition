// harness/lib/import_edited.mjs — import an app ES module with a TEST SEAM
// edited into its source, while every dependency stays the GENUINE module.
//
// WHY (2026-10-05). Several suites text-splice scene3d/entities.js into
// `new Function()` so they can patch one line (a test seam). That forces them
// to strip every static import and hand-stub the bindings, a list that rots on
// each new import (module-top-level reader calls, spawn-path helpers…) and
// quietly turns real code paths into stubs. Here the edited source is loaded
// as a `data:` ES module instead: its relative / bare import specifiers are
// rewritten to the absolute file URLs Node would have resolved, so it links
// against the SAME already-loaded dependency instances (one `three`, one
// materials.js, …) and nothing has to be stubbed.
//
// Contract: the edit callback must CHANGE the source (a no-op edit means the
// seam's anchor text drifted) — that is a hard error, never a silent pass.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(APP_ROOT, "package.json"));

function resolveBare(spec) {
  // `three` and `three/addons/...` (the only bare specifiers scene3d uses).
  if (spec === "three") return pathToFileURL(join(APP_ROOT, "node_modules/three/build/three.module.js")).href;
  if (spec.startsWith("three/addons/")) {
    return pathToFileURL(join(APP_ROOT, "node_modules/three/examples/jsm", spec.slice("three/addons/".length))).href;
  }
  return pathToFileURL(require.resolve(spec)).href;
}

/**
 * @param {string} relPath  module path relative to the app root (e.g. "scene3d/entities.js")
 * @param {(src: string) => string} edit  returns the edited source; must differ
 * @param {string} [salt]  distinguishes multiple edited instances
 * @returns {Promise<object>} the module namespace
 */
export async function importEdited(relPath, edit, salt = "") {
  const abs = join(APP_ROOT, relPath);
  const baseUrl = pathToFileURL(abs);
  const raw = readFileSync(abs, "utf8");
  const edited = edit(raw);
  if (edited === raw) {
    throw new Error(`importEdited(${relPath}): the edit changed nothing — the seam's anchor text drifted`);
  }
  const fix = (spec) => {
    if (spec.startsWith("./") || spec.startsWith("../")) return new URL(spec, baseUrl).href;
    if (spec.startsWith("file:") || spec.startsWith("data:") || spec.startsWith("node:")) return spec;
    return resolveBare(spec);
  };
  const rewritten = edited
    // static `import … from "x"` / `export … from "x"`. The clause between the
    // keyword and `from` may only hold binding syntax (identifiers, `*`, `as`,
    // braces, commas, whitespace, line comments) — so prose like
    // `... from "arm in dead code"` inside a comment is never touched.
    .replace(/(^[ \t]*(?:import|export)\s+(?:[\w$*\s{},]|\/\/[^\n]*\n)*?\bfrom\s+)(["'])([^"']+)\2/gm,
      (_, kw, q, spec) => `${kw}${q}${fix(spec)}${q}`)
    // side-effect: `import "x";`
    .replace(/(^[ \t]*import\s+)(["'])([^"']+)\2/gm, (_, kw, q, spec) => `${kw}${q}${fix(spec)}${q}`)
    // dynamic: `import("./x")` / `import("three")` with a literal specifier
    // (relative, or one of the bare ones resolveBare knows)
    .replace(/(\bimport\(\s*)(["'])(\.{1,2}\/[^"']+|three(?:\/addons\/[^"']+)?)\2/g,
      (_, kw, q, spec) => `${kw}${q}${fix(spec)}${q}`)
    // module-relative URLs the module builds itself
    .replace(/\bimport\.meta\.url\b/g, JSON.stringify(baseUrl.href));
  const url = "data:text/javascript;base64," +
    Buffer.from(`// importEdited:${relPath}:${salt}\n${rewritten}`).toString("base64");
  return import(url);
}
