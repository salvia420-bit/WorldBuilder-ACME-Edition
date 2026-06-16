// Mana-stone confirmation scaffold. Mana stones (ItemType 0x80000)
// consume one charge to recharge a single magic item OR all magic
// items in the inventory; either flow destroys the stone. Retail
// shows an Are-You-Sure prompt before consumeManaStone fires so the
// player doesn't waste a stone by misclick — this plugin ports that
// confirm flow on top of the rec #76 modal + rec #77 dispatcher.
//
// Trigger surface (caller-driven; no UI of our own yet):
//
//   window.dispatchEvent(new CustomEvent("hb:manastone-use-request", {
//     detail: { itemGuid, name?, charge?, mode?, onResolve? }
//   }));
//
// `mode` is "all" (recharge every magic item in the player's pack) or
// "single" (recharge a specific target). The modal text adapts and a
// single dialogId ("manastone:use") fires through the dispatcher so
// audit + automation tooling can hook in once the wasm-side
// consumeManaStone export lands.
//
// Programmatic API:
//   window.__showManastoneConfirm({itemGuid, name?, charge?, mode?})
//
// References:
//   - plugins/modal-dialog.js (modalConfirmCallback + emitDialogResult)
//   - plugins/world-objects/mana_stone.js (typed-class stub)
//   - acclient_2013.bndb_pseudo_c.txt: gmManaStoneUI confirm flow

import { modalConfirmCallback } from "./modal-dialog.js";

const DIALOG_ID = "manastone:use";

let _warnedMissingExport = false;

function buildMessage(opts) {
  const name = opts?.name || "this mana stone";
  const charge = (opts?.charge != null) ? `${Math.round(Number(opts.charge))}% ` : "";
  const mode = opts?.mode === "all" ? "every magic item in your pack" : "the selected item";
  return `Consume ${name}?\n` +
    `It will recharge ${mode} (${charge}restore)\n` +
    `and the stone will be destroyed.`;
}

function fireConsume(opts) {
  const guid = (opts?.itemGuid >>> 0) || 0;
  if (!guid) return;
  const handle = window.__sessionHandle ?? window.__pluginClient?._handle;
  try {
    if (typeof handle?.consumeManaStone === "function") {
      // Server-side expects (stoneGuid, targetGuid? or 0 for "all").
      // Until the wasm signature is locked in, pass the stone guid and
      // an opts-derived target so the call shape is forward-compatible.
      const target = (opts?.targetGuid >>> 0) || 0;
      handle.consumeManaStone(guid, target);
      return true;
    }
  } catch (e) {
    console.warn("[manastone-confirm] consumeManaStone failed:", e);
    return false;
  }
  if (!_warnedMissingExport) {
    _warnedMissingExport = true;
    console.warn("[manastone-confirm] consumeManaStone wasm export not wired yet — confirm logged, no wire sent.");
  }
  return false;
}

export function show(opts) {
  modalConfirmCallback({
    title: "Consume Mana Stone",
    message: buildMessage(opts),
    confirmLabel: "Consume",
    cancelLabel: "Cancel",
    dialogId: DIALOG_ID,
    action: opts?.mode === "all" ? "use-all" : "use-single",
    onConfirm: () => {
      const sent = fireConsume(opts);
      try { opts?.onResolve?.({ result: true, sent }); } catch (_) {}
    },
    onCancel: () => {
      try { opts?.onResolve?.({ result: false, sent: false }); } catch (_) {}
    },
  });
}

export const manifest = {
  id: "manastone-confirm",
  name: "Mana Stone Confirm",
  icon: "◇",
  iconHidden: true,
  version: "0.1.0",
  description: "Are-You-Sure prompt before consumeManaStone fires (scaffold — wasm export pending).",
};

export function mount() {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  function onRequest(ev) {
    const d = ev?.detail ?? {};
    show({
      itemGuid: d.itemGuid,
      name: d.name,
      charge: d.charge,
      mode: d.mode,
      targetGuid: d.targetGuid,
      onResolve: d.onResolve,
    });
  }
  window.addEventListener("hb:manastone-use-request", onRequest);
  return () => {
    window.removeEventListener("hb:manastone-use-request", onRequest);
  };
}

if (typeof window !== "undefined") {
  window.__showManastoneConfirm = show;
}
