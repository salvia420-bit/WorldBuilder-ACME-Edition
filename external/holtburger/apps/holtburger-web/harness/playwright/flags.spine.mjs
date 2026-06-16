// harness/playwright/flags.spine.mjs — flag descriptors for the A1/A6/A8/A13
// "canonical tick spine" family (unifiedTick, posePublishPostTick,
// wireStatePacks, worldLifecycle, maintPrune, unifiedTransition).
//
// Each descriptor matches the schema in harness/lib/schema.md. assertBrowser()
// consumes ONLY the helpers object from harness/lib/boot.mjs#launchAndEnter and
// returns result(status, detail) from harness/lib/assert.mjs.
//
// CLASSIFICATION (per schema.md, load-bearing — never cry FAIL for an env/rebuild miss):
//   - getter/wasm export absent ........... 'rebuild-pending'  (helpers.readGetter(m).present === false)
//   - const-req / compose BEHAVIOR unmet .. 'skip'             (presence-only; documented reason)
//   - present + reachable + WRONG ......... 'fail'
//   - present + reachable + matched ....... 'pass'
//   - SERVER_DOWN / PLAYWRIGHT_MISSING .... handled by the DRIVER (whole run skips); never seen here
//
// SPINE-FAMILY GETTER REALITY (verified against pkg/holtburger_web.d.ts +
// src/lib.rs + index.html on 2026-06-15):
//   - There is NO SessionHandle "tick counter" / "frame counter" / "server
//     control sequence" getter. `world.player.server_control_sequence` is read
//     ONLY internally for the outbound wire packet (src/lib.rs:40431) — not
//     pollable. `window.__predTickCount` (index.html:11274) advances ONLY on
//     real WASD/turn key input, so it is 0 in a no-input headless boot and is
//     NOT a usable spine oracle here.
//   - The reliable headless spine signals are: the page reached in-world with a
//     coherent `getLocalPlayerPose()` (the driver already gated `inWorld` on
//     this), the per-frame world getters (`getCurrentCellId`, `getRenderSet`)
//     stay coherent across a `waitMs` window, the 3D rAF frame driver holds the
//     tick claim (`window.__scene3dFrameDriverActive`, best-effort — only set
//     under the single-driver const), and NO console error / pageerror fires.
//   - getLocalPlayerPose() is present in the current pkg, but every descriptor
//     still guards it with readGetter(...).present so a post-rebuild regression
//     classifies as 'rebuild-pending', never 'fail'.
//   - wireStatePacks' real proof is a server_control_sequence getter that does
//     NOT yet exist; the assert probes a speculative `serverControlSequence`
//     getter (so it runs green if a future wave adds it) and classifies its
//     absence as 'rebuild-pending', falling back to a clean-boot smoke.
//
// The rustTests / crate / composeDeps / constReq fields are carried verbatim so
// the cargo driver and its skip logic can read them without re-deriving.

import { result, pass, fail, skip, rebuildPending } from "../lib/assert.mjs";

// Console-error patterns that indicate a genuine wasm/world routing break for
// the "no console error across the session" smoke (worldLifecycle et al.).
// Matched case-insensitively against consoleErrors() text.
const FATAL_PATTERNS = [
  /unreachable/i,
  /\bpanic(ked)?\b/i,
  /RuntimeError/i,
  /wasm.*abort/i,
  /index out of bounds/i,
  /called `Option::unwrap\(\)`/i,
  /called `Result::unwrap\(\)`/i,
];

/**
 * Filter the page's console errors down to the ones that indicate a fatal
 * wasm/world break (drops benign asset 404s / texture warnings / network noise).
 * @param {Array<{t:number,type:string,text:string}>} errs
 * @returns {Array<{t:number,type:string,text:string}>}
 */
function fatalErrors(errs) {
  return (errs || []).filter((e) =>
    FATAL_PATTERNS.some((re) => re.test(e.text || ""))
  );
}

/**
 * Read getLocalPlayerPose() and validate it is a coherent struct
 * ({heading, isOnGround, landblockId, x, y, z} — all finite numbers, x/y in
 * landblock-local 0..192 range). Returns the helper envelope plus a validity
 * verdict so each assert can branch on present/absent/coherent uniformly.
 * @param {object} helpers
 * @returns {Promise<{present:boolean, value:any, coherent:boolean, why:string}>}
 */
async function readPose(helpers) {
  const got = await helpers.readGetter("getLocalPlayerPose");
  if (!got.present) {
    return { present: false, value: undefined, coherent: false, why: "getter absent" };
  }
  const p = got.value;
  if (p == null) {
    return { present: true, value: p, coherent: false, why: "pose null/undefined (not seeded)" };
  }
  if (p.__error) {
    return { present: true, value: p, coherent: false, why: `getter threw: ${p.__error}` };
  }
  const nums = ["heading", "x", "y", "z"].every((k) => Number.isFinite(Number(p[k])));
  const lbOk = Number.isFinite(Number(p.landblockId));
  const inRange =
    Number(p.x) >= -1 && Number(p.x) <= 193 && Number(p.y) >= -1 && Number(p.y) <= 193;
  const coherent = nums && lbOk && inRange && typeof p.isOnGround === "boolean";
  return {
    present: true,
    value: p,
    coherent,
    why: coherent
      ? "coherent"
      : `incoherent pose (nums=${nums} lbOk=${lbOk} inRange=${inRange} onGround=${typeof p.isOnGround})`,
  };
}

export const flags = [
  // ---------------------------------------------------------------------------
  // A1-O1 — canonical tick spine. No single getter; prove the spine ticks via
  // a coherent, repeatedly-readable pose across a settle window + clean boot.
  // ---------------------------------------------------------------------------
  {
    key: "unifiedTick",
    name: "A1-O1 canonical tick spine",
    tier: "A1-O1",
    query: "renderer=3d&unifiedTick=on",
    composeDeps: [],
    rebuildCoupled: true,
    rustTests: ["tick_spine_handle_ticks_and_preserves_tick_count"],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      // There is NO tick-count getter on SessionHandle (verified) and
      // __predTickCount only moves on real key input, so the spine-liveness
      // proof is: pose getter present + coherent, world getters coherent across
      // a settle window, no fatal console errors. Pose-getter absence after a
      // rebuild regression => rebuild-pending.
      const pose0 = await readPose(helpers);
      if (!pose0.present) {
        return rebuildPending("getLocalPlayerPose absent from current pkg");
      }
      if (!pose0.coherent) {
        return fail(`pose not coherent under unifiedTick: ${pose0.why}`);
      }
      // Let the spine tick for a beat, then confirm the world getters are still
      // coherent (cell id placed, render set non-empty => PVS established and a
      // tick advanced the spine without throwing).
      await helpers.waitMs(600);
      const world = await helpers.evalInPage(() => {
        const h = window.__sessionHandle;
        if (!h) return { ok: false, why: "no session handle" };
        const out = {
          ok: true,
          frameDriver: window.__scene3dFrameDriverActive === true,
        };
        try {
          out.cellId =
            typeof h.getCurrentCellId === "function" ? h.getCurrentCellId() >>> 0 : null;
        } catch (e) {
          out.cellErr = String(e && e.message ? e.message : e);
        }
        try {
          const rs = typeof h.getRenderSet === "function" ? h.getRenderSet(1) : null;
          out.renderSetLen = rs ? rs.length : null;
        } catch (e) {
          out.rsErr = String(e && e.message ? e.message : e);
        }
        return out;
      });
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(`fatal console error under unifiedTick: ${fatals[0].text}`);
      }
      if (world.cellErr || world.rsErr) {
        return fail(`world getter threw under unifiedTick: ${world.cellErr || world.rsErr}`);
      }
      const pose1 = await readPose(helpers);
      if (!pose1.coherent) {
        return fail(`pose went incoherent after spine settle: ${pose1.why}`);
      }
      // Spine confirmed live: in-world, pose coherent twice, world getters
      // coherent, clean boot. (cellId may legitimately be 0x0 outdoors-with-no-
      // envcell; renderSet may be empty in some bakes — so those are reported,
      // not asserted hard.)
      const detail =
        `spine live: pose coherent (lb=${pose1.value.landblockId}, onGround=${pose1.value.isOnGround}), ` +
        `cellId=0x${(world.cellId || 0).toString(16)}, renderSet=${world.renderSetLen}, ` +
        `frameDriver=${world.frameDriver}, no fatal console errors`;
      return pass(detail);
    },
  },

  // ---------------------------------------------------------------------------
  // A1-O2 — pose publish AFTER integrator tick. Read the local-player pose
  // getter; with the flag the publish is same-frame. Smoke: pose coherent +
  // stable (no NaN/jitter blow-up) across a window; getter absent => rebuild.
  // ---------------------------------------------------------------------------
  {
    key: "posePublishPostTick",
    name: "A1-O2 pose publish after integrator tick",
    tier: "A1-O2",
    query: "renderer=3d&unifiedTick=on&posePublishPostTick=on",
    composeDeps: ["unifiedTick"],
    rebuildCoupled: true,
    rustTests: [],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      const pose0 = await readPose(helpers);
      if (!pose0.present) {
        return rebuildPending("getLocalPlayerPose absent from current pkg");
      }
      if (!pose0.coherent) {
        return fail(`pose not coherent under posePublishPostTick: ${pose0.why}`);
      }
      // Sample the pose across a short window; with post-tick publish the
      // shadow stays coherent (no late-by-one NaN/teleport). We can't drive
      // input headlessly, so the behavioral assertion is "no regression":
      // pose stays finite + in-range, and any movement is bounded (no
      // teleport-scale jump frame-to-frame).
      await helpers.waitMs(500);
      const pose1 = await readPose(helpers);
      if (!pose1.coherent) {
        return fail(`pose went incoherent across publish window: ${pose1.why}`);
      }
      const dx = Number(pose1.value.x) - Number(pose0.value.x);
      const dy = Number(pose1.value.y) - Number(pose0.value.y);
      const dz = Number(pose1.value.z) - Number(pose0.value.z);
      const moved = Math.hypot(dx, dy, dz);
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(`fatal console error under posePublishPostTick: ${fatals[0].text}`);
      }
      // A coherent same-landblock pose with bounded idle drift (< 50 m over
      // 0.5 s with no input) is the no-regression pass. A teleport-scale jump
      // with no input would indicate a publish-order glitch.
      if (Number.isFinite(moved) && moved > 50) {
        return fail(
          `pose jumped ${moved.toFixed(2)} m in 0.5 s with no input — publish-order glitch?`
        );
      }
      return pass(
        `post-tick pose coherent + stable (idle drift ${moved.toFixed(3)} m/0.5 s, ` +
          `lb=${pose1.value.landblockId}); no fatal console errors`
      );
    },
  },

  // ---------------------------------------------------------------------------
  // A13-W1 — canonical movement-message routing (stage1). The real proof is
  // that world.player.server_control_sequence ADVANCES on a non-autonomous
  // UpdateMotion. That value has NO SessionHandle getter today, so probe a
  // speculative `serverControlSequence` getter (runs green if a future wave
  // adds it) and classify absence as rebuild-pending; fall back to a clean-boot
  // routing smoke (no fatal errors crossing the canonical handlers path).
  // ---------------------------------------------------------------------------
  {
    key: "wireStatePacks",
    name: "A13-W1 canonical movement-message routing (stage1)",
    tier: "A13-W1",
    query: "renderer=3d&wireStatePacks=stage1",
    composeDeps: [],
    rebuildCoupled: true,
    // NOTE: per the api-spec corrections, apply_self_update_motion +
    // record_server_control_sequence are PRODUCTION fns (zero-test filters);
    // build_jump_echoes_server_control_sequence lives in holtburger-CORE, not
    // -world. Names are carried verbatim from the task for the cargo driver,
    // which must apply those corrections (real coverage e.g. core
    // build_jump_echoes_server_control_sequence + world
    // test_update_motion_caches_last_non_zero_server_style).
    rustTests: [
      "apply_self_update_motion",
      "record_server_control_sequence",
      "build_jump_echoes_server_control_sequence",
    ],
    crate: "holtburger-world",
    async assertBrowser(helpers) {
      // 1) Try the (currently nonexistent) sequence getter. Present + reachable
      //    => assert it is a finite u32; if a non-autonomous motion has been
      //    routed it advances past 0, but a fresh idle boot may legitimately
      //    read 0, so 0 is reported, not failed.
      const seq = await helpers.readGetter("serverControlSequence");
      if (seq.present) {
        const v = seq.value && seq.value.__error ? null : Number(seq.value);
        if (v == null) {
          return fail(`serverControlSequence threw: ${seq.value.__error}`);
        }
        if (!Number.isFinite(v) || v < 0) {
          return fail(`serverControlSequence not a valid u32: ${seq.value}`);
        }
        return pass(
          `serverControlSequence readable = ${v} ` +
            `(advances on non-autonomous UpdateMotion under wireStatePacks=stage1; ` +
            `0 = no server-controlled motion yet this session)`
        );
      }
      // 2) No getter in this pkg (the expected case today): the canonical
      //    routing is exercised on every UpdatePosition/UpdateMotion/Teleport.
      //    Prove the canonical handlers path is wired without throwing by
      //    confirming a coherent in-world pose (the routed arm feeds it) + no
      //    fatal console errors. Classify the missing getter as rebuild-pending
      //    so the assert flips to a real value-check after the getter ships.
      const pose = await readPose(helpers);
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(
          `fatal console error under wireStatePacks=stage1: ${fatals[0].text}`
        );
      }
      if (!pose.present) {
        return rebuildPending(
          "no serverControlSequence getter AND getLocalPlayerPose absent — pkg pre-rebuild"
        );
      }
      if (!pose.coherent) {
        return fail(`pose not coherent under wireStatePacks=stage1: ${pose.why}`);
      }
      return rebuildPending(
        "serverControlSequence getter absent from current pkg — canonical routing " +
          "smoke OK (coherent pose, no fatal console errors); value-advance assert " +
          "runs after the getter ships"
      );
    },
  },

  // ---------------------------------------------------------------------------
  // A8-M1 — canonical world lifecycle routing. Pickup/equip/despawn behave
  // identically; the headless assertion is "NO unreachable/pageerror across a
  // login+spawn session" (the routing change is a wasm path swap). No getter.
  // ---------------------------------------------------------------------------
  {
    key: "worldLifecycle",
    name: "A8-M1 canonical world lifecycle routing",
    tier: "A8-M1",
    query: "renderer=3d&worldLifecycle=on",
    composeDeps: [],
    rebuildCoupled: true,
    // NOTE: parse_world_lifecycle_flag (holtburger-web lib.rs) +
    // entity_lifecycle_state (holtburger-world accessor) are PRODUCTION fns
    // (zero-test filters); the two test_* names are the real coverage. Carried
    // verbatim; the cargo driver must drop the non-tests and use crate
    // holtburger-world for the test_* pair.
    rustTests: [
      "parse_world_lifecycle_flag",
      "entity_lifecycle_state",
      "test_remove_entity_clears_lifecycle_metadata",
      "test_retention_snapshot_reflects_lifecycle_metadata",
    ],
    crate: "holtburger-world",
    async assertBrowser(helpers) {
      // Let a login+spawn session breathe so any lifecycle-routing panic
      // (despawn/equip handler) surfaces, then assert NO fatal console error.
      await helpers.waitMs(800);
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(
          `world lifecycle routing produced a fatal error: ${fatals[0].text}` +
            (fatals.length > 1 ? ` (+${fatals.length - 1} more)` : "")
        );
      }
      // Confirm the world is actually alive (entities present + pose coherent),
      // otherwise "no errors" is vacuous.
      const pose = await readPose(helpers);
      const n = await helpers.entityCount();
      if (!pose.present) {
        return rebuildPending("getLocalPlayerPose absent — cannot confirm live world");
      }
      if (!pose.coherent) {
        return fail(`pose not coherent under worldLifecycle: ${pose.why}`);
      }
      return pass(
        `worldLifecycle routing clean: no unreachable/panic across the session ` +
          `(entities=${n >= 0 ? n : "unknown"}, pose coherent lb=${pose.value.landblockId})`
      );
    },
  },

  // ---------------------------------------------------------------------------
  // A8-M2 — 25s out-of-PVS prune to rigs. After walking/teleporting >400 m for
  // ~30 s, far rig count drops (KIND_REMOVE emitted). Headless can't drive a
  // >400 m soak (no movement input, no guaranteed far entities), so this is a
  // compose-present-but-behavior-unexercised => skip, asserting only that the
  // composite booted clean and the entity count is readable.
  // ---------------------------------------------------------------------------
  {
    key: "maintPrune",
    name: "A8-M2 25s out-of-PVS prune to rigs",
    tier: "A8-M2",
    query: "renderer=3d&unifiedTick=on&maintPrune=on",
    composeDeps: ["unifiedTick"],
    rebuildCoupled: true,
    rustTests: ["tick_spine_handle_reports_out_of_visibility_prune_despawn"],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      // The prune behavior REQUIRES a >400 m / ~30 s walk-away soak with far
      // rigs in view — not drivable in a no-input headless boot. Assert the
      // composite (unifiedTick+maintPrune) booted clean and entity counting
      // works, then SKIP the actual rig-drop assertion (presence-only).
      const pose = await readPose(helpers);
      if (!pose.present) {
        return rebuildPending("getLocalPlayerPose absent from current pkg");
      }
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(
          `fatal console error under unifiedTick+maintPrune: ${fatals[0].text}`
        );
      }
      const n = await helpers.entityCount();
      if (n < 0) {
        return skip(
          "maintPrune composite booted but entity count unreadable — " +
            "cannot stage a walk-away soak headlessly; presence-only"
        );
      }
      if (!pose.coherent) {
        return fail(`pose not coherent under maintPrune composite: ${pose.why}`);
      }
      return skip(
        `maintPrune composite present + clean (entities=${n}, pose coherent) — ` +
          "prune drop needs a >400 m / ~30 s walk-away soak with far rigs, " +
          "not drivable in a no-input headless boot; presence-only"
      );
    },
  },

  // ---------------------------------------------------------------------------
  // A6-T1/T2 — retail transition pipeline. Run into a thin wall at speed => no
  // tunneling (position blocked). Headless can't drive a run-into-wall, so the
  // tunneling assertion is unexercised => skip, asserting only a clean boot of
  // the transition pipeline (no collision-solver panic) + coherent pose.
  // USE_UNIFIED_TRANSITION is the NATIVE const carrier but the ?unifiedTransition
  // URL flag drives it on wasm, so it is URL-settable (no constReq).
  // ---------------------------------------------------------------------------
  {
    key: "unifiedTransition",
    name: "A6-T1/T2 retail transition pipeline",
    tier: "A6-T1/T2",
    query: "renderer=3d&unifiedTransition=on",
    composeDeps: [],
    rebuildCoupled: true,
    // NOTE: unified_transition_enabled is a PRODUCTION getter (zero-test
    // filter); the two unified_transition_* tests are the real coverage.
    // Carried verbatim; the cargo driver must drop the non-test.
    rustTests: [
      "unified_transition_spine_manual_collision_matrix",
      "unified_transition_manual_slice_matches_legacy_on_open_ground",
      "unified_transition_enabled",
    ],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      const pose0 = await readPose(helpers);
      if (!pose0.present) {
        return rebuildPending("getLocalPlayerPose absent from current pkg");
      }
      if (!pose0.coherent) {
        return fail(`pose not coherent under unifiedTransition: ${pose0.why}`);
      }
      // Let the transition pipeline drive the solver for a beat; the no-input
      // case still routes the local body through transition()/find_valid_position
      // each frame. Assert no collision-solver panic + pose stays coherent.
      await helpers.waitMs(600);
      const pose1 = await readPose(helpers);
      const fatals = fatalErrors(helpers.consoleErrors());
      if (fatals.length) {
        return fail(
          `transition pipeline produced a fatal error: ${fatals[0].text}`
        );
      }
      if (!pose1.coherent) {
        return fail(`pose went incoherent under transition pipeline: ${pose1.why}`);
      }
      // The actual no-tunneling proof needs a run-into-a-thin-wall, which the
      // no-input headless boot can't stage. Pipeline booted clean + pose
      // coherent => SKIP the tunneling assertion (presence-only).
      return skip(
        `transition pipeline present + clean (pose coherent lb=${pose1.value.landblockId}, ` +
          "no solver panic) — no-tunneling proof needs a run-into-wall at speed, " +
          "not drivable in a no-input headless boot; presence-only"
      );
    },
  },
];

export default flags;
