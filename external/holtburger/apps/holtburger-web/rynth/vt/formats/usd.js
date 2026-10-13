// rynth/vt/formats/usd.js — VirindiTank settings profile `.usd` reader and
// importer (import only; WebAC comparison item rynth-formats-expr-5).
//
// Format facts after WebAC packages/shared/src/routines/vtankUsd.ts and
// docs/vtank-formats.md §6 (AGPL-3.0), which took them from VTank-written
// files (MossTank's test fixtures); no VTank-written .usd is in this tree yet.
//
//   file  := [UTF-8 BOM] ntables EOL (name EOL body){ntables}
//   body  := ncols EOL colname{ncols} EOL ("y"|"n"){ncols} EOL nrows EOL value{ncols*nrows}
//   value := met.js's typed values: "n" | "i" EOL int | "d" EOL double | "s" EOL line
//          | "ba" EOL count EOL <count bytes, no EOL after> | "TABLE" EOL body
//          | "b" EOL ("True" | "False")                  (.usd only; any case)
//
// `y` marks a table's index (key) column. A nested table value is TABLE and a
// body without a name (RechargeHandlerSet's value). VTank writes CRLF and
// sorts the tables by name. A bare-LF copy reads too: its `ba` counts are
// VTank's CRLF character counts, with a raw byte-count retry (as met.js
// Reader.baEnd). A ',' in a `d` is a decimal comma (WebAC readValue).
//
// Tables (vtank-formats.md §6):
//   Settings           Setting (y), Value, Description, SettingType — 1 bool,
//                      2 double (distances in landblock fractions: ×240 = m),
//                      3 int, 5 string, 6 enum (an int), 7 table. Some files
//                      carry only Setting, Value.
//   MyMonsters         the Monsters tab, <DEFAULT> included: MonsterName (y),
//                      AttackPriority, DamageType, WeaponToUse (object id,
//                      -1 = Auto), 14 switch columns (`b`), SecondaryVuln,
//                      SecondaryEquip (object id, 0 = Auto), PetDamageType.
//   BuffedItems        Object id, Spell id — the Items tab in order, a row per
//                      buff spell (-1: none named).
//   AssistItems        Object (a name), Type — the Consumables tab: 0 health
//                      kit, 1 health food, 2 stamina kit, 3 stamina food,
//                      4 mana kit, 5 mana food, 6 mana charge, 7 grenade,
//                      8 mana stone, 9 pea, 10 lockpick, 11 all peas.
//   GemFoodItems       Name, Spell.
//   ExtraBuffSpells / AntiExtraBuffSpells   ExemplarId (one spell per family).
//   ItemUseSpecifiers  Object id (y), Uses.
//   SettingsCategories, SettingsEnumInfo, a plugin's own: kept in `tables`.
//
// importUsdProfile applies the Settings rows through VtOptions' VTank-name
// accessor (landblock fractions ×240, clamping, unknown names reported as
// `/rs opt` refuses them) and the Monsters tab to a NEW user profile made by
// Save As — never to Default, never over an existing profile. The Items,
// Consumables and Buffs tables name server-specific object ids / spell ids:
// they are parsed and reported, not applied.
//
// No imports (C2): VtOptions and the MonsterList entry validator are injected.

const dec = new TextDecoder("utf-8");
const enc = new TextEncoder();
const MAX_DEPTH = 8;
const MAX_COLS = 256;

class UsdError extends Error {
  constructor(msg, pos) {
    super(`${msg} (byte ${pos})`);
    this.pos = pos;
  }
}

// ── byte reader (met.js Reader grammar + `b`) ──────────────────────────────
class Reader {
  constructor(bytes, crlfCounts) {
    this.b = bytes;
    this.p = 0;
    this.end = bytes.length;
    // true for a bare-LF file: `ba` counts are VTank's CRLF character counts.
    this.crlfCounts = crlfCounts;
    this.oddFlags = 0;
  }
  line() {
    if (this.p >= this.end) throw new UsdError("unexpected end of file", this.p);
    const b = this.b;
    const s = this.p;
    let i = s;
    while (i < this.end && b[i] !== 10) i++;
    let e = i;
    if (i < this.end) {
      i++;
      if (e > s && b[e - 1] === 13) e--;
    }
    this.p = i;
    return dec.decode(b.subarray(s, e));
  }
  int(what) {
    const at = this.p;
    const t = this.line().trim();
    if (!/^[-+]?\d+$/.test(t)) throw new UsdError(`expected an integer ${what}, found ${JSON.stringify(t.slice(0, 40))}`, at);
    return parseInt(t, 10);
  }
  // End (exclusive) of a `ba` of count `n` at this.p (met.js Reader.baEnd).
  baEnd(n) {
    if (!this.crlfCounts) {
      if (n < 0 || this.p + n > this.end) throw new UsdError(`byte array of ${n} bytes runs past the end of the file`, this.p);
      return this.p + n;
    }
    if (n < 0) throw new UsdError(`byte array of ${n} characters runs past the end of the file`, this.p);
    const b = this.b;
    const s = this.p;
    let i = s;
    let c = 0;
    while (c < n) {
      if (i >= this.end) throw new UsdError(`byte array of ${n} characters runs past the end of the file`, s);
      c += b[i] === 10 && (i === s || b[i - 1] !== 13) ? 2 : 1;
      i++;
    }
    if (c !== n) throw new UsdError(`byte array of ${n} characters ends inside a line break`, s);
    return i;
  }
  value(depth) {
    const start = this.p;
    const tag = this.line().trim();
    switch (tag) {
      case "n":
        return { t: "n", v: null };
      case "i":
        return { t: "i", v: this.int("value") };
      case "d": {
        const at = this.p;
        const raw = this.line().trim();
        const n = Number(raw.replace(",", "."));
        if (!raw || !Number.isFinite(n)) throw new UsdError(`bad double ${JSON.stringify(raw.slice(0, 40))}`, at);
        return { t: "d", v: n };
      }
      case "s":
        return { t: "s", v: this.line() };
      case "b": {
        const at = this.p;
        const raw = this.line().trim();
        if (!/^(true|false)$/i.test(raw)) throw new UsdError(`expected True or False, found ${JSON.stringify(raw.slice(0, 40))}`, at);
        return { t: "b", v: raw.toLowerCase() === "true" };
      }
      case "ba": {
        const n = this.int("byte count");
        const e = this.baEnd(n);
        const v = dec.decode(this.b.subarray(this.p, e));
        this.p = e;
        return { t: "ba", v };
      }
      case "TABLE":
        if (depth >= MAX_DEPTH) throw new UsdError(`tables nested deeper than ${MAX_DEPTH}`, start);
        return { t: "table", ...this.body(depth + 1) };
      default:
        throw new UsdError(`unknown value type ${JSON.stringify(tag.slice(0, 20))}`, start);
    }
  }
  body(depth) {
    const at = this.p;
    const nc = this.int("column count");
    if (nc < 0 || nc > MAX_COLS) throw new UsdError(`bad column count ${nc}`, at);
    const cols = [];
    for (let i = 0; i < nc; i++) cols.push(this.line());
    const index = [];
    for (let i = 0; i < nc; i++) {
      const f = this.line().trim().toLowerCase();
      if (f !== "y" && f !== "n") this.oddFlags++;
      index.push(f === "y");
    }
    const rat = this.p;
    const nr = this.int("row count");
    // every value is at least two bytes: a count beyond the file is corrupt
    if (nr < 0 || nr > this.end - this.p) throw new UsdError(`bad row count ${nr}`, rat);
    const rows = [];
    for (let r = 0; r < nr; r++) {
      const row = [];
      for (let c = 0; c < nc; c++) row.push(this.value(depth));
      rows.push(row);
    }
    return { cols, index, rows };
  }
}

function readTables(body, crlfCounts) {
  const r = new Reader(body, crlfCounts);
  const n = r.int("table count");
  if (n < 0 || n > body.length) throw new UsdError(`bad table count ${n}`, 0);
  const tables = [];
  for (let i = 0; i < n; i++) {
    const name = r.line().trim();
    tables.push({ name, ...r.body(0) });
  }
  const trailing = dec.decode(body.subarray(r.p)).trim() ? body.length - r.p : 0;
  return { tables, trailing, oddFlags: r.oddFlags };
}

function toBytes(data) {
  if (typeof data === "string") return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data && ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

// The table-count line ends in a bare LF (a git LF copy).
function bareLfHeader(body) {
  const i = body.indexOf(10);
  return i > 0 && body[i - 1] !== 13;
}

// ── the tables' meaning ────────────────────────────────────────────────────

/** Tables whose meaning is known (vtank-formats.md §6). */
export const USD_TABLES = Object.freeze([
  "Settings", "MyMonsters", "BuffedItems", "AssistItems", "GemFoodItems", "ExtraBuffSpells", "AntiExtraBuffSpells",
  "ItemUseSpecifiers",
]);

/** MyMonsters' switch columns → the Monsters tab's columns (combat/monster_list.js MONSTER_COLUMNS).
 *  After WebAC vtankUsd.ts MONSTER_SWITCHES (AGPL-3.0). */
export const USD_MONSTER_SWITCHES = Object.freeze([
  ["Imperil", "I"], ["Vuln", "V"], ["Yield", "Y"], ["GravityW", "G"], ["Attack", "A"], ["Ring", "R"],
  ["Broadside", "B"], ["Fester", "F"], ["WeakeningCurse", "WC"], ["FesteringCurse", "FC"], ["Corruption", "Cp"],
  ["DestructiveCurse", "DC"], ["Corrosion", "Cs"], ["Streak", "S"],
].map((p) => Object.freeze(p)));

/** VirindiTank's damage elements as written in DamageType / SecondaryVuln /
 *  PetDamageType (after WebAC vtankProfile.ts VT_DAMAGE, from Virindi's
 *  public connector's VT_eDamageElement). */
export const VT_DAMAGE_NAMES = Object.freeze({
  0: "Pierce", 1: "Bludgeon", 2: "Slash", 3: "Acid", 4: "Lightning", 5: "Cold", 6: "Fire", 7: "Harm", 8: "Auto",
  9: "Void", 10: "DrainAuto", 11: "Prismatic", 12: "Random", 13: "Fists", 98: "None", 99: "Physical", 101: "PAuto",
});
// The elements the Monsters tab has here (combat/spell_tables.js ELEMENTS; Void = Nether).
const VT_ELEMENT = Object.freeze({ 0: "Pierce", 1: "Bludgeon", 2: "Slash", 3: "Acid", 4: "Lightning", 5: "Cold", 6: "Fire", 9: "Nether" });
const VT_AUTO = 8;
const VT_NONE = 98;
const VT_PET_AUTO = 101;

/** AssistItems' Type → the Consumables kind it names (vtank-formats.md §6, MOSS). */
export const USD_ASSIST_TYPES = Object.freeze({
  0: "health kit", 1: "health food", 2: "stamina kit", 3: "stamina food", 4: "mana kit", 5: "mana food",
  6: "mana charge", 7: "grenade", 8: "mana stone", 9: "pea", 10: "lockpick", 11: "all peas",
});

const cellStr = (v) => (v && (v.t === "s" || v.t === "ba") ? v.v : null);
const cellNum = (v) => (v && (v.t === "i" || v.t === "d") ? v.v : null);
const cellBool = (v) => (v && v.t === "b" ? v.v : v && v.t === "i" ? v.v !== 0 : null);
const lower = (s) => String(s).trim().toLowerCase();

function colOf(t, name) {
  const want = name.toLowerCase();
  return t.cols.findIndex((c) => lower(c) === want);
}
const cell = (row, i) => (i >= 0 ? row[i] : undefined);

/** A VT damage value → the Monsters tab's element; `fallback` (Auto / None /
 *  PAuto) for the "same as" value, a missing cell or an element the web has no
 *  column value for (reported). */
function element(n, autoValue, fallback, what, rowName, warnings) {
  if (n === null || n === autoValue) return fallback;
  const el = VT_ELEMENT[n];
  if (el) return el;
  warnings.push(`monster "${rowName}": ${what} ${VT_DAMAGE_NAMES[n] ?? n} (${n}) has no web equivalent — ${fallback}`);
  return fallback;
}

// MyMonsters → MonsterList entries (fields of combat/monster_list.js
// DEFAULT_ENTRY; a missing column is left out for the validator's default).
function readMonsters(t, warnings) {
  const iName = colOf(t, "MonsterName");
  if (iName < 0) {
    warnings.push("MyMonsters has no MonsterName column — the Monsters tab was not read");
    return null;
  }
  const iPri = colOf(t, "AttackPriority");
  const iDmg = colOf(t, "DamageType");
  const iWeapon = colOf(t, "WeaponToUse");
  const iVuln = colOf(t, "SecondaryVuln");
  const iOff = colOf(t, "SecondaryEquip");
  const iPet = colOf(t, "PetDamageType");
  const switches = USD_MONSTER_SWITCHES.map(([c, letter]) => [colOf(t, c), letter]);
  const out = [];
  let ids = 0;
  let unnamed = 0;
  for (const row of t.rows) {
    const raw = cellStr(cell(row, iName));
    if (raw === null || !raw.trim()) {
      unnamed++;
      continue;
    }
    const name = raw.trim();
    const e = { text: name === "<DEFAULT>" ? "DEFAULT" : name, enabled: true };
    const p = cellNum(cell(row, iPri));
    if (p !== null) {
      const q = Math.max(-1, Math.min(4, Math.round(p)));
      if (q !== p) warnings.push(`monster "${name}": priority ${p} is outside -1..4 — ${q}`);
      e.priority = q;
    }
    for (const [i, letter] of switches) {
      const v = cellBool(cell(row, i));
      if (v !== null) e[letter] = v;
    }
    e.damageType = element(cellNum(cell(row, iDmg)), VT_AUTO, "Auto", "Damage Type", name, warnings);
    e.exVuln = element(cellNum(cell(row, iVuln)), VT_NONE, "None", "Secondary Vuln", name, warnings);
    e.petDmg = element(cellNum(cell(row, iPet)), VT_PET_AUTO, "PAuto", "Pet Damage", name, warnings);
    // WeaponToUse -1 / SecondaryEquip 0 are <AUTO>; any other value is an object id.
    const w = cellNum(cell(row, iWeapon));
    const o = cellNum(cell(row, iOff));
    e.weapon = w === null || w === -1 || w === 0 ? 0 : w >>> 0;
    e.offhand = o === null || o === -1 || o === 0 ? 0 : o >>> 0;
    if (e.weapon || e.offhand) ids++;
    out.push(e);
  }
  if (unnamed) warnings.push(`${unnamed} MyMonsters row(s) without a MonsterName skipped`);
  if (ids) {
    warnings.push(
      `${ids} monster row(s) name a weapon / offhand by object id — object ids are server-specific (they mean that item only for the character and server that wrote the file); kept`,
    );
  }
  return out;
}

function readSettings(t, warnings) {
  const ks = colOf(t, "Setting");
  const vs = colOf(t, "Value");
  const ts = colOf(t, "SettingType");
  if (ks < 0 || vs < 0) {
    warnings.push("the Settings table has no Setting / Value column — settings were not read");
    return [];
  }
  const out = [];
  for (const row of t.rows) {
    const name = cellStr(cell(row, ks));
    const v = cell(row, vs);
    if (!name || !name.trim() || !v) continue;
    const value = v.t === "table" ? { cols: v.cols, index: v.index, rows: v.rows } : v.v;
    out.push({ vtName: name.trim(), t: v.t, value, type: cellNum(cell(row, ts)) });
  }
  return out;
}

function pairs(t, a, b, fa, fb) {
  if (!t) return [];
  const ia = colOf(t, a);
  const ib = colOf(t, b);
  const out = [];
  for (const row of t.rows) {
    const x = fa(cell(row, ia));
    const y = fb(cell(row, ib));
    if (x !== null && y !== null) out.push([x, y]);
  }
  return out;
}

function exemplars(t) {
  if (!t) return [];
  const c = colOf(t, "ExemplarId");
  const out = [];
  for (const row of t.rows) {
    const id = cellNum(cell(row, c));
    if (id !== null && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Parse a VTank settings profile (`.usd`): text, Uint8Array or ArrayBuffer.
 * → { ok: true, tables, settings: [{ vtName, t, value, type }], monsters
 *     (MonsterList entries, DEFAULT first as the file has it) | null,
 *     items: [{ object, spells }], consumables: [{ name, type, kind }],
 *     gemFood: [{ name, spell }], extraBuffs: [spellId], blacklistedBuffs:
 *     [spellId], itemUses: [{ object, uses }], warnings }
 *   | { ok: false, error, warnings }. Never throws.
 */
export function parseUsd(data) {
  const warnings = [];
  const b = toBytes(data);
  if (!b) return { ok: false, error: ".usd data must be text or bytes", warnings };
  const bom = b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  const body = bom ? b.subarray(3) : b;
  if (!dec.decode(body).trim()) return { ok: false, error: "empty .usd file", warnings };
  const lf = bareLfHeader(body);
  let res = null;
  let err = null;
  try {
    res = readTables(body, lf);
  } catch (e) {
    err = e;
  }
  if (!res && lf) {
    try {
      res = readTables(body, false);
      warnings.push(`"ba" lengths are LF byte counts, not VTank's CRLF character counts`);
    } catch {
      /* report the first error */
    }
  }
  if (!res) {
    const msg = err instanceof UsdError ? err.message : `.usd parse failed: ${err && err.message ? err.message : err}`;
    return { ok: false, error: msg, warnings };
  }
  const { tables } = res;
  const byName = (n) => tables.find((t) => lower(t.name) === n.toLowerCase()) || null;
  if (!USD_TABLES.some((n) => byName(n))) {
    return { ok: false, error: "not a VTank settings file (no Settings, MyMonsters or other VTank table)", warnings };
  }
  if (res.trailing) warnings.push(`${res.trailing} trailing byte(s) after the last table ignored`);
  if (res.oddFlags) warnings.push(`${res.oddFlags} index flag(s) other than y / n read as n`);

  const st = byName("Settings");
  const settings = st ? readSettings(st, warnings) : [];
  if (!st) warnings.push("no Settings table");
  const mt = byName("MyMonsters");
  const monsters = mt ? readMonsters(mt, warnings) : null;

  // Items tab: object ids in order, each with its buff spells (-1 = none).
  const items = [];
  for (const [object, spell] of pairs(byName("BuffedItems"), "Object", "Spell", cellNum, cellNum)) {
    const id = object >>> 0;
    let it = items.find((x) => x.object === id);
    if (!it) items.push((it = { object: id, spells: [] }));
    if (spell !== -1 && !it.spells.includes(spell)) it.spells.push(spell);
  }
  const consumables = pairs(byName("AssistItems"), "Object", "Type", cellStr, cellNum).map(([name, type]) => ({
    name,
    type,
    kind: USD_ASSIST_TYPES[type] ?? null,
  }));
  const gemFood = pairs(byName("GemFoodItems"), "Name", "Spell", cellStr, cellNum).map(([name, spell]) => ({ name, spell }));
  const itemUses = pairs(byName("ItemUseSpecifiers"), "Object", "Uses", cellNum, cellNum).map(([o, uses]) => ({ object: o >>> 0, uses }));
  return {
    ok: true,
    tables,
    settings,
    monsters,
    items,
    consumables,
    gemFood,
    extraBuffs: exemplars(byName("ExtraBuffSpells")),
    blacklistedBuffs: exemplars(byName("AntiExtraBuffSpells")),
    itemUses,
    warnings,
  };
}

// ── import into a new user profile ─────────────────────────────────────────

const RESERVED_TARGETS = new Set(["default", "[by char]", "__bychar__"]);
const errText = (e) => String(e && e.message ? e.message : e);

/** "C:\\VT\\hunter.usd" → "hunter". */
function profileNameOf(name) {
  if (typeof name !== "string" && typeof name !== "number") return "";
  return String(name).split(/[\\/]/).pop().replace(/\.usd$/i, "").trim();
}

function list(names, max = 12) {
  return names.length > max ? `${names.slice(0, max).join(", ")}, … (+${names.length - max})` : names.join(", ");
}

/**
 * Import a `.usd` (raw data, or a parseUsd result) as a NEW user profile
 * named `name` (Save As rules: no spaces). The profile is created from the
 * current values by VtOptions.saveAs and becomes the active one (VTank loads a
 * settings profile whole); the file's Settings rows are then set by their
 * VTank names and its Monsters tab replaces the list. Refused for Default /
 * [By char] and for a name a profile already has: nothing is changed then.
 *
 * @param {object} options  VtOptions (createVtOptions)
 * @param {{ mineOnly?: boolean, normalizeMonster?: (e: object) => object }} [opts]
 *   mineOnly: a "[Char]" profile instead of a shared one.
 *   normalizeMonster: the MonsterList entry validator (combat normalizeEntry).
 * → { ok: true, profile: { name, kind }, applied: string[], unknown: string[], warnings }
 *   | { ok: false, error, warnings }
 */
export function importUsdProfile(options, name, data, opts) {
  const fail = (error, warnings = []) => ({ ok: false, error, warnings });
  try {
    const mineOnly = !!opts && opts.mineOnly === true;
    const normalizeMonster = opts && typeof opts.normalizeMonster === "function" ? opts.normalizeMonster : null;
    const n = profileNameOf(name);
    if (!n) return fail("a profile name is required");
    if (RESERVED_TARGETS.has(n.toLowerCase())) return fail(`"${n}" cannot take an import — a .usd always imports into a new profile`);
    if (!options || !["saveAs", "get", "set", "setList"].every((m) => typeof options[m] === "function")) {
      return fail("no VTank settings yet");
    }
    const existing = typeof options.profiles?.list === "function" ? options.profiles.list() : [];
    if (existing.some((p) => p && (p.kind === "shared" || p.kind === "char") && String(p.name).toLowerCase() === n.toLowerCase())) {
      return fail(`a profile named "${n}" already exists — import into a new name`);
    }
    const parsed = data && typeof data === "object" && data.ok === true && Array.isArray(data.tables) && Array.isArray(data.settings);
    const p = parsed ? data : parseUsd(data);
    if (!p.ok) return fail(p.error, p.warnings || []);
    const warnings = Array.isArray(p.warnings) ? [...p.warnings] : [];
    const arr = (v) => (Array.isArray(v) ? v : []);

    const sv = options.saveAs(n, { mineOnly });
    if (!sv.ok) return fail(sv.error, warnings);
    if (typeof options.profiles?.isUserProfileActive === "function" && options.profiles.isUserProfileActive() !== true) {
      return fail("Save As did not select a user profile — nothing imported", warnings);
    }
    // From here every write lands in the new profile (never Default).
    const applied = [];
    const unknown = [];
    const notPlain = [];
    let saveError = null;
    for (const s of arr(p.settings)) {
      if (!s || typeof s.vtName !== "string") continue;
      if (s.t === "table" || s.t === "ba" || s.t === "n") {
        notPlain.push(s.vtName);
        continue;
      }
      const g = options.get(s.vtName);
      if (!g || !g.ok) {
        unknown.push(s.vtName);
        continue;
      }
      const r = options.set(s.vtName, s.value, { source: "import" });
      if (!r || !r.ok) {
        warnings.push(`${s.vtName}: ${(r && r.error) || "not set"}`);
        continue;
      }
      if (!applied.includes(r.row.key)) applied.push(r.row.key);
      if (r.clamped) warnings.push(`${s.vtName} ${s.value}: outside the web range — ${r.row.key} = ${r.value}`);
      if (r.saveError && !saveError) saveError = r.saveError;
    }
    if (unknown.length) warnings.push(`${unknown.length} setting(s) not known here, not imported: ${list(unknown)}`);
    if (notPlain.length) warnings.push(`${notPlain.length} table-valued setting(s) not imported: ${list(notPlain)}`);

    if (Array.isArray(p.monsters)) {
      const entries = p.monsters.map((e) => (normalizeMonster ? normalizeMonster(e) : { ...e }));
      const r = options.setList("monsters", entries, { source: "import" });
      if (r && r.ok) {
        applied.push("monsters");
        if (r.saveError && !saveError) saveError = r.saveError;
      } else warnings.push(`Monsters tab not imported: ${(r && r.error) || "rejected"}`);
    } else warnings.push("no Monsters tab read — the profile keeps the list it was saved from");

    const items = arr(p.items);
    const consumables = arr(p.consumables);
    if (items.length) {
      warnings.push(`Items tab: ${items.length} object id(s) not imported (object ids are server-specific) — add the items from your pack`);
    }
    if (consumables.length) warnings.push(`Consumables tab: ${consumables.length} row(s) not imported (${list(consumables.map((c) => c && c.name), 6)})`);
    const buffs = arr(p.extraBuffs).length + arr(p.blacklistedBuffs).length;
    if (buffs) warnings.push(`Buffs tab: ${buffs} spell id(s) (Extra / Blacklisted) not imported`);
    if (saveError) warnings.push(`profile "${n}" not saved yet: ${saveError}`);
    const a = typeof options.profiles?.active === "function" ? options.profiles.active() : { name: n, kind: mineOnly ? "char" : "shared" };
    return { ok: true, profile: { name: a.name, kind: a.kind }, applied, unknown, warnings };
  } catch (e) {
    return fail(`.usd import failed: ${errText(e)}`);
  }
}

export default { parseUsd, importUsdProfile };
