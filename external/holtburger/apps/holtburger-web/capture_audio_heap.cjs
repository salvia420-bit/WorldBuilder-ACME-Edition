// Audio heap-snapshot capture (Task #20, 2026-05-13).
//
// Extends capture_audio_leak.cjs's login + spawn + /godly flow with
// CDP HeapProfiler.takeHeapSnapshot before + after 60s of audio stress.
// Then parses each .heapsnapshot for Web Audio C++-backed constructor
// counts: AudioBuffer, AudioBufferSourceNode, PannerNode, GainNode,
// AudioContext, AudioListener, AudioWorkletNode.
//
// Why: capture_audio_leak.cjs proved V8 JS-heap is flat across hostile
// stress, but performance.memory.usedJSHeapSize is blind to Web Audio's
// C++ backing storage (AudioBuffer PCM data, PannerNode HRTF tables).
// HeapProfiler.takeHeapSnapshot returns chromium's full heap including
// native-backed objects exposed as "native" nodes — that's where leaks
// live if anywhere.
//
// Output: two .heapsnapshot files in /mnt/wbterminal1/holtburger-captures/
// and a JSON summary with constructor counts BEFORE / AFTER / DELTA.

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  // eslint-disable-next-line global-require
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    // eslint-disable-next-line global-require
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error("FAIL: playwright not found");
    process.exit(2);
  }
}

// === Heap snapshot helper ===================================================

/**
 * Takes a heap snapshot via CDP HeapProfiler.takeHeapSnapshot, streams
 * the addHeapSnapshotChunk events to disk, and returns the file size.
 *
 * Forces GC inside chromium first (collectGarbage CDP) so the snapshot
 * reflects retained memory rather than short-lived garbage.
 */
async function takeHeapSnapshot(client, outPath) {
  // Drop any previous listeners on the chunk event so we don't double-up.
  // CDPSession is per-page so this is safe.
  let chunkCount = 0;
  const writeStream = fs.createWriteStream(outPath, { encoding: "utf8" });

  const onChunk = (event) => {
    chunkCount += 1;
    writeStream.write(event.chunk);
  };
  client.on("HeapProfiler.addHeapSnapshotChunk", onChunk);

  // Force GC first.
  try {
    await client.send("HeapProfiler.collectGarbage");
  } catch (e) {
    console.log(`(heap) collectGarbage failed (continuing): ${e.message || e}`);
  }
  // collectGarbage is fire-and-forget; give chromium a moment to settle.
  await new Promise((r) => setTimeout(r, 500));

  // Take the snapshot — chunks stream via the event listener above.
  await client.send("HeapProfiler.takeHeapSnapshot", {
    reportProgress: false,
    captureNumericValue: true,
  });

  // Detach + close the file.
  client.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
  await new Promise((resolve, reject) => {
    writeStream.end((err) => (err ? reject(err) : resolve()));
  });

  const stat = fs.statSync(outPath);
  return { sizeBytes: stat.size, chunkCount };
}

// === Heap snapshot parser ===================================================

/**
 * Streams a .heapsnapshot file from disk, parses the JSON, and counts
 * nodes whose name (string-table index) matches our Web Audio
 * constructor list. Returns per-constructor counts + summed self_size.
 *
 * The .heapsnapshot format is valid JSON with:
 *   snapshot: { meta: { node_types: [...], node_fields: [...], ... }, node_count }
 *   nodes: [<flat int array>]  — NODE_FIELDS_LEN ints per node
 *   strings: ["<string table>"]
 *
 * NODE_FIELDS_LEN is typically 7: type, name, id, self_size, edge_count,
 * trace_node_id, detachedness.
 *
 * For Web Audio C++ objects, the V8 heap encodes the constructor name
 * in `name` (string-table index). type may be "native" (V8 generic
 * native wrapper) or "object" depending on how chromium exposes them.
 *
 * We use a streaming approach: parse the whole JSON file with
 * JSON.parse (200 MB JSON usually fits in node's default 4 GB heap
 * with --max-old-space-size already set generously). If it doesn't fit
 * we'd need a streaming parser — but node's V8 default 4 GB old-space
 * handles 200 MB JSON easily.
 */
function summarizeHeapSnapshot(snapshotPath, constructors) {
  // Use streaming read + JSON.parse to avoid double-buffering. Default
  // V8 old-space is ~2 GB on a server-class machine; 200 MB JSON parse
  // peaks at ~3-4x file size so we're within limits.
  const raw = fs.readFileSync(snapshotPath, "utf8");
  const snap = JSON.parse(raw);

  const meta = snap.snapshot.meta;
  const nodeFields = meta.node_fields;         // ["type","name","id","self_size","edge_count","trace_node_id","detachedness"]
  const nodeTypes = meta.node_types[0];        // array of type names
  const NODE_FIELDS_LEN = nodeFields.length;

  const nameFieldIdx = nodeFields.indexOf("name");
  const typeFieldIdx = nodeFields.indexOf("type");
  const selfSizeFieldIdx = nodeFields.indexOf("self_size");
  const idFieldIdx = nodeFields.indexOf("id");
  const edgeCountFieldIdx = nodeFields.indexOf("edge_count");

  if (nameFieldIdx < 0 || typeFieldIdx < 0 || selfSizeFieldIdx < 0) {
    throw new Error(`Snapshot meta missing required fields: name=${nameFieldIdx} type=${typeFieldIdx} self_size=${selfSizeFieldIdx}`);
  }

  const nodes = snap.nodes;
  const strings = snap.strings;
  const nodeCount = nodes.length / NODE_FIELDS_LEN;

  // Build a string-table index lookup for our target constructor names.
  const wantIndices = new Map(); // strIdx -> constructorName
  for (const ctor of constructors) {
    for (let i = 0; i < strings.length; i++) {
      if (strings[i] === ctor) {
        wantIndices.set(i, ctor);
      }
    }
  }

  // Counts + size sums + a few example node IDs per constructor for
  // post-mortem (in case we need to inspect a leak path).
  const counts = new Map();
  const sizes = new Map();
  const samples = new Map();
  for (const ctor of constructors) {
    counts.set(ctor, 0);
    sizes.set(ctor, 0);
    samples.set(ctor, []);
  }

  for (let i = 0; i < nodeCount; i++) {
    const base = i * NODE_FIELDS_LEN;
    const nameIdx = nodes[base + nameFieldIdx];
    const ctor = wantIndices.get(nameIdx);
    if (ctor) {
      counts.set(ctor, counts.get(ctor) + 1);
      sizes.set(ctor, sizes.get(ctor) + nodes[base + selfSizeFieldIdx]);
      const arr = samples.get(ctor);
      if (arr.length < 3) {
        arr.push({
          id: nodes[base + idFieldIdx],
          self_size: nodes[base + selfSizeFieldIdx],
          edge_count: nodes[base + edgeCountFieldIdx],
          type: nodeTypes[nodes[base + typeFieldIdx]],
        });
      }
    }
  }

  // Total node count for sanity / context.
  const summary = {
    snapshotPath,
    totalNodes: nodeCount,
    totalStrings: strings.length,
    nodeTypes,
    nodeFields,
    constructors: {},
  };
  for (const ctor of constructors) {
    summary.constructors[ctor] = {
      count: counts.get(ctor),
      selfSizeBytes: sizes.get(ctor),
      samples: samples.get(ctor),
    };
  }
  return summary;
}

// === Main ===================================================================

(async () => {
  const RUN_TAG = process.env.AUDIO_HEAP_RUN_TAG || `ahp${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.AUDIO_HEAP_CHAR_NAME || `Ahp${RUN_TAG.slice(-6)}`;
  const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
  const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
  const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
  const PAGE_URL =
    process.env.PHASE4_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
  const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
  const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  const GODMODE_CHAT = process.env.ACAD_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE = process.env.ACAD_ENABLE_GODMODE !== "0";

  // 60s of audio stress; 300 plays target = 5 plays/sec.
  const STRESS_DURATION_MS = Number(process.env.AUDIO_HEAP_STRESS_MS || 60_000);
  const STRESS_PLAYS_PER_SEC = Number(process.env.AUDIO_HEAP_STRESS_PLAYS || 5);
  const WARMUP_MS = Number(process.env.AUDIO_HEAP_WARMUP_MS || 8_000);
  const POST_STRESS_SETTLE_MS = Number(process.env.AUDIO_HEAP_SETTLE_MS || 2_000);

  // Web Audio C++ constructors we look for in the heap snapshot.
  const TARGET_CONSTRUCTORS = [
    "AudioBuffer",
    "AudioBufferSourceNode",
    "PannerNode",
    "GainNode",
    "AudioContext",
    "AudioListener",
    "AudioWorkletNode",
    // Some chromium builds report these under base classes:
    "AudioNode",
    "AudioScheduledSourceNode",
    "BaseAudioContext",
    "AudioDestinationNode",
  ];

  // Pass / fail thresholds per task spec.
  const SOFT_DELTA_THRESHOLD = 5;
  const HARD_DELTA_THRESHOLD = 100;

  const startTs = Date.now();
  const BASELINE_SNAPSHOT_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-heap-baseline-${startTs}.heapsnapshot`
  );
  const POST_STRESS_SNAPSHOT_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-heap-post-stress-${startTs}.heapsnapshot`
  );
  const SUMMARY_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-heap-summary-${startTs}.json`
  );
  const DIAG_LOG_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-heap-diag-${startTs}.log`
  );
  const SCREENSHOT_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `audio-heap-${startTs}.png`
  );
  fs.writeFileSync(DIAG_LOG_PATH, `# audio heap diag ${new Date().toISOString()}\n`);

  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`stress: ${STRESS_DURATION_MS / 1000}s @ ${STRESS_PLAYS_PER_SEC} plays/sec (target ~${STRESS_PLAYS_PER_SEC * STRESS_DURATION_MS / 1000} plays)`);
  console.log(`baseline snapshot:    ${BASELINE_SNAPSHOT_PATH}`);
  console.log(`post-stress snapshot: ${POST_STRESS_SNAPSHOT_PATH}`);
  console.log(`summary:              ${SUMMARY_PATH}`);

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-features=PaintHoldingCrossOrigin,PaintHolding",
      "--js-flags=--expose-gc",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    const text = msg.text();
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[${msg.type()}] ${text}\n`);
    } catch (_) {}
    if (msg.type() === "error") {
      consoleErrors += 1;
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
      console.log(`[browser error] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
  });

  // === Boot ===============================================================
  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: SMOKE_TIMEOUT_MS }
    );
    console.log("in-page smoke: PASS");
  } catch (e) {
    console.error(`FAIL: smoke timeout: ${e.message || e}`);
    await browser.close();
    process.exit(1);
  }

  // === Login ==============================================================
  try {
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
    console.log(`logged in as ${ACCOUNT}`);
  } catch (e) {
    console.error(`FAIL: login: ${e.message || e}`);
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(500);

  // === Create character if needed =========================================
  const initialCount = await page.locator('#character-ul button[data-id]').count();
  if (initialCount === 0) {
    console.log(`creating character "${CHAR_NAME}"`);
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click('#create-button');
    await page.waitForFunction(
      () => {
        const s = document.getElementById("create-status");
        return s && /Created\b/.test(s.innerText);
      },
      { timeout: CREATE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 }
    );
    console.log("character created");
  }

  // === Spawn ==============================================================
  const spawnButtons = page.locator('#character-ul button[data-id]');
  if ((await spawnButtons.count()) === 0) {
    console.error("FAIL: no spawnable characters");
    await browser.close();
    process.exit(1);
  }
  await spawnButtons.first().click();
  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: SPAWN_TIMEOUT_MS }
  );
  console.log("spawned");

  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

  // Wait for audio wiring.
  console.log("polling for liveScene3d.audioManager...");
  let initReady = false;
  const initDeadline = Date.now() + 45_000;
  while (Date.now() < initDeadline) {
    const ready = await page.evaluate(() => {
      const ls = window.liveScene3d;
      return !!(ls && ls.audioManager && ls.soundTableCache && ls.ambientRuntime);
    });
    if (ready) {
      initReady = true;
      break;
    }
    await page.waitForTimeout(500);
  }
  if (!initReady) {
    console.error("FAIL: liveScene3d audio wiring never appeared");
    await browser.close();
    process.exit(1);
  }
  console.log("liveScene3d audio wiring present.");

  // === /godly =============================================================
  if (ENABLE_GODMODE && GODMODE_CHAT) {
    const godResult = await page.evaluate((line) => {
      const h = window.__sessionHandle;
      if (h && typeof h.sendChat === "function") {
        try {
          h.sendChat(line);
          return "sent";
        } catch (e) {
          return `err: ${e.message || e}`;
        }
      }
      return "no handle";
    }, GODMODE_CHAT);
    console.log(`/godly: ${godResult}`);
    await page.waitForTimeout(1500);
  }

  // === User-gesture so AudioContext unlocks ==============================
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1" }));
    window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
  });

  const audioReady = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const am = ls?.audioManager;
    return {
      ready: !!(am && am._ctx),
      ctxState: am && am._ctx ? am._ctx.state : "no ctx",
    };
  });
  console.log(`audio state: ${JSON.stringify(audioReady)}`);

  if (!audioReady.ready) {
    console.log("audio not ready first try; waiting 3s for late init...");
    await page.waitForTimeout(3000);
    await page.evaluate(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "F1" }));
      window.dispatchEvent(new PointerEvent("pointerdown", { pointerType: "mouse" }));
    });
    await page.waitForTimeout(1000);
    const audioReady2 = await page.evaluate(() => {
      const ls = window.liveScene3d;
      const am = ls?.audioManager;
      return { ready: !!(am && am._ctx), ctxState: am && am._ctx ? am._ctx.state : "no ctx" };
    });
    console.log(`audio state retry: ${JSON.stringify(audioReady2)}`);
    if (!audioReady2.ready) {
      console.error("FAIL: AudioContext did not initialise after retry");
      await browser.close();
      process.exit(1);
    }
  }

  // === Warmup ============================================================
  console.log(`warmup: ${WARMUP_MS}ms (Region fetch + cache prime)`);
  await page.waitForTimeout(WARMUP_MS);

  // === CDP setup =========================================================
  const client = await context.newCDPSession(page);
  await client.send("HeapProfiler.enable");
  console.log("CDP HeapProfiler enabled");

  // === Baseline snapshot =================================================
  console.log("taking BASELINE heap snapshot (force-GC + capture)...");
  const baselineStart = Date.now();
  const baselineMeta = await takeHeapSnapshot(client, BASELINE_SNAPSHOT_PATH);
  const baselineDurMs = Date.now() - baselineStart;
  console.log(`  → ${BASELINE_SNAPSHOT_PATH}`);
  console.log(`  size: ${(baselineMeta.sizeBytes / 1024 / 1024).toFixed(2)} MB, chunks: ${baselineMeta.chunkCount}, took ${baselineDurMs}ms`);

  // Pre-stress sanity: counters via window.
  const preStressCounters = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const am = ls?.audioManager;
    return {
      playCount: am?.playCount ?? -1,
      bufferCacheSize: am?._bufferCache?.size ?? -1,
      ctxState: am?._ctx?.state ?? "noctx",
    };
  });
  console.log(`pre-stress counters: ${JSON.stringify(preStressCounters)}`);

  // === Stress ============================================================
  const STRESS_WAVE_DIDS = (process.env.AUDIO_STRESS_WAVES ||
    "0x0a000266,0x0a000272,0x0a000300,0x0a000400,0x0a000500,0x0a000600,0x0a000700,0x0a000800")
    .split(",").map((s) => parseInt(s.trim(), 16) >>> 0).filter((n) => n > 0);

  console.log(`=== stress: ${STRESS_PLAYS_PER_SEC} plays/sec across ${STRESS_WAVE_DIDS.length} DIDs for ${STRESS_DURATION_MS / 1000}s ===`);
  await page.evaluate(({ playsPerSec, waveDids }) => {
    let counter = 0;
    window.__audioStressInterval = setInterval(() => {
      try {
        const ls = window.liveScene3d;
        if (!ls || !ls.audioManager) return;
        const t = Date.now() / 1000;
        const pos = {
          x: Math.cos(t) * 5,
          y: Math.sin(t) * 5,
          z: 0,
        };
        const did = waveDids[counter % waveDids.length];
        counter += 1;
        ls.audioManager.play(did, pos).catch(() => {});
      } catch (_) {}
    }, 1000 / playsPerSec);
  }, { playsPerSec: STRESS_PLAYS_PER_SEC, waveDids: STRESS_WAVE_DIDS });

  // Sleep through the stress, sampling counters every 10s for visibility.
  const stressStart = Date.now();
  const stressDeadline = stressStart + STRESS_DURATION_MS;
  while (Date.now() < stressDeadline) {
    const nextSample = Math.min(Date.now() + 10_000, stressDeadline);
    await page.waitForTimeout(Math.max(0, nextSample - Date.now()));
    const s = await page.evaluate(() => {
      const ls = window.liveScene3d;
      const am = ls?.audioManager;
      const mem = (performance && performance.memory) ? performance.memory : null;
      return {
        playCount: am?.playCount ?? -1,
        skipCount: am?.skipCount ?? -1,
        bufferCacheSize: am?._bufferCache?.size ?? -1,
        usedHeapMb: mem ? mem.usedJSHeapSize / 1024 / 1024 : -1,
      };
    });
    console.log(`[t=${((Date.now() - stressStart) / 1000).toFixed(1)}s] plays=${s.playCount}, skips=${s.skipCount}, bufCache=${s.bufferCacheSize}, heap=${s.usedHeapMb.toFixed(2)}MB`);
  }

  // Stop stress timer.
  await page.evaluate(() => {
    if (window.__audioStressInterval) {
      clearInterval(window.__audioStressInterval);
      window.__audioStressInterval = null;
    }
  });

  // === Settle ============================================================
  console.log(`settle: ${POST_STRESS_SETTLE_MS}ms (let in-flight plays finish)`);
  await page.waitForTimeout(POST_STRESS_SETTLE_MS);

  // Post-stress counters
  const postStressCounters = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const am = ls?.audioManager;
    return {
      playCount: am?.playCount ?? -1,
      skipCount: am?.skipCount ?? -1,
      bufferCacheSize: am?._bufferCache?.size ?? -1,
    };
  });
  console.log(`post-stress counters: ${JSON.stringify(postStressCounters)}`);

  // === Post-stress snapshot ==============================================
  console.log("taking POST-STRESS heap snapshot (force-GC + capture)...");
  const postStart = Date.now();
  const postMeta = await takeHeapSnapshot(client, POST_STRESS_SNAPSHOT_PATH);
  const postDurMs = Date.now() - postStart;
  console.log(`  → ${POST_STRESS_SNAPSHOT_PATH}`);
  console.log(`  size: ${(postMeta.sizeBytes / 1024 / 1024).toFixed(2)} MB, chunks: ${postMeta.chunkCount}, took ${postDurMs}ms`);

  // === Screenshot for sanity =============================================
  try {
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
  } catch (_) {}

  await browser.close();

  // === Parse + summarize =================================================
  console.log("");
  console.log("=== parsing snapshots ===");

  let baselineSummary, postSummary;
  try {
    console.log("parsing baseline...");
    baselineSummary = summarizeHeapSnapshot(BASELINE_SNAPSHOT_PATH, TARGET_CONSTRUCTORS);
    console.log(`  baseline nodes: ${baselineSummary.totalNodes}, strings: ${baselineSummary.totalStrings}`);
  } catch (e) {
    console.error(`FAIL: parsing baseline snapshot: ${e.message || e}`);
    console.error(`  baseline snapshot exists at ${BASELINE_SNAPSHOT_PATH} (size ${baselineMeta.sizeBytes} B) — can be re-parsed manually`);
    process.exit(3);
  }
  try {
    console.log("parsing post-stress...");
    postSummary = summarizeHeapSnapshot(POST_STRESS_SNAPSHOT_PATH, TARGET_CONSTRUCTORS);
    console.log(`  post-stress nodes: ${postSummary.totalNodes}, strings: ${postSummary.totalStrings}`);
  } catch (e) {
    console.error(`FAIL: parsing post-stress snapshot: ${e.message || e}`);
    console.error(`  post-stress snapshot exists at ${POST_STRESS_SNAPSHOT_PATH} (size ${postMeta.sizeBytes} B) — can be re-parsed manually`);
    process.exit(3);
  }

  // === Compare ===========================================================
  console.log("");
  console.log("=== HEAP CONSTRUCTOR DELTAS ===");
  console.log("");
  console.log("constructor                  | before  | after   | delta   | bytes_before | bytes_after  | bytes_delta");
  console.log("-----------------------------+---------+---------+---------+--------------+--------------+-------------");

  const constructorReport = {};
  let maxAbsDelta = 0;
  let worstCtor = null;
  let exceededHardThreshold = false;

  for (const ctor of TARGET_CONSTRUCTORS) {
    const before = baselineSummary.constructors[ctor];
    const after = postSummary.constructors[ctor];
    const deltaCount = after.count - before.count;
    const deltaSize = after.selfSizeBytes - before.selfSizeBytes;

    constructorReport[ctor] = {
      countBefore: before.count,
      countAfter: after.count,
      countDelta: deltaCount,
      selfSizeBytesBefore: before.selfSizeBytes,
      selfSizeBytesAfter: after.selfSizeBytes,
      selfSizeBytesDelta: deltaSize,
      sampleBefore: before.samples,
      sampleAfter: after.samples,
    };

    if (Math.abs(deltaCount) > maxAbsDelta) {
      maxAbsDelta = Math.abs(deltaCount);
      worstCtor = ctor;
    }
    if (deltaCount > HARD_DELTA_THRESHOLD) {
      exceededHardThreshold = true;
    }

    const sign = deltaCount >= 0 ? "+" : "";
    const ssign = deltaSize >= 0 ? "+" : "";
    console.log(
      `${ctor.padEnd(28)} | ${String(before.count).padStart(7)} | ${String(after.count).padStart(7)} | ${(sign + deltaCount).padStart(7)} | ${String(before.selfSizeBytes).padStart(12)} | ${String(after.selfSizeBytes).padStart(12)} | ${(ssign + deltaSize).padStart(11)}`
    );
  }

  // === Verdict ===========================================================
  console.log("");
  let verdict;
  let verdictReason;
  if (exceededHardThreshold) {
    verdict = "LEAK";
    verdictReason = `at least one constructor grew by > ${HARD_DELTA_THRESHOLD} (unbounded accumulation)`;
  } else if (maxAbsDelta <= SOFT_DELTA_THRESHOLD) {
    verdict = "NO_LEAK";
    verdictReason = `all deltas <= ${SOFT_DELTA_THRESHOLD} (within noise tolerance)`;
  } else {
    verdict = "INDETERMINATE";
    verdictReason = `worst delta ${maxAbsDelta} (${worstCtor}) exceeds soft threshold ${SOFT_DELTA_THRESHOLD} but within hard threshold ${HARD_DELTA_THRESHOLD}`;
  }
  console.log(`verdict: ${verdict} — ${verdictReason}`);

  // === Write summary =====================================================
  const summaryDoc = {
    runTag: RUN_TAG,
    timestamps: {
      runStart: startTs,
      baselineSnapshotMs: baselineDurMs,
      postStressSnapshotMs: postDurMs,
    },
    files: {
      baselineSnapshot: BASELINE_SNAPSHOT_PATH,
      postStressSnapshot: POST_STRESS_SNAPSHOT_PATH,
      summary: SUMMARY_PATH,
      diagLog: DIAG_LOG_PATH,
      screenshot: SCREENSHOT_PATH,
    },
    snapshotSizes: {
      baselineBytes: baselineMeta.sizeBytes,
      postStressBytes: postMeta.sizeBytes,
    },
    stressConfig: {
      durationMs: STRESS_DURATION_MS,
      playsPerSec: STRESS_PLAYS_PER_SEC,
      targetPlays: STRESS_PLAYS_PER_SEC * STRESS_DURATION_MS / 1000,
      waveDidCount: STRESS_WAVE_DIDS.length,
      waveDids: STRESS_WAVE_DIDS.map((n) => "0x" + n.toString(16)),
    },
    runtimeCounters: {
      preStress: preStressCounters,
      postStress: postStressCounters,
    },
    snapshotMeta: {
      baselineTotalNodes: baselineSummary.totalNodes,
      baselineTotalStrings: baselineSummary.totalStrings,
      postStressTotalNodes: postSummary.totalNodes,
      postStressTotalStrings: postSummary.totalStrings,
    },
    constructors: constructorReport,
    thresholds: {
      softDelta: SOFT_DELTA_THRESHOLD,
      hardDelta: HARD_DELTA_THRESHOLD,
    },
    verdict,
    verdictReason,
    consoleErrors,
    consoleErrorMessages,
  };
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summaryDoc, null, 2));
  console.log(`summary written: ${SUMMARY_PATH}`);

  if (consoleErrors > 0) {
    console.log(`note: ${consoleErrors} browser console error(s) during run`);
  }
  console.log(`final verdict: ${verdict}`);
  // Exit 0 — measurement capture, not a pass/fail gate.
  process.exit(0);
})().catch((err) => {
  console.error("capture failed:", err);
  console.error(err.stack || "(no stack)");
  process.exit(1);
});
