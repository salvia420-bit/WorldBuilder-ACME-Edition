// tests/dom_sink_sanitization.test.mjs — Verify innerHTML DOM sinks sanitization and escapeHtml utilities
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { escapeHtml as domEscapeHtml } from "../app/dom_utils.js";
import { escapeHtml as acEscapeHtml } from "../ui/ac_html.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const BAR_JS = path.join(APP_DIR, "ui", "bar.js");
const DYE_PREVIEW_JS = path.join(APP_DIR, "plugins", "dye-preview.js");
const MAIN_PANEL_JS = path.join(APP_DIR, "plugins", "main-panel.js");
const INDEX_HTML = path.join(APP_DIR, "index.html");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

console.log("dom_sink_sanitization.test.mjs — testing DOM sink escaping and innerHTML safety");

// 1. escapeHtml in app/dom_utils.js
await test("dom_utils.js escapeHtml properly escapes HTML special characters and handles null/undefined", () => {
  assert.equal(domEscapeHtml(null), "");
  assert.equal(domEscapeHtml(undefined), "");
  assert.equal(domEscapeHtml(""), "");
  assert.equal(domEscapeHtml(0), "0");
  assert.equal(domEscapeHtml(12345), "12345");
  assert.equal(domEscapeHtml(false), "false");

  const dangerous = `<script>alert("XSS & 'injections'")</script>`;
  const escaped = domEscapeHtml(dangerous);
  assert.equal(escaped, "&lt;script&gt;alert(&quot;XSS &amp; &#39;injections&#39;&quot;)&lt;/script&gt;");
  assert.ok(!escaped.includes("<"));
  assert.ok(!escaped.includes(">"));
  assert.ok(!escaped.includes('"'));
  assert.ok(!escaped.includes("'"));
});

// 2. escapeHtml in ui/ac_html.js
await test("ac_html.js escapeHtml properly escapes HTML special characters and handles null/undefined", () => {
  assert.equal(acEscapeHtml(null), "");
  assert.equal(acEscapeHtml(undefined), "");
  assert.equal(acEscapeHtml(""), "");
  assert.equal(acEscapeHtml(42), "42");

  const attrPayload = `" onfocus="alert(1)" foo="`;
  const escaped = acEscapeHtml(attrPayload);
  assert.equal(escaped, "&quot; onfocus=&quot;alert(1)&quot; foo=&quot;");
  assert.ok(!escaped.includes('"'));
});

// 3. ui/bar.js sanitizes state.color in buildBarTab
await test("ui/bar.js imports escapeHtml and sanitizes state.color in buildBarTab", () => {
  const code = fs.readFileSync(BAR_JS, "utf8");
  assert.ok(code.includes('import { escapeHtml } from "./ac_html.js"'), "imports escapeHtml from ac_html.js");
  assert.ok(code.includes('value="${escapeHtml(state.color)}"'), "state.color is escaped in input value attribute");

  // Verify behavior if an attacker supplied a malicious color property
  const maliciousColor = '#141418" onmouseover="alert(1)';
  const escapedColor = acEscapeHtml(maliciousColor);
  assert.ok(!escapedColor.includes('"'), "escaped attribute has no unescaped double quotes");
  assert.equal(escapedColor, "#141418&quot; onmouseover=&quot;alert(1)");
});

// 4. plugins/dye-preview.js sanitizes error messages in viewport tooltip
await test("plugins/dye-preview.js imports escapeHtml and sanitizes viewport error innerHTML", () => {
  const code = fs.readFileSync(DYE_PREVIEW_JS, "utf8");
  assert.ok(code.includes('import { escapeHtml } from "../ui/ac_html.js"'), "imports escapeHtml from ac_html.js");
  assert.ok(
    code.includes('viewportWrap.innerHTML = `<div style="padding:8px;opacity:0.7;">(viewport error: ${escapeHtml('),
    "viewportWrap.innerHTML sanitizes error string"
  );

  const maliciousError = new Error('<img src=x onerror=alert("hacked")>');
  const escapedMsg = acEscapeHtml(String(maliciousError.message).slice(0, 60));
  assert.ok(!escapedMsg.includes("<"), "error message HTML tags are escaped");
  assert.ok(!escapedMsg.includes(">"), "error message HTML tags are escaped");
});

// 5. plugins/main-panel.js sanitizes view ID in placeholder bodyEl
await test("plugins/main-panel.js imports escapeHtml and sanitizes view id in bodyEl.innerHTML", () => {
  const code = fs.readFileSync(MAIN_PANEL_JS, "utf8");
  assert.ok(code.includes('import { escapeHtml } from "../ui/ac_html.js"'), "imports escapeHtml from ac_html.js");
  assert.ok(
    code.includes('bodyEl.innerHTML = `<div style="padding:24px;color:var(--hb-text-muted);font-style:italic;text-align:center;font-size:11px;">View "${escapeHtml(id)}" not built yet.</div>`'),
    "bodyEl.innerHTML sanitizes missing view id"
  );

  const maliciousViewId = 'custom<b onmouseover=alert(1)>view';
  const escapedId = acEscapeHtml(maliciousViewId);
  assert.ok(!escapedId.includes("<"), "missing view id HTML tags are escaped");
  assert.ok(!escapedId.includes(">"), "missing view id HTML tags are escaped");
});

// 6. index.html sanitizes error sinks
await test("index.html sanitizes error and disconnect overlays", () => {
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  assert.ok(html.includes("escapeHtml"), "index.html uses escapeHtml for safe string interpolation");
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} tests passed.`);
  process.exit(0);
}
