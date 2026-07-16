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
// (src/lib.rs ClientEvent kind=2 doc). We match that, extract the body,
// and dispatch a command if it starts with `prefix`.

const CHAT_KIND = 2;
const TELL_RE = /^(.+?) tells you, "(.*)"$/;

export class RynthControlChannel {
  /**
   * @param host RynthWebHost
   * @param kernel RynthBotKernel (paused/resumed by commands)
   * @param opts { prefix="!bot", owner=null (name allow-list), log,
   *               onGoto=null (async ({ns,ew}) => {ok,...} — bot.js wires
   *               this when config.nav is set) }
   */
  constructor(host, kernel, opts = {}) {
    this.host = host;
    this.kernel = kernel;
    this.prefix = opts.prefix || "!bot";
    this.owner = opts.owner || null; // if set, only this sender is obeyed
    this.onGoto = opts.onGoto || null; // global-nav hook ("goto <ns> <ew>")
    this.log = opts.log || ((m) => console.log(`[ctl] ${m}`));
    this.commands = [];
    this.paused = false;
    host.onEvent((e) => this._onEvent(e));
  }

  _onEvent(e) {
    if (e.kind !== CHAT_KIND || !e.text) return;
    const m = TELL_RE.exec(e.text);
    if (!m) return;
    const [, sender, body] = m;
    if (this.owner && sender !== this.owner) return;
    const trimmed = body.trim();
    if (!trimmed.toLowerCase().startsWith(this.prefix.toLowerCase())) return;
    const rest = trimmed.slice(this.prefix.length).trim();
    const [cmd, ...args] = rest.split(/\s+/);
    this.commands.push({ sender, cmd: (cmd || "").toLowerCase(), args, at: Date.now() });
    this._dispatch(sender, (cmd || "").toLowerCase(), args);
  }

  _reply(sender, text) {
    // A tell back to the sender. InvokeChatParser drives the retail
    // slash-command lane (WriteToChat is display-only), so a /t reply
    // actually leaves the client.
    this.host.InvokeChatParser(`/t ${sender}, ${text}`);
  }

  _dispatch(sender, cmd, args) {
    switch (cmd) {
      case "status": {
        const s = this.kernel.status;
        const buffs = s.buffs ? `${s.buffs.active}/${s.buffs.desired}` : "n/a";
        this._reply(sender, `action=${s.action} kills=${s.kills} looted=${s.looted} buffs=${buffs} ${this.paused ? "[PAUSED]" : ""}`);
        break;
      }
      case "pause":
        this.paused = true;
        this.kernel.stop();
        this.host.StopCompletely();
        this._reply(sender, "paused");
        this.log(`${sender}: pause`);
        break;
      case "resume":
        this.paused = false;
        this.kernel.start();
        this._reply(sender, "resumed");
        this.log(`${sender}: resume`);
        break;
      case "come":
        // Walk to the sender if they're a nearby tracked entity.
        this._comeToSender(sender);
        break;
      case "goto": {
        // "goto <ns> <ew>" — /loc degrees (floats), routed via the RynthNav
        // sidecar when bot.js wired an onGoto (config.nav).
        const ns = parseFloat(args[0]);
        const ew = parseFloat(args[1]);
        if (!Number.isFinite(ns) || !Number.isFinite(ew)) {
          this._reply(sender, "usage: goto <ns> <ew> (/loc degrees)");
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
      default: {
        const extra = args.length ? ` (args: ${args.join(" ")})` : "";
        this._reply(sender, `unknown cmd '${cmd}'${extra} — try: status | pause | resume | come | goto`);
      }
    }
  }

  _comeToSender(sender) {
    const h = this.host;
    for (const g of h.NearbyGuids()) {
      if (h.TryGetObjectName(g) === sender) {
        const pos = h.TryGetObjectPosition(g);
        if (pos) {
          h.MoveToPosition(pos.objCellId, pos.x, pos.y, pos.z, true);
          this._reply(sender, "on my way");
          return;
        }
      }
    }
    this._reply(sender, "can't see you nearby");
  }
}

export default RynthControlChannel;
