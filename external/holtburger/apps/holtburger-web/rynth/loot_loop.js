// RynthLootLoop — Phase-3 corpse looting on the RynthWebHost seam.
//
// Report 03 Tier-4 flow over the landed reads: find corpse → walk into
// reach → UseObject (opens; server replies ViewContents which stamps
// groundContainerId + container contents) → enumerate → value-rule →
// moveItem(item, mainPack-or-first-side-pack-with-room, 0) (RynthCoreHost
// MoveItemExternal, wire 0x0019; _pickupDest) → confirm via playerInventory →
// close the corpse. Paced on the busy gate;
// every action fire-and-forget with poll-shaped confirmation, plus the two
// server refusals the push plane carries (below).
//
// Movement claim (report 03 C4 fix): the corpse-approach MoveToPosition calls
// below (SCAN's initial approach, APPROACH's progress-watchdog re-issue) have
// no busy latch of their own — the kernel priority ladder already keeps
// combat/buff from ticking concurrently, but the independent explore-pressure
// ticker (bot.js ExplorePressureController) does NOT go through the kernel at
// all. `state === "APPROACH"` IS that claim: bot.js's movementClaimed() reads
// it directly (same established pattern as kernel.js's own
// `loot.state !== "SCAN"` pin check) so a pressure hop can no longer fire
// while a corpse approach is in flight. Kept intentionally narrow (only the
// approach window, not OPEN/LOOT/CONFIRM which issue no movement) and adds NO
// nav/guardLeg — the existing progress watchdog (20s timeout, 3s re-issue)
// below is unchanged.
//
// 2026-10-12 update (client drift since 2026-07-24):
// - Pickup refusals are read off the push plane instead of waiting out
//   PICKUP_TIMEOUT_MS: kind=48 InventoryActionFailed (authoritative since
//   de854bf3; u32 = item guid, u32b = WeenieError) ends the CONFIRM at once.
//   ACE refuses a pickup that lands while the previous one is still in its
//   start phase with YoureTooBusy (kind=13 UseFailed, code 0x1D) just before
//   the 48 — that one is retried after a short wait, as the client's own
//   Loot All does (plugins/corpse-loot-bar.js LOOT_ALL_*, whose constants
//   are mirrored here). Each confirmed pickup is followed by a short pause.
// - OPEN gives up: a corpse ACE will not open (another player's kill still
//   under loot rights, …) was re-Used every 6 s forever, and `state !==
//   "SCAN"` pins the kernel to Loot — buffing starved behind it.
// - A tick gap (the kernel ran combat/vitals instead) re-arms the state
//   clocks: APPROACH used to time out on the stale clock after every fight
//   that interrupted it and park a perfectly good corpse.
// - A full pack pauses looting (host TryGetFreeSlots, corrected 2026-10-12).
// - Corpse distance uses the world frame, so a corpse just across an outdoor
//   landblock seam is found (it used to require the same landblock).
// - A finished corpse is closed (NoLongerViewingContents): ACE keeps an open
//   container's Viewer locked to us, so the corpses we left items on stayed
//   unlootable for everyone else; the close also shuts the client's loot
//   window (CloseGroundContainer → kind=31).
// - Pickups and inventory reads go through the host members (degrade-not-
//   throw, freed wasm rows); the raw `host.s` path stays only for test fakes.
// - Portal space holds the whole tick (rynth/portal_gate.js): a teleport's
//   tunnel can outlast arrival by up to 60 s while the destination builds, and
//   a MoveToPosition issued in it walks the body through cells whose collision
//   has not landed. The hold leaves _lastTickAt untouched, so the tick after
//   it takes the preemption path above and re-issues the approach.
// - Movement facts (verified by the move slice, 2026-10-12): a server-driven
//   MoveTo/TurnTo (ACE's use-approach, a targeted cast's TurnTo, a melee
//   charge) REPLACES an in-flight client moveToPosition — the APPROACH
//   progress watchdog and the resume re-issue are what recover it; a cast's or
//   attack's MaybeStopCompletely does NOT cancel it. host.StopCompletely()
//   ends only the bot's own pursuit/MoveTo.
//
// 2026-10-13 — corpse refusals (WebAC comparison rynth-macro-nav-2): ACE turns
// a corpse away with a CommunicationTransientString (kind=2 chat, category
// Transient), not a UseFailed — TryUseItem then sends a plain UseDone — so
// OPEN waited out OPEN_TIMEOUT_MS × MAX_OPEN_TRIES on every corpse we may not
// loot (another player's kill, a fellow's unshared kill, a rare or PK corpse,
// a player corpse), again every LOOTED_TTL_MS, while the kernel's Loot rung
// held buffing off. The three refusals (ACE Corpse.Open, Container.InUseMessage
// via SendTransientError) now end the corpse on the next tick when the line
// names it (TryGetObjectName — names repeat, guids do not):
//   "You do not yet have the right to loot the X."  parked (LOOTED_TTL_MS
//       already outlasts ACE's Corpse.HalfLife, 180 s, after which a monster
//       corpse opens to everyone)
//   "You may not loot the X because …"  (rare / PK kill) parked while the guid
//       stays in NearbyGuids
//   "The X is already in use by Y!"  skipped INUSE_SKIP_MS, parked on the
//       MAX_INUSE_REFUSALS-th refusal (constants after WebAC corpseBook.ts,
//       AGPL-3.0; the strings are re-derived from ACE)
// A corpse ACE opens never sees any of this, so the default path is unchanged.
//
// 2026-10-19 — the VTank looting options, made live. They reach the loop
// through ONE injected reader, `optFn(key)` (rynth/vt/index.js binds it).
// Without the layer (?botVt=off) it is absent and every path below is the
// literal loop, host call for host call:
//   CorpseApproachRangeMin  the reach (REACH_M without the layer): walk to
//       within it, then Use. ACE's corpse UseRadius is 2 m edge to edge and
//       the server walks the last steps itself; floored at REACH_FLOOR_M (the
//       client's MoveTo stops ~0.6 m short of the point).
//   Corpse ownership (VTank). A corpse's LongDesc (string 16, an assessment
//       property: one RequestId) reads "Killed by <killer>." (ACE
//       Creature_Death.CreateCorpse; the admin '+' stripped, "misadventure"
//       when nobody), plus " This corpse generated a rare item!" on a rare's
//       (Corpse.TryGenerateRare, before the corpse enters the world). Our kill
//       — or our pet's, "<me>'s <pet>" (Pet.cs) — and our own corpse: always.
//       A fellow's kill (TryGetFellowshipInfo names) with LootFellowCorpses, at
//       once. Anyone else's with LootAllCorpses, from OTHERS_AFTER_MS after we
//       first saw it (stamped by _findCorpse: a fight in between can only
//       make that later). Never someone else's rare; never one that names no
//       killer. LootOnlyRareCorpses: only our own rare's corpse. A corpse whose
//       description is still on its way is not available (the kernel asks
//       _findCorpse every tick and must not pin Loot on it); no answer after
//       DESC_TRIES appraisals names no killer. "You do not yet have the right"
//       on a fellow's / anyone's corpse is tried again once it is 100 s old,
//       then every NOT_YET_RETRY_MS (ACE opens a monster corpse to everyone
//       ~120 s after it appears, Corpse.HalfLife), and left while in view
//       after MAX_NOT_YET_REFUSALS (a player's corpse never opens). A host that
//       cannot read descriptions keeps the old rule (every corpse; the server
//       decides), except that LootOnlyRareCorpses then goes by the
//       "<me> has discovered the X!" System line (Corpse.EnterWorld, 0.5 s
//       after a rare's corpse appears; it names no corpse): the corpses the
//       book saw appear within RARE_HINT_MS before it.
//   ReadUnknownScrolls. A scroll (Writable, with a Spell DataId 28 — in the
//       CreateObject header, no appraisal) of a spell we don't know that ACE
//       would let us learn (canReadScroll: Player_Skills.CanReadScroll) is
//       taken whatever its value and read after the corpse. A scroll the loot
//       profile Keeps (Sell, KeepUpTo) is kept; a Read rule's scroll is read
//       under the same test, and only while ReadUnknownScrolls is on.
//   A .utl Salvage rule's pickups are salvaged after the corpse.
// Nothing taken back from our OWN corpse is salvaged or read (a Salvage rule
// would destroy our own gear). The reading and the salvaging belong to the VT
// support modules (rynth/vt/support/scrolls.js, salvage.js): each confirmed
// pickup to read or salvage is handed over through takeWork(purpose), and
// they start nothing while corpseWorkPending() — a corpse in hand, just
// finished, or being described — so no read or salvage overlaps a corpse Use.

import { portalSpaceActive } from "./portal_gate.js";
import { worldX, worldY, isEnvCellId } from "./nav_frame.js";
import { SCHOOL_SKILL } from "./skill_cap.js";

const CORPSE_WCID = 21;
const LOOTED_TTL_MS = 5 * 60_000;
const OPEN_TIMEOUT_MS = 6000;
const PICKUP_TIMEOUT_MS = 6000;
const REACH_M = 4.0;
// LootScoring finding #1 (netwasm-spike, fixed 2026-07-17): how long an
// unappraised item may hold the loot head while its Value(19) streams in
// after a RequestId. Mirrors the C# assess window discipline
// (CorpseOpenController.cs:915-997) without wedging on a never-answering id.
const APPRAISE_TIMEOUT_MS = 2500;
// plugins/corpse-loot-bar.js LOOT_ALL_* (the client's Loot All pacing).
const NEXT_PICKUP_DELAY_MS = 150; // after a confirmed pickup — ACE queues it as NextPickup
const BUSY_RETRY_DELAY_MS = 900; // after a "You're too busy" refusal
const BUSY_WINDOW_MS = 1500; // a YoureTooBusy this recent explains a pickup failure
const MAX_PICKUP_TRIES = 3; // per item, then it is skipped
const MAX_OPEN_TRIES = 3; // Use attempts per corpse before it is parked
const MAX_OPEN_BUSY_RETRIES = 4; // uncounted "too busy" re-Uses per corpse
const OPEN_FAIL_WINDOW_MS = 3000; // a UseFailed this soon after our Use is ours
const OPEN_RETRY_DELAY_MS = 1000;
// No loot tick for this long = the kernel ran something else (the kernel ticks
// at the host rate, 10 Hz). Since 2026-10-12 a Loot→Combat preemption also
// CANCELS loot's in-flight walk (kernel.js / combat slice), so resume promptly.
const PREEMPT_GAP_MS = 1000;
const PACK_CHECK_MS = 2000; // free-slot verdict cache (the kernel scans every tick)
const WERR_YOURE_TOO_BUSY = 0x1d;
// ClientEvent kinds (scene3d/client_event_kinds.js; inlined — the scene3d
// table is not part of the rynth tree that tests stage).
const KIND_USE_FAILED = 13; // u32 = WeenieError
const KIND_INVENTORY_ACTION_FAILED = 48; // u32 = item guid, u32b = WeenieError
const KIND_CHAT = 2; // text = the line, u32b = chat category (src/lib.rs CHAT_CATEGORY_*)
const CHAT_CATEGORY_SYSTEM = 0;
const CHAT_CATEGORY_TRANSIENT = 9; // CommunicationTransientString
// Corpse refusals (header, 2026-10-13).
const INUSE_SKIP_MS = 10_000; // "already in use" — someone else has it open
const MAX_INUSE_REFUSALS = 3; // then parked like any refused corpse
// The VTank looting options (header, 2026-10-19).
const REACH_FLOOR_M = 1; // CorpseApproachRangeMin floor
const PSTR_LONG_DESC = 16; // a corpse's "Killed by X." (after an appraisal)
const DESC_RETRY_MS = 3000; // an unanswered corpse appraisal is asked again …
const DESC_TRIES = 3; // … up to this many times; then it names no killer
const OTHERS_AFTER_MS = 100_000; // VTank: someone else's kill, from 100 s after it appeared
const NOT_YET_RETRY_MS = 15_000; // "do not yet have the right" on a corpse we may take later
const MAX_NOT_YET_REFUSALS = 5; // then left while in view
const RARE_HINT_MS = 5000; // corpses this new when "<me> has discovered the X!" arrives
const FELLOW_CACHE_MS = 2000;
const KNOWN_SPELLS_CACHE_MS = 2000;
const SKILLS_CACHE_MS = 5000;
const IT_WRITABLE = 0x2000; // ItemType Writable (scrolls, books)
const DID_SPELL = 28; // PropertyDataId Spell — a scroll's spell
const SCROLL_SKILL_MARGIN = 50; // ACE Player_Skills magicSkillCheckMargin
const SKILL_TRAINED = 2; // SkillAdvancementClass.Trained
const READ_SPELL_TTL_MS = 10 * 60_000; // a spell taken to read keeps its other scrolls from being taken
const MAX_WORK = 200; // confirmed pickups nobody took over (no support module) are dropped oldest first
const BOOK_PRUNE_MS = 1000; // the corpse book drops corpses out of view at most this often
const SETTLE_AFTER_CORPSE_MS = 1500; // ACE keeps us busy through the last pickup's return animation
const RARE_FOUND_RE = /^(.+) has discovered the (.+)!$/; // ACE Corpse.EnterWorld
const RARE_TAIL = "This corpse generated a rare item!"; // ACE Corpse.TryGenerateRare

// ACE.Server Corpse.Open (rare / PK / no rights yet) and Container.InUseMessage.
// The capture is the corpse's Name: "Corpse of X" / "Treasure of X"
// (Creature_Death.CreateCorpse).
const CORPSE_REFUSALS = [
  ["notYet", /^You do not yet have the right to loot the (.+)\.$/],
  ["barred", /^You may not loot the (.+?) because /],
  ["inUse", /^The (.+?) is already in use by .*!$/],
];

/** One of ACE's refusals to open a corpse — { why: "notYet" | "barred" |
 *  "inUse", name } — or null for any other line. */
export function parseCorpseRefusal(text) {
  if (typeof text !== "string" || !text) return null;
  const line = text.trimEnd();
  for (const [why, re] of CORPSE_REFUSALS) {
    const m = re.exec(line);
    if (m) return { why, name: m[1] };
  }
  return null;
}

/** ACE Player_Skills.CanReadScroll — can a scroll of difficulty `power` be
 *  learned with the school's skill row ({ current, training })? Below 50 or
 *  from 300 anyone can; otherwise the school must be trained and its current
 *  (buffed) skill ≥ power − 50. An unknown difficulty is not judged (false).
 *  The loot loop takes scrolls by it and rynth/vt/support/scrolls.js reads by it. */
export function canReadScroll(power, row) {
  const p = Number(power);
  if (!Number.isFinite(p) || p <= 0) return false;
  if (p < 50 || p >= 300) return true;
  const skill = Number(row && row.current);
  return !!row && Number(row.training) >= SKILL_TRAINED && Number.isFinite(skill) && skill >= p - SCROLL_SKILL_MARGIN;
}

/** A corpse's LongDesc (header, 2026-10-19) → { killer, rare }: the killer it
 *  names without ACE's admin '+', "" for none or "misadventure"; rare when it
 *  says the corpse generated a rare item. */
export function parseCorpseDescription(text) {
  let s = typeof text === "string" ? text.trim() : "";
  const rare = s.endsWith(RARE_TAIL);
  if (rare) s = s.slice(0, -RARE_TAIL.length).trim();
  const m = /^Killed by (.+)\.$/.exec(s);
  let killer = m ? m[1].trim().replace(/^\+/, "") : "";
  if (killer.toLowerCase() === "misadventure") killer = "";
  return { killer, rare };
}

// Horizontal distance in the world frame (rynth/nav_frame.js — the one copy
// of the frame math). Outdoors, cells of different landblocks are comparable;
// indoors only the same landblock is (dungeon landblocks are not on the
// outdoor grid) — null when the two poses can't be compared.
export function horizontalDistance(a, b) {
  const ca = a.objCellId >>> 0;
  const cb = b.objCellId >>> 0;
  if (ca >>> 16 !== cb >>> 16 && (isEnvCellId(ca) || isEnvCellId(cb))) return null;
  return Math.hypot(worldX(cb, b.x) - worldX(ca, a.x), worldY(cb, b.y) - worldY(ca, a.y));
}

export class RynthLootLoop {
  constructor(host, opts = {}) {
    this.host = host;
    // Value(19) >= minValue. Default 0 = loot everything — a deliberate
    // polarity divergence from C#'s empty-profile-loots-nothing (LootScoring
    // finding #2, ruled by-design 2026-07-17): the playtester bot can sell
    // trash at vendors, and the director can raise the floor at any time via
    // set_loot_min_value.
    this.minValue = opts.minValue ?? 0;
    // Director-togglable looting (WP-4, C5-3 / FM-3): default ON (grind
    // persona unchanged) but boot-OFF for the explorer persona (bot.js), which
    // must not divert to a corpse — issue no MoveToPosition — while surveying.
    // set_loot_min_value / an explicit config.loot.enabled re-arm it. Mirrors
    // combat_loop's `enabled` hunt toggle. `!== false` so any truthy/absent
    // opts.enabled keeps the ON default.
    this.enabled = opts.enabled !== false;
    // VTank layer hooks (PLAN §3.14; inert at their defaults):
    //   corpseRangeM  how far a corpse may be to be looted (VTank
    //                 CorpseApproachRange-Max, a live settings cell); 30 m is
    //                 the old literal.
    //   classify      (item, { host, now }) => "pickup" | "skip" | "pending" |
    //                 null — a loaded VT loot profile (.utl). null (no profile,
    //                 or the profile has no verdict) = today's Value(19) floor.
    this.corpseRangeM = opts.corpseRangeM ?? 30;
    this.classify = opts.classify ?? null;
    this._assessAt = new Map(); // item guid -> first-hold ts (appraisal gate)
    this.log = opts.log || ((m) => console.log(`[loot] ${m}`));
    this.state = "SCAN"; // SCAN | APPROACH | OPEN | LOOT | CONFIRM
    this.corpse = 0;
    this.looted = new Map(); // corpse guid -> ts
    this.items = [];
    this.pendingItem = 0;
    this.stateSince = 0;
    this.lootedCount = 0;
    this.emptyCorpses = 0;
    this.refusedPickups = 0; // pickups the server refused (kind=48), retries excluded
    this._running = false;
    this._openTries = 0;
    this._openBusyRetries = 0;
    this._openIssuedAt = 0;
    this._openFailedAt = 0;
    this._openRetryAt = 0;
    this._openRetryCounts = true;
    this._pickupTries = new Map(); // item guid -> pickups sent (per corpse)
    this._pendingFailed = null; // { code, at } — kind=48 for pendingItem
    this._lastBusyAt = -Infinity; // last YoureTooBusy (kind=13 0x1D)
    this._nextPickupAt = 0;
    this._lastTickAt = 0;
    this._pack = { at: -Infinity, full: false };
    // Corpse refusals (header, 2026-10-13).
    this._corpseRefusal = null; // { guid, why } — the last refusal naming this.corpse
    this._barred = new Set(); // corpse guids ACE will not open for us ("may not loot … because"), while in view
    this._inUse = new Map(); // corpse guid -> { n, until } — "already in use" refusals, while in view
    // The VTank looting options (header, 2026-10-19). `optFn(key)` is the VT
    // layer's option reader (rynth/vt/index.js binds it); null = the literal loop.
    this.optFn = null;
    this._book = new Map(); // corpse guid -> what we know of it, while in view (_bookEntry)
    this._bookPrunedAt = -Infinity;
    this._seenScratch = new Set(); // reused by the once-a-second book prune
    this._ownCorpse = false; // the corpse in hand is our own (nothing from it is tagged)
    this._fellows = { at: -Infinity, names: [] };
    this._myNameLc = "";
    this._known = { at: -Infinity, set: new Set() };
    this._skills = { at: -Infinity, rows: null };
    this._readSpells = new Map(); // spell id -> ts a scroll of it was taken to read
    this._pendingTag = null; // { purpose, spellId } of the pickup in CONFIRM
    this._work = []; // confirmed pickups for the support modules: { guid, purpose, spellId, at }
    if (host && typeof host.onEvent === "function") host.onEvent((e) => this._onEvent(e));
  }

  startOn(host) {
    this._running = true;
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
  stop() {
    this._running = false;
  }

  _setState(s) {
    this.state = s;
    this.stateSince = Date.now();
    if (s === "SCAN") this._assessAt.clear(); // per-corpse holds never leak across corpses
  }

  // Push plane: the server refusals the loop acts on (see header).
  _onEvent(e) {
    if (!e) return;
    if (e.kind === KIND_CHAT) {
      this._noteCorpseRefusal(e);
      if (typeof this.optFn === "function") this._noteRareFind(e);
      return;
    }
    const now = Date.now();
    if (e.kind === KIND_USE_FAILED) {
      if ((e.u32 >>> 0) === WERR_YOURE_TOO_BUSY) this._lastBusyAt = now;
      else if (this.state === "OPEN" && now - this._openIssuedAt <= OPEN_FAIL_WINDOW_MS) this._openFailedAt = now;
      return;
    }
    if (e.kind === KIND_INVENTORY_ACTION_FAILED && this.pendingItem && (e.u32 >>> 0) === (this.pendingItem >>> 0)) {
      this._pendingFailed = { code: e.u32b >>> 0, at: now };
    }
  }

  // A corpse refusal (header, 2026-10-13) naming this.corpse is recorded here
  // and acted on by APPROACH / OPEN on the next tick (_takeCorpseRefusal).
  // Recorded in any state: a host may answer the Use before _issueOpen has
  // switched to OPEN. A new corpse or a finished one drops the record.
  _noteCorpseRefusal(e) {
    if (!this.corpse) return;
    const cat = e.u32b >>> 0;
    if (cat !== CHAT_CATEGORY_TRANSIENT && cat !== CHAT_CATEGORY_SYSTEM) return;
    const r = parseCorpseRefusal(e.text);
    if (!r) return;
    let name = null;
    try {
      name = typeof this.host.TryGetObjectName === "function" ? this.host.TryGetObjectName(this.corpse) : null;
    } catch {
      name = null;
    }
    // The line names the corpse, not its guid: a line naming a different
    // corpse is not about ours. An unknown name takes the line on trust.
    if (name && name !== r.name) return;
    this._corpseRefusal = { guid: this.corpse, why: r.why };
  }

  // End this corpse on a recorded refusal instead of waiting out OPEN's
  // timeouts. True = handled (back to SCAN).
  _takeCorpseRefusal(now) {
    const r = this._corpseRefusal;
    if (!r) return false;
    this._corpseRefusal = null;
    const g = this.corpse;
    if (r.guid !== g) return false;
    const hex = (g >>> 0).toString(16);
    if (r.why === "inUse") {
      const n = (this._inUse.get(g)?.n ?? 0) + 1;
      if (n < MAX_INUSE_REFUSALS) {
        this._inUse.set(g, { n, until: now + INUSE_SKIP_MS });
        this._finishCorpse(now, `corpse ${hex} in use by someone else — skipped ${INUSE_SKIP_MS / 1000}s (${n}/${MAX_INUSE_REFUSALS})`, false);
        return true;
      }
      this._inUse.delete(g);
      this._finishCorpse(now, `corpse ${hex} in use ${n}x — corpse parked`);
      return true;
    }
    if (r.why === "barred") {
      this._barred.add(g);
      this._finishCorpse(now, `may not loot corpse ${hex} (rare / PK kill) — parked while in view`);
      return true;
    }
    // A fellow's / anyone's kill we chose to take (header, 2026-10-19): again
    // once it is 100 s old, then every NOT_YET_RETRY_MS; left while in view
    // after MAX_NOT_YET_REFUSALS. Not parked — the book holds it back.
    const e = typeof this.optFn === "function" ? this._book.get(g) : null;
    if (e && (e.kind === "fellow" || e.kind === "other")) {
      e.notYet = (e.notYet || 0) + 1;
      if (e.notYet >= MAX_NOT_YET_REFUSALS) {
        e.refused = true;
        this._finishCorpse(now, `no right to loot corpse ${hex} after ${e.notYet} tries — left while in view`, false);
        return true;
      }
      e.retryAt = Math.max(e.seenAt + OTHERS_AFTER_MS, now + NOT_YET_RETRY_MS);
      this._finishCorpse(now, `no right to loot corpse ${hex} yet — again in ${Math.round((e.retryAt - now) / 1000)}s`, false);
      return true;
    }
    this._finishCorpse(now, `no right to loot corpse ${hex} yet — corpse parked`);
    return true;
  }

  // Refusal memory and the corpse book last only while the corpse stays in
  // view; the book is pruned only when `book` (once a second, _findCorpse).
  _forgetGoneRefusals(seen, book = false) {
    for (const g of this._barred) if (!seen.has(g)) this._barred.delete(g);
    for (const g of this._inUse.keys()) if (!seen.has(g)) this._inUse.delete(g);
    if (!book) return;
    for (const g of this._book.keys()) if (!seen.has(g)) this._book.delete(g);
    this._bookPrunedAt = Date.now();
  }

  /** With the layer: is the loop at a corpse, or about to be? The support
   *  modules (rynth/vt/support/scrolls.js, salvage.js) start nothing then, so
   *  no read or salvage overlaps a corpse Use: a corpse in hand (not SCAN);
   *  back in SCAN less than SETTLE_AFTER_CORPSE_MS ago (ACE keeps us busy
   *  through the last pickup's return animation, Player_Inventory
   *  EnqueuePickupDone, and refuses a read meanwhile); or a corpse whose
   *  description was asked for and may still come. */
  corpseWorkPending() {
    if (!this.enabled) return false;
    if (this.state !== "SCAN") return true;
    const now = Date.now();
    if (now - this.stateSince < SETTLE_AFTER_CORPSE_MS && now >= this.stateSince) return true;
    for (const e of this._book.values()) if (e.desc === undefined && e.descTries > 0 && now - e.descAt < DESC_RETRY_MS) return true;
    return false;
  }

  // ── VTank looting options (header, 2026-10-19) ─────────────────────────
  // The layer's options for this pass, or null without the layer (no optFn):
  // then every caller keeps the literal path.
  _vtOpts() {
    const f = this.optFn;
    if (typeof f !== "function") return null;
    const on = (k) => {
      try {
        return f(k) === true;
      } catch {
        return false;
      }
    };
    return {
      lootFellow: on("LootFellowCorpses"),
      lootAll: on("LootAllCorpses"),
      onlyRare: on("LootOnlyRareCorpses"),
      readUnknown: on("ReadUnknownScrolls"),
      desc: this._descCap(),
    };
  }

  // How near a corpse the walk goes before the Use.
  _reachM() {
    const f = this.optFn;
    if (typeof f !== "function") return REACH_M;
    let v;
    try {
      v = Number(f("CorpseApproachRangeMin"));
    } catch {
      v = NaN;
    }
    return Number.isFinite(v) ? Math.max(REACH_FLOOR_M, v) : REACH_M;
  }

  // Can this host read a corpse's description (string properties + an
  // appraisal request)? RynthWebHost answers per capability; a fake without
  // has() is taken at its members.
  _descCap() {
    const h = this.host;
    if (typeof h.TryGetObjectStringProperty !== "function" || typeof h.RequestId !== "function") return false;
    if (typeof h.has !== "function") return true;
    try {
      return h.has("GetObjectStringProperty") === true && h.has("RequestId") === true;
    } catch {
      return false;
    }
  }

  // The book's entry for a corpse in view, stamped when first seen.
  _bookEntry(g, now) {
    let e = this._book.get(g);
    if (!e) {
      // desc: { killer, rare } once read; kind: "own" | "fellow" | "other" |
      // null as last judged; retryAt / notYet / refused: "do not yet have
      // the right"; rareHint: the rare announcement pointed at it.
      e = { seenAt: now, desc: undefined, descTries: 0, descAt: 0, askedAt: 0, name: undefined, kind: null, retryAt: 0, notYet: 0, refused: false, rareHint: false };
      this._book.set(g, e);
    }
    return e;
  }

  // VTank's rule for one corpse in range: "loot", "wait" (a later try),
  // "skip", or "pending" (its description is on its way).
  _corpseVerdict(g, e, o, now) {
    if (!o.desc) return o.onlyRare ? (e.rareHint ? "loot" : "skip") : "loot";
    if (e.refused) return "skip";
    if (e.desc === undefined && !this._readDesc(g, e, now)) return "pending";
    const { killer, rare } = e.desc;
    let kind = killer ? this._killerKind(killer, now) : null;
    if (kind !== "own" && this._isOwnCorpse(g, e)) kind = "own";
    e.kind = kind;
    if (o.onlyRare) return kind === "own" && rare ? "loot" : "skip";
    if (!kind) return "skip"; // names no killer, or "misadventure"
    if (kind === "own") return "loot";
    if (rare) return "skip"; // never someone else's rare
    if (kind === "fellow" && o.lootFellow) return now >= e.retryAt ? "loot" : "wait";
    if (o.lootAll) return now >= Math.max(e.seenAt + OTHERS_AFTER_MS, e.retryAt) ? "loot" : "wait";
    return "skip";
  }

  // Read the corpse's description, asking for an appraisal (again every
  // DESC_RETRY_MS, DESC_TRIES times). An answer without one, or no answer at
  // all, names no killer. True once e.desc is set.
  _readDesc(g, e, now) {
    const h = this.host;
    let text = null;
    try {
      text = h.TryGetObjectStringProperty(g, PSTR_LONG_DESC);
    } catch {
      text = null;
    }
    if (typeof text !== "string" || !text) {
      const answered = this._descAnswered(g, e);
      if (!answered && e.descTries < DESC_TRIES) {
        if (!e.descTries || now - e.descAt >= DESC_RETRY_MS) {
          if (!e.descTries) e.askedAt = now;
          e.descTries++;
          e.descAt = now;
          try {
            h.RequestId(g);
          } catch {
            /* asked again on the next retry */
          }
        }
        return false;
      }
      if (!answered && now - e.descAt < DESC_RETRY_MS) return false; // the last ask may still be answered
      text = "";
    }
    e.desc = parseCorpseDescription(text);
    const { killer, rare } = e.desc;
    this.log(`corpse ${(g >>> 0).toString(16)}: ${killer ? `killed by ${killer}` : "names no killer"}${rare ? " (rare)" : ""}`);
    return true;
  }

  // An appraisal of `g` came back since our first ask (GetLastIdTime is in
  // the Date.now() domain).
  _descAnswered(g, e) {
    const h = this.host;
    if (!e.descTries || typeof h.GetLastIdTime !== "function") return false;
    let at = 0;
    try {
      at = Number(h.GetLastIdTime(g)) || 0;
    } catch {
      at = 0;
    }
    return at > 0 && at >= e.askedAt;
  }

  // "own" (we, or our pet "<me>'s <pet>", killed it), "fellow" (a fellow or a
  // fellow's pet) or "other". Names compare without the admin '+', ignoring case.
  _killerKind(killer, now) {
    const k = String(killer).toLowerCase();
    const by = (n) => !!n && (k === n || k.startsWith(`${n}'s `));
    if (by(this._myName())) return "own";
    for (const f of this._fellowNames(now)) if (by(f)) return "fellow";
    return "other";
  }

  // Our own corpse ("Corpse of <me>"): ACE lets its victim loot it whoever
  // killed it.
  _isOwnCorpse(g, e) {
    if (e.name === undefined) {
      let n = null;
      try {
        n = typeof this.host.TryGetObjectName === "function" ? this.host.TryGetObjectName(g) : null;
      } catch {
        n = null;
      }
      e.name = typeof n === "string" ? n.trim().toLowerCase() : "";
    }
    const me = this._myName();
    const m = /^corpse of \+?(.+)$/.exec(e.name);
    return !!me && !!m && m[1] === me;
  }

  // Our character's name, lower case, without the admin '+'.
  _myName() {
    if (this._myNameLc) return this._myNameLc;
    const h = this.host;
    let n = null;
    try {
      const me = typeof h.GetPlayerId === "function" ? h.GetPlayerId() : 0;
      n = me && typeof h.TryGetObjectName === "function" ? h.TryGetObjectName(me) : null;
    } catch {
      n = null;
    }
    this._myNameLc = typeof n === "string" ? n.trim().replace(/^\+/, "").toLowerCase() : "";
    return this._myNameLc;
  }

  // Our fellows' names (not ours), lower case, without the admin '+'.
  // TryGetFellowshipInfo frees its wasm boxes; TryGetFellowship (older hosts) does not.
  _fellowNames(now) {
    const c = this._fellows;
    if (now - c.at < FELLOW_CACHE_MS && now >= c.at) return c.names;
    const me = this._myName();
    const h = this.host;
    let f = null;
    try {
      if (typeof h.TryGetFellowshipInfo === "function") f = h.TryGetFellowshipInfo();
      else if (typeof h.TryGetFellowship === "function") f = h.TryGetFellowship();
    } catch {
      f = null;
    }
    const names = [];
    for (const m of f && Array.isArray(f.members) ? f.members : []) {
      const n = String((m && m.name) ?? "").trim().replace(/^\+/, "").toLowerCase();
      if (n && n !== me) names.push(n);
    }
    this._fellows = { at: now, names };
    return names;
  }

  // "<me> has discovered the X!" — a System line 0.5 s after a rare's corpse
  // appears (ACE Corpse.EnterWorld); it names the finder, not the corpse. The
  // corpses the book saw appear within RARE_HINT_MS before it are that rare's:
  // what LootOnlyRareCorpses goes by on a host that cannot read descriptions.
  // A corpse the book has not seen yet is not one of them (its first sighting
  // would date it now).
  _noteRareFind(e) {
    if ((e.u32b >>> 0) !== CHAT_CATEGORY_SYSTEM || typeof e.text !== "string") return;
    const m = RARE_FOUND_RE.exec(e.text.trimEnd());
    if (!m) return;
    const me = this._myName();
    if (!me || m[1].trim().replace(/^\+/, "").toLowerCase() !== me) return;
    const now = Date.now();
    for (const entry of this._book.values()) if (now - entry.seenAt <= RARE_HINT_MS) entry.rareHint = true;
    this.log(`we found a rare: ${m[2]}`);
  }

  // The spell a corpse item would be read for (ReadUnknownScrolls / a Read
  // rule — header): a scroll of a spell we don't know and none of whose
  // scrolls was just taken, that ACE would let us learn (canReadScroll on the
  // school's skill row). 0 = none.
  _scrollToRead(item, now) {
    const h = this.host;
    let itemType = 0;
    let spellId = 0;
    try {
      itemType = Number(h.TryGetObjectIntProperty(item, 1)) >>> 0; // ItemType
      spellId = typeof h.TryGetObjectDataIdProperty === "function" ? Number(h.TryGetObjectDataIdProperty(item, DID_SPELL)) >>> 0 : 0;
    } catch {
      return 0;
    }
    if (!(itemType & IT_WRITABLE) || !spellId) return 0;
    const taken = this._readSpells.get(spellId);
    if (taken !== undefined && now - taken < READ_SPELL_TTL_MS) return 0;
    if (this._knownSpellSet(now).has(spellId)) return 0;
    let rec = null;
    try {
      rec = typeof h.TryGetSpellRecord === "function" ? h.TryGetSpellRecord(spellId) : null;
    } catch {
      rec = null;
    }
    const skillId = rec ? SCHOOL_SKILL[rec.school] : undefined;
    if (!skillId) return 0; // no school known: not judged, not taken
    const rows = this._skillRows(now);
    const row = rows ? rows[skillId] ?? rows[String(skillId)] ?? null : null;
    return canReadScroll(rec.power, row) ? spellId : 0;
  }

  _readId(item, o, now) {
    return o && o.readUnknown ? this._scrollToRead(item, now) : 0;
  }

  _knownSpellSet(now) {
    const c = this._known;
    if (now - c.at < KNOWN_SPELLS_CACHE_MS && now >= c.at) return c.set;
    let ids = [];
    try {
      ids = typeof this.host.TryGetKnownSpells === "function" ? this.host.TryGetKnownSpells() || [] : [];
    } catch {
      ids = [];
    }
    this._known = { at: now, set: new Set(Array.from(ids, (x) => Number(x) >>> 0)) };
    return this._known.set;
  }

  _skillRows(now) {
    const c = this._skills;
    if (now - c.at < SKILLS_CACHE_MS && now >= c.at) return c.rows;
    let stats = null;
    try {
      stats = typeof this.host.TryGetPlayerStats === "function" ? this.host.TryGetPlayerStats() : null;
    } catch {
      stats = null;
    }
    this._skills = { at: now, rows: stats && stats.skills ? stats.skills : null };
    return this._skills.rows;
  }

  // What becomes of a loot-profile pickup after the corpse: a Salvage rule's
  // item is salvaged; a Read rule's scroll is read when ReadUnknownScrolls
  // would read it; anything else (Keep, Sell, KeepUpTo) is kept.
  _pickupTag(item, action, o, now) {
    if (action === "salvage") return { purpose: "salvage", spellId: 0 };
    if (action !== "read") return null;
    const spellId = this._readId(item, o, now);
    return spellId ? { purpose: "read", spellId } : null;
  }

  _queueWork(guid, tag, now) {
    if (this._work.length >= MAX_WORK) this._work.shift();
    this._work.push({ guid: guid >>> 0, purpose: tag.purpose, spellId: tag.spellId || 0, at: now });
    if (tag.purpose !== "read" || !tag.spellId) return;
    this._readSpells.set(tag.spellId, now);
    if (this._readSpells.size > 64) for (const [id, at] of this._readSpells) if (now - at >= READ_SPELL_TTL_MS) this._readSpells.delete(id);
  }

  /** The confirmed pickups waiting for `purpose` ("salvage" | "read"), handed
   *  over once — rynth/vt/support/salvage.js and scrolls.js drain them:
   *  [{ guid, spellId, at }]. */
  takeWork(purpose) {
    if (!this._work.length) return [];
    const out = [];
    const keep = [];
    for (const w of this._work) {
      if (w.purpose === purpose) out.push({ guid: w.guid, spellId: w.spellId, at: w.at });
      else keep.push(w);
    }
    this._work = keep;
    return out;
  }

  // ── netBrain (D1 path A′) — .NET-wasm LootScoring shadow ────────────────
  // The JS rule model is a single Value(19) floor, so the shadow feeds the
  // C# evaluator the equivalent one-rule VTank profile (NodeType 3
  // LongValKeyGE, DataLines [min,"19"] — the fixtures' ValueFloor shape) and
  // compares the PICKUP plane: C# keep/salvage => pickup, no-loot => skip.
  attachNetBrain(brain, mode, nbModule) {
    this._nb = { brain, mode, m: nbModule };
  }

  _nbShadowItem(item, value, jsPickup) {
    const nb = this._nb;
    if (!nb?.brain?.evaluateLoot) return;
    const h = this.host;
    nb.m.shadowTick(nb.brain, "loot", () => ({
      Item: {
        Id: item | 0,
        Name: h.TryGetObjectName(item) || "",
        ObjectClass: 0,
        // Mirror the JS read exactly: an absent Value(19) stays absent —
        // C#'s Values(19, 0) default matches the JS `?? 0`.
        IntValues: value == null ? {} : { 19: value },
        DoubleValues: {}, StringValues: {}, BoolValues: {}, DataValues: {},
        Spells: [], HostHasSpellIds: true, HostHasPalettes: true, PaletteSubIds: [],
      },
      Character: null,
      Vtank: {
        Rules: [{
          Name: "value floor", Priority: 0, Action: 1, KeepCount: null,
          // The slice parses slot 0 with int.Parse — a float minValue would
          // throw and read as permanent divergence. For integer Value(19),
          // value >= min is equivalent to value >= ceil(min).
          Conditions: [{ NodeType: 3, DataLines: [String(Math.ceil(Number(this.minValue) || 0)), "19"] }],
        }],
      },
      Native: null,
    }), (out) => {
      const csPickup = out.Verdict === "keep" || out.Verdict === "salvage";
      return {
        agree: csPickup === jsPickup,
        jsVal: jsPickup ? "pickup" : "skip",
        csVal: `${out.Verdict}${out.RuleName ? ":" + out.RuleName : ""}`,
      };
    });
  }

  // A full pack pauses looting — every pickup would be refused, and the
  // kernel would keep routing to Loot for nothing. "Full" = no free slot in
  // the main pack NOR any side pack (TryGetFreeSlots' aggregate): pickups go
  // to the main pack while it has room, then to a side pack with room
  // (_pickupDest). Unknown (no capability / inventory not streamed) = not
  // full. Cached: the kernel asks every tick.
  _packFull() {
    const h = this.host;
    if (typeof h.TryGetFreeSlots !== "function") return false;
    const now = Date.now();
    if (now - this._pack.at < PACK_CHECK_MS) return this._pack.full;
    let free = null;
    try {
      free = h.TryGetFreeSlots();
    } catch {
      free = null;
    }
    const full = free === 0;
    if (full && !this._pack.full) this.log("pack full — looting paused until slots free up");
    this._pack = { at: now, full };
    return full;
  }

  // `o` = _vtOpts() (header, 2026-10-19): with the layer, a corpse counts
  // only when VTank's ownership rule takes it now.
  _findCorpse(o = this._vtOpts()) {
    if (!this.enabled) return null; // looting OFF — kernel _corpseAvailable() stays false, never routes to Loot
    if (this._packFull()) return null;
    const h = this.host;
    const me = h.TryGetPlayerPose();
    if (!me) return null;
    const now = Date.now();
    const maxD = Number.isFinite(this.corpseRangeM) ? this.corpseRangeM : 30;
    let best = null;
    // Refusal memory is pruned on every call, as before; the layer's corpse
    // book once a second, through one reused Set (the kernel asks every tick).
    const pruneBook = o !== null && (now - this._bookPrunedAt >= BOOK_PRUNE_MS || now < this._bookPrunedAt);
    let seen = null;
    if (this._barred.size || this._inUse.size) seen = new Set();
    else if (pruneBook) {
      seen = this._seenScratch;
      seen.clear();
    }
    for (const g of h.NearbyGuids()) {
      if (seen) seen.add(g);
      const t = this.looted.get(g);
      if (t && now - t < LOOTED_TTL_MS) continue;
      if (this._barred.has(g)) continue; // "may not loot … because" — not while in view
      const inUse = this._inUse.get(g);
      if (inUse && now < inUse.until) continue; // "already in use" — skipped a while
      if (h.TryGetObjectWcid(g) !== CORPSE_WCID) continue;
      const entry = o ? this._bookEntry(g, now) : null; // stamped when first seen, judged in range
      const pos = h.TryGetObjectPosition(g);
      if (!pos) continue;
      const d = horizontalDistance(me, pos);
      if (d == null || d > maxD) continue;
      if (entry && this._corpseVerdict(g, entry, o, now) !== "loot") continue;
      if (!best || d < best.d) best = { guid: g, d, pos };
    }
    if (seen) this._forgetGoneRefusals(seen, pruneBook);
    return best;
  }

  /** The VT loot-profile verdict for one corpse item: "pickup" | "skip" |
   *  "pending", or null (no verdict / a throw / anything else) = the Value
   *  floor decides as before. `out` (with the layer) receives the verdict's
   *  rule action (rynth/vt/glue/loot_ctx.js). */
  _classifyItem(item, now, out = null) {
    try {
      const v = this.classify(item, out ? { host: this.host, now, out } : { host: this.host, now });
      return v === "pickup" || v === "skip" || v === "pending" ? v : null;
    } catch (e) {
      this.log(`loot profile threw on ${item.toString(16)}: ${(e && e.message) || e}`);
      return null;
    }
  }

  _hasInInventory(guid) {
    const g = guid >>> 0;
    const h = this.host;
    let rows = null;
    if (typeof h.TryGetPlayerInventory === "function") {
      rows = h.TryGetPlayerInventory();
    } else if (h.s && typeof h.s.playerInventory === "function") {
      try {
        rows = h.s.playerInventory() || [];
      } catch {
        rows = [];
      }
    }
    if (!rows) return false;
    for (const it of rows) if (((it.guid ?? it.itemGuid ?? 0) >>> 0) === g) return true;
    return false;
  }

  // Where a pickup goes: the main pack while it has a free slot, else the
  // first side pack with one — the client's own Loot All placement
  // (corpse-loot-bar.js takeItem -> item_drag planBackpackPlacement). ACE
  // never overflows a full main pack into a side pack by itself
  // (limitToMainPackOnly), so a pickup aimed at a full main pack is refused
  // even when side packs have room (2026-10-12 review #8). Unknown room (no
  // TryGetPackRoom / inventory not streamed) -> the main pack, as before.
  _pickupDest(me) {
    const h = this.host;
    if (typeof h.TryGetPackRoom !== "function") return me;
    let room = null;
    try {
      room = h.TryGetPackRoom();
    } catch {
      room = null;
    }
    if (!room || !room.main || room.main.free > 0) return me;
    const side = Array.isArray(room.packs) ? room.packs.find((p) => p && p.free > 0 && p.guid) : null;
    return side ? side.guid >>> 0 : me;
  }

  _pickup(item, me) {
    const h = this.host;
    const dest = this._pickupDest(me);
    if (typeof h.MoveItemToContainer === "function") return h.MoveItemToContainer(item, dest, 0) !== false;
    try {
      h.s.moveItem(item, dest, 0); // MoveItemExternal parity (0x0019)
      return true;
    } catch (e) {
      this.log(`moveItem threw: ${(e && e.message) || e}`);
      return false;
    }
  }

  // Pick `item` up and confirm it (CONFIRM). `tag` = { purpose, spellId }: a
  // pickup the support modules salvage / read after the corpse (header).
  _issuePickup(item, me, tag = null) {
    if (!this._pickup(item, me)) return false;
    this._pickupTries.set(item, (this._pickupTries.get(item) || 0) + 1);
    this.pendingItem = item;
    this._pendingFailed = null;
    this._pendingTag = tag;
    this._setState("CONFIRM");
    return true;
  }

  _issueOpen(countTry) {
    if (countTry) this._openTries++;
    this._openIssuedAt = Date.now();
    this._openFailedAt = 0;
    this._openRetryAt = 0;
    this.host.UseObject(this.corpse);
    this._setState("OPEN");
  }

  // Leave the current corpse: close it when we had it open (see header), park
  // it for LOOTED_TTL_MS (park=false: the "in use" skip keeps its own clock),
  // back to SCAN.
  _finishCorpse(now, why, park = true) {
    const h = this.host;
    if (this.corpse && h.GetGroundContainerId?.() === this.corpse && typeof h.CloseContainer === "function") {
      try { h.CloseContainer(this.corpse); } catch (_) {}
    }
    if (why) this.log(why);
    if (park) this.looted.set(this.corpse, now);
    this._corpseRefusal = null;
    this._pickupTries.clear();
    this.pendingItem = 0;
    this._pendingFailed = null;
    this._pendingTag = null;
    this._ownCorpse = false;
    this._openRetryAt = 0; // a re-Use pending for THIS corpse must not fire on the next one
    this._setState("SCAN");
  }

  // The kernel ticks one loop per tick: while combat (or vitals / unwedge)
  // held it, this loop's clocks kept running and the APPROACH MoveTo was
  // replaced by combat's own movement — since 2026-10-12 the kernel's
  // Loot→Combat preemption cancels it outright. Re-arm the clocks (the 20 s
  // APPROACH timeout restarts) and re-issue the walk instead of timing out on
  // a stale clock and parking the corpse unlooted after a long fight.
  _resume(now, gap) {
    this.stateSince = now;
    if (this.state === "APPROACH") {
      const pos = this.host.TryGetObjectPosition(this.corpse);
      if (pos) this.host.MoveToPosition(pos.objCellId, pos.x, pos.y, pos.z, true);
      this._lastApproachD = undefined;
      this._lastApproachIssue = now;
    } else if (this.state === "OPEN") {
      this._openIssuedAt = now;
    }
    this.log(`resumed ${this.state} after a ${Math.round(gap / 100) / 10}s pause`);
  }

  tick() {
    if (!this.enabled) return; // looting OFF (director/persona toggle) — no scan, no MoveToPosition
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    if (portalSpaceActive(h)) return; // hold: no MoveTo / Use / pickup in portal space (header)
    const now = Date.now();
    const gap = this._lastTickAt ? now - this._lastTickAt : 0;
    this._lastTickAt = now;
    if (gap > PREEMPT_GAP_MS && this.state !== "SCAN") this._resume(now, gap);
    const age = now - this.stateSince;

    switch (this.state) {
      case "SCAN": {
        const c = this._findCorpse();
        if (!c) return;
        this.corpse = c.guid;
        this._corpseRefusal = null;
        this._openTries = 0;
        this._openBusyRetries = 0;
        this._pickupTries.clear();
        const kind = this.optFn ? this._book.get(c.guid)?.kind : null;
        // Our own corpse: what we take back from it is never salvaged or read.
        this._ownCorpse = this.optFn ? this._isOwnCorpse(c.guid, this._bookEntry(c.guid, now)) : false;
        this.log(`corpse ${c.guid.toString(16)} d=${c.d.toFixed(1)}${kind ? ` (${kind === "own" ? "ours" : `${kind}'s kill`})` : ""}`);
        if (c.d > this._reachM()) {
          h.MoveToPosition(c.pos.objCellId, c.pos.x, c.pos.y, c.pos.z, true);
          this._lastApproachD = undefined;
          this._lastApproachIssue = Date.now();
          this._setState("APPROACH");
        } else {
          this._issueOpen(true);
        }
        return;
      }
      case "APPROACH": {
        if (this._takeCorpseRefusal(now)) return;
        const me = h.TryGetPlayerPose();
        const pos = h.TryGetObjectPosition(this.corpse);
        const d = me && pos ? horizontalDistance(me, pos) : null;
        if (d == null) {
          this._setState("SCAN");
          return;
        }
        if (d <= this._reachM()) {
          h.StopCompletely();
          this._issueOpen(true);
          return;
        }
        // Progress watchdog: a MoveToPosition issued right after a combat
        // stick-release can be eaten by the in-flight cancel — if we're
        // not closing distance, re-issue rather than waiting out the
        // full timeout (the grind-bot smoke's "approach timeout" case).
        if (this._lastApproachD !== undefined && d >= this._lastApproachD - 0.2) {
          if (now - (this._lastApproachIssue || 0) > 3000) {
            h.MoveToPosition(pos.objCellId, pos.x, pos.y, pos.z, true);
            this._lastApproachIssue = now;
          }
        } else {
          this._lastApproachIssue = this._lastApproachIssue || now;
        }
        this._lastApproachD = d;
        if (age > 20_000) {
          this._lastApproachD = undefined;
          this._finishCorpse(now, "approach timeout");
        }
        return;
      }
      case "OPEN": {
        if (h.GetGroundContainerId() === this.corpse) {
          this.items = Array.from(h.GetContainerContents(this.corpse) || []).map(Number);
          this.log(`opened: ${this.items.length} items`);
          if (!this.items.length) {
            this.emptyCorpses++;
            this._finishCorpse(now);
          } else {
            this._setState("LOOT");
          }
          return;
        }
        // ACE refused this corpse by name (header, 2026-10-13).
        if (this._takeCorpseRefusal(now)) return;
        // A pending retry (after a refusal) waits out its delay first.
        if (this._openRetryAt) {
          if (now >= this._openRetryAt) this._issueOpen(this._openRetryCounts);
          return;
        }
        const refused = this._openFailedAt > 0 && this._openFailedAt >= this._openIssuedAt;
        const busy = this._lastBusyAt >= this._openIssuedAt;
        if (busy && !refused && this._openBusyRetries < MAX_OPEN_BUSY_RETRIES) {
          // "You're too busy" (still standing up from a swing/pickup) — not
          // the corpse's fault: retry without spending an open attempt.
          this._openBusyRetries++;
          this._openRetryCounts = false;
          this._openRetryAt = now + BUSY_RETRY_DELAY_MS;
          return;
        }
        if (refused || busy || age > OPEN_TIMEOUT_MS) {
          if (this._openTries >= MAX_OPEN_TRIES) {
            this._finishCorpse(now, `open failed ${this._openTries}x — corpse parked`);
            return;
          }
          this.log(refused || busy ? "open refused — retrying use" : "open timeout — retrying use");
          this._openRetryCounts = true;
          if (refused || busy) this._openRetryAt = now + OPEN_RETRY_DELAY_MS;
          else this._issueOpen(true);
        }
        return;
      }
      case "LOOT": {
        if (h.GetBusyState() !== 0) return;
        if (now < this._nextPickupAt) return;
        if (this._packFull()) {
          this._finishCorpse(now, "pack full — leaving the corpse");
          return;
        }
        const me = h.GetPlayerId();
        // null without the layer (header, 2026-10-19) — and at our own corpse:
        // nothing taken back from it is tagged to be salvaged or read.
        const o = this._ownCorpse ? null : this._vtOpts();
        while (this.items.length) {
          const item = this.items[0];
          // VT loot profile verdict first (null = today's Value rule below).
          if (this.classify) {
            const out = o ? {} : null;
            const v = this._classifyItem(item, now, out);
            if (v === "pending") {
              // Appraisal-gated rule: hold the item at the head like the
              // Value(19) gate below — one RequestId, the same timeout — then
              // skip it unjudged.
              const heldSince = this._assessAt.get(item);
              if (heldSince === undefined) {
                this._assessAt.set(item, now);
                h.RequestId?.(item);
                return;
              }
              if (now - heldSince < APPRAISE_TIMEOUT_MS) return;
              this.log(`appraisal timeout on ${item.toString(16)} — loot profile skips it`);
              this.items.shift();
              this._assessAt.delete(item);
              // ReadUnknownScrolls still takes a scroll to read.
              const readId = this._readId(item, o, now);
              if (readId && this._issuePickup(item, me, { purpose: "read", spellId: readId })) return;
              continue;
            }
            if (v === "skip") {
              this.items.shift();
              this._assessAt.delete(item);
              const readId = this._readId(item, o, now);
              if (readId && this._issuePickup(item, me, { purpose: "read", spellId: readId })) return;
              continue;
            }
            if (v === "pickup") {
              this.items.shift();
              this._assessAt.delete(item);
              if (!this._issuePickup(item, me, o ? this._pickupTag(item, out.action, o, now) : null)) continue;
              return;
            }
          }
          // ReadUnknownScrolls: a scroll to read is taken whatever its value
          // (no loot profile keeps it, so it is read).
          const readId = this._readId(item, o, now);
          if (readId) {
            this.items.shift();
            this._assessAt.delete(item);
            if (this._issuePickup(item, me, { purpose: "read", spellId: readId })) return;
            continue;
          }
          const raw = h.TryGetObjectIntProperty(item, 19); // Value
          // Appraisal gate (LootScoring finding #1): with a value floor set,
          // an item whose Value hasn't streamed yet is HELD at the head —
          // request an appraisal once and give it APPRAISE_TIMEOUT_MS —
          // instead of being shifted out and skipped forever. On timeout it
          // falls through and is judged on value 0 (the old behavior).
          if (this.minValue > 0 && raw == null && h.HasAppraisalData?.(item) !== true) {
            const heldSince = this._assessAt.get(item);
            if (heldSince === undefined) {
              this._assessAt.set(item, now);
              h.RequestId?.(item);
              return; // stay in LOOT; next tick re-checks
            }
            if (now - heldSince < APPRAISE_TIMEOUT_MS) return;
            this.log(`appraisal timeout on ${item.toString(16)} — judging unappraised`);
          }
          this.items.shift();
          this._assessAt.delete(item);
          const value = raw ?? 0;
          if (this._nb) this._nbShadowItem(item, raw, value >= this.minValue);
          if (value < this.minValue) continue;
          if (!this._issuePickup(item, me)) continue;
          return;
        }
        this._assessAt.clear();
        this._finishCorpse(now, `corpse done (${this.lootedCount} looted total)`);
        return;
      }
      case "CONFIRM": {
        if (this._hasInInventory(this.pendingItem)) {
          this.lootedCount++;
          this.log(`picked up ${this.pendingItem.toString(16)} (${this.lootedCount})`);
          if (this._pendingTag) this._queueWork(this.pendingItem, this._pendingTag, now); // salvaged / read after the corpse
          this._pendingTag = null;
          this.pendingItem = 0;
          this._nextPickupAt = now + NEXT_PICKUP_DELAY_MS;
          this._setState("LOOT");
        } else if (this._pendingFailed) {
          const { code } = this._pendingFailed;
          const item = this.pendingItem;
          this._pendingFailed = null;
          this._pendingTag = null;
          this.pendingItem = 0;
          const tries = this._pickupTries.get(item) || 0;
          if (now - this._lastBusyAt <= BUSY_WINDOW_MS && tries < MAX_PICKUP_TRIES) {
            this.items.unshift(item); // same item again once we have stood back up
            this._nextPickupAt = now + BUSY_RETRY_DELAY_MS;
            this.log(`pickup ${item.toString(16)} refused (too busy) — retry ${tries + 1}/${MAX_PICKUP_TRIES}`);
          } else {
            this.refusedPickups++;
            this.log(`pickup ${item.toString(16)} refused (WeenieError 0x${code.toString(16)}) — skipping`);
          }
          this._setState("LOOT");
        } else if (age > PICKUP_TIMEOUT_MS) {
          this.log(`pickup timeout ${this.pendingItem.toString(16)} — skipping`);
          this._pendingTag = null;
          this.pendingItem = 0;
          this._setState("LOOT");
        }
        return;
      }
    }
  }
}

export default RynthLootLoop;
