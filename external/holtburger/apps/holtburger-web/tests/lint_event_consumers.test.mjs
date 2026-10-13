// tests/lint_event_consumers.test.mjs — test-tooling-6 (2026-10-13).
//
// Pins scripts/lint-event-consumers.mjs, the last-mile check between the
// plugin bus and its consumers: an event emitted with no subscriber must be
// an EXTENSION_POINT (public plugin API) or a KNOWN_GAP (retail consumes it,
// we do not yet), both lists shrink-only; and a bus handler must read its
// payload from `ev.detail` (plugins/api.js events.emit dispatches
// `new CustomEvent(name, { detail: payload })`).
//
// Synthetic sources go through the exported scan(); the last two cases run
// the real tree, in-process and through the CLI exactly as CI does.
//
// Run: node tests/lint_event_consumers.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  scan, maskJs, htmlScripts, collectSources,
  EXTENSION_POINTS, KNOWN_GAPS, DETAIL_KNOWN_BUGS,
} from "../../../scripts/lint-event-consumers.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LINT = path.resolve(APP, "../../scripts/lint-event-consumers.mjs");
const CLEAN = { extensionPoints: {}, knownGaps: {}, detailKnownBugs: {} };

const run = (files, opts = CLEAN) =>
  scan(Object.entries(files).map(([file, text]) => ({ file, text })), opts);
const kinds = (r) => r.findings.map((f) => `${f.kind} ${f.name}`).sort();

test("an emit with no subscriber is flagged NO-CONSUMER", () => {
  const r = run({ "app/a.js": `window.__pluginClient?.events?.emit?.("ghostEvent", { a: 1 });` });
  assert.deepEqual(kinds(r), ["NO-CONSUMER ghostEvent"]);
  assert.match(r.findings[0].where, /^app\/a\.js:1$/);
});

test("an emit plus an .on( subscriber is clean", () => {
  const r = run({
    "app/a.js": `window.__pluginClient.events.emit("fooUpdated", {});`,
    "plugins/p.js": `client.events.on("fooUpdated", () => refresh());`,
  });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.subscribed.get("fooUpdated"), ["plugins/p.js:1"]);
});

test("an emit plus bus.addEventListener( (and .on?.( / .once( / onBus() is clean", () => {
  for (const sub of [
    `bus.addEventListener("fooUpdated", (ev) => use(ev.detail));`,
    `client?.events?.on?.("fooUpdated", h);`,
    `client.events.once("fooUpdated", h);`,
    `onBus("fooUpdated", h);`,
  ]) {
    const r = run({ "app/a.js": `bus.emit("fooUpdated", {});`, "plugins/p.js": sub });
    assert.deepEqual(r.findings, [], sub);
  }
});

test("an allowlisted name passes (EXTENSION_POINTS and KNOWN_GAPS)", () => {
  const files = {
    "app/a.js": `events.emit("hoverThing", {}); events.emit("retailOnly", {});`,
  };
  const r = run(files, {
    extensionPoints: { hoverThing: "plugin API" },
    knownGaps: { retailOnly: ["acclient.c Foo::Handle_Bar"] },
    detailKnownBugs: {},
  });
  assert.deepEqual(r.findings, []);
  assert.deepEqual(
    r.allowlisted.map((a) => `${a.list} ${a.name}`).sort(),
    ["EXTENSION_POINTS hoverThing", "KNOWN_GAPS retailOnly"],
  );
});

test("an allowlisted name that gained a subscriber (or stopped being emitted) is STALE", () => {
  const opts = {
    extensionPoints: { hoverThing: "plugin API", goneEvent: "renamed away" },
    knownGaps: { retailOnly: ["acclient.c Foo::Handle_Bar"] },
    detailKnownBugs: {},
  };
  const r = run({
    "app/a.js": `events.emit("hoverThing", {}); events.emit("retailOnly", {});`,
    "plugins/p.js": `client.events.on("retailOnly", () => render());`,
  }, opts);
  assert.deepEqual(kinds(r), ["STALE-ALLOWLIST goneEvent", "STALE-ALLOWLIST retailOnly"]);
  assert.match(r.findings.find((f) => f.name === "retailOnly").detail, /KNOWN_GAPS entry now has a subscriber/);
  assert.match(r.findings.find((f) => f.name === "goneEvent").detail, /no longer emitted/);
});

test("a .on handler reading p.guid without .detail is flagged DETAIL-UNREAD", () => {
  const emit = `events.emit("selected", { guid: 1 });`;
  for (const [label, sub] of [
    ["inline arrow", `client.events.on("selected", (p) => { pick(p.guid); });`],
    ["expression arrow", `client.events.on("selected", p => pick(p?.guid));`],
    ["destructured", `client.events.on("selected", ({ guid }) => pick(guid));`],
    ["function expr", `client.events.on("selected", function (p) { return p.guid; });`],
    ["named fn", `function onSel(p) { pick(p.guid); }\nclient.events.on("selected", onSel);`],
    ["const arrow", `const onSel = async (p) => pick(p.guid);\nclient.events.on("selected", onSel);`],
    ["late assignment", `let onSel = null;\nonSel = (p) => pick(p.guid);\nclient.events.on("selected", onSel);`],
    ["alias hop", `function real(p) { pick(p.guid); }\nlet onSel = null;\nonSel = real;\nclient.events.on("selected", onSel);`],
  ]) {
    const r = run({ "app/a.js": emit, "plugins/p.js": sub });
    assert.deepEqual(kinds(r), ["DETAIL-UNREAD selected"], label);
    assert.match(r.findings[0].detail, /\.guid/, label);
  }
});

test("handlers that read .detail, ignore the payload, or touch only Event members are clean", () => {
  const emit = `events.emit("selected", { guid: 1 });`;
  for (const sub of [
    `client.events.on("selected", (ev) => pick(ev.detail.guid));`,
    `client.events.on("selected", (ev) => { const d = ev?.detail ?? ev; pick(d.guid); });`,
    `client.events.on("selected", ({ detail }) => pick(detail.guid));`,
    `client.events.on("selected", () => refresh());`,
    `client.events.on("selected", (ev) => { if (ev.type === "selected") ev.stopPropagation(); });`,
    `client.events.on("selected", (ev) => forward(ev));`,
    `const h = makeHandler(1);\nclient.events.on("selected", h);`,
  ]) {
    const r = run({ "app/a.js": emit, "plugins/p.js": sub });
    assert.deepEqual(r.findings, [], sub);
  }
});

test("DOM listeners are not checked; a dynamically-emitted name on a bus receiver is", () => {
  const r = run({
    "ui/u.js": `el.addEventListener("click", (e) => go(e.clientX));`,
    "plugins/p.js": `client.events.on("damageDealt", (d) => latch(d.defenderName));`,
  });
  assert.deepEqual(kinds(r), ["DETAIL-UNREAD damageDealt"]);
});

test("comments, strings and other buses do not count as plugin-bus traffic", () => {
  const r = run({
    "app/a.js": [
      `// events.emit("ghostA", {});`,
      `/* bus.emit("ghostB", {}); bus.on("realEvent", h); */`,
      `const s = 'events.emit("ghostC")';`,
      `const re = /emit\\("ghostD"/;`,
      `events.emit("realEvent", {});`,
      // EatableBus: payload spread INTO the event, so `ev.text` is right.
      `window.__chatHooks?.incoming?.emit("chatIncoming", { text });`,
      `comp.emit({ config: cfg });`,
    ].join("\n"),
    "plugins/p.js": `hooks.incoming.on("chatIncoming", (ev) => log(ev.text));`,
  });
  assert.deepEqual([...r.emitted.keys()], ["realEvent"]);
  assert.deepEqual(kinds(r), ["NO-CONSUMER realEvent"]);
});

test("a ternary of two literals emits both names", () => {
  const r = run({
    "app/a.js": `bus?.emit?.(rec.kind === "vital" ? "raiseVitalFailed" : "raiseAttributeFailed", {});`,
  });
  assert.deepEqual(kinds(r), ["NO-CONSUMER raiseAttributeFailed", "NO-CONSUMER raiseVitalFailed"]);
});

test("the [name, fn] tuple loop above a dynamic .on(name, fn) counts as subscribing", () => {
  const r = run({
    "app/a.js": `events.emit("kind:47", e); events.emit("kind:49", e);`,
    "plugins/inv.js": [
      `const evs = [`,
      `  ["kind:47", onWield],`,
      `  ["kind:49", onWield],`,
      `];`,
      `for (const [name, fn] of evs) {`,
      `  client.events.on(name, fn);`,
      `}`,
    ].join("\n"),
  });
  assert.deepEqual(r.findings, []);
  assert.match(r.subscribed.get("kind:47")[0], /plugins\/inv\.js:2 \(tuple\)/);
});

test("index.html: only inline <script> bodies are scanned, line numbers kept", () => {
  const html = [
    `<!doctype html>`,
    `<p>events.emit("markupText", {})</p>`,
    `<script type="importmap">{"imports": {"emit(\\"importmap\\")": "./x.js"}}</script>`,
    `<script type="module">`,
    `  pluginClient.events.emit("fromModule", {});`,
    `</script>`,
  ].join("\n");
  const blanked = htmlScripts(html);
  assert.equal(blanked.length, html.length);
  const r = run({ "index.html": html });
  assert.deepEqual([...r.emitted.keys()], ["fromModule"]);
  assert.deepEqual(r.emitted.get("fromModule"), ["index.html:5"]);
});

test("DETAIL_KNOWN_BUGS suppresses its finding, and goes STALE once fixed", () => {
  const opts = { extensionPoints: {}, knownGaps: {}, detailKnownBugs: { "plugins/p.js:selected": "open bug" } };
  const emit = `events.emit("selected", {});`;
  const buggy = run({ "app/a.js": emit, "plugins/p.js": `client.events.on("selected", (p) => pick(p.guid));` }, opts);
  assert.deepEqual(buggy.findings, []);
  assert.deepEqual(buggy.knownBugs, ["plugins/p.js:selected"]);
  const fixed = run({ "app/a.js": emit, "plugins/p.js": `client.events.on("selected", (p) => pick(p.detail.guid));` }, opts);
  assert.deepEqual(kinds(fixed), ["STALE-ALLOWLIST plugins/p.js:selected"]);
});

test("maskJs keeps offsets and newlines and is not derailed by quotes in regexes", () => {
  const src = [
    `const a = /["'\`]/g.test(x); // it's a comment`,
    `const b = n / 2 / 3; const t = \`\${a ? "}" : '{'} tail\`;`,
    `events.emit("afterTricky", {});`,
  ].join("\n");
  const { code, skel } = maskJs(src);
  assert.equal(code.length, src.length);
  assert.equal(skel.length, src.length);
  assert.equal(code.split("\n").length, 3);
  assert.doesNotMatch(code, /it's a comment/);
  const r = run({ "app/a.js": src });
  assert.deepEqual(r.emitted.get("afterTricky"), ["app/a.js:3"]);
});

test("the real tree is clean with the shipped lists (in-process scan)", () => {
  const r = scan(collectSources(APP));
  assert.deepEqual(r.findings, [], r.findings.map((f) => `${f.kind} ${f.name} ${f.where}`).join("\n"));
  // The backlog the lint was written to expose is still exactly what it says.
  const gaps = r.allowlisted.filter((a) => a.list === "KNOWN_GAPS").map((a) => a.name).sort();
  assert.deepEqual(gaps, Object.keys(KNOWN_GAPS).sort());
  assert.ok(gaps.includes("allegianceInfo") && gaps.includes("uiEvent"));
  assert.equal(
    r.allowlisted.filter((a) => a.list === "EXTENSION_POINTS").length,
    Object.keys(EXTENSION_POINTS).length,
  );
  assert.deepEqual(r.knownBugs.sort(), Object.keys(DETAIL_KNOWN_BUGS).sort());
  // Sanity: the sweep really sees the bus (not a vacuous pass).
  assert.ok(r.emitted.size >= 40, `only ${r.emitted.size} emitted names found`);
  assert.ok(r.subscribed.has("playerStatsUpdated"));
  assert.ok(r.handlers.parsed >= 100, `only ${r.handlers.parsed} handlers parsed`);
});

test("the CLI exits 0 on the real tree (the CI step)", () => {
  const res = spawnSync(process.execPath, [LINT], { cwd: APP, encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /^lint-event-consumers: \d+ files, \d+ emitted bus names/);
  assert.match(res.stdout, /0 finding\(s\)/);
});
