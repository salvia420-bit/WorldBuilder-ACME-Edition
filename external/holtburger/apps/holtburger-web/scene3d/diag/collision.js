// scene3d/diag/collision.js — collision self-tests + residency counters
// (P5.1, WORK-PLAN Tier 5, 2026-07-27)
//
// The gap this closes: the wasm side has shipped deterministic collision
// smokes since Phase 6 step B/C (`holtburg_test_collision_clamp_axis_-
// aligned`, `holtburg_test_collision_slide_along_wall`, the three door
// smokes, the fixture counts) — they are in `pkg/holtburger_web.d.ts` and
// they were unreachable from `window`. So "is collision working?" cost a
// 90-minute headless walk instead of one console call, and "did this
// landblock bake ANY collidable geometry?" was only answerable by scraping
// `[bsp]` / `[phase6.G]` drain lines out of the console.
//
// Two independent halves, deliberately kept separate:
//
//   selfTest()  — SYNTHETIC. In-memory fixtures, no live ACE, no resource
//                 source, no landblock required. Answers "is the collision
//                 MATH intact?" and runs pre-spawn, on the login screen.
//   residency() — LIVE. Reads `SessionHandle::collisionResidencyDiag()`,
//                 a per-tick mirror of the real `SpatialScene`. Answers
//                 "is there anything collidable resident RIGHT NOW?"
//
// Both are pure reads — nothing here runs, allocates or counts until a
// devtools call, so the surface is installed unconditionally like the rest
// of `__diag` (no URL flag; a flag would only gate work that doesn't exist).
//
// Devtools entry points on `__diag.collision`:
//   selfTest()      — run every wasm smoke; { ok, verdict, tests, counts }
//   residency()     — live SpatialScene index sizes; null pre-session
//   audit()         — both + a combined verdict (this is what runAll uses)
//   summary()       — last audit's summary (runs one if never run)
//   populate(lbId)  — re-run the statics + buildings populate for one LB
//                     and report the insert counts (async)

/** Wasm smokes that return 0 on pass / documented nonzero failure code.
 *  Names are the `__hbWasm` keys installed by the index.html riders; a
 *  stale `pkg/` simply leaves the key undefined and the test reports
 *  `"absent"` rather than throwing. */
const SMOKES = [
  ["clampAxisAligned", "holtburg_test_collision_clamp_axis_aligned"],
  ["slideAlongWall", "holtburg_test_collision_slide_along_wall"],
  ["doorOpenDropsAabb", "holtburg_test_door_open_drops_aabb"],
  ["doorCloseInsertsAabb", "holtburg_test_door_close_inserts_aabb"],
  ["doorPartRegistration", "holtburg_test_door_part_registration_via_aabb_index"],
];

/** Fixture counts with the floor each one's doc-comment pins. Same
 *  contract as the smokes: synthetic, deterministic, no live data. */
const COUNTS = [
  ["staticObjects", "holtburg_static_object_count", 14],
  ["townhallAabbs", "holtburg_townhall_aabb_count", 1],
  ["envCellPortals", "holtburg_envcell_count", 1],
];

/** Field order of `SessionHandle::collisionResidencyDiag()`'s comma-packed
 *  return. MUST stay in lockstep with the `format!` in
 *  `apps/holtburger-web/src/lib.rs::collision_residency_diag`. */
const RESIDENCY_FIELDS = [
  "buildingAabbs",
  "staticAabbs",
  "staticBsps",
  "buildingPhysics",
  "cellAabbs",
  "cellPhysicsTris",
  "cellPhysicsBsps",
  "cellStaticBsps",
  "cellMembership",
  "cellPortalGraph",
  "doorParts",
  "openDoorExclusions",
  "terrainHeightLbs",
  // DAT-01 phase 2e (2026-07-27) — baked procedural scenery (COL-01 trees /
  // COL-29 rocks). APPENDED, never inserted: a stale pkg/ returns the old
  // 13-field string, the extra names split to undefined -> null ("unknown"),
  // and every pre-existing counter still lands on its own name. Reordering
  // would silently mislabel all of them.
  //
  // Reading them: `sceneryColliders` is 0 on the shipped PRE-V3
  // `dist/scenery/` (no `aabb_*` fields to ingest) — that is EXPECTED until
  // the phase-3 re-bake, not a fault. `sceneryNarrowHits` stays 0 until
  // `USE_SCENERY_COLLISION` is flipped on in phase 4, because nothing calls
  // the narrow phase before then.
  "sceneryColliderLbs",
  "sceneryColliders",
  "sceneryNarrowHits",
  // REACHABILITY probe, bumped once per movement slice OUTSIDE the
  // `USE_SCENERY_COLLISION` gate. The arm's first home was dead code (the
  // legacy statics clamp chain, unreachable under USE_UNIFIED_TRANSITION), so
  // "flag off, no effect" and "flag on, no effect" looked identical. Walk for
  // a few seconds: nonzero here means the arm sits on the LIVE movement path.
  // Zero while walking means it does not, and no amount of flag-flipping will
  // change that.
  "sceneryArmEvals",
  // TIER-3 (2026-07-28) — same unconditional-reachability contract for the
  // WORLD-frame outdoor terrain contact-plane arm (`?terrainPlaneFrame`), the
  // shared fix for COL-16 / COL-17 / the stationary isOnGround flicker. Bumped
  // once per faithful transition slice OUTSIDE the gate: nonzero after any
  // outdoor movement means the arm is on the LIVE path.
  "terrainPlaneFrameArmEvals",
  // COL-27 (2026-07-28) — same contract for the INDOOR envcell-static overlap
  // bake (`?envcellStaticOverlap`), the fix for statics whose geometry spills
  // out of the cell they are authored in (Holtburg Meeting Hall's grand
  // staircase: the player walked THROUGH the flight). Bumped once per
  // per-landblock bake OUTSIDE the gate: nonzero after entering any dungeon
  // means the bake is on the LIVE path.
  "envcellStaticOverlapArmEvals",
];

function _hbWasm() {
  const w = (typeof window !== "undefined") ? window : null;
  return (w && w.__hbWasm) ? w.__hbWasm : null;
}

function _sessionHandle() {
  if (typeof window === "undefined") return null;
  return window.__sessionHandle ?? window.liveScene3d?.sessionHandle ?? null;
}

export function attachCollision(diag) {
  diag.collision = {
    lastResult: null,

    /**
     * Run every wasm collision smoke. Each returns 0 on pass; a nonzero
     * code is documented on the corresponding `export function` in
     * `pkg/holtburger_web.d.ts` (read it — the codes say WHICH half of
     * the fixture broke). Absent exports mean a stale `pkg/` and are
     * reported as `"absent"`, NOT as a pass.
     */
    selfTest() {
      const hb = _hbWasm();
      const out = {
        ts: new Date().toISOString(),
        ok: true,
        tests: {},
        counts: {},
      };
      if (!hb) {
        out.ok = false;
        out.error = "window.__hbWasm not installed (pre-boot)";
        return out;
      }
      for (const [name, fn] of SMOKES) {
        if (typeof hb[fn] !== "function") {
          out.tests[name] = { status: "absent", export: fn };
          out.ok = false;
          continue;
        }
        try {
          const code = hb[fn]() >>> 0;
          out.tests[name] = {
            status: code === 0 ? "pass" : "fail",
            code,
            export: fn,
          };
          if (code !== 0) out.ok = false;
        } catch (e) {
          out.tests[name] = { status: "threw", error: String(e?.message ?? e), export: fn };
          out.ok = false;
        }
      }
      for (const [name, fn, floor] of COUNTS) {
        if (typeof hb[fn] !== "function") {
          out.counts[name] = { status: "absent", export: fn };
          out.ok = false;
          continue;
        }
        try {
          const n = hb[fn]() >>> 0;
          out.counts[name] = {
            status: n >= floor ? "pass" : "fail",
            value: n,
            floor,
            export: fn,
          };
          if (n < floor) out.ok = false;
        } catch (e) {
          out.counts[name] = { status: "threw", error: String(e?.message ?? e), export: fn };
          out.ok = false;
        }
      }
      out.verdict = out.ok ? "PASS" : "DRIFT";
      return out;
    },

    /**
     * Live residency counters off the per-tick `collision_scene` mirror.
     * Returns null when there's no session yet (login screen) or when the
     * export is missing (stale `pkg/`) — both are "unknown", not "zero".
     *
     * `staticAabbs` / `staticBsps` are the outdoor-scenery collision the
     * COL-01 live answers say is missing; `terrainHeightLbs` is the
     * "how many landblocks are resident at all" denominator that makes a
     * zero meaningful.
     */
    residency() {
      const sh = _sessionHandle();
      if (!sh || typeof sh.collisionResidencyDiag !== "function") return null;
      let packed;
      try {
        packed = String(sh.collisionResidencyDiag());
      } catch (_) {
        return null;
      }
      const parts = packed.split(",");
      const out = {};
      for (let i = 0; i < RESIDENCY_FIELDS.length; i += 1) {
        const n = Number.parseInt(parts[i] ?? "", 10);
        out[RESIDENCY_FIELDS[i]] = Number.isFinite(n) ? n : null;
      }
      return out;
    },

    /**
     * Re-run the statics + buildings populate for one landblock and
     * report the insert counts — the same wasm entry points the boot path
     * calls per LB. Use when residency() reads zero and you want to know
     * whether the populate itself returns nothing (a bake/DAT problem) or
     * whether it returns entries that never reach the scene (a drain
     * problem). `lbId` may be a full cell id; wasm masks to 0xXXXX0000.
     */
    async populate(lbId) {
      const hb = _hbWasm();
      const id = (lbId >>> 0);
      const out = { landblockId: `0x${((id & 0xffff0000) >>> 0).toString(16).padStart(8, "0")}` };
      if (!hb) return { ...out, error: "window.__hbWasm not installed (pre-boot)" };
      try {
        out.statics = typeof hb.populateStaticsAabbsForLandblock === "function"
          ? await hb.populateStaticsAabbsForLandblock(id)
          : null;
      } catch (e) { out.staticsError = String(e?.message ?? e); }
      try {
        out.buildings = typeof hb.populateBuildingAabbsForLandblock === "function"
          ? await hb.populateBuildingAabbsForLandblock(id)
          : null;
      } catch (e) { out.buildingsError = String(e?.message ?? e); }
      // DAT-01 phase 2e — the third feed. `null` means the export is absent
      // (stale pkg/); `0` means the populate ran and found nothing to stage,
      // which on a pre-V3 `dist/scenery/` is the correct answer.
      try {
        out.scenery = typeof hb.populateSceneryCollidersForLandblock === "function"
          ? await hb.populateSceneryCollidersForLandblock(id)
          : null;
      } catch (e) { out.sceneryError = String(e?.message ?? e); }
      // The inserts are STAGED here; they only land in the scene on the
      // next TickMovement drain, so residency is read a tick later.
      out.residencyBeforeDrain = this.residency();
      return out;
    },

    /**
     * Combined verdict. `ok` is false when a synthetic smoke fails (the
     * math is broken) OR when terrain is resident but zero static AABBs
     * are — the COL-01 fingerprint, and the exact case that previously
     * looked identical to a healthy world from outside. Residency being
     * entirely unavailable (pre-session) is NOT a failure; it's reported
     * as `residency: null` and left out of the verdict.
     */
    audit() {
      const selfTest = this.selfTest();
      const residency = this.residency();
      const out = { ts: selfTest.ts, selfTest, residency };
      let staticsStarved = false;
      if (residency && residency.terrainHeightLbs > 0 && residency.staticAabbs === 0) {
        staticsStarved = true;
      }
      out.staticsStarved = staticsStarved;
      out.ok = selfTest.ok && !staticsStarved;
      out.summary = {
        smokes: Object.fromEntries(
          Object.entries(selfTest.tests).map(([k, v]) => [k, v.status]),
        ),
        staticAabbs: residency?.staticAabbs ?? null,
        buildingAabbs: residency?.buildingAabbs ?? null,
        cellStaticBsps: residency?.cellStaticBsps ?? null,
        terrainHeightLbs: residency?.terrainHeightLbs ?? null,
        staticsStarved,
        // DAT-01 phase 2e. Deliberately NOT folded into `ok` — a zero here
        // is the expected reading on the shipped pre-V3 bake, so gating the
        // verdict on it would make every healthy client report DRIFT.
        sceneryColliderLbs: residency?.sceneryColliderLbs ?? null,
        sceneryColliders: residency?.sceneryColliders ?? null,
        sceneryNarrowHits: residency?.sceneryNarrowHits ?? null,
        sceneryArmEvals: residency?.sceneryArmEvals ?? null,
        terrainPlaneFrameArmEvals: residency?.terrainPlaneFrameArmEvals ?? null,
        envcellStaticOverlapArmEvals:
          residency?.envcellStaticOverlapArmEvals ?? null,
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
