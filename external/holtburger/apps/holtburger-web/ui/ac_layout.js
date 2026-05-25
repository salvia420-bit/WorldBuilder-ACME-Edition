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

const layoutCache = new Map(); // id → Promise<layout | null>
const layoutResolved = new Map(); // id → layout (sync access once resolved)

/**
 * Load a LayoutDesc. Idempotent; caller can call repeatedly without
 * triggering extra wasm round-trips. Returns null on parse failure
 * or missing record (consumer should fall back to whatever it does
 * without retail layout data).
 *
 * @param {number} layoutId — e.g. 0x21000024 for gmPaperDollUI.
 * @returns {Promise<null | {id, width, height, elements: Array}>}
 */
export async function loadLayout(layoutId) {
  if (layoutResolved.has(layoutId)) return layoutResolved.get(layoutId);
  if (layoutCache.has(layoutId)) return layoutCache.get(layoutId);
  const p = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_layout) {
      layoutResolved.set(layoutId, null);
      return null;
    }
    try {
      const json = await wasm.fetch_layout(layoutId >>> 0);
      const raw = json === "null" ? null : JSON.parse(json);
      if (!raw) {
        layoutResolved.set(layoutId, null);
        return null;
      }
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
      layoutResolved.set(layoutId, null);
      return null;
    }
  })();
  layoutCache.set(layoutId, p);
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
