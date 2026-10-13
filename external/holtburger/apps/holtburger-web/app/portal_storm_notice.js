// app/portal_storm_notice.js — hud-ui-7 (2026-10-13): the text retail shows
// for the four Misc_PortalStorm* GameEvents (0x02C9-0x02CC), which the wasm
// surfaces as ClientEvent kind=45 PORTAL_STORM (`stringPayload` = state).
//
// Retail ClientUISystem (acclient.c):
//   Handle_Misc__PortalStormBrewing  (:402286) — ECM_UI::SendNotice_DisplayStringInfo(0x1A)
//   Handle_Misc__PortalStormImminent (:402317) — the same, 0x1A
//   Handle_Misc__PortalStormSubsided (:402264) — the same, 0x1A
//   Handle_Misc__PortalStorm         (:402348) — ClientSystem::AddTextToScroll(
//     …, i_logTextType 0, …): a plain chat line. Retail's string ends in "\n";
//     holtburger's chat log is one line per entry, so the newline is dropped.
// Text type 0x1A is the spew box, holtburger's CHAT_CATEGORY.TRANSIENT (9):
// ui/ac_spell_target_compat.js showTransientLine routes it there (and to the
// log only with the "Errors" chat option on). Like a client-side cast
// refusal, the notice also goes to the shared toast surface
// (`clientActionRejected`), so `?spewBox=off` still shows it.
//
// Brewing / Imminent also play PS_PortalStorm on the player in retail — not
// done here. The existing `portalStormChanged` bus event (status-indicators
// screen pulse) is unchanged. Vanilla ACE sends these events only from the
// Developer `@portalstorm` command (DeveloperCommands.cs HandlePortalStorm).

import { CHAT_CATEGORY } from "./chat_log.js";
import { showTransientLine } from "../ui/ac_spell_target_compat.js";

/** Retail strings, verbatim (acclient.c:402264-402367). */
export const PORTAL_STORM_TEXT = Object.freeze({
  brewing: "This area is getting too crowded - a Portal Storm is brewing.",
  imminent: "A Portal Storm is imminent - leave this crowded area!",
  subsided: "The Portal Storm has subsided",
  storm: "The Portal Storm has teleported you away from the crowded area!",
});

/**
 * The notice for a PORTAL_STORM `state`: `{ text, sink: "transient" }` for
 * brewing / imminent / subsided, `{ text, sink: "chat", category: 0 }` for
 * storm, or null for anything else.
 */
export function portalStormNotice(state) {
  const s = String(state ?? "");
  if (s === "storm") {
    return { text: PORTAL_STORM_TEXT.storm, sink: "chat", category: CHAT_CATEGORY.SYSTEM };
  }
  if (s === "brewing" || s === "imminent" || s === "subsided") {
    return { text: PORTAL_STORM_TEXT[s], sink: "transient" };
  }
  return null;
}

/**
 * Show the notice for `state`: a transient line plus `clientActionRejected`
 * on the plugin bus, or a category-0 chat line for the storm itself. Returns
 * the notice, or null when the state has none. Never throws.
 */
export function showPortalStormNotice(state) {
  const notice = portalStormNotice(state);
  if (!notice) return null;
  const w = (typeof window !== "undefined") ? window : null;
  if (notice.sink === "chat") {
    try { w?.__appendChatLine?.(notice.text, notice.category); } catch (_) {}
    return notice;
  }
  try { w?.__pluginClient?.events?.emit?.("clientActionRejected", { message: notice.text }); } catch (_) {}
  showTransientLine(notice.text);
  return notice;
}
