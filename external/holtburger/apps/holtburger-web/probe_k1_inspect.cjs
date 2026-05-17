// Inspect the current state of the 1070 Chrome's holtburger page —
// camera mode, stance, login state, pointer-lock status, etc.

const { chromium } = require("playwright");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages.find((p) =>
    p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
  );
  if (!page) {
    console.log("no holtburger tab — bail");
    process.exit(1);
  }
  console.log(`inspecting: ${page.url()}`);

  const state = await page.evaluate(() => {
    const ls = window.liveScene3d || null;
    const lp = window.__pluginClient || null;
    const sh = window.__sessionHandle || null;
    return {
      hasLiveScene3d: !!ls,
      hasPluginClient: !!lp,
      hasSessionHandle: !!sh,
      cameraMode: ls?.cameraSwitcher?.mode ?? null,
      isPointerLocked: document.pointerLockElement !== null,
      canvasFound: !!document.querySelector("canvas"),
      selectionHidden: document.getElementById("selection")?.hidden ?? "missing",
      loginStatusText: document.getElementById("login-status")?.innerText ?? "missing",
      currentStanceLow:
        typeof window.__getCurrentStanceLow === "function"
          ? window.__getCurrentStanceLow()
          : null,
      currentStanceLabel:
        typeof window.__getCurrentStanceLabel === "function"
          ? window.__getCurrentStanceLabel()
          : null,
      playerCombatMode: (() => {
        try {
          return sh?.playerStats?.()?.combatMode ?? null;
        } catch (_) {
          return "(err)";
        }
      })(),
      enteredWorld: !!window.__enteredWorld,
      localPlayerGuid:
        typeof window.getLocalPlayerGuid === "function"
          ? window.getLocalPlayerGuid()
          : null,
      entityMapSize: window.entityMap?.size ?? null,
      barSlotIds: Array.from(
        document.querySelectorAll("#hb-bar [data-slot-id]") || []
      ).map((el) => el.dataset.slotId),
    };
  });

  console.log(JSON.stringify(state, null, 2));
  await browser.close();
})();
