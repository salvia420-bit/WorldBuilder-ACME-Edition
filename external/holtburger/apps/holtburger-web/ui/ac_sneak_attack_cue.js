// ui/ac_sneak_attack_cue.js — the Sneak Attack cue inside the combat panels
// (2026-10-18; owner: "i see a sneak attack popup occur which should be moved
// into the combat HUD").
//
// RETAIL / REFERENCE CLIENTS
//   Retail has no Sneak Attack popup and no Sneak Attack element in any panel.
//   acclient.c holds exactly four "Sneak" strings: the attacker hit-line
//   prefix (ClientCombatSystem::HandleAttackerNotificationEvent :408415,
//   `attack_conditions & 4`), the defender prefix
//   (HandleDefenderNotificationEvent :409683), the skill name (:479842) and
//   the "Weave of Sneak Attack" item name (:229714). gmCombatUI (layout
//   0x21000007, data/retail-layouts/) has no such element. WebAC
//   (CombatDialog.ts formatAttackerChat) and OpenAC
//   (CombatNotificationText.AttackerLine) also only prefix the hit line. Our
//   hit lines carry the same prefixes (src/chat_format.rs
//   attacker_hit_prefix / defender_hit_prefix).
//
//   The retired plugins/sneak-hud.js plaque floated over the 3D view at 30%
//   screen height and fired on a CLIENT facing prediction
//   (scene3d/picking.js `sneakAttackPredicted`), so it also showed on evades
//   and on swings the server did not count. The cue now sits inside the
//   panel the player is already looking at, and the server decides it:
//
//   feed "attack" (melee / missile): plugins/combat-hud.js, row 2, after
//     "Recklessness +10".
//       bright: kind=19 `damageDealt` with AttackConditions bit 0x4. ACE sets
//               it when DamageEvent.SneakAttackMod > 1.0f (DamageEvent.cs:693;
//               Creature_Combat.cs GetSneakAttackMod: 100% from behind, the
//               Deception chance from the front). Lasts SNEAK_HIT_HOLD_MS, so
//               back-to-back sneak hits keep it lit. A plain hit turns it off:
//               you are no longer landing Sneak Attacks.
//       dim:    the swing left from behind the target (picking.js prediction,
//               scope local / local-missile) and Sneak Attack is trained. The
//               swing's own result replaces it (bright on a sneak hit, off on
//               a plain hit or an evade), or it fades if no result arrives
//               (SNEAK_BEHIND_HOLD_MS; SNEAK_BEHIND_MISSILE_HOLD_MS for a
//               shot). ACE sends no AttackerNotification for a killing blow
//               (Player_Combat.cs:157), so the dim cue just fades then.
//   feed "magic": plugins/combat-bar.js spell strip, the magic stance's
//     combat panel (retail swaps gmCombatUI for the spellcasting UI there).
//       bright: ACE's war / void projectile hit line, chat type Magic
//               (SpellProjectile.cs:803-813):
//               "[Critical hit! ][Overpower! ]Sneak Attack! You <verb> ...".
//               ACE sends no AttackConditions for spells, only this text.
//               There is no dim cue for spells: the cast-click geometry is out
//               of date by impact, and ACE checks the caster's position then.
//
//   "+N" is the nominal Sneak Attack damage rating: +10 trained, +20
//   specialized (Creature_Combat.cs:794). ACE scales it down when your Sneak
//   Attack skill is below your attack skill, and from the front by the
//   target's Assess Person, so the tooltip says "up to". The Recklessness
//   row in the same panel uses the same nominal number.
//
// Both panels load this module lazily, with import(). A static import would
// have to be stubbed by every suite that splices those plugins
// (harness/lib/splice_module.mjs).

import {
  readTrainingLevel,
  SKILL_SNEAK_ATTACK,
  TRAINING_TRAINED,
  TRAINING_SPECIALIZED,
} from "./ac_damage_rating.js";

/** AttackConditions.SneakAttack (ACE.Entity/Enum/AttackConditions.cs;
 *  acclient.c HandleAttackerNotificationEvent `attack_conditions & 4`). */
export const ATTACK_CONDITION_SNEAK_ATTACK = 0x4;
/** ChatMessageType.Magic: ACE SpellProjectile sends its hit lines as Magic
 *  system chat (GameMessageSystemChat(…, ChatMessageType.Magic)). */
export const CHAT_TYPE_MAGIC = 0x07;
/** How long a confirmed sneak hit keeps the cue bright. */
export const SNEAK_HIT_HOLD_MS = 2500;
/** How long a swing predicted from behind stays dim when no result arrives.
 *  Same as the diag's prediction-match window (scene3d/diag/combat.js). */
export const SNEAK_BEHIND_HOLD_MS = 2000;
/** A missile shot resolves later than a swing: ACE plays the draw and
 *  release first, then the projectile has to fly, and ACE judges the sneak
 *  at impact. */
export const SNEAK_BEHIND_MISSILE_HOLD_MS = 3000;
/** Re-read the Sneak Attack training at most this often (playerStats() walks
 *  the wasm property bag). */
const TRAINING_TTL_MS = 2000;

const STYLE_ID = "hb-sneak-cue-style";
export const SNEAK_CUE_CLASS = "hb-sneak-cue";

// picking.js prediction scopes for melee and missile swings. The magic one
// ("local-magic") is emitted at cast click, too early to say anything.
const ATTACK_SCOPES = new Set(["local", "local-missile"]);

// ACE SpellProjectile.DamageTarget attacker line:
//   `${critMsg}${overpowerMsg}${sneakMsg}You ${verb} ${target} for ${amount} points with ${spell}.${critProt}`
// critMsg = "Critical hit! ", overpowerMsg = "Overpower! ",
// sneakMsg = "Sneak Attack! " (when sneakAttackMod > 1.0f).
const MAGIC_SNEAK_LINE_RE = /^(?:Critical hit! )?(?:Overpower! )?Sneak Attack! You /;

const defaultNow = () =>
  (typeof performance !== "undefined" && typeof performance.now === "function")
    ? performance.now()
    : Date.now();

/** True when the AttackConditions mask has the SneakAttack bit. The wire is a
 *  u64; the kind=19 JSON carries it as a number (bits 0x1..0x8 only). */
export function hasSneakAttackBit(conditions) {
  if (typeof conditions === "bigint") return (conditions & 4n) !== 0n;
  const n = Number(conditions);
  if (!Number.isFinite(n) || n <= 0) return false;
  return (n & ATTACK_CONDITION_SNEAK_ATTACK) !== 0;
}

/** True for ACE's own-spell hit line with the Sneak Attack prefix (Magic chat
 *  type only; the defender line reads "Sneak Attack! <caster> …", never
 *  "Sneak Attack! You"). */
export function isMagicSneakAttackLine(text, chatType) {
  if (typeof text !== "string") return false;
  if ((Number(chatType) >>> 0) !== CHAT_TYPE_MAGIC) return false;
  return MAGIC_SNEAK_LINE_RE.test(text);
}

/** Nominal Sneak Attack damage rating for a training level
 *  (ACE GetSneakAttackMod: 20 specialized, 10 trained, else no sneak). */
export function sneakAttackBonus(training) {
  if (training === TRAINING_SPECIALIZED) return 20;
  if (training === TRAINING_TRAINED) return 10;
  return 0;
}

export function sneakCueText(bonus) {
  return bonus > 0 ? `Sneak Attack +${bonus}` : "Sneak Attack";
}

export function sneakCueTitle(mode, bonus, feed = "attack") {
  const dr = bonus > 0 ? ` (up to +${bonus} damage rating)` : "";
  if (mode === "hit") {
    return `Your last ${feed === "magic" ? "spell" : "hit"} was a Sneak Attack${dr}.`;
  }
  if (mode === "behind") {
    return `Your attack left from behind your target. If it lands it is a Sneak Attack${dr}.`;
  }
  return "";
}

/**
 * The cue's state machine: two deadlines, the mode is derived from them.
 *   behind()   swing predicted from behind: dim until the result (or timeout)
 *   hit()      server-confirmed sneak hit: bright for SNEAK_HIT_HOLD_MS
 *   plainHit() server hit WITHOUT the sneak bit: off
 *   missed()   the swing was evaded: drops the dim prediction only
 * A prediction never dims a bright cue; a bright cue that runs out while a
 * newer prediction is still pending falls back to dim, not off.
 */
export function createSneakCue({
  now = defaultNow,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
  hitHoldMs = SNEAK_HIT_HOLD_MS,
  behindHoldMs = SNEAK_BEHIND_HOLD_MS,
} = {}) {
  let hitUntil = 0;
  let behindUntil = 0;
  let critical = false;
  let flashes = 0;   // one per confirmed hit; the painter restarts the flash on change
  let timer = null;
  let disposed = false;
  const listeners = new Set();

  const modeAt = (t) => (t < hitUntil ? "hit" : t < behindUntil ? "behind" : "off");

  function get() {
    const mode = modeAt(now());
    return { mode, critical: mode === "hit" && critical, flashes };
  }

  // Wake at the nearest live deadline so the panel repaints when it expires.
  function arm() {
    if (timer != null) {
      clearTimer(timer);
      timer = null;
    }
    if (disposed) return;
    const t = now();
    let next = Infinity;
    if (hitUntil > t) next = Math.min(next, hitUntil);
    if (behindUntil > t) next = Math.min(next, behindUntil);
    if (next === Infinity) return;
    timer = setTimer(() => {
      timer = null;
      publish();
    }, Math.max(0, next - t));
  }

  function publish() {
    const snap = get();
    for (const fn of [...listeners]) {
      try { fn(snap); } catch (_) { /* a painter fault never breaks the cue */ }
    }
    arm();
    return snap;
  }

  return {
    get,
    subscribe(fn) {
      if (typeof fn !== "function") return () => {};
      listeners.add(fn);
      return () => { listeners.delete(fn); };
    },
    behind({ holdMs = behindHoldMs } = {}) {
      if (disposed) return get();
      behindUntil = Math.max(behindUntil, now() + holdMs);
      return publish();
    },
    hit({ critical: crit = false } = {}) {
      if (disposed) return get();
      hitUntil = now() + hitHoldMs;
      behindUntil = 0;
      critical = !!crit;
      flashes += 1;
      return publish();
    },
    plainHit() {
      if (disposed || (hitUntil === 0 && behindUntil === 0)) return get();
      hitUntil = 0;
      behindUntil = 0;
      critical = false;
      return publish();
    },
    missed() {
      if (disposed || behindUntil === 0) return get();
      behindUntil = 0;
      return publish();
    },
    clear() {
      if (disposed) return get();
      hitUntil = 0;
      behindUntil = 0;
      critical = false;
      return publish();
    },
    dispose() {
      disposed = true;
      if (timer != null) clearTimer(timer);
      timer = null;
      listeners.clear();
    },
  };
}

/** Paint one cue element. The text stays while it fades out, so the reserved
 *  width never jumps. `data-flash` alternates per confirmed hit, which swaps
 *  the keyframes and restarts the flash. */
export function paintSneakCue(el, snap, { bonus = 0, feed = "attack" } = {}) {
  if (!el) return;
  const mode = snap?.mode === "hit" || snap?.mode === "behind" ? snap.mode : "off";
  if (el.dataset) {
    el.dataset.sneak = mode;
    el.dataset.flash = String((Number(snap?.flashes) || 0) & 1);
  }
  if (mode !== "off") {
    const text = sneakCueText(bonus);
    if (el.textContent !== text) el.textContent = text;
    el.title = sneakCueTitle(mode, bonus, feed);
  }
  el.setAttribute?.("aria-hidden", mode === "off" ? "true" : "false");
}

// The look shared by both panels: the Recklessness row's red-orange (#ff9a7a),
// dim while a swing from behind is in flight, bright with a short flash on a
// confirmed hit, fading out over 450 ms. The panels add their own layout
// classes (.hch-sneak, .hb-ss-sneak) on top.
const SNEAK_CUE_CSS = `
  .${SNEAK_CUE_CLASS} {
    white-space: nowrap;
    color: #ff9a7a;
    text-shadow: 0 0 4px rgba(220, 80, 40, 0.5);
    opacity: 0;
    visibility: hidden;
    transition: opacity 450ms ease-out, visibility 0s linear 450ms;
  }
  .${SNEAK_CUE_CLASS}[data-sneak="behind"] {
    visibility: visible;
    opacity: 0.55;
    color: #c9927c;
    text-shadow: 0 1px 1px #000;
    transition: opacity 150ms ease-out, visibility 0s;
  }
  .${SNEAK_CUE_CLASS}[data-sneak="hit"] {
    visibility: visible;
    opacity: 1;
    color: #ffd9c8;
    text-shadow: 0 0 4px rgba(255, 100, 40, 0.75), 0 1px 2px rgba(0, 0, 0, 0.95);
    transition: opacity 120ms ease-out, visibility 0s;
  }
  .${SNEAK_CUE_CLASS}[data-sneak="hit"][data-flash="0"] { animation: hb-sneak-cue-flash-0 650ms ease-out 1; }
  .${SNEAK_CUE_CLASS}[data-sneak="hit"][data-flash="1"] { animation: hb-sneak-cue-flash-1 650ms ease-out 1; }
  @keyframes hb-sneak-cue-flash-0 {
    from { color: #fff; text-shadow: 0 0 10px rgba(255, 140, 60, 1), 0 0 3px rgba(255, 225, 190, 0.9); }
    to   { color: #ffd9c8; text-shadow: 0 0 4px rgba(255, 100, 40, 0.75), 0 1px 2px rgba(0, 0, 0, 0.95); }
  }
  @keyframes hb-sneak-cue-flash-1 {
    from { color: #fff; text-shadow: 0 0 10px rgba(255, 140, 60, 1), 0 0 3px rgba(255, 225, 190, 0.9); }
    to   { color: #ffd9c8; text-shadow: 0 0 4px rgba(255, 100, 40, 0.75), 0 1px 2px rgba(0, 0, 0, 0.95); }
  }
  @media (prefers-reduced-motion: reduce) {
    .${SNEAK_CUE_CLASS} { animation: none !important; transition: none !important; }
  }
`;

let stylesInjected = false;
export function ensureSneakCueStyles(doc = (typeof document !== "undefined" ? document : null)) {
  if (stylesInjected || !doc?.createElement || !doc.head?.appendChild) return;
  try {
    if (doc.getElementById?.(STYLE_ID)) { stylesInjected = true; return; }
    const s = doc.createElement("style");
    s.id = STYLE_ID;
    s.textContent = SNEAK_CUE_CSS;
    doc.head.appendChild(s);
    stylesInjected = true;
  } catch (_) { /* no stylesheet: the cue still tracks state */ }
}

/**
 * Wire one panel's cue element to its feed and paint it. Returns a teardown.
 *
 * @param {HTMLElement} el  the panel's cue element (combat-hud .hch-sneak /
 *   spell strip .hb-ss-sneak)
 * @param {object} [opts]
 * @param {"attack"|"magic"} [opts.feed]
 * @param {object} [opts.win]  window-like host: __pluginClient /
 *   __pluginClientReady (attack feed), __chatHooks (magic feed); the
 *   `__sneakCue[feed]` debug handle lands here
 * @param {() => number|null} [opts.readTraining]  Sneak Attack training
 */
export function mountSneakCue(el, {
  feed = "attack",
  win = (typeof window !== "undefined" ? window : null),
  doc = (typeof document !== "undefined" ? document : null),
  readTraining = () => readTrainingLevel(SKILL_SNEAK_ATTACK),
  now = defaultNow,
  setTimer,
  clearTimer,
} = {}) {
  if (!el) return () => {};
  ensureSneakCueStyles(doc);
  el.classList?.add?.(SNEAK_CUE_CLASS);

  const cueOpts = { now };
  if (setTimer) cueOpts.setTimer = setTimer;
  if (clearTimer) cueOpts.clearTimer = clearTimer;
  const cue = createSneakCue(cueOpts);

  let trainingAt = -Infinity;
  let training = null;
  const bonus = () => {
    const t = now();
    if (t - trainingAt >= TRAINING_TTL_MS) {
      trainingAt = t;
      try { training = readTraining(); } catch (_) { training = null; }
    }
    return sneakAttackBonus(training);
  };

  const paint = (snap) => paintSneakCue(el, snap, { bonus: bonus(), feed });
  const unsubCue = cue.subscribe(paint);
  el.textContent = sneakCueText(bonus());
  paint(cue.get());

  let disposed = false;
  const subs = [];

  if (feed === "attack") {
    const onDealt = (ev) => {
      const d = ev?.detail ?? ev ?? {};
      if (hasSneakAttackBit(d.attackConditions)) cue.hit({ critical: !!d.criticalHit });
      else cue.plainHit();
    };
    const onEvaded = () => { cue.missed(); };
    const onPredicted = (ev) => {
      const d = ev?.detail ?? ev ?? {};
      if (!ATTACK_SCOPES.has(d.scope)) return;
      // Untrained / unusable Sneak Attack never gets the bonus; say nothing.
      if (bonus() <= 0) return;
      cue.behind(d.scope === "local-missile" ? { holdMs: SNEAK_BEHIND_MISSILE_HOLD_MS } : undefined);
    };
    const attach = (client) => {
      if (disposed || !client?.events?.on) return false;
      const on = (name, fn) => {
        client.events.on(name, fn);
        subs.push(() => { try { client.events.off?.(name, fn); } catch (_) {} });
      };
      on("damageDealt", onDealt);
      on("evadedTarget", onEvaded);
      on("sneakAttackPredicted", onPredicted);
      return true;
    };
    // The plugin client exists only after login; index.html resolves
    // __pluginClientReady with it.
    if (!attach(win?.__pluginClient)) {
      const ready = win?.__pluginClientReady;
      if (ready && typeof ready.then === "function") {
        ready.then((c) => { attach(c ?? win?.__pluginClient); }, () => {});
      }
    }
  } else if (feed === "magic") {
    // plugins/chat-hooks.js (imported by index.html before any plugin mounts):
    // the retail OnChatWindowText tap, read-only here (never eats).
    const off = win?.__chatHooks?.onIncoming?.((ev) => {
      if (isMagicSneakAttackLine(ev?.text, ev?.chatType)) {
        cue.hit({ critical: ev.text.startsWith("Critical hit! ") });
      }
    });
    if (typeof off === "function") subs.push(off);
  }

  // Debug / eye-test handle: window.__sneakCue.attack.hit() lights the
  // combat HUD row without a fight (pin the HUD open with __combatHudDebug()).
  const handle = Object.freeze({
    hit: (o) => cue.hit(o),
    behind: () => cue.behind(),
    plainHit: () => cue.plainHit(),
    clear: () => cue.clear(),
    state: () => cue.get(),
  });
  if (win) {
    try {
      const reg = (win.__sneakCue && typeof win.__sneakCue === "object") ? win.__sneakCue : {};
      reg[feed] = handle;
      win.__sneakCue = reg;
    } catch (_) {}
  }

  return () => {
    disposed = true;
    for (const u of subs.splice(0)) { try { u(); } catch (_) {} }
    unsubCue();
    cue.dispose();
    paintSneakCue(el, { mode: "off" }, { feed });
    try { if (win?.__sneakCue?.[feed] === handle) delete win.__sneakCue[feed]; } catch (_) {}
  };
}

export const __test = Object.freeze({ MAGIC_SNEAK_LINE_RE, ATTACK_SCOPES, STYLE_ID, SNEAK_CUE_CSS });
