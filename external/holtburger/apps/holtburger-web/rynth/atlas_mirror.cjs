// atlas_mirror.cjs — the headless disk bridge for the route atlas (NavAtlas
// W2.2). Browser JS cannot write /mnt; this standalone node helper mirrors a
// bot page's in-memory atlas (localStorage, exposed as window.__atlas) to
// JSON on disk, and seeds a fresh page from disk on boot. Fully decoupled:
// the supervisor is NOT touched (main's decision) — a driver imports these or
// runs this file directly.
//
// Pure disk functions (writeAtlasJson / readAtlasJson) take/return the string
// Atlas.exportAll() produces, so they are node-testable with no playwright.
// The page helpers (mirrorFromPage / seedPage) take a Playwright `page`.
//
//   node atlas_mirror.cjs write <account> '<exportAll-json>'
//   node atlas_mirror.cjs read  <account>
//
// Default mirror dir: /mnt/wbterminal2/holtburger-scratch/atlas (override with
// env RYNTH_ATLAS_DIR). Files are <account>.json; a sidecar .meta records the
// last mirror time + route count for at-a-glance health.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_DIR = process.env.RYNTH_ATLAS_DIR || "/mnt/wbterminal2/holtburger-scratch/atlas";

function safeAccount(account) {
  // Filesystem-safe; never let an account name escape the mirror dir. Dots are
  // collapsed too so a sanitized name can never read as ".."/traversal.
  return String(account || "default").replace(/[^A-Za-z0-9_-]/g, "_") || "default";
}

/** Write an Atlas.exportAll() JSON string to <dir>/<account>.json (atomic via
 *  a temp file + rename). Returns { file, routes }. */
function writeAtlasJson(exportJson, { dir = DEFAULT_DIR, account = "default" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const acct = safeAccount(account);
  const file = path.join(dir, `${acct}.json`);
  // Validate + count before writing (never mirror garbage).
  let routes = [];
  try {
    const obj = JSON.parse(exportJson);
    routes = (obj && obj.routes) || [];
  } catch (e) {
    throw new Error(`atlas_mirror.write: invalid JSON (${e.message})`);
  }
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, exportJson);
  fs.renameSync(tmp, file);
  fs.writeFileSync(path.join(dir, `${acct}.meta.json`), JSON.stringify({ account: acct, routes: routes.length, mirroredAt: Date.now() }));
  return { file, routes: routes.length };
}

/** Read <dir>/<account>.json back as a string suitable for Atlas.importAll().
 *  Returns null if no mirror exists yet. */
function readAtlasJson({ dir = DEFAULT_DIR, account = "default" } = {}) {
  const file = path.join(dir, `${safeAccount(account)}.json`);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf8");
}

/** List mirrored accounts (basenames without .json), excluding .meta files. */
function listMirrored({ dir = DEFAULT_DIR } = {}) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".meta.json"))
    .map((f) => f.slice(0, -5));
}

/** Pull a live bot page's atlas to disk. `page` is a Playwright page whose
 *  bot install exposed window.__atlas (Atlas instance). Returns the write
 *  result or null if the page has no atlas yet. */
async function mirrorFromPage(page, { dir = DEFAULT_DIR, account = "default" } = {}) {
  const dump = await page.evaluate(() => (window.__atlas ? window.__atlas.exportAll() : null));
  if (!dump) return null;
  return writeAtlasJson(dump, { dir, account });
}

/** Seed a fresh bot page's atlas from disk (call after the atlas is installed,
 *  before the director starts). Returns the number of routes imported, or 0. */
async function seedPage(page, { dir = DEFAULT_DIR, account = "default" } = {}) {
  const dump = readAtlasJson({ dir, account });
  if (!dump) return 0;
  return page.evaluate((d) => (window.__atlas ? window.__atlas.importAll(d) : 0), dump);
}

module.exports = { writeAtlasJson, readAtlasJson, listMirrored, mirrorFromPage, seedPage, DEFAULT_DIR };

if (require.main === module) {
  const [cmd, account, json] = process.argv.slice(2);
  if (cmd === "write") {
    if (!account || !json) {
      console.error("usage: node atlas_mirror.cjs write <account> '<exportAll-json>'");
      process.exit(2);
    }
    const res = writeAtlasJson(json, { account });
    console.log(`mirrored ${res.routes} route(s) -> ${res.file}`);
  } else if (cmd === "read") {
    const dump = readAtlasJson({ account: account || "default" });
    if (!dump) {
      console.error(`no mirror for '${account || "default"}' in ${DEFAULT_DIR}`);
      process.exit(1);
    }
    process.stdout.write(dump);
  } else if (cmd === "list") {
    console.log(listMirrored().join("\n"));
  } else {
    console.error("usage: node atlas_mirror.cjs <write|read|list> ...");
    process.exit(2);
  }
}
