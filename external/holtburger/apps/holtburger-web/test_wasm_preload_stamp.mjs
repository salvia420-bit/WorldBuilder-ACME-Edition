// test_wasm_preload_stamp.mjs — the wasm `?v=` stamp is consistent everywhere.
//
// The stamp is hand-bumped at every site that names the pkg glue or binary.
// index.html also PRELOADS the binary (2026-10-06); a preload whose URL differs
// from the one init() fetches by even one character is not consumed and the
// ~2 MB wasm downloads twice. This pins: the preload exists, is shaped like the
// fetch wasm-bindgen makes (as="fetch" + crossorigin), and every stamp site in
// index.html and the three workers carries the SAME stamp.
//
// Run: cd apps/holtburger-web && node test_wasm_preload_stamp.mjs
import { readFileSync } from "node:fs";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

const html = readFileSync("index.html", "utf8");
const pre = [...html.matchAll(/<link\s+rel="preload"\s+href="([^"]*holtburger_web_bg\.wasm[^"]*)"([^>]*)>/g)];
check("index.html preloads the wasm binary exactly once", pre.length === 1, String(pre.length));
const attrs = pre[0]?.[2] ?? "";
check("preload is as=\"fetch\" (what init() issues)", /\bas="fetch"/.test(attrs));
check("preload carries crossorigin (CORS mode, same-origin credentials = fetch())", /\bcrossorigin\b/.test(attrs));
const preStamp = (pre[0]?.[1].match(/\?v=([^"&]+)/) || [])[1];
check("preload URL is stamped", !!preStamp);

const stamps = new Map();
const files = ["index.html", "scene3d/bake_worker.js", "scene3d/net_worker.js", "scene3d/net_worker_client.js"];
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/holtburger_web(?:_bg\.wasm|\.js)\?v=([A-Za-z0-9._-]+)/g)) {
    if (!stamps.has(m[1])) stamps.set(m[1], []);
    stamps.get(m[1]).push(f);
  }
}
check("ONE stamp across index.html + all worker sites", stamps.size === 1,
  [...stamps.entries()].map(([k, v]) => `${k}: ${[...new Set(v)].join(",")}`).join(" | "));
check("…and it is the preload's stamp", stamps.has(preStamp));
// the main init() call site uses the same relative path as the preload
check("init() fetches ./pkg/holtburger_web_bg.wasm with that stamp",
  html.includes(`"./pkg/holtburger_web_bg.wasm?v=${preStamp}"`));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
