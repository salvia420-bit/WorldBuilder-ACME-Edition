#!/usr/bin/env node
// rynth_combat_memory_test.cjs — unit tests for rynth/ai/combat_memory.js
// (CombatMemory: the combat-telemetry core, A3-1 §D4 dark module). No infra,
// no network, no DOM — pure JS over an injected `now` clock (constructor
// opts.now) so DPS windows and TTK are deterministic.
//
// Run: node rynth_combat_memory_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

(async () => {
  const modUrl = pathToFileURL(path.join(__dirname, "rynth", "ai", "combat_memory.js")).href;
  const mod = await import(modUrl);
  const { CombatMemory, ValueSnapShotGroup, DPS_WINDOW_MS, MAX_TRACKED_NAMES } = mod;

  // Controllable clock — tests set `t` explicitly.
  function makeClock(start = 1_000_000) {
    let t = start;
    return { now: () => t, set: (v) => (t = v), advance: (d) => (t += d) };
  }
  // Build a kind=19 combat event as host.onEvent delivers it (text = JSON).
  const combatEvt = (obj) => ({ kind: 19, text: JSON.stringify(obj), u32: 0, u32b: 0 });
  const dealt = (name, damage, opts = {}) =>
    combatEvt({ type: "damageDealt", defenderName: name, damage, severity: opts.severity || 0, criticalHit: !!opts.crit });
  const taken = (name, damage, opts = {}) =>
    combatEvt({ type: "damageTaken", attackerName: name, damage, severity: opts.severity || 0, criticalHit: !!opts.crit });
  const evadedTarget = (name) => combatEvt({ type: "evadedTarget", defenderName: name });
  const evadedAttacker = (name) => combatEvt({ type: "evadedAttacker", attackerName: name });
  const attackDone = (error) => combatEvt({ type: "attackDone", error });

  // ── ValueSnapShotGroup: sum / rate ramp / prune eviction ────────────────
  {
    const g = new ValueSnapShotGroup(60_000);
    const t0 = 1_000_000;
    g.add(100, t0);
    check("VSSG sum immediate", g.sum(t0) === 100);
    check("VSSG rate at t0 (denom floored to 1s)", near(g.rate(t0), 100));
    check("VSSG rate at +30s", near(g.rate(t0 + 30_000), 100 / 30));
    check("VSSG rate at +60s (full window, sample retained)", near(g.rate(t0 + 60_000), 100 / 60));
    check("VSSG evicts at +60.001s", g.sum(t0 + 60_001) === 0 && g.rate(t0 + 60_001) === 0);
    check("VSSG lifetime total survives eviction", g.total === 100);
    check("DPS_WINDOW_MS is 60s", DPS_WINDOW_MS === 60_000);
  }

  // ── damageDealt: offense record + out window/dps + totals ───────────────
  {
    const c = makeClock();
    const m = new CombatMemory({ now: c.now });
    m.consume(dealt("Drudge", 10, { crit: false }));
    c.advance(1000); m.consume(dealt("Drudge", 20, { crit: true }));
    c.advance(1000); m.consume(dealt("Drudge", 30, { crit: false }));
    const r = m.byTarget.get("Drudge");
    check("dealt hits counted once each", r.hits === 3, `hits=${r.hits}`);
    check("dealt damage summed", r.damage === 60, `damage=${r.damage}`);
    check("dealt crits counted", r.crits === 1);
    check("totals.dealt", m.totals.dealt === 60);
    check("totals.hits", m.totals.hits === 3);
    // window now = start + 2000; all three within 60s. elapsed 2000 -> denom 2000ms.
    check("outWindow sum", m.outWindow() === 60);
    check("outDps = 60/2s = 30", near(m.outDps(), 30), `outDps=${m.outDps()}`);
    check("inDps is zero (no damage taken)", m.inDps() === 0);
  }

  // ── damageTaken: danger (lastSeenDamage) + in window/dps + totals ───────
  {
    const c = makeClock();
    const m = new CombatMemory({ now: c.now });
    m.consume(taken("Olthoi", 15));
    c.advance(1000); m.consume(taken("Olthoi", 25, { crit: true }));
    const r = m.byAttacker.get("Olthoi");
    check("taken counted", r.taken === 2);
    check("taken damage summed", r.damage === 40);
    check("danger = last seen damage", m.danger("Olthoi") === 25, `danger=${m.danger("Olthoi")}`);
    check("crits taken counted", r.crits === 1 && m.totals.critsTaken === 1);
    check("totals.taken", m.totals.taken === 40);
    check("inWindow sum", m.inWindow() === 40);
    check("inDps = 40/1s = 40", near(m.inDps(), 40), `inDps=${m.inDps()}`);
    check("danger of unknown attacker is 0", m.danger("Nobody") === 0);
  }

  // ── accuracy = dealt/(dealt+evadedTarget) ──────────────────────────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    m.consume(dealt("Rat", 5));
    m.consume(dealt("Rat", 5));
    m.consume(dealt("Rat", 5));
    m.consume(evadedTarget("Rat"));
    check("accuracy 3/4 = 0.75", near(m.accuracy("Rat"), 0.75), `acc=${m.accuracy("Rat")}`);
    check("miss recorded in offense record", m.byTarget.get("Rat").misses === 1);
    check("totals.evadesFor", m.totals.evadesFor === 1);
    check("accuracy of unseen target is 0", m.accuracy("Ghost") === 0);
  }

  // ── defense = evadedAttacker/(taken+evadedAttacker) ────────────────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    m.consume(taken("Tusker", 10));
    m.consume(taken("Tusker", 10));
    m.consume(taken("Tusker", 10));
    m.consume(evadedAttacker("Tusker"));
    check("defense 1/4 = 0.25", near(m.defense("Tusker"), 0.25), `def=${m.defense("Tusker")}`);
    check("evade-against recorded", m.byAttacker.get("Tusker").evaded === 1);
    check("totals.evadesAgainst", m.totals.evadesAgainst === 1);
    check("defense of unseen attacker is 0", m.defense("Ghost") === 0);
  }

  // ── crit rate: overall + per-name ──────────────────────────────────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    m.consume(dealt("A", 5, { crit: true }));
    m.consume(dealt("A", 5, { crit: false }));
    m.consume(dealt("B", 5, { crit: true }));
    m.consume(dealt("B", 5, { crit: true }));
    check("overall crit rate 3/4", near(m.critRate(), 0.75));
    check("per-name crit rate A = 0.5", near(m.critRate("A"), 0.5));
    check("per-name crit rate B = 1.0", near(m.critRate("B"), 1.0));
    check("crit rate unseen name is 0", m.critRate("Z") === 0);
  }

  // ── TTK via severity accumulation (approximate, general) ───────────────
  {
    const c = makeClock(0);
    const m = new CombatMemory({ now: c.now });
    // Engagement 1: two severity-0.5 hits 3s apart -> crosses 1.0 -> kill, ttk 3000.
    m.consume(dealt("Mob", 40, { severity: 0.5 }));
    c.advance(3000); m.consume(dealt("Mob", 40, { severity: 0.5 }));
    let k = m.ttk("Mob");
    check("TTK samples after first kill", k.samples === 1, `samples=${k.samples}`);
    check("TTK last = 3000ms", k.lastMs === 3000, `last=${k.lastMs}`);
    check("kill counted in totals", m.totals.kills === 1);
    check("engagement reset (engagedAt cleared)", m.byTarget.get("Mob").engagedAt === null);
    // Engagement 2 (respawn, same name): 0.5 + 0.5, 4s span -> ttk 4000, avg 3500.
    c.advance(2000); m.consume(dealt("Mob", 40, { severity: 0.5 }));
    c.advance(4000); m.consume(dealt("Mob", 40, { severity: 0.5 }));
    k = m.ttk("Mob");
    check("TTK two samples after respawn kill", k.samples === 2, `samples=${k.samples}`);
    check("TTK avg = 3500ms", near(k.avgMs, 3500), `avg=${k.avgMs}`);
    check("TTK last = 4000ms", k.lastMs === 4000);
    check("TTK of un-killed target is zeros", JSON.stringify(m.ttk("Nobody")) === JSON.stringify({ avgMs: 0, lastMs: 0, samples: 0 }));
  }

  // ── mostDangerous picks the hardest last hit ───────────────────────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    m.consume(taken("Weakling", 3));
    m.consume(taken("Bruiser", 50));
    m.consume(taken("Bruiser", 12)); // last seen now 12 (< Weakling? no, 12>3)
    const md = m.mostDangerous();
    check("mostDangerous by last-seen-damage", md.name === "Bruiser" && md.lastSeenDamage === 12, JSON.stringify(md));
    check("mostDangerous null when no attackers", new CombatMemory().mostDangerous() === null);
  }

  // ── attackDone: swing + error counting ─────────────────────────────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    m.consume(attackDone("None"));
    m.consume(attackDone("None"));
    m.consume(attackDone("YoureTooBusy"));
    check("swings counted", m.totals.swings === 3);
    check("swing errors counted (non-None only)", m.totals.swingErrors === 1);
  }

  // ── death event (kind=29): observed-death corroboration ────────────────
  {
    const c = makeClock(7_000_000);
    const m = new CombatMemory({ now: c.now });
    m.consume({ kind: 29, text: "Drudge has been slain!", u32: 0x1234, u32b: 0x5678 });
    check("observedDeaths incremented", m.observedDeaths === 1);
    check("lastDeathAt stamped", m.lastDeathAt === 7_000_000);
  }

  // ── no-op / survival on absent, malformed, or foreign events ───────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    const before = JSON.stringify(m.snapshot());
    let threw = false;
    try {
      m.consume(null);
      m.consume(undefined);
      m.consume({});                                   // no kind
      m.consume({ kind: 19 });                         // no text
      m.consume({ kind: 19, text: "{not json" });      // bad JSON
      m.consume({ kind: 19, text: JSON.stringify({}) });        // no type
      m.consume({ kind: 19, text: JSON.stringify({ type: "combatCommenceAttack" }) }); // unknown type
      m.consume({ kind: 2, text: "You singe Rat for 9 points with Flame Bolt" });      // chat -> combat_loop's job
      m.consume({ kind: 1, text: "irrelevant" });      // foreign kind
      m.consume(42);                                   // non-object
    } catch (_) {
      threw = true;
    }
    check("consume never throws on junk", !threw);
    check("junk events mutate nothing", JSON.stringify(m.snapshot()) === before);
    check("no targets/attackers from junk", m.byTarget.size === 0 && m.byAttacker.size === 0);
  }

  // ── snapshot() shape (plain data, not a render) ────────────────────────
  {
    const c = makeClock();
    const m = new CombatMemory({ now: c.now });
    m.consume(dealt("X", 10, { crit: true }));
    m.consume(taken("X", 5));
    const s = m.snapshot();
    check("snapshot has dps/window fields", typeof s.outDps === "number" && typeof s.inWindow === "number");
    check("snapshot totals is a copy", s.totals && s.totals.dealt === 10 && s.totals !== m.totals);
    check("snapshot counts", s.targetCount === 1 && s.attackerCount === 1);
    check("snapshot is a string-serializable data object", typeof JSON.stringify(s) === "string");
  }

  // ── attach(host): subscribes via host.onEvent ──────────────────────────
  {
    const subs = [];
    const fakeHost = { onEvent: (fn) => subs.push(fn) };
    const m = new CombatMemory({ now: () => 5_000_000 }).attach(fakeHost);
    check("attach registered one subscriber", subs.length === 1);
    subs[0](dealt("Wired", 7));
    check("event routed through attach", m.byTarget.get("Wired").damage === 7);
    // attach on a host without onEvent is a safe no-op returning this.
    const m2 = new CombatMemory();
    check("attach on host w/o onEvent is a no-op", m2.attach({}) === m2 && m2.attach(null) === m2);
  }

  // ── independence: no double-count vs RynthCombatLoop.damageModel ────────
  {
    const clUrl = pathToFileURL(path.join(__dirname, "rynth", "combat_loop.js")).href;
    const { RynthCombatLoop } = await import(clUrl);
    // Minimal shared host.onEvent tap (mirrors webhost._dispatchEvent fan-out).
    const subs = [];
    const host = {
      onTick: () => {},
      onEvent: (fn) => subs.push(fn),
      TryGetTargetHealthFraction: () => -1,
    };
    const fire = (evt) => { for (const fn of subs) fn(evt); };

    const loop = new RynthCombatLoop(host);
    loop.startOn(host);        // subscribes combat_loop's _onCombatEvent
    loop.locked = 0xABCD;      // combat_loop learns only against a locked target
    const mem = new CombatMemory({ now: () => 5_000_000 }).attach(host);

    // A damageDealt with a direct severity (combat_loop learns MaxHP directly,
    // no host health poll needed) fired ONCE into the shared tap.
    fire(dealt("SharedFoe", 10, { severity: 0.1 }));

    const loopModel = loop.damageModel.get(0xABCD);
    const memRec = mem.byTarget.get("SharedFoe");
    check("combat_loop counted the shared event once", loopModel && loopModel.hits === 1, `loop hits=${loopModel && loopModel.hits}`);
    check("combat_memory counted the shared event once", memRec && memRec.hits === 1, `mem hits=${memRec && memRec.hits}`);
    check("combat_memory holds no ref to combat_loop.damageModel", mem.byTarget !== loop.damageModel);
    check("independent structures — mem did not write loop's model", loop.damageModel.size === 1 && mem.byTarget.size === 1);
    loop.stop();
  }

  // ── LRU eviction bound on byTarget/byAttacker (streamline #12 / review 11
  // §3 S3 fix: the maps were unbounded — name-keyed, no cap) ──────────────
  {
    const m = new CombatMemory({ now: () => 5_000_000 });
    check("MAX_TRACKED_NAMES is a sane positive cap", Number.isFinite(MAX_TRACKED_NAMES) && MAX_TRACKED_NAMES > 0);
    for (let i = 0; i < MAX_TRACKED_NAMES + 50; i++) m.consume(dealt(`Mob${i}`, 1));
    check("byTarget never exceeds MAX_TRACKED_NAMES", m.byTarget.size === MAX_TRACKED_NAMES, `size=${m.byTarget.size}`);
    check("oldest names were evicted", !m.byTarget.has("Mob0") && !m.byTarget.has("Mob49"));
    check("most recent names survive", m.byTarget.has(`Mob${MAX_TRACKED_NAMES + 49}`));

    const ma = new CombatMemory({ now: () => 5_000_000 });
    for (let i = 0; i < MAX_TRACKED_NAMES + 50; i++) ma.consume(taken(`Foe${i}`, 1));
    check("byAttacker never exceeds MAX_TRACKED_NAMES", ma.byAttacker.size === MAX_TRACKED_NAMES, `size=${ma.byAttacker.size}`);
  }
  {
    // Touching an existing (already-tracked) name refreshes its LRU
    // recency — an active engagement must not be evicted merely for being
    // the least-RECENTLY-CREATED entry while it keeps getting hit.
    const m = new CombatMemory({ now: () => 5_000_000 });
    m.consume(dealt("Veteran", 1)); // created first — would be evicted first under a naive insertion-only cap
    for (let i = 1; i < MAX_TRACKED_NAMES; i++) m.consume(dealt(`Filler${i}`, 1));
    // Map is now exactly at cap (Veteran + (MAX-1) fillers = MAX). Re-touch
    // Veteran to refresh it, then push one more new name past the cap.
    m.consume(dealt("Veteran", 1));
    m.consume(dealt("OneMore", 1));
    check("re-touched entry survives eviction ahead of a stale one",
      m.byTarget.has("Veteran"), `has(Veteran)=${m.byTarget.has("Veteran")}`);
    check("cap still enforced after the extra insert", m.byTarget.size === MAX_TRACKED_NAMES, `size=${m.byTarget.size}`);
  }

  console.log(`\ncombat_memory: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS ERROR", e && e.stack || e);
  process.exit(1);
});
