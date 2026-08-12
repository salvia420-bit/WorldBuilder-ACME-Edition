#!/usr/bin/env node
// s14x.mjs — attach to the live S14 browser and evaluate one expression.
// usage: node s14x.mjs <cdpPort> <file-with-expr>   (or: ... - <<'EOF' ... EOF)
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const PORT = Number(process.argv[2] || 9342);
const src = process.argv[3];
const expr = src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8");

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().startsWith("about:")) || (await browser.pages())[0];
const v = await page.evaluate(async (e) => {
  try {
    // eslint-disable-next-line no-eval
    const r = await eval(e);
    return JSON.parse(JSON.stringify(r === undefined ? "<undefined>" : r, (k, val) => {
      if (val instanceof Set) return { __set: val.size, sample: Array.from(val).slice(0, 24) };
      if (val instanceof Map) return { __map: val.size, sample: Array.from(val.keys()).slice(0, 24) };
      if (typeof val === "function") return "<fn>";
      return val;
    }));
  } catch (err) { return "ERR: " + (err && err.stack ? err.stack.split("\n").slice(0, 3).join(" | ") : err); }
}, expr);
console.log(typeof v === "string" ? v : JSON.stringify(v, null, 1));
await browser.disconnect();
