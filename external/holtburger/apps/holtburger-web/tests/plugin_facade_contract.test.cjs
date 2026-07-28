#!/usr/bin/env node
// plugin_facade_contract.test.cjs — P6.1 / CORE-07 anti-drift guard for the
// ONE versioned `client` facade contract. Pure node: no browser, no wasm, no
// network (the live half is the in-world smoke; this pins the parts that can
// rot silently in a text editor).
//
// What it guards, and why each one can rot:
//
//  [A] Manifest capability declarations vs the host's capability table.
//      48 shipped manifests now declare `capabilities`; the loader SKIPS a
//      plugin whose required capability is absent. Rename or drop a
//      CAPABILITY_CANDIDATES key and the plugin tree silently loses members
//      at boot with only a console warn. Every declared name must exist.
//
//  [B] `clientApi` ranges vs plugins/api.js API_VERSION. A major bump with
//      un-swept manifests would skip the whole tree.
//
//  [C] The loader gates' "cannot tell ⇒ permissive" rule. The loader runs
//      BEFORE a session exists; if a null capability set ever started
//      reading as "nothing is available", every capability-declaring plugin
//      would be skipped at boot.
//
//  [D] Eatable-bus semantics behind both chat hooks: subscription order,
//      first-eat-wins short-circuit, a throwing handler not killing the bus.
//
// Run: node tests/plugin_facade_contract.test.cjs   (exits 1 on any FAIL)

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const APP = path.join(__dirname, "..");
const PLUGINS = path.join(APP, "plugins");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

async function main() {
  const loader = await import(pathToFileURL(path.join(PLUGINS, "loader.js")).href);
  const webhost = await import(pathToFileURL(path.join(PLUGINS, "webhost.js")).href);
  const api = await import(pathToFileURL(path.join(PLUGINS, "api.js")).href);

  const known = new Set([...webhost.CAPABILITY_NAMES, ...webhost.ENV_CAPABILITY_NAMES]);
  check("webhost exports a non-trivial capability set", known.size > 80, `size=${known.size}`);
  check("plugins/webhost.js re-exports RynthWebHost", typeof webhost.RynthWebHost === "function");
  check("api exports API_VERSION", typeof api.API_VERSION === "string" && /^\d+\.\d+\.\d+$/.test(api.API_VERSION),
    String(api.API_VERSION));

  // ── [A] + [B] every shipped manifest's declarations are satisfiable ──
  const files = fs.readdirSync(PLUGINS).filter((f) => f.endsWith(".manifest.json")).sort();
  check("manifest set is non-empty", files.length > 40, `count=${files.length}`);
  const badCaps = [];
  const badApi = [];
  let declaring = 0;
  for (const f of files) {
    const m = JSON.parse(fs.readFileSync(path.join(PLUGINS, f), "utf8"));
    const { valid, errors } = loader.validateManifest(m);
    if (!valid) { badCaps.push(`${f}: invalid — ${errors.join("; ")}`); continue; }
    if (Array.isArray(m.capabilities) && m.capabilities.length) {
      declaring++;
      for (const raw of m.capabilities) {
        const parsed = loader.parseCapability(raw);
        if (!parsed) { badCaps.push(`${f}: unparseable ${JSON.stringify(raw)}`); continue; }
        if (!known.has(parsed.name)) badCaps.push(`${f}: unknown capability ${parsed.name}`);
      }
    }
    if (m.clientApi && !loader.clientApiSatisfied(m, api.API_VERSION)) {
      badApi.push(`${f}: clientApi ${m.clientApi} excludes ${api.API_VERSION}`);
    }
  }
  check("some manifests actually declare capabilities", declaring > 10, `declaring=${declaring}`);
  check("every declared capability exists in the host table", badCaps.length === 0, badCaps.slice(0, 6).join(" | "));
  check("every declared clientApi range admits API_VERSION", badApi.length === 0, badApi.slice(0, 6).join(" | "));

  // ── [C] gate semantics ───────────────────────────────────────────────
  const needy = { id: "x", name: "X", version: "1.0.0", capabilities: ["CastSpell", "NoSuchCap", "AlsoMissing?"] };
  check("missingCapabilities reports only REQUIRED misses",
    JSON.stringify(loader.missingCapabilities(needy, ["CastSpell"])) === JSON.stringify(["NoSuchCap"]),
    JSON.stringify(loader.missingCapabilities(needy, ["CastSpell"])));
  check("missingCapabilities: unknown host set ⇒ permissive (never a mass-skip)",
    loader.missingCapabilities(needy, null).length === 0);
  check("missingCapabilities: no declaration ⇒ nothing missing",
    loader.missingCapabilities({ id: "y" }, []).length === 0);
  check("clientApiSatisfied: no range ⇒ true", loader.clientApiSatisfied({ id: "y" }, "9.9.9") === true);
  check("clientApiSatisfied: unknown version ⇒ true", loader.clientApiSatisfied({ clientApi: "^1.0" }, null) === true);
  check("clientApiSatisfied: caret matches same major", loader.clientApiSatisfied({ clientApi: "^1.0" }, "1.4.2") === true);
  check("clientApiSatisfied: caret rejects other major", loader.clientApiSatisfied({ clientApi: "^1.0" }, "2.0.0") === false);
  check("validateManifest rejects a malformed capability",
    loader.validateManifest({ id: "a", name: "A", version: "1.0.0", capabilities: ["bad name!"] }).valid === false);
  check("validateManifest rejects an empty clientApi",
    loader.validateManifest({ id: "a", name: "A", version: "1.0.0", clientApi: "" }).valid === false);

  // loadPlugins end-to-end: one gated out, one optional-tolerant, one clean.
  const entries = [
    { manifest: { id: "needs-missing", name: "N", version: "1.0.0", capabilities: ["Nope"] }, module: {} },
    { manifest: { id: "needs-optional", name: "O", version: "1.0.0", capabilities: ["Nope?"] }, module: {} },
    { manifest: { id: "old-api", name: "P", version: "1.0.0", clientApi: "^0.9" }, module: {} },
    { manifest: { id: "clean", name: "C", version: "1.0.0", capabilities: ["CastSpell"], clientApi: "^1.0" }, module: {} },
  ];
  const res = await loader.loadPlugins({
    entries, apiVersion: "1.0.0", capabilities: ["CastSpell"], log: () => {},
  });
  check("loadPlugins skips a missing REQUIRED capability", !res.loaded.has("needs-missing"));
  check("loadPlugins tolerates a missing OPTIONAL capability", res.loaded.has("needs-optional"));
  check("loadPlugins skips a clientApi major mismatch", !res.loaded.has("old-api"));
  check("loadPlugins loads a satisfied plugin", res.loaded.has("clean"));
  check("skip reasons name the cause",
    res.skipped.some((s) => s.id === "needs-missing" && /missing required capabilities: Nope/.test(s.reason)) &&
    res.skipped.some((s) => s.id === "old-api" && /clientApi mismatch/.test(s.reason)),
    JSON.stringify(res.skipped));
  const inert = await loader.loadPlugins({ entries, log: () => {} });
  check("both gates inert when the host half is not supplied", inert.loaded.size === 4, `size=${inert.loaded.size}`);

  // ── [D] eatable-bus semantics (both chat hooks ride this) ────────────
  const bus = loader.createEatableBus();
  const order = [];
  bus.on("e", () => order.push(1));
  bus.on("e", (ev) => { order.push(2); ev.eat(); });
  bus.on("e", () => order.push(3));
  const ev = bus.emit("e", { text: "hi" });
  check("handlers run in subscription order", JSON.stringify(order) === "[1,2]", JSON.stringify(order));
  check("first eat short-circuits the rest", ev.eaten === true);
  check("payload is spread onto the event", ev.text === "hi");
  const bus2 = loader.createEatableBus();
  const seen = [];
  bus2.on("e", () => { throw new Error("boom"); });
  bus2.on("e", () => seen.push("after"));
  const ev2 = bus2.emit("e", {});
  check("a throwing handler does not kill the bus", seen.length === 1 && ev2.eaten === false);
  check("emit with no handlers reports not-eaten", loader.createEatableBus().emit("nobody", {}).eaten === false);

  // Chat hooks are wired to that bus and expose both retail hook names.
  const hooks = await import(pathToFileURL(path.join(PLUGINS, "chat-hooks.js")).href);
  check("chat-hooks exposes both eatable buses",
    !!hooks.chatHooks.incoming?.on && !!hooks.chatHooks.outgoing?.on);
  let inboundSeen = null;
  const off = hooks.onIncoming((e) => { inboundSeen = e; e.eat(); });
  const r = hooks.emitIncoming("line", 3, 5);
  off();
  check("emitIncoming reaches onIncoming with the frozen v1 shape",
    inboundSeen && inboundSeen.text === "line" && inboundSeen.chatType === 3 && inboundSeen.category === 5,
    JSON.stringify(inboundSeen));
  check("an eaten inbound line reports eaten to the caller", r.eaten === true);
  let outboundSeen = null;
  const off2 = hooks.onOutgoing((e) => { outboundSeen = e.text; });
  hooks.emitOutgoing("say something");
  off2();
  check("emitOutgoing reaches onOutgoing", outboundSeen === "say something", String(outboundSeen));
  check("unsubscribe actually unsubscribes",
    hooks.emitIncoming("after-off", 0, 0).eaten === false);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
