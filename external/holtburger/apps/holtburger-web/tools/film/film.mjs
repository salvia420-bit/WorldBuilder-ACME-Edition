#!/usr/bin/env node
// tools/film/film.mjs — the AC Film Mode command line (SPEC §5).
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF) records cinematic footage of Asheron's Call in holtburger-web with no
// one at the controls. A Claude Code session (the owner's subscription — this code makes NO Anthropic API calls)
// is the director: it turns a pasted script into plan.json, analyses the song, picks sites, and drives the page
// through THIS CLI. JEV (TypeSafe's System-One decision model on OpenRouter) is the only metered API: the camera
// pilot's reflexes, reached from the page through window.__filmJev, which this CLI installs with Playwright
// exposeFunction so the key never leaves Node. The browser is the off-screen, muted test Chrome on the GTX-1070
// box (owner baseline GPU, used by a person), reached over CDP at http://127.0.0.1:9333; the CLI attaches,
// never launches. No sound may reach the 1070's user: `boot` refuses to log in unless --mute-audio is verified
// (or --assume-muted) and also silences the page's own audio graph.
//
// WHAT (subcommands; every one takes --help and --json: machine output on stdout, human logs on stderr)
//   doctor                    node ≥ 20, ffmpeg encoders/demuxers, playwright-core, CDP (unreachable → the full
//                             three-forward ssh tunnel line), JEV key (+ --ping), gazetteer, free disk
//   project init <name>       <root>/<name>/{script.txt, plan.json, project.json, song/, takes/, stills/,
//                             reports/, edit/} (root /mnt/wbterminal2/film-projects); never overwrites
//   techniques                technique catalog (scene3d/film/shots) [--family=classic|drone|fpv]
//   song analyze <audio>      tempo, beats, bars, sections, lyrics → song.json [--lyrics=<lrc|txt>] [--out]
//   sites build|search|show   the site gazetteer (tools/film/sites)
//   plan validate|compile     plan.json → errors/warnings | timeline.json + shoot-time estimate
//   jev ping|decide           one tiny decision | an arbitrary typed decision (never prints the key or state)
//   jev task <kind>           pick | keep | site-fit | family (lib/jev_tasks.mjs; no key → the code verdict)
//   browser check             attach over CDP: pages, film page, mute, window position, GPU
//   boot                      open + log in the film page, gate on in-world/ready, clean frame, hide player
//   status                    __film.status() + camera/avatar/canvas probe; --release | --own | --clean | --avatar
//   go <site|@command>        teleport the hidden player, wait for the readiness gate
//   scout <timeline> --shot   candidate cameras + stills (+ --pick via JEV)
//   rehearse <timeline> --shot  stepped dry run → realised table + pilot telemetry
//   shoot <timeline>          walk the schedule site by site, record, drain, mux, judge, retake
//   assemble <timeline>       takes → edit/final.mp4 (+ --edl CMX3600)
//   contact-sheet <video>     a 4×4 JPEG grid for the director to Read
//   run <project-dir>         validate → compile → boot-check → shoot --all → assemble → contact-sheet
//                             (--song-analysis → plan steps, --song-audio → assemble)
//
// Exit codes: 0 ok · 1 finding (validation failure, take rejected, check failed) · 2 usage or environment.
//
// Machine rules (~/CLAUDE.md, laptop = 8 GB): every Chrome-driving command (browser check, boot, status, go, scout,
// rehearse, shoot, run) and the laptop-side encode (assemble) hold harness/lib/heavy_lock.mjs acquireHeavyLock
// for their whole run and wait for ≥ 2.5 GB available. The browser itself is remote, but the laptop still runs
// the driver and the encodes, and the 1070's GPU is the owner's shared baseline, so film work never overlaps
// another heavy job. The password (env FILM_PASSWORD, preferred, or --password) and the JEV key are scrubbed from
// every byte this CLI writes (stdout, stderr, reports, logs, and the heavy-lock owner record, which gets a scrubbed
// command line). A --password=… argument is still visible in ps / /proc/<pid>/cmdline while the command runs.
//
// Connection facts: CDP Emulation overrides and Playwright exposeFunction bindings belong to the connection that
// made them and end when this process exits. So `boot` sets the viewport and installs the broker BEFORE it
// navigates (exposeFunction survives navigations), and every later page-driving command re-applies the viewport
// (`boot` leaves the size in window.__filmCliViewport) and re-installs the broker before its takes; without a JEV
// key the stale binding is removed so the pilot flies its code policy.
//
// USAGE
//   node tools/film/film.mjs doctor [--cdp=http://127.0.0.1:9333] [--ping] [--offline]
//   node tools/film/film.mjs project init my-video
//   FILM_PASSWORD=… node tools/film/film.mjs boot --assume-muted
//   node tools/film/film.mjs shoot /mnt/wbterminal2/film-projects/my-video/timeline.json --all
//   node tools/film/film.mjs <command> --help
//
// Programmatic: `import {main} from "./film.mjs"; await main(argv, deps)` — deps = {chromium, spawn, fs, env,
// now, sleep, log, stdout, stderr, fetch, acquireHeavyLock, registry, resolvePlaywright, createJevClient, home,
// versions}; everything defaults to the real thing, tests inject fakes.

import { spawn as nodeSpawn } from "node:child_process";
import nodeFs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  EXIT,
  FilmCliError,
  boolArg,
  createIo,
  createScrubber,
  findingError,
  jsonReplacer,
  numArg,
  parseArgs,
  redactUrl,
  strArg,
  usageError,
} from "./lib/args.mjs";
import { contactSheetArgv } from "./lib/contact_sheet.mjs";
import { ffprobeFrameCount, parseFfmpegList, resolveFfmpeg, resolveFfprobe, runFfmpeg, runProcess } from "./lib/ffmpeg.mjs";
import { JevError, createJevClient, redactKey, resolveJevKey, summarizeAnswers, validateQuestions } from "./lib/jev.mjs";
import { createJevBroker } from "./lib/jev_broker.mjs";
import { energyWordOf, jevPing, keepOrRetake, pickCandidate, scoreSiteForLine, sectionTechniqueFamily, tempoWordOf } from "./lib/jev_tasks.mjs";
import { DEFAULT_PROJECT_ROOT, appendJsonl, initProject, jsonOrFile, projectDirFor, projectPaths, readJsonFile, writeJsonFile } from "./lib/project.mjs";
import {
  BOOT_SNAPSHOT_FN,
  CANVAS_SIZE_FN,
  DEFAULT_ACCOUNT,
  DEFAULT_BASE_URL,
  DEFAULT_BOOT_TIMEOUT_SEC,
  DEFAULT_1070_HOST,
  DEFAULT_CDP,
  FILM_PROBE_FN,
  GPU_RENDERER_FN,
  UNBIND_JEV_FN,
  VIEWPORT_MARK_FN,
  applyViewport,
  buildFilmUrl,
  checkBrowserMute,
  classifyBoot,
  connect,
  evaluateWithTimeout,
  filmCall,
  filmCallWith,
  goAndWait,
  isFilmUrl,
  mutePage,
  readyTargetsForCommand,
  readyTargetsForSite,
  tunnelCommand,
  waitForBoot,
  windowInfo,
} from "./lib/session.mjs";
import { DECIDE_OPTIONS, judgeInput, rehearseShot, selectSchedule, shootSchedule } from "./lib/shoot.mjs";
import { analyzeSongFile, formatSongSummary } from "./audio/analyze.mjs";
import { compilePlan, estimateShootTime } from "./plan/compile.mjs";
import { assemblyArgv, buildAssembly, toCmx3600 } from "./plan/edl.mjs";
import { validatePlan } from "./plan/schema.mjs";
import { DEFAULT_GAZETTEER_PATH, DEFAULT_PATHS, buildGazetteer, writeGazetteer } from "./sites/build.mjs";
import { expandQuery, explainSite, loadGazetteer, searchSites, siteWords } from "./sites/search.mjs";
import { formatMap, worldFromLocal, worldToMap } from "../../scene3d/film/core/units.js";

export { buildFilmUrl, redactUrl, parseArgs };

/** CLI version (bumped when a subcommand's output contract changes). */
export const FILM_CLI_VERSION = 1;

// ── dependencies ──────────────────────────────────────────────────────────────────────────────────────────

function defaultResolvePlaywright() {
  return createRequire(import.meta.url).resolve("playwright-core");
}

function withDefaults(deps = {}) {
  return {
    chromium: deps.chromium ?? null,
    spawn: deps.spawn ?? nodeSpawn,
    fs: deps.fs ?? nodeFs,
    env: deps.env ?? process.env,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    log: typeof deps.log === "function" ? deps.log : null,
    stdout: deps.stdout ?? process.stdout,
    stderr: deps.stderr ?? process.stderr,
    fetch: deps.fetch ?? globalThis.fetch,
    acquireHeavyLock: deps.acquireHeavyLock ?? null,
    registry: deps.registry ?? null,
    resolvePlaywright: deps.resolvePlaywright ?? defaultResolvePlaywright,
    createJevClient: deps.createJevClient ?? createJevClient,
    home: deps.home,
    versions: deps.versions ?? process.versions,
    cwd: deps.cwd ?? process.cwd(),
  };
}

// ── shared helpers ────────────────────────────────────────────────────────────────────────────────────────

function resolvePathArg(ctx, p) {
  return path.resolve(ctx.deps.cwd, String(p));
}

// Inline JSON, or a path resolved against the CLI's cwd.
function jsonArg(ctx, key, what) {
  const v = strArg(ctx.args, key, null);
  if (v === null) throw usageError(`--${key}=<file|json> is required`);
  const s = v.trim();
  return jsonOrFile(s.startsWith("{") || s.startsWith("[") ? s : resolvePathArg(ctx, s), { fs: ctx.deps.fs, what });
}

// The project a timeline belongs to: --project, else the timeline's directory.
function projectOf(ctx, timelineFile) {
  const explicit = strArg(ctx.args, "project", null);
  return projectPaths(projectDirFor(resolvePathArg(ctx, timelineFile), explicit ? resolvePathArg(ctx, explicit) : null));
}

async function loadRegistry(ctx) {
  if (ctx.deps.registry) return ctx.deps.registry;
  const m = await import("../../scene3d/film/shots/index.js");
  return { getTechnique: m.getTechnique, buildShot: m.buildShot, listTechniques: m.listTechniques };
}

// The plan schema treats an injected registry as authoritative (unknown ids = errors). While the technique lanes
// have not filled classic.js / drone.js the registry is empty, so fall back to the SPEC §2.12 id list (warnings).
async function planRegistry(ctx) {
  const reg = await loadRegistry(ctx);
  let n = 1;
  try {
    n = typeof reg.listTechniques === "function" ? reg.listTechniques().length : 1;
  } catch {
    n = 1;
  }
  if (n === 0) {
    ctx.io.warn("the technique registry is empty (scene3d/film/shots/classic.js and drone.js are not filled yet) — technique ids are checked against the SPEC §2.12 catalogue only");
    return null;
  }
  return reg;
}

/** `--name=value` argv entries whose value is a secret: the value becomes [redacted] in the heavy-lock record. */
const SECRET_ARGV_RE = /^(--(?:password|pass|pw|token|key|api-key|apikey|secret)=)[\s\S]*$/i;

/**
 * This process's argv with every secret removed: `--password=…` (and the like) → `--password=[redacted]`, then the
 * CLI scrubber (registered secrets such as FILM_PASSWORD or the JEV key, and URL `password=` values).
 * @param {{io: {scrub: (t: unknown) => string}}} ctx
 * @param {string[]} [argv]
 * @returns {string[]}
 */
export function scrubbedArgv(ctx, argv = process.argv) {
  return argv.map((a) => ctx.io.scrub(String(a).replace(SECRET_ARGV_RE, "$1[redacted]")));
}

async function withLock(ctx, label, fn) {
  const acquire = ctx.deps.acquireHeavyLock ?? (await import("../../harness/lib/heavy_lock.mjs")).acquireHeavyLock;
  // heavy_lock writes owner.json (in /tmp/hb-heavy.lock, readable by every local user, left behind when the job is
  // killed) with a `cmd` built from process.argv when it takes the lock: hand it an explicit scrubbed `cmd`, and
  // scrub process.argv itself while acquiring (restored right after), so a --password=… value never lands there.
  const clean = scrubbedArgv(ctx);
  const cmd = [path.basename(clean[1] || "film.mjs"), ...clean.slice(2)].join(" ").slice(0, 300);
  const saved = process.argv.slice();
  let hold;
  try {
    for (let i = 0; i < clean.length; i++) if (process.argv[i] !== clean[i]) process.argv[i] = clean[i];
    hold = await acquire({ label: `film ${label}`, cmd, env: ctx.deps.env, log: (m) => ctx.io.info(m) });
  } catch (e) {
    throw new FilmCliError(`heavy-job lock: ${e?.message ?? e}`, { exitCode: EXIT.USAGE, code: e?.code ?? "HEAVY_LOCK" });
  } finally {
    for (let i = 0; i < saved.length; i++) if (process.argv[i] !== saved[i]) process.argv[i] = saved[i];
  }
  try {
    return await fn(hold);
  } finally {
    try {
      hold?.release?.();
    } catch {
      // released on exit anyway
    }
  }
}

async function withSession(ctx, fn) {
  const s = await connect({ cdp: strArg(ctx.args, "cdp", DEFAULT_CDP), chromium: ctx.deps.chromium ?? undefined });
  try {
    return await fn(s);
  } finally {
    await s.close();
  }
}

function requireFilmPage(s) {
  if (!s.page) {
    throw usageError(`no film page is open in the Chrome at ${s.cdp} (no URL with filmMode=on) — run \`film boot\` first`);
  }
  return s.page;
}

// --width / --height of a viewport: an even integer (the recorder encodes H.264/VP9 4:2:0, and ffmpeg's libx264
// yuv420p refuses odd sizes), like the plan schema's format.width/height.
function evenSizeArg(args, key, def, max) {
  const v = numArg(args, key, def, { integer: true, min: 16, max });
  if (v !== null && v % 2 !== 0) throw usageError(`--${key} must be even (H.264 4:2:0) — got ${v}`);
  return v;
}

// Re-apply the viewport `boot` chose (or --width/--height): the override ended with boot's CDP connection.
// `forTakes` warns when there is nothing to re-apply (the canvas would follow the window size).
async function reapplyViewport(ctx, s, page, { forTakes = false } = {}) {
  let size = null;
  const w = evenSizeArg(ctx.args, "width", null, 7680);
  const h = evenSizeArg(ctx.args, "height", null, 4320);
  if (w && h) size = { width: w, height: h };
  else {
    try {
      size = await evaluateWithTimeout(page, VIEWPORT_MARK_FN, null, { timeoutMs: 15_000, what: "viewport mark" });
    } catch {
      size = null;
    }
  }
  if (size && s.context) {
    ctx.keep.push(await applyViewport(s.context, page, size));
  } else if (forTakes) {
    ctx.io.warn("no viewport to re-apply (the page was not booted by `film boot`): pass --width/--height or the canvas follows the window size");
  }
  return size;
}

function makeJev(ctx) {
  if (ctx.jev !== undefined) return ctx.jev;
  const { deps, args } = ctx;
  const home = deps.home ?? deps.env?.HOME ?? os.homedir();
  const r = resolveJevKey({ env: deps.env, home, fs: deps.fs });
  if (!r.key) {
    ctx.jev = { client: null, source: null, key: null };
    return ctx.jev;
  }
  ctx.io.addSecret(r.key);
  const maxUsdPerHour = numArg(args, "jev-max-usd-per-hour", 2, { min: 0 });
  const maxCallsPerMin = numArg(args, "jev-max-calls-per-min", 600, { min: 0 });
  const client = deps.createJevClient({
    apiKey: r.key,
    fetchFn: deps.fetch,
    budget: { maxUsdPerHour, maxCallsPerMin },
    log: (e) => ctx.event(e),
  });
  ctx.jev = { client, source: r.source, key: r.key };
  return ctx.jev;
}

async function installBroker(ctx, page, { sessionId } = {}) {
  const jev = makeJev(ctx);
  if (!jev.client) {
    try {
      await evaluateWithTimeout(page, UNBIND_JEV_FN, undefined, { timeoutMs: 15_000, what: "unbind __filmJev" });
    } catch {
      // the page bridge times out to the code policy anyway
    }
    ctx.io.info("no JEV key: the pilot flies its code policy (set OPENROUTER_API_KEY or ~/.config/holtburger-film/openrouter.key)");
    return null;
  }
  const broker = createJevBroker({ client: jev.client, page, maxInFlight: 4, sessionId, log: (e) => ctx.event(e) });
  await broker.install();
  broker.setDecideOptions(DECIDE_OPTIONS.stepped);
  ctx.io.info(`JEV broker installed (window.__filmJev; key ${jev.source} ${redactKey(jev.key)})`);
  return broker;
}

function sessionIdFor(label, now) {
  return `film-${label}-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`.slice(0, 200);
}

function readTimeline(ctx, file) {
  if (!file) throw usageError("a timeline.json path is required (from `film plan compile`)");
  const t = readJsonFile(resolvePathArg(ctx, file), { fs: ctx.deps.fs, what: "timeline" });
  if (!t || !Array.isArray(t.items) || !Array.isArray(t.schedule) || !Number.isFinite(t.fps)) {
    throw usageError(`${file} is not a compiled timeline (run \`film plan compile\`)`);
  }
  return t;
}

function findItem(timeline, shotId) {
  if (!shotId || shotId === true) throw usageError("--shot=<id> is required");
  const item = timeline.items.find((i) => i.shotId === shotId);
  if (!item) throw usageError(`no shot '${shotId}' in the timeline (have: ${timeline.items.map((i) => i.shotId).join(", ")})`);
  return item;
}

function loadSites(ctx) {
  const file = resolvePathArg(ctx, strArg(ctx.args, "gazetteer", DEFAULT_GAZETTEER_PATH));
  try {
    return { file, sites: loadGazetteer(file) };
  } catch (e) {
    throw usageError(`cannot read the gazetteer ${file} (${e?.code ?? e?.message ?? e}) — run \`film sites build\` first`);
  }
}

function findSite(sites, id) {
  const exact = sites.find((s) => s.id === id);
  if (exact) return exact;
  const low = String(id).toLowerCase();
  return sites.find((s) => String(s.name).toLowerCase() === low || (s.aliases ?? []).some((a) => String(a).toLowerCase() === low)) ?? null;
}

function hex(n) {
  return n == null ? null : `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
}

function fmtSec(ms) {
  return `${(ms / 1000).toFixed(1)} s`;
}

// Map coordinates as the director reads them ("42.1N, 33.6E", "80.8S, 61.6W"): scene3d/film/core/units.js
// formatMap, the one formatter every CLI line uses. null when the position is unknown.
function mapText(map) {
  if (!map || !Number.isFinite(Number(map.ns)) || !Number.isFinite(Number(map.ew))) return null;
  return formatMap(Number(map.ns), Number(map.ew));
}

// Map position of an OUTDOOR world point [x, y, …] (AC global metres); dungeon coordinates are off the map.
function mapOfWorld(p, indoor) {
  if (indoor || !Array.isArray(p) || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null;
  return mapText(worldToMap(p[0], p[1]));
}

// Map position of an outdoor `@teleloc <cell> <x> <y> …` (cell low word < 0x100); null otherwise.
function mapOfTeleloc(cmd) {
  const m = /^@teleloc\s+\[?(?:0x)?([0-9a-f]{1,8})\]?\s+(-?[\d.]+)\s+(-?[\d.]+)/i.exec(String(cmd ?? "").trim());
  if (!m) return null;
  const cell = parseInt(m[1], 16) >>> 0;
  const x = Number(m[2]);
  const y = Number(m[3]);
  if ((cell & 0xffff) >= 0x100 || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  try {
    return mapOfWorld(worldFromLocal(cell, x, y), false);
  } catch {
    return null;
  }
}

// ── subcommands ───────────────────────────────────────────────────────────────────────────────────────────

const COMMANDS = {};

function command(name, summary, usage, run) {
  COMMANDS[name] = { name, summary, usage, run };
}

command("doctor", "check the toolchain: node, ffmpeg, playwright-core, CDP, JEV key, gazetteer, disk",
  `film doctor [--cdp=${DEFAULT_CDP}] [--ffmpeg=<path>] [--gazetteer=<jsonl>] [--root=<project root>]
            [--min-free-gb=20] [--ping] [--offline] [--host=${DEFAULT_1070_HOST} | env FILM_1070_HOST]
  Required: node ≥ 20, ffmpeg with libx264 and the raw h264 demuxer, playwright-core, CDP (unless --offline),
  a readable JEV key setup (no key is fine: the pilot flies its code policy), free disk. Optional: libvpx-vp9,
  gazetteer. --ping makes ONE tiny JEV decision (≈ $0.000003). Exit 1 when a required check fails.
  CDP unreachable → prints the film tunnel (and --json result.tunnel), all three forwards, for --host:
    ${tunnelCommand()}`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const checks = [];
    const add = (name, ok, detail, required = true) => checks.push({ name, ok: Boolean(ok), required, detail: io.scrub(detail) });
    const nodeV = String(deps.versions?.node ?? "0");
    add("node", Number(nodeV.split(".")[0]) >= 20, `node ${nodeV} (need ≥ 20)`);

    const ffmpeg = resolveFfmpeg(strArg(args, "ffmpeg"), deps.env);
    try {
      const enc = await runProcess(ffmpeg, ["-hide_banner", "-encoders"], { spawn: deps.spawn, timeoutMs: 30_000, what: "ffmpeg -encoders" });
      const names = parseFfmpegList(enc.stdout);
      add("ffmpeg", enc.code === 0, `${ffmpeg} (exit ${enc.code})`);
      add("ffmpeg encoder libx264", names.has("libx264"), names.has("libx264") ? "present" : "missing — takes and the edit are encoded with libx264");
      add("ffmpeg encoder libvpx-vp9", names.has("libvpx-vp9"), names.has("libvpx-vp9") ? "present" : "missing (optional)", false);
      const dem = await runProcess(ffmpeg, ["-hide_banner", "-demuxers"], { spawn: deps.spawn, timeoutMs: 30_000, what: "ffmpeg -demuxers" });
      const d = parseFfmpegList(dem.stdout);
      add("ffmpeg h264 demuxer (Annex-B takes)", d.has("h264"), d.has("h264") ? "present" : "missing — raw .h264 takes cannot be muxed");
      add("ffmpeg ivf demuxer (VP9 fallback)", d.has("ivf"), d.has("ivf") ? "present" : "missing (optional)", false);
    } catch (e) {
      add("ffmpeg", false, e?.message ?? String(e));
    }

    try {
      add("playwright-core", true, `resolvable: ${deps.resolvePlaywright()}`);
    } catch (e) {
      add("playwright-core", false, `not resolvable from tools/film: ${e?.message ?? e}`);
    }

    const cdp = strArg(args, "cdp", DEFAULT_CDP);
    const offline = boolArg(args, "offline");
    const host = strArg(args, "host", null) ?? (typeof deps.env?.FILM_1070_HOST === "string" && deps.env.FILM_1070_HOST.trim() ? deps.env.FILM_1070_HOST.trim() : DEFAULT_1070_HOST);
    const tunnel = tunnelCommand({ host, cdp });
    let cdpOk = false;
    try {
      if (typeof deps.fetch !== "function") throw new Error("no fetch");
      const res = await deps.fetch(`${cdp.replace(/\/+$/, "")}/json/version`, { signal: AbortSignal.timeout(numArg(args, "cdp-timeout", 3, { min: 0.1 }) * 1000) });
      if (!res || !res.ok) throw new Error(`HTTP ${res?.status}`);
      const v = await res.json();
      add("CDP", true, `${cdp}: ${v?.Browser ?? "?"} (protocol ${v?.["Protocol-Version"] ?? "?"})`, !offline);
      cdpOk = true;
    } catch (e) {
      add("CDP", false, `${cdp} unreachable (${e?.cause?.code ?? e?.name ?? ""} ${e?.message ?? e}) — open the film tunnel (all three forwards: CDP in, serve.py :8765 and the ws bridge :8080 out; without -R 8080 the login dies with 'WsTransport ws handshake failed'):\n${" ".repeat(43)}${tunnel}`, !offline);
    }

    try {
      const jev = makeJev(ctx);
      add("JEV key", true, jev.key ? `${jev.source} ${redactKey(jev.key)}` : "none — the pilot flies its code policy (set OPENROUTER_API_KEY or ~/.config/holtburger-film/openrouter.key, mode 600)", false);
      if (boolArg(args, "ping")) {
        if (!jev.client) add("JEV ping", false, "no key to ping with");
        else {
          const r = await jevPing(jev.client);
          add("JEV ping", r.ok, `pYes ${r.pYes.toFixed(3)} · ${r.model ?? "?"} · ${r.ms ?? "?"} ms · $${(r.costUsd ?? 0).toFixed(6)}`);
        }
      }
    } catch (e) {
      add(e instanceof JevError && e.kind !== "config" ? "JEV ping" : "JEV key", false, `${e?.kind ? `${e.kind}: ` : ""}${e?.message ?? e}`);
    }

    const gz = resolvePathArg(ctx, strArg(args, "gazetteer", DEFAULT_GAZETTEER_PATH));
    try {
      const st = deps.fs.statSync(gz);
      add("gazetteer", st.size > 0, `${gz} (${(st.size / 1024).toFixed(0)} KB, ${new Date(st.mtimeMs).toISOString().slice(0, 10)})`, false);
    } catch {
      add("gazetteer", false, `${gz} missing — run \`film sites build\``, false);
    }

    const root = resolvePathArg(ctx, strArg(args, "root", DEFAULT_PROJECT_ROOT));
    const minFreeGb = numArg(args, "min-free-gb", 20, { min: 0 });
    try {
      let p = root;
      while (!deps.fs.existsSync(p) && path.dirname(p) !== p) p = path.dirname(p);
      const sfs = deps.fs.statfsSync(p);
      const freeGb = (Number(sfs.bavail) * Number(sfs.bsize)) / 1024 ** 3;
      add("disk", freeGb >= minFreeGb, `${freeGb.toFixed(1)} GB free at ${p}${p !== root ? ` (for ${root})` : ""} (need ≥ ${minFreeGb} GB)`);
    } catch (e) {
      add("disk", false, `cannot stat ${root}: ${e?.message ?? e}`);
    }

    const failed = checks.filter((c) => c.required && !c.ok);
    const text = checks.map((c) => `${c.ok ? "ok  " : c.required ? "FAIL" : "warn"}  ${c.name.padEnd(36)} ${c.detail}`).join("\n") +
      `\n${failed.length ? `${failed.length} required check(s) failed` : "all required checks passed"}`;
    return { code: failed.length ? EXIT.FINDING : EXIT.OK, data: { checks, failed: failed.map((c) => c.name), ...(cdpOk ? {} : { tunnel }) }, text };
  });

command("project init", "create a project directory tree",
  `film project init <name> [--root=${DEFAULT_PROJECT_ROOT}]
  Creates <root>/<name>/{project.json, script.txt, plan.json, song/, takes/, stills/, reports/, edit/}.
  Refuses (exit 2) when <root>/<name> already exists.`,
  async (ctx) => {
    const name = ctx.args._[2];
    if (!name) throw usageError("project init needs a <name>");
    const root = resolvePathArg(ctx, strArg(ctx.args, "root", DEFAULT_PROJECT_ROOT));
    const r = initProject({ root, name, fs: ctx.deps.fs, now: ctx.deps.now });
    return { code: EXIT.OK, data: r, text: `created ${r.dir}\n  ${[...r.files, ...r.dirs].map((f) => path.relative(r.dir, f) + (r.dirs.includes(f) ? "/" : "")).join("\n  ")}` };
  });

command("techniques", "list the camera techniques (shot grammar)",
  `film techniques [--family=classic|drone|fpv] [--json]
  The catalog the director writes plan.json against (scene3d/film/shots/index.js listTechniques).`,
  async (ctx) => {
    const reg = await loadRegistry(ctx);
    const family = strArg(ctx.args, "family", null);
    let list;
    try {
      list = reg.listTechniques(family ? { family } : {});
    } catch (e) {
      throw usageError(e?.message ?? String(e));
    }
    const lines = list.map((t) => {
      const params = Object.entries(t.params ?? {}).map(([k, p]) => `${k}:${p.type}${p.default !== undefined ? `=${JSON.stringify(p.default)}` : p.required ? "!" : ""}`).join(" ");
      return `${t.id.padEnd(28)} ${t.name ?? ""} — ${t.whenToUse ?? t.description ?? ""}${params ? `\n${" ".repeat(29)}params: ${params}` : ""}`;
    });
    if (!list.length) ctx.io.warn("0 techniques registered (scene3d/film/shots/classic.js and drone.js not filled yet?)");
    return { code: EXIT.OK, data: { count: list.length, family, techniques: list }, text: `${list.length} technique(s)${family ? ` in ${family}` : ""}\n${lines.join("\n")}` };
  });

command("song analyze", "tempo, beats, bars, sections and lyrics of a song",
  `film song analyze <audio> [--lyrics=<file.lrc|file.txt>] [--out=<song.json>] [--ffmpeg=<path>]
  Decodes with ffmpeg (FILM_FFMPEG or /home/wbterminal/bin/ffmpeg), analyses (tools/film/audio/analyze.mjs) and
  writes SongAnalysis v1 JSON (default: song.json next to the audio). A .lrc extension forces LRC lyrics.`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const audio = args._[2];
    if (!audio) throw usageError("song analyze needs an <audio> file");
    const audioPath = resolvePathArg(ctx, audio);
    const lyricsPath = strArg(args, "lyrics", null);
    const out = resolvePathArg(ctx, strArg(args, "out", path.join(path.dirname(audioPath), "song.json")));
    let a;
    try {
      a = await analyzeSongFile(audioPath, {
        lyricsPath: lyricsPath ? resolvePathArg(ctx, lyricsPath) : undefined,
        ffmpeg: strArg(args, "ffmpeg", null) ?? undefined,
        spawnImpl: deps.spawn,
        env: deps.env,
      });
    } catch (e) {
      const msg = e?.message ?? String(e);
      if (/not found — set FILM_FFMPEG/.test(msg) || e?.code === "ENOENT") throw new FilmCliError(msg, { exitCode: EXIT.USAGE, code: "FFMPEG_MISSING" });
      if (/ffmpeg failed|no audio decoded|timed out/.test(msg)) throw findingError(msg, "DECODE_FAILED");
      throw e;
    }
    writeJsonFile(out, a, { fs: deps.fs, scrub: io.scrub });
    const lines = [formatSongSummary(a), `wrote ${out}`];
    if (a.lyrics?.lines?.length) {
      lines.push(`lyrics (${a.lyrics.format}): ${a.lyrics.lines.length} line(s)`);
      for (const s of a.sections) {
        const ls = a.lyrics.lines.filter((l) => l.section === s.i && l.text);
        if (!ls.length) continue;
        lines.push(`  #${s.i} ${s.role} (${ls.length}): ${ls.slice(0, 3).map((l) => `“${l.text}”`).join(" / ")}${ls.length > 3 ? " …" : ""}`);
      }
    }
    return {
      code: EXIT.OK,
      data: { out, durationSec: a.durationSec, tempo: a.tempo, bars: a.bars.length, sections: a.sections, lyricLines: a.lyrics?.lines?.length ?? 0 },
      text: lines.join("\n"),
    };
  });

command("sites build", "build the site gazetteer from the data files",
  `film sites build [--out=${DEFAULT_GAZETTEER_PATH}] [--spawns] [--paths=<sources.json>] [--max-wilderness=400]
  --spawns streams the ACE spawn dump (life stones, portals, statues, shrines …). --paths replaces ALL source
  paths (a JSON object like DEFAULT_PATHS in tools/film/sites/build.mjs; a key left out = that source skipped).`,
  async (ctx) => {
    const { args, io } = ctx;
    const out = resolvePathArg(ctx, strArg(args, "out", DEFAULT_GAZETTEER_PATH));
    const pathsArg = strArg(args, "paths", null);
    const paths = pathsArg ? readJsonFile(resolvePathArg(ctx, pathsArg), { fs: ctx.deps.fs, what: "source paths" }) : DEFAULT_PATHS;
    const { sites, stats } = await buildGazetteer({
      paths,
      includeSpawns: boolArg(args, "spawns"),
      log: (m) => io.info(String(m)),
      maxWilderness: numArg(args, "max-wilderness", 400, { integer: true, min: 0 }),
    });
    const w = writeGazetteer(sites, out, { meta: stats });
    const kinds = {};
    for (const s of sites) kinds[s.kind] = (kinds[s.kind] ?? 0) + 1;
    return { code: EXIT.OK, data: { ...w, kinds, stats }, text: `wrote ${w.count} site(s) to ${w.path} (${(w.bytes / 1024).toFixed(0)} KB): ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}` };
  });

command("sites search", "rank gazetteer sites for a lyric / beat / place query",
  `film sites search "<query>" [--kind=town,dungeon,…] [--indoor | --no-indoor] [--near=<ns>,<ew>,<km>]
                  [--culture=…] [--limit=20] [--gazetteer=<jsonl>]
  Query words expand through tools/film/data/concept_lexicon.json (imagery → AC terrain, features, kinds).`,
  async (ctx) => {
    const { args } = ctx;
    const query = args._.slice(2).join(" ").trim();
    const { sites, file } = loadSites(ctx);
    const opts = { limit: numArg(args, "limit", 20, { integer: true, min: 1, max: 500 }) };
    const kind = strArg(args, "kind", null);
    if (kind) opts.kind = kind.split(",").map((s) => s.trim()).filter(Boolean);
    if (args.indoor !== undefined) opts.indoor = boolArg(args, "indoor");
    const culture = strArg(args, "culture", null);
    if (culture) opts.culture = culture.split(",").map((s) => s.trim());
    const near = strArg(args, "near", null);
    if (near) {
      const [ns, ew, km] = near.split(",").map((x) => Number(x));
      if (!Number.isFinite(ns) || !Number.isFinite(ew)) throw usageError("--near must be <ns>,<ew>[,<km>] (map degrees, N/E positive)");
      opts.near = { ns, ew, radiusKm: Number.isFinite(km) ? km : 5 };
    }
    const results = searchSites(sites, query, opts);
    let concepts = [];
    try {
      concepts = query ? expandQuery(query).concepts.map((c) => ({ id: c.id, matched: c.matched, kinds: c.kinds, look: c.look, techniques: c.techniques })) : [];
    } catch {
      concepts = [];
    }
    const rows = results.map((r) => ({
      score: r.score, id: r.site.id, name: r.site.name, kind: r.site.kind, indoor: Boolean(r.site.indoor), lb: r.site.lb,
      map: r.site.map ?? null, mapText: mapText(r.site.map), teleport: r.site.teleport?.best ?? null, why: r.why,
    }));
    const text = [`${rows.length} result(s) for “${query}” in ${path.basename(file)}`]
      .concat(rows.map((r) => `${String(r.score).padStart(8)}  ${r.id.padEnd(32)} ${r.kind.padEnd(10)} ${r.name}${r.mapText ? ` (${r.mapText})` : ""} — ${r.why.slice(0, 4).join(", ")}`))
      .concat(concepts.length ? [`concepts: ${concepts.map((c) => `${c.id}${c.look ? ` look ${JSON.stringify(c.look)}` : ""}${c.techniques?.length ? ` techniques ${c.techniques.join("/")}` : ""}`).join("; ")}`] : [])
      .join("\n");
    return { code: EXIT.OK, data: { query, gazetteer: file, results: rows, concepts }, text };
  });

command("sites show", "describe one site (words, teleport, readiness targets)",
  `film sites show <site-id | exact name> [--gazetteer=<jsonl>]`,
  async (ctx) => {
    const id = ctx.args._.slice(2).join(" ").trim();
    if (!id) throw usageError("sites show needs a <site-id>");
    const { sites } = loadSites(ctx);
    const site = findSite(sites, id);
    if (!site) throw findingError(`no site '${id}' in the gazetteer — try \`film sites search "${id}"\``, "NO_SITE");
    const ready = readyTargetsForSite(site);
    const map = mapText(site.map);
    const text = [explainSite(site), ...(map ? [`map: ${map}${site.indoor ? " (entrance)" : ""}`] : []), `words: ${siteWords(site).join(", ")}`, `go: film go ${site.id}`,
      `ready: lbKeys ${ready.lbKeys.map(hex).join(", ") || "(player landblock)"}${ready.interiorLb != null ? ` interiorLb ${hex(ready.interiorLb)}` : ""}`].join("\n");
    return { code: EXIT.OK, data: { site, mapText: map, ready, words: siteWords(site) }, text };
  });

function printIssues(list) {
  return list.map((i) => `  ${i.path || "(plan)"}: ${i.message}`).join("\n");
}

function planErrorResult(e) {
  const d = e.details ?? {};
  const lines = [`${e.code}: ${e.message}`];
  if (Array.isArray(d.errors) && d.errors.length) lines.push("errors:", printIssues(d.errors));
  if (Array.isArray(d.warnings) && d.warnings.length) lines.push("warnings:", printIssues(d.warnings));
  if (Array.isArray(d.shots) && d.shots.length) lines.push(`shots needing the song: ${d.shots.join(", ")}`);
  return { code: e.code === "BAD_ARGUMENT" ? EXIT.USAGE : EXIT.FINDING, data: { ok: false, error: e.toJSON?.() ?? { message: e.message } }, text: lines.join("\n") };
}

function loadSongFor(ctx, plan, planFile) {
  const songArg = strArg(ctx.args, "song", null);
  if (songArg) return readJsonFile(resolvePathArg(ctx, songArg), { fs: ctx.deps.fs, what: "song analysis" });
  const rel = plan?.song?.analysis;
  if (typeof rel === "string" && rel) {
    const p = path.resolve(path.dirname(planFile), rel);
    if (ctx.deps.fs.existsSync(p)) return readJsonFile(p, { fs: ctx.deps.fs, what: "song analysis" });
    ctx.io.warn(`plan.song.analysis ${p} does not exist (run \`film song analyze\`)`);
  }
  return null;
}

command("plan validate", "validate plan.json against the schema and the technique registry",
  `film plan validate <plan.json> [--song=<song.json>] [--no-dry-build]
  Prints every error/warning as "path: message"; exit 1 when the plan is invalid. --song also compiles the plan
  in memory (beat grid) and prints the shoot-time estimate.`,
  async (ctx) => {
    const file = ctx.args._[2];
    if (!file) throw usageError("plan validate needs a <plan.json>");
    const planFile = resolvePathArg(ctx, file);
    const plan = readJsonFile(planFile, { fs: ctx.deps.fs, what: "plan" });
    const registry = await planRegistry(ctx);
    const v = validatePlan(plan, { registry, dryBuild: boolArg(ctx.args, "dry-build", true) });
    const lines = [`${v.ok ? "valid" : "INVALID"}: ${v.errors.length} error(s), ${v.warnings.length} warning(s)`];
    if (v.errors.length) lines.push("errors:", printIssues(v.errors));
    if (v.warnings.length) lines.push("warnings:", printIssues(v.warnings));
    const data = { ok: v.ok, errors: v.errors, warnings: v.warnings };
    if (v.ok && ctx.args.song !== undefined) {
      const song = loadSongFor(ctx, plan, planFile);
      try {
        const t = compilePlan(plan, { song, registry });
        const est = estimateShootTime(t);
        data.compile = { duration: t.duration, frames: t.frames, items: t.items.length, sites: t.schedule.length, warnings: t.warnings, estimate: est.text };
        lines.push(`compiles: ${t.items.length} shot(s), ${t.duration.toFixed(2)} s / ${t.frames} frames, ${t.schedule.length} site(s); ${est.text}`);
      } catch (e) {
        if (e?.name !== "FilmPlanError") throw e;
        const r = planErrorResult(e);
        return { code: EXIT.FINDING, data: { ...data, ok: false, compileError: r.data.error }, text: `${lines.join("\n")}\n${r.text}` };
      }
    }
    return { code: v.ok ? EXIT.OK : EXIT.FINDING, data, text: lines.join("\n") };
  });

command("plan compile", "compile plan.json (+ song) into timeline.json",
  `film plan compile <plan.json> [--song=<song.json>] [--out=<timeline.json>]
  Song: --song, else plan.song.analysis relative to the plan. Writes timeline.json next to the plan by default and
  prints estimateShootTime().`,
  async (ctx) => {
    const file = ctx.args._[2];
    if (!file) throw usageError("plan compile needs a <plan.json>");
    const planFile = resolvePathArg(ctx, file);
    const plan = readJsonFile(planFile, { fs: ctx.deps.fs, what: "plan" });
    const registry = await planRegistry(ctx);
    const song = loadSongFor(ctx, plan, planFile);
    let t;
    try {
      t = compilePlan(plan, { song, registry });
    } catch (e) {
      if (e?.name === "FilmPlanError") return planErrorResult(e);
      throw e;
    }
    const out = resolvePathArg(ctx, strArg(ctx.args, "out", path.join(path.dirname(planFile), "timeline.json")));
    writeJsonFile(out, t, { fs: ctx.deps.fs, scrub: ctx.io.scrub });
    const est = estimateShootTime(t);
    const lines = [
      `wrote ${out}`,
      `${t.items.length} shot(s), ${t.duration.toFixed(2)} s, ${t.frames} frames @ ${t.fps} fps, ${t.width}×${t.height}`,
      `schedule: ${t.schedule.map((e) => `${e.siteId} [${e.shots.join(" ")}]`).join(" → ")}`,
      est.text,
    ];
    if (t.warnings.length) lines.push("warnings:", printIssues(t.warnings));
    return { code: EXIT.OK, data: { out, duration: t.duration, frames: t.frames, items: t.items.length, schedule: t.schedule.map((e) => ({ siteId: e.siteId, shots: e.shots })), warnings: t.warnings, estimate: est }, text: lines.join("\n") };
  });

command("jev ping", "one tiny JEV decision (proves key, endpoint and parsing)",
  `film jev ping [--jev-max-usd-per-hour=2] [--jev-max-calls-per-min=600]`,
  async (ctx) => {
    const jev = makeJev(ctx);
    if (!jev.client) throw usageError("no JEV key: set OPENROUTER_API_KEY (or OPENROUTER_KEY) or create ~/.config/holtburger-film/openrouter.key (chmod 600)");
    const r = await jevPing(jev.client);
    return { code: r.ok ? EXIT.OK : EXIT.FINDING, data: { ...r, keySource: jev.source }, text: `${r.ok ? "ok" : "UNEXPECTED ANSWER"}: pYes ${r.pYes.toFixed(3)} · ${r.model ?? "?"} · ${r.ms ?? "?"} ms · $${(r.costUsd ?? 0).toFixed(6)} (key ${jev.source})` };
  });

command("jev decide", "one typed JEV decision from a state + questions",
  `film jev decide --state=<file|json> --questions=<file|json> [--dry-run]
  Questions: {id: {type:'choice'|'noul'|'score', instructions, criteria}} (tools/film/lib/jev.mjs choiceQ/noulQ/
  scoreQ). --dry-run only validates. Prints answers, usage and cost — never the key or the state.`,
  async (ctx) => {
    const { args } = ctx;
    const questions = jsonArg(ctx, "questions", "questions");
    const vq = validateQuestions(questions);
    if (!vq.ok) return { code: EXIT.FINDING, data: { ok: false, issues: vq.issues }, text: `invalid questions:\n  ${vq.issues.join("\n  ")}` };
    if (boolArg(args, "dry-run")) return { code: EXIT.OK, data: { ok: true, questions: Object.keys(questions) }, text: `questions valid: ${Object.keys(questions).join(", ")}` };
    const state = jsonArg(ctx, "state", "state");
    const jev = makeJev(ctx);
    if (!jev.client) throw usageError("no JEV key: set OPENROUTER_API_KEY or create ~/.config/holtburger-film/openrouter.key (chmod 600)");
    const r = await jev.client.decide({ state, questions });
    const summary = summarizeAnswers(r.answers);
    const text = [`${r.model} · ${r.ms} ms · ${r.usage.inputTokens} input tokens · $${r.usage.costUsd.toFixed(6)}${r.id ? ` · id ${r.id}` : ""}`]
      .concat(Object.entries(r.answers).map(([id, a]) => `  ${id}: ${a.type === "choice" ? `${a.choice} (confidence ${a.confidence?.toFixed?.(3) ?? "?"})` : a.type === "score" ? `score ${a.score?.toFixed?.(3)} (confidence ${a.confidence?.toFixed?.(3) ?? "?"})` : `P(yes) ${a.noul?.toFixed?.(3)}`}`))
      .join("\n");
    return { code: EXIT.OK, data: { id: r.id, model: r.model, answers: r.answers, summary, usage: r.usage, ms: r.ms, attempts: r.attempts }, text };
  });

const isObjArg = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// The planning-time JEV tasks (lib/jev_tasks.mjs) the CLI exposes: input normalisation + one-line verdict text.
const JEV_TASKS = {
  pick: {
    run: pickCandidate,
    // A scout metrics.json (or any candidate list without words) is worded exactly as `scout --pick` words it.
    input: (ctx, i) => (Array.isArray(i.candidates) && i.candidates.some((c) => !isObjArg(c) || c.words == null) ? pickInputOf(i.intent ?? null, i.candidates) : i),
    text: (r) => `pick: ${r.choice} · band ${r.band}${r.confidence != null ? ` · confidence ${Number(r.confidence).toFixed(3)}` : ""} · ${r.source}${r.band === "escalate" ? " — look at the candidates yourself" : ""}`,
  },
  keep: {
    run: keepOrRetake,
    // A saved CLI take report (reports/<shot>.json) goes through the same judgeInput as `shoot`.
    input: (ctx, i) => (isObjArg(i) && (isObjArg(i.page) || Number.isFinite(Number(i.expectedFrames))) ? judgeInput(i) : i),
    text: (r) => `${r.keep ? "keep" : "RETAKE"} · pKeep ${Number(r.pKeep).toFixed(3)} · band ${r.band} · ${r.source}` +
      `${r.reasons?.length ? `\n  retake triggers: ${r.reasons.join("; ")}` : ""}${r.code?.borderline?.length ? `\n  borderline: ${r.code.borderline.join("; ")}` : ""}` +
      `\n  words: ${Object.entries(r.words ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}`,
  },
  "site-fit": {
    run: scoreSiteForLine,
    // `site` may be a gazetteer id / exact name: its name, kind and words come from the gazetteer.
    input: (ctx, i) => {
      if (!isObjArg(i) || typeof i.site !== "string") return i;
      const { sites } = loadSites(ctx);
      const site = findSite(sites, i.site);
      if (!site) throw findingError(`no site '${i.site}' in the gazetteer — try \`film sites search\``, "NO_SITE");
      return { ...i, site: { name: site.name, kind: site.kind, words: siteWords(site) } };
    },
    text: (r) => `fit: level ${r.level} (${r.levelText}) · score ${Number(r.score).toFixed(2)} · band ${r.band} · ${r.source}${r.source === "code" ? " (lexical hint only)" : ""}`,
  },
  family: {
    run: sectionTechniqueFamily,
    // Numbers become the task's words: energy (0..1) → energyWord, bpm → tempoWord.
    input: (ctx, i) => {
      if (!isObjArg(i)) return i;
      const o = { ...i };
      if (o.energyWord == null && o.energy != null) o.energyWord = energyWordOf(o.energy);
      if (o.tempoWord == null && (o.bpm != null || typeof o.tempo === "number")) o.tempoWord = tempoWordOf(o.bpm ?? o.tempo);
      return o;
    },
    text: (r) => `family: ${r.choice} (${r.techniques.join(", ")}) · band ${r.band}${r.confidence != null ? ` · confidence ${Number(r.confidence).toFixed(3)}` : ""} · ${r.source}`,
  },
};

command("jev task", "one planning-time JEV judgement: pick a candidate, keep/retake, site-fit, technique family",
  `film jev task <pick|keep|site-fit|family> --input=<file|json> [--code] [--json]
                [--jev-max-usd-per-hour=2] [--jev-max-calls-per-min=600]
  pick      {intent?, candidates:[{id, words}, …]} (best first; the first is the conservative default), or a
            scout stills/<shot>/metrics.json (worded exactly as \`scout --pick\` words it)
  keep      a take report — reports/<shot>.json from \`shoot\` (judged exactly as shoot does) or the words'
            facts {frames, droppedFrames, safetyAdjustedFrames, subjectMinVisibleFrac, subjectMaxUnseenSec,
            popInEvents, reveal}. Exit 1 when the verdict is RETAKE.
  site-fit  {line, mood?, site} — site = {name, kind?, words?} or a gazetteer id/name ([--gazetteer=<jsonl>])
  family    {role?, energyWord? | energy (0..1), tempoWord? | bpm, lyric?}
  With a JEV key (OPENROUTER_API_KEY or ~/.config/holtburger-film/openrouter.key) the real client decides;
  without one, or with --code, the deterministic code verdict answers (source 'code', free). The code verdict
  always comes back too (result.code) for comparison. A JEV failure other than config/auth falls back to the code
  verdict with a warning (result.jevError). Bands: act (go) · confirm (glance first) · escalate (decide yourself).`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const kind = args._[2];
    const task = kind ? JEV_TASKS[kind] : null;
    if (!task) throw usageError(`jev task needs one of ${Object.keys(JEV_TASKS).join(", ")}${kind ? ` (got '${kind}')` : ""}`);
    const raw = jsonArg(ctx, "input", "task input");
    if (!isObjArg(raw)) throw usageError(`--input for jev task ${kind} must be a JSON object`);
    const input = task.input(ctx, raw);
    // The free code verdict first: it validates the input (bad input = usage, before any API call).
    let code;
    try {
      code = await task.run(null, input);
    } catch (e) {
      if (e instanceof JevError && (e.kind === "bad-request" || e.kind === "config")) throw usageError(`invalid ${kind} input: ${e.message}`);
      throw e;
    }
    let result = code;
    let keySource = null;
    let jevError = null;
    if (!boolArg(args, "code")) {
      const jev = makeJev(ctx);
      keySource = jev.source;
      if (jev.client) {
        try {
          result = await task.run(jev.client, input, { sessionId: sessionIdFor(`task-${kind}`, deps.now), log: (e) => ctx.event(e) });
        } catch (e) {
          if (!(e instanceof JevError) || e.kind === "config" || e.kind === "auth") throw e;
          io.warn(`${kind} via JEV failed (${e.kind}: ${e.message}); using the code verdict`);
          jevError = { kind: e.kind, message: e.message };
          result = code;
        }
      }
    }
    const data = { task: kind, source: result.source, result, code: result === code ? null : code, keySource, ...(jevError ? { jevError } : {}) };
    const exit = kind === "keep" && result.keep === false ? EXIT.FINDING : EXIT.OK;
    const extra = result !== code && code ? `\n  code verdict: ${task.text(code).split("\n")[0]}` : "";
    return { code: exit, data, text: `${task.text(result)}${extra}` };
  });

command("browser check", "attach over CDP and report pages, film page, mute, window and GPU",
  `film browser check [--cdp=${DEFAULT_CDP}]
  Exit 1 when Chrome runs without --mute-audio (verified absent) or the film page's window is on screen.
  Also re-applies the page-level mute to the film page.`,
  async (ctx) => withLock(ctx, "browser check", () => withSession(ctx, async (s) => {
    const { io } = ctx;
    const mute = await checkBrowserMute(s.browser);
    let version = null;
    try {
      version = typeof s.browser.version === "function" ? s.browser.version() : null;
    } catch {
      version = null;
    }
    const pages = s.pages.map((p) => {
      let url = "";
      try {
        url = p.url();
      } catch {
        url = "";
      }
      return { url: redactUrl(url), film: isFilmUrl(url) };
    });
    const out = { cdp: s.cdp, browser: version, pages, filmPage: { open: Boolean(s.page) }, mute: { browser: mute, page: null }, window: null, gpu: null };
    const findings = [];
    if (mute.state === "absent") findings.push("Chrome runs WITHOUT --mute-audio (owner rule: no sound may reach the 1070's user)");
    if (mute.state === "unverified") io.warn(`mute unverified: ${mute.detail}`);
    if (s.page) {
      const page = s.page;
      out.filmPage.url = redactUrl(page.url());
      try {
        const snap = await evaluateWithTimeout(page, BOOT_SNAPSHOT_FN, undefined, { timeoutMs: 20_000, what: "boot snapshot" });
        const v = classifyBoot(snap, { elapsedMs: 0 });
        out.filmPage.state = snap.state;
        out.filmPage.booted = v.action === "go";
        out.filmPage.checks = v.checks;
        out.filmPage.filmVersion = snap.filmVersion;
      } catch (e) {
        out.filmPage.error = e?.message ?? String(e);
      }
      try {
        out.mute.page = await mutePage(page);
      } catch (e) {
        out.mute.page = { error: e?.message ?? String(e) };
      }
      if (s.context) out.window = await windowInfo(s.context, page);
      if (out.window?.ok && out.window.offScreen === false) findings.push(`the film window is ON SCREEN at ${JSON.stringify(out.window.bounds)} (must be off-screen: left ≤ -10000 or minimised)`);
      try {
        out.gpu = await evaluateWithTimeout(page, GPU_RENDERER_FN, undefined, { timeoutMs: 20_000, what: "GPU probe" });
        if (/swiftshader|llvmpipe/i.test(String(out.gpu?.renderer ?? ""))) io.warn(`software renderer (${out.gpu.renderer}) — this is not the 1070's GPU`);
      } catch (e) {
        out.gpu = { error: e?.message ?? String(e) };
      }
    }
    out.findings = findings;
    const text = [
      `CDP ${s.cdp}${version ? ` · ${version}` : ""}`,
      `pages (${pages.length}):`,
      ...pages.map((p) => `  ${p.film ? "[film] " : "       "}${p.url}`),
      `film page: ${s.page ? `open${out.filmPage.booted ? ", booted" : `, not booted (${out.filmPage.state ?? "?"})`}` : "none"}`,
      `mute: browser ${mute.state} (${mute.detail})${out.mute.page ? ` · page ${out.mute.page.audioManager ? `audio manager muted (ctx ${out.mute.page.ctxState})` : "no audio manager yet"}` : ""}`,
      `window: ${out.window ? (out.window.ok ? `${JSON.stringify(out.window.bounds)}${out.window.offScreen ? " (off-screen)" : " (ON SCREEN)"}` : out.window.detail) : "n/a"}`,
      `GPU: ${out.gpu?.renderer ?? out.gpu?.error ?? "n/a"}`,
      ...findings.map((f) => `FINDING: ${f}`),
    ].join("\n");
    return { code: findings.length ? EXIT.FINDING : EXIT.OK, data: out, text };
  })));

command("boot", "open and log in the film page, then make it a clean, silent, hidden-player camera",
  `film boot [--cdp=${DEFAULT_CDP}] [--base=${DEFAULT_BASE_URL}]
           [--account=${DEFAULT_ACCOUNT}] [--password=… | env FILM_PASSWORD] [--quality=high]
           [--width=1920 --height=1080] [--reuse] [--assume-muted] [--boot-timeout=${DEFAULT_BOOT_TIMEOUT_SEC}]
  Attaches (never launches), verifies --mute-audio (Browser.getBrowserCommandLine; 'unverified' needs
  --assume-muted), opens a new tab in the default context with the exact film URL (filmDof=on always), sets the
  viewport, installs the JEV broker before navigating, gates on in-world + ready + scene-ready + liveScene3d +
  __film, mutes the page, then clean(true) · own() · world.avatar(false) · @cloak on · @attackable off.
  The film account is single-login: a second film tab is refused (use --reuse), and "Account In Use" means wait
  ~25–65 s. --width/--height must be even (H.264 4:2:0). The password is never printed or written by this CLI
  (the heavy-lock record gets a scrubbed command line); prefer FILM_PASSWORD over --password=…, because a
  command-line argument is visible to every local user (ps, /proc/<pid>/cmdline) while the command runs.`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const base = strArg(args, "base", DEFAULT_BASE_URL);
    const account = strArg(args, "account", DEFAULT_ACCOUNT);
    const quality = strArg(args, "quality", "high");
    const width = evenSizeArg(args, "width", 1920, 7680);
    const height = evenSizeArg(args, "height", 1080, 4320);
    const reuse = boolArg(args, "reuse");
    const assumeMuted = boolArg(args, "assume-muted");
    const bootTimeoutSec = numArg(args, "boot-timeout", DEFAULT_BOOT_TIMEOUT_SEC, { min: 1 });
    const password = strArg(args, "password", null) ?? deps.env?.FILM_PASSWORD ?? null;
    if (password) io.addSecret(password);
    if (strArg(args, "password", null)) io.warn("--password=… is visible to every local user (ps, /proc/<pid>/cmdline) while this runs; prefer FILM_PASSWORD");
    return withLock(ctx, "boot", () => withSession(ctx, async (s) => {
      const mute = await checkBrowserMute(s.browser);
      if (mute.state === "absent") {
        throw new FilmCliError("Chrome is running WITHOUT --mute-audio — refusing to log in (owner rule: no sound may reach the 1070's user). Relaunch it with --mute-audio.", { exitCode: EXIT.USAGE, code: "NOT_MUTED" });
      }
      if (mute.state === "unverified" && !assumeMuted) {
        throw new FilmCliError(`cannot verify that Chrome runs with --mute-audio (${mute.detail}) — refusing to log in. Pass --assume-muted if it was launched with --mute-audio (the 1070 launch script does), or relaunch with --enable-automation.`, { exitCode: EXIT.USAGE, code: "MUTE_UNVERIFIED" });
      }
      if (mute.state === "unverified") io.warn(`--assume-muted: ${mute.detail}`);
      let page = s.page;
      if (page && !reuse) {
        throw new FilmCliError(`a film page is already open (${redactUrl(page.url())}) — the film account is single-login; pass --reuse to adopt it, or close that tab first`, { exitCode: EXIT.USAGE, code: "FILM_PAGE_OPEN" });
      }
      let alreadyBooted = false;
      if (page && reuse) {
        const snap = await evaluateWithTimeout(page, BOOT_SNAPSHOT_FN, undefined, { timeoutMs: 20_000, what: "boot snapshot" });
        alreadyBooted = classifyBoot(snap, { elapsedMs: 0 }).action === "go";
        io.info(`reusing the open film page (${alreadyBooted ? "already booted" : `state ${snap.state} — logging in again`})`);
      }
      if (!alreadyBooted && !password) throw new FilmCliError("no password: pass --password=… or set FILM_PASSWORD", { exitCode: EXIT.USAGE, code: "NO_PASSWORD" });
      const url = alreadyBooted ? null : buildFilmUrl({ base, account, password, quality });
      if (!page) {
        if (!s.context) throw usageError("the browser has no default context to open a tab in");
        page = await s.context.newPage();
      }
      // Size BEFORE navigation: the canvas latches its size at boot.
      if (s.context) ctx.keep.push(await applyViewport(s.context, page, { width, height }));
      // The broker BEFORE navigation (exposeFunction survives navigations).
      const broker = await installBroker(ctx, page, { sessionId: sessionIdFor("boot", deps.now) });
      const t0 = deps.now();
      if (url) {
        io.info(`opening ${redactUrl(url)}`);
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        } catch (e) {
          throw new FilmCliError(`navigation failed: ${redactUrl(String(e?.message ?? e).split(/\r?\n/)[0])}`, { exitCode: EXIT.USAGE, code: "NAVIGATION_FAILED" });
        }
      }
      try {
        await mutePage(page);
      } catch {
        // nothing loaded yet; muted again after the gate
      }
      const gate = await waitForBoot(page, {
        timeoutMs: bootTimeoutSec * 1000,
        now: deps.now,
        sleep: deps.sleep,
        onState: (snap, v) => io.info(`boot: ${snap.state ?? "?"} — ${v.reason}`),
      });
      if (!gate.ok) {
        const v = gate.verdict;
        const msg = v.accountInUse
          ? `${v.reason}. The film account (${account}) is single-login and looks in use: wait ~25–65 s (ACE reaps an abandoned session after ~60 s) and boot again.`
          : v.reason;
        throw new FilmCliError(msg, { exitCode: EXIT.FINDING, code: v.accountInUse ? "ACCOUNT_IN_USE" : "BOOT_FAILED", details: { checks: v.checks, failing: v.failing, elapsedMs: gate.elapsedMs, state: gate.snap?.state ?? null } });
      }
      const pageMute = await mutePage(page);
      if (!pageMute.audioManager) io.warn("no liveScene3d.audioManager to mute (wireframe build, or audio not constructed) — relying on --mute-audio");
      await filmCall(page, "clean", true);
      await filmCall(page, "own");
      await filmCall(page, "world.avatar", false);
      await filmCall(page, "world.teleport", "@cloak on");
      await filmCall(page, "world.teleport", "@attackable off");
      await evaluateWithTimeout(page, VIEWPORT_MARK_FN, { width, height }, { timeoutMs: 15_000, what: "viewport mark" });
      const status = await filmCallWith(page, { soft: true, timeoutMs: 30_000 }, "status");
      const data = {
        url: url ? redactUrl(url) : redactUrl(page.url()),
        account,
        viewport: { width, height },
        mute: { browser: mute, page: pageMute },
        gate: { elapsedMs: deps.now() - t0, reason: gate.verdict.reason, checks: gate.verdict.checks },
        jev: { broker: Boolean(broker) },
        status,
      };
      const text = [
        `booted ${data.url}`,
        `gate: ${gate.verdict.reason} after ${fmtSec(data.gate.elapsedMs)}`,
        `viewport ${width}×${height} · mute browser ${mute.state} · page ${pageMute.audioManager ? `muted (ctx ${pageMute.ctxState})` : "no audio manager"}`,
        `camera owned, frame clean, player hidden (@cloak on, @attackable off) · JEV ${broker ? "broker installed" : "off (code policy)"}`,
      ].join("\n");
      return { code: EXIT.OK, data, text };
    }));
  });

function yesNo(v) {
  return v === true ? "yes" : v === false ? "NO" : "unknown";
}

command("status", "the film page's __film.status() (+ camera/avatar/canvas probe); --release hands the client back",
  `film status [--cdp=${DEFAULT_CDP}] [--release | --own] [--clean=on|off] [--avatar=on|off] [--json]
  Attaches (never launches, never navigates) to the open film page and prints __film.status() plus a probe the
  status lacks: the camera switcher's mode, whether the avatar carries the film hide term, and the drawing-buffer
  size (__renderScaleState) — the JSON the 1070 eye-test checklist records for every item.
  --release   __film.release() → __film.clean(false) → __film.world.avatar(true), then checks through status +
              probe that the client is handed back: camera not owned (follow mode restored), frame not clean
              (HUD back, input unlocked), avatar not film-hidden. Exit 1 when a check fails. Refused while a take
              runs (FILM_BUSY, exit 1). @cloak / @attackable stay as \`boot\` set them.
  --own       __film.own() (exit 1 when the camera is not owned afterwards). The film frame \`boot\` leaves is
              --own --clean=on --avatar=off.
  --clean=on|off / --avatar=on|off   __film.clean(on) / __film.world.avatar(visible), alone or after --own.
  Holds the heavy-job lock; never touches the viewport, the JEV broker or the page's audio.`,
  async (ctx) => {
    const { args, io } = ctx;
    const release = boolArg(args, "release");
    const own = boolArg(args, "own");
    const clean = args.clean === undefined ? null : boolArg(args, "clean");
    const avatar = args.avatar === undefined ? null : boolArg(args, "avatar");
    if (release && own) throw usageError("--release and --own are exclusive");
    if (release && clean === true) throw usageError("--release restores the frame (clean(false)); --clean=on contradicts it");
    if (release && avatar === false) throw usageError("--release shows the avatar; --avatar=off contradicts it");
    return withLock(ctx, "status", () => withSession(ctx, async (s) => {
      const page = requireFilmPage(s);
      const actions = [];
      const act = async (method, ...a) => {
        const result = await filmCall(page, method, ...a);
        actions.push({ call: `${method}(${a.map((x) => JSON.stringify(x)).join(", ")})`, result });
        io.info(`${method}(${a.map((x) => JSON.stringify(x)).join(", ")}) → ok`);
        return result;
      };
      if (release) {
        await act("release");
        await act("clean", false);
        await act("world.avatar", true);
      } else {
        if (own) await act("own");
        if (clean !== null) await act("clean", clean);
        if (avatar !== null) await act("world.avatar", avatar);
      }
      const status = await filmCallWith(page, { soft: true, timeoutMs: 30_000 }, "status");
      let probe;
      try {
        probe = await evaluateWithTimeout(page, FILM_PROBE_FN, undefined, { timeoutMs: 15_000, what: "film probe" });
      } catch (e) {
        probe = { error: e?.message ?? String(e) };
      }
      const findings = [];
      if (!status || status.ok === false) {
        findings.push(`__film.status() failed: ${typeof status?.error === "string" ? status.error : status?.error?.message ?? JSON.stringify(status)}`);
      }
      const avatarVisible = probe?.avatar?.visible ?? null;
      let restored = null;
      if (release) {
        restored = { follow: status?.cameraOwned === false, frame: status?.clean === false, avatar: avatarVisible };
        if (!restored.follow) findings.push("the camera is still owned after release() (follow mode not restored)");
        if (!restored.frame) findings.push("the frame is still clean after clean(false) (HUD/input not restored)");
        if (restored.avatar === false) findings.push("the avatar is still film-hidden after world.avatar(true)");
        if (restored.avatar === null) io.warn("avatar visibility unknown (no liveScene3d.entityManager)");
      }
      if (own && status?.cameraOwned !== true) findings.push("own() returned but status.cameraOwned is not true");
      const canvas = probe?.canvas ? `${probe.canvas.width}×${probe.canvas.height}` : "unknown";
      const lines = [
        `film page: camera ${status?.cameraOwned === true ? "owned" : status?.cameraOwned === false ? "free" : "?"}` +
          `${probe?.cameraMode ? ` (mode ${probe.cameraMode})` : ""} · frame ${status?.clean === true ? "clean" : status?.clean === false ? "normal" : "?"}` +
          ` · avatar ${avatarVisible === true ? "visible" : avatarVisible === false ? "film-hidden" : "unknown"} · canvas ${canvas}` +
          ` · busy ${status?.busy ?? "none"}${status?.take?.shotId ? ` · prepared ${status.take.shotId}` : ""}`,
      ];
      if (restored) lines.push(`release: follow restored ${yesNo(restored.follow)} · frame restored ${yesNo(restored.frame)} · avatar visible ${yesNo(restored.avatar)}`);
      lines.push(...findings.map((f) => `FINDING: ${f}`));
      lines.push(`status: ${JSON.stringify(status, jsonReplacer, 2)}`, `probe: ${JSON.stringify(probe, jsonReplacer, 2)}`);
      return { code: findings.length ? EXIT.FINDING : EXIT.OK, data: { actions, status, probe, restored, findings }, text: lines.join("\n") };
    }));
  });

command("go", "teleport the hidden player to a site and wait for the readiness gate",
  `film go <site-id | @command> [--gazetteer=<jsonl>] [--timeline=<timeline.json>] [--timeout=90] [--settle=3]
  A site id resolves through the timeline's schedule (--timeline) or the gazetteer (teleport.best, lbKeys,
  interiorLb). An @command is sent as is (@teleloc <cell> … also gives the readiness landblock).`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const target = args._.slice(1).join(" ").trim();
    if (!target) throw usageError("go needs a <site-id> or an @command");
    const timeoutSec = numArg(args, "timeout", 90, { min: 1 });
    const settleSec = numArg(args, "settle", null, { min: 0 });
    let teleport;
    let ready;
    let label = target;
    let map = null;
    if (target.startsWith("@")) {
      teleport = target;
      ready = readyTargetsForCommand(target);
      map = mapOfTeleloc(target);
      if (map) label = `${target} (${map})`;
    } else if (args.timeline !== undefined) {
      const t = readTimeline(ctx, strArg(args, "timeline"));
      const e = t.schedule.find((x) => x.siteId === target);
      if (!e) throw usageError(`no schedule entry '${target}' in the timeline (have: ${t.schedule.map((x) => x.siteId).join(", ")})`);
      teleport = e.teleport;
      ready = { ...(e.ready ?? {}) };
      map = mapOfWorld(e.anchor, e.indoor === true) ?? mapOfTeleloc(e.teleport);
      if (map) label = `${target} (${map})`;
    } else {
      const { sites } = loadSites(ctx);
      const site = findSite(sites, target);
      if (!site) throw findingError(`no site '${target}' in the gazetteer — try \`film sites search\``, "NO_SITE");
      teleport = site.teleport?.best;
      if (!teleport) throw findingError(`site '${site.id}' has no teleport command`, "NO_TELEPORT");
      ready = readyTargetsForSite(site);
      map = mapText(site.map);
      label = `${site.id} (${site.name}${map ? `, ${map}` : ""})`;
    }
    if (settleSec !== null) ready.settleSec = settleSec;
    ready.timeoutSec = timeoutSec;
    return withLock(ctx, "go", () => withSession(ctx, async (s) => {
      const page = requireFilmPage(s);
      await reapplyViewport(ctx, s, page);
      io.info(`go ${label}: ${teleport}`);
      const r = await goAndWait(page, { teleport, ready, timeoutSec, now: deps.now, sleep: deps.sleep, log: (m) => io.info(m) });
      const data = { target: label, map, teleport, ready: { ...ready, lbKeys: (ready.lbKeys ?? []).map(hex), interiorLb: hex(ready.interiorLb) }, ok: r.ok, elapsedMs: r.elapsedMs, portal: r.portal, report: r.report };
      const text = `${r.ok ? "ready" : "NOT READY"} after ${fmtSec(r.elapsedMs)} (portal ${r.portal.sawActive ? fmtSec(r.portal.activeMs) : "not seen"})${map ? ` at ${map}` : ""}\n${JSON.stringify(r.report?.checks ?? r.report ?? {}, jsonReplacer)}`;
      return { code: r.ok ? EXIT.OK : EXIT.FINDING, data, text };
    }));
  });

function stillOf(c) {
  for (const k of ["still", "jpeg", "image", "dataUrl", "jpg", "png"]) {
    const v = c?.[k];
    if (typeof v === "string" && /^data:image\/(jpeg|jpg|png|webp);base64,/.test(v)) return { key: k, url: v };
  }
  return null;
}

// pickCandidate input from scout candidates (the page's, or stills/<shot>/metrics.json): id, else cand-<i>; the
// candidate's words, else its description, else its metrics flattened to "k: v; …".
function pickInputOf(intent, cands) {
  return {
    intent,
    candidates: cands.map((c, i) => ({ id: c?.id != null ? String(c.id) : `cand-${i}`, words: c?.words ?? c?.description ?? (flatWords(c?.metrics ?? c) || `candidate ${i}`) })),
  };
}

function flatWords(obj) {
  if (!obj || typeof obj !== "object") return String(obj ?? "");
  return Object.entries(obj)
    .filter(([, v]) => v != null && typeof v !== "object")
    .map(([k, v]) => `${k}: ${typeof v === "number" ? Math.round(v * 100) / 100 : v}`)
    .join("; ");
}

command("scout", "candidate camera placements (+ stills) for one shot",
  `film scout <timeline.json> --shot=<id> [--count=8] [--stills] [--pick] [--project=<dir>]
  Saves stills/<shot>/cand-<i>.jpg and stills/<shot>/metrics.json; --pick asks JEV (or the code fallback) to
  choose and prints the band: act (go), confirm (glance first), escalate (the director should look). The page's
  scout warnings (e.g. a light intent ignored without a usable sun) print and go into metrics.json \`warnings\`.`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const tfile = args._[1];
    const timeline = readTimeline(ctx, tfile);
    const item = findItem(timeline, strArg(args, "shot"));
    const paths = projectOf(ctx, tfile);
    const count = numArg(args, "count", 8, { integer: true, min: 1, max: 64 });
    const stills = boolArg(args, "stills");
    return withLock(ctx, "scout", () => withSession(ctx, async (s) => {
      const page = requireFilmPage(s);
      await reapplyViewport(ctx, s, page, { forTakes: true });
      const res = await filmCallWith(page, { timeoutMs: 600_000 }, "scout", item.take, { count, stills, width: 640 });
      const cands = Array.isArray(res?.candidates) ? res.candidates : [];
      const dir = path.join(paths.stills, item.shotId);
      deps.fs.mkdirSync(dir, { recursive: true });
      const files = [];
      const meta = cands.map((c, i) => {
        const st = stillOf(c);
        const copy = { ...c };
        if (st) {
          const ext = /^data:image\/png/.test(st.url) ? "png" : "jpg";
          const f = path.join(dir, `cand-${i}.${ext}`);
          deps.fs.writeFileSync(f, Buffer.from(st.url.slice(st.url.indexOf(",") + 1), "base64"));
          files.push(f);
          copy[st.key] = path.basename(f);
        }
        return { index: i, ...copy };
      });
      // The page's scout warnings (e.g. an intent.light ignored without a usable sun): printed, saved, never fatal.
      const warnings = Array.isArray(res?.warnings) ? res.warnings.map((w) => (typeof w === "string" ? w : w?.message ?? JSON.stringify(w))).filter(Boolean) : [];
      for (const w of warnings) io.warn(`scout ${item.shotId}: ${w}`);
      const metricsFile = writeJsonFile(path.join(dir, "metrics.json"), { shotId: item.shotId, technique: item.technique, count: cands.length, intent: res?.intent ?? null, warnings, candidates: meta }, { fs: deps.fs, scrub: io.scrub, replacer: jsonReplacer });
      const data = { shotId: item.shotId, candidates: cands.length, stills: files, metrics: metricsFile, warnings };
      const lines = [`${cands.length} candidate(s) for ${item.shotId} (${item.technique}) → ${path.relative(paths.dir, dir) || dir}`];
      if (boolArg(args, "pick") && cands.length) {
        const input = pickInputOf(res?.intent ?? { framing: item.take?.spec?.framing ?? item.take?.framing ?? null }, cands);
        let pick;
        try {
          pick = await pickCandidate(makeJev(ctx).client, input);
        } catch (e) {
          io.warn(`pickCandidate via JEV failed (${e?.kind ?? e?.name}: ${e?.message}); using the code choice`);
          pick = await pickCandidate(null, input);
        }
        data.pick = { choice: pick.choice, band: pick.band, confidence: pick.confidence, source: pick.source, probabilities: pick.probabilities };
        lines.push(`pick: ${pick.choice} · band ${pick.band}${pick.confidence != null ? ` · confidence ${Number(pick.confidence).toFixed(3)}` : ""} · ${pick.source}${pick.band === "escalate" ? " — look at the stills yourself" : ""}`);
      }
      return { code: EXIT.OK, data, text: lines.join("\n") };
    }));
  });

command("rehearse", "stepped dry run of one shot (no capture)",
  `film rehearse <timeline.json> --shot=<id> [--fps=8] [--project=<dir>]
  prepare → rehearse({fps}) → reports/<shot>.rehearsal.json (realised table) + reports/<shot>.pilot.jsonl.
  The page's validation / flight-check issues (e.g. overspeed with the minimum feasible duration) and warnings
  print one warning each and are saved in the rehearsal file as \`issues\`; they never fail the rehearsal.`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const tfile = args._[1];
    const timeline = readTimeline(ctx, tfile);
    const item = findItem(timeline, strArg(args, "shot"));
    const paths = projectOf(ctx, tfile);
    const fps = numArg(args, "fps", 8, { min: 1, max: 120 });
    return withLock(ctx, "rehearse", () => withSession(ctx, async (s) => {
      const page = requireFilmPage(s);
      await reapplyViewport(ctx, s, page, { forTakes: true });
      const broker = await installBroker(ctx, page, { sessionId: sessionIdFor(`rehearse-${item.shotId}`, deps.now) });
      broker?.setDecideOptions(DECIDE_OPTIONS.stepped);
      const r = await rehearseShot({ page, item, fps, paths, io, fs: deps.fs });
      if (broker) broker.dumpTelemetry(path.join(paths.reports, `${item.shotId}.rehearsal.jev.jsonl`));
      // Page issues (validation, overspeed + minimum duration, warnings) were printed as warnings; they never fail it.
      const issueText = r.issues.length ? ` · ${r.issues.length} page issue(s): ${r.issues.map((i) => i.code).join(", ")} (see the warnings)` : "";
      return {
        code: EXIT.OK,
        data: { shotId: item.shotId, file: r.file, telemetry: r.telemetryFile, telemetryCount: r.telemetryCount, issues: r.issues, flight: r.flight },
        text: `rehearsed ${item.shotId} at ${fps} fps → ${r.file} (${r.telemetryCount} pilot decision(s))${issueText}`,
      };
    }));
  });

command("shoot", "record takes site by site (never across a teleport)",
  `film shoot <timeline.json> (--site=<id> | --shot=<id>[,<id>…] | --all) [--retakes=1] [--codec=avc|vp9|frames]
            [--bitrate=40000000] [--rehearse | --no-rehearse] [--rehearse-fps=8] [--locked] [--vp9-container=mp4|webm]
            [--project=<dir>] [--ffmpeg=<path>] [--capped]
  Per site: (abort a leftover page take) → teleport → readiness → prewarm (best-effort: an incomplete prewarm
  warns and is noted in shoot-log.jsonl and the site's reports); per shot: prepare → [rehearse, always with the
  stepped JEV limits] → shoot while draining the recorder → ffmpeg mux → takes/<shot>.mp4 + reports/<shot>.json
  (+ shoot-log.jsonl, <shot>.jev.jsonl with that shot's JEV calls only); keepOrRetake (JEV or the code verdict)
  retakes up to --retakes times while the verdict is not keep/act; a failed retake keeps the earlier attempt.
  A failed take is aborted on the page (the abort is re-sent while the page stays busy) and the CLI waits for it
  to go idle; a page that stays busy is never teleported (the remaining shots fail at 'busy'). The page's
  validation / flight-check issues and warnings (prepare, rehearse, take report — e.g. overspeed with the minimum
  feasible duration) print one warning each per shot and are recorded as \`issues\` in reports/<shot>.json and
  shoot-log.jsonl; they never fail or retake a take. Exit 1 when a site is not ready or fails, or a shot has no
  kept take.`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const tfile = args._[1];
    const timeline = readTimeline(ctx, tfile);
    const selection = selectSchedule(timeline, { site: strArg(args, "site", null), shot: strArg(args, "shot", null), all: boolArg(args, "all") });
    const paths = projectOf(ctx, tfile);
    const codec = strArg(args, "codec", "avc");
    if (!["avc", "vp9", "frames"].includes(codec)) throw usageError(`--codec must be avc, vp9 or frames (got ${codec})`);
    const vp9Container = strArg(args, "vp9-container", "mp4");
    if (!["mp4", "webm"].includes(vp9Container)) throw usageError("--vp9-container must be mp4 or webm");
    const rehearse = args.rehearse === undefined ? "auto" : boolArg(args, "rehearse") ? "always" : "never";
    const opts = {
      codec,
      bitrate: numArg(args, "bitrate", 40_000_000, { integer: true, min: 100_000 }),
      retakes: numArg(args, "retakes", 1, { integer: true, min: 0, max: 5 }),
      rehearse,
      rehearseFps: numArg(args, "rehearse-fps", 8, { min: 1, max: 120 }),
      locked: boolArg(args, "locked"),
      vp9Container,
      ffmpeg: resolveFfmpeg(strArg(args, "ffmpeg"), deps.env),
      capped: boolArg(args, "capped"),
    };
    ctx.eventFile = path.join(paths.reports, "jev-client.jsonl");
    return withLock(ctx, "shoot", () => withSession(ctx, async (s) => {
      const page = requireFilmPage(s);
      const size = await reapplyViewport(ctx, s, page, { forTakes: true });
      if (size && (size.width !== timeline.width || size.height !== timeline.height)) {
        io.warn(`viewport ${size.width}×${size.height} differs from the timeline format ${timeline.width}×${timeline.height}`);
      }
      try {
        const canvas = await evaluateWithTimeout(page, CANVAS_SIZE_FN, undefined, { timeoutMs: 15_000, what: "canvas size" });
        if (canvas && (canvas.width !== timeline.width || canvas.height !== timeline.height)) {
          io.warn(`the canvas is ${canvas.width}×${canvas.height}, the timeline wants ${timeline.width}×${timeline.height} (renderScale/DPR or a pending resize?)`);
        }
      } catch {
        // informational only
      }
      try {
        await mutePage(page);
      } catch (e) {
        io.warn(`page mute failed: ${e?.message ?? e}`);
      }
      const broker = await installBroker(ctx, page, { sessionId: sessionIdFor(path.basename(paths.dir), deps.now) });
      const jev = makeJev(ctx);
      const r = await shootSchedule({
        page,
        timeline,
        selection,
        paths,
        ...opts,
        jev: jev.client,
        broker,
        keepOrRetake,
        spawn: deps.spawn,
        fs: deps.fs,
        now: deps.now,
        sleep: deps.sleep,
        io,
      });
      const text = [`shot ${r.shots.length} take(s) across ${r.teleports} site(s)`]
        .concat(r.shots.map((x) => `  ${x.shotId}: ${path.basename(x.file)} · ${x.frames} frames · ${x.kept ? "kept" : "NOT KEPT"} (${x.verdict.band}, ${x.verdict.source}${x.attempts > 1 ? `, ${x.attempts} attempts` : ""}${x.failedAttempts?.length ? `, retake ${x.failedAttempts.map((f) => f.attempt).join("/")} failed` : ""})${x.issues?.length ? ` · page issue(s): ${x.issues.map((i) => (Number.isFinite(i.minDurationSec) ? `${i.code} (min ${i.minDurationSec} s)` : i.code)).join(", ")}` : ""}`))
        .concat(r.failures.map((f) => `  FAILED ${f.shotId} at ${f.stage}: ${f.message}`))
        .join("\n");
      return { code: r.ok ? EXIT.OK : EXIT.FINDING, data: r, text };
    }));
  });

function collectTakes(ctx, timeline, paths) {
  const { fs } = ctx.deps;
  const takes = {};
  for (const it of timeline.items) {
    const rp = path.join(paths.reports, `${it.shotId}.json`);
    let rep = null;
    if (fs.existsSync(rp)) rep = readJsonFile(rp, { fs, what: "take report" });
    const file = rep?.file && fs.existsSync(rep.file) ? rep.file : path.join(paths.takes, `${it.shotId}.mp4`);
    if (!fs.existsSync(file)) continue;
    const t = { file };
    if (rep) {
      if (Number.isFinite(rep.fps)) t.fps = rep.fps;
      if (Number.isFinite(rep.frames)) t.frames = rep.frames;
      if (Number.isFinite(rep.durationSec)) t.durationSec = rep.durationSec;
    }
    takes[it.shotId] = t;
  }
  return takes;
}

command("assemble", "cut the takes into edit/final.mp4 on the song",
  `film assemble <timeline.json> [--song=<audio>] [--no-audio] [--out=edit/final.mp4] [--edl] [--missing=error|black]
               [--crf=16] [--dry-run] [--project=<dir>] [--ffmpeg=<path>] [--capped]
  Takes come from reports/<shot>.json (file, fps, frames) or takes/<shot>.mp4. Song: --song, else
  timeline.song.file resolved against the project. --edl also writes edit/final.edl (CMX3600).`,
  async (ctx) => {
    const { args, deps, io } = ctx;
    const tfile = args._[1];
    const timeline = readTimeline(ctx, tfile);
    const paths = projectOf(ctx, tfile);
    const takes = collectTakes(ctx, timeline, paths);
    const missing = strArg(args, "missing", "error");
    if (!["error", "black"].includes(missing)) throw usageError("--missing must be error or black");
    let audioFile = null;
    let tl = timeline;
    if (boolArg(args, "audio", true) === false) {
      tl = { ...timeline, song: timeline.song ? { ...timeline.song, file: null } : null };
    } else {
      const songArg = strArg(args, "song", null);
      const cand = songArg ? resolvePathArg(ctx, songArg) : typeof timeline.song?.file === "string" && timeline.song.file ? path.resolve(paths.dir, timeline.song.file) : null;
      if (cand && deps.fs.existsSync(cand)) audioFile = cand;
      else {
        if (cand) io.warn(`song ${cand} not found — assembling without audio`);
        tl = { ...timeline, song: timeline.song ? { ...timeline.song, file: null } : null };
      }
    }
    let a;
    try {
      a = buildAssembly(tl, takes, { audioFile, missing });
    } catch (e) {
      if (e?.name === "FilmPlanError") throw findingError(e.message, e.code, e.details);
      throw e;
    }
    const out = path.resolve(paths.dir, strArg(args, "out", path.relative(paths.dir, paths.finalMp4)));
    const argv = assemblyArgv(a, { out, crf: numArg(args, "crf", 16, { min: 0, max: 51 }) });
    const ffmpeg = resolveFfmpeg(strArg(args, "ffmpeg"), deps.env);
    const data = { out, totalSec: a.totalSec, totalFrames: a.totalFrames, segments: a.segments.length, audio: a.audio, warnings: a.warnings, argv: [ffmpeg, ...argv] };
    if (boolArg(args, "edl")) {
      const edl = toCmx3600(tl, takes, { title: timeline.title });
      deps.fs.mkdirSync(path.dirname(paths.finalEdl), { recursive: true });
      deps.fs.writeFileSync(paths.finalEdl, io.scrub(edl), "utf8");
      data.edl = paths.finalEdl;
    }
    for (const w of a.warnings) io.warn(`${w.path}: ${w.message}`);
    if (boolArg(args, "dry-run")) {
      return { code: EXIT.OK, data: { ...data, dryRun: true }, text: `${[ffmpeg, ...argv].map((x) => (/[\s;'"\\]/.test(x) ? JSON.stringify(x) : x)).join(" ")}` };
    }
    deps.fs.mkdirSync(path.dirname(out), { recursive: true });
    await withLock(ctx, "assemble", () => runFfmpeg(ffmpeg, argv, { spawn: deps.spawn, capped: boolArg(args, "capped"), what: "ffmpeg assemble" }));
    return { code: EXIT.OK, data, text: `wrote ${out} (${a.totalFrames} frames, ${a.totalSec.toFixed(2)} s, ${a.segments.length} segment(s)${a.audio ? ", with song" : ", no audio"})${data.edl ? `\nwrote ${data.edl}` : ""}` };
  });

command("contact-sheet", "a grid of evenly spaced frames as one JPEG",
  `film contact-sheet <video> [--cols=4 --rows=4 --width=1920] [--out=<jpg>] [--frames=N] [--ffprobe=<path>]
  N-th frame selection spans the clip: frames from --frames, ffprobe, the take report, or the timeline.`,
  async (ctx) => {
    const { args, deps } = ctx;
    const video = args._[1];
    if (!video) throw usageError("contact-sheet needs a <video>");
    const input = resolvePathArg(ctx, video);
    if (!deps.fs.existsSync(input)) throw usageError(`no such video: ${input}`);
    const ffmpeg = resolveFfmpeg(strArg(args, "ffmpeg"), deps.env);
    let frames = numArg(args, "frames", null, { integer: true, min: 1 });
    let source = "--frames";
    if (frames === null) {
      frames = await ffprobeFrameCount(resolveFfprobe(strArg(args, "ffprobe"), ffmpeg, deps.env), input, { spawn: deps.spawn, fs: deps.fs });
      source = "ffprobe";
    }
    if (frames === null) {
      const proj = strArg(args, "project", null) ? resolvePathArg(ctx, strArg(args, "project")) : path.dirname(path.dirname(input));
      const stem = path.basename(input, path.extname(input));
      const rp = path.join(proj, "reports", `${stem}.json`);
      const tp = path.join(proj, "timeline.json");
      if (deps.fs.existsSync(rp)) {
        const r = readJsonFile(rp, { fs: deps.fs, what: "take report" });
        frames = Number.isFinite(r.frames) ? r.frames : Number.isFinite(r.durationSec) && Number.isFinite(r.fps) ? Math.round(r.durationSec * r.fps) : null;
        source = "take report";
      } else if (path.basename(path.dirname(input)) === "edit" && deps.fs.existsSync(tp)) {
        frames = readJsonFile(tp, { fs: deps.fs, what: "timeline" }).frames ?? null;
        source = "timeline";
      }
    }
    if (!Number.isFinite(frames) || frames <= 0) throw usageError("cannot determine the frame count (no ffprobe, no take report): pass --frames=N");
    const cs = contactSheetArgv({
      input,
      out: strArg(args, "out", null) ? resolvePathArg(ctx, strArg(args, "out")) : undefined,
      frames,
      cols: numArg(args, "cols", 4, { integer: true }),
      rows: numArg(args, "rows", 4, { integer: true }),
      width: numArg(args, "width", 1920, { integer: true }),
    });
    await runFfmpeg(ffmpeg, cs.argv, { spawn: deps.spawn, what: "ffmpeg contact sheet" });
    return { code: EXIT.OK, data: { out: cs.out, frames, framesFrom: source, every: cs.every, filter: cs.filter }, text: `wrote ${cs.out} (every ${cs.every}th of ${frames} frames, from ${source})` };
  });

// Options `run` hands to every step. NOT `song`: plan validate/compile read --song as the analysis (song.json) and
// assemble reads it as the audio, so `run` takes the two as --song-analysis and --song-audio and routes each.
const RUN_PASSTHROUGH = ["cdp", "ffmpeg", "ffprobe", "gazetteer", "account", "password", "base", "quality", "width", "height",
  "codec", "bitrate", "retakes", "assume-muted", "boot-timeout", "jev-max-usd-per-hour", "jev-max-calls-per-min", "capped",
  "rehearse", "rehearse-fps", "missing", "vp9-container", "audio"];

// An explicit file for `run`: absolute as is; relative → the cwd when it exists there, else the project directory.
// It must exist (a typo must not silently fall back to the plan's song or an edit without audio).
function runFileArg(ctx, paths, key, what) {
  const v = strArg(ctx.args, key, null);
  if (v === null) return null;
  const fromCwd = resolvePathArg(ctx, v);
  const fromProject = path.resolve(paths.dir, v);
  const fs = ctx.deps.fs;
  const file = fs.existsSync(fromCwd) ? fromCwd : !path.isAbsolute(v) && fs.existsSync(fromProject) ? fromProject : null;
  if (!file) throw usageError(`--${key}: no such ${what} ${fromCwd}${!path.isAbsolute(v) ? ` (nor ${fromProject})` : ""}`);
  return file;
}

command("run", "the end-to-end recipe for a project",
  `film run <project-dir> [--song-analysis=<song.json>] [--song-audio=<audio>] [boot/shoot/assemble options…]
  plan validate → plan compile → boot-check (browser check; boot when no booted film page) → shoot --all →
  assemble (+ EDL) → contact-sheet edit/final.mp4. Prints each step and stops at the first failure with its
  exit code.
  Song: --song-analysis goes to plan validate/compile as --song (default: plan.song.analysis relative to the
  project); --song-audio goes to assemble as --song (default: timeline.song.file relative to the project).
  Relative paths resolve against the cwd, else the project. --song itself is refused (ambiguous here).
  Passed to the steps: --cdp --ffmpeg --ffprobe --gazetteer --account --password --base --quality --width
  --height --codec --bitrate --retakes --assume-muted --boot-timeout --jev-max-usd-per-hour
  --jev-max-calls-per-min --capped --rehearse/--no-rehearse --rehearse-fps --missing --vp9-container --no-audio.`,
  async (ctx) => {
    const { args, io } = ctx;
    const dirArg = args._[1];
    if (!dirArg) throw usageError("run needs a <project-dir>");
    const paths = projectPaths(resolvePathArg(ctx, dirArg));
    if (!ctx.deps.fs.existsSync(paths.plan)) throw usageError(`no plan.json in ${paths.dir}`);
    if (args.song !== undefined) {
      throw usageError("run does not take --song (plan steps want the analysis, assemble wants the audio): use --song-analysis=<song.json> and/or --song-audio=<audio>");
    }
    const songAnalysis = runFileArg(ctx, paths, "song-analysis", "song analysis");
    const songAudio = runFileArg(ctx, paths, "song-audio", "song audio file");
    const planSong = songAnalysis ? { song: songAnalysis } : {};
    const pass = {};
    for (const k of RUN_PASSTHROUGH) if (args[k] !== undefined) pass[k] = args[k];
    const steps = [];
    const runStep = async (label, name, stepArgs) => {
      io.info(`\n▶ ${label}`);
      let r;
      try {
        r = await COMMANDS[name].run({ ...ctx, args: { ...pass, ...stepArgs } });
      } catch (e) {
        const code = exitCodeFor(e);
        io.info(`✗ ${label}: ${errorMessage(e)}`);
        steps.push({ step: label, code, error: errorJson(e) });
        return { code, data: null };
      }
      if (r.text) io.out(r.text);
      steps.push({ step: label, code: r.code, data: r.data });
      io.info(`${r.code === 0 ? "✓" : "✗"} ${label} (exit ${r.code})`);
      return r;
    };
    const finish = (code) => ({ code, data: { project: paths.dir, steps }, text: `run ${code === 0 ? "complete" : `stopped (exit ${code})`}: ${steps.map((s) => `${s.step} ${s.code === 0 ? "ok" : `exit ${s.code}`}`).join(" → ")}` });
    return withLock(ctx, "run", async () => {
      let r = await runStep("plan validate", "plan validate", { _: ["plan", "validate", paths.plan], ...planSong });
      if (r.code !== 0) return finish(r.code);
      r = await runStep("plan compile", "plan compile", { _: ["plan", "compile", paths.plan], out: paths.timeline, ...planSong });
      if (r.code !== 0) return finish(r.code);
      r = await runStep("boot-check", "browser check", { _: ["browser", "check"] });
      if (r.code !== 0) return finish(r.code);
      if (!r.data?.filmPage?.booted) {
        r = await runStep("boot", "boot", { _: ["boot"], reuse: Boolean(r.data?.filmPage?.open) });
        if (r.code !== 0) return finish(r.code);
      }
      r = await runStep("shoot --all", "shoot", { _: ["shoot", paths.timeline], all: true });
      if (r.code !== 0) return finish(r.code);
      r = await runStep("assemble", "assemble", { _: ["assemble", paths.timeline], edl: true, out: paths.finalMp4, ...(songAudio ? { song: songAudio } : {}) });
      if (r.code !== 0) return finish(r.code);
      r = await runStep("contact-sheet", "contact-sheet", { _: ["contact-sheet", paths.finalMp4], out: path.join(paths.edit, "final.contact.jpg"), project: paths.dir });
      return finish(r.code);
    });
  });

// ── errors, help, main ────────────────────────────────────────────────────────────────────────────────────

/**
 * Exit code for any thrown value: FilmCliError → its code; JevError 'config'/'auth' → 2, other kinds → 1;
 * FilmPlanError → 1 (BAD_ARGUMENT → 2); FilmShotError → 2; a missing binary/file (ENOENT) → 2; anything else → 2.
 * @param {unknown} e
 * @returns {number}
 */
export function exitCodeFor(e) {
  if (e instanceof FilmCliError) return e.exitCode;
  if (e instanceof JevError || e?.name === "JevError") return e.kind === "config" || e.kind === "auth" ? EXIT.USAGE : EXIT.FINDING;
  if (e?.name === "FilmPlanError") return e.code === "BAD_ARGUMENT" ? EXIT.USAGE : EXIT.FINDING;
  if (e?.name === "FilmShotError") return EXIT.USAGE;
  return EXIT.USAGE;
}

function errorMessage(e) {
  if (e?.name === "JevError") return `JEV ${e.kind}: ${e.message}${e.retryAfterMs != null ? ` (retry after ${Math.ceil(e.retryAfterMs / 1000)} s)` : ""}`;
  return e?.message ?? String(e);
}

function errorJson(e) {
  if (e && typeof e.toJSON === "function") return e.toJSON();
  return { name: e?.name ?? "Error", message: e?.message ?? String(e) };
}

function generalUsage() {
  const names = Object.keys(COMMANDS);
  return [
    "film — AC Film Mode CLI (holtburger-web, ?filmMode=on). The director is a Claude Code session; JEV flies the camera.",
    "",
    "usage: node tools/film/film.mjs <command> [options] [--json] [--help]",
    "",
    ...names.map((n) => `  ${n.padEnd(16)} ${COMMANDS[n].summary}`),
    "",
    "exit codes: 0 ok · 1 finding · 2 usage/environment. Options use --key=value. See <command> --help.",
  ].join("\n");
}

function resolveCommand(pos) {
  const two = pos.length >= 2 ? `${pos[0]} ${pos[1]}` : null;
  if (two && COMMANDS[two]) return COMMANDS[two];
  if (pos[0] && COMMANDS[pos[0]]) return COMMANDS[pos[0]];
  return null;
}

/**
 * Run the CLI. Never throws and never calls process.exit: it returns the exit code.
 * @param {string[]} [argv] arguments after `film.mjs`
 * @param {{chromium?: object, spawn?: Function, fs?: object, env?: object, now?: () => number,
 *   sleep?: (ms: number) => Promise<void>, log?: (entry: object) => void, stdout?: {write: Function},
 *   stderr?: {write: Function}, fetch?: Function, acquireHeavyLock?: Function, registry?: object,
 *   resolvePlaywright?: () => string, createJevClient?: Function, home?: string, versions?: object,
 *   cwd?: string}} [deps]
 * @returns {Promise<number>} exit code
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const d = withDefaults(deps);
  const scrubber = createScrubber();
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    createIo({ stdout: d.stdout, stderr: d.stderr, scrubber }).info(`film: ${e.message}`);
    return EXIT.USAGE;
  }
  const json = args.json === true || args.json === "true";
  const io = createIo({ stdout: d.stdout, stderr: d.stderr, json, scrubber });
  // Secrets known up front: never echo them, whatever happens next.
  if (typeof args.password === "string") io.addSecret(args.password);
  if (typeof d.env?.FILM_PASSWORD === "string") io.addSecret(d.env.FILM_PASSWORD);
  for (const k of ["OPENROUTER_API_KEY", "OPENROUTER_KEY"]) if (typeof d.env?.[k] === "string" && d.env[k].trim()) io.addSecret(d.env[k].trim());

  const cmd = resolveCommand(args._);
  if (!cmd) {
    if (args._.length === 0 && (args.help || argv.length === 0)) {
      if (json) io.emitJson({ ok: true, commands: Object.keys(COMMANDS) });
      else io.out(generalUsage());
      return EXIT.OK;
    }
    io.info(`film: unknown command '${args._.join(" ")}'\n\n${generalUsage()}`);
    if (json) io.emitJson({ ok: false, error: { code: "USAGE", message: `unknown command '${args._.join(" ")}'` } });
    return EXIT.USAGE;
  }
  if (args.help) {
    if (json) io.emitJson({ ok: true, command: cmd.name, usage: cmd.usage });
    else io.out(`${cmd.name} — ${cmd.summary}\n\nusage: ${cmd.usage}`);
    return EXIT.OK;
  }
  const ctx = {
    args,
    deps: d,
    io,
    cmd: cmd.name,
    keep: [],
    jev: undefined,
    eventFile: null,
    // Called as `someCtx.event(e)`: `this` is the (sub-)context whose eventFile applies (`run` copies the ctx).
    event(entry) {
      try {
        d.log?.(entry);
      } catch {
        // a broken sink never stops a shoot
      }
      const file = this?.eventFile ?? null;
      if (file) {
        try {
          appendJsonl(file, entry, { fs: d.fs, scrub: io.scrub, replacer: jsonReplacer });
        } catch {
          // telemetry is best-effort
        }
      }
    },
  };
  let code;
  try {
    const r = await cmd.run(ctx);
    code = Number.isInteger(r?.code) ? r.code : EXIT.OK;
    if (json) io.emitJson({ ok: code === EXIT.OK, command: cmd.name, exitCode: code, ...(r?.data && typeof r.data === "object" ? { result: r.data } : {}) });
    else if (r?.text) io.out(r.text);
  } catch (e) {
    code = exitCodeFor(e);
    io.info(`film ${cmd.name}: ${errorMessage(e)}`);
    if (e?.name === "FilmPlanError" && Array.isArray(e.details?.errors)) io.info(printIssues(e.details.errors));
    if (json) io.emitJson({ ok: false, command: cmd.name, exitCode: code, error: errorJson(e) });
  } finally {
    try {
      ctx.jev?.client?.close?.();
    } catch {
      // ignore
    }
  }
  return code;
}

// ── entry point ───────────────────────────────────────────────────────────────────────────────────────────

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
      // Playwright can keep the event loop alive after a CDP session: force the exit shortly after.
      setTimeout(() => process.exit(code), 1500).unref();
    },
    (e) => {
      process.stderr.write(`film: internal error: ${redactUrl(String(e?.stack ?? e))}\n`);
      process.exit(EXIT.USAGE);
    },
  );
}
