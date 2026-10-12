#!/usr/bin/env node
// rynth_magic_update_test.cjs — the 2026-10-12 cast-pipeline update of
// rynth/buff_loop.js, rynth/vitals.js and rynth/ai/heal_reflex.js.
//
// What moved under these loops, and the behavior each case pins:
//   * ACE plays every windup and the cast gesture at CastSpeed 2 before the
//     enchantment lands — ~7 s for a level-8 Incantation (Player_Magic.cs:603,
//     data/spell-cast-sequence.json). B8 used to give up at 2.5 s and walk the
//     family down a tier; it now resolves on the registry, a kind=13 refusal
//     code, or UseDone + grace, with a 12 s cap.          (cases B8-*)
//   * Refusal codes are classified (components / mana / fizzle / place /
//     transient / unknown-spell) instead of all reading as a silent no-show.
//                                                         (cases R-*)
//   * spell_ladders.json tiers are scarab levels, so level-7 lore spells and
//     level-8 Incantations are reachable; B4 ladders enchantments only.
//                                                         (cases L-*)
//   * SelfTargeted spells are cast targeted at the player's own guid (the
//     glow); non-self spells stay untargeted.             (cases T-*)
//   * Magic entry checks the wielded caster; no cast in portal space.
//                                                         (cases G-*)
//   * wasm boxes (playerEnchantments rows, playerStats) are freed.
//                                                         (cases F-*)
//   * vitals resolve recovery spells to the highest known tier, demote on
//     fizzles, and re-read the book.                      (cases V-*)
//   * RynthAi's dynamic buff list.                        (cases D-*)
//   * heal_reflex claims the cast token only when it acts. (cases H-*)
//
// Run: node rynth_magic_update_test.cjs   (exit 1 on any FAIL)

"use strict";
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const APP = __dirname;
const RYNTH = path.join(APP, "rynth");
const load = (rel) => import(pathToFileURL(path.join(RYNTH, rel)).href);

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || "" });
}

const SELF_GUID = 0x50000001;
const EQUIP_MELEE = 0x00100000;
const EQUIP_CASTER = 0x01000000;

// Fake RynthWebHost: records casts / mode requests, owns a UseDone counter,
// a push-event plane and the shared cast token.
function makeHost(opts = {}) {
  const st = {
    reg: opts.reg || [],
    known: opts.known || [],
    mode: opts.mode ?? 8,
    useDone: 0,
    casts: [],
    modeReqs: [],
    inv: opts.inv ?? [],
    freed: 0,
    statsFreed: 0,
    handlers: [],
    token: null,
    claims: [],
    releases: [],
    vitals: opts.vitals || [1, 100, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100],
  };
  const box = (row) => ({ ...row, free() { st.freed++; } });
  const host = {
    st,
    IsPlayerReady: () => true,
    GetCurrentCombatMode: () => st.mode,
    GetCastBusyState: () => 0,
    GetBusyState: () => 0,
    GetPlayerId: () => (opts.noGuid ? 0 : SELF_GUID),
    CastSpell: (target, id) => st.casts.push({ target, id }),
    ChangeCombatMode: (m) => st.modeReqs.push(m),
    TryGetPlayerInventory: () => st.inv,
    onEvent: (fn) => st.handlers.push(fn),
    tryClaimCast: (owner) => {
      st.claims.push(owner);
      if (st.token && st.token !== owner) return false;
      st.token = owner;
      return true;
    },
    releaseCast: (owner) => {
      st.releases.push(owner);
      if (st.token === owner) st.token = null;
    },
    get castToken() {
      return st.token ? { owner: st.token } : null;
    },
    s: {
      playerEnchantments: () => st.reg.map(box),
      playerKnownSpells: () => st.known.slice(),
      getUseDoneSeq: () => st.useDone,
      playerStats: () => ({ vitals: st.vitals.slice(), skills: [], free() { st.statsFreed++; } }),
      ...(opts.records ? { getSpellRecord: (id) => opts.records[id] ?? null } : {}),
    },
    emit(e) {
      for (const fn of st.handlers) fn(e);
    },
  };
  return host;
}
const wire = (spellId, family, remainingS, extra = {}) => ({
  spellId, spellCategory: family, startTime: 0, duration: remainingS, layer: 0, ...extra,
});

async function main() {
  const bl = await load("buff_loop.js");
  const { RynthBuffLoop, castRefusalClass, buildDynamicBuffList, filterCastableBuffs, loadSpellLadders } = bl;
  const { RynthVitals, VITAL_LADDERS } = await load("vitals.js");
  const { HealReflex } = await load("ai/heal_reflex.js");
  const ladder = await loadSpellLadders(); // module-relative file: URL in node
  const catalog = JSON.parse(fs.readFileSync(path.join(APP, "data", "spells-catalog.json"), "utf8")).spells;
  const attrs = JSON.parse(fs.readFileSync(path.join(APP, "data", "spell-table-attrs.json"), "utf8")).attrs;
  const SCARAB = new Map([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6], [110, 6], [112, 7], [192, 7], [193, 8]]);

  check("L0 ladder table loads in node (module-relative)", ladder && Object.keys(ladder).length > 1000,
    `entries=${ladder ? Object.keys(ladder).length : "null"}`);

  const realNow = Date.now;
  const T0 = 9_000_000;
  let now = T0;
  Date.now = () => now;
  const mk = (host, raw, o = {}) => {
    const loop = new RynthBuffLoop(host, raw, { log: () => {}, ...o });
    loop.startedAt = T0;
    loop._buildLadders();
    loop.registryReady = true;
    loop._refresh();
    return loop;
  };

  try {
    // ── L — tiers 7/8 reachable; enchantments only ─────────────────────
    {
      const host = makeHost({ known: [2, 1332, 2087, 4325] }); // Str I, VI, Lugians (7), Incantation (8)
      const loop = mk(host, [2]);
      check("L1 B4 resolves Strength Self I to the Incantation (tier 8) when known",
        loop.desired.length === 1 && loop.desired[0] === 4325, `desired=${JSON.stringify(loop.desired)}`);
    }
    {
      const host = makeHost({ known: [2, 1332, 2087] });
      const loop = mk(host, [2]);
      check("L2 without the Incantation, B4 picks Might of the Lugians (tier 7)",
        loop.desired[0] === 2087, `desired=${JSON.stringify(loop.desired)}`);
    }
    {
      // Healing Mastery Self I desired; the character also knows Heal Self VI
      // (category 67, a Boost) — B4 must not swap the buff for the heal.
      const host = makeHost({ known: [874, 879, 1161, 4311] });
      const loop = mk(host, [874]);
      check("L3 B4 ladders enchantments only (Healing Mastery VI, not Heal Self)",
        loop.desired[0] === 879, `desired=${JSON.stringify(loop.desired)}`);
    }

    // ── T — self-targeted casts ─────────────────────────────────────────
    {
      const host = makeHost({ known: [2] });
      const loop = mk(host, [2]);
      loop.tick();
      const c = host.st.casts[0];
      check("T1 SelfTargeted buff is cast targeted at the player's own guid",
        c && c.id === 2 && c.target === SELF_GUID, JSON.stringify(c));
    }
    {
      const host = makeHost({ known: [2963] }); // Aura of Hunter's Cunning — not SelfTargeted
      const loop = mk(host, [2963]);
      loop.tick();
      const c = host.st.casts[0];
      // NEVER untargeted (2026-10-12 server crash: ACE's untargeted path keeps
      // a NULL target and a non-SelfTargeted enchantment reaches
      // CreateEnchantment(null) on the world thread) — targeted at self.
      check("T2 non-SelfTargeted spell is cast TARGETED at self, never untargeted",
        c && c.id === 2963 && c.target === SELF_GUID, JSON.stringify(c));
    }
    {
      const host = makeHost({ known: [2], noGuid: true });
      const loop = mk(host, [2]);
      loop.tick();
      check("T3 no player guid yet -> no cast at all (never an untargeted fallback)",
        host.st.casts.length === 0 && !loop.pending, JSON.stringify(host.st.casts));
    }

    {
      // Live server crash 2026-10-12: the book holds "Incantation of Strength
      // Other" (4324 — not in the ladder table; the catalog fallback says NOT
      // SelfTargeted) beside Strength Self I. B4 must never resolve the self
      // buff to the Other spell (it was then cast untargeted -> ACE
      // CreateEnchantment(null) -> unhandled NRE -> server down).
      const records = { 4324: { category: 1, roughLevel: 8, power: 400, flags: { selfTargeted: false } } };
      const host = makeHost({ known: [2, 4324], records });
      const loop = mk(host, [2]);
      loop.tick();
      check("T4 B4 never upgrades a self buff to an Other spell (catalog: not SelfTargeted)",
        loop.desired[0] === 2 && !host.st.casts.some((c) => c.id === 4324),
        JSON.stringify({ desired: loop.desired, casts: host.st.casts }));
      check("T4 and every cast it sends is targeted at self", host.st.casts.every((c) => c.target === SELF_GUID),
        JSON.stringify(host.st.casts));
    }

    // ── I12 — an item enchant the host didn't send frees the token (second review #12) ──
    {
      const host = makeHost({ known: [2] });
      let sendOk = false;
      const sent = [];
      host.CastSpell = (t, id) => { sent.push({ t, id }); return sendOk; };
      const loop = mk(host, [], { itemBuffs: [{ spellId: 1636, itemGuid: 0x80001234 }] });
      const acted = loop._maintainItemBuffs(now, host);
      check("I12 refused send: no pending, token released, nothing claimed left over",
        acted === false && loop._itemPending === null && host.st.token === null && host.st.releases.includes("buff"),
        JSON.stringify({ acted, pending: loop._itemPending, token: host.st.token, releases: host.st.releases }));
      const claimsBefore = host.st.claims.length;
      now += 1000;
      loop._maintainItemBuffs(now, host);
      check("I12 no retry inside the 2 s window (no token churn every tick)", host.st.claims.length === claimsBefore && sent.length === 1,
        `claims=${host.st.claims.length - claimsBefore} sent=${sent.length}`);
      now += 1500;
      sendOk = true;
      const acted2 = loop._maintainItemBuffs(now, host);
      check("I12 retried after the window; a sent cast installs the pending + keeps the token",
        acted2 === true && sent.length === 2 && loop._itemPending && loop._itemPending.spellId === 1636 && host.st.token === "buff",
        JSON.stringify({ acted2, sent: sent.length, pending: loop._itemPending, token: host.st.token }));
    }

    // ── B8 — resolution on ACE's answer ─────────────────────────────────
    {
      // A 7 s Incantation: nothing landed at 3 s, no UseDone yet -> still pending.
      now = T0;
      const host = makeHost({ known: [4325] });
      const loop = mk(host, [4325]);
      loop.tick();
      const issued = loop.pending && loop.pending.spellId === 4325;
      now = T0 + 3000;
      loop.tick();
      const stillPending = loop.pending && loop.pending.spellId === 4325 && !loop._unresolvable.has(4325);
      now = T0 + 6900;
      host.st.reg = [wire(4325, 1, 3600)];
      host.st.useDone = 1;
      loop.tick();
      check("B8a long cast (7 s) is not a no-show at 3 s and confirms when it lands",
        issued && stillPending && loop.pending === null && (loop.noShows.get(4325) || 0) === 0 && !loop._unresolvable.has(4325),
        `issued=${issued} pendingAt3s=${stillPending} pending=${loop.pending && loop.pending.spellId} unresolvable=${loop._unresolvable.has(4325)}`);
      now = T0;
    }
    {
      // UseDone came back at 1 s and nothing landed -> silent no-show once
      // past both the grace and the 2.5 s floor -> the B9 tier walk.
      const host = makeHost({ known: [1332, 4325] });
      const loop = mk(host, [1332]); // resolves to 4325
      loop.tick();
      now = T0 + 1000;
      host.st.useDone = 1;
      loop.tick();
      now = T0 + 2000;
      loop.tick();
      const pendingAt2 = !!loop.pending;
      now = T0 + 2600;
      loop.tick();
      check("B8b UseDone with nothing landed -> no-show after grace + 2.5 s floor -> tier walk",
        pendingAt2 && loop.pending === null && loop._unresolvable.has(4325) && loop.desired[0] === 1332,
        `pendingAt2=${pendingAt2} pending=${loop.pending} desired=${JSON.stringify(loop.desired)}`);
      now = T0;
    }
    {
      // No UseDone ever (lost / never sent from a stalled page): retried at
      // the 12 s cap, counted toward the park, NOT tier-walked.
      const host = makeHost({ known: [1332, 4325] });
      const loop = mk(host, [1332]);
      loop.tick();
      now = T0 + 11_000;
      loop.tick();
      const pendingAt11 = !!loop.pending;
      now = T0 + 12_100;
      loop.tick();
      check("B8c hard cap: no answer in 12 s -> retry counted, no tier walk",
        pendingAt11 && loop.pending === null && !loop._unresolvable.has(4325) && loop.noShows.get(4325) === 1,
        `pendingAt11=${pendingAt11} unresolvable=${loop._unresolvable.has(4325)} noShows=${loop.noShows.get(4325)}`);
      now = T0;
    }
    {
      // Host without UseDone reporting keeps the legacy fixed clock.
      const host = makeHost({ known: [1332, 4325] });
      delete host.s.getUseDoneSeq;
      const loop = mk(host, [1332]);
      loop.tick();
      const legacy = loop.pending && loop.pending.useDoneAtIssue == null;
      now = T0 + 2600;
      loop.tick();
      check("B8d host without UseDoneSeq: legacy 2.5 s give-up still walks",
        legacy && loop._unresolvable.has(4325), `legacy=${legacy} unresolvable=${loop._unresolvable.has(4325)}`);
      now = T0;
    }

    // ── R — refusal classes ─────────────────────────────────────────────
    check("R0 classifier", castRefusalClass(0x0400) === "components" && castRefusalClass(0x0401) === "mana" &&
      castRefusalClass(0x0402) === "fizzle" && castRefusalClass(0x001d) === "transient" &&
      castRefusalClass(0x03fc) === "unknown-spell" && castRefusalClass(0x0550) === null, "");
    const refusalCase = (code) => {
      now = T0;
      const host = makeHost({ known: [1332, 4325] });
      const loop = mk(host, [1332]);
      loop.tick(); // casts 4325; tick ensured the event tap
      now = T0 + 300;
      host.emit({ kind: 13, u32: code, text: null, u32b: 0 });
      now = T0 + 700;
      loop.tick();
      return { host, loop };
    };
    {
      const { loop, host } = refusalCase(0x0400);
      now = T0 + 60_000;
      loop.tick(); // still held: no new cast
      check("R1 components: resolved at once, buffing held 5 min, no no-show, no walk",
        loop.pending === null && loop.status.blocked === "components" && host.st.casts.length === 1 &&
          !loop._unresolvable.has(4325) && (loop.noShows.get(4325) || 0) === 0 && loop.lastRefusal?.cls === "components",
        `blocked=${loop.status.blocked} casts=${host.st.casts.length} unresolvable=${loop._unresolvable.has(4325)}`);
    }
    {
      const { loop, host } = refusalCase(0x0401);
      const heldAt10 = (() => { now = T0 + 10_000; loop.tick(); return host.st.casts.length === 1; })();
      now = T0 + 16_000;
      loop.tick();
      check("R2 mana: held 15 s, then retried; no walk", heldAt10 && host.st.casts.length === 2 && !loop._unresolvable.has(4325),
        `heldAt10=${heldAt10} casts=${host.st.casts.length}`);
    }
    {
      const { loop, host } = refusalCase(0x001d);
      now = T0 + 1800;
      loop.tick();
      check("R3 busy (transient): retried after ~1 s, nothing counted",
        host.st.casts.length === 2 && (loop.noShows.get(4325) || 0) === 0 && !loop._unresolvable.has(4325),
        `casts=${host.st.casts.length}`);
    }
    {
      // Three fizzles in a row -> walk; two do not.
      now = T0;
      const host = makeHost({ known: [1332, 4325] });
      const loop = mk(host, [1332]);
      let t = T0;
      const fizzleOnce = () => {
        now = t;
        loop.tick(); // cast
        now = t + 300;
        host.emit({ kind: 13, u32: 0x0402, text: null, u32b: 0 });
        now = t + 700;
        loop.tick(); // resolve
        t += 2000;
      };
      fizzleOnce();
      fizzleOnce();
      const after2 = !loop._unresolvable.has(4325) && loop.desired[0] === 4325;
      fizzleOnce();
      check("R4 fizzle: two retry, the third walks a tier", after2 && loop._unresolvable.has(4325) && loop.desired[0] === 1332,
        `after2=${after2} desired=${JSON.stringify(loop.desired)}`);
      now = T0;
    }
    {
      const { loop } = refusalCase(0x03fc);
      check("R5 not-in-spellbook refusal walks at once", loop._unresolvable.has(4325) && loop.desired[0] === 1332,
        `desired=${JSON.stringify(loop.desired)}`);
    }
    {
      // A refusal that isn't a cast code (MissileOutOfRange from a loot use) is ignored.
      const { loop } = refusalCase(0x0550);
      check("R6 non-cast refusal code is ignored (cast stays pending)", loop.pending && loop.pending.spellId === 4325,
        `pending=${loop.pending && loop.pending.spellId}`);
    }

    // ── G — gates ───────────────────────────────────────────────────────
    {
      now = T0;
      const host = makeHost({ known: [2], mode: 1, inv: [{ equipMask: EQUIP_MELEE }] });
      const loop = mk(host, [2]);
      loop.tick();
      check("G1 no caster wielded: no setCombatMode(Magic) sent, blocked=no-caster",
        host.st.modeReqs.length === 0 && loop.status.blocked === "no-caster", `modeReqs=${host.st.modeReqs} blocked=${loop.status.blocked}`);
    }
    {
      const host = makeHost({ known: [2], mode: 1, inv: [{ equipMask: EQUIP_CASTER }] });
      const loop = mk(host, [2]);
      loop.tick();
      check("G2 caster wielded: Magic requested", host.st.modeReqs[0] === 8, `modeReqs=${host.st.modeReqs}`);
    }
    {
      const host = makeHost({ known: [2], mode: 1, inv: [] });
      const loop = mk(host, [2]);
      loop.tick();
      check("G3 inventory not streamed (empty): legacy attempt still sent", host.st.modeReqs[0] === 8, `modeReqs=${host.st.modeReqs}`);
    }
    {
      const host = makeHost({ known: [2] });
      const loop = mk(host, [2]);
      globalThis.__isPortalSpaceActive = () => true;
      loop.tick();
      const none = host.st.casts.length === 0;
      delete globalThis.__isPortalSpaceActive;
      loop.tick();
      check("G4 portal space holds new casts; they resume after", none && host.st.casts.length === 1, `none=${none} casts=${host.st.casts.length}`);
    }

    // ── F — boxes freed; receivedAt keyed by layer ──────────────────────
    {
      const host = makeHost({ known: [2], reg: [wire(2, 1, 1800), wire(1332, 1, 1800)] });
      const loop = mk(host, [2]);
      const before = host.st.freed;
      loop._refresh();
      check("F1 playerEnchantments boxes freed once per read", host.st.freed - before === 2, `freed=${host.st.freed - before}`);
    }
    {
      // Same spell on two layers, different start times: each layer keeps its
      // own receipt stamp across reads.
      now = T0;
      const host = makeHost({ known: [2], reg: [wire(2, 1, 1800, { layer: 1, startTime: 0 }), wire(2, 1, 1800, { layer: 2, startTime: -600 })] });
      const loop = mk(host, [2]);
      const e1 = loop.families.get(1).expiresAtMs;
      now = T0 + 10_000;
      loop._refresh();
      const e2 = loop.families.get(1).expiresAtMs;
      check("F2 receivedAt keyed by spell+layer: expiry stable across reads", e1 === e2 && e1 === T0 + 1800_000, `e1=${e1} e2=${e2}`);
      now = T0;
    }
    {
      const host = makeHost({ known: [6] });
      const vit = new RynthVitals(host, { log: () => {} });
      vit._fractions();
      check("F3 vitals playerStats box freed", host.st.statsFreed === 1, `statsFreed=${host.st.statsFreed}`);
    }

    // ── V — vitals ──────────────────────────────────────────────────────
    {
      const host = makeHost({ known: [6, 1157, 1161, 1664, 1669, 2343], vitals: [1, 40, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] });
      const vit = new RynthVitals(host, { log: () => {} });
      const sp = vit.spells;
      check("V1 recovery spells resolve to the highest known tier", sp.healSelf === 1161 && sp.stamToHealth === 2343,
        JSON.stringify(sp));
      vit.step(true); // hp 40 < 60 in combat -> heal
      const c = host.st.casts[0];
      check("V2 vitals heal cast at own guid with the resolved tier", c && c.id === 1161 && c.target === SELF_GUID, JSON.stringify(c));
    }
    {
      const host = makeHost({ known: [6, 1161] });
      const vit = new RynthVitals(host, { log: () => {}, spells: { healSelf: 6 } });
      check("V3 opts.spells pin wins", vit.spells.healSelf === 6, JSON.stringify(vit.spells));
    }
    {
      now = T0;
      const host = makeHost({ known: [6, 1159, 1161], vitals: [1, 40, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] });
      const vit = new RynthVitals(host, { log: () => {} });
      for (let i = 0; i < 3; i++) {
        now = T0 + i * 1000;
        host.st.token = null;
        vit.step(true);
        now += 200;
        host.emit({ kind: 13, u32: 0x0402, text: null, u32b: 0 });
      }
      check("V4 three fizzles demote the heal one tier (VI -> IV)", vit.spells.healSelf === 1159, JSON.stringify(vit.spells));
      now = T0;
    }
    {
      now = T0;
      const host = makeHost({ known: [] });
      const vit = new RynthVitals(host, { log: () => {} });
      const before = vit.spells.healSelf; // book empty: level-1 placeholder
      host.st.known = [6, 1158];
      now = T0 + 31_000;
      const after = vit.spells.healSelf;
      check("V5 known book re-read (bot built before the spellbook hydrated)", before === 6 && after === 1158, `before=${before} after=${after}`);
      now = T0;
    }
    {
      const host = makeHost({ known: [6], mode: 1, inv: [{ equipMask: EQUIP_MELEE }], vitals: [1, 40, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] });
      const vit = new RynthVitals(host, { log: () => {} });
      const held = vit.step(true);
      check("V6 vitals without a caster: no Magic request, tick released, blocked=no-caster",
        held === false && host.st.modeReqs.length === 0 && vit.status.blocked === "no-caster", `held=${held} modeReqs=${host.st.modeReqs}`);
    }
    {
      // Every VITAL_LADDERS entry: the named spell, SelfTargeted, level = slot.
      const want = {
        healSelf: ["Heal Self", "Adja's Intervention", "Incantation of Heal Self"],
        stamToHealth: ["Stamina to Health Self", "Rushed Recovery", "Incantation of Stamina to Health Self"],
        stamToMana: ["Stamina to Mana Self", "Meditative Trance", "Incantation of Stamina to Mana Self"],
        revitalize: ["Revitalize Self", "Robustification", "Incantation of Revitalize Self"],
      };
      const bad = [];
      for (const [role, ids] of Object.entries(VITAL_LADDERS)) {
        ids.forEach((id, i) => {
          const name = catalog[String(id)]?.name || "?";
          const a = attrs[String(id)];
          const lvl = a ? SCARAB.get(a.formula[0]) : null;
          const nameOk = i < 6 ? name.startsWith(want[role][0]) : name === want[role][i === 6 ? 1 : 2];
          if (!nameOk || lvl !== i + 1 || !a || !(a.bitfield & 0x8)) bad.push(`${role}[${i}]=${id} '${name}' L${lvl}`);
        });
      }
      check("V7 VITAL_LADDERS match the catalog (name, scarab level, SelfTargeted)", bad.length === 0, bad.join("; "));
    }

    // ── D — dynamic buff list ──────────────────────────────────────────
    {
      // Strength I (1), Focus III, Willpower VI, Heavy Weapon Mastery I, Light
      // Weapon Mastery I, Regeneration II, Aura of Blood Drinker I, Heal Self I.
      const focus3 = Object.keys(ladder).find((k) => catalog[k]?.name === "Focus Self III");
      const will6 = Object.keys(ladder).find((k) => catalog[k]?.name === "Willpower Self VI");
      const known = [2, Number(focus3), Number(will6), 418, 298, 166, 35, 6];
      const skills = new Map([[44, 2], [45, 1], [31, 1]]); // Heavy trained, Light untrained, Creature untrained
      const list = buildDynamicBuffList({ knownIds: known, skills, ladder });
      const names = list.map((id) => catalog[String(id)]?.name);
      check("D1 RynthAi order: Focus, Willpower, Strength, trained mastery, life, aura; untrained mastery and heals out",
        JSON.stringify(names) === JSON.stringify(["Focus Self III", "Willpower Self VI", "Strength Self I", "Heavy Weapon Mastery Self I", "Regeneration Self II", "Aura of Blood Drinker Self I"]),
        JSON.stringify(names));
    }
    {
      // Each family table entry names its category: some ladder spell whose
      // catalog name starts with the base name carries that category.
      const bad = [];
      const fams = [...bl.BASE_CREATURE_BUFFS, ...bl.SKILL_BUFFS.map(([, n, c]) => [n, c]), ...bl.LIFE_BUFFS, ...bl.AURA_BUFFS];
      for (const [base, cat] of fams) {
        const hit = Object.entries(ladder).some(([id, row]) => row[0] === cat && (catalog[id]?.name || "").startsWith(base));
        if (!hit) bad.push(`${base}->${cat}`);
      }
      check("D2 dynamic-list family categories match the catalog", bad.length === 0, bad.join("; "));
    }
    {
      const kept = filterCastableBuffs([2, 99999, 1083], [1332], ladder);
      check("D3 filterCastableBuffs keeps a family known at another tier, drops unknowns",
        JSON.stringify(kept) === JSON.stringify([2]), JSON.stringify(kept));
    }

    // ── S — runtime control used by the HUD ──────────────────────────────
    {
      now = T0;
      const host = makeHost({ known: [2, 1332], reg: [wire(1332, 1, 3600)] });
      const loop = mk(host, [2]);
      loop.tick();
      const quietWhileActive = host.st.casts.length === 0;
      loop.forceRebuff();
      loop.tick();
      const recast = host.st.casts.length === 1 && host.st.casts[0].id === 1332;
      const ids = loop.setDesired([24]);
      check("S1 forceRebuff recasts an active buff; setDesired swaps the set",
        quietWhileActive && recast && JSON.stringify(ids) === "[24]" && loop._laddersBuilt === false,
        `quiet=${quietWhileActive} recast=${recast} ids=${JSON.stringify(ids)}`);
    }

    // ── H — heal_reflex token ───────────────────────────────────────────
    {
      const host = makeHost({ known: [], inv: [{ guid: 7, name: "Rock", itemType: 0 }], vitals: [1, 20, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] });
      const hr = new HealReflex(host, { enabled: true, log: () => {} });
      const r = hr.step(false);
      check("H1 nothing usable in the pack: cast token never claimed", r.reason === "no-consumable" && host.st.claims.length === 0,
        `reason=${r.reason} claims=${host.st.claims}`);
    }
    {
      const host = makeHost({ known: [], inv: [{ guid: 9, name: "Apple", itemType: 0x20 }], vitals: [1, 20, 0, 100, 3, 100, 0, 100, 5, 100, 0, 100] });
      host.UseObject = () => false;
      const hr = new HealReflex(host, { enabled: true, log: () => {} });
      const r = hr.step(false);
      check("H2 send failure releases the token it claimed", r.reason === "food-send-failed" && host.st.releases.includes("heal_reflex") && host.st.token === null,
        `reason=${r.reason} releases=${host.st.releases} token=${host.st.token}`);
      check("H3 one playerStats box read and freed per step", host.st.statsFreed === 1, `statsFreed=${host.st.statsFreed}`);
    }
  } finally {
    Date.now = realNow;
  }

  let failed = 0;
  const W = Math.max(...results.map((r) => r.name.length)) + 1;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(W)}${r.ok ? "" : ` [${r.detail}]`}`);
  }
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error("HARNESS ERROR:", e);
  process.exit(1);
});
