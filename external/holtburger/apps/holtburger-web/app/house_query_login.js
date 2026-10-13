// app/house_query_login.js — hud-ui-4 (2026-10-13): ask about the player's
// house once at login, as retail does.
//
// Retail CPlayerSystem::InitializePlayer (acclient.c:400740) ends, once per
// player_initialized, with CM_House::Event_QueryHouse() (:400811), right
// after AttemptSendLoginCompleteNotification. That is why gmMapUI's
// "Your House" marker and the House page have the answer from login on.
// ACE answers 0x021E with HouseData (0x0225, you own a house) or HouseStatus
// (0x0226 BadParam, you don't) — Player_House.cs HandleActionQueryHouse — and
// never pushes HouseData by itself (its other callers are buy / rent /
// abandon). Without this query plugins/map-panel.js's house marker
// (playerHouseData) and plugins/house-panel.js stayed empty until someone
// pressed Query House. The wasm HouseStatus arm (src/session/messages/
// game_event.rs) only stores a snapshot, so a character without a house gets
// no chat line from it.
//
// app/client_events.js calls maybeQueryHouseAtLogin() from the kind=7
// EnteredWorld arm. The wasm fires kind=7 on PlayerCreate right after it sends
// LoginComplete, the same order as retail. kind=7 also refires on a death
// respawn, so the query is sent once per SessionHandle (a WeakSet): a respawn
// or a teleport sends nothing, and a relog or session takeover (a new handle)
// asks again.
//
// `?houseQueryAtLogin=off` (or 0 / false) leaves the query to the House
// panel's Query House button.

function params(search) {
  try { return new URLSearchParams(search ?? globalThis.location?.search ?? ""); }
  catch (_) { return new URLSearchParams(""); }
}

/** `?houseQueryAtLogin` — DEFAULT ON; `off` / `0` / `false` disable it. */
export function houseQueryAtLoginEnabled(search) {
  const v = params(search).get("houseQueryAtLogin");
  return !(v === "off" || v === "0" || v === "false");
}

// SessionHandles that already sent their login query (retail's
// player_initialized, per session).
const queriedHandles = new WeakSet();

/**
 * Send `handle.houseQuery()` (GameAction 0x021E) the first time a session
 * enters the world. Returns true when the query went out. No-op for a missing
 * handle, a stale pkg/ without `houseQuery`, a handle that already asked, or
 * `?houseQueryAtLogin=off`. Never throws.
 */
export function maybeQueryHouseAtLogin(handle, search) {
  if (!handle || (typeof handle !== "object" && typeof handle !== "function")) return false;
  if (!houseQueryAtLoginEnabled(search)) return false;
  if (queriedHandles.has(handle)) return false;
  if (typeof handle.houseQuery !== "function") return false;
  // Marked before the send: a closed command channel (the throw below) means
  // the session is gone, so there is nothing to retry.
  queriedHandles.add(handle);
  try {
    handle.houseQuery();
    return true;
  } catch (e) {
    console.warn("[houseQuery] login query failed:", e);
    return false;
  }
}
