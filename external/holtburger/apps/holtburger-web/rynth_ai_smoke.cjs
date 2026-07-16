#!/usr/bin/env node
// rynth_ai_smoke.cjs — LIVE E2E smoke for the rynth AI director (SPEC.md, A7).
// Starts the scripted mock LLM server in-process (:8899), boots headless,
// creates a grind bot with ai config pointed at the mock, and verifies the
// full check-in loop: observe -> chat -> plan -> execute -> journal ->
// reschedule. Mock reply 1 sets loot.minValue=4321 + a note with
// next_check_minutes=1; replies 2..N are a steady "none" plan — so we assert
// the plan executed, then that a second check-in fires without further churn.
//
// LAPTOP-RUN ONLY (the buildbox has no ACE/serve.py). Needs: serve.py :8765,
// wsbridge :8080, local ACE, Playwright on NODE_PATH. Port 8899 must be free.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");
const { startMockLlmServer } = require("./rynth/ai/mock_llm_server.cjs");

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  let browser, mock;
  try {
    // Fixed :8899 — the in-page baseUrl below must match, and the page at
    // :8765 reaches it cross-origin (mock serves full CORS).
    mock = await startMockLlmServer({ port: 8899 });
    console.log(`mock LLM at ${mock.url}`);

    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await bootInWorld(browser, URL);
    if (!page) { console.log("FAIL boot"); process.exit(1); }

    // Console-error watch starts at bot creation: boot noise is out of scope,
    // anything after this point would implicate the ai wiring.
    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.evaluate(async (aiBaseUrl) => {
      const { createGrindBot } = await import("/apps/holtburger-web/rynth/bot.js");
      window.__bot = await createGrindBot(window.__sessionHandle, {
        control: false,
        ai: { apiKey: "test-key", baseUrl: aiBaseUrl, model: "mock", intervalMinutes: 1, autoStart: true },
      });
    }, `${mock.url}/v1`);

    // window.rynthAI.{status,journal} are the SPEC-frozen A8 surfaces; bot.ai
    // presence is asserted but its inner shape is not.
    const snap = () =>
      page.evaluate(() => {
        const st = window.rynthAI?.status ? window.rynthAI.status() : null;
        let journalKinds = [];
        try { journalKinds = (window.rynthAI?.journal?.tail(50) || []).map((e) => e.kind); } catch {}
        return {
          hasAi: !!window.__bot?.ai,
          status: st
            ? { enabled: !!st.enabled, running: !!st.running, calls: st.calls | 0,
                consecutiveErrors: st.consecutiveErrors | 0, lastSummary: String(st.lastSummary ?? "") }
            : null,
          lootMin: window.__bot?.loot ? window.__bot.loot.minValue : null,
          journalKinds,
        };
      });

    // First check-in: intervalMinutes=1, so <=90s covers it even if the
    // director waits a full interval before its first call.
    let s = await snap();
    for (let i = 0; i < 45 && !((s.status?.calls ?? 0) >= 1 && s.lootMin === 4321); i++) {
      await sleep(2000);
      s = await snap();
    }
    check("bot.ai exposed", s.hasAi);
    check("window.rynthAI.status present", !!s.status, "rynthAI.status() returned nothing");
    // `running` is true only DURING a check-in (a ~ms transient, cleared in
    // checkNow's finally); between the setTimeout-scheduled checks it is
    // correctly false. "director is active" = enabled + it has actually run.
    check("director enabled + checked in", !!s.status?.enabled && (s.status?.calls | 0) >= 1, JSON.stringify(s.status));
    check("first check-in happened", (s.status?.calls ?? 0) >= 1, `calls=${s.status?.calls}`);
    check("plan executed: loot.minValue=4321", s.lootMin === 4321, `minValue=${s.lootMin}`);
    check("journal has plan entry", s.journalKinds.includes("plan"), s.journalKinds.join(","));
    check("journal has result entry", s.journalKinds.includes("result"), s.journalKinds.join(","));

    // Second check-in: reply 1 said next_check_minutes=1, so ~60s out; poll
    // up to 100s. The steady reply's only action is "none" — loot must hold.
    const callsAfterFirst = s.status?.calls ?? 0;
    let s2 = s;
    for (let i = 0; i < 50 && (s2.status?.calls ?? 0) < callsAfterFirst + 1; i++) {
      await sleep(2000);
      s2 = await snap();
    }
    check("second check-in happened", (s2.status?.calls ?? 0) >= 2, `calls=${s2.status?.calls}`);
    check("loot unchanged after steady reply", s2.lootMin === 4321, `minValue=${s2.lootMin}`);
    check("no consecutive director errors", (s2.status?.consecutiveErrors ?? 99) === 0,
      `consecutiveErrors=${s2.status?.consecutiveErrors}`);
    check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    console.log(`director: calls=${s2.status?.calls} lastSummary=${JSON.stringify(s2.status?.lastSummary).slice(0, 200)}`);

    await page.evaluate(() => { try { window.rynthAI?.stop?.(); } catch {} window.__bot?.stop(); }).catch(() => null);
    await sleep(1000);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => null);
    if (mock) await mock.close().catch(() => null);
  }
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
