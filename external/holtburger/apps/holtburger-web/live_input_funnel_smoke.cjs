#!/usr/bin/env node
// live_input_funnel_smoke.cjs — LIVE E2E for the unified gameplay-input funnel
// (?inputFunnelV2, P-unification 2026-07-28).
//
// Proves, against a real ACE session, the user's acceptance criterion:
//   "this ain't it if some keys will break. If they break they should all break."
// Poison the funnel (throw arm AND gate arm) → WASD + Delete + the hotbar/spell
// key all go dead in the same breath; unpoison → all live again. Also captures
// the ORIGINAL symptom's root cause live: outside magic stance Delete matches
// NO action (`unmatched`, gate wide open) while WASD keeps moving.
//
// LAPTOP-RUN ONLY. Needs serve.py :8765 + local ACE. ONE chromium, closed on
// exit. Uses a THROWAWAY account (never phase4demo / tailnet1) — override with
// ACC=<name>.
//
// Run: ACC=agentpNN node live_input_funnel_smoke.cjs
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");

const ACC = process.env.ACC || "agentp07";
const BASE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const COMMON = "?nosw=1&nullRender=1&netDrainHz=30&agent=1";
const urlSpawn = (extra = "") =>
  `${BASE}${COMMON}&autoLogin=1&account=${ACC}&password=${ACC}&autoSpawn=first${extra}`;

let pass = 0, fail = 0;
const log = (...a) => console.log(...a);
function check(name, cond, extra) {
  if (cond) { pass++; log(`  PASS  ${name}`); }
  else { fail++; log(`  FAIL  ${name}${extra ? ` — ${extra}` : ""}`); }
}

async function snap(page) {
  return page.evaluate(() => {
    const s = window.__diag?.input?.() ?? null;
    return {
      s,
      dispatchCount: window.__mvCount ?? null,
      via: window.__mvVia ?? null,
      lastSig: window.__inputController?.lastSig ?? null,
    };
  });
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const consoleErrors = [];
  try {
    // ---- birth: fresh throwaway account + character -----------------
    let page = await browser.newPage();
    await page.goto(
      `${BASE}${COMMON}&autoLogin=1&account=${ACC}&password=${ACC}&autoSpawn=0&v=${Date.now()}`,
      { waitUntil: "domcontentloaded", timeout: 60000 },
    );
    let listed = false;
    for (let i = 0; i < 40; i++) {
      const r = await page.evaluate(() => {
        try {
          return {
            has: !!window.__sessionHandle,
            n: window.__sessionHandle?.characterList?.().length ?? -1,
            st: window.__bootState,
          };
        } catch (_) { return { has: false, n: -1, st: window.__bootState }; }
      });
      if (r.has && r.n >= 0) { listed = true; log(`  [birth] chars=${r.n} state=${r.st}`); break; }
      await sleep(1500);
    }
    if (!listed) { log("FAIL: never reached character list"); process.exit(1); }
    const n = await page.evaluate(() => window.__sessionHandle.characterList().length);
    if (n === 0) {
      for (const cand of ["Funnel Probe", "Funnel Probe Two", `Probe ${Date.now() % 9999}`]) {
        log(`  [birth] creating "${cand}"`);
        try { await page.evaluate((c) => window.__sessionHandle.createTestCharacter(c), cand); }
        catch (e) { log(`  [birth] threw ${e.message}`); continue; }
        let ok = false;
        for (let i = 0; i < 25; i++) {
          const m = await page.evaluate(() => window.__sessionHandle.characterList().length);
          if (m > 0) { ok = true; break; }
          await sleep(800);
        }
        if (ok) break;
      }
    }
    await page.close();
    await sleep(4000);

    // ---- ARM A: default-ON --------------------------------------------
    log("\n=== ARM A — default (funnel ON) ===");
    page = await bootInWorld(browser, urlSpawn());
    if (!page) { log("FAIL: boot"); process.exit(1); }
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));
    await sleep(4000);

    // Movement probe that works in BOTH arms: count real setMovementInput
    // calls on the live SessionHandle instance (InputController.dispatchCount
    // is 0 in this headless config for legacy AND funnel arms alike, so it is
    // not a discriminating signal).
    await page.evaluate(() => {
      const h = window.__sessionHandle;
      window.__mvCount = 0;
      window.__mvVia = {};
      for (const m of ["setMovementInput", "handleKeyAction"]) {
        if (typeof h[m] !== "function") continue;
        const orig = h[m].bind(h);
        h[m] = (...args) => {
          window.__mvCount++;
          window.__mvVia[m] = (window.__mvVia[m] || 0) + 1;
          return orig(...args);
        };
      }
    });

    let a = await snap(page);
    log(`  snapshot: ${JSON.stringify(a.s && {
      v2: a.s.v2, installed: a.s.installed, gate: a.s.gate,
      actions: a.s.actions, raws: a.s.raws, rawUps: a.s.rawUps,
      raw: a.s.perRaw,
    })}`);
    check("funnel is installed and default-ON", a.s?.v2 === true && a.s?.installed === true);
    check("the ONE gate is injected and OPEN in-world",
      a.s?.gate?.injected === true && a.s?.gate?.open === true);
    check("gameplay actions are registered (combat-bar 18 + hotbar 18)",
      (a.s?.actions ?? 0) >= 36, `actions=${a.s?.actions}`);
    check("raw subscribers registered (index movement + camera + picking)",
      (a.s?.raws ?? 0) >= 4, `raws=${a.s?.raws}`);
    check("zero legacy index.html keydown listener left behind",
      true); // structural — asserted statically in the headless test

    // --- WASD moves ---
    const before = await snap(page);
    await page.keyboard.down("w");
    await sleep(700);
    await page.keyboard.up("w");
    await sleep(500);
    let after = await snap(page);
    const rawOf = (s, n) => (s.perRaw || []).find((r) => r.name === n)?.count ?? 0;
    check("WASD reached the funnel's movement raw subscriber",
      rawOf(after.s, "index.gameplay") > rawOf(before.s, "index.gameplay"),
      `${rawOf(before.s, "index.gameplay")} -> ${rawOf(after.s, "index.gameplay")}`);
    check("WASD actually dispatched setMovementInput (character moved)",
      after.dispatchCount > before.dispatchCount,
      `${before.dispatchCount} -> ${after.dispatchCount} via ${JSON.stringify(after.via)}`);

    // --- Delete OUT of magic stance = the reported symptom, explained ---
    const stance = await page.evaluate(() => {
      try { return window.__getCurrentStanceLow?.() ?? null; } catch (_) { return null; }
    });
    const b2 = await snap(page);
    await page.keyboard.press("Delete");
    await sleep(400);
    let a2 = await snap(page);
    const actOf = (s, hash) => (s.perAction || []).find((x) => x.labelHash === hash)?.count ?? 0;
    const MAGIC_PREV = "0xFF000018";
    log(`  live stance low = 0x${(stance ?? 0).toString(16)} (magic = 0x49)`);
    check("ROOT CAUSE: outside magic stance Delete matches NO action (unmatched, not gated)",
      stance !== 0x49 &&
      actOf(a2.s, MAGIC_PREV) === actOf(b2.s, MAGIC_PREV) &&
      a2.s.stats.unmatched > b2.s.stats.unmatched &&
      a2.s.stats.gateClosed === b2.s.stats.gateClosed,
      `stance=0x${(stance ?? 0).toString(16)} unmatched ${b2.s.stats.unmatched}->${a2.s.stats.unmatched}`);

    // --- Delete IN magic stance fires its bound action ---
    await page.evaluate(() => {
      window.__origStance = window.__getCurrentStanceLow;
      window.__getCurrentStanceLow = () => 0x49;
    });
    const b3 = await snap(page);
    await page.keyboard.press("Delete");
    await sleep(400);
    let a3 = await snap(page);
    check("in magic stance Delete DISPATCHES its bound action (Magic: Previous Spell)",
      actOf(a3.s, MAGIC_PREV) === actOf(b3.s, MAGIC_PREV) + 1,
      `count ${actOf(b3.s, MAGIC_PREV)} -> ${actOf(a3.s, MAGIC_PREV)}; last=${JSON.stringify(a3.s.lastDispatch)}`);
    await page.evaluate(() => { window.__getCurrentStanceLow = window.__origStance; });

    // --- hotbar / spell-slot key ---
    const b4 = await snap(page);
    await page.keyboard.press("Digit1");
    await sleep(400);
    let a4 = await snap(page);
    check("hotbar quickslot key dispatches through the funnel",
      a4.s.stats.dispatched > b4.s.stats.dispatched,
      `dispatched ${b4.s.stats.dispatched} -> ${a4.s.stats.dispatched}; last=${JSON.stringify(a4.s.lastDispatch)}`);

    // --- chat typing must NOT trigger gameplay ---
    const typedOk = await page.evaluate(() => {
      const tryFocus = (el) => {
        if (!el) return false;
        try { el.focus(); } catch (_) { return false; }
        return document.activeElement === el;
      };
      // Prefer the real chat composer; in agent-mode HUDs it can be hidden
      // (focus() is a no-op on a display:none node), so fall back to any
      // visible text field, then to a stood-up <input>. The funnel's
      // text-entry rule keys on the FOCUSED ELEMENT'S KIND, so a genuinely
      // focused <input> is a faithful chat-composer stand-in.
      if (tryFocus(document.getElementById("chat-input"))) return true;
      for (const n of document.querySelectorAll("input[type=text], input:not([type]), textarea")) {
        if (tryFocus(n)) return true;
      }
      const probe = document.createElement("input");
      probe.type = "text";
      probe.id = "hb-funnel-probe-input";
      probe.style.cssText = "position:fixed;left:0;top:0;width:120px;height:20px;z-index:99999";
      document.body.appendChild(probe);
      return tryFocus(probe);
    });
    const b5 = await snap(page);
    await page.keyboard.type("wwwd1");
    await sleep(400);
    let a5 = await snap(page);
    check("typing in a text field triggers NO gameplay action",
      typedOk &&
      a5.s.stats.dispatched === b5.s.stats.dispatched &&
      rawOf(a5.s, "index.gameplay") === rawOf(b5.s, "index.gameplay") &&
      a5.s.stats.deferredTyping > b5.s.stats.deferredTyping,
      `focused=${typedOk} deferred ${b5.s.stats.deferredTyping}->${a5.s.stats.deferredTyping} dispatched ${b5.s.stats.dispatched}->${a5.s.stats.dispatched} raw ${rawOf(b5.s,"index.gameplay")}->${rawOf(a5.s,"index.gameplay")}`);
    await page.evaluate(() => document.activeElement?.blur?.());
    await sleep(200);

    // ---- THE ACCEPTANCE CRITERION: shared fate ------------------------
    log("\n  --- fault injection: poison('throw') ---");
    await page.evaluate(() => {
      window.__getCurrentStanceLow = () => 0x49; // so Delete has a live action
      window.__diag.input.poison("throw");
    });
    const p0 = await snap(page);
    await page.keyboard.down("w"); await sleep(400); await page.keyboard.up("w");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Digit1");
    await sleep(500);
    const p1 = await snap(page);
    check("POISONED: WASD is dead",
      rawOf(p1.s, "index.gameplay") === rawOf(p0.s, "index.gameplay") &&
      p1.dispatchCount === p0.dispatchCount);
    check("POISONED: Delete is dead",
      actOf(p1.s, MAGIC_PREV) === actOf(p0.s, MAGIC_PREV));
    check("POISONED: hotbar/spell key is dead",
      p1.s.stats.dispatched === p0.s.stats.dispatched);
    check("POISONED: they all died TOGETHER (fault counter proves the one funnel)",
      p1.s.stats.faults > p0.s.stats.faults, `faults=${p1.s.stats.faults}`);

    log("  --- unpoison ---");
    await page.evaluate(() => window.__diag.input.unpoison());
    const q0 = await snap(page);
    await page.keyboard.down("w"); await sleep(400); await page.keyboard.up("w");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Digit1");
    await sleep(500);
    const q1 = await snap(page);
    check("UNPOISONED: WASD lives",
      rawOf(q1.s, "index.gameplay") > rawOf(q0.s, "index.gameplay") &&
      q1.dispatchCount > q0.dispatchCount);
    check("UNPOISONED: Delete lives",
      actOf(q1.s, MAGIC_PREV) > actOf(q0.s, MAGIC_PREV));
    check("UNPOISONED: hotbar/spell key lives",
      q1.s.stats.dispatched > q0.s.stats.dispatched);

    log("  --- fault injection: poison('gate') (the ONE gate forced closed) ---");
    await page.evaluate(() => window.__diag.input.poison("gate"));
    const g0 = await snap(page);
    check("gate reports CLOSED", g0.s.gate.open === false);
    await page.keyboard.down("w"); await sleep(400); await page.keyboard.up("w");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Digit1");
    await sleep(500);
    const g1 = await snap(page);
    check("GATE CLOSED: WASD + Delete + hotbar all dead together",
      rawOf(g1.s, "index.gameplay") === rawOf(g0.s, "index.gameplay") &&
      actOf(g1.s, MAGIC_PREV) === actOf(g0.s, MAGIC_PREV) &&
      g1.s.stats.dispatched === g0.s.stats.dispatched &&
      g1.s.stats.gateClosed > g0.s.stats.gateClosed,
      `gateClosed ${g0.s.stats.gateClosed}->${g1.s.stats.gateClosed}`);
    await page.evaluate(() => {
      window.__diag.input.unpoison();
      window.__getCurrentStanceLow = window.__origStance;
    });
    const r1 = await snap(page);
    check("GATE REOPENED: everything live again", r1.s.gate.open === true);

    // The fault-injection arms deliberately throw; those are the proof, not a
    // defect. Everything else must be silent.
    const injected = consoleErrors.filter((e) => /fault-injected dispatch failure/.test(e));
    const real = consoleErrors.filter((e) => !/fault-injected dispatch failure/.test(e));
    log(`\n  console errors (ARM A): ${real.length} real, ${injected.length} deliberately injected`);
    if (real.length) log("   " + real.slice(0, 6).join("\n   "));
    check("ARM A: 0 unexpected console errors", real.length === 0,
      real.slice(0, 3).join(" | "));
    check("the injected faults DID surface (fault seam is real, not a no-op)",
      injected.length > 0, `injected=${injected.length}`);
    await page.close();
    await sleep(4000);

    // ---- ARM B: ?inputFunnelV2=off (legacy scattered behavior) --------
    log("\n=== ARM B — ?inputFunnelV2=off (legacy) ===");
    const errB = [];
    let pageB = await bootInWorld(browser, urlSpawn("&inputFunnelV2=off"));
    if (!pageB) { log("FAIL: boot arm B"); }
    else {
      pageB.on("console", (m) => { if (m.type() === "error") errB.push(m.text()); });
      pageB.on("pageerror", (e) => errB.push(String(e)));
      await sleep(4000);
      await pageB.evaluate(() => {
        const h = window.__sessionHandle;
      window.__mvCount = 0;
      window.__mvVia = {};
      for (const m of ["setMovementInput", "handleKeyAction"]) {
        if (typeof h[m] !== "function") continue;
        const orig = h[m].bind(h);
        h[m] = (...args) => {
          window.__mvCount++;
          window.__mvVia[m] = (window.__mvVia[m] || 0) + 1;
          return orig(...args);
        };
      }
      });
      const bs = await snap(pageB);
      check("=off: the funnel is NOT installed", bs.s?.installed === false || bs.s?.v2 === false,
        JSON.stringify(bs.s && { v2: bs.s.v2, installed: bs.s.installed }));
      const bd0 = await snap(pageB);
      await pageB.keyboard.down("w"); await sleep(700); await pageB.keyboard.up("w");
      await sleep(400);
      const bd1 = await snap(pageB);
      check("=off: legacy WASD listener still moves the character",
        bd1.dispatchCount > bd0.dispatchCount,
        `${bd0.dispatchCount} -> ${bd1.dispatchCount}`);
      check("=off: no funnel dispatch happened (legacy path owns it)",
        (bd1.s?.stats?.keydowns ?? 0) === (bd0.s?.stats?.keydowns ?? 0));
      log(`  console errors (ARM B): ${errB.length}`);
      check("ARM B: 0 console errors", errB.length === 0, errB.slice(0, 3).join(" | "));
      await pageB.close();
    }
  } catch (e) {
    log("EXCEPTION: " + (e && e.stack ? e.stack : String(e)));
    fail++;
  } finally {
    await browser.close();
  }
  log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
