// app/plugin_bar.js — plugin + bar boot: the P6.1 plugin-roster wire answer
// (window.__pluginListWire / __publishPluginList), the loader-driven bar-slot
// build (PLUGIN_MODULES, BAR_SLOT_ORDER / _SUPPRESS / _EXPORT_OVERRIDES, the
// ad-hoc rynthsuite + fullscreen slots, buildBarSlotsViaLoader), main-panel
// view registration, the manifest-hotkey bridge (PLUGIN_HOTKEY_DISPATCH +
// its window keydown listener), the XP-table prefetch and mountBar().
//
// Moved VERBATIM out of index.html's inline script (2026-10-05). index.html
// awaits initPluginBar() at the point this code used to run, so the
// top-level `await buildBarSlotsViaLoader()` still blocks the rest of boot
// exactly as before. `barInstance` stays an index.html `let` (assigned here
// through D's accessor). The plugin modules are imported here directly —
// index.html imports the same URLs first, so module evaluation order is
// unchanged.

import { API_VERSION as CLIENT_API_VERSION } from "../plugins/api.js";
import { probeCapabilities } from "../plugins/webhost.js";
import { mountBar } from "../ui/bar.js";
import { loadPlugins, fetchManifestIndex, formatPluginList } from "../plugins/loader.js";
import { buildManifestBindings as buildManifestHotkeyBindings, setManifestBindings as setManifestHotkeyBindings, setManifestHotkeyConflicts, matchHotkeyEvent as matchManifestHotkeyEvent } from "../ui/keymap.js";
import * as spellbookPlugin from "../plugins/spellbook.js";
import * as inventoryPlugin from "../plugins/inventory.js";
import * as examineTargetPlugin from "../plugins/examine-target.js";
import * as mainPanelPlugin from "../plugins/main-panel.js";
import * as characterInfoPlugin from "../plugins/character-info.js";
import * as mapPanelPlugin from "../plugins/map-panel.js";
import * as allegiancePanelPlugin from "../plugins/allegiance-panel.js";
import * as fellowshipPanelPlugin from "../plugins/fellowship-panel.js";
import * as journalPanelPlugin from "../plugins/journal-panel.js";
import * as contractsPanelPlugin from "../plugins/contracts-panel.js";
import * as lorePanelPlugin from "../plugins/lore-panel.js";
import * as optionsPanelPlugin from "../plugins/options-panel.js";
import * as trainSkillsPlugin from "../plugins/train-skills.js";
import * as emotePanelPlugin from "../plugins/emote-panel.js";

export async function initPluginBar(D) {
  const { __hbWasmNs, pluginsDisabled } = D;
  // P6.1 (2026-07-27) — plugin-manifest wire answer (GameEvent 0x02AE ->
  // GameAction 0x02AF). The roster is computed once from the loader's
  // `loaded` map and pushed into the wasm session, which owns the reply:
  // an admin query must be answered synchronously off the recv loop, so
  // no JS round-trip may sit in that path. `?plugins=none` never runs the
  // loader, leaving the roster "" — wasm then sends retail's
  // "3rd party API not in use." literal, matching retail's
  // `APIIsReady() == false` branch.
  //
  // Called from both ends of the ordering: after the loader resolves (the
  // handle may not exist yet — pre-login) and immediately after each
  // session handle is installed (a reconnect gets a fresh wasm session
  // whose roster starts empty).
  window.__pluginListWire = "";
  window.__publishPluginList = function publishPluginList() {
    const h = window.__sessionHandle;
    if (!h || typeof h.setPluginList !== "function") return false;
    try {
      h.setPluginList(window.__pluginListWire || "");
      return true;
    } catch (err) {
      console.warn(`[plugin-query] setPluginList failed: ${err?.message ?? err}`);
      return false;
    }
  };

  // 2026-05-17 history note (preserved):
  //  - the standalone `⚐ stance-toggle` slot was merged into
  //    the Combat plugin; one slot instead of two.
  //  - the top-of-screen vitals HUD overlay (previously a raw
  //    `#vitals-hud-overlay` div inside this file) was extracted
  //    into `plugins/vitals-hud.js` and registered here with
  //    `iconHidden: true` so it claims no bar real estate but
  //    still runs through the per-slot `mount()` lifecycle.
  //
  // 2026-05-27 (Polish A): the hand-spread `barSlots = [{...manifest,
  // mount, activate}, …]` literal that lived here has been replaced
  // by a loader-driven build. The loader (plugins/loader.js, PR 8)
  // validates every manifest, dependency-orders them per Chorizite
  // §5.5, runs lifecycle hooks, and returns a {manifest, module} set.
  // We then map that set into bar slots, splicing in the two ad-hoc
  // entries (rynthsuite, fullscreen) that have no .manifest.json.
  //
  //   • PLUGIN_MODULES — id → static-import namespace. Lets the
  //     loader skip the dynamic-import path entirely (predictable
  //     compile-time module graph).
  //   • BAR_SLOT_ORDER — keeps the bar's icon/mount order stable
  //     across loader-version changes (loader uses topological
  //     sort, which is not the user-facing visual order).
  //   • BAR_SLOT_SUPPRESS — manifests that ship today but whose
  //     bar surface is intentionally hidden (stance-toggle merged
  //     into combat-bar; emote-panel routed via Shift+F2).
  //   • BAR_SLOT_EXPORT_OVERRIDES — per-id opt-outs from the
  //     default "attach mount + activate if present" rule. The
  //     combat-bar `mount: false` override preserves the existing
  //     pre-Polish-A behaviour (combat-bar.mount currently does not
  //     fire — flip in a follow-up after validating it doesn't
  //     double-mount armed-spell cleanup).
  // J1.C (2026-05-27): only plugins with non-bar uses (`.view`,
  // `.registerView` hosts) retain entries here; the ~18 bar-slot-only
  // plugins (vitals-hud, buffs-hud, target-bar, combat-hud, sneak-hud,
  // radar, chat-panel, status-indicators, hotbar, dye-preview,
  // combat-bar, vendor-ui, radial-menu, container-panel, social-panel,
  // trade-panel, book-panel, house-panel) now resolve via the loader's
  // dynamic `modulePath` path. Same with emote-panel + stance-toggle.
  const PLUGIN_MODULES = {
    "main-panel": mainPanelPlugin,
    // manifest id is `examine-target-watcher` (intentional rename per
    // examine-target.manifest.json:3); the .js filename remained.
    "examine-target-watcher": examineTargetPlugin,
    "spellbook": spellbookPlugin,
    "inventory": inventoryPlugin,
    "map-panel": mapPanelPlugin,
    "allegiance-panel": allegiancePanelPlugin,
    "fellowship-panel": fellowshipPanelPlugin,
    "journal-panel": journalPanelPlugin,
    "contracts-panel": contractsPanelPlugin,
    "lore-panel": lorePanelPlugin,
    // Wave 4.A (2026-05-28) — Train Skills (gmSkillUI port).
    "train-skills": trainSkillsPlugin,
  };

  const BAR_SLOT_ORDER = [
    // vitals-orbs sits next to vitals-hud because they are mutually
    // exclusive (?vitalsOrbs=on) — whichever loses the flag mounts a
    // no-op, so listing both here costs nothing and keeps the mount
    // order deterministic instead of relying on the append-at-end
    // fallback for unlisted candidate slots.
    "vitals-hud", "vitals-orbs", "buffs-hud", "target-bar", "combat-hud", "sneak-hud",
    "radar", "chat-panel", "status-indicators", "hotbar", "main-panel",
    "dye-preview", "examine-target-watcher",
    // (rynthsuite + fullscreen ad-hoc slots get spliced here)
    "combat-bar",
    "vendor-ui",
  ];

  const BAR_SLOT_SUPPRESS = new Set([
    "stance-toggle",  // merged into combat-bar 2026-05-17
    "emote-panel",    // routed via Shift+F2 / Wave F.6 chat slash
  ]);

  const BAR_SLOT_EXPORT_OVERRIDES = {
    // Pre-Polish-A behaviour: combat-bar's mount() was not wired
    // through the barSlot literal. Preserving that omission here so
    // Polish A is a pure refactor; flip to {mount:true, activate:true}
    // in a follow-up if you've verified mount() is idempotent.
    "combat-bar": { mount: false, activate: true },
  };

  // Ad-hoc bar slots (no .manifest.json — they're inlined here
  // because they have no underlying plugin module). Spliced into
  // BAR_SLOT_ORDER between `examine-target` and `combat-bar`.
  const AD_HOC_BAR_SLOTS = [
    {
      id: "rynthsuite",
      name: "RynthSuite",
      icon: "⚒",
      panelBody:
        "RynthSuite grind bot — boot with ?bot=1 (add ?aiPanel=1 for the AI director UI). " +
        "Console: window.__bot.kernel.status / window.rynthAI.status(). In-game: !bot help.",
    },
    {
      // Task C v2 (2026-07-02, user request): the spellbook lives in
      // the main-panel view system (target-bar button / F5), but HUD
      // position/visibility issues can strand those surfaces — this
      // sidebar slot is the always-reachable route, plus a rescue
      // button that clears every persisted hb.window.* position and
      // un-minimizes the plugin bar.
      id: "spellbook-shortcut",
      name: "Spellbook",
      icon: "📖",
      iconSprite: "0x06001119",
      activate: (bodyEl) => {
        bodyEl.innerHTML = "";
        const mk = (tag, css, text) => {
          const el = document.createElement(tag);
          if (css) el.style.cssText = css;
          if (text != null) el.textContent = text;
          bodyEl.appendChild(el);
          return el;
        };
        const status = mk("div", "margin-bottom:8px;color:var(--hb-text-cream,#fff);");
        const openBtn = mk("button", "padding:6px 12px;background:rgba(120,84,32,0.5);color:#fff;border:1px solid #8a7544;border-radius:3px;cursor:pointer;font-family:inherit;display:block;margin-bottom:10px;", "Open Spellbook");
        openBtn.type = "button";
        const refresh = () => {
          const mp = window.__mainPanel;
          status.textContent = mp
            ? (mp.isOpen?.() && mp.currentViewId?.() === "spellbook"
                ? "Spellbook is open in the main panel."
                : "Opens the spellbook in the main panel.")
            : "Main panel not ready yet — try again in a moment.";
        };
        openBtn.addEventListener("click", () => {
          try { window.__mainPanel?.toggleView?.("spellbook"); } catch (_) {}
          setTimeout(refresh, 50);
        });
        const rescueBtn = mk("button", "padding:6px 12px;background:rgba(90,32,32,0.5);color:#fff;border:1px solid #8a5544;border-radius:3px;cursor:pointer;font-family:inherit;display:block;", "Reset HUD positions");
        rescueBtn.type = "button";
        mk("div", "margin-top:8px;font-size:10px;color:rgba(255,255,255,0.55);font-style:italic;",
          "Reset clears every saved window position (main panel, chat, spell bar, plugin bar) and reloads — use when a panel is stuck off-screen.");
        rescueBtn.addEventListener("click", () => {
          if (!window.confirm("Reset all saved HUD window positions and reload?")) return;
          try {
            const doomed = [];
            for (let i = 0; i < localStorage.length; i++) {
              const k = localStorage.key(i);
              if (k && k.startsWith("hb.window.")) doomed.push(k);
            }
            doomed.forEach((k) => localStorage.removeItem(k));
            // Un-minimize + re-dock the plugin bar itself.
            const rawBar = localStorage.getItem("holtburger_ui_bar_v1");
            if (rawBar) {
              const st = JSON.parse(rawBar);
              st.minimized = false;
              st.left = null;
              st.top = null;
              localStorage.setItem("holtburger_ui_bar_v1", JSON.stringify(st));
            }
          } catch (_) {}
          location.reload();
        });
        refresh();
      },
    },
    {
      // PR-MM 2026-05-23: fullscreen toggle in the (deprecated)
      // plugin bar. Uses the browser Fullscreen API on
      // #canvas-column (the wrapper holding #canvas + keypad),
      // matching the existing #fullscreen-btn that's hidden in
      // agent-mode (index.html:759). Going fullscreen on the
      // column lets the canvas expand to native screen
      // resolution via the existing :fullscreen CSS rules at
      // index.html:177-178.
      id: "fullscreen",
      name: "Fullscreen",
      icon: "⛶",
      activate: (bodyEl) => {
        // PR-NN 2026-05-23: target document.documentElement so
        // fullscreen works in BOTH agent-mode (canvas-column may
        // be 0x0 because the body>* whitelist hides it; #stage is
        // the visible carrier) AND normal 3D-render mode. The
        // html:fullscreen CSS above expands #stage/#canvas to
        // 100vw/100vh in either mode. Was previously targeting
        // canvas-column which only worked in normal mode.
        bodyEl.innerHTML = "";
        const status = document.createElement("div");
        status.style.cssText = "margin-bottom:8px;color:var(--hb-text-cream,#fff);";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.style.cssText = "padding:6px 12px;background:rgba(120,84,32,0.5);color:#fff;border:1px solid #8a7544;border-radius:3px;cursor:pointer;font-family:inherit;";
        const note = document.createElement("div");
        note.style.cssText = "margin-top:8px;font-size:10px;color:rgba(255,255,255,0.55);font-style:italic;";
        note.textContent = "Press Esc to exit fullscreen.";
        function refresh() {
          const on = !!document.fullscreenElement;
          status.textContent = on
            ? "Currently fullscreen — canvas at screen resolution."
            : "Currently windowed.";
          btn.textContent = on ? "Exit Fullscreen" : "Enter Fullscreen";
        }
        btn.addEventListener("click", () => {
          if (document.fullscreenElement) {
            document.exitFullscreen?.();
          } else {
            document.documentElement.requestFullscreen?.()
              .then(() => {
                // Three.js / Pixi canvas needs a resize to pick up
                // the new viewport. Some renderers auto-resize via
                // ResizeObserver; many don't. Dispatch a resize
                // event so listeners (scene3d/index.js handleResize)
                // re-compute camera projection + renderer drawing
                // buffer at native res.
                setTimeout(() => {
                  window.dispatchEvent(new Event("resize"));
                }, 50);
              })
              .catch((e) => console.warn("[fullscreen] request failed:", e));
          }
          setTimeout(refresh, 100);
        });
        const onChange = () => refresh();
        document.addEventListener("fullscreenchange", onChange);
        // Best-effort cleanup when the popover closes:
        // the bar's closePanel removes bodyEl from the DOM, so
        // listen for disconnection via MutationObserver.
        const obs = new MutationObserver(() => {
          if (!bodyEl.isConnected) {
            document.removeEventListener("fullscreenchange", onChange);
            obs.disconnect();
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        bodyEl.appendChild(status);
        bodyEl.appendChild(btn);
        bodyEl.appendChild(note);
        refresh();
      },
    },
  ];

  // Drive the PR 8 loader. Returns a barSlots array ready for
  // `mountBar({ slots: ... })`. The loader's `loaded` Map preserves
  // its internal load order (dependency-resolved topological from
  // resolveDependencies); we reorder per BAR_SLOT_ORDER for stable
  // bar appearance. The two ad-hoc slots are spliced in at the
  // documented join point.
  async function buildBarSlotsViaLoader() {
    // Build a manifest-index URL the loader can fetch. Using
    // document.baseURI keeps it correct under both file:// and the
    // dev server (vite/serve-static/etc.); the index.json sits next
    // to the .manifest.json files it points at.
    const indexUrl = new URL("./plugins/index.json", document.baseURI).href;

    // [a] Discover manifests + per-plugin manifest.json files.
    const { entries, skipped: indexSkipped } =
      await fetchManifestIndex({ indexUrl });
    for (const s of indexSkipped) {
      console.warn(`[plugin-loader] index skip: ${s.reason}`);
    }

    // [b] Attach the pre-imported namespace module to each entry.
    // The loader's dynamic-import fallback (entry.modulePath) only
    // runs when entry.module is absent — used here for the two
    // manifests that aren't statically imported (emote-panel,
    // stance-toggle). Both end up BAR_SLOT_SUPPRESS-ed so this is
    // belt-and-suspenders, but it keeps the lifecycle hooks running.
    for (const entry of entries) {
      const mod = PLUGIN_MODULES[entry.manifest?.id];
      if (mod) entry.module = mod;
    }

    // P6.1 — the host half of the facade contract the loader enforces.
    // `capabilities` comes from SessionHandle.prototype (see the import
    // note): identical to a live probe for a method-only set, and
    // available now, which a session is not. `null` => gate inert, so a
    // stale/missing pkg/ can never mass-skip the plugin tree.
    let __clientCapabilities = null;
    try {
      const proto = __hbWasmNs?.SessionHandle?.prototype;
      if (proto) {
        __clientCapabilities = probeCapabilities(proto);
        window.__clientCapabilities = __clientCapabilities;
      }
    } catch (err) {
      console.warn(`[plugin-loader] capability probe skipped: ${err?.message ?? err}`);
    }

    // [c] Validate, resolve deps, run lifecycle hooks. The 5-stage
    // hooks (onBeforeLoad/onLoad) fire here; today no plugin exports
    // them so this is a no-op pass that just builds the `loaded` Map.
    const { loaded, skipped } = await loadPlugins({
      entries,
      environment: "browser",
      context: { host: "holtburger-web" },
      apiVersion: CLIENT_API_VERSION,
      capabilities: __clientCapabilities,
      log: (level, msg) => {
        // Quiet info; warn/error → console.
        if (level === "warn") console.warn(`[plugin-loader] ${msg}`);
        else if (level === "error") console.error(`[plugin-loader] ${msg}`);
      },
    });
    for (const s of skipped) {
      console.warn(`[plugin-loader] skipped ${s.id || "<unknown>"}: ${s.reason}`);
    }

    // Polish-A→B bridge (2026-05-27): register manifest-declared hotkeys
    // with the keymap resolver. Polish B's API; consumed by the keydown
    // handler below. Plugins without `hotkeys[]` in their manifest are
    // silently ignored. Wave J1.B (2026-05-27) retired the legacy
    // FKEY_VIEWS / FKEY_SHIFT_TOGGLES fallback tables; every dispatched
    // F-key now flows through a manifest hotkey (character-info F1,
    // options-panel F10, spell-research-panel Shift+F4 ship with their
    // own manifests as of J1.B).
    // P6.1 — publish the `id@version` roster for the 0x02AE answer.
    // `loaded` is the loader's own map, so this is the single source of
    // truth for "which plugins does this client have".
    try {
      window.__pluginListWire = formatPluginList(loaded);
      window.__publishPluginList();
    } catch (err) {
      console.warn(`[plugin-query] roster build skipped: ${err?.message ?? err}`);
    }

    try {
      const manifestList = [...loaded.values()].map((v) => v.manifest);
      const { map: hotkeyMap, duplicates } = buildManifestHotkeyBindings(manifestList);
      setManifestHotkeyBindings(hotkeyMap);
      // HUD rec #113 — persist conflicts so the Options Controls
      // tab can surface them to the player + suggest rebinding.
      setManifestHotkeyConflicts(duplicates || []);
      if (duplicates && duplicates.length) {
        console.warn(`[hotkey-bindings] duplicates: ${duplicates.map((d) => d.key).join(", ")}`);
      }
    } catch (err) {
      console.warn(`[hotkey-bindings] skip: ${err?.message ?? err}`);
    }

    // [d] Build candidate slot map from the loaded set.
    const candidateSlots = new Map();
    for (const [id, { manifest, module }] of loaded) {
      if (BAR_SLOT_SUPPRESS.has(id)) continue;
      if (!module) continue;
      const overrides = BAR_SLOT_EXPORT_OVERRIDES[id] || {};
      const hasMount = typeof module.mount === "function";
      const hasActivate = typeof module.activate === "function";
      const includeMount = (overrides.mount !== false) && hasMount;
      const includeActivate = (overrides.activate !== false) && hasActivate;
      if (!includeMount && !includeActivate) continue;
      const slot = { ...manifest };
      if (includeMount) slot.mount = module.mount;
      if (includeActivate) slot.activate = module.activate;
      candidateSlots.set(id, slot);
    }

    // [e] Splice in BAR_SLOT_ORDER + ad-hoc entries. Anything in
    // `candidateSlots` that's NOT in BAR_SLOT_ORDER gets appended
    // at the end (future-proof; today nothing falls into this case
    // because all candidate ids are listed in BAR_SLOT_ORDER).
    const ordered = [];
    const seen = new Set();
    for (const id of BAR_SLOT_ORDER) {
      if (id === "combat-bar" && AD_HOC_BAR_SLOTS.length > 0) {
        // Splice the ad-hoc slots immediately before combat-bar to
        // match the original explicit ordering (examine-target →
        // rynthsuite → fullscreen → combat-bar → vendor-ui).
        for (const adhoc of AD_HOC_BAR_SLOTS) ordered.push(adhoc);
      }
      const slot = candidateSlots.get(id);
      if (slot) {
        ordered.push(slot);
        seen.add(id);
      }
    }
    for (const [id, slot] of candidateSlots) {
      if (!seen.has(id)) ordered.push(slot);
    }
    return ordered;
  }

  // Build the bar slots. Top-level await is fine inside a
  // <script type="module">; the awaits later in this file
  // (init(), manifest fetch) already exercise this path.
  // When `?plugins=none` is set we skip the loader entirely —
  // mountBar() below is already gated on !pluginsDisabled, so an
  // empty array here just saves a round of 29 manifest fetches.
  const barSlots = pluginsDisabled ? [] : await buildBarSlotsViaLoader();

  // Register views with the main-panel container (PR-U). Inventory
  // and Examine share one pane; main-panel.pushView routes between
  // them with a view stack so "Back" returns to inventory.
  // See docs/examine-architecture-2026-05-22.md.
  // 2026-05-23 — gated on !pluginsDisabled. When ?plugins=none is set,
  // main-panel never mounts so __mainPanel is undefined and these
  // views would no-op anyway, but skipping the calls is tidier.
  if (!pluginsDisabled) {
    mainPanelPlugin.registerView("inventory", inventoryPlugin.view);
    mainPanelPlugin.registerView("examine",   examineTargetPlugin.view);
    mainPanelPlugin.registerView("character", characterInfoPlugin.view);
    mainPanelPlugin.registerView("map",       mapPanelPlugin.view);
    mainPanelPlugin.registerView("allegiance", allegiancePanelPlugin.view);
    mainPanelPlugin.registerView("fellowship", fellowshipPanelPlugin.view);
    mainPanelPlugin.registerView("spellbook", spellbookPlugin.view);
    mainPanelPlugin.registerView("journal",   journalPanelPlugin.view);
    mainPanelPlugin.registerView("contracts", contractsPanelPlugin.view);
    // HUD rec #181 — Personal Library (Shift+F8). matchManifestHotkeyEvent
    // resolves the manifest hotkey → pluginId "lore-panel" → strip "-panel"
    // → "lore" view via the generic toggleView bridge.
    mainPanelPlugin.registerView("lore",      lorePanelPlugin.view);
    // PR-II (2026-05-23): Options view — main-panel port of retail
    // gmConfigUI (layout 0x21000029). Same convention as Inventory /
    // Character / Spellbook / etc. — shares the right-side pane and
    // gets brass-rim chrome from main-panel's container slot.
    mainPanelPlugin.registerView("options",   optionsPanelPlugin.view);
    // BAND-B S3 (2026-06-17): the standalone Train Skills view is RETIRED —
    // its gmSkillUI raise/train flow now lives in the character pane's
    // Skills tab (the gmStatManagementUI improve-footer). train-skills.js is
    // still imported (its pure helpers `computeNextRaiseCost` /
    // `decideTrainAction` / `TRAINING` are used by character-info.js + the
    // unit test), but no longer registered as a view. F11 is repointed to
    // `__mainPanel.showView('character', { tab: 'skills' })` via the
    // PLUGIN_HOTKEY_DISPATCH override below.
    // R2 (BAND-C1): Emote Palette as a main-panel view (Shift+F2). The
    // generic strip rule maps pluginId "emote-panel" → view "emote" →
    // toggleView, so no PLUGIN_HOTKEY_DISPATCH entry is needed.
    mainPanelPlugin.registerView("emote", emotePanelPlugin.view);
  }
  // PR-GG (2026-05-23): vendor-ui is its own top-level horizontal bar
  // (retail gmVendorUI layout 0x21000012), NOT a main-panel view.
  // The plugin's bar-slot mount() builds a standalone overlay; the
  // kind=12 VendorOpened handler shows it. PR-CC's registerView call
  // is gone — vendor never shares the inventory/skills/etc. pane.

  // Main-panel view hotkeys — F-keys only. Single-letter bindings
  // (S, A, F, C, J, K, M, E) were retired 2026-05-22 per user
  // direction: "these keymap changes have served their purpose and
  // are approaching interference." S collided with strafe-back,
  // A with strafe-left, etc. F-keys never collide with movement.
  //   F1 Character    F2 Spellbook   F3 Map        F4 Inventory
  //   F5 Spellbook    F6 Journal     F7 Contracts  F8 Allegiance
  //   F9 Fellowship   F10 Options (PR-II 2026-05-23)
  // Shift+F4 toggles the Spell Research panel; Shift+F6 toggles the
  // House panel. These overlays live outside main-panel's view set
  // (each is its own document-body overlay), so they need a custom
  // PLUGIN_HOTKEY_DISPATCH entry rather than the generic
  // toggleView(viewName) path.
  // Examine is no longer auto-fired on selection (regression fix
  // 2026-05-22): clicking a vendor / NPC now passes through to the
  // interact path. Open examine via main-panel toggle if needed.
  //
  // Wave J1.B (2026-05-27): the FKEY_VIEWS / FKEY_SHIFT_TOGGLES
  // tables that lived here have been retired in favour of manifest
  // hotkey declarations (plugins/*.manifest.json#/hotkeys[]). The
  // bridge below resolves a `KeyboardEvent` to a manifest action
  // via `matchManifestHotkeyEvent` and dispatches via:
  //   1. PLUGIN_HOTKEY_DISPATCH explicit override — when the plugin
  //      is a standalone overlay (no main-panel view) or its view
  //      name does not match the bridge's generic strip rule.
  //   2. The generic rule — strip "com.holtburger." prefix and
  //      "-panel" suffix from the plugin id, then call
  //      `__mainPanel.toggleView(viewName)`.
  // Source of truth for what's bound where: plugins/*.manifest.json.
  const PLUGIN_HOTKEY_DISPATCH = {
    // character-info.js's view registers as "character" (see
    // mainPanelPlugin.registerView("character", …) above). The
    // generic strip rule would dispatch to "character-info", which
    // is unregistered. Explicit override keeps the manifest id
    // aligned with the file basename.
    "character-info": () => window.__mainPanel?.toggleView?.("character"),
    // spell-research-panel.js is a standalone overlay (its own
    // document-body element, not a main-panel view). The plugin
    // exposes window.__toggleSpellResearchPanel; the bridge calls
    // it directly. Same pattern that house-panel / emote-panel
    // could later adopt for their non-main-panel hotkeys.
    "spell-research-panel": () => window.__toggleSpellResearchPanel?.(),
    // R3/R4 (BAND-C1): social-panel (Shift+F3) and house-panel (Shift+F6)
    // are standalone overlays, not main-panel views — dispatch straight to
    // their toggle globals (same pattern as spell-research above).
    "social-panel": () => window.__toggleSocialPanel?.(),
    "house-panel": () => window.__toggleHousePanel?.(),
    // BAND-B S3 (2026-06-17): F11 (train-skills manifest hotkey) opens the
    // SHARED character pane at the Skills tab instead of the retired
    // standalone view. showView (NOT toggleView) — toggleView would CLOSE
    // the pane when it's already open on any character tab; showView resets
    // the stack and re-mounts honoring ctx.tab, so F11 always lands on
    // Skills even mid-Attributes.
    // HUD overhaul 2026-10-05: F11 opens Character Information on its Skills
    // tab (train-skills was folded into it); __openCharacterTab toggles.
    "train-skills": () => (window.__openCharacterTab
      ? window.__openCharacterTab("skills")
      : window.__mainPanel?.showView?.("character", { tab: "skills" })),
  };
  window.addEventListener("keydown", (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = ev.target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    // HUD rec #61 — contentEditable inputs (rich text widgets, chat
    // composer, future inline-edit panels) should not steal F-key
    // hotkeys mid-typing. Covers any element with the attribute set,
    // not just the two HTML tags above.
    if (ev.target?.isContentEditable) return;

    // Polish B (2026-05-27): manifest-declared hotkeys take precedence.
    // Plugin id → view-name convention: strip "com.holtburger." prefix
    // and "-panel" suffix (matches main-panel.registerView naming).
    // Wave J1.B: PLUGIN_HOTKEY_DISPATCH takes precedence over the
    // generic strip rule for the standalone-overlay / mismatched-name
    // cases (character-info → "character", spell-research-panel →
    // standalone overlay).
    const action = matchManifestHotkeyEvent(ev);
    if (action && action.pluginId) {
      ev.preventDefault();
      // Press edge only: these are TOGGLES, so OS autorepeat of a held key
      // flickered the panel open/closed ~30x/s and left it in whichever
      // state the last repeat landed on.
      if (ev.repeat) return;
      const dispatch = PLUGIN_HOTKEY_DISPATCH[action.pluginId];
      if (dispatch) {
        dispatch();
      } else {
        const view = action.pluginId
          .replace(/^com\.holtburger\./, "")
          .replace(/-panel$/, "");
        window.__mainPanel?.toggleView?.(view);
      }
      return;
    }
  });

  // Mount the bar immediately — it doesn't depend on session state.
  // The facade is created post-login and stored on window.__pluginClient.
  // 2026-05-23 — gated on !pluginsDisabled. Skipping mountBar avoids
  // every plugin's mount() side effects (DOM append, per-frame tick
  // hookups, requestAnimationFrame drivers). barInstance stays null,
  // window.__barInstance stays undefined; downstream consumers like
  // window.__pluginClient.attack() use the wire client directly
  // (window.__sessionHandle), not the bar.
  if (!pluginsDisabled) {
    // Pre-fetch XP rank tables so character-info raise buttons render
    // on first open instead of flashing in after a ~100ms async delay
    // (HUD rec #15 — D09 vitals/attributes streams). character-info.js
    // loadXpTables() reuses this promise; the .then() seeds ._cached so
    // the synchronous render path at line 671 sees data immediately.
    if (!window.__xpTablesPromise) {
      window.__xpTablesPromise = fetch("./data/xp-tables.json")
        .then((r) => r.json())
        .then((t) => { window.__xpTablesPromise._cached = t; return t; })
        .catch(() => null);
    }
    if (document.body) {
      D.barInstance = mountBar({ client: null, root: document.body, slots: barSlots });
      window.__barInstance = D.barInstance;
    } else {
      window.addEventListener("DOMContentLoaded", () => {
        D.barInstance = mountBar({ client: null, root: document.body, slots: barSlots });
        window.__barInstance = D.barInstance;
      });
    }
  }
}
