// combat_install_giveup.test.mjs — the three combat modules must say something
// when they give up waiting for the plugin bus.
//
// NEW 2026-08-03. `installKillImpulse`, `installCarnage` and
// `installBloodDecals` each retry `_bind()` 60 times at 2 s intervals and then
// ended the chain in SILENCE. The success arms log ("[carnage] armed",
// "[blood] armed"), so a reader watching the console sees nothing at all in the
// failure case — three DEFAULT-ON features permanently inert with zero
// evidence. That is the "shipped but never executed" signature the 2026-08-03
// Round-7 review names, and the reason it stays invisible.
//
// The bus is simply never installed here (`window.__pluginClient` is absent)
// and `setTimeout` is replaced with an immediate scheduler, so the whole
// two-minute retry ladder runs synchronously.
//
// Run: node tests/combat_install_giveup.test.mjs   (from apps/holtburger-web/)

import { register } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(resolvePath(__dirname, "../_three_stub_loader.mjs")).href);

// No `__pluginClient` — the bus never arrives.
globalThis.window = { location: { search: "" } };

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error("  FAIL:", msg);
  }
}
function section(n) {
  console.log(`\n— ${n}`);
}

const realSetTimeout = globalThis.setTimeout;
let scheduled = 0;
/** Run one installer with the retry ladder collapsed to synchronous calls. */
async function runInstaller(fn) {
  const warns = [];
  const realWarn = console.warn;
  const realInfo = console.info;
  scheduled = 0;
  console.warn = (...a) => warns.push(a.join(" "));
  console.info = () => {};
  globalThis.setTimeout = (cb) => { scheduled++; cb(); return 0; };
  try {
    await fn();
  } finally {
    globalThis.setTimeout = realSetTimeout;
    console.warn = realWarn;
    console.info = realInfo;
  }
  return { warns, attempts: scheduled + 1 };
}

const { installKillImpulse } = await import("../scene3d/kill_impulse.js");
const { installCarnage } = await import("../scene3d/carnage.js");
const { installBloodDecals } = await import("../scene3d/blood_decals.js");

const CASES = [
  ["kill-impulse", () => installKillImpulse()],
  ["carnage", () => installCarnage()],
  ["blood", () => installBloodDecals()],
];

for (const [label, fn] of CASES) {
  section(`${label} — give-up is loud`);
  const { warns, attempts } = await runInstaller(fn);
  const mine = warns.filter((w) => w.includes(`[${label}]`));
  ok(mine.length === 1, `exactly ONE give-up warn (got ${mine.length}: ${JSON.stringify(mine.slice(0, 2))})`);
  ok(mine[0]?.includes("__pluginClient"),
    "…naming the thing that never appeared, so the reader knows where to look");
  ok(/gave up/i.test(mine[0] ?? ""), "…and saying it gave up rather than describing a transient");
  ok(attempts >= 50,
    `…only AFTER the full retry ladder, not on the first miss (${attempts} attempts)`);
  ok(!/\bundefined\b/.test(mine[0] ?? ""), "…with no `undefined` in the message");
}

/* The installers are idempotent: a second call after giving up must not start
 * a second ladder (and must not re-warn). */
section("idempotence");
{
  const { warns, attempts } = await runInstaller(() => installCarnage());
  ok(warns.length === 0 && attempts === 1, "a second installCarnage() is a no-op, not a second ladder");
}

console.log(`\ncombat_install_giveup: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
