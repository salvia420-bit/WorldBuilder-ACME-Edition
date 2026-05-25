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
      if (typeof desc.x === "number") el.style.left = `${ox + desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${oy + desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
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
 */
export function getElementStates(element) {
  return element?.states ?? {};
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
