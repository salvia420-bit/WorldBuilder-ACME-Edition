// RynthControlChannel — remote bot control over in-game chat/tells.
//
// The RynthCoreHost `InvokeChatParser` + push-event plane, put to work:
// an owner sends the bot a tell ("<prefix> pause", "<prefix> status"),
// the bot parses it off the ChatReceived push events (kind=2) and acts +
// replies. This is the report-04 push plane's first real consumer and
// the seam's WriteToChat/InvokeChatParser exercised end to end.
//
// Chat lines arrive wasm-preformatted; the tell shape is
//   `<Sender> tells you, "<body>"`
// (src/chat_format.rs format_tell). We match that, extract the body,
// and dispatch a command if it starts with `prefix`.
//
// SELF-TELLS (2026-10-12): since R-chat (2026-10-08, retail
// Handle_Communication__HearDirectSpeech) a tell to yourself renders as
//   `You think, "<body>"`
// — no name. That is exactly the line an operator at the bot's own chat bar
// produces with `/t <botname>, !bot pause`, and the channel's DEFAULT owner IS
// the logged-in character, so the default configuration had silently lost its
// only working sender. A "You think" line can only come from this session
// (ACE's tell carries the sender guid; sender == target), so it is accepted
// as the character itself and always authorized; replies to it are printed
// locally (WriteToChatWindow) instead of being told back to ourselves.
//
// Replies go out as a direct tell (host.SendTell → wasm sendTell, 2026-10-12)
// whenever the host has it. The old `/t <name>, <text>` InvokeChatParser path
// is kept only for hosts without the capability (a stale pkg/ or a node test
// fake): on a page without the slash router it falls through to sendChat — a
// plain Talk, i.e. the reply would be said aloud.
//
// Hardening:
// - SENDER ALLOWLIST (report 13 P0, fixed 2026-07-23): commands are refused
//   entirely unless the sender resolves as an owner. opts.owner (a name
//   string or an array of names) wins when set; otherwise the channel
//   defaults, per dispatch, to the logged-in character's own name (the
//   account this bot IS — host.GetPlayerId()+TryGetObjectName()). A null/
//   unresolvable owner means REFUSE EVERYONE, never "obey everyone" — the
//   prior behavior let any player on the ACE server drive the live-stream
//   bot via `/tell <botname> !bot pause|goto|ai off`. An unauthorized sender
//   gets one "unauthorized" reply per session (see _unauthorizedLogged),
//   not silence and not a reply per attempt.
// - Replies are rate-limited per sender (REPLY_MAX_PER_WINDOW per
//   REPLY_WINDOW_MS); excess replies are logged and dropped, so a
//   command-spamming sender can't use the bot as a chat amplifier.
// - "goto" args must be finite /loc degrees within the map (|deg| <=
//   MAX_LOC_DEG) — "goto 1e309 -0" gets the usage reply, not a route.
// - A "goto" while one is already routing gets a clean
//   "route failed: goto already active" reply (bot.js's goto latch);
//   the in-flight goto is unaffected.
// - "come" routes through bot.js's onCome hook (bot.travel — a guarded,
//   single-leg router walk that stops+restores the kernel) instead of a raw
//   host.MoveToPosition with the kernel untouched (report 01 C2): previously
//   the same command was clobbered ~100ms later while grinding (the kernel
//   re-issuing its own StickTo/MoveToPosition every tick) and unguarded while
//   idle — same command, two different outcomes. A missing onCome (channel
//   built standalone, e.g. a test harness with no bot.js) falls back to the
//   old raw move so this file still works import-free.
// - "pause"/"resume" are the operator's single stop authority over the
//   grind kernel (report 01 C1 / 13 C3): pause latches kernel.js's
//   operator-hold (refusing even the director's own `resume` action) and
//   stops the AI director's check-in timer; resume clears the hold and
//   restarts the director only if it was running before the pause. `status`
//   reads kernel.operatorHeld live, so `[PAUSED]` can never go stale.
//   2026-10-12: when bot.js wires opts.getControl (() => bot.control, the
//   ai/operator_stop.js OperatorControl the HUD's RUNNING/STOPPED button also
//   drives), pause/resume/status go through it instead — one stop authority
//   for chat, HUD and console. Behaviour change: `!bot pause` now PERSISTS
//   across reconnect/reload reboots (the bot-wide latch), like `!bot ai off`.
//   While paused, `goto` / `come` are refused ("paused — resume first").
// - "ai on"/"ai off" route through the durable operator_stop.js latch
//   (report 13 C2) so an AI stop survives a session-takeover reconnect;
//   "ai now" and the director's own checkNow() both refuse while latched.
//   Reached via a lazy dynamic import (_opStop below), NOT a static one —
//   this file is loaded standalone by test harnesses that stage a flat copy
//   of rynth/*.js without the ai/ subdirectory (rynth_navsim_test.cjs,
//   rynth_explorer_survival_test.cjs); bot.js itself never statically
//   imports anything under ai/ for the same reason. A missing/broken module
//   degrades to skipping the durable latch (director.start/stop() still run
//   synchronously) — additive hardening, never a hard dependency.

const CHAT_KIND = 2;
const TELL_RE = /^(.+?) tells you, "(.*)"$/;
const SELF_TELL_RE = /^You think, "(.*)"$/; // src/chat_format.rs format_tell, sender == target
const REPLY_WINDOW_MS = 5000; // per-sender reply rate limit window
const REPLY_MAX_PER_WINDOW = 5;
const MAX_LOC_DEG = 102; // the map spans ~±101.95 /loc degrees

// Cached lazy loader for ai/operator_stop.js — see header note above.
let _opStopMod; // undefined = not yet attempted; null = attempted and unavailable
async function _opStop() {
  if (_opStopMod !== undefined) return _opStopMod;
  try { _opStopMod = await import("./ai/operator_stop.js"); }
  catch { _opStopMod = null; }
  return _opStopMod;
}

export class RynthControlChannel {
  /**
   * @param host RynthWebHost
   * @param kernel RynthBotKernel (paused/resumed by commands)
   * @param opts { prefix="!bot", owner=null (name string OR array of names;
   *               unset -> defaults to the logged-in character, see
   *               _resolvedOwners; unresolvable -> refuse everyone), log,
   *               onGoto=null (async ({ns,ew}) => {ok,...} — bot.js wires
   *               this when config.nav is set),
   *               onCome=null (({lb,x,y,z}) => {ok,...} — bot.js wires
   *               (leg) => bot.travel([leg]); unset -> raw MoveToPosition,
   *               the pre-hardening behavior, see header "come" note),
   *               getAi=null (() => RynthAiDirector|undefined — bot.js wires
   *               () => bot.ai?.director; lazy so the channel can be built
   *               before the AI director exists) }
   */
  constructor(host, kernel, opts = {}) {
    this.host = host;
    this.kernel = kernel;
    this.prefix = opts.prefix || "!bot";
    this._configuredOwner = opts.owner ?? null; // explicit override; see _resolvedOwners for the default
    this.onGoto = opts.onGoto || null; // global-nav hook ("goto <ns> <ew>")
    this.onCome = opts.onCome || null; // guarded-mover hook ("come" — report 01 C2)
    this.getAi = opts.getAi || null; // lazy AI-director hook ("ai ...")
    this.getControl = opts.getControl || null; // () => OperatorControl (bot.control) — pause/resume authority
    this.log = opts.log || ((m) => console.log(`[ctl] ${m}`));
    this.commands = [];
    this._directorWasEnabledBeforePause = false; // resume restarts the director only if pause stopped it
    this._replyLog = new Map(); // sender -> recent reply timestamps (anti-spam)
    this._unauthorizedLogged = new Set(); // sender -> already told "unauthorized" this session
    this._selfSenders = new Set(); // names a self-tell ("You think, …") resolved to — replies print locally
    host.onEvent((e) => this._onEvent(e));
  }

  // Allowed sender names for THIS dispatch, or [] to refuse everyone. A
  // configured owner (string or array) always wins; otherwise resolved live
  // from the host (not cached at construction — bot.js builds the channel
  // before host.start(), so the snapshot GetPlayerId() reads may not be
  // populated yet; a dispatch after boot resolves fine).
  _resolvedOwners() {
    if (this._configuredOwner != null) {
      return Array.isArray(this._configuredOwner) ? this._configuredOwner : [this._configuredOwner];
    }
    const me = this._selfName();
    return me ? [me] : [];
  }

  // The logged-in character's name, or null when it can't be resolved yet.
  _selfName() {
    try {
      const selfGuid = this.host.GetPlayerId ? this.host.GetPlayerId() : 0;
      const name = selfGuid ? this.host.TryGetObjectName(selfGuid) : null;
      return name || null;
    } catch {
      return null;
    }
  }

  _isAllowed(sender) {
    return this._resolvedOwners().includes(sender);
  }

  _control() {
    try {
      return this.getControl ? this.getControl() : null;
    } catch {
      return null;
    }
  }

  // `paused` is derived LIVE — from the OperatorControl when wired (any stop
  // route: HUD, chat, persisted latch), else from the kernel's operator-hold
  // latch — never a locally-tracked flag, so `!bot status` can't go stale
  // relative to what actually un-paused or re-paused the bot (report 01 C1 /
  // 13 C3).
  get paused() {
    const c = this._control();
    if (c && typeof c.isStopped === "function") {
      try {
        return c.isStopped() === true;
      } catch {
        /* fall through to the kernel latch */
      }
    }
    return !!(this.kernel && this.kernel.operatorHeld);
  }

  _onEvent(e) {
    if (e.kind !== CHAT_KIND || !e.text) return;
    let sender;
    let body;
    let isSelf = false;
    const m = TELL_RE.exec(e.text);
    if (m) {
      [, sender, body] = m;
    } else {
      const s = SELF_TELL_RE.exec(e.text);
      if (!s) return;
      body = s[1];
      sender = this._selfName() || "You";
      isSelf = true;
    }
    const trimmed = body.trim();
    if (!trimmed.toLowerCase().startsWith(this.prefix.toLowerCase())) return;
    if (isSelf) this._selfSenders.add(sender);
    if (!isSelf && !this._isAllowed(sender)) {
      // Unauthorized: reply once per sender per session (not per attempt —
      // the reply-rate-limiter above caps REPLY volume, not whether a
      // command runs, so without this early refusal any player could still
      // drive the bot). See header "SENDER ALLOWLIST".
      if (!this._unauthorizedLogged.has(sender)) {
        this._unauthorizedLogged.add(sender);
        this._reply(sender, "unauthorized");
      }
      this.log(`unauthorized ${this.prefix} attempt from ${sender}`);
      return;
    }
    const rest = trimmed.slice(this.prefix.length).trim();
    const [cmd, ...args] = rest.split(/\s+/);
    this.commands.push({ sender, cmd: (cmd || "").toLowerCase(), args, at: Date.now() });
    this._dispatch(sender, (cmd || "").toLowerCase(), args);
  }

  _reply(sender, text) {
    // Anti-spam: cap replies per sender per window; excess replies are
    // logged and DROPPED (not queued) — see header.
    const now = Date.now();
    const recent = (this._replyLog.get(sender) || []).filter((t) => now - t < REPLY_WINDOW_MS);
    if (recent.length >= REPLY_MAX_PER_WINDOW) {
      this._replyLog.set(sender, recent);
      this.log(`reply to ${sender} throttled: ${text}`);
      return;
    }
    recent.push(now);
    this._replyLog.set(sender, recent);
    // Self-tell: print locally — a tell to ourselves would only echo back as
    // another "You think" line.
    if (this._selfSenders.has(sender) && typeof this.host.WriteToChatWindow === "function") {
      if (this.host.WriteToChatWindow(`[${this.prefix}] ${text}`)) return;
    }
    // A direct tell back to the sender (see the header REPLIES note).
    const h = this.host;
    if (typeof h.has === "function" && h.has("SendTell") && typeof h.SendTell === "function") {
      if (h.SendTell(sender, text)) return;
    }
    // Legacy lane for a host without sendTell: the routed `/t <name>, <text>`
    // chat-bar command (InvokeChatParser tries window.__routeSlashCommand
    // first, then sendChat).
    h.InvokeChatParser(`/t ${sender}, ${text}`);
  }

  _dispatch(sender, cmd, args) {
    switch (cmd) {
      case "status": {
        const s = this.kernel.status;
        const buffs = s.buffs ? `${s.buffs.active}/${s.buffs.desired}` : "n/a";
        this._reply(sender, `action=${s.action} kills=${s.kills} looted=${s.looted} buffs=${buffs} ${this.paused ? "[PAUSED]" : ""}`);
        break;
      }
      case "pause": {
        const ctl = this._control();
        if (ctl && typeof ctl.stop === "function") {
          // OperatorControl: kernel hold + director stop + movement halt +
          // the persisted bot-wide latch, in one place (see header).
          try {
            ctl.stop({ reason: `!bot pause from ${sender}` });
            this._reply(sender, "paused");
          } catch (e) {
            this._reply(sender, `pause failed: ${(e && e.message) || e}`);
          }
          this.log(`${sender}: pause`);
          break;
        }
        // Single stop authority (report 01 C1 / 13 C3): latch the kernel's
        // operator hold (refuses even the director's own `resume` action)
        // AND stop the director's check-in timer, so a scheduled check-in
        // can't un-pause the bot or spend an LLM call while paused.
        this.kernel.holdForOperator();
        this.host.StopCompletely();
        let director = null;
        try { director = this.getAi ? this.getAi() : null; } catch { director = null; }
        this._directorWasEnabledBeforePause = !!(director && director.enabled);
        if (this._directorWasEnabledBeforePause) director.stop();
        this._reply(sender, "paused");
        this.log(`${sender}: pause`);
        break;
      }
      case "resume": {
        const ctl = this._control();
        if (ctl && typeof ctl.resume === "function") {
          try {
            const st = ctl.resume();
            this._reply(sender, st && st.stopped ? "resume refused (still held)" : "resumed");
          } catch (e) {
            this._reply(sender, `resume failed: ${(e && e.message) || e}`);
          }
          this.log(`${sender}: resume`);
          break;
        }
        this.kernel.releaseOperatorHold();
        this.kernel.start();
        let director = null;
        try { director = this.getAi ? this.getAi() : null; } catch { director = null; }
        if (director && this._directorWasEnabledBeforePause) director.start();
        this._directorWasEnabledBeforePause = false;
        this._reply(sender, "resumed");
        this.log(`${sender}: resume`);
        break;
      }
      case "come":
        // Walk to the sender if they're a nearby tracked entity.
        if (this.paused) {
          this._reply(sender, "paused — resume first");
          break;
        }
        this._comeToSender(sender);
        break;
      case "goto": {
        if (this.paused) {
          this._reply(sender, "paused — resume first");
          break;
        }
        // "goto <ns> <ew>" — /loc degrees (floats), routed via the RynthNav
        // sidecar when bot.js wired an onGoto (config.nav).
        const ns = parseFloat(args[0]);
        const ew = parseFloat(args[1]);
        if (!Number.isFinite(ns) || !Number.isFinite(ew) || Math.abs(ns) > MAX_LOC_DEG || Math.abs(ew) > MAX_LOC_DEG) {
          this._reply(sender, `usage: goto <ns> <ew> (/loc degrees, |deg| <= ${MAX_LOC_DEG})`);
          break;
        }
        if (!this.onGoto) {
          this._reply(sender, "goto unavailable — nav not configured");
          break;
        }
        this._reply(sender, `goto ${ns.toFixed(2)}ns ${ew.toFixed(2)}ew — routing`);
        this.log(`${sender}: goto ${ns} ${ew}`);
        Promise.resolve(this.onGoto({ ns, ew }))
          .then((r) =>
            this._reply(
              sender,
              r && r.ok ? `arrived (${r.legsWalked} legs, ${r.replans} replans)` : `route failed: ${(r && r.error) || "?"}`
            )
          )
          .catch((e) => this._reply(sender, `route failed: ${e.message}`));
        break;
      }
      case "ai": {
        // "ai status|on|off|now" — the LLM director (rynth/ai/SPEC.md §Wiring).
        let director = null;
        try {
          director = this.getAi ? this.getAi() : null;
        } catch { director = null; }
        const sub = (args[0] || "status").toLowerCase();
        if (!director) {
          this._reply(sender, sub === "status" ? "ai off" : "ai unavailable — no key/config (rynth/ai/README.md)");
          break;
        }
        switch (sub) {
          case "status": {
            const s = director.status;
            const next = s.nextCheckAt ? `${Math.max(0, Math.round((s.nextCheckAt - Date.now()) / 60000))}m` : "-";
            this._reply(
              sender,
              s.enabled
                ? `ai on calls=${s.calls} errs=${s.consecutiveErrors} next=${next}${s.lastSummary ? ` | ${String(s.lastSummary).slice(0, 80)}` : ""}`
                : "ai off"
            );
            break;
          }
          case "on":
            // Durable latch (report 13 C2): clear it BEFORE start() so a
            // stop set via this same channel (or window.rynthAI.stop())
            // doesn't resurrect on the next reconnect reboot despite `on`.
            // Dynamic import (see _opStop) — a missing module just skips the
            // latch clear; start() below is unconditional either way.
            _opStop().then((m) => { try { m?.clearOperatorStop(); } catch {} });
            director.start();
            this._reply(sender, "ai on");
            this.log(`${sender}: ai on`);
            break;
          case "off":
            // Durable latch (report 13 C2): without this, `!bot ai off`
            // stopped only the in-memory loop — a session-takeover reconnect
            // rebuilt a fresh, running director (the exact 11h-credit-burn
            // bug operator_stop.js was written to fix, re-opened for chat).
            _opStop().then((m) => { try { m?.latchOperatorStop(); } catch {} });
            director.stop();
            this._reply(sender, "ai off");
            this.log(`${sender}: ai off`);
            break;
          case "now":
            // Refuse while disabled or durably latched (report 10 #1) —
            // checkNow() itself also refuses on the latch (statically
            // imported there, always available — see director.js), so this
            // is a friendlier reply, not the enforcement boundary; a missing
            // module here just fails open to that inner guard.
            _opStop().then((m) => {
              let latched = false;
              try { latched = !!m?.isOperatorStopLatched(); } catch { latched = false; }
              if (!director.enabled || latched) {
                this._reply(sender, "ai off — check-in refused");
                return;
              }
              // Fire-and-forget: checkNow() never rejects (director
              // contract); the catch is belt-and-braces so a chat command
              // can't crash.
              Promise.resolve(director.checkNow()).catch(() => {});
              this._reply(sender, "ai check started");
              this.log(`${sender}: ai now`);
            });
            break;
          default:
            this._reply(sender, "usage: ai status | on | off | now");
        }
        break;
      }
      default: {
        const extra = args.length ? ` (args: ${args.join(" ")})` : "";
        this._reply(sender, `unknown cmd '${cmd}'${extra} — try: status | pause | resume | come | goto | ai`);
      }
    }
  }

  _comeToSender(sender) {
    const h = this.host;
    for (const g of h.NearbyGuids()) {
      if (h.TryGetObjectName(g) === sender) {
        const pos = h.TryGetObjectPosition(g);
        if (pos) {
          // Guarded mover (report 01 C2 fix): onCome (bot.travel under the
          // hood) stops the kernel for the walk and restores it on
          // completion — combat/loot can no longer clobber the come-move
          // mid-grind, and it's no longer unguarded while idle either. Falls
          // back to the raw move only when no onCome is wired (see header).
          if (typeof this.onCome === "function") {
            const r = this.onCome({ lb: pos.objCellId, x: pos.x, y: pos.y, z: pos.z });
            if (!r || r.ok !== true) {
              this._reply(sender, `come refused: ${(r && r.error) || "unavailable"}`);
              return;
            }
          } else {
            h.MoveToPosition(pos.objCellId, pos.x, pos.y, pos.z, true);
          }
          this._reply(sender, "on my way");
          return;
        }
      }
    }
    this._reply(sender, "can't see you nearby");
  }
}

export default RynthControlChannel;
