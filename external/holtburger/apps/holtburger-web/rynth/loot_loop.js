// RynthLootLoop — Phase-3 corpse looting on the RynthWebHost seam.
//
// Report 03 Tier-4 flow over the landed reads: find corpse → walk into
// reach → UseObject (opens; server replies ViewContents which stamps
// groundContainerId + container contents) → enumerate → value-rule →
// moveItem(item, player, 0) (RynthCoreHost MoveItemExternal, wire 0x0019)
// → confirm via playerInventory. Paced on the busy gate; every action
// fire-and-forget with poll-shaped confirmation.

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

export class RynthLootLoop {
  constructor(host, opts = {}) {
    this.host = host;
    // Value(19) >= minValue. Default 0 = loot everything — a deliberate
    // polarity divergence from C#'s empty-profile-loots-nothing (LootScoring
    // finding #2, ruled by-design 2026-07-17): the playtester bot can sell
    // trash at vendors, and the director can raise the floor at any time via
    // set_loot_min_value.
    this.minValue = opts.minValue ?? 0;
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
    this._running = false;
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

  _findCorpse() {
    const h = this.host;
    const me = h.TryGetPlayerPose();
    if (!me) return null;
    const now = Date.now();
    let best = null;
    for (const g of h.NearbyGuids()) {
      const t = this.looted.get(g);
      if (t && now - t < LOOTED_TTL_MS) continue;
      if (h.TryGetObjectWcid(g) !== CORPSE_WCID) continue;
      const pos = h.TryGetObjectPosition(g);
      if (!pos || pos.objCellId >>> 16 !== me.objCellId >>> 16) continue;
      const d = Math.hypot(pos.x - me.x, pos.y - me.y);
      if (d > 30) continue;
      if (!best || d < best.d) best = { guid: g, d, pos };
    }
    return best;
  }

  _inventoryGuids() {
    const s = this.host.s;
    if (!s.playerInventory) return new Set();
    const out = new Set();
    for (const it of s.playerInventory() || []) {
      out.add(Number(it.guid ?? it.itemGuid ?? 0));
    }
    return out;
  }

  tick() {
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    const now = Date.now();
    const age = now - this.stateSince;

    switch (this.state) {
      case "SCAN": {
        const c = this._findCorpse();
        if (!c) return;
        this.corpse = c.guid;
        this.log(`corpse ${c.guid.toString(16)} d=${c.d.toFixed(1)}`);
        if (c.d > REACH_M) {
          h.MoveToPosition(c.pos.objCellId, c.pos.x, c.pos.y, c.pos.z, true);
          this._lastApproachD = undefined;
          this._lastApproachIssue = Date.now();
          this._setState("APPROACH");
        } else {
          h.UseObject(this.corpse);
          this._setState("OPEN");
        }
        return;
      }
      case "APPROACH": {
        const me = h.TryGetPlayerPose();
        const pos = h.TryGetObjectPosition(this.corpse);
        if (!pos || !me) {
          this._setState("SCAN");
          return;
        }
        const d = Math.hypot(pos.x - me.x, pos.y - me.y);
        if (d <= REACH_M) {
          h.StopCompletely();
          h.UseObject(this.corpse);
          this._setState("OPEN");
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
          this.log("approach timeout");
          this.looted.set(this.corpse, now); // park it
          this._lastApproachD = undefined;
          this._setState("SCAN");
        }
        return;
      }
      case "OPEN": {
        if (h.GetGroundContainerId() === this.corpse) {
          this.items = Array.from(h.GetContainerContents(this.corpse) || []).map(Number);
          this.log(`opened: ${this.items.length} items`);
          if (!this.items.length) {
            this.emptyCorpses++;
            this.looted.set(this.corpse, now);
            this._setState("SCAN");
          } else {
            this._setState("LOOT");
          }
        } else if (age > OPEN_TIMEOUT_MS) {
          this.log("open timeout — retrying use");
          h.UseObject(this.corpse);
          this._setState("OPEN"); // re-arm timer
        }
        return;
      }
      case "LOOT": {
        if (h.GetBusyState() !== 0) return;
        const me = h.GetPlayerId();
        while (this.items.length) {
          const item = this.items[0];
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
          h.s.moveItem(item, me, 0); // MoveItemExternal parity (0x0019)
          this.pendingItem = item;
          this._setState("CONFIRM");
          return;
        }
        this._assessAt.clear();
        this.looted.set(this.corpse, now);
        this.log(`corpse done (${this.lootedCount} looted total)`);
        this._setState("SCAN");
        return;
      }
      case "CONFIRM": {
        if (this._inventoryGuids().has(this.pendingItem)) {
          this.lootedCount++;
          this.log(`picked up ${this.pendingItem.toString(16)} (${this.lootedCount})`);
          this.pendingItem = 0;
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
