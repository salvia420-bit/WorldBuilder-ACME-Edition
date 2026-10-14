// tools/film/lib/project.mjs — film project directories: layout, `project init`, and JSON file helpers.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) produces many artefacts per music video or story — the pasted
// script, plan.json, the song and its analysis, raw takes, scout stills, take reports and the final edit. One
// fixed layout lets the director (a Claude Code session) and every CLI subcommand find them without flags, and
// keeps the 8 GB laptop's full system disk out of it (owner decision: projects live on /mnt/wbterminal2).
//
// Layout of <root>/<name>/ (created by initProject; refuses to overwrite):
//   project.json   {name, created, version: 1}
//   script.txt     the director's pasted script / lyrics
//   plan.json      Plan JSON v1 skeleton (tools/film/plan/schema.mjs) — the director fills sites and shots
//   timeline.json  written by `film plan compile`
//   song/          song audio + song.json (`film song analyze`)
//   takes/         raw drains (<shot>.h264 | .ivf | .frames/) and muxed <shot>.mp4
//   stills/        scout stills (<shot>/cand-<i>.jpg + metrics.json)
//   reports/       <shot>.json take reports, shoot-log.jsonl, rehearsal tables, JEV telemetry
//   edit/          final.mp4, final.edl, contact sheets
//
// Node-only; the fs module is injected so tests can use a temp directory.

import nodeFs from "node:fs";
import path from "node:path";

import { FilmCliError, EXIT, usageError } from "./args.mjs";

/** Default project root (owner decision 2026-10-13: the external drive, never the system disk). */
export const DEFAULT_PROJECT_ROOT = "/mnt/wbterminal2/film-projects";
/** Sub-directories of every project. */
export const PROJECT_SUBDIRS = Object.freeze(["song", "takes", "stills", "reports", "edit"]);
/** Project names are directory names: no separators, no leading dot. */
export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
/** project.json schema version. */
export const PROJECT_VERSION = 1;

/**
 * Every well-known path inside a project directory.
 * @param {string} dir project directory
 * @returns {{dir:string, projectJson:string, script:string, plan:string, timeline:string, song:string,
 *   songJson:string, takes:string, stills:string, reports:string, edit:string, shootLog:string,
 *   finalMp4:string, finalEdl:string}}
 */
export function projectPaths(dir) {
  const d = path.resolve(dir);
  return {
    dir: d,
    projectJson: path.join(d, "project.json"),
    script: path.join(d, "script.txt"),
    plan: path.join(d, "plan.json"),
    timeline: path.join(d, "timeline.json"),
    song: path.join(d, "song"),
    songJson: path.join(d, "song", "song.json"),
    takes: path.join(d, "takes"),
    stills: path.join(d, "stills"),
    reports: path.join(d, "reports"),
    edit: path.join(d, "edit"),
    shootLog: path.join(d, "reports", "shoot-log.jsonl"),
    finalMp4: path.join(d, "edit", "final.mp4"),
    finalEdl: path.join(d, "edit", "final.edl"),
  };
}

/**
 * The plan.json skeleton written by `project init`: valid shape, empty sites/shots (the director fills them;
 * `film plan validate` reports what is missing).
 * @param {string} name
 * @returns {object}
 */
export function planSkeleton(name) {
  return {
    version: 1,
    title: name,
    kind: "music-video",
    format: { width: 1920, height: 1080, fps: 30, capture: "stepped" },
    song: { file: "song/song.mp3", analysis: "song/song.json", offsetSec: 0 },
    defaults: { transition: "cut", pilot: { mode: "jev" }, look: {} },
    edit: { fadeInSec: 0, fadeOutSec: 0 },
    sites: [],
    shots: [],
  };
}

const SCRIPT_PLACEHOLDER =
  "# Paste the script (or the song's lyrics) below this line. The film director turns it into plan.json.\n";

/**
 * Create a project tree. Refuses (FilmCliError, exit 2) when the directory already exists — even an empty one —
 * so a typo can never overwrite a shoot.
 * @param {{root?: string, name: string, fs?: typeof nodeFs, now?: () => number}} opts
 * @returns {{dir: string, created: string, files: string[], dirs: string[]}}
 */
export function initProject({ root = DEFAULT_PROJECT_ROOT, name, fs = nodeFs, now = Date.now } = {}) {
  if (typeof name !== "string" || !PROJECT_NAME_RE.test(name)) {
    throw usageError(`project name must match ${PROJECT_NAME_RE} (letters, digits, '_', '-', '.'; got '${name ?? ""}')`);
  }
  if (typeof root !== "string" || !root) throw usageError("--root must be a directory path");
  const p = projectPaths(path.join(root, name));
  if (fs.existsSync(p.dir)) {
    throw new FilmCliError(`refusing to overwrite: ${p.dir} already exists`, { exitCode: EXIT.USAGE, code: "PROJECT_EXISTS" });
  }
  const created = new Date(now()).toISOString();
  fs.mkdirSync(p.dir, { recursive: true });
  const dirs = [];
  for (const sub of PROJECT_SUBDIRS) {
    const d = path.join(p.dir, sub);
    fs.mkdirSync(d, { recursive: true });
    dirs.push(d);
  }
  const files = [];
  const write = (file, text) => {
    // 'wx' = fail if it exists (belt and braces against a race with another init)
    fs.writeFileSync(file, text, { encoding: "utf8", flag: "wx" });
    files.push(file);
  };
  write(p.projectJson, `${JSON.stringify({ name, created, version: PROJECT_VERSION }, null, 2)}\n`);
  write(p.script, SCRIPT_PLACEHOLDER);
  write(p.plan, `${JSON.stringify(planSkeleton(name), null, 2)}\n`);
  return { dir: p.dir, created, files, dirs };
}

/**
 * Read and parse a JSON file; a missing or malformed file is a usage error (exit 2) naming the file.
 * @param {string} file
 * @param {{fs?: typeof nodeFs, what?: string}} [opts]
 * @returns {any}
 */
export function readJsonFile(file, { fs = nodeFs, what = "file" } = {}) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    throw usageError(`cannot read ${what} ${file}: ${e?.code ?? e?.message ?? e}`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (e) {
    throw usageError(`${what} ${file} is not valid JSON: ${e?.message ?? e}`);
  }
}

/**
 * Inline JSON (`{…}` / `[…]`) or a path to a JSON file.
 * @param {string} value
 * @param {{fs?: typeof nodeFs, what?: string}} [opts]
 * @returns {any}
 */
export function jsonOrFile(value, { fs = nodeFs, what = "JSON" } = {}) {
  const s = String(value ?? "").trim();
  if (s.startsWith("{") || s.startsWith("[")) {
    try {
      return JSON.parse(s);
    } catch (e) {
      throw usageError(`inline ${what} is not valid JSON: ${e?.message ?? e}`);
    }
  }
  if (!s) throw usageError(`${what} is empty`);
  return readJsonFile(s, { fs, what });
}

/**
 * The project directory a timeline/plan file belongs to: `--project` when given, else the file's directory.
 * @param {string} file
 * @param {string|null} [explicit]
 * @returns {string}
 */
export function projectDirFor(file, explicit = null) {
  return path.resolve(explicit || path.dirname(path.resolve(file)));
}

/**
 * Write JSON (pretty, trailing newline), creating parent directories. `scrub` (the CLI's secret scrubber) is
 * applied to the text, so a report can never carry the password or the key.
 * @param {string} file
 * @param {unknown} obj
 * @param {{fs?: typeof nodeFs, scrub?: (t: string) => string, replacer?: Function}} [opts]
 * @returns {string} the file path
 */
export function writeJsonFile(file, obj, { fs = nodeFs, scrub = (t) => t, replacer } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${scrub(JSON.stringify(obj, replacer, 2))}\n`, "utf8");
  return file;
}

/**
 * Append one JSON line (scrubbed), creating parent directories.
 * @param {string} file
 * @param {unknown} obj
 * @param {{fs?: typeof nodeFs, scrub?: (t: string) => string, replacer?: Function}} [opts]
 */
export function appendJsonl(file, obj, { fs = nodeFs, scrub = (t) => t, replacer } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${scrub(JSON.stringify(obj, replacer))}\n`, "utf8");
}
