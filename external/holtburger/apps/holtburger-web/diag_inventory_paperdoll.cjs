// Live diagnostic for two bugs:
//   #1 — inventory item icons not rendering
//   #2 — paperdoll viewport not rendering
//
// Logs in via the same wire-agent path as capture_wire_agent_hud_inventory.cjs,
// opens inventory, and reads window state to find out:
//   (a) does the player actually have inventory items? what are their IconIds?
//   (b) does wasm.fetch_surface_pixels work for those IconIds?
//   (c) is the PaperdollViewport instantiated? did loadPlayer() succeed?
//   (d) what is meta.modelId / setupId / mtableId / paletteId on the
//       local player entity?

const fs = require("node:fs");
const path = require("node:path");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try { ({ chromium } = require("playwright")); }
catch (_) { ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright"))); }

const ACCOUNT = process.env.HB_ACCOUNT || "tailnet1";
const PASSWORD = process.env.HB_PASSWORD || "tailnet1";
const BASE = process.env.HB_BASE_URL || "http://127.0.0.1:7080";

const PAGE_URL =
  `${BASE}/apps/holtburger-web/index.html` +
  `?renderer=3d&wireframe=1` +
  `&autoLogin=1&account=${encodeURIComponent(ACCOUNT)}&password=${encodeURIComponent(PASSWORD)}` +
  `&autoSpawn=first`;

const OUT_JSON = process.env.HB_DIAG_OUT ||
  "/mnt/wbterminal1/tmp/claude-scratch/diag-inventory-paperdoll.json";
const OUT_PNG = "/mnt/wbterminal1/tmp/claude-scratch/diag-inventory-paperdoll.png";

(async () => {
  console.log(`[diag] URL: ${PAGE_URL}`);
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-dev-shm-usage", "--no-sandbox",
      "--use-gl=angle", "--enable-webgl", "--ignore-gpu-blocklist",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
    ],
  });
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await ctx.newPage();
  page.on("console", (msg) => {
    const t = msg.text();
    if (msg.type() === "error" || /\[boot-state\]|\[diag\]/i.test(t)) {
      console.log(`  [browser ${msg.type()}] ${t.slice(0, 200)}`);
    }
  });
  page.on("pageerror", (err) => console.log(`  [pageerror] ${err.message}`));

  await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__bootState === "ready", { timeout: 120_000, polling: 500 });
  console.log("[diag] ready.");

  // Give the recv loop a few seconds to drain initial wire messages so
  // the inventory + meta should be populated.
  await page.waitForTimeout(5_000);

  // Open inventory.
  await page.evaluate(() => window.__mainPanel?.showView?.("inventory"));
  await page.waitForTimeout(2_000);

  const diag = await page.evaluate(async () => {
    const out = {
      bootState: window.__bootState ?? null,
      sessionHandlePresent: !!window.__sessionHandle,
      wasmPresent: !!(window.__hbWasm || window.__wasm),
      localPlayerGuid: null,
      localPlayerMeta: null,
      inventoryItemCount: 0,
      inventoryItems: [],
      iconFetchProbes: [],
      paperdoll: {
        viewportInstantiated: false,
        viewportCanvasPresent: false,
        viewportCanvasNonBlank: null,
        loadKey: null,
        loadOk: null,
        loadError: null,
      },
      domShape: {
        invOverlayPresent: !!document.getElementById("hb-main-panel"),
        invPaperdollWrapPresent: !!document.querySelector(".hb-inv-paperdoll-viewport"),
        invItemsGridChildren: document.querySelectorAll(".hb-inv-items-grid > *").length,
        invPaperdollSlots: document.querySelectorAll(".hb-inv-paperdoll-slot").length,
      },
      errors: [],
    };

    try {
      const lpg = (typeof window.getLocalPlayerGuid === "function")
        ? (window.getLocalPlayerGuid() >>> 0) : 0;
      out.localPlayerGuid = "0x" + lpg.toString(16).padStart(8, "0");

      const em = window.liveScene3d?.entityManager;
      const inst = em?.entityMap?.get?.(lpg);
      const meta = inst?.meta;
      if (meta) {
        out.localPlayerMeta = {
          modelId: meta.modelId ? "0x" + (meta.modelId >>> 0).toString(16).padStart(8, "0") : null,
          setupId: meta.setupId ? "0x" + (meta.setupId >>> 0).toString(16).padStart(8, "0") : null,
          mtableId: meta.mtableId ? "0x" + (meta.mtableId >>> 0).toString(16).padStart(8, "0") : null,
          paletteId: meta.paletteId ? "0x" + (meta.paletteId >>> 0).toString(16).padStart(8, "0") : null,
          subPalettesLen: meta.subPalettes?.length ?? 0,
          subPalettesSample: meta.subPalettes ? Array.from(meta.subPalettes.slice(0, 12))
            .map(v => "0x" + (v >>> 0).toString(16)) : null,
          name: meta.name ?? null,
          itemType: meta.itemType ?? null,
        };
      }

      // Inventory items — walk the player's containers via the wasm
      // session handle. The handle exposes various enumeration helpers
      // depending on holtburger version; we try several.
      const handle = window.__sessionHandle ?? window.__pluginClient?._handle ?? null;
      if (handle) {
        // Real accessor: playerInventory() → Vec<InventoryItem>
        let items = null;
        const tried = [];
        for (const fn of ["playerInventory", "playerInventorySnapshot"]) {
          tried.push(fn);
          try {
            if (typeof handle[fn] === "function") {
              items = handle[fn]();
              if (items) { out.inventorySource = fn; break; }
            }
          } catch (e) { tried.push(`${fn}_err:${String(e).slice(0,60)}`); }
        }
        out.inventoryAccessorsTried = tried;
        // wasm-bindgen Vec<T> may return as Array, or as an iterator-like.
        if (items && typeof items[Symbol.iterator] === "function" && !Array.isArray(items)) {
          items = Array.from(items);
        }
        if (Array.isArray(items)) {
          out.inventoryItemCount = items.length;
          out.inventoryItems = items.slice(0, 20).map(it => ({
            guid: it?.guid != null ? "0x" + (it.guid >>> 0).toString(16) : null,
            wcid: it?.wcid ?? null,
            name: it?.name ?? null,
            iconId: it?.iconId != null ? "0x" + (it.iconId >>> 0).toString(16) : null,
            itemType: it?.itemType ?? null,
            equipMask: it?.equipMask != null ? "0x" + (it.equipMask >>> 0).toString(16) : null,
            containerId: it?.containerId != null ? "0x" + (it.containerId >>> 0).toString(16) : null,
            stackSize: it?.stackSize ?? null,
          }));
        } else if (items && typeof items === "object") {
          out.inventoryItemCount = Object.keys(items).length;
          out.inventoryItemsRaw = JSON.stringify(items).slice(0, 800);
        }

        // Also try direct entity walk: any entity whose container is the player.
        if (em?.entityMap) {
          let contained = 0;
          const containedSample = [];
          for (const [g, e] of em.entityMap.entries()) {
            const m = e?.meta;
            if (m && (m.container >>> 0) === lpg) {
              contained += 1;
              if (containedSample.length < 12) containedSample.push({
                guid: "0x" + (g >>> 0).toString(16),
                name: m.name ?? null,
                iconId: m.iconId != null ? "0x" + (m.iconId >>> 0).toString(16) : null,
                itemType: m.itemType ?? null,
              });
            }
          }
          out.entityMapContainerWalk = { contained, sample: containedSample };
        }
      }

      // Also inspect the legacy index.html DOM that the plugin observes.
      out.domShape.invEquippedLiCount = document.querySelectorAll("#inv-equipped > li").length;
      out.domShape.invPackLiCount = document.querySelectorAll("#inv-pack > li").length;
      out.domShape.invEquippedFirstLiHtml = document.querySelector("#inv-equipped > li")?.outerHTML?.slice(0, 200) ?? null;

      // Pixel probe — for any icon DIDs we found, ask wasm to fetch via the
      // dedicated icon entry. Fall back to fetch_surface_pixels for diagnostic
      // contrast (it should fail; that's the bug we just fixed).
      const wasm = window.__hbWasm ?? window.__wasm ?? null;
      out.probeIconExportName = typeof wasm?.fetch_icon_pixels === "function" ? "fetch_icon_pixels"
        : typeof wasm?.fetch_surface_pixels === "function" ? "fetch_surface_pixels" : null;
      const probeIds = [];
      for (const it of out.inventoryItems) {
        if (it.iconId && it.iconId !== "0x0") probeIds.push(parseInt(it.iconId, 16) >>> 0);
      }
      // Add a couple of well-known icons from data/icon-manifest.json
      // (if it loads) so we have a baseline even when inventory empty.
      try {
        const r = await fetch("/apps/holtburger-web/data/icon-manifest.json");
        if (r.ok) {
          const m = await r.json();
          const sample = (Array.isArray(m) ? m : Object.keys(m)).slice(0, 5);
          for (const v of sample) {
            const n = typeof v === "string" ? parseInt(v, 16) : (v.iconId ?? v.did ?? v);
            if (n) probeIds.push(n >>> 0);
          }
        }
      } catch (_) {}
      const seen = new Set();
      for (const id of probeIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (out.iconFetchProbes.length >= 16) break;
        try {
          const fetchIcon = wasm?.fetch_icon_pixels ?? wasm?.fetch_surface_pixels;
          if (fetchIcon) {
            const r = await fetchIcon(id);
            out.iconFetchProbes.push({
              did: "0x" + id.toString(16),
              ok: !!(r && r.width && r.height && r.pixels?.length),
              width: r?.width ?? null,
              height: r?.height ?? null,
              pxLen: r?.pixels?.length ?? null,
            });
            if (r?.free) try { r.free(); } catch (_) {}
          } else {
            out.iconFetchProbes.push({ did: "0x" + id.toString(16), ok: false, error: "no icon-fetch export" });
          }
        } catch (e) {
          out.iconFetchProbes.push({ did: "0x" + id.toString(16), ok: false, error: String(e) });
        }
      }

      // Directly drive the paperdoll viewport: import the module, build one,
      // call loadPlayer with the local-player meta, capture the boolean.
      try {
        const mod = await import("/apps/holtburger-web/ui/ac_paperdoll_viewport.js");
        const vp = new mod.PaperdollViewport({});
        const m = meta || {};
        const setupId = (m.modelId ?? m.setupId ?? 0) >>> 0;
        const mtableId = (m.mtableId ?? 0) >>> 0;
        const paletteId = (m.paletteId ?? 0) >>> 0;
        const subs = m.subPalettes ?? new Uint32Array(0);
        const ok = await vp.loadPlayer(setupId, mtableId, paletteId, subs);
        out.paperdoll.directLoadOk = !!ok;
        out.paperdoll.directLoadArgs = { setupId: "0x" + setupId.toString(16), mtableId: "0x" + mtableId.toString(16), paletteId: "0x" + paletteId.toString(16), subsLen: subs.length };
        // Inspect the viewport internals.
        out.paperdoll.directRigChildCount = vp.rigRoot?.children?.length ?? null;
        out.paperdoll.directLastLoadKey = vp._lastLoadKey ?? null;
        // Force a render + sample its canvas.
        if (ok) {
          vp.start?.();
          await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          const tmpC = document.createElement("canvas");
          tmpC.width = vp.canvas.width; tmpC.height = vp.canvas.height;
          tmpC.getContext("2d").drawImage(vp.canvas, 0, 0);
          const idDir = tmpC.getContext("2d").getImageData(0, 0, tmpC.width, tmpC.height);
          let nz = 0;
          for (let i = 0; i < idDir.data.length; i += 4)
            if (idDir.data[i] || idDir.data[i+1] || idDir.data[i+2] || idDir.data[i+3]) nz += 1;
          out.paperdoll.directCanvasNonZeroPx = nz;
        }
      } catch (e) {
        out.paperdoll.directLoadErr = String(e);
        if (e?.stack) out.paperdoll.directLoadStack = e.stack.split("\n").slice(0, 6).join(" | ");
      }

      // Now also fetch some wasm-export names to confirm fetchEntityAnimationKeyframes etc.
      const wasmExports = window.liveScene3d?.entityManager?.wasmExports
        ?? window.__hbWasm ?? window.__wasm ?? {};
      out.paperdoll.wasmExportNames = Object.keys(wasmExports).filter(k =>
        /^(fetch|animation|surface|entity|paper)/i.test(k)).slice(0, 30);

      // Paperdoll viewport: find canvas in DOM + ask if its pixels are all transparent.
      const viewportCanvas = document.querySelector(".hb-inv-paperdoll-viewport canvas");
      out.paperdoll.viewportCanvasPresent = !!viewportCanvas;
      if (viewportCanvas) {
        out.paperdoll.viewportCanvasSize = { w: viewportCanvas.width, h: viewportCanvas.height,
          cssW: viewportCanvas.clientWidth, cssH: viewportCanvas.clientHeight };
        // Read a small sample of pixels from the WebGL backbuffer via a 2D snapshot.
        try {
          const tmp = document.createElement("canvas");
          tmp.width = viewportCanvas.width; tmp.height = viewportCanvas.height;
          tmp.getContext("2d").drawImage(viewportCanvas, 0, 0);
          const id = tmp.getContext("2d").getImageData(0, 0, tmp.width, tmp.height);
          let nonZero = 0;
          for (let i = 0; i < id.data.length; i += 4) {
            if (id.data[i] || id.data[i+1] || id.data[i+2] || id.data[i+3]) nonZero += 1;
          }
          out.paperdoll.viewportCanvasNonBlank = nonZero > 0;
          out.paperdoll.viewportNonZeroPx = nonZero;
        } catch (e) {
          out.paperdoll.viewportCanvasErr = String(e);
        }
      }
    } catch (e) {
      out.errors.push(String(e));
    }
    return out;
  });

  // Take a screenshot too — useful evidence.
  fs.mkdirSync(path.dirname(OUT_PNG), { recursive: true });
  await page.screenshot({ path: OUT_PNG, fullPage: false });
  fs.writeFileSync(OUT_JSON, JSON.stringify(diag, null, 2));
  console.log("[diag] wrote", OUT_JSON);
  console.log("[diag] wrote", OUT_PNG);
  console.log(JSON.stringify(diag, null, 2));

  await browser.close();
})().catch((e) => {
  console.error("[diag] FAIL", e);
  process.exit(1);
});
