// Shared helpers for the drone probe session (CDP :9333 on the 1070 via the laptop tunnel).
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
export async function connect() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  let page = ctx.pages().find((p) => /holtburger-web/.test(p.url())) || ctx.pages()[0];
  return { browser, ctx, page };
}
// Local ACE test account; the password is read from the repo script at runtime (never copied).
export function localLoginUrl() {
  const src = readFileSync("/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/scripts/perf-worker/hbbench.mjs", "utf8");
  const m = src.match(/account=tailnet1&password=([^&"`]+)/);
  if (!m) throw new Error("tailnet1 password not found in hbbench.mjs");
  const q = new URLSearchParams({
    autoLogin: "1", account: "tailnet1", password: m[1], autoSpawn: "first", nosw: "1", camDebug: "on",
    quality: "high", csm: "off", renderScale: "1", adaptiveRes: "off",
    // Pin the LOCAL ACE (laptop) through the tunneled bridge - never Coldeve.
    bridge_url: "ws://127.0.0.1:8080/", server_host: "127.0.0.1", server_port: "9000",
  });
  return `http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`;
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
