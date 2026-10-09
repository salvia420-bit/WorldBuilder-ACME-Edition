// tests/book_retail_pages.test.mjs — books-journal-1..4 (2026-10-08 round 3).
//
// Retail gmBookUI (acclient.c):
//   DisplayPageData :238214 — a page is editable only when
//     authorID == player || ignoreAuthor.
//   CloseCurPage :238301 — leaving an editable page sends BookModifyPage,
//     or BookDeletePage when it is blank AND the player wrote it
//     (PageTextBlank: spaces / newlines / terminators only).
//   OpenBook :238737 — a scribed book is titled with its inscription; a book
//     not owned by the player registers a range handler (OnObjectRangeExit
//     :237788 closes it).
//   ItemExamineUI::SetInscription :229275 — the inscription box exists only
//     for an Inscribable item (bitfield 0x2); unsigned reads "<Inscribe here>".
//
// Pure-helper pins plus source pins for the wasm snapshot fields (the
// DOM flow is in tests/commerce_windows_smoke.test.mjs [book]).
//
// Run: node tests/book_retail_pages.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isBlankBookText, isBookPageEditable, isOwnBookPage, bookFlushAction, bookTitle, bookCloseDistance,
  claimPageTextRequest,
} from "../plugins/book-panel.js";
import {
  inscriptionEditable, examineInscribeEnabled, ODF_INSCRIBABLE, INSCRIBE_PLACEHOLDER,
} from "../plugins/examine-target.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
const ME = 0x50000001;

test("PageTextBlank: spaces, newlines and terminators only", () => {
  assert.equal(isBlankBookText(""), true);
  assert.equal(isBlankBookText(" \n \0"), true);
  assert.equal(isBlankBookText(" a "), false);
  assert.equal(isBlankBookText(null), true);
});

test("DisplayPageData editability: own page or ignoreAuthor; stale pkg fails open", () => {
  assert.equal(isBookPageEditable({ authorId: ME, ignoreAuthor: false }, ME), true);
  assert.equal(isBookPageEditable({ authorId: 0x50000002, ignoreAuthor: false }, ME), false);
  assert.equal(isBookPageEditable({ authorId: 0x50000002, ignoreAuthor: true }, ME), true);
  assert.equal(isBookPageEditable({ authorId: ME, textIncluded: false }, ME), false, "text not loaded");
  assert.equal(isBookPageEditable({ text: "x" }, ME), true, "no authorId (old pkg) → as before");
  assert.equal(isBookPageEditable({ authorId: ME }, 0), false, "unknown local guid");
  assert.equal(isOwnBookPage({ authorId: ME }, ME), true);
  assert.equal(isOwnBookPage({ authorId: 1, ignoreAuthor: true }, ME), false);
});

test("CloseCurPage: blank own page deletes, changed text modifies, others' pages never save", () => {
  assert.equal(bookFlushAction({ text: "a", authorId: ME }, "", ME), "delete");
  assert.equal(bookFlushAction({ text: "a", authorId: ME }, "b", ME), "modify");
  assert.equal(bookFlushAction({ text: "a", authorId: ME }, "a", ME), null, "unchanged");
  assert.equal(bookFlushAction({ text: "a", authorId: 7 }, "b", ME), null, "not writable");
  assert.equal(bookFlushAction({ text: "a", authorId: 7, ignoreAuthor: true }, "", ME), "modify",
    "a blank page someone else wrote in an open book is blanked, not deleted");
});

test("OpenBook title: the inscription of a scribed book, else the object name", () => {
  assert.equal(bookTitle({ scribeId: 0x50000009, inscription: "For Lin" }, "Book"), "For Lin");
  assert.equal(bookTitle({ scribeId: 0, inscription: "For Lin" }, "Book"), "Book");
  assert.equal(bookTitle({ scribeId: 0xFFFFFFFF, inscription: "For Lin" }, "Book"), "Book", "ACE's no-scribe sentinel");
  assert.equal(bookTitle({ scribeId: 5, inscription: "  " }, "Book"), "Book");
});

test("range close distance: UseRadius plus body slack, sane default", () => {
  assert.equal(bookCloseDistance(3), 5.5);
  assert.equal(bookCloseDistance(null), 3.5);
  assert.equal(bookCloseDistance(0.2), 3.5);
});

test("examine inscription gate: Inscribable + owned + unsigned or signed by me", () => {
  assert.equal(ODF_INSCRIBABLE, 0x2);
  assert.equal(INSCRIBE_PLACEHOLDER, "<Inscribe here>");
  assert.equal(inscriptionEditable({ descFlags: 0x2, owned: true }), true);
  assert.equal(inscriptionEditable({ descFlags: 0x0, owned: true }), false, "not Inscribable");
  assert.equal(inscriptionEditable({ descFlags: 0x2, owned: false }), false, "ACE only inscribes owned items");
  assert.equal(inscriptionEditable({ descFlags: 0x2, owned: true, scribeName: "Bob", myName: "Bob" }), true);
  assert.equal(inscriptionEditable({ descFlags: 0x2, owned: true, scribeName: "Bob", myName: "Al" }), false);
  assert.equal(inscriptionEditable({ descFlags: 0x2, owned: true, scribeName: "Bob", myName: null }), false);
  assert.equal(examineInscribeEnabled(""), true);
  assert.equal(examineInscribeEnabled("?examineInscribe=off"), false);
});

test("wasm book snapshot carries authorId / ignoreAuthor / textIncluded / scribeId", () => {
  const lib = src("src/lib.rs");
  for (const name of ["authorId", "ignoreAuthor", "textIncluded", "scribeId"]) {
    assert.match(lib, new RegExp(`js_name = ${name}\\)`), name);
  }
  assert.match(lib, /scribe_id: bd\.author_id\.unwrap_or\(0\)/);
  assert.match(lib, /author_id: p\.author_id,\s*\n\s*ignore_author: p\.ignore_author,\s*\n\s*text_included: p\.text_included,/);
});

test("SetCurPage: a page sent without text is fetched once per open book (books-journal-2)", () => {
  const seen = new Set();
  const bare = { textIncluded: false };
  assert.equal(claimPageTextRequest(bare, 0x7000_0001, 2, seen), true, "first look fetches");
  assert.equal(claimPageTextRequest(bare, 0x7000_0001, 2, seen), false, "never twice");
  assert.equal(claimPageTextRequest(bare, 0x7000_0001, 3, seen), true, "another page");
  assert.equal(claimPageTextRequest({ textIncluded: true, text: "x" }, 0x7000_0001, 4, seen), false);
  assert.equal(claimPageTextRequest(undefined, 0x7000_0001, 0, seen), false, "no page");
  const panel = src("plugins/book-panel.js");
  assert.match(panel, /claimPageTextRequest\(page, snapGuid, currentPageIndex\)/);
  assert.match(panel, /bookPageData\?\.\(snapGuid, currentPageIndex\)/);
  assert.match(panel, /requestedPageText\.clear\(\)/, "a different book starts over");
  assert.match(src("src/lib.rs"), /js_name = bookPageData/);
});
