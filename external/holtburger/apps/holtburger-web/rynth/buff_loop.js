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
//   B5  incantation tier-cap: cap the target at the highest tier OBSERVED
//       landing for the family (skill-capped incantations don't recast
//       forever chasing their nominal tier).
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

import { portalSpaceActive } from "./portal_gate.js";

// Lazy-loaded family tier ladder (id -> [category, tier, flags, power],
// self-beneficial spells, baked from the spell DAT — rynth_spell_ladders_test
// .cjs documents and checks the shape). Shared across all buff-loop instances.
let LADDER_TABLE = null;
let LADDER_PROMISE = null;
const LADDER_FLAG_SELF_TARGETED = 1;
const LADDER_FLAG_ENCHANTMENT = 2;
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
  // Node (tests, harness tools) has no fetch for file: URLs.
  if (url.startsWith("file:") && typeof window === "undefined") {
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
const COMPONENTS_PARK_MS = 5 * 60_000;
const MANA_BACKOFF_MS = 15_000;
const TRANSIENT_BACKOFF_MS = 1_000;
const PLACE_PARK_MS = 60_000;

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
    this._familyAchievedTier = new Map(); // category -> highest landed tier (B5)
    this._spellTier = new Map(); // spellId -> roughLevel
    // B9 tier-walk-down (finding 5): spell ids that silently no-showed are
    // marked unresolvable and excluded from the ladder, so the family
    // re-resolves to the next lower known tier instead of parking unbuffed.
    this._unresolvable = new Set();
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
    this.spellFamily = new Map(); // spellId -> family (learned from landings)
    this.lastRefreshAt = 0;
    // B8/B9 state
    this.pending = null; // { spellId, issuedAt }
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
    this._itemLastCast = new Map(); // "spellId:itemGuid" -> confirmed ts
    this._itemPending = null; // { spellId, itemGuid, issuedAt }
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
    if (/^You cast .+ on /.test(e.text)) {
      const key = `${this._itemPending.spellId}:${this._itemPending.itemGuid}`;
      this._itemLastCast.set(key, Date.now());
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
    this.log("force rebuff: recasting all buffs");
  }

  /** "Cancel Force Rebuff" — back to timer mode; an in-flight cast still
   *  resolves. */
  cancelForceRebuff() {
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
  // B5: cap at the highest tier we've OBSERVED landing for the family (an
  // Incantation nominally tier 8 that lands skill-capped at 6 must not
  // recast forever chasing 8).
  _buildLadders() {
    this._laddersBuilt = true;
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
      byFamily.get(meta.category).push({ id, tier: meta.tier, power: meta.power || 0 });
    }
    // Resolve each raw desired buff to the best known tier in its family.
    const resolved = [];
    for (const rawId of this.rawDesired) {
      const meta = this._spellMeta(rawId);
      const fam = meta ? meta.category : this._familyOfSpell.get(rawId);
      if (fam == null || !byFamily.has(fam) || (meta && meta.enchantment === false)) {
        resolved.push(rawId); // no ladder data (or not an enchantment) — keep as-is
        continue;
      }
      const cap = this._familyAchievedTier.get(fam) ?? 8;
      // Tier first (C# BuffManager targets the highest LEVEL), Power breaks a
      // same-tier tie — ACE's stacking winner within a category.
      const ladder = byFamily
        .get(fam)
        .filter((e) => e.tier <= cap)
        .sort((a, b) => b.tier - a.tier || b.power - a.power);
      const best = ladder[0] ? ladder[0].id : rawId;
      // Log a resolution once, not on every rebuild (B5 rebuilds after each
      // family's first landing — the same 4 lines used to repeat per confirm).
      if (!this._ladderLogged) this._ladderLogged = new Map();
      if (best !== rawId && this._ladderLogged.get(rawId) !== best) {
        this.log(`ladder: ${rawId} -> ${best} (family ${fam}, tier ${this._spellTier.get(best)})`);
      }
      this._ladderLogged.set(rawId, best);
      resolved.push(best);
    }
    this.desired = resolved;
  }

  // B5 — record the tier a family actually landed at (from the registry),
  // and if a capped tier changes, rebuild ladders.
  _recordAchievedTiers(reg) {
    if (!reg) return;
    let changed = false;
    for (const [family, entry] of reg) {
      const tier = this._spellTier.get(entry.spellId);
      if (tier == null) continue;
      const prev = this._familyAchievedTier.get(family) ?? 0;
      if (tier > prev) {
        this._familyAchievedTier.set(family, tier);
        changed = true;
      }
    }
    if (changed && this.tierLadders) this._buildLadders();
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
      }
      const prev = out.get(family);
      // B2 last-wins quirk (finding 10): C# keeps the LAST wire row for a
      // family (BuffManager.cs:1374); JS deliberately keeps the entry with the
      // LATER expiry (max-remaining) — more defensible against reordered/stale
      // rows. CONFIRMED-no-change: the JS choice stands.
      if (!prev || expiresAtMs > prev.expiresAtMs) {
        out.set(family, { spellId, expiresAtMs, permanent });
      }
      this.spellFamily.set(spellId, family);
    }
    this._pruneReceived(seen);
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
    this._recordAchievedTiers(reg); // B5
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
  heartbeat() {
    if (!this.registryReady) return; // login gate owns the pre-ready window
    if (Date.now() - this.lastRefreshAt > PERIODIC_REFRESH_INTERVAL_MS) this._refresh();
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
      const cap = this._familyAchievedTier.get(family);
      const effectiveTarget = cap != null ? Math.min(desiredTier, cap) : desiredTier;
      // A landed spell with at least the desired spell's Power already wins
      // ACE's stacking (higher power holds the category) — recasting a lower
      // "tier" over it would flap forever without changing anything.
      const landedPower = this._spellMeta(entry.spellId)?.power || 0;
      const desiredPower = this._spellMeta(spellId)?.power || 0;
      const outpowers = landedPower > 0 && desiredPower > 0 && landedPower >= desiredPower;
      if (landedTier < effectiveTarget && !outpowers) return false; // upgrade
    }
    if (entry.permanent) return true;
    // B8×B3 (finding 9): a family confirmed landing below the rebuff threshold
    // is held active while present so the batch doesn't rebatch it forever;
    // it's recast only once it fully drops from the registry.
    if (family !== undefined && this._shortDurationFamilies.has(family)) return true;
    return remainingS > REBUFF_SECONDS_REMAINING;
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
    return {
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
  _noShow(spellId, fam, now, { walk = true } = {}) {
    let walked = false;
    if (walk && this.tierLadders && fam !== undefined && !this._unresolvable.has(spellId)) {
      this._unresolvable.add(spellId);
      this._buildLadders(); // re-resolve desired excluding unresolvable ids
      walked = this.desired.some(
        (id) => id !== spellId && !this._unresolvable.has(id) && this._familyForSpell(id) === fam
      );
      if (!walked) this._unresolvable.delete(spellId); // no lower tier — undo, let B9 park
    }
    if (walked) {
      this.log(`tier-down ${spellId} unresolvable -> family ${fam} walking to a lower tier`);
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
          this._noShow(spellId, fam, now);
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
    // Desired ladders from the known book (same source as _buildLadders).
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    const desired = [];
    for (const rawId of this.rawDesired) {
      const meta = this._spellMeta(rawId);
      const fam = meta?.category ?? this._familyOfSpell.get(rawId);
      const ladder = [];
      for (const id of known) {
        const m = this._spellMeta(id);
        if (!m || m.category !== fam) continue;
        ladder.push({
          Id: id, Name: this._nbSpellName(id, fam), Family: fam, Tier: m.tier,
          Known: !this._unresolvable.has(id), // folds the B9 walk-down blacklist
        });
      }
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
        RebuffSecondsRemaining: REBUFF_SECONDS_REMAINING,
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
        AchievedTier: [...this._familyAchievedTier].map(([f, t]) => ({ Family: f, Value: t })),
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
      const landed = famEntry ? this._remainingS(famEntry) > 0 : this._isActiveReal(spellId);
      if (landed) {
        this.noShows.delete(spellId);
        // B12 — mark the family recast this cycle so the force-rebuff pass
        // stops re-selecting it.
        if (fam !== undefined) {
          this._forceRebuffCast.add(fam);
          // finding 9: landed BELOW the rebuff threshold -> hold it active so
          // the batch doesn't rebatch this short-duration buff forever (the
          // deliberate improvement over C#, which rebatches endlessly here).
          if (famEntry && !famEntry.permanent && this._remainingS(famEntry) <= REBUFF_SECONDS_REMAINING) {
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
  _maintainItemBuffs(now, h) {
    if (!this.itemBuffs.length) return false;
    // Awaiting chat confirmation? Time it out (no-chat = retry next pass).
    if (this._itemPending) {
      const r = this._itemPending.refusal;
      if (r) {
        // Refused outright: no chat will come. Components/mana hold all
        // casting like a self-buff refusal; anything else retries next pass.
        this.lastRefusal = { code: r.code, cls: r.cls, spellId: this._itemPending.spellId, at: now };
        if (r.cls === "components" || r.cls === "mana") {
          const ms = r.cls === "components" ? COMPONENTS_PARK_MS : MANA_BACKOFF_MS;
          this._backoffUntil = Math.max(this._backoffUntil, now + ms);
          this._block(r.cls, ms, now);
        }
        this.log(`item enchant ${this._itemPending.spellId} refused (${r.cls})`);
        this._itemPending = null;
        this._release();
        return true;
      }
      if (now - this._itemPending.issuedAt > 5000) {
        this.log(`item enchant no-chat timeout (${this._itemPending.spellId})`);
        this._itemPending = null;
        if (typeof h.releaseCast === "function") h.releaseCast("buff"); // C3 shared serializer
      }
      return true;
    }
    // A cast the host didn't send (below) waits ITEM_SEND_RETRY_MS before the
    // next try instead of re-claiming the token every kernel tick.
    if (now < (this._itemSendRetryAt ?? 0)) return false;
    for (const ib of this.itemBuffs) {
      const key = `${ib.spellId}:${ib.itemGuid}`;
      const last = this._itemLastCast.get(key) ?? 0;
      if (now - last < this.itemRecastMs) continue; // still fresh (by interval)
      // C3 shared serializer — see the self-buff cast site above.
      if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("buff")) return true;
      const itemUseDoneAtIssue = this._useDoneNow(); // _refusalIsFor's queued-before-issue check
      let sent = false;
      try {
        sent = h.CastSpell(ib.itemGuid, ib.spellId) !== false; // targeted at the item
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
// Step 7 (armor banes) are ITEM enchantments cast on worn armor — B7's job,
// which needs item guids — so they are not in the self list. Each entry is
// [base name, SpellCategory]; the category is the B2/B4 family, so any known
// member stands in and B4 upgrades it to the best known tier.
// rynth_magic_update_test.cjs checks every category against the catalog.
const SKILL = Object.freeze({
  MeleeDefense: 6, MissileDefense: 7, ArcaneLore: 14, MagicDefense: 15, ManaConversion: 16,
  ItemTinkering: 18, AssessPerson: 19, Deception: 20, Healing: 21, Jump: 22, Lockpick: 23, Run: 24,
  AssessCreature: 27, WeaponTinkering: 28, ArmorTinkering: 29, MagicItemTinkering: 30,
  CreatureEnchantment: 31, ItemEnchantment: 32, LifeMagic: 33, WarMagic: 34, Leadership: 35,
  Loyalty: 36, Fletching: 37, Alchemy: 38, Cooking: 39, Salvaging: 40, TwoHandedCombat: 41,
  VoidMagic: 43, HeavyWeapons: 44, LightWeapons: 45, FinesseWeapons: 46, Shield: 48, DualWield: 49,
  Recklessness: 50, SneakAttack: 51, DirtyFighting: 52, Summoning: 54,
});
const SKILL_TRAINED = 2; // SkillAdvancementClass.Trained

export const BASE_CREATURE_BUFFS = Object.freeze([
  ["Strength Self", 1], ["Endurance Self", 3], ["Coordination Self", 7], ["Quickness Self", 5],
  ["Focus Self", 9], ["Willpower Self", 11], ["Magic Resistance Self", 41],
  ["Invulnerability Self", 37], ["Impregnability Self", 39],
]);
// C# CreatureSkillBuffs (:250-289), insertion order: [skill, base name, category].
export const SKILL_BUFFS = Object.freeze([
  [SKILL.MeleeDefense, "Invulnerability Self", 37], [SKILL.MissileDefense, "Impregnability Self", 39],
  [SKILL.MagicDefense, "Magic Resistance Self", 41], [SKILL.HeavyWeapons, "Heavy Weapon Mastery", 31],
  [SKILL.LightWeapons, "Light Weapon Mastery", 17], [SKILL.FinesseWeapons, "Finesse Weapon Mastery", 23],
  [SKILL.TwoHandedCombat, "Two Handed Combat Mastery", 593], [SKILL.Shield, "Shield Mastery", 674],
  [SKILL.DualWield, "Dual Wield Mastery", 668], [SKILL.Recklessness, "Recklessness Mastery", 671],
  [SKILL.SneakAttack, "Sneak Attack Mastery", 677], [SKILL.DirtyFighting, "Dirty Fighting Mastery", 665],
  [SKILL.AssessCreature, "Monster Attunement", 63], [SKILL.AssessPerson, "Person Attunement", 205],
  [SKILL.ArcaneLore, "Arcane Enlightenment", 53], [SKILL.ArmorTinkering, "Armor Tinkering Expertise", 55],
  [SKILL.ItemTinkering, "Item Tinkering Expertise", 57], [SKILL.MagicItemTinkering, "Magic Item Tinkering Expertise", 59],
  [SKILL.WeaponTinkering, "Weapon Tinkering Expertise", 61], [SKILL.Salvaging, "Arcanum Salvaging", 435],
  [SKILL.Run, "Sprint", 77], [SKILL.Jump, "Jumping Mastery", 69], [SKILL.Loyalty, "Fealty", 75],
  [SKILL.Leadership, "Leadership Mastery", 71], [SKILL.Deception, "Deception Mastery", 65],
  [SKILL.Healing, "Healing Mastery", 67], [SKILL.Lockpick, "Lockpick Mastery", 73],
  [SKILL.Cooking, "Cooking Mastery", 216], [SKILL.Fletching, "Fletching Mastery", 218],
  [SKILL.Alchemy, "Alchemy Mastery", 221], [SKILL.ManaConversion, "Mana Conversion Mastery", 51],
  [SKILL.CreatureEnchantment, "Creature Enchantment Mastery", 43], [SKILL.ItemEnchantment, "Item Enchantment Mastery", 45],
  [SKILL.LifeMagic, "Life Magic Mastery", 47], [SKILL.WarMagic, "War Magic Mastery", 49],
  [SKILL.VoidMagic, "Void Magic Mastery", 645], [SKILL.Summoning, "Summoning Mastery", 696],
]);
export const LIFE_BUFFS = Object.freeze([
  ["Regeneration Self", 93], ["Rejuvenation Self", 95], ["Mana Renewal Self", 97], ["Armor Self", 115],
  ["Acid Protection Self", 101], ["Fire Protection Self", 109], ["Cold Protection Self", 105],
  ["Lightning Protection Self", 107], ["Blade Protection Self", 113], ["Piercing Protection Self", 111],
  ["Bludgeoning Protection Self", 103],
]);
export const AURA_BUFFS = Object.freeze([
  ["Aura of Blood Drinker Self", 154], ["Aura of Hermetic Link Self", 195], ["Aura of Heart Seeker Self", 152],
  ["Aura of Spirit Drinker Self", 695], ["Aura of Swift Killer Self", 158], ["Aura of Defender Self", 156],
]);

/**
 * RynthAi's dynamic self-buff list for a character, as spell ids (one known
 * enchantment per family — the highest tier; the loop's B4 re-resolves it).
 * @param {{knownIds: Iterable<number>, skills?: Map<number,number>|null, ladder?: object}} p
 *   skills: SkillType -> training (SkillAdvancementClass); null/absent means
 *   "unknown" and, like C# `_charSkills == null`, counts every skill usable.
 * @returns {number[]} ids in RynthAi order; [] without a ladder table.
 */
export function buildDynamicBuffList({ knownIds, skills = null, ladder = LADDER_TABLE } = {}) {
  if (!ladder || typeof ladder !== "object") return [];
  const bestByFamily = new Map(); // category -> {id, tier, power}
  for (const raw of knownIds || []) {
    const id = Number(raw) >>> 0;
    const row = ladder[String(id)];
    if (!row) continue;
    const flags = row.length > 2 ? Number(row[2]) : LADDER_FLAG_ENCHANTMENT;
    if (!(flags & LADDER_FLAG_ENCHANTMENT)) continue;
    const cur = bestByFamily.get(row[0]);
    const power = Number(row[3]) || 0;
    if (!cur || row[1] > cur.tier || (row[1] === cur.tier && power > cur.power)) {
      bestByFamily.set(row[0], { id, tier: row[1], power });
    }
  }
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
  return families.filter((cat) => bestByFamily.has(cat)).map((cat) => bestByFamily.get(cat).id);
}

/**
 * Keep the desired buffs this character can cast at SOME tier: the id itself
 * is known, or its family holds a known enchantment (B4 resolves to it). A
 * plain "is this exact id known" filter drops "Strength Self I" from a
 * character that only kept Strength Self VI.
 */
export function filterCastableBuffs(desired, knownIds, ladder = LADDER_TABLE) {
  const known = new Set(Array.from(knownIds || [], (n) => Number(n) >>> 0));
  const knownFamilies = new Set();
  if (ladder && typeof ladder === "object") {
    for (const id of known) {
      const row = ladder[String(id)];
      if (row && (row.length < 3 || Number(row[2]) & LADDER_FLAG_ENCHANTMENT)) knownFamilies.add(row[0]);
    }
  }
  return Array.from(desired || [], (n) => Number(n) >>> 0).filter((id) => {
    if (known.has(id)) return true;
    const row = ladder && ladder[String(id)];
    return !!row && knownFamilies.has(row[0]);
  });
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
