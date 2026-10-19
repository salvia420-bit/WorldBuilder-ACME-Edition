// rynth/vt/support/helpers.js — VTank's "help fellows" as the "Helpers"
// kernel slot (2026-10-19: DoHelp, the Vitals page's "… others at" rows,
// HelperDistance*, UseHealersHeart and JumpOutWandCasting, live instead of
// "Not on web"; behaviour after VTank / MOSS as WebAC reproduces it,
// rechargePlan.ts helperAction).
//
// Rank afterVitals, keepsCombatLoop, registered right after Supplies: your own
// vitals (rynth/vitals.js, then Supplies) come first, then your fellows'. The
// slot is inert (enabled() false) unless DoHelp is on and you are in a
// fellowship — or a Healer's Heart swap still owes the weapons back.
//
//   * Fellow vitals flow only while someone asked for them: ACE sends a
//     fellow's vital updates only to members whose fellowship panel is "open"
//     (Fellowship.cs OnVitalUpdate, Player_Fellowship.cs
//     HandleFellowshipUpdateRequest). The reflex holds that stream
//     (host.FellowshipHoldUpdates(true)) while helping is wanted — DoHelp on,
//     in a fellowship, the bot not operator-held — and releases it exactly
//     once when that stops, or on dispose (the count is shared with the
//     page's fellowship panel). Vitals are trusted only once a fellowship
//     update arrived after the hold: the snapshot from joining is stale.
//   * Per vital — health, stamina, mana — the fellows (never yourself; alive,
//     max > 0) below its "… others at" level (strict <, 0 disables the vital)
//     and within its helper distance (host.TryGetObjectDistance; unknown ⇒
//     skipped): the lowest percentage is helped first.
//   * Health with UseHealersHeart: a Healer's Heart on the Items tab goes
//     first for the fellows its own spell reaches. A heart is an owned entry
//     whose own spell (DataId 28) is a Heal Other spell (category 79) AND that
//     ACE uses wielded — ItemUseable's source half has Wielded (The Healer's
//     Heart, wcid 8552: 0x600004, casts 1166; the Seed of Mornings and the
//     Derubloom Wand, 0x600008, are used from the pack and are no hearts).
//     When the item is appraised, ACE's activation requirements are checked
//     first (WorldObject_Use.cs CheckUseRequirements: Arcane Lore ≥
//     ItemDifficulty, the ItemSkillLimit skill ≥ ItemSkillLevelLimit — the
//     Heart: 105 and Life Magic 245); the reflex appraises an unappraised
//     heart (≤ 1 per minute). ACE casts it only wielded and in Magic mode
//     (Player_Use.cs HandleActionUseWithTarget → HandleActionCastTargeted
//     Spell): WieldItem(heart, Held) — the client moves every weapon and the
//     shield to the pack first (holtburger_world::equip) — then
//     ChangeCombatMode(8), then UseItemOnTarget(heart, fellow). ACE answers a
//     use it refuses for its requirements or the combat mode with a plain
//     UseDone and no error, so a use counts only once it showed: ACE's
//     "With … you restore N points of health to X" line (it precedes the
//     UseDone in the same UI queue), or — Magic chat squelched — the fellow's
//     health reading rising within 2 s. Three uses in a row that showed
//     nothing park the heart (30 s, doubling per repeat, ≤ 10 min): Heal Other
//     spells and the hand-back run meanwhile. With JumpOutWandCasting a
//     minimal jump follows ~0.2 s later, on a later heartbeat (VTank: the heal
//     goes out at once) — never for a PK / PKLite, whose jump fails the cast
//     (ACE FastTick: Player.cs HandleActionJump → FailCast).
//   * Hand-back: the swap is a debt — what it moved to the pack, or nothing
//     (empty hands). Once no fellow within the heart's reach needs it, each
//     item goes back to its own slot, then a heart still in hand goes back to
//     the pack (UnwieldItem). Before the first step the heart must still be in
//     hand, or the hands empty: a loadout someone else changed meanwhile is
//     theirs. An item that fails to go back parks (doubling) and keeps the
//     debt, until its fifth failure (≈ 7.5 min): then that part is given up
//     with one local chat alert (deps.print, else host.WriteToChatWindow) —
//     the same for a heart that will not leave the hand. Items back in hand,
//     gone or given up settle it; holdsWandSlot() is true exactly while the
//     debt is owed (combat and the planner hold their loadout meanwhile),
//     and deps.state keeps the debt across a rebind.
//   * Spells: Heal Other / Revitalize Other / Mana Boost Other (Infuse Mana
//     Other when no Mana Boost Other is known), the highest known tier by
//     LADDER position (the catalog reads the VII lore names and the
//     Incantations as level 1), within the Life Magic tier cap when
//     BuffTierSkillCap is on (skill_cap.js, as rynth/vitals.js), and within
//     the spell's range (ACE VerifySpellRange: its DAT range at your skill,
//     never beyond 75 m). Cast TARGETED only (host.CastSpellAt) under the
//     cast token "helpers", in Magic mode — a caster must already be wielded
//     (a plain spell never swaps weapons) — at most one every 0.4 s.
//   * Pacing: one help in flight at a time — the slot stays pinned and keeps
//     its cast claim until that help's own answer (the useDone / useFailed
//     signal; ≤ 6 s): ACE's UseDone count moves on before a refusal is
//     dispatched. Refusals are ours when host.castOwner() says so (the raw
//     cast token without it). A fellow is helped again only ≥ 2 s after the
//     last help was sent and once its vitals had time to arrive. A refusal or
//     an out-of-range answer backs that fellow off 5 s; missing components /
//     no mana hold every helper cast; three fizzles or "not in the spellbook"
//     drop a tier for 10 min; a heal that restored nothing ("With … you
//     restore 0 points of health to …") means that fellow's reading is stale
//     — that vital waits 30 s.
//
// Holds in portal space; never throws; no timers (the jump-out is a
// timestamp a later heartbeat checks).

import { casterWielded, castRefusalClass } from "../../buff_loop.js";
import { SCHOOL, createHostSkillCap, readTierThresholds } from "../../skill_cap.js";
import {
  PROP,
  makeLogger,
  errText,
  opt,
  optBool,
  optNum,
  optList,
  call,
  playerGuid,
  inPortal,
  busyCount,
  combatMode,
  inventoryOf,
  objName,
  objInt,
  objDid,
  distanceTo,
  playerStats,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  castTokenBusy,
  loopOf,
  resolveOwned,
  lc,
} from "./consumables.js";

const OWNER = "vthelpers"; // item token: the heart's wield and use, the hand-back
const CAST_OWNER = "helpers"; // cast token: spells and the heart's cast

export const HELPER_TUNING = Object.freeze({
  FELLOWSHIP_REFRESH_MS: 1000, // re-read the fellowship at least this often
  FELLOWSHIP_MIN_READ_MS: 250, // … and at most this often while updates stream in
  FRESH_FALLBACK_MS: 5000, // no fellowship update after our hold: trust the vitals anyway
  RECAST_MS: 2000, // min gap between two helps at one fellow
  SETTLE_MS: 750, // after a help was answered, its fellow's vitals get this long to arrive
  CAST_PIN_MAX_MS: 6000, // an unanswered cast / heart use pins the slot (and its cast claim) at most this long
  WIELD_PIN_MAX_MS: 4000,
  CAST_INTERVAL_MS: 400,
  BACKOFF_MS: 5000, // a refused / out-of-range help backs that fellow off
  STALE_BACKOFF_MS: 30_000, // a heal that restored nothing
  GAIN_WINDOW_MS: 10_000, // a "you restore" line belongs to our help this long
  HEART_VERIFY_MS: 2000, // a heart use with no "you restore" line: the fellow's reading must rise within this
  HEART_FAIL_LIMIT: 3,
  ITEM_FAIL_PARK_MS: 30_000, // the first park of a heart / weapon that failed; doubles per repeat
  ITEM_PARK_MAX_MS: 600_000,
  HAND_BACK_TRY_LIMIT: 5, // failed hand-backs of one item (≈ 7.5 min of parks) before its debt is given up
  HEART_ID_RETRY_MS: 60_000, // an unappraised heart is appraised at most this often
  MAGIC_MODE_INTERVAL_MS: 3000,
  MAGIC_MODE_ATTEMPT_LIMIT: 5,
  MAGIC_MODE_PARK_MS: 15_000,
  COMPONENTS_PARK_MS: 60_000,
  MANA_PARK_MS: 10_000,
  FIZZLE_LIMIT: 3,
  DEMOTE_MS: 600_000,
  HEART_CACHE_MS: 1000,
  KNOWN_REFRESH_MS: 30_000,
  KNOWN_EMPTY_REFRESH_MS: 2000,
  SKILL_REFRESH_MS: 5000,
  JUMP_DELAY_MS: 200,
  JUMP_WINDOW_MS: 1500, // CanJumpNow() still false this long after the due time: no jump
  JUMP_POWER: 0.05, // a 50 ms charge (goto_compose.js jumpPowerMin; WebAC holdMs 50)
  MIN_PROGRESS_PCT: 0.5,
  MAX_SPELL_RANGE_M: 75, // ACE Player.MaxRadarRange_Outdoors caps every spell range
});
const T = HELPER_TUNING;

// The other-targeted vital spells, lowest tier first: I..VI, the level-7 lore
// spell, the level-8 Incantation (data/spells-catalog.json names). The tier
// is the ladder position + 1. None is SelfTargeted: always cast at the fellow.
export const HELPER_LADDERS = Object.freeze({
  heal: Object.freeze([5, 1162, 1163, 1164, 1165, 1166, 2072, 4310]), // Heal Other I..VI, Adja's Gift, Incantation of Heal Other
  revitalize: Object.freeze([1183, 1184, 1185, 1186, 1187, 1188, 2082, 4320]), // Revitalize Other I..VI, Replenish, Incantation of Revitalize Other
  manaBoost: Object.freeze([1207, 1208, 1209, 1210, 1211, 1212, 2076, 4314]), // Mana Boost Other I..VII, Incantation of Mana Boost Other
  infuse: Object.freeze([9, 1255, 1256, 1257, 1258, 1259, 2336, 4651]), // Infuse Mana Other I..VI, Gift of Essence, Incantation of Infuse Mana Other
});
const HEAL_OTHER = new Set(HELPER_LADDERS.heal);
const HEAL_OTHER_CATEGORY = 79;

// Per vital: its options, the TryGetFellowship member fields, the ladders
// tried in order (VTank order: health, stamina, mana).
const VITALS = Object.freeze([
  Object.freeze({ vital: "health", atKey: "HealOthersAt", atDflt: 50, rangeKey: "HelperHealDistance", cur: "health", max: "maxHealth",
    ladders: Object.freeze(["heal"]) }),
  Object.freeze({ vital: "stamina", atKey: "RestamOthersAt", atDflt: 10, rangeKey: "HelperRestamDistance", cur: "stamina", max: "maxStamina",
    ladders: Object.freeze(["revitalize"]) }),
  Object.freeze({ vital: "mana", atKey: "InfuseOthersAt", atDflt: 10, rangeKey: "HelperInfuseDistance", cur: "mana", max: "maxMana",
    ladders: Object.freeze(["manaBoost", "infuse"]) }),
]);

// ACE EquipMask (EquipMask.cs): a Held caster clears every weapon slot and the
// shield (Player_Inventory.cs CheckWeaponCollision; the client moves them to
// the pack before GetAndWieldItem).
const EM_MELEE = 0x00100000;
const EM_SHIELD = 0x00200000;
const EM_MISSILE = 0x00400000;
const EM_HELD = 0x01000000;
const EM_TWO_HANDED = 0x02000000;
const EM_HAND_SLOTS = EM_MELEE | EM_SHIELD | EM_MISSILE | EM_HELD | EM_TWO_HANDED;
const inHand = (row) => !!row && ((Number(row.equipMask) >>> 0) & EM_HAND_SLOTS) !== 0;
const MODE_MAGIC = 8;
const ITEM_MOVES = new Set(["wield", "handBack", "unwield"]); // in-flight kinds answered by an equip change
// ACE ids: Skill, PropertyInt, PropertyDataId, PlayerKillerStatus,
// ObjectDescriptionFlag.
const SKILL_ARCANE_LORE = 23;
const SKILL_LIFE_MAGIC = 33;
const SAC_SPECIALIZED = 3;
const PINT_ITEM_USEABLE = 16;
const USABLE_SOURCE_WIELDED = 0x4; // ItemUseable's source half (low 16 bits)
const PINT_ITEM_SPELLCRAFT = 106;
const PINT_ITEM_DIFFICULTY = 109;
const PINT_ITEM_SKILL_LEVEL_LIMIT = 115;
const PINT_PK_STATUS = 134;
const PDID_ITEM_SKILL_LIMIT = 37;
const PK_STATUS_PK = 0x04;
const PK_STATUS_PKLITE = 0x40;
const ODF_PK_BITS = 0x00000020 | 0x02000000; // PLAYER_KILLER | PK_LITE_STATUS

// ACE WorldObject_Magic.cs (vital boost arm) to the caster of a beneficial
// spell on someone else: "With Heal Other VI you restore 112 points of health
// to Bob." The heart's spell says the same.
const RESTORE_LINE = /^With (.+) you restore (\d+) points? of (health|stamina|mana) to (.+)\.$/;

/**
 * The spell of one ladder to cast: the highest known tier within `cap` (a
 * spell level; Infinity = no cap), demoted ids skipped; with nothing known
 * within the cap, the highest known one below the lowest demoted tier
 * (rynth/vitals.js _spell). 0 when nothing on the ladder is known.
 */
export function pickTier(ladder, known, cap = Infinity, demoted = null) {
  let fallback = 0;
  for (let i = ladder.length - 1; i >= 0; i--) {
    const id = ladder[i];
    if (demoted && demoted(id)) {
      fallback = 0;
      continue;
    }
    if (!known.has(id)) continue;
    if (i + 1 <= cap) return id;
    if (!fallback) fallback = id;
  }
  return fallback;
}

export function createHelpers(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null, items = null } = deps;
  const combatLoop = typeof deps.combat === "function" ? deps.combat : () => loopOf(bot, "combat");
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "helpers", now);
  // What a heart swap moved to the pack lives in deps.state when the
  // composition root passes page-session memory (the planner's plannerState
  // idiom), so a rebound bot still hands the weapons back.
  const keep = deps.state && typeof deps.state === "object" ? deps.state : {};
  if (!("saved" in keep)) keep.saved = null; // { heart, items: [{ guid, mask }], started }

  const st = {
    holding: false, // our FellowshipHoldUpdates(true) is outstanding
    holdAt: 0,
    freshAt: 0, // a fellowship update arrived after the hold
    fs: undefined, // the TryGetFellowship snapshot (null = not in one)
    fsAt: -Infinity,
    fsDirty: false,
    inFlight: null, // { kind: "cast"|"heart"|"wield"|"handBack"|"unwield", target?, name?, vital?, pct?, spellId?, item?, at, seq, … }
    jump: null, // { at, until }
    paced: new Map(), // fellow guid -> no help before ts
    backoff: new Map(), // fellow guid | "guid:vital" -> ts
    lastHelp: null, // { target, name, vital, at, gain } — the "you restore" attribution
    heartCheck: null, // { item, target, pct, help, due } — an answered heart use that has not shown yet
    castBlock: null, // { reason, until }
    magicParkUntil: 0,
    magicAttempts: 0,
    modeAt: -Infinity,
    lastCastAt: -Infinity,
    demoted: new Map(), // spellId -> ts
    fizzles: new Map(), // spellId -> fizzles in a row
    itemParkUntil: new Map(), // guid -> ts: a wield / hand-back / unwield that failed
    itemFails: new Map(), // guid -> failures in a row (the park doubles)
    heartParkUntil: new Map(), // heart guid -> ts: uses that showed nothing
    heartParks: new Map(), // heart guid -> parks in a row
    heartFails: 0,
    hearts: null, // { at, list: [{ guid, spellId, name }] }
    heartSkipLogged: new Set(), // heart guids whose unmet requirements were logged
    idAt: new Map(), // heart guid -> last appraisal request
    pkJumpLogged: false,
    known: null,
    knownAt: -Infinity,
    cap: null,
    capSig: null,
    skills: null, // { at, value }
    sigSeq: 0,
    lastUseDoneSeq: 0,
    lastUseDoneAt: 0,
    lastFail: null, // { seq, code, at }
    plan: null, // { at, plan }
    casts: 0,
    heartUses: 0,
    jumps: 0,
    lastAction: null,
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    const on = (type, fn) => {
      unsubs.push(
        subscribe(type, (sig) => {
          try {
            fn(sig);
          } catch (_) {
            /* a bad signal never breaks the bus */
          }
        })
      );
    };
    try {
      on("useDone", () => {
        st.lastUseDoneSeq = ++st.sigSeq;
        st.lastUseDoneAt = now();
      });
      on("useFailed", (sig) => {
        st.lastFail = { seq: ++st.sigSeq, code: Number(sig && sig.code) >>> 0, at: now() };
        onRefusal(st.lastFail);
      });
      on("equip", (sig) => onEquip(sig));
      on("fellowship", () => {
        st.fsDirty = true;
        if (st.holding && !st.freshAt) st.freshAt = now();
      });
      on("chat", (sig) => onChat(sig));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  // ── the fellowship and its vitals stream ────────────────────────────────
  function fellowship(t) {
    const age = t - st.fsAt;
    if (st.fs === undefined || age < 0 || age >= (st.fsDirty ? T.FELLOWSHIP_MIN_READ_MS : T.FELLOWSHIP_REFRESH_MS)) {
      const v = call(host, "TryGetFellowship");
      st.fs = v && typeof v === "object" ? v : null;
      st.fsAt = t;
      st.fsDirty = false;
    }
    return st.fs;
  }

  function helpWanted(t) {
    return !st.disposed && optBool(options, "DoHelp", true) && !!fellowship(t);
  }

  // ACE FellowshipPanelOpen: held while helping is wanted and the bot is not
  // operator-held; every hold is released exactly once.
  function syncHold(t, held) {
    const want = !held && helpWanted(t);
    if (want && !st.holding) {
      // Fresh only after an update that follows this hold, even when the
      // page's panel already holds the stream (its request may have gone to
      // an earlier session).
      st.holding = true;
      st.holdAt = t;
      st.freshAt = 0;
      call(host, "FellowshipHoldUpdates", true);
    } else if (!want && st.holding) {
      release();
    }
  }

  function release() {
    if (!st.holding) return;
    st.holding = false;
    st.freshAt = 0;
    call(host, "FellowshipHoldUpdates", false);
  }

  function fresh(t) {
    return st.holding && (st.freshAt > 0 || t - st.holdAt >= T.FRESH_FALLBACK_MS);
  }

  function enabled() {
    if (st.disposed) return false;
    if (keep.saved || st.inFlight || st.jump) return true; // finish what was started
    return optBool(options, "DoHelp", true) && !!fellowship(now());
  }

  // ── small reads ─────────────────────────────────────────────────────────
  function paced(g, t) {
    const u = st.paced.get(g);
    return u != null && t < u;
  }
  function backedOff(g, vital, t) {
    const a = st.backoff.get(g);
    const b = st.backoff.get(`${g}:${vital}`);
    return (a != null && t < a) || (b != null && t < b);
  }
  function parkedIn(map, g, t) {
    const u = map.get(g >>> 0);
    return u != null && t < u;
  }
  function itemParked(g, t) {
    return parkedIn(st.itemParkUntil, g, t);
  }
  // Park `g` in `until` for 30 s, doubling with every failure in a row
  // (`counts`), at most 10 min. → the park in ms.
  function park(until, counts, g, t) {
    const n = (counts.get(g) || 0) + 1;
    if (counts.size > 64 && !counts.has(g)) counts.clear();
    counts.set(g, n);
    const ms = Math.min(T.ITEM_FAIL_PARK_MS * 2 ** (n - 1), T.ITEM_PARK_MAX_MS);
    until.set(g, t + ms);
    return ms;
  }
  function demoted(id, t) {
    const u = st.demoted.get(id);
    return u != null && t < u;
  }
  function wieldedIn(guid, mask) {
    return inventoryOf(host).some((r) => (Number(r && r.guid) >>> 0) === guid && ((Number(r.equipMask) >>> 0) & mask) !== 0);
  }
  function itemsFree(t) {
    return !itemTokenHeldByOther(host, OWNER) && busyCount(host) === 0 && !castTokenBusy(host, t);
  }
  function castFree(t) {
    return busyCount(host) === 0 && !castTokenBusy(host, t) && t - st.lastCastAt >= T.CAST_INTERVAL_MS;
  }
  function hex(g) {
    return (Number(g) >>> 0).toString(16);
  }
  // A fellow's reading of one vital in percent (the cached snapshot), or null.
  function memberPct(guid, V, t) {
    const fs = fellowship(t);
    const m = fs && Array.isArray(fs.members) ? fs.members.find((x) => (Number(x && x.guid) >>> 0) === guid) : null;
    const max = Number(m && m[V.max]);
    const cur = Number(m && m[V.cur]);
    return max > 0 && Number.isFinite(cur) ? (cur / max) * 100 : null;
  }

  function known(t) {
    const age = st.known && st.known.size > 0 ? T.KNOWN_REFRESH_MS : T.KNOWN_EMPTY_REFRESH_MS;
    if (!st.known || t - st.knownAt > age || t < st.knownAt) {
      const v = call(host, "TryGetKnownSpells");
      st.known = new Set((Array.isArray(v) ? v : []).map((x) => Number(x) >>> 0));
      st.knownAt = t;
    }
    return st.known;
  }

  // The skills map of TryGetPlayerStats (5 s), or null.
  function skillsOf(t) {
    const c = st.skills;
    if (c && t >= c.at && t - c.at < T.SKILL_REFRESH_MS) return c.value;
    const sk = playerStats(host)?.skills;
    st.skills = { at: t, value: sk && typeof sk === "object" ? sk : null };
    return st.skills.value;
  }

  // The Life Magic tier cap of the buff and vitals loops (BuffTierSkillCap +
  // BuffMinSkillLevelTier1..8, read here directly); Infinity when off.
  function lifeCap() {
    if (!optBool(options, "BuffTierSkillCap", false)) {
      st.cap = null;
      st.capSig = null;
      return Infinity;
    }
    const tiers = readTierThresholds((k, d) => opt(options, k, d), "BuffMinSkillLevelTier");
    const sig = tiers.join(",");
    if (!st.cap || st.capSig !== sig) {
      st.cap = createHostSkillCap(host, { tiers });
      st.capSig = sig;
    }
    const v = Number(st.cap(SCHOOL.Life));
    return Number.isNaN(v) ? Infinity : v;
  }

  function spellFor(V, t) {
    const k = known(t);
    const cap = lifeCap();
    for (const name of V.ladders) {
      const id = pickTier(HELPER_LADDERS[name], k, cap, (x) => demoted(x, t));
      if (id) return id;
    }
    return 0;
  }

  // The skill ACE measures a spellbook cast's range with: init level + ranks
  // (Player_Magic.cs VerifySpellRange; init 10 when specialized, 0 trained).
  function lifeRangeSkill(t) {
    const row = skillsOf(t)?.[SKILL_LIFE_MAGIC];
    const ranks = Number(row && row.ranks);
    return Number.isFinite(ranks) ? ranks + ((Number(row.training) || 0) >= SAC_SPECIALIZED ? 10 : 0) : undefined;
  }

  // ACE VerifySpellRange: BaseRangeConstant + skill × BaseRangeMod, never
  // beyond 75 m (the cap alone when the record or the skill is unknown).
  function spellRangeM(spellId, skillOf) {
    const rec = call(host, "TryGetSpellRecord", spellId);
    if (!rec || typeof rec !== "object") return T.MAX_SPELL_RANGE_M;
    const c = Number(rec.baseRangeConstant) || 0;
    const m = Number(rec.baseRangeMod) || 0;
    if (!(c > 0) && !(m > 0)) return T.MAX_SPELL_RANGE_M;
    let r = c;
    if (m > 0) {
      const s = Number(skillOf());
      if (!Number.isFinite(s)) return T.MAX_SPELL_RANGE_M;
      r += s * m;
    }
    return Math.min(r, T.MAX_SPELL_RANGE_M);
  }

  // ── the Items-tab heart ─────────────────────────────────────────────────
  function itemEntries() {
    try {
      if (items && typeof items.list === "function") {
        const v = items.list();
        return Array.isArray(v) ? v : [];
      }
    } catch (_) {
      return [];
    }
    return optList(options, "items");
  }

  function isHealOther(spellId) {
    if (HEAL_OTHER.has(spellId)) return true;
    const rec = call(host, "TryGetSpellRecord", spellId);
    return !!rec && Number(rec.category) === HEAL_OTHER_CATEGORY;
  }

  // Owned Items entries that are hearts: their own spell heals others AND ACE
  // uses them wielded (ItemUseable unreadable: the spell alone decides).
  // Cached 1 s.
  function heartCandidates(t) {
    const c = st.hearts;
    if (c && t >= c.at && t - c.at < T.HEART_CACHE_MS) return c.list;
    const list = [];
    const inv = inventoryOf(host);
    for (const e of itemEntries()) {
      let g = 0;
      try {
        g = items && typeof items.resolveGuid === "function" ? Number(items.resolveGuid(e)) >>> 0 : resolveOwned(host, e, inv);
      } catch (_) {
        g = 0;
      }
      const spellId = g ? objDid(host, g, PROP.DID_SPELL) : undefined;
      if (!spellId || !isHealOther(spellId)) continue;
      const use = objInt(host, g, PINT_ITEM_USEABLE);
      if (use !== undefined && ((use & 0xffff) & USABLE_SOURCE_WIELDED) === 0) continue; // used from the pack
      list.push({ guid: g, spellId, name: String((e && e.name) || "") });
    }
    st.hearts = { at: t, list };
    return list;
  }

  // ACE CheckUseRequirements for the heart's own magic, once it is appraised:
  // → { ok, why }, or null while unreadable (then it is tried; failures park it).
  function heartActivation(g, t) {
    if (call(host, "HasAppraisalData", g) !== true) return null;
    const sk = skillsOf(t);
    if (!sk) return null;
    const need = [];
    const diff = objInt(host, g, PINT_ITEM_DIFFICULTY);
    if (diff > 0) need.push([SKILL_ARCANE_LORE, diff, "Arcane Lore"]);
    const skill = objDid(host, g, PDID_ITEM_SKILL_LIMIT);
    const level = objInt(host, g, PINT_ITEM_SKILL_LEVEL_LIMIT);
    if (skill && level > 0) need.push([skill, level, skill === SKILL_LIFE_MAGIC ? "Life Magic" : `skill ${skill}`]);
    for (const [id, min, label] of need) {
      const cur = Number(sk[id] && sk[id].current);
      if (Number.isFinite(cur) && cur < min) return { ok: false, why: `${label} ${Math.round(cur)} < ${min}` };
    }
    return { ok: true };
  }

  // The heart to use: a candidate neither parked nor short of its
  // requirements, with its wield state.
  function findHeart(t) {
    for (const h of heartCandidates(t)) {
      if (itemParked(h.guid, t) || parkedIn(st.heartParkUntil, h.guid, t)) continue;
      const act = heartActivation(h.guid, t);
      if (act && !act.ok) {
        if (!st.heartSkipLogged.has(h.guid)) {
          st.heartSkipLogged.add(h.guid);
          log(`${h.name || "the heart"} can't be activated (${act.why}) — Heal Other spells instead`);
        }
        continue;
      }
      return { ...h, wielded: wieldedIn(h.guid, EM_HELD) };
    }
    return null;
  }

  // An unappraised heart is appraised (≤ 1 per HEART_ID_RETRY_MS each), so its
  // activation requirements become readable before it is ever wielded.
  function appraiseHearts(t) {
    if (typeof host?.HasAppraisalData !== "function" || typeof host?.RequestId !== "function") return;
    for (const h of heartCandidates(t)) {
      if (call(host, "HasAppraisalData", h.guid) === true) continue;
      const last = st.idAt.get(h.guid);
      if (last != null && t >= last && t - last < T.HEART_ID_RETRY_MS) continue;
      st.idAt.set(h.guid, t);
      call(host, "RequestId", h.guid);
    }
  }

  // How far the heart's own spell reaches: its DAT range at the item's
  // spellcraft (ACE measures a built-in spell with ItemSpellcraft), ≤ 75 m.
  function heartReachM(heart) {
    return spellRangeM(heart.spellId, () => objInt(host, heart.guid, PINT_ITEM_SPELLCRAFT));
  }

  // An answered heart use counts once it showed: its "you restore" line, or
  // the fellow's health reading rising; nothing within HEART_VERIFY_MS is a
  // failed use (ACE's plain UseDone for an activation or combat-mode refusal).
  function settleHeartCheck(t) {
    const c = st.heartCheck;
    if (!c) return;
    let shown = !!c.help && c.help.gain != null;
    if (!shown) {
      const pct = memberPct(c.target, VITALS[0], t);
      shown = pct != null && pct > c.pct + T.MIN_PROGRESS_PCT;
    }
    if (!shown && t < c.due) return;
    st.heartCheck = null;
    if (shown) {
      st.heartFails = 0;
      st.heartParks.delete(c.item);
    } else heartFailed(c.item, t, "no heal came of it");
  }

  function heartFailed(g, t, why) {
    if (++st.heartFails < T.HEART_FAIL_LIMIT) return;
    st.heartFails = 0;
    const ms = park(st.heartParkUntil, st.heartParks, g, t);
    log(`the heart failed ${T.HEART_FAIL_LIMIT}x in a row (${why}) — Heal Other spells and the hand-back for ${ms / 1000}s`);
  }

  // ACE IsPKType (PlayerKillerStatus PK or PKLite): FastTick, where a jump
  // mid-cast fails the cast. Unreadable status: the description flags.
  function pkType() {
    const me = playerGuid(host);
    if (!me) return false;
    const v = objInt(host, me, PINT_PK_STATUS);
    if (v !== undefined) return v === PK_STATUS_PK || v === PK_STATUS_PKLITE;
    const f = call(host, "TryGetObjectDescFlags", me);
    return typeof f === "number" && ((f >>> 0) & ODF_PK_BITS) !== 0;
  }

  // ── decisions ───────────────────────────────────────────────────────────
  function magicStep(t) {
    if (t < st.magicParkUntil) return null;
    return t - st.modeAt >= T.MAGIC_MODE_INTERVAL_MS ? { kind: "magic" } : { kind: "wait" };
  }

  function planHeart(heart, ready, t) {
    if (st.heartCheck) return null; // the last use has not shown yet
    const target = ready[0];
    if (!heart.wielded) return itemsFree(t) ? { kind: "wield", heart, target } : null;
    if (combatMode(host) !== MODE_MAGIC) return magicStep(t);
    st.magicAttempts = 0;
    if (!itemsFree(t) || t - st.lastCastAt < T.CAST_INTERVAL_MS) return null;
    return { kind: "heart", heart, target, vital: "health", spellId: heart.spellId };
  }

  function planSpell(V, ready, t) {
    if (st.castBlock && st.castBlock.until > t) return null;
    const spellId = spellFor(V, t);
    if (!spellId) return null;
    const rangeM = spellRangeM(spellId, () => lifeRangeSkill(t));
    const target = ready.find((n) => n.dist <= rangeM);
    if (!target) return null;
    if (combatMode(host) !== MODE_MAGIC) {
      if (casterWielded(host) === false) {
        st.castBlock = { reason: "no-caster", until: t + T.MAGIC_MODE_PARK_MS };
        log("no caster (wand/orb/staff) wielded — helper spells need Magic mode; holding");
        return null;
      }
      return magicStep(t);
    }
    st.magicAttempts = 0;
    if (!castFree(t)) return null;
    return { kind: "cast", spellId, target, vital: V.vital };
  }

  // The next help, or null. `out.needHeart`: a fellow within the heart's reach
  // still needs it (one just helped included) — the hand-back waits for that.
  function decideHelp(t, fs, me, out) {
    const members = fs && Array.isArray(fs.members) ? fs.members : [];
    for (const V of VITALS) {
      const at = optNum(options, V.atKey, V.atDflt);
      if (!(at > 0)) continue;
      const range = optNum(options, V.rangeKey, 30);
      const need = [];
      for (const m of members) {
        const g = Number(m && m.guid) >>> 0;
        if (!g || g === me) continue;
        const max = Number(m[V.max]);
        const cur = Number(m[V.cur]);
        if (!(max > 0) || !Number.isFinite(cur) || !(Number(m.health) > 0)) continue; // no reading, or dead
        const pct = (cur / max) * 100;
        if (!(pct < at) || backedOff(g, V.vital, t)) continue;
        const dist = distanceTo(host, g);
        if (dist == null || dist > range) continue;
        need.push({ guid: g, name: String(m.name ?? ""), pct, dist, paced: paced(g, t) });
      }
      if (!need.length) continue;
      need.sort((a, b) => a.pct - b.pct);
      if (V.vital === "health" && optBool(options, "UseHealersHeart", true)) {
        const heart = findHeart(t);
        const reach = heart ? heartReachM(heart) : 0;
        const near = heart ? need.filter((n) => n.dist <= reach) : [];
        if (near.length) {
          out.needHeart = true;
          const ready = near.filter((n) => !n.paced);
          const p = ready.length ? planHeart(heart, ready, t) : null;
          if (p) return p;
          continue; // the heart heals whom it reaches; Heal Other spells wait while it can
        }
      }
      const ready = need.filter((n) => !n.paced);
      if (!ready.length) continue;
      const p = planSpell(V, ready, t);
      if (p) return p;
    }
    return null;
  }

  // The hand-back of the heart swap's debt, once no fellow within the heart's
  // reach needs it: each owed item back to its own slot, then a heart still
  // in hand back to the pack.
  function decideHandBack(t, needHeart) {
    const sv = keep.saved;
    if (!sv || needHeart) return null;
    const inv = inventoryOf(host);
    const heartInHand = wieldedIn(sv.heart, EM_HELD);
    if (!sv.started && !heartInHand && inv.some(inHand)) {
      keep.saved = null;
      log("the hands were re-armed meanwhile — nothing to hand back");
      return null;
    }
    const owed = owedItems(sv.items, inv);
    if (owed.length) {
      const next = owed.find((x) => !itemParked(x.guid, t));
      if (!next) return null; // failed lately: tried again after its park, the debt stays
      return itemsFree(t) ? { kind: "handBack", item: next.guid, mask: next.mask } : null;
    }
    if (sv.dropped) {
      keep.saved = null; // the rest is back; what could not come back was given up (and said)
      return null;
    }
    if (heartInHand) {
      if (typeof host?.UnwieldItem !== "function") {
        keep.saved = null;
        log("no UnwieldItem on this host — the heart stays in hand");
        return null;
      }
      if (itemParked(sv.heart, t)) return null;
      return itemsFree(t) ? { kind: "unwield", item: sv.heart } : null;
    }
    keep.saved = null;
    return null;
  }

  // Owed items still in the pack (one gone, or back in hand, is settled).
  function owedItems(list, inv) {
    return list.filter((x) => {
      const r = inv.find((i) => (Number(i && i.guid) >>> 0) === x.guid);
      return !!r && !inHand(r);
    });
  }

  // HAND_BACK_TRY_LIMIT failed tries of one hand-back step: that part of the
  // debt is given up, said once in chat — the combat loop and the planner
  // hold their loadout while the debt is owed, so it may never be owed for
  // good. Nothing else owed: the debt is settled now (holdsWandSlot() false).
  function giveUp(g, kind) {
    st.itemFails.delete(g);
    st.itemParkUntil.delete(g);
    const sv = keep.saved;
    const name = itemName(g);
    if (sv && kind === "handBack") {
      const items = sv.items.filter((x) => x.guid !== g);
      keep.saved = owedItems(items, inventoryOf(host)).length ? { ...sv, items, dropped: true } : null;
      alert(`could not wield ${name} back after the Healer's Heart — check your pack`);
    } else {
      keep.saved = null;
      alert(`could not put ${name} back in the pack after healing — check your pack`);
    }
  }

  function itemName(g) {
    const r = inventoryOf(host).find((i) => (Number(i && i.guid) >>> 0) === g);
    return String((r && r.name) || objName(host, g) || hex(g));
  }

  // A local chat line, never sent to the server: the injected deps.print,
  // else host.WriteToChatWindow (nav/active_nav.js _alert).
  function alert(text) {
    log(text);
    const line = `[RynthSuite] ${text}`;
    try {
      if (typeof deps.print === "function") deps.print(line, 0);
      else call(host, "WriteToChatWindow", line);
    } catch (_) {
      /* chat surface absent */
    }
  }

  function decide(t) {
    if (inPortal(host)) return null;
    resolve(t);
    if (st.inFlight || st.jump) return null;
    settleHeartCheck(t);
    const me = playerGuid(host);
    if (!me) return null;
    const out = { needHeart: false };
    if (st.holding && helpWanted(t)) {
      if (!fresh(t)) return null; // the stream was just asked for: wait for real vitals
      const p = decideHelp(t, fellowship(t), me, out);
      if (p) return p;
    }
    return decideHandBack(t, out.needHeart);
  }

  function cachedPlan(t) {
    if (st.plan && t >= st.plan.at && t - st.plan.at <= 50) return st.plan.plan; // same kernel tick
    const plan = decide(t);
    st.plan = { at: t, plan };
    return plan;
  }

  // ── in-flight resolution ────────────────────────────────────────────────
  function onEquip(sig) {
    const f = st.inFlight;
    if (!f || !ITEM_MOVES.has(f.kind) || !sig) return;
    if ((Number(sig.item) >>> 0) !== f.item) return;
    if (sig.failed) f.failed = true;
    else f.done = true;
  }

  // Is a refusal arriving now ours? host.castOwner(): the live claim's owner,
  // else the last claim's for 6 s (the refusal trails ACE's UseDone); hosts
  // without it: the raw cast token.
  function refusalIsOurs() {
    if (host && typeof host.castOwner === "function") {
      try {
        return host.castOwner() === CAST_OWNER;
      } catch (_) {
        return false;
      }
    }
    let tok = null;
    try {
      tok = host ? host.castToken : null;
    } catch (_) {
      tok = null;
    }
    return !(tok && tok.owner && tok.owner !== CAST_OWNER);
  }

  // A kind-13 refusal while our cast / heart use is unanswered.
  function onRefusal(fail) {
    const f = st.inFlight;
    if (!f || f.refused || (f.kind !== "cast" && f.kind !== "heart") || !refusalIsOurs()) return;
    const t = now();
    const code = fail.code & 0xffff;
    const cls = castRefusalClass(code);
    f.refused = cls || "other";
    if (f.kind === "heart") st.jump = null; // no cast to jump out of
    if (f.kind === "cast" && cls === "components") {
      st.castBlock = { reason: "components", until: t + T.COMPONENTS_PARK_MS };
      log(`cast refused: missing spell components — helper casts held ${T.COMPONENTS_PARK_MS / 1000}s`);
    } else if (f.kind === "cast" && cls === "mana") {
      st.castBlock = { reason: "mana", until: t + T.MANA_PARK_MS };
    } else if (f.kind === "cast" && cls === "unknown-spell") {
      demote(f.spellId, "not in the spellbook", t);
    } else if (f.kind === "cast" && cls === "fizzle") {
      const n = (st.fizzles.get(f.spellId) || 0) + 1;
      if (n >= T.FIZZLE_LIMIT) demote(f.spellId, `fizzled ${n}x in a row`, t);
      else st.fizzles.set(f.spellId, n);
    } else {
      // Out of range (MissileOutOfRange), target gone or teleporting,
      // indoors / outdoors, too busy …: that fellow waits.
      st.backoff.set(f.target, t + T.BACKOFF_MS);
      log(`help at ${f.name || hex(f.target)} refused (code 0x${code.toString(16)}) — backing off ${T.BACKOFF_MS / 1000}s`);
      if (f.kind === "heart") heartFailed(f.item, t, `refused 0x${code.toString(16)}`);
    }
  }

  function demote(id, why, t) {
    st.fizzles.delete(id);
    st.demoted.set(id, t + T.DEMOTE_MS);
    log(`demote ${id} (${why}) — next lower known tier for ${T.DEMOTE_MS / 60_000} min`);
  }

  // "With <spell> you restore N points of <vital> to <fellow>." for our last
  // help: the heal landed; 0 points ⇒ the fellow was full, its reading stale.
  function onChat(sig) {
    const m = RESTORE_LINE.exec(String((sig && sig.text) || ""));
    if (!m) return;
    const h = st.lastHelp;
    const t = now();
    if (!h || h.gain != null || t - h.at > T.GAIN_WINDOW_MS || h.vital !== m[3] || lc(h.name) !== lc(m[4])) return;
    h.gain = Number(m[2]);
    if (h.gain > 0) return;
    st.backoff.set(`${h.target}:${h.vital}`, t + T.STALE_BACKOFF_MS);
    log(`${m[1]} restored nothing to ${h.name} — its ${h.vital} reading is stale; waiting ${T.STALE_BACKOFF_MS / 1000}s`);
  }

  function resolve(t) {
    const f = st.inFlight;
    if (!f) return;
    if (ITEM_MOVES.has(f.kind)) {
      const landed =
        f.done || (f.kind === "unwield" ? !wieldedIn(f.item, EM_HAND_SLOTS) : wieldedIn(f.item, f.kind === "wield" ? EM_HELD : EM_HAND_SLOTS));
      if (!landed && !f.failed && t - f.at <= T.WIELD_PIN_MAX_MS) return;
      st.inFlight = null;
      releaseItem(host, OWNER);
      if (!landed) {
        const ms = park(st.itemParkUntil, st.itemFails, f.item, t);
        if (f.kind !== "wield" && st.itemFails.get(f.item) >= T.HAND_BACK_TRY_LIMIT) giveUp(f.item, f.kind);
        else log(`${f.kind === "wield" ? "wield of the heart" : f.kind === "unwield" ? "unwield of the heart" : "hand-back of"} ${hex(f.item)} failed — next try in ${ms / 1000}s`);
      } else {
        st.itemFails.delete(f.item);
        if (st.castBlock && st.castBlock.reason === "no-caster") st.castBlock = null; // our own move changed the hands: look again
      }
      return;
    }
    // A cast / heart use keeps its claim until its own answer: ACE's UseDone
    // count moves on before a refusal is dispatched.
    let answeredAt = t; // the answer's signal time (the pin's end without one)
    if (st.lastFail && st.lastFail.seq > f.seq) answeredAt = Math.min(t, st.lastFail.at);
    else if (st.lastUseDoneSeq > f.seq) answeredAt = Math.min(t, st.lastUseDoneAt);
    else if (t - f.at <= T.CAST_PIN_MAX_MS) return;
    st.inFlight = null;
    call(host, "releaseCast", CAST_OWNER);
    if (f.kind === "heart") {
      releaseItem(host, OWNER);
      if (!f.refused) st.heartCheck = { item: f.item, target: f.target, pct: f.pct, help: st.lastHelp, due: answeredAt + T.HEART_VERIFY_MS };
    } else if (!f.refused && st.lastUseDoneSeq > f.seq) st.fizzles.delete(f.spellId); // a clean UseDone
    st.paced.set(f.target, Math.max(f.at + T.RECAST_MS, answeredAt + T.SETTLE_MS));
  }

  function pinned() {
    if (!st.inFlight && !st.jump) return false;
    resolve(now());
    return !!st.inFlight || !!st.jump;
  }

  // ── actions ─────────────────────────────────────────────────────────────
  function disengage() {
    try {
      const c = combatLoop();
      if (c && typeof c.disengage === "function") c.disengage({ cancelAttack: true }); // the planner's pre-wield rule
    } catch (_) {
      /* best effort */
    }
  }

  function noteHelp(kind, plan, t) {
    const target = plan.target;
    const item = plan.heart ? plan.heart.guid : 0;
    st.inFlight = { kind, target: target.guid, name: target.name, vital: plan.vital, pct: target.pct, spellId: plan.spellId, item, at: t, seq: st.sigSeq };
    st.lastHelp = { target: target.guid, name: target.name, vital: plan.vital, at: t, gain: null };
    st.paced.set(target.guid, t + T.RECAST_MS);
    st.lastCastAt = t;
    st.lastAction = { kind, target: target.guid, name: target.name, vital: plan.vital, pct: Math.round(target.pct), spellId: plan.spellId, at: t };
  }

  function wieldHeart(plan, t) {
    const heart = plan.heart;
    if (!claimItem(host, OWNER)) return;
    // What this wield moves to the pack: every weapon slot and the shield.
    const moved = inventoryOf(host)
      .filter((r) => r && (Number(r.guid) >>> 0) !== heart.guid && ((Number(r.equipMask) >>> 0) & EM_HAND_SLOTS) !== 0)
      .map((r) => ({ guid: Number(r.guid) >>> 0, mask: (Number(r.equipMask) >>> 0) & EM_HAND_SLOTS }))
      .sort((a, b) => (a.mask === EM_SHIELD ? 1 : 0) - (b.mask === EM_SHIELD ? 1 : 0)); // the shield after the weapon
    disengage();
    if (call(host, "WieldItem", heart.guid, EM_HELD) !== true) {
      releaseItem(host, OWNER);
      const ms = park(st.itemParkUntil, st.itemFails, heart.guid, t);
      log(`wield of the heart ${hex(heart.guid)} not sent — Heal Other spells for ${ms / 1000}s`);
      return;
    }
    // The debt: what this swap moved out, or nothing (the heart itself goes
    // back). A debt still owed keeps the loadout from before the first swap.
    if (keep.saved) keep.saved = { ...keep.saved, heart: heart.guid, started: false };
    else keep.saved = { heart: heart.guid, items: moved, started: false };
    st.inFlight = { kind: "wield", item: heart.guid, at: t, seq: st.sigSeq };
    st.lastAction = { kind: "wield", item: heart.guid, at: t };
    log(`wielding ${heart.name || "the heart"} for ${plan.target.name || hex(plan.target.guid)} (health ${Math.round(plan.target.pct)}%)`);
  }

  function useHeart(plan, t) {
    const heart = plan.heart;
    if (!claimItem(host, OWNER)) return;
    if (typeof host?.tryClaimCast === "function" && host.tryClaimCast(CAST_OWNER) !== true) {
      releaseItem(host, OWNER);
      return;
    }
    if (call(host, "UseItemOnTarget", heart.guid, plan.target.guid) !== true) {
      call(host, "releaseCast", CAST_OWNER);
      releaseItem(host, OWNER);
      return;
    }
    noteHelp("heart", plan, t);
    st.heartUses++;
    if (optBool(options, "JumpOutWandCasting", false)) {
      if (!pkType()) st.jump = { at: t + T.JUMP_DELAY_MS, until: t + T.JUMP_DELAY_MS + T.JUMP_WINDOW_MS };
      else if (!st.pkJumpLogged) {
        st.pkJumpLogged = true;
        log("JumpOutWandCasting skipped: you are a PK, and a PK's jump fails the cast (ACE FailCast)");
      }
    }
    log(`${heart.name || "heart"} on ${plan.target.name || hex(plan.target.guid)} (health ${Math.round(plan.target.pct)}%)`);
  }

  function castAt(plan, t) {
    if (typeof host?.tryClaimCast === "function" && host.tryClaimCast(CAST_OWNER) !== true) return;
    if (call(host, "CastSpellAt", plan.target.guid, plan.spellId) !== true) {
      call(host, "releaseCast", CAST_OWNER);
      return;
    }
    noteHelp("cast", plan, t);
    st.casts++;
    log(`cast ${plan.spellId} on ${plan.target.name || hex(plan.target.guid)} (${plan.vital} ${Math.round(plan.target.pct)}%)`);
  }

  // One step of the hand-back: an owed item to its slot, or the heart to the pack.
  function handBack(plan, t) {
    if (!claimItem(host, OWNER)) return;
    const sent = plan.kind === "unwield" ? call(host, "UnwieldItem", plan.item) : call(host, "WieldItem", plan.item, plan.mask);
    if (sent !== true) {
      releaseItem(host, OWNER);
      park(st.itemParkUntil, st.itemFails, plan.item, t);
      if (st.itemFails.get(plan.item) >= T.HAND_BACK_TRY_LIMIT) giveUp(plan.item, plan.kind);
      return;
    }
    if (keep.saved) keep.saved.started = true;
    st.inFlight = { kind: plan.kind, item: plan.item, at: t, seq: st.sigSeq };
    st.lastAction = { kind: plan.kind, item: plan.item, at: t };
    log(plan.kind === "unwield" ? `the heart ${hex(plan.item)} back to the pack` : `handing back ${hex(plan.item)} (slot 0x${plan.mask.toString(16)})`);
  }

  // JumpOutWandCasting: due on a later heartbeat, when the client can jump.
  function jumpStep(t) {
    const j = st.jump;
    if (!j || t < j.at) return;
    if (t > j.until || inPortal(host)) {
      st.jump = null;
      return;
    }
    if (call(host, "CanJumpNow") === false) return;
    st.jump = null;
    if (call(host, "Jump", T.JUMP_POWER) === true) {
      st.jumps++;
      st.lastAction = { kind: "jump", at: t };
    }
  }

  function act(plan, t) {
    switch (plan.kind) {
      case "wield":
        return wieldHeart(plan, t);
      case "heart":
        return useHeart(plan, t);
      case "cast":
        return castAt(plan, t);
      case "handBack":
      case "unwield":
        return handBack(plan, t);
      case "magic": {
        call(host, "ChangeCombatMode", MODE_MAGIC);
        st.modeAt = t;
        st.magicAttempts++;
        if (st.magicAttempts > T.MAGIC_MODE_ATTEMPT_LIMIT) {
          st.magicParkUntil = t + T.MAGIC_MODE_PARK_MS;
          st.magicAttempts = 0;
          log(`give up entering Magic mode after ${T.MAGIC_MODE_ATTEMPT_LIMIT} attempts — parked ${T.MAGIC_MODE_PARK_MS / 1000}s`);
        }
        return;
      }
      default:
        return; // "wait": hold the tick while the mode change lands
    }
  }

  const slot = {
    name: "Helpers",
    rank: "afterVitals",
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
    wants: () => {
      try {
        if (!enabled()) return false;
        if (pinned()) return true;
        return !!cachedPlan(now());
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick: () => {
      try {
        const t = now();
        resolve(t);
        jumpStep(t);
        if (st.inFlight || st.jump) return; // waiting for the server's answer / the jump
        const plan = cachedPlan(t);
        st.plan = null;
        if (plan) act(plan, t);
      } catch (e) {
        log(`tick threw: ${errText(e)}`);
      }
    },
    onLeave: () => {},
    get status() {
      return status();
    },
  };

  // The VT post-tick (also while operator-held): the vitals stream hold, and
  // the appraisal of an Items-tab heart nobody looked at yet.
  const reflex = {
    name: "Helpers",
    enabled: () => {
      try {
        return !st.disposed && (st.holding || helpWanted(now()));
      } catch (_) {
        return false;
      }
    },
    tick(nowMs, info = {}) {
      try {
        if (st.disposed) return;
        const t = Number.isFinite(nowMs) ? nowMs : now();
        const held = !!(info && info.held);
        syncHold(t, held);
        if (!held && st.holding && optBool(options, "UseHealersHeart", true)) appraiseHearts(t);
        for (const m of [st.paced, st.backoff, st.demoted, st.itemParkUntil, st.heartParkUntil]) for (const [k, u] of m) if (u <= t) m.delete(k);
      } catch (e) {
        log(`reflex threw: ${errText(e)}`);
      }
    },
  };

  /** A heart swap holds the wand slot until its debt is handed back. */
  function holdsWandSlot() {
    return !!keep.saved;
  }

  function status() {
    const t = now();
    const f = st.inFlight;
    return {
      enabled: (() => {
        try {
          return enabled();
        } catch (_) {
          return false;
        }
      })(),
      holding: st.holding,
      fresh: fresh(t),
      inFlight: f ? { kind: f.kind, target: f.target || 0, item: f.item || 0, spellId: f.spellId || 0, at: f.at } : null,
      jumpPending: !!st.jump,
      lastAction: st.lastAction,
      casts: st.casts,
      heartUses: st.heartUses,
      heartFails: st.heartFails,
      jumps: st.jumps,
      handBack: keep.saved ? { heart: keep.saved.heart, items: keep.saved.items.map((x) => x.guid) } : null,
      castBlocked: st.castBlock && st.castBlock.until > t ? st.castBlock.reason : null,
      backedOff: [...st.backoff].filter(([, u]) => u > t).map(([k]) => String(k)),
    };
  }

  function dispose() {
    if (st.disposed) return;
    st.disposed = true;
    release();
    st.jump = null;
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  return { slot, reflex, status, dispose, holdsWandSlot, _state: st };
}

export default createHelpers;
