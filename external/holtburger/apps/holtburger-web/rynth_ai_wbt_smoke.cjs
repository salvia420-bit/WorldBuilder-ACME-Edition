#!/usr/bin/env node
// rynth_ai_wbt_smoke.cjs — LIVE E2E smoke for the WorldBuilder oracle
// extension (rynth/ai/tools/wbt.js + apps/wbt-sidecar): boots headless
// in-world, creates a grind bot with a persona + mock-LLM ai config, and
// verifies (1) the composed system prompt carries the persona and the wbt
// actions, (2) an in-page wbt_query travels page -> sidecar -> real
// WorldBuilder.Terminal and journals its result (CORS proof), (3) an in-page
// file_ticket lands in the sidecar's tickets store with the character's
// position attached.
//
// LAPTOP-RUN ONLY. Needs: serve.py :8765, wsbridge :8080, local ACE, the
// wbt-sidecar on :8768 (scripts/wbt-sidecar-boot.sh), Playwright on
// NODE_PATH. Port 8899 must be free.
const { chromium } = require("playwright");
const { bootInWorld } = require("./rynth_boot_helper.cjs");
const { startMockLlmServer } = require("./rynth/ai/mock_llm_server.cjs");

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";
const SIDECAR = "http://127.0.0.1:8768";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  let browser, mock;
  try {
    const health = await (await fetch(`${SIDECAR}/health`)).json().catch(() => null);
    if (!health || health.ready !== true) {
      console.log(`FAIL wbt-sidecar not ready at ${SIDECAR} — run scripts/wbt-sidecar-boot.sh first`);
      process.exit(1);
    }
    const ticketsBefore = (await (await fetch(`${SIDECAR}/tickets?limit=200`)).json()).tickets.length;

    mock = await startMockLlmServer({ port: 8899 });
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await bootInWorld(browser, URL);
    if (!page) { console.log("FAIL boot"); process.exit(1); }

    const consoleErrors = [];
    page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    const r = await page.evaluate(async (aiBaseUrl) => {
      const { createGrindBot } = await import("/apps/holtburger-web/rynth/bot.js");
      const bot = await createGrindBot(window.__sessionHandle, {
        control: false,
        ai: {
          apiKey: "test-key", baseUrl: aiBaseUrl, model: "mock",
          intervalMinutes: 30, autoStart: false, // no check-ins — we drive the actions directly
          persona: { name: "Brakis", background: "A fresh arrival playtesting Dereth.", goals: "Find what is broken." },
        },
      });
      const out = { prompt: null, query: null, queryNote: null, ticket: null, catalog: null };
      const ext = bot.ai?.extensions;
      out.prompt = bot.ai?.director?.systemPrompt ?? null;
      if (ext?.extActions?.wbt_query) {
        const journal = bot.ai.journal;
        out.query = await ext.extActions.wbt_query.apply(bot, { type: "wbt_query", command: "melt-reference" }, { journal });
        try { out.queryNote = (journal.tail(10) || []).map((e) => e.text).find((t) => t.startsWith("wbt melt-reference:")) ?? null; } catch {}
        out.catalog = await ext.extActions.wbt_catalog.apply(bot, { type: "wbt_catalog", filter: "landblock" }, { journal });
        out.ticket = await ext.extActions.file_ticket.apply(
          bot,
          { type: "file_ticket", title: "[smoke] wbt oracle live probe", body: "Automated rynth_ai_wbt_smoke ticket — safe to close.", severity: "low" },
          { journal }
        );
      }
      bot.stop?.();
      return out;
    }, `${mock.url}/v1`);

    check("persona in live system prompt", typeof r.prompt === "string" && r.prompt.startsWith("WHO YOU ARE") && r.prompt.includes("Brakis"));
    check("wbt actions in live system prompt", !!r.prompt && r.prompt.includes("wbt_query {") && r.prompt.includes("file_ticket {"));
    check("in-page wbt_query ok (page->sidecar->WBT)", r.query?.ok === true && String(r.query?.result?.response ?? "").includes("melt"));
    check("wbt_query result journaled", typeof r.queryNote === "string" && r.queryNote.length > 20);
    check("in-page wbt_catalog ok", r.catalog?.ok === true && r.catalog?.result?.total >= 1);
    check("in-page file_ticket ok", r.ticket?.ok === true && typeof r.ticket?.result?.id === "string");

    const after = (await (await fetch(`${SIDECAR}/tickets?limit=200`)).json()).tickets;
    const mine = after.find((t) => t.title === "[smoke] wbt oracle live probe");
    check("ticket persisted server-side", after.length === ticketsBefore + 1 && !!mine);
    check("ticket carries position", !!mine && mine.position != null && Number.isFinite(mine.position.x));
    check("no console errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
  } catch (e) {
    check("smoke ran", false, String((e && e.message) || e));
  } finally {
    try { await browser?.close(); } catch {}
    try { await mock?.close(); } catch {}
  }
  console.log(`\n${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
