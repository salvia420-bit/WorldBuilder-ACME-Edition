// harness/test_shell_gate.mjs — scripts/shell_gate.cjs (bundled page gate in proxy.cjs).
//
// What must hold:
//   - only the app index (index.html, or the bare directory) is ever rewritten,
//     and the query string survives the rewrite;
//   - the bundled page is served ONLY while every recorded input still hashes
//     the same — a changed, deleted, or unrecorded-manifest input means the
//     live page, with the reason in the decision;
//   - a stale bundle schedules ONE background rebuild after the sources have
//     been quiet for `quietMs`, and the gate serves the bundle again once the
//     rebuild lands;
//   - `?shell=off` and HB_SHELL=off are honoured; HB_SHELL_AUTOBUILD=0 never
//     builds.
//
// Run: cd apps/holtburger-web && node harness/test_shell_gate.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createShellGate, BUNDLED_PATH } = require(path.resolve(HERE, "../../../scripts/shell_gate.cjs"));

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "shell-gate-"));
const app = path.join(root, "apps", "holtburger-web");
fs.mkdirSync(path.join(app, "shell"), { recursive: true });
fs.mkdirSync(path.join(app, "scene3d"), { recursive: true });
const write = (rel, text) => fs.writeFileSync(path.join(app, rel), text);
function writeBuild(tag = "v1") {
  write("index-bundled.html", `<html>${tag}</html>`);
  write(`shell/app-${tag}.js`, `// ${tag}`);
  write("shell-manifest.json", JSON.stringify({
    entries: { app: { file: `app-${tag}.js` } },
    inputs: {
      "index.html": sha(fs.readFileSync(path.join(app, "index.html"))),
      "scene3d/a.js": sha(fs.readFileSync(path.join(app, "scene3d/a.js"))),
    },
  }));
}
write("index.html", "<html>live</html>");
write("scene3d/a.js", "export const a = 1;");

let t = Date.now(); // file mtimes are wall-clock; the gate compares against now()
const now = () => t;
const builds = [];
const mk = (extra = {}) => createShellGate({
  appRoot: app, quietMs: 50, cacheMs: 0, now, log: () => {}, env: {},
  runBuild: (o, done) => { builds.push(o); writeBuild(`v${builds.length + 1}`); done(true); },
  ...extra,
});

console.log("\nrouting");
{
  writeBuild("v1");
  const g = mk();
  const d = g.decide("/apps/holtburger-web/index.html?autoLogin=1&x=2");
  check("fresh bundle ⇒ served", d?.serveBundled === true && d.path === `${BUNDLED_PATH}?autoLogin=1&x=2`, JSON.stringify(d));
  check("bare directory URL is the index too", g.decide("/apps/holtburger-web/")?.serveBundled === true);
  check("any other path is not touched", g.decide("/apps/holtburger-web/scene3d/a.js") === null
    && g.decide("/apps/holtburger-web/index-bundled.html") === null && g.decide("/dist/manifest.json") === null);
  const off = g.decide("/apps/holtburger-web/index.html?shell=off");
  check("?shell=off ⇒ live page", off?.serveBundled === false && off.reason === "shell=off" && off.path.includes("index.html"));
  g.dispose();
  const g2 = mk({ env: { HB_SHELL: "off" } });
  check("HB_SHELL=off ⇒ live page", g2.decide("/apps/holtburger-web/index.html")?.reason === "HB_SHELL=off");
  g2.dispose();
}

console.log("\nstaleness");
{
  writeBuild("v1");
  builds.length = 0;
  const g = mk();
  check("starts fresh", g.decide("/apps/holtburger-web/index.html").serveBundled === true);
  write("scene3d/a.js", "export const a = 2; // edited");
  const d = g.decide("/apps/holtburger-web/index.html");
  check("an edited input ⇒ live page, reason names the file",
    d.serveBundled === false && d.reason === "changed: scene3d/a.js", JSON.stringify(d));
  // The background build waits for the quiet period, then rebuilds once.
  t += 1000;
  await new Promise((r) => setTimeout(r, 120));
  check("one rebuild scheduled after the quiet period", builds.length === 1, String(builds.length));
  const after = g.decide("/apps/holtburger-web/index.html");
  check("…and the fresh bundle is served again", after.serveBundled === true, JSON.stringify(after));
  fs.unlinkSync(path.join(app, "scene3d/a.js"));
  check("a deleted input ⇒ live page", g.decide("/apps/holtburger-web/index.html").serveBundled === false);
  write("scene3d/a.js", "export const a = 2; // edited");
  g.dispose();
}

console.log("\nunusable builds");
{
  const g = mk({ autoBuild: false });
  write("shell-manifest.json", JSON.stringify({ entries: { app: { file: "app-v9.js" } } }));
  check("a manifest without inputs (pre-2026-10-06 build) is never trusted",
    /no inputs/.test(g.decide("/apps/holtburger-web/index.html").reason));
  writeBuild("v1");
  fs.unlinkSync(path.join(app, "shell", "app-v1.js"));
  check("a missing app bundle file ⇒ live page", /missing/.test(g.decide("/apps/holtburger-web/index.html").reason));
  fs.unlinkSync(path.join(app, "index-bundled.html"));
  check("not built ⇒ live page", g.decide("/apps/holtburger-web/index.html").reason === "not built");
  builds.length = 0;
  t += 1000;
  await new Promise((r) => setTimeout(r, 120));
  check("autoBuild off ⇒ never builds", builds.length === 0);
  g.dispose();
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
