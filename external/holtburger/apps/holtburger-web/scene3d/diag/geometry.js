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
  };
}
