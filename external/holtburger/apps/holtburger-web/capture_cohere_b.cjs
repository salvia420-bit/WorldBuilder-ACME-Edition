// Cohere-B (2026-05-12) live capture — login → @teleloc Holtburg →
// programmatic setMotion(WALK_FORWARD) on the local player rig →
// screenshot canvas at peak walk cycle. Validates that Stage 1
// (rest-pose fix) + Stage 2 (InterpolateDiscrete + zero-crossfade)
// produce a cohesive player rig in motion in the actual user-facing
// rendering path.
//
// Why programmatic setMotion instead of holding W: Cohere-C/D scope
// is fixing WASD-to-integrator. Bullet 7+8 of capture_3d_movement_e2e
// fail on master 9472e12 — the integrator doesn't receive WASD even
// for forward. We bypass that by calling `em.setMotion(localGuid,
// 0x45000005, 0)` directly, which is what kind=5 UpdateMotion does on
// the wire. The animation cycle runs faithfully even though the
// integrator never advances the player position.
//
// Why tailnet1 not a fresh account: needs #teleport-button privileges
// to land in Holtburg. The Academy default spawn isn't ready for
// rig validation per the user 2026-05-12.
//
// Output: /mnt/wbterminal1/holtburger-captures/cohere-b/

const fs = require("node:fs");
const path = require("node:path");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error("FAIL: playwright not found in NODE_PATH or " + PLAYWRIGHT_CACHE);
    process.exit(2);
  }
}

(async () => {
  const PAGE_URL =
    process.env.COHERE_B_PAGE_URL ||
    "http://100.116.47.66:8765/apps/holtburger-web/index.html?renderer=3d";
  const ACCOUNT = process.env.COHERE_B_ACCOUNT || "tailnet1";
  const PASSWORD = process.env.COHERE_B_PASSWORD || "tailnet1";
  const BRIDGE_URL = process.env.COHERE_B_BRIDGE_URL || "ws://100.116.47.66:8080/";
  const SERVER_HOST = process.env.COHERE_B_SERVER_HOST || "127.0.0.1";
  const SERVER_PORT = process.env.COHERE_B_SERVER_PORT || "9000";
  const CHAR_NAME =
    process.env.COHERE_B_CHAR_NAME ||
    `CohereB${Date.now().toString(36).slice(-6)}`;
  const OUT_DIR = "/mnt/wbterminal1/holtburger-captures/cohere-b";
  const SMOKE_TIMEOUT_MS = 60_000;
  const LOGIN_TIMEOUT_MS = 20_000;
  const CREATE_TIMEOUT_MS = 15_000;
  const SPAWN_TIMEOUT_MS = 30_000;
  const TELEPORT_TIMEOUT_MS = 20_000;
  const POST_TELEPORT_DRAIN_MS = 12_000;
  const WALK_CYCLE_MS = 2_000;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  console.log(`launching chromium → ${PAGE_URL}`);
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
  const page = await context.newPage();

  let consoleErrors = 0;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      consoleErrors += 1;
      consoleErrorMessages.push(msg.text());
    }
  });
  page.on("pageerror", (e) => {
    consoleErrors += 1;
    consoleErrorMessages.push(String(e));
  });

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    },
    { timeout: SMOKE_TIMEOUT_MS }
  ).catch(() => {
    console.error("FAIL: in-page smoke didn't reach PASS");
    process.exit(1);
  });

  // Login flow — same shape as capture_phase7_4_entities.cjs mode 2.
  await page.fill('input[name="account"]', ACCOUNT);
  await page.fill('input[name="password"]', PASSWORD);
  await page.fill('input[name="bridge_url"]', BRIDGE_URL);
  await page.fill('input[name="server_host"]', SERVER_HOST);
  await page.fill('input[name="server_port"]', SERVER_PORT);
  await page.click('#login-form button[type=submit]');

  const loginOk = await page
    .waitForSelector("#selection:not([hidden])", { timeout: LOGIN_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!loginOk) {
    console.error(`FAIL: login timed out (account=${ACCOUNT})`);
    await browser.close();
    process.exit(1);
  }
  console.log("login OK; installing entity drain hook");

  // Hook pollEntityUpdates → __scene3dEntityHook so the 3D EntityManager
  // sees every entity (mirrors capture_phase7_4_entities.cjs mode 2).
  // Without this, em.entityMap stays empty even though the wire spawns
  // arrive — the local-player and NPC entities never get to the 3D rig
  // builder.
  await page.evaluate(() => {
    const tryInstall = () => {
      const h = window.__sessionHandle;
      if (!h || typeof h.pollEntityUpdates !== "function") return false;
      if (window.__cohere_b_install_done) return true;
      const orig = h.pollEntityUpdates.bind(h);
      h.pollEntityUpdates = function () {
        const events = orig();
        for (const upd of events) {
          try {
            if (typeof window.__scene3dEntityHook === "function") {
              window.__scene3dEntityHook(upd);
            }
          } catch (_) {}
        }
        return events;
      };
      window.__cohere_b_install_done = true;
      return true;
    };
    if (!tryInstall()) {
      const t = setInterval(() => {
        if (tryInstall()) clearInterval(t);
      }, 100);
      setTimeout(() => clearInterval(t), 30_000);
    }
  });

  // Pick existing character or create one.
  await page.waitForTimeout(500);
  const initialButtonCount = await page
    .locator("#character-ul button[data-id]")
    .count();
  if (initialButtonCount === 0) {
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click("#create-button");
    await page.waitForFunction(
      () => {
        const s = document.getElementById("create-status");
        return s && /Created\b/.test(s.innerText);
      },
      { timeout: CREATE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () =>
        document.querySelectorAll("#character-ul button[data-id]").length > 0,
      { timeout: 10_000 }
    );
  }
  await page.locator("#character-ul button[data-id]").first().click();
  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: SPAWN_TIMEOUT_MS }
  );
  await page.waitForSelector("#post-spawn:not([hidden])", {
    timeout: TELEPORT_TIMEOUT_MS,
  });
  console.log("spawned (Academy)");

  // Click the teleport-to-Holtburg button.
  await page.click("#teleport-button");
  console.log(`teleport clicked; draining up to ${POST_TELEPORT_DRAIN_MS}ms`);
  // Poll entityMap.size each second so we can short-circuit as soon as
  // entities start landing.
  const drainStart = Date.now();
  while (Date.now() - drainStart < POST_TELEPORT_DRAIN_MS) {
    const sz = await page.evaluate(
      () => window.liveScene3d?.entityManager?.entityMap?.size ?? 0
    );
    if (sz >= 5) {
      console.log(`  entityMap reached ${sz} entities at +${Date.now() - drainStart}ms`);
      break;
    }
    if ((Date.now() - drainStart) % 2000 < 1100) {
      console.log(`  drain wait +${Date.now() - drainStart}ms — entityMap.size=${sz}`);
    }
    await page.waitForTimeout(1000);
  }

  // Find a target entity to animate. Prefer the local player; fall
  // back to any rigged entity in entityMap. The phase7_4 mode 2
  // capture observed 47-94 NPCs landing post-teleport — pick one.
  const playerInfo = await page.evaluate(() => {
    const out = { error: null, target: null, localPlayerGuid: null };
    try {
      const lpg = window.getLocalPlayerGuid?.();
      out.localPlayerGuid = lpg
        ? "0x" + (lpg >>> 0).toString(16).padStart(8, "0")
        : null;
      const live = window.liveScene3d;
      if (!live?.entityManager) {
        out.error = "no liveScene3d.entityManager";
        return out;
      }
      const em = live.entityManager;
      out.entityMapSize = em.entityMap.size;
      // Try local player first.
      if (lpg) {
        const inst = em.entityMap.get(lpg >>> 0);
        if (inst && inst.parts && inst.parts.length > 0) {
          out.target = {
            kind: "localPlayer",
            guidHex: out.localPlayerGuid,
            partCount: inst.parts.length,
            name: inst.meta?.name ?? "(unnamed)",
          };
          return out;
        }
      }
      // Fall back: scan entityMap for the first rigged entity with parts > 0.
      for (const [guid, inst] of em.entityMap) {
        if (inst.parts && inst.parts.length >= 5) {
          out.target = {
            kind: "fallbackNpc",
            guidHex: "0x" + (guid >>> 0).toString(16).padStart(8, "0"),
            partCount: inst.parts.length,
            name: inst.meta?.name ?? "(unnamed)",
          };
          return out;
        }
      }
      out.error = `no suitable target — entityMap.size=${out.entityMapSize}, localPlayer-in-map=${
        lpg && em.entityMap.has(lpg >>> 0) ? "yes" : "no"
      }`;
      return out;
    } catch (e) {
      out.error = String(e);
      return out;
    }
  });
  console.log("=== target search ===");
  console.log(JSON.stringify(playerInfo, null, 2));
  if (playerInfo.error || !playerInfo.target) {
    console.error(`FAIL: ${playerInfo.error || "no target found"}`);
    await browser.close();
    process.exit(1);
  }

  // Screenshot 1 — rest pose in Holtburg.
  const canvasLocator = page.locator("canvas").first();
  const restShot = path.join(OUT_DIR, "cohere-b-01-rest-pose-holtburg.png");
  await canvasLocator.screenshot({ path: restShot });
  console.log(`saved ${restShot}`);

  // Force WalkForward motion on the target rig. AC NonCombat
  // WalkForward = 0x45000005. em.setMotion is the JS-side equivalent
  // of receiving a kind=5 UpdateMotion packet — drives the
  // AnimationMixer directly without going through the (broken) WASD
  // integrator path.
  //
  // For NPC targets (fallback path), this overrides their natural
  // motion state with WalkForward — they may snap back to idle when
  // the next wire-side motion update arrives, but for the screenshot
  // window we hold them in a known walk cycle.
  //
  // Also frame the camera onto the target so the screenshot crops to
  // its rig. Default 3D follow camera tracks the local player only;
  // for NPC fallback we manually position the renderer's camera.
  const motionResult = await page.evaluate(async ({ guid, cmd, stance, kind }) => {
    const out = {};
    try {
      const live = window.liveScene3d;
      const em = live.entityManager;
      const inst = em.entityMap.get(guid >>> 0);
      if (!inst) { out.error = "target gone before setMotion"; return out; }

      // For NPC fallback, point the camera at the target's root. Local-
      // player target already has a follow camera so no override.
      if (kind === "fallbackNpc" && live.camera && inst.root) {
        const p = inst.root.position;
        live.camera.position.set(p.x + 4, p.y + 2, p.z + 4);
        live.camera.lookAt(p.x, p.y + 1, p.z);
        if (typeof live.camera.updateProjectionMatrix === "function") {
          live.camera.updateProjectionMatrix();
        }
      }

      await em.setMotion(guid >>> 0, cmd >>> 0, stance >>> 0);
      // Give the async setMotion / animationCache fetch time to resolve.
      await new Promise((r) => setTimeout(r, 800));
      out.mixerTime = inst.mixer?.time ?? 0;
      out.currentActionTime = inst.currentAction?.time ?? 0;
      out.currentActionWeight = inst.currentAction?.getEffectiveWeight() ?? 0;
      out.actionsSize = inst.actions?.size ?? 0;
      out.hasCurrentAction = !!inst.currentAction;
      return out;
    } catch (e) {
      out.error = String(e);
      return out;
    }
  }, {
    guid: parseInt(playerInfo.target.guidHex, 16),
    cmd: 0x45000005,
    stance: 0,
    kind: playerInfo.target.kind,
  });
  console.log("=== setMotion(WalkForward) ===");
  console.log(JSON.stringify(motionResult, null, 2));

  // Let the rAF loop drive the mixer for the configured walk window
  // so the rig animates over several authored frames.
  console.log(`letting walk cycle run ${WALK_CYCLE_MS}ms`);
  await page.waitForTimeout(WALK_CYCLE_MS);

  // Re-probe mixer state after the wait — confirms the rAF mixer.update
  // (not the synthetic per-eval one we used in the prior synthetic
  // capture) actually advances the action time.
  const postWait = await page.evaluate((guid) => {
    const live = window.liveScene3d;
    const em = live?.entityManager;
    const inst = em?.entityMap?.get(guid >>> 0);
    return {
      mixerTime: inst?.mixer?.time ?? 0,
      currentActionTime: inst?.currentAction?.time ?? 0,
      currentActionWeight: inst?.currentAction?.getEffectiveWeight() ?? 0,
    };
  }, parseInt(playerInfo.target.guidHex, 16));
  console.log("=== post-wait mixer ===");
  console.log(JSON.stringify(postWait, null, 2));

  const walkShot = path.join(OUT_DIR, "cohere-b-02-walking-holtburg.png");
  await canvasLocator.screenshot({ path: walkShot });
  console.log(`saved ${walkShot}`);

  await browser.close();

  console.log("=========================");
  console.log(`Cohere-B live capture: ${consoleErrors === 0 ? "PASS" : "FAIL"}`);
  console.log(`  account: ${ACCOUNT}`);
  console.log(`  target: ${playerInfo.target.kind} ${playerInfo.target.guidHex} "${playerInfo.target.name}" (${playerInfo.target.partCount} parts)`);
  console.log(`  localPlayerGuid: ${playerInfo.localPlayerGuid}`);
  console.log(`  entityMap size: ${playerInfo.entityMapSize}`);
  console.log(`  post-setMotion mixer.time: ${motionResult.mixerTime}`);
  console.log(`  post-${WALK_CYCLE_MS}ms wait mixer.time: ${postWait.mixerTime}`);
  console.log(`  walk action weight: ${postWait.currentActionWeight}`);
  console.log(`  console errors: ${consoleErrors}`);
  if (consoleErrors > 0) {
    console.log("  errors:");
    consoleErrorMessages.slice(0, 8).forEach((m) => console.log("    " + m.slice(0, 200)));
  }
  console.log("  screenshots:");
  console.log(`    ${restShot}`);
  console.log(`    ${walkShot}`);
  console.log("Eye-test: open both PNGs; player rig should be cohesive in both.");
  console.log("=========================");

  process.exit(consoleErrors === 0 ? 0 : 1);
})();
