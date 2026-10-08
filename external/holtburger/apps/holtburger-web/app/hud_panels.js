// app/hud_panels.js — the legacy vitals / attributes / skills / inventory
// panels and the selected-item box (DOM refs, click wiring, snapshot
// renderers). Extracted verbatim from index.html's inline script (2026-10-05);
// index.html calls initHudPanels() at the same point the code used to run and
// receives renderVitalsPanel / renderInventoryPanel back for the ClientEvent
// dispatcher.

import { escapeHtml } from "./dom_utils.js";

export function initHudPanels(D) {
  const { skillName, attributeName, vitalName } = D;
  // Phase 4 step 4 follow-on (vitals + inventory panels) — DOM
  // refs + render helpers.
  const vitalsPanel = document.getElementById("vitals-panel");
  const vitalsName = document.getElementById("vitals-name");
  const vitalsLevel = document.getElementById("vitals-level");
  const vitalsBars = document.getElementById("vitals-bars");
  // Phase H.2 — top-of-screen vitals HUD. Extracted into
  // `plugins/vitals-hud.js` on 2026-05-17 per the
  // "everything is a plugin" framework; the plugin's mount
  // lifecycle creates its own overlay div + subscribes to
  // `playerStatsUpdated`. No-op here (kept for the diff context
  // around the removed `renderVitalsHud` call).
  const attributeTable = document.getElementById("attribute-table").querySelector("tbody");
  const skillTable = document.getElementById("skill-table").querySelector("tbody");
  const inventoryPanel = document.getElementById("inventory-panel");
  const inventoryEmpty = document.getElementById("inventory-empty");
  const invEquippedH = document.getElementById("inv-equipped-h");
  const invPackH = document.getElementById("inv-pack-h");
  const invEquipped = document.getElementById("inv-equipped");
  const invPack = document.getElementById("inv-pack");
  // Phase J.3 — Selected Item Box DOM refs + state.
  const selectedItemBox = document.getElementById("selected-item-box");
  const selectedItemName = document.getElementById("selected-item-name");
  const selectedItemUseBtn = document.getElementById("selected-item-use");
  const selectedItemExamineBtn = document.getElementById("selected-item-examine");
  const selectedItemClearBtn = document.getElementById("selected-item-clear");
  let selectedItemGuid = 0;
  window.getSelectedItemGuid = () => selectedItemGuid;
  function setSelectedItem(guid, name) {
    selectedItemGuid = guid >>> 0;
    if (selectedItemGuid === 0) {
      selectedItemBox.hidden = true;
      for (const li of document.querySelectorAll("#inv-equipped li.selected, #inv-pack li.selected")) {
        li.classList.remove("selected");
      }
      return;
    }
    selectedItemName.textContent = name || `Item 0x${selectedItemGuid.toString(16)}`;
    selectedItemBox.hidden = false;
    // Highlight the matching li.
    for (const li of document.querySelectorAll("#inv-equipped li, #inv-pack li")) {
      li.classList.toggle("selected", Number(li.dataset.guid) === selectedItemGuid);
    }
  }
  selectedItemClearBtn.addEventListener("click", () => setSelectedItem(0));

  // Group C (2026-07-07): client-side "use item on target" targeting flow.
  // Rust decides (classifyUse.needsTarget + canUseWith legality); JS only
  // holds the transient pending-target UI state and renders the prompt +
  // crosshair cursor. Mirrors retail ItemHolder::UseObject / TargetAcquired
  // (acclient.c:433354 / :433578). Pending state lives on window so
  // scene3d/picking.js (world targets) shares the same flow.
  window.__useTargeting = window.__useTargeting || {
    pending: null, // { itemGuid, itemName } while awaiting a target click
    begin(itemGuid, itemName) {
      this.pending = { itemGuid: itemGuid >>> 0, itemName: itemName || "item" };
      document.body.classList.add("use-targeting");
      window.__pluginClient?.events?.emit?.("clientActionRejected", {
        message: `Choose a target for ${this.pending.itemName} (Esc to cancel)`,
      });
    },
    cancel() {
      if (!this.pending) return;
      this.pending = null;
      document.body.classList.remove("use-targeting");
      // clear any lingering hover-reticule outlines (canvas + inventory)
      for (const el of document.querySelectorAll(".use-target-ok, .use-target-bad")) {
        el.classList.remove("use-target-ok", "use-target-bad");
      }
    },
    // Consume a target click. Returns true iff a use was pending (caller
    // swallows the click). Rust's canUseWith is the legality gate; the
    // server re-validates, so an approximate client answer is safe.
    resolve(targetGuid) {
      if (!this.pending) return false;
      const h = window.__sessionHandle;
      const { itemGuid, itemName } = this.pending;
      let ok = false;
      try { ok = !!(h && typeof h.canUseWith === "function" && h.canUseWith(itemGuid >>> 0, targetGuid >>> 0)); } catch (_) {}
      if (ok) {
        try { h.useWithTarget(itemGuid >>> 0, targetGuid >>> 0); }
        catch (e) { console.warn(`[use-target] useWithTarget: ${e?.message ?? e}`); }
      } else {
        window.__pluginClient?.events?.emit?.("clientActionRejected", {
          message: `You cannot use the ${itemName} on that.`,
        });
      }
      this.cancel();
      return true;
    },
  };

  selectedItemUseBtn.addEventListener("click", () => {
    if (!selectedItemGuid) return;
    const h = window.__sessionHandle;
    try {
      // Retail ItemHolder::UseObject for an owned item (plugins/inventory.js
      // activateItem): wield / wear / salvage / target mode before a Use.
      if (window.__inventory?.activateItem?.(selectedItemGuid) === true) return;
      // Group C: if the item requires a target (Rust classifyUse), enter
      // targeting mode instead of firing a bare Use (0x0036).
      if (h && typeof h.classifyUse === "function") {
        let needsTarget = false;
        let intent = null;
        try { intent = h.classifyUse(selectedItemGuid); needsTarget = !!intent.needsTarget; }
        finally { if (intent && typeof intent.free === "function") intent.free(); }
        if (needsTarget) {
          window.__useTargeting.begin(selectedItemGuid, selectedItemName?.textContent);
          return;
        }
      }
      if (h && typeof h.useObject === "function") h.useObject(selectedItemGuid);
    } catch (e) {
      console.warn(`[selected-item] Use(0x${selectedItemGuid.toString(16)}): ${e?.message ?? e}`);
    }
  });
  selectedItemExamineBtn.addEventListener("click", () => {
    if (!selectedItemGuid) return;
    // R8: open the examine view for the selected inventory item. The wasm
    // side already cached the appraisal (auto IdentifyObject on
    // ObjectCreate), so __showExamineFor just surfaces it. fromInventory
    // mirrors inventory.js's examine contract (vs fromEntity for world).
    const name = selectedItemName?.textContent || `Item 0x${selectedItemGuid.toString(16)}`;
    if (typeof window.__showExamineFor === "function") {
      window.__showExamineFor(selectedItemGuid, { name, fromInventory: true });
    } else {
      window.__mainPanel?.pushView?.("examine", { guid: selectedItemGuid, name, fromInventory: true });
    }
  });
  // Click anywhere in an inv list → select that item.
  // Drag from pack list → exposes the item GUID via
  // `text/x-hb-item-guid` dataTransfer for plugins (vendor-ui
  // accepts this as a sell drop).
  function attachInventorySelection() {
    for (const ul of [invEquipped, invPack]) {
      ul.addEventListener("click", (ev) => {
        const li = ev.target.closest("li[data-guid]");
        if (!li) return;
        const guid = Number(li.dataset.guid) >>> 0;
        const name = li.querySelector(".name")?.textContent ?? "";
        // Group C: while a use-on-target is pending, clicking an inventory
        // item selects it as the TARGET (e.g. oil/dye on a weapon/armor)
        // rather than changing the selection.
        if (window.__useTargeting?.pending && window.__useTargeting.pending.itemGuid !== guid) {
          window.__useTargeting.resolve(guid);
          return;
        }
        setSelectedItem(guid, name);
      });
      // Group C hover reticule for inventory-item targets: outline legal
      // (Rust canUseWith) vs illegal items while a use-on-target is pending.
      ul.addEventListener("mouseover", (ev) => {
        const T = window.__useTargeting;
        if (!T?.pending) return;
        const li = ev.target.closest("li[data-guid]");
        if (!li) return;
        const g = Number(li.dataset.guid) >>> 0;
        const h = window.__sessionHandle;
        let ok = false;
        try { ok = !!(h && typeof h.canUseWith === "function" && g !== T.pending.itemGuid && h.canUseWith(T.pending.itemGuid >>> 0, g)); } catch (_) {}
        li.classList.toggle("use-target-ok", ok);
        li.classList.toggle("use-target-bad", !ok);
      });
      ul.addEventListener("mouseout", (ev) => {
        const li = ev.target.closest("li[data-guid]");
        if (li) li.classList.remove("use-target-ok", "use-target-bad");
      });
      ul.addEventListener("dragstart", (ev) => {
        const li = ev.target.closest("li[data-guid]");
        if (!li || !li.draggable) return;
        const guid = Number(li.dataset.guid) >>> 0;
        const name = li.querySelector(".name")?.textContent ?? "";
        // Wave D / PR11 (2026-06-06): dual-mime so the polymorphic
        // grid drop-sites (bag-tabs, container-panel, paperdoll,
        // canvas) parse the legacy <li> as a peer. effectAllowed
        // moves to 'move' since these now route through moveItem /
        // dropItem / setWielded — not a copy.
        ev.dataTransfer.setData("application/x-hb-inv-guid", String(guid));
        ev.dataTransfer.setData("text/x-hb-item-guid", String(guid));
        ev.dataTransfer.setData("text/plain", name);
        ev.dataTransfer.effectAllowed = "move";
        // Wave C / PR9 (2026-06-06): iconId-driven Image ghost. The
        // legacy <ul>'s <li> rendering stashes the iconId on a child
        // .icon element's background-image; pull it through a new
        // Image so the ghost matches the polymorphic-grid path.
        try {
          const iconEl = li.querySelector(".icon");
          const bg = iconEl ? getComputedStyle(iconEl).backgroundImage : "";
          const m = bg && bg !== "none" ? /url\(["']?([^"')]+)["']?\)/.exec(bg) : null;
          if (m && m[1]) {
            const img = new Image();
            img.src = m[1];
            img.width = 32; img.height = 32;
            ev.dataTransfer.setDragImage(img, 16, 16);
          }
        } catch (_) {}
      });
    }
  }
  attachInventorySelection();

  // Vital colour-class lookup. Maps the wasm-side VitalType
  // numeric id (Health=1, Stamina=3, Mana=5) to the CSS class
  // hooks defined in `#vitals-panel .vital-bar.{health,stamina,mana}`.
  const VITAL_CSS_CLASS = { 1: "health", 3: "stamina", 5: "mana" };

  // Phase 4 step 4 follow-on: re-render the vitals panel from
  // the wasm bundle's PlayerStatsSnapshot. Called from the
  // drainEvents tick on every kind=8 event. The snapshot getter
  // is a fresh struct each call (clones the inner LatestStats),
  // so this is bounded work.
  function renderVitalsPanel(handle) {
    if (!handle) return;
    // Copy-then-free: playerStats() hands back a wasm-bindgen
    // PlayerStatsSnapshot box. This runs on EVERY kind=8 — i.e. every
    // vital regen tick — so the box must be released deterministically
    // rather than left to the FinalizationRegistry. The body is split
    // out (unchanged) so the free stays throw-safe in a `finally`.
    const stats = handle.playerStats();
    try {
      renderVitalsPanelFromSnapshot(stats);
    } finally {
      stats?.free?.();
    }
  }
  function renderVitalsPanelFromSnapshot(stats) {
    const name = stats.name || "—";
    vitalsName.textContent = name;

    // Level / xp summary. levelInfo packs:
    //   [level, current_xp_lo, current_xp_hi, unspent_xp_lo,
    //    unspent_xp_hi, available_luminance_lo, available_luminance_hi]
    const lvl = stats.levelInfo;
    if (lvl && lvl.length === 7) {
      const level = lvl[0];
      // BigInt reassembly so XP > 2^32 displays correctly. Most
      // test characters are level <50 so XP fits in 32 bits, but
      // a level-275+ character has cumulative XP in the trillions.
      const currentXp = (BigInt(lvl[2]) << 32n) | BigInt(lvl[1]);
      const unspentXp = (BigInt(lvl[4]) << 32n) | BigInt(lvl[3]);
      vitalsLevel.textContent =
        `Level ${level} · ${currentXp.toString()} XP` +
        (unspentXp > 0n ? ` (${unspentXp.toString()} unspent)` : "");
    } else {
      vitalsLevel.textContent = "Level 0";
    }

    // Vitals bars. `vitals` packs `[type, current, base, buffed_max] × 3`.
    const vitals = stats.vitals;
    // (vitals-hud plugin handles its own re-render via the
    // `playerStatsUpdated` event the kind=8 dispatcher emits.)
    if (!vitals || vitals.length === 0) {
      vitalsBars.innerHTML = '<div class="empty">Waiting for player biota…</div>';
    } else {
      const rows = [];
      for (let i = 0; i + 3 < vitals.length; i += 4) {
        const type = vitals[i];
        const current = vitals[i + 1];
        const buffedMax = vitals[i + 3];
        const cls = VITAL_CSS_CLASS[type] || "";
        const label = vitalName(type);
        const pct = buffedMax > 0
          ? Math.max(0, Math.min(100, (current / buffedMax) * 100))
          : 0;
        rows.push(
          `<div class="vital-row">` +
            `<span class="label">${label}</span>` +
            `<div class="vital-bar ${cls}"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>` +
            `<span class="nums">${current} / ${buffedMax}</span>` +
          `</div>`
        );
      }
      vitalsBars.innerHTML = rows.join("");
    }

    // Attribute table. `attributes` packs `[type, current, base, ranks] × 6`.
    const attributes = stats.attributes;
    if (!attributes || attributes.length === 0) {
      attributeTable.innerHTML = "";
    } else {
      const rows = [];
      for (let i = 0; i + 3 < attributes.length; i += 4) {
        const type = attributes[i];
        const current = attributes[i + 1];
        const base = attributes[i + 2];
        const ranks = attributes[i + 3];
        const buffDelta = current - base;
        const buffStr = buffDelta === 0
          ? ""
          : (buffDelta > 0 ? `+${buffDelta}` : `${buffDelta}`);
        rows.push(
          `<tr>` +
            `<td class="label">${attributeName(type)}</td>` +
            `<td class="num">${current}</td>` +
            `<td class="delta">${base}${buffStr ? ` (${buffStr})` : ""} · ${ranks} ranks</td>` +
          `</tr>`
        );
      }
      attributeTable.innerHTML = rows.join("");
    }

    // Skill table. `skills` packs `[type, current, base, ranks, training] × N`.
    // training: 0=Untrained, 1=Untrained-but-Trainable, 2=Trained, 3=Specialized.
    const TRAINING_CLASS = { 0: "untrained", 1: "untrained", 2: "trained", 3: "specialized" };
    const skills = stats.skills;
    if (!skills || skills.length === 0) {
      skillTable.innerHTML = "";
    } else {
      const rows = [];
      for (let i = 0; i + 4 < skills.length; i += 5) {
        const type = skills[i];
        const current = skills[i + 1];
        const base = skills[i + 2];
        const ranks = skills[i + 3];
        const training = skills[i + 4];
        const cls = TRAINING_CLASS[training] || "";
        const label = skillName(type);
        const buffDelta = current - base;
        const buffStr = buffDelta === 0 ? "" : (buffDelta > 0 ? `(+${buffDelta})` : `(${buffDelta})`);
        rows.push(
          `<tr class="${cls}">` +
            `<td class="label">${label}</td>` +
            `<td class="num">${current}</td>` +
            `<td class="delta">${base}${buffStr ? " " + buffStr : ""} · ${ranks} ranks</td>` +
          `</tr>`
        );
      }
      skillTable.innerHTML = rows.join("");
    }

    // Reveal the panel once we have data.
    if (vitalsPanel.hidden) vitalsPanel.hidden = false;
  }

  // Phase 4 step 4 follow-on: re-render the inventory panel
  // from `SessionHandle.playerInventory()`. Called from the
  // drainEvents tick on every kind=11 event. The snapshot is
  // already sorted (equipped first, then by name) so we just
  // partition into the two sub-sections.
  function renderInventoryPanel(handle) {
    if (!handle) return;
    // Copy-then-free: playerInventory() hands back an ARRAY of
    // wasm-bindgen InventoryItem boxes (one per owned item) — freed
    // element-wise, unlike the single-box snapshot above. Runs on every
    // kind=11 (ObjectCreate / Delete / Wield / ViewContents). Body split
    // out (unchanged, incl. its early returns) so the free is throw-safe.
    const items = handle.playerInventory();
    try {
      renderInventoryPanelFromSnapshot(items);
    } finally {
      if (items) for (const it of items) it?.free?.();
    }
  }
  function renderInventoryPanelFromSnapshot(items) {
    // Empty-state — both sections hidden, "no items" message shown.
    if (!items || items.length === 0) {
      inventoryEmpty.hidden = false;
      invEquippedH.hidden = true;
      invPackH.hidden = true;
      invEquipped.innerHTML = "";
      invPack.innerHTML = "";
      if (inventoryPanel.hidden) inventoryPanel.hidden = false;
      return;
    }
    inventoryEmpty.hidden = true;
    const equippedRows = [];
    const packRows = [];
    for (const item of items) {
      // Tag the <li> with the most-significant item-type bit so
      // the CSS colour hints match (Weapon / Armor / Magic /
      // Money). Multiple bits can be set; pick the lowest one.
      const itemType = item.itemType >>> 0;
      let typeBit = 0;
      if (itemType !== 0) {
        // Find lowest set bit.
        typeBit = itemType & (~itemType + 1);
      }
      const meta = item.stackSize > 1
        ? `<span class="stack">×${item.stackSize}</span>`
        : (item.value > 0 ? `${item.value} pyreals` : "");
      // Wave D / PR11 (2026-06-06): every owned pack/equipped item
      // is draggable. Vendor-ui still rejects equipped sells (with a
      // toast — see vendor-ui dual-mime patch), but the inventory
      // drag-source is uniform so paperdoll->items-grid unequip and
      // bag-tab routing work without a per-item branch.
      const draggable = "draggable=\"true\"";
      const row =
        `<li data-guid="${item.guid}" data-type-bit="0x${typeBit.toString(16)}" ${draggable}>` +
          `<span class="name">${escapeHtml(item.name || "(unnamed)")}</span>` +
          `<span class="meta">${meta}</span>` +
        `</li>`;
      if (item.equipMask !== 0) equippedRows.push(row);
      else packRows.push(row);
    }
    if (equippedRows.length > 0) {
      invEquippedH.hidden = false;
      invEquipped.innerHTML = equippedRows.join("");
    } else {
      invEquippedH.hidden = true;
      invEquipped.innerHTML = "";
    }
    if (packRows.length > 0) {
      invPackH.hidden = false;
      invPack.innerHTML = packRows.join("");
    } else {
      invPackH.hidden = true;
      invPack.innerHTML = "";
    }
    if (inventoryPanel.hidden) inventoryPanel.hidden = false;
  }
  return { renderVitalsPanel, renderInventoryPanel };
}
