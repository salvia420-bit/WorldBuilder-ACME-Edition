#!/usr/bin/env node
// harness/dat-decode-diag-probe.mjs — P2 net-fixwave (2026-07-10) shape probe
// for the A07 §3.6 decode-diag surface. Boots headless per the A16 contract,
// waits for in-world + a settled bake, then asserts:
//   1. `window.__diag.datDecode()` resolves to { main, worker, jsMissing };
//   2. `main` parses with the stable counter fields (fresh wasm);
//   3. `worker` is either the same shape (worker active, fresh pkg) or null
//      (worker off / stale pkg) — both legal, reported which;
//   4. the wasm negative cache holds NO tex-swap alias DIDs (0x08F0xxxx
//      block refused — A06-F2) in either instance;
//   5. negCacheSize === negCache.length (self-consistency).
// Exit 0 = all gates pass. Usage:
//   node dat-decode-diag-probe.mjs [--settleMs 20000] [--out out.json]
import fs from "node:fs";
import { launchAndEnter } from "./lib/boot.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const SETTLE_MS = Number(arg("settleMs", "20000"));
const OUT = arg("out", "");

const FIELDS = [
  "firstHopMiss", "depMiss", "parseFail", "decodeFail",
  "negCacheHits", "negCacheInserts", "decodeMissesTotal",
  "negCacheSize", "recentMissing", "negCache",
];

const { page, helpers, inWorld } = await launchAndEnter({ timeoutMs: 120_000 });
if (!inWorld) console.warn("[dat-decode-diag-probe] boot stalled pre-in-world; probing anyway");
try {
  // Let the boot bake + a few entity decodes run so counters are live.
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  const res = await page.evaluate(async () => {
    if (!window.__diag || typeof window.__diag.datDecode !== "function") {
      return { err: "__diag.datDecode missing" };
    }
    try {
      return { val: await window.__diag.datDecode() };
    } catch (e) {
      return { err: String((e && e.message) || e) };
    }
  });
  const out = { gates: {}, raw: res };
  const fail = (g, why) => { out.gates[g] = `FAIL: ${why}`; };
  const pass = (g, note) => { out.gates[g] = note ? `PASS (${note})` : "PASS"; };

  if (res.err) fail("shape", res.err);
  else {
    const v = res.val || {};
    if ("main" in v && "worker" in v && "jsMissing" in v) pass("shape");
    else fail("shape", `keys=${Object.keys(v)}`);

    const checkInstance = (name, inst, requiredLive) => {
      if (inst == null) {
        if (requiredLive) fail(name, "null (main must be live on a fresh pkg)");
        else pass(name, "null — worker off or stale pkg (legal)");
        return;
      }
      const missing = FIELDS.filter((f) => !(f in inst));
      if (missing.length) return fail(name, `missing fields: ${missing}`);
      if (inst.negCacheSize !== inst.negCache.length) {
        return fail(name, `negCacheSize ${inst.negCacheSize} != negCache.length ${inst.negCache.length}`);
      }
      const aliases = inst.negCache.filter(
        (s) => ((parseInt(s, 16) >>> 0) & 0xfff00000) >>> 0 === 0x08f00000,
      );
      if (aliases.length) return fail(name, `alias DIDs memoised: ${aliases}`);
      pass(name, `negCacheSize=${inst.negCacheSize} inserts=${inst.negCacheInserts} hits=${inst.negCacheHits} misses=${inst.decodeMissesTotal}`);
    };
    checkInstance("main", v.main, true);
    checkInstance("worker", v.worker, false);
    if (Array.isArray(v.jsMissing)) pass("jsMissing", `${v.jsMissing.length} entries`);
    else fail("jsMissing", "not an array");
  }

  const failed = Object.values(out.gates).filter((s) => s.startsWith("FAIL"));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("DAT-DECODE-DIAG SUMMARY:", JSON.stringify(out.gates));
  process.exit(failed.length ? 1 : 0);
} finally {
  await helpers.close().catch(() => {});
}
