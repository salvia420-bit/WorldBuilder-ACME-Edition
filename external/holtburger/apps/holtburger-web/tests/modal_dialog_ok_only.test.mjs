// tests/modal_dialog_ok_only.test.mjs — chat-errors-7 (2026-10-13).
//
// Retail ClientCommunicationSystem::Handle_Communication__PopUpString
// (acclient.c:425219) opens the type-3 OK message dialog (property 0x8E = 3).
// plugins/modal-dialog.js grew an additive `hideCancel` option for it: one OK
// button, no title row unless a title is given, Enter / Esc / backdrop all
// close it as OK, and entries still wait in the same queue. Callers that do
// not pass it keep the Yes/No confirm exactly as before.
//
// Run: node tests/modal_dialog_ok_only.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { installDialogFakeDom, tick } from "./helpers/dialog_fake_dom.mjs";

const { document, press } = installDialogFakeDom();
const { modalConfirm, modalConfirmCallback, mount } = await import("../plugins/modal-dialog.js");

function parts() {
  const dialog = document.getElementById("hb-modal-dialog");
  const byClass = (cls) => dialog.children.find((c) => c.className.split(/\s+/).includes(cls));
  const row = byClass("hb-dlg-actions");
  const [okBtn, cancelBtn] = row.children;
  return {
    dialog,
    backdrop: document.getElementById("hb-modal-dialog-backdrop"),
    title: byClass("hb-dlg-title"),
    divider: byClass("hbk-divider"),
    msg: byClass("hb-dlg-msg"),
    okBtn,
    cancelBtn,
    visibleButtons: row.children.filter((b) => b.style.display !== "none"),
    open: dialog.getAttribute("data-open") === "1",
  };
}

const WELCOME = "Welcome to Asheron's Call!\nTo begin your training, speak to the Society Greeter.";

test("hideCancel renders one OK button, no title row, the text with its line breaks", async () => {
  let ok = 0;
  modalConfirmCallback({ message: WELCOME, hideCancel: true, onConfirm: () => { ok += 1; } });
  const p = parts();
  assert.equal(p.open, true, "dialog open");
  assert.equal(p.visibleButtons.length, 1, "one visible button");
  assert.equal(p.visibleButtons[0], p.okBtn);
  assert.equal(p.okBtn.textContent, "OK");
  assert.equal(p.cancelBtn.style.display, "none", "cancel hidden");
  assert.equal(p.title.style.display, "none", "no title row");
  assert.equal(p.divider.style.display, "none", "no divider without a title");
  assert.equal(p.msg.textContent, WELCOME, "message verbatim, line breaks kept");
  assert.equal(document.activeElement, p.okBtn, "OK has focus");
  const ev = press("Enter");
  assert.equal(ok, 1, "Enter closes it as OK");
  assert.equal(ev._stop, true, "Enter is swallowed");
  assert.equal(parts().open, false, "closed");
  await tick();
});

test("Esc closes it as OK (Promise form resolves true)", async () => {
  const done = modalConfirm({ message: "A quest popup.", hideCancel: true });
  assert.equal(parts().open, true);
  const ev = press("Escape");
  assert.equal(ev._stop, true, "Esc is swallowed");
  assert.equal(await done, true);
  assert.equal(parts().open, false);
  await tick();
});

test("Tab keeps focus on OK; a backdrop click closes it as OK", async () => {
  let ok = 0;
  let cancel = 0;
  modalConfirmCallback({ message: "x", hideCancel: true, onConfirm: () => { ok += 1; }, onCancel: () => { cancel += 1; } });
  const p = parts();
  press("Tab");
  assert.equal(document.activeElement, p.okBtn, "Tab stays on OK");
  press("ArrowRight");
  assert.equal(document.activeElement, p.okBtn, "arrows stay on OK");
  p.backdrop.click();
  assert.deepEqual([ok, cancel], [1, 0], "backdrop = OK");
  await tick();
});

test("two popups queue: the second shows only after the first is closed", async () => {
  const seen = [];
  modalConfirmCallback({ message: "first", hideCancel: true, onConfirm: () => seen.push("first") });
  modalConfirmCallback({ message: "second", hideCancel: true, onConfirm: () => seen.push("second") });
  assert.equal(parts().msg.textContent, "first");
  press("Enter");
  assert.deepEqual(seen, ["first"]);
  await tick();
  const p = parts();
  assert.equal(p.open, true, "second opened from the queue");
  assert.equal(p.msg.textContent, "second");
  press("Escape");
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(parts().open, false);
  await tick();
});

test("a normal confirm after an OK-only one is unchanged (title, two buttons, Esc cancels)", async () => {
  let r = null;
  modalConfirmCallback({ title: "Drop Bonded Item", message: "Drop it?", onConfirm: () => { r = "yes"; }, onCancel: () => { r = "no"; } });
  let p = parts();
  assert.equal(p.title.textContent, "Drop Bonded Item");
  assert.notEqual(p.title.style.display, "none");
  assert.notEqual(p.divider.style.display, "none");
  assert.equal(p.visibleButtons.length, 2, "Yes/No both shown");
  assert.equal(p.cancelBtn.textContent, "Cancel");
  press("Escape");
  assert.equal(r, "no", "Esc cancels a normal confirm");
  await tick();

  modalConfirmCallback({ message: "Sure?", onConfirm: () => { r = "yes"; }, onCancel: () => { r = "no"; } });
  p = parts();
  assert.equal(p.title.textContent, "Confirm", "default title kept");
  press("Tab");
  assert.equal(document.activeElement, p.cancelBtn, "Tab still reaches Cancel");
  press("Enter");
  assert.equal(r, "no", "Enter on Cancel still cancels");
  await tick();
});

test("an OK-only entry with a title shows it", async () => {
  modalConfirmCallback({ title: "Notice", message: "m", hideCancel: true });
  const p = parts();
  assert.equal(p.title.textContent, "Notice");
  assert.notEqual(p.title.style.display, "none");
  assert.equal(p.visibleButtons.length, 1);
  press("Enter");
  await tick();
});

test("the hb:modal-confirm-request window event forwards hideCancel", async () => {
  const dispose = mount();
  let ok = 0;
  window.dispatchEvent(new CustomEvent("hb:modal-confirm-request", {
    detail: { message: "via event", hideCancel: true, onConfirm: () => { ok += 1; } },
  }));
  const p = parts();
  assert.equal(p.msg.textContent, "via event");
  assert.equal(p.visibleButtons.length, 1);
  press("Escape");
  assert.equal(ok, 1);
  dispose();
  await tick();
});
