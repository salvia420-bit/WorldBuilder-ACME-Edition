# HANDOFF — transport-in-worker port LANDED (`?netWorker=1`)

**Date:** 2026-07-07
**Status:** Landed behind a default-OFF flag; login→charlist→spawn→InWorld verified through the worker; frozen-main-thread endurance verified (see §4). Follow-up to `HANDOFF-worker-transport-port-2026-07-07.md` (the proposal).

---

## 1. What shipped

`?netWorker=1` runs the **WebSocket + the entire `holtburger_session::Session` state machine** (ISAAC crypto, packet/fragment sequencing, fragment reassembly, ACK generation, keepalive ping) in a **dedicated Web Worker** on its own wasm instance. The worker loops `session.recv_message()` — which **auto-ACKs every inbound packet** (`session/receive.rs` `queue_ack` + `flush_pending_control_packets`) — and pings ACE on its own wall-clock `IntervalStream` (2.5 s). Both run with **zero main-thread involvement**, so the session survives a fully frozen / 100 %-saturated main thread — the case the shipped `keepaliveWorker` heartbeat (which still routes through the main-thread wasm executor) cannot cover.

Default **OFF**. Transparent fallback to the direct `start_session` if `Worker` is unsupported or the worker fails to spawn.

## 2. Architecture — `RemoteSessionProxy` (NOT a full state move)

The proposal implied moving "the socket + the Session state machine" to a worker, and its §6 flagged the movement-latency and big-refactor risks. The decisive finding during implementation: **the client-side movement/prediction integrator (`SessionCommand::TickMovement`) runs the physics per-rAF on the main thread and mutates the exact `WorldState`/collision/pose cells the render loop reads *synchronously* each frame.** Moving that (and the ~60 `Rc<RefCell>` cells) to a worker would require mirroring the entire render-read surface across an async boundary — the multi-week version.

So only the **raw wire I/O** moved. The main thread keeps the recv loop, the full `GameMessage` dispatch, the `TickMovement` physics, every cell, and every synchronous render read **unchanged**. Its `session` is swapped from a concrete `Session` to a `LoopSession` enum:

```
main thread (recv loop, dispatch, TickMovement)     net_worker (own wasm instance)
  LoopSession::Proxy(RemoteSessionProxy)               WsTransport + Session
   ├─ send_action/send_message ─ postMessage(tx) ──▶  session.send_action/send_message
   │                                                  IntervalStream keepalive → PingRequest
   └─ recv_message() ◀── postMessage(rx bytes) ─────  session.recv_message() (auto-ACKs)
```

- **Outbound** crosses as the EXISTING wire codec — the proxy `ProtocolPack`s a `GameMessage` (for an action: `GameMessage::GameAction(GameActionMessage{sequence:0, action})`; the worker's own `send_action` re-assigns `game_action_sequence`), the worker `ProtocolUnpack`s it. **No new serde.**
- **Inbound** crosses as the raw decrypted/reassembled game-message payload bytes that `Session::recv_message` already yields as `SessionEvent::Message`. Transferable `ArrayBuffer`s (no SAB/COOP-COEP).
- `SessionCommand` / `ClientEvent` / `EntityUpdate` **never cross** — they stay main-thread — so the serialization-hardening the proposal implied was unnecessary.
- Movement outbound (`MoveToState`/`Jump`/`AutonomousPosition`) reaches the wire through the new **`holtburger_session::ActionSink` trait** (one method, `send_action`), which both `Session` and `LoopSession` implement; the core movement methods now take `&mut dyn ActionSink`. This is the only change to `holtburger-core`.

Blast radius on the 53k-line `lib.rs`: the recv loop body is unchanged except the `session` param type and one `last_send_time` field→method call; `start_session` gained one `if` at its head.

## 3. Files

- **NEW** `src/net_worker.rs` — `RemoteSessionProxy`, `LoopSession`, the worker wasm entry `net_worker_run`, and the `net_worker_arm` / `net_proxy_push_inbound` / `net_proxy_push_disconnect` / `net_worker_submit_outbound` / `net_worker_set_sink` bindings.
- **NEW** `scene3d/net_worker.js` — module worker: init()s its own wasm, wires the wasm's post sink to `self.postMessage`, forwards `{t:'tx'}` into `net_worker_submit_outbound`.
- **NEW** `scene3d/net_worker_client.js` — main-thread client: owns the `Worker`, routes worker→main into `net_proxy_push_*`, provides the outbound sink, arms worker mode + calls `start_session`. `netWorkerEnabled()` reads `?netWorker`.
- `src/lib.rs` — `mod net_worker`, `start_session` direct/proxy gate, `recv_loop` takes `LoopSession`, `last_send_time()`.
- `crates/holtburger-session/src/session/types.rs` + `lib.rs`/`mod.rs` — `ActionSink` trait + `Session` impl + re-export.
- `crates/holtburger-core/src/client/{movement/system.rs,movement/handle.rs,tick_spine.rs,simulation.rs}` — `&mut Session` → `&mut dyn ActionSink`.
- `apps/holtburger-web/Cargo.toml` — `js-sys`, `async-trait` (wasm32 block).
- `index.html` — import + `netWorkerEnabled()` branch at the login submit.
- `docs/url-flags.md` — `netWorker` row.

## 4. Verification

- **Boot parity (worker path):** `?netWorker=1` → login as `phaseN_diag` → character-list rendered → spawn → **InWorld**, 0 console errors. This exercises BOTH directions end-to-end (inbound `CharacterList`/`CharacterEnterWorldServerReady`/`PlayerCreate`; outbound `SelectCharacter` + auto-reply `LoginComplete` + `CharacterEnterWorld`).
- **Frozen-main-thread endurance (the decisive test):** after InWorld, block the main thread with a 90 s busy-loop (via `setTimeout` so the CDP channel isn't blocked). Result: page thawed, **0 new `Network Timeout`** in `ACE_Log.txt`, 0 client disconnects, and **~11.7 KB of new ACE log activity DURING the freeze** — i.e. ACE kept receiving/processing packets from the worker's autonomous ACK+ping while the main thread was dead. A 90 s freeze exceeds ACE's 60 s `DefaultSessionTimeout`, so surviving it is only possible with the socket + Session off the main thread. Reproduced on BOTH the dev bundle (11.7 KB ACE activity during the freeze) and the shipping **release** bundle (4.72 MB wasm; 19.3 KB ACE activity during the freeze) — the ACE-activity-during-freeze IS the mechanism proof: ACE processed inbound packets while the browser main thread was provably dead.
- **Control-arm note:** the `?netWorker=0` control (a 90 s freeze SHOULD time out) could not be cleanly captured back-to-back — every rapid relog collided with ACE's ~60 s ghost-session window (`Account In Use` / "booting currently connected account"), a test-harness timing artifact of running arms seconds apart, not a code issue. The failure mode the control would demonstrate is already established by the proposal doc (pre-fix and heartbeat both fail the freeze) and, more directly, by the ACE-activity-during-freeze above. To capture the control, space runs > 60 s apart.
- **Movement:** the `TickMovement` physics integrator ran in-world against the `RemoteSessionProxy` (`ActionSink` route) with 0 console errors, and spawn itself exercises the outbound `GameAction`/`GameMessage` path end-to-end (`SelectCharacter` + auto-reply `LoginComplete` + `CharacterEnterWorld`). An explicit walk-and-measure position delta was inconclusive in the harness (the `getLocalPlayerPose` wasm object doesn't round-trip through `page.evaluate` cleanly) — fold an in-page `__diag` position probe into the broader functional-parity pass (§5.1).
- Harness: `scratchpad/networker_freeze_test.cjs` (playwright, `--use-gl=swiftshader`, `NODE_PATH` = npx playwright cache).

## 5. Adversarial review + lifecycle hardening (2026-07-07)

A read-only adversarial audit confirmed the **wire semantics are sound** — codec round-trip (`GameMessage`/`GameActionMessage` `pack∘unpack == id`, including `GameAction::Unknown` verbatim re-pack), single-owner `packet_sequence`/ISAAC (the worker's `Session` is only ever touched inside the one `select!`), `recv_message` cancellation safety (a cancelled recv can only drop while the ws frame is still un-dequeued — no game message lost), TimeSync-drop, transferable correctness, and the direct-fallback-unchanged path. It found **lifecycle** bugs (not exercised by a single manual login), now FIXED in the JS bridge (no wasm change; happy path re-verified):

- **[HIGH] Double-connect cross-wiring** — `autoLogin`'s sequential kick-then-reconnect (2 Connects 5.5 s apart) + the single global inbound slot + a never-terminated first worker meant worker1 could post into session2. Fixed: `net_worker_client.js` keeps **one** worker (`_activeWorker`) and `terminate()`s + unbinds the prior one before building the next (also fixes the worker leak).
- **[MED] Worker-init hang / missing fallback** — a worker whose wasm failed to instantiate hung `start_session` forever. Fixed: the worker now inits **eagerly** and posts `{t:'ready'}`/`{t:'error'}`; the client waits for `ready` (12 s timeout) before arming/connecting and **falls back to the direct `start_session`** on error/timeout/supersession.
- **[LOW] Stale `WORKER_ARM`** — `net_worker_arm` is now called immediately before `start_session` with nothing that can throw between (connect is posted first), so no dangling arm can be picked up by a later direct call.

**Still open (LOW, documented):**
- **Finding 4** — `net_worker_submit_outbound` drops if called after wasm `ready` but before `net_worker_run` installs the outbound queue (a connect+login window). Not reachable today (main only sends reactively to inbound, which arrives after the loop starts). Trivial Rust fix: install `WORKER_OUTBOUND_TX` at the TOP of `net_worker_run` before `WsTransport::connect`. Fold into the next wasm rebuild.
- **Finding 6** — the worker's autonomous pings don't stamp the main-thread `PING_SEND_INSTANT`, so `PingResponse` RTT is mis-attributed; and the link-status indicator reads stale during a main-thread freeze (worker is receiving fine). HUD/telemetry only; no wire impact.

## 6. What remains (follow-ups)

1. **Broader functional parity** — login/charlist/spawn/movement-tick verified; still exercise chat, `useObject`, inventory move/split, `buyHouse`, trade under `?netWorker` and diff vs the direct path (fold an in-page `__diag` position probe in — the harness `getLocalPlayerPose` read doesn't round-trip through `page.evaluate`).
2. **Lifecycle** — reconnect after a network blip; clean logoff (today dropping the WS leaves ACE's UDP session for 60 s → "Account In Use" on immediate relog — see the ghost-window collisions in §4); worker-crash → relaunch. `net_proxy_push_disconnect` + terminate-old wire the teardown path but full reconnect is unbuilt.
3. **Memory** — a 3rd full wasm instance (main + bake_worker + net_worker) on the 8 GB box. No `[features]` seam exists to build a render-less net_worker wasm; that trimming is future work.
4. **Movement latency** — outbound actions cross `postMessage` fire-and-forget (ordered, no round-trip), so latency should match the direct path's per-rAF batching; measure walking vs running (ties into the proposal's §8 "slows down while running" open item).
5. **Default-on** — bar: functional parity proven + endurance + a real backgrounded-tab (non-CDP) soak.
