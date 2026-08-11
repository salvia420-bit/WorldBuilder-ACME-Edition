// oracle-run.mjs — the holtburger-side scenario driver.
//
// Boots holtburger in a headless browser with `?moveTelemetry=1`, replays a
// scenario's timed input events, drains the wasm telemetry ring, and writes
// the JSONL the differ reads. The retail side of the same scenario is driven
// by keystrokes into the Wine client (see docs/reengineering/oracle/WINE-RIG.md).
//
// CONSTRAINTS THIS FILE RESPECTS — read before "simplifying":
//
// * `?nullRender=1` is FORBIDDEN here. It skips render(), and movement needs
//   real ticks; a null-rendered run produces a plausible-looking but wrong
//   curve. Use `?targetFps=` to keep SwiftShader affordable instead.
// * ONE headless browser at a time. The laptop has 8 GB and each chromium is
//   ~1.5 GB, so the launcher refuses to start under a free-memory floor
//   rather than triggering the OOM killer mid-capture.
// * `?nosw=1` on every URL. The service worker caches index.html and the
//   shards across reloads, and only `?nosw=1` clears it — without it you can
//   measure a stale build for hours.
//
// Usage:
//   node harness/oracle-run.mjs --scenario run-hold --out holt.jsonl
//   node harness/oracle-run.mjs --list
//   node harness/oracle-run.mjs --selftest        # no browser needed

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execSync } from "node:child_process";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = path.join(HERE, "..", "docs", "reengineering", "oracle", "scenarios.json");

/** Minimum free MiB before we are willing to start a browser. */
export const FREE_MEM_FLOOR_MB = 1700;

export function freeMemMb() {
  try {
    const out = execSync("free -m", { encoding: "utf8" });
    const line = out.split("\n").find((l) => /^Mem:/.test(l));
    // "available" is the last column and is the honest number (buff/cache is
    // reclaimable); "free" alone would refuse to run on a perfectly fine box.
    return Number(line.trim().split(/\s+/).pop());
  } catch {
    return Infinity;
  }
}

/**
 * Turn a scenario's event list into an ordered plan of
 * `{ atMs, action }` steps, with the settle prologue folded in.
 */
export function buildPlan(scenario, defaults = {}) {
  const settle = scenario.settle_ms ?? defaults.settle_ms ?? 2500;
  const trail = scenario.trail_ms ?? defaults.trail_ms ?? 1500;
  const steps = (scenario.events ?? []).map((e) => ({ atMs: settle + e.t, event: e }));
  steps.sort((a, b) => a.atMs - b.atMs);
  const last = steps.length ? steps[steps.length - 1].atMs : settle;
  return { settle, trail, steps, totalMs: last + trail };
}

/** Map a scenario key name to a DOM key for the holtburger key layout. */
export function domKey(key) {
  const map = {
    w: "w",
    a: "a",
    s: "s",
    d: "d",
    q: "q",
    e: "e",
    shift: "Shift",
    space: " ",
  };
  const k = map[key];
  if (!k) throw new Error(`unmapped scenario key '${key}'`);
  return k;
}

function buildUrl(base, scenario, account) {
  const p = new URLSearchParams();
  p.set("moveTelemetry", "1");
  p.set("nosw", "1");
  p.set("autoLogin", "1");
  p.set("account", account);
  p.set("password", account);
  p.set("autoSpawn", "first");
  p.set("agent", "1");
  // Keep SwiftShader affordable WITHOUT skipping ticks. Movement must run at
  // a real cadence; only the frame rate is throttled.
  p.set("targetFps", "20");
  return `${base}?${p.toString()}`;
}

async function run(args) {
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  const scenario = spec.scenarios.find((s) => s.id === args.scenario);
  if (!scenario) throw new Error(`unknown scenario '${args.scenario}'`);
  const plan = buildPlan(scenario, spec.defaults);

  const free = freeMemMb();
  if (free < FREE_MEM_FLOOR_MB) {
    throw new Error(
      `only ${free} MiB available; refusing to start a browser under the ` +
        `${FREE_MEM_FLOOR_MB} MiB floor (close the other chromium first)`,
    );
  }

  const { chromium } = await import("playwright-core");
  const url = buildUrl(args.base ?? "http://127.0.0.1:8765/apps/holtburger-web/index.html", scenario, args.account ?? "agentp09");
  console.error(`[oracle-run] ${scenario.id}: ${url}`);

  const browser = await chromium.launch({
    headless: true,
    executablePath: args.chrome ?? "/usr/bin/chromium",
    args: ["--use-gl=swiftshader", "--disable-dev-shm-usage", "--no-sandbox"],
  });
  let out = "";
  try {
    const page = await browser.newPage();
    page.on("console", (m) => {
      if (/error|warn/i.test(m.type())) console.error(`  [page:${m.type()}] ${m.text().slice(0, 200)}`);
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });

    // Boot gate. __bootState goes through a documented sequence; 'in-world' is
    // the only state where movement is meaningful. Poll rather than sleep, and
    // surface __bootStateHistory on failure so a timeout is diagnosable.
    await page
      .waitForFunction(() => window.__bootState === "in-world", null, { timeout: 240_000 })
      .catch(async () => {
        const hist = await page.evaluate(() => window.__bootStateHistory ?? window.__bootState);
        throw new Error(`never reached in-world; bootState history: ${JSON.stringify(hist)}`);
      });
    console.error("[oracle-run] in-world");

    // The telemetry ring has been filling since boot; drop that history so the
    // capture starts at the scenario, not at login.
    await page.evaluate(() => window.__hbWasmNs?.moveTelemetryDrain?.());

    const t0 = Date.now();
    for (const step of plan.steps) {
      const wait = step.atMs - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
      const e = step.event;
      if (e.type === "keydown") await page.keyboard.down(domKey(e.key));
      else if (e.type === "keyup") await page.keyboard.up(domKey(e.key));
      else if (e.type === "cast") await page.evaluate(() => window.__castDefaultForOracle?.());
      else if (e.type === "stance") console.error(`  [skip] stance step (no driver hook yet)`);
      console.error(`  t+${step.atMs}ms ${e.type} ${e.key ?? e.spell ?? e.value ?? ""}`);
    }
    await page.waitForTimeout(plan.trail);

    out = await page.evaluate(() => window.__hbWasmNs?.moveTelemetryDrain?.() ?? "");
    const status = await page.evaluate(() => window.__hbWasmNs?.moveTelemetryStatus?.() ?? 0);
    console.error(`[oracle-run] drained ${out.split("\n").filter(Boolean).length} records (status ${status})`);
  } finally {
    await browser.close();
  }

  if (!out.trim()) {
    throw new Error(
      "telemetry drain was EMPTY — is pkg/ rebuilt with the moveTelemetry " +
        "exports? (a stale pkg/ yields undefined and this reads as '')",
    );
  }
  const dest = args.out ?? `holt-${scenario.id}.jsonl`;
  writeFileSync(dest, out.endsWith("\n") ? out : out + "\n");
  console.error(`[oracle-run] wrote ${dest}`);
}

// ---------------------------------------------------------------------------

function selftest() {
  let p = 0;
  let f = 0;
  const check = (n, ok, d) => {
    console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`);
    ok ? p++ : f++;
  };
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  check("scenarios.json parses", Array.isArray(spec.scenarios) && spec.scenarios.length >= 10, `${spec.scenarios.length} scenarios`);
  check("every scenario has an id and events", spec.scenarios.every((s) => s.id && Array.isArray(s.events)));
  check(
    "every scenario key is mappable to a DOM key",
    spec.scenarios.every((s) => s.events.every((e) => !e.key || (() => { try { domKey(e.key); return true; } catch { return false; } })())),
  );
  const plan = buildPlan(spec.scenarios.find((s) => s.id === "run-hold"), spec.defaults);
  check("run-hold plan is ordered and settled", plan.steps[0].atMs === plan.settle, `first step at ${plan.steps[0].atMs}ms`);
  check("run-hold plan has a trailing window", plan.totalMs > plan.steps[plan.steps.length - 1].atMs);
  const f2 = spec.scenarios.find((s) => s.id === "walk-edge-after-manualheld-walk");
  check("F2 scenario ends on a run hold (no shift at the second edge)", f2.gait_expected === "run");
  check("mem floor helper returns a number", Number.isFinite(freeMemMb()) || freeMemMb() === Infinity);
  console.log(`\n${p} passed, ${f} failed`);
  process.exit(f === 0 ? 0 : 1);
}

const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const k = a.slice(2);
    const n = argv[i + 1];
    if (n && !n.startsWith("--")) {
      args[k] = n;
      i++;
    } else args[k] = true;
  }
}
if (args.selftest) selftest();
else if (args.list) {
  const spec = JSON.parse(readFileSync(SCENARIOS, "utf8"));
  for (const s of spec.scenarios) console.log(`${s.id.padEnd(34)} ${s.description.slice(0, 90)}`);
} else if (!args.scenario) {
  console.error("usage: oracle-run.mjs --scenario <id> [--out f.jsonl] [--account agentp09]");
  console.error("       oracle-run.mjs --list | --selftest");
  process.exit(2);
} else {
  run(args).catch((e) => {
    console.error(`[oracle-run] FAILED: ${e.message}`);
    process.exit(1);
  });
}
