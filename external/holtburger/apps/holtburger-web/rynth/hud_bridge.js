// rynth/hud_bridge.js — the ONE adapter between the RynthSuite HUD
// (plugins/rynth-hud.js) and the bot (2026-10-12).
//
// Everything the HUD knows about the bot's API lives in this file, so a
// contract change in rynth/ lands in one place:
//
//   buildViewModel(input)   PURE: bot + OperatorControl.state() + session
//                           handle → the plain object the HUD renders. No
//                           wasm walks beyond the cheap host getters the
//                           kernel already polls; never throws.
//   createHudBridge(env)    snapshot() + the commands the HUD's controls
//                           drive (start/stop, subsystem toggles, AI, force
//                           rebuff, monster priorities, loot floor, vitals
//                           thresholds, buff list, goto/egress/routes) and
//                           the persisted HUD bot settings.
//
// Stop/resume authority: rynth/ai/operator_stop.js getOperatorControl(bot)
// (the single stop/resume/state control, bot.control). When that module is
// older than the control (no getOperatorControl), stop/resume fall back to
// the `!bot pause` / `!bot resume` sequence in control_channel.js.
//
// Module URLs resolve against location.href ("rynth/…"), like rynth/boot.js —
// not import.meta.url (see boot.js header). Tests inject `importer` +
// `moduleUrl` and a fake `win`. The one static import (portal_gate.js) has
// no imports of its own.

import { portalSpaceActive } from "./portal_gate.js";

export const HUD_SETTINGS_KEY = "rynth.hud.settings.v1";
export const HUD_SUBSYSTEMS = Object.freeze(["combat", "buff", "nav", "loot", "ai"]);

// playerStats().vitals is a stride-4 [type, current, base, max] array; the
// type ids are rynth/vitals.js's VITAL_HEALTH/STAMINA/MANA.
export const VITAL_TYPE = Object.freeze({ hp: 1, st: 3, mn: 5 });

// vitals.js thresholds the HUD exposes (percent). Defaults mirror
// rynth/vitals.js DEFAULTS and are only used to label/seed the inputs.
export const VITALS_FIELDS = Object.freeze([
  { key: "healAtCombat", label: "Heal at (combat)", dflt: 60 },
  { key: "getManaAtCombat", label: "Mana at (combat)", dflt: 40 },
  { key: "restamAtCombat", label: "Stamina at (combat)", dflt: 30 },
  { key: "emergencyHp", label: "Emergency HP", dflt: 30 },
  { key: "topOffHp", label: "Top off HP (idle)", dflt: 95 },
  { key: "topOffStam", label: "Top off stamina", dflt: 95 },
  { key: "topOffMana", label: "Top off mana", dflt: 95 },
]);

const AI_KEY_STORAGE = "holtburger_ai_key_v1"; // = rynth/ai/llm_client.js KEY_STORAGE
const LOG_MAX = 80;

function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** The logged-in character's guid — the operator-stop latches are scoped per
 *  character (rynth/ai/operator_stop.js). undefined when unknown. */
function latchScopeOf(handle) {
  const g = Number(safe(() => handle?.playerGuid?.(), 0)) >>> 0;
  return g || undefined;
}

/** Player vitals straight off the session handle (works with no bot).
 *  playerStats() hands back a fresh wasm box per call — copy, then free it
 *  (the HUD reads this at 4 Hz; leaving the box to the FinalizationRegistry
 *  grows the wasm heap on long sessions). */
export function readPlayerVitals(handle) {
  const out = { hp: null, st: null, mn: null };
  const v = safe(() => {
    const box = handle?.playerStats?.();
    try {
      return Array.from(box?.vitals || []).map(Number);
    } finally {
      try { if (box && typeof box.free === "function") box.free(); } catch { /* already freed */ }
    }
  }, []);
  for (let i = 0; i + 3 < v.length; i += 4) {
    const cur = v[i + 1];
    const max = v[i + 3];
    if (!(max > 0)) continue;
    const slot = v[i] === VITAL_TYPE.hp ? "hp" : v[i] === VITAL_TYPE.st ? "st" : v[i] === VITAL_TYPE.mn ? "mn" : null;
    if (slot) out[slot] = { cur: Math.max(0, cur), max };
  }
  return out;
}

function objectName(bot, handle, guid) {
  return (
    safe(() => bot?.host?.TryGetObjectName?.(guid)) ??
    safe(() => handle?.objectName?.(guid)) ??
    null
  );
}
function healthFraction(bot, handle, guid) {
  let f = safe(() => bot?.host?.TryGetTargetHealthFraction?.(guid));
  if (f == null) f = safe(() => handle?.objectHealthFraction?.(guid));
  return typeof f === "number" && f >= 0 && f <= 1 ? f : null;
}

function fmtTarget(name, hp) {
  return hp == null ? name : `${name} (${Math.round(hp * 100)}%)`;
}

/** A goto / route failure reason as the HUD shows it. global_router.js
 *  aborts a sidecar request after config.nav.requestTimeoutMs (20 s) with
 *  "sidecar timed out after …ms at <endpoint>". */
export function describeNavError(r) {
  const raw = r && typeof r === "object" ? (r.error || r.state || "") : String(r ?? "");
  const s = String(raw || "failed");
  if (/sidecar timed out/i.test(s)) return "nav sidecar timed out";
  if (/nav not configured|globalRouter/i.test(s)) return "nav sidecar not configured";
  return s;
}

// buff_loop.js / vitals.js `status.blocked` reasons (and the refusal
// classes behind them, buff_loop.js castRefusalClass) in player words.
const BLOCK_TEXT = Object.freeze({
  "no-caster": "no wand, orb or staff wielded",
  components: "missing spell components",
  mana: "not enough mana",
  place: "can't cast here",
  fizzle: "spells fizzling",
  "unknown-spell": "spell not in the spellbook",
  transient: "busy",
});
export function describeBlock(reason) {
  if (!reason) return null;
  return BLOCK_TEXT[reason] ?? String(reason);
}

/**
 * The HUD's view of the world. PURE apart from the cheap getters it calls on
 * `bot` / `handle`. Input:
 *   { bot, ctl (OperatorControl.state() or null), handle, booting, now,
 *     selectedGuid, hasAiKey, spellName(id) }
 */
export function buildViewModel(input = {}) {
  const { bot = null, ctl = null, handle = null, booting = false, selectedGuid = 0, hasAiKey = false } = input;
  const now = typeof input.now === "number" ? input.now : Date.now();
  const spellName = typeof input.spellName === "function" ? input.spellName : () => null;
  const kernel = safe(() => bot?.kernel ?? null);
  const combat = safe(() => bot?.combat ?? null);
  const loot = safe(() => bot?.loot ?? null);
  const buff = safe(() => bot?.buff ?? null);
  const vitalsLoop = safe(() => bot?.vitals ?? null);
  const director = safe(() => bot?.ai?.director ?? null);
  // ONE kernel.status per refresh: OperatorControl.state() (ctl) already
  // computed it, and its kernel block carries action/kills/looted/combat —
  // so only a control-less caller reads kernel.status here. buff.status and
  // vitals.status (each a fresh computation; vitals copies wasm stats) are
  // read once, and director.status only when the control did not report it.
  const kctl = ctl && ctl.kernel ? ctl.kernel : null;
  const ks = kctl
    ? { action: kctl.action, kills: kctl.kills, looted: kctl.looted, combat: kctl.combat ?? null }
    : safe(() => kernel?.status ?? null);
  // The control's kernel block also carries THE SAME kernel.status read's
  // buffs/vitals (undefined when an older control/kernel does not publish
  // them) — reuse those instead of recomputing (vitals.status copies wasm
  // stats; review-2 #8). Control-less callers read the loops directly.
  const bst = kctl && kctl.buffs !== undefined ? kctl.buffs : safe(() => buff?.status ?? null);
  const vst = kctl && kctl.vitals !== undefined ? kctl.vitals : safe(() => vitalsLoop?.status ?? null);
  const ready = !!safe(() => handle?.isPlayerReady?.() === true, false);

  // ── run state ──────────────────────────────────────────────────────────
  const held = ctl ? !!ctl.kernel?.held : !!safe(() => kernel?.operatorHeld === true, false);
  const stopped = ctl ? !!ctl.stopped : held;
  let phase;
  if (bot) phase = stopped ? "stopped" : "running";
  else if (booting) phase = "booting";
  else if (!handle) phase = "no-session";
  else phase = "not-started";
  const kernelRunning = ctl?.kernel ? !!ctl.kernel.running : !!safe(() => kernel?.running === true, false);

  // ── mission / travel ───────────────────────────────────────────────────
  const m = safe(() => bot?.mission ?? null);
  const mission = m
    ? { kind: String(m.kind ?? "mission"), label: String(m.label ?? m.kind ?? "mission"), sinceMs: num(m.startedAt) != null ? now - m.startedAt : null }
    : null;
  const rs = safe(() => bot?.router?.status ?? null);
  const routeState = rs?.state ?? ctl?.movement?.router ?? null;
  const walking = routeState === "WALK" || routeState === "PORTAL";
  // router.js holds every walk while the client shows portal space
  // (rynth/portal_gate.js); `portalHold` is that hold.
  const portalHold = !!rs?.portalHold;
  const inPortalSpace =
    typeof input.portalSpace === "boolean" ? input.portalSpace : !!safe(() => portalSpaceActive(bot?.host ?? null), false);

  // ── target (bot lock first, then the player's own selection) ──────────
  const locked = (num(ks?.combat?.locked) ?? num(safe(() => combat?.locked)) ?? 0) >>> 0;
  let target = null;
  if (locked) {
    const name = objectName(bot, handle, locked) || "Unknown";
    target = { guid: locked, name, hp: healthFraction(bot, handle, locked), source: "bot" };
  } else if (selectedGuid >>> 0) {
    const g = selectedGuid >>> 0;
    const name = objectName(bot, handle, g);
    if (name) target = { guid: g, name, hp: healthFraction(bot, handle, g), source: "selection" };
  }

  // ── state / activity lines (RynthAi "Meta State" / "Bot Activity") ────
  let stateLine;
  let activityLine = "Idle";
  if (phase === "no-session") stateLine = "Not logged in";
  else if (phase === "not-started") stateLine = ready ? "Not started" : "Waiting for world";
  else if (phase === "booting") stateLine = "Starting…";
  else if (phase === "stopped") stateLine = ctl?.reason ? `Stopped — ${ctl.reason}` : "Stopped";
  else if (portalHold) stateLine = "Holding: portal space";
  else if (inPortalSpace) stateLine = "Portal space";
  else if (mission || walking) stateLine = "Travelling";
  else if (!kernelRunning) stateLine = "Kernel off";
  else stateLine = String(ks?.action ?? kernel?.action ?? "Idle");

  if (bot && phase !== "stopped") {
    const action = String(ks?.action ?? "");
    if (mission) {
      const leg = rs && num(rs.leg) != null && num(rs.legs) ? ` · leg ${rs.leg + 1}/${rs.legs}` : "";
      activityLine = `${mission.kind}: ${mission.label}${leg}`;
    } else if (target && target.source === "bot") {
      activityLine = `Fighting ${fmtTarget(target.name, target.hp)}`;
    } else if (action === "Loot" || (loot && loot.state && loot.state !== "SCAN")) {
      activityLine = `Looting${loot?.state && loot.state !== "SCAN" ? ` (${String(loot.state).toLowerCase()})` : ""}`;
    } else if (action === "Buffing" || (buff && buff.pending)) {
      const id = num(buff?.pending?.spellId) ?? num(bst?.pending) ?? 0;
      activityLine = id ? `Casting ${spellName(id) || `spell ${id}`}` : "Buffing";
    } else if (action === "Vitals") {
      const r = safe(() => vitalsLoop?.lastReason ?? vst?.lastReason ?? null);
      activityLine = r ? `Recovering — ${r}` : "Recovering";
    } else if (action === "Unwedge") {
      activityLine = "Freeing a stuck character";
    } else if (walking) {
      activityLine = `Walking (${routeState.toLowerCase()})`;
    }
  } else if (phase === "stopped") {
    activityLine = "Hands off — you have control";
  }

  // ── subsystem toggles ──────────────────────────────────────────────────
  const sub = (loop, extra = {}) => {
    if (!loop) return { available: false, on: false, ...extra };
    return { available: true, on: safe(() => loop.enabled !== false, true), ...extra };
  };
  const aiState = ctl?.ai ?? null;
  const aiOn = aiState ? !!aiState.enabled : !!safe(() => director?.enabled === true, false);
  const toggles = {
    combat: sub(combat, { hint: combat ? null : "No combat loop on this bot" }),
    // bot.setBuffs() (bot.js) builds a buff loop on demand, so with no loop
    // the toggle is still live: ON maintains the saved list or "auto".
    buff: buff
      ? { available: true, on: safe(() => buff.enabled !== false && (num(bst?.desired) ?? 1) > 0, true), hint: null }
      : typeof safe(() => bot?.setBuffs) === "function"
        ? { available: true, on: false, hint: "No buff list yet — click to maintain your self-buffs (Settings picks them; default auto)" }
        : { available: false, on: false, hint: "No buffs configured — pick self-buffs in Settings, then Restart" },
    loot: sub(loot, { hint: loot ? null : "Looting disabled at boot (config.loot = false)" }),
    nav: {
      available: !!bot,
      on: !!(mission || walking),
      hint: bot ? null : "Start the bot first",
    },
    ai: {
      available: !!director,
      on: aiOn,
      deferred: !!aiState?.deferredAutoStart,
      hint: director ? null : hasAiKey ? "Key saved — restart the bot to activate the director" : "Set an OpenRouter key in the AI tab",
    },
  };

  // ── force rebuff (only when buff_loop exposes it) ─────────────────────
  const forceRebuff = {
    available: !!(buff && typeof buff.forceRebuff === "function"),
    active: !!safe(() => (typeof buff?.forceRebuffing === "boolean" ? buff.forceRebuffing : buff?._forceRebuffing === true), false),
    cancellable: !!(buff && typeof buff.cancelForceRebuff === "function"),
  };

  // ── stats ──────────────────────────────────────────────────────────────
  const startedAt = num(safe(() => bot?.startedAt));
  const uptimeMs = startedAt != null ? Math.max(0, now - startedAt) : null;
  const kills = num(ks?.kills) ?? num(safe(() => combat?.kills)) ?? 0;
  const looted = num(ks?.looted) ?? num(safe(() => loot?.lootedCount)) ?? 0;
  const hours = uptimeMs != null ? uptimeMs / 3_600_000 : 0;
  const bs = bst;
  const stats = {
    kills,
    looted,
    // loot_loop.js: items the server refused (pack full / burden) — cheap counter.
    lootRefused: num(safe(() => loot?.refusedPickups)) ?? 0,
    killsPerHour: uptimeMs != null && uptimeMs >= 60_000 ? kills / hours : null,
    uptimeMs,
    buffs: bs ? { active: num(bs.active) ?? 0, desired: num(bs.desired) ?? 0, ready: !!bs.ready } : null,
  };

  // ── AI detail ──────────────────────────────────────────────────────────
  const ds = aiState ? null : safe(() => director?.status ?? null);
  const nextAt = aiState?.nextCheckAt ?? ds?.nextCheckAt ?? null;
  const ai = {
    present: !!director,
    enabled: aiOn,
    busy: !!(aiState?.busy ?? ds?.running),
    nextInS: num(nextAt) != null ? Math.max(0, Math.round((nextAt - now) / 1000)) : null,
    calls: num(aiState?.calls ?? ds?.calls),
    errors: num(aiState?.errors ?? ds?.consecutiveErrors),
    lastSummary: aiState?.lastSummary ?? ds?.lastSummary ?? null,
    deferred: !!aiState?.deferredAutoStart,
    hasKey: !!hasAiKey,
  };

  // ── held casts (buff_loop / vitals status.blocked + lastRefusal) ──────
  const refusal = (r) =>
    r && typeof r === "object"
      ? { cls: r.cls ?? null, spellId: num(r.spellId), agoS: num(r.at) != null ? Math.max(0, Math.round((now - r.at) / 1000)) : null }
      : null;
  const castHold = {
    combat: ks?.combat?.incapable ? String(ks.combat.incapable) : null,
    buffs: bst?.blocked ? describeBlock(bst.blocked) : null,
    vitals: vst?.blocked ? describeBlock(vst.blocked) : null,
    buffRefusal: refusal(bst?.lastRefusal),
    vitalsRefusal: refusal(vst?.lastRefusal),
  };
  const sp = safe(() => vst?.spells ?? vitalsLoop?.spells ?? null);
  const recoverySpells = sp && typeof sp === "object"
    ? Object.fromEntries(Object.entries(sp).filter(([, v]) => num(v) != null && v > 0))
    : null;

  // ── editable settings, read back from the live loops ──────────────────
  const priorities = Object.entries(safe(() => combat?.priorities ?? {}, {}) || {})
    .filter(([k, v]) => k && Number.isFinite(Number(v)))
    .map(([k, v]) => [k, Number(v)])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const lootMin = num(safe(() => loot?.minValue));
  const vcfg = safe(() => vitalsLoop?.cfg ?? null);
  const vitalsCfg = vcfg ? Object.fromEntries(VITALS_FIELDS.map((f) => [f.key, num(vcfg[f.key])])) : null;

  return {
    phase,
    present: !!bot,
    running: phase === "running",
    stopped: phase === "stopped",
    ready,
    canStart: phase === "stopped" || (phase === "not-started" && ready),
    reason: ctl?.reason ?? null,
    persisted: !!ctl?.latched?.bot,
    kernelRunning,
    stateLine,
    activityLine,
    toggles,
    forceRebuff,
    target,
    vitals: readPlayerVitals(handle),
    stats,
    mission,
    routeState,
    portalHold,
    inPortalSpace,
    ai,
    castHold,
    recoverySpells,
    priorities,
    lootMin,
    vitalsCfg,
    gotoAvailable: !!safe(() => bot?.globalRouter),
    combatMode: num(ks?.combat?.mode),
    combatIncapable: ks?.combat?.incapable ?? null,
  };
}

// ── persisted HUD bot settings (applied live + used by HUD-started boots) ─
export function loadHudSettings(storage) {
  try {
    const raw = storage?.getItem?.(HUD_SETTINGS_KEY);
    const o = raw ? JSON.parse(raw) : null;
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}
export function saveHudSettings(storage, s) {
  try { storage?.setItem?.(HUD_SETTINGS_KEY, JSON.stringify(s || {})); } catch { /* blocked storage */ }
}

/** Ring log of transitions the bridge observed between snapshots. */
class RingLog {
  constructor(max) { this.max = max; this.lines = []; }
  push(t, text) {
    this.lines.push({ t, text: String(text) });
    if (this.lines.length > this.max) this.lines.splice(0, this.lines.length - this.max);
  }
}

/**
 * The bridge. env: { win, importer(url) → Promise<module>, moduleUrl(rel) →
 * url, now() → ms, storage }. Every command resolves to { ok, error?, … } and
 * never throws.
 */
export function createHudBridge(env = {}) {
  const win = env.win || globalThis;
  const now = typeof env.now === "function" ? env.now : () => Date.now();
  const importer = typeof env.importer === "function" ? env.importer : (u) => import(u);
  const moduleUrl =
    typeof env.moduleUrl === "function" ? env.moduleUrl : (rel) => new URL(rel, win.location.href).href;
  const storage = env.storage ?? safe(() => win.localStorage ?? null);
  const log = new RingLog(LOG_MAX);
  let settings = loadHudSettings(storage);
  let prev = null;
  let opMod = null;
  let opModPromise = null;
  let lastNav = null; // { text, ok, at } — the last goto/route/egress outcome
  let catalog = null; // Map id -> {name, level, school, untargeted, duration}
  let catalogPromise = null;
  // Fallback stop memory (only used when no OperatorControl is available).
  let fbDirectorWasOn = false;
  // Buff-list changes are awaited straight through bot.setBuffs(): bot.js
  // itself runs them one at a time in call order (two quick clicks can't
  // build two loops), so the HUD keeps no second queue (review-2 #13).
  // Live spell names for the Activity line ("Casting <name>"): the session
  // handle's getSpellRecord (wasm, Map-shaped record) first, cached per id;
  // the lazily loaded catalog (Settings tab) second.
  const spellNameCache = new Map(); // id -> name | null (capped)
  const SPELL_NAME_CACHE_MAX = 256;

  const getBot = () => safe(() => win.__bot ?? null);
  const getHandle = () => safe(() => win.__sessionHandle ?? null);
  const loadOp = () => {
    if (!opModPromise) {
      opModPromise = Promise.resolve()
        .then(() => importer(moduleUrl("rynth/ai/operator_stop.js")))
        .then((m) => (opMod = m || null))
        .catch(() => (opMod = null));
    }
    return opModPromise;
  };
  const getControl = (b = getBot()) => {
    if (!b) return null;
    const cur = safe(() => b.control ?? null);
    if (cur && typeof cur.state === "function" && typeof cur.stop === "function" && typeof cur.resume === "function") return cur;
    if (opMod && typeof opMod.getOperatorControl === "function") return safe(() => opMod.getOperatorControl(b));
    return null;
  };
  const selectedGuid = () =>
    num(safe(() => win.liveScene3d?.entityManager?.getSelectedTarget?.())) ??
    num(safe(() => win.liveScene3d?.entityManager?.selectedTarget)) ??
    0;
  const hasAiKey = () => !!safe(() => storage?.getItem?.(AI_KEY_STORAGE));
  const recordName = (rec) => {
    if (!rec) return null;
    try {
      const n = typeof rec.get === "function" ? rec.get("name") : rec.name;
      return typeof n === "string" && n ? n : null;
    } catch {
      return null;
    }
  };
  const spellName = (id) => {
    const key = id >>> 0;
    if (!key) return null;
    if (spellNameCache.has(key)) {
      const n = spellNameCache.get(key);
      if (n) return n;
    } else {
      const h = getHandle();
      if (h && typeof h.getSpellRecord === "function") {
        const n = recordName(safe(() => h.getSpellRecord(key)));
        if (spellNameCache.size >= SPELL_NAME_CACHE_MAX) spellNameCache.delete(spellNameCache.keys().next().value);
        spellNameCache.set(key, n); // a miss is cached too (no handle = not cached)
        if (n) return n;
      }
    }
    return (catalog && catalog.get(key)?.name) || null;
  };
  const persist = () => saveHudSettings(storage, settings);
  const note = (text) => log.push(now(), text);
  const navResult = (text, okFlag) => {
    lastNav = { text: String(text), ok: !!okFlag, at: now() };
    note(text);
  };
  const ok = (extra = {}) => ({ ok: true, ...extra });
  const fail = (error, extra = {}) => ({ ok: false, error: String(error), ...extra });

  function observe(vm) {
    const p = prev;
    prev = vm;
    if (!p) return;
    if (p.phase !== vm.phase) {
      const words = { running: "RUNNING", stopped: "STOPPED", booting: "starting…", "not-started": "not started", "no-session": "logged out" };
      note(`bot ${words[vm.phase] ?? vm.phase}${vm.phase === "stopped" && vm.reason ? ` (${vm.reason})` : ""}`);
    }
    if (vm.present && p.present) {
      if (vm.stateLine !== p.stateLine && vm.phase === "running" && p.phase === "running") note(`state: ${vm.stateLine}`);
      if (vm.stats.kills > p.stats.kills) {
        const who = p.target && p.target.source === "bot" ? ` — ${p.target.name}` : "";
        note(`kill #${vm.stats.kills}${who}`);
      }
      if (vm.stats.looted > p.stats.looted) note(`looted (${vm.stats.looted} total)`);
      if (!p.mission && vm.mission) note(`travel started: ${vm.mission.kind} ${vm.mission.label}`);
      if (p.mission && !vm.mission) {
        const r = safe(() => getBot()?.lastMission?.result ?? null);
        note(`travel ended: ${p.mission.label}${r ? (r.ok ? " — arrived" : ` — ${r.state ?? "failed"}`) : ""}`);
      }
      if (vm.ai.lastSummary && vm.ai.lastSummary !== p.ai.lastSummary) note(`AI: ${String(vm.ai.lastSummary).slice(0, 140)}`);
      for (const name of HUD_SUBSYSTEMS) {
        if (vm.toggles[name].available && p.toggles[name].available && vm.toggles[name].on !== p.toggles[name].on) {
          note(`${name} ${vm.toggles[name].on ? "on" : "off"}`);
        }
      }
    }
  }

  function snapshot() {
    loadOp(); // fire-and-forget: the control appears on the next snapshot
    const bot = getBot();
    const control = getControl(bot);
    const ctl = control ? safe(() => control.state()) : null;
    const vm = buildViewModel({
      bot,
      ctl,
      handle: getHandle(),
      booting: !!safe(() => win.__botBooting === true, false),
      now: now(),
      selectedGuid: selectedGuid(),
      hasAiKey: hasAiKey(),
      spellName,
    });
    observe(vm);
    vm.hasControl = !!control;
    vm.log = log.lines.slice();
    vm.journal = safe(() => {
      const j = bot?.ai?.journal;
      return typeof j?.tail === "function" ? Array.from(j.tail(6) || []) : [];
    }, []);
    vm.settings = { ...settings };
    vm.lastNav = lastNav ? { ...lastNav } : null;
    return vm;
  }

  // ── start / stop ───────────────────────────────────────────────────────
  function fallbackStop(b) {
    const k = b.kernel;
    const d = safe(() => b.ai?.director ?? null);
    fbDirectorWasOn = !!(d && d.enabled);
    try { k?.holdForOperator?.(); } catch { /* ignore */ }
    try { b.router?.cancel?.(); } catch { /* ignore */ }
    try { b.host?.StopStick?.(); } catch { /* ignore */ }
    try { b.host?.StopCompletely?.(); } catch { /* ignore */ }
    if (fbDirectorWasOn) try { d.stop(); } catch { /* ignore */ }
  }
  function fallbackResume(b) {
    const k = b.kernel;
    try { k?.releaseOperatorHold?.(); } catch { /* ignore */ }
    try { k?.start?.(); } catch { /* ignore */ }
    const d = safe(() => b.ai?.director ?? null);
    if (d && fbDirectorWasOn) try { d.start(); } catch { /* ignore */ }
    fbDirectorWasOn = false;
  }

  async function start() {
    const b = getBot();
    await loadOp();
    if (b) {
      const c = getControl(b);
      if (c) {
        safe(() => c.resume());
      } else {
        fallbackResume(b);
      }
      note("START (resume)");
      return ok({ resumed: true });
    }
    if (safe(() => win.__botBooting === true, false)) return fail("the bot is already starting");
    const h = getHandle();
    if (!h) return fail("not logged in");
    if (!safe(() => h.isPlayerReady?.() === true, false)) return fail("not in the world yet");
    let boot;
    try {
      boot = await importer(moduleUrl("rynth/boot.js"));
    } catch (e) {
      return fail(`boot module failed to load: ${e?.message ?? e}`);
    }
    note("START (booting the bot)");
    // An explicit START is the operator saying "run": drop THIS character's
    // persisted bot stop BEFORE the boot, so the new bot is not booted held
    // (its director autoStart would otherwise wait for a resume()). Another
    // character's stop (another tab) is left alone.
    safe(() => opMod?.clearBotStop?.(storage ?? undefined, latchScopeOf(h)));
    const nb = await boot.bootBotFromHud(h, botOverrides(), { win });
    if (!nb) return fail("bot boot failed — see the console");
    // Belt and braces: a bot that still came up held (a latch written in
    // between, an older operator_stop.js) is resumed — START means go.
    const c = getControl(nb);
    if (c && safe(() => c.isStopped?.() === true, false)) safe(() => c.resume());
    applyPersonaRuntime(nb);
    return ok({ booted: true });
  }

  async function stop() {
    const b = getBot();
    if (!b) return fail("the bot is not running");
    await loadOp();
    const c = getControl(b);
    if (c) safe(() => c.stop({ persist: true, reason: "HUD" }));
    else fallbackStop(b);
    note("STOP");
    return ok();
  }

  async function toggleRun() {
    const b = getBot();
    if (!b) return start();
    await loadOp();
    const c = getControl(b);
    const stopped = c ? !!safe(() => c.isStopped?.() ?? c.state()?.stopped, false) : !!safe(() => b.kernel?.operatorHeld, false);
    return stopped ? start() : stop();
  }

  // ── subsystems ─────────────────────────────────────────────────────────
  async function setSubsystem(name, on) {
    const b = getBot();
    if (!b) return fail("start the bot first");
    if (name === "ai") return setAi(on);
    if (name === "nav") return on ? followRoute(settings.route ?? null) : cancelTravel();
    if (name === "buff" && on) {
      // No loop yet, or an empty list: bot.setBuffs() builds/fills it from
      // the saved HUD list, else "auto" (the known self-buffs).
      const want = Array.isArray(settings.buffs) && settings.buffs.length ? settings.buffs.slice() : "auto";
      const empty = !b.buff || (num(safe(() => b.buff.status?.desired)) ?? 1) === 0;
      if (empty) {
        if (typeof b.setBuffs !== "function") return fail("no buff loop on this bot — pick buffs in Settings, then Restart");
        let list;
        try {
          list = await b.setBuffs(want); // bot.js serializes concurrent calls
        } catch (e) {
          return fail(`buffs: ${e?.message ?? e}`);
        }
        // Nothing castable resolved (no known self-buff, or none of the saved
        // ids): say so and leave the toggle OFF (review-2 #11).
        if (Array.isArray(list) && list.length === 0) {
          return fail("no castable self-buffs known for this character");
        }
        note(`buffs on (${want === "auto" ? "auto" : `${want.length} spell(s)`})`);
      }
      if (!b.buff) return ok({ live: true });
    }
    if (name === "buff" && !on && !b.buff) return ok();
    if (!["combat", "loot", "buff"].includes(name)) return fail(`unknown subsystem ${name}`);
    await loadOp();
    const c = getControl(b);
    if (c && typeof c.setEnabled === "function") {
      const r = safe(() => c.setEnabled(name, !!on), null);
      if (r && r.ok === false) return fail(r.error || "refused");
    } else {
      const loop = b[name];
      if (!loop) return fail(`no ${name} loop on this bot`);
      try { loop.enabled = !!on; } catch (e) { return fail(e?.message ?? e); }
    }
    note(`${name} ${on ? "on" : "off"} (HUD)`);
    return ok();
  }

  async function setAi(on) {
    const b = getBot();
    if (!b) return fail("start the bot first");
    await loadOp();
    const c = getControl(b);
    if (c && typeof c.setAi === "function") {
      const r = safe(() => c.setAi(!!on), null);
      if (!r) return fail("AI toggle failed");
      if (r.ok === false) return fail(r.error || "AI toggle refused");
      return ok({ deferred: !!r.deferred });
    }
    const api = safe(() => win.rynthAI ?? null);
    if (!b.ai?.director || !api) return fail("no AI director on this bot");
    try { on ? api.start() : api.stop(); } catch (e) { return fail(e?.message ?? e); }
    return ok();
  }

  function forceRebuff() {
    const buff = safe(() => getBot()?.buff ?? null);
    if (!buff || typeof buff.forceRebuff !== "function") return fail("force rebuff is not available on this bot");
    try { buff.forceRebuff(); } catch (e) { return fail(e?.message ?? e); }
    note("force rebuff");
    return ok();
  }
  function cancelForceRebuff() {
    const buff = safe(() => getBot()?.buff ?? null);
    if (!buff || typeof buff.cancelForceRebuff !== "function") return fail("cancel is not available on this bot");
    try { buff.cancelForceRebuff(); } catch (e) { return fail(e?.message ?? e); }
    note("force rebuff cancelled");
    return ok();
  }

  // ── monster priorities / loot floor / vitals thresholds / buff list ────
  function setPriority(name, prio) {
    const key = String(name ?? "").trim().toLowerCase();
    const n = Number(prio);
    if (!key) return fail("monster name is empty");
    if (!Number.isFinite(n)) return fail("priority must be a number");
    const v = Math.max(0, Math.min(20, Math.round(n)));
    settings.priorities = { ...(settings.priorities || {}), [key]: v };
    persist();
    const combat = safe(() => getBot()?.combat ?? null);
    if (combat) safe(() => { combat.priorities = { ...(combat.priorities || {}), [key]: v }; });
    return ok({ live: !!combat });
  }
  function removePriority(name) {
    const key = String(name ?? "").trim().toLowerCase();
    if (settings.priorities) {
      const { [key]: _drop, ...rest } = settings.priorities;
      settings.priorities = rest;
      persist();
    }
    const combat = safe(() => getBot()?.combat ?? null);
    if (combat && combat.priorities && key in combat.priorities) {
      safe(() => {
        const { [key]: _gone, ...rest } = combat.priorities;
        combat.priorities = rest;
      });
    }
    return ok();
  }
  function setLootMin(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fail("loot value must be a number ≥ 0");
    settings.lootMin = n;
    persist();
    const loot = safe(() => getBot()?.loot ?? null);
    if (loot) safe(() => { loot.minValue = n; });
    return ok({ live: !!loot });
  }
  function setVitalsThreshold(key, value) {
    if (!VITALS_FIELDS.some((f) => f.key === key)) return fail(`unknown threshold ${key}`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 100) return fail("threshold must be 0–100");
    settings.vitals = { ...(settings.vitals || {}), [key]: n };
    persist();
    const v = safe(() => getBot()?.vitals ?? null);
    if (v && v.cfg) safe(() => { v.cfg[key] = n; });
    return ok({ live: !!(v && v.cfg) });
  }
  /** Buff list: live when buff_loop exposes setDesired(), else saved for the
   *  next HUD start / restart. Async: bot.setBuffs() resolves the list (and
   *  may build the loop) before this reports ok; errors are reported, not
   *  thrown. */
  async function setBuffs(ids) {
    const list = ids === "auto"
      ? "auto"
      : [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter((x) => Number.isInteger(x) && x > 0 && x <= 0xFFFFFFFF))];
    settings.buffs = list;
    persist();
    const b = getBot();
    if (b && typeof b.setBuffs === "function") {
      // bot.js: builds the loop when there is none, resolves "auto".
      try {
        await b.setBuffs(list); // bot.js serializes concurrent calls
      } catch (e) {
        return fail(`buffs: ${e?.message ?? e}`);
      }
      note(list === "auto" ? "buff list: auto" : `buff list set (${list.length})`);
      return ok({ live: true });
    }
    if (list === "auto") return ok({ live: false });
    const buff = safe(() => b?.buff ?? null);
    if (buff && typeof buff.setDesired === "function") {
      try { buff.setDesired(list); } catch (e) { return fail(e?.message ?? e); }
      note(`buff list set (${list.length})`);
      return ok({ live: true });
    }
    return ok({ live: false });
  }
  /** Profile: explorer = combat + loot off (the director's explorer prompt
   *  needs a restart with an AI key); grind = both on. */
  async function setPersona(persona) {
    const p = persona === "explorer" ? "explorer" : "grind";
    settings.persona = p;
    persist();
    const b = getBot();
    if (!b) return ok({ live: false });
    await setSubsystem("combat", p !== "explorer");
    await setSubsystem("loot", p !== "explorer");
    return ok({ live: true });
  }
  function applyPersonaRuntime(b) {
    if (settings.persona !== "explorer" || !b) return;
    // bot.js already boots explorer combat/loot OFF when the persona rode
    // cfg.ai; without a director (no key) apply the same toggles here.
    if (safe(() => b.combat?.enabled !== false, false)) setSubsystem("combat", false);
    if (safe(() => b.loot?.enabled !== false, false)) setSubsystem("loot", false);
  }
  function botOverrides() {
    const o = {};
    if (settings.buffs === "auto") o.buffs = "auto";
    else if (Array.isArray(settings.buffs) && settings.buffs.length) o.buffs = settings.buffs.slice();
    if (settings.priorities && Object.keys(settings.priorities).length) o.priorities = { ...settings.priorities };
    if (Number.isFinite(settings.lootMin)) o.lootMin = settings.lootMin;
    if (settings.vitals && Object.keys(settings.vitals).length) o.vitals = { ...settings.vitals };
    if (settings.persona) o.persona = settings.persona;
    return o;
  }

  /** Restart the bot with the HUD settings (stops the current one; the
   *  operator-stop latch, if set, still boots it held). */
  async function restart() {
    const h = getHandle();
    if (!h) return fail("not logged in");
    if (safe(() => win.__botBooting === true, false)) return fail("the bot is already starting");
    let boot;
    try {
      boot = await importer(moduleUrl("rynth/boot.js"));
    } catch (e) {
      return fail(`boot module failed to load: ${e?.message ?? e}`);
    }
    note("RESTART with HUD settings");
    const nb = await boot.bootBotFromHud(h, botOverrides(), { win });
    if (!nb) return fail("bot boot failed — see the console");
    applyPersonaRuntime(nb);
    return ok({ booted: true });
  }

  // ── navigation ─────────────────────────────────────────────────────────
  async function getAtlas() {
    const existing = safe(() => win.__atlas ?? null);
    if (existing) return existing;
    try {
      const m = await importer(moduleUrl("rynth/atlas.js"));
      const Atlas = typeof m.Atlas === "function" ? m.Atlas : typeof m.default === "function" ? m.default : null;
      if (!Atlas) return null;
      // Re-check: rynth/ai/tools/routes.js may have created THE shared one meanwhile.
      const again = safe(() => win.__atlas ?? null);
      if (again) return again;
      const at = new Atlas({});
      try { win.__atlas = at; } catch { /* frozen window */ }
      return at;
    } catch {
      return null;
    }
  }
  async function listRoutes() {
    const at = await getAtlas();
    const routes = safe(() => at?.listRoutes?.() ?? [], []) || [];
    return routes
      .filter((r) => r && Array.isArray(r.legs) && r.legs.length)
      .map((r) => ({ id: r.id, name: r.name || r.id, legs: r.legs.length, portals: r.portalsUsed ?? 0 }))
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  function selectRoute(id) {
    settings.route = id || null;
    persist();
    return ok();
  }
  async function followRoute(idOrName) {
    const b = getBot();
    if (!b) return fail("start the bot first");
    if (typeof b.followRoute !== "function") return fail("this bot cannot follow routes");
    const key = idOrName ?? settings.route;
    if (!key) return fail("pick a route first");
    const at = await getAtlas();
    const route = safe(() => at?.getRoute?.(key) ?? null);
    if (!route) return fail(`route not found: ${key}`);
    settings.route = route.id ?? key;
    persist();
    note(`follow route ${route.name ?? key}`);
    // followRoute resolves when the walk ends; the HUD polls bot.mission.
    Promise.resolve(b.followRoute(route.legs, { label: route.name ?? String(key) }))
      .then((r) => {
        if (r && r.ok === false) navResult(`route ${route.name ?? key}: ${describeNavError(r)}`, false);
        else if (r && r.ok) navResult(`route ${route.name ?? key}: done`, true);
      })
      .catch((e) => navResult(`route ${route.name ?? key} failed: ${describeNavError(e?.message ?? e)}`, false));
    return ok();
  }
  async function gotoLoc(ns, ew) {
    const b = getBot();
    if (!b) return fail("start the bot first");
    const n = Number(ns);
    const e = Number(ew);
    if (!Number.isFinite(n) || !Number.isFinite(e) || Math.abs(n) > 102 || Math.abs(e) > 102) {
      return fail("coordinates must be /loc degrees (|deg| ≤ 102; south / west negative)");
    }
    if (!b.globalRouter) return fail("nav sidecar not configured (page loaded with ?nav=off?)");
    note(`goto ${n.toFixed(2)} ${e.toFixed(2)}`);
    Promise.resolve(b.goto({ ns: n, ew: e }))
      .then((r) => (r && r.ok
        ? navResult(`goto arrived (${r.legsWalked ?? "?"} legs)`, true)
        : navResult(`goto failed: ${describeNavError(r)}`, false)))
      .catch((err) => navResult(`goto failed: ${describeNavError(err?.message ?? err)}`, false));
    return ok();
  }
  async function egress() {
    const b = getBot();
    if (!b) return fail("start the bot first");
    if (typeof b.egress !== "function") return fail("this bot cannot egress");
    note("egress to the nearest exit");
    Promise.resolve(b.egress())
      .then((r) => (r && r.ok
        ? navResult(r.alreadyOutdoors ? "already outdoors" : "egress done", true)
        : navResult(`egress failed: ${describeNavError(r)}`, false)))
      .catch((err) => navResult(`egress failed: ${describeNavError(err?.message ?? err)}`, false));
    return ok();
  }
  async function cancelTravel() {
    const b = getBot();
    if (!b) return fail("start the bot first");
    await loadOp();
    const c = getControl(b);
    if (c && typeof c.cancelTravel === "function") safe(() => c.cancelTravel());
    else {
      try { b.router?.cancel?.(); } catch { /* ignore */ }
      try { b.host?.StopCompletely?.(); } catch { /* ignore */ }
    }
    note("travel cancelled");
    return ok();
  }

  // ── spell catalog (self-buff picker) ───────────────────────────────────
  function loadCatalog() {
    if (catalog) return Promise.resolve(catalog);
    if (!catalogPromise) {
      const fetcher = typeof env.fetchJson === "function"
        ? env.fetchJson
        : (u) => fetch(u, { cache: "force-cache" }).then((r) => (r.ok ? r.json() : null));
      catalogPromise = Promise.resolve()
        .then(() => fetcher(moduleUrl("data/spells-catalog.json")))
        .then((j) => {
          const m = new Map();
          const spells = j && j.spells && typeof j.spells === "object" ? j.spells : {};
          for (const [id, s] of Object.entries(spells)) if (s && s.name) m.set(Number(id) >>> 0, s);
          catalog = m;
          return m;
        })
        .catch(() => {
          catalogPromise = null; // retry on the next open
          return null;
        });
    }
    return catalogPromise;
  }
  /** Known self-buff spells (untargeted enchantments with a duration) —
   *  the Settings tab's buff picker. One row per spell id, highest level
   *  first within a family name. */
  async function knownSelfBuffs() {
    const h = getHandle();
    const known = safe(() => Array.from(h?.playerKnownSpells?.() || []).map((x) => Number(x) >>> 0), []) || [];
    const cat = await loadCatalog();
    if (!cat) return [];
    const out = [];
    for (const id of known) {
      const s = cat.get(id);
      if (!s || !s.untargeted || !(Number(s.duration) > 0)) continue;
      out.push({ id, name: String(s.name), level: Number(s.level) || 0, school: Number(s.school) || 0 });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return out;
  }

  return {
    snapshot,
    start,
    stop,
    toggleRun,
    setSubsystem,
    setAi,
    forceRebuff,
    cancelForceRebuff,
    setPriority,
    removePriority,
    setLootMin,
    setVitalsThreshold,
    setBuffs,
    setPersona,
    restart,
    listRoutes,
    selectRoute,
    followRoute,
    gotoLoc,
    egress,
    cancelTravel,
    knownSelfBuffs,
    loadCatalog,
    spellName,
    getSettings: () => ({ ...settings }),
    note,
  };
}

export default createHudBridge;
