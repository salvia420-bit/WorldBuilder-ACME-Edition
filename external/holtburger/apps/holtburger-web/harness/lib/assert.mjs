// harness/lib/assert.mjs — tiny ESM assertion + result-classifier helpers
// shared by every flags.*.mjs descriptor's assertBrowser() and by the driver.
//
// Deliberately dependency-free (no node:assert import) so it loads identically
// in Node and — if ever needed — inside page.evaluate via a stringified copy.
//
// The four result statuses are load-bearing (see harness/lib/schema.md):
//   'pass'            — the behavior/getter was observed and matched.
//   'fail'            — the behavior/getter was present + reachable but WRONG.
//   'skip'            — a precondition that CANNOT be satisfied from a URL was
//                       unmet (a Rust const is off; a compose-dep mob/NPC was
//                       not in view; the run had no world). NOT a defect.
//   'rebuild-pending' — a wasm export/getter the assert needs is ABSENT from
//                       the current pkg/. The user's separate wasm rebuild is
//                       expected to add it. NEVER report this as 'fail'.

export const STATUSES = Object.freeze(["pass", "fail", "skip", "rebuild-pending"]);

/**
 * Throw an Error(msg) when cond is falsy. Mirrors node:assert(ok) but with a
 * required message and a stable `.assertion = true` tag so assertBrowser()
 * bodies can distinguish a deliberate assertion failure (=> 'fail') from an
 * unexpected runtime throw.
 * @param {*} cond
 * @param {string} msg
 */
export function assert(cond, msg) {
  if (!cond) {
    const err = new Error(msg || "assertion failed");
    err.assertion = true;
    throw err;
  }
}

/**
 * Assert strict (SameValue, so NaN===NaN passes) equality.
 * @param {*} actual
 * @param {*} expected
 * @param {string} [msg]
 */
export function assertEqual(actual, expected, msg) {
  if (!Object.is(actual, expected)) {
    assert(
      false,
      `${msg ? msg + ": " : ""}expected ${fmt(expected)}, got ${fmt(actual)}`
    );
  }
}

/**
 * Assert two finite numbers are within `epsilon` (default 1e-6) of each other.
 * @param {number} actual
 * @param {number} expected
 * @param {number} [epsilon=1e-6]
 * @param {string} [msg]
 */
export function assertApprox(actual, expected, epsilon = 1e-6, msg) {
  const a = Number(actual);
  const e = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(e)) {
    assert(
      false,
      `${msg ? msg + ": " : ""}non-finite in approx compare (actual=${fmt(actual)}, expected=${fmt(expected)})`
    );
  }
  const delta = Math.abs(a - e);
  if (delta > epsilon) {
    assert(
      false,
      `${msg ? msg + ": " : ""}expected ${e} ±${epsilon}, got ${a} (delta ${delta})`
    );
  }
}

/**
 * Build a normalized result envelope. Use this as the return value of every
 * assertBrowser(helpers). The driver reads { status, detail }.
 * @param {('pass'|'fail'|'skip'|'rebuild-pending')} status
 * @param {string} [detail] human-readable one-liner (reason on skip/pending/fail)
 * @returns {{status:string, detail:string}}
 */
export function result(status, detail = "") {
  if (!STATUSES.includes(status)) {
    throw new Error(
      `result(): status must be one of ${STATUSES.join("|")}, got ${fmt(status)}`
    );
  }
  return { status, detail: String(detail) };
}

// Convenience constructors so descriptor bodies read cleanly.
export const pass = (detail = "") => result("pass", detail);
export const fail = (detail = "") => result("fail", detail);
export const skip = (detail = "") => result("skip", detail);
export const rebuildPending = (detail = "") => result("rebuild-pending", detail);

/**
 * Run an assertion-bearing fn and map its outcome to a result envelope:
 *   - returns normally           => pass(passDetail)
 *   - throws err.assertion===true => fail(err.message)
 *   - throws anything else        => fail("unexpected: " + err.message)
 * Lets a descriptor write straight-line assert() calls without try/catch.
 * @param {() => void} fn
 * @param {string} [passDetail]
 * @returns {{status:string, detail:string}}
 */
export function runAsserts(fn, passDetail = "") {
  try {
    fn();
    return pass(passDetail);
  } catch (err) {
    if (err && err.assertion) return fail(err.message);
    return fail(`unexpected: ${err && err.message ? err.message : String(err)}`);
  }
}

function fmt(v) {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "bigint") return `${v}n`;
  try {
    return String(v);
  } catch (_) {
    return Object.prototype.toString.call(v);
  }
}
