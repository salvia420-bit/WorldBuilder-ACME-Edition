// app/account_boot.js — ACE's AccountBoot (0xF7DC) as retail shows it.
//
// inventory-session-6 (2026-10-13): retail CPlayerSystem::Handle_AccountBooted
// (acclient.c:400213) formats "You have been booted from Asheron's Call%s."
// (reason, or " for Code of Conduct Violations") and drops to the disconnected
// screen. ACE sends the boot only through Session.Terminate: a wrong password,
// a client-version or DAT mismatch, a forced log-off, the world closing, an
// admin boot. The wasm recv loop (src/session/messages/login.rs) formats the
// line (src/account_boot.rs) and ends the session with ONE kind=4 Disconnected
// event: `stringPayload` = the line, `u32Payload` = 0xF7DC. No other
// Disconnected event carries a `u32Payload`.
//
// Before CharacterList (wrong password, client version) there is no handle to
// drain that event: `start_session` rejects with the same line instead, and
// index.html's login catch records it as `setBootState("error",
// "start_session: <line>")` and shows it through loginFailedStatusHtml().
//
// A boot is terminal: retail never reconnects on its own, and a retry cannot
// fix a bad password, a wrong client or a closed world (and would undo an
// admin's boot). The autoLogin orchestrator (app/auto_login.js) and the
// bot/agent auto-reload (app/client_events.js) stop on it.

import { escapeHtml } from "./dom_utils.js";

/** The kind=4 `u32Payload` marking a server boot (GameOpcode::AccountBoot). */
export const ACCOUNT_BOOT_MARKER = 0xf7dc;

/** Retail's fixed prefix of every boot line (acclient.c:400251). */
export const ACCOUNT_BOOT_PREFIX = "You have been booted from Asheron's Call";

/** True for the kind=4 Disconnected event that ends a session on a boot. */
export function isAccountBootDisconnect(evt) {
  return evt != null && evt.u32Payload != null && (evt.u32Payload >>> 0) === ACCOUNT_BOOT_MARKER;
}

/**
 * loginStatus HTML for index.html's start_session catch. The message is
 * escaped: since a pre-CharacterList boot rejects with the server's reason in
 * it, it is server text. A boot shows retail's line alone, like the kind=4 boot
 * arm (app/client_events.js). The wsbridge/ACE hint only fits a failure where
 * no server answered, so a boot leaves it out.
 */
export function loginFailedStatusHtml(msg) {
  const text = String(msg ?? "");
  if (text.includes(ACCOUNT_BOOT_PREFIX)) {
    return `<span class="fail">[FAIL]</span> ${escapeHtml(text)}`;
  }
  return (
    `<span class="fail">[FAIL]</span> Login failed: <code>${escapeHtml(text)}</code>` +
    ` <span class="hint">Check that holtburger-wsbridge is listening at the configured URL and ACE is up.</span>`
  );
}

/**
 * The boot line that ended the session at or after `since` (ms epoch), or
 * null. Reads the two places a boot lands: `window.__lastDisconnect`
 * (`{ ts, reason, booted }`, set by the kind=4 arm) and, for a boot before
 * CharacterList, the `__bootStateHistory` "error" entry whose message carries
 * the line (start_session's rejection).
 */
export function accountBootSince(lastDisconnect, history, since) {
  if (lastDisconnect && lastDisconnect.booted && lastDisconnect.ts >= since) {
    return String(lastDisconnect.reason || ACCOUNT_BOOT_PREFIX);
  }
  if (Array.isArray(history)) {
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (!entry || entry.ts < since) break;
      if (entry.state !== "error") continue;
      const msg = String(entry.message ?? "");
      const at = msg.indexOf(ACCOUNT_BOOT_PREFIX);
      if (at >= 0) return msg.slice(at);
    }
  }
  return null;
}
