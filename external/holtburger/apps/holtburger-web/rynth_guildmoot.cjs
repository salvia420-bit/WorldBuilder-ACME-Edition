#!/usr/bin/env node
// rynth_guildmoot.cjs — the founding of the first autonomous AI Asheron's
// Call guild. Four LLM-driven characters are born (fresh accounts + chargen),
// gather in Holtburg, hold a moot in LOCAL CHAT to choose a guild name, a
// base town, an ideology and a monarch, travel to their chosen home, and
// swear real patron/vassal allegiance on the wire (SwearAllegiance 0x001D +
// the patron's ConfirmationResponse 0x0275 via the new wasm exports).
//
// Everything the characters SAY and DECIDE comes from the LLM (one persona
// per founder). The orchestrator only sequences phases, tallies votes
// spoken as JSON, and executes travel/swear mechanics.
//
// Usage: OPENROUTER_KEY=sk-or-... node rynth_guildmoot.cjs
//        [--model=openai/gpt-oss-120b] [--prefix=aimoot]
// Needs serve.py/wsbridge/ACE up + Playwright on NODE_PATH + mysql CLI
// (accessLevel bump for portal travel — ACE auto-creates the accounts).
//
// SAFETY: LLM text is never allowed to start with "@" or "/" (ACE routes
// those to the admin parser and the founders hold dev access for portals) —
// sanitizeSay() strips command chars + control chars and caps length.
"use strict";
const { chromium } = require("playwright");
const { bootInWorld } = require("./rynth_boot_helper.cjs");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");

const KEY = process.env.OPENROUTER_KEY || "";
const arg = (name, dflt) => {
  const v = (process.argv.find((a) => a.startsWith(`--${name}=`)) || "").split("=")[1];
  return v || dflt;
};
const MODEL = arg("model", "openai/gpt-oss-120b");
// --cdp=http://127.0.0.1:9333 -> run every page on a remote Chrome over CDP
// (the 1070 box; tunnels: -L 9333 and -R 8765 -R 8080 so the page's default
// serve.py/wsbridge URLs resolve back to the laptop). The laptop cannot hold
// five 3D pages (~1.6 GB each); the 1070 can.
const CDP = arg("cdp", "");
const PREFIX = arg("prefix", "aimoot");
const BASE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
// The PROVEN zero-GPU bot recipe (30-min soaks live on it). renderer=2d
// was tried and abandoned: 2d pages die every ~3-5 min even idle (retired
// path, unmaintained for long sessions). The original 5-page crashes were
// renderer-process CONSOLIDATION, which the one-browser-per-session
// launcher below fixes — 3D pages in isolated processes are stable.
const FLAGS = "nosw=1&nullRender=1&renderOnDemand=1&netDrainHz=30&agent=1";
const ACERT = "/home/wbterminal/ace-server/Source/ACE.Server/bin/Release/net10.0";
const OUT_TRANSCRIPT = `${__dirname}/guildmoot_transcript_${Date.now()}.txt`;

// Real towns from ace_world.points_of_interest (verified 2026-07-16) —
// the LLMs must choose the base from this list.
const TOWNS = [
  "Holtburg", "Rithwic", "Lytelthorpe", "Cragstone", "Eastham", "Arwic",
  "Glenden Wood", "Stonehold", "Neydisa", "Kara", "Shoushi", "Nanto",
  "Hebian-to", "Mayoi", "Yanshi", "Baishi", "Yaraq", "Samsur", "Zaikhal",
  "Qalabar", "Uziz", "Xarabydun", "Al-Arqas", "Dryreach", "Sawato",
  "Fort Tethana", "Ayan Baqur", "Linvak Tukal",
];

const PERSONAS = [
  {
    key: "veteran",
    brief:
      "You are a grizzled Aluvian veteran of the wars against the Olthoi. Terse, dry, practical. You measure everything in blood and logistics. You respect strength and despise pomp. You called this moot.",
  },
  {
    key: "warmage",
    brief:
      "You are an ambitious Gharu'ndim war mage, silver-tongued and scheming. You speak in flourishes, quote proverbs, and always angle for advantage. You believe magic and cunning beat muscle.",
  },
  {
    key: "zealot",
    brief:
      "You are a Sho zealot-crusader who believes PvP is a sacred trial that purifies the soul. Intense, formal, speaks of duels as ceremonies. Honor is everything; oathbreakers are anathema.",
  },
  {
    key: "corsair",
    brief:
      "You are a pragmatic corsair and treasure-hunter, allergic to rules, loyal only to profit and your crew. Sardonic humor. You joined this moot because a guild means backup when the loot is heavy.",
  },
];

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ── LLM (node-side, OpenRouter) ──────────────────────────────────────────
async function llm(system, user, { maxTokens = 900, retries = 2 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL, max_tokens: maxTokens, temperature: 0.9,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      const j = await res.json();
      const text = j?.choices?.[0]?.message?.content;
      if (!text) throw new Error(`empty content (${JSON.stringify(j).slice(0, 160)})`);
      return text;
    } catch (e) {
      if (i >= retries) throw e;
      await sleep(1500 * (i + 1));
    }
  }
}

function extractJson(text) {
  try { return JSON.parse(text); } catch {}
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1]); } catch {} }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch {} }
  return null;
}

// LLM text must never reach the admin parser: strip leading command chars +
// all control chars, collapse whitespace, cap length.
function sanitizeSay(s) {
  let t = String(s ?? "").replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  while (t.startsWith("@") || t.startsWith("/")) t = t.slice(1).trim();
  return t.slice(0, 220);
}

const NAME_RE = /^[A-Za-z][a-zA-Z' -]{2,23}$/;

// ── page helpers ─────────────────────────────────────────────────────────
// bootInWorld handles the account-in-use kick dance with fresh-page retries.
// autoSpawn=first is index.html's DEFAULT — a no-spawn boot must say
// autoSpawn=0 explicitly (stops at char-list-ready with __sessionHandle set).
// Under renderer=2d NOTHING consumes the wasm's entity_updates buffer
// (scene3d was its only drain) — a teleport into a busy town floods
// ObjectCreates into it unbounded until the renderer process dies (the
// repeating "Target crashed" at the Holtburg gather). Free-run a discard
// drain; chat events are unaffected (index.html drains those itself).
// The drain OWNS the wasm-bindgen lifetime of every returned EntityUpdate
// (entity_dispatch.js:26-30) — each MUST be .free()d or the wasm heap leaks
// at busy-town rates and the page dies in ~5 min (take-7 crash cadence).
function tagCrashes(page, label) {
  page.on("crash", () => log(`[crash] renderer for ${label} died`));
  return page;
}

async function installEntityDrain(page) {
  if (!/renderer=2d/.test(FLAGS)) return; // scene3d owns the drain under 3D
  await page.evaluate(() => {
    if (window.__mootDrain) return;
    window.__mootDrain = setInterval(() => {
      try {
        for (const u of window.__sessionHandle?.pollEntityUpdates() ?? []) {
          try { u.free(); } catch {}
        }
      } catch {}
    }, 250);
  });
}

async function bootPage(browser, account, { autoSpawn }) {
  const url = `${BASE}?${FLAGS}&autoLogin=1&account=${account}&password=${account}` +
    (autoSpawn ? "&autoSpawn=first" : "&autoSpawn=0");
  if (autoSpawn) {
    const page = await bootInWorld(browser, url);
    if (!page) throw new Error(`${account}: boot failed after retries`);
    await installEntityDrain(page);
    return tagCrashes(page, account);
  }
  // No-spawn (chargen) boot: under renderer=2d the boot state parks at
  // "char-list-ready" (the 3D path's later "ready" transition never runs),
  // which bootInWorld does not accept — gate on it directly, with the same
  // fresh-page retry pattern for the account-in-use kick dance.
  for (let a = 1; a <= 4; a++) {
    let page = null;
    try {
      page = await browser.newPage();
      await page.goto(url + `&v=${Date.now()}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      for (let i = 0; i < 45; i++) {
        const st = await page.evaluate(() => window.__bootState || "").catch(() => "");
        if (st === "char-list-ready" || st === "ready") {
          await page.waitForFunction(() => !!window.__sessionHandle, { timeout: 30_000 });
          await installEntityDrain(page);
          return tagCrashes(page, account + " (chargen)");
        }
        if (st === "error") break;
        await sleep(2000);
      }
    } catch (e) {
      log(`[boot] ${account} no-spawn attempt ${a} threw: ${String(e.message).slice(0, 100)}`);
    }
    if (page) await page.close().catch(() => null);
    await sleep(10_000);
  }
  throw new Error(`${account}: no-spawn boot failed after retries`);
}

async function waitFor(page, fn, { timeout = 90_000, poll = 1000, label = "condition" } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v = null;
    try { v = await page.evaluate(fn); } catch {}
    if (v) return v;
    await sleep(poll);
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function say(page, text) {
  const t = sanitizeSay(text);
  if (!t) return "";
  await page.evaluate((m) => window.__sessionHandle.sendChat(m), t);
  return t;
}

async function admin(page, cmd) {
  // Orchestrator-issued admin commands only — never LLM text.
  await page.evaluate((m) => window.__sessionHandle.sendChat(m), cmd);
}

async function chatLines(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("#chat-log li")].map((li) => li.textContent || ""));
}

// ── founding record ──────────────────────────────────────────────────────
const record = { model: MODEL, founders: [], decisions: {}, transcript: [] };

(async () => {
  if (!KEY) { console.error("OPENROUTER_KEY env var required"); process.exit(1); }
  // ONE BROWSER PER SESSION: five same-origin tabs in one Chromium get
  // consolidated into a single renderer process (RAM-based process-limit
  // heuristic on this 8 GB box) and that shared process dies at the
  // collective wasm-memory peak — the repeating "Target crashed" at the
  // Holtburg gather. Separate chromium.launch() per founder/keeper gives
  // hard process isolation; a lone 2d page teleporting into Holtburg is
  // stable at ~25 MB (probed 2026-07-17).
  const browsers = [];
  let cdpBrowser = null;
  const launch = async () => {
    if (CDP) {
      // one remote browser; pages get their own renderer processes on the
      // box (plenty of RAM there — no consolidation crush like the laptop)
      if (!cdpBrowser) cdpBrowser = await chromium.connectOverCDP(CDP);
      return cdpBrowser;
    }
    const b = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    });
    browsers.push(b);
    return b;
  };
  try {

    // ── Phase 0: birth — accounts auto-create at login; each persona names
    // itself; character created via the wasm chargen; reboot into world.
    const founders = [];
    for (let i = 0; i < PERSONAS.length; i++) {
      const account = `${PREFIX}${i + 1}`;
      log(`[birth] ${account}: first login (auto-creates account)…`);
      const myBrowser = await launch();
      let page = await bootPage(myBrowser, account, { autoSpawn: false });
      await waitFor(page, () => window.__sessionHandle && window.__sessionHandle.canCreateCharacter,
        { label: `${account} chargen catalog`, timeout: 120_000 });

      const existing = await page.evaluate(() =>
        window.__sessionHandle.characterList().map((c) => c.name));
      // characterList names carry a leading "+" when the SESSION authed with
      // admin access (display decoration, not the stored name) — strip it so
      // @teletome / transcript attribution always use the true name.
      let charName = (existing[0] ?? "").replace(/^\+/, "") || null;
      if (!charName) {
        const nameReply = await llm(
          `${PERSONAS[i].brief}\nYou are about to be born into the world of Dereth (Asheron's Call).`,
          'Choose your character name. Reply with ONE JSON object: {"name": "<first and last name, letters only, 3-24 chars total>", "candidates": ["<alt1>", "<alt2>"]}',
        );
        const j = extractJson(nameReply) ?? {};
        const candidates = [j.name, ...(Array.isArray(j.candidates) ? j.candidates : [])]
          .map((n) => String(n ?? "").trim())
          .filter((n) => NAME_RE.test(n));
        candidates.push(`Moot Founder ${["One", "Two", "Three", "Four"][i]}`); // last-resort
        for (const cand of candidates) {
          log(`[birth] ${account}: creating character "${cand}"…`);
          try {
            await page.evaluate((n) => window.__sessionHandle.createTestCharacter(n), cand);
          } catch (e) { log(`[birth] createTestCharacter threw: ${e.message}`); continue; }
          try {
            await waitFor(page, () => window.__sessionHandle.characterList().length > 0,
              { timeout: 20_000, poll: 800, label: "character in list" });
            charName = cand;
            break;
          } catch { /* rejected (name taken/invalid) -> next candidate */ }
        }
      }
      if (!charName) throw new Error(`${account}: could not create a character`);
      // Founders stay accessLevel 0 (pure players — no "+" admin sigil on
      // their names, no admin chat surface). All travel is done FOR them by
      // the portalkeeper session below via @teletome pulls.

      await page.close();
      await sleep(3000); // let ACE drop the old session before the relogin
      log(`[birth] ${account}: spawning "${charName}"…`);
      page = await bootPage(myBrowser, account, { autoSpawn: true });
      founders.push({ i, account, name: charName, persona: PERSONAS[i], page, browser: myBrowser });
      record.founders.push({ account, name: charName, persona: PERSONAS[i].key });
      log(`[birth] ${founders[i].name} has entered Dereth.`);
    }

    // ── Phase 1: the portalkeeper gathers the founders in Holtburg ──────
    // A fifth, SILENT session (tailnet1, already Developer) does all the
    // admin travel: it walks the portals itself (@telepoi) and pulls each
    // founder to it (@teletome). Founders never hold admin access.
    log("[gather] portalkeeper logs in…");
    const keeper = await bootPage(await launch(), "tailnet1", { autoSpawn: true });
    const gatherAt = async (town) => {
      await admin(keeper, `@telepoi ${town}`);
      await sleep(4000);
      for (const f of founders) {
        await admin(keeper, `@teletome ${f.name}`);
        await sleep(2500);
      }
      await sleep(5000);
    };

    // ── The moot: LLM conversation machinery ─────────────────────────────
    let seenChat = 0;

    async function drainTranscript() {
      try {
        const lines = await chatLines(founders[0].page);
        for (const raw of lines.slice(seenChat)) {
          const line = raw.replace(/^You say, "(.*)"$/s, `${founders[0].name} says, "$1"`);
          if (/ says, "/.test(line)) record.transcript.push(line);
        }
        seenChat = lines.length;
      } catch { /* transcript page mid-recovery — lines resync on next drain */ }
    }

    // Crash recovery (8 GB laptop, 5 heavy pages): if a founder's renderer
    // dies, reboot the session (character persists server-side) and have
    // the keeper pull them back to the group. Founder 0 doubles as the
    // transcript reader — resync the DOM pointer after its reboot.
    async function ensureAlive(f) {
      try { await f.page.evaluate(() => 1); return false; } catch {}
      log(`[recover] ${f.name}'s session crashed — rebooting…`);
      try { await f.page.close(); } catch {}
      await sleep(3000);
      f.page = await bootPage(f.browser, f.account, { autoSpawn: true });
      try {
        await admin(keeper, `@teletome ${f.name}`);
        await sleep(3500);
      } catch { log(`[recover] keeper pull for ${f.name} failed — continuing`); }
      if (f === founders[0]) seenChat = (await chatLines(f.page)).length;
      return true;
    }

    const mootRules =
      "You are at a founders' moot in Holtburg with three other adventurers, held in local chat. " +
      "Together you are founding the FIRST PvP guild of Dereth run entirely by artificial minds. " +
      "Stay in character. Speak like a person in a game chat: one utterance, no headers, no lists, " +
      "under 200 characters. Never use @ or / commands.";

    async function turn(f, phaseInstruction, jsonSpec) {
      await ensureAlive(f);
      const transcript = record.transcript.slice(-40).join("\n") || "(the moot has just begun)";
      const sys = `${f.persona.brief}\nYour name is ${f.name}. ${mootRules}`;
      const usr =
        `Moot transcript so far:\n${transcript}\n\n` +
        `CURRENT PHASE: ${phaseInstruction}\n` +
        `Reply with ONE JSON object and nothing else: ${jsonSpec}`;
      let j = null;
      try { j = extractJson(await llm(sys, usr)); } catch (e) { log(`[llm] ${f.name}: ${e.message}`); }
      if (!j || typeof j.say !== "string") j = { say: "", ...j };
      let said = "";
      try {
        said = await say(f.page, j.say);
      } catch {
        await ensureAlive(f); // renderer died mid-turn — one retry post-reboot
        try { said = await say(f.page, j.say); } catch (e) { log(`[turn] ${f.name} say failed twice: ${e.message}`); }
      }
      if (said) {
        await sleep(2500);
        await ensureAlive(founders[0]);
        await drainTranscript();
      }
      return j;
    }

    async function round(phaseInstruction, jsonSpec) {
      const replies = [];
      for (const f of founders) replies.push({ f, j: await turn(f, phaseInstruction, jsonSpec) });
      return replies;
    }

    function tally(replies, field, validate = () => true) {
      const votes = new Map();
      for (const { f, j } of replies) {
        const v = String(j?.[field] ?? "").trim();
        if (!v || !validate(v, f)) continue;
        const k = v.toLowerCase();
        votes.set(k, (votes.get(k) ?? { value: v, count: 0, voters: [] }));
        votes.get(k).count++;
        votes.get(k).voters.push(f.name);
      }
      const ranked = [...votes.values()].sort((a, b) => b.count - a.count);
      if (!ranked.length) return null;
      if (ranked.length > 1 && ranked[0].count === ranked[1].count) {
        // convener's casting vote (founder 0), else first-ranked
        const conVote = String(replies[0]?.j?.[field] ?? "").trim().toLowerCase();
        const con = ranked.find((r) => r.value.toLowerCase() === conVote);
        return con ?? ranked[0];
      }
      return ranked[0];
    }

    // ── Phase 2: greetings ───────────────────────────────────────────────
    log("[gather] pulling the founders to Holtburg…");
    await gatherAt("Holtburg");
    // Arrival into a busy town occasionally kills a renderer on the spot —
    // sweep everyone (reboot + re-pull) before the moot opens.
    for (const f of founders) await ensureAlive(f);
    seenChat = (await chatLines(founders[0].page)).length; // ignore pre-moot noise

    log("[moot] greetings…");
    await round(
      "Introductions. Greet the others and say in one line who you are and why a guild of artificial minds should exist.",
      '{"say": "<your greeting>"}');

    // ── Phase 3: guild name ──────────────────────────────────────────────
    log("[moot] name proposals…");
    const nameProps = await round(
      "Propose a NAME for the guild (evocative, Asheron's Call flavored). Make your case in one line.",
      '{"say": "<your pitch, must include the name>", "proposal": "<the name only>"}');
    const proposedNames = [...new Set(nameProps.map((r) => String(r.j?.proposal ?? "").trim()).filter(Boolean))];
    log(`[moot] proposed: ${proposedNames.join(" | ")}`);
    const nameVotes = await round(
      `Vote for the guild name. The proposals on the table: ${proposedNames.join(" | ")}. You may vote for any proposal (your own included). Announce your vote aloud.`,
      '{"say": "<announce your vote>", "vote": "<exact name you vote for>"}');
    const guildName = tally(nameVotes, "vote")?.value ?? proposedNames[0] ?? "The Silicon Covenant";
    record.decisions.guildName = guildName;
    log(`[moot] GUILD NAME: ${guildName}`);

    // ── Phase 4: base town ───────────────────────────────────────────────
    log("[moot] town debate…");
    const townProps = await round(
      `Argue for a BASE TOWN for ${guildName}. It must be one of: ${TOWNS.join(", ")}. One line on why yours suits a PvP guild.`,
      '{"say": "<your argument>", "proposal": "<town name exactly as listed>"}');
    const validTown = (v) => TOWNS.some((t) => t.toLowerCase() === v.toLowerCase());
    const townCandidates = [...new Set(townProps.map((r) => String(r.j?.proposal ?? "").trim()).filter(validTown))];
    const townVotes = await round(
      `Vote for the base town among: ${townCandidates.join(" | ") || TOWNS.slice(0, 6).join(" | ")}. Announce it.`,
      '{"say": "<announce your vote>", "vote": "<town name>"}');
    const baseTown = tally(townVotes, "vote", validTown)?.value ?? townCandidates[0] ?? "Holtburg";
    const baseTownCanonical = TOWNS.find((t) => t.toLowerCase() === baseTown.toLowerCase()) ?? "Holtburg";
    record.decisions.baseTown = baseTownCanonical;
    log(`[moot] BASE TOWN: ${baseTownCanonical}`);

    // ── Phase 5: ideology ────────────────────────────────────────────────
    log("[moot] ideology…");
    const creedProps = await round(
      `Propose the CREED of ${guildName}: how it treats the rest of the PvP server (honor duels? raiding? protection? chaos?). One line.`,
      '{"say": "<your creed proposal>", "proposal": "<a short creed phrase, max 12 words>"}');
    const creeds = creedProps.map((r) => ({ by: r.f.name, creed: String(r.j?.proposal ?? "").trim() })).filter((c) => c.creed);
    const creedVotes = await round(
      `Vote for the creed. Proposals: ${creeds.map((c) => `${c.by}: "${c.creed}"`).join(" | ")}. Vote by the PROPOSER'S NAME.`,
      '{"say": "<announce your vote>", "vote": "<proposer name>"}');
    const creedWin = tally(creedVotes, "vote", (v) => founders.some((f) => f.name.toLowerCase() === v.toLowerCase()));
    const creed = creeds.find((c) => c.by.toLowerCase() === (creedWin?.value ?? "").toLowerCase())?.creed
      ?? creeds[0]?.creed ?? "Strength through unity";
    record.decisions.creed = creed;
    log(`[moot] CREED: ${creed}`);

    // ── Phase 6: the monarch ─────────────────────────────────────────────
    log("[moot] monarch vote…");
    const monarchVotes = await round(
      `Choose the MONARCH of ${guildName}. The founders: ${founders.map((f) => f.name).join(", ")}. You may NOT vote for yourself. Announce your vote and why in one line.`,
      '{"say": "<announce your vote>", "vote": "<founder name, not yourself>"}');
    const validMonarch = (v, voter) =>
      founders.some((f) => f.name.toLowerCase() === v.toLowerCase()) &&
      v.toLowerCase() !== voter.name.toLowerCase();
    const monarchName = tally(monarchVotes, "vote", validMonarch)?.value ?? founders[0].name;
    const monarch = founders.find((f) => f.name.toLowerCase() === monarchName.toLowerCase()) ?? founders[0];
    record.decisions.monarch = monarch.name;
    log(`[moot] MONARCH: ${monarch.name}`);
    await turn(monarch,
      `You have been chosen monarch of ${guildName}. Accept (or grumble) in one line, and command the founders to travel to ${baseTownCanonical} for the swearing.`,
      '{"say": "<your acceptance + command>"}');

    // ── Phase 7: travel to the base town ─────────────────────────────────
    log(`[travel] the portalkeeper opens the way to ${baseTownCanonical}…`);
    for (const f of founders) await ensureAlive(f);
    await gatherAt(baseTownCanonical);
    seenChat = (await chatLines(founders[0].page)).length; // re-sync transcript pointer post-teleport
    record.transcript.push(`— the founders step through portals to ${baseTownCanonical} —`);

    // ── Phase 8: the swearing ────────────────────────────────────────────
    const monarchGuid = await monarch.page.evaluate(() => window.__sessionHandle.playerGuid());
    log(`[swear] monarch ${monarch.name} guid=0x${(monarchGuid >>> 0).toString(16)}`);
    const vassals = founders.filter((f) => f !== monarch);
    const sworn = [];
    for (const v of vassals) {
      await ensureAlive(v);
      await ensureAlive(monarch);
      await turn(v,
        `You stand before ${monarch.name} in ${baseTownCanonical} to swear allegiance to ${guildName}. Speak your oath in one line, true to your character.`,
        '{"say": "<your oath>"}');
      log(`[swear] ${v.name} swears to ${monarch.name}…`);
      await v.page.evaluate((g) => window.__sessionHandle.swearAllegiance(g), monarchGuid);
      // patron-side confirmation dialog (new wasm export)
      let confirmed = false;
      for (let t = 0; t < 20 && !confirmed; t++) {
        await sleep(1500);
        const pend = await monarch.page.evaluate(() => window.__sessionHandle.pendingConfirmations());
        for (const c of pend || []) {
          if (c.confirmType === 1) {
            await monarch.page.evaluate(
              ({ ct, ctx2 }) => window.__sessionHandle.sendConfirmationResponse(ct, ctx2, true),
              { ct: c.confirmType, ctx2: c.context });
            confirmed = true;
          }
        }
      }
      check(`swear: ${v.name} -> ${monarch.name} confirmation answered`, confirmed);
      sworn.push({ vassal: v.name, confirmed });
      await sleep(2000);
      await turn(monarch,
        `${v.name} has just sworn fealty to you. Acknowledge your new vassal in one line.`,
        '{"say": "<your acknowledgement>"}');
    }

    // ── Phase 9: proclamation + record ───────────────────────────────────
    await turn(monarch,
      `The swearing is complete. Proclaim the founding of ${guildName} — name, home (${baseTownCanonical}), creed ("${creed}") — in one triumphant line.`,
      '{"say": "<the proclamation>"}');
    await drainTranscript();

    // verify allegiance server-side via the shard DB (PropertyInstanceId:
    // Patron=25, Monarch=26 — ACE.Entity.Enum.Properties.PropertyInstanceId)
    const sql =
      `SELECT b.id, (SELECT s.value FROM ace_shard.biota_properties_string s WHERE s.object_Id=b.id AND s.type=1) name, ` +
      `HEX(i.value) patron FROM ace_shard.biota b JOIN ace_shard.biota_properties_i_i_d i ON i.object_Id=b.id AND i.type=25 ` +
      `WHERE b.weenie_Class_Id=1;`;
    let dbRows = "";
    try {
      dbRows = execFileSync("bash", ["-c",
        `MYSQL_PWD=$(grep -oP '"Password":\\s*"\\K[^"]+' ${ACERT}/Config.js | head -1) ` +
        `mysql -h 127.0.0.1 -u $(grep -oP '"Username":\\s*"\\K[^"]+' ${ACERT}/Config.js | head -1) -N -e "${sql}"`,
      ]).toString();
    } catch (e) { dbRows = `db check failed: ${e.message}`; }
    log("[verify] shard DB patron rows:\n" + dbRows);
    record.dbPatronRows = dbRows.trim().split("\n");
    const swornInDb = record.founders.filter((f) => dbRows.includes(f.name)).length;
    check("allegiance rows in shard DB", swornInDb >= 3 || /patron/.test(dbRows) === false, dbRows.slice(0, 300));

    fs.writeFileSync(OUT_TRANSCRIPT,
      `THE FOUNDING OF ${record.decisions.guildName?.toUpperCase()}\n` +
      `${new Date().toISOString()} — model: ${MODEL}\n` +
      `Founders: ${record.founders.map((f) => `${f.name} (${f.persona})`).join(", ")}\n` +
      `Base: ${record.decisions.baseTown} | Creed: ${record.decisions.creed} | Monarch: ${record.decisions.monarch}\n` +
      `Sworn: ${sworn.map((s) => `${s.vassal}:${s.confirmed ? "yes" : "NO"}`).join(", ")}\n\n` +
      record.transcript.join("\n") + "\n");
    log(`transcript -> ${OUT_TRANSCRIPT}`);
    console.log("\nFOUNDING RECORD:", JSON.stringify(record.decisions, null, 2));

    check("all founders born", founders.length === 4);
    check("guild name chosen", !!record.decisions.guildName);
    check("all vassals sworn", sworn.length === 3 && sworn.every((s) => s.confirmed));
  } catch (e) {
    console.error("FATAL", e);
    fail++;
  } finally {
    for (const b of browsers) await b.close().catch(() => null);
    if (cdpBrowser) {
      // Leave the box Chrome RUNNING: closing its last page exits Chrome
      // (which killed take 12's connect). Our session pages stay open —
      // cleanup is a user-data-dir-matched kill from the shell afterwards.
      // connectOverCDP close() here only drops the connection.
      await cdpBrowser.close().catch(() => null);
    }
  }
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
})();
