// rynth/vt/support/pets.js — "Summon Pets" as the "Pets" kernel slot (PLAN
// W1-9 SUP, §3.11, §2.1 O21-O23, §2.4 M21). Port of CS/Combat/PetManager.cs
// (U6 §3) with the VTank range rule and the PetDmg column.
//
// Rank beforeCombat: when monsters show up the slot gets the tick before the
// kernel picks Combat for the threat (a locked fight — combatPinned — is never
// interrupted). It summons when:
//   * no pet is up — no visible object named "<me>'s …" (ACE Pet.Init names it
//     so) and none whose PetOwner (IID 44) is us — and the 10 s "assume active"
//     window after a summon has passed;
//   * ≥ PetMinMonsters scanned monsters are within the pet range = CustomPetRange
//     when CustomPetRangeEnabled, else MonsterRange (G:41-42; C# always used
//     the custom range);
//   * Summoning is trained (unknown skill ⇒ allowed), nothing is busy, no cast
//     gesture/claim is open, not in portal space.
// Devices: Items-tab entries of kind "pet", then Consumables "Pet" entries, in
// list order. With the Monsters-tab PetDmg of the monster that triggered the
// summon set to an element, essences whose pet deals that element
// (data/pet_essences.json, from ACE PetDeviceToPetMapping) are tried first;
// "PAuto" (or no table yet) keeps the list order.
// Charges = Structure (PropertyInt 92): ≠ 0 (or unreadable) ⇒ UseObject(essence);
// 0 ⇒ refill with an owned "Encapsulated Spirit" (UseItemOnTarget(spirit,
// essence)) when PetAutoRefill, else park the essence 15 s and try the next.
// Completion: Structure dropped, a pet became visible, or ACE chat ("is already
// active", "does not have enough charges", "add the spirit to the essence",
// "essence is already full", "You must be a … to use"); 8 s timeout ⇒ park the
// essence 30 s (and assume the summon worked for 10 s).
//
// enabled() = SummonPets && EnableCombat (bot.combat.enabled !== false, critic
// G12) && a device is configured. Item token owner "vtpets" (C8). Never throws.

import {
  OWNERS,
  PROP,
  SKILL,
  makeLogger,
  errText,
  optBool,
  optNum,
  call,
  playerGuid,
  inPortal,
  busyCount,
  inventoryOf,
  objName,
  objInt,
  playerStats,
  skillOf,
  claimItem,
  releaseItem,
  itemTokenHeldByOther,
  castTokenBusy,
  loopOf,
  scanTargets,
  consumableEntries,
  resolveOwned,
  supportData,
  lc,
} from "./consumables.js";

const OWNER = OWNERS.pets;

export const PET_TUNING = Object.freeze({
  THINK_INTERVAL_MS: 1000,
  ACTION_TIMEOUT_MS: 8000,
  ASSUME_ACTIVE_MS: 10_000,
  DEVICE_FAIL_COOLDOWN_MS: 30_000,
  DEVICE_NO_SPIRIT_COOLDOWN_MS: 15_000,
  DEVICE_MASTERY_COOLDOWN_MS: 10 * 60_000,
  PLAYER_NAME_TTL_MS: 30_000,
});
const T = PET_TUNING;
const SPIRIT_NAME = "encapsulated spirit";

export function createPets(deps = {}) {
  const { host = null, bot = null, options = null, subscribe = null, consumables = null, items = null } = deps;
  const monsterPetDmg = typeof deps.monsterPetDmg === "function" ? deps.monsterPetDmg : null;
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const log = makeLogger(deps.log, "pets", now);

  const st = {
    state: "idle", // idle | summoning | refilling
    device: 0,
    spirit: 0,
    preCharges: -1,
    issuedAt: 0,
    lastThinkAt: -Infinity,
    assumeActiveUntil: 0,
    deviceCooldown: new Map(),
    playerName: "",
    playerNameAt: -Infinity,
    summons: 0,
    refills: 0,
    lastAction: null,
    plan: null,
    disposed: false,
  };

  const unsubs = [];
  if (typeof subscribe === "function") {
    try {
      unsubs.push(subscribe("chat", (sig) => onChat(String((sig && sig.text) || ""))));
    } catch (e) {
      log(`subscribe failed: ${errText(e)}`);
    }
  }

  function combat() {
    return loopOf(bot, "combat");
  }

  function devices(inv) {
    const out = [];
    const push = (g, wcid, name) => {
      if (g && !out.some((d) => d.guid === g)) out.push({ guid: g, wcid: wcid >>> 0, name });
    };
    try {
      if (items && typeof items.ofKind === "function") {
        for (const e of items.ofKind("pet") || []) {
          const g = typeof items.resolveGuid === "function" ? Number(items.resolveGuid(e)) >>> 0 : resolveOwned(host, e, inv);
          const row = inv.find((r) => (Number(r.guid) >>> 0) === g);
          push(g, Number(e.wcid || (row && row.wcid)) || 0, e.name);
        }
      }
    } catch (_) {
      /* no Items tab */
    }
    for (const e of consumableEntries(consumables)) {
      if (e.type !== "Pet") continue;
      const g = resolveOwned(host, e, inv);
      const row = inv.find((r) => (Number(r.guid) >>> 0) === g);
      push(g, Number(e.wcid || (row && row.wcid)) || 0, e.name);
    }
    return out;
  }

  function configured() {
    try {
      if (items && typeof items.ofKind === "function" && (items.ofKind("pet") || []).length) return true;
    } catch (_) {
      /* no Items tab */
    }
    return consumableEntries(consumables).some((e) => e.type === "Pet");
  }

  function enabled() {
    if (st.disposed) return false;
    if (!optBool(options, "SummonPets", false)) return false;
    const c = combat();
    if (c && c.enabled === false) return false;
    return configured();
  }

  function petRange() {
    return optBool(options, "CustomPetRangeEnabled", false)
      ? Math.max(1, optNum(options, "CustomPetRange", 5))
      : Math.max(1, optNum(options, "MonsterRange", 40));
  }

  /** The scanned monsters inside the pet range, nearest first. */
  function monstersInRange() {
    const range = petRange();
    return scanTargets(combat())
      .filter((s) => s && Number(s.dist) <= range)
      .sort((a, b) => Number(a.dist) - Number(b.dist));
  }

  function playerName(t) {
    if (st.playerName && t - st.playerNameAt < T.PLAYER_NAME_TTL_MS && t >= st.playerNameAt) return st.playerName;
    const me = playerGuid(host);
    const n = me ? objName(host, me) : "";
    if (n) {
      st.playerName = n;
      st.playerNameAt = t;
    }
    return st.playerName;
  }

  /** A combat pet of ours is visible (name prefix "<me>'s " or PetOwner == us). */
  function petActive(t) {
    const me = playerGuid(host);
    const prefix = (playerName(t) || "") + "'s ";
    const guids = call(host, "NearbyGuids");
    if (!Array.isArray(guids)) return false;
    for (const g0 of guids) {
      const g = Number(g0) >>> 0;
      if (!g || g === me) continue;
      if (prefix.length > 3 && objName(host, g).startsWith(prefix)) return true;
      if (me) {
        const owner = call(host, "TryGetObjectInstanceIdProperty", g, PROP.IID_PET_OWNER);
        if (typeof owner === "number" && owner >>> 0 === me) return true;
      }
    }
    return false;
  }

  function summoningTrained() {
    const sk = skillOf(playerStats(host), SKILL.SUMMONING);
    if (!sk) return true; // unknown ⇒ don't block
    return sk.training >= 2;
  }

  function charges(g) {
    const v = objInt(host, g, PROP.STRUCTURE);
    return typeof v === "number" ? v : -1;
  }

  function findSpirit(inv) {
    const r = inv.find((x) => !(Number(x.equipMask) >>> 0) && lc(x.name).includes(SPIRIT_NAME));
    return r ? Number(r.guid) >>> 0 : 0;
  }

  function onChat(text) {
    if (!text || st.state === "idle") return;
    const t = now();
    if (st.state === "summoning") {
      if (/is already active/i.test(text)) {
        st.assumeActiveUntil = t + T.ASSUME_ACTIVE_MS;
        goIdle();
      } else if (/enough charges/i.test(text)) {
        log(`essence ${st.device} reports empty; will refill`);
        goIdle();
      } else if (/^You must be an? .+ to use/i.test(text)) {
        if (st.device) st.deviceCooldown.set(st.device, t + T.DEVICE_MASTERY_COOLDOWN_MS);
        log(`essence ${st.device} needs another summoning mastery — skipped`);
        goIdle();
      }
      return;
    }
    if (st.state === "refilling" && /add the spirit to the essence|essence is already full/i.test(text)) {
      st.refills++;
      goIdle();
    }
  }

  function goIdle() {
    st.state = "idle";
    st.issuedAt = 0;
    st.preCharges = -1;
    releaseItem(host, OWNER);
  }
  function reset() {
    if (st.state !== "idle") releaseItem(host, OWNER);
    st.state = "idle";
    st.device = 0;
    st.spirit = 0;
    st.preCharges = -1;
    st.issuedAt = 0;
  }

  /** Positive completion checks + the timeout (before any busy gate, C#). */
  function progress(inv, t) {
    if (st.state === "summoning") {
      const cur = charges(st.device);
      if ((st.preCharges >= 0 && cur >= 0 && cur < st.preCharges) || petActive(t)) {
        st.assumeActiveUntil = t + T.ASSUME_ACTIVE_MS;
        st.summons++;
        goIdle();
        return;
      }
    } else if (st.state === "refilling") {
      const spiritGone = st.spirit && !inv.some((r) => (Number(r.guid) >>> 0) === st.spirit);
      if (spiritGone || charges(st.device) > 0) {
        st.refills++;
        log(`refill complete (essence ${st.device})`);
        goIdle();
        return;
      }
    }
    if (st.state !== "idle" && t - st.issuedAt > T.ACTION_TIMEOUT_MS) {
      log(`action timeout in ${st.state} (essence ${st.device}); cooling down`);
      if (st.device) st.deviceCooldown.set(st.device, t + T.DEVICE_FAIL_COOLDOWN_MS);
      if (st.state === "summoning") st.assumeActiveUntil = t + T.ASSUME_ACTIVE_MS;
      reset();
    }
  }

  /** Device order for this summon: PetDmg-matching essences first. */
  function orderedDevices(inv, trigger) {
    const all = devices(inv);
    if (!monsterPetDmg || !trigger) return all;
    let want = null;
    try {
      want = monsterPetDmg(trigger);
    } catch (_) {
      want = null;
    }
    const table = supportData("pet_essences");
    if (!want || want === "PAuto" || !table || !table.essences) return all;
    const el = (d) => {
      const rec = table.essences[String(d.wcid >>> 0)];
      return rec ? rec.damageType : null;
    };
    const match = all.filter((d) => el(d) === want);
    return match.concat(all.filter((d) => el(d) !== want));
  }

  // The decision for this think. Side effects are bookkeeping only (the think
  // throttle after a "nothing to do" evaluation, parking an empty essence that
  // has no spirit to refill it) — never a host action.
  function decide(t) {
    if (st.state !== "idle") return { kind: "wait" };
    if (inPortal(host)) return null;
    if (t - st.lastThinkAt < T.THINK_INTERVAL_MS && t >= st.lastThinkAt) return null;
    if (t < st.assumeActiveUntil) return null;
    if (busyCount(host) !== 0 || itemTokenHeldByOther(host, OWNER) || castTokenBusy(host, t)) return null;
    if (call(host, "GetCastBusyState") > 0) return null; // AC refuses an item use mid-gesture (PM:IssueSummon)
    if (!playerGuid(host)) return null;
    const plan = evaluate(t);
    if (!plan) st.lastThinkAt = t; // nothing to do: think again in 1 s
    return plan;
  }

  function evaluate(t) {
    const near = monstersInRange();
    const need = Math.min(20, Math.max(1, Math.round(optNum(options, "PetMinMonsters", 1))));
    if (near.length < need) return null;
    if (petActive(t)) return null;
    if (!summoningTrained()) return null;
    const inv = inventoryOf(host);
    const refill = optBool(options, "PetAutoRefill", true);
    for (const d of orderedDevices(inv, near[0] && Number(near[0].guid) >>> 0)) {
      const u = st.deviceCooldown.get(d.guid);
      if (u != null && t < u) continue;
      const ch = charges(d.guid);
      if (ch !== 0) return { kind: "summon", device: d.guid, charges: ch, name: d.name };
      if (refill) {
        const spirit = findSpirit(inv);
        if (spirit) return { kind: "refill", device: d.guid, spirit, name: d.name };
      }
      // Out of charges and nothing to refill it with: park it, try the next one.
      st.deviceCooldown.set(d.guid, t + T.DEVICE_NO_SPIRIT_COOLDOWN_MS);
      log(`essence ${d.name || d.guid} is empty and there is no Encapsulated Spirit — next essence`);
    }
    return null;
  }

  function act(plan, t) {
    st.lastThinkAt = t;
    if (plan.kind !== "summon" && plan.kind !== "refill") return;
    if (!claimItem(host, OWNER)) return;
    const sent =
      plan.kind === "summon"
        ? call(host, "UseObject", plan.device) === true
        : call(host, "UseItemOnTarget", plan.spirit, plan.device) === true;
    if (!sent) {
      releaseItem(host, OWNER);
      return;
    }
    st.state = plan.kind === "summon" ? "summoning" : "refilling";
    st.device = plan.device;
    st.spirit = plan.kind === "refill" ? plan.spirit : 0;
    st.preCharges = plan.kind === "summon" ? plan.charges : -1;
    st.issuedAt = t;
    st.lastAction = { kind: plan.kind, device: plan.device, at: t };
    log(plan.kind === "summon" ? `summoning from essence ${plan.name || plan.device} (charges ${plan.charges})` : `refilling essence ${plan.device}`);
  }

  function cachedPlan(t) {
    if (st.plan && t >= st.plan.at && t - st.plan.at <= 50) return st.plan.plan; // same kernel tick
    const plan = decide(t);
    st.plan = { at: t, plan };
    return plan;
  }

  const slot = {
    name: "Pets",
    rank: "beforeCombat",
    keepsCombatLoop: false,
    enabled: () => {
      try {
        return enabled();
      } catch (_) {
        return false;
      }
    },
    wants: () => {
      try {
        if (!enabled()) return false;
        const t = now();
        if (st.state !== "idle") {
          // An issued summon/refill resolves on its own (Structure, the pet,
          // chat, the 8 s timeout); it never holds the tick — the fight goes on.
          progress(inventoryOf(host), t);
          if (st.state !== "idle") return false;
        }
        const p = cachedPlan(t);
        return !!p && p.kind !== "wait";
      } catch (e) {
        log(`wants threw: ${errText(e)}`);
        return false;
      }
    },
    tick: () => {
      try {
        const t = now();
        if (st.state !== "idle") {
          progress(inventoryOf(host), t);
          return;
        }
        const p = cachedPlan(t);
        st.plan = null;
        if (p) act(p, t);
      } catch (e) {
        log(`tick threw: ${errText(e)}`);
      }
    },
    onLeave: () => {},
    get status() {
      return status();
    },
  };

  function status() {
    return {
      enabled: (() => {
        try {
          return enabled();
        } catch (_) {
          return false;
        }
      })(),
      state: st.state,
      device: st.device,
      summons: st.summons,
      refills: st.refills,
      petRangeM: petRange(),
      lastAction: st.lastAction,
    };
  }

  function dispose() {
    st.disposed = true;
    reset();
    for (const u of unsubs.splice(0)) {
      try {
        if (typeof u === "function") u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  return { slot, status, dispose, _state: st };
}

export default createPets;
