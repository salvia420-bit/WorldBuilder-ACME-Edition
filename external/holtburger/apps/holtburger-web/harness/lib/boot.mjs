// harness/lib/boot.mjs — shared headless-boot foundation for the Playwright
// flag harness. Every flags.*.mjs descriptor's assertBrowser(helpers) consumes
// the `helpers` object returned by launchAndEnter(); the driver owns the
// browser/page lifecycle and calls helpers.close() when done.
//
// ---------------------------------------------------------------------------
// PLAYWRIGHT INSTALL NOTE (read if launchAndEnter throws PLAYWRIGHT_MISSING):
//   playwright@1.59.1 is installed ONLY in the npx cache on this box, NOT in
//   any project node_modules (there is no package.json anywhere in the tree).
//   `require('playwright')` therefore fails from the app dir — we fall back to
//   the cache path below (override with env PLAYWRIGHT_CACHE).
//   To (re)populate the cache:   npx -y playwright@1.59.1 install chromium
//   To vendor it locally instead (also creates the missing package.json):
//       npm i -D playwright@1.59.1 && npx playwright install chromium
//   (run from apps/holtburger-web/). Once vendored, require('playwright')
//   resolves and the cache fallback is never reached.
// ---------------------------------------------------------------------------
//
// HEADLESS BOOT FACTS baked in here (from prior validated sessions):
//   - serve.py auto-binds 127.0.0.1:8765 over the baked dist root; app base is
//     http://127.0.0.1:8765/apps/holtburger-web/ .
//   - ?nullRender=1 is MANDATORY headless (else rAF throttles to ~0.2Hz and
//     nothing ticks). We always inject it.
//   - autoLogin uses the standing tailnet1/tailnet1 account (teleport/Developer
//     privs) against the local bridge (form default ws://127.0.0.1:8080/, so we
//     omit bridge_url) and ACE at 127.0.0.1:9000.
//   - IN-WORLD gate (MEMORY: "gate on in-world+pose, NEVER ready"): wait until
//     window.__bootState === 'in-world' (set at EnteredWorld kind=7) AND
//     window.__sessionHandle.getLocalPlayerPose() !== undefined. 'ready' is
//     scene-bake-complete and can fire BEFORE in-world — never gate on it.
//     We also scan window.__bootStateHistory because the brief in-world→ready
//     transition can slip between polls.
//   - ALL wasm getters MUST be read inside page.evaluate (the SessionHandle is
//     window.__sessionHandle in the page; absent in Node).

import { createRequire } from "node:module";
import http from "node:http";

const require = createRequire(import.meta.url);

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

const SERVER_BASE =
  process.env.HARNESS_BASE_URL || "http://127.0.0.1:8765/apps/holtburger-web/";

// Mandatory query that every flag run inherits. Caller-supplied `query` is
// merged on top (and may override e.g. server_host for a remote run).
const BASE_QUERY = {
  renderer: "3d",
  nullRender: "1",
  autoLogin: "1",
  // The driver launches one fresh session per flag group with the SAME account.
  // ACE keeps the account "in world" for a ~25s grace after the prior session's
  // socket closes ("2nd connect boots 1st"), so a back-to-back reconnect lands
  // mid-grace and never reaches in-world. kickDance does connect→kick→reconnect
  // so each group can claim the world. Disable with HARNESS_KICKDANCE=0.
  ...(process.env.HARNESS_KICKDANCE === "0" ? {} : { kickDance: "1" }),
  account: process.env.HARNESS_ACCOUNT || "tailnet1",
  password: process.env.HARNESS_PASSWORD || "tailnet1",
  autoSpawn: "first",
  server_host: process.env.HARNESS_SERVER_HOST || "127.0.0.1",
  server_port: process.env.HARNESS_SERVER_PORT || "9000",
};

/**
 * Load playwright's `chromium` launcher, preferring a real node_modules install
 * and falling back to the npx cache. Mirrors the canonical fallback the 68
 * capture_*.cjs files use, adapted to ESM via createRequire.
 * Throws Error('PLAYWRIGHT_MISSING') (code='PLAYWRIGHT_MISSING') if neither
 * resolves.
 */
export function loadChromium() {
  try {
    return require("playwright").chromium;
  } catch (_) {
    try {
      return require(`${PLAYWRIGHT_CACHE}/playwright`).chromium;
    } catch (_2) {
      try {
        // playwright-core also exposes chromium and is in the same cache.
        return require(`${PLAYWRIGHT_CACHE}/playwright-core`).chromium;
      } catch (e) {
        throw Object.assign(
          new Error(
            `PLAYWRIGHT_MISSING: not in node_modules nor ${PLAYWRIGHT_CACHE}. ` +
              `Run: npx -y playwright@1.59.1 install chromium`
          ),
          { code: "PLAYWRIGHT_MISSING", cause: e }
        );
      }
    }
  }
}

/**
 * Short-timeout reachability probe of the dev server (NOT a full nav). Resolves
 * true on any HTTP response (even 404 — the server is up), false on
 * connection-refused / timeout / socket error. Used to SKIP the whole run
 * instead of hanging when serve.py isn't running.
 * @param {string} [url=SERVER_BASE]
 * @param {number} [timeoutMs=2500]
 * @returns {Promise<boolean>}
 */
export function probeServer(url = SERVER_BASE, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let req;
    try {
      req = http.get(url, (res) => {
        // Any status line means the server answered — it's up.
        res.resume(); // drain so the socket can close
        done(true);
      });
    } catch (_) {
      done(false);
      return;
    }
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(false);
    });
    req.on("error", () => done(false));
  });
}

function buildUrl(query) {
  const u = new URL(SERVER_BASE);
  const merged = { ...BASE_QUERY };
  if (typeof query === "string" && query) {
    // Accept a raw query fragment like "wasmPursuit=on&unifiedTick=on".
    for (const [k, v] of new URLSearchParams(
      query.replace(/^[?&]/, "")
    ).entries()) {
      merged[k] = v;
    }
  } else if (query && typeof query === "object") {
    Object.assign(merged, query);
  }
  for (const [k, v] of Object.entries(merged)) {
    u.searchParams.set(k, String(v));
  }
  return u.toString();
}

/**
 * Launch headless chromium, navigate to the app with the mandatory headless
 * query plus the caller's `query`, and wait until the local player is truly
 * in-world (in-world boot-state AND a non-undefined pose).
 *
 * @param {object} opts
 * @param {string|object} [opts.query] extra URL query (string fragment or
 *   key/value object) appended to the base headless+autoLogin query.
 * @param {number} [opts.timeoutMs=60000] hard cap on reaching in-world.
 * @returns {Promise<{browser:import('playwright').Browser, page:import('playwright').Page, helpers:object, url:string, inWorld:boolean}>}
 * @throws Error('SERVER_DOWN') (code='SERVER_DOWN') if the dev server is
 *   unreachable; Error('PLAYWRIGHT_MISSING') if playwright can't be loaded.
 *   Does NOT throw on in-world timeout — returns inWorld:false so the driver
 *   can decide (typically SKIP that run, never FAIL a flag for a boot stall).
 */
export async function launchAndEnter({ query, timeoutMs = 60000 } = {}) {
  // 1) Server reachability — SKIP the whole run rather than hang.
  const up = await probeServer();
  if (!up) {
    throw Object.assign(new Error("SERVER_DOWN"), {
      code: "SERVER_DOWN",
      base: SERVER_BASE,
    });
  }

  const chromium = loadChromium();
  const url = buildUrl(query);

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  // 2) Collect console + pageerror for consoleErrors().
  const consoleLog = []; // { t, type, text }
  const pageErrors = []; // { t, message }
  const t0 = Date.now();
  page.on("console", (msg) => {
    consoleLog.push({ t: Date.now() - t0, type: msg.type(), text: msg.text() });
  });
  page.on("pageerror", (err) => {
    pageErrors.push({ t: Date.now() - t0, message: err.message });
  });

  // 3) Navigate. domcontentloaded is enough — autoLogin fires from the page.
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });

  // 4) Wait for truly-in-world: __bootState==='in-world' (now OR anywhere in
  //    __bootStateHistory, to catch the in-world->ready slip) AND a
  //    non-undefined local-player pose. Bounded by timeoutMs; on stall we
  //    resolve inWorld:false rather than throwing.
  let inWorld = false;
  try {
    await page.waitForFunction(
      () => {
        const hist = Array.isArray(window.__bootStateHistory)
          ? window.__bootStateHistory
          : [];
        const reachedInWorld =
          window.__bootState === "in-world" ||
          hist.some((e) => e && e.state === "in-world");
        if (!reachedInWorld) return false;
        if (window.__bootState === "error") return true; // terminal; let caller inspect
        const h = window.__sessionHandle;
        if (!h || typeof h.getLocalPlayerPose !== "function") return false;
        let pose;
        try {
          pose = h.getLocalPlayerPose();
        } catch (_) {
          return false;
        }
        return pose !== undefined && pose !== null;
      },
      { timeout: timeoutMs, polling: 100 }
    );
    // Confirm we didn't resolve solely on a terminal 'error' state.
    inWorld = await page.evaluate(() => window.__bootState !== "error");
  } catch (_) {
    inWorld = false; // boot stalled — driver decides (SKIP), never FAIL.
  }

  const helpers = makeHelpers(page, { consoleLog, pageErrors, browser, url });
  return { browser, page, helpers, url, inWorld };
}

/**
 * Build the helper surface passed to assertBrowser(helpers). All wasm/DOM reads
 * run inside page.evaluate. Read-only except close().
 */
function makeHelpers(page, ctx) {
  /**
   * Evaluate a function in the page. The function is serialized by Playwright,
   * so it must be self-contained (no closure over harness scope); pass extra
   * inputs as trailing args.
   * @template T
   * @param {(...a:any[])=>T} fn
   * @param {...any} args
   * @returns {Promise<T>}
   */
  const evalInPage = (fn, ...args) => page.evaluate(fn, ...args);

  /**
   * Read a SessionHandle method in-page. Returns { present, value }:
   *   present=false  => the method is ABSENT from the current pkg/ (or the
   *                     handle isn't ready) => caller classifies 'rebuild-pending'.
   *   present=true   => `value` is the JSON-cloneable return (typed arrays are
   *                     converted to plain Arrays so they survive the bridge).
   * Throws nothing for an absent method; throws only on a real in-call error,
   * surfaced as { present:true, value:{ __error: message } } so callers never
   * crash mid-assert.
   * @param {string} method  e.g. 'pursuitStatus', 'getLocalPlayerPose'
   * @param {any[]} [args=[]]
   * @returns {Promise<{present:boolean, value:any}>}
   */
  const readGetter = (method, args = []) =>
    page.evaluate(
      ({ method, args }) => {
        const h = window.__sessionHandle;
        if (!h || typeof h[method] !== "function") {
          return { present: false, value: undefined };
        }
        let raw;
        try {
          raw = h[method](...args);
        } catch (e) {
          return { present: true, value: { __error: e && e.message ? e.message : String(e) } };
        }
        // Make the return JSON-cloneable across the page boundary.
        const clone = (v) => {
          if (v === null || v === undefined) return v;
          if (
            v instanceof Uint8Array ||
            v instanceof Uint16Array ||
            v instanceof Uint32Array ||
            v instanceof Int8Array ||
            v instanceof Int16Array ||
            v instanceof Int32Array ||
            v instanceof Float32Array ||
            v instanceof Float64Array
          ) {
            return Array.from(v);
          }
          if (Array.isArray(v)) return v.map(clone);
          if (typeof v === "object") {
            // wasm-bindgen structs expose getters off the prototype, not own
            // enumerable keys — pull the union of own + prototype accessor names.
            const out = {};
            const names = new Set(Object.keys(v));
            let proto = Object.getPrototypeOf(v);
            while (proto && proto !== Object.prototype) {
              for (const n of Object.getOwnPropertyNames(proto)) {
                if (n === "constructor") continue;
                const d = Object.getOwnPropertyDescriptor(proto, n);
                if (d && typeof d.get === "function") names.add(n);
              }
              proto = Object.getPrototypeOf(proto);
            }
            for (const n of names) {
              try {
                const child = v[n];
                if (typeof child === "function") continue;
                out[n] = clone(child);
              } catch (_) {
                /* unreadable accessor — skip */
              }
            }
            return out;
          }
          return v; // primitive
        };
        return { present: true, value: clone(raw) };
      },
      { method, args }
    );

  /**
   * Return the window.__<globalName> object (e.g. '__diag', '__diag.render',
   * '__syncTickDiag') JSON-cloned, or null if absent. Dotted paths are walked.
   * @param {string} globalName  with or without the leading '__'/'window.'
   * @returns {Promise<any|null>}
   */
  const readDiag = (globalName) =>
    page.evaluate((raw) => {
      let path = String(raw).replace(/^window\./, "");
      // Normalize: accept 'diag', '__diag', 'diag.render', '__diag.render'.
      const parts = path.split(".").filter(Boolean);
      if (parts.length && !parts[0].startsWith("__")) parts[0] = "__" + parts[0];
      let cur = window;
      for (const p of parts) {
        if (cur == null) return null;
        cur = cur[p];
      }
      if (cur == null) return null;
      // Best-effort JSON clone; functions and cycles are dropped.
      const seen = new WeakSet();
      const clone = (v) => {
        if (v === null || typeof v !== "object") {
          return typeof v === "function" ? undefined : v;
        }
        if (seen.has(v)) return undefined;
        seen.add(v);
        if (
          v instanceof Uint8Array ||
          v instanceof Uint32Array ||
          v instanceof Float32Array
        ) {
          return Array.from(v);
        }
        if (v instanceof Map) {
          const o = {};
          for (const [k, val] of v.entries()) o[String(k)] = clone(val);
          return o;
        }
        if (v instanceof Set) return Array.from(v).map(clone);
        if (Array.isArray(v)) return v.map(clone);
        const out = {};
        for (const k of Object.keys(v)) {
          const c = clone(v[k]);
          if (c !== undefined) out[k] = c;
        }
        return out;
      };
      try {
        return clone(cur);
      } catch (_) {
        return null;
      }
    }, globalName);

  /**
   * Best-effort live entity count. Reads window.entityMap.size, falling back to
   * window.liveScene3d.entityManager.entityMap.size, else __diag spawn counts.
   * Returns -1 if no source is available (treat as 'unknown', not zero).
   * @returns {Promise<number>}
   */
  const entityCount = () =>
    page.evaluate(() => {
      try {
        if (window.entityMap && typeof window.entityMap.size === "number") {
          return window.entityMap.size;
        }
        const em =
          window.liveScene3d &&
          window.liveScene3d.entityManager &&
          window.liveScene3d.entityManager.entityMap;
        if (em && typeof em.size === "number") return em.size;
        const s = window.__diag && window.__diag.spawns;
        if (s && typeof s.succeeded === "number") return s.succeeded;
      } catch (_) {
        /* fall through */
      }
      return -1;
    });

  /**
   * Console messages of type 'error' plus uncaught pageerrors, collected since
   * navigation. Each entry: { t, type:'error'|'pageerror', text }.
   * @returns {Array<{t:number,type:string,text:string}>}
   */
  const consoleErrors = () => [
    ...ctx.consoleLog
      .filter((e) => e.type === "error")
      .map((e) => ({ t: e.t, type: "error", text: e.text })),
    ...ctx.pageErrors.map((e) => ({ t: e.t, type: "pageerror", text: e.message })),
  ];

  /** Sleep `ms` driven by the page clock (a real awaited delay). */
  const waitMs = (ms) => page.waitForTimeout(ms);

  /** Tear down the browser. Idempotent; swallows close errors. */
  const close = async () => {
    try {
      await ctx.browser.close();
    } catch (_) {
      /* already closed */
    }
  };

  return {
    page,
    url: ctx.url,
    evalInPage,
    readGetter,
    readDiag,
    entityCount,
    consoleErrors,
    waitMs,
    close,
  };
}

export { SERVER_BASE, BASE_QUERY, PLAYWRIGHT_CACHE };
