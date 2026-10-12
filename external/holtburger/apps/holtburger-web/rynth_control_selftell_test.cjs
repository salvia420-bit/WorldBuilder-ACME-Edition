#!/usr/bin/env node
// rynth_control_selftell_test.cjs — rynth/control_channel.js after the
// 2026-10-12 update:
//
//   T1  a self-tell renders `You think, "<body>"` since R-chat (2026-10-08,
//       src/chat_format.rs format_tell) — the channel's DEFAULT owner is the
//       logged-in character, so before this fix the default configuration
//       accepted no command at all. It is the character itself, always
//       authorized, and its replies print locally.
//   T2  replies to a remote owner go out as a DIRECT tell (host SendTell),
//       never through the `/t` chat line that becomes a public say when the
//       page's slash router is absent.
//   T3  a host without sendTell keeps the legacy routed `/t` reply.
//   T4  an unauthorized sender is still refused (once), a "You think" line
//       that is not a command is ignored.
//
// Run: node rynth_control_selftell_test.cjs   (exits 1 on any FAIL)

"use strict";
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

function makeHost({ sendTell = true } = {}) {
  const handlers = [];
  const out = { tells: [], local: [], parser: [] };
  const host = {
    out,
    onEvent: (fn) => handlers.push(fn),
    emit: (text) => handlers.forEach((fn) => fn({ kind: 2, text, u32: 0, u32b: 0 })),
    GetPlayerId: () => 0x50000001,
    TryGetObjectName: (g) => (g === 0x50000001 ? "Rynthbot" : null),
    has: (cap) => (cap === "SendTell" ? sendTell : false),
    SendTell: (n, t) => { out.tells.push([n, t]); return true; },
    WriteToChatWindow: (t) => { out.local.push(t); return true; },
    InvokeChatParser: (line) => { out.parser.push(line); return true; },
    StopCompletely: () => true,
    NearbyGuids: () => [],
  };
  return host;
}

function makeKernel() {
  return {
    held: false,
    started: 0,
    get operatorHeld() { return this.held; },
    holdForOperator() { this.held = true; },
    releaseOperatorHold() { this.held = false; },
    start() { this.started++; return true; },
    get status() { return { action: "Idle", kills: 3, looted: 2, buffs: null }; },
  };
}

(async () => {
  const { RynthControlChannel } = await import(pathToFileURL(path.join(__dirname, "rynth/control_channel.js")).href);
  const quiet = () => {};

  // T1 — self-tell under the DEFAULT owner (the character itself)
  {
    const h = makeHost();
    const k = makeKernel();
    const ch = new RynthControlChannel(h, k, { log: quiet });
    h.emit('You think, "!bot status"');
    check("T1 a self-tell command is accepted under the default owner", ch.commands.length === 1 && ch.commands[0].sender === "Rynthbot",
      JSON.stringify(ch.commands));
    check("T1 its reply prints locally (no tell to ourselves)", h.out.local.length === 1 && /kills=3/.test(h.out.local[0]) && h.out.tells.length === 0,
      JSON.stringify(h.out));
    h.emit('You think, "!bot pause"');
    check("T1 pause works from the bot's own chat bar", k.held === true);
    h.emit('You think, "remember to buy food"');
    check("T1 a non-command self-tell is ignored", ch.commands.length === 2);
  }

  // T1b — a configured owner list does not lock the character itself out
  {
    const h = makeHost();
    const ch = new RynthControlChannel(h, makeKernel(), { log: quiet, owner: ["Operator"] });
    h.emit('You think, "!bot status"');
    check("T1b self-tell accepted even with an explicit owner list", ch.commands.length === 1 && h.out.local.length === 1);
  }

  // T2 — remote owner: direct tell reply
  {
    const h = makeHost();
    const ch = new RynthControlChannel(h, makeKernel(), { log: quiet, owner: ["Operator"] });
    h.emit('Operator tells you, "!bot status"');
    check("T2 an owner's tell is answered with a direct tell", ch.commands.length === 1 && h.out.tells.length === 1 && h.out.tells[0][0] === "Operator" && h.out.parser.length === 0,
      JSON.stringify(h.out));
  }

  // T3 — legacy routed /t when the host has no sendTell
  {
    const h = makeHost({ sendTell: false });
    new RynthControlChannel(h, makeKernel(), { log: quiet, owner: ["Operator"] });
    h.emit('Operator tells you, "!bot status"');
    check("T3 no sendTell: legacy /t reply", h.out.parser.length === 1 && /^\/t Operator, action=Idle/.test(h.out.parser[0]) && h.out.tells.length === 0,
      JSON.stringify(h.out));
  }

  // T4 — unauthorized sender
  {
    const h = makeHost();
    const k = makeKernel();
    const ch = new RynthControlChannel(h, k, { log: quiet });
    h.emit('Stranger tells you, "!bot pause"');
    h.emit('Stranger tells you, "!bot pause"');
    check("T4 an unauthorized tell is refused, told once", ch.commands.length === 0 && k.held === false
      && h.out.tells.length === 1 && h.out.tells[0][1] === "unauthorized", JSON.stringify(h.out));
  }

  // T5 — pause/resume through the OperatorControl (opts.getControl → bot.control)
  {
    const h = makeHost();
    const k = makeKernel();
    const ctlCalls = [];
    let stopped = false;
    let refuseResume = false;
    const ctl = {
      isStopped: () => stopped,
      stop: (o) => { ctlCalls.push(["stop", o && o.reason]); stopped = true; return { stopped: true }; },
      resume: () => { ctlCalls.push(["resume"]); if (!refuseResume) stopped = false; return { stopped }; },
    };
    const ch = new RynthControlChannel(h, k, { log: quiet, owner: ["Operator"], getControl: () => ctl });
    h.emit('Operator tells you, "!bot pause"');
    check("T5 pause goes through OperatorControl.stop (not the bare kernel hold)",
      ctlCalls.length === 1 && ctlCalls[0][0] === "stop" && /!bot pause from Operator/.test(ctlCalls[0][1]) && k.held === false,
      JSON.stringify(ctlCalls));
    check("T5 paused reads the control", ch.paused === true && h.out.tells.some((t) => t[1] === "paused"));
    h.emit('Operator tells you, "!bot goto 10 20"');
    h.emit('Operator tells you, "!bot come"');
    check("T5 goto/come refused while paused", h.out.tells.filter((t) => t[1] === "paused — resume first").length === 2, JSON.stringify(h.out.tells));
    refuseResume = true;
    h.emit('Operator tells you, "!bot resume"');
    check("T5 a refused resume says so", h.out.tells.some((t) => t[1] === "resume refused (still held)") && ch.paused === true);
    refuseResume = false;
    h.emit('Operator tells you, "!bot resume"');
    check("T5 resume goes through OperatorControl.resume", ctlCalls.filter((c) => c[0] === "resume").length === 2 && ch.paused === false
      && h.out.tells.some((t) => t[1] === "resumed"), JSON.stringify(ctlCalls));
  }

  // T6 — no control wired: the kernel-hold fallback still pauses/resumes
  {
    const h = makeHost();
    const k = makeKernel();
    const ch = new RynthControlChannel(h, k, { log: quiet, owner: ["Operator"] });
    h.emit('Operator tells you, "!bot pause"');
    check("T6 fallback pause latches the kernel hold", k.held === true && ch.paused === true);
    h.emit('Operator tells you, "!bot resume"');
    check("T6 fallback resume releases it and restarts the kernel", k.held === false && k.started === 1);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
