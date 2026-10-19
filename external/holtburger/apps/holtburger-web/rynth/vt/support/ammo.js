// rynth/vt/support/ammo.js — the "Ammo" kernel slot: Enable Missile Crafting
// ("Refill missile ammo", schema EnableMissileCrafting, default ON — RynthAi
// MissileCraftingManager.cs, U6 Appendix C), kept simpler than RynthAi.
//
// A launcher in the missile-weapon slot (bow, crossbow, atlatl: a non-zero
// AmmoType, the wasm is_missing_missile_ammo rule) with nothing in the ammo
// slot can't enter missile combat: the wasm refuses the stance locally ("You
// are out of ammunition!", src/session/commands/combat.rs) and the combat loop
// stands down 60 s after 5 toggles. This slot fills the ammo slot first:
//
//   1. Wield loose ammo: an unequipped stack that fits the ammo slot with the
//      launcher's EXACT AmmoType (ACE Player_Inventory.cs refuses any other) —
//      the kind last wielded first, else the biggest stack —
//      WieldItem(stack, Ammo 0x00800000), SetWielded on a host without it
//      (GetAndWieldItem; an empty slot has nothing to merge or swap).
//   2. Only when there is none: fletch one bundle, UseItemOnTarget(heads,
//      shafts) (ACE RecipeManager), and wield the product. ACE's recipes
//      (world DB cook_book: 315 ammo rows, all Fletching 37): the SHAFTS make
//      the kind (arrow 1 / quarrel 2 / atlatl dart 4) — every head bundle is
//      "…Arrowheads" and fits all three — crystal heads ×8 (crystal ammo),
//      chorizite heads ×64; "Wrapped" heads go on wrapped shafts, the others
//      on plain ones, the Infinite heads on both. The easiest recipe goes
//      first, never one whose estimated chance (ACE SkillCheck, Fletching vs
//      the recipe difficulty) is under 50 %: a failed combine destroys both
//      bundles. ACE crafts only in peace mode (allow_combat_mode_crafting is
//      off by default), so NonCombat is requested first. Confirmed by "You
//      make …" or the new stack; "You fail to make …" tries again (2 failures
//      park those heads 10 min); "You're too busy" → resend after 2 s, no
//      answer at all → after 5 s; 15 s → give up, crafting parked 60 s
//      (RynthAi: 2 s / 15 s). A combine that went through is never sent
//      twice: a kind-13 refusal that names a cast owner (host.castOwner():
//      vitals or the helper casting into ACE's crafting busy state) is that
//      cast's, not ours — a combine raises no busy count, so nothing else
//      tells them apart — and every resend waits until the first send got a
//      reply (or 1.5 s) and neither bundle stack moved nor a product
//      appeared. A chance-of-success dialog (a character option, off in
//      ACE's defaults) for our own combine is answered: yes at ≥ 50 %, else
//      no.
//
// When (never fighting a hand edit): only while the kernel runs, out of portal
// space, and only while the bot wants missile combat — a threat in range or a
// lock (the kernel's inCombat), or a "You are out of ammunition!" line (the
// server's last-arrow line or the client's refused stance toggle) in the last
// 30 s. The slot must also have been empty 1.5 s — a hand swap of arrows is
// never raced — unless its last stack was used up (gone from the pack).
//
// Rank beforeCombatPinned, keepsCombatLoop: below Vitals, the afterVitals
// slots, Unwedge, the /rs jump queue and an uninterruptible nav step
// (pinnedFirst); above Combat, pinned or not, so the combat loop's toggle
// budget isn't spent meanwhile.
// With the ammo slot empty ACE has already ended the missile attack loop; the
// lock is kept and Combat resumes it once the stack is in. Without a fight a
// loot or buff transaction in flight finishes first. A job in flight pins the
// slot (RynthAi: crafting blocks combat/nav/loot).
//
// Item actions claim the item token "vtammo" (C8); never throws (C9); no
// timers (C4). enabled() is false unless a launcher with an empty ammo slot is
// wielded (or a job is in flight), so the slot is invisible everywhere else.

import { skillChance } from "./supplies.js";
import {
  makeLogger,
  errText,
  optBool,
  call,
  playerGuid,
  inPortal,
  busyCount,
  combatMode,
  inventoryOf,
  objInt,
  playerStats,
  skillOf,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  castTokenBusy,
  loopOf,
  scanTargets,
} from "./consumables.js";

const OWNER = "vtammo";

export const AMMO_TUNING = Object.freeze({
  GEAR_TTL_MS: 250, // wielded-gear re-read (equip / inventory signals drop it at once)
  EMPTY_GRACE_MS: 1500, // an emptied slot whose stack was not used up waits this long (a hand swap)
  OUT_OF_AMMO_WINDOW_MS: 30_000, // "You are out of ammunition!" means "wants missile combat" this long
  ACTION_GAP_MS: 1000, // min gap between two of our item actions
  PLAN_TTL_MS: 250,
  WIELD_TIMEOUT_MS: 4000,
  ITEM_PARK_MS: 30_000, // a stack whose wield failed (crafting waits as long)
  CRAFT_RETRY_MS: 2000, // after "You're too busy" (RynthAi APPLY_RETRY_MS)
  CRAFT_SILENT_RETRY_MS: 5000, // no answer at all and both bundles untouched
  IN_FLIGHT_MS: 1500, // a send with no reply yet may still be running in ACE this long
  CRAFT_TIMEOUT_MS: 15_000, // RynthAi CRAFT_TIMEOUT_MS
  CRAFT_PARK_MS: 60_000,
  PRODUCT_WAIT_MS: 3000, // "You make" seen: wait this long for the new stack
  PEACE_WAIT_MS: 6000,
  MODE_INTERVAL_MS: 2000,
  HEADS_FAIL_LIMIT: 2,
  HEADS_PARK_MS: 10 * 60_000, // failed / declined heads, a pair with no recipe
  CRAFT_MIN_CHANCE: 0.5,
  NOTE_REPEAT_MS: 60_000,
});
const T = AMMO_TUNING;

// ACE EquipMask (EquipMask.cs) and the ids this slot reads.
const EM_MISSILE_WEAPON = 0x00400000;
const EM_AMMO = 0x00800000;
const PROP_AMMO_TYPE = 50; // PropertyInt AmmoType
const SKILL_FLETCHING = 37;
const MODE_NONCOMBAT = 1;
const CONFIRM_CRAFT = 5; // ConfirmationType.CraftInteraction
const OUT_OF_AMMO = "You are out of ammunition!";
// Chat categories (src/lib.rs CHAT_CATEGORY_*): ACE's recipe lines arrive as
// Craft, the out-of-ammo line as Transient; System (0) is also what a host
// without categories reports. Speech never arrives in these, so a player
// can't fake a result line.
const CAT_SYSTEM = 0;
const CAT_TRANSIENT = 9;
const CAT_CRAFT = 19;
// WeenieError codes (kind-13 UseDone(error), or a kind-2 line's u32).
const WE_TOO_BUSY = 0x001d;
const WE_PEACE_MODE = 0x043a; // YouMustBeInPeaceModeToTrade
const WE_NOT_TRAINED = 0x043b; // YouAreNotTrainedInThatTradeSkill

// Shaft bundles → [ammo kind (AmmoType flag), wrapped].
const SHAFTS = new Map([
  [4585, [1, false]], // Bundle of Arrowshafts
  [5339, [2, false]], // Bundle of Quarrelshafts
  [15296, [4, false]], // Bundle of Atlatl Dart Shafts
  [9377, [1, true]], // Wrapped Bundle of Arrowshafts
  [9378, [2, true]], // Wrapped Bundle of Quarrelshafts
  [15298, [4, true]], // Wrapped Bundle of Atlatl Dartshafts
]);

function diffTable(groups) {
  const m = new Map();
  for (const [d, ids] of Object.entries(groups)) for (const id of ids) m.set(id, Number(d));
  return m;
}
// Head bundles → Fletching difficulty (the hardest of their arrow / quarrel /
// dart recipes), per shaft family (ACE world DB recipe + cook_book).
const PLAIN_HEADS = diffTable({
  5: [4586],
  10: [5344, 5345],
  20: [5346, 5347, 8824],
  60: [5340, 5341, 5342, 5343, 7996],
  80: [9233],
  100: [9234],
  120: [5348, 21997],
  130: [9235],
  140: [5353, 5354],
  150: [15411, 15414, 15415, 21998],
  160: [5355, 5356, 8825],
  175: [15413, 15418, 24543],
  200: [5349, 5350, 5351, 5352],
  225: [15412, 15416, 15417, 15419],
  250: [30074, 30075, 30076, 30077, 30078, 30079, 30080, 30081, 44070],
  260: [44359, 44360, 44361],
  275: [44362, 44363],
  370: [44069],
  385: [44068],
});
const WRAPPED_HEADS = diffTable({
  35: [9359],
  40: [9362, 9363],
  50: [9361, 9366, 24544],
  90: [9360, 9364, 9365, 9367],
  150: [9368, 21999],
  170: [9371, 9372],
  175: [15420, 22000],
  180: [15423, 15424, 30074, 30077],
  190: [9370, 9375, 24546],
  200: [15422, 15427, 24545, 30076, 30080],
  230: [9369, 9373, 9374, 9376],
  250: [15421, 15425, 15426, 15428, 30075, 30078, 30079, 30081],
  275: [44071],
  300: [36363, 36497, 38779, 43148, 44210],
  320: [44224, 44364],
  325: [44365, 44366, 44367],
  375: [44073],
  400: [44072],
});
const CRYSTAL_HEADS = new Set([7996, 9233, 9234, 9235]); // Crystal, Bloodletter, Fleshripper, Soulrender: ×8
const CHORIZITE_HEADS = new Set([21997, 21998, 21999, 22000]); // ×64

const u32 = (v) => Number(v) >>> 0;
const sizeOf = (r) => (Number(r.stackSize) > 0 ? Number(r.stackSize) : 1);
const hex = (g) => (g >>> 0).toString(16);

/** What a heads bundle makes on a shafts bundle: { ammoType, difficulty }, or null (no recipe). */
export function craftProduct(headsWcid, shaftsWcid) {
  const s = SHAFTS.get(u32(shaftsWcid));
  if (!s) return null;
  const h = u32(headsWcid);
  const difficulty = (s[1] ? WRAPPED_HEADS : PLAIN_HEADS).get(h);
  if (difficulty === undefined) return null;
  const mult = CRYSTAL_HEADS.has(h) ? 8 : CHORIZITE_HEADS.has(h) ? 64 : 1;
  return { ammoType: s[0] * mult, difficulty };
}

/**
 * The loose stack to wield for a launcher of `ammoType`, or null: unequipped,
 * fits the ammo slot, the SAME AmmoType. `preferWcid` (the kind last wielded)
 * first, then the biggest stack. `blocked(guid)` skips parked stacks.
 */
export function pickLooseAmmo(inv, ammoType, { preferWcid = 0, blocked = () => false } = {}) {
  const want = u32(ammoType);
  if (!want) return null;
  let best = null;
  for (const r of inv || []) {
    if (!r || u32(r.equipMask) || !(u32(r.validLocations) & EM_AMMO) || u32(r.ammoType) !== want) continue;
    const guid = u32(r.guid);
    if (!guid || blocked(guid)) continue;
    const wcid = u32(r.wcid);
    const c = { guid, wcid, size: sizeOf(r), name: String(r.name ?? ""), pref: preferWcid && wcid === u32(preferWcid) ? 1 : 0 };
    if (!best || (c.pref - best.pref || c.size - best.size || best.guid - c.guid) > 0) best = c;
  }
  return best;
}

/**
 * The combine that fletches ammo of `ammoType`: { best, tooHard }. best =
 * { heads, shafts, headsWcid, shaftsWcid, difficulty, chance, name } — the
 * easiest recipe, then the biggest heads stack. With a known Fletching
 * `skill`, a pair under `minChance` is skipped (tooHard says one was).
 * `blocked(headsRow, shaftsRow)` skips parked pairs.
 */
export function craftPlan(inv, ammoType, { skill = null, minChance = T.CRAFT_MIN_CHANCE, blocked = () => false } = {}) {
  const out = { best: null, tooHard: false };
  const want = u32(ammoType);
  if (!want) return out;
  const heads = [];
  const shafts = [];
  for (const r of inv || []) {
    if (!r || u32(r.equipMask) || !u32(r.guid)) continue;
    const w = u32(r.wcid);
    if (SHAFTS.has(w)) shafts.push(r);
    else if (PLAIN_HEADS.has(w) || WRAPPED_HEADS.has(w)) heads.push(r);
  }
  for (const h of heads) {
    for (const s of shafts) {
      const p = craftProduct(h.wcid, s.wcid);
      if (!p || p.ammoType !== want || blocked(h, s)) continue;
      const chance = typeof skill === "number" && Number.isFinite(skill) ? skillChance(skill, p.difficulty) : null;
      if (chance !== null && chance < minChance) {
        out.tooHard = true;
        continue;
      }
      const c = {
        heads: u32(h.guid),
        shafts: u32(s.guid),
        headsWcid: u32(h.wcid),
        shaftsWcid: u32(s.wcid),
        difficulty: p.difficulty,
        chance,
        size: sizeOf(h),
        name: String(h.name ?? ""),
      };
      const b = out.best;
      if (!b || (b.difficulty - c.difficulty || c.size - b.size || b.heads - c.heads) > 0) out.best = c;
    }
  }
  return out;
}

export function createAmmo(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null } = deps;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "ammo", now);

  const st = {
    job: null, // { kind: "wield" | "craft", phase, …, at }
    gear: null, // { at, g } — the wielded-gear read
    plan: null, // { at, plan }
    emptySince: null, // when the launcher's ammo slot was first seen empty
    consumed: false, // …because its last stack was used up (no grace)
    lastAmmo: null, // { guid, wcid } of the last stack seen in the slot
    outOfAmmoAt: -Infinity,
    lastActionAt: -Infinity,
    modeAt: -Infinity,
    parked: new Map(), // "item:<guid>" | "heads:<wcid>" | "pair:<heads>:<shafts>" | "craft" -> until
    fails: new Map(), // heads wcid -> failed combines in a row
    sigSeq: 0,
    result: null, // { seq, kind: made | failed | norecipe | untrained } — the last craft line
    useFailed: null, // { seq, code }
    useDoneSeq: 0,
    equipFail: null, // { seq, item, code }
    wields: 0,
    crafts: 0,
    craftFails: 0,
    lastAction: null,
    note: null, // why the slot can't refill (status / log)
    noteAt: -Infinity,
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      unsubs.push(subscribe("chat", (sig) => onChat(sig)));
      unsubs.push(
        subscribe("equip", (sig) => {
          if (sig && sig.failed) st.equipFail = { seq: ++st.sigSeq, item: u32(sig.item), code: u32(sig.code) };
          dropMemo();
        })
      );
      unsubs.push(subscribe("inventory", () => dropMemo()));
      unsubs.push(
        subscribe("useFailed", (sig) => {
          // A refusal that names a cast owner is that cast's (vitals or the
          // helper casting into ACE's crafting busy state), never the combine's.
          if (castOwner()) return;
          st.useFailed = { seq: ++st.sigSeq, code: u32(sig && sig.code) };
        })
      );
      unsubs.push(subscribe("useDone", () => { st.useDoneSeq = ++st.sigSeq; }));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function dropMemo() {
    st.gear = null;
    st.plan = null;
  }

  /** Who a refusal arriving now belongs to: host.castOwner() (the live cast
   *  claim, else the last one for a few seconds); a host without it, the raw
   *  cast-token owner. null = nobody cast lately. */
  function castOwner() {
    if (host && typeof host.castOwner === "function") {
      const o = call(host, "castOwner");
      return typeof o === "string" && o ? o : null;
    }
    try {
      const tok = host ? host.castToken : null;
      return tok && typeof tok === "object" && tok.owner ? String(tok.owner) : null;
    } catch (_) {
      return null;
    }
  }

  function onChat(sig) {
    const text = String((sig && sig.text) || "").trim();
    if (!text) return;
    const cat = u32(sig.cat);
    if (text === OUT_OF_AMMO) {
      if (cat === CAT_TRANSIENT || cat === CAT_SYSTEM) {
        st.outOfAmmoAt = now();
        dropMemo();
      }
      return;
    }
    let kind = null;
    if (u32(sig.chatType) === WE_NOT_TRAINED) kind = "untrained";
    else if (cat === CAT_CRAFT || cat === CAT_SYSTEM) {
      if (/^You make\b/.test(text)) kind = "made";
      else if (/^You fail to make\b/.test(text)) kind = "failed";
      else if (/^The .+ cannot be (used on the .+|combined with itself)\.$/.test(text)) kind = "norecipe";
    }
    if (kind) st.result = { seq: ++st.sigSeq, kind };
  }

  function optOn() {
    return optBool(options, "EnableMissileCrafting", true);
  }

  function parkedKey(key, t) {
    const u = st.parked.get(key);
    if (u === undefined) return false;
    if (t < u) return true;
    st.parked.delete(key);
    return false;
  }
  function park(key, ms, t) {
    st.parked.set(key, t + ms);
    if (st.parked.size > 128) for (const [k, u] of st.parked) if (u <= t) st.parked.delete(k);
  }

  function note(msg, t) {
    if (st.note === msg && t >= st.noteAt && t - st.noteAt < T.NOTE_REPEAT_MS) return;
    st.note = msg;
    st.noteAt = t;
    log(msg);
  }

  // ── reads ───────────────────────────────────────────────────────────────
  /**
   * { launcher, ammoType, ammo, needsAmmo } of the wielded gear; null when
   * unreadable. From the inventory rows' equipMask — the wasm's
   * player.equipment, the very set is_missing_missile_ammo reads (the
   * TryGetWieldedItems index is built for other wielders).
   */
  function readGear() {
    if (!playerGuid(host)) return null;
    let launcher = null;
    let ammo = null;
    for (const r of inventoryOf(host)) {
      const m = u32(r && r.equipMask);
      if (m & EM_AMMO) ammo = { guid: u32(r.guid), wcid: u32(r.wcid) };
      else if (m & EM_MISSILE_WEAPON) launcher = r;
    }
    const lg = launcher ? u32(launcher.guid) : 0;
    const ammoType = lg ? u32(launcher.ammoType) || u32(objInt(host, lg, PROP_AMMO_TYPE) ?? 0) : 0;
    // A thrown weapon (AmmoType 0) launches itself: nothing to refill.
    return { launcher: lg, ammoType, ammo, needsAmmo: !!lg && ammoType > 0 && !ammo };
  }

  function gear(t) {
    const m = st.gear;
    if (m && t >= m.at && t - m.at < T.GEAR_TTL_MS) return m.g;
    const g = readGear();
    st.gear = { at: t, g };
    track(g, t);
    return g;
  }

  // The slot's history: the last stack in it, and when / how it emptied.
  function track(g, t) {
    if (g && g.ammo) {
      st.lastAmmo = g.ammo;
      st.emptySince = null;
      return;
    }
    if (!g || !g.needsAmmo) {
      st.emptySince = null;
      return;
    }
    if (st.emptySince !== null) return;
    st.emptySince = t;
    // Used up (gone from the pack): the out-of-arrows case, no grace. Still in
    // the pack: unwielded by hand (or pulled off by a launcher swap) — wait.
    const last = st.lastAmmo;
    st.consumed = !!last && !inventoryOf(host).some((r) => r && u32(r.guid) === last.guid);
  }

  /** Inventory rows; an ammo-slot row from a host that predates `ammoType` reads it (PropertyInt 50). */
  function inventory() {
    return inventoryOf(host).map((r) =>
      r && u32(r.validLocations) & EM_AMMO && !u32(r.ammoType) ? { ...r, ammoType: u32(objInt(host, u32(r.guid), PROP_AMMO_TYPE) ?? 0) } : r
    );
  }

  // ── decisions ───────────────────────────────────────────────────────────
  function inCombatOf(ctx) {
    if (ctx && typeof ctx.inCombat === "boolean") return ctx.inCombat;
    const c = loopOf(bot, "combat");
    if (!c) return false;
    return u32(c.locked) !== 0 || scanTargets(c).length > 0;
  }

  /** The bot wants missile combat: a threat or a lock, or an out-of-ammo line lately. */
  function wanted(ctx, t) {
    return inCombatOf(ctx) || (t >= st.outOfAmmoAt && t - st.outOfAmmoAt <= T.OUT_OF_AMMO_WINDOW_MS);
  }

  function settled(t) {
    return st.emptySince !== null && (st.consumed || t < st.emptySince || t - st.emptySince >= T.EMPTY_GRACE_MS);
  }

  function itemsFree(t) {
    if (itemTokenHeldByOther(host, OWNER) || busyCount(host) !== 0 || castTokenBusy(host, t)) return false;
    return t < st.lastActionAt || t - st.lastActionAt >= T.ACTION_GAP_MS;
  }

  function decide(g, t) {
    const inv = inventory();
    const loose = pickLooseAmmo(inv, g.ammoType, {
      preferWcid: st.lastAmmo ? st.lastAmmo.wcid : 0,
      blocked: (guid) => parkedKey(`item:${guid}`, t),
    });
    if (loose) return { kind: "wield", guid: loose.guid, name: loose.name };
    if (parkedKey("craft", t)) return null;
    const sk = skillOf(playerStats(host), SKILL_FLETCHING);
    if (sk && sk.training < 2) {
      note("out of ammo — Fletching is not trained, nothing to fletch with", t);
      return null;
    }
    const skill = sk ? sk.current : null;
    const { best, tooHard } = craftPlan(inv, g.ammoType, {
      skill,
      blocked: (h, s) =>
        parkedKey(`heads:${u32(h.wcid)}`, t) ||
        parkedKey(`pair:${u32(h.wcid)}:${u32(s.wcid)}`, t) ||
        call(host, "CanUseWith", u32(h.guid), u32(s.guid)) === false,
    });
    if (best) return { kind: "craft", ...best };
    note(
      tooHard
        ? `out of ammo — Fletching ${skill} is too low for the arrowheads you carry (< ${Math.round(T.CRAFT_MIN_CHANCE * 100)}%)`
        : "out of ammo — no matching ammo to wield and nothing to fletch",
      t
    );
    return null;
  }

  function cachedPlan(g, t) {
    const m = st.plan;
    if (m && t >= m.at && t - m.at < T.PLAN_TTL_MS) return m.plan;
    const plan = decide(g, t);
    st.plan = { at: t, plan };
    return plan;
  }

  // ── jobs ────────────────────────────────────────────────────────────────
  function end(j) {
    if (st.job === j) st.job = null;
    releaseItem(host, OWNER);
    dropMemo();
  }

  function wieldJob(guid, name, t) {
    return { kind: "wield", phase: "start", guid, name, at: t, sentAt: 0, seq: st.sigSeq };
  }

  function craftJob(plan, ammoType, t) {
    return {
      kind: "craft",
      phase: "peace",
      heads: plan.heads,
      shafts: plan.shafts,
      headsWcid: plan.headsWcid,
      shaftsWcid: plan.shaftsWcid,
      name: plan.name,
      chance: plan.chance,
      ammoType,
      at: t,
      seq: st.sigSeq,
      sentAt: 0,
      lastSendAt: -Infinity,
      sendSeq: st.sigSeq,
      sends: 0,
      answered: false, // a UseDone came after the last send
      replied: false, // a UseDone or a refusal of ours came after the last send
      busy: false, // the last send drew "You're too busy"
      bundles: null, // "heads:shafts" stack sizes at the last send
      before: null, // matching loose stacks before the first send
      confirms: null, // craft dialogs already pending before the first send
      dialog: false,
      madeAt: 0,
    };
  }

  function sendWield(j, t) {
    if (busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER)) return;
    if (!claimItem(host, OWNER, { minIntervalMs: T.ACTION_GAP_MS })) return;
    let sent = call(host, "WieldItem", j.guid, EM_AMMO) === true;
    if (!sent) sent = call(host, "SetWielded", j.guid, EM_AMMO) === true;
    if (!sent) {
      park(`item:${j.guid}`, T.ITEM_PARK_MS, t);
      log(`wield of ${hex(j.guid)} not sent — skipping it for ${T.ITEM_PARK_MS / 1000}s`);
      end(j);
      return;
    }
    j.phase = "await";
    j.sentAt = t;
    j.seq = st.sigSeq;
    st.lastActionAt = t;
    st.lastAction = { kind: "wield", guid: j.guid, at: t };
    st.gear = null;
    log(`wielding ${j.name || hex(j.guid)}`);
  }

  function craftConfirms() {
    const v = call(host, "TryGetPendingConfirmations");
    return Array.isArray(v) ? v.filter((c) => c && u32(c.confirmType) === CONFIRM_CRAFT) : [];
  }

  /** "heads:shafts" stack sizes — a combine that went through changes them. */
  function bundlesOf(j) {
    const inv = inventoryOf(host);
    const size = (g) => {
      const r = inv.find((x) => x && u32(x.guid) === g);
      return r ? sizeOf(r) : 0;
    };
    return `${size(j.heads)}:${size(j.shafts)}`;
  }

  /** A combine went through since the last send: a bundle stack moved, or a new matching stack showed. */
  function combineSeen(j) {
    if (bundlesOf(j) !== j.bundles) return true;
    return !!pickLooseAmmo(inventory(), j.ammoType, { blocked: (g) => !!j.before && j.before.has(g) });
  }

  function sendCraft(j, t) {
    // Not into another module's cast in flight either (ACE: "You're too busy").
    if (busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER) || castTokenBusy(host, t)) return;
    if (!claimItem(host, OWNER)) return;
    if (!j.before) {
      j.before = new Set(inventory().filter((r) => r && !u32(r.equipMask) && u32(r.ammoType) === j.ammoType).map((r) => u32(r.guid)));
      j.confirms = new Set(craftConfirms().map((c) => u32(c.context)));
    }
    j.bundles = bundlesOf(j);
    if (call(host, "UseItemOnTarget", j.heads, j.shafts) !== true) {
      park(`pair:${j.headsWcid}:${j.shaftsWcid}`, T.CRAFT_PARK_MS, t);
      log(`combine ${j.name} not sent — skipping it for ${T.CRAFT_PARK_MS / 1000}s`);
      end(j);
      return;
    }
    if (!j.sentAt) j.sentAt = t;
    j.phase = "await";
    j.lastSendAt = t;
    j.sendSeq = st.sigSeq;
    j.sends++;
    j.answered = false;
    j.replied = false;
    j.busy = false;
    st.lastActionAt = t;
    st.lastAction = { kind: "craft", heads: j.heads, shafts: j.shafts, at: t };
    if (j.sends === 1) log(`out of ammo — fletching ${j.name}${j.chance === null ? "" : ` (~${Math.round(j.chance * 100)}%)`}`);
  }

  function step(j, t) {
    if (inPortal(host)) return; // hold; the job's own timeouts still run
    if (j.kind === "wield") {
      if (j.phase === "start") sendWield(j, t);
      return;
    }
    if (j.phase === "peace") {
      const mode = combatMode(host);
      if (mode > 0 && mode !== MODE_NONCOMBAT) {
        if (t < st.modeAt || t - st.modeAt >= T.MODE_INTERVAL_MS) {
          call(host, "ChangeCombatMode", MODE_NONCOMBAT); // ACE crafts only in peace mode
          st.modeAt = t;
        }
      } else if (!j.sends || !combineSeen(j)) sendCraft(j, t); // a resend after the peace-mode refusal: same guard
      return;
    }
    if (j.phase !== "await") return;
    // Resend after "You're too busy", or after silence — never while that send
    // may still be running in ACE (no reply yet and < IN_FLIGHT_MS), and never
    // once a bundle moved or a product showed: a combine that went through is
    // not sent twice.
    const gap = t - j.lastSendAt;
    const due = j.busy ? gap >= T.CRAFT_RETRY_MS : !j.answered && gap >= T.CRAFT_SILENT_RETRY_MS;
    if (due && (j.replied || gap >= T.IN_FLIGHT_MS) && !combineSeen(j)) sendCraft(j, t);
  }

  function resolveWield(j, t) {
    if (j.phase === "start") {
      if (t - j.at > T.WIELD_TIMEOUT_MS) end(j); // never got the token / pacing
      return;
    }
    const f = st.equipFail;
    const refused = !!(f && f.seq > j.seq && f.item === j.guid);
    const g = refused ? null : gear(t);
    if (g && g.ammo) {
      st.wields++;
      st.outOfAmmoAt = -Infinity;
      st.note = null;
      // A combat stand-down from the refused missile stance ends with the ammo
      // in (a combat loop without the hook keeps its 60 s window).
      call(loopOf(bot, "combat"), "clearIncapable", "combat mode will not establish");
      end(j);
      return;
    }
    if (!refused && t - j.sentAt <= T.WIELD_TIMEOUT_MS) return;
    const why = refused ? `refused (code ${f.code})` : "got no answer";
    log(`wield of ${j.name || hex(j.guid)} ${why} — skipping it for ${T.ITEM_PARK_MS / 1000}s`);
    park(`item:${j.guid}`, T.ITEM_PARK_MS, t);
    park("craft", T.ITEM_PARK_MS, t); // a refused wield never turns into a combine
    end(j);
  }

  // The character's chance-of-success dialog for OUR combine (one not already
  // pending at the first send): yes at ≥ CRAFT_MIN_CHANCE, else no. → ended?
  function answerDialog(j, t) {
    if (j.dialog) return false;
    const c = craftConfirms().find((x) => !(j.confirms && j.confirms.has(u32(x.context))));
    if (!c) return false;
    j.dialog = true;
    const m = /(\d+(?:\.\d+)?) percent chance/i.exec(String(c.text || ""));
    const pct = m ? Number(m[1]) : NaN;
    const yes = Number.isFinite(pct) && pct >= T.CRAFT_MIN_CHANCE * 100;
    call(host, "SendConfirmationResponse", u32(c.confirmType), u32(c.context), yes);
    if (yes) {
      j.sentAt = t; // the combine runs from the answer
      j.answered = true;
      return false;
    }
    park(`heads:${j.headsWcid}`, T.HEADS_PARK_MS, t);
    log(`declined the ${Number.isFinite(pct) ? pct : "?"}% fletching dialog for ${j.name} — those heads are skipped for 10 min`);
    end(j);
    return true;
  }

  function resolveCraft(j, t) {
    if (j.phase === "peace") {
      if (t - j.at > T.PEACE_WAIT_MS) {
        park("craft", T.CRAFT_PARK_MS, t);
        log(`the combine never started (no peace mode, or another action kept it out) — crafting parked ${T.CRAFT_PARK_MS / 1000}s`);
        end(j);
      }
      return;
    }
    // The product: a new stack (in "product" any matching one) — the chat
    // line can trail the inventory, or go missing.
    const fresh = pickLooseAmmo(inventory(), j.ammoType, {
      blocked: (g) => (j.phase !== "product" && !!j.before && j.before.has(g)) || parkedKey(`item:${g}`, t),
    });
    if (fresh) {
      st.crafts++;
      st.fails.delete(j.headsWcid);
      end(j);
      st.job = wieldJob(fresh.guid, fresh.name, t);
      return;
    }
    const r = st.result;
    if (r && r.seq > j.seq) {
      st.result = null;
      if (r.kind === "made" && j.phase !== "product") {
        j.phase = "product";
        j.madeAt = t;
      } else if (r.kind === "failed") {
        st.craftFails++;
        const n = (st.fails.get(j.headsWcid) || 0) + 1;
        if (n >= T.HEADS_FAIL_LIMIT) {
          st.fails.delete(j.headsWcid);
          park(`heads:${j.headsWcid}`, T.HEADS_PARK_MS, t);
          log(`${j.name}: ${n} failed combines — those heads are skipped for 10 min`);
        } else st.fails.set(j.headsWcid, n);
        end(j);
        return;
      } else if (r.kind === "norecipe") {
        park(`pair:${j.headsWcid}:${j.shaftsWcid}`, T.HEADS_PARK_MS, t);
        log(`${j.name} does not combine with ${hex(j.shafts)} — that pair is skipped for 10 min`);
        end(j);
        return;
      } else if (r.kind === "untrained") {
        park("craft", T.HEADS_PARK_MS, t);
        log("Fletching is not trained — crafting parked 10 min");
        end(j);
        return;
      }
    }
    if (j.phase === "product") {
      if (t - j.madeAt > T.PRODUCT_WAIT_MS) {
        park("craft", T.CRAFT_PARK_MS, t); // made but not seen: never combine twice
        log(`made ${j.name} ammo but no new stack showed — crafting parked ${T.CRAFT_PARK_MS / 1000}s`);
        end(j);
      }
      return;
    }
    // Refusals naming a cast owner never got here (castOwner): this one is ours.
    const u = st.useFailed;
    if (u && u.seq > j.sendSeq) {
      st.useFailed = null;
      j.replied = true;
      if (u.code === WE_PEACE_MODE) {
        j.phase = "peace";
        j.at = t;
        return;
      }
      if (u.code !== WE_TOO_BUSY) {
        park(`pair:${j.headsWcid}:${j.shaftsWcid}`, T.CRAFT_PARK_MS, t);
        log(`combine ${j.name} refused (code ${u.code}) — skipping it for ${T.CRAFT_PARK_MS / 1000}s`);
        end(j);
        return;
      }
      j.busy = true; // resent after the retry gap, if the guard in step() allows
    } else if (st.useDoneSeq > j.sendSeq) {
      j.answered = true;
      j.replied = true;
    }
    if (answerDialog(j, t)) return;
    if (t - j.sentAt > T.CRAFT_TIMEOUT_MS) {
      park("craft", T.CRAFT_PARK_MS, t);
      log(`combine ${j.name} timed out — crafting parked ${T.CRAFT_PARK_MS / 1000}s`);
      end(j);
    }
  }

  function resolve(t) {
    const j = st.job;
    if (!j) return;
    if (j.kind === "wield") resolveWield(j, t);
    else resolveCraft(j, t);
  }

  function pinned() {
    if (!st.job) return false;
    resolve(now());
    return !!st.job;
  }

  function enabled() {
    if (st.disposed) return false;
    if (!optOn()) {
      if (st.job) end(st.job);
      return false;
    }
    if (st.job) return true;
    const g = gear(now());
    return !!(g && g.needsAmmo);
  }

  function wants(ctx, t) {
    if (pinned()) return true;
    const g = gear(t);
    if (!g || !g.needsAmmo || !settled(t) || !wanted(ctx, t)) return false;
    if (inPortal(host) || !itemsFree(t)) return false;
    // Without a fight a loot / buff transaction in flight finishes first.
    if (ctx && (ctx.lootPinned || ctx.buffPinned) && !inCombatOf(ctx)) return false;
    return !!cachedPlan(g, t);
  }

  function tick(t) {
    resolve(t);
    if (!st.job) {
      const g = gear(t);
      if (!g || !g.needsAmmo || inPortal(host)) return;
      const plan = cachedPlan(g, t);
      st.plan = null;
      if (!plan) return;
      st.job = plan.kind === "wield" ? wieldJob(plan.guid, plan.name, t) : craftJob(plan, g.ammoType, t);
    }
    step(st.job, t);
  }

  const slot = {
    name: "Ammo",
    rank: "beforeCombatPinned",
    keepsCombatLoop: true,
    enabled: () => {
      try {
        return enabled();
      } catch (_) {
        return false;
      }
    },
    pinned: () => {
      try {
        return pinned();
      } catch (_) {
        return false;
      }
    },
    wants: (ctx) => {
      try {
        return enabled() && wants(ctx, now());
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick: () => {
      try {
        tick(now());
      } catch (e) {
        log(`tick threw: ${errText(e)}`);
      }
    },
    onLeave: (next) => {
      try {
        if (next === "Stopped" && st.job) end(st.job); // the operator / a mover took the body
      } catch (_) {
        /* best effort */
      }
    },
    get status() {
      return status();
    },
  };

  function status() {
    const t = now();
    const on = slot.enabled();
    const g = on ? gear(t) : null;
    const j = st.job;
    return {
      enabled: on,
      job: j ?{ kind: j.kind, phase: j.phase, item: j.kind === "wield" ? j.guid : j.heads, at: j.at } : null,
      needsAmmo: !!(g && g.needsAmmo),
      ammoType: g ? g.ammoType : 0,
      wields: st.wields,
      crafts: st.crafts,
      craftFails: st.craftFails,
      parked: [...st.parked].filter(([, u]) => u > t).map(([k]) => k),
      lastAction: st.lastAction,
      note: st.note,
    };
  }

  function dispose() {
    if (st.job) end(st.job);
    st.disposed = true;
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  return { slot, status, dispose, enabled: slot.enabled, _state: st };
}

export default createAmmo;
