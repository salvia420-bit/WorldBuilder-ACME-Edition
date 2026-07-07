# HANDOFF — full Web-Worker transport port (network keepalive, phase 2)

**Date:** 2026-07-07
**Status:** proposal / not started. Prereq (the keepalive *heartbeat* worker) is DONE and shipped — see "What already shipped" below.
**Owner of this doc:** follow-up to the 2026-07-07 ACE "Network Timeout" fix.

---

## 1. Why this exists

holtburger-web sessions drop from vanilla ACE with `Reason: Network Timeout`. ACE is correct: `DefaultSessionTimeout = 60s` (`Config.js`), reset on **any** inbound client packet, upstream of dispatch (`ace-server/.../Network/NetworkSession.cs:~331`). The client just has to emit *something* every <60s.

The bug was that **every keepalive path ran on the browser main thread**, so it dies when:
- the main thread is **saturated** (long synchronous landblock bake/decode), or
- the tab is **hidden/occluded/headless** and Chrome throttles main-thread `setInterval`/`setTimeout` (≥1s, →1/min after ~5 min hidden, freeze when occluded).

This hits **real backgrounded players** (alt-tabbing) and headless bots alike (historical log: dozens of `Network Timeout` for the test account).

### What already shipped (2026-07-07 — the "option 2" heartbeat fix)
- `scene3d/keepalive_worker.js` + `scene3d/keepalive_worker_client.js` — a dedicated worker whose wall-clock `setInterval` posts ticks that poke `window.__sessionHandle.sendKeepalive()`. Default-on; `?keepaliveWorker=0` escape; transparent fallback to the retained main-thread 2.5s interval if Worker is unsupported/crashes.
- `src/lib.rs`: hoisted the proactive `gloo_timers` ping to a **fixed-cadence** `IntervalStream::new(5_000)` *outside* the recv `select!` loop (previously re-created every iteration → reset by inbound traffic → rarely fired); relaxed both the proactive and `ForceKeepalive` gates from `InWorld` to `InWorld | EnteringWorld` so long portal/dungeon loads aren't left keepalive-less.
- Verified: a session survived **~7.75 min, zero timeouts** with the worker as the sole keepalive; a full cottage purchase drive ran multi-minute without a drop.

### Residual risk this doc closes
The heartbeat still **sends through the main-thread wasm executor** (tick → `postMessage` → `sendKeepalive` → recv-loop → `ws.send`). It beats hidden-tab *timer throttling* (the dominant real-player case — an idle hidden main thread still wakes to service a posted message). It does **NOT** survive a **fully frozen / 100%-saturated main thread**: if the executor never runs, the posted message is never serviced and no packet goes out. The robust fix is to move the socket + the `Session` state machine off the main thread entirely.

---

## 2. Current architecture (what couples us to the main thread)

Everything network lives in the **main-thread wasm instance**:

| Piece | Location |
|---|---|
| `Transport` trait (wasm variant is `!Send`, single-threaded) | `crates/holtburger-session/src/session/types.rs:~41` (also native `Send+Sync` variant `:34`, `impl … for UdpSocket`, `MockTransport`) |
| `WsTransport` (owns `web_sys::WebSocket` + JS callbacks) | `crates/holtburger-transport-ws/src/transport.rs:~71` (`struct WsTransport`), `impl Transport … :~270`, `ws.send_with_u8_array :~281`; framing in `frame.rs` |
| `Session` state machine — sequencing, CRC, ACK/retransmit, login+world flows | `crates/holtburger-session/src/session/` |
| Recv loop (`spawn_local`), keepalive arms, command dispatch | `apps/holtburger-web/src/lib.rs` — `spawn_local` `~33185`, loop def `~35208`, `tokio::select!` `~35669`; keepalive arm `~41729`, `ForceKeepalive` `~41760`, `sendKeepalive` export `~30205` |
| ACK/flush send path | `crates/holtburger-session/src/.../send.rs` (`queue_ack`, `flush_pending_control_packets`, `send_raw_packet`) and `receive.rs` `finalize_ordered_server_packet` |
| Inbound drain into the scene (NOT a keepalive) | `scene3d/index.js:~637-651` (`netDrainHz` interval → `window.__netFramePump()` = `poll_events` + entity/streaming drain) + watchdog `~2180+` |
| Main-thread keepalive heartbeat (the shipped fix) | `scene3d/keepalive_worker*.js` + `index.html:~5205` |

The `SessionHandle` (wasm-bindgen object on `window.__sessionHandle`) exposes the whole game API (`buyHouse`, `useObject`, `sendChat`, movement, the `player*` getters). All of it currently executes on the main thread.

**Precedent to copy:** the bake pipeline already runs a second wasm instance in a worker — `scene3d/bake_worker.js` + `bake_worker_client.js`, which `init`s its own wasm and holds its own `init_resource_source(manifest)`. Study its module init, message protocol, and fallback handling; the transport worker should mirror its shape.

---

## 3. Target architecture

A **dedicated `net_worker`** owns the socket and the `Session` state machine end to end:

```
main thread (render/scene/UI, three.js)          net_worker (own wasm instance)
  SessionHandle (thin shim)                          WsTransport (web_sys::WebSocket)
   ├─ buyHouse/useObject/sendChat/move ──postMessage──▶ Session (seq/CRC/ACK/retransmit)
   │                                                    keepalive timer (worker setInterval)
   └─ poll_events()/entity pipeline ◀──postMessage──── decoded GameEvents / pose updates
```

- The worker runs its own `setInterval`/executor → **not** throttled by a hidden tab and **not** blocked by main-thread bake/decode. Keepalive and ACKs keep flowing even if the main thread is frozen.
- Outbound: main-thread `SessionHandle` methods become message senders (`postMessage({cmd, args})`); the worker translates to `Session` calls.
- Inbound: the worker decodes packets → `Session` produces events → `postMessage` (Transferable `ArrayBuffer`s for zero-copy) to the main thread, which feeds the **existing** `poll_events`/entity/streaming pipeline. `netDrainHz` becomes the worker→main message-drain cadence.

---

## 4. Incremental plan (land in phases; keep it bootable each step)

**Phase 0 — clean the boundary (main-thread only, no behavior change).**
Introduce an internal command/event enum between `SessionHandle` (API surface) and the `Session`/recv-loop layer, so the network layer talks only in serializable messages. This makes the physical move mechanical and is independently shippable/testable.

**Phase 1 — stand up the worker + its wasm.**
New `scene3d/net_worker.js` + `net_worker_client.js` (mirror `bake_worker*`). Worker `init`s its own wasm and constructs `WsTransport` + `Session` there. Wire the login **and** world flows (login session precedes world — the worker must own both, or hand off cleanly).

**Phase 2 — route commands & events over postMessage.**
Main-thread `SessionHandle` methods → `postMessage` commands. Worker → decoded events/pose deltas → main thread → existing `poll_events` pipeline. Prefer Transferable `ArrayBuffer`s; only reach for `SharedArrayBuffer` + a ring buffer if message latency hurts movement (SAB needs **COOP/COEP** headers — update `scripts/serve.py` and prod serving; call this out early).

**Phase 3 — subsume the heartbeat, handle lifecycle.**
The `keepalive_worker` heartbeat becomes redundant (keepalive now lives with the socket in the net_worker); keep the `?keepaliveWorker` flag as a fallback path. Implement reconnect, clean logoff (currently the client just drops the WS and ACE holds the UDP session for 60s → re-login inside that window = "Account In Use"), and worker-crash fallback.

**Phase 4 — verify (below).**

---

## 5. Verification (the point of the whole exercise)

The new, decisive test the heartbeat fix could NOT pass:
- **Frozen-main-thread endurance:** after in-world, block the main thread hard for ~90s (`evaluate_script` a `const t=Date.now(); while(Date.now()-t<90000){}` busy-loop) and confirm the session does **NOT** log `Network Timeout` in `ACE_Log.txt` — the worker must keep ACKing/pinging through the freeze. (Pre-fix and post-heartbeat both FAIL this; the worker transport must PASS.)
- **Functional parity:** login → spawn → move (WASD) → `useObject` a slumlord → `buyHouse` → chat all still work, events/poses still render, no ordering regressions.
- **Real-play:** backgrounded tab for >5 min survives; reconnect after network blip; clean logoff releases the ACE session promptly.
- Harness note: the chrome-devtools MCP tab is CDP-attached, which **suppresses** background timer throttling — so *backgrounding* alone won't reproduce the throttle under MCP. Use the busy-loop freeze (above) to exercise the saturation path, and test real backgrounding in a non-CDP browser.

Build (memory-constrained laptop, OOM jail):
`env PATH="/home/wbterminal/.cargo/bin:/usr/local/bin:/usr/bin:/bin" capped-build wasm-pack build <app> --target web --out-dir pkg-rel --release` then `rsync -a --delete pkg-rel/ pkg/`. Verify `pkg/*.wasm` ≈ 4.7 MB (release). Serve via `scripts/serve.py` (:8765); load with `?nosw=1` so the service worker doesn't serve a stale bundle. **Do not** run parallel wasm builds (they clobber `pkg/wasm-opt.wasm`).

---

## 6. Risks / open questions

- **Two wasm instances** (net_worker + bake_worker + main) → memory cost on the 8 GB dev laptop. Confirm footprint; the net_worker's wasm can likely be a trimmed feature set (network/session only, no render).
- **Login-vs-world session ownership** — the login session precedes the world session; decide whether the worker owns both or hands the socket over at world entry.
- **Movement latency** — position updates crossing the postMessage boundary each tick; measure. SAB ring buffer is the escape hatch (needs COOP/COEP).
- **`!Send` futures** — fine inside a single-threaded worker, but the module split must not accidentally require `Send`.
- **Big wasm-boundary refactor** — Phase 0's clean command/event boundary is what keeps this safe; don't skip it.

---

## 7. Related
- Keepalive heartbeat fix (this repo, 2026-07-07): `scene3d/keepalive_worker*.js`, `src/lib.rs`, `docs/url-flags.md` (the `?keepaliveWorker` flag).
- Prior perf/lag analysis: `docs/handoff-perf-lag-wireframe-2026-07-04.md` (documents the client-side keepalive starvation and the transport-worker as the intended follow-up).
- ACE side (do NOT edit — vanilla): timeout at `ace-server/.../Network/NetworkSession.cs:~331`, `Config.js` `DefaultSessionTimeout`.
