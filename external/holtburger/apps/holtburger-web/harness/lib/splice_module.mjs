// harness/lib/splice_module.mjs — load an app ES module into `new Function()`.
//
// WHY THIS EXISTS (2026-08-03 review, finding F2)
// ----------------------------------------------
// Several suites hand-rolled an import stripper that removed ONE hardcoded
// specifier, e.g.
//
//     .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/adapter\.js["'];?\s*$/m, "")
//
// `scene3d/materials.js` has since grown vfx_flags / quality / suite_assets /
// bc7_textures imports, so a static `import` survived into the `new Function`
// body and every such suite died with
//
//     SyntaxError: Cannot use import statement outside a module
//
// Four suites were in that state and nobody noticed, because their
// `locateThree()` exited 0 before ever reaching the splice.
//
// CONTRACT (deliberate): stubs are EXPLICIT. Any imported name that the
// stripped source does not itself define and the caller did not stub is a
// hard error naming the symbol. The alternative — a permissive catch-all
// Proxy stub — makes every assertion that touches it unfalsifiable, which is
// the same class of defect this review exists to remove. A loud
// "you must stub X" is always preferable to a silent truthy X.

const IMPORT_PATTERNS = [
  // import { a, b as c } from "x";   (brace body may span lines)
  /^[ \t]*import\s+\{[^}]*\}\s+from\s+["'][^"']+["'];?[ \t]*$/gm,
  // import * as NS from "x";
  /^[ \t]*import\s+\*\s+as\s+[A-Za-z_$][\w$]*\s+from\s+["'][^"']+["'];?[ \t]*$/gm,
  // import Default, { a } from "x";  /  import Default from "x";
  /^[ \t]*import\s+[A-Za-z_$][\w$]*\s*(?:,\s*\{[^}]*\})?\s*from\s+["'][^"']+["'];?[ \t]*$/gm,
  // import "x";  (side-effect only)
  /^[ \t]*import\s+["'][^"']+["'];?[ \t]*$/gm,
];

/** Every identifier bound by a static import in `src`. */
export function importedNames(src) {
  const out = new Set();
  const re = /^[ \t]*import\s+([\s\S]*?)\s+from\s+["'][^"']+["'];?[ \t]*$/gm;
  let m;
  while ((m = re.exec(src)) !== null) {
    const spec = m[1].trim();
    const braces = /\{([\s\S]*?)\}/.exec(spec);
    if (braces) {
      for (const part of braces[1].split(",")) {
        const id = part.trim().split(/\s+/).pop();
        if (/^[A-Za-z_$][\w$]*$/.test(id ?? "")) out.add(id);
      }
    }
    const lead = spec.split("{")[0].replace(/\*\s+as\s+/, "").replace(/,\s*$/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(lead)) out.add(lead);
  }
  return out;
}

/** Remove every static import declaration. Dynamic `await import(...)` is untouched. */
export function stripStaticImports(src) {
  let out = src;
  for (const re of IMPORT_PATTERNS) out = out.replace(re, "");
  return out;
}

/** Turn `export`ed declarations into plain ones so they land in the Function scope. */
export function stripExports(src) {
  return src
    .replace(/^[ \t]*export\s+async\s+function\s+/gm, "async function ")
    .replace(/^[ \t]*export\s+function\s*\*/gm, "function*")
    .replace(/^[ \t]*export\s+function\s+/gm, "function ")
    .replace(/^[ \t]*export\s+class\s+/gm, "class ")
    .replace(/^[ \t]*export\s+const\s+/gm, "const ")
    .replace(/^[ \t]*export\s+let\s+/gm, "let ")
    .replace(/^[ \t]*export\s+var\s+/gm, "var ")
    .replace(/^[ \t]*export\s+default\s+/gm, "")
    .replace(/^[ \t]*export\s+\{[^}]*\}[ \t]*(?:from\s+["'][^"']+["'])?[\s;]*$/gm, "");
}

/** True when `src` declares `name` at any scope (good enough for splice checks). */
function declares(src, name) {
  return new RegExp(
    `(?:^|\\n)[ \\t]*(?:async\\s+)?(?:function\\*?|class|const|let|var)\\s+${name}\\b`
  ).test(src);
}

/**
 * Build a `new Function` body from an app module.
 *
 * @param {string} src        raw module source
 * @param {object} [opts]
 * @param {Record<string,string>} [opts.stubs]  name -> JS initialiser source
 * @param {string[]} [opts.provided]  names supplied as Function() parameters
 *                                    (e.g. "THREE") — never need a stub
 * @param {string} [opts.label]  module name, for error messages
 * @returns {string} the composed body (stub prelude + stripped source)
 */
export function spliceModule(src, opts = {}) {
  const { stubs = {}, provided = ["THREE"], label = "module" } = opts;
  const names = importedNames(src);
  const body = stripExports(stripStaticImports(src));

  const unresolved = [...names].filter(
    (n) => !provided.includes(n) && !(n in stubs) && !declares(body, n)
  );
  if (unresolved.length) {
    throw new Error(
      `spliceModule(${label}): ${unresolved.length} imported symbol(s) are neither ` +
      `declared in the module nor stubbed: ${unresolved.join(", ")}.\n` +
      `  Add them to the \`stubs\` map (an explicit stub, NOT a catch-all proxy — a\n` +
      `  permissive stub silently makes assertions that touch it unfalsifiable).`
    );
  }
  // Any leftover `import`/`export` keyword at statement position means a form
  // the strippers do not know; fail here rather than inside new Function().
  const leftover = body.match(/^[ \t]*(?:import|export)\s[^\n]*/m);
  if (leftover) {
    throw new Error(
      `spliceModule(${label}): an import/export survived stripping:\n    ${leftover[0].trim()}\n` +
      `  Teach harness/lib/splice_module.mjs that form.`
    );
  }

  const prelude = Object.entries(stubs)
    .filter(([n]) => !declares(body, n))
    .map(([n, init]) => `const ${n} = ${init};`)
    .join("\n");
  return (prelude ? prelude + "\n" : "") + body;
}
