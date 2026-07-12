// probe_cast_matrix.cjs — WS16 headless cast-regression harness.
//
// RUNS ON THE LAPTOP (live vanilla ACE on udp 9000/9001 + the 1070 Chrome
// over CDP). Authored + syntax-checked on the buildbox; the live drive is a
// laptop task (see the TODO-FOR-LAPTOP recipe in WS16-diag-harness.md).
//
// What it does (mirrors k1_drive_combat.cjs's connect→login→spawn→teleport
// scaffold, then drives a configurable war+void spell list):
//   1. Connect over CDP, cache-bust, login, spawn, @telepoi holtburg.
//   2. Learn the test spells (@addspell) + a nearby target (@create) for the
//      targeted-bolt cases.
//   3. For each spell: __diag.cast.reset(), fire the cast, wait out the
//      chain, then read __diag.cast + emit PASS/DRIFT lines per check:
//        gesture-played · timing-in-tolerance · caster-effect-seen ·
//        link-resolved (no silent no-op) · UseDone-ordering · projectile-moved
//   4. Print a matrix summary + exit non-zero on any DRIFT.
//
// The checks are self-calibrating: expected windup count + total duration
// come from the page's own getCastSequence(spellId), so adding a spell to
// CAST_SPELLS needs no code change here.
//
// Config (env):
//   K1_CDP_URL   CDP endpoint            (default http://127.0.0.1:9223)
//   K1_PAGE_URL  app URL (append flags)  (default http://localhost:7080/apps/holtburger-web/index.html)
//   CAST_ACCOUNT / CAST_PASSWORD         (default tailnet1/tailnet1)
//   CAST_SPELLS  csv "id:self|target"    (default war bolts + a void/self set)
//   CAST_TOL     timing tolerance factor (default 1.6 — CastSpeed 2.0 + RTT slack)

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const PAGE_URL = process.env.K1_PAGE_URL || "http://localhost:7080/apps/holtburger-web/index.html";
const ACCOUNT = process.env.CAST_ACCOUNT || "tailnet1";
const PASSWORD = process.env.CAST_PASSWORD || "tailnet1";
const TOL = Number(process.env.CAST_TOL || "1.6");
const OUT_DIR = process.env.CAST_OUT_DIR || "/mnt/wbterminal1/tmp/claude-scratch/ws16";
const HB_PREFIX = "http://localhost:7080/apps/holtburger-web/";

// Default matrix: War bolts (targeted) + Void/self-buff (self). "self" casts
// promote to targeted-at-own-guid client-side (foundation §1.1). Void needs a
// void-trained char; swap in real void ids on the test char.
//   1708 = Wedding Bliss (3-windup self chain — the slideCast validation spell)
//   2331 = single Purple windup + MagicTransfer (colored-band void repro)
const DEFAULT_SPELLS = "1:target,1708:self,2331:self";
const SPELLS = (process.env.CAST_SPELLS || DEFAULT_SPELLS)
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map((tok) => {
    const [id, mode] = tok.split(":");
    return { spellId: Number(id), mode: (mode || "target").toLowerCase() };
  });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

let DRIFT = 0, CHECKS = 0;
function line(spellId, name, pass, detail) {
  CHECKS += 1;
  if (!pass) DRIFT += 1;
  console.log(`  ${pass ? "PASS" : "DRIFT"} [spell ${spellId}] ${name}${detail ? " — " + detail : ""}`);
}

async function attemptLogin(page, attempt) {
  console.log(`# login attempt ${attempt}`);
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
  await page.fill('input[name="server_host"]', "127.0.0.1");
  await page.fill('input[name="server_port"]', "9000");
  await page.click("#login-form button[type=submit]", { noWaitAfter: true }).catch(() => null);
  try { await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 }); return true; }
  catch (_) { return false; }
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => p.url().startsWith(HB_PREFIX)) || await ctx.newPage();

  // ── cache-bust + reload ──
  await page.goto("about:blank");
  const cdp = await page.context().newCDPSession(page);
  try { await cdp.send("Network.clearBrowserCache"); } catch (_) {}
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      for (const r of await navigator.serviceWorker.getRegistrations()) { try { await r.unregister(); } catch (_) {} }
    }
    if ("caches" in window) { for (const k of await caches.keys()) { try { await caches.delete(k); } catch (_) {} } }
  }).catch(() => {});
  // ?nosw=1 per project law; default flags otherwise (bare-default acceptance bar).
  const url = PAGE_URL + (PAGE_URL.includes("?") ? "&" : "?") + "nosw=1&v=" + Date.now();
  console.log(`reload: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  page.on("console", (m) => { if (/error|fizzle|cast|spell|warn/i.test(m.text())) console.log(`[browser ${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => console.error(`[pageerror] ${e.message}`));

  await page.waitForFunction(() => { const r = document.getElementById("results"); return r && /PASS/.test(r.innerHTML); }, { timeout: 30_000 });
  console.log("smoke: PASS");

  // ── login (retry for the double-connect kick) ──
  let loggedIn = false;
  for (let a = 1; a <= 3 && !loggedIn; a += 1) {
    loggedIn = await attemptLogin(page, a);
    if (!loggedIn) { console.log("  waiting 12s for ACE to drop stale session…"); await sleep(12_000); }
  }
  if (!loggedIn) { console.error("FAIL: login never reached selection"); await browser.close(); process.exit(1); }
  await page.locator("#character-ul button[data-id]").first().click();
  await page.waitForFunction(() => { const s = document.getElementById("login-status"); return s && /InWorld|Spawned/.test(s.innerText); }, { timeout: 25_000 });
  console.log("spawned");
  try { await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 8_000 }); } catch (_) {}

  const sendChat = (l) => page.evaluate((x) => window.__sessionHandle?.sendChat?.(x), l);
  await sendChat("@telepoi holtburg");
  await sleep(4_000);

  // Ensure the caster is in Magic stance (stance low16 0x0049).
  await page.evaluate(() => {
    const low = window.__getCurrentStanceLow?.();
    if ((low & 0xffff) !== 0x49) window.__sessionHandle?.sendChat?.("/mode magic");
  });
  await sleep(1_500);

  // Learn the test spells + spawn a target for the targeted cases.
  for (const { spellId } of SPELLS) { await sendChat(`@addspell ${spellId}`); await sleep(600); }
  const needTarget = SPELLS.some((s) => s.mode === "target");
  if (needTarget) { await sendChat("@create 7 3"); await sleep(3_000); }

  // Preload the cast-sequence table so getCastSequence is populated + find a target.
  const setup = await page.evaluate(async () => {
    try { const m = await import("./ui/ac_spell_cast_sequence.js"); if (m.getCastSequence) m.getCastSequence(1); } catch (_) {}
    const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    let target = null;
    const em = window.liveScene3d?.entityManager;
    if (em?.entityMap) {
      for (const [g] of em.entityMap) { if ((g >>> 0) !== localGuid && (g >>> 0) >= 0x80000000) { target = g >>> 0; } }
    }
    return { localGuid, target, castDiag: !!window.__diag?.cast };
  });
  console.log(`localGuid=0x${(setup.localGuid >>> 0).toString(16)} target=${setup.target ? "0x" + setup.target.toString(16) : "(none)"} __diag.cast=${setup.castDiag}`);
  if (!setup.castDiag) { console.error("FAIL: window.__diag.cast surface absent — is scene3d/diag/cast.js wired?"); await browser.close(); process.exit(1); }

  console.log("\n=== CAST MATRIX ===");
  for (const { spellId, mode } of SPELLS) {
    // Expected shape from the page's own generated table.
    const exp = await page.evaluate(async (id) => {
      const m = await import("./ui/ac_spell_cast_sequence.js");
      const e = m.getCastSequence(id);
      return e ? { windups: e.windupGestures.length, total: e.totalDurationS, casterEffect: e.casterEffect | 0, fastCast: !!e.fastCast } : null;
    }, spellId);
    if (!exp) { line(spellId, "in-cast-sequence-table", false, "getCastSequence returned null"); continue; }

    const tgt = mode === "target" ? setup.target : setup.localGuid;
    if (mode === "target" && !tgt) { line(spellId, "has-target", false, "no creature spawned"); continue; }

    // Reset the surface, fire the cast, wait out the chain (+ RTT + UseDone).
    await page.evaluate(() => window.__diag.cast.reset());
    const aceCastSpeed = 2.0; // ACE Player_Magic.CastSpeed; the client paces at CAST_SPEED too.
    const waitMs = Math.max(1500, Math.round((exp.total * 1000 / aceCastSpeed) + 2500));
    await page.evaluate(({ g, id }) => {
      window.liveScene3d?.entityManager?.setSelectedTarget?.(g >>> 0);
      window.__sessionHandle?.castTargetedSpell?.(g >>> 0, id);
    }, { g: tgt, id: spellId });
    await sleep(waitMs);

    const res = await page.evaluate(({ id, localGuid }) => {
      const c = window.__diag.cast;
      const tl = c.lastTimeline(localGuid);
      const snap = c.movementSnapshot();
      const summary = c.summary();
      return { tl, snap, summary };
    }, { id: spellId, localGuid: setup.localGuid });
    const tl = res.tl;

    // ── Checks ──
    if (!tl) { line(spellId, "cast-recorded", false, "no __diag.cast timeline for local player"); continue; }
    line(spellId, "not-suppressed", tl.outcome !== "suppressed", tl.suppressedReason || "");
    // gesture played: expected windup count (fastCast/leadOnly ⇒ 0) + a cast stamp
    line(spellId, "windups-played", tl.deltasMs.windups.length >= exp.windups, `got ${tl.deltasMs.windups.length}/${exp.windups}`);
    line(spellId, "cast-gesture-played", tl.deltasMs.cast != null, tl.deltasMs.cast != null ? `at ${tl.deltasMs.cast}ms` : "MISSING (silent no-op?)");
    // timing within tolerance of the CastSpeed-scaled authored duration
    const budget = Math.round(exp.total * 1000 / 2.0 * TOL);
    if (tl.deltasMs.cast != null) line(spellId, "timing-in-tolerance", tl.deltasMs.cast <= budget, `cast ${tl.deltasMs.cast}ms <= ${budget}ms`);
    // link resolution: no cast-gesture silent no-op (miss count over cast band)
    line(spellId, "links-resolved", res.summary.castLink.miss === 0, `miss=${res.summary.castLink.miss} hit=${res.summary.castLink.hit}`);
    // effect script seen (only when the spell has a caster effect)
    if (exp.casterEffect !== 0) line(spellId, "caster-effect-seen", tl.deltasMs.casterEffect != null, tl.deltasMs.casterEffect != null ? `at ${tl.deltasMs.casterEffect}ms` : "no CasterEffect emit");
    // UseDone ordering: if a UseDone arrived, it should be at/after the cast gesture
    if (tl.deltasMs.useDone != null && tl.deltasMs.cast != null) line(spellId, "usedone-after-cast", tl.deltasMs.useDone >= tl.deltasMs.cast - 50, `useDone ${tl.deltasMs.useDone}ms vs cast ${tl.deltasMs.cast}ms`);
    // movement-arbitration snapshot (informational — records the latch/slot at read time)
    console.log(`    arb: latch=${res.snap.latchAutonomous} fwdSlot=${res.snap.forwardSlot} pending=${res.snap.pendingMotions} reclaim=${JSON.stringify(res.snap.reclaimCause)}`);
    // projectile moved (targeted bolts only, best-effort): a missile entity gained velocity
    if (mode === "target") {
      const moved = await page.evaluate(() => {
        const em = window.liveScene3d?.entityManager; if (!em?.entityMap) return null;
        for (const [, inst] of em.entityMap) { if (inst?.isMissile || inst?.physicsState === "Missile") return true; }
        return false;
      });
      if (moved !== null) line(spellId, "projectile-present", moved === true, moved ? "" : "no missile entity seen (may have already impacted)");
    }
  }

  const shot = path.join(OUT_DIR, "cast-matrix-final.png");
  await page.screenshot({ path: shot }).catch(() => null);
  console.log(`\nscreenshot: ${shot}`);
  console.log("\n=== SUMMARY ===");
  console.log(`checks: ${CHECKS}  drift: ${DRIFT}`);
  await browser.close();
  process.exit(DRIFT > 0 ? 2 : 0);
})();
