// rynth/boot.js — the ONE way a RynthSuite grind bot gets booted on a live
// page (2026-10-12).
//
// Two callers share it:
//   1. app/client_events.js, kind=7 EnteredWorld — the ?bot=1 auto-boot
//      (2026-07-17). Its URL → config assembly moved here VERBATIM; the boot
//      block in client_events.js now only reads the URL (the flag lint and
//      rynth_ai_persona_test pin those `botParams.get(…)` reads THERE) and
//      calls maybeAutoBootBot().
//   2. plugins/rynth-hud.js START on a page loaded WITHOUT ?bot=1 —
//      bootBotFromHud(): the same URL-derived config plus the HUD's saved
//      settings (buffs, monster priorities, loot floor, vitals thresholds).
//   3. the VTank option StartMacroOnLogin (2026-10-19) — the same kind=7
//      EnteredWorld, maybeStartMacroOnLogin(): START (the HUD's, else the
//      same steps here) when the character's active VTank profile asks for it.
//
// Behavior of the ?bot=1 path is unchanged: same config, same globals
// (window.__bot / __botHandle / __botBooting), same console lines, same
// takeover rebind rule. tests/rynth_boot_config.test.mjs pins the URL →
// config mapping against a copy of the pre-move code.
//
// No static imports and no top-level side effects: app/client_events.js
// imports this file statically, and tests/app_client_events.test.mjs imports
// that module under plain node. Module URLs are resolved against
// location.href ("rynth/bot.js"), exactly as the original block did — NOT
// import.meta.url, which points into shell/ once scripts/build-shell.mjs
// bundles the app.

/** Every URL param the boot reads, in the order the original block read them
 *  (later additions appended: botBuffs 2026-10-12, botVt 2026-10-13). */
export const BOT_URL_PARAM_NAMES = Object.freeze([
  "bot", "botAi", "nav", "navEndpoint", "botKernel", "explorePressure",
  "botCtlOwner", "botPersona", "botModel", "botInterval", "botBuffs", "botVt",
]);

/** URLSearchParams | search string → { name: string|null } for BOT_URL_PARAM_NAMES.
 *  The HUD's boot path uses this; client_events.js builds the same object
 *  with explicit `botParams.get("…")` reads (see the header). */
export function readBotUrlParams(search) {
  let sp;
  try {
    sp = search instanceof URLSearchParams ? search : new URLSearchParams(search ?? "");
  } catch (_) {
    sp = new URLSearchParams("");
  }
  const out = {};
  for (const name of BOT_URL_PARAM_NAMES) out[name] = sp.get(name);
  return out;
}

// Model-family provider-routing table (P1 #6 / rynth-review 09 C1,
// 2026-07-23): the original pin was a single `bm.startsWith("z-ai/")`
// literal, so it silently did nothing the moment the live rig rotated onto a
// different model family (STREAM-RIG-OPS.md model history: z-ai/glm-5.2 ->
// microsoft/phi-4 -> minimax/minimax-m3, the CURRENT live model) — unpinned
// OpenRouter default routing + the full 120s timeout + no cost floor, exactly
// the fallthrough this pin exists to prevent. Add a prefix entry here
// whenever the rig adopts a new family; z-ai/* keeps its EXACT
// soak-8-proven values unchanged.
export const PROVIDER_PIN_TABLE = Object.freeze([
  // z-ai/* (soak-8, unchanged): 3 fp8 sale endpoints, fastest first
  // (streamlake 1.08s/52tps), never falling through to 4x-price fp4 quants.
  { prefix: "z-ai/", provider: { order: ["streamlake", "novita", "baidu"], allow_fallbacks: false } },
  // minimax/minimax-m3 (2026-07-23): no soak-8-style provider ranking exists
  // yet for this family — same INTENT as the z-ai pin (fast/cheap hosts
  // first, `allow_fallbacks:false` so a bad first choice fails loud instead
  // of silently routing to an expensive default), not the same literal
  // providers. novita already hosts sale-priced endpoints for other
  // Chinese-model families per the z-ai pin above; minimax (the model's
  // first-party host) is the natural 2nd. Re-tune once minimax gets its own
  // soak.
  { prefix: "minimax/", provider: { order: ["novita", "minimax"], allow_fallbacks: false } },
]);

export function providerPinFor(model) {
  const hit = PROVIDER_PIN_TABLE.find((e) => model.startsWith(e.prefix));
  return hit ? { provider: hit.provider } : {};
}

/** The config before the operator-stop latch: ?botAi=off → { ai:false }. */
export function initialBotConfig(p) {
  return p && p.botAi === "off" ? { ai: false } : {};
}

/**
 * The rest of the URL → createGrindBot config mapping, applied AFTER the
 * operator-stop latch (which may have set cfg.ai = false and so switches the
 * AI block off). Mutates and returns cfg. Pure: no window / location /
 * storage. Order and every literal are the original block's.
 */
export function applyBotUrlParams(cfg, p) {
  // nav sidecar (2026-07-18): default-on. Without config.nav the bot has NO
  // coordinate travel (goto/goto_lb return "nav not configured") and a soak
  // strands in its spawn town — the sidecar is a standing laptop service
  // (:8767), and an unreachable endpoint only fails individual goto calls,
  // never the boot. ?nav=off opts out; ?navEndpoint= overrides.
  if (p.nav !== "off") {
    cfg.nav = { endpoint: p.navEndpoint || "http://127.0.0.1:8767" };
  }
  // Stream-rig bot tuning survives reloads via URL: ?botModel= (director
  // LLM), ?botInterval= (check-in minutes; caps scale with it). Provider pins
  // can't ride a URL — a reload falls back to OpenRouter default routing for
  // the chosen model.
  // ?botKernel=off — no grind loops (explorer/pure-travel).
  if (p.botKernel === "off") cfg.kernel = false;
  // ?botVt=off (2026-10-13, VTank layer escape hatch, PLAN D2): the bot boots
  // without rynth/vt/ (no `/rs` layer on the bot, the kernel's literal
  // ladder). Default ON = the layer loads (createGrindBot, unless
  // config.vt === false). Absent → cfg untouched (byte-identical). Read
  // outside the cfg.ai guard, like botKernel.
  if (p.botVt === "off") cfg.vt = false;
  // ?explorePressure=1 (task #15) — ambient idle-motion ticks between
  // AI-director check-ins (rynth/bot.js ExplorePressureController); only
  // fires with an enabled director, so read outside the cfg.ai guard like
  // botKernel above (harmless without a director). Exact-match opt-in;
  // default OFF.
  if (p.explorePressure === "1") cfg.explorePressure = true;
  // ?botBuffs= (2026-10-12): self-buffs to maintain — `auto` (bot.js builds
  // the list from the known spellbook, rynth/buff_loop.js
  // buildDynamicBuffList) or a comma list of spell ids. Absent → no buffs,
  // exactly as before. Read outside the cfg.ai guard (no director needed).
  const botBuffs = parseBotBuffsParam(p.botBuffs);
  if (botBuffs != null) cfg.buffs = botBuffs;
  // ?botCtlOwner= (P0 fix, rynth-review 13 #1 / P1 streamline #3,
  // 2026-07-23): sender allowlist for the in-game control channel
  // (RynthControlChannel, rynth/control_channel.js — refuses ALL commands
  // when its owner can't be resolved). Comma-split into an array so a rig
  // can name more than one trusted account (e.g. the operator's own
  // character alongside the bot's login). Read outside the cfg.ai guard,
  // same as botKernel/explorePressure above — the control channel is
  // independent of the AI director. Absent -> the channel's own default
  // applies (the logged-in character; refuse-all if that's ever
  // unresolvable) — carrying this through a reconnect just makes that
  // default explicit and future-proofs a multi-owner rig.
  const botCtlOwner = p.botCtlOwner;
  if (botCtlOwner) {
    cfg.control = {
      ...(cfg.control || {}),
      owner: botCtlOwner.split(",").map((s) => s.trim()).filter(Boolean),
    };
  }
  if (cfg.ai !== false) {
    // ?botPersona=explorer etc. — base-prompt persona (rynth/ai/director.js);
    // URL-carried so reconnect reboots keep it.
    const bp = p.botPersona;
    if (bp) cfg.ai = { ...(cfg.ai || {}), persona: bp };
    const bm = p.botModel;
    const bi = parseFloat(p.botInterval);
    // 2026-07-20 latency fix: 4096-token budgets let GLM ramble ~2,400
    // completion tokens ≈ 50-80s per check-in at ~30-50tps — the director
    // looked dead between calls. 1280 matches the documented discipline
    // (soak-8 measured GLM at 400-800 tokens) and the llm_client retries once
    // at double budget on a "length" cutoff.
    // 2026-07-23: heavy-reasoning models (minimax-m3) burn the ENTIRE 1280
    // (and the 2560 retry) on hidden reasoning and return an EMPTY completion
    // every call (finish_reason=length) — the director hit 5 such errors and
    // auto-disabled on the live rig. Give the minimax family the room it
    // needs; GLM/gpt-oss keep the latency-tuned 1280.
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

/** ?botBuffs value → "auto" | number[] (unique positive uint32 ids) | null
 *  (absent / empty / nothing valid → leave cfg.buffs unset). */
export function parseBotBuffsParam(v) {
  if (v == null) return null;
  const t = String(v).trim();
  if (!t) return null;
  if (t.toLowerCase() === "auto") return "auto";
  const ids = t.split(",").map((x) => Number(x.trim())).filter((x) => Number.isInteger(x) && x > 0 && x <= 0xFFFFFFFF);
  return ids.length ? [...new Set(ids)] : null;
}

/** Whole URL-derived config (tests / callers that already know the latch
 *  outcome): `latch(cfg)` is applied between the two halves, exactly where the
 *  boot runs operator_stop.js's applyOperatorStopToCfg. */
export function botConfigFromUrlParams(p, { latch = null } = {}) {
  const cfg = initialBotConfig(p);
  if (typeof latch === "function") latch(cfg);
  return applyBotUrlParams(cfg, p);
}

/**
 * HUD settings → createGrindBot config, layered AFTER the URL mapping. Only
 * used by HUD-initiated boots (never by a plain ?bot=1 page). Every field is
 * optional and validated; garbage is dropped, never passed through.
 *   { buffs: number[] | "auto", priorities: {name: number}, lootMin: number,
 *     vitals: {threshold: number}, persona: "grind"|"explorer" }
 * persona=explorer is only carried into cfg.ai when the AI director is on the
 * table (cfg.ai !== false AND hasAiKey) — bot.js keys its explorer boot
 * (combat + loot off) on config.ai.persona, but an ai object with no key
 * would build a director that can only fail; the HUD applies the explorer
 * loop toggles at runtime instead (hud_bridge.js applyPersona).
 */
export function applyHudOverrides(cfg, o, { hasAiKey = false } = {}) {
  if (!o || typeof o !== "object") return cfg;
  if (o.buffs === "auto") cfg.buffs = "auto";
  else if (Array.isArray(o.buffs)) {
    const ids = o.buffs.map(Number).filter((x) => Number.isInteger(x) && x > 0 && x <= 0xFFFFFFFF);
    if (ids.length) cfg.buffs = [...new Set(ids)];
  }
  if (o.priorities && typeof o.priorities === "object") {
    const pr = {};
    for (const [k, v] of Object.entries(o.priorities)) {
      const key = String(k).trim().toLowerCase();
      const n = Number(v);
      if (key && Number.isFinite(n)) pr[key] = Math.max(0, Math.min(20, Math.round(n)));
    }
    if (Object.keys(pr).length) cfg.priorities = pr;
  }
  if (o.lootMin != null && Number.isFinite(Number(o.lootMin)) && Number(o.lootMin) >= 0) {
    cfg.loot = { ...(cfg.loot && typeof cfg.loot === "object" ? cfg.loot : {}), minValue: Number(o.lootMin) };
  }
  if (o.vitals && typeof o.vitals === "object") {
    const th = {};
    for (const [k, v] of Object.entries(o.vitals)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0 && n <= 100) th[k] = n;
    }
    if (Object.keys(th).length) cfg.vitals = th;
  }
  if (o.persona === "explorer" && cfg.ai !== false && hasAiKey) {
    cfg.ai = { ...(cfg.ai && typeof cfg.ai === "object" ? cfg.ai : {}), persona: "explorer" };
  }
  return cfg;
}

function moduleUrl(win, rel) {
  // location.href-relative, like the original block (see header).
  return new URL(rel, win.location.href).href;
}

/** The ?bot=1 takeover rule, unchanged: boot when asked and not already
 *  booting, and either no bot exists or it is strapped to another handle. A
 *  HUD-booted bot (no ?bot=1) is rebound by the same rule — new behavior for
 *  pages WITHOUT ?bot=1 only. */
export function botNeedsBoot(win, p, targetHandle) {
  const spec = win.__botBootSpec;
  const wanted = (p && p.bot === "1") || !!(spec && spec.source === "hud" && win.__bot);
  return wanted && !win.__botBooting && (!win.__bot || win.__botHandle !== targetHandle);
}

// ── live-settings carry-over (takeover rebind) ──────────────────────────
// A session-takeover reboot used to rebuild the bot from boot-time config
// only: settings changed AFTER that boot — HUD edits (applied live to the
// loops), director actions (set_priorities, hunt_start/stop,
// set_loot_min_value) — silently reverted while the HUD still showed the new
// values. The rebind now reads them off the outgoing bot and layers them over
// the URL/HUD-boot config, so the new bot continues where the old one was.
// Explicit HUD boots (START / Restart) don't carry: their saved HUD settings
// are the operator's intent.

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/** The outgoing bot's live, editable settings. Plain property reads (no wasm),
 *  never throws; absent loops contribute nothing.
 *  -> { priorities?, lootMin?, lootEnabled?, buffs?, buffEnabled?, vitals?, combatEnabled? } */
export function captureLiveSettings(bot) {
  const out = {};
  if (!bot || typeof bot !== "object") return out;
  const read = (fn) => { try { return fn(); } catch (_) { return undefined; } };
  const combat = read(() => bot.combat ?? bot.kernel?.combat ?? null);
  if (combat) {
    const pr = read(() => combat.priorities);
    if (pr && typeof pr === "object") {
      const o = {};
      for (const [k, v] of Object.entries(pr)) if (k && isNum(Number(v))) o[k] = Number(v);
      out.priorities = o;
    }
    const en = read(() => combat.enabled);
    if (typeof en === "boolean") out.combatEnabled = en;
  }
  const loot = read(() => bot.loot ?? null);
  if (loot) {
    const mv = read(() => loot.minValue);
    if (isNum(mv) && mv >= 0) out.lootMin = mv;
    const en = read(() => loot.enabled);
    if (typeof en === "boolean") out.lootEnabled = en;
  }
  // The buff SPEC (bot.buffSpec: "auto" | id list) wins over the resolved
  // list: a ?botBuffs=auto rig must come back "auto" (spells learned later
  // keep joining), not frozen to yesterday's ids (review-2 #9).
  const cleanIds = (arr) => [...new Set(arr.map(Number).filter((x) => Number.isInteger(x) && x > 0 && x <= 0xFFFFFFFF))];
  const spec = read(() => bot.buffSpec);
  if (spec === "auto") out.buffs = "auto";
  else if (Array.isArray(spec)) out.buffs = cleanIds(spec);
  const buff = read(() => bot.buff ?? null);
  if (buff) {
    if (out.buffs === undefined) {
      const raw = read(() => buff.rawDesired ?? buff.desired);
      if (Array.isArray(raw)) out.buffs = cleanIds(raw);
    }
    const en = read(() => buff.enabled);
    if (typeof en === "boolean") out.buffEnabled = en;
  }
  const vcfg = read(() => bot.vitals?.cfg ?? null);
  if (vcfg && typeof vcfg === "object") {
    const th = {};
    for (const [k, v] of Object.entries(vcfg)) if (isNum(v) && v >= 0 && v <= 100) th[k] = v;
    if (Object.keys(th).length) out.vitals = th;
  }
  return out;
}

/** Layer captured live settings over an assembled createGrindBot config
 *  (they are newer than both the URL and the boot-time HUD settings).
 *  An empty captured buff list means "buffing was turned off" and is kept.
 *  Mutates and returns cfg. */
export function applyLiveCarryOver(cfg, carry) {
  if (!cfg || typeof cfg !== "object" || !carry || typeof carry !== "object") return cfg;
  if (carry.priorities && typeof carry.priorities === "object") cfg.priorities = { ...carry.priorities };
  if (cfg.loot !== false && (isNum(carry.lootMin) || typeof carry.lootEnabled === "boolean")) {
    const loot = { ...(cfg.loot && typeof cfg.loot === "object" ? cfg.loot : {}) };
    if (isNum(carry.lootMin)) loot.minValue = carry.lootMin;
    if (typeof carry.lootEnabled === "boolean") loot.enabled = carry.lootEnabled;
    cfg.loot = loot;
  }
  if (carry.buffs === "auto") cfg.buffs = "auto";
  else if (Array.isArray(carry.buffs)) cfg.buffs = carry.buffs.slice();
  if (cfg.vitals !== false && carry.vitals && typeof carry.vitals === "object") {
    cfg.vitals = { ...(cfg.vitals && typeof cfg.vitals === "object" ? cfg.vitals : {}), ...carry.vitals };
  }
  return cfg;
}

/** The carried flags that are not createGrindBot config (combat's `enabled`
 *  is not a constructor option; a paused buff loop is runtime state) — set on
 *  the freshly booted bot. Never throws. */
export function applyLiveRuntimeFlags(bot, carry) {
  if (!bot || !carry) return bot;
  try { if (typeof carry.combatEnabled === "boolean" && bot.combat) bot.combat.enabled = carry.combatEnabled; } catch (_) {}
  try { if (typeof carry.buffEnabled === "boolean" && bot.buff) bot.buff.enabled = carry.buffEnabled; } catch (_) {}
  return bot;
}

/** The logged-in character's guid — scopes the operator-stop latches to this
 *  character (rynth/ai/operator_stop.js). undefined when unknown. */
function latchScopeOf(handle) {
  try {
    const g = Number(handle?.playerGuid?.()) >>> 0;
    return g || undefined;
  } catch (_) {
    return undefined;
  }
}

/**
 * Boot (or re-boot onto a new session handle) — the original ?bot=1 body.
 * Resolves to the bot, or null on failure (logged, never thrown).
 *   opts.source     "url" (the ?bot=1 path) | "hud"
 *   opts.overrides  HUD settings (applyHudOverrides) — HUD boots only
 *   opts.carryLive  carry the outgoing bot's live settings (takeover rebind)
 *   opts.importer   (url) => Promise<module>   — tests; default import()
 *
 * The outgoing bot is retired only once the new bot module has loaded. If the
 * load fails, a bot on the SAME session (a HUD Restart) is left installed and
 * running; one strapped to another (dead) session is stopped and dropped — it
 * is never left orphaned behind a null window.__bot for START to stack a second
 * bot on.
 */
export function bootBot(targetHandle, p, opts = {}) {
  const win = opts.win || globalThis;
  const source = opts.source === "hud" ? "hud" : "url";
  const overrides = opts.overrides || null;
  const importer = typeof opts.importer === "function" ? opts.importer : (u) => import(u);
  win.__botBooting = true;
  const prevBot = win.__bot;
  const prevHandle = win.__botHandle;
  const prevSpec = win.__botBootSpec;
  if (!prevBot) win.__bot = null; // first boot: null while booting, as before
  // Remember how this bot was booted so a session-takeover reboot repeats it
  // (HUD settings ride along). A plain ?bot=1 boot records source "url" with
  // no overrides, i.e. nothing changes for it.
  win.__botBootSpec = { source, overrides };
  let prevRetired = false;
  const retirePrev = () => {
    if (!prevBot || prevRetired) return;
    prevRetired = true;
    try { if (typeof prevBot.stop === "function") prevBot.stop(); } catch (_) {}
    // The dead bot's host leaves the page-wide event-tap registry
    // (window.__rynthEventHosts) so `!bot` replies don't double after a
    // rebind. RynthWebHost.dispose() is final.
    try { prevBot?.host?.dispose?.(); } catch (_) {}
  };
  const scope = latchScopeOf(targetHandle);
  return importer(moduleUrl(win, "rynth/bot.js"))
    .then(async (m) => {
      const carry = opts.carryLive && prevBot ? captureLiveSettings(prevBot) : null;
      retirePrev();
      win.__bot = null; // the old bot is gone; a failure below leaves none installed
      const cfg = initialBotConfig(p);
      // operator ai-stop latch (task #11, 2026-07-19): a reconnect reboot
      // must NOT resurrect a director the operator stopped via
      // rynthAI.stop(). The latch (set in rynth/ai/operator_stop.js,
      // persisted in localStorage so it survives reloads/reconnects/browser
      // restarts) forces cfg.ai=false here, on top of ?botAi=off. Absent
      // latch = default behavior unchanged. Its own try/catch: a broken
      // latch module must never block the boot.
      // 2026-10-12: the module also carries the BOT-wide stop latch
      // (OperatorControl.stop persist) — applyOperatorStopToCfg then sets
      // cfg.startHeld (bot.js boots the kernel held, director deferred).
      // The AI line is unchanged; a held boot gets its own line.
      // The latches are per character (scope = player guid) so a STOP in one
      // bot tab can't hold another character's bot; an operator_stop.js
      // without scope support ignores the extra argument (origin-wide latch).
      try {
        const os = await importer(moduleUrl(win, "rynth/ai/operator_stop.js"));
        const aiSuppressed = os.applyOperatorStopToCfg(cfg, undefined, scope);
        // Compat: a LEGACY origin-wide bot latch (a pre-scope control wrote
        // the bare key) still boots this bot held while it exists —
        // OperatorControl.resume() clears it. New stops are always scoped.
        if (cfg.startHeld !== true && scope && typeof os.isBotStopLatched === "function" && os.isBotStopLatched(undefined)) {
          cfg.startHeld = true;
        }
        let latched = null;
        try { latched = typeof os.describeOperatorStop === "function" ? os.describeOperatorStop(undefined, scope) : null; } catch (_) { latched = null; }
        if (aiSuppressed || latched?.ai) {
          console.log("[bot] AI director suppressed: operator stop latch");
        }
        if (latched?.bot || cfg.startHeld === true) {
          console.log("[bot] booting HELD: operator stop latch (START in the RynthSuite HUD resumes)");
        }
      } catch (_) { /* latch unavailable = fall through to params */ }
      applyBotUrlParams(cfg, p);
      if (overrides) applyHudOverrides(cfg, overrides, { hasAiKey: hasAiKey(win) });
      if (carry) applyLiveCarryOver(cfg, carry);
      win.__bot = await m.createGrindBot(targetHandle, cfg);
      if (carry) applyLiveRuntimeFlags(win.__bot, carry);
      win.__botHandle = targetHandle;
      if (source === "url") {
        console.log(prevBot
          ? "[rynth] grind bot re-booted onto new session via ?bot=1 (takeover rebind)"
          : "[rynth] grind bot auto-booted via ?bot=1");
      } else {
        console.log(prevBot
          ? "[rynth] grind bot re-booted from the RynthSuite HUD"
          : "[rynth] grind bot booted from the RynthSuite HUD");
      }
      return win.__bot;
    })
    .catch((e) => {
      console.warn(source === "url" ? "[rynth] ?bot=1 auto-boot failed:" : "[rynth] HUD bot boot failed:", e);
      if (prevBot && !prevRetired) {
        if (prevHandle === targetHandle) {
          // Same session (a HUD Restart): the bot module failed to load, so
          // the running bot stays — and stays reachable.
          win.__bot = prevBot;
          win.__botBootSpec = prevSpec;
        } else {
          // Takeover: the outgoing bot is strapped to a dead session.
          retirePrev();
          win.__bot = null;
        }
      }
      return null;
    })
    .finally(() => { win.__botBooting = false; });
}

/**
 * app/client_events.js kind=7 entry point. Synchronous decision (so the
 * __botBooting guard is set in the same turn as the event, as before);
 * returns the boot promise or null when nothing needs booting.
 */
export function maybeAutoBootBot(targetHandle, p, opts = {}) {
  const win = opts.win || globalThis;
  if (!botNeedsBoot(win, p, targetHandle)) return null;
  const spec = win.__botBootSpec;
  // ?bot=1 pages that never used the HUD: source "url", no overrides — the
  // original call. A HUD (re)boot on this page carries its settings through
  // the takeover too.
  const viaHud = !!(spec && spec.source === "hud");
  return bootBot(targetHandle, p, {
    ...opts,
    source: viaHud ? "hud" : "url",
    overrides: viaHud ? spec.overrides : null,
    // A takeover rebind continues the outgoing bot's live settings.
    carryLive: true,
  });
}

/** The HUD's START when no bot exists yet: the page URL's bot params (so
 *  ?botAi=off / ?nav=off / ?botModel= still apply) + the HUD settings. */
export function bootBotFromHud(targetHandle, overrides, opts = {}) {
  const win = opts.win || globalThis;
  let search = "";
  try { search = win.location?.search ?? ""; } catch (_) { search = ""; }
  return bootBot(targetHandle, readBotUrlParams(search), { ...opts, source: "hud", overrides: overrides || null });
}

// ── StartMacroOnLogin (2026-10-19) ──────────────────────────────────────
// VTank's / RynthAi's "Start Macro On Login" (LegacyDashboardRenderer: the
// macro runs at login iff the option is set): the one piece of run state a
// profile carries — owner decision, see rynth/vt/settings/profile_store.js.
// Off (the default) changes nothing: a ?bot=1 page, a held boot and the HUD
// behave exactly as before.

const START_ON_LOGIN_KEY = "StartMacroOnLogin";

const tryRead = (fn, dflt = null) => {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch (_) {
    return dflt;
  }
};

/** The character's VTank session (its active profile): the page entry's
 *  (window.__rynthVt.session(<guid>), which knows a bot layer's), else the
 *  same registry session straight from rynth/vt/settings (location.href) —
 *  without installing the entry the HUD installs lazily (never under
 *  ?rynthHud=off). null when the layer is absent. */
async function loginProfileSession(win, scope, importer) {
  try {
    const vt = win.__rynthVt;
    if (vt && typeof vt.session === "function") return vt.session(String(scope)) || null;
    const set = await importer(moduleUrl(win, "rynth/vt/settings/index.js"));
    return set.peekVtSession(win, String(scope)) || set.getVtSession(win, String(scope), {}) || null;
  } catch (_) {
    return null; // no VTank layer on this page: nothing asks
  }
}

/** The operator control of a bot: bot.control, else operator_stop.js's. */
function controlOf(bot, os) {
  const c = tryRead(() => bot.control);
  if (c && typeof c.resume === "function") return c;
  return os && typeof os.getOperatorControl === "function" ? tryRead(() => os.getOperatorControl(bot)) : null;
}
const isHeld = (c) => !!tryRead(() => (typeof c.isStopped === "function" ? c.isStopped() : c.state()?.stopped), false);

/** START the way the RynthSuite HUD's does (rynth/hud_bridge.js start()). →
 *  "hud" | "resumed" | "running" | "booted" | null; throws on a refusal. */
async function startMacro(win, targetHandle, scope, session, importer) {
  const hud = tryRead(() => win.__rynthHud.bridge);
  if (hud && typeof hud.start === "function") {
    const r = await hud.start(); // boot-or-resume with the HUD settings + persona; clears the stored stop first
    if (r && r.ok === false) throw new Error(r.error || "START refused");
    return "hud";
  }
  // No HUD on this page: START's steps here. The character's stored stop goes
  // first (an explicit START), so a boot does not come up held.
  let os = null;
  try {
    os = await importer(moduleUrl(win, "rynth/ai/operator_stop.js"));
  } catch (_) {
    os = null;
  }
  try { os?.clearBotStop?.(undefined, scope); } catch (_) { /* latch unavailable */ }
  const bot = win.__bot;
  if (bot && win.__botHandle === targetHandle) {
    const c = controlOf(bot, os);
    if (c && isHeld(c)) {
      c.resume();
      return "resumed";
    }
    return "running";
  }
  if (win.__botBooting) return null; // another boot owns the page right now
  // A USER profile boots with its legacy values (rs_entry.js hudProvider:
  // hudBootOverrides()); Default boots with the page URL's params only.
  const overrides = tryRead(() => session.profiles.isUserProfileActive() === true, false)
    ? tryRead(() => session.options.hudBootOverrides())
    : null;
  const nb = await bootBotFromHud(targetHandle, overrides, { win, importer });
  if (!nb) throw new Error("bot boot failed — see the console");
  const c = controlOf(nb, os);
  if (c && isHeld(c)) c.resume(); // a latch written in between: START means go
  return "booted";
}

/**
 * app/client_events.js kind=7 entry, right after maybeAutoBootBot: when the
 * logged-in character's active VTank profile has StartMacroOnLogin on, START
 * the macro as the RynthSuite HUD's START does — the HUD bridge's start() when
 * the HUD is mounted (boot-or-resume with its settings and persona), else the
 * same steps here (clear the stored stop; resume a held bot through
 * bot.control, or bootBotFromHud with the profile's hudBootOverrides()).
 *
 * Once per login: a death respawn re-enters with the same session handle (the
 * takeover rule's identity), remembered in window.__botLoginStartHandle.
 * Never on a ?bot=1 page (the URL boots it, under the stored stop) and never
 * with ?botVt=off (the bot boots without the VTank layer: its profiles drive
 * nothing). The profile (loginProfileSession) is read after `opts.after`
 * (the takeover rebind maybeAutoBootBot started) settles, so the HUD's START
 * finds the rebound bot and resumes it. Synchronous decision, then a promise of
 * "hud" | "resumed" | "running" | "booted" | null; never rejects.
 *   opts.after     a promise to wait for first (maybeAutoBootBot's)
 *   opts.importer  (url) => Promise<module>   — tests; default import()
 */
export function maybeStartMacroOnLogin(targetHandle, p, opts = {}) {
  const win = opts.win || globalThis;
  if (!targetHandle || (p && (p.bot === "1" || p.botVt === "off"))) return null;
  if (win.__botLoginStartHandle === targetHandle) return null;
  win.__botLoginStartHandle = targetHandle;
  const importer = typeof opts.importer === "function" ? opts.importer : (u) => import(u);
  return Promise.resolve(opts.after)
    .catch(() => null)
    .then(async () => {
      const scope = latchScopeOf(targetHandle);
      if (!scope) {
        // The character is not readable yet: its next EnteredWorld may try again.
        if (win.__botLoginStartHandle === targetHandle) win.__botLoginStartHandle = null;
        return null;
      }
      const session = await loginProfileSession(win, scope, importer);
      if (tryRead(() => session.options.getValue(START_ON_LOGIN_KEY), false) !== true) return null;
      const how = await startMacro(win, targetHandle, scope, session, importer);
      if (how && how !== "running") {
        console.log(`[rynth] StartMacroOnLogin: macro started (${how})`);
        try { win.__appendChatLine?.("[RynthSuite] Start on login: the macro is running (profile option StartMacroOnLogin).", 0); } catch (_) { /* no chat */ }
      }
      return how;
    })
    .catch((e) => {
      console.warn("[rynth] StartMacroOnLogin failed:", e);
      return null;
    });
}

// = rynth/ai/llm_client.js KEY_STORAGE (inlined: no ai/ import on the boot path).
const AI_KEY_STORAGE = "holtburger_ai_key_v1";
function hasAiKey(win) {
  try { return !!win.localStorage?.getItem(AI_KEY_STORAGE); } catch (_) { return false; }
}
