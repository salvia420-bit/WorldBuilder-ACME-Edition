// cdp-eval.mjs — `hbsess.mjs eval` over a raw CDP WebSocket (2026-10-29).
//   node --experimental-websocket cdp-eval.mjs <file.js> [--timeout-sec 600]
// file = body of an async fn; its `return` value is printed as JSON (same contract as hbsess eval).
//
// Why: on the 1070's Chrome 156, playwright-core 1.59.1's connectOverCDP hangs once Chrome lists
// `browser_ui` targets (chrome://omnibox-popup.top-chrome/…) next to the page — it tries to attach to
// every target. The page itself answers at once. This talks to the page target alone: one
// Runtime.evaluate with awaitPromise, no attach to anything else, no focus emulation, and it never
// closes or navigates the page. CDP :9333 must be tunnelled (memory/fleet-runbooks.md).
import { readFileSync } from "node:fs";

const CDP = process.env.HB_CDP || "http://127.0.0.1:9333";
const argv = process.argv.slice(2);
const file = argv[0];
const ti = argv.indexOf("--timeout-sec");
const timeoutMs = (ti >= 0 ? +argv[ti + 1] : 600) * 1000;
if (!file) { console.error("usage: node --experimental-websocket cdp-eval.mjs <file.js> [--timeout-sec N]"); process.exit(2); }
if (typeof WebSocket !== "function") { console.error("needs a global WebSocket: run with node --experimental-websocket (node 20) or node >= 22"); process.exit(2); }

const src = readFileSync(file, "utf8");
const list = await (await fetch(`${CDP}/json/list`)).json();
const target = list.find((p) => p.type === "page" && p.url.includes("holtburger-web"));
if (!target) { console.error("no holtburger-web page target at", CDP); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws error")); setTimeout(() => rej(new Error("ws open timeout")), 15000); });
const reply = await new Promise((res, rej) => {
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id === 1) res(m); };
  setTimeout(() => rej(new Error(`eval timeout after ${timeoutMs / 1000} s`)), timeoutMs);
  ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: {
    expression: `(async () => { ${src}\n })()`, awaitPromise: true, returnByValue: true, userGesture: false } }));
});
ws.close();
if (reply.error) { console.error("CDP error", JSON.stringify(reply.error)); process.exit(1); }
const r = reply.result;
if (r.exceptionDetails) { console.error("page exception", JSON.stringify(r.exceptionDetails).slice(0, 2000)); process.exit(1); }
const v = r.result?.value;
console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
process.exit(0);
