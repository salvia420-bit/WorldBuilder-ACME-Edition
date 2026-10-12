// rynth/vt/cmd/coords.js — VTank map coordinates for the /rs command line
// (PLAN W1-5 CMD, §3.7; guide G:218 `/rs addnavpt <coords>`).
//
// Map coordinates are the retail /loc "degrees": NS positive = North, EW
// positive = East, |deg| <= 102 (the map spans ~±101.95; the same bound as
// the `!bot goto` parser, rynth/control_channel.js MAX_LOC_DEG). Z is in nav
// units = metres / 240 (the .nav file unit, rynth/nav_file.js navPointToLeg),
// so a pose's z converts as pose.z / 240 (fixes C# addnavpt writing metres,
// U7b H10).
//
// Accepted forms (args are the whitespace-split words after the verb; commas
// may be glued to a word or stand alone):
//   12.3N 41.5E            12.3S, 41.5W          41.5E 12.3N (letters decide)
//   -12.3 41.5             (signed: NS first, then EW, like `!bot goto`)
//   12.3n,41.5e 0.5        (an optional third number = z in nav units)
//   12.3 N 41.5 E          (a lone direction letter applies to the number before it)
//   41.53N, 34.46E, 0.20Z  (the expression coordinates string, e.g. `/vt addnavpt `+$tempCoords
//                           in the corpus; a Z suffix marks the z value)
//   41.53|34.46|0.2        (RynthAi's internal "NS|EW|Z" coordinates form)
//
// Pure module: no imports, no side effects.

export const MAX_LOC_DEG = 102;

const NUM_RE = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const LETTERED_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([nsewNSEW])$/;
const Z_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))[zZ]$/;
const LETTER_RE = /^[nsewNSEW]$/;
const PIPE_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\|([+-]?(?:\d+(?:\.\d*)?|\.\d+))(?:\|([+-]?(?:\d+(?:\.\d*)?|\.\d+)))?$/;

function err(error) {
  return { ok: false, error };
}

/**
 * Parse `/rs addnavpt` coordinates.
 * @param {string[]|string} args
 * @returns {{ok:true, ns:number, ew:number, z?:number} | {ok:false, error:string}}
 */
export function parseCoords(args) {
  const text = Array.isArray(args) ? args.map((a) => String(a ?? "")).join(" ") : String(args ?? "");
  const pipe = PIPE_RE.exec(text.trim());
  if (pipe) {
    const out = { ok: true, ns: Number(pipe[1]), ew: Number(pipe[2]) };
    if (pipe[3] !== undefined) out.z = Number(pipe[3]);
    if (Math.abs(out.ns) > MAX_LOC_DEG || Math.abs(out.ew) > MAX_LOC_DEG) {
      return err(`coordinates must be within ±${MAX_LOC_DEG} (got ${fmt(out.ns)}, ${fmt(out.ew)})`);
    }
    return out;
  }
  const words = text
    .replace(/,/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return err("no coordinates given (e.g. 12.3N 41.5E)");

  // Tokens: { value, axis: "ns"|"ew"|"z"|null, word }
  const toks = [];
  for (const w of words) {
    const zm = Z_RE.exec(w);
    if (zm) {
      toks.push({ value: Number(zm[1]), axis: "z", word: w });
      continue;
    }
    let m = LETTERED_RE.exec(w);
    if (m) {
      if (/^[+-]/.test(m[1])) return err(`"${w}": use either a sign or N/S/E/W, not both`);
      const letter = m[2].toLowerCase();
      const v = Number(m[1]);
      toks.push({ value: letter === "s" || letter === "w" ? -v : v, axis: letter === "n" || letter === "s" ? "ns" : "ew", word: w });
      continue;
    }
    if (LETTER_RE.test(w)) {
      const prev = toks[toks.length - 1];
      if (!prev || prev.axis || /^[+-]/.test(prev.word)) return err(`stray direction "${w}"`);
      const letter = w.toLowerCase();
      prev.axis = letter === "n" || letter === "s" ? "ns" : "ew";
      if (letter === "s" || letter === "w") prev.value = -prev.value;
      prev.word += w;
      continue;
    }
    if (NUM_RE.test(w)) {
      toks.push({ value: Number(w), axis: null, word: w });
      continue;
    }
    return err(`cannot read "${w}" as a coordinate`);
  }

  let ns = null;
  let ew = null;
  let z;
  const plain = [];
  for (const t of toks) {
    if (t.axis === "ns") {
      if (ns !== null) return err("two N/S coordinates given");
      ns = t.value;
    } else if (t.axis === "ew") {
      if (ew !== null) return err("two E/W coordinates given");
      ew = t.value;
    } else if (t.axis === "z") {
      if (z !== undefined) return err("two Z values given");
      z = t.value;
    } else {
      plain.push(t);
    }
  }
  // Unlettered numbers fill the missing axes in NS, EW order; one more is z.
  for (const t of plain) {
    if (ns === null) ns = t.value;
    else if (ew === null) ew = t.value;
    else if (z === undefined) z = t.value;
    else return err(`too many numbers ("${t.word}")`);
  }
  if (ns === null || ew === null) return err("need both an N/S and an E/W coordinate");
  if (!Number.isFinite(ns) || !Number.isFinite(ew) || (z !== undefined && !Number.isFinite(z))) {
    return err("coordinates must be finite numbers");
  }
  if (Math.abs(ns) > MAX_LOC_DEG || Math.abs(ew) > MAX_LOC_DEG) {
    return err(`coordinates must be within ±${MAX_LOC_DEG} (got ${fmt(ns)}, ${fmt(ew)})`);
  }
  return z === undefined ? { ok: true, ns, ew } : { ok: true, ns, ew, z };
}

/**
 * Map coordinates of a pose {objCellId, x, y, z} (landblock-local metres):
 * the outdoor "classic radar" projection (EW = (lbX*192 + x)/240 - 101.95,
 * identical to rynth/nav_file.js legToNavPoint/worldToDeg; C#
 * NavCoordinateHelper). Indoors this yields the landblock-local "coords",
 * like C#. z is in nav units (pose.z / 240). null for a missing pose.
 */
export function poseToCoords(pose) {
  if (!pose || typeof pose !== "object") return null;
  const cell = Number(pose.objCellId) >>> 0;
  const x = Number(pose.x);
  const y = Number(pose.y);
  const zm = Number(pose.z);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const wx = ((cell >>> 24) & 0xff) * 192 + x;
  const wy = ((cell >>> 16) & 0xff) * 192 + y;
  return { ns: (wy / 24 - 1019.5) / 10, ew: (wx / 24 - 1019.5) / 10, z: Number.isFinite(zm) ? zm / 240 : 0 };
}

function fmt(n) {
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : String(n);
}

/** "12.30N, 41.50E" (+ ", 0.47Z" when z is given) — the RynthAi coordinatetostring form. */
export function coordsToText(ns, ew, z) {
  const a = `${Math.abs(ns).toFixed(2)}${ns >= 0 ? "N" : "S"}, ${Math.abs(ew).toFixed(2)}${ew >= 0 ? "E" : "W"}`;
  return z === undefined || z === null ? a : `${a}, ${Number(z).toFixed(2)}Z`;
}
