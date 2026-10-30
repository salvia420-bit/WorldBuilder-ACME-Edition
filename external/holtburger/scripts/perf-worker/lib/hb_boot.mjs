// lib/hb_boot.mjs — boot ONE arm the way hbbench.mjs's v2 path boots it, for the tools that are not the
// bench (hbanatomy.mjs, hbsweep.mjs --boot), and the §4 pins of a session another tool booted
// (hbsweep.mjs / hbanatomy.mjs --attach). Round 3 R3-0 / R3-1, 2026-10-30.
//
//   bootArm(arm, o, extraFlags, res, deps)   fresh profile (box launch files), connect right after launch,
//       the arm's INNER window, the planArm URL (skytime=13, renderScale=1, adaptiveRes=off, targetFps=0,
//       gpuGovernor=off once documented), boot (arm.readyWhen), DayGroup 0, teleport + settle at arm.spot,
//       the server-state census, arm.gate (refuses the run when false), the pin read-back and the run-JSON
//       asserts (lib/hb_v2.mjs buildAsserts: URL pins, DayGroup, skytime, window, wasm, adapter), then the
//       Holtburg orbit pose (window.__hbOrbit) with hbbench's 25 s orbit warm-up, parked.
//       Mutates `res` (url, plan, box, window, gpu, pins, asserts, assertProblems, serverState, gate, orbit);
//       returns {c, plan, orbit}. `deps` swaps every side effect (the suite runs it against a fake page).
//       A throw after the connect closes that connection before it propagates; the CALLER kills the
//       box Chrome in its `finally` whenever it is not attached (hbanatomy runArm / runEval, hbsweep --boot).
//   applySessionPins(c, opts, deps)          an ATTACHED session: DayGroup 0 applied (sticky for the
//       session), optional exact INNER window (--inner), every pin read back and checked
//       (lib/hb_v2.mjs sessionPinProblems: URL pins, skytime, DayGroup, window, server port, adapter).
//
// Nothing runs at import time; Playwright and ssh are reached only through the deps.
import { planArm } from "../hbbench.mjs";
import { V2_DEFAULTS, DAY_GROUP_DAT_NAMES, dayYearForGroup, redactUrl, buildAsserts, runAssertProblems, sessionPinProblems } from "./hb_v2.mjs";
import { CDP, killBench, prepareLaunch, launchChrome, boxSample } from "./hb_box.mjs";
import { waitAccountFree, connectAtLaunch, sizeWindow, waitBootReady, teleportSettle, wasmProfileOf, servedWasmUrl } from "./hb_session.mjs";
import { pageApplyPins, pageServerState, pageGateValue, pageGateInfo } from "./hb_page.mjs";

/** The I/O bootArm / applySessionPins use; the suite swaps in fakes. */
export const BOOT_DEPS = Object.freeze({
  waitAccountFree, killBench, prepareLaunch, launchChrome, connectAtLaunch, sizeWindow, waitBootReady, teleportSettle, wasmProfileOf, boxSample,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
});

export async function bootArm(arm, o, extraFlags, res, deps = {}) {
  const d = { ...BOOT_DEPS, ...deps };
  const plan = planArm(extraFlags ? { ...arm, flags: [arm.flags, extraFlags].filter(Boolean).join("&") } : arm, o);
  res.url = redactUrl(plan.url);
  res.plan = { window: plan.window, dayGroup: plan.dayGroup, spot: plan.spot, readyWhen: plan.readyWhen, gate: plan.gate, orbitDegPerSec: plan.orbitDegPerSec };
  res.box = res.box || [];
  res.errors = res.errors || [];
  res.accountFree = await d.waitAccountFree();
  d.killBench();
  await d.prepareLaunch({ profile: `hbb-${o.profileTag || "anat"}-${arm.name}-${o.rep || 1}-${Date.now()}`, windowOuter: plan.window.outer, uncapped: o.uncapped, chrome: arm.chrome });
  res.box.push(await d.boxSample("pre-launch"));
  if (!(await d.launchChrome(CDP))) throw new Error("test Chrome never answered on CDP (hbgate refused?)");
  const c = await d.connectAtLaunch(CDP);
  // A throw from here on never returns `c` to the caller: close the connection here (the caller's
  // `finally` still kills the box Chrome, as it must for every non-attached run).
  try {
    return await bootConnected(c, plan, o, res, d);
  } catch (e) {
    try { if (c && c.browser) await c.browser.close(); } catch (_) { /* gone */ }
    throw e;
  }
}

async function bootConnected(c, plan, o, res, d) {
  c.pg.on("pageerror", (e) => res.errors.push(String(e?.message ?? e).slice(0, 200)));
  c.pg.on("console", (m) => { if (m.type() === "error") res.errors.push(m.text().slice(0, 200)); });
  if (plan.window.target) res.window = await d.sizeWindow(c.ctx, c.pg, plan.window.target);
  const { url } = plan; // built by hbbench.mjs planArm: `const url = uncappedBenchUrl(...)`
  await c.pg.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
  res.gpu = await c.pg.evaluate(() => { const gl = document.createElement("canvas").getContext("webgl2"); const e = gl.getExtension("WEBGL_debug_renderer_info"); return gl.getParameter(e.UNMASKED_RENDERER_WEBGL); });
  if (!/1070/.test(res.gpu)) throw new Error("not on 1070");
  await c.pg.evaluate(async () => { try { window.__benchWake = await navigator.wakeLock.request("screen"); } catch (_) {} });
  const boot = await d.waitBootReady(c.pg, { readyWhen: plan.readyWhen });
  res.bootMs = boot.ms;
  if (!boot.ok) throw new Error("boot never ready");
  await d.sleep(5000);
  if (plan.dayGroup) res.pinsBoot = await c.pg.evaluate(pageApplyPins, { dayGroup: plan.dayGroup });
  res.settle = await d.teleportSettle(c.pg, plan.spot);
  res.serverState = { settled: await c.pg.evaluate(pageServerState).catch((e) => ({ error: String(e?.message ?? e) })) };
  if (plan.gate) {
    const v = await c.pg.evaluate(pageGateValue, plan.gate).catch((e) => `evaluate failed: ${e?.message ?? e}`);
    const info = plan.gateInfo ? await c.pg.evaluate(pageGateInfo, plan.gateInfo).catch(() => null) : null;
    res.gate = { expr: plan.gate, value: v, info, ok: v === true };
    if (v !== true) throw new Error(`gate failed: ${plan.gate} -> ${JSON.stringify(v)}`);
  }
  res.pins = await c.pg.evaluate(pageApplyPins, plan.dayGroup ? { dayGroup: plan.dayGroup } : {});
  const wasm = [];
  for (const w of res.pins.wasm || []) wasm.push(await d.wasmProfileOf(w.url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${o.port}`)));
  if (!wasm.length) wasm.push({ ...(await d.wasmProfileOf(servedWasmUrl(plan.app))), source: "served-file (page listed no .wasm resource)" });
  res.asserts = buildAsserts({ plan, gpu: res.gpu, pins: res.pins, wasm, sized: res.window });
  res.assertProblems = runAssertProblems(res).problems;
  const pose = await c.pg.evaluate(() => window.__cam.world());
  const orbit = { x: pose.x, y: pose.y, z: pose.z + 1.5, dist: 70, az: 45, el: 22, degPerSec: plan.orbitDegPerSec };
  res.orbit = orbit;
  await c.pg.evaluate((o2) => { window.__hbOrbit = o2; }, orbit);
  // the same orbit warm-up hbbench runs before its still segment
  await c.pg.evaluate((o2) => new Promise((done) => { const t0 = performance.now(); const f = (now) => { window.__cam.orbit(o2.x, o2.y, o2.z, o2.dist, o2.az + ((now - t0) / 1000) * o2.degPerSec, o2.el); if (now - t0 >= 25000) return done(); requestAnimationFrame(f); }; requestAnimationFrame(f); }), orbit);
  await c.pg.evaluate((o2) => window.__cam.orbit(o2.x, o2.y, o2.z, o2.dist, o2.az, o2.el), orbit);
  await d.sleep(3000);
  return { c, plan, orbit };
}

/** {day, year, index, datName} of a DayGroup option ("none" -> null; default V2_DEFAULTS.dayGroup). */
export function dayGroupPin(v) {
  if (v === "none") return null;
  const idx = v == null ? V2_DEFAULTS.dayGroup : Number(v);
  if (!Number.isInteger(idx) || idx < 0 || idx > 19) throw new Error(`dayGroup must be 0..19 or "none" (got ${v})`);
  return { ...dayYearForGroup(idx), datName: DAY_GROUP_DAT_NAMES[idx] };
}

/**
 * The §4 pins on an attached session: DayGroup applied (sticky), the INNER window sized when `inner`
 * is given (Playwright or raw CDP session), every pin read back and checked. Never throws: problems
 * are returned (and recorded by the caller next to its results).
 */
export async function applySessionPins(c, { dayGroup = V2_DEFAULTS.dayGroup, inner = null, port = null, governorFlag = false } = {}, deps = {}) {
  const d = { ...BOOT_DEPS, ...deps };
  const out = { at: new Date().toISOString(), dayGroup: null, inner: inner ? [inner.w, inner.h] : null, port };
  try {
    const dg = dayGroupPin(dayGroup);
    out.dayGroup = dg;
    if (inner) out.window = await d.sizeWindow(c.ctx, c.pg, inner);
    out.pins = await c.pg.evaluate(pageApplyPins, dg ? { dayGroup: dg, adapter: true } : { adapter: true });
    const url = typeof c.pg.url === "function" ? c.pg.url() : "";
    out.url = redactUrl(url);
    out.problems = sessionPinProblems({ url, pins: out.pins, dayGroup: dg, inner, port, governorFlag });
  } catch (e) {
    out.problems = [`pins not applied: ${String((e && e.message) || e).slice(0, 200)}`];
  }
  return out;
}
