// tools/film/lib/args.mjs — argument parsing, typed CLI errors, secret scrubbing and the output channel for the
// film CLI (tools/film/film.mjs).
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) is driven by a Claude Code director through `film.mjs`. Three
// things every subcommand shares live here so they behave the same everywhere:
//   1. a hand-rolled parser (`--key=value`, `--flag`, `--no-flag`, positionals, `--` ends options) — no
//      dependencies, deterministic, testable;
//   2. FilmCliError, which carries the process exit code (0 ok / 1 finding / 2 usage-or-environment);
//   3. the output channel. The account password and the OpenRouter key must NEVER reach stdout, stderr, a log, a
//      report file or an error message, so every byte the CLI writes passes through a scrubber that removes
//      `password=…` query values and the literal secret strings registered at run time.
//
// Node-only, pure except for the injected stream writers.

/** Exit codes (SPEC §5): 0 ok, 1 finding (validation failure, take rejected, check failed), 2 usage/environment. */
export const EXIT = Object.freeze({ OK: 0, FINDING: 1, USAGE: 2 });

/**
 * A CLI failure with an exit code. `code` is a short machine-readable tag; `details` is JSON-safe extra data
 * that `--json` output carries.
 */
export class FilmCliError extends Error {
  /**
   * @param {string} message human-readable (never contains a secret: it is scrubbed again on output anyway)
   * @param {{exitCode?: number, code?: string, details?: unknown, cause?: unknown}} [opts]
   */
  constructor(message, opts = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "FilmCliError";
    this.exitCode = Number.isInteger(opts.exitCode) ? opts.exitCode : EXIT.USAGE;
    this.code = typeof opts.code === "string" && opts.code ? opts.code : "FILM_CLI";
    if (opts.details !== undefined) this.details = opts.details;
  }

  /** JSON form for `--json` output. */
  toJSON() {
    const out = { name: this.name, code: this.code, message: this.message, exitCode: this.exitCode };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** Shorthand: a usage error (exit 2). */
export function usageError(message, details) {
  return new FilmCliError(message, { exitCode: EXIT.USAGE, code: "USAGE", details });
}

/** Shorthand: a finding (exit 1). */
export function findingError(message, code = "FINDING", details) {
  return new FilmCliError(message, { exitCode: EXIT.FINDING, code, details });
}

/**
 * Parse argv (WITHOUT the node binary and script path).
 * - `--key=value` → `args[key] = "value"` (the value may contain `=`; the last occurrence wins)
 * - `--flag` → `args.flag = true`; `--no-flag` → `args.flag = false`
 * - `-h` → `args.help = true`
 * - anything else → positional (`args._`); a lone `--` makes every later token positional
 * Keys keep their spelling (`--boot-timeout=5` → `args["boot-timeout"]`). `--key value` (space) is NOT supported:
 * the value would be read as a positional.
 * @param {string[]} argv
 * @returns {{_: string[], [key: string]: string|boolean|string[]}}
 */
export function parseArgs(argv) {
  const out = { _: [] };
  let rest = false;
  for (const raw of Array.isArray(argv) ? argv : []) {
    const tok = String(raw);
    if (rest) {
      out._.push(tok);
      continue;
    }
    if (tok === "--") {
      rest = true;
      continue;
    }
    if (tok === "-h") {
      out.help = true;
      continue;
    }
    if (tok.startsWith("--") && tok.length > 2) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq === 0) throw usageError(`malformed option '${tok}'`);
      if (eq > 0) {
        out[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (body.startsWith("no-") && body.length > 3) {
        out[body.slice(3)] = false;
      } else {
        out[body] = true;
      }
      continue;
    }
    out._.push(tok);
  }
  return out;
}

/**
 * Read a numeric option. Absent → `def`. Throws a usage error for a non-number, a boolean flag without value, or
 * a value outside [min, max] / not an integer when `integer`.
 * @param {object} args parsed args
 * @param {string} key
 * @param {number|null} def
 * @param {{min?: number, max?: number, integer?: boolean}} [opts]
 * @returns {number|null}
 */
export function numArg(args, key, def, opts = {}) {
  const v = args?.[key];
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") throw usageError(`--${key} needs a value (--${key}=N)`);
  const n = Number(v);
  if (String(v).trim() === "" || !Number.isFinite(n)) throw usageError(`--${key} must be a number (got '${v}')`);
  if (opts.integer && !Number.isInteger(n)) throw usageError(`--${key} must be an integer (got '${v}')`);
  if (opts.min !== undefined && n < opts.min) throw usageError(`--${key} must be ≥ ${opts.min} (got ${n})`);
  if (opts.max !== undefined && n > opts.max) throw usageError(`--${key} must be ≤ ${opts.max} (got ${n})`);
  return n;
}

/**
 * Read a string option. Absent → `def`; a bare `--key` (boolean) is a usage error.
 * @param {object} args
 * @param {string} key
 * @param {string|null} [def]
 * @returns {string|null}
 */
export function strArg(args, key, def = null) {
  const v = args?.[key];
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") throw usageError(`--${key} needs a value (--${key}=…)`);
  return String(v);
}

/**
 * Read a boolean option: `--key`, `--key=true|1|yes|on` → true; `--no-key`, `--key=false|0|no|off` → false;
 * absent → `def` (default false; test `args[key] !== undefined` first when "absent" must stay distinguishable).
 * @param {object} args
 * @param {string} key
 * @param {boolean} [def=false]
 * @returns {boolean}
 */
export function boolArg(args, key, def = false) {
  const v = args?.[key];
  if (v === undefined || v === null) return def;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  throw usageError(`--${key} must be true or false (got '${v}')`);
}

/**
 * Matches a `password=` URL query value (after `?`, `&` or `;`, up to `&`, whitespace, quote or end). Only the
 * URL form: help text such as `--password=…` stays readable, and the literal secret is scrubbed separately.
 */
const PASSWORD_PARAM_RE = /([?&;]password=)[^&\s"'<>#]*/gi;

/**
 * Redact the password query value of a URL (or of any text that embeds one): `?…&password=hunter2` →
 * `&password=[redacted]`. Safe on non-URL text.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  return String(url ?? "").replace(PASSWORD_PARAM_RE, "$1[redacted]");
}

/**
 * A scrubber that removes every registered secret (literal and URL-encoded) and every `password=` value from
 * text. Secrets shorter than 4 characters are still removed (better a mangled log than a leaked password).
 * @returns {{add: (secret: string|null|undefined) => void, scrub: (text: unknown) => string, size: () => number}}
 */
export function createScrubber() {
  const secrets = new Set();
  return {
    add(secret) {
      if (typeof secret !== "string" || secret.length === 0) return;
      secrets.add(secret);
      const enc = encodeURIComponent(secret);
      if (enc !== secret) secrets.add(enc);
    },
    scrub(text) {
      let s = typeof text === "string" ? text : String(text ?? "");
      s = s.replace(PASSWORD_PARAM_RE, "$1[redacted]");
      // Longest first, so a secret that contains another is removed whole.
      for (const sec of [...secrets].sort((a, b) => b.length - a.length)) {
        if (s.includes(sec)) s = s.split(sec).join("[redacted]");
      }
      return s;
    },
    size() {
      return secrets.size;
    },
  };
}

/**
 * The CLI output channel. Results go to stdout (human text, or one JSON document with `--json`); progress and
 * warnings go to stderr. Every write is scrubbed.
 * @param {{stdout: {write: Function}, stderr: {write: Function}, json?: boolean, scrubber?: ReturnType<typeof createScrubber>}} o
 * @returns {{json: boolean, scrub: (t: unknown) => string, addSecret: (s: string) => void,
 *   out: (text: string) => void, info: (text: string) => void, warn: (text: string) => void,
 *   emitJson: (obj: unknown) => void, safeJson: (obj: unknown, space?: number) => string}}
 */
export function createIo({ stdout, stderr, json = false, scrubber = createScrubber() }) {
  const write = (stream, text) => {
    try {
      stream?.write?.(scrubber.scrub(text));
    } catch {
      // a closed pipe must not crash the CLI
    }
  };
  const safeJson = (obj, space = 2) => scrubber.scrub(JSON.stringify(obj, jsonReplacer, space));
  return {
    json,
    scrub: (t) => scrubber.scrub(t),
    addSecret: (s) => scrubber.add(s),
    out: (text) => {
      if (!json) write(stdout, text.endsWith("\n") ? text : `${text}\n`);
    },
    info: (text) => write(stderr, text.endsWith("\n") ? text : `${text}\n`),
    warn: (text) => write(stderr, `warning: ${text}${text.endsWith("\n") ? "" : "\n"}`),
    emitJson: (obj) => {
      if (json) write(stdout, `${safeJson(obj)}\n`);
    },
    safeJson,
  };
}

/** JSON.stringify replacer: Infinity/NaN → strings (page SensorFrames use Infinity), Errors → {name, message}. */
export function jsonReplacer(_key, value) {
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (value instanceof Error) {
    return typeof value.toJSON === "function" ? value.toJSON() : { name: value.name, message: value.message };
  }
  if (typeof value === "bigint") return value.toString();
  return value;
}
