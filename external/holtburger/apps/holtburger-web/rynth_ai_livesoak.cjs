#!/usr/bin/env node
// rynth_ai_livesoak.cjs — LIVE soak of the AI director against a REAL LLM
// (OpenRouter), multi-model: the grind bot fights/loots/buffs on live ACE
// while the director check-ins run on each model in sequence (hot-swapped
// via client.model, the same seam ui.js uses). Measures per model:
//   - check-in attempts vs successful plans (reply-contract discipline)
//   - invalid/failed actions (validator + safety rejections)
//   - director errors + self-disable
//   - token spend + estimated USD
//
// The API key is NEVER stored in this file or the repo: pass it via the
// OPENROUTER_KEY env var. Cost stays sub-cent on the default models — check
// the printed estimate against your OpenRouter dashboard anyway.
//
// Usage:
//   OPENROUTER_KEY=sk-or-... node rynth_ai_livesoak.cjs \
//     [--minutes-per-model=8] [--interval=2] [--models=a,b,c]
// Needs serve.py/wsbridge/ACE up + Playwright on NODE_PATH.
const { chromium } = require("playwright");
const { bootInWorld, sleep } = require("./rynth_boot_helper.cjs");

const KEY = process.env.OPENROUTER_KEY || "";
const arg = (name, dflt) => {
  const v = (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
  return v || dflt;
};
const MIN_PER_MODEL = Number(arg("minutes-per-model", 8));
const INTERVAL_MIN = Number(arg("interval", 2));
const MAX_TOKENS = Number(arg("max-tokens", 0)) || undefined; // undefined -> client default (1024)
const MODELS = arg(
  "models",
  "meta-llama/llama-3.1-8b-instruct,openai/gpt-oss-120b,openai/gpt-5-nano",
).split(",").map((s) => s.trim()).filter(Boolean);

// Rough OpenRouter list prices (USD/Mtok, 2026-07) for the printed estimate
// only — never billing truth.
const PRICES = {
  "meta-llama/llama-3.1-8b-instruct": { in: 0.05, out: 0.08 },
  "openai/gpt-oss-120b": { in: 0.037, out: 0.17 },
  "openai/gpt-5-nano": { in: 0.05, out: 0.4 },
};

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first";

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

(async () => {
  if (!KEY) { console.error("OPENROUTER_KEY env var required"); process.exit(1); }
  let browser;
  const consoleErrors = [];
  try {
    browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
    const page = await bootInWorld(browser, URL);
    if (!page) { console.log("FAIL boot"); process.exit(1); }
    page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${String(e).slice(0, 160)}`));
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(`console: ${m.text().slice(0, 160)}`);
    });

    await page.evaluate(
      async ({ apiKey, model, interval, maxTokens }) => {
        const { createGrindBot } = await import("/apps/holtburger-web/rynth/bot.js");
        window.__bot = await createGrindBot(window.__sessionHandle, {
          buffs: [2, 6],
          control: false,
          // maxCallsPerHour raised so a ~25-min multi-model soak isn't
          // budget-starved (still hard-capped; ~30 calls ≈ well under a cent
          // on these models).
          ai: { apiKey, model, intervalMinutes: interval, maxCallsPerHour: 30, autoStart: true, maxTokens },
        });
      },
      { apiKey: KEY, model: MODELS[0], interval: INTERVAL_MIN, maxTokens: MAX_TOKENS },
    );
    // Same grind spot + mob keeper as rynth_netbrain_soak.cjs.
    await page.evaluate(() => window.__bot.host.WriteToChat("@teleloc 0xA9B40019 84.0 15.0 94.05"));
    await sleep(6000);

    const snap = () =>
      page.evaluate(() => {
        const d = window.__bot.ai.director;
        const st = window.__bot.status();
        return {
          director: {
            enabled: d.status.enabled, calls: d.status.calls,
            consecutiveErrors: d.status.consecutiveErrors,
            lastSummary: d.status.lastSummary,
          },
          spend: window.__bot.ai.client.spend,
          journal: window.__bot.ai.journal.tail(200).map((e) => ({ kind: e.kind, text: String(e.text).slice(0, 220) })),
          kills: st.kills, looted: st.looted, action: st.action,
        };
      });

    // Live "thoughts" stream: print every new journal entry as it lands —
    // `plan` entries carry the LLM's own analysis of the observation.
    let journalSeen = 0;
    const streamJournal = async () => {
      const j = await page
        .evaluate(() => window.__bot.ai.journal.tail(200).map((e) => ({ kind: e.kind, text: String(e.text) })))
        .catch(() => null);
      if (!j) return;
      for (const e of j.slice(journalSeen)) console.log(`  [ai/${e.kind}] ${e.text.slice(0, 400)}`);
      journalSeen = j.length;
    };

    let spawns = 0, lastSpawnCheck = 0;
    const keepMobs = async () => {
      if (Date.now() - lastSpawnCheck < 45_000) return;
      lastSpawnCheck = Date.now();
      const alive = await page.evaluate(() => window.__bot.combat._scanTargets().length).catch(() => 0);
      if (alive < 2 && spawns < 60) {
        await page.evaluate(() => window.__bot.host.WriteToChat("@create 7")).catch(() => {});
        spawns++;
      }
    };

    const phases = [];
    for (const model of MODELS) {
      console.log(`\n=== phase: ${model} (${MIN_PER_MODEL} min) ===`);
      const before = await snap();
      await page.evaluate((m) => {
        window.__bot.ai.client.model = m; // ui.js model-input seam
        window.__bot.ai.journal.add("note", `livesoak: model -> ${m}`);
        window.__bot.ai.director.checkNow(); // immediate first datapoint
      }, model);

      const endAt = Date.now() + MIN_PER_MODEL * 60_000;
      while (Date.now() < endAt) {
        await sleep(10_000);
        await streamJournal();
        await keepMobs();
      }
      await streamJournal();

      const after = await snap();
      const newEntries = after.journal.slice(before.journal.length);
      const plans = newEntries.filter((e) => e.kind === "plan");
      const errors = newEntries.filter((e) => e.kind === "error");
      const results = newEntries.filter((e) => e.kind === "result");
      const failedActions = results.flatMap((e) => e.text.match(/\w+:FAIL/g) || []);
      const okActions = results.flatMap((e) => e.text.match(/\w+:ok/g) || []);
      const dTok = {
        prompt: after.spend.promptTokens - before.spend.promptTokens,
        completion: after.spend.completionTokens - before.spend.completionTokens,
        calls: after.spend.calls - before.spend.calls,
        clientErrors: after.spend.errors - before.spend.errors,
      };
      const p = PRICES[model];
      const usd = p ? (dTok.prompt * p.in + dTok.completion * p.out) / 1e6 : null;
      const phase = {
        model,
        attempts: after.director.calls - before.director.calls,
        plans: plans.length,
        errors: errors.length,
        okActions: okActions.length,
        failedActions: failedActions.length,
        tokens: dTok,
        estUsd: usd,
        enabledAtEnd: after.director.enabled,
        killsSoFar: after.kills,
        sampleSummaries: plans.slice(0, 4).map((e) => e.text.slice(0, 160)),
        errorSamples: errors.slice(0, 3).map((e) => e.text.slice(0, 160)),
        failSamples: results.filter((e) => /FAIL/.test(e.text)).slice(0, 3).map((e) => e.text.slice(0, 200)),
      };
      phases.push(phase);
      console.log(JSON.stringify(phase, null, 2));
      check(`${model}: >=2 parsed plans`, phase.plans >= 2, `plans=${phase.plans} errors=${phase.errors}`);
      check(`${model}: director not self-disabled`, phase.enabledAtEnd);
    }

    const final = await snap();
    check("bot killed mobs during soak", (final.kills | 0) > 0, `kills=${final.kills}`);
    check("no page errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));
    const totUsd = phases.reduce((s, ph) => s + (ph.estUsd || 0), 0);
    console.log(
      `\nSOAK SUMMARY: models=${MODELS.length} attempts=${phases.reduce((s, ph) => s + ph.attempts, 0)} ` +
      `plans=${phases.reduce((s, ph) => s + ph.plans, 0)} estUsd=$${totUsd.toFixed(4)} ` +
      `kills=${final.kills} looted=${final.looted} spawns=${spawns}`,
    );

    await page.evaluate(() => { try { window.rynthAI.stop(); } catch {} try { window.__bot.stop(); } catch {} }).catch(() => null);
    await sleep(1000);
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    if (browser) await browser.close().catch(() => null);
  }
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
