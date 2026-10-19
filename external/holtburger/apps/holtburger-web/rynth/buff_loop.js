// RynthBuffLoop — Phase-3 self-buff maintenance on the RynthWebHost seam.
//
// A faithful subset of RynthAi's BuffManager contract as extracted in
// docs/rynth-integration/workflow-reports/11.md §buffs (B-rules). Implemented:
//   B1  login-stabilization gate (registry count stable across two
//       consecutive 1 s reads, or 20 s max wait) — never buff a
//       half-streamed registry.
//   B2  expiry truth = player enchantment registry keyed by FAMILY
//       (spell_category), remaining = (duration + start_time) − elapsed
//       since receipt (start_time is RELATIVE ≤ 0: 0 at cast, −age when
//       re-sent aged — ACE EnchantmentManager.cs:188).
//   B3  rebuff threshold: active while remaining > 300 s (uniform — the
//       1200 s batch override in the source is a stale comment).
//   B6  permanent enchants (remaining > 1 year) = presence-only.
//   B8  self-buff confirmation by registry re-read at 600 ms; give up at
//       2500 ms (then B9).
//   B9  silent-no-show valve: 2 consecutive no-shows parks the family
//       (30 min contract value; configurable for tests).
//   B13 30 s periodic full re-sync (death/dispel recovery).
//   B14 pacing: 400 ms cast interval + the cast/busy gates.
//   B4  tier-upgrade: a desired buff is resolved to the highest-tier spell
//       in its family the character knows (via spell_ladders.json).
//   B5  incantation tier-cap: cap the target at the tier OUR OWN cast was
//       seen landing at when it landed BELOW the cast tier, and the upgrade
//       test at the highest tier seen landing at all (skill-capped
//       incantations don't recast forever chasing their nominal tier).
//   B10 hard-reject cooldown: a family that can't land is parked 120s and
//       the batch respects it. B11 auto batch-rebuff: any buff below
//       threshold recasts ALL buffs in one pass (aligned timers). B12 force
//       rebuff ignores live timers (recast everything to a common start).
//   B7  item enchants (Impen/Banes): live on the item, absent from the
//       player registry, duration not client-readable — recast on an
//       interval, confirmed ONLY by the "You cast <spell> on <item>" chat
//       line off the push-event plane (never optimistic).
// B15/B16 vital policy lives in vitals.js. The report-11 buff contract is
// complete.
//
// netwasm-parity fixes (b5.md, 2026-07-16) — each cites C# BuffManager.cs:
//   finding 1  B11: _anyBelowThreshold now SKIPS parked families (:824-827)
//              so a can't-land parked buff no longer livelocks the batch.
//   finding 2  B13/B3: families store ABSOLUTE expiry timestamps (live
//              remaining, :1216) + kernel-driven heartbeat() re-sync, so the
//              kernel gate no longer starves rebuffs on expiry/death.
//   finding 3  B4: _isActiveReal upgrade-recasts an active LOWER-tier family
//              (:1207-1215).
//   finding 4  B8: pending casts confirm by FAMILY, not spell id (:555-556) —
//              a skill-capped incantation landing lower no longer no-shows.
//   finding 5  B9: a silent no-show tier-WALKS-DOWN to the next known tier
//              (:566-573) instead of parking unbuffed.
//   finding 9  B8×B3: a sub-threshold-duration buff confirms (no false
//              no-show) and is held active (no infinite rebatch).
//   finding 10 B2: same-family wire rows keep the LATER expiry (JS-defensible;
//              C# keeps last, :1374) — CONFIRMED no change.
//
// 2026-10-12 client-drift update (the cast pipeline moved under this loop):
//   * Casts no longer leave the wasm when CastSpell returns: on the default
//     `?cmdInterp` lane both cast arms queue retail MaybeStopCompletely and
//     send the request after the NEXT movement tick's stop flush
//     (src/session/commands/combat.rs, 457f9de1/fef31a95). The tick is driven
//     by the page's frame pump, so a cast reaches ACE a frame later in a
//     visible tab — and never in a hidden tab with no `?netDrainHz` (the
//     host-side pump request in the 2026-10-12 report).
//   * B8 no longer gives up on a blind 2.5 s clock. ACE plays every windup and
//     the cast gesture at CastSpeed 2.0 (Player_Magic.cs:603) before the
//     enchantment lands: half the ladder takes longer than 2.5 s and every
//     level-8 Incantation ~7 s (data/spell-cast-sequence.json). A long cast
//     read as a silent no-show and walked the family DOWN a tier. Pending
//     casts now resolve on ACE's own answer — the enchantment in the registry,
//     a refusal code on the push plane (kind 13), or UseDone with nothing
//     landed — with a 12 s cap for a lost UseDone.
//   * Refusals are classified (castRefusalClass): missing components park all
//     self-buffing, no mana backs off, busy/in-air retries; none of them is a
//     tier problem any more. Fizzles walk a tier only after three in a row.
//   * SelfTargeted spells are cast TARGETED at the player's own guid, the
//     retail shape: ACE's untargeted handler lands the enchantment but never
//     broadcasts its TargetEffect glow (ui/ac_cast_spell.js selfTargetGuidFor).
//   * The wasm now refuses setCombatMode(Magic) locally when no caster is
//     wielded and prints "You must wield a wand, orb, or staff…" each time —
//     the Magic-entry retries check the wielded caster first instead of
//     spamming that line five times per park cycle.
//   * spell_ladders.json tiers are scarab levels (7 = lore, 8 = Incantation,
//     unreachable before) and B4 ladders enchantments only — see
//     rynth_spell_ladders_test.cjs for the table contract.
//   * playerEnchantments() rows are wasm boxes: copied and freed here.
//   * No cast starts in portal space (portal_gate.js — ACE refuses casts while
//     teleporting, and the tunnel can hold up to 80 s on a cold interior).
//   * Self-targeted casts never turn the caster: ACE skips the rotate for
//     TargetCategory.Self and IsWithinAngle(self) is 0 (Player_Magic.cs:148,
//     :721), so they don't replace a client MoveTo the way a targeted cast at
//     another object does (move fork contract note, 2026-10-12).
//
// Tier lock fix (rynth-macro-nav-1, 2026-10-13):
//   * B5 was seeded from EVERY registry row on the first refresh — the login
//     snapshot included — and _buildLadders caps the cast target with it, so a
//     lower tier standing at login re-resolved `desired` down to that tier and
//     the family never upgraded for the life of the bot (nor after a relog: the
//     old tier is rebuffed before it lapses). Registry rows now feed only the
//     _isActiveReal flap guard (_familySeenTier — C# IsBuffActive, so the
//     upgrade waits for the old tier's rebuff window); the ladder cap is learned
//     only from our own cast landing below its cast tier (_recordOwnLanding).
//   * B8 confirm of an UPGRADE over a lower tier: the family-keyed confirm read
//     the old entry as the new landing, so a fizzled upgrade "confirmed" at
//     600 ms and its fizzles never counted. The pending cast now remembers the
//     entry it was cast over (pending.prior) and waits while that one stands.
//     B2 keeps the LATER-expiry row per family, so a prior that outlives the
//     upgrade (a permanent item V, a fellow's longer V) still stands after the
//     upgrade LANDS; then the cast's own row is the landing when it was first
//     stamped after the send, or stands and ACE answered clean (its successful
//     UseDone, no refusal — a same-spell refresh is never re-stamped). It used
//     to read as a silent no-show and walk the tier off for good (review
//     Y-R1). _isActiveReal likewise judges a desired spell standing UNDER such
//     a lower tier by its own row, not as an upgrade to recast every tick.
//   * A tier walked down after FIZZLE_WALK_LIMIT fizzles comes back on the
//     ladder after FIZZLE_WALK_RETRY_MS (fizzles are odds, not a ceiling; C#
//     retries them with no blacklist, BuffManager.cs:570). Unknown-spell and
//     silent no-show walks stay permanent.
//
// Opt-in skill cap (rynth-macro-nav-4, 2026-10-13; opts.skillCap /
// setSkillCap, off by default): B4 resolves each family to the highest known
// tier the buffed skill of the spell's school reaches (skill_cap.js; RynthAi
// GetDynamicSelfBuffId starts at GetHighestBuffSpellTier). ACE fails a cast
// outright below Power − 50 and rolls a 0.07 sigmoid above it, and any trained
// character can learn a level 7/8 scroll, so the highest KNOWN tier is often
// one it can't cast before Focus / Willpower / its masteries land — each
// fizzle burned mana and 3-7 s until the walk. No known tier within the cap
// keeps today's pick. When a school's castable tier moves the ladders are
// re-resolved; a rise also returns that school's fizzle-walked tiers it now
// covers (_checkSkillCap).
//
// Scroll ladder (2026-10-19, owner report "the buff list contains spells
// players shouldn't normally be able to cast"): a SpellCategory holds the
// normal scroll ladder AND quest / NPC / potion spells, and ACE's
// @addallspells (PlayerSpellTable) grants several of the latter. B4's
// best-(tier, Power) pick then preferred them on a dev character — Zongo's
// Fist (VII, Power 420, 3 h) over Might of the Lugians (VII, 300); under a
// skill cap or a fizzle walk, Combat Medication / Zombies Persistence (60 s
// spells, recast every minute) over Robustify / Regeneration Self VI. RynthAi
// never could: its resolver is NAME-based (GetDynamicSelfBuffId). Now
// spell_ladders.json marks each bot family's scroll ladder (flag bit 2,
// derived and checked by rynth_spell_ladders_test.cjs; families in
// buff_families.js) and
//   * buildDynamicBuffList and the B4 resolution use ladder members only
//     (_ladderRungs): never a spell off the ladder while a ladder member is
//     known. A family whose only known members are off the ladder is skipped
//     by the dynamic list, and an explicit ladder request for it is dropped
//     by filterCastableBuffs (nothing on the ladder to cast).
//   * A desired id OFF the ladder (a ?botBuffs= / bot.setBuffs() / saved-list
//     pick) is an explicit pin: cast exactly as named while it is known — no
//     tier upgrade, no skill cap. When it is unknown, or walked off by the
//     fizzle / unknown-spell / no-show valves, the family falls back to its
//     ladder at or below the pin's tier (a walk never goes up); the fizzle
//     walk's 10-minute retry brings the pin back.
//   * Families without ladder data (outside buff_families.js, or a table
//     baked before 2026-10-19) resolve exactly as before.
//   * Same-tier ladder copies resolve by Power, then the copy a scroll
//     teaches, then the lower id (deterministic for the five "Light Weapon
//     Mastery Self VII" ids).
// The pickers read the same data: canonicalBuffFamilies() (one row per
// family, HUD Settings), buffFamilyInfo / BUFF_GROUPS / isCanonicalBuff /
// canonicalTier / canonicalLadder / buffFamilyOf (VT Buffs tab), and
// toLadderSpec() moves a family-selector spec saved from the old list onto
// the ladder (else its off-ladder ids would read as pins).
//
// B11/B12 pass end (2026-10-19): heartbeat() ends a batch / Force pass once
// every desired buff is recast or parked (_endFinishedPass). Only tick() used
// to, and the kernel gives the loop no tick then (all read active), so the
// pass stayed open and no buff was ever recast again.
//
// Worn armor (2026-10-19, the VTank options BuffArmorImpen / BuffProfileBanes
// made live). They are read through `optFn`, the VT layer's option reader
// (rynth/vt/index.js binds it; absent without the layer, ?botVt=off — and then
// nothing in this paragraph applies, B7 is exactly as before):
//   * Impenetrability or a bane cast on YOURSELF lands on every enchantable
//     armor and clothing piece you wear and on your shield (ACE
//     WorldObject_Magic.cs TryCastItemEnchantment_WithRedirects), so worn
//     armor is one B7 cast per family at our own guid, at the best tier in the
//     spellbook (_wornArmor), after the self buffs (RynthAi step 7) and before
//     the Items tab's casts — of which an EQUIPPED shield's are dropped for
//     the families the worn casts cover (_itemPass).
//   * B7 runs only inside a buff tick, and the kernel stops ticking this loop
//     once every SELF buff is up (kernel.js _buffNeeded), so an item enchant
//     was cast at login and then only when a self buff happened to be
//     missing. With the layer, status counts the item enchants as buffs — a
//     due one keeps the kernel on Buffing like a self buff — and so:
//   * an item cast resolves on ACE's own answer (its UseDone; the "You cast …
//     on <item>" lines come before it) instead of a flat 5 s, and one that
//     enchanted nothing, fizzled FIZZLE_WALK_LIMIT times in a row (a worn
//     family steps a tier down meanwhile) or was refused for its spellbook /
//     place is held (_itemNoLine, _holdRefusedItem) rather than recast every
//     few seconds with the bot parked on Buffing; a busy / in-the-air refusal
//     backs off TRANSIENT_BACKOFF_MS;
//   * Force Buff recasts the item enchants too, and the B3 threshold and the
//     idle-rebuff window move their recast point (_itemRecastAfterMs).

import { portalSpaceActive } from "./portal_gate.js";
import { buffSchoolOf, capRose, capsBySchool } from "./skill_cap.js";
import {
  SKILL,
  BASE_CREATURE_BUFFS,
  SKILL_BUFFS,
  LIFE_BUFFS,
  AURA_BUFFS,
  BUFF_FAMILY_ORDER,
  LADDER_FLAG_SELF_TARGETED,
  LADDER_FLAG_ENCHANTMENT,
  LADDER_FLAG_SCROLL,
  ROMAN,
  buffFamilyInfo,
  rowCanonical,
  rowIsEnchantment,
  rungOrder,
  canonicalLadderOf,
  bestKnownByFamily,
} from "./buff_families.js";

// The family catalogue and its display info live in buff_families.js (pure —
// the ladder generator imports it too); re-exported here because buff_loop.js
// is what the bot, the HUD bridge and the VT bridge load.
export {
  BASE_CREATURE_BUFFS,
  SKILL_BUFFS,
  LIFE_BUFFS,
  AURA_BUFFS,
  BUFF_GROUPS,
  BUFF_FAMILY_ORDER,
  buffFamilyInfo,
  buffFamilies,
} from "./buff_families.js";

// Lazy-loaded family tier ladder (id -> [category, tier, flags, power],
// self-beneficial spells, baked from the spell DAT — rynth_spell_ladders_test
// .cjs documents and checks the shape). Shared across all buff-loop instances.
let LADDER_TABLE = null;
let LADDER_PROMISE = null;
// Module-relative by default: the old "/apps/holtburger-web/rynth" literal
// only resolved when the page was served from the holtburger repo root, and
// a 404 silently emptied the table (no B4/B5, no self-target flags).
export function loadSpellLadders(base) {
  if (LADDER_TABLE) return Promise.resolve(LADDER_TABLE);
  if (!LADDER_PROMISE) {
    const url = base ? `${String(base).replace(/\/$/, "")}/spell_ladders.json` : new URL("./spell_ladders.json", import.meta.url).href;
    LADDER_PROMISE = readLadderTable(url)
      .then((t) => (LADDER_TABLE = t && typeof t === "object" ? t : {}))
      .catch(() => (LADDER_TABLE = {}));
  }
  return LADDER_PROMISE;
}

async function readLadderTable(url) {
  // Node (tests, harness tools) has no fetch for file: URLs — also under a
  // fake DOM that defines `window` (tests/rynth_hud_dom.test.mjs).
  const node = typeof process !== "undefined" && !!(process.versions && process.versions.node);
  if (url.startsWith("file:") && (node || typeof window === "undefined")) {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(new URL(url), "utf8"));
  }
  const r = await fetch(url);
  return r.ok ? r.json() : {};
}

const LOGIN_REFRESH_MAX_WAIT_MS = 20_000; // B1
const REBUFF_SECONDS_REMAINING = 300; // B3
const SELF_BUFF_CONFIRM_MS = 600; // B8
const SELF_BUFF_GIVE_UP_MS = 2500; // B8
const SILENT_NO_SHOW_THRESHOLD = 2; // B9
const SILENT_NO_SHOW_COOLDOWN_MS = 30 * 60_000; // B9
const PERIODIC_REFRESH_INTERVAL_MS = 30_000; // B13
const SPELL_CAST_INTERVAL_MS = 400; // B14 (buffing is faster than combat)
const PERMANENT_SENTINEL_S = 86_400 * 365; // B6
// Magic-mode entry give-up valve (02 C1 / synthesis #11) — see vitals.js's
// matching comment: toggleCombatMode() never yields Magic(8) for a
// melee/archer character, so entering Magic to self-buff is now an
// EXPLICIT ChangeCombatMode(8), bounded by attempts so a genuine non-caster
// (refused locally by the wasm's own is_wielding_caster gate, lib.rs:45179)
// parks instead of retrying forever.
const MAGIC_MODE_ATTEMPT_LIMIT = 5;
const MAGIC_MODE_PARK_MS = 15_000;
// EquipMask::CASTER (holtburger-common properties/inventory.rs) — the bit the
// wasm's local set(Magic) gate tests (holtburger-world context.rs
// is_wielding_caster / get_suggested_combat_mode).
export const EQUIP_CASTER = 0x01000000;

/** Is a caster (wand/orb/staff) wielded? true/false off the inventory's equip
 *  masks; null when the host can't say (no inventory capability, nothing
 *  streamed yet) — callers treat null as "try anyway". The ONE copy: vitals.js
 *  and buff_loop.js both gate their Magic-mode entry on it (the wasm refuses
 *  set(Magic) locally without a caster and prints its refusal every time). */
export function casterWielded(host) {
  if (!host || typeof host.TryGetPlayerInventory !== "function") return null;
  let inv;
  try {
    inv = host.TryGetPlayerInventory();
  } catch (_) {
    return null;
  }
  if (!Array.isArray(inv) || inv.length === 0) return null;
  return inv.some((it) => ((Number(it?.equipMask) >>> 0) & EQUIP_CASTER) !== 0);
}

// B8 resolution (2026-10-12). ACE answers every cast request with exactly one
// UseDone — after FinishCast on success (the enchantment is applied BEFORE it,
// in DoCastSpell_Inner), immediately on a refusal. Wait for that answer
// instead of a fixed clock; the grace covers the registry update trailing the
// UseDone on the wire. The cap outlasts the longest ladder cast (~8.1 s of
// windups + gesture at CastSpeed 2) plus a round trip.
const SELF_BUFF_USE_DONE_GRACE_MS = 750;
const SELF_BUFF_HARD_CAP_MS = 12_000;
// C# polls the registry at most every 250 ms while a cast settles
// (BuffManager.cs:551); every read builds one wasm box per enchantment.
const SELF_BUFF_POLL_MS = 250;
const FIZZLE_WALK_LIMIT = 3;
// A fizzle-walked tier is retried after this long — the combat planner's
// EXCLUDE_MS (vt/combat/attack_planner.js). Three fizzles in a row are bad
// luck at skill ≈ power (ACE SkillCheck sigmoid), not a skill ceiling.
const FIZZLE_WALK_RETRY_MS = 10 * 60_000;
// Slack for "the lower-tier entry an upgrade was cast over still stands": ACE
// ticks StartTime down in 5 s heartbeats (EnchantmentManager.HeartBeat), so a
// re-sent aged row can move the computed expiry by up to one heartbeat.
const UPGRADE_PRIOR_SLACK_MS = 5_000;
const COMPONENTS_PARK_MS = 5 * 60_000;
const MANA_BACKOFF_MS = 15_000;
const TRANSIENT_BACKOFF_MS = 1_000;
const PLACE_PARK_MS = 60_000;
// Layer B7 (header, "Worn armor"): an item cast that enchanted nothing is
// retried after this long; silent twice in a row it waits noShowCooldownMs
// (B9's two strikes).
const ITEM_SILENT_RETRY_MS = 60_000;
// ACE ItemType Armor (shields too) | Clothing — the worn pieces a self-cast
// Impenetrability / bane enchants (WeenieType Clothing or a shield).
const ITEM_TYPE_WORN = 0x2 | 0x4;
// The worn-armor casts re-read the spellbook and the inventory at most this often.
const WORN_REFRESH_MS = 1_000;

// WeenieError codes a cast request can come back with (holtburger-protocol
// errors.rs; ACE Player_Magic.cs SendUseDoneEvent / SendWeenieError sites).
// They arrive as kind=13 UseFailed events with the code in u32Payload — UseDone
// (error) and the fizzle's WeenieError message both route there
// (src/session/messages/game_event.rs).
const REFUSAL_CLASSES = new Map([
  [0x0400, "components"], // YouDontHaveAllTheComponents
  [0x0401, "mana"], // YouDontHaveEnoughManaToCast
  [0x0402, "fizzle"], // YourSpellFizzled
  [0x0407, "place"], // YourSpellCannotBeCastOutside
  [0x0408, "place"], // YourSpellCannotBeCastInside
  [0x001d, "transient"], // YoureTooBusy (also the queued-behind-a-cast case)
  [0x04eb, "transient"], // YouCantDoThatWhileInTheAir
  [0x042c, "transient"], // TargetNotAcquired (own guid teleporting)
  [0x0498, "transient"], // YouHaveMovedTooFar (PK windup move cap)
  [0x000f, "transient"], // BadCast
  [0x03fc, "unknown-spell"], // MagicInvalidSpellType — not in the spellbook
]);

/** Class of a cast refusal code: "components" | "mana" | "fizzle" | "place"
 *  | "transient" | "unknown-spell", or null for a code that isn't a cast
 *  refusal. Shared with vitals.js. */
export function castRefusalClass(code) {
  return REFUSAL_CLASSES.get((Number(code) >>> 0) & 0xffff) ?? null;
}

// Read the player's enchantments as plain rows and free the wasm boxes
// (PlayerEnchantmentJs has a free(); the FinalizationRegistry would get to
// them eventually, but a pending cast re-reads every few ticks — same
// copy-then-free rule webhost.js applies to pose boxes, review F6).
function readEnchantmentRows(s) {
  if (!s || typeof s.playerEnchantments !== "function") return null;
  let raw;
  try {
    raw = s.playerEnchantments() || [];
  } catch (_) {
    return null;
  }
  const rows = [];
  for (const e of raw) {
    try {
      rows.push({
        spellId: Number(e.spellId ?? e.spell_id),
        family: Number(e.spellCategory ?? e.spell_category),
        start: Number(e.startTime ?? e.start_time),
        duration: Number(e.duration),
        layer: Number(e.layer ?? 0) || 0,
      });
    } catch (_) {
      /* one bad row must not drop the read */
    }
    try {
      e?.free?.();
    } catch (_) {
      /* already freed */
    }
  }
  return rows;
}

// B7 confirm line for a NAMED item: ACE WorldObject_Magic.cs:443 "You cast
// <spell> on <target><suffix>", suffix "" | ", surpassing X" | ", refreshing X"
// | ", but it is surpassed by X" (:411-420). The name must end the line or
// precede the suffix comma, so "Shield" never matches "Shield Golem".
// Case-insensitive: an Items-tab name typed by hand may differ in case.
const ITEM_CAST_RE_CACHE = new Map();
function itemCastLine(name) {
  let re = ITEM_CAST_RE_CACHE.get(name);
  if (!re) {
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`^You cast .+ on ${esc}(?:,|\\s*$)`, "i");
    if (ITEM_CAST_RE_CACHE.size > 256) ITEM_CAST_RE_CACHE.clear();
    ITEM_CAST_RE_CACHE.set(name, re);
  }
  return re;
}

// B7 confirm line for a WORN-ARMOR cast (target = ourselves): ACE answers it
// once per enchanted item, "You cast <spell> on <item><suffix>" (the line
// above), so it is matched by the spell's own name — the items are whatever
// is worn — and no other cast's line confirms it.
const WORN_CAST_RE_CACHE = new Map();
function wornCastLine(spellName) {
  let re = WORN_CAST_RE_CACHE.get(spellName);
  if (!re) {
    const esc = String(spellName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    re = new RegExp(`^You cast ${esc} on `);
    WORN_CAST_RE_CACHE.set(spellName, re);
  }
  return re;
}

// The worn-armor families (header, "Worn armor"): [family, VTank bane letter
// (null = Impenetrability, BuffArmorImpen), tier I-VI base name, tier VII
// name, spell ids of tiers I..VIII] in the Buffs tab's column order. The ids
// and names are rynth/vt/data/combat_spells.json "impen" / "bane:<el>" (the
// Items tab's ladders; tests/rynth_buff_worn_armor.test.mjs checks this copy —
// buff_loop.js reads nothing of the VT layer but its options).
const WORN_ARMOR_LADDERS = [
  ["impen", null, "Impenetrability", "Brogard's Defiance", [51, 1482, 1483, 1484, 1485, 1486, 2108, 4407]],
  ["bane:slash", "S", "Blade Bane", "Swordsman's Bane", [37, 1558, 1559, 1560, 1561, 1562, 2094, 4393]],
  ["bane:pierce", "P", "Piercing Bane", "Archer's Bane", [1569, 1570, 1571, 1572, 1573, 1574, 2113, 4412]],
  ["bane:bludgeon", "B", "Bludgeon Bane", "Tusker's Bane", [1511, 1512, 1513, 1514, 1515, 1516, 2098, 4397]],
  ["bane:fire", "F", "Flame Bane", "Inferno's Bane", [1547, 1548, 1549, 1550, 1551, 1552, 2102, 4401]],
  ["bane:cold", "C", "Frost Bane", "Gelidite's Bane", [1523, 1524, 1525, 1526, 1527, 1528, 2104, 4403]],
  ["bane:lightning", "L", "Lightning Bane", "Astyrrian's Bane", [1535, 1536, 1537, 1538, 1539, 1540, 2110, 4409]],
  ["bane:acid", "A", "Acid Bane", "Olthoi's Bane", [1493, 1494, 1495, 1496, 1497, 1498, 2092, 4391]],
];

/** The worn-armor families: { family, letter, rungs: [{ id, tier, name }] }
 *  (tiers ascending; `letter` null for Impenetrability). Frozen. */
export const WORN_ARMOR_FAMILIES = Object.freeze(
  WORN_ARMOR_LADDERS.map(([family, letter, base, vii, ids]) =>
    Object.freeze({
      family,
      letter,
      rungs: Object.freeze(
        ids.map((id, i) =>
          Object.freeze({ id, tier: i + 1, name: i === 7 ? `Incantation of ${base}` : i === 6 ? vii : `${base} ${ROMAN[i + 1]}` })
        )
      ),
    })
  )
);
const WORN_FAMILY_OF = new Map(WORN_ARMOR_FAMILIES.flatMap((f) => f.rungs.map((r) => [r.id, f.family])));

// VTank's bane letters in its order, and its BuffProfile_Banes enum (1 =
// Custom: the letters themselves).
const BANE_LETTERS = "ALFCBPS";
const BANE_ENUM = Object.freeze({ 2: "ALFCBPS", 3: "", 4: "B", 5: "BPS", 6: "BPSA", 7: "BPSAC", 8: "ALFC" });

/** A bane profile as VTank writes it — its enum 2-8, All / None, or letters in
 *  any case / order / separators — → canonical letters ("" = none); null for
 *  anything else. A copy of rynth/vt/settings/schema.js baneLetters (the
 *  BuffProfileBanes codec; buff_loop.js imports nothing of rynth/vt), so a
 *  value stored before the codec ("Banes1", "All", "2") reads as the codec
 *  would read it; tests/rynth_buff_worn_armor.test.mjs keeps the two in step. */
export function baneLetters(raw) {
  if (raw === null || raw === undefined || typeof raw === "object") return null;
  if (typeof raw === "boolean") return raw ? BANE_LETTERS : "";
  const s = String(raw).trim();
  if (!s || /^none$/i.test(s)) return "";
  if (/^all$/i.test(s)) return BANE_LETTERS;
  let n = null;
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(s)) n = Number(s);
  else if (/^[+-]?0x[0-9a-f]+$/i.test(s)) n = (s.startsWith("-") ? -1 : 1) * parseInt(s.replace(/^[+-]/, ""), 16);
  if (n !== null) return Object.prototype.hasOwnProperty.call(BANE_ENUM, n) ? BANE_ENUM[n] : null;
  const up = s.toUpperCase().replace(/[\s,;+]/g, "");
  if (!/^[ALFCBPS]+$/.test(up)) return null;
  return [...BANE_LETTERS].filter((c) => up.includes(c)).join("");
}

// serde_wasm_bindgen hands getSpellRecord back as a Map; older bundles and
// test fakes use plain objects.
function recordField(rec, key) {
  if (!rec) return undefined;
  return rec instanceof Map ? rec.get(key) : rec[key];
}

export class RynthBuffLoop {
  /**
   * @param host RynthWebHost
   * @param desiredSpellIds self-buff spell ids to maintain (filtered to the
   *        known-spell book at start)
   */
  constructor(host, desiredSpellIds, opts = {}) {
    this.host = host;
    // The caller names a buff by ANY spell in its family (e.g. "Strength
    // Self I"); B4/B5 upgrade it to the highest known+castable tier at
    // start. `tierLadders` OFF (opts.tierLadders===false) keeps the exact
    // ids (pre-B4 behavior).
    this.rawDesired = desiredSpellIds.slice();
    this.tierLadders = opts.tierLadders !== false;
    this.desired = desiredSpellIds.slice(); // resolved lazily on first tick
    this._laddersBuilt = false;
    this._familyOfSpell = new Map(); // spellId -> category
    // B5, two maps (rynth-macro-nav-1):
    //   _familyAchievedTier  category -> tier our own cast landed at below its
    //                        cast tier (_recordOwnLanding). The LADDER cap:
    //                        _buildLadders never targets above it.
    //   _familySeenTier      category -> highest tier seen in ANY registry row
    //                        (C# RecordAchievedTier). Only the _isActiveReal
    //                        upgrade flap guard reads it, never the target.
    this._familyAchievedTier = new Map();
    this._familySeenTier = new Map();
    this._spellTier = new Map(); // spellId -> roughLevel
    // B9 tier-walk-down (finding 5): spell ids that silently no-showed are
    // marked unresolvable and excluded from the ladder, so the family
    // re-resolves to the next lower known tier instead of parking unbuffed.
    this._unresolvable = new Set();
    // spellId -> ts: the fizzle-walked members of _unresolvable, which go
    // back on the ladder at ts (FIZZLE_WALK_RETRY_MS). Ids absent here stay.
    this._unresolvableUntil = new Map();
    // B8×B3 (finding 9): families whose buff confirmed landing but whose
    // natural duration is below the rebuff threshold — held "active" while
    // present so the batch doesn't rebatch them forever.
    this._shortDurationFamilies = new Set();
    this.log = opts.log || ((m) => console.log(`[buff] ${m}`));
    this.noShowCooldownMs = opts.noShowCooldownMs ?? SILENT_NO_SHOW_COOLDOWN_MS;
    // B1 state
    this.registryReady = false;
    this.startedAt = 0;
    this.lastCount = -1;
    this.lastCountAt = 0;
    // B2 state: family -> { spellId, remainingS, permanent } (refreshed)
    this.families = new Map();
    // spellId -> its later-expiry TIMED row of the last read, with receivedAtS
    // (the B2 receivedAt stamp): a spell standing under a longer-lived lower
    // tier the family map keeps instead (Y-R1 — _ownLanding, _isActiveReal).
    this._spellRows = new Map();
    this.spellFamily = new Map(); // spellId -> family (learned from landings)
    this.lastRefreshAt = 0;
    // B8/B9 state
    this.pending = null; // { spellId, issuedAt, …, prior? } (prior: _upgradeFrom)
    this.noShows = new Map(); // spellId -> consecutive count
    this.parkedUntil = new Map(); // spellId -> ts
    this.lastCastAt = 0;
    this.allActiveSince = 0;
    // B10-B12 batch rebuff state.
    this.batchRebuff = opts.batchRebuff !== false; // on by default
    this._forceRebuffing = false; // B11 — recast everything this pass
    this._forceRebuffCast = new Set(); // B12 — families recast this cycle
    this._rejectParkedUntil = new Map(); // family -> ts (B10, 120s)
    // B7 item enchants — [{ spellId, itemGuid }]. Item buffs live on the
    // item, are ABSENT from the player enchantment registry, and their true
    // duration is not client-readable (VTank couldn't read it either), so
    // they are recast on an interval and confirmed ONLY by chat ("You cast
    // <spell> on <item>") — never optimistically (an optimistic timer left a
    // phantom "active" buff whenever a cast silently failed).
    this.itemBuffs = (opts.itemBuffs || []).slice();
    this.itemRecastMs = opts.itemRecastMs ?? 25 * 60_000; // conservative
    // VTank layer hooks (PLAN §3.14; inert at their defaults):
    //   rebuffSecondsRemaining  the B3 threshold (VTank RebufTimeRemainingSeconds,
    //                           a live settings cell); 300 = REBUFF_SECONDS_REMAINING.
    //   idleRebuffWindowS       extra seconds added to the threshold in
    //                           _isActiveReal ONLY — the "Rebuff When Idle" slot
    //                           raises it for exactly one tick() and restores 0;
    //                           capped per family at half the landed duration
    //                           (_idleWindowFor).
    this.rebuffSecondsRemaining = opts.rebuffSecondsRemaining ?? REBUFF_SECONDS_REMAINING;
    this.idleRebuffWindowS = 0;
    //   skillCap                fn(school) -> highest castable level (skill_cap.js
    //                           createHostSkillCap; RynthAi BuffMinSkillLevelTierN),
    //                           or null = the highest known tier (setSkillCap).
    this.skillCap = typeof opts.skillCap === "function" ? opts.skillCap : null;
    this._skillCapsBuilt = null; // capsBySchool() the ladders were built under
    this._schoolOf = new Map(); // spellId -> MagicSchool (memo, skill cap only)
    this._itemLastCast = new Map(); // "spellId:itemGuid" -> confirmed ts
    this._itemPending = null; // { spellId, itemGuid, issuedAt }
    //   optFn                   key -> the VT option's value (VtOptions.getValue),
    //                           bound by rynth/vt/index.js; null without the
    //                           layer. Worn armor and the layer's B7 bookkeeping
    //                           below exist only with it (header, "Worn armor").
    this.optFn = null;
    this._itemHeldUntil = new Map(); // "spellId:itemGuid" -> ts (a silent / refused item cast)
    this._itemSilent = new Map(); // "spellId:itemGuid" -> silent casts in a row
    this._itemFizzles = new Map(); // "spellId:itemGuid" -> fizzles in a row
    this._wornWalkedUntil = new Map(); // worn rung -> ts: fizzle-walked off its family until then
    this._itemForceAt = 0; // Force Buff: item enchants confirmed before it are recast
    this._wornMemo = null; // _wornArmor's last read
    this._wornUnresolvable = new Set(); // worn rungs ACE refused as not in the spellbook
    this._running = false;
    // 2026-10-12 resolution state.
    this._evtTapped = false; // push-plane subscription (B7 chat + refusals)
    this._lastPendingPollAt = 0;
    this._fizzles = new Map(); // spellId -> consecutive fizzles
    this._backoffUntil = 0; // all self-buffing held (mana / transient)
    this._blocked = null; // { reason, until } — surfaced in status
    this.lastRefusal = null; // { code, cls, spellId, at }
    this._knownCount = -1; // known-book size the ladders were built from
  }

  startOn(host) {
    this._running = true;
    this.startedAt = Date.now();
    if (this.tierLadders) loadSpellLadders(); // kick off the ladder fetch
    this._ensureEventTap();
    host.onTick(() => {
      if (this._running) {
        try {
          this.tick();
        } catch (e) {
          this.log(`tick threw: ${e.message}`);
        }
      }
    });
  }

  // Subscribe to the push-event plane once. The kernel drives this loop
  // through tick() and never calls startOn(), so before 2026-10-12 the B7 chat
  // confirm was never subscribed on the live path; the tap is now ensured from
  // the tick itself.
  _ensureEventTap() {
    if (this._evtTapped) return;
    const h = this.host;
    if (!h || typeof h.onEvent !== "function") return;
    this._evtTapped = true;
    h.onEvent((e) => this._onEvent(e));
  }

  _onEvent(e) {
    if (!e) return;
    if (e.kind === 2) this._onChat(e);
    else if (e.kind === 13) this._onRefusal(e);
    else if (e.kind === 14) this._countUseDone(); // UseDone (success)
  }

  // A SUCCESSFUL UseDone (kind 14) is counted against each cast still pending
  // here. ACE answers every cast with exactly one UseDone — kind 14 on
  // success, or a refusal that the wasm turns into kind 13 (game_event.rs
  // UseDone arm). A fizzle is the exception: DoCastSpell_Inner reports it
  // through a separate WeenieError (also kind 13, game_event.rs WeenieError
  // arm) and the cast's own UseDone (kind 14) FOLLOWS it. So a refusal belongs
  // to the pending buff while no successful UseDone has been counted for it:
  // once our kind 14 has come, the shared cast token is free and any refusal
  // after it is a cast/use some OTHER module issued — vitals, combat, a loot
  // pickup (2026-10-12 review #3: a foreign refusal used to be pinned on the
  // pending buff, and a false "components" held ALL self-buffing for 5 min).
  // A kind 14 counts only once the live UseDone seq has moved past the
  // pending cast's issue-time value: a stale UseDone of an EARLIER action that
  // was still queued when we cast (its seq bump happened before the issue)
  // must not mark our cast answered.
  _countUseDone() {
    const seq = this._useDoneNow();
    for (const p of [this.pending, this._itemPending]) {
      if (!p) continue;
      if (seq != null && p.useDoneAtIssue != null && seq === p.useDoneAtIssue) continue; // pre-issue UseDone
      p.useDoneEvents = (p.useDoneEvents || 0) + 1;
    }
  }

  /** Is this kind=13 refusal the pending cast `p`'s own answer? */
  _refusalIsFor(p, now) {
    if (!p || p.refusal || now < p.issuedAt) return false;
    return (p.useDoneEvents || 0) === 0; // our successful UseDone not seen yet
  }

  // B7 — confirm an item enchant by the server's "You cast <spell> on
  // <target>" line (kind=2 Magic chat). The "on <target>" form is the
  // item/other-target cast; the self form is "You cast X and ...". Only a
  // matching confirmation stamps the timer — never optimistic.
  _onChat(e) {
    if (e.kind !== 2 || !e.text || !this._itemPending) return;
    // An item buff projected by the VT layer carries its item's name (U2 H5):
    // only "You cast <spell> on <that item>[, suffix]" confirms it, so a
    // debuff/other-target line can no longer confirm a pending item enchant.
    // Without a name, today's any-target form. A worn-armor cast is confirmed
    // by the first of its per-item lines, by the spell's name (wornCastLine).
    const p = this._itemPending;
    const itemName = p.itemName;
    const hit = p.worn
      ? wornCastLine(p.spellName).test(e.text)
      : itemName
        ? itemCastLine(itemName).test(e.text)
        : /^You cast .+ on /.test(e.text);
    if (hit) {
      const key = `${p.spellId}:${p.itemGuid}`;
      this._itemLastCast.set(key, Date.now());
      this._itemSilent.delete(key);
      this._itemFizzles.delete(key);
      this.log(`item enchant confirmed: ${e.text.slice(0, 60)}`);
      this._itemPending = null;
      if (typeof this.host.releaseCast === "function") this.host.releaseCast("buff"); // C3 shared serializer
    }
  }

  // A refusal (kind=13, WeenieError code in u32) is ours only while our
  // cast's successful UseDone hasn't come (_refusalIsFor); a cast-class code
  // arriving after it (registry wait, UseDone grace) is another module's and
  // is ignored.
  _onRefusal(e) {
    const cls = castRefusalClass(e.u32);
    if (!cls) return;
    const now = Date.now();
    if (this._refusalIsFor(this.pending, now)) this.pending.refusal = { code: e.u32 >>> 0, cls };
    else if (this._refusalIsFor(this._itemPending, now)) this._itemPending.refusal = { code: e.u32 >>> 0, cls };
  }
  stop() {
    this._running = false;
  }

  /** Replace the desired set at runtime (HUD / director / bot.setBuffs).
   *  B4 re-resolves on the next tick; registry state, parks and learned
   *  tiers are kept. An in-flight cast still resolves normally. */
  setDesired(spellIds) {
    const ids = Array.from(spellIds || [], (n) => Number(n) >>> 0).filter(Boolean);
    this.rawDesired = ids.slice();
    this.desired = ids.slice();
    this._laddersBuilt = false;
    this._forceRebuffing = false;
    this._forceRebuffCast = new Set();
    this.allActiveSince = 0;
    return this.desired.slice();
  }

  /** B12 Force Rebuff (the RynthAi dashboard's "FR" button): recast every
   *  desired buff now, ignoring live timers, to one common start. */
  forceRebuff() {
    this._forceRebuffing = true;
    this._forceRebuffCast = new Set();
    this.allActiveSince = 0;
    this._itemForceAt = Date.now(); // with the layer, the item enchants too (_itemDue)
    this.log("force rebuff: recasting all buffs");
  }

  /** "Cancel Force Rebuff" — back to timer mode; an in-flight cast still
   *  resolves. */
  cancelForceRebuff() {
    this._itemForceAt = 0;
    if (!this._forceRebuffing) return;
    this._forceRebuffing = false;
    this.log("force rebuff cancelled");
  }

  // Resolve a spell to { category, tier }. Prefers the static ladder table
  // (spell_ladders.json — id -> [category, tier], self-beneficial buffs,
  // baked from the spell DAT) because the live SpellCatalog (getSpellRecord)
  // is NOT loaded in a lightweight headless session. Falls back to
  // getSpellRecord when the catalog IS present (full render session).
  // Meta shape: { category, tier, selfTargeted, enchantment, power } — the two
  // booleans are null when the source doesn't say (catalog fallback, or a
  // pre-2026-10-12 two-field table row).
  //   canonical — on its family's normal scroll ladder (flag bit 2); null when
  //               the table has no ladder data for the family (catalog
  //               fallback, a family outside buff_families.js, an old table).
  //   scroll    — taught by a scroll (flag bit 3; the same-tier tie-break).
  _spellMeta(id) {
    const key = String(id >>> 0);
    const t = LADDER_TABLE;
    const row = t && t[key];
    if (row) {
      const flags = row.length > 2 ? Number(row[2]) : null;
      return {
        category: row[0],
        tier: row[1],
        selfTargeted: flags == null ? null : (flags & LADDER_FLAG_SELF_TARGETED) !== 0,
        enchantment: flags == null ? null : (flags & LADDER_FLAG_ENCHANTMENT) !== 0,
        power: row.length > 3 ? Number(row[3]) || 0 : 0,
        canonical: rowCanonical(row, t),
        scroll: flags == null ? false : (flags & LADDER_FLAG_SCROLL) !== 0,
      };
    }
    const s = this.host.s;
    if (s.getSpellRecord) {
      try {
        const r = s.getSpellRecord(id >>> 0);
        const category = recordField(r, "category");
        if (r && category != null) {
          const flags = recordField(r, "flags");
          const self = flags == null ? null : recordField(flags, "selfTargeted");
          return {
            category,
            tier: Number(recordField(r, "roughLevel")) || 0,
            selfTargeted: typeof self === "boolean" ? self : null,
            enchantment: null,
            power: Number(recordField(r, "power")) || 0,
            canonical: null,
            scroll: false,
          };
        }
      } catch (_) {
        /* fall through */
      }
    }
    return null;
  }

  // B4/B5 — build family tier ladders from the known-spell book. For each
  // raw desired buff, find its family (category) and the highest-tier spell
  // in that family the character actually knows; that becomes the target.
  // B5: cap at the tier our own cast was seen landing at below its cast tier
  // (an Incantation nominally tier 8 that lands skill-capped at 6 must not
  // recast forever chasing 8) — _recordOwnLanding. With the opt-in skill cap,
  // the best rung within the cap of its school (header).
  // Scroll ladder (2026-10-19, header): a family with ladder data resolves to
  // its canonical members only. A desired id OFF the ladder is an explicit
  // pin: cast as named while known (no upgrade, no skill cap); once it is
  // unknown or walked off (fizzles / not in the book / silent no-show) the
  // family falls back to its ladder at or below the pin's tier.
  _buildLadders() {
    this._laddersBuilt = true;
    // [War, Life, Item, Creature, Void] castable levels, one read per build.
    const caps = this.skillCap ? capsBySchool(this.skillCap) : null;
    this._skillCapsBuilt = caps;
    const s = this.host.s;
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    this._knownCount = known.length;
    this._builtWithTable = !!(LADDER_TABLE && Object.keys(LADDER_TABLE).length);
    // Index every known ENCHANTMENT by family with its tier. A category can
    // mix kinds (67 = Heal Self boosts + Healing Mastery enchantments): only
    // enchantments land in the registry, so only they may stand in for a
    // desired buff. `enchantment === null` (unknown) stays eligible.
    const byFamily = new Map(); // category -> [{id, tier, power}]
    for (const id of known) {
      if (this._unresolvable.has(id)) continue; // finding 5: skip blacklisted tiers
      const meta = this._spellMeta(id);
      if (!meta || meta.category == null) continue;
      this._familyOfSpell.set(id, meta.category);
      this._spellTier.set(id, meta.tier);
      if (meta.enchantment === false) continue;
      // A SELF-buff family resolves to self spells only: a category shares
      // "Strength Self" with "Strength Other" (catalog fallback rows carry
      // the flag; ladder-table rows are self buffs). An Other spell must never
      // stand in for a desired self buff (2026-10-12 server-crash chain, see
      // _castSelfBuff). Unknown (null) stays eligible — it is cast targeted.
      if (meta.selfTargeted === false) continue;
      if (!byFamily.has(meta.category)) byFamily.set(meta.category, []);
      byFamily.get(meta.category).push({ id, tier: meta.tier, power: meta.power || 0, canonical: meta.canonical, scroll: meta.scroll });
    }
    // Resolve each raw desired buff to the best known tier in its family.
    const knownSet = new Set(known);
    const resolved = [];
    if (!this._ladderLogged) this._ladderLogged = new Map();
    for (const rawId of this.rawDesired) {
      const meta = this._spellMeta(rawId);
      const fam = meta ? meta.category : this._familyOfSpell.get(rawId);
      if (fam == null || !byFamily.has(fam) || (meta && meta.enchantment === false)) {
        resolved.push(rawId); // no ladder data (or not an enchantment) — keep as-is
        continue;
      }
      const pinned = !!meta && meta.canonical === false;
      if (pinned && knownSet.has(rawId) && !this._unresolvable.has(rawId) && meta.selfTargeted !== false) {
        if (this._ladderLogged.get(rawId) !== rawId) this.log(`ladder: ${rawId} kept as named (family ${fam}: off the scroll ladder, an explicit pick)`);
        this._ladderLogged.set(rawId, rawId);
        resolved.push(rawId);
        continue;
      }
      const cap = Math.min(this._familyAchievedTier.get(fam) ?? 8, pinned ? meta.tier : 8);
      // Tier first (C# BuffManager targets the highest LEVEL), Power breaks a
      // same-tier tie — ACE's stacking winner within a category — then the
      // copy a scroll teaches, then the lower id (buff_families.js rungOrder).
      const ladder = this._ladderRungs(byFamily.get(fam), meta)
        .filter((e) => e.tier <= cap)
        .sort((a, b) => b.tier - a.tier || rungOrder(a, b));
      // Opt-in skill cap: the best rung its school's buffed skill reaches
      // (RynthAi GetDynamicSelfBuffId); none within it keeps today's pick.
      const pick = caps ? ladder.find((e) => e.tier <= caps[this._spellSchool(e.id) - 1]) || ladder[0] : ladder[0];
      const best = pick ? pick.id : rawId;
      // Log a resolution once, not on every rebuild (B5 rebuilds after each
      // family's first landing — the same 4 lines used to repeat per confirm).
      if (best !== rawId && this._ladderLogged.get(rawId) !== best) {
        this.log(`ladder: ${rawId} -> ${best} (family ${fam}, tier ${this._spellTier.get(best)})`);
      }
      this._ladderLogged.set(rawId, best);
      resolved.push(best);
    }
    this.desired = resolved;
  }

  // The rungs a desired buff may resolve to among its family's known members
  // (`members`: {id, tier, power, canonical, scroll}). A family with scroll-
  // ladder data never resolves to a spell off the ladder while a ladder member
  // is known — Zongo's Fist (VII, Power 420) used to beat Might of the Lugians
  // (VII, 300), Combat Medication (a 60 s spell) beat Robustify. A ladder
  // request (canonical id) or a pin's fallback with no ladder member known
  // gets none (the raw id is kept). Without ladder data (catalog fallback, a
  // family outside buff_families.js, an older table) every member, as before.
  _ladderRungs(members, rawMeta) {
    const ladder = members.filter((e) => e.canonical === true);
    if (ladder.length) return ladder;
    if (rawMeta && rawMeta.canonical != null) return members.filter((e) => e.canonical == null);
    return members.filter((e) => e.canonical !== false);
  }

  // B5 flap guard — the highest tier each family has been SEEN at in the
  // registry, from any row (C# RecordAchievedTier, BuffManager.cs:1251-1256,
  // fed from RefreshFromLiveMemory :1383). _isActiveReal caps the upgrade test
  // with it, as C# IsBuffActive does (:1207-1209), so a lower tier standing at
  // login is upgraded at its rebuff window rather than at once. It is NOT a
  // ladder cap (rynth-macro-nav-1): it used to be, and a lower tier standing at
  // login re-resolved `desired` down to itself — the higher tier was never cast
  // again to lift the cap, so the family stayed locked for the life of the bot
  // and across relogs. C#'s target resolver (GetDynamicSelfBuffId) never reads
  // it either. The ladders are still rebuilt when a family's seen tier rises,
  // as before (cheap; the V-1 golden replay pins this host-call cadence).
  _recordSeenTiers(reg) {
    if (!reg) return;
    let changed = false;
    for (const [family, entry] of reg) {
      const tier = this._spellTier.get(entry.spellId);
      if (tier == null) continue;
      const prev = this._familySeenTier.get(family) ?? 0;
      if (tier > prev) {
        this._familySeenTier.set(family, tier);
        changed = true;
      }
    }
    if (changed && this.tierLadders) this._buildLadders();
  }

  // The upgrade flap-guard cap for a family: the highest tier observed landing,
  // own skill-capped landing or registry row alike; undefined when neither.
  _flapCap(family) {
    const own = this._familyAchievedTier.get(family);
    const seen = this._familySeenTier.get(family);
    if (own == null) return seen;
    return seen == null ? own : Math.max(own, seen);
  }

  // B5 ladder cap — record the tier OUR OWN confirmed cast landed at, and
  // rebuild the ladders when that sets the cap (rynth-macro-nav-1). Only a
  // landing BELOW the cast tier says the family has a ceiling: the skill-capped
  // Incantation B5 exists for (cast at 8, lands as VI). On ACE a cast lands at
  // its own tier, so no cap is set and the target stays the best known tier.
  // A landing at the cast tier doesn't set it either — after a fizzle walk it
  // would hold the family below the tier that comes back at
  // FIZZLE_WALK_RETRY_MS.
  _recordOwnLanding(fam, castId, entry) {
    if (fam === undefined || !entry) return;
    const landedTier = this._tierOf(entry.spellId);
    const castTier = this._tierOf(castId);
    if (landedTier == null || castTier == null || landedTier >= castTier) return;
    const prev = this._familyAchievedTier.get(fam);
    if (prev != null && prev >= landedTier) return;
    this._familyAchievedTier.set(fam, landedTier);
    this.log(`family ${fam}: cast at tier ${castTier} landed at ${landedTier} — capping its ladder there (B5)`);
    if (this.tierLadders) this._buildLadders();
  }

  // B8 upgrade baseline: when `spellId` is a tier UPGRADE over a lower tier the
  // family already holds, the entry it is cast over ({spellId, expiresAtMs});
  // else null. The confirm is family-keyed, so without it the old entry read
  // as the new landing: a fizzled upgrade "confirmed" at 600 ms, its fizzles
  // never counted toward the walk, and the next tick cast it again.
  _upgradeFrom(spellId, fam) {
    if (fam === undefined) return null;
    const entry = this.families.get(fam);
    if (!entry) return null;
    const castTier = this._tierOf(spellId);
    const heldTier = this._tierOf(entry.spellId);
    if (castTier == null || heldTier == null || heldTier >= castTier) return null;
    return { spellId: entry.spellId, expiresAtMs: entry.expiresAtMs };
  }

  // Is `entry` still the lower-tier entry `prior` the upgrade was cast over
  // (same spell, same expiry within one ACE heartbeat)?
  _isPriorEntry(prior, entry) {
    if (!prior || !entry || entry.spellId !== prior.spellId) return false;
    const a = entry.expiresAtMs;
    const b = prior.expiresAtMs;
    return a === b || Math.abs(a - b) <= UPGRADE_PRIOR_SLACK_MS; // === covers permanent (Infinity)
  }

  // Y-R1 — an upgrade cast over a `prior` that OUTLIVES it (a permanent item V,
  // a fellow's longer V): the landed tier is a second row in the family and B2
  // keeps the prior (later expiry), so the prior still stands after a real
  // landing. The cast's own row is then the landing when
  //   * it first appeared after the cast was sent (a new layer — receivedAt is
  //     stamped on first sight of a spell/layer/start), or
  //   * it stands and ACE answered clean (a same-spell refresh keeps its
  //     spell/layer/start-0 key, so it is never re-stamped): ACE applies the
  //     enchantment BEFORE the cast's successful UseDone (DoCastSpell_Inner,
  //     then FinishCast) and reports a fizzle/refusal ahead of it (kind 13,
  //     _onRefusal) — at the moment a missing landing reads as a no-show (the
  //     same grace / give-up clocks).
  // No row of the cast spell at all is still a silent no-show (B9 walk).
  // Returns that row, or null.
  _ownLanding(p, now, age) {
    const row = this._spellRows.get(p.spellId);
    if (!row || !(this._remainingS(row) > 0)) return null;
    const sent = p.prior ? p.prior.sentAtS : undefined;
    if (typeof sent === "number" && row.receivedAtS > sent) return row;
    if (p.refusal || !((p.useDoneEvents || 0) > 0) || age <= SELF_BUFF_GIVE_UP_MS) return null;
    const answered = p.useDoneAt ? now - p.useDoneAt > SELF_BUFF_USE_DONE_GRACE_MS : p.useDoneAtIssue == null;
    return answered ? row : null;
  }

  // Put fizzle-walked tiers whose retry time has come back on the ladder and
  // re-resolve `desired` (it climbs back to them). Not under an in-flight cast.
  _expireFizzleWalks(now) {
    if (!this._unresolvableUntil.size || this.pending) return;
    let changed = false;
    for (const [id, until] of this._unresolvableUntil) {
      if (now < until) continue;
      this._unresolvableUntil.delete(id);
      this._unresolvable.delete(id);
      changed = true;
      this.log(`tier ${id} back on the ladder (fizzle walk expired)`);
    }
    if (changed && this.tierLadders && this._laddersBuilt) this._buildLadders();
  }

  /** Opt-in skill cap (rynth-macro-nav-4): `fn(school) → highest castable
   *  level` (skill_cap.js createHostSkillCap), or null/absent for today's
   *  highest known tier. The ladders re-resolve at the next tick/heartbeat. */
  setSkillCap(fn) {
    this.skillCap = typeof fn === "function" ? fn : null;
  }

  // MagicSchool of a laddered spell: the live catalog's own `school` when the
  // session has one, else by category (skill_cap.js buffSchoolOf — RynthAi
  // BuffManager.SkillForBuff's split). Memoised; read only under a skill cap.
  _spellSchool(id) {
    let school = this._schoolOf.get(id);
    if (school !== undefined) return school;
    let recSchool = null;
    const s = this.host.s;
    if (s && typeof s.getSpellRecord === "function") {
      try {
        recSchool = recordField(s.getSpellRecord(id >>> 0), "school");
      } catch (_) {
        /* category fallback */
      }
    }
    school = buffSchoolOf(this._familyOfSpell.get(id) ?? this._spellMeta(id)?.category, recSchool);
    this._schoolOf.set(id, school);
    return school;
  }

  // Opt-in skill cap: re-resolve the ladders when a school's castable tier
  // moved since they were built (Focus / Willpower / a mastery landing or
  // lapsing; the host cap re-reads the skills every few seconds). A RISE also
  // returns that school's fizzle-walked tiers it now covers — the odds they
  // were walked under are gone. A tier still above the cap stays walked: back
  // on the ladder it could only become the no-tier-within-cap fallback again.
  // Not under an in-flight cast. A no-op while no cap is set.
  _checkSkillCap() {
    if (!this.tierLadders || !this._laddersBuilt || this.pending) return;
    if (!this.skillCap) {
      if (this._skillCapsBuilt) this._buildLadders(); // switched off: today's pick again
      return;
    }
    const before = this._skillCapsBuilt;
    const after = capsBySchool(this.skillCap);
    if (before && after.every((v, i) => v === before[i])) return;
    if (before) {
      for (const id of [...this._unresolvableUntil.keys()]) {
        const school = this._spellSchool(id);
        const tier = this._tierOf(id);
        if (tier == null || !capRose(before, after, school) || tier > after[school - 1]) continue;
        this._unresolvableUntil.delete(id);
        this._unresolvable.delete(id);
        this.log(`tier ${id} back on the ladder (school ${school} skill tier ${before[school - 1]} -> ${after[school - 1]})`);
      }
    }
    this._buildLadders();
  }

  _readRegistry() {
    // B2: registry truth via the seam's session handle.
    //
    // Time-domain trap (the buffs-hud "bug A1", already solved there):
    // wire start_time is RELATIVE and ≤ 0 (0 at cast, decremented per
    // 5 s heartbeat — ACE PropertiesEnchantmentRegistryExtensions.cs:251
    // — so an aged re-send arrives as −age), NOT epoch seconds of any
    // kind. ACE's remaining formula (EnchantmentManager.cs:188):
    //   ExpiresAt = duration < 0 ? forever
    //             : receivedAt + duration + startTime
    // with receivedAt = OUR wall clock stamped when a given
    // (spellId, startTime) pair first appears; carried forward while
    // startTime is unchanged (recast re-stamps). (P4.2 follow-up F1:
    // the previous `− startTime` sign error made an aged buff's expiry
    // estimate 2×age late.)
    const rows = readEnchantmentRows(this.host.s);
    if (!rows) return null;
    const nowS = Date.now() / 1000;
    const out = new Map();
    const bySpell = new Map(); // -> this._spellRows
    const seen = new Set();
    for (const { spellId, family, start, duration, layer } of rows) {
      // Finding 2: store an ABSOLUTE expiry timestamp (wall-clock ms), NOT a
      // remaining-seconds SNAPSHOT. _isActiveReal/status recompute remaining
      // live against Date.now() every read, so expiry is detected even when
      // the loop hasn't ticked/refreshed in a while (the kernel-gate
      // starvation this fixes: once all-active the loop stops ticking, and a
      // frozen remainingS never crossed the rebuff threshold — BuffManager
      // stores expiry timestamps, BuffManager.cs:1216 `timer.Expiration`).
      let expiresAtMs;
      let permanent = false;
      if (duration < 0 || duration > PERMANENT_SENTINEL_S) {
        expiresAtMs = Infinity; // B6 presence-only
        permanent = true;
      } else {
        const receivedAt = this._stampReceived(spellId, layer, start, nowS, seen);
        // F1: `+ start` per ACE (start ≤ 0; clamp guards synthetic > 0).
        expiresAtMs = (receivedAt + duration + Math.min(0, start)) * 1000;
        if (expiresAtMs - nowS * 1000 <= 0) continue; // B2: drop expired
        const own = bySpell.get(spellId);
        if (!own || expiresAtMs > own.expiresAtMs) {
          bySpell.set(spellId, { spellId, expiresAtMs, permanent: false, durationS: duration, receivedAtS: receivedAt });
        }
      }
      const prev = out.get(family);
      // B2 last-wins quirk (finding 10): C# keeps the LAST wire row for a
      // family (BuffManager.cs:1374); JS deliberately keeps the entry with the
      // LATER expiry (max-remaining) — more defensible against reordered/stale
      // rows. CONFIRMED-no-change: the JS choice stands.
      if (!prev || expiresAtMs > prev.expiresAtMs) {
        // durationS: the landed spell's full duration (s) — caps the
        // idle-rebuff window per family (_idleWindowFor, review safety-3).
        out.set(family, { spellId, expiresAtMs, permanent, durationS: duration });
      }
      this.spellFamily.set(spellId, family);
    }
    this._pruneReceived(seen);
    this._spellRows = bySpell;
    return out;
  }

  // receivedAt bookkeeping for one wire row (the start_time trap above). Keyed
  // by spell AND layer: two layers of one spell (a recast that surpassed an
  // aged copy) carry different start times, and one shared key re-stamped
  // both as "just received" on every read.
  _stampReceived(spellId, layer, start, nowS, seen) {
    if (!this._receivedAt) this._receivedAt = new Map();
    const key = `${spellId}:${layer | 0}`;
    seen?.add(key);
    const prior = this._receivedAt.get(key);
    const at = prior && prior.start === start ? prior.at : nowS;
    this._receivedAt.set(key, { start, at });
    return at;
  }

  _pruneReceived(seen) {
    if (!this._receivedAt) return;
    for (const key of this._receivedAt.keys()) if (!seen.has(key)) this._receivedAt.delete(key);
  }

  _refresh() {
    const reg = this._readRegistry();
    if (reg) this.families = reg;
    this.lastRefreshAt = Date.now();
    // B5 flap guard only — the ladder cap is never learned from a registry
    // read, which holds rows we didn't cast (see _recordOwnLanding).
    this._recordSeenTiers(reg);
    // finding 9 cleanup: a short-duration family that has fully dropped from
    // the registry is eligible to recast again — forget its "held active" mark.
    if (reg) {
      for (const fam of this._shortDurationFamilies) {
        const entry = reg.get(fam);
        if (!entry || this._remainingS(entry) <= 0) this._shortDurationFamilies.delete(fam);
      }
    }
    return reg;
  }

  // Finding 2 — UNCONDITIONAL heartbeat driven by the kernel EVERY tick,
  // independent of whether "Buffing" is the selected action. It runs only the
  // B13 death/dispel re-sync (self-throttled to the 30 s cadence), so a death
  // that silently empties the enchantment registry is detected even while the
  // kernel is busy with combat/loot and never routes to Buffing. Without it,
  // once all buffs read active the kernel's _buffNeeded gate goes false,
  // buff.tick() (which owns the periodic refresh) never runs, and the bot
  // fights on unbuffed forever. Buff EXPIRY is handled separately by the live
  // expiry timestamps in _isActiveReal, so this only closes the "registry
  // emptied while our timers still say active" gap.
  // It also returns fizzle-walked tiers to the ladder when their retry time
  // comes: a family walked down to a tier that then landed reads all-active,
  // so the kernel would never tick this loop to notice. Likewise a skill-cap
  // move (opt-in): a family re-resolved UP reads inactive and wakes the kernel.
  // And it ends a finished B11/B12 pass (_endFinishedPass).
  heartbeat() {
    if (!this.registryReady) return; // login gate owns the pre-ready window
    if (Date.now() - this.lastRefreshAt > PERIODIC_REFRESH_INTERVAL_MS) this._refresh();
    this._expireFizzleWalks(Date.now());
    this._checkSkillCap();
    this._endFinishedPass(Date.now());
  }

  // B11/B12 — a batch (or Force) pass is over once tick()'s cast loop would
  // skip every desired buff: its spell parked (B9), its family parked (B10),
  // or recast this pass (_isActive). tick()'s "Nothing left to cast this pass"
  // branch ends it — but only on one more buff tick, and the kernel gives none:
  // with every family in _forceRebuffCast status reads all active and nothing
  // pending, so kernel._buffNeeded() is false. The pass stayed open,
  // _isActive() kept answering from it, no buff read below the threshold again
  // and none was ever recast (until setDesired / Cancel / bot.setBuffs).
  // Never with a cast in flight; the parks are only read (tick() prunes them).
  _endFinishedPass(now) {
    if (!this._forceRebuffing || this.pending) return;
    for (const spellId of this.desired) {
      const parked = this.parkedUntil.get(spellId);
      if (parked && now < parked) continue;
      const fam = this._familyForSpell(spellId);
      if (fam !== undefined && (this._rejectParkedUntil.get(fam) ?? 0) > now) continue;
      if (!this._isActive(spellId)) return; // still to cast this pass
    }
    this._forceRebuffing = false;
    this.log("batch rebuff complete");
  }

  _familyForSpell(spellId) {
    if (this.spellFamily.has(spellId)) return this.spellFamily.get(spellId);
    const meta = this._spellMeta(spellId);
    return meta ? meta.category : undefined;
  }

  _tierOf(id) {
    if (this._spellTier.has(id)) return this._spellTier.get(id);
    const m = this._spellMeta(id);
    return m ? m.tier : null;
  }

  // Live remaining seconds from the stored absolute expiry (finding 2).
  _remainingS(entry) {
    return entry.permanent ? Infinity : (entry.expiresAtMs - Date.now()) / 1000;
  }

  // Resolve the registry entry backing a desired spell id: by family first
  // (so a skill-capped Incantation that landed as a lower-tier id in the SAME
  // family still resolves — finding 4), else by exact spell id.
  _entryForSpell(spellId) {
    const family = this._familyForSpell(spellId);
    if (family !== undefined && this.families.has(family)) return { family, entry: this.families.get(family) };
    for (const [fam, entry] of this.families) if (entry.spellId === spellId) return { family: fam, entry };
    return { family, entry: null };
  }

  // B3 real-timer test (ignores the force-rebuff view). Remaining is computed
  // live from the absolute expiry (finding 2), so this is correct even if the
  // registry hasn't been refreshed recently.
  _isActiveReal(spellId) {
    const { family, entry } = this._entryForSpell(spellId);
    if (!entry) return false;
    const remainingS = this._remainingS(entry);
    if (remainingS <= 0) return false;
    // B4 tier-upgrade (BuffManager.cs:1207-1215): a family holding a LOWER
    // tier than desired (capped by the highest tier we've seen land — B5) is
    // treated inactive so it upgrade-recasts regardless of time left. Was
    // absent — a friend-cast / older lower tier never upgraded (finding 3).
    const desiredTier = this._tierOf(spellId);
    const landedTier = this._tierOf(entry.spellId);
    if (family !== undefined && desiredTier != null && landedTier != null) {
      const cap = this._flapCap(family);
      const effectiveTarget = cap != null ? Math.min(desiredTier, cap) : desiredTier;
      // A landed spell with at least the desired spell's Power already wins
      // ACE's stacking (higher power holds the category) — recasting a lower
      // "tier" over it would flap forever without changing anything.
      const landedPower = this._spellMeta(entry.spellId)?.power || 0;
      const desiredPower = this._spellMeta(spellId)?.power || 0;
      const outpowers = landedPower > 0 && desiredPower > 0 && landedPower >= desiredPower;
      if (landedTier < effectiveTarget && !outpowers) {
        // Y-R1: the desired spell's own row can stand UNDER a lower tier that
        // outlives it (B2 keeps the later expiry — a permanent item V over our
        // VII). That is no upgrade to recast every tick: judge its own timer.
        const own = this._spellRows.get(spellId);
        if (!own || this._remainingS(own) <= 0) return false; // upgrade
        if (this._shortDurationFamilies.has(family)) return true;
        return this._remainingS(own) > this._rebuffThresholdS() + this._idleWindowFor(own);
      }
    }
    if (entry.permanent) return true;
    // B8×B3 (finding 9): a family confirmed landing below the rebuff threshold
    // is held active while present so the batch doesn't rebatch it forever;
    // it's recast only once it fully drops from the registry.
    if (family !== undefined && this._shortDurationFamilies.has(family)) return true;
    return remainingS > this._rebuffThresholdS() + this._idleWindowFor(entry);
  }

  /** The idle-rebuff window (s) for one landed family entry: the raised
   *  window, capped so the windowed threshold never exceeds HALF the landed
   *  duration (or the base threshold, whichever is higher). "Running low"
   *  (G:37) is never a buff with more than half its time left: without the
   *  cap, RebuffSecondsRemaining + IdleRebuffWindowSec >= a buff's duration
   *  (in-schema, e.g. 1200 + 600 on 1800 s Level I-V buffs) read every fresh
   *  landing as "below", and the idle slot recast the whole set every
   *  ~1.75 s forever (review safety-3). Unchanged at the defaults (300 + 600)
   *  for any buff of 1800 s or more; an entry without a known duration keeps
   *  the full window. */
  _idleWindowFor(entry) {
    const win = this._idleWindowS();
    if (!(win > 0)) return 0;
    const d = entry ? entry.durationS : undefined;
    if (typeof d !== "number" || !Number.isFinite(d) || d <= 0) return win;
    return Math.min(win, Math.max(0, d / 2 - this._rebuffThresholdS()));
  }

  /** B3 threshold (s): the live rebuffSecondsRemaining cell, else 300. */
  _rebuffThresholdS() {
    const v = this.rebuffSecondsRemaining;
    return typeof v === "number" && Number.isFinite(v) ? v : REBUFF_SECONDS_REMAINING;
  }

  /** The idle-rebuff window (s) currently raised by the VT IdleRebuff slot. */
  _idleWindowS() {
    const v = this.idleRebuffWindowS;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0;
  }

  /** "Does the buff loop want the tick?" — with extraWindowS 0 EXACTLY the
   *  kernel's _buffNeeded() predicate (kernel.js: enabled, not blocked with
   *  nothing pending, `!ready || active < desired || pending`), so meta
   *  NeedToBuff and the kernel agree (critic C10). With extraWindowS > 0 it is
   *  also true when a desired, non-parked buff would be recast by a tick()
   *  under that window — remaining ≤ rebuffSecondsRemaining + extraWindowS,
   *  the window capped per family by _idleWindowFor (permanent and
   *  short-duration-held families never count). With the VT layer the item
   *  enchants count as well (status, _itemCounts), under the window too. */
  needsBuff({ extraWindowS = 0 } = {}) {
    if (this.enabled === false) return false;
    const st = this.status;
    if (st.blocked && st.pending === 0) return false;
    if (!st.ready || st.active < st.desired || st.pending !== 0) return true;
    const extra = Number(extraWindowS);
    if (!(extra > 0) || !Number.isFinite(extra)) return false;
    const prev = this.idleRebuffWindowS;
    this.idleRebuffWindowS = extra;
    try {
      const now = Date.now();
      if (this.desired.some((id) => !this._isParked(id, now) && !this._isActiveReal(id))) return true;
      return (this._itemCounts(now, extra)?.due ?? 0) > 0;
    } finally {
      this.idleRebuffWindowS = prev;
    }
  }

  /** Replace the B7 item-enchant list (the VT Items/Buffs tabs projection):
   *  `[{ spellId, itemGuid, itemName }]`. Confirmations already seen for a
   *  spell+item pair are kept (no recast storm on a re-projection); an empty
   *  list is today's dormant B7. Returns the accepted count. */
  setItemBuffs(list) {
    const out = [];
    for (const ib of Array.isArray(list) ? list : []) {
      const spellId = Number(ib && ib.spellId) >>> 0;
      const itemGuid = Number(ib && ib.itemGuid) >>> 0;
      if (!spellId || !itemGuid) continue;
      const itemName = typeof ib.itemName === "string" ? ib.itemName.trim() : "";
      out.push(itemName ? { spellId, itemGuid, itemName } : { spellId, itemGuid });
    }
    this.itemBuffs = out;
    return out.length;
  }

  // ── worn armor + the layer's B7 bookkeeping (header, "Worn armor") ───────

  /** A VT option through the injected reader; `dflt` without the layer, for
   *  an unset key, or when the read throws. */
  _opt(key, dflt) {
    const f = this.optFn;
    if (typeof f !== "function") return dflt;
    try {
      const v = f(key);
      return v === undefined || v === null ? dflt : v;
    } catch (_) {
      return dflt;
    }
  }

  // The spellbook as a Set (empty when unreadable).
  _knownSpellSet() {
    const s = this.host.s;
    try {
      return new Set(s && s.playerKnownSpells ? Array.from(s.playerKnownSpells() || [], Number) : []);
    } catch (_) {
      return new Set();
    }
  }

  // The inventory rows — the host's per-heartbeat memo when it has one; []
  // when unreadable.
  _inventoryRows() {
    const h = this.host;
    try {
      const rows =
        typeof h.TryGetPlayerInventoryCached === "function"
          ? h.TryGetPlayerInventoryCached()
          : typeof h.TryGetPlayerInventory === "function"
            ? h.TryGetPlayerInventory()
            : null;
      return Array.isArray(rows) ? rows : [];
    } catch (_) {
      return [];
    }
  }

  /**
   * The worn-armor casts the options ask for, re-read at most every
   * WORN_REFRESH_MS → { entries, covers }; null without the layer.
   * `entries`: one per family — Impenetrability with BuffArmorImpen, a bane
   * per BuffProfileBanes letter (baneLetters; a value it can't read means all
   * of them, the default) — at the highest tier in the spellbook (the Items
   * tab's resolution, vt/combat/spell_tables.js bestCastable) less the rungs
   * ACE refused as unknown, and less a fizzle-walked rung while a lower one is
   * known (_holdRefusedItem), targeted at our own guid:
   * { spellId, itemGuid, worn, family, spellName }. None while no enchantable
   * piece is worn (ACE would answer with no line at all) or the inventory is
   * unreadable. `covers`: the equipped armor / clothing / shield guids those
   * casts reach (_itemPass).
   */
  _wornArmor(now) {
    if (typeof this.optFn !== "function") return null;
    const impen = this._opt("BuffArmorImpen", false) === true;
    const raw = this._opt("BuffProfileBanes", null);
    const letters = raw === null ? "" : baneLetters(raw) ?? BANE_LETTERS;
    const sig = `${impen ? "I" : "-"}:${letters}`;
    const m = this._wornMemo;
    if (m && m.sig === sig && now >= m.at && now - m.at < WORN_REFRESH_MS) return m;
    const w = { at: now, sig, entries: [], covers: new Set() };
    this._wornMemo = w;
    const fams = WORN_ARMOR_FAMILIES.filter((f) => (f.letter ? letters.includes(f.letter) : impen));
    let me = 0;
    try {
      me = fams.length && typeof this.host.GetPlayerId === "function" ? Number(this.host.GetPlayerId()) >>> 0 : 0;
    } catch (_) {
      me = 0;
    }
    const known = me ? this._knownSpellSet() : null;
    const entries = [];
    for (const f of known ? fams : []) {
      let pick = null;
      for (let i = f.rungs.length - 1; i >= 0; i--) {
        const r = f.rungs[i];
        if (!known.has(r.id) || this._wornUnresolvable.has(r.id)) continue;
        if (!pick) pick = r; // every known rung fizzle-walked: the best, held
        if ((this._wornWalkedUntil.get(r.id) ?? 0) > now) continue;
        pick = r;
        break;
      }
      if (pick) entries.push({ spellId: pick.id, itemGuid: me, worn: true, family: f.family, spellName: pick.name });
    }
    if (entries.length) {
      for (const r of this._inventoryRows()) {
        if ((Number(r && r.equipMask) >>> 0) !== 0 && ((Number(r.itemType) >>> 0) & ITEM_TYPE_WORN) !== 0) {
          w.covers.add(Number(r.guid) >>> 0);
        }
      }
    }
    if (w.covers.size) w.entries = entries;
    this._logWorn(w, entries.length > 0);
    return w;
  }

  // Log the worn-armor casts when they change, not on every re-read; quiet
  // while there never was anything to cast.
  _logWorn(w, resolved) {
    const sig = w.entries.map((e) => e.spellId).join(",") || (resolved ? "unworn" : "none");
    if (sig === this._wornLogged) return;
    const first = this._wornLogged === undefined;
    this._wornLogged = sig;
    if (w.entries.length) {
      this.log(`worn armor: ${w.entries.map((e) => e.spellName).join(", ")} — ${w.covers.size} worn piece(s)`);
    } else if (!first) {
      this.log(`worn armor: nothing to cast (${resolved ? "no enchantable piece worn" : "none chosen or known"})`);
    }
  }

  /** The B7 list this pass: the Items tab's (setItemBuffs) without the layer;
   *  with it, the worn-armor casts first (RynthAi step 7), then the Items-tab
   *  entries less an equipped piece's for a family a worn cast covers — that
   *  cast enchants it, so it is never cast twice. */
  _itemPass(now) {
    const w = this._wornArmor(now);
    if (!w || !w.entries.length) return this.itemBuffs;
    const fams = new Set(w.entries.map((e) => e.family));
    const rest = this.itemBuffs.filter((ib) => !(w.covers.has(ib.itemGuid) && fams.has(WORN_FAMILY_OF.get(ib.spellId))));
    return [...w.entries, ...rest];
  }

  /** Is item enchant `ib` due a cast? Without the layer: itemRecastMs after
   *  its last confirmation, as always. With it: never while held (a silent or
   *  refused cast), at once when confirmed before a Force Buff, else
   *  _itemRecastAfterMs(windowS) after its confirmation. */
  _itemDue(ib, now, windowS = this._idleWindowS()) {
    const key = `${ib.spellId}:${ib.itemGuid}`;
    const last = this._itemLastCast.get(key) ?? 0;
    if (typeof this.optFn !== "function") return now - last >= this.itemRecastMs;
    if ((this._itemHeldUntil.get(key) ?? 0) > now) return false;
    if (this._itemForceAt && last < this._itemForceAt) return true;
    return now - last >= this._itemRecastAfterMs(windowS);
  }

  /** With the layer, how long after its confirmation an item enchant is
   *  recast (ms). Its duration is not client-readable: itemRecastMs is the
   *  recast point, at the default 300 s threshold, of an enchant assumed to
   *  last itemRecastMs + 300 s (25 + 5 min — the 30 min of Impenetrability and
   *  every bane at tiers I-V; VI-VIII last longer). Another B3 threshold or the
   *  idle-rebuff window moves that point as it moves a self buff's, never to
   *  before half the assumed span (the _idleWindowFor rule). */
  _itemRecastAfterMs(windowS = 0) {
    const spanS = this.itemRecastMs / 1000 + REBUFF_SECONDS_REMAINING;
    const w = typeof windowS === "number" && Number.isFinite(windowS) && windowS > 0 ? windowS : 0;
    return 1000 * Math.max(spanS / 2, spanS - this._rebuffThresholdS() - w);
  }

  /** With the layer, the item enchants B7 keeps this pass: { total, due }
   *  (status / needsBuff); null without the layer or with none. */
  _itemCounts(now, windowS = 0) {
    if (typeof this.optFn !== "function") return null;
    const list = this._itemPass(now);
    if (!list.length) return null;
    let due = 0;
    for (const ib of list) if (this._itemDue(ib, now, windowS)) due++;
    return { total: list.length, due };
  }

  // Layer B7: an item cast that enchanted nothing — ACE finished it without a
  // "You cast … on" line (no enchantable piece worn, the item out of reach or
  // not a valid target) or never answered — is held ITEM_SILENT_RETRY_MS,
  // noShowCooldownMs when the cast before it was silent too.
  _itemNoLine(p, now, why) {
    const key = `${p.spellId}:${p.itemGuid}`;
    const n = (this._itemSilent.get(key) || 0) + 1;
    this._itemSilent.set(key, n);
    const ms = n >= SILENT_NO_SHOW_THRESHOLD ? this.noShowCooldownMs : ITEM_SILENT_RETRY_MS;
    this._itemHeldUntil.set(key, now + ms);
    const on = p.worn ? "worn armor" : `0x${(p.itemGuid >>> 0).toString(16)}`;
    this.log(`item enchant ${p.spellId} on ${on} ${why} — held ${Math.round(ms / 1000)} s`);
    this._itemPending = null;
    this._release();
  }

  // Layer B7: a refused item cast, by class, as a self buff would be (the
  // caller already held all buffing for "components" / "mana"):
  //   fizzle         retried; FIZZLE_WALK_LIMIT in a row hold it
  //                  FIZZLE_WALK_RETRY_MS (odds, not a ceiling: the self-buff
  //                  fizzle walk), and a worn family steps a tier down for
  //                  that long when one is known below it (_wornArmor) —
  //                  otherwise back-to-back fizzles kept the bot on Buffing;
  //   transient      busy / in the air: TRANSIENT_BACKOFF_MS;
  //   unknown-spell  a worn rung leaves its family for good (B9's walk); an
  //                  Items-tab one waits noShowCooldownMs;
  //   place          PLACE_PARK_MS.
  _holdRefusedItem(p, cls, now) {
    const key = `${p.spellId}:${p.itemGuid}`;
    if (cls === "fizzle") {
      const n = (this._itemFizzles.get(key) || 0) + 1;
      if (n < FIZZLE_WALK_LIMIT) {
        this._itemFizzles.set(key, n);
        return;
      }
      this._itemFizzles.delete(key);
      this._itemHeldUntil.set(key, now + FIZZLE_WALK_RETRY_MS);
      if (p.worn) {
        this._wornWalkedUntil.set(p.spellId, now + FIZZLE_WALK_RETRY_MS);
        this._wornMemo = null; // re-resolved on the next pass
      }
      this.log(`item enchant ${p.spellId} fizzled ${n}x in a row — held ${FIZZLE_WALK_RETRY_MS / 60_000} min`);
    } else if (cls === "transient") {
      this._backoffUntil = Math.max(this._backoffUntil, now + TRANSIENT_BACKOFF_MS);
    } else if (cls === "unknown-spell") {
      if (p.worn) {
        this._wornUnresolvable.add(p.spellId);
        this._wornMemo = null; // re-resolved on the next pass
      } else this._itemHeldUntil.set(key, now + this.noShowCooldownMs);
    } else if (cls === "place") this._itemHeldUntil.set(key, now + PLACE_PARK_MS);
  }

  _isActive(spellId) {
    // B12: during a force-rebuff pass, a buff counts "active" ONLY if its
    // family was already recast THIS cycle — live timers are ignored so the
    // whole set recasts to a common start (aligned timers).
    if (this._forceRebuffing) {
      const fam = this._familyForSpell(spellId);
      return fam !== undefined && this._forceRebuffCast.has(fam);
    }
    return this._isActiveReal(spellId);
  }

  // A desired buff is "parked" if the spell itself is in the no-show park
  // (B9) or its family is in the hard-reject/no-show cooldown (B10).
  _isParked(spellId, now) {
    const sp = this.parkedUntil.get(spellId);
    if (sp && now < sp) return true;
    const fam = this._familyForSpell(spellId);
    return fam !== undefined && (this._rejectParkedUntil.get(fam) ?? 0) > now;
  }

  // B11 — any desired buff below threshold (real timers) means the set has
  // drifted; recast everything so the timers realign. PARKED families are
  // SKIPPED (finding 1): C# AnyBuffBelowThreshold ignores families in the
  // fail cooldown (BuffManager.cs:824-827), otherwise a can't-land parked
  // buff keeps re-triggering the batch forever (batch -> cast -> no-show ->
  // re-park -> batch, the /god loop). The prior code counted parked buffs as
  // "below threshold" and livelocked the healthy set into perpetual recasts.
  _anyBelowThreshold() {
    const now = Date.now();
    return this.desired.some((id) => !this._isParked(id, now) && !this._isActiveReal(id));
  }

  get status() {
    const active = this.desired.filter((id) => this._isActive(id));
    const st = {
      ready: this.registryReady,
      desired: this.desired.length,
      active: active.length,
      parked: [...this.parkedUntil.keys()],
      pending: this.pending ? this.pending.spellId : 0,
      itemBuffs: this.itemBuffs.length,
      itemConfirmed: this._itemLastCast.size,
      itemPending: this._itemPending ? this._itemPending.spellId : 0,
      // Why buffing is held right now ("no-caster", "components", "mana", …)
      // or null — for the HUD/director; the B-rules don't read it.
      blocked: this._blocked && this._blocked.until > Date.now() ? this._blocked.reason : null,
      lastRefusal: this.lastRefusal,
    };
    // With the layer, B7's item enchants count as buffs: a due one keeps the
    // kernel on Buffing (kernel.js _buffNeeded, active < desired) — B7's only
    // tick once every self buff is up (header, "Worn armor").
    const items = this._itemCounts(Date.now());
    if (items) {
      st.desired += items.total;
      st.active += items.total - items.due;
    }
    return st;
  }

  _block(reason, ms, now = Date.now()) {
    const fresh = !this._blocked || this._blocked.reason !== reason || this._blocked.until <= now;
    this._blocked = { reason, until: now + ms };
    return fresh;
  }

  // Is a caster (wand/orb/staff) wielded? true/false from the inventory
  // snapshot, null when it can't be told yet (no inventory API, or the
  // inventory hasn't streamed — an empty list proves nothing).
  _casterWielded() {
    return casterWielded(this.host);
  }

  // Cast a self-buff the retail way: TARGETED at our own guid (ACE
  // TargetCategory.Self — the path that broadcasts the glow; valid for a
  // SelfTargeted spell and for an "Other" spell cast on oneself).
  // NEVER untargeted: ACE's untargeted path keeps a NULL cast target and only
  // HandleCastSpell's IsSelfTargeted branch substitutes the caster, so any
  // other enchantment reaches WorldObject.CreateEnchantment(null) and the
  // unhandled NullReferenceException on the world thread takes the WHOLE
  // SERVER down (ACE WorldObject_Magic.cs:406 via Player_Magic.cs:1171
  // SetCastParams(spell, null, …, null, …)). Live-hit 2026-10-12: a tier
  // upgrade resolved "Strength Self I" to "Incantation of Strength Other"
  // (not in the ladder table, catalog fallback) and the untargeted cast
  // crashed ACE twice. No guid yet (player not ready) -> no cast. -> sent?
  _castSelfBuff(spellId) {
    const h = this.host;
    const self = typeof h.GetPlayerId === "function" ? h.GetPlayerId() >>> 0 : 0;
    if (!self) return false;
    return h.CastSpell(self, spellId) !== false;
  }

  // ACE's UseDone counter, read LIVE off the handle (the host snapshot is up to
  // one heartbeat old, and a UseDone landing between snapshot and cast would
  // read as ours). null when neither the handle nor the host can report it —
  // B8 then keeps the legacy fixed clock.
  _useDoneNow() {
    const h = this.host;
    try {
      if (h.s && typeof h.s.getUseDoneSeq === "function") return h.s.getUseDoneSeq() >>> 0;
      if (typeof h.has === "function" && h.has("GetUseDoneSeq") && typeof h.GetUseDoneSeq === "function") {
        return h.GetUseDoneSeq() >>> 0;
      }
    } catch (_) {
      /* fall through */
    }
    return null;
  }

  _release() {
    if (typeof this.host.releaseCast === "function") this.host.releaseCast("buff"); // C3 shared serializer
  }

  // B9 — the cast finished without landing. Tier-walk FIRST (finding 5): a
  // silently-dropped cast means this tier won't land (skill-capped / unknown
  // real tier). Mark it unresolvable and re-resolve the family to the next
  // lower KNOWN tier so the bot ends up buffed at a reachable tier instead of
  // parking unbuffed for 30 min (BuffManager.cs:566-573 cold-snapshot
  // MarkSpellUnresolvable + FindBestSpellId tier-drop). Only when NO lower tier
  // remains do we fall through to the silent-no-show park. `walk: false` (the
  // cast was never answered) skips the walk and only counts toward the park.
  // `retryAfterMs` (the fizzle walk) puts the tier back on the ladder after
  // that long instead of for good (_expireFizzleWalks).
  // Under the opt-in skill cap a walk must go DOWN: with no other tier within
  // the cap left, the re-resolution falls back to the highest known tier, and
  // walking UP from a fizzled tier to it is no walk — undo, let B9 park.
  _noShow(spellId, fam, now, { walk = true, retryAfterMs = 0 } = {}) {
    let walked = false;
    if (walk && this.tierLadders && fam !== undefined && !this._unresolvable.has(spellId)) {
      this._unresolvable.add(spellId);
      this._buildLadders(); // re-resolve desired excluding unresolvable ids
      const from = this.skillCap ? this._tierOf(spellId) : null;
      walked = this.desired.some(
        (id) =>
          id !== spellId &&
          !this._unresolvable.has(id) &&
          this._familyForSpell(id) === fam &&
          (from == null || !(this._tierOf(id) > from))
      );
      if (!walked) {
        this._unresolvable.delete(spellId); // no lower tier — undo, let B9 park
        if (this.skillCap) this._buildLadders(); // the cap's fallback resolved up: back to spellId
      }
    }
    if (walked) {
      if (retryAfterMs > 0) this._unresolvableUntil.set(spellId, now + retryAfterMs);
      else this._unresolvableUntil.delete(spellId);
      this.log(
        `tier-down ${spellId} unresolvable -> family ${fam} walking to a lower tier` +
          (retryAfterMs > 0 ? ` (retried in ${Math.round(retryAfterMs / 60_000)} min)` : "")
      );
      this.pending = null;
      this._release();
      return;
    }
    // B9 — silent no-show valve.
    const n = (this.noShows.get(spellId) || 0) + 1;
    this.noShows.set(spellId, n);
    this.log(`no-show ${spellId} (${n}/${SILENT_NO_SHOW_THRESHOLD})`);
    if (n >= SILENT_NO_SHOW_THRESHOLD) {
      this.parkedUntil.set(spellId, now + this.noShowCooldownMs);
      // B10/B12 — also park the FAMILY and mark it "done this cycle" so
      // a can't-land buff doesn't respin the whole batch forever.
      if (fam !== undefined) {
        this._rejectParkedUntil.set(fam, now + 120_000);
        this._forceRebuffCast.add(fam);
      }
      this.log(`parked ${spellId}`);
    }
    this.pending = null;
    this._release();
  }

  // A refused cast, by class. None of these says the TIER is wrong except a
  // run of fizzles (skill vs. difficulty) and a spell that isn't in the book.
  _resolveRefusal(p, fam, now) {
    const { code, cls } = p.refusal;
    const spellId = p.spellId;
    this.lastRefusal = { code, cls, spellId, at: now };
    this.pending = null;
    this._release();
    const hex = `0x${code.toString(16).padStart(4, "0")}`;
    switch (cls) {
      case "components":
      case "mana": {
        const ms = cls === "components" ? COMPONENTS_PARK_MS : MANA_BACKOFF_MS;
        this._backoffUntil = Math.max(this._backoffUntil, now + ms);
        this._block(cls, ms, now);
        this._logBlock(cls, `cast ${spellId} refused (${hex} ${cls === "components" ? "missing spell components" : "not enough mana"}) — self-buffing held ${ms / 1000}s`);
        return;
      }
      case "place":
        if (fam !== undefined) this._rejectParkedUntil.set(fam, now + PLACE_PARK_MS);
        this.log(`cast ${spellId} refused here (${hex}) — family ${fam} parked ${PLACE_PARK_MS / 1000}s`);
        return;
      case "fizzle": {
        const n = (this._fizzles.get(spellId) || 0) + 1;
        if (n >= FIZZLE_WALK_LIMIT) {
          this._fizzles.delete(spellId);
          this.log(`${spellId} fizzled ${n}x in a row — treating as skill-capped`);
          this._noShow(spellId, fam, now, { retryAfterMs: FIZZLE_WALK_RETRY_MS });
        } else {
          this._fizzles.set(spellId, n);
          this.log(`fizzle ${spellId} (${n}/${FIZZLE_WALK_LIMIT}) — retry`);
        }
        return;
      }
      case "unknown-spell":
        this.log(`cast ${spellId} refused (${hex}) — not in the spellbook`);
        this._noShow(spellId, fam, now);
        return;
      default: // "transient": busy / in the air / target lost — just retry
        this._backoffUntil = Math.max(this._backoffUntil, now + TRANSIENT_BACKOFF_MS);
    }
  }

  // Log a hold once per reason (the reason repeats every park cycle).
  _logBlock(reason, msg) {
    if (this._lastLoggedBlock === reason) return;
    this._lastLoggedBlock = reason;
    this.log(msg);
  }

  // Rebuild B4 ladders when the known book changed size, or when the ladder
  // table arrived after a catalog-only build.
  _maybeRebuildLadders() {
    if (!this.tierLadders || !this._laddersBuilt) return;
    const s = this.host.s;
    let count = -1;
    try {
      count = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).length : -1;
    } catch (_) {
      return;
    }
    const tableArrived = LADDER_TABLE && Object.keys(LADDER_TABLE).length > 0 && !this._builtWithTable;
    if (count !== this._knownCount || tableArrived) this._buildLadders();
  }

  // ── netBrain (D1 path A′) — .NET-wasm BuffScheduling shadow ─────────────
  // SNAPSHOT mode (the dto-map ruling): SchedulerState is rebuilt from this
  // loop's live fields on every shadowed tick — a threaded C#-side mirror
  // would drift into pure noise after the first differing decision (its
  // PendingSpellId would track a cast that never physically happened).
  // Comparison is EVENT-level only: "would C# cast the same spell right
  // now" — cadence actions (login-wait/interval-wait/idle/mode-switch/...)
  // never count as divergence. Item-enchant ticks are skipped entirely
  // (JS B7 is a chat-confirmed mechanism the slice deliberately excludes).
  attachNetBrain(brain, mode, nbModule, opts = {}) {
    this._nb = { brain, mode, m: nbModule };
    this._nbVitals = opts.vitals || null;
    this._nbCombat = opts.combat || null;
    this._nbLastAt = 0;
    this._nbMinIntervalMs = opts.minIntervalMs ?? 250;
  }

  _nbRoman(t) {
    return ["I", "I", "II", "III", "IV", "V", "VI", "VII", "VIII"][Math.max(1, Math.min(8, t || 1))];
  }

  // C# drops registry rows with an empty Name and parses the trailing roman
  // numeral for the tier — resolve via the live catalog when present, else
  // synthesize from the ladder meta (headless has no SpellCatalog).
  _nbSpellName(id, famHint) {
    const s = this.host.s;
    if (s.getSpellRecord) {
      try {
        const r = s.getSpellRecord(id >>> 0);
        if (r?.name) return r.name;
      } catch (_) { /* fall through */ }
    }
    const meta = this._spellMeta(id);
    const fam = meta?.category ?? famHint;
    return `Fam${fam ?? 0} Self ${this._nbRoman(meta?.tier)}`;
  }

  _nbBuildInput(now) {
    const h = this.host;
    const s = h.s;
    const v = this._nbVitals;
    const nowS = now / 1000;
    // RAW wire rows (C# does its own last-wins family collapse), reusing the
    // exact _readRegistry receivedAt bookkeeping (the Derethian-epoch trap).
    const registry = [];
    const rows = readEnchantmentRows(s);
    if (rows) {
      for (const { spellId, family, start, duration, layer } of rows) {
        const permanent = duration < 0 || duration > PERMANENT_SENTINEL_S;
        let remainingS = 0;
        if (!permanent) {
          // Same receivedAt book as _readRegistry (no prune here — the
          // shadow read runs between real reads).
          const receivedAt = this._stampReceived(spellId, layer, start, nowS, null);
          // F1: `+ start` per ACE EnchantmentManager.cs:188 (start ≤ 0).
          remainingS = receivedAt + duration + Math.min(0, start) - nowS;
          if (remainingS <= 0) continue;
        }
        registry.push({
          SpellId: spellId, Name: this._nbSpellName(spellId, family),
          Family: family, RemainingS: permanent ? 0 : remainingS, Permanent: permanent,
        });
      }
    }
    // Desired ladders from the known book (same source as _buildLadders: the
    // family's scroll ladder when it has one, a known pin alone).
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    const desired = [];
    for (const rawId of this.rawDesired) {
      const meta = this._spellMeta(rawId);
      const fam = meta?.category ?? this._familyOfSpell.get(rawId);
      const members = [];
      for (const id of known) {
        const m = this._spellMeta(id);
        if (!m || m.category !== fam) continue;
        members.push({ id, tier: m.tier, canonical: m.canonical });
      }
      const pin = meta && meta.canonical === false && known.includes(rawId) && !this._unresolvable.has(rawId);
      const ladder = (pin ? members.filter((e) => e.id === rawId) : this._ladderRungs(members, meta)).map((e) => ({
        Id: e.id, Name: this._nbSpellName(e.id, fam), Family: fam, Tier: e.tier,
        Known: !this._unresolvable.has(e.id), // folds the B9 walk-down blacklist
      }));
      desired.push({
        BaseName: this._nbSpellName(rawId, fam), SkillUsable: true,
        MaxTier: 8, Ladder: ladder, // no GetHighestBuffSpellTier live (documented gap)
      });
    }
    const fr = v && typeof v._fractions === "function" ? v._fractions() : null;
    const vid = (id) => (v && id && (!v._known || v._known(id)) ? id : 0);
    return {
      NowMs: now,
      Config: {
        EnableBuffing: true,
        RebuffSecondsRemaining: this._rebuffThresholdS(),
        SpellCastIntervalMs: SPELL_CAST_INTERVAL_MS,
        HealAt: v?.cfg?.healAtCombat ?? 60, RestamAt: v?.cfg?.restamAtCombat ?? 30,
        GetManaAt: v?.cfg?.getManaAtCombat ?? 40,
        TopOffHP: v?.cfg?.topOffHp ?? 95, TopOffStam: v?.cfg?.topOffStam ?? 95,
        TopOffMana: v?.cfg?.topOffMana ?? 95,
      },
      Vitals: {
        HealthPct: fr ? Math.round(fr.hp * 100) : 100,
        StaminaPct: fr ? Math.round(fr.stam * 100) : 100,
        ManaPct: fr ? Math.round(fr.mana * 100) : 100,
        // Approximation of C#'s HasCloseThreat (a full _scanTargets here
        // would double the scan cost) — threshold-band ticks are cadence.
        InCombat: !!(this._nbCombat && this._nbCombat.locked !== 0),
        HasHealthKit: false, // no JS kit plane (documented gap)
        StamToHealthId: vid(v?.spells?.stamToHealth), HealSelfId: vid(v?.spells?.healSelf),
        StamToManaId: vid(v?.spells?.stamToMana), RevitalizeId: vid(v?.spells?.revitalize),
      },
      HasRegistryApi: rows !== null,
      Registry: registry,
      KnownSnapshotWarm: true,
      Desired: desired,
      InMagicMode: h.GetCurrentCombatMode() === 8,
      CanCastNow: h.GetCastBusyState() === 0,
      BusyCount: h.GetBusyState(),
      State: {
        RegistryReady: this.registryReady,
        LoginStartAtMs: this.startedAt || -1,
        LastLoginCount: this.lastCount,
        LastLiveRefreshAttemptMs: this.lastCountAt || -1e15,
        LastPeriodicRefreshMs: this.lastRefreshAt || -1e15,
        LastCastAttemptMs: this.lastCastAt || -1e15,
        LastSelfBuffPollAtMs: -1e15, // no JS mirror (cadence-only)
        PendingSpellId: this.pending?.spellId ?? 0,
        PendingSpellName: this.pending ? this._nbSpellName(this.pending.spellId) : "",
        PendingFamily: this.pending ? this._familyForSpell(this.pending.spellId) ?? 0 : 0,
        PendingKnown: true,
        ForceRebuffing: this._forceRebuffing,
        ForceRebuffCastFamilies: [...this._forceRebuffCast],
        NoShowCounts: [...this.noShows].map(([id, n]) => ({ Family: this._familyForSpell(id) ?? 0, Value: n })),
        FailCooldownUntil: [...this._rejectParkedUntil].map(([f, t]) => ({ Family: f, UntilMs: t })),
        // C#'s one map = our seen tiers merged with the own-landing ladder caps.
        AchievedTier: [...new Set([...this._familySeenTier.keys(), ...this._familyAchievedTier.keys()])].map((f) => ({
          Family: f,
          Value: this._flapCap(f),
        })),
        UnresolvableIds: [...this._unresolvable],
        RamTimers: [...this.families].map(([f, e]) => ({
          Family: f, SpellName: this._nbSpellName(e.spellId, f),
          Level: this._tierOf(e.spellId) ?? 0,
          // Infinity is not JSON — a permanent timer rides the flag + a far
          // finite expiry.
          ExpiresAtMs: e.permanent ? now + 1e12 : e.expiresAtMs,
          Permanent: !!e.permanent,
        })),
        ItemTimers: [], // JS B7 is out of the slice's scope by design
      },
    };
  }

  // C# actions that are pure cadence — never a divergence when JS is quiet.
  static _NB_CADENCE = new Set([
    "login-wait", "login-ready", "interval-wait", "gate-blocked", "hold-pending",
    "idle", "buffing-disabled", "confirmed", "no-show-retry", "no-show-parked",
    "no-chat-timeout", "mode-switch",
  ]);

  tick() {
    const nb = this._nb;
    const now = Date.now();
    const doShadow = !!nb?.brain && now - this._nbLastAt >= this._nbMinIntervalMs;
    let input = null;
    if (doShadow) {
      this._nbLastAt = now;
      try {
        input = this._nbBuildInput(now); // PRE-tick snapshot (both sides decide from it)
      } catch (_) {
        nb.m.diag().errors.buff++;
      }
    }
    const prePending = this.pending;
    const preItemPending = this._itemPending;
    this._tickJs();
    if (!input) return;
    // JS event this tick, classified by WHICH pending was newly set — an
    // outstanding item confirm can coexist with a fresh self-buff cast, so
    // "_itemPending is non-null" is not an item-cast marker (review finding).
    if (this._itemPending && this._itemPending !== preItemPending) return; // item cast: out of slice scope
    const jsCast = this.pending && this.pending !== prePending ? this.pending.spellId : 0;
    nb.m.shadowTick(nb.brain, "buff", () => input, (out) => {
      const csCast = out.Action === "cast-buff" || out.Action === "vital-cast" ? out.SpellId : 0;
      const agree = jsCast
        ? csCast === jsCast
        : csCast === 0 && (RynthBuffLoop._NB_CADENCE.has(out.Action) || out.Action === "");
      return {
        agree,
        jsVal: jsCast ? `cast:${jsCast}` : "quiet",
        csVal: `${out.Action}${out.SpellId ? ":" + out.SpellId : ""}`,
      };
    });
  }

  _tickJs() {
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    const now = Date.now();
    this._ensureEventTap(); // kernel path: startOn() never runs

    // B4/B5 — resolve desired buffs to their best known+castable tier once
    // the ladder table has loaded (or the live catalog is available).
    if (this.tierLadders && !this._laddersBuilt && (LADDER_TABLE || this.host.s.getSpellRecord)) {
      this._buildLadders();
    }

    // B1 — login stabilization: registry count stable on two consecutive
    // ~1 s reads, or the 20 s max wait.
    if (!this.registryReady) {
      if (now - this.lastCountAt >= 1000) {
        const reg = this._readRegistry();
        const count = reg ? reg.size : -1;
        if (count >= 0 && count === this.lastCount) {
          this.registryReady = true;
          this.families = reg;
          this.log(`registry stable (${count} families) — buffing enabled`);
        }
        this.lastCount = count;
        this.lastCountAt = now;
      }
      if (!this.registryReady && now - this.startedAt < LOGIN_REFRESH_MAX_WAIT_MS) return;
      if (!this.registryReady) {
        this.registryReady = true; // 20 s cap reached
        this._refresh();
        this.log("registry stabilization timed out — proceeding (B1 cap)");
      }
    }

    // B13 — periodic re-sync (death/dispel recovery); the spellbook can grow
    // mid-session (and the ladder table can land after a catalog-only build).
    if (now - this.lastRefreshAt > PERIODIC_REFRESH_INTERVAL_MS) {
      this._refresh();
      this._maybeRebuildLadders();
    }

    // B8 — resolve the pending cast. Signals, in order: the family in the live
    // registry (landed); a refusal code off the push plane (castRefusalClass);
    // ACE's UseDone with nothing landed after a grace (silent no-show); the
    // hard cap (a lost UseDone, or a request that never left a stalled page —
    // retried, not tier-walked). A host that can't report UseDoneSeq keeps
    // the original fixed SELF_BUFF_GIVE_UP_MS clock.
    if (this.pending) {
      const p = this.pending;
      const age = now - p.issuedAt;
      if (age < SELF_BUFF_CONFIRM_MS) return;
      if (!p.refusal && now - this._lastPendingPollAt < SELF_BUFF_POLL_MS) return;
      this._lastPendingPollAt = now;
      this._refresh();
      const spellId = p.spellId;
      const fam = this._familyForSpell(spellId);
      // B8 confirm by FAMILY, not spell id (BuffManager.cs:555-556): a
      // skill-capped Incantation lands as a LOWER-tier spell in the SAME
      // family, so confirming by the exact cast id phantom-no-shows every
      // incantation (finding 4). Confirm = the family is present in the live
      // registry with remaining > 0 (C# tests `st.Expiration > now`, NOT the
      // rebuff threshold — so a short-duration buff still confirms, finding 9).
      const famEntry = fam !== undefined ? this.families.get(fam) : null;
      // An UPGRADE has not landed while the lower-tier entry it was cast over
      // still stands unchanged (rynth-macro-nav-1): fall through to the
      // refusal / UseDone answer, so a fizzle counts and the walk can run.
      // A pending without `prior` (same-tier recast, empty family) confirms as before.
      // A prior that OUTLIVES the upgrade still stands after it lands (Y-R1):
      // there the cast's own row is the landing (_ownLanding), and only that
      // row (never the prior) feeds finding 9 / the B5 cap.
      const overPrior = this._isPriorEntry(p.prior, famEntry);
      const landedEntry = overPrior ? this._ownLanding(p, now, age) : famEntry;
      const landed = overPrior
        ? !!landedEntry
        : famEntry
          ? this._remainingS(famEntry) > 0
          : this._isActiveReal(spellId);
      if (landed) {
        this.noShows.delete(spellId);
        // B12 — mark the family recast this cycle so the force-rebuff pass
        // stops re-selecting it.
        if (fam !== undefined) {
          this._forceRebuffCast.add(fam);
          // finding 9: landed BELOW the rebuff threshold -> hold it active so
          // the batch doesn't rebatch this short-duration buff forever (the
          // deliberate improvement over C#, which rebatches endlessly here).
          if (landedEntry && !landedEntry.permanent && this._remainingS(landedEntry) <= this._rebuffThresholdS()) {
            if (!this._shortDurationFamilies.has(fam)) {
              this.log(`family ${fam} lands below rebuff threshold — holding active (finding 9, no rebatch)`);
            }
            this._shortDurationFamilies.add(fam);
          }
        }
        this.log(`confirmed ${spellId}`);
        this.pending = null;
        this._fizzles.delete(spellId);
        this._lastLoggedBlock = null;
        this._release();
        // B5 ladder cap (may re-resolve desired). Not with a refusal on record:
        // our cast didn't land, so what stands is someone else's buff.
        if (!p.refusal) this._recordOwnLanding(fam, spellId, landedEntry);
        return;
      }
      if (p.refusal) {
        this._resolveRefusal(p, fam, now);
        return;
      }
      if (p.useDoneAtIssue == null) {
        if (age > SELF_BUFF_GIVE_UP_MS) this._noShow(spellId, fam, now);
        return;
      }
      if (!p.useDoneAt) {
        const seq = this._useDoneNow();
        if (seq != null && seq !== p.useDoneAtIssue) p.useDoneAt = now;
      }
      if (p.useDoneAt && now - p.useDoneAt > SELF_BUFF_USE_DONE_GRACE_MS && age > SELF_BUFF_GIVE_UP_MS) {
        this._noShow(spellId, fam, now); // ACE finished the cast and nothing landed
      } else if (age > SELF_BUFF_HARD_CAP_MS) {
        this.log(`no answer to cast ${spellId} after ${SELF_BUFF_HARD_CAP_MS / 1000}s — retrying (not a tier problem)`);
        this._noShow(spellId, fam, now, { walk: false });
      }
      return;
    }

    // B9 — a fizzle-walked tier whose retry time has come is a target again.
    this._expireFizzleWalks(now);
    // B4 under the opt-in skill cap: a school's castable tier moved.
    this._checkSkillCap();

    // Casting requires Magic combat mode (ACE Player_Magic mismatch gate —
    // the untargeted arm at :279 mirrors the targeted one; B14's
    // BotAction="Buffing" stance pin is this rule's native-side shadow).
    // Enter Magic EXPLICITLY (ChangeCombatMode(8)) rather than
    // toggleCombatMode() — the equipment-derived toggle never reaches
    // Magic for a non-caster (02 C1). This is ONLY the Magic-entry path
    // for self-buffing; combat's own equipment-derived toggle for its
    // Melee/Missile ENGAGE stance (the bow/wand mode-revert trap, README
    // "Live-verified traps") is untouched — never blind-set THAT one.
    // A refusal backoff (no mana / missing components / busy) holds every
    // self-buff, the mode entry included; so does portal space.
    if (now < this._backoffUntil) return;
    if (portalSpaceActive(h)) return;
    if (h.GetCurrentCombatMode() !== 8) {
      const now0 = now;
      if (this._magicParkedUntil && now0 < this._magicParkedUntil) return; // gave up — don't retry-storm
      // The wasm refuses set(Magic) locally without a wielded caster and prints
      // its refusal line every time (session/commands/combat.rs) — don't send
      // a request that can't work; just hold and look again next park cycle.
      if (this._casterWielded() === false) {
        this._magicParkedUntil = now0 + MAGIC_MODE_PARK_MS;
        this._magicAttempts = 0;
        this._block("no-caster", MAGIC_MODE_PARK_MS, now0);
        this._logBlock("no-caster", "no caster (wand/orb/staff) wielded — self-buffs need Magic mode; holding");
        return;
      }
      if (now0 - (this._modeRequestedAt || 0) > 3000) {
        h.ChangeCombatMode(8);
        this._modeRequestedAt = now0;
        this._magicAttempts = (this._magicAttempts || 0) + 1;
        if (this._magicAttempts > MAGIC_MODE_ATTEMPT_LIMIT) {
          this._magicParkedUntil = now0 + MAGIC_MODE_PARK_MS;
          this._magicAttempts = 0;
          this.log(
            `give up entering Magic mode after ${MAGIC_MODE_ATTEMPT_LIMIT} attempts (no caster wielded?) — parked ${MAGIC_MODE_PARK_MS / 1000}s`
          );
        }
      }
      return;
    }
    this._magicAttempts = 0; // mode established — reset the guard

    // B14 — pacing + gates.
    if (now - this.lastCastAt < SPELL_CAST_INTERVAL_MS) return;
    if (h.GetCastBusyState() !== 0) return;
    if (h.GetBusyState() !== 0) return;

    // B11 — start a force-rebuff pass when any buff drops below threshold, so
    // the whole set recasts to a common start (aligned timers) instead of a
    // staggered one-buff-every-few-minutes drip.
    if (this.batchRebuff && !this._forceRebuffing && this._anyBelowThreshold()) {
      this._forceRebuffing = true;
      this._forceRebuffCast = new Set();
      this.allActiveSince = 0;
      this.log("batch rebuff: recasting all buffs to align timers");
    }

    // Next needed buff.
    for (const spellId of this.desired) {
      const spellParked = this.parkedUntil.get(spellId);
      if (spellParked && now < spellParked) continue;
      if (spellParked) this.parkedUntil.delete(spellId);
      // B10 — respect family-level reject parks during the batch.
      const fam = this._familyForSpell(spellId);
      if (fam !== undefined && (this._rejectParkedUntil.get(fam) ?? 0) > now) continue;
      if (this._isActive(spellId)) continue;
      // C3 shared serializer: another module (combat/vitals) may hold a
      // still-open cast claim (gesture done, resolution not yet seen) —
      // wait rather than overlap it. Degrade-open if the host predates
      // the token (contract 0.1).
      if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("buff")) return;
      const useDoneAtIssue = this._useDoneNow();
      if (!this._castSelfBuff(spellId)) {
        // Not sent (no player guid yet, or the host refused the action):
        // free the token we just claimed and retry on a later tick.
        if (typeof h.releaseCast === "function") h.releaseCast("buff");
        return;
      }
      this.lastCastAt = now;
      this.pending = { spellId, issuedAt: now, useDoneAtIssue, useDoneAt: 0, refusal: null, useDoneEvents: 0 };
      const prior = this._upgradeFrom(spellId, fam); // B8 upgrade baseline
      if (prior) {
        // Rows first stamped after this are this cast's (_ownLanding). Read
        // after the send, in the same seconds form _readRegistry stamps with.
        prior.sentAtS = Date.now() / 1000;
        this.pending.prior = prior;
      }
      this._lastPendingPollAt = 0;
      return;
    }
    // Nothing left to cast this pass.
    if (this._forceRebuffing) {
      // B11 complete — every family got its one recast; back to timer mode.
      this._forceRebuffing = false;
      this.log("batch rebuff complete");
    }

    // B7 — item enchants after self-buffs are settled.
    if (this._maintainItemBuffs(now, h)) return;

    if (!this.allActiveSince) {
      this.allActiveSince = now;
      this.log(`all ${this.desired.length} desired buffs active`);
    }
  }

  // B7 — returns true if it issued/awaits an item-enchant cast this tick.
  // The list is _itemPass: the Items tab's, and with the layer the worn armor
  // first.
  _maintainItemBuffs(now, h) {
    const list = this._itemPass(now);
    if (!list.length) return false;
    // Awaiting chat confirmation? Time it out (no-chat = retry next pass).
    if (this._itemPending) {
      const p = this._itemPending;
      const r = p.refusal;
      if (r) {
        // Refused outright: no chat will come. Components/mana hold all
        // casting like a self-buff refusal; anything else retries next pass
        // (with the layer, as a self buff would: _holdRefusedItem).
        this.lastRefusal = { code: r.code, cls: r.cls, spellId: p.spellId, at: now };
        if (r.cls === "components" || r.cls === "mana") {
          const ms = r.cls === "components" ? COMPONENTS_PARK_MS : MANA_BACKOFF_MS;
          this._backoffUntil = Math.max(this._backoffUntil, now + ms);
          this._block(r.cls, ms, now);
        }
        if (p.layer) this._holdRefusedItem(p, r.cls, now);
        this.log(`item enchant ${p.spellId} refused (${r.cls})`);
        this._itemPending = null;
        this._release();
        return true;
      }
      if (p.layer && p.useDoneAtIssue != null) {
        // With the layer, on ACE's own answer (B8's clocks): the per-item
        // lines come before the cast's UseDone (CreatePlayerSpell runs inside
        // DoCastSpell_Inner, FinishCast sends the UseDone), so a UseDone with
        // no line after the grace enchanted nothing, and the hard cap is a
        // lost UseDone. A long windup no longer times out with its line still
        // to come.
        if (!p.useDoneAt) {
          const seq = this._useDoneNow();
          if (seq != null && seq !== p.useDoneAtIssue) p.useDoneAt = now;
        }
        const age = now - p.issuedAt;
        if (p.useDoneAt && now - p.useDoneAt > SELF_BUFF_USE_DONE_GRACE_MS && age > SELF_BUFF_GIVE_UP_MS) {
          this._itemNoLine(p, now, "enchanted nothing");
        } else if (age > SELF_BUFF_HARD_CAP_MS) {
          this._itemNoLine(p, now, `had no answer in ${SELF_BUFF_HARD_CAP_MS / 1000} s`);
        }
        return true;
      }
      if (now - p.issuedAt > 5000) {
        if (p.layer) this._itemNoLine(p, now, "no-chat timeout");
        else {
          this.log(`item enchant no-chat timeout (${p.spellId})`);
          this._itemPending = null;
          if (typeof h.releaseCast === "function") h.releaseCast("buff"); // C3 shared serializer
        }
      }
      return true;
    }
    // A cast the host didn't send (below) waits ITEM_SEND_RETRY_MS before the
    // next try instead of re-claiming the token every kernel tick.
    if (now < (this._itemSendRetryAt ?? 0)) return false;
    for (const ib of list) {
      if (!this._itemDue(ib, now)) continue; // still fresh (by interval), or held
      // C3 shared serializer — see the self-buff cast site above.
      if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("buff")) return true;
      const itemUseDoneAtIssue = this._useDoneNow(); // _refusalIsFor's queued-before-issue check
      let sent = false;
      try {
        sent = h.CastSpell(ib.itemGuid, ib.spellId) !== false; // targeted at the item (worn armor: at us)
      } catch (_) {
        sent = false;
      }
      if (!sent) {
        // Not sent (the host refused the action): free the token now — a
        // pending + claimed token would block vitals/combat casts for the 5 s
        // no-chat timeout behind a cast that never went out — and retry later.
        this._release();
        this._itemSendRetryAt = now + 2000;
        this.log(`item enchant ${ib.spellId} not sent — retrying in 2 s`);
        return false;
      }
      this._itemPending = {
        spellId: ib.spellId, itemGuid: ib.itemGuid, issuedAt: now,
        useDoneAtIssue: itemUseDoneAtIssue, useDoneEvents: 0, refusal: null,
      };
      if (ib.itemName) this._itemPending.itemName = String(ib.itemName); // tightened B7 confirm (_onChat)
      if (ib.worn) Object.assign(this._itemPending, { worn: true, spellName: ib.spellName }); // confirmed by the spell's line
      if (typeof this.optFn === "function") this._itemPending.layer = true; // resolution + holds (header, "Worn armor")
      this.lastCastAt = now;
      return true;
    }
    return false;
  }
}

// ── Dynamic buff list (RynthAi BuffManager.BuildDynamicBuffList, :1607-1660) ──
// The C# bot never takes a buff list from its operator: it builds one from the
// character, in a fixed order — Creature Enchantment Mastery, Focus,
// Willpower, the other creature buffs plus a mastery for every TRAINED skill
// (IsSkillUsable = training >= 2, :1892), life/armor/protections, weapon auras.
// Step 7 (armor banes) are ITEM enchantments on worn armor — B7 casts them at
// our own guid after the self buffs, with the VT layer's BuffArmorImpen /
// BuffProfileBanes (_wornArmor) — so they are not in the self list. The family
// tables ([base name, SpellCategory]) live in buff_families.js; the category
// is the B2/B4 family, so any known ladder member stands in and B4 upgrades it
// to the best known tier. rynth_magic_update_test.cjs checks every category
// against the catalog.
// Scroll ladder (2026-10-19): a family is offered only through its normal
// scroll ladder (spell_ladders.json flag bit 2 — RynthAi resolves buffs by
// NAME, SpellManager.GetDynamicSelfBuffId, so it never could pick Zongo's Fist
// or Combat Medication); a character that knows nothing but quest / NPC /
// potion spells of a family gets no entry for it. A table without ladder data
// keeps the pre-2026-10-19 pick (best known enchantment by tier, Power).
const SKILL_TRAINED = 2; // SkillAdvancementClass.Trained

/**
 * RynthAi's dynamic self-buff list for a character, as spell ids (one known
 * scroll-ladder spell per family — the highest tier; the loop's B4 re-resolves
 * it).
 * @param {{knownIds: Iterable<number>, skills?: Map<number,number>|null, ladder?: object}} p
 *   skills: SkillType -> training (SkillAdvancementClass); null/absent means
 *   "unknown" and, like C# `_charSkills == null`, counts every skill usable.
 * @returns {number[]} ids in RynthAi order; [] without a ladder table.
 */
export function buildDynamicBuffList({ knownIds, skills = null, ladder = LADDER_TABLE } = {}) {
  if (!ladder || typeof ladder !== "object") return [];
  const best = bestKnownByFamily(knownIds, ladder); // category -> {id, tier, power, scroll}
  const usable = (skill) => !skills || (skills.get(skill) ?? 0) >= SKILL_TRAINED;
  const families = [];
  const push = (cat) => {
    if (!families.includes(cat)) families.push(cat);
  };
  const baseCats = new Set(BASE_CREATURE_BUFFS.map(([, c]) => c));
  if (usable(SKILL.CreatureEnchantment)) push(43); // step 1 — Creature Enchantment Mastery
  push(9); // step 2 — Focus Self
  push(11); // step 3 — Willpower Self
  for (const [, cat] of BASE_CREATURE_BUFFS) push(cat); // step 4 — other creature buffs
  for (const [skill, , cat] of SKILL_BUFFS) {
    if (cat === 43 || baseCats.has(cat)) continue; // mastery is step 1; bases are above
    if (usable(skill)) push(cat);
  }
  for (const [, cat] of LIFE_BUFFS) push(cat); // step 5
  for (const [, cat] of AURA_BUFFS) push(cat); // step 6
  return families.filter((cat) => best.has(cat)).map((cat) => best.get(cat).id);
}

/**
 * Keep the desired buffs this character can cast at SOME tier, the way B4
 * resolves them: the id itself is known (a known spell off the scroll ladder
 * is an explicit pick, cast as named), or its family holds a known
 * scroll-ladder spell — for an id off the ladder, one at or below its tier
 * (the pin's fallback). A plain "is this exact id known" filter drops
 * "Strength Self I" from a character that only kept Strength Self VI. Families
 * without ladder data (an older table, a family outside buff_families.js)
 * keep the old rule: any known enchantment of the family.
 */
export function filterCastableBuffs(desired, knownIds, ladder = LADDER_TABLE) {
  const known = new Set(Array.from(knownIds || [], (n) => Number(n) >>> 0));
  const knownFamilies = new Set(); // families with a known enchantment
  const lowestLadderTier = new Map(); // family -> lowest known scroll-ladder tier
  if (ladder && typeof ladder === "object") {
    for (const id of known) {
      const row = ladder[String(id)];
      if (!row || !rowIsEnchantment(row)) continue;
      knownFamilies.add(row[0]);
      if (rowCanonical(row, ladder) === true) lowestLadderTier.set(row[0], Math.min(lowestLadderTier.get(row[0]) ?? Infinity, row[1]));
    }
  }
  return Array.from(desired || [], (n) => Number(n) >>> 0).filter((id) => {
    if (known.has(id)) return true;
    const row = ladder && ladder[String(id)];
    if (!row) return false;
    const canon = rowIsEnchantment(row) ? rowCanonical(row, ladder) : null; // a Boost is no family member
    if (canon === null) return knownFamilies.has(row[0]);
    const low = lowestLadderTier.get(row[0]);
    return low !== undefined && (canon || low <= row[1]);
  });
}

// ── Scroll-ladder helpers (HUD Settings picker, VT Buffs tab) ────────────────
// All take the ladder table (default: the one loadSpellLadders() loaded) and
// are pure table lookups.

/** Is `id` on its family's normal scroll ladder (spell_ladders.json bit 2)? */
export function isCanonicalBuff(id, ladder = LADDER_TABLE) {
  return rowCanonical(ladder && ladder[String(Number(id) >>> 0)], ladder) === true;
}

/** The ladder tier (1..8) of a scroll-ladder spell; null for any other id. */
export function canonicalTier(id, ladder = LADDER_TABLE) {
  const row = ladder && ladder[String(Number(id) >>> 0)];
  return rowCanonical(row, ladder) === true ? Number(row[1]) : null;
}

/** The family (SpellCategory) of a laddered self buff; null when the table
 *  doesn't hold the id. */
export function buffFamilyOf(id, ladder = LADDER_TABLE) {
  const row = ladder && ladder[String(Number(id) >>> 0)];
  return Array.isArray(row) ? row[0] : null;
}

/** A buff spec whose ids name FAMILIES (the VT Buffs tab's rows), rewritten
 *  onto the scroll ladder: an id off the ladder, in a family with ladder data,
 *  becomes that family's tier-I ladder spell (B4 still resolves it to the best
 *  known tier); every other id, and "auto", unchanged. Migrates a spec captured
 *  from the pre-2026-10-19 dynamic list (4395 for Blood Drinker VIII, Zongo's
 *  Fist…), which buff_loop.js would otherwise honour as an explicit pin. Not
 *  for a spec of explicit picks (?botBuffs=, bot.setBuffs from a script). */
export function toLadderSpec(spec, ladder = LADDER_TABLE) {
  if (!Array.isArray(spec)) return spec;
  return spec.map((raw) => {
    const id = Number(raw) >>> 0;
    const row = ladder && ladder[String(id)];
    if (rowCanonical(row, ladder) !== false || !rowIsEnchantment(row)) return id; // a Boost (Heal Self) is no family member
    const first = canonicalLadderOf(row[0], ladder)[0];
    return first ? first.id : id;
  });
}

/** One family's scroll ladder, ascending by tier: [{ id, tier, power, scroll }]
 *  (same-tier copies — e.g. the five "Light Weapon Mastery Self VII" ids —
 *  in B4's preference order); [] for a family without ladder data. */
export function canonicalLadder(category, ladder = LADDER_TABLE) {
  return canonicalLadderOf(category, ladder);
}

/**
 * One row per buff family the character can maintain on its scroll ladder —
 * the best KNOWN ladder spell (highest tier, B4's same-tier order) — in the
 * bot's own buff order (BUFF_FAMILY_ORDER). Trained skills are NOT applied (a
 * picker lists every family; buildDynamicBuffList applies them).
 * @returns {{category, spellId, tier, tierText, power, label, base, group,
 *   groupOrder, order, school}[]} [] without ladder data.
 */
export function canonicalBuffFamilies({ knownIds, ladder = LADDER_TABLE } = {}) {
  if (!ladder || typeof ladder !== "object") return [];
  const best = bestKnownByFamily(knownIds, ladder);
  const out = [];
  for (const cat of BUFF_FAMILY_ORDER) {
    const b = best.get(cat);
    if (!b || rowCanonical(ladder[String(b.id)], ladder) !== true) continue;
    out.push({ ...buffFamilyInfo(cat), spellId: b.id, tier: b.tier, tierText: ROMAN[b.tier] || "", power: b.power });
  }
  return out;
}

/** Read the trained-skill map off a SessionHandle (playerStats().skills,
 *  stride 6: [type, current, base, ranks, training, next_cost]); the stats
 *  box is freed. null when unavailable. */
export function readSkillTraining(sessionHandle) {
  if (!sessionHandle || typeof sessionHandle.playerStats !== "function") return null;
  let ps = null;
  try {
    ps = sessionHandle.playerStats();
    const sk = Array.from(ps?.skills || [], Number);
    if (!sk.length) return null;
    const out = new Map();
    for (let i = 0; i + 5 < sk.length; i += 6) out.set(sk[i], sk[i + 4]);
    return out;
  } catch (_) {
    return null;
  } finally {
    try {
      ps?.free?.();
    } catch (_) {
      /* already freed */
    }
  }
}

/** Convenience for bot.js / the HUD: the dynamic list for a live session
 *  (loads the ladder table first). */
export async function dynamicBuffsFor(sessionHandle) {
  const ladder = await loadSpellLadders();
  let known = [];
  try {
    known = sessionHandle?.playerKnownSpells ? Array.from(sessionHandle.playerKnownSpells() || [], Number) : [];
  } catch (_) {
    known = [];
  }
  return buildDynamicBuffList({ knownIds: known, skills: readSkillTraining(sessionHandle), ladder });
}

export default RynthBuffLoop;
