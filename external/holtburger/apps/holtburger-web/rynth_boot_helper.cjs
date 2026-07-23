// Shared boot helper: reload-retry around single-shot autoLogin (the
// Account-In-Use kick dance). Uses a FRESH page per attempt (a crashed
// renderer poisons the old page object).
//
// Readiness gate (rynth-review 14 B-1 / 15 C-3 / 17-SYNTHESIS #15, fixed
// 2026-07-23): this used to accept `__bootState === "ready"` and wait only
// for `__sessionHandle` PRESENCE — the exact pattern soak-11/12 forbade
// ("gate on in-world+pose, NEVER ready" — HANDOFF-playtester-soak-11.md:96,
// soak-12.md:41-44). Under the mandatory headless `?nullRender`, `ready`
// (scene-bake-complete) can fire BEFORE `in-world` (EnteredWorld kind=7), so
// the old gate could hand a smoke a page that LOOKS live (session handle
// attached early) but hasn't actually entered the world — the smoke then
// acts on a dead/immature session (false pass or flake). Success is now:
// bootState (or its history, to catch a brief in-world->ready slip) shows
// "in-world" AND getLocalPlayerPose() returns a real pose — mirrors
// harness/lib/boot.mjs's launchAndEnter() gate exactly (MEMORY: "gate on
// in-world AND getLocalPlayerPose()!==undefined").
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll one page for the pose-based in-world gate. Never throws (a wasm/DOM
 * read failure is just "not ready yet"). -> { ok, isError, lastState } */
async function pollTrulyInWorld(page) {
  return page.evaluate(() => {
    const hist = Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
    const reachedInWorld =
      window.__bootState === "in-world" || hist.some((e) => e && e.state === "in-world");
    if (window.__bootState === "error") return { ok: false, isError: true, lastState: "error" };
    if (!reachedInWorld) return { ok: false, isError: false, lastState: window.__bootState || "" };
    let pose;
    try {
      const h = window.__sessionHandle;
      pose = h && typeof h.getLocalPlayerPose === "function" ? h.getLocalPlayerPose() : undefined;
    } catch (_) {
      pose = undefined;
    }
    const hasPose = pose !== undefined && pose !== null;
    return { ok: hasPose, isError: false, lastState: window.__bootState || "" };
  });
}

async function bootInWorld(browser, url, attempts = 4) {
  for (let a = 1; a <= attempts; a++) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(url + `&v=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      let ok = false;
      // Same overall budget as before (60 x 2000ms = 120s), now polling
      // in-world+pose in one evaluate instead of bootState alone.
      for (let i = 0; i < 60; i++) {
        const r = await pollTrulyInWorld(page);
        if (r.ok) { ok = true; break; }
        if (r.isError) break;
        await sleep(2000);
      }
      if (ok) return page;
      const hist = await page.evaluate(() => window.__bootStateHistory || window.__bootState);
      console.log(`boot attempt ${a} failed: ${JSON.stringify(hist).slice(0, 200)}`);
    } catch (e) {
      console.log(`boot attempt ${a} threw: ${String(e.message).slice(0, 120)}`);
    }
    if (page) await page.close().catch(() => null);
    await sleep(15_000);
  }
  return null;
}
module.exports = { bootInWorld, pollTrulyInWorld, sleep };
