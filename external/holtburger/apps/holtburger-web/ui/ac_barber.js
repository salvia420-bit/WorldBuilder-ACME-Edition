// ui/ac_barber.js — maps-chargen-barber-1 (2026-10-13): the barber page's
// rules (retail gmBarberUI), DOM-free so they are unit-tested in Node.
//
// Flow (retail → ours):
//   GameEventStartBarber 0x0075 → gmBarberUI::RecvNotice_StartBarberNotice
//     (acclient.c:271178) → InitializePage (:270582) maps the 16 DIDs back
//     to the face. Ours: wasm queues UI_EVENT "barber|f0,…,f15";
//     app/client_events.js emits the `startBarber` bus event {rest};
//     plugins/barber-panel.js parses it (parseStartBarberFields), opens and
//     asks `SessionHandle.barberInit` (holtburger_core::barber::barber_init).
//   Row arrows / row clicks / colour spots / shade scroll →
//     ListenToElementMessage (:269886) → SetSelection (:269647), SetColor
//     (:269542), SetShade (:269141). Ours: BarberPage below.
//   Apply (0x100005A6) → GenerateBaseAppearanceData + the heritage option's
//     local effects (SetMotionTableID / destroy_particle_manager /
//     play_script) → CM_Character::Event_FinishBarber (0x0311). Ours:
//     `SessionHandle.barberApply` builds the fields and runs the ported ACE
//     checks; applyBarber refuses (and says why) instead of letting ACE drop
//     the request silently, else runs the effects and sends finishBarber
//     exactly once.
//   Cancel (0x100005A7) only hides the page — nothing is sent (ACE keeps
//     BarberActive until the next login, as with retail).
//
// Flags: `?barber=off` (default ON) leaves StartBarber as a console line.
// An Empyrean Apply also swaps the local player's motion table, as retail's
// CPhysicsObj::SetMotionTableID does (`?barberMotionTable`, DEFAULT ON since
// 2026-10-19, ahead of its 1070 eye test); `?barberMotionTable=off` skips the
// swap, and the gait then changes at the next login.

/** GameEventStartBarber / FinishBarber field count. */
export const BARBER_FIELD_COUNT = 16;

/** gmBarberUI root element (LayoutDesc 0x21000068 "classic_barber"). */
export const BARBER_WINDOW_ID = 0x10000599;

function params(search) {
  try { return new URLSearchParams(search ?? globalThis.location?.search ?? ""); }
  catch (_) { return new URLSearchParams(""); }
}
const isOff = (v) => v === "off" || v === "0" || v === "false";

/** `?barber=off|0|false` disables the barber page (default ON). */
export function barberEnabled(search) {
  return !isOff(params(search).get("barber"));
}

/**
 * Apply swaps the local motion table (DEFAULT ON since 2026-10-19);
 * `?barberMotionTable=off|0|false|no` skips the swap.
 */
export function barberMotionTableEnabled(search) {
  const v = (params(search).get("barberMotionTable") || "").trim().toLowerCase();
  return !(v === "off" || v === "0" || v === "false" || v === "no");
}

/**
 * The UI_EVENT "barber" tail ("f0,…,f15", decimal u32 in wire order) → 16
 * numbers, or null when malformed.
 */
export function parseStartBarberFields(rest) {
  const parts = String(rest ?? "").split(",");
  if (parts.length !== BARBER_FIELD_COUNT) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p.trim())) return null;
    const v = Number(p.trim());
    if (!Number.isSafeInteger(v) || v > 0xFFFFFFFF) return null;
    out.push(v >>> 0);
  }
  return out;
}

/** gmBarberUI::EParts. */
export const BarberPart = Object.freeze({ HAIR: 1, EYES: 2, NOSE: 3, MOUTH: 4, SKIN: 5 });
export const BARBER_PARTS = Object.freeze([
  BarberPart.HAIR, BarberPart.EYES, BarberPart.NOSE, BarberPart.MOUTH, BarberPart.SKIN,
]);

/** StringTable of the option checkbox labels (enum 0x10000001). */
export const BARBER_OPTION_STRING_TABLE = 0x23000001;
/** StringTable of the Gearknight / Olthoi row labels (enum 0x10000002). */
export const BARBER_ROW_STRING_TABLE = 0x23000002;

/** client_local_English.dat values, used until the tables are loaded. */
const ENGLISH = Object.freeze({
  ID_Barber_Empyrean_Earthbound: "Suppress Levitation",
  ID_Barber_Undead_NoFlame: "Suppress Flames",
  ID_Barber_Shadow_NoCrown: "Suppress Crown",
  ID_CharGen_GearText_HairButton: "Body Style",
  ID_CharGen_GearText_EyesButton: "Trim Color",
  ID_CharGen_GearText_SkinButton: "Gear Color",
  ID_CharGen_OlthoiText_HairButton: "Body Style",
  ID_CharGen_OlthoiText_EyesButton: "Eyes",
  ID_CharGen_OlthoiText_SkinButton: "Markings",
});

function resolveText(tableId, token, lookup) {
  let text = null;
  if (typeof lookup === "function") {
    try { text = lookup(tableId, token); } catch (_) { text = null; }
  }
  return (typeof text === "string" && text) ? text : (ENGLISH[token] ?? token);
}

/**
 * Row labels. Gearknight (6) and Olthoi (12/13) rename hair / eyes / skin
 * (InitializePage :270858-270938); `lookup(tableId, token)` reads the DAT
 * text when loaded.
 */
export function barberRowLabels(heritage, lookup) {
  const labels = {
    [BarberPart.HAIR]: "Hair", [BarberPart.EYES]: "Eyes", [BarberPart.NOSE]: "Nose",
    [BarberPart.MOUTH]: "Mouth", [BarberPart.SKIN]: "Skin",
  };
  const h = heritage >>> 0;
  const kind = h === 6 ? "Gear" : (h === 12 || h === 13) ? "Olthoi" : null;
  if (kind) {
    labels[BarberPart.HAIR] = resolveText(BARBER_ROW_STRING_TABLE, `ID_CharGen_${kind}Text_HairButton`, lookup);
    labels[BarberPart.EYES] = resolveText(BARBER_ROW_STRING_TABLE, `ID_CharGen_${kind}Text_EyesButton`, lookup);
    labels[BarberPart.SKIN] = resolveText(BARBER_ROW_STRING_TABLE, `ID_CharGen_${kind}Text_SkinButton`, lookup);
  }
  return labels;
}

/** The option checkbox's label (null when the heritage has none). */
export function barberOptionLabel(optionToken, lookup) {
  if (!optionToken) return null;
  return resolveText(BARBER_OPTION_STRING_TABLE, optionToken, lookup);
}

const PROBLEM_TEXT = Object.freeze({
  paletteBase: "base palette",
  headObject: "hair style",
  hairTexture: "hair",
  defaultHairTexture: "hair",
  eyesTexture: "eyes",
  defaultEyesTexture: "eyes",
  noseTexture: "nose",
  defaultNoseTexture: "nose",
  mouthTexture: "mouth",
  defaultMouthTexture: "mouth",
  skinPalette: "skin shade",
  hairPalette: "hair colour",
  eyesPalette: "eye colour",
  setupTable: "body",
});

/** Player-facing text for barberApply's `problems` list. */
export function barberProblemText(problems) {
  const parts = [];
  for (const p of Array.isArray(problems) ? problems : []) {
    const t = PROBLEM_TEXT[p] ?? String(p);
    if (!parts.includes(t)) parts.push(t);
  }
  return parts.length
    ? `The barber cannot do that (${parts.join(", ")}). Nothing was sent.`
    : "";
}

const clamp01 = (v) => (Number.isFinite(+v) ? Math.min(1, Math.max(0, +v)) : 0);

/**
 * The page state over a parsed `barberInit` result: the face (CharGenState
 * fields), the selected part, and the gmBarberUI handlers that edit them.
 */
export class BarberPage {
  constructor(init) {
    this.heritage = (init?.heritage ?? 0) >>> 0;
    this.gender = (init?.gender ?? 0) >>> 0;
    this.option = init?.option ?? null;
    this.optionToken = init?.optionToken ?? null;
    this.gearOlthoi = !!init?.gearOlthoi;
    const c = init?.counts ?? {};
    this.counts = {
      hairStyles: (c.hairStyles ?? 0) | 0,
      eyeStrips: (c.eyeStrips ?? 0) | 0,
      noseStrips: (c.noseStrips ?? 0) | 0,
      mouthStrips: (c.mouthStrips ?? 0) | 0,
      hairColors: (c.hairColors ?? 0) | 0,
      eyeColors: (c.eyeColors ?? 0) | 0,
    };
    const f = init?.face ?? {};
    this.face = {
      hairStyle: (f.hairStyle ?? 0) >>> 0,
      eyesStrip: (f.eyesStrip ?? 0) >>> 0,
      noseStrip: (f.noseStrip ?? 0) >>> 0,
      mouthStrip: (f.mouthStrip ?? 0) >>> 0,
      hairColor: (f.hairColor ?? 0) >>> 0,
      hairShade: Number.isFinite(+f.hairShade) ? +f.hairShade : 0,
      skinShade: Number.isFinite(+f.skinShade) ? +f.skinShade : 0,
      eyeColor: (f.eyeColor ?? 0) >>> 0,
      option: !!f.option,
    };
    const s = init?.spots ?? {};
    this.spots = {
      hair: Array.isArray(s.hair) ? s.hair : [],
      eyes: Array.isArray(s.eyes) ? s.eyes : [],
      skin: Array.isArray(s.skin) ? s.skin : [],
    };
    // InitializePage ends on SetSelection(ECG_PARTS_HAIR).
    this.part = BarberPart.HAIR;
  }

  /** m_tChoices[part].iNumChoices (skin has no styles). */
  choiceCount(part) {
    switch (part) {
      case BarberPart.HAIR: return this.counts.hairStyles;
      case BarberPart.EYES: return this.counts.eyeStrips;
      case BarberPart.NOSE: return this.counts.noseStrips;
      case BarberPart.MOUTH: return this.counts.mouthStrips;
      default: return 0;
    }
  }

  /** The current style index of `part` (-1 for skin). */
  choice(part) {
    switch (part) {
      case BarberPart.HAIR: return this.face.hairStyle;
      case BarberPart.EYES: return this.face.eyesStrip;
      case BarberPart.NOSE: return this.face.noseStrip;
      case BarberPart.MOUTH: return this.face.mouthStrip;
      default: return -1;
    }
  }

  /** Gearknight / Olthoi hide the nose and mouth rows. */
  rowVisible(part) {
    return !(this.gearOlthoi && (part === BarberPart.NOSE || part === BarberPart.MOUTH));
  }

  /** The skin row's arrows are always ghosted; Gearknight / Olthoi ghost the eyes row's. */
  arrowsEnabled(part) {
    if (part === BarberPart.SKIN) return false;
    if (this.gearOlthoi && part === BarberPart.EYES) return false;
    return this.rowVisible(part) && this.choiceCount(part) > 0;
  }

  /** A row click: SetSelection(part). */
  select(part) {
    if (BARBER_PARTS.includes(part) && this.rowVisible(part)) this.part = part;
    return this.part;
  }

  /**
   * A row arrow (0x1000030A −1 / 0x1000030B +1): step the style with
   * wrap-around (≥ count → 0, < 0 → count − 1), then SetSelection(part).
   */
  step(part, dir) {
    if (!this.arrowsEnabled(part)) return this.choice(part);
    const n = this.choiceCount(part);
    let v = this.choice(part) + (dir < 0 ? -1 : 1);
    if (v >= n) v = 0;
    else if (v < 0) v = n - 1;
    switch (part) {
      case BarberPart.HAIR: this.face.hairStyle = v; break;
      case BarberPart.EYES: this.face.eyesStrip = v; break;
      case BarberPart.NOSE: this.face.noseStrip = v; break;
      case BarberPart.MOUTH: this.face.mouthStrip = v; break;
      default: break;
    }
    this.select(part);
    return v;
  }

  /**
   * The colour wheel for the selected part (SetSelection): hair — the hair
   * colours + shade scroll; eyes — the eye colours, no scroll; nose /
   * mouth / skin — the one skin spot + the SKIN shade.
   */
  wheel() {
    switch (this.part) {
      case BarberPart.HAIR:
        return { spots: this.spots.hair, current: this.face.hairColor, shadeVisible: true, shade: this.face.hairShade };
      case BarberPart.EYES:
        return { spots: this.spots.eyes, current: this.face.eyeColor, shadeVisible: false, shade: 0.5 };
      default:
        return { spots: this.spots.skin, current: 0, shadeVisible: true, shade: this.face.skinShade };
    }
  }

  /** A colour spot click: SetColor (hair colour / eye colour; skin has one). */
  pickSpot(index) {
    const i = index | 0;
    if (this.part === BarberPart.HAIR) {
      if (i >= 0 && i < this.counts.hairColors) this.face.hairColor = i;
    } else if (this.part === BarberPart.EYES) {
      if (i >= 0 && i < this.counts.eyeColors) this.face.eyeColor = i;
    }
    return this.wheel().current;
  }

  /** The shade scroll: SetShade — hair shade on Hair, skin shade on Nose / Mouth / Skin. */
  setShade(value) {
    const v = clamp01(value);
    if (this.part === BarberPart.HAIR) this.face.hairShade = v;
    else if (this.part !== BarberPart.EYES) this.face.skinShade = v;
    return v;
  }

  /** The option checkbox (0x100005C9). */
  setOption(on) {
    if (this.option) this.face.option = !!on;
    return this.face.option;
  }

  /** The face object `barberApply` takes. */
  faceForWasm() {
    return { ...this.face };
  }
}

/**
 * Apply's world half in retail order (ListenToElementMessage :270186-270296):
 * SetMotionTableID (Empyrean, only with `opts.motionTable`), then
 * destroy_particle_manager, then play_script. Returns the steps run.
 */
export function runBarberLocalEffects(effects, sinks, opts = {}) {
  const ran = [];
  const e = effects ?? {};
  const mt = (e.motionTableId ?? 0) >>> 0;
  if (mt && opts.motionTable && typeof sinks?.setMotionTable === "function") {
    try { sinks.setMotionTable(mt); ran.push("motionTable"); } catch (_) {}
  }
  if (e.destroyParticles && typeof sinks?.destroyParticles === "function") {
    try { sinks.destroyParticles(); ran.push("destroyParticles"); } catch (_) {}
  }
  const pes = (e.playScript ?? 0) >>> 0;
  if (pes && typeof sinks?.playScript === "function") {
    try { sinks.playScript(pes); ran.push("playScript"); } catch (_) {}
  }
  return ran;
}

/**
 * Apply. `deps`:
 *   barberApply(heritage, gender, face) → Promise<JSON string | object>
 *   finishBarber(Uint32Array(16))
 *   sinks: { setMotionTable?, destroyParticles?, playScript? }
 *   motionTable: boolean (barberMotionTableEnabled(): default on, ?barberMotionTable=off)
 *   stillOpen?(): boolean — checked once barberApply settles; false (the
 *     page was cancelled / closed / superseded meanwhile) → nothing runs
 * Resolves to `{ sent: true, fields, effects }`, or `{ sent: false, reason,
 * problems? }` — "unbuildable" (GenerateBaseAppearanceData failed),
 * "rejected" (ACE's checks would drop it; nothing is sent), or "cancelled"
 * (the page went away while barberApply was pending; no local effects, no
 * FinishBarber).
 */
export async function applyBarber(page, deps) {
  let res = await deps.barberApply(page.heritage, page.gender, page.faceForWasm());
  // barberApply can be slow (its ensure_records may re-fetch a PalSet that
  // failed at open); a Cancel / Esc / close in that gap must not still run
  // the PES or send 0x0311 (retail's Apply is synchronous, so it never could).
  if (typeof deps.stillOpen === "function" && !deps.stillOpen()) {
    return { sent: false, reason: "cancelled" };
  }
  if (typeof res === "string") res = JSON.parse(res);
  const fields = res?.fields;
  if (!Array.isArray(fields) || fields.length !== BARBER_FIELD_COUNT) {
    return { sent: false, reason: "unbuildable" };
  }
  const problems = Array.isArray(res.problems) ? res.problems : [];
  if (problems.length > 0) return { sent: false, reason: "rejected", problems };
  runBarberLocalEffects(res.effects, deps.sinks, { motionTable: !!deps.motionTable });
  deps.finishBarber(Uint32Array.from(fields, (v) => v >>> 0));
  return { sent: true, fields, effects: res.effects ?? {} };
}
