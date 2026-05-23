// scene3d/diag/pvs.js — runtime cell-visibility diagnostic slice (Wave 3)
//
// Read-only tap over the host runtime's per-frame PVS state. The runtime's
// `tickCellVisibility3D` (cells.js) already computes the visible cell set
// every rAF via `sessionHandle.getRenderSet(1)` and flips
// `cellContainer.visible` per entry in `scene3d.cellContainers3d`. We
// observe that result — never recompute it — and additionally record cell
// transitions in a bounded ring buffer so we can answer:
//
//   - "I'm here but the building 10m north didn't load" (diff vs oracle)
//   - "I crossed a portal but interior cells stayed visible" (transitions)
//
// The host hook calls `onCellTick(cellId)` once per frame from the bottom
// of `tickCellVisibility3D`, AFTER visibility flips are applied; we detect
// transitions ourselves by comparing to `_lastCellId`. Every read is of
// state the runtime already computed — no wasm calls, no scene walks.
//
// The oracle for `diff()` is a Set<cellId> supplied by the harness (future
// WB.Terminal cell-portal-graph dump). When absent, `diff()` returns the
// observed set only — never throws.

const MAX_TRANSITIONS = 100;

const hexCell = (cid) => "0x" + ((cid >>> 0).toString(16).padStart(8, "0"));

/** Resolve liveScene3d defensively; capture-time loops may have no scene. */
function ls() {
  return (typeof window !== "undefined") ? window.liveScene3d : null;
}

/** Resolve sessionHandle from scene or window fallback. */
function sh() {
  const live = ls();
  if (live?.sessionHandle) return live.sessionHandle;
  if (typeof window !== "undefined" && window.__sessionHandle) return window.__sessionHandle;
  return null;
}

export function attachPvs(diag) {
  diag.pvs = {
    _lastCellId: 0,
    transitions: [],
    maxTransitions: MAX_TRANSITIONS,

    /**
     * Host hook — called once per frame from `tickCellVisibility3D` after
     * visibility flips. Detects cell changes against `_lastCellId` and
     * pushes a transition record onto the ring. Cheap: 1 number compare
     * on the steady-state path; only allocates on actual transitions.
     */
    onCellTick(currentCellId) {
      const cid = (currentCellId >>> 0);
      if (cid === this._lastCellId) return;
      const t = performance.now();
      // We snapshot the visible-cell count AFTER the flip — i.e. the
      // visibility state the runtime will render on this frame.
      const visibleAtTransition = this.visibleCells();
      this.transitions.push({
        t,
        from: this._lastCellId,
        to: cid,
        fromHex: hexCell(this._lastCellId),
        toHex: hexCell(cid),
        visibleCount: visibleAtTransition.size,
      });
      if (this.transitions.length > this.maxTransitions) this.transitions.shift();
      this._lastCellId = cid;
    },

    /** Decoded current-cell view via sessionHandle (LB+cell-byte split). */
    currentCell() {
      const handle = sh();
      if (!handle || typeof handle.getCurrentCellId !== "function") return null;
      try {
        const cid = handle.getCurrentCellId() >>> 0;
        if (!cid) return null;
        return {
          cellId: cid,
          cellHex: hexCell(cid),
          lbId: (cid & 0xffff0000) >>> 0,
          lbHex: "0x" + (((cid & 0xffff0000) >>> 0).toString(16).padStart(8, "0")),
          cellX: (cid >>> 24) & 0xff,
          cellY: (cid >>> 16) & 0xff,
          cellIdx: cid & 0xffff,
        };
      } catch (_) { return null; }
    },

    /** Observed visible cells — flipped by `tickCellVisibility3D`. */
    visibleCells() {
      const live = ls();
      const out = new Set();
      if (live?.cellContainers3d instanceof Map) {
        for (const [cid, container] of live.cellContainers3d) {
          if (container?.visible) out.add(cid >>> 0);
        }
      }
      return out;
    },

    /**
     * Diff observed visible-cell set against an oracle Set<cellId>. When
     * `oracleVisibleSet` is null/undefined, returns observed-only (no
     * throw — `diff()` is the entry-point harnesses call first to check
     * the wiring). Missing = oracle has, observer doesn't (under-load).
     * Extra = observer shows, oracle doesn't (failed-to-hide / leaked).
     */
    diff(oracleVisibleSet) {
      const obs = this.visibleCells();
      if (!oracleVisibleSet || !(oracleVisibleSet instanceof Set)) {
        return { observed: Array.from(obs).map(hexCell), oracle: null };
      }
      const missing = [];
      const extra = [];
      for (const cid of oracleVisibleSet) if (!obs.has(cid >>> 0)) missing.push(hexCell(cid));
      for (const cid of obs) if (!oracleVisibleSet.has(cid >>> 0)) extra.push(hexCell(cid));
      return {
        observedCount: obs.size,
        oracleCount: oracleVisibleSet.size,
        missing,
        extra,
        ok: missing.length === 0 && extra.length === 0,
      };
    },

    /** Cheap status snapshot for telemetry / smoke tests. */
    snapshot() {
      const cur = this.currentCell();
      const last = this.transitions.length
        ? this.transitions[this.transitions.length - 1]
        : null;
      return {
        currentCell: cur,
        visibleCount: this.visibleCells().size,
        transitionsCount: this.transitions.length,
        lastTransition: last,
      };
    },

    /** Clear transition ring + reset baseline. Idempotent. */
    reset() {
      this.transitions.length = 0;
      this._lastCellId = 0;
    },
  };
}
