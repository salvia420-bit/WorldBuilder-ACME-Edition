// observe.js — compact world/bot observation for the AI director's prompt.
// INTERFACE FROZEN — see rynth/ai/SPEC.md §observe. Pure function of
// (bot, opts): the only clock is the injected `now`; every field is
// individually try/caught and degrades to "n/a" (a hostile/missing
// subsystem can never break a check-in). Text is hard-capped at maxChars,
// dropping threat lines first.

import { TOWNS } from "./tools/towns.js";

const NA = "n/a";
const THREAT_TOP_N = 8; // SPEC §observe: top-8 nearby attackable threats
const CORPSE_WCID = 21; // loot_loop.js:10 (private const there)

/** Every observation field goes through this: throw/undefined -> null. */
function safe(fn) {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch (_) {
    return null;
  }
}

// /loc degrees from a full objCellId + landblock-local x/y. Neither half of
// this math is exported: world-frame metres per router.js:45-47 worldXY
// (lbByte*192 + local), then the sidecar's WorldToDeg — rynthnav-sidecar/
// DetourRouter.cs:131 `(w / 24.0 - 1019.5) / 10.0`, with NS from world-Y and
// EW from world-X (DetourRouter.cs:244-245). Inlined verbatim; do not
// "simplify" — goto {ns,ew} feeds the inverse (DegToWorld) on the sidecar.
function locDegrees(objCellId, x, y) {
  const wx = ((objCellId >>> 24) & 0xff) * 192 + x;
  const wy = ((objCellId >>> 16) & 0xff) * 192 + y;
  return { ns: (wy / 24 - 1019.5) / 10, ew: (wx / 24 - 1019.5) / 10 };
}

// Global-frame distance (cross-landblock safe), same frame as the combat
// loop's netbrain input builder (combat_loop.js:245-258).
function globalDist(a, b) {
  const gx = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
  const gy = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;
  return Math.hypot(
    gx(b.objCellId >>> 0, b.x) - gx(a.objCellId >>> 0, a.x),
    gy(b.objCellId >>> 0, b.y) - gy(a.objCellId >>> 0, a.y),
    (b.z || 0) - (a.z || 0)
  );
}

function fmtDur(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d${h}h`;
  if (h) return `${h}h${m}m`;
  if (m) return `${m}m${s % 60}s`;
  return `${s}s`;
}

const fmtDeg = (v, pos, neg) => `${Math.abs(v).toFixed(2)}${v >= 0 ? pos : neg}`;
const fmtPct = (v) => (v == null ? "?" : `${Math.round(v)}%`);
// Health fractions: TryGetTargetHealthFraction yields -1 unknown, 0..1 known
// (webhost.js:314-316); null here = unknown.
const fmtHp = (frac) => (frac == null ? "hp=?" : `hp=${Math.round(frac * 100)}%`);

/** -> { text, data } — token-lean prompt block + the structured source.
 *
 * showSteadyState (default true) gates the combat/econ steady-state TEXT lines
 * (vitals, buffs, loot_min/priorities) that a non-combat goal set never reads
 * — see extensions.js activeGoalsFor / C4-2. The structured `data` is left
 * whole regardless (observe_ext.js and others read data.vitals/kernel), so
 * this only trims the rendered prompt, never the source of truth. */
export function buildObservation(bot, { journalTail = "", maxChars = 6000, now = Date.now(), diag = null, spend = null, showSteadyState = true } = {}) {
  const b = bot || {};
  journalTail = journalTail == null ? "" : String(journalTail);

  // ── data (each field independently null on any error) ────────────────
  const uptimeMs = safe(() => {
    // No canonical start stamp on the bot surface; kernel.start() stamps
    // buff.startedAt (kernel.js:33). bot.startedAt wins if wiring adds one.
    const t = b.startedAt ?? b.buff?.startedAt;
    return Number.isFinite(t) && t > 0 && now >= t ? now - t : null;
  });

  const position = safe(() => {
    const p = b.host.TryGetPlayerPose();
    if (!p) return null;
    const cell = p.objCellId >>> 0;
    const { ns, ew } = locDegrees(cell, p.x, p.y);
    return { objCellId: cell, x: p.x, y: p.y, z: p.z, ns, ew };
  });

  const kernel = safe(() => {
    const st = b.kernel.status; // kernel.js:149-157
    return { running: b.kernel.running === true, action: st.action, kills: st.kills, looted: st.looted };
  });

  const vitals = safe(() => {
    const f = b.vitals._fractions(); // vitals.js:88-109 (percent 0..100)
    if (!f || f.hp === undefined) return null;
    return { hp: f.hp, stam: f.stam ?? null, mana: f.mana ?? null };
  });

  const buffs = safe(() => {
    const st = b.buff.status; // buff_loop.js:427-439
    return {
      ready: st.ready === true,
      active: st.active,
      desired: st.desired,
      parked: Array.isArray(st.parked) ? st.parked.length : 0,
      pending: st.pending || 0,
    };
  });

  const lockedGuid = safe(() => {
    const g = b.combat.locked;
    return typeof g === "number" ? g : null;
  });
  const lock = lockedGuid
    ? safe(() => ({
        guid: lockedGuid >>> 0,
        name: safe(() => b.host.TryGetObjectName(lockedGuid)) || "?",
        hp: safe(() => {
          const hf = b.host.TryGetTargetHealthFraction(lockedGuid);
          return hf >= 0 ? hf : null;
        }),
        dist: safe(() => {
          const me = b.host.TryGetPlayerPose();
          const tp = b.host.TryGetObjectPosition(lockedGuid);
          return me && tp ? globalDist(me, tp) : null;
        }),
      }))
    : null;

  // Reuse combat's own scanner — same filters/scoring the kernel trusts
  // (kernel.js:59-62); already sorted best-first (combat_loop.js:164-195).
  const threats = safe(() =>
    b.combat._scanTargets().slice(0, THREAT_TOP_N).map((t) => ({
      guid: t.guid >>> 0,
      name: safe(() => b.host.TryGetObjectName(t.guid)) || "?",
      dist: t.dist,
      hp: safe(() => {
        const hf = b.host.TryGetTargetHealthFraction(t.guid);
        return hf >= 0 ? hf : null;
      }),
    }))
  );

  const corpses = safe(() => {
    // Same spatial gate as loot_loop._findCorpse (loot_loop.js:98-115):
    // corpse wcid, same landblock word, <= 30 m planar.
    const me = b.host.TryGetPlayerPose();
    if (!me) return null;
    let n = 0;
    for (const g of b.host.NearbyGuids()) {
      if (b.host.TryGetObjectWcid(g) !== CORPSE_WCID) continue;
      const p = b.host.TryGetObjectPosition(g);
      if (!p || p.objCellId >>> 16 !== me.objCellId >>> 16) continue;
      if (Math.hypot(p.x - me.x, p.y - me.y) > 30) continue;
      n++;
    }
    return n;
  });

  const router = safe(() => {
    const st = b.router.status; // router.js:284-286
    return { state: st.state, leg: st.leg, legs: st.legs, walked: st.walked };
  });
  const gotoActive = safe(() => (b.globalRouter ? b.globalRouter.busy === true : null));
  const loot = safe(() => ({ minValue: b.loot.minValue }));
  const priorities = safe(() => ({ ...b.combat.priorities }));

  const netbrain = safe(() => {
    // First line only — the rest is per-slice detail the director doesn't
    // need. opts.diag is the test seam; the page publishes window.__diag
    // (netbrain.js diag()).
    const d = diag ?? globalThis.window?.__diag;
    const s = d?.netbrain?.summary();
    return typeof s === "string" ? s.split("\n")[0] : null;
  });

  const spendData = safe(() =>
    spend
      ? {
          calls: spend.calls,
          promptTokens: spend.promptTokens,
          completionTokens: spend.completionTokens,
          errors: spend.errors,
        }
      : null
  );

  const data = {
    now,
    uptimeMs,
    position,
    kernel,
    vitals,
    buffs,
    lock,
    threats,
    corpses,
    router,
    gotoActive,
    loot,
    priorities,
    netbrain,
    spend: spendData,
    journalTail,
  };

  // ── text (line-oriented; threats list truncates first, then hard slice) ──
  const nn = (v) => (v == null ? "?" : v);
  const head = [];
  head.push(
    `uptime: ${uptimeMs == null ? NA : fmtDur(uptimeMs)} | kernel: ${
      kernel
        ? `${kernel.running ? "running" : "STOPPED"} action=${nn(kernel.action)} kills=${nn(kernel.kills)} looted=${nn(kernel.looted)}`
        : NA
    }`
  );
  head.push(
    position
      ? `pos: 0x${position.objCellId.toString(16).padStart(8, "0")} xyz=(${position.x.toFixed(1)},${position.y.toFixed(1)},${position.z.toFixed(1)}) loc=${fmtDeg(position.ns, "N", "S")} ${fmtDeg(position.ew, "E", "W")}`
      : `pos: ${NA}`
  );
  // Nav availability is GROUND TRUTH (like the pos line): live soak-13
  // showed a stale scratchpad belief ("goto fails") outliving a nav fix —
  // the model never retried. State it every check-in so beliefs can't drift.
  {
    const indoors = position ? ((position.objCellId >>> 0) & 0xffff) >= 0x100 : false;
    const hasNav = safe(() => !!bot.globalRouter);
    head.push(
      hasNav
        ? `nav: goto/goto_lb ONLINE (outdoor router)${indoors ? " — you are INDOORS: use exit_building first, goto only works outdoors" : ""}`
        : `nav: OFFLINE (no sidecar) — goto/goto_lb unavailable; move with goto_object${indoors ? " or exit_building" : ""}`
    );
    // Sense of place (soak-14): raw loc degrees left the model guessing
    // "town center" coordinates from priors. Name the nearest known town
    // and the offset to it — public map data (tools/towns.js).
    if (position && Number.isFinite(position.ns) && Number.isFinite(position.ew)) {
      let best = null;
      for (const t of TOWNS) {
        const d = Math.hypot(position.ns - t.ns, position.ew - t.ew);
        if (!best || d < best.d) best = { t, d };
      }
      if (best) {
        const dns = position.ns - best.t.ns, dew = position.ew - best.t.ew;
        const dir = `${Math.abs(dns) >= 0.05 ? (dns > 0 ? "N" : "S") : ""}${Math.abs(dew) >= 0.05 ? (dew > 0 ? "E" : "W") : ""}` || "at";
        head.push(
          best.d < 0.15
            ? `area: AT ${best.t.name} town center`
            : `area: nearest town ${best.t.name}, ${best.d.toFixed(1)}° ${dir} of its center (${fmtDeg(best.t.ns, "N", "S")} ${fmtDeg(best.t.ew, "E", "W")})`
        );
      }
    }
  }
  // Steady-state combat/econ telemetry (C4-2): rendered only when an active
  // goal reads it. Data is still populated above regardless.
  if (showSteadyState) {
    head.push(vitals ? `vitals: hp=${fmtPct(vitals.hp)} stam=${fmtPct(vitals.stam)} mana=${fmtPct(vitals.mana)}` : `vitals: ${NA}`);
    head.push(
      buffs
        ? `buffs: active=${nn(buffs.active)}/${nn(buffs.desired)} parked=${buffs.parked} pending=${buffs.pending} ready=${buffs.ready ? "y" : "n"}`
        : `buffs: ${NA}`
    );
  }
  head.push(
    lockedGuid == null
      ? `lock: ${NA}`
      : lock
        ? `lock: 0x${lock.guid.toString(16)} "${lock.name}" ${fmtHp(lock.hp)}${lock.dist != null ? ` d=${lock.dist.toFixed(1)}m` : ""}`
        : "lock: none"
  );

  const threatLines =
    threats == null ? [] : threats.map((t) => `- ${t.name} d=${t.dist.toFixed(1)} ${fmtHp(t.hp)}`);

  const tail = [];
  tail.push(`corpses: ${corpses == null ? NA : corpses}`);
  tail.push(
    `router: ${
      router
        ? router.state === "WALK" || router.state === "PORTAL"
          ? `${router.state} leg=${router.leg + 1}/${router.legs} walked=${router.walked}`
          : nn(router.state)
        : NA
    } | goto: ${gotoActive == null ? NA : gotoActive ? "active" : "idle"}`
  );
  if (showSteadyState)
    tail.push(
      `loot_min: ${loot ? nn(loot.minValue) : NA} | priorities: ${
        priorities
          ? Object.keys(priorities).length
            ? Object.entries(priorities).map(([k, v]) => `${k}:${v}`).join(",")
            : "none"
          : NA
      }`
    );
  tail.push(`netbrain: ${netbrain == null ? NA : netbrain}`);
  if (spendData)
    tail.push(
      `ai_spend: calls=${nn(spendData.calls)} prompt=${nn(spendData.promptTokens)} completion=${nn(spendData.completionTokens)} errors=${nn(spendData.errors)}`
    );
  tail.push(`journal:${journalTail ? "\n" + journalTail : " (none)"}`);

  const render = (k) => {
    const th =
      threats == null
        ? [`threats: ${NA}`]
        : threats.length === 0
          ? ["threats: none"]
          : [`threats (${k}/${threats.length}):`, ...threatLines.slice(0, k)];
    return [...head, ...th, ...tail].join("\n");
  };

  let k = threatLines.length;
  let text = render(k);
  while (text.length > maxChars && k > 0) text = render(--k); // threats go first
  if (text.length > maxChars) text = text.slice(0, maxChars); // then the hard cap

  return { text, data };
}
