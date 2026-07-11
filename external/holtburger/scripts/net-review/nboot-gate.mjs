// A1 flake gate: N back-to-back launchAndEnter boots in ONE process with the
// same account — the exact ACE-grace collision that produced the s12 stalls.
// PASS = every boot reaches in-world with 0 console errors.
import { launchAndEnter } from "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";

const N = parseInt(process.argv[2] || "10", 10);
let fails = 0;
for (let i = 0; i < N; i += 1) {
  let r = null;
  try {
    r = await launchAndEnter({ query: {} });
    const errs = r.helpers.consoleErrors().length;
    const ok = r.inWorld === true && errs === 0;
    if (!ok) fails += 1;
    console.log(
      `boot ${i + 1}/${N}: ${ok ? "PASS" : "FAIL"} inWorld=${r.inWorld} inWorldMs=${r.inWorldMs} consoleErrors=${errs}`
    );
  } catch (e) {
    fails += 1;
    console.log(`boot ${i + 1}/${N}: FAIL threw ${e && e.message}`);
  } finally {
    try { await r?.helpers?.close?.(); } catch (_) {}
  }
}
console.log(`NBOOT SUMMARY: ${N - fails}/${N} green`);
process.exit(fails ? 1 : 0);
