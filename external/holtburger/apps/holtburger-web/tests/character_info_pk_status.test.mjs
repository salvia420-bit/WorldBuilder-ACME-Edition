// tests/character_info_pk_status.test.mjs — pk-5 (2026-10-08 round 5).
//
// Retail gmStatManagementUI::UpdatePKStatus (acclient.c:284375-284420) fills
// the character panel's PKStatus text (element 0x10000233, bound at
// :284242-284247) from the local player's LIVE weenie: Player Killer, Player
// Killer Lite or Non-Player Killer. The panel had the element only in its
// anatomy comment. A PlayerKillerStatus change fires neither
// playerStatsUpdated nor titleUpdated, so a 1 s check repaints on a change.
// Source assertions (the panel is DOM + bitmap font).
//
// Run: node tests/character_info_pk_status.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../plugins/character-info.js", import.meta.url), "utf8");

test("the header builds the PKStatus element under the title", () => {
  assert.match(src, /import \{ pkStatusText \} from "\.\/examine_format\.js";/);
  assert.match(src, /const pkEl = el\("div", "hb-ci-sub"\); pkEl\.dataset\.el = "0x10000233";/);
  assert.match(src, /headMain\.append\(nameEl, subEl, pkEl, xpRow, meter\);/);
});

test("the text comes from the live ODF of the local player", () => {
  const fn = src.slice(src.indexOf("function livePkStatus()"), src.indexOf("function renderHeader()"));
  assert.match(fn, /h\?\.objectDescFlags\?\.\(me\)/);
  assert.match(fn, /return odf \? pkStatusText\(odf\) : null;/);
  const render = src.slice(src.indexOf("function renderHeader()"));
  assert.match(render.slice(0, 1200), /const pk = livePkStatus\(\);/);
});

test("a PK change repaints within a second; the timer stops with the view", () => {
  assert.match(src, /const pkTimer = setInterval\(\(\) => \{\s*if \(root\.isConnected && livePkStatus\(\) !== shownPk\) schedule\(\);\s*\}, 1000\);/);
  assert.match(src, /clearInterval\(pkTimer\);/);
});
