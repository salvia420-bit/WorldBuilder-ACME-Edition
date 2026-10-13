// tests/rynth_vt_meta_engine.test.mjs — rynth/vt/meta engine (W1-4 META,
// PLAN §3.12, §2.9 X1-X5/X8).
//
// MetaEngine against fakes for every injected dependency (C2: no import of
// another vt package): a tiny fake expression runtime (setvar/getvar/==,
// delayexec queue, registry calls), a fake MetaContext (settings with a bag,
// chat runner that applies /vt lines synchronously, nav, player, world,
// portal, views) and an injected clock. Covers fire-once, re-arm, DoAll,
// break-on-entry, interleaving, the call stack, the watchdog, the two timers,
// event latching, B14, V-7 (delayexec waits while held), replaceMeta, the
// injected truthiness, cadence, rebind continuity and T-ME-EX (G:296-319).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_meta_engine.test.mjs

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const META_DIR = path.resolve(HERE, "../rynth/vt/meta");

const M = await import("../rynth/vt/meta/index.js");
const { MetaEngine, registerMetaFunctions, PASS_INTERVAL_MS, STACK_CAP, normalizeMeta } = M;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

const T0 = 1_800_000_000_000;

// ── fakes ────────────────────────────────────────────────────────────────

// Q9 truthiness / Bool "1"/"0" — the shape EXPR's values.js exports.
const VALUES = {
  isErr: (v) => !!v && typeof v === "object" && v.t === "err",
  truthy: (v) => {
    if (v === null || v === undefined || v === false || v === 0) return false;
    if (typeof v === "string") return !["", "0", "false"].includes(v.trim().toLowerCase());
    if (v && typeof v === "object" && v.t === "err") return false;
    return true;
  },
  toStr: (v) => (v === null || v === undefined ? "" : typeof v === "boolean" ? (v ? "1" : "0") : typeof v === "object" ? `[${v.t}]` : String(v)),
};

function fakeRegistry() {
  const fns = new Map();
  return {
    define(name, impl, opts = {}) {
      fns.set(String(name).toLowerCase(), { impl, ...opts });
      return true;
    },
    get: (n) => fns.get(String(n).toLowerCase()) || null,
    has: (n) => fns.has(String(n).toLowerCase()),
    names: () => [...fns.keys()],
  };
}

// A tiny meta-mode evaluator: name[args], `a==b`, literals; delayexec[ms,raw]
// queues the raw text; setvar/getvar/err/throw/count builtins; any other call
// goes to the registry (registerMetaFunctions is registered on it).
function makeMiniExpr(clock, registry) {
  const vars = new Map();
  const queue = [];
  let seq = 0;
  const stats = { flush: [], pumps: [], evaluated: [], counters: new Map() };
  const builtins = {
    setvar: (a) => (vars.set(String(a[0]).toLowerCase(), a[1]), a[1]),
    getvar: (a) => (vars.has(String(a[0]).toLowerCase()) ? vars.get(String(a[0]).toLowerCase()) : 0),
    err: (a) => ({ t: "err", msg: String(a[0] ?? "boom") }),
    count: (a) => {
      const k = String(a[0] ?? "");
      stats.counters.set(k, (stats.counters.get(k) || 0) + 1);
      return 0;
    },
    concat: (a) => a.map((x) => VALUES.toStr(x)).join(""),
  };
  class Thrown extends Error {}
  function eq(l, r) {
    const ln = Number(l);
    const rn = Number(r);
    if (l !== "" && r !== "" && Number.isFinite(ln) && Number.isFinite(rn)) return ln === rn;
    return VALUES.toStr(l).toLowerCase() === VALUES.toStr(r).toLowerCase();
  }
  function evaluate(src) {
    stats.evaluated.push(src);
    const s = String(src);
    let i = 0;
    const call = (name, args) => {
      const low = name.toLowerCase();
      if (low === "throw") throw new Thrown("fake throw");
      for (const v of args) if (VALUES.isErr(v)) return v;
      if (builtins[low]) return builtins[low](args);
      const f = registry && registry.get(low);
      if (f) return f.impl(args, {});
      return { t: "err", msg: `Call to unknown function "${name}"` };
    };
    const term = () => {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\[/.exec(s.slice(i));
      if (m) {
        i += m[0].length;
        const name = m[1];
        if (name.toLowerCase() === "delayexec") {
          const comma = s.indexOf(",", i);
          const ms = Number(s.slice(i, comma));
          let depth = 1;
          let j = comma + 1;
          while (j < s.length && depth) {
            if (s[j] === "[") depth++;
            else if (s[j] === "]") depth--;
            j++;
          }
          queue.push({ due: clock.t + ms, seq: seq++, text: s.slice(comma + 1, j - 1) });
          i = j;
          return 1;
        }
        const args = [];
        if (s[i] === "]") i++;
        else {
          for (;;) {
            args.push(expr());
            if (s[i] === ",") {
              i++;
              continue;
            }
            if (s[i] === "]") {
              i++;
              break;
            }
            throw new Error(`bad syntax at ${i}`);
          }
        }
        return call(name, args);
      }
      let j = i;
      while (j < s.length && s[j] !== "," && s[j] !== "]" && !s.startsWith("==", j)) j++;
      const lit = s.slice(i, j).trim();
      i = j;
      return /^-?\d+(\.\d+)?$/.test(lit) ? Number(lit) : lit;
    };
    const expr = () => {
      const l = term();
      if (s.startsWith("==", i)) {
        i += 2;
        return eq(l, term());
      }
      return l;
    };
    try {
      const v = expr();
      return i < s.length ? { t: "err", msg: `trailing input at ${i}` } : v;
    } catch (e) {
      if (e instanceof Thrown) throw e; // the real runtime never throws; this fake can, on purpose
      return { t: "err", msg: e.message };
    }
  }
  return {
    vars: { flush: (o) => stats.flush.push(o && o.force ? "force" : "soft"), get: (k, n) => vars.get(String(n).toLowerCase()) },
    evaluate,
    setVar: (n, v) => (vars.set(String(n).toLowerCase(), v), v),
    getVar: (n) => vars.get(String(n).toLowerCase()),
    delay: (ms, text) => queue.push({ due: clock.t + ms, seq: seq++, text }),
    pump(now) {
      stats.pumps.push(now);
      const due = queue.filter((e) => e.due <= now).sort((a, b) => a.due - b.due || a.seq - b.seq);
      for (const e of due) queue.splice(queue.indexOf(e), 1);
      for (const e of due) evaluate(e.text);
      return due.length;
    },
    get queued() {
      return queue.length;
    },
    stats,
    rawVars: vars,
  };
}

const ALIASES = { enablenav: "EnableNavigation" };

function makeWorld(over = {}) {
  const w = {
    settings: { EnableMeta: true, EnableNavigation: false, EnableBuffing: false, EnableCombat: true, AttackDistance: 40 },
    bag: new Map(),
    writes: [],
    disabled: [],
    prints: [],
    chat: [],
    invoked: [],
    pose: { objCellId: 0xc8e90012, x: 10, y: 20, z: 0 },
    world: { wx: 1000, wy: 2000, z: 0 },
    portal: false,
    nav: { name: null, points: [], finished: false, minDist: Infinity, embedded: [] },
    views: { created: [], destroyed: [], destroyAll: 0 },
    chatThrows: false,
    ...over,
  };
  const findKey = (name) => {
    const low = String(name).trim().toLowerCase();
    return ALIASES[low] || Object.keys(w.settings).find((k) => k.toLowerCase() === low) || null;
  };
  const coerce = (raw) => {
    const s = String(raw).trim().toLowerCase();
    if (["true", "on", "yes", "1"].includes(s) || raw === true) return true;
    if (["false", "off", "no", "0"].includes(s) || raw === false) return false;
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  };
  const settings = {
    get(name) {
      const k = findKey(name);
      return k ? { ok: true, value: w.settings[k] } : { ok: false, error: `unknown option ${name}` };
    },
    set(name, raw, { source } = {}) {
      const k = findKey(name);
      if (!k) return { ok: false, error: `unknown option ${name}` };
      w.settings[k] = coerce(raw);
      w.writes.push([k, w.settings[k], source]);
      return { ok: true, value: w.settings[k] };
    },
    getValue: (key) => w.settings[key],
    bagGet: (n) => w.bag.get(String(n).toLowerCase()),
    bagSet: (n, v) => w.bag.set(String(n).toLowerCase(), v),
    disableMeta(reason) {
      w.disabled.push(reason);
      w.settings.EnableMeta = false;
    },
  };
  // The fake /vt dispatcher: synchronous effects; unknown /vt /rs eaten;
  // anything else goes to the (fake) game chat parser.
  const navRoutes = {
    runback: { points: [{ type: 0 }, { type: 0 }, { type: 0 }], type: "once" },
    fighting: { points: [{ type: 0 }, { type: 0 }], type: "circular" },
  };
  const chat = {
    run(line) {
      w.chat.push(line);
      if (w.chatThrows && /boom/.test(line)) throw new Error("chat runner exploded");
      const m = /^\/(vt|rs)\s+(.*)$/i.exec(line);
      if (!m) {
        w.invoked.push(line);
        return;
      }
      const parts = m[2].trim().split(/\s+/);
      const verb = parts[0].toLowerCase();
      if (verb === "nav" && parts[1] === "load") {
        const r = navRoutes[parts[2]];
        if (r) Object.assign(w.nav, { name: parts[2], points: r.points.slice(), finished: false });
      } else if (verb === "opt" && parts[1] === "set") {
        settings.set(parts[2], parts.slice(3).join(" "), { source: "command" });
      } else if (verb === "setmetastate") {
        w.engine && w.engine.enterState(parts[1], "command");
      } else {
        w.prints.push(`[RynthSuite] unknown /${m[1]} command '${verb}'`);
      }
    },
  };
  const ctx = {
    now: () => w.clock.t,
    log: () => {},
    print: (t) => w.prints.push(t),
    settings,
    chat,
    player: {
      guid: () => 0x50000001,
      pose: () => w.pose,
      world: () => w.world,
      packFreeMain: () => 10,
      burdenPct: () => 50,
      itemCount: () => 0,
      selfEnchantments: () => [],
    },
    world: { monsters: () => [] },
    nav: {
      isEmpty: () => w.nav.points.length === 0 || w.nav.finished,
      minDistToAnyPointM: () => w.nav.minDist,
      loadEmbedded(tag, mn) {
        w.nav.embedded.push([tag, mn]);
        return { ok: true };
      },
    },
    buff: { needsBuff: () => false },
    monsters: { priorityOf: () => 1 },
    portal: { active: () => w.portal },
    views: {
      create: (n, x) => (w.views.created.push([n, x]), { ok: true }),
      destroy: (n) => w.views.destroyed.push(n),
      destroyAll: () => {
        w.views.destroyAll++;
      },
    },
  };
  return { w, ctx };
}

let ruleSeq = 0;
function R(state, cond, act, extra = {}) {
  return { id: `r${++ruleSeq}`, state, enabled: true, cond, act, ...extra };
}
const C = {
  always: { t: "Always" },
  never: { t: "Never" },
  expr: (expr) => ({ t: "Expr", expr }),
  secs: (secs) => ({ t: "SecsInStateGE", secs }),
  psecs: (secs) => ({ t: "PSecsInStateGE", secs }),
  chat: (re) => ({ t: "ChatMatch", re }),
  cap: (re, colors = "") => ({ t: "ChatCapture", re, colors }),
  navEmpty: { t: "NavEmpty" },
  death: { t: "Death" },
};
const A = {
  set: (state) => ({ t: "SetState", state }),
  chat: (text) => ({ t: "Chat", text }),
  doExpr: (expr) => ({ t: "DoExpr", expr }),
  chatExpr: (expr) => ({ t: "ChatExpr", expr }),
  all: (...children) => ({ t: "DoAll", children }),
  call: (state, ret) => (ret === undefined ? { t: "CallState", state } : { t: "CallState", state, ret }),
  ret: { t: "Return" },
  wd: (dist, secs, state) => ({ t: "SetWatchdog", dist, secs, state }),
  clearWd: { t: "ClearWatchdog" },
  setOpt: (opt, expr) => ({ t: "SetOpt", opt, expr }),
};
function meta(rules, extra = {}) {
  return { v: 1, name: "test", source: { kind: "json" }, rules, navs: {}, warnings: [], ...extra };
}

function makeEngine({ m = null, worldOver = {}, state = {}, values = VALUES, running = true, getRegex } = {}) {
  const clock = { t: T0 };
  const registry = fakeRegistry();
  const expr = makeMiniExpr(clock, registry);
  const { w, ctx } = makeWorld(worldOver);
  w.clock = clock;
  const logs = [];
  const engine = new MetaEngine({
    ctx,
    expr,
    getRegex:
      getRegex ||
      ((p, f) => {
        try {
          return new RegExp(p, f);
        } catch {
          return null;
        }
      }),
    values,
    setVar: (n, v) => expr.setVar(n, v),
    state,
    now: () => clock.t,
    log: (msg) => logs.push(msg),
  });
  w.engine = engine;
  registerMetaFunctions(registry, () => engine);
  if (m) {
    const r = engine.load(m);
    assert.equal(r.ok, true, `load failed: ${r.error}`);
  }
  const h = { engine, clock, expr, registry, w, ctx, logs, state: engine.st };
  h.tick = (ms = 100, opts = { running }) => {
    clock.t += ms;
    engine.tick(clock.t, opts);
  };
  h.run = (totalMs, step = 100, opts = { running }) => {
    for (let t = 0; t < totalMs; t += step) h.tick(step, opts);
  };
  return h;
}

// ── tests ────────────────────────────────────────────────────────────────

await check("load starts in Default (not Rules[0].State, B4), clears stack/watchdog/views, never mutates the input", () => {
  const m = meta([R("zeta", C.always, A.chat("/x z")), R("Default", C.never, A.chat("/x d")), { state: "alpha", cond: C.always, act: A.chat("/x a") }]);
  const before = JSON.stringify(m);
  const h = makeEngine();
  h.state.stack.push("old");
  h.state.watchdog = { state: "x", dist: 1, secs: 1, remainingMs: 1000, lastAt: T0 };
  const r = h.engine.load(m, { name: "Lib Meta" });
  assert.equal(r.ok, true);
  assert.equal(h.engine.state, "Default");
  assert.equal(h.engine.stackDepth, 0);
  assert.equal(h.state.watchdog, null);
  assert.equal(h.w.views.destroyAll, 1, "views die on meta load");
  assert.equal(h.state.metaName, "Lib Meta");
  assert.equal(JSON.stringify(m), before, "input meta untouched");
  const ids = h.engine.meta().rules.map((x) => x.id);
  assert.equal(new Set(ids).size, 3, "the id-less rule got a fresh unique id");
  assert.ok(ids.every((id) => /^r\d+$/.test(id)));
  assert.equal(h.engine.load(null).ok, false);
  assert.equal(h.engine.load({ rules: "nope" }).ok, false);
});

await check("normalizeMeta: duplicate ids renumbered, malformed cond/act → Never/None with warnings", () => {
  const r = normalizeMeta({ rules: [{ id: "r1", state: "A", cond: C.always, act: A.chat("x") }, { id: "r1", cond: null, act: 5 }, 7] });
  assert.equal(r.ok, true);
  assert.equal(r.meta.rules.length, 2);
  assert.notEqual(r.meta.rules[0].id, r.meta.rules[1].id);
  assert.deepEqual(r.meta.rules[1].cond, { t: "Never" });
  assert.deepEqual(r.meta.rules[1].act, { t: "None" });
  assert.equal(r.meta.rules[1].state, "Default");
  assert.ok(r.warnings.length >= 3);
});

await check("fire-once per state entry; fired ids in the snapshot", () => {
  const r1 = R("Default", C.always, A.chat("/x once"));
  const h = makeEngine({ m: meta([r1]) });
  h.run(3000);
  assert.deepEqual(h.w.chat, ["/x once"]);
  assert.deepEqual(h.engine.snapshot().fired, [r1.id]);
});

await check("same-state SetState re-arms every rule and resets Seconds in State", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.chat("/x tick")), R("Default", C.secs(1), A.set("Default"))]) });
  h.run(3500);
  // fires at t≈0, then each re-entry after ≥1 s re-arms the Always rule
  const n = h.w.chat.length;
  assert.ok(n >= 3 && n <= 5, `re-armed ${n} times`);
  assert.ok(h.engine.snapshot().secondsInState < 1.5);
});

await check("DoAll runs every child in order even after a child changes state (no early bail)", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.all(A.chat("/x a"), A.set("other"), A.chat("/x b"), A.all(A.chat("/x c")))), R("Default", C.always, A.chat("/x never"))]) });
  h.tick();
  assert.deepEqual(h.w.chat, ["/x a", "/x b", "/x c"]);
  assert.equal(h.engine.state, "other");
});

await check("the pass breaks at the first state entry; the new state is evaluated on the next tick (decide now)", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.set("s2")), R("Default", C.always, A.chat("/x after")), R("s2", C.always, A.chat("/x in s2"))]) });
  h.tick(100);
  assert.equal(h.engine.state, "s2");
  assert.deepEqual(h.w.chat, []);
  h.tick(100); // < 293 ms later: decideNow forces the pass
  assert.deepEqual(h.w.chat, ["/x in s2"]);
});

await check("interleaved cond → act: a DoExpr setvar is visible to the next rule's Expr in the same pass", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.doExpr("setvar[x,1]")), R("Default", C.expr("getvar[x]==1"), A.chat("/x saw it"))]) });
  h.tick();
  assert.deepEqual(h.w.chat, ["/x saw it"]);
});

await check("disabled rules are skipped (never fired)", () => {
  const r = R("Default", C.always, A.chat("/x off"), { enabled: false });
  const h = makeEngine({ m: meta([r]) });
  h.run(1000);
  assert.deepEqual(h.w.chat, []);
  assert.deepEqual(h.engine.snapshot().fired, []);
});

await check("CallState pushes the explicit ret (B2/B8), falls back to the current state; Return pops into it", () => {
  const h = makeEngine({
    m: meta([
      R("Default", C.always, A.call("sub", "combine")),
      R("sub", C.always, A.ret),
      R("combine", C.always, A.call("sub2")),
      R("sub2", C.always, A.chat("/x in sub2")),
    ]),
  });
  h.tick();
  assert.equal(h.engine.state, "sub");
  assert.deepEqual(h.engine.snapshot().stack, ["combine"]);
  h.tick();
  assert.equal(h.engine.state, "combine", "Return pops the explicit ret, not the caller");
  assert.equal(h.engine.stackDepth, 0);
  h.tick();
  assert.equal(h.engine.state, "sub2");
  assert.deepEqual(h.engine.snapshot().stack, ["combine"], "no ret ⇒ the current state is pushed");
});

await check("Return with an empty call stack: error line, EnableMeta off via disableMeta, pass ends (GUIDE:283)", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.ret), R("Default", C.always, A.chat("/x after"))]) });
  h.tick();
  assert.equal(h.w.settings.EnableMeta, false);
  assert.equal(h.w.disabled.length, 1);
  assert.match(h.w.prints.join("\n"), /Return From Call with an empty call stack/);
  assert.deepEqual(h.w.chat, [], "the pass stopped");
  assert.match(h.engine.snapshot().lastError.msg, /empty call stack/);
  h.run(1000);
  assert.deepEqual(h.w.chat, [], "disabled ⇒ no more passes");
});

await check(`call stack capped at ${STACK_CAP} (oldest dropped, one warning)`, () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.call("Default", "back"))]) });
  h.run(80 * 100);
  assert.equal(h.engine.stackDepth, STACK_CAP);
  assert.equal(h.w.prints.filter((p) => /call stack exceeded/.test(p)).length, 1);
});

await check("watchdog: arm, fire = SetState after secs without moving dist, cleared on that entry", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 2, "stuck")), R("stuck", C.always, A.chat("/x stuck"))]) });
  h.tick();
  const wd = h.engine.snapshot().watchdog;
  assert.equal(wd.state, "stuck");
  assert.equal(wd.dist, 5);
  h.run(1500);
  assert.equal(h.engine.state, "Default");
  h.run(800);
  assert.equal(h.engine.state, "stuck");
  assert.match(h.w.prints.join("\n"), /Watchdog triggered → stuck/);
  assert.equal(h.engine.snapshot().watchdog, null, "cleared by the entry it caused");
  h.tick();
  assert.deepEqual(h.w.chat, ["/x stuck"]);
});

await check("watchdog: moving ≥ dist (world frame) re-anchors and restarts the countdown", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 2, "stuck"))]) });
  h.tick();
  for (let i = 0; i < 6; i++) {
    h.run(1000);
    h.w.world = { wx: h.w.world.wx + 6, wy: h.w.world.wy, z: 0 }; // 6 m per second
  }
  assert.equal(h.engine.state, "Default", "kept moving ⇒ never fired");
  h.w.world = { ...h.w.world, wx: h.w.world.wx + 3 }; // < 5 m from the anchor: no reset
  h.run(1500);
  assert.equal(h.engine.state, "Default");
  h.run(1000);
  assert.equal(h.engine.state, "stuck");
});

await check("watchdog: cleared by every state entry (SetState / ClearWatchdog)", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 2, "stuck")), R("Default", C.secs(1), A.set("other")), R("other", C.always, A.chat("/x other"))]) });
  h.run(1500);
  assert.equal(h.engine.state, "other");
  assert.equal(h.engine.snapshot().watchdog, null);
  h.run(5000);
  assert.equal(h.engine.state, "other", "the cleared watchdog never fires");
  const h2 = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 2, "stuck")), R("Default", C.secs(1), A.clearWd)]) });
  h2.run(6000);
  assert.equal(h2.engine.state, "Default");
});

await check("watchdog: paused in portal space (no false fire during a long tunnel)", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 2, "stuck"))]) });
  h.tick();
  h.run(1000);
  h.w.portal = true;
  h.run(10_000);
  assert.equal(h.engine.state, "Default");
  h.w.portal = false;
  h.run(700);
  assert.equal(h.engine.state, "Default", "only ~1.7 s counted so far");
  h.run(600);
  assert.equal(h.engine.state, "stuck");
});

await check("watchdog: paused while operator-held; resume re-arms the state (macro start)", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 2, "stuck"))]) });
  h.tick();
  h.run(1000);
  h.run(10_000, 100, { running: false });
  assert.equal(h.engine.state, "Default", "no fire while held");
  h.tick(100);
  assert.equal(h.engine.state, "Default");
  const wd = h.engine.snapshot().watchdog;
  assert.ok(wd && wd.secsRemaining > 1.8, "macro start re-armed the SetWatchdog rule with a fresh countdown");
  h.run(2200);
  assert.equal(h.engine.state, "stuck");
});

await check("watchdog: a second SetWatchdog REPLACES the first", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.wd(5, 10, "first")), R("Default", C.secs(1), A.wd(5, 2, "second"))]) });
  h.run(1500);
  assert.equal(h.engine.snapshot().watchdog.state, "second");
  h.run(2200);
  assert.equal(h.engine.state, "second");
});

await check("Seconds in State resets on macro off/on; Seconds in State (P) does not (GUIDE:252/268, B7)", () => {
  const h = makeEngine({ m: meta([R("Default", C.secs(5), A.chat("/x secs")), R("Default", C.psecs(5), A.chat("/x psecs"))]) });
  h.run(3000);
  h.run(7000, 100, { running: false }); // held 7 s
  h.tick(100); // resume at ~10 s: macro-start edge
  assert.deepEqual(h.w.chat, ["/x psecs"], "(P) counts the real entry; plain timer restarted");
  h.run(4000);
  assert.deepEqual(h.w.chat, ["/x psecs"]);
  h.run(1200);
  assert.deepEqual(h.w.chat, ["/x psecs", "/x secs"]);
});

await check("an event is visible to exactly one pass (even across a state change)", () => {
  const h = makeEngine({ m: meta([R("Default", C.chat("^hello$"), A.set("s2")), R("s2", C.chat("^hello$"), A.chat("/x leaked")), R("s2", C.chat("^again$"), A.chat("/x again"))]) });
  h.tick();
  h.engine.pushEvent({ type: "chat", text: "hello", chatType: 0 });
  h.tick(10);
  assert.equal(h.engine.state, "s2");
  h.run(1000);
  assert.deepEqual(h.w.chat, [], "the s2 rule never saw the consumed line");
  h.engine.pushEvent({ type: "chat", text: "again", chatType: 0 });
  h.tick(10);
  assert.deepEqual(h.w.chat, ["/x again"]);
});

await check("events are dropped while the gate is closed (held / disabled) — no stale replay", () => {
  const h = makeEngine({ m: meta([R("Default", C.chat("^boo$"), A.chat("/x boo"))]) });
  h.tick();
  h.engine.pushEvent({ type: "chat", text: "boo", chatType: 0 });
  h.tick(100, { running: false });
  h.run(500);
  assert.deepEqual(h.w.chat, []);
  h.w.settings.EnableMeta = false;
  h.engine.pushEvent({ type: "chat", text: "boo", chatType: 0 });
  h.tick();
  h.w.settings.EnableMeta = true;
  h.run(500);
  assert.deepEqual(h.w.chat, []);
});

await check("B14: an action that throws records lastError, stays fired, does not re-fire", () => {
  const r1 = R("Default", C.always, A.chat("/x boom"));
  const h = makeEngine({ m: meta([r1, R("Default", C.always, A.chat("/x next"))]), worldOver: { chatThrows: true } });
  h.tick();
  h.run(2000);
  assert.equal(h.w.chat.filter((l) => l === "/x boom").length, 1, "no re-fire storm");
  const s = h.engine.snapshot();
  assert.ok(s.fired.includes(r1.id));
  assert.equal(s.lastError.ruleId, r1.id);
  assert.match(s.lastError.msg, /chat runner exploded/);
  assert.equal(h.w.chat.filter((l) => l === "/x next").length, 1, "later rules still run");
});

await check("a condition that throws is false and recorded (the engine keeps running)", () => {
  const r1 = R("Default", C.expr("throw[]"), A.chat("/x no"));
  const h = makeEngine({ m: meta([r1, R("Default", C.always, A.chat("/x yes"))]) });
  h.tick();
  assert.deepEqual(h.w.chat, ["/x yes"]);
  assert.equal(h.engine.snapshot().lastError.ruleId, r1.id);
});

await check("V-7: delayexec pumped while EnableMeta is off, NOT while held; queued entries run after resume", () => {
  const h = makeEngine({ m: meta([]) });
  h.w.settings.EnableMeta = false;
  h.expr.evaluate("delayexec[0,setvar[d1,1]]");
  h.tick();
  assert.equal(h.expr.getVar("d1"), 1, "pumped with the meta disabled");
  h.expr.evaluate("delayexec[0,setvar[d2,1]]");
  const pumpsBefore = h.expr.stats.pumps.length;
  h.run(3000, 100, { running: false });
  assert.equal(h.expr.stats.pumps.length, pumpsBefore, "no pump while held");
  assert.equal(h.expr.getVar("d2"), undefined, "the entry waits");
  assert.equal(h.expr.queued, 1);
  h.tick(100);
  assert.equal(h.expr.getVar("d2"), 1, "ran after resume");
});

await check("var flush every tick (held and disabled too) + a forced flush on the stop edge", () => {
  const h = makeEngine({ m: meta([]) });
  h.w.settings.EnableMeta = false;
  h.tick();
  h.tick(100, { running: false });
  h.tick(100, { running: false });
  const f = h.expr.stats.flush;
  assert.equal(f.filter((x) => x === "soft").length, 3);
  assert.equal(f.filter((x) => x === "force").length, 1, "one forced flush on running → held");
});

await check("gate: no pass while held, while EnableMeta is off, or with no meta loaded", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.chat("/x go"))]) });
  h.run(1000, 100, { running: false });
  h.w.settings.EnableMeta = false;
  h.run(1000);
  assert.deepEqual(h.w.chat, []);
  h.w.settings.EnableMeta = true;
  h.tick();
  assert.deepEqual(h.w.chat, ["/x go"]);
  const h2 = makeEngine();
  h2.run(1000);
  assert.equal(h2.engine.snapshot().loaded, false);
});

await check(`cadence: one pass per ${PASS_INTERVAL_MS} ms; decide-now on an event, a state entry and a kernel action change`, () => {
  const h = makeEngine({ m: meta([R("Default", C.expr("count[p]"), A.chat("/x never"))]) });
  h.run(3000); // 30 ticks
  const n = h.expr.stats.counters.get("p");
  assert.ok(n >= 9 && n <= 12, `≈ 3000/293 passes, got ${n}`);
  const k0 = h.expr.stats.counters.get("p");
  h.tick(50);
  h.engine.noteKernelAction("Combat");
  h.tick(50);
  assert.equal(h.expr.stats.counters.get("p"), k0 + 1, "kernel action change ⇒ immediate pass");
  h.tick(50);
  assert.equal(h.expr.stats.counters.get("p"), k0 + 1, "then the 293 ms throttle again");
  h.engine.pushEvent({ type: "portalIn" });
  h.tick(10);
  assert.equal(h.expr.stats.counters.get("p"), k0 + 2, "edge event ⇒ immediate pass");
  h.engine.noteKernelAction("Combat");
  h.tick(10);
  assert.equal(h.expr.stats.counters.get("p"), k0 + 2, "same action ⇒ no extra pass");
});

await check("an expression's setmetastate entering a state ends the pass (re-arm idiom vtsetmetastate[vtgetmetastate[]])", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.chat("/x one")), R("Default", C.secs(1), A.doExpr("vtsetmetastate[vtgetmetastate[]]"))]) });
  h.run(1600);
  assert.ok(h.w.chat.length >= 2, "same-state set via the expression re-armed the Always rule");
  const h2 = makeEngine({ m: meta([R("Default", C.expr("setmetastate[s9]"), A.chat("/x never")), R("Default", C.always, A.chat("/x never2")), R("s9", C.always, A.chat("/x s9"))]) });
  h2.tick();
  assert.equal(h2.engine.state, "s9");
  assert.deepEqual(h2.w.chat, [], "a condition that entered a state ends the pass");
  h2.tick();
  assert.deepEqual(h2.w.chat, ["/x s9"]);
});

await check("ChatCapture binds capturegroup_<name> BEFORE the action runs", () => {
  const h = makeEngine({ m: meta([R("Default", C.cap("^You have (?<vitae>\\d+)% vitae"), A.chatExpr("concat[/x vitae=,getvar[capturegroup_vitae]]"))]) });
  h.tick();
  h.engine.pushEvent({ type: "chat", text: "You have 15% vitae", chatType: 0 });
  h.tick(10);
  assert.deepEqual(h.w.chat, ["/x vitae=15"]);
  assert.equal(h.expr.getVar("capturegroup_vitae"), "15");
});

await check("ChatExpr never sends an error result (B18); a non-empty result is routed like Chat", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.chatExpr("err[bad thing]")), R("Default", C.always, A.chatExpr("concat[/x hi]")), R("Default", C.always, A.chatExpr("concat[]"))]) });
  h.tick();
  assert.deepEqual(h.w.chat, ["/x hi"]);
  assert.ok(!h.w.chat.some((l) => /ERR|bad thing/.test(l)));
  assert.match(h.engine.snapshot().lastError.msg, /bad thing/);
});

await check("truthiness of Expr results goes ONLY through the injected values helpers", () => {
  let calls = 0;
  const odd = { ...VALUES, truthy: (v) => (calls++, v === "YES") };
  const h = makeEngine({ m: meta([R("Default", C.expr("YES"), A.chat("/x yes")), R("Default", C.expr("1"), A.chat("/x one"))]), values: odd });
  h.tick();
  assert.deepEqual(h.w.chat, ["/x yes"]);
  assert.equal(calls, 2);
});

await check("replaceMeta keeps state/stack/watchdog/enteredAt; keeps fired of surviving ids, drops removed, un-fires moved rules", () => {
  const keep = R("s2", C.always, A.chat("/x keep"));
  const move = R("s2", C.always, A.chat("/x move"));
  const gone = R("s2", C.always, A.chat("/x gone"));
  const h = makeEngine({ m: meta([R("Default", C.always, A.call("s2", "Default")), keep, move, gone, R("s2", C.always, A.wd(5, 30, "wd"))]) });
  h.tick();
  h.tick();
  assert.equal(h.engine.state, "s2");
  const s0 = h.engine.snapshot();
  assert.deepEqual(new Set(s0.fired), new Set([keep.id, move.id, gone.id, h.engine.meta().rules[4].id]));
  const enteredAt = h.state.enteredAt;
  const edited = JSON.parse(JSON.stringify(h.engine.meta()));
  edited.rules = edited.rules.filter((r) => r.id !== gone.id);
  edited.rules.find((r) => r.id === move.id).state = "s3";
  edited.rules.push({ id: "r999", state: "s2", enabled: true, cond: C.always, act: A.chat("/x new") });
  h.tick();
  const r = h.engine.replaceMeta(edited, { keepState: true });
  assert.equal(r.ok, true);
  assert.equal(h.engine.state, "s2", "no Default entry");
  assert.equal(h.state.enteredAt, enteredAt);
  assert.deepEqual(h.engine.snapshot().stack, ["Default"]);
  assert.equal(h.engine.snapshot().watchdog.state, "wd");
  const fired = h.engine.snapshot().fired;
  assert.ok(fired.includes(keep.id));
  assert.ok(!fired.includes(move.id), "moved to another state ⇒ un-fired");
  assert.ok(!fired.includes(gone.id));
  h.tick(10); // decideNow
  assert.ok(h.w.chat.includes("/x new"), "the added rule fires at once");
  assert.equal(h.w.chat.filter((l) => l === "/x keep").length, 1, "a surviving fired rule does not re-fire");
});

await check("rebind continuity (D6): a new engine on the same state object resumes without a macro-start re-arm", () => {
  const r1 = R("Default", C.always, A.set("hunt"));
  const r2 = R("hunt", C.always, A.chat("/x hunt once"));
  const m = meta([r1, r2]);
  const h = makeEngine({ m });
  h.run(1000);
  assert.deepEqual(h.w.chat, ["/x hunt once"]);
  const saved = h.engine.meta();
  h.engine.destroy();
  const h2 = makeEngine({ state: JSON.parse(JSON.stringify(h.state)) }); // session.metaState is JSON-able
  h2.clock.t = h.clock.t;
  h2.engine.replaceMeta(saved, { keepState: true });
  h2.run(2000);
  assert.equal(h2.engine.state, "hunt");
  assert.deepEqual(h2.w.chat, [], "fired flags survived; no re-arm on the rebind");
  // a page reload = fresh state ⇒ Default
  const h3 = makeEngine({ m });
  assert.equal(h3.engine.state, "Default");
});

await check("debug mode prints `[Meta] state | cond → act` per fired rule; setDebug persists in the state", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.chat("/x dbg"))]) });
  h.engine.setDebug(true);
  h.tick();
  assert.ok(h.w.prints.some((p) => p === "[Meta] Default | Always → Chat {/x dbg}"), h.w.prints.join(" / "));
  assert.equal(h.state.debug, true);
  assert.equal(h.engine.snapshot().debug, true);
});

await check("snapshot shape (MetaSnapshot) + lastFired; never throws", () => {
  const r1 = R("Default", C.always, A.set("b"));
  const h = makeEngine({ m: meta([r1, R("b", C.never, A.chat("x")), R("a", C.never, A.chat("y"))]) });
  h.tick();
  const s = h.engine.snapshot();
  for (const k of ["enabled", "running", "state", "secondsInState", "secondsInStateP", "stackDepth", "ruleCount", "stateCount", "states", "fired", "watchdog", "lastFired", "lastError", "debug"]) {
    assert.ok(k in s, `snapshot.${k}`);
  }
  assert.equal(s.enabled, true);
  assert.equal(s.running, true);
  assert.equal(s.ruleCount, 3);
  assert.equal(s.stateCount, 3);
  assert.deepEqual(s.states, ["Default", "b", "a"]);
  assert.deepEqual(s.lastFired, { ruleId: r1.id, state: "Default", cond: "Always", act: "SetState {b}", at: h.clock.t });
  const quiet = [];
  const broken = new MetaEngine({ ctx: { settings: { getValue: () => { throw new Error("x"); } } }, log: (m) => quiet.push(m) });
  assert.ok(quiet.some((m) => /values helpers/.test(m)) && quiet.some((m) => /getRegex not injected/.test(m)), "missing injections are logged");
  assert.equal(typeof broken.snapshot().state, "string");
});

await check("enabled getter/setter go through ctx.settings (EnableMeta); state names match case-insensitively", () => {
  const h = makeEngine({ m: meta([R("Hunting", C.always, A.chat("/x hunting"))]) });
  h.engine.enabled = false;
  assert.equal(h.w.settings.EnableMeta, false);
  assert.deepEqual(h.w.writes.at(-1), ["EnableMeta", false, "meta"]);
  h.engine.enabled = true;
  h.engine.enterState("hunting", "manual");
  assert.equal(h.engine.state, "Hunting", "canonical spelling of the rule state");
  h.tick();
  assert.deepEqual(h.w.chat, ["/x hunting"]);
  assert.equal(h.engine.enterState("  ", "manual"), false, "empty names ignored");
  assert.equal(h.engine.state, "Hunting");
});

await check("manual dropdown to a DIFFERENT state re-arms and resets the timer (fixes B11)", () => {
  const h = makeEngine({ m: meta([R("a", C.always, A.chat("/x a")), R("b", C.always, A.chat("/x b"))]) });
  h.engine.enterState("a", "manual");
  h.tick();
  h.engine.enterState("b", "manual");
  h.tick();
  h.engine.enterState("a", "manual");
  h.tick();
  assert.deepEqual(h.w.chat, ["/x a", "/x b", "/x a"]);
});

await check("destroy(): idempotent, views destroyed, vars force-flushed, tick is a no-op afterwards", () => {
  const h = makeEngine({ m: meta([R("Default", C.always, A.chat("/x go"))]) });
  const before = h.w.views.destroyAll;
  h.engine.destroy();
  h.engine.destroy();
  assert.equal(h.w.views.destroyAll, before + 1);
  assert.equal(h.expr.stats.flush.at(-1), "force");
  h.run(1000);
  assert.deepEqual(h.w.chat, []);
});

await check("unload(): no meta, back to Default, views destroyed; onMetaChange fires on load/replace/unload", () => {
  const seen = [];
  const h = makeEngine();
  h.engine.onMetaChange((m) => seen.push(m ? m.rules.length : null));
  h.engine.load(meta([R("x", C.always, A.chat("y"))]));
  h.engine.enterState("x", "manual");
  h.engine.replaceMeta(meta([]));
  h.engine.unload();
  assert.deepEqual(seen, [1, 0, null]);
  assert.equal(h.engine.meta(), null);
  assert.equal(h.engine.state, "Default");
});

await check("T-ME-EX: the G:296-319 death/runback meta runs to completion; no line reaches the game chat parser", () => {
  const m = meta([
    R("Default", C.death, A.set("dead")),
    R("dead", C.always, A.chat("/vt nav load runback")),
    R("dead", C.always, A.chat("/vt opt set enablebuffing true")),
    R("dead", C.always, A.chat("/vt opt set enablenav true")),
    R("dead", C.navEmpty, A.set("back")),
    R("back", C.always, A.chat("/vt nav load fighting")),
    R("back", C.always, A.chat("/vt opt set enablecombat true")),
    R("back", C.always, A.set("Default")),
  ]);
  const h = makeEngine({ m, worldOver: { settings: { EnableMeta: true, EnableNavigation: false, EnableBuffing: false, EnableCombat: false } } });
  h.run(1000);
  assert.equal(h.engine.state, "Default");
  // the character dies (kind 29, self)
  h.engine.pushEvent({ type: "death", self: true });
  h.tick(10);
  assert.equal(h.engine.state, "dead");
  h.tick(10);
  assert.deepEqual(h.w.chat, ["/vt nav load runback", "/vt opt set enablebuffing true", "/vt opt set enablenav true"]);
  assert.equal(h.w.nav.name, "runback");
  assert.equal(h.w.settings.EnableBuffing, true);
  assert.equal(h.w.settings.EnableNavigation, true);
  h.run(3000);
  assert.equal(h.engine.state, "dead", "the Once route is still running");
  h.w.nav.finished = true; // runback reached its end ⇒ Navroute Empty
  h.run(400);
  assert.equal(h.engine.state, "Default", "dead → back → Default");
  assert.equal(h.w.nav.name, "fighting");
  assert.equal(h.w.settings.EnableCombat, true);
  assert.deepEqual(h.w.invoked, [], "nothing reached InvokeChatParser / ACE");
  assert.ok(!h.w.prints.some((p) => /unknown \/vt/.test(p)));
  // a second death runs the whole cycle again (Default re-armed)
  h.engine.pushEvent({ type: "death" });
  h.tick(10);
  assert.equal(h.engine.state, "dead");
});

await check("one clock per tick: entries/watchdog stamped with the heartbeat's nowMs even when the injected clock lags", () => {
  // The injected clock is frozen at 0 while the heartbeat passes nowMs.
  const h = makeEngine({ m: meta([R("Default", C.secs(2), A.chat("/x two")), R("Default", C.always, A.wd(5, 3, "stuck"))]) });
  h.engine.now = () => 0;
  h.run(1000);
  assert.deepEqual(h.w.chat, [], "Seconds in State measured on the tick clock (not now − 0)");
  assert.ok(h.engine.snapshot().watchdog, "armed");
  h.run(1200);
  assert.deepEqual(h.w.chat, ["/x two"]);
  assert.equal(h.engine.state, "Default", "watchdog counts tick time, not a 1 s-per-tick clamp");
  h.run(1000);
  assert.equal(h.engine.state, "stuck");
  // outside a tick the injected clock is used again
  h.engine.enterState("Default", "manual");
  assert.equal(h.state.enteredAt, 0);
});

await check("a clock that steps back neither stalls passes nor mutes the logger", () => {
  const h = makeEngine({ m: meta([R("Default", C.expr("count[p]"), A.chat("/x never"))]) });
  h.run(1000);
  const k0 = h.expr.stats.counters.get("p");
  h.clock.t -= 3_600_000; // the system clock jumps an hour back
  h.run(1000);
  const n = h.expr.stats.counters.get("p") - k0;
  assert.ok(n >= 3, `passes continue after the step back (${n})`);
  const lines = [];
  const clk = { t: 50_000 };
  const log = M.makeMetaLog((m) => lines.push(m), () => clk.t);
  log("same");
  log("same");
  clk.t = 10_000;
  log("same");
  assert.equal(lines.length, 2, "rate-limited forward, printed again after the clock went back");
});

await check("a rule id \"__proto__\" is renumbered (its fired flag would never stick and it would re-fire every pass)", () => {
  const h = makeEngine({ m: meta([{ id: "__proto__", state: "Default", enabled: true, cond: C.always, act: A.chat("/x once") }]) });
  h.run(3000);
  assert.deepEqual(h.w.chat, ["/x once"]);
  const id = h.engine.meta().rules[0].id;
  assert.match(id, /^r\d+$/);
  assert.ok(normalizeMeta({ rules: [{ id: "__proto__", cond: C.always, act: A.chat("x") }] }).warnings.some((w) => /reserved/.test(w)));
});

await check("acceptance: imports stay inside rynth/vt/meta/; no timers, DOM, host casts or server chat in the package", () => {
  const files = readdirSync(META_DIR).filter((f) => f.endsWith(".js"));
  assert.deepEqual(files.sort(), ["actions.js", "conditions.js", "engine.js", "index.js", "meta_fns.js", "views.js"]);
  for (const f of files) {
    const src = readFileSync(path.join(META_DIR, f), "utf8");
    for (const m of src.matchAll(/^\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)) {
      assert.ok(/^\.\/[a-z_]+\.js$/.test(m[1]), `${f} imports ${m[1]}`);
    }
    assert.equal(/\bimport\s*\(/.test(src), false, `${f} has a dynamic import`);
    assert.equal(/setTimeout|setInterval|requestAnimationFrame/.test(src), false, `${f} uses a timer`);
    assert.equal(/CastSpell\(|CastUntargetedSpell\(|castTargetedSpell|castUntargetedSpell|WriteToChat\(/.test(src), false, `${f} names a host cast / server chat`);
    assert.equal(/\bdocument\b|\bwindow\b|innerHTML|DOMParser/.test(src), false, `${f} touches the DOM`);
  }
});

await check("host effects (setmotion keys) are released on the running→held edge, on portalIn and on destroy — never while running (I-3, V-12, review runtime-1)", () => {
  const h = makeEngine({ m: meta([R("Default", C.never, A.chat("/x"))]) });
  const reasons = [];
  h.expr.functions = { release: (why) => reasons.push(why) };
  h.run(1000);
  assert.deepEqual(reasons, [], "nothing released while running");
  h.tick(100, { running: false });
  assert.deepEqual(reasons, ["hold"], "the operator-hold edge");
  h.run(1000, 100, { running: false });
  assert.deepEqual(reasons, ["hold"], "once per edge");
  h.run(500);
  h.engine.pushEvent({ type: "portalIn" });
  assert.deepEqual(reasons, ["hold", "portal"]);
  h.engine.pushEvent({ type: "portalOut" });
  assert.equal(reasons.length, 2, "portalOut releases nothing");
  h.engine.destroy();
  assert.deepEqual(reasons, ["hold", "portal", "detach"]);
  h.engine.destroy();
  assert.equal(reasons.length, 3, "destroy is idempotent");
  // A runtime without a function registry (or without release) is fine.
  const bare = makeEngine({ m: meta([R("Default", C.never, A.chat("/x"))]) });
  bare.run(300);
  bare.tick(100, { running: false });
  bare.engine.pushEvent({ type: "portalIn" });
  bare.engine.destroy();
});

await check("integration (REAL createGrindBot + a real meta rule): a setmotion[] key is released by operator STOP within one heartbeat, refused while held and in portal space, released by bot.stop() (review runtime-1)", async () => {
  class FakeWorker {
    constructor() {
      this.onmessage = null;
    }
    postMessage() {}
    terminate() {}
  }
  if (typeof globalThis.Worker !== "function") globalThis.Worker = FakeWorker;
  if (typeof URL.createObjectURL !== "function") URL.createObjectURL = () => "blob:vt-meta-engine";
  if (typeof URL.revokeObjectURL !== "function") URL.revokeObjectURL = () => {};
  const realNow = Date.now;
  const realLog = console.log;
  const realWarn = console.warn;
  let NOW = 1_760_000_000_000;
  Date.now = () => NOW;
  console.log = () => {};
  console.warn = () => {};
  let bot = null;
  try {
    const { createGrindBot } = await import("../rynth/bot.js");
    const guid = 0x50000e01;
    const calls = [];
    const rec = (n) => (...a) => calls.push(`${n}(${a.join(",")})`);
    const session = {
      isPlayerReady: () => true,
      playerGuid: () => guid,
      getLocalPlayerPose: () => ({ landblockId: 0xa9b40015, x: 100, y: 100, z: 0, heading: 0, free() {} }),
      objectName: (g) => ((g >>> 0) === guid ? "Tester" : undefined),
      moveToPosition: rec("moveToPosition"),
      cancelPursuit: rec("cancelPursuit"),
      stopStick: rec("stopStick"),
      pursuitStatus: () => 0,
      sendChat: rec("sendChat"),
      sendTell: rec("sendTell"),
      nearbyEntityGuids: () => [],
      playerKnownSpells: () => [],
      setMovementInput: rec("setMovementInput"),
      turnToHeading: rec("turnToHeading"),
    };
    bot = await createGrindBot(session, { hz: 10, ai: false });
    const tick = (n = 1) => {
      for (let i = 0; i < n; i++) {
        NOW += 250;
        bot.host._tick();
      }
    };
    const smiSince = (k) => calls.slice(k).filter((c) => c.startsWith("setMovementInput"));
    tick(10);
    const L = bot.vt;
    assert.ok(L, "the VT layer is attached");
    const m = meta([
      R("Default", C.expr("getvar[go] == 1"), A.all(A.doExpr("setmotion[forward, 1] && setvar[go, 0]"), A.set("Push"))),
      R("Default", { t: "IntoPortal" }, A.doExpr("setmotion[forward, 1]")),
    ], { name: "mv" });
    assert.equal(L.library.importMeta("mv", JSON.stringify(m), "json").ok, true);
    assert.equal(L.library.loadMeta("mv").ok, true);
    L.options.set("EnableMeta", true, { source: "ui" });
    tick(4);
    let k = calls.length;
    L.vars.set("session", "go", 1);
    tick(4);
    assert.equal(L.meta.state, "Push");
    assert.deepEqual(smiSince(k), ["setMovementInput(1,0,0,true)"], "the meta pressed forward");
    k = calls.length;
    bot.control.stop({ persist: false, reason: "test" });
    tick(1);
    assert.deepEqual(smiSince(k), ["setMovementInput(0,0,0,false)"], "STOP lets go within one heartbeat");
    k = calls.length;
    assert.equal(Number(L.expr.evaluate("setmotion[forward, 1]")), 0, "pressing a key while held is refused");
    tick(20);
    assert.deepEqual(smiSince(k), [], "nothing pressed while held");
    bot.control.resume();
    tick(4);
    k = calls.length;
    globalThis.__isPortalSpaceActive = () => true;
    try {
      bot.host._dispatchEvent({ kind: 33, stringPayload: "", u32Payload: 1, u32Payload2: 0 });
      tick(4);
      assert.equal(smiSince(k).filter((c) => c.startsWith("setMovementInput(1")).length, 0, "the IntoPortal setmotion is refused in portal space");
    } finally {
      globalThis.__isPortalSpaceActive = undefined;
    }
    tick(2);
    assert.equal(Number(L.expr.evaluate("setmotion[forward, 1]")), 1);
    k = calls.length;
    bot.stop();
    assert.ok(smiSince(k).includes("setMovementInput(0,0,0,false)"), "bot.stop() (layer dispose) lets go");
    bot = null;
  } finally {
    if (bot) {
      try {
        bot.stop();
      } catch (_) {
        /* best effort */
      }
    }
    Date.now = realNow;
    console.log = realLog;
    console.warn = realWarn;
  }
});

console.log(fail === 0 ? `rynth_vt_meta_engine: all ${pass} checks passed` : `rynth_vt_meta_engine: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
