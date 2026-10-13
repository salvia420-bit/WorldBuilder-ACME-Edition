// scene3d/film/core/errors.js — typed errors for AC Film Mode (SPEC §2).
//
// WHY: every film module (pure math, shot grammar, pilot, page runtime, Node
// CLI) reports faults through ONE small class family so callers can tell a
// film fault from a programming bug (`instanceof FilmError`) and branch on a
// machine-readable `.code` instead of parsing messages. The page API turns
// these into `{ok:false, error}` (toErrorJSON) instead of throwing.
//
// Film mode is DEFAULT OFF (`?filmMode=on`); nothing here runs otherwise.
// Pure module: no DOM, no three, no wasm, no clocks.

/**
 * Machine-readable codes used by the core modules. Other lanes may use their
 * own string codes; these are the shared, documented ones.
 * @type {Readonly<{FILM_ERROR:string, SHOT_ERROR:string, PLAN_ERROR:string,
 *   BAD_ARGUMENT:string, UNKNOWN_EASING:string, BAD_CELL_ID:string, BAD_COMMAND:string}>}
 */
export const FILM_ERROR_CODES = Object.freeze({
  /** Default code of a plain FilmError. */
  FILM_ERROR: "FILM_ERROR",
  /** Default code of a FilmShotError (shot/trajectory construction). */
  SHOT_ERROR: "FILM_SHOT_ERROR",
  /** Default code of a FilmPlanError (plan.json validation/compilation). */
  PLAN_ERROR: "FILM_PLAN_ERROR",
  /** A numeric/config argument is out of its documented domain. */
  BAD_ARGUMENT: "BAD_ARGUMENT",
  /** `ease(name)` was given a name that is not in EASINGS. */
  UNKNOWN_EASING: "UNKNOWN_EASING",
  /** A landblock/cell id could not be parsed as an unsigned 32-bit id. */
  BAD_CELL_ID: "BAD_CELL_ID",
  /** A chat/admin command could not be formatted safely. */
  BAD_COMMAND: "BAD_COMMAND",
});

/**
 * Normalise the second constructor argument: a code string or an options bag.
 * @param {string|{code?:string, details?:*, cause?:*}|undefined|null} codeOrOptions
 * @returns {{code?:string, details?:*, cause?:*}}
 */
function readOptions(codeOrOptions) {
  if (typeof codeOrOptions === "string") return { code: codeOrOptions };
  if (codeOrOptions && typeof codeOrOptions === "object") return codeOrOptions;
  return {};
}

/** @param {*} codeOrOptions @returns {boolean} true when an explicit non-empty code was supplied. */
function hasExplicitCode(codeOrOptions) {
  const c = readOptions(codeOrOptions).code;
  return typeof c === "string" && c.length > 0;
}

/**
 * Base class of every film-mode error.
 *
 * `new FilmError(message, code)` or `new FilmError(message, {code, details, cause})`.
 * `.code` is always a non-empty string (default "FILM_ERROR"); `.details` is an
 * optional JSON-safe payload; `.cause` follows the standard Error cause option.
 */
export class FilmError extends Error {
  /**
   * @param {string} message human-readable description (shown to the director)
   * @param {string|{code?:string, details?:*, cause?:*}} [codeOrOptions]
   */
  constructor(message, codeOrOptions) {
    const opts = readOptions(codeOrOptions);
    super(message == null ? "" : String(message), opts.cause !== undefined ? { cause: opts.cause } : undefined);
    /** @type {string} */
    this.name = "FilmError";
    /** @type {string} */
    this.code = hasExplicitCode(codeOrOptions) ? opts.code : FILM_ERROR_CODES.FILM_ERROR;
    if (opts.details !== undefined) {
      /** @type {*} */
      this.details = opts.details;
    }
  }

  /**
   * JSON-safe form used by the page API (`{ok:false, error}`) and the CLI logs.
   * @returns {{name:string, code:string, message:string, details?:*}}
   */
  toJSON() {
    const out = { name: this.name, code: this.code, message: this.message };
    if (this.details !== undefined) out.details = this.details;
    return out;
  }
}

/** A shot / trajectory / technique could not be built or validated (default code "FILM_SHOT_ERROR"). */
export class FilmShotError extends FilmError {
  /**
   * @param {string} message
   * @param {string|{code?:string, details?:*, cause?:*}} [codeOrOptions]
   */
  constructor(message, codeOrOptions) {
    super(message, codeOrOptions);
    this.name = "FilmShotError";
    if (!hasExplicitCode(codeOrOptions)) this.code = FILM_ERROR_CODES.SHOT_ERROR;
  }
}

/** A film plan (plan.json) is invalid or cannot be compiled (default code "FILM_PLAN_ERROR"). */
export class FilmPlanError extends FilmError {
  /**
   * @param {string} message
   * @param {string|{code?:string, details?:*, cause?:*}} [codeOrOptions]
   */
  constructor(message, codeOrOptions) {
    super(message, codeOrOptions);
    this.name = "FilmPlanError";
    if (!hasExplicitCode(codeOrOptions)) this.code = FILM_ERROR_CODES.PLAN_ERROR;
  }
}

/**
 * True for any FilmError (including subclasses).
 * @param {*} err
 * @returns {boolean}
 */
export function isFilmError(err) {
  return err instanceof FilmError;
}

/**
 * JSON-safe description of ANY thrown value (FilmError → its toJSON(); other
 * Errors → code "INTERNAL_ERROR"; non-Errors → stringified). Never throws.
 * @param {*} err
 * @returns {{name:string, code:string, message:string, details?:*}}
 */
export function toErrorJSON(err) {
  if (err instanceof FilmError) return err.toJSON();
  if (err instanceof Error) {
    return { name: err.name || "Error", code: "INTERNAL_ERROR", message: String(err.message ?? "") };
  }
  let message;
  try {
    message = typeof err === "string" ? err : JSON.stringify(err);
  } catch {
    message = String(err);
  }
  return { name: "Error", code: "INTERNAL_ERROR", message: message === undefined ? String(err) : message };
}
