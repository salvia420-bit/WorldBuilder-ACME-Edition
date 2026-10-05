// app/slash_commands.js — retail chat-command routing: the sticky tell
// targets (window.__chatLastIncomingTellSender / __chatLastOutgoingTellTarget),
// the retail comma-tell parser, the tell/reply/retell/say alias sets and
// routeSlashCommand(handle, message) (slash command -> wire GameAction, or
// fall-through to sendChat), plus their window.__parseCommaTell /
// window.__routeSlashCommand exposures.
//
// Moved VERBATIM out of index.html's login handler (2026-10-05). index.html
// calls initSlashCommands() once per login at the point this code used to run
// (so the sticky tell targets are reset per session exactly as before); the
// chat form's submit listener stays in index.html and calls the returned
// routeSlashCommand.

export function initSlashCommands() {
  // Phase 4 step 4 — chat send. Dispatches the input field's
  // text through SessionHandle.sendChat (GameAction::Talk).
  // `@`/`/`-prefixed messages route to ACE's command parser;
  // access level enforced server-side. Echoes the local
  // outbound line into the log so the user sees their own
  // message even before ACE rebroadcasts it (which it
  // doesn't always — ACE only echoes Talk back via
  // ChannelBroadcast for channels the player is subscribed
  // to).
  // Two distinct sticky targets, matching retail
  // gmCCommunicationSystem state:
  //   __chatLastIncomingTellSender — name of last player who
  //     sent YOU a tell. Drives `/reply` `/r` `/rp`. Populated
  //     by the kind=2 chat-received drain when chat_type ==
  //     ChatMessageType::Tell (0x03).
  //   __chatLastOutgoingTellTarget — name of last player YOU
  //     sent a tell to. Drives `/retell` `/rt`. Populated
  //     synchronously when a tell is dispatched below.
  // Retail decomp: acclient.c:417665-417906 + 417862-417890.
  window.__chatLastIncomingTellSender = null;
  window.__chatLastOutgoingTellTarget = null;

  // Retail-strict comma parser. acclient.c:417984-418036's
  // DoTell does `_strchr(argv, 44)` (comma) and splits there;
  // on miss it prints "Use comma after the name for targeted
  // chat." We mirror that verbatim so AC veterans see the UX
  // they're used to. Returns { target, message } or null on
  // miss (no comma, empty target, or empty message).
  function parseCommaTell(rest) {
    const commaIdx = rest.indexOf(",");
    if (commaIdx < 0) return null;
    const target = rest.slice(0, commaIdx).trim();
    const msg = rest.slice(commaIdx + 1).trim();
    if (!target || !msg) return null;
    return { target, message: msg };
  }
  window.__parseCommaTell = parseCommaTell;

  // Retail aliased the tell verb five ways (tell/t/send/
  // whisper/w → DoTell). acclient.c:428178-428288.
  const TELL_ALIASES = new Set(["tell", "t", "send", "whisper", "w"]);
  const REPLY_ALIASES = new Set(["reply", "r", "rp"]);
  const RETELL_ALIASES = new Set(["retell", "rt"]);
  // Local speech aliases. Strip the slash-prefix and dispatch
  // through the Talk path. Without this, `/say hi` falls into
  // sendChat() verbatim and ACE shouts back the literal
  // string "/say hi" because ACE's GameActionTalk does not
  // parse client-side slash commands.
  const SAY_ALIASES = new Set(["say", "s"]);

  // Slash-command → wire-opcode router. Retail's client
  // parses these locally and sends the matching GameAction;
  // ACE's GameActionTalk does NOT parse `/`-prefixes (only
  // `@admin` commands). So we have to dispatch the right
  // wasm method ourselves. Returns:
  //   { dispatched: true, ... } if we handled the message,
  //   { dispatched: false }     if caller should fall through
  //                              to sendChat (plain say / @admin)
  function routeSlashCommand(handle, message) {
    // @admin commands stay on the Talk path (ACE parses them
    // server-side from GameActionTalk).
    if (message.startsWith("@")) return { dispatched: false };
    if (!message.startsWith("/")) return { dispatched: false };

    // Parse "/cmd rest..." — cmd is lowercased.
    const sp = message.indexOf(" ");
    const cmd = (sp < 0 ? message.slice(1) : message.slice(1, sp)).toLowerCase();
    const rest = sp < 0 ? "" : message.slice(sp + 1);

    // Tells: `/tell <name>, <msg>` (comma-delimited, retail-
    // strict). Aliases: tell, t, send, whisper, w.
    if (TELL_ALIASES.has(cmd)) {
      const parsed = parseCommaTell(rest);
      if (!parsed) {
        return { dispatched: true, echo: null,
                 error: "Use comma after the name for targeted chat." };
      }
      handle.sendTell(parsed.target, parsed.message);
      window.__chatLastOutgoingTellTarget = parsed.target;
      return { dispatched: true,
               echo: `You tell ${parsed.target}, "${parsed.message}"` };
    }

    // Reply to last incoming teller: `/reply <msg>` (aliases
    // reply, r, rp). acclient.c:417699-417703 — retail keyed
    // off the last teller's character ID. We key off name
    // because our wire path is TellByName (opcode 0x005D);
    // server-side lookup is the same either way.
    if (REPLY_ALIASES.has(cmd)) {
      if (!window.__chatLastIncomingTellSender) {
        return { dispatched: true, echo: null,
                 error: "No one has sent you a tell to reply to." };
      }
      if (!rest.trim()) {
        return { dispatched: true, echo: null,
                 error: `Usage: /${cmd} <message>` };
      }
      const target = window.__chatLastIncomingTellSender;
      handle.sendTell(target, rest.trim());
      window.__chatLastOutgoingTellTarget = target;
      return { dispatched: true,
               echo: `You tell ${target}, "${rest.trim()}"` };
    }

    // Local speech: `/say <msg>` or `/s <msg>`. ACE doesn't
    // parse slash-prefixes server-side, so we strip them
    // client-side and dispatch as a plain Talk. Echo matches
    // the plain-message fall-through ("> msg") since ACE
    // doesn't broadcast Talk back to the sender.
    if (SAY_ALIASES.has(cmd)) {
      if (!rest.trim()) {
        return { dispatched: true, echo: null,
                 error: `Usage: /${cmd} <message>` };
      }
      const msg = rest.trim();
      handle.sendChat(msg);
      return { dispatched: true, echo: `> ${msg}` };
    }

    // Retell to last outgoing target: `/retell <msg>` or
    // `/rt <msg>`. acclient.c:417862-417890 — `@retell` /
    // GetLastTelleeName().
    if (RETELL_ALIASES.has(cmd)) {
      if (!window.__chatLastOutgoingTellTarget) {
        return { dispatched: true, echo: null,
                 error: "You haven't sent a tell yet." };
      }
      if (!rest.trim()) {
        return { dispatched: true, echo: null,
                 error: `Usage: /${cmd} <message>` };
      }
      const target = window.__chatLastOutgoingTellTarget;
      handle.sendTell(target, rest.trim());
      return { dispatched: true,
               echo: `You tell ${target}, "${rest.trim()}"` };
    }

    // Allegiance channels — ChatChannel enum values from
    // crates/holtburger-protocol/src/messages/chat/types.rs.
    // /a /f /p /m /v /co /h
    const CHANNEL_MAP = {
      a:   0x02000000,   // AllegianceBroadcast
      f:   0x00000800,   // Fellow
      p:   0x00002000,   // Patron
      m:   0x00004000,   // Monarch
      v:   0x00001000,   // Vassals
      co:  0x01000000,   // CoVassals
      cv:  0x01000000,   // CoVassals (alt)
      h:   0x00000400,   // Help
    };
    if (CHANNEL_MAP[cmd] != null) {
      if (!rest) {
        return { dispatched: true, echo: null,
                 error: `Usage: /${cmd} <message>` };
      }
      handle.sendChannel(CHANNEL_MAP[cmd], rest);
      const labels = { a: "Allegiance", f: "Fellowship", p: "Patron",
                       m: "Monarch", v: "Vassals", co: "CoVassals",
                       cv: "CoVassals", h: "Help" };
      return { dispatched: true,
               echo: `[${labels[cmd]}] You say, "${rest}"` };
    }

    // Turbine channels (/cg /ct /clfg /crp /society /olthoi).
    // chat_type values come from TurbineChatType in
    // crates/holtburger-protocol/src/messages/chat/turbine.rs:
    //   General=1 Trade=2 Lfg=3 Roleplay=4 Society=5 Olthoi=9.
    // SocietyCelHan/EldWeb/RadBlo (6/7/8) are advertised only
    // to society members — we ship the umbrella /society=5
    // and let ACE return "no channel" if the player isn't in
    // a society.
    const TURBINE_CMDS = { cg: { type: 1, label: "General" },
                           ct: { type: 2, label: "Trade" },
                           clfg: { type: 3, label: "LFG" },
                           crp: { type: 4, label: "Roleplay" },
                           society: { type: 5, label: "Society" },
                           olthoi: { type: 9, label: "Olthoi" } };
    if (TURBINE_CMDS[cmd]) {
      const entry = TURBINE_CMDS[cmd];
      try { handle.sendTurbineChannel(entry.type, rest); }
      catch (e) {
        return { dispatched: true, echo: null,
                 error: `${entry.label}: ${e?.message || e}` };
      }
      return { dispatched: true,
               echo: `[${entry.label}] ${rest}` };
    }

    // Wave 9 Phase 9.3 (movement-animation overhaul,
    // 2026-05-26) — /me <action> wired through GameAction::
    // Emote (sub-opcode 0x01DF). ACE rebroadcasts the text
    // via GameMessageEmoteText (0x01E0); no motion plays —
    // for pose emotes (`/bow`, `/wave`, …) use sendSoulEmote
    // instead (handled below). Retail citation: retail
    // client routes `/me` through CGameAction::SendEmote
    // (acclient.c: ClientCommunicationSystem family).
    if (cmd === "me") {
      const action = rest.trim();
      if (!action) {
        return { dispatched: true, echo: null,
                 error: "Usage: /me <action>" };
      }
      try { handle.sendEmote(action); }
      catch (e) {
        return { dispatched: true, echo: null,
                 error: `/me: ${e?.message || e}` };
      }
      return { dispatched: true, echo: `> ${action}` };
    }

    // Wave 9 Phase 9.3 (2026-05-26) — soul emote slash
    // commands (`/bow`, `/wave`, `/cheer`, `/salute`, etc.).
    // The catalog is DAT-derived (`ChatPoseTable` 0x0E000007,
    // ~303 tokens including aliases per
    // `ace-server/Source/ACE.Server/Entity/SoulEmote.cs`),
    // so we delegate the lookup to `handle.resolveSoulEmote`
    // rather than hard-coding the table here. The wasm
    // resolver returns:
    //   - `pose`: pose name (e.g. "Wave", "BowDeepState")
    //   - `motionFull`: 32-bit MotionCommand for setMotion
    //   - `myEmote` / `otherEmote`: rendered chat text
    //   - `held`: true for State / persistent poses, false
    //     for one-shots
    //
    // Wire path mirrors retail (`~/ac-headers/acclient.c:
    // 425567+`) — client locally invokes the motion via
    // cmdinterp + sends `Communication_SoulEmote` (0x01E1)
    // with the formatted text. ACE rebroadcasts the chat
    // via GameMessageSoulEmote (0x01E2) and lets the
    // client's later `MoveToState` carry the actual motion
    // for remote players. Local prediction here calls
    // setMotion / setSwingMotion directly so the local
    // player sees the animation immediately, mirroring the
    // Wave 1.5 jump-prediction pattern (index.html:7861+).
    //
    // Falls through on unknown token so a typo doesn't get
    // swallowed — the user sees ACE's "Unknown command"
    // when sendChat fires.
    if (typeof handle.resolveSoulEmote === "function") {
      const resolved = handle.resolveSoulEmote(cmd);
      if (resolved) {
        const otherText = resolved.otherEmote;
        const myText = resolved.myEmote;
        const motionFull = resolved.motionFull >>> 0;
        // 1. Wire: send the formatted text via SoulEmote so
        //    nearby players see the chat line.
        try {
          if (otherText) {
            handle.sendSoulEmote(otherText);
          } else {
            // Some catalog entries (very rare) have no
            // ChatEmoteData. Fall back to a bare token-as-
            // message so the wire packet still fires.
            handle.sendSoulEmote(cmd);
          }
        } catch (e) {
          return { dispatched: true, echo: null,
                   error: `/${cmd}: ${e?.message || e}` };
        }
        // 1.5. Wave 9.5 (2026-05-26): broadcast the motion
        //      itself so remote players see the bow / wave /
        //      etc., not just the chat text. Companion to
        //      sendSoulEmote — queues a transient MoveToState
        //      pulse via the cli's MovementSystem. ACE's
        //      RawMotionState.cs ApplyMotion accepts the
        //      embedded MotionCommand via its Action mask
        //      branch and Player_Networking.cs
        //      BroadcastMovement rebroadcasts as
        //      GameMessageUpdateMotion to PVS-visible peers.
        //      Skip when motionFull is 0 (catalog has a
        //      ChatPoseTable entry but no MotionCommand
        //      mapping — rare; fall through to chat-only).
        if (motionFull !== 0
            && typeof handle.broadcastEmoteMotion === "function") {
          try {
            handle.broadcastEmoteMotion(motionFull);
          } catch (_) {
            // Best-effort — the chat text already fired so
            // observers will see the line even if the
            // motion broadcast is rejected (e.g. pre-
            // EnteredWorld which the recv arm drops with a
            // console_log_str).
          }
        }
        // 2. Local prediction: play the motion immediately
        //    on the local player so the user sees their
        //    emote without waiting for a UpdateMotion echo
        //    (the LOCAL player's own MoveToState round-trip
        //    is async; predicting here matches retail's
        //    `cmdinterp` immediate local play at
        //    `~/ac-headers/acclient.c:425567`).
        if (motionFull !== 0) {
          try {
            const em = window.liveScene3d?.entityManager;
            const localGuid = (typeof window.getLocalPlayerGuid === "function")
              ? window.getLocalPlayerGuid()
              : null;
            if (em && localGuid != null) {
              const g = localGuid >>> 0;
              if (resolved.held) {
                // Persistent `*State` pose — looping cycle.
                // setMotion routes through cycle path which
                // calls AnimationCache.get with LoopRepeat
                // semantics; matches Wave 8 STATIONARY_
                // COMMANDS classification (entities.js:322-
                // 338).
                const NONCOMBAT_STANCE = 0x8000003D;
                const stance = (typeof em.getStance === "function"
                  ? em.getStance(g) >>> 0
                  : 0) || NONCOMBAT_STANCE;
                if (typeof em.setMotion === "function") {
                  em.setMotion(g, motionFull, stance);
                }
              } else {
                // One-shot emote (Wave / Cheer / Laugh …).
                // setSwingMotion plays the clip once via
                // LoopOnce; matches Wave 8 EMOTE_COMMANDS
                // classification (entities.js:276-294, all
                // routed as "attack" → setSwingMotion).
                if (typeof em.setSwingMotion === "function") {
                  em.setSwingMotion(g, motionFull);
                }
              }
            }
          } catch (_) {
            // Local prediction is best-effort; the wire
            // packet already fired so the chat side will
            // surface regardless.
          }
        }
        // Echo into local chat. Emote text uses category 4
        // (italic grey) to match retail's gmCCommunication-
        // System's emote rendering class. Empty myText
        // falls back to a generic acknowledgement.
        const echoText = myText
          ? `You ${myText}`
          : `You ${otherText || resolved.pose}`;
        return { dispatched: true, echo: echoText };
      }
    }

    // Unknown slash → treat as a SERVER command (retail
    // accepted `/` and `@` interchangeably as command
    // prefixes; ACE's GameActionTalk only parses `@`). Send
    // `@cmd rest` so `/telepoi holtburg` works and a typo
    // draws ACE's "Unknown command" instead of the player
    // SAYING "/telepoi holtburg" out loud (pre-fix behavior).
    handle.sendChat(`@${cmd}${rest ? ` ${rest}` : ""}`);
    return { dispatched: true, echo: `> @${cmd}${rest ? ` ${rest}` : ""}` };
  }
  window.__routeSlashCommand = routeSlashCommand;
  return { routeSlashCommand };
}
