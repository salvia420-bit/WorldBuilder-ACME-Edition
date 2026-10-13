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

import { portalSpaceActive } from "./portal_gate.js";
import { worldX, worldY, isEnvCellId } from "./nav_frame.js";

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

  // Push plane: the two server refusals the loop acts on (see header).
  _onEvent(e) {
    if (!e) return;
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

  _findCorpse() {
    if (!this.enabled) return null; // looting OFF — kernel _corpseAvailable() stays false, never routes to Loot
    if (this._packFull()) return null;
    const h = this.host;
    const me = h.TryGetPlayerPose();
    if (!me) return null;
    const now = Date.now();
    const maxD = Number.isFinite(this.corpseRangeM) ? this.corpseRangeM : 30;
    let best = null;
    for (const g of h.NearbyGuids()) {
      const t = this.looted.get(g);
      if (t && now - t < LOOTED_TTL_MS) continue;
      if (h.TryGetObjectWcid(g) !== CORPSE_WCID) continue;
      const pos = h.TryGetObjectPosition(g);
      if (!pos) continue;
      const d = horizontalDistance(me, pos);
      if (d == null || d > maxD) continue;
      if (!best || d < best.d) best = { guid: g, d, pos };
    }
    return best;
  }

  /** The VT loot-profile verdict for one corpse item: "pickup" | "skip" |
   *  "pending", or null (no verdict / a throw / anything else) = the Value
   *  floor decides as before. */
  _classifyItem(item, now) {
    try {
      const v = this.classify(item, { host: this.host, now });
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

  _issueOpen(countTry) {
    if (countTry) this._openTries++;
    this._openIssuedAt = Date.now();
    this._openFailedAt = 0;
    this._openRetryAt = 0;
    this.host.UseObject(this.corpse);
    this._setState("OPEN");
  }

  // Leave the current corpse: close it when we had it open (see header), park
  // it for LOOTED_TTL_MS, back to SCAN.
  _finishCorpse(now, why) {
    const h = this.host;
    if (this.corpse && h.GetGroundContainerId?.() === this.corpse && typeof h.CloseContainer === "function") {
      try { h.CloseContainer(this.corpse); } catch (_) {}
    }
    if (why) this.log(why);
    this.looted.set(this.corpse, now);
    this._pickupTries.clear();
    this.pendingItem = 0;
    this._pendingFailed = null;
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
        this._openTries = 0;
        this._openBusyRetries = 0;
        this._pickupTries.clear();
        this.log(`corpse ${c.guid.toString(16)} d=${c.d.toFixed(1)}`);
        if (c.d > REACH_M) {
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
        const me = h.TryGetPlayerPose();
        const pos = h.TryGetObjectPosition(this.corpse);
        const d = me && pos ? horizontalDistance(me, pos) : null;
        if (d == null) {
          this._setState("SCAN");
          return;
        }
        if (d <= REACH_M) {
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
        while (this.items.length) {
          const item = this.items[0];
          // VT loot profile verdict first (null = today's Value rule below).
          if (this.classify) {
            const v = this._classifyItem(item, now);
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
              continue;
            }
            if (v === "skip") {
              this.items.shift();
              this._assessAt.delete(item);
              continue;
            }
            if (v === "pickup") {
              this.items.shift();
              this._assessAt.delete(item);
              if (!this._pickup(item, me)) continue;
              this._pickupTries.set(item, (this._pickupTries.get(item) || 0) + 1);
              this.pendingItem = item;
              this._pendingFailed = null;
              this._setState("CONFIRM");
              return;
            }
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
          if (!this._pickup(item, me)) continue;
          this._pickupTries.set(item, (this._pickupTries.get(item) || 0) + 1);
          this.pendingItem = item;
          this._pendingFailed = null;
          this._setState("CONFIRM");
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
          this.pendingItem = 0;
          this._nextPickupAt = now + NEXT_PICKUP_DELAY_MS;
          this._setState("LOOT");
        } else if (this._pendingFailed) {
          const { code } = this._pendingFailed;
          const item = this.pendingItem;
          this._pendingFailed = null;
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
          this.pendingItem = 0;
          this._setState("LOOT");
        }
        return;
      }
    }
  }
}

export default RynthLootLoop;
