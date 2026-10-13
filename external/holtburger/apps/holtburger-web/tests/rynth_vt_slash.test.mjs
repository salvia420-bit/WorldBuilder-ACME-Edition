// tests/rynth_vt_slash.test.mjs — PLAN INT-3 (§5 app/slash_commands.js row,
// D13, K1, V-4, I-27..I-29): the `/rs` `/vt` `/ra` `/mt` `/ub` branch of the
// REAL routeSlashCommand (app/slash_commands.js initSlashCommands()).
//
//   • with window.__rynthVt installed, every RynthSuite line goes to its
//     route(handle, line) synchronously and answers { dispatched: true,
//     echo: null } — never handle.sendChat (nothing reaches ACE);
//   • with no layer installed the page entry (rynth/vt/rs_entry.js) is
//     imported lazily from location.href — the REAL module here — and the
//     line still runs; when it cannot be imported the line is dropped with a
//     local "[RynthSuite] command layer unavailable" SYSTEM line, never sent;
//   • host.InvokeChatParser (rynth/webhost.js) reaches the same branch;
//   • everything else routes exactly as before: `@rs x` goes to the server
//     verbatim, `/telepoi holtburg` → `@telepoi holtburg`, soul emotes, the
//     `/v` channel, `/rsx` (not a family verb) → `@rsx`;
//   • no static import was added (I-27).
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_slash.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");

// The page: window IS the global (so rynth/webhost.js InvokeChatParser and the
// slash router share window.__routeSlashCommand, as in the browser).
globalThis.window = globalThis;
const printed = [];
globalThis.__appendChatLine = (text, cat) => printed.push([String(text), cat]);
delete globalThis.location; // no page URL until a test sets one

const SC = await import("../app/slash_commands.js");
const { CHAT_CATEGORY } = await import("../app/chat_log.js");
const { initSlashCommands, normalizeChatLine, RS_PREFIX_SET, RS_UNAVAILABLE_TEXT, RETAIL_CLIENT_VERBS, CHANNEL_MAP, TURBINE_CMDS } = SC;
const { routeSlashCommand } = initSlashCommands();

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
const settle = async (ms = 0) => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, ms));
};
/** Wait (bounded) for a condition the lazy import makes true. */
async function until(fn, ms = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 5));
  }
  return true;
}

/** A SessionHandle that records EVERY member call (any of them = a leak). */
function recordingHandle(extra = {}) {
  const calls = [];
  const base = {
    playerGuid: () => 0x50000001,
    resolveSoulEmote: () => null,
    ...extra,
  };
  const h = new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      if (typeof k !== "string") return undefined;
      return (...args) => { calls.push([k, ...args]); };
    },
  });
  return { h, calls };
}
const FAMILY_LINES = ["/rs x", "/vt x", "/ra x", "/mt x", "/ub x", "/RS help", "/Vt opt get AttackDistance", "/rs", "/ub delay 500 /rs echo hi", "/rs mexec 1  +  2"];

// ── 1. an installed layer ───────────────────────────────────────────────────
await check("RS_PREFIX_SET is exactly the five family verbs and shadows no existing route", () => {
  assert.deepEqual([...RS_PREFIX_SET].sort(), ["mt", "ra", "rs", "ub", "vt"]);
  for (const v of RS_PREFIX_SET) {
    assert.equal(RETAIL_CLIENT_VERBS.has(v), false, `${v} is a retail client verb`);
    assert.equal(Object.prototype.hasOwnProperty.call(CHANNEL_MAP, v), false, `${v} is a channel verb`);
    assert.equal(Object.prototype.hasOwnProperty.call(TURBINE_CMDS, v), false, `${v} is a Turbine room`);
  }
});

await check("with window.__rynthVt: /rs /vt /ra /mt /ub → route(handle, line) synchronously; {dispatched:true, echo:null}; nothing sent", () => {
  const routed = [];
  globalThis.__rynthVt = { version: 1, route: (handle, line) => { routed.push([handle, line]); return { dispatched: true, echo: null }; }, dispatch: () => ({ handled: true, lines: [] }) };
  try {
    for (const line of FAMILY_LINES) {
      const { h, calls } = recordingHandle();
      const before = routed.length;
      const r = routeSlashCommand(h, line);
      assert.deepEqual(r, { dispatched: true, echo: null }, line);
      assert.equal(routed.length, before + 1, `${line}: routed synchronously`);
      assert.equal(routed[routed.length - 1][0], h, `${line}: the routed handle`);
      assert.equal(routed[routed.length - 1][1], line, `${line}: the line verbatim (spacing kept)`);
      assert.deepEqual(calls, [], `${line}: no SessionHandle call (never sendChat)`);
    }
    // retail trims a trailing comma off the verb: the layer gets a parsable line
    const { h, calls } = recordingHandle();
    assert.deepEqual(routeSlashCommand(h, "/rs, opt get MonsterRange"), { dispatched: true, echo: null });
    assert.equal(routed[routed.length - 1][1], "/rs opt get MonsterRange");
    assert.deepEqual(calls, []);
    assert.deepEqual(printed, [], "the router itself prints nothing (the layer prints its own lines)");
  } finally {
    delete globalThis.__rynthVt;
  }
});

await check("a throwing layer route is contained: still dispatched, one local error line, nothing sent", () => {
  globalThis.__rynthVt = { version: 1, route: () => { throw new Error("boom"); }, dispatch: () => null };
  printed.length = 0;
  try {
    const { h, calls } = recordingHandle();
    assert.deepEqual(routeSlashCommand(h, "/rs help"), { dispatched: true, echo: null });
    assert.deepEqual(calls, []);
    assert.deepEqual(printed, [["[RynthSuite] command failed: boom", 10]]);
  } finally {
    delete globalThis.__rynthVt;
    printed.length = 0;
  }
});

// ── 2. no layer, no importable entry ────────────────────────────────────────
await check("no layer and no page URL: the unavailable SYSTEM line, synchronously; nothing sent", async () => {
  printed.length = 0;
  for (const line of ["/rs help", "/mt cast 2"]) {
    const { h, calls } = recordingHandle();
    assert.deepEqual(routeSlashCommand(h, line), { dispatched: true, echo: null }, line);
    assert.deepEqual(calls, [], line);
  }
  assert.deepEqual(printed, [[RS_UNAVAILABLE_TEXT, CHAT_CATEGORY.SYSTEM], [RS_UNAVAILABLE_TEXT, CHAT_CATEGORY.SYSTEM]]);
  await settle();
  assert.equal(printed.length, 2, "no late lines");
  printed.length = 0;
});

await check("no layer and the entry module cannot be imported: dispatched at once, then the unavailable line; a later line retries", async () => {
  printed.length = 0;
  // A page URL whose rynth/vt/rs_entry.js does not exist (inside the app tree).
  globalThis.location = { href: pathToFileURL(path.join(APP, "rynth/testdata/vt/__no_page__/index.html")).href, search: "" };
  try {
    const { h, calls } = recordingHandle();
    assert.deepEqual(routeSlashCommand(h, "/vt opt list"), { dispatched: true, echo: null });
    assert.deepEqual(calls, []);
    assert.ok(await until(() => printed.length >= 1), "the unavailable line arrives");
    assert.deepEqual(printed, [[RS_UNAVAILABLE_TEXT, CHAT_CATEGORY.SYSTEM]]);
    assert.equal(globalThis.__rynthVt, undefined, "nothing installed");
    printed.length = 0;
    const second = recordingHandle();
    assert.deepEqual(routeSlashCommand(second.h, "/ra help"), { dispatched: true, echo: null });
    assert.ok(await until(() => printed.length >= 1), "the retry reports too");
    assert.deepEqual(printed, [[RS_UNAVAILABLE_TEXT, CHAT_CATEGORY.SYSTEM]]);
    assert.deepEqual(second.calls, []);
  } finally {
    delete globalThis.location;
    printed.length = 0;
  }
});

// ── 3. the REAL lazy path ───────────────────────────────────────────────────
await check("no layer yet: /rs imports the REAL rynth/vt/rs_entry.js from location.href, installs window.__rynthVt and runs the line", async () => {
  printed.length = 0;
  globalThis.location = { href: pathToFileURL(path.join(APP, "index.html")).href, search: "" };
  const { h, calls } = recordingHandle();
  assert.deepEqual(routeSlashCommand(h, "/rs help"), { dispatched: true, echo: null });
  assert.ok(await until(() => globalThis.__rynthVt && printed.length > 3), "installed + help printed");
  assert.equal(globalThis.__rynthVt.version, 1);
  assert.equal(typeof globalThis.__rynthVt.route, "function");
  assert.match(printed[0][0], /^\[RynthSuite\] \/rs/);
  assert.ok(printed.some(([t]) => /\/rs opt list/.test(t)), "the verb list");
  assert.deepEqual(calls, [], "help never touches the session");
  printed.length = 0;
  // Installed now: the next lines run synchronously through it.
  const r2 = recordingHandle();
  assert.deepEqual(routeSlashCommand(r2.h, "/vt opt get AttackDistance"), { dispatched: true, echo: null });
  assert.deepEqual(printed, [["[RynthSuite] AttackDistance = 0.1666667", 0]], "40 m in VTank lbf (÷240), synchronously");
  printed.length = 0;
  assert.deepEqual(routeSlashCommand(r2.h, "/RS opt set AttackDistance 0.0833"), { dispatched: true, echo: null });
  assert.deepEqual(printed, [["[RynthSuite] Set option AttackDistance = 0.0833", 0]]);
  printed.length = 0;
  assert.deepEqual(routeSlashCommand(r2.h, "/rs opt get MonsterRange"), { dispatched: true, echo: null });
  assert.deepEqual(printed, [["[RynthSuite] MonsterRange = 19.992", 0]], "0.0833 lbf × 240 m, the page session (no bot)");
  printed.length = 0;
  assert.deepEqual(routeSlashCommand(r2.h, "/mt foo"), { dispatched: true, echo: null });
  assert.deepEqual(printed, [["[RynthSuite] unknown /mt command 'foo'", 10]], "an unknown compat verb is a LOCAL error, never @mt");
  assert.deepEqual(r2.calls, [], "nothing reached the session (V-4)");
  printed.length = 0;
});

await check("host.InvokeChatParser (rynth/webhost.js) takes the same branch: a /rs line is handled locally, never sent", async () => {
  const { RynthWebHost } = await import("../rynth/webhost.js");
  const sent = [];
  const host = new RynthWebHost({ sendChat: (t) => sent.push(t), playerGuid: () => 0x50000001 }, { entityMap: new Map(), noEventTap: true });
  printed.length = 0;
  try {
    assert.equal(globalThis.__routeSlashCommand, routeSlashCommand, "the page's router");
    assert.equal(host.InvokeChatParser("/rs echo hello from a meta"), true);
    assert.deepEqual(printed, [["hello from a meta", 0]], "/rs echo is a local echo");
    assert.equal(host.InvokeChatParser("/ub opt get AttackDistance"), true);
    assert.deepEqual(printed[1], ["[RynthSuite] AttackDistance = 0.0833", 0]);
    assert.deepEqual(sent, [], "nothing went to sendChat");
    // a non-family line still reaches the server through the same router
    assert.equal(host.InvokeChatParser("/telepoi holtburg"), true);
    assert.deepEqual(sent, ["@telepoi holtburg"]);
  } finally {
    printed.length = 0;
  }
});

// ── 4. everything else is unchanged (I-29) ──────────────────────────────────
await check("@rs / @vt are server lines: not routed, sent verbatim by the caller (dispatched:false)", () => {
  for (const line of ["@rs help", "@vt opt get AttackDistance", "@mt cast 2", "@ub jump"]) {
    assert.deepEqual(normalizeChatLine(line), { kind: "server", line }, line);
    const { h, calls } = recordingHandle();
    assert.deepEqual(routeSlashCommand(h, line), { dispatched: false }, line);
    assert.deepEqual(calls, [], line);
  }
  assert.deepEqual(printed, []);
});

await check("unknown non-family slash verbs still go to the server as @cmd (incl. look-alikes /rsx /vtank)", () => {
  for (const [line, wire] of [["/telepoi holtburg", "@telepoi holtburg"], ["/rsx foo", "@rsx foo"], ["/vtank", "@vtank"], ["/myquests", "@myquests"]]) {
    const { h, calls } = recordingHandle();
    const r = routeSlashCommand(h, line);
    assert.deepEqual(calls, [["sendChat", wire]], line);
    assert.equal(r.echo, `> ${wire}`, line);
  }
});

await check("tells, channels and soul emotes are unchanged (/v is vassals, /t carries /rs as text)", () => {
  let x = recordingHandle();
  routeSlashCommand(x.h, "/v hi");
  assert.deepEqual(x.calls, [["sendChannel", 0x1000, "hi"]]);
  x = recordingHandle();
  routeSlashCommand(x.h, "/t Bob, /rs help");
  assert.deepEqual(x.calls, [["sendTell", "Bob", "/rs help"]]);
  const WAVE = { pose: "Wave", motionFull: 0x13000087, myEmote: "wave.", otherEmote: "waves.", held: false };
  x = recordingHandle({ resolveSoulEmote: (t) => (String(t).toLowerCase() === "wave" ? WAVE : null) });
  const r = routeSlashCommand(x.h, "/wave");
  assert.equal(r.echo, "You wave.");
  assert.equal(r.category, CHAT_CATEGORY.EMOTE);
  assert.deepEqual(x.calls, [["sendSoulEmote", "waves."], ["broadcastEmoteMotion", 0x13000087]]);
});

await check("I-27: app/slash_commands.js gained no static import (the entry is a location.href dynamic import)", () => {
  const src = readFileSync(path.join(APP, "app/slash_commands.js"), "utf8");
  const statics = [...src.matchAll(/^import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
  assert.deepEqual(statics, ["./chat_log.js", "./social_commands.js"]);
  assert.equal(/from\s+["'][^"']*rynth\/vt/.test(src), false);
  assert.match(src, /new URL\(RS_ENTRY_PATH, window\.location\.href\)/);
});

console.log(fail === 0 ? `rynth_vt_slash: all ${pass} checks passed` : `rynth_vt_slash: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
