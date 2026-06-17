/**
 * LayoutDesc (DAT type 0x21) JS loader. Mirrors `loadActionMap` /
 * `loadRetailKeyMap`: async, single-flight, cached.
 *
 * Wraps the wasm `fetch_layout(id)` export, which reads the layout
 * from `eor/local` namespace (Layout records live in
 * `client_local_English.dat`) and chains the singleton
 * MasterProperty (0x39000001) from `eor/portal` to resolve the
 * embedded BaseProperty type tags.
 *
 * Element tree shape (per fetch_layout's JSON):
 *
 *   layout: {
 *     id, width, height,
 *     elements: [Element, ...]
 *   }
 *
 *   Element: {
 *     key, element_id, element_type, default_state,
 *     x?, y?, width?, height?, z_level?,
 *     left_edge, top_edge, right_edge, bottom_edge,
 *     children: [Element, ...]
 *   }
 *
 * Element coords are sparse — retail incorporation_flags determine
 * which of x/y/width/height/z_level are stored per element; the
 * rest are computed at runtime from parent flow + edge anchors.
 * Consumers must handle `undefined` for any geometry field.
 *
 * `element_id` is the stable identity (e.g. `0x100005AB` = head slot
 * in gmPaperDollUI 0x21000024); `key` is the dict-key the parent uses
 * to reference this element — only meaningful inside the parent's
 * `children` map.
 */

import { acString } from "./ac_strings.js";

const layoutInflight = new Map(); // id → Promise<layout | null> (in-flight only)
const layoutResolved = new Map(); // id → layout (cached on success only)

/**
 * Load a LayoutDesc. Idempotent on success; caller can call
 * repeatedly without triggering extra wasm round-trips once the
 * record is in cache.
 *
 * **Failures are NOT cached.** If `fetch_layout` returns null (e.g.
 * because the `eor/local` shard hasn't been prefetched yet — common
 * for plugins that mount during early boot), the next call retries.
 * In-flight requests dedupe through `layoutInflight`. Consumers
 * should be tolerant of a transient null and re-attempt or accept
 * that the layout never loads.
 *
 * @param {number} layoutId — e.g. 0x21000024 for gmPaperDollUI.
 * @returns {Promise<null | {id, width, height, elements: Array}>}
 */
export async function loadLayout(layoutId) {
  if (layoutResolved.has(layoutId)) return layoutResolved.get(layoutId);
  if (layoutInflight.has(layoutId)) return layoutInflight.get(layoutId);
  const p = (async () => {
    // Yield a microtask so the caller's `layoutInflight.set(...)`
    // below has run before the body starts. Without this, a synchronous
    // early-return (e.g. wasm not yet ready) would fire the `finally`
    // delete BEFORE the set, leaving the entry stuck forever and
    // starving every subsequent retry.
    await Promise.resolve();
    try {
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      if (!wasm?.fetch_layout) return null;
      // fetch_layout calls global_source() which panics if
      // init_resource_source hasn't completed yet. Plugins that mount
      // via mountBar() can fire their applyXxxLayout retry-tick into
      // the window between `__hbWasm` being populated (right after
      // `await init()`) and init_resource_source resolving (which can
      // take several seconds through a tunneled manifest fetch).
      // Skip if the resource source isn't installed yet — the retry
      // loop will re-try in 2s.
      if (typeof wasm.has_resource_source === "function" && !wasm.has_resource_source()) {
        return null;
      }
      const json = await wasm.fetch_layout(layoutId >>> 0);
      const raw = json === "null" ? null : JSON.parse(json);
      if (!raw) return null;
      layoutResolved.set(layoutId, raw);
      try {
        window.__diag?.layout?.onLoaded?.({
          id: layoutId,
          topLevelElements: raw.elements.length,
          totalElements: countElements(raw.elements),
        });
        // HUD rec #187 (2026-06-16): G3 emission telemetry. Wasm
        // populates `ok` + `g3SerializeErrors.{stateDesc,states}` at
        // the top of the layout payload — surface fallback hits to
        // the diag layer so Round-3 probes can pick up regressions.
        if (raw.ok === false) {
          const e = raw.g3SerializeErrors ?? {};
          window.__diag?.layout?.onG3SerializeError?.(
            layoutId,
            (e.stateDesc ?? 0) >>> 0,
            (e.states ?? 0) >>> 0,
          );
        }
      } catch (_) {}
      return raw;
    } catch (err) {
      console.warn(`[ac-layout] layout 0x${layoutId.toString(16)} load failed:`, err);
      return null;
    } finally {
      // Always clear inflight, including the wasm-not-ready early-out
      // path — otherwise a single early call permanently caches the
      // null promise and starves all retries.
      layoutInflight.delete(layoutId);
    }
  })();
  layoutInflight.set(layoutId, p);
  return p;
}

/** Sync accessor — returns the resolved layout, or null if not loaded yet. */
export function getCachedLayout(layoutId) {
  return layoutResolved.get(layoutId) ?? null;
}

/**
 * Depth-first walk for a child Element whose `element_id` equals the
 * given target. Returns the first match (retail layouts have unique
 * element_ids by convention; nothing in the format enforces it but
 * acclient relies on it).
 *
 * @param {{elements: Array}} layout
 * @param {number} elementId
 * @returns {object | null}
 */
export function findElementById(layout, elementId) {
  if (!layout || !Array.isArray(layout.elements)) return null;
  const target = elementId >>> 0;
  const stack = [...layout.elements];
  while (stack.length) {
    const el = stack.pop();
    if ((el.element_id >>> 0) === target) return el;
    if (Array.isArray(el.children)) {
      for (const c of el.children) stack.push(c);
    }
  }
  return null;
}

/** Accept "0x100005AB" / "100005AB" / 0x100005AB and normalize to u32. */
export function parseElementIdHex(s) {
  if (typeof s === "number") return s >>> 0;
  if (typeof s !== "string") return 0;
  const cleaned = s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
  return parseInt(cleaned, 16) >>> 0;
}

function countElements(elements) {
  let n = 0;
  const stack = [...elements];
  while (stack.length) {
    const el = stack.pop();
    n += 1;
    if (Array.isArray(el.children)) stack.push(...el.children);
  }
  return n;
}

/**
 * Shared apply-layout-regions helper — DRYs out the ~30 LOC of
 * dispatch + retry + box-application that every plugin port
 * (inventory/radar/chat/vendor/spellbook/character-info/etc.)
 * replicates today.
 *
 * Usage:
 *   import { applyLayoutRegions } from "../ui/ac_layout.js";
 *   applyLayoutRegions(0x21000074, {
 *     [RADAR_ELEMS.disk]:  diskEl,
 *     [RADAR_ELEMS.lock]:  lockEl,
 *     [RADAR_ELEMS.move]:  moveEl,
 *     // ...
 *   }, {
 *     // optional — see `opts` below
 *   });
 *
 * @param {number} layoutId — LayoutDesc DAT id (e.g. 0x21000074).
 * @param {Record<number | string, Element>} refs — element_id (number
 *        or hex string "0x10000619") → DOM element. Keys not present
 *        in the layout are silently skipped (logged via diag).
 * @param {object} [opts]
 * @param {boolean} [opts.retry=true] — wrap in 8 × 2s retry loop for
 *        plugins that mount before window.__hbWasm is populated
 *        (mountBar early-mount path). Disable for user-initiated
 *        showView() panels where wasm is guaranteed ready.
 * @param {(layout: object, applied: number, missed: number) => void}
 *        [opts.afterApply] — called after each apply pass; useful
 *        for per-plugin diag emission or post-positioning hooks.
 * @param {(el: Element, desc: object) => void} [opts.beforeApplyEl] —
 *        called per-element before applyBox; useful for clearing CSS
 *        `right`/`bottom` or special transforms (see radar
 *        cardinals' `transform="none"` precedent).
 * @param {{x: number, y: number}} [opts.parentOrigin] — translate
 *        every element's (x, y) by (origin.x, origin.y). Useful when
 *        the DOM keeps a child as a sibling of its retail parent
 *        (e.g. inventory's burden bar lives inside paperdoll in
 *        retail but is a sibling in our DOM; pass paperdollOrigin to
 *        anchor correctly).
 * @returns {void} — synchronous if layout is already cached;
 *        otherwise fires async load + apply when resolved.
 *
 * HUD rec #118 — incorporated vs sparse geometry note:
 * ElementDesc records use `incorporation_flags` to mark which
 * geometry fields (x / y / w / h) are actually authored on this
 * element. A field with its incorporation bit clear is INTENTIONALLY
 * undefined — NOT a parse miss. Callers must not treat undefined
 * dims as zero or as an error; instead leave the element on its
 * CSS default (or parent-relative positioning) and only apply the
 * dims that were actually authored. applyBox below already honors
 * this contract by skipping undefined fields, but plugin authors
 * iterating element children directly should re-check the flags
 * before clobbering CSS positions.
 */
export function applyLayoutRegions(layoutId, refs, opts = {}) {
  const { retry = true, afterApply, beforeApplyEl, parentOrigin } = opts;
  const ox = parentOrigin?.x ?? 0;
  const oy = parentOrigin?.y ?? 0;
  let attempt = 0;
  const maxRetries = retry ? 8 : 0;

  const doApply = (layout) => {
    if (!layout) {
      if (attempt < maxRetries) {
        attempt += 1;
        setTimeout(kickoff, 2000);
      }
      return;
    }
    let applied = 0;
    let missed = 0;
    for (const [idAny, el] of Object.entries(refs)) {
      if (!el) continue;
      // Object.entries coerces numeric keys (`[0x10000619]: el`) to
      // their *decimal* string form ("268436505"), not hex. Number()
      // round-trips that correctly AND still parses "0x..." hex
      // strings — covers every caller pattern in the codebase.
      const id = Number(idAny) >>> 0;
      const desc = findElementById(layout, id);
      if (!desc) { missed += 1; continue; }
      if (typeof beforeApplyEl === "function") {
        try { beforeApplyEl(el, desc); } catch (_) {}
      }
      // Rec #186 — edge-anchor fallback. Explicit x/y/width/height
      // win as before; when an axis is missing we look at the
      // {left,top,right,bottom}_edge fields and compute against
      // opts.parentRect (if provided) — e.g. inventory's burden bar
      // anchored to paperdoll's bottom. With no parentRect, the
      // helper returns only the explicit dims, so behaviour is
      // unchanged for the common case.
      const geom = opts.parentRect
        ? computeChildGeometry(desc, opts.parentRect)
        : desc;
      if (typeof geom.x === "number") el.style.left = `${ox + geom.x}px`;
      if (typeof geom.y === "number") el.style.top = `${oy + geom.y}px`;
      if (typeof geom.width === "number") el.style.width = `${geom.width}px`;
      if (typeof geom.height === "number") el.style.height = `${geom.height}px`;
      applied += 1;
    }
    try {
      window.__diag?.layout?.onRegionsApplied?.({ layoutId, applied, missed });
    } catch (_) {}
    if (typeof afterApply === "function") {
      try { afterApply(layout, applied, missed); } catch (_) {}
    }
  };

  const kickoff = () => {
    const cached = getCachedLayout(layoutId);
    if (cached) { doApply(cached); return; }
    loadLayout(layoutId).then(doApply).catch(() => {});
  };
  kickoff();
}

// ---------------------------------------------------------------------
// State / property / media helpers (v2 fetch_layout payload).
//
// Most elements have `states: {}` (no overrides). Multi-state elements
// (lock buttons, dropdowns, frame-chrome with locked/unlocked variants)
// carry a `<UIStateId>: StateDesc` map. StateDesc.properties is keyed
// by MasterPropertyId; StateDesc.media is a list of MediaDesc variants
// (Image / Alpha / Sound / Animation / etc.). BaseProperty variants
// are discriminant-tagged: `{"DataId": 0x06000123}` etc.
//
// Common consumer patterns:
//   - Lookup a background-image DataID for state `0`:
//       getStateMediaByType(states["0"], "Image") → {file, draw_mode}
//   - Lookup a color override:
//       getStateProperty(state, MASTER_PROP_FG_COLOR) → {Color: {...}}
//   - Lookup a sprite DataID:
//       getStateProperty(state, MASTER_PROP_SPRITE) → {DataId: 0x06...}

/**
 * Get the state-overrides map (`UIStateId → StateDesc`) for an element.
 * Returns an empty object if the element has no states. Keys are
 * strings (JSON object property convention).
 *
 * The DAT carries the element's default-state data twice: once at
 * `element.state_desc` (cached by ACE for hot-path access) and once
 * inside `element.states` keyed by `default_state`. If the latter is
 * missing we inject the former under its own `state_id` so callers
 * always see the default state via the same lookup.
 *
 * HUD rec #118 — sparse-state note: a state's StateDesc can omit any
 * subset of (sprite / color / position-delta / extent) fields. Missing
 * = "inherit from default-state". Callers picking a property out of a
 * specific UIStateId should fall back to the default-state entry when
 * the value is absent rather than treating undefined as "clear it".
 */
export function getElementStates(element) {
  const states = element?.states ?? {};
  const baseStateDesc = element?.state_desc;
  if (baseStateDesc && typeof baseStateDesc.state_id === "number") {
    const key = String(baseStateDesc.state_id);
    if (!states[key]) {
      return { ...states, [key]: baseStateDesc };
    }
  }
  return states;
}

/**
 * Walk an element subtree and collect, per element, the inherited
 * StateDesc list propagated from ancestors whose StateDesc has
 * `pass_to_children` set. Children also inherit their own ancestors'
 * pass_to_children states — the cascade composes. Each returned entry
 * holds the array of cascaded StateDescs (most-recent ancestor first)
 * plus the element's own states.
 *
 * Pass the root element (or any subtree root). Returns
 * `Map<elementKey, {own: StateDesc[], inherited: StateDesc[]}>` so
 * consumers can render leaf elements with the right precedence:
 * own state overrides win, with inherited cascaded states filling in
 * unset sprite / color / position-delta / extent fields.
 *
 * This helper exists so the cascade can be unit-tested without
 * spinning up the layout renderer. Rec #65.
 *
 * @param {object} root — an ElementDesc with optional `children[]`
 * @returns {Map<string|number, {own: object[], inherited: object[]}>}
 */
export function collectCascadedStates(root) {
  const out = new Map();
  function walk(el, inheritedFromAbove) {
    if (!el || typeof el !== "object") return;
    const states = getElementStates(el);
    const ownStates = Object.values(states);
    const passThrough = ownStates.filter((s) => !!s?.pass_to_children);
    const key = el.key ?? el.element_id ?? null;
    if (key != null) {
      out.set(key, {
        own: ownStates,
        inherited: inheritedFromAbove.slice(),
      });
    }
    // Children inherit ancestors' pass_to_children states + ours.
    const downstream = passThrough.length > 0
      ? [...passThrough, ...inheritedFromAbove]
      : inheritedFromAbove;
    if (Array.isArray(el.children)) {
      for (const c of el.children) walk(c, downstream);
    }
  }
  walk(root, []);
  return out;
}

/**
 * Look up a BaseProperty override by `dict_key` (typically the same
 * as MasterPropertyId) in a StateDesc. Returns the wrapped variant
 * object (e.g. `{ DataId: 0x06000123 }`) or null.
 */
export function getStateProperty(stateDesc, dictKey) {
  if (!stateDesc?.properties) return null;
  // Serde serializes HashMap<u32, ...> with stringified keys.
  return stateDesc.properties[String(dictKey)]
      ?? stateDesc.properties[dictKey]
      ?? null;
}

/**
 * Extract the *value* from a BaseProperty variant, no matter which
 * discriminant. For scalar variants (Bool/Integer/Float/Enum/DataId/
 * InstanceId/Bitfield32/Bitfield64), returns the raw value. For
 * compound variants (Vector/Color/StringInfo/Array/Struct), returns
 * the inner object/array. Returns `undefined` if the variant is
 * unknown or the property is null.
 */
export function basePropertyValue(prop) {
  if (!prop || typeof prop !== "object") return undefined;
  for (const k of Object.keys(prop)) return prop[k]; // single-discriminant
  return undefined;
}

/**
 * HUD rec #154 — resolve a `StringInfo` BaseProperty to its localized text
 * via the DAT StringTable. `prop` is a wrapped BaseProperty (e.g. the return
 * of {@link getStateProperty}); only the
 * `{ StringInfo: { string_id, table_id, ... } }` variant resolves — any other
 * variant returns null so the caller keeps its placeholder. `table_id` is used
 * when non-zero, else `defaultTableId` (many layout StringInfos leave the table
 * empty; gmConfigUI labels live in UI_Options 0x23000004). {@link acString}
 * returns null until the table is loaded, so `resolved` reports whether the
 * lookup actually hit. Pure — the caller swaps the element text when resolved.
 *
 * @param {object|null} prop — wrapped BaseProperty, e.g. `{ StringInfo: {...} }`
 * @param {number} defaultTableId — StringTable id to use when StringInfo.table_id is 0
 * @returns {{ text: (string|null), stringId: number, tableId: number, resolved: boolean }|null}
 */
export function resolveStringInfo(prop, defaultTableId) {
  const si = (prop && typeof prop === "object") ? prop.StringInfo : null;
  if (!si || typeof si !== "object") return null;
  const stringId = (si.string_id ?? si.stringId ?? 0) >>> 0;
  if (!stringId) return null;
  const rawTable = si.table_id ?? si.tableId;
  // The DAT serializes table_id as 0/empty for most entries — fall back to the
  // layout default. Guard against non-numeric (e.g. an empty object) too.
  const tableId = (typeof rawTable === "number" && rawTable > 0)
    ? (rawTable >>> 0)
    : (defaultTableId >>> 0);
  const text = acString(tableId, stringId);
  try {
    window.__diag?.layout?.onStringInfoResolved?.({ stringId, tableId, resolved: text != null });
  } catch (_) { /* diag is best-effort */ }
  return { text, stringId, tableId, resolved: text != null };
}

/**
 * HUD rec #154 — resolve the label text for a layout element. Reads the
 * canonical label slot (MasterProperty 0x17 = dict_key 23) from the element's
 * default StateDesc and runs {@link resolveStringInfo}. Returns null when the
 * element carries no StringInfo label (so callers keep their placeholder text).
 *
 * @param {object} element — ElementDesc (e.g. from {@link findElementById})
 * @param {number} [defaultTableId=0x23000004] — UI_Options default for gmConfigUI
 * @returns {{ text: (string|null), stringId: number, tableId: number, resolved: boolean }|null}
 */
export function resolveElementLabel(element, defaultTableId = 0x23000004) {
  const sd = element?.state_desc;
  if (!sd) return null;
  const prop = getStateProperty(sd, 23);
  return resolveStringInfo(prop, defaultTableId);
}

/**
 * Find the first MediaDesc of a given variant ("Image" / "Alpha" /
 * "Sound" / "Animation" / "Cursor" / "Movie" / "Jump" / "Message" /
 * "Pause" / "State" / "Fade") in a StateDesc. Returns the inner
 * payload (e.g. `{file: 0x06..., draw_mode: 0}` for "Image") or null.
 */
export function getStateMediaByType(stateDesc, variantName) {
  if (!stateDesc?.media || !Array.isArray(stateDesc.media)) return null;
  for (const m of stateDesc.media) {
    if (m && typeof m === "object" && m[variantName]) return m[variantName];
  }
  return null;
}

/**
 * Rec #186 — Edge-anchor flow-layout fallback for elements whose
 * ElementDesc omits explicit x/y but carries left_edge / top_edge /
 * right_edge / bottom_edge offsets relative to the parent rect.
 *
 * Retail mirror: client/UIElement::Layout reads the four edge fields
 * as anchor distances measured INWARD from the parent rect's
 * corresponding edge, and computes the child rect as
 *   x = parent.x + left_edge
 *   y = parent.y + top_edge
 *   width  = parent.width  - left_edge - right_edge
 *   height = parent.height - top_edge  - bottom_edge
 *
 * Explicit element.x / element.y win when present — this helper is a
 * fallback for sparse ElementDescs (variable-height panels: chat log,
 * vendor grid, burden bar anchored to paperdoll's bottom). When both
 * explicit dims and edges are present, explicit dims take precedence
 * (matches applyLayoutRegions today). When neither is present, the
 * returned field is `undefined` so callers can fall through to CSS
 * defaults.
 *
 * Caller convention: pass the parent's *content* rect (post-padding
 * resolution), not the OS-window outer rect. The four edge fields are
 * authored relative to whatever the parent's layout box is.
 *
 * @param {object} element — ElementDesc with optional x / y / width /
 *        height / left_edge / top_edge / right_edge / bottom_edge.
 * @param {{x: number, y: number, width: number, height: number}} parentRect
 * @returns {{x?: number, y?: number, width?: number, height?: number}}
 *        the resolved child geometry; fields are present only when
 *        either explicit or edge-derived.
 */
export function computeChildGeometry(element, parentRect) {
  const out = {};
  if (!element || typeof element !== "object") return out;
  const px = parentRect?.x ?? 0;
  const py = parentRect?.y ?? 0;
  const pw = parentRect?.width ?? 0;
  const ph = parentRect?.height ?? 0;
  const le = Number.isFinite(element.left_edge)   ? element.left_edge   : null;
  const te = Number.isFinite(element.top_edge)    ? element.top_edge    : null;
  const re = Number.isFinite(element.right_edge)  ? element.right_edge  : null;
  const be = Number.isFinite(element.bottom_edge) ? element.bottom_edge : null;

  // X position
  if (Number.isFinite(element.x)) {
    out.x = element.x;
  } else if (le !== null) {
    out.x = px + le;
  }
  // Y position
  if (Number.isFinite(element.y)) {
    out.y = element.y;
  } else if (te !== null) {
    out.y = py + te;
  }
  // Width — only edge-derive when explicit width is absent. Need both
  // left and right edges to derive (single-edge anchoring leaves the
  // width undetermined; callers should pass an explicit width then).
  if (Number.isFinite(element.width)) {
    out.width = element.width;
  } else if (le !== null && re !== null) {
    out.width = Math.max(0, pw - le - re);
  }
  // Height — symmetric to width.
  if (Number.isFinite(element.height)) {
    out.height = element.height;
  } else if (te !== null && be !== null) {
    out.height = Math.max(0, ph - te - be);
  }
  return out;
}

/**
 * Variant of applyLayoutRegions that returns a Promise resolving
 * when the first successful apply completes (or null on giveup).
 * Useful for plugins that need to do something AFTER positions land.
 */
export async function applyLayoutRegionsAsync(layoutId, refs, opts = {}) {
  // Re-implement as a thin wrapper that resolves at the right time.
  return new Promise((resolve) => {
    const wrappedOpts = {
      ...opts,
      afterApply: (layout, applied, missed) => {
        if (typeof opts.afterApply === "function") {
          try { opts.afterApply(layout, applied, missed); } catch (_) {}
        }
        resolve({ layout, applied, missed });
      },
    };
    applyLayoutRegions(layoutId, refs, wrappedOpts);
  });
}
