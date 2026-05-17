// Phase K.1 — live-ACE validation of every combat / magic wire
// packet shipped in Phases B–J. Drives one outbound packet per
// scenario via the wasm SessionHandle, captures the binary WS frame
// (via playwright `framesent` hook), and asserts the expected
// sub-opcode + payload bytes appear inside the frame. For each
// scenario, also tails the ACE server log for either a handler-
// reach signature (e.g. `HandleActionTargetedMeleeAttack`) or an
// expected rejection signature (e.g. `CombatMode mismatch`,
// `couldn't find target`, `Invalid spellId`) — any of which proves
// ACE parsed our payload correctly.
//
// The acceptance criterion is **not** "the attack landed" — many
// scenarios use a deliberately invalid target (0xDEADBEEF) so ACE
// rejects them at semantic-validation time. The criterion is
// **wire correctness**: bytes leave the wasm matching the
// pack-fixture layout, ACE deserializes them and reaches the right
// handler, and ACE does NOT log `Received unhandled GameActionType`
// or `GameAction packet that threw an exception` (the failure
// markers from `InboundMessageManager`).
//
// Pre-reqs (mirror capture_phase6_step_f_dungeon.cjs):
//   - Live ACE on 127.0.0.1 UDP 9000/9001 (writes to
//     /mnt/wbterminal1/tmp/claude-scratch/k1/ace.log)
//   - holtburger-wsbridge on ws://127.0.0.1:8080/
//   - python3 -m http.server 8765 from external/holtburger/
//
// Run: `node capture_phase_k_combat_validation.cjs` from
// `apps/holtburger-web/`. Exits 0 on PASS, 1 on FAIL.

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const ACE_LOG_PATH = process.env.K1_ACE_LOG
  || "/mnt/wbterminal1/tmp/claude-scratch/k1/ace.log";
// tailnet1 account already has a "Tester" character on the local
// ACE (preserved from the prior tailnet-ACE captures). Reusing it
// skips the character-creation flow.
const ACCOUNT = process.env.K1_ACCOUNT || "tailnet1";
const PASSWORD = process.env.K1_PASSWORD || "tailnet1";
const BRIDGE_URL = process.env.K1_BRIDGE_URL || "ws://127.0.0.1:8080/";
const SERVER_IP = process.env.K1_SERVER_IP || "127.0.0.1";
const SERVER_PORT = process.env.K1_SERVER_PORT || "9000";
// Chrome on the 1070 reaches our http via the reverse SSH tunnel
// (port 7080 on the remote → 8765 on this box).
const PAGE_URL = process.env.K1_PAGE_URL
  || "http://localhost:7080/apps/holtburger-web/index.html";
// CDP URL forwarded from remote 9222 → local 9223.
const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
const CHAR_NAME = process.env.K1_CHAR_NAME
  || `K1${Date.now().toString(36).slice(-6)}`;
const OUT_DIR = process.env.K1_OUT_DIR
  || "/mnt/wbterminal1/tmp/claude-scratch/k1";

// Deliberately bogus target (0xDEADBEEF) — ACE rejects "couldn't
// find target" / "target guid not creature" AFTER fully parsing the
// payload. The rejection in the log itself proves ACE deserialized
// our wire bytes correctly. Spell id 1 (Strength Self I, per LSD) is
// used for the magic scenarios — if not in book, ACE's "Invalid
// spellId" path proves the parse went through.

// Hex match patterns (LE-encoded GameAction inner payload, AFTER the
// sub-opcode). Each is a substring of the outbound WS binary frame
// (which carries [u16 port LE][UDP payload [...]GameAction[seq u32][
// subop u32][data...]]).
//
// Pattern construction:
//   target_guid_hex_le = "EFBEADDE" (0xDEADBEEF LE)
//   height_med = "02000000" (2 = Medium LE)
//   power_half = "0000003F" (0.5 f32 LE)
//   spell_1 = "01000000"
//
// Sub-opcodes (matched separately):
//   melee = "08000000"
//   missile = "0A000000"
//   castTargeted = "4A000000"
//   castUntargeted = "48000000"
//   removeSpell = "A8010000"
//   changeCombatMode = "53000000"
const TARGET_HEX = "EFBEADDE";
const HEIGHT_MED_HEX = "02000000";
const POWER_HALF_HEX = "0000003F";
const SPELL_HEX = "01000000";

const SCENARIOS = [
  {
    name: "Phase H/B prereq — ChangeCombatMode 0x0053",
    drive: () => window.__sessionHandle.toggleCombatMode(),
    expectSubOpHex: "53000000",
    expectPayloadHex: null, // payload is just mode u32 — varies, skip
    ackInLog: /world|combat|stance/i, // weak — toggle has no specific log line
    skipAck: true,
  },
  {
    name: "Phase B — TargetedMeleeAttack 0x0008",
    drive: () =>
      window.__sessionHandle.attack(0xDEADBEEF, 2, 0.5),
    expectSubOpHex: "08000000",
    expectPayloadHex: TARGET_HEX + HEIGHT_MED_HEX + POWER_HALF_HEX,
    ackInLog: /HandleActionTargetedMeleeAttack|couldn.t find target|target guid not creature|CombatMode mismatch/i,
  },
  {
    name: "Phase E — TargetedMissileAttack 0x000A",
    drive: () =>
      window.__sessionHandle.missileAttack(0xDEADBEEF, 2, 0.5),
    expectSubOpHex: "0A000000",
    expectPayloadHex: TARGET_HEX + HEIGHT_MED_HEX + POWER_HALF_HEX,
    ackInLog: /HandleActionTargetedMissileAttack|couldn.t find creature target|CombatMode mismatch/i,
  },
  {
    name: "Phase F — CastTargetedSpell 0x004A",
    drive: () =>
      window.__sessionHandle.castTargetedSpell(0xDEADBEEF, 1),
    expectSubOpHex: "4A000000",
    expectPayloadHex: TARGET_HEX + SPELL_HEX,
    ackInLog: /HandleActionCastTargetedSpell|CombatMode mismatch|CurrentMotionState|spellId/i,
  },
  {
    name: "Phase F — CastUntargetedSpell 0x0048",
    drive: () => window.__sessionHandle.castUntargetedSpell(1),
    expectSubOpHex: "48000000",
    expectPayloadHex: SPELL_HEX,
    ackInLog: /HandleActionMagicCastUnTargetedSpell|CombatMode mismatch|spellId/i,
  },
  {
    name: "Phase J — RemoveSpellFromBook 0x01A8",
    drive: () => window.__sessionHandle.removeSpellFromBook(1),
    expectSubOpHex: "A8010000",
    expectPayloadHex: SPELL_HEX,
    ackInLog: /HandleActionMagicRemoveSpellId|RemoveSpellFromSpellBook|Invalid spellId/i,
  },
];

function hexOfBuffer(buf) {
  return Buffer.from(buf).toString("hex").toUpperCase();
}

function containsHexInsensitive(haystackHex, needleHex) {
  return haystackHex.toUpperCase().indexOf(needleHex.toUpperCase()) !== -1;
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`ACE log: ${ACE_LOG_PATH}`);

  // Connect to the user's already-running Chrome on the GTX 1070
  // (via CDP over reverse SSH tunnel). Real GPU avoids the
  // swiftshader/headless renderer crashes that blocked the local
  // chromium path.
  console.log(`connecting via CDP to ${CDP_URL}`);
  const browser = await chromium.connectOverCDP(CDP_URL);
  const contexts = browser.contexts();
  const context = contexts[0] || (await browser.newContext());
  const pages = context.pages();
  // Filter to the holtburger tab — the user may have other tabs
  // (web search, docs) open in the same Chrome we're sharing.
  const HOLTBURGER_PREFIX = "http://localhost:7080/apps/holtburger-web/";
  let page = pages.find((p) => p.url().startsWith(HOLTBURGER_PREFIX));
  if (!page) {
    console.log("no existing holtburger tab — opening one");
    page = await context.newPage();
  } else {
    console.log(`reusing holtburger tab @ ${page.url()}`);
  }

  page.on("console", (msg) => {
    console.log(`[browser ${msg.type()}] ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.error("[pageerror]", err.message));

  // Capture all WS frames (both directions) as hex AND log live —
  // chromium has been crashing post-login, so frames already in
  // wsLog need to survive a renderer kill. Also stream every frame
  // event to a per-run log on disk in case the script aborts.
  const wsLog = []; // { dir, hex, t }
  const wsTrace = fs.createWriteStream(path.join(OUT_DIR, "ws-trace.log"), { flags: "w" });
  page.on("websocket", (ws) => {
    console.log(`[ws] open ${ws.url()}`);
    wsTrace.write(`${new Date().toISOString()} OPEN ${ws.url()}\n`);
    ws.on("framesent", ({ payload }) => {
      const buf = typeof payload === "string"
        ? Buffer.from(payload, "utf8")
        : Buffer.from(payload);
      const hex = hexOfBuffer(buf);
      wsLog.push({ dir: "send", hex, t: Date.now() });
      const head = hex.length > 200 ? hex.slice(0, 200) + "..." : hex;
      console.log(`[ws sent ${buf.length}b] ${head}`);
      wsTrace.write(`${new Date().toISOString()} SEND ${buf.length}b ${hex}\n`);
    });
    ws.on("framereceived", ({ payload }) => {
      const buf = typeof payload === "string"
        ? Buffer.from(payload, "utf8")
        : Buffer.from(payload);
      const hex = hexOfBuffer(buf);
      wsLog.push({ dir: "recv", hex, t: Date.now() });
      const head = hex.length > 200 ? hex.slice(0, 200) + "..." : hex;
      console.log(`[ws recv ${buf.length}b] ${head}`);
      wsTrace.write(`${new Date().toISOString()} RECV ${buf.length}b ${hex}\n`);
    });
    ws.on("close", () => {
      console.log("[ws] close");
      wsTrace.write(`${new Date().toISOString()} CLOSE\n`);
    });
  });

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForFunction(() => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    }, { timeout: 30_000 });
  } catch (e) {
    const html = await page.locator("#results").innerHTML();
    console.error("smoke not PASS:", html.slice(0, 500));
    await browser.close();
    process.exit(1);
  }
  console.log("smoke checks PASS");

  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', BRIDGE_URL);
  await page.fill('input[name="server_host"]', SERVER_IP);
  await page.fill('input[name="server_port"]', SERVER_PORT);
  await page.click("#login-form button[type=submit]", { noWaitAfter: true });
  await page.waitForSelector("#selection:not([hidden])", { timeout: 60_000 }).catch(async (err) => {
    const sp = path.join(OUT_DIR, "phase_k_login_fail.png");
    await page.screenshot({ path: sp, fullPage: true });
    const status = await page.locator("#login-status").innerText().catch(() => "?");
    console.error(`login-status text: "${status}"`);
    console.error(`screenshot: ${sp}`);
    throw err;
  });
  await page.waitForTimeout(500);

  const initialButtons = await page.locator("#character-ul button[data-id]").count();
  if (initialButtons === 0) {
    const createVisible = (await page.locator("#create-form:not([hidden])").count()) > 0;
    if (!createVisible) {
      console.error("create-form hidden, no chars — bailing");
      await browser.close();
      process.exit(1);
    }
    console.log(`creating character "${CHAR_NAME}"`);
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click("#create-button");
    await page.waitForFunction(() => {
      const s = document.getElementById("create-status");
      return s && /Created\b/.test(s.innerText);
    }, { timeout: 20_000 });
    await page.waitForFunction(() => {
      return document.querySelectorAll("#character-ul button[data-id]").length > 0;
    }, { timeout: 10_000 });
  }

  await page.locator("#character-ul button[data-id]").first().click();
  console.log("clicked Spawn");

  await page.waitForFunction(() => {
    const s = document.getElementById("login-status");
    return s && /InWorld|Spawned/.test(s.innerText);
  }, { timeout: 30_000 });
  console.log("InWorld reached");

  // Wait for first AutonomousPosition + initial entity drain. We
  // don't need post-spawn teleport-to-Holtburg — the wire validation
  // doesn't care where the avatar physically is.
  await page.waitForTimeout(3_000);

  // === scenario loop =====================================
  const aceLogStartSize = fs.existsSync(ACE_LOG_PATH)
    ? fs.statSync(ACE_LOG_PATH).size
    : 0;
  console.log(`ACE log offset: ${aceLogStartSize}`);

  const results = [];
  for (const sc of SCENARIOS) {
    console.log(`\n=== ${sc.name} ===`);
    const sendIdxBefore = wsLog.filter((f) => f.dir === "send").length;
    const aceLogSizeBefore = fs.existsSync(ACE_LOG_PATH)
      ? fs.statSync(ACE_LOG_PATH).size
      : 0;

    let driveErr = null;
    try {
      await page.evaluate(sc.drive);
    } catch (e) {
      driveErr = String(e.message || e);
      console.log(`  drive threw: ${driveErr}`);
    }
    await page.waitForTimeout(1_200);

    // Frame match: search frames sent AFTER the drive call.
    const newSentFrames = wsLog
      .filter((f) => f.dir === "send")
      .slice(sendIdxBefore);
    const subOpMatches = newSentFrames.filter((f) =>
      containsHexInsensitive(f.hex, sc.expectSubOpHex)
    );
    const payloadMatches = sc.expectPayloadHex
      ? newSentFrames.filter(
          (f) =>
            containsHexInsensitive(f.hex, sc.expectSubOpHex) &&
            containsHexInsensitive(f.hex, sc.expectPayloadHex)
        )
      : subOpMatches;

    // ACE log: read tail since previous size.
    let aceTail = "";
    if (fs.existsSync(ACE_LOG_PATH)) {
      const fd = fs.openSync(ACE_LOG_PATH, "r");
      const sz = fs.statSync(ACE_LOG_PATH).size;
      const newBytes = sz - aceLogSizeBefore;
      if (newBytes > 0) {
        const buf = Buffer.alloc(newBytes);
        fs.readSync(fd, buf, 0, newBytes, aceLogSizeBefore);
        aceTail = buf.toString("utf8");
      }
      fs.closeSync(fd);
    }
    const aceMatchedLine = aceTail
      .split("\n")
      .find((line) => sc.ackInLog && sc.ackInLog.test(line));
    const aceErrorLine = aceTail
      .split("\n")
      .find((line) =>
        /Received unhandled GameActionType|threw an exception/i.test(line)
      );

    const result = {
      name: sc.name,
      driveErr,
      framesSent: newSentFrames.length,
      subOpFound: subOpMatches.length > 0,
      payloadFound: payloadMatches.length > 0,
      sampleFrameHex: payloadMatches[0]?.hex
        || subOpMatches[0]?.hex
        || newSentFrames[0]?.hex
        || null,
      aceAck: aceMatchedLine || null,
      aceError: aceErrorLine || null,
    };
    const wirePass =
      result.subOpFound && (sc.expectPayloadHex ? result.payloadFound : true);
    const ackPass = sc.skipAck ? true : !!result.aceAck;
    const noError = !result.aceError;
    result.pass = wirePass && ackPass && noError;
    results.push(result);

    console.log(`  drive: ${driveErr ? "ERR " + driveErr : "ok"}`);
    console.log(`  frames sent: ${newSentFrames.length}, subop "${sc.expectSubOpHex}" found: ${result.subOpFound}, payload found: ${result.payloadFound}`);
    if (result.sampleFrameHex) {
      console.log(`  sample frame[0..120]: ${result.sampleFrameHex.slice(0, 120)}`);
    }
    if (result.aceAck) {
      console.log(`  ACE ack: ${result.aceAck.slice(0, 160)}`);
    } else if (!sc.skipAck) {
      console.log(`  ACE ack: <not found>`);
    }
    if (result.aceError) {
      console.log(`  ACE ERROR: ${result.aceError.slice(0, 200)}`);
    }
    console.log(`  ${result.pass ? "PASS" : "FAIL"}`);
  }

  // Persist artifact.
  const summary = {
    timestamp: new Date().toISOString(),
    pass: results.every((r) => r.pass),
    results,
    wsFramesTotal: wsLog.length,
  };
  const summaryPath = path.join(OUT_DIR, "phase_k_combat_validation.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(`\n=== summary: ${summary.pass ? "PASS" : "FAIL"} (${summaryPath}) ===`);
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name}`);
  }

  // Don't close the browser — it's the user's Chrome on the 1070,
  // running outside our control. Just disconnect.
  await browser.close();
  process.exit(summary.pass ? 0 : 1);
})();
