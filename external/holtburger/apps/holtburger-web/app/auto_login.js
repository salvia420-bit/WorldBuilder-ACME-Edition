// app/auto_login.js — the `?autoLogin=1` Connect+Spawn orchestrator
// (runAutonomousLogin + its in-flight claim), the window.__runAutonomousLogin
// entry point, and the deferred auto-trigger. Extracted verbatim from
// index.html's inline script (2026-10-05); index.html calls initAutoLogin() as
// its last statement, exactly where this code used to run. `activeHandle` is a
// live binding owned by index.html, read and written through the deps
// accessor (D.activeHandle).

import { netWorkerEnabled } from "../scene3d/net_worker_client.js";
import { lowBandwidth } from "../scene3d/bandwidth_tier.js";

export function initAutoLogin(D) {
  const { __resetEntDrainPending, loginForm, characterUl, setBootState, bootParams } = D;
  // ────────────────────────────────────────────────────────────
  // Autonomous Connect+Spawn orchestrator.
  //
  // Drives the form when `?autoLogin=1` is set: one clean warm
  // Connect (a single connect also clears a stale session — ACE
  // boots it "in favor of new connection"), then Spawn. The old
  // connect→kick→reconnect "dance" param was retired 2026-06-14 and
  // its dead URL key removed from every harness emitter in s13
  // (2026-07-11, 1120-appendix A1) — stale-session recovery is
  // opt-in via `?maxRetries=N`; harnesses avoid colliding with
  // ACE's session reap (60 s network timeout after an abrupt
  // close; live-measured s13) with an inter-arm quiet-gap instead.
  //
  // URL params honored:
  //   - `?autoLogin=1`         — run the orchestrator
  //   - `?autoSpawn=first`     — click Spawn on the first character
  //   - `?autoSpawn=Name`      — click Spawn on a named character
  //   - `?autoSpawn=0`         — skip Spawn (stop at char-list-ready)
  //   - `?autoSpawn=select`    — stop at char-list-ready on the retail
  //                              character screen (app/character_select.js)
  //   - `?maxRetries=N`        — opt-in stale-session retry (default 0)
  //
  // Defaults: autoSpawn=first, maxRetries=0.
  //
  // Re-entrancy: a run that is still IN FLIGHT owns the flow — a second
  // call while it is running is a no-op that returns immediately (see
  // `__autoLoginClaim` below). Once a run has settled (success, error or
  // throw) the orchestrator is re-armed, so an agent CAN retry via
  // `window.__runAutonomousLogin({...})`; it just cannot run two at once.
  // (Round-10 note: the previous comment here promised idempotency that
  // no code implemented. Two concurrent runs both call `fireSubmit()`,
  // which frees `window.__sessionHandle`, bumps `window.__connectEpoch`
  // and nulls `activeHandle` — so each run's `start_session` resolves
  // into the OTHER's superseded-epoch branch and gets freed, and neither
  // ever reaches char-list. `?autoLogin=1` schedules a run from
  // requestIdleCallback while the documented manual entry point is
  // exposed on window, which is exactly how the two collide.)
  // ────────────────────────────────────────────────────────────
  // The claim is a module-scope pair so it is unit-testable on its own
  // (the orchestrator itself closes over the whole login DOM).
  let __autoLoginInFlight = false;
  function __autoLoginClaim() {
    if (__autoLoginInFlight) return false;
    __autoLoginInFlight = true;
    return true;
  }
  function __autoLoginRelease() {
    __autoLoginInFlight = false;
  }
  window.__autoLoginInFlight = () => __autoLoginInFlight;
  async function runAutonomousLogin(opts = {}) {
    if (!__autoLoginClaim()) {
      console.warn(
        "[autoLogin] a run is already in flight — ignoring the re-entrant call " +
        "(two orchestrators fight over fireSubmit/__connectEpoch and neither connects)"
      );
      return;
    }
    try {
    const autoSpawn = opts.autoSpawn ?? "first";
    // Single clean attempt by default (2026-06-14). The retry-"dance"
    // was built to clear a STALE session, but it is destructive: every
    // reconnect opens a 2nd login session that ACE boots the 1st with
    // (account_login_boots_in_use=True), and on a slow cold-boot spawn
    // the dance races/boots its OWN freshly-in-world session before the
    // late EnteredWorld(kind=7) registers. A single WARM connect+spawn
    // (see the idle-deferred trigger below) was verified to reach real
    // in-world reliably, and a single connect ALSO handles a stale
    // session cleanly (ACE boots it "in favor of new connection" — no
    // 2nd session, so no self-race). Opt back into the dance with
    // `?maxRetries=N` only if you specifically need stale-session
    // recovery without an idle warm-up.
    const maxRetries = opts.maxRetries ?? 0;
    // Tuned for localhost+tailnet ACE. Empirical measurements
    // (2026-05-21, 3 consecutive cold boots with /clear-cache):
    //   - Successful Connect after a 3s kick-wait: 250-300ms
    //   - Connect retry after kickWaitMs: ~270ms (Phase B cache hit)
    //   - Spawn → in-world: ~90ms
    //   - Hung-Connect detection (ACE has orphan): connectTimeoutMs
    //
    // Total agentic-loop wall-clock = connectTimeoutMs + kickWaitMs
    //                                  + ~400ms (Connect#2 + Spawn).
    //
    // Reliability-first tuning (2026-05-21). Aggressive 1.5-2.5s
    // budgets broke the retry path: ACE's character-level logout
    // (NOT the session-level kick) takes 5-10s, and short
    // connectTimeoutMs leaves the retry chasing a half-killed
    // session that keeps emitting CharacterError::Logon (0x01) and
    // EnterGameCharacterInWorld (0x0D). Larger budgets give ACE
    // time to finish kicking the character before we Connect+Spawn
    // again.
    //
    // Cold-boot fix (2026-06-14). Root cause of the "ready but no
    // player" bug: autoLogin fires (via requestIdleCallback) WHILE
    // the wasm + scene3d cold-bake is still saturating the main
    // thread, so the wasm client's first login packet is delayed.
    // Measured on the 1070's +RTT link: the wsbridge "ws accepted"
    // → "routing/udp bound" gap (= time until the client's first
    // packet) was ~15s cold vs ~1s warm. With the old 5s budget,
    // attempt-0 ALWAYS timed out mid-handshake on a cold boot, which
    // tripped the retry-dance; the reconnect then opened a 2nd login
    // session that ACE booted the 1st with (account_login_boots_in_use),
    // killing the in-flight spawn's recv loop. A single clean
    // connect+spawn was verified to reach real in-world every time —
    // the dance was the whole failure. Give attempt-0 enough runway
    // to clear the cold-bake (25s ≫ the measured 15s) so it succeeds
    // on the first try and the destructive dance never fires.
    // `?bandwidth` low (2026-10-06): on a 666 kbps link the cold-boot
    // downloads share the line with the handshake — measured 27 s from
    // Connect to CharacterList on the 1070, i.e. a false "timeout" right
    // before the list arrived. 45 s keeps the single-clean-attempt shape.
    const connectTimeoutMs = opts.connectTimeoutMs ?? (lowBandwidth() ? 45000 : 25000);
    // 10s was fine warm, but a cold-boot spawn (PVS stream + scene
    // bake still competing for the main thread) can take >10s to reach
    // EnteredWorld(kind=7); 20s gives it room without a false timeout.
    const spawnTimeoutMs = opts.spawnTimeoutMs ?? 20000;
    const baseKickWaitMs = opts.kickWaitMs ?? 3000;
    // char-in-world (EnterGameCharacterInWorld, code 0x0D) means
    // ACE's character logout is still pending — we MUST wait
    // longer than baseKickWaitMs (which is sized for session-level
    // kick) before re-attempting. Empirical lower bound is ~5s.
    const charInWorldWaitMs = opts.charInWorldWaitMs ?? 7000;
    // Preemptive kick (opts.kickFirst=true — NOT URL-exposed): fire
    // a throwaway Connect immediately to trigger ACE's
    // session-already-in-use kick, wait `baseKickWaitMs` for it to
    // propagate, THEN run the normal attempt loop. Agents in a
    // /clear-cache + reload loop should set this to make boot
    // timing deterministic at ~6s instead of 2.5s/8.5s bimodal
    // (fresh vs kicked path divergence). localStorage-based
    // detection was tried + dropped — `/clear-cache` wipes
    // localStorage as a side effect, which is unavoidable in
    // agentic workflows that need to see code changes.
    const kickFirst = opts.kickFirst ?? false;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const fireSubmit = () => {
      // The submit handler bails when activeHandle is set; clear
      // it first so a fresh fire actually runs.
      // conn-fix (2026-07-18): FREE the wasm SessionHandle before
      // dropping the JS refs. Nulling alone leaves the wasm
      // recv_loop + WebSocket + bridge UDP flow alive forever
      // (wasm-bindgen destructors don't run on GC) — every retry
      // then stacks another zombie connection that retransmits at
      // 1 Hz into ACE ("Session for Id 0 has IP …" flood).
      // Drain the cross-frame entity queue BEFORE the handles go: those
      // are the outgoing session's EntityUpdate boxes, and the retry
      // dance is exactly the path that would otherwise replay them into
      // the incoming session (see __resetEntDrainPending). A kind=4 is
      // not guaranteed to precede a retry, so this cannot rely on the
      // disconnect arm alone.
      try { __resetEntDrainPending("reconnect"); } catch (_) {}
      try {
        const oldHandle = window.__sessionHandle;
        if (oldHandle && typeof oldHandle.free === "function") oldHandle.free();
        if (D.activeHandle && D.activeHandle !== oldHandle && typeof D.activeHandle.free === "function") D.activeHandle.free();
      } catch (_) {}
      // Supersede any still-pending start_session: its late-resolved
      // handle is freed instead of installed (epoch check in the
      // submit handler).
      window.__connectEpoch = (window.__connectEpoch ?? 0) + 1;
      D.activeHandle = null;
      window.__sessionHandle = null;
      window.__lastCharacterError = null;
      window.__lastDisconnect = null;
      if (typeof loginForm.requestSubmit === "function") {
        loginForm.requestSubmit();
      } else {
        loginForm.dispatchEvent(new Event("submit", { cancelable: true }));
      }
    };

    // Watch for the outcome of a Connect attempt. Returns:
    //   "char-list"       — start_session resolved, handle has list
    //   "kick"            — ACE sent CharacterError::Logon (0x01)
    //                       or disconnected us mid-handshake
    //   "error"           — submit handler set boot-state to error
    //   "timeout"         — neither signal arrived
    // 50ms polling cadence — tight enough that a successful Connect
    // (~500ms) registers in 1 poll, slow enough not to spin the CPU.
    //
    // `since` is the timestamp at which the current Connect attempt
    // fired; we only treat a CharacterError or Disconnect as a real
    // signal if it ARRIVED after that timestamp. Without this, a
    // stale event from the previous attempt (e.g. spawn-failed
    // CharacterError) sticks in `window.__lastCharacterError` and
    // causes Connect #N+1 to incorrectly classify itself as
    // "kick" within 50ms, blowing through all retries.
    const waitForConnectOutcome = async (timeoutMs, since) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (D.activeHandle?.characterList) return "char-list";
        const ce = window.__lastCharacterError;
        if (ce && ce.ts >= since) {
          if (ce.code === 0x01) return "kick"; // Logon
          return `character-error-${ce.code}`;
        }
        const dc = window.__lastDisconnect;
        if (dc && dc.ts >= since) {
          // Kick-dance race fix (2026-06-11): a disconnect arriving
          // just after THIS attempt fired is usually the PREVIOUS
          // attempt's socket being booted by ACE in OUR favor
          // ("booting currently connected account"), not a kick of
          // this attempt. Classifying it as "kick" immediately made
          // the dance reconnect on top of its own successful
          // connection — each retry booted its live predecessor,
          // forever (converged on low-RTT localhost, never on the
          // 1070's +180ms link). Give char-list a grace window
          // before conceding; only then treat it as a real kick.
          const graceDeadline = Math.min(deadline, Date.now() + 5000);
          while (Date.now() < graceDeadline) {
            if (D.activeHandle?.characterList) return "char-list";
            if (window.__bootState === "error") return "error";
            await sleep(50);
          }
          return "kick"; // ACE terminated
        }
        if (window.__bootState === "error") return "error";
        await sleep(50);
      }
      // Login-boot diagnosis 2026-06-11 (fix 6): success may land
      // exactly as the deadline expires (event-loop jank under the
      // boot fan-out). A late char-list is still a success — without
      // this check it returned "timeout" and the retry booted the
      // live session.
      if (D.activeHandle?.characterList) return "char-list";
      return "timeout";
    };

    // After Spawn click, watch for in-world (kind=7) OR a
    // CharacterError::EnterGameCharacterInWorld (0x0D) which
    // means the character is in-world on ACE's end and we need to
    // fully restart Connect + Spawn after the kick wait.
    //
    // 2026-05-28 — Bug 11 fix: check `__bootStateHistory` for any
    // "in-world" transition since the spawn click, not just the
    // current `__bootState`. The wire-agent boot path fires
    // `in-world` → `ready` within ~90ms, and the 50ms poll cadence
    // can land on "ready" instead of "in-world", missing the
    // equality check, falling through to the 10s timeout, and
    // re-triggering the kick-dance even though the session is live.
    // Reading the history is O(history-length) but the array stays
    // tiny (< 30 entries for a full agentic login).
    const waitForSpawnOutcome = async (timeoutMs, since) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (window.__bootState === "in-world") return "in-world";
        // Catch the brief in-world → ready transition where the
        // current bootState already advanced past "in-world".
        const history = window.__bootStateHistory;
        if (Array.isArray(history)) {
          for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];
            if (!entry || entry.ts < since) break;
            if (entry.state === "in-world") return "in-world";
          }
        }
        const ce = window.__lastCharacterError;
        if (ce && ce.ts >= since) {
          if (ce.code === 0x0D) return "char-in-world"; // retry
          if (ce.code === 0x10) return "char-in-world"; // EnterGameCharacterInWorldServer
          return `character-error-${ce.code}`;
        }
        const dc = window.__lastDisconnect;
        if (dc && dc.ts >= since) return "disconnect";
        if (window.__bootState === "error") return "error";
        await sleep(50);
      }
      // Late-success check: an in-world transition that landed at the
      // deadline edge must not be classified "timeout" (the retry
      // would kick the freshly-spawned session).
      //
      // 2026-06-14: do NOT treat bare "ready" as in-world here. In
      // wire-agent / wireframe mode `ready` is fired by scene3d the
      // moment terrain+buildings+statics+entities finish baking
      // (scene3d/index.js:~3999) — fully DECOUPLED from the player
      // entering the world, and it can even fire BEFORE spawn. The
      // old `|| "ready"` shortcut let a geometry-only scene (no
      // local player: getLocalPlayerPose() undefined, currentCell
      // 0x0) masquerade as a successful spawn. The REAL in-world
      // signal is setBootState("in-world", guid=…) at EnteredWorld
      // (kind=7). A genuine in-world that already advanced to "ready"
      // is still caught by the history scan immediately below
      // (setBootState records every transition, incl. "in-world").
      if (window.__bootState === "in-world") return "in-world";
      {
        const history = window.__bootStateHistory;
        if (Array.isArray(history)) {
          for (let i = history.length - 1; i >= 0; i--) {
            const entry = history[i];
            if (!entry || entry.ts < since) break;
            if (entry.state === "in-world") return "in-world";
          }
        }
      }
      return "timeout";
    };

    const pickSpawnButton = () => {
      const buttons = [...characterUl.querySelectorAll("button[data-id]")];
      for (const b of buttons) {
        if (!b.dataset.testId) b.dataset.testId = "character-spawn-btn";
      }
      if (buttons.length === 0) return null;
      if (autoSpawn === "first" || autoSpawn === "1" || autoSpawn === true) {
        return buttons[0];
      }
      const wantName = String(autoSpawn).toLowerCase();
      return buttons.find(
        (b) => (b.parentElement?.dataset?.name ?? "").toLowerCase() === wantName,
      );
    };

    try {
      // Preemptive kick was tried + rejected 2026-05-21: ACE's
      // session-termination is fast (<1s) but the character-level
      // logout takes 5-10s longer. A short preemptive kick (3s)
      // half-kills the session, leaving ACE in a state where
      // Spawn returns CharacterError::EnterGameCharacterInWorld
      // (0x0D) repeatedly until the character actually finishes
      // logging out. Pure timing-based recovery (no preemptive)
      // is faster + more reliable in practice (~8.5s vs failure).
      // `kickFirst` opt is preserved as a tuning knob but
      // intentionally not exposed via URL param.
      if (kickFirst) {
        setBootState("kicking", `preemptive (kickFirst=true; ${baseKickWaitMs}ms wait)`);
        fireSubmit();
        await sleep(baseKickWaitMs);
      }

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // Safety net (2026-06-14): never dance past a spawn that has
        // already reached in-world. A late EnteredWorld(kind=7) can
        // land AFTER an attempt's spawn-timeout (slow cold boot);
        // without this, the next reconnect opens a 2nd login session
        // that ACE boots our own freshly-in-world session with. Only
        // relevant for the opt-in retry-dance (?maxRetries=N) — the
        // default (maxRetries=0) never reconnects.
        if (
          attempt > 0 &&
          (window.__bootStateHistory || []).some((e) => e.state === "in-world")
        ) {
          return;
        }
        if (attempt > 0) {
          // Adaptive backoff: each retry adds 1.5× to the kick
          // wait. attempt 1: 3000ms, 2: 4500ms, 3: 6750ms.
          const adaptiveWaitMs = Math.round(baseKickWaitMs * Math.pow(1.5, attempt - 1));
          setBootState("kicking", `attempt ${attempt + 1}/${maxRetries + 1}: waiting ${adaptiveWaitMs}ms`);
          await sleep(adaptiveWaitMs);
          setBootState("reconnecting", `attempt ${attempt + 1}/${maxRetries + 1}`);
        }

        const attemptStartTs = Date.now();
        let connectOutcome;
        if (attempt > 0 && D.activeHandle?.characterList) {
          // Kick-dance race fix (2026-06-11): the char list landed
          // DURING the adaptive kick wait — the previous attempt
          // actually succeeded. Re-firing submit here would null
          // activeHandle, orphan the live session as a zombie, and
          // open a new connection that boots it. Use the live
          // session instead of reconnecting.
          setBootState(
            "char-list-ready",
            `attempt ${attempt}/${maxRetries + 1} succeeded during kick wait — skipping reconnect`,
          );
          connectOutcome = "char-list";
        } else {
          fireSubmit();
          connectOutcome = await waitForConnectOutcome(connectTimeoutMs, attemptStartTs);
        }

        if (connectOutcome === "kick") {
          // Wire-level signal: ACE kicked the account. Retry.
          continue;
        }
        if (connectOutcome === "error" || connectOutcome === "timeout") {
          if (attempt === maxRetries) {
            setBootState(
              "error",
              `connect failed after ${attempt + 1} attempts: ${connectOutcome}`,
            );
            return;
          }
          continue;
        }
        if (connectOutcome !== "char-list") {
          if (attempt === maxRetries) {
            setBootState("error", `connect: ${connectOutcome}`);
            return;
          }
          continue;
        }

        // Char list arrived. Stop here if autoSpawn is disabled — or
        // `select` (2026-10-09): the retail character screen
        // (app/character_select.js) takes over and the player chooses.
        if (autoSpawn === "0" || autoSpawn === "" || autoSpawn === false || autoSpawn === "select") {
          return;
        }

        const target = pickSpawnButton();
        if (!target) {
          const buttons = [...characterUl.querySelectorAll("button[data-id]")];
          setBootState(
            "error",
            `autoSpawn target "${autoSpawn}" not found (have: ${buttons.map((b) => b.parentElement?.dataset?.name).join(", ")})`,
          );
          return;
        }
        // Wait for WorldBootstrap before clicking spawn — otherwise
        // PlayerCreate fires before WorldState is constructable, and
        // wasm prints "MovementSystem disabled this session" with
        // WASD permanently broken for the rest of the run. The
        // prefetch was kicked off post-init; this `await` is usually
        // a microtask (already resolved) but on a cold tunnel can be
        // several seconds. Cap at the spawn timeout so a stuck
        // prefetch surfaces as a normal autoSpawn timeout rather
        // than hanging forever.
        if (window.__worldBootstrapReady) {
          const waitDeadline = Date.now() + Math.min(15000, spawnTimeoutMs);
          const ready = await Promise.race([
            window.__worldBootstrapReady,
            new Promise((r) => setTimeout(() => r("timeout"), waitDeadline - Date.now())),
          ]);
          if (ready === "timeout") {
            console.warn("[autoLogin] WorldBootstrap not loaded after 15s; spawning anyway (movement may be disabled)");
          }
        }
        target.click();
        const spawnAttemptTs = Date.now();

        const spawnOutcome = await waitForSpawnOutcome(spawnTimeoutMs, spawnAttemptTs);
        if (spawnOutcome === "in-world") {
          // Protocol-level success — ACE confirmed PlayerCreate.
          // But phase7 streaming + atmosphere LUT load are still
          // running. Wait for `ready` (sky-k.3 fires the
          // setBootState from scene3d/index.js) before declaring
          // the agent flow complete. Without this, agents take
          // screenshots / drive gameplay against a half-rendered
          // scene (no buildings, no clouds, raw clear color sky).
          const readyTimeoutMs = opts.readyTimeoutMs ?? 90000;
          const readyDeadline = Date.now() + readyTimeoutMs;
          while (Date.now() < readyDeadline) {
            // conn-fix (2026-07-18): also accept the sticky
            // __sceneReadyEverFired latch — under ?nullRender (and
            // fast boots generally) 'ready' fires BEFORE 'in-world'
            // and gets overwritten in __bootState, so polling the
            // scalar alone falsely latched 'error' on healthy
            // sessions 90s later (which then provoked relogin
            // loops that leaked connections).
            if (window.__bootState === "ready" || window.__sceneReadyEverFired) {
              return; // FULL SUCCESS
            }
            if (window.__bootState === "error") {
              return;
            }
            await sleep(100);
          }
          setBootState(
            "error",
            `in-world reached but scene-ready signal did not fire within ${readyTimeoutMs}ms`,
          );
          return;
        }
        if (spawnOutcome === "char-in-world") {
          // Char-level kick: this character is in-world on ACE.
          // ACE's character-logout is ~5-10s; wait longer than
          // baseKickWaitMs here before the next attempt fires so
          // we don't loop on the same 0x0D rejection. Drop handle
          // and full retry from Connect.
          setBootState(
            "kicking",
            `char-in-world (0x0D) — waiting ${charInWorldWaitMs}ms for character logout`,
          );
          await sleep(charInWorldWaitMs);
          continue;
        }
        if (attempt === maxRetries) {
          setBootState("error", `spawn: ${spawnOutcome}`);
          return;
        }
      }
      setBootState("error", `connect+spawn failed after ${maxRetries + 1} attempts`);
    } catch (e) {
      setBootState("error", `autonomous-login: ${String(e?.message ?? e)}`);
    }
    } finally {
      // Re-arm on EVERY exit path — the `return`s scattered through the
      // attempt loop (full success, autoSpawn=0, target-not-found, budget
      // exhausted) as well as the catch above. A claim that leaked would
      // silently disable every later retry, which is a worse failure than
      // the double-run this guard exists to stop.
      __autoLoginRelease();
    }
  }
  window.__runAutonomousLogin = runAutonomousLogin;

  // Auto-trigger when `?autoLogin=1`. Defer via requestIdleCallback
  // so the form-rendering + login-status DOM has a chance to settle.
  if (bootParams.get("autoLogin") === "1") {
    const opts = {
      autoSpawn: bootParams.get("autoSpawn") ?? "first",
      // Optional knobs for fine-tuning agent loops:
      //   ?connectTimeoutMs=N   ?spawnTimeoutMs=N   ?kickWaitMs=N
      //   ?maxRetries=N
      // kickFirst is NOT URL-exposed — see comment block in
      // runAutonomousLogin for why preemptive kick is harmful.
      connectTimeoutMs:
        parseInt(bootParams.get("connectTimeoutMs") ?? "", 10) || undefined,
      spawnTimeoutMs:
        parseInt(bootParams.get("spawnTimeoutMs") ?? "", 10) || undefined,
      kickWaitMs:
        parseInt(bootParams.get("kickWaitMs") ?? "", 10) || undefined,
      // `|| undefined` would coerce a legitimate 0 back to the
      // default (0 since 2026-06-14 — single clean attempt; the
      // retry-dance is opt-in via `?maxRetries=N`). Preserve explicit
      // 0; only fall back to the default on a non-numeric value.
      maxRetries: (() => {
        const n = parseInt(bootParams.get("maxRetries") ?? "", 10);
        return Number.isFinite(n) ? n : undefined;
      })(),
    };
    // Cold-boot fix (2026-06-14): fire the connect only once the main
    // thread is genuinely IDLE — i.e. after the terrain/buildings/
    // statics cold-bake + the page-init fetch storm (140 modulepreloads
    // + scenery + EnvCells) have settled. The old `{timeout: 800}`
    // force-fired the connect ~800ms in, deep inside that storm, so the
    // wasm client's first login packet was starved (~15s to route) and
    // the WS was prone to being dropped mid-handshake ("recv loop exited
    // before CharacterList"), which tripped the destructive retry-dance.
    // A WARM connect (what a human gets by clicking Connect after the
    // scene settles) routes in ~1s and just works. The long idle
    // timeout (20s) lets requestIdleCallback wait for a real idle slot
    // (post-bake) instead of force-firing mid-bake; it still fires by
    // 20s if the thread never fully quiesces. The non-idle fallback uses
    // a fixed warm-up delay rather than 0.
    // `?loginDefer=` revisit (2026-07-11 s13, 1120-appendix A9) — lands
    // DORMANT. The 20 s idle-defer exists only because the direct-path
    // login send is main-thread-starved during the cold-bake storm;
    // under `?netWorker=1` the socket + Session run in a worker, so
    // Connect can fire at a short idle. The knob is therefore honored
    // ONLY when netWorkerEnabled() — the bare default stays
    // byte-identical to before and the knob auto-activates if/when the
    // worker is promoted (A8/S15).
    //   short → 2000 ms idle timeout · idle20 → 20000 (explicit default)
    //   formshown → 0 (first idle slot) · <ms> → numeric timeout
    const loginDeferRaw = bootParams.get("loginDefer");
    const loginIdleTimeoutMs = (() => {
      if (!loginDeferRaw || !netWorkerEnabled()) return 20000;
      if (loginDeferRaw === "short") return 2000;
      if (loginDeferRaw === "idle20") return 20000;
      if (loginDeferRaw === "formshown") return 0;
      const n = parseInt(loginDeferRaw, 10);
      return Number.isFinite(n) && n >= 0 ? n : 20000;
    })();
    const launch = () => runAutonomousLogin(opts);
    if (typeof window.requestIdleCallback === "function") {
      window.requestIdleCallback(launch, { timeout: loginIdleTimeoutMs });
    } else {
      setTimeout(launch, 6000);
    }
  }
}
