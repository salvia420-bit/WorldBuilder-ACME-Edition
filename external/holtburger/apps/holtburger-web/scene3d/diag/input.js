// scene3d/diag/input.js — keybinding + ActionMap dispatch diagnostic slice
//
// Pain point this addresses: the input pipeline (LOCAL_ACTIONS in
// `ui/keymap.js` + the retail ActionMap in `ui/ac_strings.js`) has
// zero runtime observability today. localStorage reads/writes are
// silent (quota / privacy-mode errors fall into the catch arms and
// vanish); rebinds don't log; conflicts where two labelHashes map to
// the same physical keypress have no detector; the Controls-tab
// rebind UI has no way to surface "the StringTable for action labels
// failed to load so the panel can't render rows" except indirectly
// via blank rows.
//
// This surface exposes:
//
//   __diag.input.activeBindings()  — merged defaults + user overrides
//   __diag.input.overrides()       — getKeybindings() pass-through
//   __diag.input.conflicts()       — labelHashes sharing one keypress
//   __diag.input.rebindHistory     — ring [{labelHash, old, new, ts}]
//   __diag.input.storageErrors     — ring [{op, error, ts}]
//   __diag.input.actionMapState()  — cross-ref into __diag.strings
//   __diag.input.summary()         — aggregate counters
//   __diag.input.snapshot()        — full picture for report.json
//
// Hooks fire from `ui/keymap.js` at the existing setBinding /
// clearBinding / localStorage-catch arms.

import { LOCAL_ACTIONS, getKeybindings, resolveLocalBinding } from "../../ui/keymap.js";

const DEFAULT_MAX_REBINDS = 50;
const DEFAULT_MAX_STORAGE_ERRORS = 20;

function errStr(e) {
  if (e == null) return "(null)";
  if (typeof e === "string") return e;
  if (e.message) return String(e.message);
  try { return String(e); } catch (_) { return "(unstringifiable)"; }
}

function bindingKey(b) {
  if (!b || !b.code) return null;
  return `${b.code}|${b.shift?1:0}${b.ctrl?1:0}${b.alt?1:0}${b.meta?1:0}`;
}

function pushCapped(arr, entry, max) {
  arr.push(entry);
  if (arr.length > max) arr.shift();
}

export function attachInput(diag) {
  const input = {
    rebindHistory: [],
    storageErrors: [],
    maxRebinds: DEFAULT_MAX_REBINDS,
    maxStorageErrors: DEFAULT_MAX_STORAGE_ERRORS,

    /**
     * Read-through: the LOCAL_ACTIONS table from `ui/keymap.js`.
     */
    defaults() {
      try {
        return LOCAL_ACTIONS.map((a) => ({ ...a }));
      } catch (_) { return []; }
    },

    /**
     * Read-through: getKeybindings() raw localStorage object.
     */
    overrides() {
      try {
        return { ...(getKeybindings() || {}) };
      } catch (e) {
        input.onStorageError({ op: "read", error: e });
        return {};
      }
    },

    /**
     * Resolved active bindings for every LOCAL_ACTIONS entry: user
     * override if set, default otherwise. Includes `source` per row
     * so the harness can tell which slots have been rebound.
     */
    activeBindings() {
      try {
        const overrides = input.overrides();
        return LOCAL_ACTIONS.map((a) => {
          const ov = overrides[a.labelHash];
          if (ov && ov.code) {
            return {
              labelHash: a.labelHash,
              label: a.label,
              binding: { ...ov },
              source: "override",
            };
          }
          return {
            labelHash: a.labelHash,
            label: a.label,
            binding: resolveLocalBinding(a.labelHash, a.defaultCode),
            source: "default",
          };
        });
      } catch (_) { return []; }
    },

    /**
     * Scan for keypress collisions: any physical-key shape mapped to
     * more than one labelHash. Returns the colliding groups.
     */
    conflicts() {
      try {
        const active = input.activeBindings();
        const byKey = new Map();
        for (const a of active) {
          const k = bindingKey(a.binding);
          if (!k) continue;
          let group = byKey.get(k);
          if (!group) {
            group = [];
            byKey.set(k, group);
          }
          group.push(a);
        }
        const out = [];
        for (const [key, group] of byKey) {
          if (group.length > 1) {
            out.push({
              keypress: key,
              labelHashes: group.map((g) => g.labelHash),
              labels: group.map((g) => g.label),
            });
          }
        }
        return out;
      } catch (_) { return []; }
    },

    /**
     * Cross-reference into __diag.strings — either the hook-observed
     * `actionMap` record OR the cached-from-pipeline read-through.
     * Returns `null` if `__diag.strings` isn't attached, or if no
     * ActionMap has been loaded by anyone yet.
     */
    actionMapState() {
      try {
        const ds = diag.strings;
        if (!ds) return null;
        if (ds.actionMap) {
          return {
            loaded: true,
            source: "hook",
            stringTableId: ds.actionMap.stringTableId,
            actionCount: ds.actionMap.actionCount,
            labelResolveFails: ds.actionMap.labelResolveFails,
          };
        }
        if (typeof ds.cached === "function") {
          const c = ds.cached();
          if (c?.actionMapLoaded) {
            return { loaded: true, source: "cache" };
          }
        }
        return null;
      } catch (_) { return null; }
    },

    /**
     * Fired from `ui/keymap.js::setBinding` (after persist) and
     * `clearBinding` (after persist). Meta: {labelHash, oldBinding,
     * newBinding, op: "set"|"clear"}.
     */
    onRebind(meta) {
      try {
        const m = meta || {};
        pushCapped(input.rebindHistory, {
          labelHash: m.labelHash || null,
          oldBinding: m.oldBinding ? { ...m.oldBinding } : null,
          newBinding: m.newBinding ? { ...m.newBinding } : null,
          op: m.op || "unknown",
          ts: performance.now(),
        }, input.maxRebinds);
      } catch (_) {}
    },

    /**
     * Fired from `ui/keymap.js` load() catch (quota / privacy mode /
     * corrupt cache) and persist() catch. Meta: {op: "read"|"write",
     * error}.
     */
    onStorageError(meta) {
      try {
        const m = meta || {};
        pushCapped(input.storageErrors, {
          op: m.op || "unknown",
          error: errStr(m.error),
          ts: performance.now(),
        }, input.maxStorageErrors);
      } catch (_) {}
    },

    summary() {
      const overrides = input.overrides();
      const conflictCount = input.conflicts().length;
      const am = input.actionMapState();
      return {
        defaultCount: (LOCAL_ACTIONS || []).length,
        overrideCount: Object.keys(overrides).length,
        conflictCount,
        rebindHistorySize: input.rebindHistory.length,
        storageErrorCount: input.storageErrors.length,
        actionMapReady: !!(am && am.loaded),
        actionMapActionCount: am ? am.actionCount : 0,
      };
    },

    snapshot() {
      return {
        ts: new Date().toISOString(),
        defaults: input.defaults(),
        overrides: input.overrides(),
        active: input.activeBindings(),
        conflicts: input.conflicts(),
        rebindHistory: [...input.rebindHistory],
        storageErrors: [...input.storageErrors],
        actionMap: input.actionMapState(),
      };
    },

    reset() {
      input.rebindHistory.length = 0;
      input.storageErrors.length = 0;
    },
  };

  diag.input = input;
}
