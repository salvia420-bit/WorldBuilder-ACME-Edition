// scene3d/diag.js — observed-vs-expected diagnostic layer
//
// Pain point this addresses: WB.Terminal queries the AC content (DAT
// files + ACE world database) and reports e.g. "landblock 0xA9B4 should
// have NPCs Alcott at (110.5, 158.3, 66.1) and Pathwarden at (...)";
// you boot the wire-agent and don't see them. The five failure modes
// are indistinguishable from outside:
//
//   (a) never-arrived-in-wire — server didn't send KIND_SPAWN
//   (b) arrived-but-drain-skipped — drain ran but didn't dispatch
//   (c) spawn-attempted-but-errored — _spawnImpl threw mid-await
//   (d) spawn-still-pending — async chain stuck on materials / animations
//   (e) spawn-succeeded-but-wrong-position — root added at unexpected coord
//
// This module installs `window.__diag` with entity-spawn lifecycle
// counters + per-landblock buckets + a `diff(lbId)` function that
// compares an externally-loaded expected-state oracle (from
// WorldBuilder.Terminal's `dump-lb-expectations` command) against
// observed entities and classifies each missing entry into one of
// the five modes above.
//
// Hooks fire from entities.js::spawn (attempted + failed) and
// _spawnImpl (succeeded). Cost is ~3 Map ops per spawn — negligible
// for the typical ~100 spawns per session. Always-on; not gated
// behind a URL flag so the diagnostic surface is always available
// for inspection from devtools without a page reload.

// Wave-1 surface attach modules. Each adds its own namespace to the
// installed __diag via `attach<Name>(diag)`. Imported here to keep diag.js
// the single installation point; modules can fail to load gracefully via
// the optional-chain in the install loop.
import { lbKeyOf } from "./landblock_lru.js";
import { attachPlacements as _attachPlacements } from "./diag/placements.js";
import { attachEntityTypes as _attachEntityTypes } from "./diag/entity_types.js";
import { attachEvents as _attachEvents } from "./diag/events.js";
import { attachWire as _attachWire } from "./diag/wire.js";
import { attachPhysics as _attachPhysics } from "./diag/physics.js";
import { attachMotion as _attachMotion } from "./diag/motion.js";
import { attachPvs as _attachPvs } from "./diag/pvs.js";
import { attachAssets as _attachAssets } from "./diag/assets.js";
import { attachIntegrity as _attachIntegrity } from "./diag/integrity.js";
import { attachFonts as _attachFonts } from "./diag/fonts.js";
import { attachStrings as _attachStrings } from "./diag/strings.js";
import { attachInput as _attachInput } from "./diag/input.js";
import { attachCombat as _attachCombat } from "./diag/combat.js";
import { attachPalettes as _attachPalettes } from "./diag/palettes.js";
import { attachLod as _attachLod } from "./diag/lod.js";
import { attachClothing as _attachClothing } from "./diag/clothing.js";
import { attachGeometry as _attachGeometry } from "./diag/geometry.js";

/** @typedef {{ guid: number, wcid: number, name: string, landblockId: number, x: number, y: number, z: number, setupId: number, attemptedAt: number, isLocalPlayer: boolean }} SpawnMeta */
/** @typedef {{ wcid: number, name: string, x: number, y: number, z: number, cell?: number }} ExpectedNpc */

const TWO_M_SQ = 4; // 2-meter tolerance squared for "misplaced" classification
const PENDING_TIMEOUT_MS = 5000; // spawn-pending classification threshold

export function installDiag() {
  if (typeof window === "undefined") return;
  // Idempotent: once installed, don't replace (preserves accumulated
  // counters across hot-reload edits during development).
  if (window.__diag && window.__diag._installed) return window.__diag;

  const diag = {
    _installed: true,

    // ── entity spawn lifecycle ────────────────────────────────────
    spawns: {
      attempted: 0,
      succeeded: 0,
      failed: [],   // [{ guid, wcid, name, lbId, error, attemptedAt, failedAt }]
      pending: new Map(),   // guid → SpawnMeta + awaitingWhat
      // Aggregate views built incrementally on each hook fire:
      byLandblock: new Map(),   // lbId → { attempted, succeeded, failed, pending: Set<guid> }
      byWcid: new Map(),        // wcid → [{ guid, lbId, x, y, z, name, status }]
      localPlayer: { attempted: 0, succeeded: 0 },
    },

    // ── expected-state oracle (loaded externally) ─────────────────
    expected: null,   // { landblockId, npcs: [...], buildings: [...], scenery: [...] }

    // ── bake state (read-through to existing scene3d state) ───────
    get bakes() {
      const ls = window.liveScene3d;
      return {
        terrain:   ls?.terrainBakedLbs   ?? null,
        buildings: ls?.buildingsBakedLbs ?? null,
        statics:   ls?.staticsBakedLbs   ?? null,
        envCells:  ls?.envCellLoadedLbs  ?? null,
        materialsPending: ls?.materialCache?.pendingFetches?.size ?? 0,
        counts: {
          buildings:       ls?.buildingsGroup?.children?.length ?? 0,
          statics:         ls?.staticsGroup?.children?.length   ?? 0,
          envCells:        ls?.cellsGroup?.children?.length     ?? 0,
          terrainMaterials: ls?.terrainMaterials?.length        ?? 0,
        },
      };
    },

    // ── lifecycle hooks (called from entities.js) ─────────────────
    onSpawnAttempted(meta) {
      this.spawns.attempted += 1;
      if (meta.isLocalPlayer) {
        this.spawns.localPlayer.attempted += 1;
        return;
      }
      const guid = meta.guid >>> 0;
      const lbId = ((meta.landblockId & 0xffff0000) >>> 0);
      const wcid = meta.wcid >>> 0;
      const record = {
        guid, wcid,
        name: meta.name ?? "",
        landblockId: lbId,
        x: meta.x ?? 0, y: meta.y ?? 0, z: meta.z ?? 0,
        setupId: (meta.setupId ?? meta.modelId ?? 0) >>> 0,
        attemptedAt: performance.now(),
        awaitingWhat: "init",
      };
      this.spawns.pending.set(guid, record);

      // byLandblock bucket
      let lbBucket = this.spawns.byLandblock.get(lbId);
      if (!lbBucket) {
        lbBucket = { attempted: 0, succeeded: 0, failed: 0, pending: new Set() };
        this.spawns.byLandblock.set(lbId, lbBucket);
      }
      lbBucket.attempted += 1;
      lbBucket.pending.add(guid);

      // byWcid bucket
      let wcidBucket = this.spawns.byWcid.get(wcid);
      if (!wcidBucket) {
        wcidBucket = [];
        this.spawns.byWcid.set(wcid, wcidBucket);
      }
      wcidBucket.push({ guid, lbId, x: record.x, y: record.y, z: record.z, name: record.name, status: "pending" });
    },

    onSpawnSucceeded(guid, inst) {
      const g = guid >>> 0;
      const pending = this.spawns.pending.get(g);
      // Local player has no pending record (we early-return in
      // onSpawnAttempted) — route the success counter to localPlayer
      // instead of the remote-entity bucket.
      if (!pending) {
        if (typeof window !== "undefined" && typeof window.getLocalPlayerGuid === "function") {
          try {
            const lpg = window.getLocalPlayerGuid();
            if (lpg !== null && lpg !== undefined && (lpg >>> 0) === g) {
              this.spawns.localPlayer.succeeded += 1;
              return;
            }
          } catch (_) {}
        }
      }
      this.spawns.succeeded += 1;
      if (pending) {
        const lbBucket = this.spawns.byLandblock.get(pending.landblockId);
        if (lbBucket) {
          lbBucket.pending.delete(g);
          lbBucket.succeeded += 1;
        }
        const wcidBucket = this.spawns.byWcid.get(pending.wcid);
        if (wcidBucket) {
          const idx = wcidBucket.findIndex((r) => r.guid === g);
          if (idx >= 0) wcidBucket[idx].status = "succeeded";
        }
        // Update final position from the actual instance — server pose
        // may have shifted between spawn-attempted and succeeded.
        if (inst?.root) {
          const wcidBucket2 = this.spawns.byWcid.get(pending.wcid);
          if (wcidBucket2) {
            const idx = wcidBucket2.findIndex((r) => r.guid === g);
            if (idx >= 0) {
              wcidBucket2[idx].x = inst.root.position.x;
              wcidBucket2[idx].y = inst.root.position.y;
              wcidBucket2[idx].z = inst.root.position.z;
            }
          }
        }
        this.spawns.pending.delete(g);
      }
    },

    onSpawnFailed(meta, error) {
      const g = (meta?.guid >>> 0) || 0;
      const pending = this.spawns.pending.get(g);
      const lbId = pending?.landblockId ?? lbKeyOf(meta?.landblockId >>> 0);
      const wcid = pending?.wcid ?? (meta?.wcid >>> 0);
      this.spawns.failed.push({
        guid: g,
        wcid,
        name: pending?.name ?? meta?.name ?? "",
        landblockId: lbId,
        error: String(error?.message ?? error ?? "unknown"),
        attemptedAt: pending?.attemptedAt ?? performance.now(),
        failedAt: performance.now(),
      });
      const lbBucket = this.spawns.byLandblock.get(lbId);
      if (lbBucket) {
        lbBucket.pending.delete(g);
        lbBucket.failed += 1;
      }
      const wcidBucket = this.spawns.byWcid.get(wcid);
      if (wcidBucket) {
        const idx = wcidBucket.findIndex((r) => r.guid === g);
        if (idx >= 0) wcidBucket[idx].status = "failed";
      }
      this.spawns.pending.delete(g);
    },

    // ── expected-state plumbing ───────────────────────────────────
    setExpected(data) {
      this.expected = data;
    },

    /**
     * Fetch + load expected state from a URL. Convenience wrapper for
     * test harnesses that want to side-load oracle data before boot.
     *   await window.__diag.loadExpected("/oracles/holtburg-0xA9B4.json");
     */
    async loadExpected(url) {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`loadExpected ${url}: ${resp.status}`);
      const data = await resp.json();
      this.setExpected(data);
      return data;
    },

    // ── diff: observed vs expected ────────────────────────────────
    /**
     * Compare the expected oracle against observed spawn state for one
     * landblock. Returns:
     *   {
     *     landblockId, expected: N, observed: M,
     *     missing: [{ expected, classification, detail }],
     *     extra: [...], misplaced: [...],
     *   }
     *
     * Classification of missing entries:
     *   - "wire-never-received" — no spawnAttempted seen for this wcid in
     *     ANY landblock (server may not have sent the packet)
     *   - "wire-arrived-other-lb" — saw this wcid spawn but in a different LB
     *   - "spawn-failed" — saw onSpawnFailed for this guid
     *   - "spawn-pending" — saw spawnAttempted, no spawnSucceeded after
     *     PENDING_TIMEOUT_MS — async chain is stuck
     *   - "spawn-succeeded-but-no-match" — succeeded but couldn't pair up;
     *     usually means name/wcid mismatch with oracle
     */
    diff(lbId) {
      if (!this.expected) {
        return { error: "no expected state loaded; call __diag.setExpected({...}) first" };
      }
      // Unsigned-coerce LAST so the bitwise-AND result doesn't sign-extend
      // for keys above 0x80000000 (e.g. Holtburg 0xA9B40000).
      const lb = ((lbId & 0xffff0000) >>> 0);
      const expectedNpcs = (this.expected.npcs ?? []).filter((_npc) => {
        if (this.expected.landblockId == null) return true;
        const oracleLb = typeof this.expected.landblockId === "string"
          ? parseInt(this.expected.landblockId, 16) >>> 0
          : (this.expected.landblockId >>> 0);
        return ((oracleLb & 0xffff0000) >>> 0) === lb;
      });

      const now = performance.now();
      const missing = [];
      const paired = new Set();   // observed guids already paired (good or bad)
      let goodMatches = 0;

      // Oracle positions are landblock-local (0–192). Observed positions
      // from `inst.root.position` are world-space (lbX*192 + localX etc).
      // Convert oracle to world by adding the LB origin.
      const lbX = (lb >> 24) & 0xff;
      const lbY = (lb >> 16) & 0xff;
      const METERS_PER_LB = 192.0;

      // Global-greedy pairing on SUCCEEDED observations only — multi-
      // instance wcids (Door=412, Royal Guard=37518) used to pair sub-
      // optimally under per-expected nearest-neighbour: a near-optimal
      // pairing globally beats any locally-greedy choice. Algorithm:
      // enumerate all (expected, succeeded-observation) pairs with
      // matching wcid + same LB, sort by distSq, take in order while
      // both sides are unclaimed.
      const succeededPairs = [];
      for (let i = 0; i < expectedNpcs.length; i++) {
        const exp = expectedNpcs[i];
        const wcid = exp.wcid >>> 0;
        const observedByWcid = this.spawns.byWcid.get(wcid) ?? [];
        const expWorldX = lbX * METERS_PER_LB + (exp.x ?? 0);
        const expWorldY = lbY * METERS_PER_LB + (exp.y ?? 0);
        const expWorldZ = (exp.z ?? 0);
        for (const obs of observedByWcid) {
          if (obs.lbId !== lb) continue;
          if (obs.status !== "succeeded") continue;
          const dx = obs.x - expWorldX;
          const dy = obs.y - expWorldY;
          const dz = obs.z - expWorldZ;
          const dSq = dx*dx + dy*dy + dz*dz;
          succeededPairs.push({ i, obs, dSq });
        }
      }
      succeededPairs.sort((a, b) => a.dSq - b.dSq);
      const matchedExp = new Map();   // expectedIdx → {obs, distSq}
      for (const p of succeededPairs) {
        if (matchedExp.has(p.i)) continue;
        if (paired.has(p.obs.guid)) continue;
        matchedExp.set(p.i, { obs: p.obs, distSq: p.dSq });
        paired.add(p.obs.guid);
      }

      // Walk expected list in original order, applying matchedExp first
      // and falling back to the failed/pending/elsewhere classification
      // for unmatched entries.
      for (let i = 0; i < expectedNpcs.length; i++) {
        const exp = expectedNpcs[i];
        const wcid = exp.wcid >>> 0;
        const observedByWcid = this.spawns.byWcid.get(wcid) ?? [];

        const matched = matchedExp.get(i);
        if (matched) {
          if (matched.distSq <= TWO_M_SQ) {
            goodMatches += 1;
          } else {
            missing.push({
              expected: exp,
              classification: "succeeded-but-misplaced",
              detail: {
                observedGuid: matched.obs.guid,
                observedPos: [matched.obs.x, matched.obs.y, matched.obs.z],
                distance: Math.sqrt(matched.distSq),
              },
            });
          }
          continue;
        }

        // No succeeded global-greedy match. Fall back: walk failed +
        // pending + elsewhere for this wcid (per-row nearest is fine
        // for these — they aren't position-sensitive contracts).
        let bestFail = null;
        let bestFailDistSq = Infinity;
        let bestPending = null;
        let bestPendingDistSq = Infinity;
        const expWorldX = lbX * METERS_PER_LB + (exp.x ?? 0);
        const expWorldY = lbY * METERS_PER_LB + (exp.y ?? 0);
        const expWorldZ = (exp.z ?? 0);
        for (const obs of observedByWcid) {
          if (paired.has(obs.guid)) continue;
          if (obs.lbId !== lb) continue;
          const dx = obs.x - expWorldX, dy = obs.y - expWorldY, dz = obs.z - expWorldZ;
          const dSq = dx*dx + dy*dy + dz*dz;
          if (obs.status === "failed" && dSq < bestFailDistSq) {
            bestFailDistSq = dSq; bestFail = obs;
          } else if (obs.status === "pending" && dSq < bestPendingDistSq) {
            bestPendingDistSq = dSq; bestPending = obs;
          }
        }
        if (bestFail) {
          const failure = this.spawns.failed.find((f) => f.guid === bestFail.guid);
          missing.push({
            expected: exp,
            classification: "spawn-failed",
            detail: { guid: bestFail.guid, error: failure?.error ?? "(unknown)" },
          });
          paired.add(bestFail.guid);
          continue;
        }
        if (bestPending) {
          const pending = this.spawns.pending.get(bestPending.guid);
          const age = pending ? now - pending.attemptedAt : 0;
          if (age > PENDING_TIMEOUT_MS) {
            missing.push({
              expected: exp,
              classification: "spawn-pending",
              detail: { guid: bestPending.guid, ageMs: age, awaitingWhat: pending?.awaitingWhat ?? "unknown" },
            });
            paired.add(bestPending.guid);
            continue;
          }
        }

        // No observation of this wcid at all in this LB. Check elsewhere.
        const sawElsewhere = observedByWcid.find((o) => o.lbId !== lb && !paired.has(o.guid));
        if (sawElsewhere) {
          missing.push({
            expected: exp,
            classification: "wire-arrived-other-lb",
            detail: { observedLb: `0x${sawElsewhere.lbId.toString(16)}`, observedGuid: sawElsewhere.guid },
          });
          paired.add(sawElsewhere.guid);
        } else {
          missing.push({
            expected: exp,
            classification: "wire-never-received",
            detail: null,
          });
        }
      }

      // Extras: observed entities in this LB not matched against any expected entry.
      const extra = [];
      for (const [wcid, records] of this.spawns.byWcid) {
        for (const obs of records) {
          if (obs.lbId !== lb) continue;
          if (paired.has(obs.guid)) continue;
          extra.push({ wcid, guid: obs.guid, name: obs.name, pos: [obs.x, obs.y, obs.z], status: obs.status });
        }
      }

      // Compute the count of observed entities in this LB (for the summary).
      let observedInLb = 0;
      const lbBucket = this.spawns.byLandblock.get(lb);
      if (lbBucket) observedInLb = lbBucket.succeeded + lbBucket.pending.size + lbBucket.failed;

      return {
        landblockId: `0x${lb.toString(16).padStart(8, "0")}`,
        expectedCount: expectedNpcs.length,
        observedCount: observedInLb,
        goodMatches,
        pairedCount: paired.size,
        missing,
        extra,
        ok: missing.length === 0,
        summary: missing.reduce((acc, m) => {
          acc[m.classification] = (acc[m.classification] ?? 0) + 1;
          return acc;
        }, {}),
      };
    },

    // ── convenience: human-readable summary ───────────────────────
    summary() {
      const s = this.spawns;
      return {
        attempted: s.attempted,
        succeeded: s.succeeded,
        failed: s.failed.length,
        pending: s.pending.size,
        localPlayer: { ...s.localPlayer },
        byLandblock: Array.from(s.byLandblock.entries()).map(([lb, b]) => ({
          lb: `0x${lb.toString(16).padStart(8, "0")}`,
          attempted: b.attempted, succeeded: b.succeeded, failed: b.failed, pending: b.pending.size,
        })),
        bakes: this.bakes.counts,
      };
    },
  };

  window.__diag = diag;

  // Wave-1 surfaces: each new module attaches its own namespace via
  // `attach<Name>(diag)`. The attach pattern keeps diag.js the single
  // installation point while letting each surface own its own file under
  // ./diag/. Order is not load-bearing — attach failures are isolated
  // so one broken surface doesn't kill the rest.
  for (const [name, fn] of [
    ["placements", _attachPlacements],
    ["entityTypes", _attachEntityTypes],
    ["events",     _attachEvents],
    ["wire",       _attachWire],
    ["physics",    _attachPhysics],
    ["motion",     _attachMotion],
    ["pvs",        _attachPvs],
    ["assets",     _attachAssets],
    ["integrity",  _attachIntegrity],
    ["fonts",      _attachFonts],
    ["strings",    _attachStrings],
    ["input",      _attachInput],
    ["combat",     _attachCombat],
    ["palettes",   _attachPalettes],
    ["lod",        _attachLod],
    ["clothing",   _attachClothing],
    ["geometry",   _attachGeometry],
  ]) {
    try { fn?.(diag); } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[diag] attach ${name} failed:`, e);
    }
  }

  // Convenience: run every diff function that has an oracle loaded and
  // return an aggregated structured object the harness can serialize to
  // a report.json. Mirror of build-side `diag-run-all`.
  diag.runAll = function runAll(lbId) {
    const out = { landblockId: `0x${(((lbId >>> 0) & 0xffff0000) >>> 0).toString(16).padStart(8, "0")}`, ts: new Date().toISOString(), surfaces: {} };
    try { out.surfaces.spawns = this.diff(lbId); } catch (e) { out.surfaces.spawns = { error: String(e?.message ?? e) }; }
    try { if (this.placements?.diff) out.surfaces.placements = this.placements.diff(lbId); } catch (e) { out.surfaces.placements = { error: String(e?.message ?? e) }; }
    try { if (this.entityTypes?.coverageByLb) out.surfaces.entityTypes = this.entityTypes.coverageByLb(lbId); } catch (e) { out.surfaces.entityTypes = { error: String(e?.message ?? e) }; }
    try { if (this.events?.diff) out.surfaces.events = this.events.diff(lbId); } catch (e) { out.surfaces.events = { error: String(e?.message ?? e) }; }
    // geom-audit (2026-07-02): scene-wide geometry completeness (entity
    // rig parts + envcell stab attachment). Oracle-free — audits the
    // live scene against the build-time stamps, so it always runs.
    try { if (this.geometry?.audit) out.surfaces.geometry = this.geometry.audit(); } catch (e) { out.surfaces.geometry = { error: String(e?.message ?? e) }; }
    out.summary = Object.fromEntries(Object.entries(out.surfaces).map(([k, v]) => [k, v?.error ? "INFRA" : (v?.ok === false ? "DRIFT" : "PASS")]));
    return out;
  };

  // eslint-disable-next-line no-console
  console.log("[diag] window.__diag installed — call .summary() / .runAll(lbId) / .diff(lbId) from devtools");
  return diag;
}
