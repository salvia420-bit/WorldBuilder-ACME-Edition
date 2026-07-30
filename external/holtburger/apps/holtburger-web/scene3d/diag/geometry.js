// scene3d/diag/geometry.js — geometry-completeness audit (geom-audit 2026-07-02)
//
// Catches the "geometry that should exist but is not in the scene" class:
//   1. half-missing multi-part Setups (an entity part whose GfxObj decode
//      soft-skipped → empty part group, e.g. the Holtburg cooking forge), and
//   2. missing interior statics (EnvCell stab models dropped from a per-LB
//      bake — no tables/chairs in the grocer).
//
// The producers stamp the expectations at build time:
//   - entities.js: every part of a spawned rig is a `part_<i>` Group whose
//     mesh count is directly observable; `inst.parts.length` = the Setup's
//     authored part count (from the wasm EntityAnimationData).
//   - cells.js: each envcell container's userData carries
//     { expectedStatics, peeledAnimated, missingStaticDids } (geom-audit
//     stamps), and each attached stab is a child with userData.isCellStatic.
//
// Every mismatch this audit reports is either UNEXPLAINED (a real bug —
// nothing logged a reason) or EXPLAINED (cells.js/wasm already console-
// warned it: decode-starved / zero-tri / batch-failed). The wasm side
// additionally tags `ModelMesh.decodeMisses` and logs `[geom-audit]`
// warns; cross-reference the console for the reason lines.
//
// Devtools entry points on `__diag.geometry`:
//   audit()   — full sweep; returns { ok, entities, cells, summary }
//   summary() — last audit's summary (runs one if never run)

export function attachGeometry(diag) {
  diag.geometry = {
    lastResult: null,

    audit() {
      const s3d = window.liveScene3d;
      const out = {
        ts: new Date().toISOString(),
        ok: true,
        entities: { checked: 0, incomplete: [] },
        cells: { checked: 0, incomplete: [] },
      };
      if (!s3d) {
        out.ok = false;
        out.error = "liveScene3d not ready";
        this.lastResult = out;
        return out;
      }

      // --- 1. Entity rigs: every part group must hold >=1 mesh with
      // non-empty geometry. A rig part with zero meshes/tris means the
      // part's GfxObj never decoded (or decoded empty).
      try {
        const em = s3d.entityManager;
        if (em?.entityMap) {
          for (const [guid, inst] of em.entityMap) {
            const parts = inst?.parts;
            if (!Array.isArray(parts) || parts.length === 0) continue;
            out.entities.checked += 1;
            const emptyParts = [];
            for (let p = 0; p < parts.length; p += 1) {
              let meshes = 0;
              let tris = 0;
              try {
                parts[p]?.traverse?.((o) => {
                  if (o.isMesh) {
                    meshes += 1;
                    const pos = o.geometry?.attributes?.position;
                    tris += pos ? pos.count / 3 : 0;
                  }
                });
              } catch (_) { /* per-part fail-soft */ }
              if (meshes === 0 || tris === 0) emptyParts.push(p);
            }
            if (emptyParts.length > 0) {
              out.entities.incomplete.push({
                guid: `0x${(guid >>> 0).toString(16)}`,
                name: inst?.meta?.name ?? null,
                wcid: (inst?.meta?.wcid ?? 0) >>> 0,
                setupId: `0x${(((inst?.meta?.setupDid ?? inst?.meta?.setupId ?? 0)) >>> 0).toString(16)}`,
                partCount: parts.length,
                emptyParts,
              });
            }
          }
        }
      } catch (e) {
        out.entities.error = String(e?.message ?? e);
      }

      // --- 2. EnvCell containers: attached cell-statics (+ animated
      // peel-offs, attached under the same container) must equal the
      // authored stab count. `missingStaticDids` entries are EXPLAINED
      // drops (already console-warned with reasons); anything else
      // missing is UNEXPLAINED.
      try {
        if (s3d.cellContainers3d instanceof Map) {
          for (const [cellId, container] of s3d.cellContainers3d) {
            const ud = container?.userData;
            if (!ud || typeof ud.expectedStatics !== "number") continue; // pre-audit container
            out.cells.checked += 1;
            let attached = 0;
            for (const k of container.children) {
              if (k?.userData?.isCellStatic) attached += 1;
              // animated peel-offs parent under the container a beat
              // later with their own node type; count any non-mesh
              // child groups tagged by animated_scenery.
              else if (k?.userData?.isAnimatedScenery) attached += 1;
            }
            const explained = Array.isArray(ud.missingStaticDids) ? ud.missingStaticDids.length : 0;
            const peeled = (ud.peeledAnimated | 0);
            // peeled statics attach asynchronously — count them as
            // satisfied whether or not the node landed yet (they have
            // their own attach-failure warn path).
            const accounted = attached + explained + Math.max(0, peeled - countAnimated(container));
            if (accounted < ud.expectedStatics) {
              out.cells.incomplete.push({
                cellId: `0x${(cellId >>> 0).toString(16)}`,
                expected: ud.expectedStatics,
                attached,
                peeledAnimated: peeled,
                explainedMissing: (ud.missingStaticDids || []).map((d) => `0x${(d >>> 0).toString(16)}`),
                unexplainedShortfall: ud.expectedStatics - accounted,
              });
            }
          }
        }
      } catch (e) {
        out.cells.error = String(e?.message ?? e);
      }

      function countAnimated(container) {
        let n = 0;
        for (const k of container.children) {
          if (k?.userData?.isAnimatedScenery) n += 1;
        }
        return n;
      }

      const entBad = out.entities.incomplete.length;
      const cellUnexplained = out.cells.incomplete.filter((c) => c.unexplainedShortfall > 0).length;
      out.ok = entBad === 0 && cellUnexplained === 0;
      out.summary = {
        entitiesChecked: out.entities.checked,
        entitiesIncomplete: entBad,
        cellsChecked: out.cells.checked,
        cellsIncomplete: out.cells.incomplete.length,
        cellsUnexplained: cellUnexplained,
        verdict: out.ok ? "PASS" : "DRIFT",
      };
      this.lastResult = out;
      return out;
    },

    summary() {
      if (!this.lastResult) this.audit();
      return this.lastResult?.summary ?? null;
    },

    /**
     * `?gfxRelief` — what the geometry-relief gate ACTUALLY resolved to, plus
     * live evidence that it reached both wasm instances and survived the
     * statics atlas. A headless session asserts on this rather than on eyes:
     *
     *   const r = window.__diag.geometry.relief();
     *   r.config.enabled === true && r.config.subdivLevel === 1
     *   r.mainApplied.ok === true             // pkg/ is not stale
     *   r.workerApplied?.applied["bake-worker"].ok === true   // no split brain
     *   r.split === false
     *
     * `sampleVertexCounts` is the raw before/after signal: with relief ON the
     * per-mesh vertex counts of atlased statics should be ~4x (level 1) or
     * ~16x (level 2) the flag-off baseline for the same landblock.
     */
    relief() {
      const cfg =
        (typeof window !== "undefined" && window.__gfxRelief) || null;
      const out = {
        ts: new Date().toISOString(),
        // Resolved on the MAIN thread by scene3d/gfx_relief.js.
        config: cfg,
        // Outcome of `set_gfx_relief` on the MAIN wasm instance. `ok:false` +
        // `wasmExportPresent:false` = stale pkg/, the feature is a no-op.
        mainApplied: (cfg && cfg.applied && cfg.applied.main) || null,
        // The bake worker's OWN echo (it owns a SECOND wasm instance and would
        // otherwise bake flat invisibly). null until the worker has spawned —
        // it is lazy, so this stays null on a session that never baked, and
        // under `?bakeWorker=0` it stays null forever, which is correct.
        workerApplied:
          (typeof globalThis !== "undefined" && globalThis.__hbGfxReliefWorkerAck) ||
          null,
        split: null,
        sampleVertexCounts: null,
      };
      // Split-brain check: main-thread config vs what the worker ACKed.
      const wa = out.workerApplied;
      if (cfg && wa) {
        out.split =
          cfg.enabled !== wa.enabled ||
          cfg.subdivLevel !== wa.subdivLevel ||
          cfg.scale !== wa.scale;
      }
      // Vertex-count census over the statics graph — the load-bearing check
      // that displaced positions actually reached the GPU buffers (the statics
      // ATLAS is default-ON and merges into BatchedMesh, so we count both the
      // plain singletons and the atlas buckets).
      try {
        const s3d = typeof window !== "undefined" ? window.liveScene3d : null;
        const g = s3d && s3d.staticsGroup;
        if (g) {
          let meshes = 0;
          let atlasBuckets = 0;
          let verts = 0;
          g.traverse((o) => {
            if (!o) return;
            if (o.isBatchedMesh) {
              atlasBuckets += 1;
              const ud = o.userData || {};
              if (Number.isFinite(ud.usedVerts)) verts += ud.usedVerts;
              return;
            }
            if (o.isMesh && o.geometry?.attributes?.position) {
              meshes += 1;
              verts += o.geometry.attributes.position.count;
            }
          });
          out.sampleVertexCounts = { meshes, atlasBuckets, verts };
        }
      } catch (_) {
        /* census is advisory */
      }
      return out;
    },
  };
}
