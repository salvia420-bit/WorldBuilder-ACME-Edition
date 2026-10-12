// rynth/vt/settings/index.js — barrel for the W1-2 SET package (PLAN §3.5, §4):
// the option schema, VtOptions (the one settings authority), profiles, named
// stores, live cells and the page-level VtSession.

export {
  SCHEMA, LBF_M, LIST_KEYS, REF_KEYS, LIST_DEFAULTS, PRESETS, LEGACY_ALIASES, VITALS_FIELD_KEYS,
  findRow, findRowIn, buildIndex, coerce, present, defaults, displayName,
} from "./schema.js";
export { NamedStore, createKv, makeLogger, clone, deepEqual, canonicalJson } from "./named_store.js";
export {
  ProfileStore, PROFILE_NAME_RE, DEFAULT_NAME, BYCHAR_NAME, HUD_BLOB_KEY, SHARED_PREFIX, ACTIVE_PREFIX, charPrefix,
} from "./profile_store.js";
export { createVtOptions } from "./options.js";
export { createLiveCells, CELL_KEYS, CELL_LISTS, PROFILE_OWNED_CELLS } from "./cells.js";
export {
  getVtSession, peekVtSession, normaliseScope, SESSION_REGISTRY_KEY, NAV_STORE_PREFIX, META_STORE_PREFIX,
  LOOT_STORE_PREFIX,
} from "./session.js";
