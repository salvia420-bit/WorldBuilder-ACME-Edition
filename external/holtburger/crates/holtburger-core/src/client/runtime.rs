use super::*;
use anyhow::Result;
use std::sync::Arc;
use std::time::Duration;
use web_time::Instant;

impl ClientRuntime {
    fn should_send_keepalive_ping(&self, _now: Instant) -> bool {
        matches!(self.state, ClientState::InWorld)
            && self.session.last_send_time.elapsed() > Duration::from_secs(5)
    }

    // A1-O1 (2026-06-11): the body-tracking sync + event observation
    // moved verbatim to `tick_spine.rs` (`sync_remote_body_tracking` /
    // `observe_world_event_for_body_tracking`) so the wasm spine shares
    // one tracking law; these methods now delegate.

    pub(super) fn poll_busy_timeout(&mut self, now: Instant) {
        let Some(pending) = self.active_busy_operation.as_ref() else {
            return;
        };

        if now < pending.deadline {
            return;
        }

        let pending = self
            .active_busy_operation
            .take()
            .expect("busy operation should still exist when timing out");
        self.emit_busy_state_updated();
        self.emit_busy_operation_finished(pending.operation, BusyOperationResult::TimedOut);
    }

    pub(super) fn emit_runtime_body_snapshot(&self) {
        let bodies: Arc<[_]> = self.world.runtime_body_views().into();
        let _ = self
            .client_view_event_tx
            .send(ClientViewEvent::RuntimeBodySnapshot { bodies });
    }

    pub(super) fn sync_server_time(&mut self, server_time: f64, local_time: Instant) {
        let world_events = self.world.set_server_time_sync(server_time, local_time);
        for event in world_events {
            self.handle_world_event(&event);
        }
    }

    pub(super) fn observe_runtime_world_event(&mut self, event: &WorldEvent) {
        super::tick_spine::observe_world_event_for_body_tracking(
            &self.world,
            &mut self.simulation,
            event,
        );
    }

    pub(super) fn handle_runtime_world_event(&mut self, event: &WorldEvent) {
        self.observe_runtime_world_event(event);
        self.emit_world_view_projection(event);
    }

    pub async fn run(&mut self) -> Result<()> {
        self.send_status_event();

        let mut physics_tick = tokio::time::interval(Duration::from_millis(PHYSICS_TICK_MS));
        let mut net_tick = tokio::time::interval(Duration::from_secs(1));
        let mut last_physics_time = Instant::now();

        loop {
            if matches!(self.state, ClientState::Disconnected) {
                break;
            }

            tokio::select! {
                _ = net_tick.tick() => {
                    let now = Instant::now();

                    let _ = self.client_view_event_tx.send(ClientViewEvent::NetPulse {
                        bytes_in: self.session.bytes_in,
                        bytes_out: self.session.bytes_out,
                    });

                    // `self.session.last_recv_time` is `web_time::Instant`
                    // (§8 step 3); `.elapsed()` works on both targets while
                    // `now.duration_since(...)` would be a wasm32 type mismatch.
                    if self.session.last_recv_time.elapsed() > Duration::from_secs(15) {
                        log::warn!("Connection timed out (no data for 15s)");
                        self.state = ClientState::Disconnected;
                        let _ = self.client_view_event_tx.send(ClientViewEvent::Disconnected);
                        self.send_status_event();
                        break;
                    }

                    if self.should_send_keepalive_ping(now) {
                        use holtburger_protocol::messages::misc::actions::PingRequestActionData;
                        self.session
                            .send_action(holtburger_protocol::messages::GameAction::PingRequest(
                                Box::new(PingRequestActionData),
                            ))
                            .await?;
                    }

                    self.poll_busy_timeout(now);
                }
                res = self.session.recv_message() => {
                    use holtburger_session::SessionEvent;
                    match res {
                        Ok(events) => {
                            for event in events {
                                match event {
                                    SessionEvent::Message(msg_data) => {
                                        self.handle_message(&msg_data).await?;

                                        if matches!(self.state, ClientState::Disconnected) {
                                            return Ok(());
                                        }
                                    }
                                    SessionEvent::TimeSync(server_time) => {
                                        self.sync_server_time(server_time, Instant::now());
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            log::error!("Session error: {}", e);
                            self.state = ClientState::Disconnected;
                            self.send_status_event();
                            return Err(e);
                        }
                    }
                }
                Some(cmd) = async {
                    if let Some(rx) = &mut self.command_rx {
                        rx.recv().await
                    } else {
                        None
                    }
                } => {
                    self.handle_command(cmd).await?;
                }
                _ = physics_tick.tick() => {
                    let now = Instant::now();
                    let dt = now.duration_since(last_physics_time).as_secs_f32();
                    let dt_duration = Duration::from_secs_f32(dt.max(0.0));
                    last_physics_time = now;

                    // A1-O1 (2026-06-11): delegate to the canonical tick
                    // spine — `tick_spine::tick_frame` is the single owner
                    // of the movement → world → simulation order (retail
                    // single-spine analog: SmartBox::UseTime,
                    // acclient.c:146256–146316). The per-phase sink
                    // preserves the exact pre-extraction per-event
                    // handling (`handle_runtime_world_event` = observe
                    // body tracking, then project to the view channel),
                    // interleaved BETWEEN phases as before. `state`/`tx`
                    // are snapshotted up front — neither can change inside
                    // a physics tick (no message handling runs here).
                    let view_state = self.state.clone();
                    let view_tx = self.client_view_event_tx.clone();
                    super::tick_spine::tick_frame(
                        now,
                        dt_duration,
                        &mut self.world,
                        &mut self.movement,
                        &mut self.simulation,
                        &mut self.session,
                        |_phase, event, world, simulation| {
                            super::tick_spine::observe_world_event_for_body_tracking(
                                world, simulation, event,
                            );
                            Self::emit_world_view_projection_to(
                                world, &view_state, &view_tx, event,
                            );
                        },
                    )
                    .await?;
                }
            }
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::client::builder;

    #[test]
    fn keepalive_ping_requires_in_world_state() {
        let now = Instant::now();

        let mut connected = builder::build_test_client(ClientState::Connected);
        connected.session.last_send_time = now - Duration::from_secs(6);
        assert!(!connected.should_send_keepalive_ping(now));

        let mut entering_world = builder::build_test_client(ClientState::EnteringWorld);
        entering_world.session.last_send_time = now - Duration::from_secs(6);
        assert!(!entering_world.should_send_keepalive_ping(now));

        let mut in_world = builder::build_test_client(ClientState::InWorld);
        in_world.session.last_send_time = now - Duration::from_secs(6);
        assert!(in_world.should_send_keepalive_ping(now));
    }
}
