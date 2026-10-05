// app/client_events.js — the ClientEvent dispatcher: one call per event drained
// from `handle.poll_events()`, routing `evt.kind` (named via the generated
// ClientEventKind table) to its handler: character list / create / spawn,
// chat, Disconnected (+ auto-reload), stats/inventory, doors, sounds, combat,
// cast + motion streams (incl. the kind-61 CMD_INTERP DriveApplied -> setMotion
// path and the remote swing-guess), portal space, vitals, and the plugin event
// bus fan-out. Each event runs inside the evtGuard try/catch/finally that
// isolates a throwing handler and frees the wasm box.
//
// Moved VERBATIM out of index.html's pumpNetFrame() loop body (2026-10-05).
// The only mechanical changes:
//   - bare `evt.kind === N` numbers are spelled `ClientEventKind.NAME`;
//   - the loop's `continue` is a plain `return`, and the kind-4 handler's
//     `return` out of pumpNetFrame is `return STOP_PUMP` (the caller returns);
//   - closure state is passed in `D` (index.html's __clientEventDeps): consts
//     and functions are destructured per call, while the `let` bindings index.html
//     still owns (spawningCharId, spawnedPlayerGuid, enteredWorld,
//     lastPredictionTime) are read and written through D's live accessors.

import { ClientEventKind } from "../scene3d/client_event_kinds.js";
import { getCombatManeuver } from "../ui/ac_combat_maneuver.js";
import { inferAttackTypeForWeapon, ATTACK_TYPE } from "../ui/ac_attack_type_for_weapon.js";
import { getAimLevelForVelocity } from "../ui/ac_aim_level_for_velocity.js";
import { isTerminalCastReject, shouldClearCastOnReject } from "../ui/cast_reject_policy.js";
import { acToThree } from "../scene3d/adapter.js";
import { escapeHtml, showDisconnectBanner } from "./dom_utils.js";

/** Returned by dispatchClientEvent when the inline loop used to `return` out of
 *  pumpNetFrame (kind 4 Disconnected): stop draining this batch. */
export const STOP_PUMP = Symbol("stopPump");

/**
 * latency (2026-10-05): flush the panel renders a drain batch coalesced
 * (see the kind 8 / kind 11 arms). Called by pumpNetFrame after the batch —
 * and before a STOP_PUMP return — so the UI still updates in the SAME frame
 * as the events, once. Order matches the unbatched path: render, then the
 * plugin-bus emit. Resets the flags. No-op without a batch object.
 */
export function flushPanelBatch(batch, D) {
  if (!batch) return;
  const { stats, inventory } = batch;
  batch.stats = false;
  batch.inventory = false;
  if (stats) {
    try { D.renderVitalsPanel(D.handle); } catch (e) { console.warn("[panelBatch] vitals:", e); }
    try { window.__pluginClient?.events?.emit?.("playerStatsUpdated", {}); } catch (e) { console.warn("[panelBatch] stats emit:", e); }
  }
  if (inventory) {
    try { D.renderInventoryPanel(D.handle); } catch (e) { console.warn("[panelBatch] inventory:", e); }
    try { window.__pluginClient?.events?.emit?.("playerInventoryChanged", {}); } catch (e) { console.warn("[panelBatch] inventory emit:", e); }
  }
}

export function dispatchClientEvent(evt, D) {
  const { populateSkyDescFromRegion, RANGED_STANCES, MAGIC_STANCES, setLocalPlayerGuid,
    getLocalPlayerGuid, __unifiedClientEventOn, __resetEntDrainPending,
    ensureCellContainersForLandblock, ensureBuildingAabbsAroundLandblock,
    ensureTerrainAroundLandblock, loginStatus, characterUl, createNameInput, createBtn,
    createStatus, postSpawn, teleportBtn, chatPanel, chatInput, chatSendBtn, appendChatLine,
    renderVitalsPanel, renderInventoryPanel, setBootState, handle, renderCharacterList,
    CAST_MOVE_ON, CMD_INTERP_ON, EVT_GUARD_ON } = D;
  try { window.__diag?.wire?.onEvent?.(evt); } catch (_) {}
  // rynth-integration (2026-07-16): default-off push-event tap.
  // The client already drains poll_events destructively here;
  // a bot brain (RynthWebHost) can't re-drain without stealing,
  // so forward each event to an optional hook it installs. No
  // behavior change when unset. (report 04's push plane.)
  try { window.__rynthOnEvent?.(evt); } catch (_) {}
  // evtGuard (2026-07-28, login-input bug): isolate each
  // ClientEvent handler. poll_events is a DESTRUCTIVE drain, so
  // one throwing handler used to abort the whole batch — every
  // event after it (including a same-batch kind=7 EnteredWorld,
  // or the tail of the kind=7 handler itself past the
  // `enteredWorld = true` line) was silently lost. Net effect
  // live: `__bootState` says "in-world" and the world streams
  // fine, but `enteredWorld` never flips → WASD/keybinds dead
  // for the whole session (the intermittent "keys don't work at
  // login" report; big tunnel-latency batches maximize the odds
  // that kind=7 shares a batch with a poison event). Default ON;
  // `?evtGuard=off` restores abort-the-batch. Catches are
  // counted in `window.__evtGuardStats` (reachability counter)
  // and surfaced via `__diag.bootInput()`.
  try {
  if (evt.kind === ClientEventKind.PLAYER_SPAWNED) {
    // PlayerSpawned — u32Payload = spawned player GUID.
    D.spawnedPlayerGuid = evt.u32Payload >>> 0;
    // Phase 4 step 6e: tell the nameplate layer who the
    // local player is so it skips drawing a name above
    // them (retail convention).
    setLocalPlayerGuid(D.spawnedPlayerGuid);
    D.spawningCharId = null;
    const guidHex = `0x${D.spawnedPlayerGuid.toString(16).toUpperCase().padStart(8, "0")}`;
    // Find the Li that triggered this spawn (matches by guid).
    const li = characterUl.querySelector(`li[data-id="${D.spawnedPlayerGuid}"]`);
    const name = li?.dataset?.name || "<unknown>";
    if (li) {
      const btn = li.querySelector("button[data-id]");
      if (btn) btn.textContent = "Spawned";
    }
    loginStatus.innerHTML =
      `<span class="ok">[OK]</span> Spawned <strong>${name}</strong> ` +
      `<span class="hint">(GUID ${guidHex})</span>. ` +
      `<span class="hint">Player + entities render via the live entity layer.</span>`;
  } else if (evt.kind === ClientEventKind.CHARACTER_LIST_RECEIVED) {
    // CharacterListReceived re-fire (after CharacterCreate /
    // CharacterDelete). The recv loop has already updated
    // `character_list` shared state — re-render so the UI
    // reflects the new roster.
    renderCharacterList();
  } else if (evt.kind === ClientEventKind.CHAT_RECEIVED) {
    // ChatReceived (Phase 4 step 4). The recv loop
    // pre-formats every chat-bearing variant into a single
    // display line and tags it with a CHAT_CATEGORY_* id
    // in `evt.u32Payload2` (see ClientEvent kind=2 doc
    // comment in src/lib.rs). JS appends + colour-codes
    // by category — no prefix-string heuristic.
    const text = evt.stringPayload || "";
    const category = evt.u32Payload2;
    // Incoming-tell stickiness for /reply. chat_type ==
    // ChatMessageType::Tell (0x03) only — exclude the
    // OutgoingTell (0x04) echo and AdminTell paths.
    // Sender is parsed from the wasm-formatted line
    // ("X tells you, \"Y\"") because the protocol-level
    // event carries it as sender_name but lib.rs folds
    // it into stringPayload before publishing. The
    // non-greedy `.+?` handles multi-word names.
    if ((evt.u32Payload >>> 0) === 0x03) {
      const m = text.match(/^(.+?) tells you, "/);
      if (m) window.__chatLastIncomingTellSender = m[1];
    }
    // P6.1 chat hook — retail AddTextToScroll parity
    // (IACPlugin::OnChatWindowText): fires AFTER wire-state
    // side effects (tell-sender parse above; the wire message
    // already fully applied upstream) and BEFORE display.
    // Eat = the line is never displayed anywhere; nothing
    // else changes. Local echoes elsewhere in this file
    // never traverse the hook (retail sendToAPI=false rule).
    const chatHookEv = window.__chatHooks?.incoming?.emit(
      "chatIncoming",
      {
        text,
        chatType: evt.u32Payload >>> 0,
        category: typeof category === "number" ? category : 0,
      },
    );
    if (!chatHookEv?.eaten) {
      appendChatLine(
        text,
        typeof category === "number" ? category : 0,
      );
    }
  } else if (evt.kind === ClientEventKind.ENTERED_WORLD) {
    // EnteredWorld — server has fully spawned the
    // player (PlayerDescription / StartGame fired). The
    // wasm bundle's chat / movement commands now take
    // effect server-side. Unhide the post-spawn block
    // and enable the Teleport button.
    const playerGuidU32 = evt.u32Payload >>> 0;
    const playerGuid = playerGuidU32.toString(16).toUpperCase().padStart(8, "0");
    // Safety-net: the eager-WorldState path on SelectCharacter
    // suppresses the kind=1 PlayerCreate event, leaving
    // spawnedPlayerGuid + setLocalPlayerGuid unset. Without
    // these, the 3D follow camera can't resolve the local
    // player's pose and falls back to a Holtburg-centre
    // constant. Idempotent: no-op when kind=1 already ran.
    if (D.spawnedPlayerGuid === null) {
      D.spawnedPlayerGuid = playerGuidU32;
      setLocalPlayerGuid(D.spawnedPlayerGuid);
    }
    postSpawn.hidden = false;
    teleportBtn.disabled = false;
    if (window.__bootState !== "in-world") {
      setBootState("in-world", `guid=0x${playerGuid}`);
    }
    // evtGuard (2026-07-28): open the keyboard-movement gate the
    // moment we KNOW we're in-world, instead of ~300 lines later
    // at the end of this handler. Pre-fix, any exception in the
    // bot-boot / spawn-kick / HUD blocks below (or in this
    // handler's tail) left `enteredWorld` false forever while
    // `__bootState` already said "in-world" — a fully playable-
    // looking session with permanently dead WASD. The legacy
    // assignments at the end of the handler stay (idempotent).
    if (EVT_GUARD_ON) {
      // Gate FIRST, DOM second — the gate flip must not be
      // hostage to any DOM write throwing.
      D.enteredWorld = true;
      D.lastPredictionTime = null;
      chatPanel.hidden = false;
      chatInput.disabled = false;
      chatSendBtn.disabled = false;
    }
    // rynth auto-boot (2026-07-17): ?bot=1 starts the grind bot
    // on the live session at first in-world — the client-side
    // wire the whole rynth stack was missing (previously only
    // Node/Playwright harnesses ever called createGrindBot).
    // Default OFF: it takes over the character. ?botAi=off
    // skips the AI-director key probe; otherwise a saved
    // OpenRouter key (window.rynthAI.setKey) activates the
    // director as usual. Idempotent (kind=7 refires on death
    // respawn) and try/caught: a broken bot module must never
    // take down the client.
    try {
      const botParams = new URLSearchParams(location.search);
      // conn-fix (2026-07-18): rebind on session takeover.
      // The old guard (`!window.__bot`) made auto-boot
      // one-shot: after a reconnect replaced
      // __sessionHandle, kind=7 refired but the bot stayed
      // strapped to the DEAD handle forever. Now: same
      // handle → idempotent no-op (death respawn); changed
      // handle → stop the old bot and boot a fresh one on
      // the live session.
      const botTargetHandle = window.__sessionHandle ?? handle;
      const botNeedsBoot =
        botParams.get("bot") === "1" &&
        !window.__botBooting &&
        (!window.__bot || window.__botHandle !== botTargetHandle);
      if (botNeedsBoot) {
        window.__botBooting = true;
        const prevBot = window.__bot;
        window.__bot = null;
        import(new URL("rynth/bot.js", location.href).href)
          .then(async (m) => {
            try { if (prevBot && typeof prevBot.stop === "function") prevBot.stop(); } catch (_) {}
            const cfg = botParams.get("botAi") === "off" ? { ai: false } : {};
            // operator ai-stop latch (task #11, 2026-07-19): a
            // reconnect reboot must NOT resurrect a director the
            // operator stopped via rynthAI.stop(). The latch (set in
            // rynth/ai/operator_stop.js, persisted in localStorage so
            // it survives reloads/reconnects/browser restarts) forces
            // cfg.ai=false here, on top of ?botAi=off. Absent latch =
            // default behavior unchanged. Its own try/catch: a broken
            // latch module must never block the boot.
            try {
              const os = await import(new URL("rynth/ai/operator_stop.js", location.href).href);
              if (os.applyOperatorStopToCfg(cfg)) {
                console.log("[bot] AI director suppressed: operator stop latch");
              }
            } catch (_) { /* latch unavailable = fall through to params */ }
            // nav sidecar (2026-07-18): default-on. Without
            // config.nav the bot has NO coordinate travel
            // (goto/goto_lb return "nav not configured") and a
            // soak strands in its spawn town — the sidecar is a
            // standing laptop service (:8767), and an unreachable
            // endpoint only fails individual goto calls, never
            // the boot. ?nav=off opts out; ?navEndpoint= overrides.
            if (botParams.get("nav") !== "off") {
              cfg.nav = { endpoint: botParams.get("navEndpoint") || "http://127.0.0.1:8767" };
            }
            // Stream-rig bot tuning survives reloads via URL:
            // ?botModel= (director LLM), ?botInterval= (check-in
            // minutes; caps scale with it). Provider pins can't
            // ride a URL — a reload falls back to OpenRouter
            // default routing for the chosen model.
            // ?botKernel=off — no grind loops (explorer/pure-travel).
            if (botParams.get("botKernel") === "off") cfg.kernel = false;
            // ?explorePressure=1 (task #15) — ambient idle-motion
            // ticks between AI-director check-ins (rynth/bot.js
            // ExplorePressureController); only fires with an
            // enabled director, so read outside the cfg.ai guard
            // like botKernel above (harmless without a director).
            // Exact-match opt-in; default OFF.
            if (botParams.get("explorePressure") === "1") cfg.explorePressure = true;
            // ?botCtlOwner= (P0 fix, rynth-review 13 #1 / P1
            // streamline #3, 2026-07-23): sender allowlist for
            // the in-game control channel (RynthControlChannel,
            // rynth/control_channel.js — refuses ALL commands
            // when its owner can't be resolved). Comma-split
            // into an array so a rig can name more than one
            // trusted account (e.g. the operator's own
            // character alongside the bot's login). Read
            // outside the cfg.ai guard, same as botKernel/
            // explorePressure above — the control channel is
            // independent of the AI director. Absent -> the
            // channel's own default applies (the logged-in
            // character; refuse-all if that's ever
            // unresolvable) — carrying this through a
            // reconnect just makes that default explicit and
            // future-proofs a multi-owner rig.
            const botCtlOwner = botParams.get("botCtlOwner");
            if (botCtlOwner) {
              cfg.control = {
                ...(cfg.control || {}),
                owner: botCtlOwner.split(",").map((s) => s.trim()).filter(Boolean),
              };
            }
            if (cfg.ai !== false) {
              // ?botPersona=explorer etc. — base-prompt persona
              // (rynth/ai/director.js); URL-carried so reconnect
              // reboots keep it.
              const bp = botParams.get("botPersona");
              if (bp) cfg.ai = { ...(cfg.ai || {}), persona: bp };
              const bm = botParams.get("botModel");
              const bi = parseFloat(botParams.get("botInterval"));
              // Model-family provider-routing table (P1 #6 /
              // rynth-review 09 C1, 2026-07-23): the original pin
              // was a single `bm.startsWith("z-ai/")` literal, so
              // it silently did nothing the moment the live rig
              // rotated onto a different model family (STREAM-
              // RIG-OPS.md model history: z-ai/glm-5.2 ->
              // microsoft/phi-4 -> minimax/minimax-m3, the CURRENT
              // live model) — unpinned OpenRouter default routing
              // + the full 120s timeout + no cost floor, exactly
              // the fallthrough this pin exists to prevent. Add a
              // prefix entry here whenever the rig adopts a new
              // family; z-ai/* keeps its EXACT soak-8-proven
              // values unchanged.
              const PROVIDER_PIN_TABLE = [
                // z-ai/* (soak-8, unchanged): 3 fp8 sale
                // endpoints, fastest first (streamlake
                // 1.08s/52tps), never falling through to
                // 4x-price fp4 quants.
                { prefix: "z-ai/", provider: { order: ["streamlake", "novita", "baidu"], allow_fallbacks: false } },
                // minimax/minimax-m3 (2026-07-23): no soak-8-
                // style provider ranking exists yet for this
                // family — same INTENT as the z-ai pin (fast/
                // cheap hosts first, `allow_fallbacks:false` so
                // a bad first choice fails loud instead of
                // silently routing to an expensive default), not
                // the same literal providers. novita already
                // hosts sale-priced endpoints for other Chinese-
                // model families per the z-ai pin above; minimax
                // (the model's first-party host) is the natural
                // 2nd. Re-tune once minimax gets its own soak.
                { prefix: "minimax/", provider: { order: ["novita", "minimax"], allow_fallbacks: false } },
              ];
              const providerPinFor = (model) => {
                const hit = PROVIDER_PIN_TABLE.find((e) => model.startsWith(e.prefix));
                return hit ? { provider: hit.provider } : {};
              };
              // 2026-07-20 latency fix: 4096-token budgets let GLM
              // ramble ~2,400 completion tokens ≈ 50-80s per
              // check-in at ~30-50tps — the director looked dead
              // between calls. 1280 matches the documented
              // discipline (soak-8 measured GLM at 400-800 tokens)
              // and the llm_client retries once at double budget on
              // a "length" cutoff.
              // 2026-07-23: heavy-reasoning models (minimax-m3) burn
              // the ENTIRE 1280 (and the 2560 retry) on hidden
              // reasoning and return an EMPTY completion every call
              // (finish_reason=length) — the director hit 5 such
              // errors and auto-disabled on the live rig. Give the
              // minimax family the room it needs; GLM/gpt-oss keep
              // the latency-tuned 1280.
              const bmMaxTokens = /minimax/i.test(bm) ? 8192 : 1280;
              if (bm) cfg.ai = {
                ...(cfg.ai || {}), model: bm, maxTokens: bmMaxTokens,
                reasoning: { effort: "low" }, timeoutMs: 120000,
                ...providerPinFor(bm),
              };
              if (Number.isFinite(bi) && bi > 0) {
                cfg.ai = {
                  ...(cfg.ai || {}),
                  intervalMinutes: bi, minIntervalMinutes: bi,
                  maxIntervalMinutes: bi * 2,
                  maxCallsPerHour: Math.min(70, Math.ceil(70 / bi)),
                };
              }
            }
            window.__bot = await m.createGrindBot(botTargetHandle, cfg);
            window.__botHandle = botTargetHandle;
            console.log(prevBot
              ? "[rynth] grind bot re-booted onto new session via ?bot=1 (takeover rebind)"
              : "[rynth] grind bot auto-booted via ?bot=1");
          })
          .catch((e) => console.warn("[rynth] ?bot=1 auto-boot failed:", e))
          .finally(() => { window.__botBooting = false; });
      }
    } catch (_) { /* flag parse failure = no bot, client unaffected */ }
    // ?streamHud=1 (2026-07-18) — stream-rig dressing: open the
    // inventory pane and shift the buffs HUD below the vitals
    // frame (its default top:40 sits inside vitals' 0..70 box).
    // Idempotent across kind=7 refires; never touches the panel
    // once a viewer (or the bot's own UI actions) navigated it.
    try {
      if (new URLSearchParams(location.search).get("streamHud") === "1") {
        if (!document.getElementById("stream-hud-style")) {
          const shs = document.createElement("style");
          shs.id = "stream-hud-style";
          shs.textContent = "#hb-buffs-hud { top: 84px !important; left: 8px !important; }";
          document.head.appendChild(shs);
        }
        if (window.__mainPanel && !window.__mainPanel.isOpen()) {
          window.__mainPanel.showView("inventory");
        }
      }
    } catch (_) { /* stream dressing must never break spawn */ }
    // Spawn-kick (2026-06-30): the ring populate
    // (ensure*AroundLandblock) is otherwise driven ONLY by the first
    // inbound kind=0 position update in handlePositionUpdate. That
    // was assumed to always arrive promptly after spawn, but a
    // player who spawns/respawns and stands still gets NO collision
    // or statics beyond the boot pack, and whether the spawn ring
    // loads at all is racy (it hinges on an early UpdatePosition
    // landing). EnteredWorld (kind=7) fires on login + death-
    // respawn, so kick the current landblock's ring here for a
    // deterministic spawn load. Idempotent: each ensure* is gated by
    // its own populated/in-flight Set, so this no-ops for an
    // already-populated LB and composes with the position-update
    // trigger (which still covers in-world movement + teleports).
    try {
      // Copy-then-free: `getLocalPlayerPose()` hands back a
      // wasm-bindgen LocalPlayerPose box. Same invariant the
      // cell-residency watchdog (~L4150) already honors.
      const spawnPose = handle.getLocalPlayerPose?.();
      let spawnCell = 0;
      try {
        spawnCell = (spawnPose?.landblockId ?? 0) >>> 0;
      } finally {
        spawnPose?.free?.();
      }
      // Indoor-spawn fix (2026-07-23, Town Network no-walk wedge):
      // the raw pose accessor can read cell 0 (or a stale
      // pre-teleport cell) right at EnteredWorld — precisely on a
      // login/respawn INTO a dungeon (HANDOFF-surveyor-round2
      // §OPEN "raw getLocalPlayerPose() cell stays 0x0"). The old
      // code then skipped the kick entirely, and a stationary solo
      // player gets no follow-up UpdatePosition to retrigger the
      // load: no EnvCells → no cell BSPs → movement pipeline
      // wedged on the pre-bake fallback. Fall back to the
      // cell-scene snapshot (`getCurrentCellId`, server-truth
      // carried cell) so the spawn landblock is always kicked.
      if (spawnCell === 0) {
        try {
          spawnCell = typeof handle.getCurrentCellId === "function"
            ? handle.getCurrentCellId() >>> 0 : 0;
        } catch (_) { /* keep 0 — the cell-watchdog retries */ }
      }
      const spawnLb = ((spawnCell >>> 16) << 16) >>> 0;
      if (spawnLb !== 0) {
        ensureTerrainAroundLandblock(spawnLb);
        ensureBuildingAabbsAroundLandblock(spawnLb);
        ensureCellContainersForLandblock(spawnLb);
        // Indoor spawn: also kick the 3D EnvCell mesh bake for the
        // dungeon we spawned inside (the position-update trigger
        // that normally owns this never fires for a stationary
        // spawn). Idempotent per-LB; optional-chained — the
        // cell-watchdog above covers a not-yet-built liveScene3d.
        if ((spawnCell & 0xffff) >= 0x100) {
          window.liveScene3d?.loadEnvCellsForLandblock?.(spawnLb);
        }
        console.log(
          `[spawn-kick] kicked ring populate for spawn landblock 0x${spawnLb.toString(16).padStart(8, "0")}`
        );
      }
    } catch (e) {
      console.warn("[spawn-kick] initial populate failed:", e);
    }
    // Workstream Sky-B (parametric skybox, 2026-05-11):
    // populate the SkyDesc shadow from Region 0x13000000
    // (Dereth — the only Region shipped in retail
    // client_portal.dat). One-shot per session; the wasm
    // populator is idempotent so a double-fire from a
    // PlayerCreate / EnteredWorld race is harmless. The
    // synchronous getSkyState reads gate on the shadow's
    // presence via `handle.hasSkyDesc()`.
    // URL param `?skytime=accel` drives the demo 5-min
    // synthetic day via `setSkyTimeOverride` per rAF tick
    // (the rAF loop handles the override drive separately).
    (async () => {
      try {
        const dayGroupCount =
          await populateSkyDescFromRegion(0x13000000);
        console.log(
          `[Sky-B] populateSkyDescFromRegion → ${dayGroupCount} DayGroups`,
        );
      } catch (e) {
        console.warn(
          "[Sky-B] populateSkyDescFromRegion failed (renderer will skip skybox):",
          e,
        );
      }
    })();
    // Terrain heightmap prefetch is now driven by the
    // first position update for the local player (see
    // `ensureTerrainAroundLandblock` in
    // `handlePositionUpdate`). That covers the initial
    // spawn, all teleports, and death-respawns uniformly
    // — the prior hardcoded Holtburg prefetch missed
    // every non-Holtburg destination + every
    // death-respawn, leaving the integrator's terrain
    // lookup with a cache miss and re-introducing
    // impact-damage death.
    // Phase 4 step 4: reveal the chat panel; wasm bundle's
    // sendChat is now safe to call.
    chatPanel.hidden = false;
    chatInput.disabled = false;
    chatSendBtn.disabled = false;
    // Phase 4 step 3: open the keyboard movement gate.
    D.enteredWorld = true;
    // Phase 4 step 3.5: arm the prediction clock. First
    // rAF tick after this captures the wall-time baseline;
    // the tick after that is the first one with a real dt.
    D.lastPredictionTime = null;
    loginStatus.innerHTML =
      `<span class="ok">[OK]</span> InWorld as GUID 0x${playerGuid}. ` +
      `<span class="hint">Click <em>Teleport to Holtburg</em> to bypass the Training Academy. ` +
      `Then use <kbd>W</kbd>/<kbd>A</kbd>/<kbd>S</kbd>/<kbd>D</kbd> to walk, ` +
      `<kbd>Q</kbd>/<kbd>E</kbd> to turn, <kbd>Shift</kbd> to run.</span>`;
  } else if (evt.kind === ClientEventKind.CHARACTER_CREATED) {
    // CharacterCreated — refresh the list (recv loop has
    // already mutated the shared character_list state via
    // the companion CharacterList re-fire) and flash the
    // status line.
    const newGuid = evt.u32Payload >>> 0;
    const newName = evt.stringPayload || "<unknown>";
    renderCharacterList();
    createStatus.innerHTML =
      // escapeHtml: server-supplied name into innerHTML. (Also
      // makes the "<unknown>" fallback visible instead of being
      // parsed away as an unknown element.) The plugin-bus
      // fan-out below keeps the RAW name.
      `<span class="ok">[OK]</span> Created <strong>${escapeHtml(newName)}</strong> ` +
      `<span class="hint">(GUID 0x${newGuid.toString(16).toUpperCase().padStart(8, "0")})</span>. ` +
      `Click Spawn on the new row to enter world.`;
    createBtn.disabled = false;
    createNameInput.value = "";
    // Wave D.2 — fan out to the plugin-client bus so the
    // character-creation wizard plugin (which is listening
    // via `client.events.on("characterCreated", ...)`) can
    // transition its Submitting→Success state.
    if (window.__pluginClient?.events?.emit) {
      window.__pluginClient.events.emit("characterCreated",
        { guid: newGuid, name: newName });
    }
  } else if (evt.kind === ClientEventKind.CHARACTER_CREATE_FAILED) {
    // CharacterCreateFailed — surface the response code
    // (NameInUse, NameNotAllowed, etc.) and re-enable the
    // form so the user can retry with a different name.
    const code = evt.u32Payload >>> 0;
    const label = evt.stringPayload || "<unknown>";
    createStatus.innerHTML =
      `<span class="fail">[FAIL]</span> CharacterCreate rejected: ` +
      // escapeHtml: server-supplied label into innerHTML. The
      // plugin-bus fan-out below keeps the RAW label.
      `<code>${escapeHtml(label)}</code> (code ${code}).`;
    createBtn.disabled = false;
    // Wave D.2 — bus fan-out (see kind=5 comment above).
    if (window.__pluginClient?.events?.emit) {
      window.__pluginClient.events.emit("characterCreateFailed",
        { code, reason: label });
    }
  } else if (evt.kind === ClientEventKind.DISCONNECTED) {
    // Disconnected — recv loop terminated. The UI stays
    // up but commands won't go anywhere.
    loginStatus.innerHTML =
      // escapeHtml: server-supplied reason into innerHTML. The
      // __lastDisconnect stash below keeps the RAW reason (the
      // autoLogin orchestrator matches on it).
      `<span class="fail">[FAIL]</span> Disconnected: <code>${escapeHtml(evt.stringPayload || "")}</code>` +
      ` <span class="hint">Reload the page to retry.</span>`;
    // Stash the disconnect reason so the autoLogin
    // orchestrator can see it (it watches for kind=20
    // CharacterError + kind=4 disconnect as the two
    // signals that the kick path is required).
    window.__lastDisconnect = {
      ts: Date.now(),
      reason: evt.stringPayload || "",
    };
    showDisconnectBanner(
      "DISCONNECTED — session dead, reload to reconnect" +
        (evt.stringPayload ? ` (${evt.stringPayload})` : ""),
    );
    // Entity reaping (2026-06-15): the dead session's entity
    // guids are all invalid now. Clear them so an in-page
    // reconnect (e.g. the autoLogin kick-dance, or any future
    // reconnect path) re-streams onto an EMPTY map instead of
    // stacking a 2nd set of ACE's freshly-guid'd generator items
    // — the academy "two leather hats" double-spawn. Use
    // clearWorldEntities() (NOT dispose(), which permanently
    // disables the manager) so the EM stays reusable.
    try {
      window.liveScene3d?.entityManager?.clearWorldEntities?.();
    } catch (_) { /* best-effort */ }
    // Same reset, for the one buffer clearWorldEntities can't
    // reach: the cross-frame drain queue still holds this dead
    // session's EntityUpdate handles (see __resetEntDrainPending).
    try { __resetEntDrainPending("disconnect"); } catch (_) {}
    // Bounded auto-reload (P1 #5a, rynth-review 15 C1 / 13 D2,
    // 2026-07-23): the runbook already treats a kind=4 drop as
    // "reload it" (STREAM-RIG-OPS.md "Reload/boot loop" — every
    // reload corpse-collides with ACE's ~60s reap window once,
    // "expect __bootState==='error' once, reload again, then
    // in-world — two reloads is normal, not a failure"); this
    // promotes that lore into code. Gated to the unattended
    // stream/fleet contexts ONLY (?bot=1 or ?agent=1 in the URL)
    // — a human dev tab carrying neither flag is NEVER yanked
    // out from under them; they just see the red banner above
    // and reload by hand. ~10s grace before reloading (matches
    // the reap window so we don't hammer a still-reaping
    // account). Retry budget lives in sessionStorage — it
    // survives the reload itself (same tab, same session) so a
    // wedged account or a bad URL can't reload-loop forever:
    // max 5 reloads per rolling 10-minute window, then stop and
    // leave the banner up for a human (never an infinite loop).
    try {
      const rp = new URLSearchParams(location.search);
      if (rp.get("bot") === "1" || rp.get("agent") === "1") {
        const AUTO_RELOAD_KEY = "hbAutoReloadBudget";
        const AUTO_RELOAD_MAX = 5;
        const AUTO_RELOAD_WINDOW_MS = 10 * 60 * 1000; // 10 min
        const AUTO_RELOAD_GRACE_MS = 10 * 1000; // ACE reap window
        const now = Date.now();
        let budget = null;
        try { budget = JSON.parse(sessionStorage.getItem(AUTO_RELOAD_KEY) || "null"); } catch (_) { budget = null; }
        if (!budget || typeof budget.windowStart !== "number" || now - budget.windowStart > AUTO_RELOAD_WINDOW_MS) {
          budget = { windowStart: now, count: 0 };
        }
        if (budget.count < AUTO_RELOAD_MAX) {
          budget.count += 1;
          try { sessionStorage.setItem(AUTO_RELOAD_KEY, JSON.stringify(budget)); } catch (_) { /* quota/unavailable — reload still fires */ }
          console.warn(
            `[auto-reload] kind=4 disconnect in bot/agent context — reloading in ` +
            `${AUTO_RELOAD_GRACE_MS / 1000}s (attempt ${budget.count}/${AUTO_RELOAD_MAX} this 10-min window)`
          );
          setTimeout(() => location.reload(), AUTO_RELOAD_GRACE_MS);
        } else {
          console.warn(
            `[auto-reload] kind=4 disconnect — retry budget exhausted ` +
            `(${AUTO_RELOAD_MAX} reloads in 10 min); leaving the DISCONNECTED banner up for a human`
          );
        }
      }
    } catch (_) { /* auto-reload must never throw out of the event loop */ }
    return STOP_PUMP; // Stop polling — pumpNetFrame returns on STOP_PUMP.
  } else if (evt.kind === ClientEventKind.CHARACTER_ERROR) {
    // CharacterError — ACE wire-level signal. See
    // CLIENT_EVENT_KIND_CHARACTER_ERROR in src/lib.rs.
    // The two cases that matter for autoLogin:
    //   Logon (0x01) → account in use elsewhere, kick
    //     dance required (ACE terminates the new session
    //     mid-handshake; old session also gets kicked)
    //   EnterGameCharacterInWorld (0x0D) → character is
    //     in-world, char-level kick dance required (drop
    //     handle, full Connect+Spawn retry)
    const code = evt.u32Payload >>> 0;
    const name = evt.stringPayload || `Unknown(${code})`;
    window.__lastCharacterError = {
      ts: Date.now(),
      code,
      name,
    };
    console.warn(`[character-error] ${name} (0x${code.toString(16)})`);
    if (loginStatus) {
      loginStatus.innerHTML =
        // escapeHtml: server-supplied label into innerHTML. The
        // __lastCharacterError stash above keeps the RAW name.
        `<span class="fail">[ACE]</span> CharacterError: <code>${escapeHtml(name)}</code> (0x${code.toString(16)})`;
    }
  } else if (evt.kind === ClientEventKind.PLAYER_STATS_UPDATED) {
    // Phase 4 step 4 follow-on: PlayerStatsUpdated.
    // The recv loop coalesces all stat-bearing wire
    // messages (PrivateUpdate{Vital,Attribute,Skill}
    // /Public counterparts / GameEvent::UpdateHealth /
    // PlayerDescription) into one signal per recv
    // iteration. Refreshing on every event is cheap
    // because playerStats() is a clone of pre-built
    // typed arrays.
    // latency (2026-10-05): inside a frame-pump drain the render + bus
    // emit coalesce to ONE per batch (flushPanelBatch, same frame, after
    // the batch) — a tunnel-latency batch carries one kind=8 per packet,
    // and each used to rebuild the vitals panel + fan out to every plugin.
    if (D.panelBatch) {
      D.panelBatch.stats = true;
    } else {
      renderVitalsPanel(handle);
      // Phase G — also relay through the facade so plugins
      // (spellbook) can refresh from playerKnownSpells()
      // without polling. The wasm side piggybacks the
      // known-spells snapshot on this same hook.
      if (window.__pluginClient) {
        window.__pluginClient.events.emit("playerStatsUpdated", {});
      }
    }
  } else if (evt.kind === ClientEventKind.INVENTORY_UPDATED) {
    // Phase 4 step 4 follow-on: InventoryUpdated.
    // ObjectCreate / ObjectDelete / WieldObject /
    // ViewContents / IdentifyObjectResponse all funnel
    // here. The wasm-side filter excludes entities not
    // owned by the player.
    // latency (2026-10-05): coalesced per drain batch like kind=8 above
    // (a full inventory DOM rebuild + MutationObserver paperdoll rebuild
    // per packet was the burst-frame cost).
    if (D.panelBatch) {
      D.panelBatch.inventory = true;
    } else {
      renderInventoryPanel(handle);
      // PR-EE 2026-05-22: also relay through the plugin bus
      // so vendor-ui / inventory-panel / examine-popover and
      // future plugins can react without polling. Payload is
      // intentionally empty — subscribers re-pull state via
      // `client.player.inventory` (live snapshot from wasm).
      if (window.__pluginClient && window.__pluginClient.events) {
        window.__pluginClient.events.emit("playerInventoryChanged", {});
      }
    }
  } else if (evt.kind === ClientEventKind.VENDOR_OPENED) {
    // Phase 4 step 5: VendorOpened. The wasm side cached the
    // full vendor state (items + multipliers + alt currency)
    // BEFORE pushing this event, so plugins can fetch via
    // `handle.getVendorState(vendorGuid)`.
    //
    // 2026-05-19: emit `vendorOpened` on the plugin bus so
    // plugins/vendor-ui.js (the Vendor Window) can render.
    // The event payload mirrors the wasm ClientEvent fields
    // 1:1; consumers re-fetch full state via wasm.
    const vendorName = evt.stringPayload || "Vendor";
    const vendorGuidU32 = evt.u32Payload >>> 0;
    const vendorGuidHex = vendorGuidU32.toString(16).toUpperCase().padStart(8, "0");
    const itemCount = evt.u32Payload2 >>> 0;
    // eslint-disable-next-line no-console
    console.log(`[step 5] VendorOpened ${vendorName} guid=0x${vendorGuidHex} items=${itemCount}`);
    if (window.__pluginClient && window.__pluginClient.events) {
      window.__pluginClient.events.emit("vendorOpened", {
        stringPayload: vendorName,
        u32Payload: vendorGuidU32,
        u32Payload2: itemCount,
      });
    }
  } else if (evt.kind === ClientEventKind.CONTAINER_OPENED) {
    // PR-HH 2026-05-23: ContainerOpened. ACE sent a
    // `GameEvent::ViewContents` (opcode 0x0196) for a
    // non-vendor container — chest, corpse, salvage bag,
    // etc. The wasm side cached the item-GUID list
    // BEFORE pushing this event; plugins read it via
    // `handle.getContainerContents(containerGuid)`.
    // (Per-item DATA — name, value, icon — lives in the
    // existing entity store; look each GUID up there.)
    const containerName = evt.stringPayload || "Container";
    const containerGuidU32 = evt.u32Payload >>> 0;
    const containerGuidHex = containerGuidU32.toString(16).toUpperCase().padStart(8, "0");
    const containerItemCount = evt.u32Payload2 >>> 0;
    // eslint-disable-next-line no-console
    console.log(`[PR-HH] ContainerOpened ${containerName} guid=0x${containerGuidHex} items=${containerItemCount}`);
    if (window.__pluginClient && window.__pluginClient.events) {
      window.__pluginClient.events.emit("containerOpened", {
        stringPayload: containerName,
        u32Payload: containerGuidU32,
        u32Payload2: containerItemCount,
      });
    }
  } else if (evt.kind === ClientEventKind.FELLOWSHIP_UPDATED) {
    // Wave D (2026-05-25): FellowshipUpdated. ACE sent one
    // of the 5 fellowship GameEvents and the wasm side has
    // refreshed `latest_fellowship` from `world.fellowship`.
    // Consumer reads fresh state via
    // `handle.playerFellowship()` (null pre-join /
    // post-disband). Mirrors the enchantment pattern —
    // payload-less signal, snapshot getter for the data.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("fellowshipUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.TRADE_UPDATED) {
    // AC Trade (2026-05-25, Discord deficiency #3):
    // TradeUpdated. ACE sent one of the 9 trade GameEvents
    // and the wasm side has refreshed `latest_trade` from
    // `world.trade`. Consumer reads fresh state via
    // `handle.playerTrade()` (null pre-open / post-close).
    // The trade-panel plugin subscribes and renders its
    // floating window from the snapshot.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("tradeUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.BOOK_UPDATED) {
    // AC Books (2026-05-25): BookUpdated. ACE pushed one of
    // BookDataResponse / BookModifyPageResponse /
    // BookAddPageResponse / BookDeletePageResponse.
    // Consumer reads via `handle.playerBook()` (null pre-
    // open). The book-panel plugin subscribes and renders.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("bookUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.ALLEGIANCE_UPDATED) {
    // Wave-F2 (2026-05-26): AllegianceUpdated. ACE pushed
    // `GameEvent::AllegianceUpdate` (opcode 0x0020) and the
    // wasm side has refreshed `latest_allegiance` by folding
    // the wire payload (monarch / patron / self / vassals).
    // Consumer reads fresh state via
    // `handle.playerAllegiance()` (null pre-join /
    // post-break). The allegiance-panel plugin subscribes
    // and renders the hierarchy.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("allegianceUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.FRIENDS_UPDATED) {
    // Wave-H1 (2026-05-26): FriendsUpdated. ACE pushed
    // `GameEvent::FriendsListUpdate` (opcode 0x0021) and
    // the wasm side has folded the payload per
    // FriendsUpdateTypeFlags (FullList replaces; the
    // FriendAdded / FriendRemoved / FriendStatusChanged
    // deltas mutate the existing list). Consumer reads
    // fresh state via `handle.playerFriends()` (null
    // pre-FullList). The social-panel plugin subscribes
    // and renders the Friends section.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("friendsUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.SQUELCH_UPDATED) {
    // Wave-H3 (2026-05-26): SquelchUpdated. ACE pushed
    // `GameEvent::SetSquelchDb` (opcode 0x01F4) and the
    // wasm side has folded the wire payload (characters
    // + globals) into `latest_squelch`. Consumer reads
    // via `handle.playerSquelch()` (null pre-event).
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("squelchUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.TITLE_UPDATED) {
    // Wave-H3 (2026-05-26): TitleUpdated. ACE pushed
    // either `GameEvent::CharacterTitle` (opcode 0x0029,
    // full replace) or `GameEvent::UpdateTitle`
    // (opcode 0x002B, single-title delta). Consumer
    // reads via `handle.playerTitle()` (null
    // pre-CharacterTitle).
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("titleUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.DEATH) {
    // Q1a (2026-05-26): Death. ACE pushed
    // `GameMessage::PlayerKilled` — canonical death
    // broadcast with victim + killer GUIDs and the
    // pre-formatted message. Closes Chorizite EventArgs
    // row 15 (Character.OnDeath). The combat-hud plugin
    // subscribes for the "You died." self-death overlay.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("death", {
        victimGuid: (evt.u32Payload >>> 0) || 0,
        killerGuid: (evt.u32Payload2 >>> 0) || 0,
        message: evt.stringPayload || "",
      });
    }
    // ACPlugin PR-4 (2026-05-27): forward into the typed
    // Character.applyCombatHandlePlayerDeath — the filter
    // (victimId == self) is INSIDE Character so this is
    // a safe broadcast-side hook.
    try {
      window.__pluginClient?.world?.dispatchCombatHandlePlayerDeath?.(
        evt.stringPayload || "",
        (evt.u32Payload >>> 0) || 0,
        (evt.u32Payload2 >>> 0) || 0,
      );
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.PLAY_EFFECT /* PlayEffect */) {
    // CMT Wave 11 / Phase 34 (2026-05-26): bridge ACE's
    // `GameMessage::PlayEffect` (opcode `0xF755` =
    // GameMessageScript) into the plugin event bus so
    // the placeholder VFX module
    // (`scene3d/play_effect_vfx.js`) can spawn particle
    // bursts at the target entity's position. Wave 10
    // Phase 31 set up the WorldEvent emission; this is
    // the JS-side surface bridge.
    //
    // `u32Payload` = target entity GUID,
    // `u32Payload2` = PlayScript ID (see
    // `ui/ac_play_script.js` for the enum mirror),
    // `f32Payload` = visual-script playback speed
    // (typically 1.0; retained for future PhysicsScript
    // integration that respects playback rate).
    const targetGuid = (evt.u32Payload ?? 0) >>> 0;
    const scriptId = (evt.u32Payload2 ?? 0) >>> 0;
    const speed = evt.f32Payload ?? 0;
    try {
      window.__pluginClient?.events?.emit?.("playEffect", {
        targetGuid,
        scriptId,
        speed,
      });
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.CONTAINER_CLOSED /* ContainerClosed */) {
    // ACPlugin PR-2 (2026-05-27): non-vendor container
    // explicitly closed by the player. Symmetric to
    // kind=21 ContainerOpened. The new WorldState
    // dispatcher (plugins/world-state.js,
    // bindWorldStateToClient) subscribes via
    // `client.events.on('containerClosed', ...)` and
    // routes into `dispatchContainerClosed`. Existing
    // chest/corpse plugins that watch only the open path
    // continue to work — this is purely additive.
    const containerName = evt.stringPayload || "Container";
    const containerGuidU32 = (evt.u32Payload ?? 0) >>> 0;
    try {
      window.__pluginClient?.events?.emit?.("containerClosed", {
        stringPayload: containerName,
        u32Payload: containerGuidU32,
      });
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.PORTAL_SPACE_ENTERED /* PortalSpaceEntered */) {
    // ACPlugin PR-4 (2026-05-27): Character.OnPortalSpaceEntered
    // mirror. Bridges PlayerTeleport into the typed Character's
    // `applyEffectsPlayerTeleport` via WorldState's dispatcher,
    // and fires the bus event so any plugin can subscribe (the
    // loading-screen curtain that used to listen here is retired —
    // portal space is the retail tunnel below).
    try {
      window.__pluginClient?.world?.dispatchEffectsPlayerTeleport?.();
      window.__pluginClient?.events?.emit?.('portalSpaceEntered', {
        teleportSeq: (evt.u32Payload ?? 0) >>> 0,
      });
    } catch (_) {}
    // A4-Q3 (2026-06-12, ?mtQueue=on): exit-world overlay
    // cancellation — stop the LOCAL player's one-shot
    // overlays on portal transit, so an emote/swing/cast
    // never carries through a teleport (retail
    // MotionTableManager::HandleExitWorld success=0 drain +
    // enter-world link removal, acclient.c:329940-329957).
    // The Rust pending-queue drain rides the SAME
    // PlayerTeleport message inside the wasm recv arm
    // (handle_exit_world_for) — this is only the renderer
    // half. No-op when ?mtQueue is off (gate lives inside
    // _cancelOneShotOverlays).
    try {
      const lpg = window.getLocalPlayerGuid?.();
      if (lpg !== null && lpg !== undefined) {
        window.liveScene3d?.entityManager
          ?.cancelOneShotOverlaysForGuid?.(lpg >>> 0);
      }
    } catch (_) {}
    // Portal space (2026-10-05 rework) — the retail gmSmartBoxUI tunnel
    // (acclient.c:262328-262580; OpenAC PortalTunnelPresentation): world
    // hidden, tunnel Setup (DID-by-enum 0x10000001/7) animated at 40 fps on
    // black with random camera roll, held until the kind=66 TeleportArrived
    // edge + destination cells resident, then continue (>=2 s) -> tunnel
    // fade-out -> world fade-in. Plays on every teleport incl. indoor<->indoor
    // and same-landblock hops. DEFAULT-ON; `?portalSpace=off` disables (a
    // legacy numeric `?portalSpace=<scale>` just means on).
    try {
      const sp = new URLSearchParams(window.location.search);
      const ps = sp.get('portalSpace');
      const enabled = ps !== 'off' && ps !== '0' && ps !== 'false';
      if (enabled && window.liveScene3d) {
        // Parse a hex Wave DID (or off/none → 0). undefined = module default.
        const hexDid = (v) => {
          if (v === null) return undefined;
          if (v === 'off' || v === 'none' || v === '0') return 0;
          const n = parseInt(v.replace(/^0x/i, ''), 16);
          return Number.isFinite(n) ? (n >>> 0) : undefined;
        };
        // ?portalSound=<hex|off> overrides the enter whoosh (default
        // 0x0A000246 UI_EnterPortal); ?portalSoundLoop=<hex> adds an
        // optional looping bed (e.g. 0x0A000316).
        const enterDid = hexDid(sp.get('portalSound'));
        const loopDid = hexDid(sp.get('portalSoundLoop'));
        import('../scene3d/portal_space.js')
          .then((m) => m.startPortalSpace(window.liveScene3d, {
            enterDid,
            loopDid,
            // Character.OnPortalSpaceExited mirror (api.js coverage row 14).
            onExit: () => {
              try { window.__pluginClient?.events?.emit?.('portalSpaceExited', {}); } catch (_) {}
            },
          }))
          .catch((e) => console.warn('[portalSpace] start failed:', e));
      }
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.TELEPORT_ARRIVED /* TeleportArrived */) {
    // kind=66 — the destination self UpdatePosition of the pending teleport
    // was applied (retail waiting_for_teleport cleared). Portal space adds the
    // cells-resident half and leaves the tunnel. u32Payload = dest objcell.
    const cellId = (evt.u32Payload ?? 0) >>> 0;
    import('../scene3d/portal_space.js')
      .then((m) => m.signalPortalArrived({ cellId }))
      .catch(() => {});
  } else if (evt.kind === ClientEventKind.CONTRACTS_UPDATED /* ContractsUpdated */) {
    // Wave F.5 (2026-05-27): ACE pushed either
    // `GameEvent::SendClientContractTrackerTable` (opcode
    // 0x0314 — full snapshot at login) or
    // `GameEvent::SendClientContractTracker` (opcode 0x0315
    // — per-contract delta on Add / Erase / Update from
    // `ContractManager`). The wasm-side recv arm has
    // already folded the payload into `latest_contracts`.
    // Consumer reads via `handle.playerContracts()` (null
    // pre-event). The contracts-panel plugin subscribes
    // and re-renders the list.
    //
    // u32Payload carries the affected contract_id (single-
    // tracker path only; null on table-replace);
    // u32Payload2 = 1 when the delta was a delete (Abandon
    // / Erase), else 0. Plugins can use these for toast
    // notifications without diffing snapshots.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("contractsUpdated", {
        contractId: (evt.u32Payload ?? 0) >>> 0,
        deleted: ((evt.u32Payload2 ?? 0) >>> 0) === 1,
      });
    }
  } else if (evt.kind === ClientEventKind.ALLEGIANCE_PRESENCE /* AllegiancePresence */) {
    // Wave F.3 (2026-05-27): an allegiance member logged
    // in or out. ACE pushed
    // `Allegiance_AllegianceLoginNotification` (opcode
    // 0x027A). The wasm-side recv arm has already flipped
    // the matching member's `logged_in` flag in the cached
    // snapshot, so the allegiance panel just needs to
    // re-render. Forward the GUID + status so plugins can
    // pop a chat-style notification.
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("allegiancePresence", {
        characterGuid: (evt.u32Payload ?? 0) >>> 0,
        isLoggedIn: ((evt.u32Payload2 ?? 0) >>> 0) === 1,
      });
      // The cached snapshot was mutated, so the panel
      // should refresh — easiest path is to re-emit the
      // generic allegianceUpdated event the F2 panel
      // already listens to.
      window.__pluginClient.events.emit("allegianceUpdated", {});
    }
  } else if (evt.kind === ClientEventKind.ALLEGIANCE_INFO /* AllegianceInfo */) {
    // Wave F.3 (2026-05-27): server replied to an
    // `Allegiance_AllegianceInfoRequest` query with a full
    // `AllegianceProfile` (opcode 0x027C). Consumer reads
    // the fresh snapshot via
    // `handle.lastAllegianceInfoResponse()`. Used for
    // examining other players' allegiance trees (not the
    // local player's).
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("allegianceInfo", {
        targetGuid: (evt.u32Payload ?? 0) >>> 0,
      });
    }
  } else if (
    evt.kind === ClientEventKind.VITAL_HEALTH /* Wave 3.C VitalHealth */ ||
    evt.kind === ClientEventKind.VITAL_STAMINA /* Wave 3.C VitalStamina */ ||
    evt.kind === ClientEventKind.VITAL_MANA /* Wave 3.C VitalMana */
  ) {
    // === Wave 3.C — per-vital events (2026-05-28) ===
    // Granular vital updates emitted IN ADDITION to the
    // coalesced kind=8 `playerStatsUpdated`. Vitals HUD
    // subscribes to these so each bar animates smoothly
    // without repainting all three when only one moved.
    // Payload (per src/lib.rs `CLIENT_EVENT_KIND_VITAL_*`):
    //   u32Payload  = current (post-update)
    //   u32Payload2 = buffed_max
    //   f32Payload  = oldValue (Wave 6 polish 2026-05-28)
    //                 — pre-mutation value, undefined when
    //                 the holtburger-world handler couldn't
    //                 capture (initial-spawn hydrate path).
    //                 Subscribers expecting OldValue must
    //                 fall back to `current` when undefined.
    // Vital type lives in the kind itself (HP=42 / ST=43 /
    // MN=44). Non-vital subscribers keep using kind=8 — the
    // coalesced signal still fires alongside these.
    if (window.__pluginClient?.events) {
      const busName =
        evt.kind === ClientEventKind.VITAL_HEALTH ? "vitalChangedHealth"
        : evt.kind === ClientEventKind.VITAL_STAMINA ? "vitalChangedStamina"
        : "vitalChangedMana";
      const current = (evt.u32Payload ?? 0) >>> 0;
      const buffedMax = (evt.u32Payload2 ?? 0) >>> 0;
      // f32Payload is `Option<f32>` on the wasm side; the
      // JS getter returns `undefined` for None. Cast to int
      // when present (vitals are integer values; the f32
      // carrier was only for payload-slot reuse, the value
      // is still exact for any vital < 16M).
      const f32prev = evt.f32Payload;
      const oldValue = (f32prev !== undefined && f32prev !== null)
        ? (f32prev | 0)
        : undefined;
      window.__pluginClient.events.emit(busName, {
        current,
        buffedMax,
        oldValue,
      });
    }
  } else if (evt.kind === ClientEventKind.PORTAL_STORM /* Wave 6.C PortalStorm */) {
    // === Wave 6.C — Portal Storm dispatch (2026-05-28) ===
    // Wave 1.F pre-wired the Portal Storm floaty indicator
    // at `plugins/status-indicators.js:533-547` to subscribe
    // to `portalStormChanged`. No emit site existed. Wave
    // 6.C surfaces the 4 Misc_PortalStorm* GameEvents
    // (0x02C9-0x02CC) through CLIENT_EVENT_KIND_PORTAL_STORM
    // (= 45 — bumped from 42-44 owned by Wave 3.C).
    //
    // Payload (per `src/lib.rs::CLIENT_EVENT_KIND_PORTAL_STORM`):
    //   stringPayload = "brewing" | "imminent" | "storm" | "subsided"
    //   u32Payload    = level 0..3 (Subsided=0, Brewing=1,
    //                   Imminent=2, Storm=3)
    //   f32Payload    = ACE extent (Brewing/Imminent only,
    //                   0.0 for Storm/Subsided which carry
    //                   no wire payload)
    //
    // The subscribe site (status-indicators.js) reads
    // `level` (preferred) or `extent` (fallback) and
    // treats either as "active when > 0". The state name
    // is forwarded so a future wave can swap to per-state
    // sprites without a new event kind.
    if (window.__pluginClient?.events) {
      const state = evt.stringPayload || "subsided";
      const level = (evt.u32Payload ?? 0) >>> 0;
      const extent = Number(evt.f32Payload ?? 0);
      window.__pluginClient.events.emit("portalStormChanged", {
        state,
        level,
        extent,
      });
    }
  } else if (evt.kind === ClientEventKind.ENTITY_ENCHANTMENTS_UPDATED /* Wave 4.B EntityEnchantmentsUpdated */) {
    // === Wave 4.B — remote-entity enchantments dispatch (2026-05-28) ===
    //
    // Wire layer is complete on inbound for non-self
    // targets — the recv loop's pre-route hook updates
    // `entity_enchantments_index` for every
    // `MagicUpdateEnchantment` / DispelEnchantment / Purge etc.
    // whose `target` != local player guid. This event signals
    // the JS side that the new snapshot is ready to pull
    // via `handle.entityEnchantments(guid)`.
    //
    // Payload (per `src/lib.rs::CLIENT_EVENT_KIND_ENTITY_ENCHANTMENTS_UPDATED`):
    //   u32Payload    = target entity GUID
    //   u32Payload_2  = current cached enchantment count (post-mutation)
    //   stringPayload = None
    //   f32Payload    = None
    //
    // Subscribers (`plugins/buffs-hud.js` + `scene3d/
    // nameplate_sprite.js`) re-pull the per-GUID snapshot
    // and refresh just the affected target's UI — without
    // touching the local-player path.
    if (window.__pluginClient?.events) {
      const guid = (evt.u32Payload ?? 0) >>> 0;
      const count = (evt.u32Payload2 ?? 0) >>> 0;
      if (guid !== 0) {
        window.__pluginClient.events.emit("entityEnchantmentsUpdated", {
          guid,
          count,
        });
      }
    }
  } else if (evt.kind === ClientEventKind.ENTITY_ATTACHED /* EntityAttached — runtime equip */) {
    // Held items (weapon/shield/caster) wielded while already
    // in-world: Rust emits ClientEvent kind=49 (and kind=47 on
    // unequip) on the Wielder PropertyInstanceId transition, but
    // this drain had NO arm and no generic kind:N forwarder, so the
    // scene3d/index.js kind:49/47 subscribers (markWielderDirty →
    // attachChildToParent — the ONLY runtime channel that attaches
    // a held mesh to the rig hand) never fired. Login-time wields
    // ride KIND_SPAWN → _markWielderDirty, so the gap was invisible
    // until a live equip. Re-emit on the plugin bus, mirroring the
    // kind:13 re-emit pattern below.
    if (window.__pluginClient?.events?.emit) {
      try { window.__pluginClient.events.emit("kind:49", evt); } catch (_) {}
    }
  } else if (evt.kind === ClientEventKind.ENTITY_DETACHED /* EntityDetached — runtime unequip */) {
    if (window.__pluginClient?.events?.emit) {
      try { window.__pluginClient.events.emit("kind:47", evt); } catch (_) {}
    }
  } else if (evt.kind === ClientEventKind.CHESS_UPDATE /* SG-C1b ChessUpdate */) {
    // SG-C1b (2026-06-09): the 5 chess-minigame GameEvents
    // decoded in SG-C1a arrive here string-encoded (see
    // src/lib.rs CLIENT_EVENT_KIND_CHESS_UPDATE). Maintain a
    // per-board state object on `window.__chess` (a Map keyed by
    // board-guid hex) so the drudge-chess board is observable
    // client-side (console + any future board plugin), and
    // re-emit on the plugin bus as `chessUpdate`. Minimal/debug
    // surface — a rendered 8x8 grid is a follow-on.
    try {
      const rec = String(evt.stringPayload || "");
      const parts = rec.split("|");
      const tag = parts[0];
      const board = parts[1] || (((evt.u32Payload ?? 0) >>> 0).toString(16));
      if (!window.__chess) window.__chess = new Map();
      let st = window.__chess.get(board);
      if (!st) {
        st = {
          board, myColor: null, status: "active", lastMove: null,
          lastResult: null, stalemate: null, winner: null, history: [],
        };
        window.__chess.set(board, st);
      }
      if (tag === "join") {
        st.myColor = parseInt(parts[2], 10);
        st.status = st.myColor === -1 ? "join-failed" : "active";
      } else if (tag === "moveres") {
        st.lastResult = parseInt(parts[2], 10);
      } else if (tag === "turn") {
        const mv = {
          color: parseInt(parts[2], 10),
          type: parseInt(parts[3], 10),
          player: parts[4],
          from: { x: parseInt(parts[5], 10), y: parseInt(parts[6], 10) },
          to: { x: parseInt(parts[7], 10), y: parseInt(parts[8], 10) },
          piece: parts[9],
        };
        st.lastMove = mv;
        st.history.push(mv);
      } else if (tag === "stale") {
        st.stalemate = {
          color: parseInt(parts[2], 10),
          offering: parts[3] === "1",
        };
      } else if (tag === "over") {
        st.status = "over";
        st.winner = parseInt(parts[2], 10);
      }
      // eslint-disable-next-line no-console
      console.log(`[chess] ${tag} board=0x${board}`, st);
      window.__pluginClient?.events?.emit?.("chessUpdate", { board, tag, state: st });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[chess] dispatch failed:", e);
    }
  } else if (evt.kind === ClientEventKind.INSCRIPTION /* SG-C2 InscriptionResponse */) {
    // SG-C2 (2026-06-09): an object's inscription text + scribe.
    // u32Payload = object guid, stringPayload = inscription text,
    // u32Payload_2 = scribe guid. (Deprecated retail event;
    // inscription text normally arrives via appraisal.) Minimal
    // observable surface + plugin-bus emit.
    const objGuid = (evt.u32Payload ?? 0) >>> 0;
    const text = String(evt.stringPayload || "");
    const scribeGuid = (evt.u32Payload2 ?? 0) >>> 0;
    // eslint-disable-next-line no-console
    console.log(`[inscription] obj=0x${objGuid.toString(16)} scribe=0x${scribeGuid.toString(16)} text=${JSON.stringify(text)}`);
    window.__pluginClient?.events?.emit?.("inscriptionShown", {
      objectGuid: objGuid, scribeGuid, text,
    });
  } else if (evt.kind === ClientEventKind.SALVAGE_RESULT /* SG-C2 SalvageOperationsResult */) {
    // SG-C2 (2026-06-09): per-material salvage yield. u32Payload =
    // skill, u32Payload_2 = augmentation bonus, stringPayload =
    // "<material>:<units>:<workmanship>,..." per line.
    const skill = (evt.u32Payload ?? 0) >>> 0;
    const augBonus = (evt.u32Payload2 ?? 0) | 0;
    const results = String(evt.stringPayload || "")
      .split(",")
      .filter((s) => s.length > 0)
      .map((s) => {
        const [material, units, workmanship] = s.split(":");
        return {
          material: parseInt(material, 10),
          units: parseInt(units, 10),
          workmanship: Number(workmanship),
        };
      });
    // eslint-disable-next-line no-console
    console.log(`[salvage] skill=${skill} augBonus=${augBonus}`, results);
    window.__pluginClient?.events?.emit?.("salvageResult", {
      skill, augBonus, results,
    });
  } else if (evt.kind === ClientEventKind.UI_EVENT /* SG-C3 UiEvent */) {
    // SG-C3 (2026-06-09): UI-surface self-events
    // (barber/age/chat-channels/housing/house-access). stringPayload
    // = "<tag>|<data...>". Route /age to the chat log; emit the rest
    // on the plugin bus as `uiEvent` (per-feature UIs are follow-ons).
    try {
      const rec = String(evt.stringPayload || "");
      const sep = rec.indexOf("|");
      const tag = sep === -1 ? rec : rec.slice(0, sep);
      const rest = sep === -1 ? "" : rec.slice(sep + 1);
      const u32 = (evt.u32Payload ?? 0) >>> 0;
      const u32b = (evt.u32Payload2 ?? 0) >>> 0;
      if (tag === "age") {
        // "age|<name>|<age>"
        const bar = rest.indexOf("|");
        const name = bar === -1 ? rest : rest.slice(0, bar);
        const age = bar === -1 ? "" : rest.slice(bar + 1);
        const line = `${name || "?"} ${age || ""}`.trim();
        if (typeof appendChatLine === "function") appendChatLine(line, 0);
        // eslint-disable-next-line no-console
        console.log(`[uiEvent age] ${line}`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[uiEvent ${tag}]`, { rest, u32, u32b });
      }
      window.__pluginClient?.events?.emit?.("uiEvent", { tag, rest, u32, u32b });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[uiEvent] dispatch failed:", e);
    }
  } else if (evt.kind === ClientEventKind.ENTITY_HEALTH /* F10-1 EntityHealth */) {
    // F10-1: a tracked entity's health fraction changed
    // (QueryHealth reply / damage UpdateHealthFraction). Forward
    // to the target-bar via the plugin bus, keyed by guid.
    try {
      const guid = (evt.u32Payload ?? 0) >>> 0;
      const fraction = Number.isFinite(evt.f32Payload) ? evt.f32Payload : null;
      window.__pluginClient?.events?.emit?.("entityHealthUpdated", { guid, fraction });
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.OBJECT_APPRAISED /* ObjectAppraised */) {
    // ACPlugin PR-2 (2026-05-27): an entity's appraisal
    // data was just refreshed in the entity store (the
    // wasm-side already folded the IdentifyObjectResponse
    // properties through `apply_identify_response`).
    // Unblocks /assess UI, vendor tooltips, examine
    // popovers — see ACPlugin handoff §4 priority row
    // "0x00C9 Item_SetAppraiseInfo". Plugin handlers read
    // updated props via the existing entity-store API +
    // (in WorldState) via the typed WorldObject reflecting
    // PR 1's setters.
    const entityName = evt.stringPayload || "";
    const entityGuidU32 = (evt.u32Payload ?? 0) >>> 0;
    try {
      window.__pluginClient?.events?.emit?.("objectAppraised", {
        stringPayload: entityName,
        u32Payload: entityGuidU32,
      });
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.USE_FAILED) {
    // Phase 4 step 5: UseFailed (WeenieError /
    // WeenieErrorWithString). Already mirrored as a
    // chat line into the System tab; logging here for
    // debug visibility.
    const errLabel = evt.stringPayload || "?";
    const errCode = evt.u32Payload >>> 0;
    // eslint-disable-next-line no-console
    console.log(`[step 5] UseFailed ${errLabel} code=${errCode}`);
    // Wave D / PR13 (2026-06-06): re-emit on the plugin
    // bus. rejection_feedback.js uses it only as a FALLBACK
    // (UseDone failures carry no item GUID); the authoritative
    // inventory rejection is kind=48 below.
    if (window.__pluginClient?.events?.emit) {
      try {
        window.__pluginClient.events.emit("kind:13", evt);
      } catch (_) {}
    }
    // F8-2: a fizzle (YourSpellFizzled = 0x0402) cancels the
    // local cast-gesture chain so the character doesn't finish
    // the windup and flash the spell's success glow. Default-ON
    // (`?castFizzle=off` escape).
    if (errCode === 0x0402) {
      try {
        if (new URLSearchParams(window.location.search).get("castFizzle") !== "off") {
          const em = window.liveScene3d?.entityManager;
          const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
          // WS16 diag: fizzle (WeenieError 0x0402) landed.
          try { window.__diag?.cast?.onFizzle?.({ guid: lg }); } catch (_) {}
          if (em && lg && typeof em.cancelCastSequence === "function") {
            em.cancelCastSequence(lg, "fizzle");
          }
        }
      } catch (_) {}
    }
    // F8-6 (WS08 2026-07-12): a server cast-REJECT (UseDone(error) ->
    // kind=13) ends the cast. Retail's UseDone handler decrements the
    // busy count for ANY error (acclient.c:401931 m_cBusy--), so a
    // rejected cast must (a) stop finishing its optimistic windup /
    // self-buff glow and (b) free the F8-4 busy window so a CORRECTED
    // recast isn't eaten. Excludes 0x0402 (fizzle, handled above) and
    // 0x001D YoureTooBusy (the PREVIOUS cast is still live). Only acts
    // when a local cast prediction is actually in flight
    // (_castBusyUntilMs active) so a door/melee reuse of e.g.
    // MissileOutOfRange can't cut a non-existent cast. DEFAULT-ON
    // (`!== "off"` reader; `=off` disables); the batched 1070
    // eye-test (E1-E4) is still owed.
    else if (isTerminalCastReject(errCode)) {
      try {
        const flagOn = new URLSearchParams(window.location.search).get("castRejectClears")?.toLowerCase() !== "off";
        const em = window.liveScene3d?.entityManager;
        const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
        const inst = em?.entityMap?.get?.(lg);
        // WS08b (2026-07-13): gate on a DURABLE in-flight signal
        // (inst._castChainActive) rather than the busy-window ESTIMATE
        // alone — the round-4c defect was a genuine reject arriving
        // after `_castBusyUntilMs` (a short durationS estimate) lapsed
        // but while the windup was still running, so the old
        // `now < _castBusyUntilMs` gate silently dropped it and the
        // false success glow finished. `chainActive` stays true for the
        // whole chain; the busy window is now only an OR-fallback.
        if (em && lg && inst && typeof em.cancelCastSequence === "function" &&
            shouldClearCastOnReject({
              flagOn,
              code: errCode,
              chainActive: !!inst._castChainActive,
              busyUntilMs: inst._castBusyUntilMs || 0,
              nowMs: performance.now(),
            })) {
          em.cancelCastSequence(lg, "reject");
        }
      } catch (_) {}
    }
  } else if (evt.kind === ClientEventKind.INVENTORY_ACTION_FAILED) {
    // kind=48 InventoryActionFailed — the server's own rejection
    // of an inventory mutation (GameEvent InventoryServerSaveFailed
    // 0x00A0): u32Payload = item GUID, u32Payload2 = WeenieError,
    // stringPayload = Debug label. Forward the authoritative event
    // to the plugin bus (raw + semantic name); rejection_feedback.js
    // renders the slot flash + toast. The paired transient chat line
    // is pushed separately by the same recv arm.
    const payload = {
      kind: ClientEventKind.INVENTORY_ACTION_FAILED,
      u32Payload: (evt.u32Payload ?? 0) >>> 0,
      u32Payload2: (evt.u32Payload2 ?? 0) >>> 0,
      stringPayload: evt.stringPayload || "",
    };
    try {
      window.__pluginClient?.events?.emit?.("kind:48", payload);
      window.__pluginClient?.events?.emit?.("inventoryActionFailed", payload);
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.USE_DONE) {
    // Phase 4 step 5: UseDone OK — door opened, container
    // approached, lifestone touched. The visible reaction
    // (open-container UI, position update for
    // lifestone-respawn, etc.) arrives via subsequent
    // events; nothing to render here.
    // eslint-disable-next-line no-console
    console.log(`[step 5] UseDone (success)`);
    // F8-4: UseDone means the server finished the current action
    // (incl. a cast) — clear the local cast-busy window so the
    // next cast can start immediately (?castStateMachine).
    try {
      const em = window.liveScene3d?.entityManager;
      const lg = (getLocalPlayerGuid?.() ?? 0) >>> 0;
      // WS16 diag: UseDone landed — server finished the action.
      try { window.__diag?.cast?.onUseDone?.({ guid: lg }); } catch (_) {}
      if (em && lg && typeof em.clearCastBusy === "function") {
        em.clearCastBusy(lg);
      }
      // WS14 — cast-lifecycle resolved on UseDone so the combat-bar
      // cast-busy sweep clears even for fast/instant casts whose
      // gesture chain the server outran. Additive + no-op without a
      // bus / consumer (a non-cast UseDone just clears an idle sweep).
      try {
        window.__pluginClient?.events?.emit?.("spellCastResolved", { casterGuid: lg });
      } catch (_) {}
    } catch (_) {}
  } else if (evt.kind === ClientEventKind.DOOR_STATE_CHANGED) {
    // Phase 6 step E: DoorStateChanged — ACE has
    // broadcast a SetState packet for an entity flagged
    // ObjectDescriptionFlag::DOOR with the ETHEREAL bit
    // toggled. The wasm side has already flipped the
    // matching `building_aabb_index` entry's `active`
    // flag (handled inside the recv loop's WorldEvent
    // dispatch — see the DoorStateChanged arm in
    // src/lib.rs). JS-side responsibility: update the
    // door state map, rotate the door entity's own
    // sprite, AND rotate the building's static door
    // part sprite so both swing together. Per-part
    // match goes through the wasm-side indexed lookup
    // (`handle.getBuildingPartForDoor`) populated on
    // ObjectCreate; spatial proximity via
    // `findClosestBuildingPart` is the fallback when
    // the indexed lookup misses (race with AABB drain,
    // dynamic-dungeon doors).
    const doorGuid = evt.u32Payload >>> 0;
    const doorState = (evt.u32Payload2 >>> 0) === 1
      ? "open"
      : "closed";
    window.__doorStates.set(doorGuid, doorState);
    // The 2D PIXI door-sprite-rotation branch (rotate the door
    // entity's PIXI sprite + the building's static door-part sprite,
    // resolved via handle.getBuildingPartForDoor / findClosestBuilding-
    // Part and cached in __doorBuildingParts) was RETIRED 2026-06-18
    // (2D-PIXI-retirement) → legacy/door_2d.js. Zero 3D readers
    // (verified). The 3D path below is the live door renderer.
    // PR-OO 2026-05-23: 3D path — rotate the door entity's
    // THREE.Group root around the world-up (Z) axis. The
    // 2D path above only touches Pixi sprites; the 3D
    // renderer needs a parallel write to the
    // entityManager.entityMap[guid].root. Hinge frame from
    // SetupModel still TODO (the `holtburg_test_door_
    // rotation_keyframe` follow-on); rotating around the
    // root's local origin is a visible approximation — for
    // most doors the origin sits on the hinge edge of the
    // mesh, so this swings the door open. Doors with a
    // centred origin will spin in place; refine via SetupModel
    // hingeFrame extraction in a follow-up.
    if (window.liveScene3d?.entityManager?.entityMap) {
      const em3d = window.liveScene3d.entityManager;
      const inst = em3d.entityMap.get(doorGuid >>> 0);
      if (inst?.root) {
        // Animation consolidation (?unifiedMotion=door): play the
        // door's real On (open) / Off (close) swing via the Rust
        // authority — the hinge is baked into the keyframes (63 door
        // MTs carry On/Off cycles; probe_door_motions.rs), so the door
        // panel parts swing correctly instead of the instant
        // root-rotation snap (which spins centred-origin doors in
        // place). Default-off → unchanged snap.
        // OpenAC comparison 2026-10-04 (doors F9): the escape
        // mode used to snap the WHOLE entity ±90° here — not
        // retail (it spun centred-origin doors in place). With
        // unified door motion off, the server's door
        // UpdateMotion (ACE Door.cs Open/Close broadcast it)
        // drives the swing; this state event is visual-free.
        if (em3d.usesUnifiedDoor?.()) {
          em3d.playDoorMotion(doorGuid >>> 0, doorState === "open");
        }
        inst.__doorState = doorState;
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `[phase6.E] door 0x${doorGuid.toString(16).toUpperCase().padStart(8, "0")} → ${doorState}`,
    );
  } else if (evt.kind === ClientEventKind.ENTITY_VISIBILITY_CHANGED) {
    // EntityVisibilityChanged — wasm detected that
    // `Entity::should_draw()` flipped on a SetState
    // update, or that the entity spawned already
    // hidden. Driven by `PhysicsState::HIDDEN`,
    // `NO_DRAW`, or `CLOAKED` bits per `acclient.h`
    // enum `PhysicsState` (and ACE's matching gates in
    // `ACE.Server/Physics/PhysicsObj.cs`).
    //
    // `u32Payload` = entity GUID; `u32Payload2` = 1
    // (visible) or 0 (hidden). Forwards to the 3D
    // EntityManager which toggles
    // `inst.root.visible` on the matching
    // THREE.Group. The 2D path is unaffected — it does
    // not currently honor PhysicsState draw gates
    // (a future ship can mirror this if needed).
    //
    // A8-M3: under ?unifiedClientEvent=on the handler body
    // lives in scene3d/client_event_dispatch.js (one
    // rig-affecting ClientEvent dispatcher, retail parity:
    // visibility owned by the entity layer, no renderer
    // dispatch hop — acclient.c:143396/322197-322200);
    // flag-off runs the legacy inline body below,
    // byte-identical. The legacy body is the `else` of the
    // consumed-hook test so the two can never double-handle.
    if (!(__unifiedClientEventOn && window.__scene3dClientEventHook?.(evt))) {
      const visGuid = evt.u32Payload >>> 0;
      const visible = (evt.u32Payload2 >>> 0) === 1;
      if (
        window.liveScene3d
        && window.liveScene3d.entityManager
        && typeof window.liveScene3d.entityManager.setVisibility === "function"
      ) {
        window.liveScene3d.entityManager.setVisibility(visGuid, visible);
      }
    }
  } else if (evt.kind === ClientEventKind.OVERHEAD_SPEECH) {
    // F17-5 — overhead speech bubble. The wasm recv loop emits
    // this alongside the kind=2 chat-panel line for the four
    // near-field chat arms (HearSpeech / HearRangedSpeech /
    // EmoteText / SoulEmote), carrying the SPEAKER guid that was
    // previously dropped — so chat only ever reached the DOM
    // window, never the 3D talker. `u32Payload` = sender guid,
    // `stringPayload` = the words / emote text (no channel
    // prefix), `u32Payload2` = CHAT_CATEGORY_* (4 = emote, per
    // lib.rs `CHAT_CATEGORY_EMOTE`). Integrated always-on after the
    // 1070 eye-test PASSED (2026-06-10) — was formerly gated behind
    // `?speechBubbles=on`; the gate is removed (still guarded on the
    // live scene/entityManager being ready).
    if (
      window.liveScene3d
      && window.liveScene3d.entityManager
      && typeof window.liveScene3d.entityManager.showSpeechBubble === "function"
    ) {
      const speakerGuid = evt.u32Payload >>> 0;
      const isEmote = (evt.u32Payload2 >>> 0) === 4;
      window.liveScene3d.entityManager.showSpeechBubble(
        speakerGuid,
        evt.stringPayload || "",
        isEmote,
      );
    }
  } else if (evt.kind === ClientEventKind.SERVER_INFO) {
    // HUD rec #83 (2026-06-16) — ServerInfoReceived. ACE
    // sent GameMessage::ServerName (opcode 0xF658) with the
    // world identity + connection counts; wasm has stashed
    // a fresh `serverInfo()` snapshot. Re-render the post-
    // login banner so users see "Server: <name> | Players:
    // X/Max" (acclient.h:56091
    // gmCharacterManagementUI::UpdateWorldName).
    if (typeof window.__renderLoginStatusBanner === "function") {
      window.__renderLoginStatusBanner();
    }
  } else if (evt.kind === ClientEventKind.SHARED_COOLDOWNS) {
    // HUD rec #84 (2026-06-16) — SharedCooldownsUpdated.
    // Wasm flagged a PlayerEnchantmentsUpdated tick (incl.
    // adds, refreshes, expiries, dispels). u32Payload
    // carries the active-cooldown count for at-a-glance
    // use. Re-broadcast on the plugin bus as the
    // Chorizite-style `sharedCooldownChanged` event so
    // hotbar / vitals-hud / future cooldown HUDs can
    // subscribe without re-filtering enchantments on every
    // kind=8 stats fire. Mirrors api.js #12
    // (Character.OnSharedCooldownChanged, previously
    // MISSING per the rec's audit).
    if (window.__pluginClient?.events) {
      window.__pluginClient.events.emit("sharedCooldownChanged", {
        activeCount: (evt.u32Payload ?? 0) >>> 0,
      });
    }
  } else if (evt.kind === ClientEventKind.LOCALIZATION) {
    // HUD rec #68 (2026-06-16) — LocalizationReceived. ACE's
    // DddInterrogation (0xF7E5) carried the server language
    // context; wasm stashed a localization() snapshot. Seed
    // window.__acLocalization with langId/region plus the JS-side
    // locale derivations: numericLocale + currencyFormat come from
    // langId via a static BCP-47 table (ACE has no per-account
    // currency/format preference — these are pure client
    // derivations), then resolve __acLocalizationReady so panels
    // can await locale context. langId is a global server config
    // (0 = English on English ACE installs), not per-character.
    try {
      const loc = handle.localization?.() ?? null;
      const langId = (evt.u32Payload ?? loc?.langId ?? 0) >>> 0;
      const region = (evt.u32Payload2 ?? loc?.serversRegion ?? 0) >>> 0;
      // AC name_rule_language convention: 0 English, 1 French,
      // 2 German, 3 Spanish, 4 Italian, 5 Portuguese, 6 Korean,
      // 7 Chinese, 8 Japanese. pyreal (₱) is the universal AC
      // currency symbol; only the numeric grouping differs.
      const LANG_ID_TO_LOCALE = {
        0: { code: "en-US", numericLocale: { decimal: ".", thousands: "," } },
        1: { code: "fr-FR", numericLocale: { decimal: ",", thousands: " " } },
        2: { code: "de-DE", numericLocale: { decimal: ",", thousands: "." } },
        3: { code: "es-ES", numericLocale: { decimal: ",", thousands: "." } },
        4: { code: "it-IT", numericLocale: { decimal: ",", thousands: "." } },
        5: { code: "pt-BR", numericLocale: { decimal: ",", thousands: "." } },
        6: { code: "ko-KR", numericLocale: { decimal: ".", thousands: "," } },
        7: { code: "zh-CN", numericLocale: { decimal: ".", thousands: "," } },
        8: { code: "ja-JP", numericLocale: { decimal: ".", thousands: "," } },
      };
      const locale = LANG_ID_TO_LOCALE[langId] ?? LANG_ID_TO_LOCALE[0];
      window.__acLocalization = {
        langId,
        region,
        productId: (loc?.productId ?? 0) >>> 0,
        supportedLangs: loc?.supportedLanguages ? Array.from(loc.supportedLanguages) : [],
        code: locale.code,
        numericLocale: locale.numericLocale,
        currencyFormat: { symbol: "₱", position: "suffix" },
      };
      if (window.__pluginClient?.events) {
        window.__pluginClient.events.emit("localizationReady", window.__acLocalization);
      }
      if (typeof window.__resolveAcLocalizationReady === "function") {
        window.__resolveAcLocalizationReady(window.__acLocalization);
        window.__resolveAcLocalizationReady = null;
      }
    } catch (e) {
      console.warn("[hud rec#68] localization drain failed:", e);
    }
  } else if (evt.kind === ClientEventKind.JUMP_REFUSED) {
    // A14-I4 (W3+ S11, ?jumpParity=on) — jump refusal text.
    // `u32Payload` = the retail refusal code (jump_is_allowed /
    // jump_charge_is_allowed, acclient.c:343922-343974); retail
    // prints via ClientSystem::AddTextToScroll(…, 0x1A, …)
    // (acclient.c:408050-408059 press, :408193-408203 release).
    // Wording = ACE WeenieError style; the retail string
    // CONTENTS aren't in the decompile (only the globals
    // cant_jump_load/position/in_air, acclient.c:56814-56818 —
    // spec §6 Q3, confirm when the ACE Network tree is
    // greppable). Replaces the legacy arm's silent drop.
    const code = evt.u32Payload >>> 0;
    const text =
      code === 73 ? "You are too encumbered to jump!"
      : code === 72 ? "You can't jump from this position!"
      : code === 36 ? "You're in the air!"
      : "You can't jump right now.";
    if (typeof appendChatLine === "function") {
      appendChatLine(text, 10);
    }
  } else if (evt.kind === ClientEventKind.CMD_INTERP) {
    // ?cmdInterp=on (step 5, PLAN rows 12-13): interpreter
    // event stream → renderer consumers. The legacy sig-diff
    // side-effects (W3.1 forward clip, anim-break cut,
    // setSidestepLayer) are silenced under the flag; these
    // arms are their event-driven replacements, mirroring
    // the legacy blocks at the sig-diff dispatcher (~8700).
    // u32Payload: 1 = ForwardSlotEvicted (cut the local cast
    // gesture), 2 = ControlReclaimed (ADJ-15 Q3
    // instrumentation for the 1070 A/B), 3 = DriveApplied
    // (u32Payload2 packs (fwd+1)|(side+1)<<8|(turn+1)<<16|
    // run<<24 — each axis -1/0/+1).
    if (!CMD_INTERP_ON) return; // stream is flag-on only (the inline loop's `continue`)
    try {
      const code61 = evt.u32Payload >>> 0;
      const em = window.liveScene3d?.entityManager;
      const localGuid =
        typeof window.getLocalPlayerGuid === "function"
          ? window.getLocalPlayerGuid()
          : null;
      if (code61 === 1) {
        // Row 12 anim-break: a fresh forward intent evicted
        // the forward slot — cut the LOCAL cast-gesture
        // chain. Same F8-4 busy-window guard + ?castMove
        // alias gate as the legacy W3.1 cut (observers still
        // watch the full cast — server only rate-checks).
        if (
          CAST_MOVE_ON &&
          em &&
          localGuid != null &&
          typeof em.cancelCastSequence === "function"
        ) {
          const inst = em.entityMap?.get?.(localGuid >>> 0);
          if (
            inst?._castBusyUntilMs &&
            performance.now() < inst._castBusyUntilMs
          ) {
            em.cancelCastSequence(localGuid >>> 0, "anim-break");
          }
        }
      } else if (code61 === 2) {
        // FU-A reclaim fired (stomp + all-three-heads
        // revival). Counted for the ADJ-15 Q3 observation:
        // does a turn-tap reclaim visually evict the
        // gesture? The 1070 A/B reads this counter + the
        // console line alongside the visuals.
        window.__cmdInterpReclaims =
          ((window.__cmdInterpReclaims | 0) + 1) | 0;
        console.log(
          "[cmdInterp] FU-A control reclaim #" +
            window.__cmdInterpReclaims
        );
      } else if (code61 === 3) {
        const packed = (evt.u32Payload2 ?? 0x010101) >>> 0;
        const fwd = (packed & 0xff) - 1;
        const side = ((packed >> 8) & 0xff) - 1;
        const run = ((packed >> 24) & 0xff) !== 0;
        if (em && localGuid != null) {
          const NONCOMBAT_STANCE = 0x8000003d;
          const stance =
            (typeof em.getStance === "function"
              ? em.getStance(localGuid >>> 0) >>> 0
              : 0) || NONCOMBAT_STANCE;
          // Row 12 (W3.1 replacement): the forward base
          // clip from the INSTALLED drive — same command
          // choices as the legacy block (backward always
          // walks; stopped → Ready idle base).
          if (typeof em.setMotion === "function") {
            let forwardCmd;
            if (fwd > 0) forwardCmd = run ? 0x44000007 : 0x45000005;
            else if (fwd < 0) forwardCmd = 0x45000006;
            else forwardCmd = 0x41000003;
            // 2026-10-05: a pure strafe IS the cycle (retail
            // CMotionTable sidestep-as-substate); the sidestep
            // layer below rides the mixer, which UNIFIED_LOCO
            // no longer advances. Sign carries direction.
            let fwdSpeed = 1.0;
            if (fwd === 0 && side !== 0) {
              forwardCmd = 0x6500000f;
              fwdSpeed = side < 0 ? -1.0 : 1.0;
            }
            em.setMotion(localGuid >>> 0, forwardCmd >>> 0, stance, fwdSpeed);
          }
          // Row 13 (setSidestepLayer replacement): always
          // the SideStepRight clip, sign carries direction
          // (Phase 2.5 collapse — see the legacy block's
          // rationale).
          if (typeof em.setSidestepLayer === "function") {
            const sidestepCmd =
              side !== 0 ? 0x6500000f /* SideStepRight */ : 0;
            em.setSidestepLayer(
              localGuid >>> 0,
              sidestepCmd,
              stance,
              side
            );
          }
        }
      }
    } catch (e) {
      console.warn("[cmdInterp] kind-61 consumer failed:", e);
    }
  } else if (evt.kind === ClientEventKind.ENTITY_AIRBORNE_CHANGED) {
    // Wave 1.8 — EntityAirborneChanged for REMOTE players.
    // Wave 10 Phase 10.1 (2026-05-26) — extended to also
    // accept the local-player touchdown signal.
    //
    // Restores the JS recv handler that Wave 1.2 deleted
    // alongside the local-player overlay. Wasm
    // `CLIENT_EVENT_KIND_ENTITY_AIRBORNE_CHANGED` (lib.rs:23517)
    // fires from TWO sites:
    //   - REMOTE (Wave 1.8): VectorUpdate velocity-z threshold
    //     crossings for non-local entities (jump + landing).
    //   - LOCAL  (Wave 10.1): the post-tick `was_airborne_pre_tick
    //     && !w.player.is_airborne` branch in the recv loop
    //     fires `(local_guid, 0)` exclusively on touchdown —
    //     the wasm never emits airborne=1 for the local
    //     player (the spacebar handler's `setAirborne(true)`
    //     local-prediction owns that direction).
    //
    // Per Joe Trevis (original AC dev): retail had a combined
    // jumping/falling animation (arms up), no discrete Jump
    // motion-table clip. So we fire `setAirborne(guid, true)`
    // on any remote airborne edge (jump OR walked-off-ledge,
    // can't distinguish from wire) — both get the retail
    // arms-up overlay. `setAirborne(guid, false)` on the
    // falling edge clears that overlay for both remote AND
    // local players.
    //
    // `u32Payload` = entity GUID; `u32Payload2` = 1 (airborne)
    // or 0 (grounded). The local guid is no longer filtered
    // out — the wasm-side gates already ensure local fires
    // only on the grounded edge.
    const airborneGuid = evt.u32Payload >>> 0;
    const airborne = (evt.u32Payload2 >>> 0) === 1;
    if (
      airborneGuid !== 0
      && window.liveScene3d
      && window.liveScene3d.entityManager
      && typeof window.liveScene3d.entityManager.setAirborne === "function"
    ) {
      window.liveScene3d.entityManager.setAirborne(airborneGuid, airborne);
    }
  } else if (evt.kind === ClientEventKind.SOUND_TRIGGERED) {
    // Task F (ambient-sounds-chain 2026-05-12):
    // SoundTriggered — ACE broadcast `GameMessageSound`
    // (opcode 0xF750) for a server-triggered audio cue:
    // lifestone bind, switch activation, hotspot trigger,
    // craft event, etc.
    //
    // Payload (set by the recv-loop `GameMessage::PlaySound`
    // arm in `src/lib.rs`):
    //   u32Payload  = entity GUID (the sound's source)
    //   u32Payload2 = `Sound` enum value (lookup key into
    //                 the entity's SoundTable)
    //   f32Payload  = scale (server-side volume multiplier,
    //                 typically 1.0)
    //
    // Resolution chain (mirrors Task E's SoundTable hook
    // dispatch in `scene3d/entities.js::_fireHook`):
    //   1. window.liveScene3d.entityManager.entityMap[guid]
    //      → EntityInstance (Task E plumbing — inst exposes
    //      `soundTableDid` + `root.position`).
    //   2. resolveSound(soundTableDid, soundEnum) picks a
    //      `SoundEntry` weighted by `probability`.
    //   3. audioManager.play(waveDid, pos, { gain: vol*scale })
    //      mixes through the same PannerNode path as Task E.
    //
    // Soft cases (each logs debug + skips):
    //   - entity unknown (despawn race between ACE send +
    //     client recv); 2D-only renderer (no entityManager)
    //   - inst.soundTableDid == 0 (entity has no SoundTable
    //     on its weenie — normal for many statics)
    //   - resolveSound returns null (Sound enum absent from
    //     the SoundTable's `Sounds` dictionary)
    //   - scale <= 0 (treated as 1.0; logs a one-shot warn
    //     so the bug surfaces without spamming the console)
    const sndGuid = evt.u32Payload >>> 0;
    const sndEnum = evt.u32Payload2 >>> 0;
    let sndScale = (typeof evt.f32Payload === "number")
      ? +evt.f32Payload
      : 1.0;
    if (!(sndScale > 0)) {
      if (!window.__soundTriggeredScaleWarned) {
        window.__soundTriggeredScaleWarned = true;
        // eslint-disable-next-line no-console
        console.warn(
          `[task-F/gms] non-positive scale=${evt.f32Payload} for `
          + `guid=0x${sndGuid.toString(16).padStart(8, "0")} `
          + `enum=0x${sndEnum.toString(16)}; treating as 1.0 `
          + `(further occurrences silenced this session)`,
        );
      }
      sndScale = 1.0;
    }
    // Capture-script telemetry counters — accumulate
    // outcomes so a diag can assert (a) the event was
    // observed, (b) the resolve path was taken, (c) the
    // audio play call landed (or fell into a documented
    // soft skip). Live on window so they survive
    // hot-reloads of the drain block.
    if (!window.__soundTriggeredStats) {
      window.__soundTriggeredStats = {
        received: 0,
        entityMissing: 0,
        noSoundTable: 0,
        enumMissing: 0,
        played: 0,
        scaleClamped: 0,
        lastError: null,
      };
    }
    const stats = window.__soundTriggeredStats;
    stats.received += 1;
    if (sndScale === 1.0 && (typeof evt.f32Payload === "number") && !(evt.f32Payload > 0)) {
      stats.scaleClamped += 1;
    }
    const scene3d = window.liveScene3d;
    const emgr = scene3d?.entityManager ?? null;
    const inst = emgr?.entityMap?.get(sndGuid) ?? null;
    // Event-sound coverage fix (2026-06-09): local-player SoundTable
    // fallback. The local player entity is seeded without a
    // SoundTable (lib.rs:30960 minimal seed; its self-ObjectCreate
    // meta only hydrates one post-wasm-rebuild and only when the
    // Setup carries `default_sound_table`). But ACE targets the
    // bulk of action sounds — eat, drink, pickup, drop, wield,
    // raise-trait, death, wound/fall-damage, resist, lifestone,
    // spell-expire — at `player.Guid`. Without a table those all
    // hit the `noSoundTable` skip below and play silence. Default
    // the local player to the canonical humanoid table 0x20000001
    // (verified to map the shared 0x8B-0x97 action cluster +
    // Eat/Drink/Wound/Death). We mutate `inst.soundTableDid` so it
    // persists → also unblocks the animation Sound-hook channel for
    // the player. A race-accurate DID from the wasm spawn meta
    // (post-rebuild) supersedes this (it only fires when the table
    // is still 0). Remote entities are unaffected.
    if (inst && !(inst.soundTableDid >>> 0)) {
      const lpg = (typeof window.getLocalPlayerGuid === "function")
        ? (window.getLocalPlayerGuid() >>> 0) : 0;
      if (lpg && (sndGuid >>> 0) === lpg) {
        inst.soundTableDid = 0x20000001;
        stats.localPlayerFallback = (stats.localPlayerFallback | 0) + 1;
      }
    }
    if (!inst) {
      stats.entityMissing += 1;
      // eslint-disable-next-line no-console
      console.debug(
        `[task-F/gms] entity 0x${sndGuid.toString(16).padStart(8, "0")} `
        + `not in registry — skip`,
      );
    } else if (!(inst.soundTableDid >>> 0)) {
      stats.noSoundTable += 1;
      // eslint-disable-next-line no-console
      console.debug(
        `[task-F/gms] entity 0x${sndGuid.toString(16).padStart(8, "0")} `
        + `has no SoundTable — skip`,
      );
    } else {
      const stbDid = inst.soundTableDid >>> 0;
      const cache = scene3d?.soundTableCache ?? null;
      const audioMgr = scene3d?.audioManager ?? null;
      if (!cache || !audioMgr) {
        // 3D scene not initialised (renderer=2d or pre-
        // init). Silent no-op — the event isn't actionable
        // without the 3D audio runtime.
        stats.lastError = "no_cache_or_audio_mgr";
      } else {
        cache.resolveSound(stbDid, sndEnum)
          .then((entry) => {
            if (!entry) {
              stats.enumMissing += 1;
              // eslint-disable-next-line no-console
              console.debug(
                `[task-F/gms] no SoundTable entry for enum=0x`
                + `${sndEnum.toString(16)} on stb=0x`
                + `${stbDid.toString(16)} (guid=0x`
                + `${sndGuid.toString(16).padStart(8, "0")}) — skip`,
              );
              return;
            }
            // Snapshot position at resolve-time so a
            // moving entity's audio lands at its current
            // location (matches Task E's snapshot pattern).
            const pos = inst.root?.position;
            if (!pos) {
              stats.lastError = "no_position";
              return;
            }
            const baseVol = entry.volume > 0 ? entry.volume : 1.0;
            const gain = baseVol * sndScale;
            // Phase F.C — runtime event log probe. Source
            // is "GameMessageSound" — the ACE wire-pushed
            // 0xF750 SoundTriggered; F.D's validator
            // matches against server_sound_messages in the
            // F.B manifest's S3 channel (which is a
            // "synthetic injection" path for the probe
            // scenario — the actual server hasn't been
            // captured yet).
            const pushEventRecord = scene3d?._pushEventRecord;
            if (pushEventRecord) {
              pushEventRecord({
                type: "sound",
                wave_did: (entry.waveDid >>> 0),
                parent_entity_guid: (sndGuid >>> 0),
                world_pos: [+pos.x, +pos.y, +pos.z],
                t_wall_ms: typeof performance !== "undefined" ? performance.now() : 0,
                source: "GameMessageSound",
                source_meta: {
                  server_object_guid: (sndGuid >>> 0),
                  sound_enum: sndEnum,
                  stb_did: stbDid,
                  scale: sndScale,
                  gain,
                },
              });
            }
            // Wave C / PR10 (2026-06-06): suppress the
            // server-broadcast echo when the same
            // (soundEnum, itemGuid) was fired optimistically
            // by audio_optimistic.js within the last 300ms.
            // The ring entry is consumed on the suppress
            // check so a second genuine fire still plays.
            try {
              if (window.__audioOptimistic?.shouldSuppressEcho?.(sndEnum, sndGuid)) {
                stats.suppressedEchoes = (stats.suppressedEchoes | 0) + 1;
                return Promise.resolve();
              }
            } catch (_) {}
            // D4-NEW-1 (2026-06-05): transform the RAW AC-frame
            // entity position (inst.root.position; the worldRoot
            // -π/2 rotation never reaches the AudioContext) into the
            // three.js listener frame so the panner pans the correct
            // HRTF bearing (north→overhead bug otherwise). The
            // event-log world_pos above stays AC-frame for cross-
            // source diffing; only the panner value is transformed.
            // Mirrors the scene3d/entities.js Sound(1) sibling
            // (~:8498) and scene3d/index.js GameMessageSound (~:3520).
            const sndT = acToThree(pos.x, pos.y, pos.z);
            return audioMgr.play(
              entry.waveDid,
              { x: sndT[0], y: sndT[1], z: sndT[2] },
              { gain },
            ).then(() => {
              stats.played += 1;
            });
          })
          .catch((e) => {
            stats.lastError = String(e?.message ?? e);
            // eslint-disable-next-line no-console
            console.warn(
              `[task-F/gms] resolve/play threw for `
              + `guid=0x${sndGuid.toString(16).padStart(8, "0")} `
              + `enum=0x${sndEnum.toString(16)}:`,
              e,
            );
          });
      }
    }
  } else if (evt.kind === ClientEventKind.ENVIRON_CHANGE) {
    // AdminEnvirons (0xEA60) — server-pushed environment change
    // (retail CPlayerSystem::Handle_Admin__Environs, acclient.c:396298).
    // evt.u32Payload = EnvironChangeType:
    //   0x00 Clear · 0x01-0x06 fog tint · 0x65-0x7B environment sound.
    const ec = evt.u32Payload >>> 0;
    if (ec <= 0x06) {
      // FOG: set a global override the distance-fog tick
      // (scene3d/loop.js::tickDistanceFogColor) respects until a
      // Clear (0x00) resets it. Colors + fogMax from retail
      // (acclient.c:396344-416; ARGB 0x64RRGGBB -> RGB). Clear
      // restores the region/sky fog.
      const ENVIRON_FOG = {
        0x01: { rgb: 0x960000, fogMax: 50 }, // RedFog
        0x02: { rgb: 0x320096, fogMax: 50 }, // BlueFog
        0x03: { rgb: 0x646464, fogMax: 30 }, // WhiteFog
        0x04: { rgb: 0x1e6400, fogMax: 50 }, // GreenFog
        0x05: { rgb: 0x969696, fogMax: 40 }, // BlackFog
        0x06: { rgb: 0x969696, fogMax: 40 }, // BlackFog2 (== BlackFog)
      };
      window.__environFogOverride = ec === 0x00 ? null : (ENVIRON_FOG[ec] || null);
      // eslint-disable-next-line no-console
      console.log(
        `[environ] fog change 0x${ec.toString(16)} -> `
        + `${window.__environFogOverride ? `override rgb=0x${window.__environFogOverride.rgb.toString(16)}` : "clear (region fog)"}`,
      );
    } else if (ec >= 0x65) {
      // SOUND: retail plays SoundType (= EnvironChangeType + 0x11)
      // from the UI SoundTable via PlaySoundFromCenter
      // (acclient.c:396438+) — non-positional ("from center"), so
      // play at the listener. The UI SoundTable is **0x2000004B**:
      // a portal.dat scan found it is the UNIQUE 0x20 SoundTable
      // carrying all 21 environ slots 0x76-0x8A (Roar 0x76->Wave
      // 0x0A000314 … Thunder6 0x8A->0x0A0004D2). Override with
      // window.__environSoundTableDid. Fail-soft if the slot is absent.
      const ENVIRON_SOUND_TABLE = (window.__environSoundTableDid >>> 0) || 0x2000004B;
      const soundType = (ec + 0x11) >>> 0;
      const scene3d = window.liveScene3d;
      const cache = scene3d?.soundTableCache ?? null;
      const audioMgr = scene3d?.audioManager ?? null;
      // eslint-disable-next-line no-console
      console.log(
        `[environ] sound 0x${ec.toString(16)} -> sType 0x${soundType.toString(16)} `
        + `via stb 0x${ENVIRON_SOUND_TABLE.toString(16)}`
        + `${(cache && audioMgr) ? "" : " (no 3D audio runtime — skip)"}`,
      );
      if (cache && audioMgr) {
        cache.resolveSound(ENVIRON_SOUND_TABLE, soundType)
          .then((entry) => {
            if (!entry) {
              // eslint-disable-next-line no-console
              console.debug(
                `[environ] no sound for type 0x${ec.toString(16)} `
                + `(sType 0x${soundType.toString(16)}) on stb 0x`
                + `${ENVIRON_SOUND_TABLE.toString(16)} — skip`,
              );
              return;
            }
            // Co-locate with the (camera-anchored) listener so the
            // environ cue is heard "around" the player, not from a
            // direction. camera.position is already three.js-frame.
            const cam = scene3d?.camera?.position;
            const pos = cam ? { x: cam.x, y: cam.y, z: cam.z } : { x: 0, y: 0, z: 0 };
            const gain = entry.volume > 0 ? entry.volume : 1.0;
            // eslint-disable-next-line no-console
            console.log(`[environ] sound playing wave 0x${(entry.waveDid >>> 0).toString(16)} gain=${gain.toFixed(2)}`);
            return audioMgr.play(entry.waveDid, pos, {
              category: "ambient",
              gain,
              refDistance: 1e6,
              rolloffFactor: 0,
            });
          })
          .catch((e) => {
            // eslint-disable-next-line no-console
            console.warn(`[environ] sound resolve/play threw for type 0x${ec.toString(16)}:`, e);
          });
      }
    }
  } else if (evt.kind === ClientEventKind.COMBAT_EVENT) {
    // Phase C — structured combat event for plugin
    // subscribers. The recv loop also emits a kind=2 chat
    // line for human display; this kind=19 event carries a
    // JSON payload with discrete fields so a plugin can
    // subscribe via client.events.on("damageDealt", ...).
    try {
      const payload = JSON.parse(evt.stringPayload || "{}");
      const eventName = payload.type;
      if (eventName && window.__pluginClient) {
        window.__pluginClient.events.emit(eventName, payload);
      }
      // Phase D — visual response: when an attacker hits
      // us (damageTaken) play their swing on the attacker's
      // rig. Names are unique per-cell at any given time so
      // the case-sensitive linear lookup is reliable enough.
      //
      // CMT Wave 2 / Phase 5 (2026-05-26): previously this
      // path called `setSwingPose(g)`, a vibe-coded triangle-
      // wave tween that early-returned on non-human rigs
      // (entities.js:1917 `if (!isHuman) return`) — drudges
      // and other non-human creatures silently played
      // nothing. We now resolve the correct MotionCommand
      // through the CombatManeuverTable runtime using the
      // attacker's stance + inferred AttackType from their
      // equipped weapon, and call `setSwingMotion` which
      // routes through the motion-table link path and can
      // drive ANY rig (humanoid or creature). On CMT miss
      // (unknown stance / attackType combo / `getStance`
      // unset pre-UpdateMotion / `getEquippedWeapon`
      // returning Undef-only) we fall back to the original
      // `setSwingPose` so humanoids still get the legacy
      // wind-up.
      const em = window.liveScene3d?.entityManager;
      if (em && typeof em.findGuidByName === "function") {
        const dispatchRemoteSwing = (attackerName) => {
          const g = em.findGuidByName(attackerName);
          if (g === 0) return;
          // Wave 4 / Phase 4.1 (2026-05-26) — strategy (a):
          // prefer the UpdateMotion-cached swing clip when one
          // is already in flight for this attacker. ACE
          // broadcasts `UpdateMotion(swing, stance)` to all
          // observers BEFORE the damage event resolves and
          // emits `damageTaken`/`evadedAttacker`. By the time
          // we get here, `em.setMotion` (loop.js KIND_MOTION
          // dispatch) has already routed the swing through
          // `_tryPlayLink` and the clip is playing —
          // `inst.currentActionKey` is `swing:<cmd>:<stance>`.
          // If we re-fire CMT here we either (a) replay the
          // same clip from frame 0 (visible stutter) or (b)
          // override with a CMT-picked default that doesn't
          // match the broadcast (e.g. Slash mid when the
          // server actually picked SlashHigh). Skip the work
          // when the cached path already won.
          //
          // Acceptable race window: if UpdateMotion hasn't
          // landed yet (server out-of-order, or the swing
          // arrived in the same poll batch as damageTaken
          // and KIND_MOTION dispatch ran AFTER the
          // damageTaken kind=19 below), `currentActionKey`
          // is null or a locomotion key — fall through to
          // the CMT path. Stale swing (>2s old) also falls
          // through so a long-idle attacker still gets a
          // visible swing on subsequent damage events.
          const STALE_SWING_MS = 2000;
          const inst = em.entityMap?.get((g >>> 0));
          const currentKey = inst?.currentActionKey ?? "";
          const swingLastUsedMs = (typeof currentKey === "string" && currentKey.startsWith("swing:"))
            ? (inst?.actionLastUsedMs?.get?.(currentKey) ?? 0)
            : 0;
          // Audit C1 (CMT remote-swing double-play dedup): a
          // server KIND_MOTION_ACTION swing routed through
          // setMotion's `cls === "attack"` branch plays via
          // `_tryPlayLink`, which RAW-plays the clip under a
          // `link:` key WITHOUT updating `currentActionKey` —
          // so the `swing:`-key check above misses it and the
          // CMT guess below fires a second swing on top.
          // `_tryPlayLink` now stamps `inst._lastServerSwingMs`
          // on the attack/cast success path; treat a fresh stamp
          // as an in-flight server swing for this same target and
          // skip the guess too (strategy (a) also covers the
          // link-key path now).
          const serverSwingMs = (inst && Number.isFinite(inst._lastServerSwingMs))
            ? inst._lastServerSwingMs
            : 0;
          const swingFresh =
            (swingLastUsedMs > 0 && (performance.now() - swingLastUsedMs) < STALE_SWING_MS) ||
            (serverSwingMs > 0 && (performance.now() - serverSwingMs) < STALE_SWING_MS);
          if (swingFresh) {
            try {
              window.__diag?.combat?.onAimLevel?.({
                scope: "remote-cached",
                motion: (() => {
                  const parts = currentKey.split(":");
                  return parts.length >= 2 ? parseInt(parts[1], 16) : 0;
                })(),
              });
            } catch (_) {}
            return; // UpdateMotion-cached swing already playing — strategy (a) hit.
          }
          const stance = em.getStance?.(g) ?? 0;
          // Wave 3 Phase 7 (2026-05-26) — ranged-stance remote
          // attackers (drudge with bow, archer NPCs) pick an
          // aim-level motion via `getAimLevelForVelocity` on
          // the direct-line vector to the local player. This
          // mirrors `picking.js`'s missile branch and matches
          // ACE's `Creature_Missile.cs::GetAimLevel` server-
          // side dispatch. Melee stances keep the existing
          // CMT lookup. RANGED_STANCES set defined above at
          // line ~1949 (shared with `isInRangedStance`).
          let resolvedMotion = null;
          // WS07 (2026-07-12): remote cast gestures render entirely
          // via the UpdateMotion path — windups arrive as
          // KIND_MOTION_ACTION (Action-class 0x10) → `_armMotionAction`
          // and the final 0x40 gesture as KIND_MOTION → `_armMotion`,
          // both routing through `setMotion`'s `cls === "cast"` branch
          // → `_tryPlayLink(Magic, Ready, fullCmd)`. This
          // `dispatchRemoteSwing` reaction (a `damageTaken` /
          // `evadedAttacker` melee echo) has NO role for magic.
          // `setCastPose` (the both-arms-up vibe-pose one-shot) was
          // retired to a no-op 2026-06-18 (see entities.js) — the old
          // `typeof em.setCastPose === "function"` guard was already
          // false (the method is `undefined`), so the guarded call was
          // dead; removed. The early `return` STAYS and is
          // LOAD-BEARING: without it a Magic-stance attacker falls
          // through to the melee `getCombatManeuver` branch below and
          // would dispatch a sword-swing maneuver on a caster.
          if (MAGIC_STANCES.has(stance)) {
            return;
          }
          if (RANGED_STANCES.has(stance)) {
            // Attacker world position from EntityInstance
            // root (already in AC world frame per
            // `entities.js setPose` — see `scene3d/picking.js`
            // `entityAcPosition` docstring for the convention).
            const inst = em.entityMap?.get((g >>> 0));
            const attackerPos = inst?.root?.position ?? null;
            // Local player pose: landblock-local + landblockId.
            // Convert to AC world frame the same way
            // `playerWorldPose` does in picking.js (LB origin
            // at `(lbX * 192, lbY * 192)`).
            // Copy-then-free: wasm-bindgen LocalPlayerPose box.
            // Fires once per incoming damageTaken/evadedAttacker,
            // so an unfreed box here orphans one per hit taken.
            const lp = handle?.getLocalPlayerPose?.();
            try {
              if (attackerPos && lp) {
                const lbId = (lp.landblockId ?? 0) >>> 0;
                const lbX = (lbId >>> 24) & 0xff;
                const lbY = (lbId >>> 16) & 0xff;
                const lx = lp.x + lbX * 192;
                const ly = lp.y + lbY * 192;
                const lz = lp.z;
                const v = {
                  x: lx - attackerPos.x,
                  y: ly - attackerPos.y,
                  z: lz - attackerPos.z,
                };
                resolvedMotion = getAimLevelForVelocity(v);
                try { window.__diag?.combat?.onAimLevel?.({ scope: "remote", motion: resolvedMotion }); } catch (_) {}
              }
            } finally {
              lp?.free?.();
            }
          } else {
            const weapon = em.getEquippedWeapon?.(g) ?? null;
            const inferred = inferAttackTypeForWeapon(weapon);
            // Wave 1's mapping returns Undef for ranged / caster /
            // shield-only — those are out of scope for this CMT
            // dispatch (Phase 6 handles ranged via picking.js,
            // magic uses CastTargeted/CastUntargeted not CMT).
            // For melee, default to Slash when the inference
            // can't make a positive call so the remote attacker
            // still gets a swing clip rather than nothing.
            const attackType = (inferred === ATTACK_TYPE.Undef)
              ? ATTACK_TYPE.Slash
              : inferred;
            const ATTACK_HEIGHT_MEDIUM = 2;
            resolvedMotion = getCombatManeuver(
              stance,
              ATTACK_HEIGHT_MEDIUM,
              attackType,
              0.5,
            );
          }
          if (resolvedMotion && typeof em.setSwingMotion === "function") {
            em.setSwingMotion(g, resolvedMotion);
          } else if (typeof em.setSwingPose === "function") {
            em.setSwingPose(g);
          }
        };
        if (eventName === "damageTaken" && payload.attackerName) {
          dispatchRemoteSwing(payload.attackerName);
        } else if (eventName === "evadedAttacker" && payload.attackerName) {
          // Their swing missed — still show the wind-up so
          // the player sees something happened on their end.
          dispatchRemoteSwing(payload.attackerName);
        }
      }
    } catch (e) {
      console.warn(`[combat-event] bad JSON: ${e?.message ?? e}`);
    }
  } else if (evt.kind === ClientEventKind.CHARACTER_LIST_RECEIVED) {
    // Re-fired CharacterListReceived (e.g. after CharacterCreate
    // / CharacterDelete round-trip). Step 2a doesn't act on
    // these; logging keeps the contract observable.
    // eslint-disable-next-line no-console
    console.log(`[step 2a] CharacterListReceived re-fire — count=${evt.u32Payload}`);
  }
  // evtGuard catch (see the `try {` at the top of this loop).
  } catch (__evtErr) {
    if (!EVT_GUARD_ON) throw __evtErr;
    const __st = window.__evtGuardStats;
    if (__st) {
      __st.catches++;
      const __k = String(evt?.kind);
      __st.byKind[__k] = (__st.byKind[__k] || 0) + 1;
      __st.last = {
        kind: evt?.kind,
        msg: String(__evtErr?.message ?? __evtErr),
        ts: Date.now(),
      };
      // Warn once per kind so a per-frame repeat can't flood.
      if (__st.byKind[__k] === 1) {
        // eslint-disable-next-line no-console
        console.warn(
          `[evtGuard] ClientEvent kind=${__k} handler threw (rest of batch preserved):`,
          __evtErr,
        );
      }
    }
  } finally {
    // ClientEvent is a wasm-bindgen box (it carries an owned
    // Rust String in `stringPayload`), exactly like the
    // EntityUpdate freed at the tail of the entity drain below.
    // `finally` so the free also covers the paths that leave the
    // iteration early: the kind=4 `return STOP_PUMP`, the kind=61
    // early `return`, and the `?evtGuard=off` rethrow above.
    // Verified no consumer retains the box past this point —
    // both taps at the loop head normalize to a plain object
    // synchronously (scene3d/diag/wire.js recordFromEvent,
    // rynth/webhost.js _dispatchEvent), and no handler captures
    // `evt` in an async closure.
    evt.free?.();
  }
}
