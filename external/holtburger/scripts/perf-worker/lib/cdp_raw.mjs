// lib/cdp_raw.mjs — the 1070 drivers' fallback when Playwright cannot attach (2026-10-29).
//
// On the box's Chrome 156, playwright-core 1.59.1's connectOverCDP hangs on a browser that has been
// up a while: Chrome then lists `browser_ui` targets (chrome://omnibox-popup.top-chrome/…) next to
// the game page and Playwright tries to attach to every target. The page itself answers CDP at once.
// These helpers talk to ONE target over its own WebSocket (Playwright's bundled `ws`, so node 20 needs
// no flag): no attach to anything else, no focus emulation, never closes or navigates the page.
//
//   const { browser, ctx, pg } = await rawSession(CDP);   // same surface hbsess.mjs uses:
//   await pg.evaluate(fnOrExpression, arg)               //   Runtime.evaluate, awaitPromise, by value
//   const cdp = await ctx.newCDPSession(pg); await cdp.send("Profiler.start")
//   await rawTrace(CDP, outPath, categories, async () => { ... })   // browser-wide Tracing to a file
import { createRequire } from "node:module";
import { createWriteStream } from "node:fs";

const require = createRequire(import.meta.url);
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core";
const { ws: WS } = require(`${PLAYWRIGHT_CORE}/lib/utilsBundle.js`);

/** One CDP connection over a target's WebSocket URL: `send`, `on(event, fn)`, `close`. */
export async function cdpConnect(wsUrl, { openTimeoutMs = 15000 } = {}) {
  const sock = new WS(wsUrl, { perMessageDeflate: false, maxPayload: 1 << 30 });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`cdp_raw: open timeout ${wsUrl}`)), openTimeoutMs);
    sock.once("open", () => { clearTimeout(t); res(); });
    sock.once("error", (e) => { clearTimeout(t); rej(e); });
  });
  let id = 0;
  const pending = new Map(), listeners = new Map();
  sock.on("message", (data) => {
    const m = JSON.parse(String(data));
    if (m.id !== undefined && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(`${m.error.message}${m.error.data ? ": " + m.error.data : ""}`)); else res(m.result);
    } else if (m.method) for (const fn of listeners.get(m.method) || []) fn(m.params);
  });
  sock.on("close", () => { for (const { rej } of pending.values()) rej(new Error("cdp_raw: socket closed")); pending.clear(); });
  return {
    send(method, params = {}) {
      return new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); sock.send(JSON.stringify({ id: i, method, params })); });
    },
    on(method, fn) { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
    close() { try { sock.close(); } catch (_) { /* gone */ } },
  };
}

/** The game page target (url contains `holtburger-web`). */
export async function findPageTarget(cdpHttp) {
  const list = await (await fetch(`${cdpHttp}/json/list`)).json();
  const t = list.find((p) => p.type === "page" && p.url.includes("holtburger-web"));
  if (!t) throw new Error(`cdp_raw: no holtburger-web page at ${cdpHttp}`);
  return t;
}

/** A Playwright-shaped `{ browser, ctx, pg }` over the page target alone (see the header). */
export async function rawSession(cdpHttp) {
  const target = await findPageTarget(cdpHttp);
  const c = await cdpConnect(target.webSocketDebuggerUrl);
  const evaluate = async (fn, arg) => {
    const expression = typeof fn === "function" ? `(${fn.toString()})(${arg === undefined ? "" : JSON.stringify(arg)})` : String(fn);
    const r = await c.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(`page exception: ${d.exception?.description || d.text || JSON.stringify(d).slice(0, 500)}`);
    }
    return r.result?.value;
  };
  const pg = { evaluate, url: () => target.url, isRaw: true };
  const ctx = { newCDPSession: async () => ({ send: (m, p) => c.send(m, p), on: (m, fn) => c.on(m, fn), detach: async () => {} }) };
  const browser = { close: async () => c.close(), isRaw: true };
  return { browser, ctx, pg, cdp: c };
}

/**
 * Browser-wide trace (all processes, GPU included) around `during()`, written to `outPath` as
 * Chrome's own `{"traceEvents": [...]}` JSON (what Playwright's startTracing writes).
 */
export async function rawTrace(cdpHttp, outPath, categories, during) {
  const ver = await (await fetch(`${cdpHttp}/json/version`)).json();
  const b = await cdpConnect(ver.webSocketDebuggerUrl);
  try {
    await b.send("Tracing.start", { transferMode: "ReturnAsStream", traceConfig: { includedCategories: categories, recordMode: "recordAsMuchAsPossible" } });
    const result = await during();
    const done = new Promise((res) => b.on("Tracing.tracingComplete", res));
    await b.send("Tracing.end");
    const { stream } = await done;
    const out = createWriteStream(outPath);
    for (;;) {
      const chunk = await b.send("IO.read", { handle: stream, size: 1 << 20 });
      out.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
      if (chunk.eof) break;
    }
    await b.send("IO.close", { handle: stream });
    await new Promise((res) => out.end(res));
    return result;
  } finally { b.close(); }
}
