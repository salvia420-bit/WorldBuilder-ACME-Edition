// Capture all WS frames during an @addspell command + look for the
// MagicUpdateSpell opcode (0x02C1) in the inbound traffic.
const { chromium } = require("playwright");
const fs = require("node:fs");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  const browser = await chromium.connectOverCDP(
    process.env.K1_CDP_URL || "http://127.0.0.1:9223"
  );
  const ctx = browser.contexts()[0];
  const page = ctx.pages().find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) throw new Error("no holtburger tab");

  const frames = [];
  page.on("websocket", (ws) => {
    ws.on("framereceived", ({ payload }) => {
      const buf = Buffer.from(payload);
      frames.push({ dir: "recv", t: Date.now(), hex: buf.toString("hex") });
    });
    ws.on("framesent", ({ payload }) => {
      const buf = Buffer.from(payload);
      frames.push({ dir: "send", t: Date.now(), hex: buf.toString("hex") });
    });
  });

  // Snapshot before
  const before = await page.evaluate(() => ({
    spells: Array.from(window.__pluginClient?.player?.knownSpells?.() ?? []),
    chatTail: Array.from(
      document.querySelectorAll(".chat-line, .chat-message")
    ).slice(-10).map((el) => el.innerText.slice(0, 80)),
  }));
  console.log("before:", JSON.stringify(before));

  console.log("\nsending @addspell 6");
  await page.evaluate(() => window.__sessionHandle.sendChat("@addspell 6"));
  await sleep(4_000);

  const after = await page.evaluate(() => ({
    spells: Array.from(window.__pluginClient?.player?.knownSpells?.() ?? []),
    chatTail: Array.from(
      document.querySelectorAll(".chat-line, .chat-message")
    ).slice(-10).map((el) => el.innerText.slice(0, 80)),
  }));
  console.log("\nafter:", JSON.stringify(after));

  // Grep frames for the 0x02C1 (MagicUpdateSpell GameEventType) opcode.
  // GameEvent S→C frame layout (per the earlier finding):
  //   wsbridge port (2B BE) || Turbine header (20B) || ack-seq (4B if flag set)
  //   || GameEvent fragment: [GameMessageOpcode 0xF7B0 u32 LE] [Player GUID u32]
  //      [GameEventSequence u32] [EventType u32 LE] [body]
  // So we look for the sequence "b0 f7 00 00" anywhere (GameEvent envelope),
  // and "c1 02 00 00" specifically (MagicUpdateSpell).
  const recv = frames.filter((f) => f.dir === "recv");
  console.log(`\nWS recv frames after addspell: ${recv.length}`);
  for (const f of recv) {
    const hex = f.hex.toLowerCase();
    const hasGameEvent = hex.includes("b0f70000");
    const hasMagicUpdate = hex.includes("c1020000");
    const hasMagicRemove = hex.includes("a8010000");
    if (hasGameEvent || hasMagicUpdate || hasMagicRemove) {
      console.log(
        `  ${f.hex.length / 2}b  GE=${hasGameEvent} MUpd=${hasMagicUpdate} MRem=${hasMagicRemove}  ${hex.slice(
          0,
          200
        )}`
      );
    }
  }

  fs.writeFileSync(
    "/mnt/wbterminal1/tmp/claude-scratch/k1/ws-addspell.txt",
    frames.map((f) => `${f.dir} ${f.hex.length / 2}b ${f.hex}`).join("\n")
  );
  console.log(
    "\nfull frame log: /mnt/wbterminal1/tmp/claude-scratch/k1/ws-addspell.txt"
  );

  await browser.close();
})();
