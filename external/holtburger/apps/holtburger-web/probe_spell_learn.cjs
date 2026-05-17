// Drive the @addspell verification:
// - If page is in-world: just send @addspell + snapshot.
// - If not: login + spawn + teleport, then send @addspell.

const { chromium } = require("playwright");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function attemptLogin(page) {
  await page.fill('input[name="account"]', "tailnet1");
  await page.fill('input[name="password"]', "tailnet1");
  await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
  await page.fill('input[name="server_host"]', "127.0.0.1");
  await page.fill('input[name="server_port"]', "9000");
  await page.click("#login-form button[type=submit]", { noWaitAfter: true });
  try {
    await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 });
    return true;
  } catch {
    return false;
  }
}

(async () => {
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  let page = ctx
    .pages()
    .find((p) =>
      p.url().startsWith("http://localhost:7080/apps/holtburger-web/")
    );
  if (!page) page = await ctx.newPage();
  console.log(`page: ${page.url()}`);

  page.on("console", (msg) => {
    const t = msg.text();
    if (
      /spell|addspell|stats|PlayerDescription|StatsUpdated|knownSpells/i.test(t)
    ) {
      console.log(`[browser] ${t}`);
    }
  });
  page.on("pageerror", (err) => console.error(`[pageerror] ${err.message}`));

  // Snapshot the current state — is the user already in-world?
  const initial = await page.evaluate(() => ({
    hasSessionHandle: !!window.__sessionHandle,
    hasPluginClient: !!window.__pluginClient,
    enteredWorld:
      typeof window.__getLocalPlayerGuid === "function"
        ? window.__getLocalPlayerGuid() !== null
        : null,
    localGuid:
      typeof window.getLocalPlayerGuid === "function"
        ? window.getLocalPlayerGuid()
        : null,
    spellCount: window.__pluginClient?.player?.knownSpells?.()?.length ?? null,
    loginStatus: document.getElementById("login-status")?.innerText ?? "",
  })).catch((e) => ({ error: e.message }));
  console.log(`initial state: ${JSON.stringify(initial)}`);

  // If not in-world, log in. (Skip page nav so the user's view stays.)
  if (!initial.localGuid) {
    console.log("not in-world — running login flow");
    if (!(await attemptLogin(page))) {
      console.log("first attempt timed out; retry after 12 s");
      await sleep(12_000);
      if (!(await attemptLogin(page))) {
        console.error("login failed after retry; bailing");
        await browser.close();
        process.exit(1);
      }
    }
    await page.locator("#character-ul button[data-id]").first().click();
    await page.waitForFunction(
      () =>
        /InWorld|Spawned/.test(
          document.getElementById("login-status")?.innerText ?? ""
        ),
      { timeout: 25_000 }
    );
    console.log("InWorld");
    // Teleport to Holtburg so we're in a populated cell.
    await page.evaluate(() =>
      window.__sessionHandle.sendChat("@telepoi holtburg")
    );
    await sleep(6_000);
  }

  // Before snapshot.
  const before = await page.evaluate(() => {
    const arr = window.__pluginClient?.player?.knownSpells?.() ?? [];
    return Array.from(arr);
  });
  console.log(`\nspell_book BEFORE: ${before.length} spells`);
  if (before.length) console.log(`  ${before.slice(0, 15).join(", ")}`);

  // Send @addspell for 5 known starter ids.
  const ids = [1, 2, 3, 4, 5];
  console.log(`\nsending @addspell ${ids.join(", ")}`);
  for (const id of ids) {
    await page.evaluate(
      (cmd) => window.__sessionHandle.sendChat(cmd),
      `@addspell ${id}`
    );
    await sleep(400);
  }
  // ACE broadcasts PlayerDescription on each addspell. Give it
  // generous time to land.
  await sleep(6_000);

  const after = await page.evaluate(() => {
    const arr = window.__pluginClient?.player?.knownSpells?.() ?? [];
    return Array.from(arr);
  });
  console.log(`\nspell_book AFTER:  ${after.length} spells`);
  if (after.length) console.log(`  ${after.slice(0, 15).join(", ")}`);

  // Open the spellbook panel + inspect DOM.
  try {
    await page.click('.hb-bar [data-plugin-id="spellbook"]', { timeout: 3_000 });
  } catch (_) {
    console.log("(could not click spellbook button)");
  }
  await sleep(800);
  const dom = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".hb-sb-row"));
    return {
      panelOpen: !!document.querySelector(".hb-sb-panel, [data-plugin-id='spellbook']"),
      emptyMsg: document.querySelector(".hb-sb-empty")?.textContent ?? null,
      rowCount: rows.length,
      rows: rows.slice(0, 10).map((r) => ({
        id: r.dataset.spellId,
        name: r.querySelector(".hb-sb-row-name")?.textContent,
      })),
    };
  });
  console.log(`\nspellbook DOM: ${JSON.stringify(dom, null, 2)}`);

  const sp = "/mnt/wbterminal1/tmp/claude-scratch/k1/k1-spellbook-after.png";
  await page.screenshot({ path: sp });
  console.log(`\nscreenshot: ${sp}`);
  console.log(
    `\n=== summary === before=${before.length} after=${after.length} domRows=${dom.rowCount}`
  );

  await browser.close();
})();
