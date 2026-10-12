// tests/rynth_boot_config.test.mjs — rynth/boot.js (2026-10-12).
//
// The ?bot=1 auto-boot moved out of app/client_events.js into rynth/boot.js
// so the RynthSuite HUD's START button boots the same way. This pins:
//   1. URL → createGrindBot config: byte-identical to the pre-move block,
//      which is copied VERBATIM below as the oracle (originalCfg), over a
//      matrix of every bot param × the operator-stop latch.
//   2. The boot / takeover-rebind rules: same handle = no-op, new handle =
//      prevBot.stop() + reboot, __botBooting guard, the exact console lines,
//      a failing bot module warns and resets the guard.
//   3. HUD boots: URL params still apply, HUD settings layer on top, and a
//      HUD-booted bot is rebound on takeover even without ?bot=1.
//   4. app/client_events.js still reads every BOT_URL_PARAM_NAMES param
//      (the flag lint + rynth_ai_persona_test pin the reads there).
//
// Run from apps/holtburger-web/:  node tests/rynth_boot_config.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const boot = await import("../rynth/boot.js");

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n       ") : e}`);
  }
}

// ── 1. the oracle: the pre-move cfg assembly, verbatim ─────────────────
// (app/client_events.js @ 2026-10-11, the body of the ?bot=1 `.then`
// between `const cfg = …` and `window.__bot = await …`; the async
// operator_stop import is replaced by the injected `os`.)
function originalCfg(botParams, os) {
  const cfg = botParams.get("botAi") === "off" ? { ai: false } : {};
  try {
    if (os.applyOperatorStopToCfg(cfg)) {
      /* console.log("[bot] AI director suppressed: operator stop latch"); */
    }
  } catch (_) { /* latch unavailable = fall through to params */ }
  if (botParams.get("nav") !== "off") {
    cfg.nav = { endpoint: botParams.get("navEndpoint") || "http://127.0.0.1:8767" };
  }
  if (botParams.get("botKernel") === "off") cfg.kernel = false;
  if (botParams.get("explorePressure") === "1") cfg.explorePressure = true;
  const botCtlOwner = botParams.get("botCtlOwner");
  if (botCtlOwner) {
    cfg.control = {
      ...(cfg.control || {}),
      owner: botCtlOwner.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }
  if (cfg.ai !== false) {
    const bp = botParams.get("botPersona");
    if (bp) cfg.ai = { ...(cfg.ai || {}), persona: bp };
    const bm = botParams.get("botModel");
    const bi = parseFloat(botParams.get("botInterval"));
    const PROVIDER_PIN_TABLE = [
      { prefix: "z-ai/", provider: { order: ["streamlake", "novita", "baidu"], allow_fallbacks: false } },
      { prefix: "minimax/", provider: { order: ["novita", "minimax"], allow_fallbacks: false } },
    ];
    const providerPinFor = (model) => {
      const hit = PROVIDER_PIN_TABLE.find((e) => model.startsWith(e.prefix));
      return hit ? { provider: hit.provider } : {};
    };
    const bmMaxTokens = /minimax/i.test(bm) ? 8192 : 1280;
    if (bm) cfg.ai = {
      ...(cfg.ai || {}), model: bm, maxTokens: bmMaxTokens,
      reasoning: { effort: "low" }, timeoutMs: 120000,
      ...providerPinFor(bm),
    };
    if (Number.isFinite(bi) && bi > 0) {
      cfg.ai = {
        ...(cfg.ai || {}),
        intervalMinutes: bi, minIntervalMinutes: bi,
        maxIntervalMinutes: bi * 2,
        maxCallsPerHour: Math.min(70, Math.ceil(70 / bi)),
      };
    }
  }
  return cfg;
}
// The latch module's documented behavior (rynth/ai/operator_stop.js
// applyOperatorStopToCfg): bot latch → cfg.startHeld, AI latch → cfg.ai=false.
const latchOs = (ai, botStop = false) => ({
  applyOperatorStopToCfg(cfg) {
    if (botStop) cfg.startHeld = true;
    if (!ai) return false;
    cfg.ai = false;
    return true;
  },
});

const VALUES = {
  botAi: [null, "off", "on"],
  nav: [null, "off", "on"],
  navEndpoint: [null, "http://10.0.0.5:9999"],
  botKernel: [null, "off", "1"],
  explorePressure: [null, "1", "true"],
  botCtlOwner: [null, "Torval", " Torval , Alt Two ,,"],
  botPersona: [null, "explorer", "weird"],
  botModel: [null, "z-ai/glm-5.2", "minimax/minimax-m3", "openai/gpt-oss-120b"],
  botInterval: [null, "0.5", "5", "-1", "abc"],
};
function* matrix() {
  // One axis at a time against a base, plus a few dense combos — the
  // mapping has no cross-terms beyond cfg.ai, which the AI rows cover.
  const base = { bot: "1" };
  yield base;
  for (const [k, vals] of Object.entries(VALUES)) for (const v of vals) yield { ...base, [k]: v };
  for (const ai of VALUES.botAi)
    for (const m of VALUES.botModel)
      for (const i of VALUES.botInterval)
        for (const p of VALUES.botPersona) yield { ...base, botAi: ai, botModel: m, botInterval: i, botPersona: p };
}
const toSearch = (o) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v != null) sp.set(k, v);
  return sp;
};

await check("URL → cfg identical to the pre-move block (matrix × latch states)", () => {
  let n = 0;
  for (const combo of matrix()) {
    for (const [ai, bs] of [[false, false], [true, false], [false, true], [true, true]]) {
      const sp = toSearch(combo);
      const want = originalCfg(sp, latchOs(ai, bs));
      const p = boot.readBotUrlParams(sp);
      const got = boot.botConfigFromUrlParams(p, { latch: (cfg) => latchOs(ai, bs).applyOperatorStopToCfg(cfg) });
      assert.deepStrictEqual(got, want, `combo ${JSON.stringify(combo)} latch ai=${ai} bot=${bs}`);
      n++;
    }
  }
  assert.ok(n > 500, `matrix too small (${n})`);
});

await check("?botBuffs: auto | id list → cfg.buffs; absent/empty/garbage → no buffs (as before)", () => {
  assert.equal(boot.parseBotBuffsParam(null), null);
  assert.equal(boot.parseBotBuffsParam("  "), null);
  assert.equal(boot.parseBotBuffsParam("AUTO"), "auto");
  assert.deepStrictEqual(boot.parseBotBuffsParam("2, 24,2,-1,x,1.5"), [2, 24]);
  assert.equal(boot.parseBotBuffsParam("x,-3"), null);
  const auto = boot.botConfigFromUrlParams(boot.readBotUrlParams("?bot=1&botBuffs=auto&botAi=off"));
  assert.equal(auto.buffs, "auto");
  const list = boot.botConfigFromUrlParams(boot.readBotUrlParams("?bot=1&botBuffs=2,24"));
  assert.deepStrictEqual(list.buffs, [2, 24]);
  assert.equal("buffs" in boot.botConfigFromUrlParams(boot.readBotUrlParams("?bot=1")), false);
  // HUD settings win over the URL on a HUD boot.
  assert.equal(boot.applyHudOverrides({ buffs: [2] }, { buffs: "auto" }).buffs, "auto");
  assert.deepStrictEqual(boot.applyHudOverrides({ buffs: "auto" }, { buffs: [24] }).buffs, [24]);
});

await check("readBotUrlParams accepts a search string, URLSearchParams, or garbage", () => {
  assert.equal(boot.readBotUrlParams("?bot=1&botAi=off").botAi, "off");
  assert.equal(boot.readBotUrlParams(new URLSearchParams("nav=off")).nav, "off");
  const empty = boot.readBotUrlParams(undefined);
  for (const k of boot.BOT_URL_PARAM_NAMES) assert.equal(empty[k], null);
});

await check("app/client_events.js reads every BOT_URL_PARAM_NAMES param and calls maybeAutoBootBot", () => {
  const src = readFileSync(path.join(APP, "app/client_events.js"), "utf8");
  for (const k of boot.BOT_URL_PARAM_NAMES) {
    assert.ok(src.includes(`${k}: botParams.get("${k}")`), `client_events.js no longer reads ${k}`);
  }
  assert.match(src, /import \{ maybeAutoBootBot \} from "\.\.\/rynth\/boot\.js";/);
  assert.match(src, /maybeAutoBootBot\(botTargetHandle, \{/);
});

// ── 2. boot / rebind rules ─────────────────────────────────────────────
function harness({ failBot = false, failLatch = false, ai = false, botStop = false } = {}) {
  const logs = [];
  const warns = [];
  const made = [];
  const win = { location: { href: "http://h/apps/holtburger-web/index.html?bot=1", search: "?bot=1" }, localStorage: null };
  const importer = async (url) => {
    if (url.endsWith("rynth/bot.js")) {
      if (failBot) throw new Error("boom");
      return {
        createGrindBot: async (handle, cfg) => {
          const bot = { handle, cfg, stopped: 0, disposed: 0, stop() { this.stopped++; }, host: { dispose() { bot.disposed++; } } };
          made.push(bot);
          return bot;
        },
      };
    }
    if (url.endsWith("rynth/ai/operator_stop.js")) {
      if (failLatch) throw new Error("no latch module");
      return latchOs(ai, botStop);
    }
    throw new Error(`unexpected import ${url}`);
  };
  return { win, importer, logs, warns, made };
}
async function withConsole(h, fn) {
  const ol = console.log;
  const ow = console.warn;
  console.log = (...a) => h.logs.push(a.join(" "));
  console.warn = (...a) => h.warns.push(a.join(" "));
  try { return await fn(); } finally { console.log = ol; console.warn = ow; }
}

await check("?bot=1 first in-world: boots, sets globals, logs the auto-boot line", async () => {
  const h = harness();
  await withConsole(h, async () => {
    const p = boot.readBotUrlParams("?bot=1&botAi=off");
    const pr = boot.maybeAutoBootBot("H1", p, { win: h.win, importer: h.importer });
    assert.ok(pr, "a boot promise");
    assert.equal(h.win.__botBooting, true, "guard set synchronously");
    assert.equal(h.win.__bot, null);
    const bot = await pr;
    assert.equal(h.win.__bot, bot);
    assert.equal(h.win.__botHandle, "H1");
    assert.equal(h.win.__botBooting, false);
    assert.deepStrictEqual(bot.cfg, { ai: false, nav: { endpoint: "http://127.0.0.1:8767" } });
  });
  assert.deepStrictEqual(h.logs, ["[rynth] grind bot auto-booted via ?bot=1"]);
  assert.deepStrictEqual(h.warns, []);
});

await check("same handle → no-op (death respawn); booting → no-op; no ?bot=1 → no-op", async () => {
  const h = harness();
  await withConsole(h, async () => {
    const p = boot.readBotUrlParams("?bot=1");
    await boot.maybeAutoBootBot("H1", p, { win: h.win, importer: h.importer });
    assert.equal(boot.maybeAutoBootBot("H1", p, { win: h.win, importer: h.importer }), null);
    h.win.__botBooting = true;
    assert.equal(boot.maybeAutoBootBot("H2", p, { win: h.win, importer: h.importer }), null);
    h.win.__botBooting = false;
    const h2 = harness();
    assert.equal(boot.maybeAutoBootBot("H1", boot.readBotUrlParams(""), { win: h2.win, importer: h2.importer }), null);
  });
  assert.equal(h.made.length, 1);
});

await check("takeover (new handle) → prevBot.stop() + reboot + the rebind log line", async () => {
  const h = harness();
  await withConsole(h, async () => {
    const p = boot.readBotUrlParams("?bot=1");
    const first = await boot.maybeAutoBootBot("H1", p, { win: h.win, importer: h.importer });
    const second = await boot.maybeAutoBootBot("H2", p, { win: h.win, importer: h.importer });
    assert.equal(first.stopped, 1, "old bot stopped");
    assert.equal(first.disposed, 1, "old host disposed (leaves window.__rynthEventHosts)");
    assert.equal(h.win.__bot, second);
    assert.equal(h.win.__botHandle, "H2");
  });
  assert.deepStrictEqual(h.logs, [
    "[rynth] grind bot auto-booted via ?bot=1",
    "[rynth] grind bot re-booted onto new session via ?bot=1 (takeover rebind)",
  ]);
});

await check("operator AI latch: cfg.ai=false + the suppression log line (and botStop → startHeld)", async () => {
  const h = harness({ ai: true, botStop: true });
  await withConsole(h, async () => {
    const bot = await boot.maybeAutoBootBot("H1", boot.readBotUrlParams("?bot=1&botModel=minimax/minimax-m3"), { win: h.win, importer: h.importer });
    assert.equal(bot.cfg.ai, false);
    assert.equal(bot.cfg.startHeld, true);
  });
  assert.deepStrictEqual(h.logs, [
    "[bot] AI director suppressed: operator stop latch",
    "[bot] booting HELD: operator stop latch (START in the RynthSuite HUD resumes)",
    "[rynth] grind bot auto-booted via ?bot=1",
  ]);
});

await check("AI latch alone: the unchanged single suppression line, no held line", async () => {
  const h = harness({ ai: true, botStop: false });
  await withConsole(h, () => boot.maybeAutoBootBot("H1", boot.readBotUrlParams("?bot=1"), { win: h.win, importer: h.importer }));
  assert.deepStrictEqual(h.logs, ["[bot] AI director suppressed: operator stop latch", "[rynth] grind bot auto-booted via ?bot=1"]);
});

await check("bot latch alone (describeOperatorStop): startHeld reaches createGrindBot + the held line", async () => {
  const h = harness();
  const os = {
    applyOperatorStopToCfg(cfg) { cfg.startHeld = true; return false; },
    describeOperatorStop: () => ({ ai: false, bot: true }),
  };
  const importer = async (u) => (u.endsWith("rynth/ai/operator_stop.js") ? os : h.importer(u));
  const bot = await withConsole(h, () => boot.maybeAutoBootBot("H1", boot.readBotUrlParams("?bot=1"), { win: h.win, importer }));
  assert.equal(bot.cfg.startHeld, true);
  assert.equal(bot.cfg.ai, undefined, "the AI stays on the table");
  assert.deepStrictEqual(h.logs, [
    "[bot] booting HELD: operator stop latch (START in the RynthSuite HUD resumes)",
    "[rynth] grind bot auto-booted via ?bot=1",
  ]);
});

await check("a missing latch module never blocks the boot", async () => {
  const h = harness({ failLatch: true });
  const bot = await withConsole(h, () => boot.maybeAutoBootBot("H1", boot.readBotUrlParams("?bot=1"), { win: h.win, importer: h.importer }));
  assert.ok(bot);
  assert.deepStrictEqual(h.warns, []);
});

await check("a failing bot module warns with the ?bot=1 prefix and resets the guard", async () => {
  const h = harness({ failBot: true });
  const r = await withConsole(h, () => boot.maybeAutoBootBot("H1", boot.readBotUrlParams("?bot=1"), { win: h.win, importer: h.importer }));
  assert.equal(r, null);
  assert.equal(h.win.__botBooting, false);
  assert.equal(h.win.__bot, null);
  assert.equal(h.warns.length, 1);
  assert.ok(h.warns[0].startsWith("[rynth] ?bot=1 auto-boot failed:"));
});

// ── 3. HUD boots ───────────────────────────────────────────────────────
await check("bootBotFromHud: page bot* params still apply, HUD settings layer on top", async () => {
  const h = harness();
  h.win.location = { href: "http://h/apps/holtburger-web/index.html?botAi=off&nav=off", search: "?botAi=off&nav=off" };
  const bot = await withConsole(h, () => boot.bootBotFromHud("H1", {
    buffs: [2, "24", 0, -1, 2], priorities: { " Olthoi ": 12, bad: "x" }, lootMin: 250,
    vitals: { healAtCombat: 55, nope: 300 }, persona: "explorer",
  }, { win: h.win, importer: h.importer }));
  assert.deepStrictEqual(bot.cfg, {
    ai: false, // ?botAi=off wins; explorer persona not carried without the AI
    buffs: [2, 24],
    priorities: { olthoi: 12 },
    loot: { minValue: 250 },
    vitals: { healAtCombat: 55 },
  });
  assert.deepStrictEqual(h.logs, ["[rynth] grind bot booted from the RynthSuite HUD"]);
  assert.deepStrictEqual(h.win.__botBootSpec.source, "hud");
});

await check("explorer persona rides cfg.ai only when an AI key is saved", async () => {
  const cfg1 = boot.applyHudOverrides({}, { persona: "explorer" }, { hasAiKey: false });
  assert.equal(cfg1.ai, undefined);
  const cfg2 = boot.applyHudOverrides({}, { persona: "explorer" }, { hasAiKey: true });
  assert.deepStrictEqual(cfg2.ai, { persona: "explorer" });
  const cfg3 = boot.applyHudOverrides({ ai: false }, { persona: "explorer" }, { hasAiKey: true });
  assert.equal(cfg3.ai, false);
});

await check("a HUD-booted bot (no ?bot=1) is rebound on takeover with its HUD settings", async () => {
  const h = harness();
  h.win.location = { href: "http://h/apps/holtburger-web/index.html", search: "" };
  await withConsole(h, async () => {
    const first = await boot.bootBotFromHud("H1", { lootMin: 7 }, { win: h.win, importer: h.importer });
    // kind=7 again on the SAME handle: nothing to do.
    assert.equal(boot.maybeAutoBootBot("H1", boot.readBotUrlParams(""), { win: h.win, importer: h.importer }), null);
    // Takeover: a new handle.
    const second = await boot.maybeAutoBootBot("H2", boot.readBotUrlParams(""), { win: h.win, importer: h.importer });
    assert.equal(first.stopped, 1);
    assert.deepStrictEqual(second.cfg.loot, { minValue: 7 });
  });
  assert.deepStrictEqual(h.logs, [
    "[rynth] grind bot booted from the RynthSuite HUD",
    "[rynth] grind bot re-booted from the RynthSuite HUD",
  ]);
});

// ── 4. takeover carries the LIVE settings; boot failures never orphan a bot ──
// A fake bot module whose bots carry loop objects (so live settings can be
// edited on them and runtime flags read back).
function loopsImporter(h, { failBot = false, throwCreate = false, os = null } = {}) {
  return async (url) => {
    if (url.endsWith("rynth/bot.js")) {
      if (failBot) throw new Error("bot.js failed to load");
      return {
        createGrindBot: async (handle, cfg) => {
          if (throwCreate) throw new Error("createGrindBot blew up");
          const bot = {
            handle, cfg, stopped: 0, disposed: 0,
            stop() { this.stopped++; },
            host: { dispose() { bot.disposed++; } },
            combat: { enabled: true, priorities: { ...(cfg.priorities || {}) } },
            loot: cfg.loot === false ? null : { enabled: cfg.loot?.enabled !== false, minValue: cfg.loot?.minValue ?? 0 },
            buff: Array.isArray(cfg.buffs) && cfg.buffs.length ? { enabled: true, rawDesired: cfg.buffs.slice() } : null,
            vitals: { cfg: { healAtCombat: 60, emergencyHp: 30, ...(cfg.vitals || {}) } },
          };
          h.made.push(bot);
          return bot;
        },
      };
    }
    if (url.endsWith("rynth/ai/operator_stop.js")) return os || latchOs(false, false);
    throw new Error(`unexpected import ${url}`);
  };
}

await check("takeover rebind continues the outgoing bot's LIVE settings (over the URL config)", async () => {
  const h = harness();
  const importer = loopsImporter(h);
  const p = boot.readBotUrlParams("?bot=1&botBuffs=auto");
  await withConsole(h, async () => {
    const first = await boot.maybeAutoBootBot("H1", p, { win: h.win, importer });
    // Edited after boot (HUD / director): priorities, hunting off, loot floor +
    // looting off, a fixed buff list with the loop paused, a vitals threshold.
    first.combat.priorities = { olthoi: 10, Drudge: 3, junk: "x" };
    first.combat.enabled = false;
    first.loot.minValue = 500;
    first.loot.enabled = false;
    first.buff = { enabled: false, rawDesired: [2, 24, 2] };
    first.vitals.cfg.healAtCombat = 70;
    first.vitals.cfg.bogus = 400;
    const second = await boot.maybeAutoBootBot("H2", p, { win: h.win, importer });
    assert.equal(first.stopped, 1);
    assert.deepStrictEqual(second.cfg.priorities, { olthoi: 10, Drudge: 3 });
    assert.deepStrictEqual(second.cfg.loot, { minValue: 500, enabled: false });
    assert.deepStrictEqual(second.cfg.buffs, [2, 24], "the live list replaces ?botBuffs=auto");
    assert.equal(second.cfg.vitals.healAtCombat, 70);
    assert.equal(second.cfg.vitals.bogus, undefined, "out-of-range values are not carried");
    assert.equal(second.combat.enabled, false, "hunting stays off (runtime flag)");
    assert.equal(second.buff.enabled, false, "a paused buff loop stays paused");
  });
});

await check("takeover carries 'buffing turned off' (empty live list) and a HUD-booted bot's live edits", async () => {
  const h = harness();
  h.win.location = { href: "http://h/apps/holtburger-web/index.html", search: "" };
  const importer = loopsImporter(h);
  await withConsole(h, async () => {
    const first = await boot.bootBotFromHud("H1", { buffs: [2], lootMin: 7 }, { win: h.win, importer });
    assert.deepStrictEqual(first.cfg.buffs, [2]);
    first.buff.rawDesired = []; // the HUD Buff toggle / setBuffs([]) emptied it
    first.loot.minValue = 42;
    const second = await boot.maybeAutoBootBot("H2", boot.readBotUrlParams(""), { win: h.win, importer });
    assert.deepStrictEqual(second.cfg.buffs, [], "no buffs: the empty live list wins over the boot-time [2]");
    assert.equal(second.cfg.loot.minValue, 42, "the live floor wins over the boot-time 7");
  });
});

await check("an explicit HUD Restart does NOT carry live settings — the saved HUD settings win", async () => {
  const h = harness();
  h.win.location = { href: "http://h/apps/holtburger-web/index.html", search: "" };
  const importer = loopsImporter(h);
  await withConsole(h, async () => {
    const first = await boot.bootBotFromHud("H1", { lootMin: 7 }, { win: h.win, importer });
    first.loot.minValue = 999;
    const second = await boot.bootBotFromHud("H1", { lootMin: 8 }, { win: h.win, importer });
    assert.equal(second.cfg.loot.minValue, 8);
    assert.equal(first.stopped, 1);
  });
});

await check("Restart on the SAME session with a failing bot module keeps the running bot installed", async () => {
  const h = harness();
  h.win.location = { href: "http://h/apps/holtburger-web/index.html", search: "" };
  await withConsole(h, async () => {
    const first = await boot.bootBotFromHud("H1", { lootMin: 7 }, { win: h.win, importer: loopsImporter(h) });
    const pending = boot.bootBotFromHud("H1", { lootMin: 8 }, { win: h.win, importer: loopsImporter(h, { failBot: true }) });
    assert.equal(h.win.__bot, first, "the running bot stays visible while the new one loads");
    const r = await pending;
    assert.equal(r, null);
    assert.equal(h.win.__bot, first, "still installed — START won't stack a second bot");
    assert.equal(first.stopped, 0, "and still running");
    assert.equal(h.win.__botHandle, "H1");
    assert.deepStrictEqual(h.win.__botBootSpec, { source: "hud", overrides: { lootMin: 7 } }, "its boot spec is restored");
    assert.equal(h.win.__botBooting, false);
  });
  assert.equal(h.warns.length, 1);
  assert.ok(h.warns[0].startsWith("[rynth] HUD bot boot failed:"));
});

await check("takeover with a failing bot module stops and drops the outgoing (dead-session) bot", async () => {
  const h = harness();
  const p = boot.readBotUrlParams("?bot=1");
  await withConsole(h, async () => {
    const first = await boot.maybeAutoBootBot("H1", p, { win: h.win, importer: loopsImporter(h) });
    const r = await boot.maybeAutoBootBot("H2", p, { win: h.win, importer: loopsImporter(h, { failBot: true }) });
    assert.equal(r, null);
    assert.equal(first.stopped, 1, "stopped — no orphaned heartbeat on the dead session");
    assert.equal(first.disposed, 1, "its host left the event-tap registry");
    assert.equal(h.win.__bot, null);
    assert.equal(h.win.__botBooting, false);
    // The next kind=7 boots again (nothing installed, not booting).
    const again = await boot.maybeAutoBootBot("H2", p, { win: h.win, importer: loopsImporter(h) });
    assert.ok(again && h.win.__bot === again);
  });
});

await check("createGrindBot throwing after the old bot was retired leaves no bot installed", async () => {
  const h = harness();
  const p = boot.readBotUrlParams("?bot=1");
  await withConsole(h, async () => {
    const first = await boot.maybeAutoBootBot("H1", p, { win: h.win, importer: loopsImporter(h) });
    const r = await boot.maybeAutoBootBot("H2", p, { win: h.win, importer: loopsImporter(h, { throwCreate: true }) });
    assert.equal(r, null);
    assert.equal(first.stopped, 1);
    assert.equal(h.win.__bot, null);
    assert.equal(h.win.__botBooting, false);
  });
});

await check("the latch scope (player guid) reaches applyOperatorStopToCfg + describeOperatorStop", async () => {
  const h = harness();
  const seen = [];
  const os = {
    applyOperatorStopToCfg(cfg, storage, scope) { seen.push(["apply", storage, scope]); return false; },
    describeOperatorStop(storage, scope) { seen.push(["describe", storage, scope]); return { ai: false, bot: false }; },
  };
  const handle = { playerGuid: () => 0x50000007 };
  await withConsole(h, () => boot.maybeAutoBootBot(handle, boot.readBotUrlParams("?bot=1"), { win: h.win, importer: loopsImporter(h, { os }) }));
  assert.deepStrictEqual(seen, [["apply", undefined, 0x50000007], ["describe", undefined, 0x50000007]]);
  // No guid (pre-login handle / test string): scope undefined = the origin-wide latch.
  seen.length = 0;
  const h2 = harness();
  await withConsole(h2, () => boot.maybeAutoBootBot("H1", boot.readBotUrlParams("?bot=1"), { win: h2.win, importer: loopsImporter(h2, { os }) }));
  assert.deepStrictEqual(seen, [["apply", undefined, undefined], ["describe", undefined, undefined]]);
});

await check("real operator_stop.js: only THIS character's persisted stop boots it held", async () => {
  const realOs = await import("../rynth/ai/operator_stop.js");
  if (typeof realOs.botStopKey !== "function") return; // pre-scope module: nothing to pin
  const m = new Map();
  const prevLs = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  try {
    realOs.latchBotStop(undefined, 0x50000008); // another character was stopped in another tab
    const h = harness();
    const importer = loopsImporter(h, { os: realOs });
    const mine = { playerGuid: () => 0x50000007 };
    const bot = await withConsole(h, () => boot.maybeAutoBootBot(mine, boot.readBotUrlParams("?bot=1"), { win: h.win, importer }));
    assert.equal(bot.cfg.startHeld, undefined, "not held by another character's stop");
    realOs.latchBotStop(undefined, 0x50000007);
    const h2 = harness();
    const bot2 = await withConsole(h2, () => boot.maybeAutoBootBot(mine, boot.readBotUrlParams("?bot=1"), { win: h2.win, importer: loopsImporter(h2, { os: realOs }) }));
    assert.equal(bot2.cfg.startHeld, true, "its own stop boots it held");
    assert.ok(h2.logs.includes("[bot] booting HELD: operator stop latch (START in the RynthSuite HUD resumes)"));
  } finally {
    globalThis.localStorage = prevLs;
  }
});

await check("captureLiveSettings carries the buff SPEC: 'auto' stays 'auto' (review-2 #9)", () => {
  const c1 = boot.captureLiveSettings({ buffSpec: "auto", buff: { rawDesired: [4325, 4291], enabled: true } });
  assert.equal(c1.buffs, "auto", "an auto rig comes back auto, not frozen to the resolved ids");
  assert.equal(c1.buffEnabled, true);
  assert.equal(boot.applyLiveCarryOver({ buffs: [2] }, c1).buffs, "auto");
  const c2 = boot.captureLiveSettings({ buffSpec: [24, 2, 2, -1], buff: { rawDesired: [4325] } });
  assert.deepStrictEqual(c2.buffs, [24, 2], "a fixed list spec wins over the resolved list");
  const off = boot.captureLiveSettings({ buffSpec: [] });
  assert.deepStrictEqual(off.buffs, [], "buffing turned off (no loop) is carried as off");
  const legacy = boot.captureLiveSettings({ buff: { rawDesired: [2, 24] } });
  assert.deepStrictEqual(legacy.buffs, [2, 24], "no spec (an older bot) -> the resolved list");
});

await check("real operator_stop.js: a LEGACY bare bot latch still boots the character held (compat, review-2 #5)", async () => {
  const realOs = await import("../rynth/ai/operator_stop.js");
  if (typeof realOs.botStopKey !== "function") return;
  const m = new Map();
  const prevLs = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
  try {
    realOs.latchBotStop(undefined); // the bare origin-wide key a pre-scope control wrote
    const h = harness();
    const mine = { playerGuid: () => 0x50000007 };
    const bot = await withConsole(h, () => boot.maybeAutoBootBot(mine, boot.readBotUrlParams("?bot=1"), { win: h.win, importer: loopsImporter(h, { os: realOs }) }));
    assert.equal(bot.cfg.startHeld, true, "the legacy latch still holds the boot");
    assert.ok(h.logs.includes("[bot] booting HELD: operator stop latch (START in the RynthSuite HUD resumes)"));
  } finally {
    globalThis.localStorage = prevLs;
  }
});

await check("captureLiveSettings never throws on a broken bot surface", () => {
  const evil = new Proxy({}, { get() { throw new Error("boom"); } });
  assert.deepStrictEqual(boot.captureLiveSettings(evil), {});
  assert.deepStrictEqual(boot.captureLiveSettings(null), {});
  const partial = { combat: { get priorities() { throw new Error("x"); }, enabled: true } };
  assert.deepStrictEqual(boot.captureLiveSettings(partial), { combatEnabled: true });
});

await check("boot.js has no static imports and no top-level window/location use", () => {
  const src = readFileSync(path.join(APP, "rynth/boot.js"), "utf8");
  assert.ok(!/^import\s/m.test(src), "static import found");
  assert.ok(src.includes('moduleUrl(win, "rynth/bot.js")'), "bot.js must resolve against location.href (bundle-safe)");
});

console.log(fail === 0 ? `rynth_boot_config: all ${pass} checks passed` : `rynth_boot_config: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
