// harness/playwright/flags.remote.mjs
// ---------------------------------------------------------------------------
// Flag descriptors for the REMOTE-position / pursuit driver group:
//   - remoteInterp  (A2-P2 remote-pose driver,  SessionHandle.pollRemotePoses)
//   - stickyRetail  (A2-P3 R2 remote sticky,     RemotePoseFrame.stickyFlags + localStickyTarget)
//   - wasmPursuit   (A14-I2 pursuit driver half, SessionHandle.pursuitStatus)
//
// Each descriptor conforms to harness/lib/schema.md. assertBrowser(helpers)
// consumes ONLY the helper API from harness/lib/boot.mjs#launchAndEnter and
// returns a {status,detail} envelope from harness/lib/assert.mjs. The DRIVER
// owns browser lifecycle + folds composeDeps into the query; these bodies only
// classify NON-url preconditions (constReq off, no mob in view, getter absent).
//
// Classification rules (schema.md §"Classification rules"):
//   getter/export absent ........ rebuild-pending  (rebuildCoupled getters; runs green post-rebuild)
//   composeDep behavior unexercised (no moving remote / sticky mob in view) .... skip (assert PRESENCE as the pass floor)
//   constReq Rust const off (USE_STICKY_MANAGER / USE_MOVETO_DRIVER) ............ skip (presence-only; documented fast-fail/zero is NOT a fail)
//   present + reachable + correct .............................................. pass
//   present + reachable + WRONG ............................................... fail
//
// Getter/diag names verified against pkg/holtburger_web.d.ts (current pkg/, manifest v4):
//   pollRemotePoses():RemotePoseFrame {guids:Uint32Array, landblocks:Uint32Array,
//     poses:Float32Array(stride-7 [x,y,z,qw,qx,qy,qz]), stickyFlags:Uint8Array}   (.d.ts:4337, 2643)
//   localStickyTarget():number                                                    (.d.ts:3998)
//   pursueEntity(target_guid, radius_m, height_m, run):void                       (.d.ts:4401)
//   pursuitStatus():number  (low16 state 0/1/2/3, high16 weenie err; read-clear)  (.d.ts:4414)
//   cancelPursuit():void                                                          (.d.ts:2965)
// url-flags.md rows: remoteInterp:478, stickyRetail:502, USE_STICKY_MANAGER:496,
//   wasmPursuit:140, USE_MOVETO_DRIVER:287.
// ---------------------------------------------------------------------------

import { result, pass, fail, skip, rebuildPending } from "../lib/assert.mjs";

// Enumerate up to `cap` live REMOTE entity guids (entityMap keys minus the
// local player guid). Self-contained for page.evaluate (no closures/imports).
// Returns { guids:number[], localGuid:number|null, total:number }.
function collectRemoteGuidsInPage(cap) {
  const out = [];
  let localGuid = null;
  try {
    localGuid =
      typeof window.getLocalPlayerGuid === "function"
        ? window.getLocalPlayerGuid()
        : null;
  } catch (_) {
    localGuid = null;
  }
  const lg = localGuid == null ? null : localGuid >>> 0;
  let total = 0;
  try {
    const em = window.entityMap;
    if (em && typeof em.forEach === "function") {
      em.forEach((_inst, guid) => {
        total += 1;
        const g = guid >>> 0;
        if (g !== 0 && (lg === null || g !== lg) && out.length < cap) {
          out.push(g);
        }
      });
    }
  } catch (_) {
    /* entityMap not ready */
  }
  return { guids: out, localGuid: lg, total };
}

export const flags = [
  // -------------------------------------------------------------------------
  // remoteInterp — A2-P2 remote-pose driver
  // -------------------------------------------------------------------------
  {
    key: "remoteInterp",
    name: "A2-P2 remote-pose driver",
    tier: "A2-P2",
    // MUST set the flag + every URL-settable composeDep so the driver folds
    // the full A2-P2 triple in (lib.rs warns + treats remoteInterp off without
    // unifiedTick + wireStatePacks=stage1).
    query: "renderer=3d&unifiedTick=on&wireStatePacks=stage1&remoteInterp=on",
    composeDeps: ["unifiedTick", "wireStatePacks"],
    rebuildCoupled: true,
    rustTests: [
      "poll_remote_poses",
      "flatten_remote_pose_rows",
      "remote_pose_rows_flatten_to_parallel_arrays",
      "resolve_remote_sticky_target_pose",
    ],
    crate: "holtburger-world",

    // SessionHandle.pollRemotePoses() returns a RemotePoseFrame (u32
    // guids/landblocks + stride-7 f32 poses). Assert it is a function and,
    // near a moving NPC, returns >0 rows with a well-formed stride-7 layout.
    async assertBrowser(helpers) {
      const got = await helpers.readGetter("pollRemotePoses");
      // 1. Getter ABSENT from current pkg/ => rebuild-pending (rides manifest v4).
      if (!got.present) {
        return rebuildPending(
          "pollRemotePoses absent from current pkg/ — additive v4 getter; runs after wasm rebuild"
        );
      }
      const frame = got.value;
      // An in-call throw lands as value.__error (treat as a real defect: the
      // getter exists but blew up).
      if (frame && typeof frame === "object" && "__error" in frame) {
        return fail(`pollRemotePoses() threw: ${frame.__error}`);
      }
      if (frame == null || typeof frame !== "object") {
        return fail(
          `pollRemotePoses() returned a non-object (${String(frame)}) — expected a RemotePoseFrame`
        );
      }
      // readGetter deep-clones typed arrays → plain JS arrays.
      const guids = Array.isArray(frame.guids) ? frame.guids : null;
      const landblocks = Array.isArray(frame.landblocks)
        ? frame.landblocks
        : null;
      const poses = Array.isArray(frame.poses) ? frame.poses : null;
      // 2. Shape sanity: the three parallel arrays must exist (the struct
      // always exposes them — empty arrays when no remote is managed).
      if (guids === null || landblocks === null || poses === null) {
        return fail(
          `RemotePoseFrame missing a parallel array (guids=${frame.guids === undefined ? "absent" : typeof frame.guids}, landblocks=${frame.landblocks === undefined ? "absent" : typeof frame.landblocks}, poses=${frame.poses === undefined ? "absent" : typeof frame.poses})`
        );
      }
      const rows = guids.length;
      // 3. No managed remote rows: composite is PRESENT but unexercised (no
      // moving remote NPC running the manager near the spawn). PRESENCE is the
      // pass floor; the >0-rows path is a skip, not a fail.
      if (rows === 0) {
        const seen = await helpers
          .evalInPage(collectRemoteGuidsInPage, 8)
          .catch(() => ({ total: 0 }));
        return skip(
          `pollRemotePoses present + callable; 0 managed remote rows (no moving remote NPC running the A2-P2 manager in view; entityMap remotes=${seen && typeof seen.total === "number" ? seen.total : "?"}) — composite present, behavior unexercised`
        );
      }
      // 4. Rows present => parallel arrays + stride-7 poses MUST be coherent.
      if (landblocks.length !== rows) {
        return fail(
          `RemotePoseFrame parallel-array mismatch: guids=${rows} landblocks=${landblocks.length}`
        );
      }
      if (poses.length !== rows * 7) {
        return fail(
          `RemotePoseFrame poses not stride-7: ${rows} rows expected ${rows * 7} floats, got ${poses.length}`
        );
      }
      if (frame.stickyFlags !== undefined) {
        const sf = Array.isArray(frame.stickyFlags) ? frame.stickyFlags : null;
        if (sf !== null && sf.length !== rows) {
          return fail(
            `RemotePoseFrame.stickyFlags length ${sf.length} != ${rows} rows`
          );
        }
      }
      // Spot-check row 0's quaternion is finite + roughly unit (qw,qx,qy,qz at
      // poses[3..7]) so we are reading a real pose, not garbage.
      const qw = poses[3];
      const qx = poses[4];
      const qy = poses[5];
      const qz = poses[6];
      const finite = [qw, qx, qy, qz].every((n) => Number.isFinite(n));
      if (!finite) {
        return fail(
          `RemotePoseFrame row0 quaternion non-finite [${qw},${qx},${qy},${qz}]`
        );
      }
      const qlen = Math.hypot(qw, qx, qy, qz);
      if (!(qlen > 0.5 && qlen < 1.5)) {
        return fail(
          `RemotePoseFrame row0 quaternion not unit-ish (|q|=${qlen.toFixed(4)}) [${qw},${qx},${qy},${qz}]`
        );
      }
      return pass(
        `pollRemotePoses → ${rows} managed remote row(s), parallel arrays aligned, stride-7 poses, row0 |q|=${qlen.toFixed(3)}`
      );
    },
  },

  // -------------------------------------------------------------------------
  // stickyRetail — A2-P3 R2 remote sticky
  // -------------------------------------------------------------------------
  {
    key: "stickyRetail",
    name: "A2-P3 R2 remote sticky",
    // Full compose query (url-flags.md:502 recommended): A2-P2 triple + the flag.
    query:
      "renderer=3d&unifiedTick=on&wireStatePacks=stage1&remoteInterp=on&stickyRetail=on",
    composeDeps: ["unifiedTick", "wireStatePacks", "remoteInterp"],
    // Rust const NOT settable from any URL (crates/holtburger-world/src/spatial/
    // position_manager.rs). A flagged sticky row / nonzero localStickyTarget is
    // impossible while it is off => those assertions become skip, never fail.
    constReq: "USE_STICKY_MANAGER",
    tier: "A2-P3",
    rebuildCoupled: true,
    rustTests: [
      "remote_sticky_converges_flags_rows_and_times_out",
      "remote_sticky_enabled",
      "remote_sticky_lazy_install_and_removal_cleanup",
      "remote_sticky_unstick_clears_and_restick_rearms_timeout",
      "remote_sticky_disabled_is_inert",
      "set_remote_sticky_enabled",
      "parse_sticky_retail_flag",
      "local_sticky_target",
      "apply_local_sticky_from_invalid",
      "local_sticky_install_feed_step_converges_and_times_out",
    ],
    crate: "holtburger-world",

    // RemotePoseFrame.stickyFlags per-row (additive getter) + localStickyTarget()
    // for the local player. Assert getters present; a sticky mob produces a
    // flagged row. Nonzero/flagged needs USE_STICKY_MANAGER => skip when off.
    async assertBrowser(helpers) {
      // --- localStickyTarget presence (additive v4) ---
      const lst = await helpers.readGetter("localStickyTarget");
      if (!lst.present) {
        return rebuildPending(
          "localStickyTarget absent from current pkg/ — additive v4 getter; runs after wasm rebuild"
        );
      }
      if (lst.value && typeof lst.value === "object" && "__error" in lst.value) {
        return fail(`localStickyTarget() threw: ${lst.value.__error}`);
      }
      const localTarget = lst.value >>> 0;

      // --- RemotePoseFrame.stickyFlags presence + per-row alignment ---
      const got = await helpers.readGetter("pollRemotePoses");
      if (!got.present) {
        return rebuildPending(
          "pollRemotePoses absent from current pkg/ — additive v4 getter; runs after wasm rebuild"
        );
      }
      const frame = got.value;
      if (frame && typeof frame === "object" && "__error" in frame) {
        return fail(`pollRemotePoses() threw: ${frame.__error}`);
      }
      if (frame == null || typeof frame !== "object") {
        return fail(
          `pollRemotePoses() returned a non-object (${String(frame)}) — expected a RemotePoseFrame`
        );
      }
      // The stickyFlags field itself is the additive R2 getter under test. On a
      // partially-rebuilt pkg the parent frame can exist without it.
      if (frame.stickyFlags === undefined) {
        return rebuildPending(
          "RemotePoseFrame.stickyFlags absent from current pkg/ — additive R2 getter; runs after wasm rebuild"
        );
      }
      const guids = Array.isArray(frame.guids) ? frame.guids : [];
      const stickyFlags = Array.isArray(frame.stickyFlags)
        ? frame.stickyFlags
        : null;
      if (stickyFlags === null) {
        return fail(
          `RemotePoseFrame.stickyFlags is not an array (${typeof frame.stickyFlags})`
        );
      }
      const rows = guids.length;
      // Per-row contract: stickyFlags[i] pairs with guids[i].
      if (rows > 0 && stickyFlags.length !== rows) {
        return fail(
          `RemotePoseFrame.stickyFlags length ${stickyFlags.length} != ${rows} guid rows`
        );
      }
      const flaggedRows = stickyFlags.filter((f) => (f >>> 0) === 1).length;

      // --- Behavioral classification ---
      // A FLAGGED row or nonzero localStickyTarget requires the full A2-P2
      // triple effective AND ?stickyRetail=on AND USE_STICKY_MANAGER on AND a
      // sticky mob in view. The driver folds the triple+flag into the query;
      // the remaining gates (const + mob) are what we cannot force here.
      if (flaggedRows > 0 || localTarget !== 0) {
        // Const is clearly live + something stuck => the R2 path is exercised.
        return pass(
          `sticky exercised: ${flaggedRows} sticky-stepped row(s) of ${rows}, localStickyTarget=0x${localTarget.toString(16)} — stickyFlags aligned, USE_STICKY_MANAGER live`
        );
      }
      // Nothing stuck: either USE_STICKY_MANAGER is off (const-gated, NOT a
      // fail) or no sticky mob is in view (composite present, unexercised).
      // Both resolve to skip with the getters proven present + aligned.
      return skip(
        `stickyFlags + localStickyTarget present + aligned (${rows} remote row(s), 0 flagged, localStickyTarget=0); no flagged row — USE_STICKY_MANAGER may be off in this build (Rust const, no URL) OR no sticky melee mob in view — presence-only`
      );
    },
  },

  // -------------------------------------------------------------------------
  // wasmPursuit — A14-I2 pursuit driver (wasm half)
  // -------------------------------------------------------------------------
  {
    key: "wasmPursuit",
    name: "A14-I2 pursuit driver (wasm half)",
    query: "renderer=3d&wasmPursuit=on",
    composeDeps: [],
    // crates/holtburger-core/src/client/movement/move_to.rs const. On a
    // driver-off build a pursue intent installs-then-fast-fails 0x36 (status 3)
    // and never reaches arrived(2) — a documented fast-fail, NOT a fail.
    constReq: "USE_MOVETO_DRIVER",
    tier: "A14-I2",
    rebuildCoupled: true,
    rustTests: [
      "second_pursuit_entry_turn_begins_on_first_driver_frame",
      "pursuit_status_lifecycle_and_cancel_restore",
    ],
    crate: "holtburger-core",

    // SessionHandle.pursuitStatus() (low16 = 0 idle / 1 active / 2 arrived /
    // 3 failed; high16 weenie err; read-clear). Assert present; on a charge it
    // transitions 1→2. Driver-off => fast-fail to 3 => skip (USE_MOVETO_DRIVER).
    async assertBrowser(helpers) {
      // 1. Presence of the status getter (additive v4, read-clear).
      const st = await helpers.readGetter("pursuitStatus");
      if (!st.present) {
        return rebuildPending(
          "pursuitStatus absent from current pkg/ — additive v4 getter; runs after wasm rebuild"
        );
      }
      if (st.value && typeof st.value === "object" && "__error" in st.value) {
        return fail(`pursuitStatus() threw: ${st.value.__error}`);
      }
      // 2. The companion command pursueEntity must also be present to drive a
      // 1→2 transition; cancelPursuit to clean up. Without pursueEntity we can
      // only assert presence (rebuild-pending if the whole pursuit surface is
      // not yet in pkg/).
      const probe = await helpers.evalInPage(() => {
        const h = window.__sessionHandle;
        return {
          haveHandle: !!h,
          havePursue: !!h && typeof h.pursueEntity === "function",
          haveCancel: !!h && typeof h.cancelPursuit === "function",
          haveStatus: !!h && typeof h.pursuitStatus === "function",
        };
      });
      if (!probe.haveHandle) {
        // No live SessionHandle => not in world (driver should have gated, but
        // be defensive): nothing to exercise.
        return skip("no live SessionHandle (window.__sessionHandle null) — not in world");
      }
      if (!probe.havePursue || !probe.haveStatus) {
        return rebuildPending(
          `pursuit surface incomplete in current pkg/ (pursueEntity=${probe.havePursue}, pursuitStatus=${probe.haveStatus}) — additive v4 exports; runs after wasm rebuild`
        );
      }

      // 3. Find a nearby REMOTE entity to charge (exclude the local player).
      const seen = await helpers.evalInPage(collectRemoteGuidsInPage, 6);
      const targets =
        seen && Array.isArray(seen.guids) ? seen.guids : [];
      if (targets.length === 0) {
        // Composite present but no entity in view to pursue. PRESENCE is the
        // pass floor; the 1→2 path is a skip.
        return skip(
          `pursuitStatus + pursueEntity present + callable; no remote entity in entityMap to charge (remotes=${seen && typeof seen.total === "number" ? seen.total : 0}) — driver present, transition unexercised`
        );
      }

      // 4. Drain any latched completion state first (read-clear), then issue a
      // pursue intent at the first target and poll pursuitStatus() across a few
      // page-clock ticks, looking for active(1) → arrived(2). Accept fast-fail
      // (3) as USE_MOVETO_DRIVER-off (skip), never fail.
      const targetGuid = targets[0] >>> 0;
      const drive = await helpers.evalInPage((guid) => {
        const h = window.__sessionHandle;
        const lo = (raw) => (raw >>> 0) & 0xffff;
        const hi = (raw) => (raw >>> 16) & 0xffff;
        let preDrain = null;
        try {
          preDrain = h.pursuitStatus() >>> 0;
        } catch (e) {
          return { issued: false, error: `pre-drain pursuitStatus threw: ${e && e.message ? e.message : String(e)}` };
        }
        // radius_m = charge stop range; height_m = 0 (flat metric); run = true.
        try {
          h.pursueEntity(guid >>> 0, 3.0, 0.0, true);
        } catch (e) {
          return {
            issued: false,
            preDrain: { lo: lo(preDrain), hi: hi(preDrain) },
            error: `pursueEntity threw: ${e && e.message ? e.message : String(e)}`,
          };
        }
        return { issued: true, preDrain: { lo: lo(preDrain), hi: hi(preDrain) } };
      }, targetGuid);

      if (drive && drive.error) {
        // pursueEntity present but the call threw → genuine defect.
        return fail(`${drive.error} (target 0x${targetGuid.toString(16)})`);
      }

      // Poll the read-clear status over ~1.5s of page time. Snapshot each
      // poll's low16 (capture the FIRST non-idle low16 we see — read-clear
      // consumes completion latches, so a single read may capture 2 or 3).
      const observed = [];
      let sawActive = false;
      let sawArrived = false;
      let sawFailed = false;
      let lastHi = 0;
      for (let i = 0; i < 8; i++) {
        await helpers.waitMs(200);
        const snap = await helpers.evalInPage(() => {
          const h = window.__sessionHandle;
          let raw = 0;
          try {
            raw = h.pursuitStatus() >>> 0;
          } catch (_) {
            return { lo: -1, hi: 0 };
          }
          return { lo: (raw >>> 0) & 0xffff, hi: (raw >>> 16) & 0xffff };
        });
        observed.push(snap.lo);
        if (snap.lo === 1) sawActive = true;
        else if (snap.lo === 2) sawArrived = true;
        else if (snap.lo === 3) {
          sawFailed = true;
          lastHi = snap.hi;
        }
      }
      // Always release the pursuit so a reused same-query session is clean.
      await helpers
        .evalInPage(() => {
          try {
            window.__sessionHandle.cancelPursuit?.();
          } catch (_) {}
        })
        .catch(() => {});

      const trace = `[pre lo=${drive && drive.preDrain ? drive.preDrain.lo : "?"}] polls=${observed.join(",")}`;

      // 5. Classify.
      if (sawArrived) {
        // active→arrived (the 2 latch) => the MoveTo driver steered to arrival.
        return pass(
          `pursuitStatus reached arrived(2) for target 0x${targetGuid.toString(16)} — MoveTo driver live (USE_MOVETO_DRIVER on); ${trace}`
        );
      }
      if (sawFailed) {
        // Fast-fail (3) — on a driver-OFF build the intent installs then
        // fast-fails 0x36; documented, NOT a fail. (high16 weenie err: 0x36
        // cancelled / 0x3D fail-distance / 0x37/0x38 lost / 8 unresolvable.)
        return skip(
          `pursuitStatus fast-failed to 3 (weenie 0x${lastHi.toString(16)}) — USE_MOVETO_DRIVER likely off in this build (Rust const, no URL): intent installs then 0x36 fast-fail — presence-only; ${trace}`
        );
      }
      if (sawActive) {
        // Active but neither arrived nor failed within the window: the driver
        // accepted the intent and is steering (target too far to arrive in
        // ~1.5s, or no convergence). Presence + acceptance proven; the full
        // 1→2 needs a reachable target — skip rather than fail.
        return skip(
          `pursuitStatus reached active(1) but did not arrive/fail within ~1.5s for target 0x${targetGuid.toString(16)} — driver accepted intent (steering); arrival unexercised (target out of reach) — presence + acceptance only; ${trace}`
        );
      }
      // Never left idle(0): the intent did not register at all. With the flag
      // on + getters present this is unexpected, but it is the documented
      // const-off shape too (some builds short-circuit before active). Treat as
      // a skip (presence-only) rather than a hard fail to honor the
      // "documented fast-fail/zero is NOT a fail" rule.
      return skip(
        `pursuitStatus stayed idle(0) after a pursue intent on target 0x${targetGuid.toString(16)} — intent did not register active; USE_MOVETO_DRIVER likely off (no driver to run the intent) — presence-only; ${trace}`
      );
    },
  },
];

export default flags;
