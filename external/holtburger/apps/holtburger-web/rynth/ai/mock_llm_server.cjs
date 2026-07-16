#!/usr/bin/env node
// mock_llm_server.cjs — standalone OpenAI-compatible chat-completions mock for
// the rynth AI director smoke (SPEC.md §Verification bar, A7). Serves scripted
// assistant replies IN SEQUENCE: reply 1 is a director plan (set_loot_min_value
// 4321 + note), replies 2..N are a steady "none" plan. Full CORS (the game page
// at 127.0.0.1:8765 fetches this server cross-origin). Accepts POSTs to any
// <prefix>/chat/completions — both /v1/chat/completions and /chat/completions.
//
// CLI:  node rynth/ai/mock_llm_server.cjs [--port=8899] [--selftest]
//   --selftest starts itself (ephemeral port unless --port given, so a busy
//   :8899 can't fail the box run), fetches both replies, asserts shape + CORS,
//   exits 0/1.
// In-process (rynth_ai_smoke.cjs): const { startMockLlmServer } = require(...)

"use strict";
const http = require("node:http");

// Reply contract per SPEC.md §director: {analysis, actions, next_check_minutes}.
const DEFAULT_SCRIPT = [
  JSON.stringify({
    analysis: "loot threshold too low for this camp; raising it and leaving a note",
    actions: [
      { type: "set_loot_min_value", value: 4321 },
      { type: "note", text: "soak check" },
    ],
    next_check_minutes: 1,
  }),
  // 2..N — the last script entry repeats forever.
  JSON.stringify({ analysis: "steady", actions: [{ type: "none" }], next_check_minutes: 5 }),
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Allow-Methods": "*",
};

function createMockLlmServer({ script = DEFAULT_SCRIPT, log = console.log } = {}) {
  let seq = 0; // completions served, server-lifetime
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, "http://127.0.0.1").pathname;
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS);
      res.end();
      log(`[mock-llm] OPTIONS ${pathname} -> 204`);
      return;
    }
    if (req.method === "POST" && pathname.endsWith("/chat/completions")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        seq += 1;
        const content = script[Math.min(seq, script.length) - 1];
        let model = "mock";
        try { model = JSON.parse(body).model || model; } catch { /* body shape is not asserted */ }
        const reply = {
          id: `mock-llm-${seq}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: Math.max(1, Math.ceil(body.length / 4)),
            completion_tokens: Math.max(1, Math.ceil(content.length / 4)),
            total_tokens: Math.max(1, Math.ceil(body.length / 4)) + Math.max(1, Math.ceil(content.length / 4)),
          },
        };
        res.writeHead(200, { "Content-Type": "application/json", ...CORS });
        res.end(JSON.stringify(reply));
        log(`[mock-llm] POST ${pathname} -> reply #${seq} (script[${Math.min(seq, script.length) - 1}], ${content.length}B)`);
      });
      req.on("error", () => { res.destroy(); });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json", ...CORS });
    res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${pathname}` } }));
    log(`[mock-llm] ${req.method} ${pathname} -> 404`);
  });
  return server;
}

/** Listen and resolve {server, port, url, close()}. port 0 = ephemeral. */
function startMockLlmServer({ port = 8899, host = "127.0.0.1", script, log } = {}) {
  const server = createMockLlmServer({ script, log });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = server.address().port;
      resolve({
        server,
        port: bound,
        url: `http://${host}:${bound}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function selftest(port) {
  let pass = 0, fail = 0;
  function check(name, ok, detail) {
    if (ok) { pass++; console.log(`PASS ${name}`); }
    else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
  }
  const mock = await startMockLlmServer({ port });
  const post = (path) => fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-key" },
    body: JSON.stringify({ model: "mock", messages: [{ role: "user", content: "obs" }], max_tokens: 1024 }),
  });
  try {
    const pre = await fetch(`${mock.url}/v1/chat/completions`, { method: "OPTIONS" });
    check("preflight 204", pre.status === 204, `status=${pre.status}`);
    check("preflight Allow-Origin *", pre.headers.get("access-control-allow-origin") === "*");
    check("preflight Allow-Headers *", pre.headers.get("access-control-allow-headers") === "*");
    check("preflight Allow-Methods *", pre.headers.get("access-control-allow-methods") === "*");

    const r1 = await post("/v1/chat/completions");
    check("POST /v1/chat/completions 200", r1.status === 200, `status=${r1.status}`);
    check("POST Allow-Origin *", r1.headers.get("access-control-allow-origin") === "*");
    const b1 = await r1.json();
    check("chat.completion shape", b1.object === "chat.completion" && b1.choices?.[0]?.message?.role === "assistant");
    check("usage tokens present",
      Number.isFinite(b1.usage?.prompt_tokens) && Number.isFinite(b1.usage?.completion_tokens),
      JSON.stringify(b1.usage));
    let p1 = null;
    try { p1 = JSON.parse(b1.choices[0].message.content); } catch { /* checked below */ }
    check("reply 1 content is JSON plan", !!p1 && Array.isArray(p1.actions) && typeof p1.analysis === "string");
    check("reply 1 sets loot min 4321",
      p1?.actions?.[0]?.type === "set_loot_min_value" && p1?.actions?.[0]?.value === 4321,
      JSON.stringify(p1?.actions?.[0]));
    check("reply 1 note 'soak check'",
      p1?.actions?.[1]?.type === "note" && p1?.actions?.[1]?.text === "soak check",
      JSON.stringify(p1?.actions?.[1]));
    check("reply 1 next_check_minutes 1", p1?.next_check_minutes === 1, String(p1?.next_check_minutes));

    const r2 = await post("/chat/completions"); // prefixless path must work too
    check("POST /chat/completions 200", r2.status === 200, `status=${r2.status}`);
    const p2 = JSON.parse((await r2.json()).choices[0].message.content);
    check("reply 2 steady none",
      p2.analysis === "steady" && p2.actions?.[0]?.type === "none" && p2.next_check_minutes === 5,
      JSON.stringify(p2));

    const r3 = await post("/v1/chat/completions");
    const p3 = JSON.parse((await r3.json()).choices[0].message.content);
    check("reply 3 repeats steady (2..N)", p3.actions?.[0]?.type === "none", JSON.stringify(p3.actions));

    const r404 = await fetch(`${mock.url}/nope`, { method: "POST", body: "{}" });
    check("unknown route 404", r404.status === 404, `status=${r404.status}`);
    check("404 still carries Allow-Origin *", r404.headers.get("access-control-allow-origin") === "*");
  } finally {
    await mock.close();
  }
  console.log(`${pass} pass, ${fail} fail`);
  process.exit(fail ? 1 : 0);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const explicitPort = portArg ? Number(portArg.slice("--port=".length)) : null;
  if (args.includes("--selftest")) {
    selftest(explicitPort ?? 0).catch((e) => { console.error("FATAL", e); process.exit(1); });
  } else {
    startMockLlmServer({ port: explicitPort ?? 8899 })
      .then((m) => console.log(`[mock-llm] listening on ${m.url} (POST <prefix>/chat/completions)`))
      .catch((e) => { console.error("FATAL", e); process.exit(1); });
  }
}

module.exports = { DEFAULT_SCRIPT, createMockLlmServer, startMockLlmServer };
