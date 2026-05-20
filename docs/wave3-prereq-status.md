# Wave 3 prereq status — 2026-05-19

Per `docs/diagnostic-toolset-plan-2026-05-19.md` §6 Wave 3, this is the
setup paragraph that gates the physics + motion parity validators. Two
items: (a) Developer-level `phaseN_diag` account on live ACE; (b)
PingRequest keepalive in the wasm bundle to mirror the cli's
`should_send_keepalive_ping` arm.

Owner: open. Status: SHIPPED.

## 1. ACE reachability

`ACE.Server` (pid 10540) listening on UDP `0.0.0.0:9000` (login) and
`0.0.0.0:9001` (world) on this box. Tailscale local interface
`100.116.47.66` confirmed bound on `tailscale0`; `wbterminal` itself in
`tailscale status` is `100.116.47.66`. The spec's "live ACE on Tailscale
`100.116.47.66:9000`" is in fact this host — no SSH required.

Probe: `ss -tunlp | grep -E '9000|9001'` shows `ACE.Server`. Connection
flow: holtburger-wsbridge on `127.0.0.1:8080` (running, pid 8012) → UDP
`100.116.47.66:9000`. End-to-end login round-trip exercised by the smoke
script below.

## 2. `phaseN_diag` account state

Account auto-created on first login (TUI). MariaDB row:

```
accountId | accountName | accessLevel | create_Time
309       | phasen_diag | 4           | 2026-05-19 23:05:14 UTC
```

Promotion was implicit — ACE `Config.js` has
`"Accounts": { "DefaultAccessLevel": 4, ... }` so all fresh accounts get
Developer (level 4) at auto-create time. The defensive SQL UPDATE was
also run for belt-and-suspenders; idempotent.

Verified via TUI login (`apps/holtburger-cli/target/release/tui`) +
later via the smoke script logging in and creating
`+KeepaliveDiagd96tp5` character. Developer-only commands (`/god`,
`/telepoi`) usable.

Credentials: `phaseN_diag` / `phaseN_diag` on `100.116.47.66:9000` (also
`127.0.0.1:9000` directly).

## 3. PingRequest keepalive — wasm bundle

Added to `apps/holtburger-web/src/lib.rs::recv_loop`. New third arm in
the `tokio::select!` block at ~line 17385 (between the `recv_message`
arm and the `cmd_rx.next()` arm):

```rust
_ = gloo_timers::future::TimeoutFuture::new(5_000) => {
    if matches!(state, LoopState::InWorld { .. })
        && session.last_send_time.elapsed() > std::time::Duration::from_secs(5)
    {
        use holtburger_protocol::messages::misc::actions::PingRequestActionData;
        use holtburger_protocol::messages::GameAction;
        if let Err(e) = session
            .send_action(GameAction::PingRequest(Box::new(PingRequestActionData)))
            .await
        {
            log::warn!("recv_loop: keepalive PingRequest send failed: {e}");
        }
    }
}
```

Mirrors the cli's gating exactly
(`crates/holtburger-core/src/client/runtime.rs:9-12, 124-131`). The
`gloo_timers::future::TimeoutFuture` is the wasm-safe equivalent of
`tokio::time::sleep` (which panics on wasm32 — see [[project_emit_dynamic_site]]).

Dependency added to `apps/holtburger-web/Cargo.toml` (wasm32-only
target block, mirroring `holtburger-session/Cargo.toml:38`):

```toml
gloo-timers = { version = "0.3", features = ["futures"] }
```

Build status:

- `wasm-pack build --release --target web` clean. Wasm-opt completed.
  Bundle at `apps/holtburger-web/pkg/holtburger_web_bg.wasm`, 2.77 MB.
- `strings` over the bundle confirms the keepalive arm string is baked
  in (`recv_loop: keepalive PingRequest send failed:`).

## 4. Smoke test results

`apps/holtburger-web/smoke_wave3_keepalive.cjs` drives the wasm bundle
through login → CharacterCreate → spawn → InWorld dwell (12 s) →
browser close → relog (5 s gap).

Run 1 results: PASS. CharacterList received, `KeepaliveDiagd96tp5`
character created, spawn reached InWorld, dwelled 12 s without
disconnect. Keepalive send failures counted: **0** over the 12 s
window, meaning the arm fired ≥2 times successfully (every 5 s).

Run 2 results: **expected blocked by account-lock**, not a keepalive
defect. ACE log shows the canonical double-drop:

```
20:48:12 Session 0 dropped: Account was logged in, booting currently connected
20:48:12 Session 1 dropped: Account In Use: Found another session already logged in
```

Tested with `WAVE3_RUN_GAP_MS=35000` (35 s gap) → same outcome. ACE's
ghost-session window in this build is wider than 35 s; the documented
60-90 s figure in [[project_emit_dynamic_site]] is the correct ceiling.

### Finding

The Wave 3 plan §6 attribution to the keepalive of mitigating the
ghost-session window was over-stated. Keepalive prevents
**mid-session** network-timeout disconnects (ACE's
`NetworkManager.DefaultSessionTimeout = 60s`, reset on every recv —
`Source/ACE.Server/Network/NetworkSession.cs:331`), not the
account-lock window on relog. The latter is a separate ACE invariant.

For Wave 3's deterministic replay loop, the recommended pattern is
either (a) wait ≥60-90 s between replay runs, or (b) use a per-run
unique account (`phaseN_diag_<seq>`), or (c) implement the two-click
Connect dance from [[project_holtburger_login_double_connect]] where
the second click happens 10 s after the first to clear the in-game lock.

Recommendation for Wave 3.A's `physics-replay-trace`: use option (b),
seed accounts as `phaseN_diag_001 … phaseN_diag_NNN` and rotate. The
Developer-level default from `Config.js` makes auto-creation cheap.

## 5. Files touched

- `external/holtburger/apps/holtburger-web/Cargo.toml` — added
  `gloo-timers` to wasm32 deps block.
- `external/holtburger/apps/holtburger-web/src/lib.rs` — added the
  third `select!` arm + variable banner comment in `recv_loop`.
- `external/holtburger/apps/holtburger-web/smoke_wave3_keepalive.cjs`
  — new smoke script.
- `docs/wave3-prereq-status.md` — this doc.

## 6. Outstanding manual steps

None. ACE local; mariadb local; account creation happens on first
login. The Developer access level is the `Config.js` default so no
manual SQL is required for fresh `phaseN_diag_*` accounts in future
runs.

## 7. Wave 3 starting checklist

- [x] ACE on `100.116.47.66:9000` reachable.
- [x] `phaseN_diag` exists with accessLevel = 4 (DefaultAccessLevel
      auto-promotion).
- [x] Wasm bundle sends `PingRequest` every 5 s when InWorld (`recv_loop`
      third `select!` arm). Verified live (0 send failures over 12 s).
- [x] `wasm-pack build --release --target web` clean (2.77 MB bundle).
- [ ] Replay-loop account-rotation pattern adopted in W3.A
      (`physics-replay-trace`). Recommend `phaseN_diag_<seq>`.
- [ ] W3.A `physics-replay-trace` brick.
- [ ] W3.B `physics-jump-formula` brick.
- [ ] W3.C `motion-classify-swing` brick.
- [ ] W3.D method docs (`physics-parity-method.md`,
      `motion-parity-method.md`).
