// scripts/shell_gate.cjs — should the public front serve the BUNDLED page?
//
// WHY (2026-10-06): a cold boot of the unbundled page is ~376 module requests
// (3.95 MB gzip, comments and all); the T11 bundle (scripts/build-shell.mjs)
// carries the same app in a handful of files at ~1.1 MB gzip — ~3 MB / ~35 s
// less at 666 kbps, and ~370 fewer requests on a high-latency link. It existed
// since 2026-08-09 but players never got it: it lived at index-bundled.html,
// went stale with every source edit, and nothing pointed at it.
//
// This gate lets proxy.cjs (the tunnel-facing front) answer a request for
// /apps/holtburger-web/index.html with the bundled page — ONLY while the bundle
// is provably current: shell-manifest.json records a sha256 of every source
// file the bundle was built from, and each is re-checked (stat-memoised, so a
// re-hash happens only when a file's mtime/size moved). A stale or missing
// bundle is NEVER served: the request gets the live unbundled page (correct,
// just heavier) and a background rebuild is scheduled once the sources have
// been quiet for `quietMs` (an agent mid-edit does not trigger a build per
// save). Escapes: `?shell=off` per request, HB_SHELL=off for the process,
// HB_SHELL_AUTOBUILD=0 to never rebuild. The dev server (serve.py :8765)
// is untouched — it always serves the live tree.

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const INDEX_PATHS = new Set(["/apps/holtburger-web/index.html", "/apps/holtburger-web/"]);
const BUNDLED_PATH = "/apps/holtburger-web/index-bundled.html";

function createShellGate(opts = {}) {
  const appRoot = opts.appRoot;
  const holtRoot = opts.holtRoot || path.resolve(appRoot, "..", "..");
  const env = opts.env || process.env;
  const disabled = String(env.HB_SHELL || "").toLowerCase() === "off";
  const autoBuild = opts.autoBuild ?? String(env.HB_SHELL_AUTOBUILD ?? "1") !== "0";
  const quietMs = opts.quietMs ?? 10000;
  const cacheMs = opts.cacheMs ?? 1500;
  const log = opts.log || ((m) => console.log(`[shell-gate] ${m}`));
  const now = opts.now || Date.now;
  const runBuild = opts.runBuild || defaultRunBuild;

  const manifestPath = path.join(appRoot, "shell-manifest.json");
  const bundledHtml = path.join(appRoot, "index-bundled.html");
  let manifest = { mtimeMs: -1, data: null };
  const memo = new Map(); // rel -> { mtimeMs, size, sha }
  let cached = null; // { at, result }
  let building = false;
  let buildTimer = null;
  const stats = { checks: 0, bundled: 0, unbundled: 0, builds: 0, buildFailures: 0, lastReason: null, lastBuildMs: null };

  function readManifest() {
    let st;
    try { st = fs.statSync(manifestPath); } catch { manifest = { mtimeMs: -1, data: null }; return null; }
    if (st.mtimeMs !== manifest.mtimeMs) {
      try { manifest = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(manifestPath, "utf8")) }; }
      catch { manifest = { mtimeMs: st.mtimeMs, data: null }; }
    }
    return manifest.data;
  }

  /** sha256 of an app-relative file, or null if it is gone. */
  function fileSha(rel) {
    const abs = path.join(appRoot, rel);
    let st;
    try { st = fs.statSync(abs); } catch { memo.delete(rel); return { sha: null, mtimeMs: 0 }; }
    const m = memo.get(rel);
    if (m && m.mtimeMs === st.mtimeMs && m.size === st.size) return m;
    const sha = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    const rec = { mtimeMs: st.mtimeMs, size: st.size, sha };
    memo.set(rel, rec);
    return rec;
  }

  /** { fresh, reason, newestChangeMs } — memoised for `cacheMs`. */
  function check() {
    const t = now();
    if (cached && t - cached.at < cacheMs) return cached.result;
    stats.checks += 1;
    let result;
    const m = readManifest();
    if (!fs.existsSync(bundledHtml) || !m) {
      result = { fresh: false, reason: "not built", newestChangeMs: 0 };
    } else if (!m.inputs || typeof m.inputs !== "object" || !Object.keys(m.inputs).length) {
      result = { fresh: false, reason: "manifest has no inputs (pre-2026-10-06 build)", newestChangeMs: 0 };
    } else if (!m.entries?.app?.file || !fs.existsSync(path.join(appRoot, "shell", m.entries.app.file))) {
      result = { fresh: false, reason: "app bundle file missing", newestChangeMs: 0 };
    } else {
      result = { fresh: true, reason: "fresh", newestChangeMs: 0 };
      for (const [rel, sha] of Object.entries(m.inputs)) {
        const cur = fileSha(rel);
        if (cur.sha !== sha) {
          if (result.fresh) result = { fresh: false, reason: `changed: ${rel}`, newestChangeMs: 0 };
          result.newestChangeMs = Math.max(result.newestChangeMs, cur.mtimeMs || t);
        }
      }
    }
    cached = { at: t, result };
    stats.lastReason = result.reason;
    return result;
  }

  function scheduleBuild(result) {
    if (!autoBuild || building || buildTimer) return;
    // Clamped: a future-dated mtime (clock skew, restored backup) must not
    // park the rebuild for hours — at worst it waits six quiet periods.
    const wait = Math.min(quietMs * 6, Math.max(0, (result.newestChangeMs || 0) + quietMs - now()));
    buildTimer = setTimeout(() => {
      buildTimer = null;
      cached = null;
      const again = check();
      if (again.fresh) return;
      // Sources still moving? Wait for them to settle (bounded: a file whose
      // mtime sits in the future is treated as settled after the clamp).
      const age = now() - (again.newestChangeMs || 0);
      if (again.newestChangeMs && age >= 0 && age < quietMs) { scheduleBuild(again); return; }
      building = true;
      const t0 = now();
      log(`rebuilding the shell bundle (${again.reason})`);
      runBuild({ holtRoot }, (ok, detail) => {
        building = false;
        cached = null;
        stats.lastBuildMs = now() - t0;
        if (ok) { stats.builds += 1; log(`shell bundle rebuilt in ${stats.lastBuildMs} ms`); }
        else { stats.buildFailures += 1; log(`shell rebuild FAILED (serving unbundled): ${String(detail).slice(0, 300)}`); }
      });
    }, wait);
    if (typeof buildTimer.unref === "function") buildTimer.unref();
  }

  /**
   * @param {string} reqUrl raw request URL (path + query)
   * @returns {null | { serveBundled: boolean, path: string, reason: string }}
   *   null when the request is not for the app's index page.
   */
  function decide(reqUrl) {
    let u;
    try { u = new URL(reqUrl, "http://x"); } catch { return null; }
    if (!INDEX_PATHS.has(u.pathname)) return null;
    const off = disabled || String(u.searchParams.get("shell") || "").toLowerCase() === "off";
    if (off) {
      stats.unbundled += 1;
      return { serveBundled: false, path: reqUrl, reason: disabled ? "HB_SHELL=off" : "shell=off" };
    }
    const c = check();
    if (!c.fresh) {
      stats.unbundled += 1;
      scheduleBuild(c);
      return { serveBundled: false, path: reqUrl, reason: c.reason };
    }
    stats.bundled += 1;
    return { serveBundled: true, path: BUNDLED_PATH + u.search, reason: "fresh" };
  }

  function dispose() {
    if (buildTimer) clearTimeout(buildTimer);
    buildTimer = null;
  }

  return { decide, check, stats, dispose, _memo: memo };
}

function defaultRunBuild({ holtRoot }, done) {
  // Niced + idle IO class: this laptop has 8 GB and the build is a background
  // courtesy (≈240 MB peak, ≈2 s), never something that should compete with a
  // session.
  const args = ["-n", "15", "ionice", "-c3", process.execPath, path.join(holtRoot, "scripts", "build-shell.mjs"), "--quiet"];
  let err = "";
  let child;
  try {
    child = spawn("nice", args, { cwd: holtRoot, stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) {
    done(false, e.message);
    return;
  }
  child.stderr.on("data", (d) => { err += d; });
  child.on("error", (e) => done(false, e.message));
  child.on("exit", (code) => done(code === 0, err || `exit ${code}`));
}

module.exports = { createShellGate, INDEX_PATHS, BUNDLED_PATH };
