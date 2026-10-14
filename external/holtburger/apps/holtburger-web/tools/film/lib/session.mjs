// tools/film/lib/session.mjs — the film CLI's connection to the off-screen Chrome on the GTX-1070 box: CDP
// attach (never launch), the exact film boot URL, `window.__film` calls, the boot gate, the audio mute, window and
// GPU probes, and the teleport → readiness wait.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) renders on the 1070 (the owner's baseline GPU, used by a person),
// reached through `ssh -L 9333` as http://127.0.0.1:9333. The CLI only ATTACHES (playwright-core
// chromium.connectOverCDP) — it never launches a browser, never closes someone else's page, and never lets sound
// reach the 1070's user. The page API is SPEC §3 `window.__film` (JSON in/out, `{ok:false, error}` instead of
// throwing). Everything that runs in the page is a self-contained function (Playwright serialises it with
// toString), typeof-guarded so a page without film mode answers instead of throwing.
//
// Facts this module relies on (docs/film-mode-2026-10-13/recon/recon_capture.md, recon_world.md, recon_hud.md):
//   - boot states: init → form-shown → connecting → kicking → reconnecting → char-list-ready → spawning →
//     in-world; 'ready' (atmosphere composer wired; __set* helpers attach after it) may come before OR after
//     in-world, so it is read from __bootStateHistory as well as the scalar; __sceneReadyEverFired latches it.
//   - SwiftShader trap: 'ready' can time out (__bootState → 'error' AFTER in-world) though the scene is fine →
//     accept mesh count > 100 once 90 s have passed. An 'error' BEFORE in-world is a login failure (single-login
//     account: "Account In Use" → wait ~25–65 s).
//   - window.liveScene3d arrives ≈35 s after in-world; window.__film is installed after it (filmMode=on).
//   - the only WebAudio graph is liveScene3d.audioManager (scene3d/audio/audio_manager.js): setMasterGain /
//     setEffectGain / setAmbientGain / pauseAll, private _ctx (AudioContext, created on the first user gesture)
//     and _master (→ ctx.destination). There is no music player.
//   - Emulation overrides and exposeFunction bindings belong to the CDP connection that set them: they end when the
//     CLI process disconnects, so every page-driving command re-applies the viewport and re-installs the JEV broker.
//   - Browser.getBrowserCommandLine works only when Chrome runs with --enable-automation; otherwise the mute flag
//     is 'unverified'.

import { FilmCliError, EXIT, redactUrl } from "./args.mjs";

export { redactUrl };

/** Default CDP endpoint (the -L 9333 tunnel to the 1070 test Chrome). */
export const DEFAULT_CDP = "http://127.0.0.1:9333";
/** Default page (serve.py on the laptop, through the tailnet front on the box). */
export const DEFAULT_BASE_URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
/** Film account (owner decision 2026-10-13: phase4demo, ACE accessLevel 5). The password is run-time only. */
export const DEFAULT_ACCOUNT = "phase4demo";
/** Boot gate timeout (s). */
export const DEFAULT_BOOT_TIMEOUT_SEC = 180;
/** After this long without 'ready' / scene-ready, a scene with > 100 meshes counts as booted (SwiftShader trap). */
export const SCENE_READY_FALLBACK_MS = 90_000;
/** Mesh count that proves the world is drawn (cmdinterp gate). */
export const SCENE_MESH_MIN = 100;
/** The GTX-1070 box (fleet runbook). Override with `--host` or env FILM_1070_HOST. */
export const DEFAULT_1070_HOST = "young@100.127.215.75";

/**
 * The film session's SSH tunnel (fleet runbook): `-L` CDP to the laptop, `-R 8765` the laptop's serve.py to the
 * box (the boot URL's page), `-R 8080` the laptop's ws↔UDP bridge to the box (the client's default bridge_url).
 * Without `-R 8080` the login dies with 'WsTransport ws handshake failed'. The local `-L` port follows the CDP URL
 * (default 9333); the box's Chrome always listens on 9333.
 * @param {{host?: string, cdp?: string}} [o]
 * @returns {string}
 */
export function tunnelCommand({ host = DEFAULT_1070_HOST, cdp = DEFAULT_CDP } = {}) {
  let port = 9333;
  try {
    const u = new URL(String(cdp));
    const p = Number(u.port);
    if (Number.isInteger(p) && p > 0 && p < 65536) port = p;
  } catch {
    // keep 9333
  }
  const h = String(host || DEFAULT_1070_HOST).trim() || DEFAULT_1070_HOST;
  return `ssh -o ExitOnForwardFailure=yes -fN -L ${port}:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080 ${h}`;
}

/**
 * The exact film boot URL. Parameter order is fixed; `filmDof=on` is ALWAYS present (owner decision: depth of
 * field ships in v1). The result contains the password — log it only through redactUrl().
 * @param {{base?: string, account?: string, password: string, quality?: string}} o
 * @returns {string}
 */
export function buildFilmUrl({ base = DEFAULT_BASE_URL, account = DEFAULT_ACCOUNT, password, quality = "high" } = {}) {
  if (typeof password !== "string" || password.length === 0) {
    throw new FilmCliError("no password: pass --password=… or set FILM_PASSWORD", { exitCode: EXIT.USAGE, code: "NO_PASSWORD" });
  }
  if (typeof account !== "string" || !account) throw new FilmCliError("--account must not be empty", { exitCode: EXIT.USAGE, code: "USAGE" });
  const q = String(quality || "high");
  const b = String(base || DEFAULT_BASE_URL);
  const query =
    "nosw=1&agent=1&hud=none&plugins=none&filmMode=on&filmDof=on&autoLogin=1" +
    `&account=${encodeURIComponent(account)}&password=${encodeURIComponent(password)}&autoSpawn=first` +
    `&quality=${encodeURIComponent(q)}&renderScale=1&adaptiveRes=off&radialFog=on&objRadius=off&fogRingCap=off` +
    "&punchSidedness=on&particleClock=sim&frameBudget=off&maxTickDist=400&dynLod=off";
  const hashAt = b.indexOf("#");
  const head = hashAt >= 0 ? b.slice(0, hashAt) : b;
  const sep = head.includes("?") ? (head.endsWith("?") || head.endsWith("&") ? "" : "&") : "?";
  return `${head}${sep}${query}`;
}

/** True for a film-mode page URL (`filmMode=on`, exact). */
export function isFilmUrl(url) {
  try {
    const u = new URL(String(url));
    return u.searchParams.get("filmMode") === "on";
  } catch {
    return /[?&]filmMode=on(?:&|#|$)/.test(String(url ?? ""));
  }
}

/** Lazily import playwright-core's chromium (never at module load: tests and --help never touch it). */
export async function loadChromium() {
  let m;
  try {
    m = await import("playwright-core");
  } catch (e) {
    throw new FilmCliError(`playwright-core is not resolvable from tools/film (expected apps/holtburger-web/node_modules/playwright-core): ${e?.message ?? e}`, {
      exitCode: EXIT.USAGE,
      code: "NO_PLAYWRIGHT",
    });
  }
  const chromium = m.chromium ?? m.default?.chromium;
  if (!chromium) throw new FilmCliError("playwright-core has no chromium export", { exitCode: EXIT.USAGE, code: "NO_PLAYWRIGHT" });
  return chromium;
}

/**
 * Attach to the running Chrome over CDP and find the film page (URL with filmMode=on). Never launches anything.
 * `close()` disconnects this client only (the browser and its pages keep running).
 * @param {{cdp?: string, chromium?: {connectOverCDP: Function}, timeoutMs?: number, match?: (url: string) => boolean}} [o]
 * @returns {Promise<{browser: object, context: object|null, page: object|null, pages: object[], cdp: string,
 *   close: () => Promise<void>}>}
 */
export async function connect({ cdp = DEFAULT_CDP, chromium, timeoutMs = 15_000, match = isFilmUrl } = {}) {
  const ch = chromium ?? (await loadChromium());
  let browser;
  try {
    browser = await ch.connectOverCDP(cdp, { timeout: timeoutMs });
  } catch (e) {
    throw new FilmCliError(`cannot attach to Chrome over CDP at ${cdp} (is the 1070 test Chrome up and the tunnel open? \`film doctor\` prints the full ssh line): ${firstLine(e?.message ?? e)}`, {
      exitCode: EXIT.USAGE,
      code: "CDP_UNREACHABLE",
    });
  }
  const contexts = typeof browser.contexts === "function" ? browser.contexts() : [];
  const context = contexts[0] ?? null;
  const pages = [];
  for (const c of contexts) for (const p of typeof c.pages === "function" ? c.pages() : []) pages.push(p);
  const page = pages.find((p) => safeUrl(p) && match(safeUrl(p))) ?? null;
  return {
    browser,
    context,
    page,
    pages,
    cdp,
    async close() {
      try {
        await browser.close();
      } catch {
        // already disconnected
      }
    },
  };
}

function safeUrl(p) {
  try {
    return typeof p?.url === "function" ? String(p.url()) : "";
  } catch {
    return "";
  }
}

function firstLine(s) {
  return String(s ?? "").split(/\r?\n/)[0].slice(0, 300);
}

// ── window.__film calls ────────────────────────────────────────────────────────────────────────────────────

/**
 * Runs in the page: resolve `window.__film.<dotted.method>`, call it with `this` = its parent object, await it.
 * Never throws: a missing API or a throw becomes `{ok:false, error, code}`.
 */
export const FILM_CALL_FN = async ({ method, args }) => {
  const film = typeof window !== "undefined" ? window.__film : undefined;
  if (!film || typeof film !== "object") {
    return { ok: false, error: "window.__film is not installed (open the page with ?filmMode=on and wait for the boot gate)", code: "NO_FILM" };
  }
  const parts = String(method).split(".");
  let owner = film;
  for (let i = 0; i < parts.length - 1; i++) owner = owner == null ? undefined : owner[parts[i]];
  const fn = owner == null ? undefined : owner[parts[parts.length - 1]];
  if (typeof fn !== "function") return { ok: false, error: `window.__film.${method} is not a function`, code: "NO_METHOD" };
  try {
    const r = await fn.apply(owner, Array.isArray(args) ? args : []);
    return r === undefined ? { ok: true } : r;
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), code: "THREW" };
  }
};

/**
 * `page.evaluate` with a watchdog: a hung Runtime.evaluate once cost 6 hours (recon_capture HAZARDS), so every
 * call races a timer and fails with FilmCliError (exit 1) instead of hanging.
 * @param {object} page Playwright Page
 * @param {Function} fn self-contained page function
 * @param {unknown} arg
 * @param {{timeoutMs?: number, what?: string}} [o]
 * @returns {Promise<any>}
 */
export async function evaluateWithTimeout(page, fn, arg, { timeoutMs = 120_000, what = "page.evaluate" } = {}) {
  let timer;
  const watchdog = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new FilmCliError(`${what} did not answer within ${Math.round(timeoutMs / 1000)} s (page busy or hung?)`, {
      exitCode: EXIT.FINDING,
      code: "EVAL_TIMEOUT",
    })), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  });
  try {
    return await Promise.race([page.evaluate(fn, arg), watchdog]);
  } catch (e) {
    if (e instanceof FilmCliError) throw e;
    throw new FilmCliError(`${what} failed: ${firstLine(e?.message ?? e)}`, { exitCode: EXIT.FINDING, code: "EVAL_FAILED" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call `window.__film[method]` (dotted paths like 'world.ready', 'recorder.drain') with options:
 * `soft` returns `{ok:false, …}` results instead of throwing; `timeoutMs` bounds the evaluate.
 * @param {object} page
 * @param {{timeoutMs?: number, soft?: boolean}} opts
 * @param {string} method
 * @param {...unknown} args JSON-safe arguments
 * @returns {Promise<any>}
 */
export async function filmCallWith(page, opts, method, ...args) {
  const o = opts || {};
  const r = await evaluateWithTimeout(page, FILM_CALL_FN, { method, args }, { timeoutMs: o.timeoutMs ?? 120_000, what: `__film.${method}` });
  if (!o.soft && r && typeof r === "object" && r.ok === false) {
    const err = typeof r.error === "string" ? r.error : r.error?.message ?? JSON.stringify(r.error ?? r);
    throw new FilmCliError(`__film.${method} failed: ${err}`, {
      exitCode: r.code === "NO_FILM" || r.code === "NO_METHOD" ? EXIT.USAGE : EXIT.FINDING,
      code: r.code ?? "FILM_CALL_FAILED",
      details: { method, error: r.error ?? null },
    });
  }
  return r;
}

/**
 * Call `window.__film[method](...args)`; throws FilmCliError on `{ok:false, error}`.
 * @param {object} page
 * @param {string} method e.g. 'status', 'world.teleport', 'recorder.drain'
 * @param {...unknown} args
 * @returns {Promise<any>}
 */
export function filmCall(page, method, ...args) {
  return filmCallWith(page, {}, method, ...args);
}

// ── boot gate ──────────────────────────────────────────────────────────────────────────────────────────────

/** Runs in the page: the boot gate snapshot. Never returns location.href (it carries the password). */
export const BOOT_SNAPSHOT_FN = () => {
  const w = typeof window !== "undefined" ? window : {};
  const hist = Array.isArray(w.__bootStateHistory)
    ? w.__bootStateHistory.slice(-60).map((h) => ({
        state: h && h.state != null ? String(h.state) : "",
        message: h && h.message != null ? String(h.message).slice(0, 300) : "",
        ts: h && typeof h.ts === "number" ? h.ts : null,
      }))
    : [];
  const ce = w.__lastCharacterError;
  let portalActive = null;
  try {
    portalActive = typeof w.__isPortalSpaceActive === "function" ? !!w.__isPortalSpaceActive() : null;
  } catch (_) {
    portalActive = null;
  }
  let lastDisconnect = null;
  try {
    lastDisconnect = w.__lastDisconnect == null ? null : String(typeof w.__lastDisconnect === "object" ? JSON.stringify(w.__lastDisconnect) : w.__lastDisconnect).slice(0, 300);
  } catch (_) {
    lastDisconnect = null;
  }
  return {
    state: w.__bootState == null ? null : String(w.__bootState),
    history: hist,
    sceneReadyEverFired: w.__sceneReadyEverFired === true,
    liveScene3d: !!w.liveScene3d,
    film: !!(w.__film && typeof w.__film === "object"),
    filmVersion: w.__film && w.__film.version != null ? String(w.__film.version) : null,
    portalActive,
    lastCharacterError: ce ? { code: typeof ce.code === "number" ? ce.code : null, name: ce.name != null ? String(ce.name) : null, message: ce.message != null ? String(ce.message).slice(0, 300) : null, mode: ce.mode != null ? String(ce.mode) : null } : null,
    lastDisconnect,
  };
};

/** Runs in the page: number of meshes in the live scene (the SwiftShader-trap fallback). */
export const MESH_COUNT_FN = () => {
  let n = 0;
  try {
    const s = typeof window !== "undefined" && window.liveScene3d ? window.liveScene3d.scene : null;
    if (s && typeof s.traverse === "function") s.traverse((o) => { if (o && o.isMesh) n++; });
  } catch (_) {
    // count what we have
  }
  return n;
};

const ACCOUNT_IN_USE_RE = /in use|logon|already logged|kick/i;

/**
 * Classify a boot snapshot (pure). `go` when: in-world (scalar or history) AND 'ready' (scalar or history) AND
 * `__sceneReadyEverFired` AND `liveScene3d` AND `__film` — where 'ready' + scene-ready may instead be satisfied
 * by `meshCount > 100` once `elapsedMs ≥ 90 s` (SwiftShader trap). `fail` when the login failed BEFORE in-world
 * (`__bootState === 'error'`, or a fatal CharacterError). Else `wait`.
 * @param {ReturnType<typeof BOOT_SNAPSHOT_FN>} snap
 * @param {{elapsedMs?: number, meshCount?: number|null}} [o]
 * @returns {{action: 'go'|'wait'|'fail', reason: string, accountInUse?: boolean, checks: Record<string, boolean>,
 *   failing: string[]}}
 */
export function classifyBoot(snap, { elapsedMs = 0, meshCount = null } = {}) {
  const s = snap || {};
  const hist = Array.isArray(s.history) ? s.history : [];
  const seen = (st) => s.state === st || hist.some((h) => h && h.state === st);
  const inWorld = seen("in-world");
  const trap = elapsedMs >= SCENE_READY_FALLBACK_MS && Number(meshCount) > SCENE_MESH_MIN;
  const checks = {
    inWorld,
    ready: seen("ready") || trap,
    sceneReady: s.sceneReadyEverFired === true || trap,
    liveScene3d: s.liveScene3d === true,
    film: s.film === true,
  };
  const failing = Object.keys(checks).filter((k) => !checks[k]);
  if (!inWorld) {
    const ce = s.lastCharacterError;
    const fatalCe = ce && (ce.mode === "fatal" || ce.code === 1 || ACCOUNT_IN_USE_RE.test(`${ce.name ?? ""} ${ce.message ?? ""}`));
    if (s.state === "error" || fatalCe) {
      const lastErr = [...hist].reverse().find((h) => h && h.state === "error");
      const text = [lastErr?.message, ce ? `${ce.name ?? ""} ${ce.message ?? ""}`.trim() : null, s.lastDisconnect].filter(Boolean).join(" | ");
      const accountInUse = ACCOUNT_IN_USE_RE.test(text) || (ce && ce.code === 1) || hist.some((h) => h && h.state === "kicking");
      return {
        action: "fail",
        reason: `login failed before in-world${text ? `: ${text}` : ""}`,
        accountInUse: Boolean(accountInUse),
        checks,
        failing,
      };
    }
  }
  if (failing.length === 0) return { action: "go", reason: trap && !(seen("ready") && s.sceneReadyEverFired) ? "in-world (scene-ready fallback: > 100 meshes after 90 s)" : "in-world and ready", checks, failing };
  return { action: "wait", reason: `waiting for ${failing.join(", ")}`, checks, failing };
}

/**
 * Poll the boot gate until `go`, a login failure or the timeout. Reads the mesh count only once the 90 s
 * fallback window is open and the scene-ready signals are still missing.
 * @param {object} page
 * @param {{timeoutMs?: number, pollMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void>,
 *   onState?: (snap: object, verdict: object) => void}} [o]
 * @returns {Promise<{ok: boolean, verdict: object, snap: object, elapsedMs: number, meshCount: number|null}>}
 */
export async function waitForBoot(page, o = {}) {
  const { timeoutMs = DEFAULT_BOOT_TIMEOUT_SEC * 1000, pollMs = 1000, onState } = o;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = now();
  let lastState = null;
  for (;;) {
    const elapsedMs = now() - t0;
    const snap = await evaluateWithTimeout(page, BOOT_SNAPSHOT_FN, undefined, { timeoutMs: 30_000, what: "boot snapshot" });
    let meshCount = null;
    if (elapsedMs >= SCENE_READY_FALLBACK_MS && !(snap.sceneReadyEverFired && (snap.state === "ready" || snap.history.some((h) => h.state === "ready")))) {
      meshCount = await evaluateWithTimeout(page, MESH_COUNT_FN, undefined, { timeoutMs: 30_000, what: "mesh count" });
    }
    const verdict = classifyBoot(snap, { elapsedMs, meshCount });
    if (onState && snap.state !== lastState) {
      lastState = snap.state;
      try {
        onState(snap, verdict);
      } catch {
        // progress only
      }
    }
    if (verdict.action === "go") return { ok: true, verdict, snap, elapsedMs, meshCount };
    if (verdict.action === "fail") return { ok: false, verdict, snap, elapsedMs, meshCount };
    if (elapsedMs >= timeoutMs) {
      return { ok: false, verdict: { ...verdict, action: "fail", reason: `boot gate timed out after ${Math.round(elapsedMs / 1000)} s — ${verdict.reason}` }, snap, elapsedMs, meshCount };
    }
    await sleep(pollMs);
  }
}

// ── mute ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Is Chrome running with --mute-audio? Browser.getBrowserCommandLine (works only with --enable-automation).
 * @param {object} browser Playwright Browser (connectOverCDP)
 * @returns {Promise<{state: 'verified'|'absent'|'unverified', flags: string[], detail: string}>}
 */
export async function checkBrowserMute(browser) {
  let session = null;
  try {
    if (typeof browser?.newBrowserCDPSession !== "function") return { state: "unverified", flags: [], detail: "no browser-level CDP session" };
    session = await browser.newBrowserCDPSession();
    const r = await session.send("Browser.getBrowserCommandLine");
    const args = Array.isArray(r?.arguments) ? r.arguments.map(String) : [];
    const flags = args.filter((a) => /^--(mute-audio|enable-automation|window-position|window-size|use-angle|use-gl|headless|remote-debugging-port)/.test(a));
    const muted = args.some((a) => a === "--mute-audio" || a.startsWith("--mute-audio="));
    return muted
      ? { state: "verified", flags, detail: "Chrome command line has --mute-audio" }
      : { state: "absent", flags, detail: "Chrome command line has NO --mute-audio" };
  } catch (e) {
    return { state: "unverified", flags: [], detail: `Browser.getBrowserCommandLine unavailable (${firstLine(e?.message ?? e)}); it needs --enable-automation` };
  } finally {
    try {
      await session?.detach?.();
    } catch {
      // ignore
    }
  }
}

/**
 * Runs in the page: silence everything the client can play. Suspends the AudioManager's AudioContext and pins it
 * suspended, disconnects the master bus from the speakers, sets master/effect/ambient to 0, stops playing voices,
 * re-applies all of it when the context is created later (first user gesture), and mutes <audio>/<video>.
 * Every access is typeof-guarded.
 */
export const PAGE_MUTE_FN = () => {
  const out = { audioManager: false, ctxState: null, gains: null, wrapped: false, media: 0, errors: [] };
  const w = typeof window !== "undefined" ? window : null;
  const am = w && w.liveScene3d ? w.liveScene3d.audioManager : null;
  const muteNow = (m) => {
    try {
      if (typeof m.pauseAll === "function") m.pauseAll();
    } catch (e) {
      out.errors.push(`pauseAll: ${e && e.message}`);
    }
    for (const k of ["setMasterGain", "setEffectGain", "setAmbientGain"]) {
      try {
        if (typeof m[k] === "function") m[k](0);
      } catch (e) {
        out.errors.push(`${k}: ${e && e.message}`);
      }
    }
    const ctx = m._ctx;
    if (ctx) {
      try {
        if (m._master && typeof m._master.disconnect === "function" && ctx.destination) m._master.disconnect(ctx.destination);
      } catch (_) {
        // already disconnected
      }
      try {
        if (typeof ctx.suspend === "function" && ctx.state !== "closed") {
          const p = ctx.suspend();
          if (p && typeof p.catch === "function") p.catch(() => {});
        }
      } catch (e) {
        out.errors.push(`suspend: ${e && e.message}`);
      }
      try {
        if (!ctx.__filmMuted) {
          ctx.__filmMuted = true;
          ctx.resume = () => Promise.resolve();
        }
      } catch (_) {
        // read-only: the gains and the disconnect still hold
      }
    }
  };
  if (am) {
    out.audioManager = true;
    muteNow(am);
    try {
      if (!am.__filmMuteWrapped && typeof am._initContext === "function") {
        const orig = am._initContext;
        am._initContext = function filmMutedInitContext(...a) {
          const r = orig.apply(this, a);
          try {
            muteNow(this);
          } catch (_) {
            // best effort
          }
          return r;
        };
        am.__filmMuteWrapped = true;
      }
    } catch (e) {
      out.errors.push(`wrap: ${e && e.message}`);
    }
    out.wrapped = am.__filmMuteWrapped === true;
    out.ctxState = am._ctx ? String(am._ctx.state) : "none";
    out.gains = {
      master: typeof am._masterGainValue === "number" ? am._masterGainValue : null,
      effect: typeof am._effectGainValue === "number" ? am._effectGainValue : null,
      ambient: typeof am._ambientGainValue === "number" ? am._ambientGainValue : null,
    };
  }
  try {
    if (typeof document !== "undefined" && document && typeof document.querySelectorAll === "function") {
      for (const el of document.querySelectorAll("audio,video")) {
        try {
          el.muted = true;
          if (typeof el.pause === "function") el.pause();
          out.media++;
        } catch (_) {
          // keep going
        }
      }
    }
  } catch (_) {
    // no DOM
  }
  return out;
};

/** Mute the page (PAGE_MUTE_FN) — returns its report. */
export function mutePage(page) {
  return evaluateWithTimeout(page, PAGE_MUTE_FN, undefined, { timeoutMs: 15_000, what: "page mute" });
}

// ── window / GPU / viewport ────────────────────────────────────────────────────────────────────────────────

/**
 * The page's browser window bounds (Browser.getWindowForTarget) and whether it is off-screen
 * (left or top ≤ −10000, or minimised).
 * @param {object} context Playwright BrowserContext
 * @param {object} page
 * @returns {Promise<{ok: boolean, bounds?: object, windowId?: number, offScreen?: boolean, detail?: string}>}
 */
export async function windowInfo(context, page) {
  let s = null;
  try {
    s = await context.newCDPSession(page);
    const r = await s.send("Browser.getWindowForTarget");
    const b = r?.bounds ?? {};
    const offScreen = (Number(b.left) <= -10000) || (Number(b.top) <= -10000) || b.windowState === "minimized";
    return { ok: true, windowId: r?.windowId, bounds: b, offScreen };
  } catch (e) {
    return { ok: false, detail: `Browser.getWindowForTarget failed: ${firstLine(e?.message ?? e)}` };
  } finally {
    try {
      await s?.detach?.();
    } catch {
      // ignore
    }
  }
}

/** Runs in the page: the WebGL renderer string (the live renderer's context when there is one). */
export const GPU_RENDERER_FN = () => {
  const read = (gl) => {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)),
      vendor: String(ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR)),
    };
  };
  try {
    const r = typeof window !== "undefined" && window.liveScene3d ? window.liveScene3d.renderer : null;
    const gl = r && typeof r.getContext === "function" ? r.getContext() : null;
    if (gl && typeof gl.getExtension === "function") return { ...read(gl), source: "liveScene3d.renderer" };
  } catch (_) {
    // fall through to a scratch context
  }
  try {
    if (typeof document === "undefined") return { renderer: null, vendor: null, source: "none", error: "no document" };
    const c = document.createElement("canvas");
    const gl = c.getContext("webgl2") || c.getContext("webgl");
    if (!gl) return { renderer: null, vendor: null, source: "none", error: "WebGL unavailable" };
    const out = { ...read(gl), source: "scratch canvas" };
    const lose = gl.getExtension("WEBGL_lose_context");
    if (lose) lose.loseContext();
    return out;
  } catch (e) {
    return { renderer: null, vendor: null, source: "none", error: String((e && e.message) || e) };
  }
};

/**
 * Emulation.setDeviceMetricsOverride {width, height, deviceScaleFactor: 1, mobile: false} on a CDP session that
 * stays attached for this process (the override ends with the session).
 * @param {object} context
 * @param {object} page
 * @param {{width: number, height: number}} size
 * @returns {Promise<object>} the CDP session (keep a reference)
 */
export async function applyViewport(context, page, { width, height }) {
  const s = await context.newCDPSession(page);
  await s.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  return s;
}

/** Runs in the page: remember / read the viewport `boot` chose, so later commands re-apply the same one. */
export const VIEWPORT_MARK_FN = (size) => {
  if (typeof window === "undefined") return null;
  if (size && typeof size === "object") window.__filmCliViewport = { width: size.width, height: size.height };
  const v = window.__filmCliViewport;
  return v && typeof v.width === "number" && typeof v.height === "number" ? { width: v.width, height: v.height } : null;
};

/** Runs in the page: the WebGL canvas drawing-buffer size (null before liveScene3d). */
export const CANVAS_SIZE_FN = () => {
  try {
    const c = typeof window !== "undefined" && window.liveScene3d && window.liveScene3d.renderer ? window.liveScene3d.renderer.domElement : null;
    return c && typeof c.width === "number" ? { width: c.width, height: c.height } : null;
  } catch (_) {
    return null;
  }
};

/**
 * Runs in the page: what `__film.status()` does not report but the eye-test checklist needs — the camera
 * switcher's mode, whether the local avatar carries the film hide term (`entityManager._filmHiddenGuids`, set by
 * `world.avatar(false)`; `visible` = not film-hidden, null when the entity manager is missing) and the WebGL
 * drawing-buffer size (`__renderScaleState().drawingBuffer`, else the renderer canvas). Read-only.
 */
export const FILM_PROBE_FN = () => {
  const w = typeof window !== "undefined" ? window : {};
  const live = w.liveScene3d || null;
  const out = { cameraMode: null, avatar: { guid: null, filmHidden: null, visible: null, filmHiddenCount: null }, canvas: null };
  try {
    const cs = live && live.cameraSwitcher;
    if (cs && cs.mode != null) out.cameraMode = String(cs.mode);
  } catch (_) {
    // no camera switcher yet
  }
  let guid = null;
  const take = (g) => {
    const n = Number(g);
    return Number.isFinite(n) && n !== 0 ? n >>> 0 : null;
  };
  try {
    if (typeof w.getLocalPlayerGuid === "function") guid = take(w.getLocalPlayerGuid());
  } catch (_) {
    guid = null;
  }
  if (guid === null) {
    try {
      const h = (live && live.sessionHandle) || w.__sessionHandle || null;
      if (h && typeof h.playerGuid === "function") guid = take(h.playerGuid());
    } catch (_) {
      guid = null;
    }
  }
  if (guid !== null) out.avatar.guid = `0x${guid.toString(16).toUpperCase().padStart(8, "0")}`;
  try {
    const em = live && live.entityManager;
    if (em && typeof em === "object") {
      const set = em._filmHiddenGuids;
      const isSet = !!set && typeof set.has === "function" && typeof set.size === "number";
      out.avatar.filmHiddenCount = isSet ? set.size : 0;
      out.avatar.filmHidden = isSet ? (guid !== null ? set.has(guid) : set.size > 0) : false;
      out.avatar.visible = !out.avatar.filmHidden;
    }
  } catch (_) {
    // unknown
  }
  try {
    const st = typeof w.__renderScaleState === "function" ? w.__renderScaleState() : null;
    const db = st && st.drawingBuffer;
    if (Array.isArray(db) && db.length === 2) out.canvas = { width: Number(db[0]), height: Number(db[1]), source: "__renderScaleState" };
  } catch (_) {
    out.canvas = null;
  }
  if (!out.canvas) {
    try {
      const c = live && live.renderer ? live.renderer.domElement : null;
      if (c && typeof c.width === "number") out.canvas = { width: c.width, height: c.height, source: "renderer.domElement" };
    } catch (_) {
      out.canvas = null;
    }
  }
  return out;
};

/** Runs in the page: forget a stale `__filmJev` binding so the pilot uses its code policy (no key this run). */
export const UNBIND_JEV_FN = () => {
  if (typeof window === "undefined") return false;
  try {
    delete window.__filmJev;
  } catch (_) {
    // non-configurable
  }
  try {
    if (typeof window.__filmJev === "function") window.__filmJev = undefined;
  } catch (_) {
    // read-only
  }
  return typeof window.__filmJev !== "function";
};

/** Runs in the page: is the portal tunnel up? (null when the client lacks the probe) */
export const PORTAL_ACTIVE_FN = () => {
  try {
    const w = typeof window !== "undefined" ? window : globalThis;
    return typeof w.__isPortalSpaceActive === "function" ? !!w.__isPortalSpaceActive() : null;
  } catch (_) {
    return null;
  }
};

// ── teleport + readiness ───────────────────────────────────────────────────────────────────────────────────

/**
 * Landblock key of a cell/landblock id ("0xA9B40019", "A9B4", 0x01F60289 …): `(id & 0xFFFF0000) >>> 0`; a bare
 * 4-hex-digit landblock "0xA9B4" is shifted into place.
 * @param {string|number} id
 * @returns {number|null}
 */
export function lbKeyOfId(id) {
  if (typeof id === "number" && Number.isFinite(id)) return (id & 0xffff0000) >>> 0;
  const s = String(id ?? "").trim().replace(/^\[|\]$/g, "");
  const m = /^(?:0x)?([0-9a-f]{1,8})$/i.exec(s);
  if (!m) return null;
  const hex = m[1];
  const n = parseInt(hex, 16) >>> 0;
  return hex.length <= 4 ? ((n << 16) >>> 0) : ((n & 0xffff0000) >>> 0);
}

/**
 * Readiness targets of a gazetteer site (sites/build.mjs Site), derived from the destination the site's
 * `teleport.best` actually reaches, never from its kind or map position (a town or POI whose exact destination is
 * an EnvCell — Kor-Gursha, Northwatch Castle … — still needs the interior gate):
 *   - `teleport.best` is `@teleloc <cell> …` → readyTargetsForCommand(best) (the cell teleported to);
 *   - else lbKeys = [lb << 16] (or the cell's landblock) and interiorLb = that key when `site.cell` is an EnvCell
 *     ((cell & 0xFFFF) ≥ 0x100), or — with no cell (@teledungeon / @tele / @telepoi sites) — when `site.indoor`.
 * The plan compiler (plan/schema.mjs) derives interiorLb from the cell the same way.
 * @param {{lb?: string, cell?: string|null, indoor?: boolean, map?: object|null, kind?: string,
 *   teleport?: {best?: string}}} site
 * @returns {{lbKeys: number[], interiorLb: number|null}}
 */
export function readyTargetsForSite(site) {
  const best = typeof site?.teleport?.best === "string" ? site.teleport.best.trim() : "";
  if (/^@teleloc\s/i.test(best)) {
    const r = readyTargetsForCommand(best);
    if (r.lbKeys.length) return r;
  }
  const key = site?.lb != null ? ((parseInt(String(site.lb), 16) << 16) >>> 0) : site?.cell ? lbKeyOfId(site.cell) : null;
  if (key === null || !Number.isFinite(key)) return { lbKeys: [], interiorLb: null };
  const cell = cellNumberOf(site.cell);
  const interior = cell !== null ? (cell & 0xffff) >= 0x100 : site.indoor === true;
  return { lbKeys: [key], interiorLb: interior ? key : null };
}

// A full 8-hex-digit cell id ("0x01F60289", "[01F60289]", 0x01F60289) → uint32; anything else → null.
function cellNumberOf(id) {
  if (typeof id === "number") return Number.isFinite(id) ? id >>> 0 : null;
  const m = /^(?:0x)?([0-9a-f]{5,8})$/i.exec(String(id ?? "").trim().replace(/^\[|\]$/g, ""));
  return m ? parseInt(m[1], 16) >>> 0 : null;
}

/**
 * Readiness targets of an admin command: `@teleloc <cell> …` names the cell (interiorLb when it is an EnvCell);
 * other commands (@telepoi, @tele …) do not, so the page gate runs on the player's landblock.
 * @param {string} cmd
 * @returns {{lbKeys: number[], interiorLb: number|null}}
 */
export function readyTargetsForCommand(cmd) {
  const m = /^@teleloc\s+(\[?(?:0x)?[0-9a-f]{1,8}\]?)/i.exec(String(cmd ?? "").trim());
  if (!m) return { lbKeys: [], interiorLb: null };
  const raw = m[1].replace(/^\[|\]$/g, "").replace(/^0x/i, "");
  const cell = parseInt(raw, 16) >>> 0;
  const key = (cell & 0xffff0000) >>> 0;
  const indoor = (cell & 0xffff) >= 0x100;
  return { lbKeys: [key], interiorLb: indoor ? key : null };
}

/**
 * Teleport the hidden player and wait until the destination is ready to film:
 * `__film.world.teleport(cmd)` → wait for the portal tunnel to come up (≤ portalStartMs) and to end → poll
 * `__film.world.ready(ready)` until `ok` or the deadline. Never records anything.
 * @param {object} page
 * @param {{teleport: string, ready?: {lbKeys?: number[], interiorLb?: number|null, settleSec?: number,
 *   timeoutSec?: number}, timeoutSec?: number, portalStartMs?: number, pollMs?: number,
 *   now?: () => number, sleep?: (ms: number) => Promise<void>, log?: (msg: string) => void}} o
 * @returns {Promise<{ok: boolean, elapsedMs: number, report: object|null, portal: {sawActive: boolean, activeMs: number}, polls: number}>}
 */
export async function goAndWait(page, o) {
  const { teleport, ready = {}, portalStartMs = 6000, pollMs = 1000, log } = o;
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (typeof teleport !== "string" || !teleport.trim().startsWith("@")) {
    throw new FilmCliError(`teleport commands must start with '@' (got '${teleport}')`, { exitCode: EXIT.USAGE, code: "BAD_COMMAND" });
  }
  const timeoutSec = Number.isFinite(o.timeoutSec) ? o.timeoutSec : Number.isFinite(ready.timeoutSec) ? ready.timeoutSec : 90;
  const t0 = now();
  const deadline = t0 + timeoutSec * 1000;
  await filmCall(page, "world.teleport", teleport.trim());
  log?.(`teleport sent: ${teleport.trim()}`);
  // Portal tunnel: wait for it to start (a same-landblock hop may never show it), then for it to end.
  let sawActive = false;
  let activeFrom = null;
  const startBy = now() + portalStartMs;
  for (;;) {
    const a = await evaluateWithTimeout(page, PORTAL_ACTIVE_FN, undefined, { timeoutMs: 15_000, what: "portal probe" });
    if (a === null) break;
    if (a === true && !sawActive) {
      sawActive = true;
      activeFrom = now();
    }
    if (a === false && (sawActive || now() >= startBy)) break;
    if (now() >= deadline) break;
    await sleep(250);
  }
  const portal = { sawActive, activeMs: sawActive ? now() - activeFrom : 0 };
  if (sawActive) log?.(`portal space ended after ${(portal.activeMs / 1000).toFixed(1)} s`);
  let report = null;
  let polls = 0;
  for (;;) {
    const remaining = Math.max(1, Math.ceil((deadline - now()) / 1000));
    const req = { ...ready, timeoutSec: Math.min(remaining, Number.isFinite(ready.timeoutSec) ? ready.timeoutSec : remaining) };
    report = await filmCallWith(page, { soft: true, timeoutMs: (req.timeoutSec + 30) * 1000 }, "world.ready", req);
    polls++;
    if (report && report.ok === true) return { ok: true, elapsedMs: now() - t0, report, portal, polls };
    if (report && report.ok === false && report.error !== undefined && report.checks === undefined) {
      throw new FilmCliError(`__film.world.ready failed: ${typeof report.error === "string" ? report.error : JSON.stringify(report.error)}`, {
        exitCode: report.code === "NO_FILM" || report.code === "NO_METHOD" ? EXIT.USAGE : EXIT.FINDING,
        code: report.code ?? "READY_FAILED",
      });
    }
    if (now() >= deadline) return { ok: false, elapsedMs: now() - t0, report, portal, polls };
    await sleep(pollMs);
  }
}
