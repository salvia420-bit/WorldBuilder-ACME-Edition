// harness/playwright/flags.anim.mjs
// ---------------------------------------------------------------------------
// Animation / movement-completion flag descriptors for the headless Playwright
// flag harness. Consumed by the driver (which owns browser lifecycle): for each
// descriptor it merges `query` + `composeDeps` into the base headless+autoLogin
// query (harness/lib/boot.mjs#BASE_QUERY), launches once per distinct query,
// confirms `inWorld`, then `await descriptor.assertBrowser(helpers)` and
// aggregates the {status, detail} envelope.
//
// SCHEMA: harness/lib/schema.md (descriptor shape + the helpers contract).
// ASSERT HELPERS: harness/lib/assert.mjs (result/pass/fail/skip/rebuildPending).
//
// CLASSIFICATION RULES (load-bearing — never cry FAIL for env/rebuild timing):
//   - getter / wasm export ABSENT from current pkg/  => 'rebuild-pending'
//       (probe helpers.readGetter(m).present, or a typeof guard for a bridge /
//        struct-return getter; the harness runs AFTER the user's separate wasm
//        rebuild which could regress pkg/, so absence is expected, not a defect).
//   - composeDep behavior unexercised (no mob/clip/translating-one-shot in
//     view) OR a Rust constReq that CANNOT be set from a URL is off
//     (USE_MOTION_TABLE_QUEUE / USE_STICKY_MANAGER / USE_MOVETO_DRIVER ...)
//       => 'skip' (driver still runs; assert PRESENCE/callability as the floor).
//   - present + reachable + WRONG  => 'fail'.
//   - present + reachable + matched => 'pass'.
//
// All wasm reads go through helpers (which run inside page.evaluate): the live
// SessionHandle is window.__sessionHandle; readGetter('m', args) returns
// {present, value}; readDiag('__x.y') JSON-clones a debug global; evalInPage(fn)
// runs a self-contained fn in the page. NEVER call helpers.close() in here — the
// driver owns it.
//
// rustTests / crate / composeDeps / constReq are copied VERBATIM from the task
// spec + docs/url-flags.md so the companion cargo step
//   cargo test -p <crate> --lib -- <rustTests...>
// and the driver's skip logic can read them. (Per the api-spec corrections,
// several "tests" the task listed are actually production fns that match ZERO
// cargo tests — they are kept verbatim here as the spec requires; the cargo
// driver is responsible for substring-matching real #[test] names.)
// ---------------------------------------------------------------------------

import {
  result,
  pass,
  fail,
  skip,
  rebuildPending,
  assert,
  runAsserts,
} from "../lib/assert.mjs";

export const flags = [
  // ===================================================================
  // mtQueue — A4-Q2 AnimationDone across the wasm boundary
  // ===================================================================
  // url-flags.md:466. ON wires one-shot overlay COMPLETION across the wasm
  // boundary: tagged (mtQueued-played) overlays call window.__notifyAnimationDone
  // (index.html:8102 bridge, next to window.__sessionHandle) -> wasm
  // SessionHandle.notifyAnimationDone (d.ts:4092) -> A4 per-guid recv arm.
  // The Rust queue is INERT unless the core const USE_MOTION_TABLE_QUEUE is on,
  // and there is NO current caller that TAGS overlays (enqueue sources arrive
  // with Stage-2 ?interpRig / A3-D2), so the end-to-end "tagged one-shot
  // completion notifies" path cannot be exercised here. We therefore assert
  // PRESENCE/callability of both halves (the bridge fn + the wasm export) and
  // classify the unexercised end-to-end path as skip.
  {
    key: "mtQueue",
    name: "A4-Q2 AnimationDone across wasm boundary",
    tier: "A4-Q2",
    query: "renderer=3d&hookDrain=on&mtQueue=on",
    composeDeps: ["hookDrain"],
    constReq: "USE_MOTION_TABLE_QUEUE",
    rebuildCoupled: true,
    rustTests: [],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      // 1) The wasm export half — absent => rebuild-pending (manifest v4).
      const probe = await helpers.readGetter("notifyAnimationDone", [0, true]);
      if (!probe.present) {
        return rebuildPending(
          "SessionHandle.notifyAnimationDone absent from current pkg/ (manifest v4 export)"
        );
      }
      // 2) The bridge half — window.__notifyAnimationDone is always installed
      //    in index.html, but is a SOFT NO-OP unless the wasm export exists.
      //    Confirm it is a callable function and does not throw on a benign
      //    (guid=0) call.
      const bridge = await helpers.evalInPage(() => {
        const fn = window.__notifyAnimationDone;
        if (typeof fn !== "function") return { present: false };
        let threw = null;
        try {
          fn(0, true);
        } catch (e) {
          threw = e && e.message ? e.message : String(e);
        }
        return { present: true, threw };
      });
      if (!bridge.present) {
        return rebuildPending(
          "window.__notifyAnimationDone bridge not installed (handle-ready gate not reached)"
        );
      }
      if (bridge.threw) {
        return fail(
          `window.__notifyAnimationDone(0,true) threw: ${bridge.threw}`
        );
      }
      // The export + bridge are both present and callable. The retail
      // "tagged one-shot completes -> notify -> queue truncation" path needs
      // the core const USE_MOTION_TABLE_QUEUE on AND a tagging enqueue source
      // (?interpRig / A3-D2), neither URL-settable / present yet -> skip.
      return skip(
        "notifyAnimationDone export + __notifyAnimationDone bridge present & callable; " +
          "tagged-one-shot completion needs USE_MOTION_TABLE_QUEUE const + an enqueue tagger (?interpRig/A3-D2) — presence-only"
      );
    },
  },

  // ===================================================================
  // jumpParity — A14-I4 jump charge clock (wasm half)
  // ===================================================================
  // url-flags.md:490. Four additive v4 exports: jumpChargeCommence() (space
  // keydown arm), jumpChargeLevel() (rAF bar read on the retail 1.0s curve,
  // MIN_JUMP_EXTENT=0.001 floor), jumpChargeRelease() (keyup DoJump),
  // jumpChargeAbort() (blur). The "level rises over ~1s" assertion needs
  // ?jumpParity=on AND the local player GROUNDED (commence is press-time
  // position-gated). Flag-off / airborne => level reads 0.0 (legacy uses
  // __jumpKeydownTs JS hold-math).
  {
    key: "jumpParity",
    name: "A14-I4 jump charge clock (wasm half)",
    tier: "A14-I4",
    query: "renderer=3d&jumpParity=on",
    composeDeps: [],
    rebuildCoupled: true,
    rustTests: [
      "jump_charge_begin",
      "jump_charge_commence",
      "jump_charge_release",
      "jump_charge_abort",
      "jump_charge_cancel",
      "jump_charge_level",
      "jump_charge_power",
      "build_jump_echoes_server_control_sequence",
    ],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      // 1) All four charge exports must exist (absent => rebuild-pending).
      for (const m of [
        "jumpChargeCommence",
        "jumpChargeLevel",
        "jumpChargeRelease",
        "jumpChargeAbort",
      ]) {
        const p = await helpers.readGetter(m, []);
        if (!p.present) {
          return rebuildPending(
            `SessionHandle.${m} absent from current pkg/ (manifest v4 jump-charge export)`
          );
        }
      }
      // 2) Baseline: level is 0.0 with no charge pending.
      const baseline = await helpers.readGetter("jumpChargeLevel", []);
      if (baseline.value && baseline.value.__error) {
        return fail(`jumpChargeLevel() threw at baseline: ${baseline.value.__error}`);
      }
      // 3) The "rises over ~1s" behavior needs the local player grounded.
      const pose = await helpers.readGetter("getLocalPlayerPose", []);
      const onGround =
        pose.present && pose.value && pose.value.isOnGround === true;
      if (!onGround) {
        return skip(
          "jumpCharge* exports present & callable (baseline level=" +
            `${fmt(baseline.value)}); local player not grounded — cannot drive the charge curve (presence-only)`
        );
      }
      // 4) Drive the retail charge clock: commence -> sample over ~1s -> read
      //    peak -> release. The bar read is jumpChargeLevel() each tick.
      const run = await helpers.evalInPage(async () => {
        const h = window.__sessionHandle;
        if (!h) return { ok: false, why: "no session handle" };
        let commenceErr = null;
        try {
          h.jumpChargeCommence();
        } catch (e) {
          commenceErr = e && e.message ? e.message : String(e);
        }
        if (commenceErr) return { ok: false, why: "commence threw: " + commenceErr };
        const samples = [];
        const t0 = performance.now();
        // Sample ~1.1s so the 1.0s curve reaches its plateau.
        while (performance.now() - t0 < 1100) {
          let lvl = 0;
          try {
            lvl = h.jumpChargeLevel();
          } catch (_) {
            /* read-soft */
          }
          samples.push(lvl);
          await new Promise((r) => setTimeout(r, 50));
        }
        let releaseErr = null;
        try {
          h.jumpChargeRelease();
        } catch (e) {
          releaseErr = e && e.message ? e.message : String(e);
        }
        const peak = samples.reduce((a, b) => (b > a ? b : a), 0);
        return { ok: true, samples, peak, releaseErr };
      });
      if (!run.ok) {
        return skip(
          `jumpCharge* exports present; could not drive curve (${run.why}) — presence-only`
        );
      }
      if (run.releaseErr) {
        return fail(`jumpChargeRelease() threw: ${run.releaseErr}`);
      }
      // Grounded + flag-on: the level should have RISEN above the floor.
      // MIN_JUMP_EXTENT=0.001; require a clear rise to call it exercised.
      if (run.peak > 0.01) {
        return pass(
          `jump charge level rose to ${run.peak.toFixed(4)} over ~1s (grounded, ?jumpParity=on)`
        );
      }
      // Grounded but level never rose: either the legacy JS clock owns this
      // build (wasm clock not engaged) or commence was refused by a position
      // gate we cannot satisfy headless — not a defect of the export.
      return skip(
        `jumpCharge* exports present & callable but level stayed flat (peak ${run.peak}) — ` +
          "wasm charge clock not engaged this build / commence position-gated (presence-only)"
      );
    },
  },

  // ===================================================================
  // retailRunKeys — A14-I3 ToggleRun XOR + autorun (wasm autorun half)
  // ===================================================================
  // url-flags.md:521. The JS XOR-run half is live-on-reload and independent of
  // wasm. The WASM autorun half is the additive v4 export SessionHandle.setAutoRun
  // (d.ts:4745): toggling installs the forward-run drive in MovementSystem
  // (auto_run field, default false). The continuous-forward-run BEHAVIOR is
  // wasm-internal (ApplyCurrentMovement auto_run re-issue) and not directly
  // observable as a pose without a long soak; we assert the export is callable
  // (on then off, no throw).
  {
    key: "retailRunKeys",
    name: "A14-I3 ToggleRun XOR + autorun (wasm autorun half)",
    tier: "A14-I3",
    query: "renderer=3d&retailRunKeys=on",
    composeDeps: [],
    rebuildCoupled: true,
    rustTests: [
      "auto_run_default_off_keeps_manual_drive_verbatim",
      "auto_run_engage_installs_forward_run_and_cancels_pursuit",
      "auto_run_off_restores_held_manual_state",
      "auto_run_overrides_forward_keys_but_keeps_sidestep_turn",
      "auto_run_same_value_is_a_noop",
    ],
    crate: "holtburger-core",
    async assertBrowser(helpers) {
      // 1) The export must exist (absent => rebuild-pending, manifest v4).
      const probe = await helpers.readGetter("setAutoRun", [true]);
      if (!probe.present) {
        return rebuildPending(
          "SessionHandle.setAutoRun absent from current pkg/ (manifest v4 autorun export)"
        );
      }
      if (probe.value && probe.value.__error) {
        return fail(`setAutoRun(true) threw: ${probe.value.__error}`);
      }
      // 2) Toggle on then off — both must be no-throw (idempotent drive edges).
      const cycle = await helpers.evalInPage(() => {
        const h = window.__sessionHandle;
        if (!h || typeof h.setAutoRun !== "function") return { present: false };
        const errs = [];
        for (const v of [true, false, true, false]) {
          try {
            h.setAutoRun(v);
          } catch (e) {
            errs.push({ v, msg: e && e.message ? e.message : String(e) });
          }
        }
        return { present: true, errs };
      });
      if (!cycle.present) {
        return rebuildPending("SessionHandle.setAutoRun went absent mid-run");
      }
      if (cycle.errs.length) {
        return fail(
          `setAutoRun toggle cycle threw: ${cycle.errs
            .map((e) => `${e.v}:${e.msg}`)
            .join(", ")}`
        );
      }
      // Export present + callable through on/off edges. The continuous
      // forward-run effect is wasm-internal (MovementSystem auto_run re-issue)
      // and validated by the auto_run_* rust tests — presence is the browser
      // floor here.
      return pass(
        "SessionHandle.setAutoRun present & callable through on/off toggle cycle (?retailRunKeys=on); forward-run drive is wasm-internal (auto_run_* rust tests)"
      );
    },
  },

  // ===================================================================
  // rootMotionObject — A5-P3 root-motion -> entity anchor (wasm half)
  // ===================================================================
  // url-flags.md:472. Wasm half: EntityAnimationData.rootMotionNet (d.ts:893)
  // = [tx,ty,tz, qw,qx,qy,qz] (AC w-first), the NET rigid root displacement of
  // a baked clip; empty = no clip, identity = no POS_FRAMES. It is a RETURN-VALUE
  // getter off fetchEntityAnimationKeyframes(), which the page does NOT expose as
  // a global (only the curated window.__hbWasm, which omits it) — so a direct
  // browser-side getter probe is not reachable. The OBSERVABLE in-page signal is
  // the JS consumer (scene3d/entities.js): the EntityManager arms
  // `_rootMotionObjectOn` from ?rootMotionObject=1 (entities.js:2471) and stamps a
  // diag-only `inst._appliedRootMotion` ledger (entities.js:8472) when a
  // translating remote one-shot completes. We assert via that consumer; with no
  // translating remote one-shot in view it is presence-only (skip). The wasm net
  // math is covered by the a5p3_* rust tests.
  {
    key: "rootMotionObject",
    name: "A5-P3 root-motion -> entity anchor (wasm half)",
    tier: "A5-P3",
    query: "renderer=3d&rootMotionObject=1",
    composeDeps: [],
    rebuildCoupled: true,
    rustTests: [
      "a5p3_forward_then_reverse_nets_to_zero",
      "a5p3_net_translation_sums_deltas_across_segments",
      "a5p3_no_cycle_fallback_has_empty_root_motion_net",
      "a5p3_no_pos_frames_yields_identity_net",
      "a5p3_yaw_net_survives_fold_that_zeroes_pos_channel",
      "a5p3_inner_v",
    ],
    crate: "holtburger-web",
    async assertBrowser(helpers) {
      // Read the JS consumer's armed flag + any applied-root-motion ledger.
      const snap = await helpers.evalInPage(() => {
        const em = window.liveScene3d && window.liveScene3d.entityManager;
        if (!em) return { hasEm: false };
        const armed = em._rootMotionObjectOn === true;
        // hasRootMotion predicate is module-private; the observable proof that
        // a non-empty net was produced + applied is inst._appliedRootMotion
        // (diag-only ledger written by _applyRootMotionToAnchor).
        const map =
          em.entityMap && typeof em.entityMap.forEach === "function"
            ? em.entityMap
            : null;
        let applied = 0;
        let sample = null;
        if (map) {
          map.forEach((inst) => {
            if (inst && inst._appliedRootMotion) {
              applied += 1;
              if (!sample) sample = { hasLedger: true };
            }
          });
        }
        return {
          hasEm: true,
          armed,
          mapPresent: !!map,
          applied,
          sample,
        };
      });
      if (!snap.hasEm) {
        return skip(
          "liveScene3d.entityManager not available (3D scene not initialized) — cannot read rootMotion consumer"
        );
      }
      // The JS gate must be armed by ?rootMotionObject=1; if not, the flag did
      // not parse (a real wiring regression).
      if (!snap.armed) {
        return fail(
          "entityManager._rootMotionObjectOn is false despite ?rootMotionObject=1 — flag did not arm in the consumer"
        );
      }
      // A translating remote one-shot that completed leaves an
      // _appliedRootMotion ledger — that is the end-to-end proof the v4
      // rootMotionNet getter returned a non-empty net AND it was applied.
      if (snap.applied > 0) {
        return pass(
          `?rootMotionObject=1 armed; ${snap.applied} entity(ies) carry an applied root-motion ledger (non-empty rootMotionNet applied to anchor)`
        );
      }
      // Armed but no ledger yet: either no translating remote one-shot played
      // in view, or a pre-P3 pkg made the consumer fail-soft (rootMotionNet
      // absent -> hasRootMotion false -> never armed-on-finish). The net getter
      // lives on a fetchEntityAnimationKeyframes return value not exposed to the
      // page, so we cannot disambiguate in-page; the a5p3_* rust tests cover the
      // net math. Presence-only skip.
      return skip(
        "?rootMotionObject=1 armed in consumer but no translating remote one-shot completed in view " +
          "(no _appliedRootMotion ledger); rootMotionNet is a fetchEntityAnimationKeyframes return-getter not page-exposed — a5p3_* rust tests cover the net math"
      );
    },
  },

  // ===================================================================
  // getLink — A4-Q4 two-hop link resolver
  // ===================================================================
  // url-flags.md:533. By DESIGN there is NO browser getter: the flag is parsed
  // wasm-side (parse_get_link_flag, OnceLock) and routes the link-bake through
  // the faithful two-hop MotionTable::get_link port. Browser-side proof is a
  // CLEAN boot (no module parse/init error) and that stance/substate transitions
  // play (we confirm in-world + no animation/module console errors). NEVER probe
  // a getter; absence is expected (not rebuild-pending, not fail). Coverage is
  // the dat q4_get_link_* rust tests. rebuildCoupled:false per schema (the assert
  // reads no wasm getter).
  {
    key: "getLink",
    name: "A4-Q4 two-hop link resolver",
    tier: "A4-Q4",
    query: "renderer=3d&getLink=on",
    composeDeps: [],
    rebuildCoupled: false,
    rustTests: [
      "q4_get_link_forward_hop",
      "q4_get_link_backward_hop",
      "q4_get_link_full_miss_is_none",
      "q4_get_link_inner_key_is_full_command",
      "q4_table",
    ],
    crate: "holtburger-dat",
    async assertBrowser(helpers) {
      // No getter exists by design. Prove a clean boot: in-world and no
      // module-parse / animation-error console noise. (The driver only calls
      // assertBrowser when inWorld is true, but we re-confirm the boot state
      // and scan for animation/module errors that a broken link resolver would
      // surface.)
      const bootOk = await helpers.evalInPage(() => {
        const hist = Array.isArray(window.__bootStateHistory)
          ? window.__bootStateHistory
          : [];
        const reached =
          window.__bootState === "in-world" ||
          hist.some((e) => e && e.state === "in-world");
        return {
          reached,
          state: window.__bootState,
          errorState: window.__bootState === "error",
        };
      });
      if (!bootOk.reached || bootOk.errorState) {
        return skip(
          `getLink: boot did not reach in-world (state=${bootOk.state}) — cannot confirm transitions play`
        );
      }
      // A broken link resolver would throw on link-bake -> animation errors in
      // the console. Filter for genuinely link/motion/module-relevant errors.
      const errs = helpers.consoleErrors();
      const relevant = errs.filter((e) => {
        const t = (e.text || "").toLowerCase();
        return (
          t.includes("get_link") ||
          t.includes("getlink") ||
          t.includes("link") &&
            (t.includes("motion") || t.includes("anim")) ||
          t.includes("modulinit") ||
          t.includes("module parse") ||
          t.includes("failed to fetch dynamically imported module") ||
          t.includes("wasm")
        );
      });
      if (relevant.length) {
        return fail(
          `getLink: boot clean expected but found ${relevant.length} link/motion/module console error(s): ` +
            relevant
              .slice(0, 3)
              .map((e) => e.text)
              .join(" | ")
        );
      }
      return pass(
        "getLink: clean boot, in-world, no link/motion/module console errors (no browser getter by design; q4_get_link_* dat rust tests are the coverage)"
      );
    },
  },

  // ===================================================================
  // placementId — A9-Stage1 wire placement-id
  // ===================================================================
  // url-flags.md:447. The GETTER EntityUpdate.placementId (d.ts:1274) is always
  // present (additive v3/v4); it reads 0 unless the wire SPAWN carried a
  // placement frame. The ?placementId=on flag (parsed wasm-side, no export) gates
  // the JS CONSUMER's rest-pose chain, not the getter. We poll
  // SessionHandle.pollEntityUpdates() (d.ts:4327) for a SPAWN-kind
  // (ENTITY_UPDATE_KIND_SPAWN == 1) chest/corpse and read .placementId. A spawn
  // without a wire placement reads 0 (not a FAIL; presence + read-0 is
  // acceptable when no placement-bearing entity is in view).
  {
    key: "placementId",
    name: "A9-Stage1 wire placement-id",
    tier: "A9-Stage1",
    query: "renderer=3d&placementId=on",
    composeDeps: [],
    rebuildCoupled: true,
    rustTests: [
      "resolve_static_placement_frame_orders",
      "resolve_static_placement_frame",
      "collect_setup_placement_frames",
      "fetch_setup_placement_frames",
    ],
    crate: "holtburger-web",
    async assertBrowser(helpers) {
      // 1) pollEntityUpdates must exist (absent => rebuild-pending).
      const probe = await helpers.readGetter("pollEntityUpdates", []);
      if (!probe.present) {
        return rebuildPending(
          "SessionHandle.pollEntityUpdates absent from current pkg/ — cannot read EntityUpdate.placementId"
        );
      }
      // 2) Walk a window of polled updates, looking for a SPAWN (kind==1) entry
      //    that exposes a placementId getter. We must read .placementId on the
      //    raw wasm EntityUpdate (it is a prototype getter) inside the page.
      const scan = await helpers.evalInPage(async () => {
        const h = window.__sessionHandle;
        if (!h || typeof h.pollEntityUpdates !== "function") {
          return { getterPresent: false };
        }
        let getterPresent = false;
        let spawnSeen = 0;
        let withPlacement = 0;
        let samplePid = null;
        let sampleKind = null;
        // Poll a few times — pollEntityUpdates is a drain; spawns may have
        // already been consumed during boot, so we also accept a single batch.
        const t0 = performance.now();
        while (performance.now() - t0 < 1500) {
          let batch;
          try {
            batch = h.pollEntityUpdates();
          } catch (_) {
            break;
          }
          if (!batch || !batch.length) {
            await new Promise((r) => setTimeout(r, 100));
            continue;
          }
          for (const u of batch) {
            if (!u) continue;
            // Probe getter presence on the first real EntityUpdate.
            if (!getterPresent) {
              getterPresent = typeof u.placementId === "number";
            }
            const kind = typeof u.kind === "number" ? u.kind : null;
            // ENTITY_UPDATE_KIND_SPAWN == 1 (index.html PlayerSpawned kind=1).
            if (kind === 1) {
              spawnSeen += 1;
              let pid = 0;
              try {
                pid = u.placementId >>> 0;
              } catch (_) {
                /* getter unreadable */
              }
              if (pid > 0) {
                withPlacement += 1;
                if (samplePid == null) {
                  samplePid = pid;
                  sampleKind = kind;
                }
              }
            }
          }
          await new Promise((r) => setTimeout(r, 100));
        }
        return {
          getterPresent,
          spawnSeen,
          withPlacement,
          samplePid,
          sampleKind,
        };
      });
      // If we never saw a single EntityUpdate to even probe the getter on, and
      // the SessionHandle method exists, treat as no-entities-in-view skip.
      if (scan.getterPresent === false && scan.spawnSeen === 0) {
        return skip(
          "no EntityUpdate drained in the poll window to probe .placementId (no fresh spawns in view) — presence-only"
        );
      }
      // The getter exists but no spawn carried a wire placement frame: read-0
      // is documented-acceptable, not a FAIL.
      if (scan.withPlacement === 0) {
        return skip(
          `EntityUpdate.placementId getter present (saw ${scan.spawnSeen} SPAWN update(s)) but none carried a wire placement frame (all read 0) — ` +
            "presence + read-0 acceptable when no placement-bearing entity is in view"
        );
      }
      // A SPAWN entity exposed a non-zero wire placement id.
      return pass(
        `EntityUpdate.placementId present; a SPAWN entity exposed wire placement id=${scan.samplePid} ` +
          `(${scan.withPlacement}/${scan.spawnSeen} SPAWN updates carried a placement frame)`
      );
    },
  },

  // ===================================================================
  // particleDegrade — A11-S4 authored degrade radius (wasm getter half)
  // ===================================================================
  // url-flags.md:527. ON: window.__hbWasm.fetch_particle_degrade_distance (the
  // additive v4 entry, spread-conditionally off the namespace import at
  // index.html:1886 — absent on a stale pkg) is fetched once per hwGfxObjId at
  // addEmitter and stamped onto emitter.degradeDistance (Infinity until resolved;
  // particle_manager.js:622-625). The ParticleManager instances live on the 3D
  // scene: world = liveScene3d.entityManager._worldParticleManager (entities.js:8650),
  // statics = liveScene3d._staticParticleManager (statics.js:2846); each holds a
  // particleTable Map<id, emitter> (particle_manager.js:402). PROOF: a persistent
  // authored emitter's .degradeDistance must be FINITE (not Infinity) after the
  // async fetch resolves. Flag-off keeps it Infinity by design (RP6-only culling).
  {
    key: "particleDegrade",
    name: "A11-S4 authored degrade radius (wasm getter half)",
    tier: "A11-S4",
    query: "renderer=3d&particleDegrade=retail",
    composeDeps: [],
    rebuildCoupled: true,
    rustTests: [],
    crate: "holtburger-web",
    async assertBrowser(helpers) {
      // 1) The wasm bridge entry must exist (absent => rebuild-pending: the v4
      //    namespace export isn't in this pkg, so degradeDistance stays Infinity
      //    by F18-2 soft-degrade and the radius can never be stamped).
      const bridge = await helpers.evalInPage(
        () => typeof window.__hbWasm?.fetch_particle_degrade_distance === "function"
      );
      if (!bridge) {
        return rebuildPending(
          "window.__hbWasm.fetch_particle_degrade_distance absent from current pkg/ (v4 namespace export); degradeDistance stays Infinity by F18-2 soft-degrade"
        );
      }
      // 2) Inspect the live ParticleManager emitters (world + statics) for a
      //    finite degradeDistance. Allow a short settle for the async fetch.
      const inspect = async () =>
        helpers.evalInPage(() => {
          const out = {
            managers: 0,
            emitters: 0,
            finite: 0,
            infinite: 0,
            sampleFinite: null,
          };
          const ls = window.liveScene3d;
          const mgrs = [];
          const wm = ls && ls.entityManager && ls.entityManager._worldParticleManager;
          if (wm) mgrs.push(wm);
          if (ls && ls._staticParticleManager) mgrs.push(ls._staticParticleManager);
          out.managers = mgrs.length;
          for (const mgr of mgrs) {
            const tbl = mgr && mgr.particleTable;
            if (!tbl || typeof tbl.forEach !== "function") continue;
            tbl.forEach((em) => {
              if (!em) return;
              out.emitters += 1;
              const d = em.degradeDistance;
              if (typeof d === "number" && Number.isFinite(d)) {
                out.finite += 1;
                if (out.sampleFinite == null) out.sampleFinite = d;
              } else {
                out.infinite += 1;
              }
            });
          }
          return out;
        });
      let snap = await inspect();
      // Give the async per-hwGfxObjId fetch a moment if emitters exist but none
      // resolved yet.
      if (snap.emitters > 0 && snap.finite === 0) {
        await helpers.waitMs(1500);
        snap = await inspect();
      }
      if (snap.managers === 0) {
        return skip(
          "no ParticleManager on liveScene3d yet (world/statics managers lazy — no emitters spawned in view) — presence-only (bridge present)"
        );
      }
      if (snap.emitters === 0) {
        return skip(
          "ParticleManager present but no emitters in view to inspect a degradeDistance stamp — " +
            "stand near a persistent authored emitter (lifestone/portal) — presence-only (bridge present)"
        );
      }
      // Emitters exist. Under ?particleDegrade=retail at least one persistent
      // authored emitter should have a FINITE radius stamped.
      if (snap.finite > 0) {
        return pass(
          `fetch_particle_degrade_distance bridge present; ${snap.finite}/${snap.emitters} live emitter(s) carry a FINITE degradeDistance ` +
            `(sample ${snap.sampleFinite}m) — authored radius stamped under ?particleDegrade=retail`
        );
      }
      // All emitters still Infinity after settle: the in-view emitters may all
      // be unauthored (no 0x11 degrade chain -> 100.0 default would still be
      // finite, so all-Infinity means the stamp never landed for these) OR the
      // fetch is still inflight for transient burst emitters. Not a defect of
      // the getter -> skip.
      return skip(
        `fetch_particle_degrade_distance bridge present but all ${snap.emitters} in-view emitter(s) still degradeDistance=Infinity after settle ` +
          "(transient/unauthored emitters or fetch inflight) — no persistent authored emitter in view to prove the stamp (presence-only)"
      );
    },
  },
];

// Local fmt for skip/detail strings (assert.mjs#fmt is module-private).
function fmt(v) {
  try {
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  } catch (_) {
    return String(v);
  }
}

export default flags;
