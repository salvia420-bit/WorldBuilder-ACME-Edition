// 2026-08-06 — the texture re-hydration registry (`scene3d/texture_rehydrate.js`)
// and its wiring into the context-restore path (`scene3d/webgl_context_recovery.js`).
//
// WHY THIS SUITE EXISTS. §9 of the 08-05 handoff measured 1,332 MB of the JS
// heap held as CPU-side copies of pixels already on the GPU; §10 withdrew
// releasing them because three's restore path re-uploads FROM those copies
// (three.module.js:16382 via :17055) and `webgl_context_recovery.js` exists
// precisely because context loss is real on the 1070 ("observed 7×"). This
// module is the replacement re-upload source. Everything it must guarantee is a
// PART below:
//
//   PART 1 — the registry: register / re-register / unregister / WeakRef, and
//            the `textureHasPixels` predicate the whole thing pivots on.
//   PART 2 — a released texture is re-hydrated, verified, and marked
//            needsUpdate so three actually re-uploads it.
//   PART 3 — a MISS is LOUD. Rejection, an explicit `false`, and the nastiest
//            case — a rehydrator that resolves having supplied nothing — all
//            land on console.error and in the `failed` counter. A silently
//            black texture is the exact failure this subsystem prevents.
//   PART 4 — THE NO-OP. With an empty registry the restore path keeps its
//            original fully-synchronous shape: onResume before the caller ever
//            yields. This is every page today.
//   PART 5 — ORDERING vs the frame pump. onResume (which sets `running = true`,
//            index.js:4938) must not fire until the pass settles, because
//            `tick` early-returns on `!running` (index.js:2235-2236) and that
//            is the only thing keeping render() away from a pixel-less texture.
//   PART 6 — no double-fire: a duplicate `webglcontextrestored` is ignored, and
//            a pass superseded by a SECOND loss neither resumes the pump nor
//            merges into the next restore's pass.
//   PART 7 — no deadlock: a rehydrator that never settles hits the pass
//            deadline, is reported as a miss, and the pump resumes anyway.
//
// WHAT THIS SUITE CANNOT SEE (no GPU in node):
//   * that three's restore really does re-upload from the re-supplied
//     `image.data` — that is three's `uploadTexture` and needs a live context;
//   * that the re-supplied pixels are the RIGHT pixels (a real wasm decode);
//   * that the stall is short enough to be tolerable on the 1070;
//   * that no OTHER path renders while paused (only `tick`'s `!running` guard
//     is read here, not exercised).
//   Those are owner-run 1070 items: `__loseContext()` → `__restoreContext()`
//   with `window.__textureRehydrate.stats().failed === 0` and a non-black frame.
//
// Run:
//   cd apps/holtburger-web/
//   node test_texture_rehydrate.mjs

import {
  registerReleasedTexture,
  unregisterReleasedTexture,
  releasedTextureCount,
  rehydrateReleasedTextures,
  textureRehydrateStats,
  textureHasPixels,
  releaseTextureDataForTest,
  __resetTextureRehydrateForTests,
  DEFAULT_TIMEOUT_MS,
} from "./scene3d/texture_rehydrate.js";
import { installWebglContextRecovery } from "./scene3d/webgl_context_recovery.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** A DataTexture-shaped stand-in. Three's `image` is `{data,width,height}` and
 *  `source.data` is the SAME object in r184 (test_texture_census.mjs header) —
 *  mirror that so `textureHasPixels` is exercised the way it will run. */
function makeTex(bytes = 64) {
  const image = { data: new Uint8Array(bytes), width: 4, height: 4 };
  return { image, source: { data: image }, mipmaps: [], needsUpdate: false, isTexture: true };
}

function makeCanvas() {
  const listeners = Object.create(null);
  return {
    clientWidth: 800,
    clientHeight: 600,
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    fire(type, ev) { for (const fn of listeners[type] || []) fn(ev); },
  };
}

const fakeRenderer = {
  getSize(t) { t.set(800, 600); return t; },
  setRenderTarget() {},
  getContext() { return null; },
};

const lostEvent = { preventDefault() {} };

/** Install a recovery handle over fresh fakes, recording resume/pause order. */
function makeRecovery(extra = {}) {
  const canvas = makeCanvas();
  const log = [];
  const live = {};
  const handle = installWebglContextRecovery({
    renderer: fakeRenderer,
    canvas,
    getLiveScene3d: () => live,
    onPause: () => log.push("pause"),
    onResume: () => log.push("resume"),
    ...extra,
  });
  return { canvas, log, live, handle };
}

/** Drain microtasks + timers. The pass is chained off a promise, so a settled
 *  world needs a macrotask turn, not just `await null`. */
const turn = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** Capture console.error/warn for the loudness assertions. */
function captureConsole(fn) {
  const errs = [], warns = [];
  const e0 = console.error, w0 = console.warn;
  console.error = (...a) => errs.push(a.map(String).join(" "));
  console.warn = (...a) => warns.push(a.map(String).join(" "));
  const restore = () => { console.error = e0; console.warn = w0; };
  const out = fn();
  if (out && typeof out.then === "function") {
    return out.then((v) => { restore(); return { errs, warns, value: v }; },
                    (e) => { restore(); throw e; });
  }
  restore();
  return Promise.resolve({ errs, warns, value: out });
}

// ---------------------------------------------------------------------------

console.log("PART 1 — the registry and the pixel predicate");
{
  __resetTextureRehydrateForTests();
  check("empty by default", releasedTextureCount() === 0);

  const tex = makeTex();
  check("a texture with bytes HAS pixels", textureHasPixels(tex) === true);
  tex.image.data = null;
  check("...and none once the copy is released", textureHasPixels(tex) === false);
  check("a zero-length buffer is not pixels",
        textureHasPixels({ image: { data: new Uint8Array(0) } }) === false);
  check("a compressed texture counts its mip 0",
        textureHasPixels({ image: null, mipmaps: [{ data: new Uint8Array(8) }] }) === true);
  check("a released compressed texture does not",
        textureHasPixels({ image: null, mipmaps: [{ data: null }] }) === false);
  check("a canvas/ImageBitmap-backed texture always has pixels (we never release those)",
        textureHasPixels({ image: { width: 64, height: 64 } }) === true);
  check("a render target has no CPU copy and must never read as a miss",
        textureHasPixels({ isRenderTargetTexture: true, image: null }) === true);

  const id = registerReleasedTexture(tex, () => true, { label: "0x06003789", owner: "unit" });
  check("register returns an id and counts", id > 0 && releasedTextureCount() === 1);
  const id2 = registerReleasedTexture(tex, () => true, { label: "0x06003789" });
  check("re-registering the SAME texture replaces, never stacks",
        id2 === id && releasedTextureCount() === 1);
  check("stats attribute by owner", textureRehydrateStats().byOwner.unknown === 1,
        JSON.stringify(textureRehydrateStats().byOwner));

  check("unregister by texture", unregisterReleasedTexture(tex) === true && releasedTextureCount() === 0);
  check("unregister twice is a no-op, not a throw", unregisterReleasedTexture(tex) === false);

  let threw = null;
  try { registerReleasedTexture(makeTex(), null); } catch (e) { threw = e; }
  check("a registration with no rehydrator is REFUSED (it would look covered and not be)",
        threw !== null && /rehydrate callback is required/.test(String(threw.message)));
}

console.log("PART 2 — a released texture is re-hydrated and marked for re-upload");
{
  __resetTextureRehydrateForTests();
  const tex = makeTex();
  const fresh = new Uint8Array(64).fill(7);
  releaseTextureDataForTest(tex, async () => ({ data: fresh }), { label: "surf-A" });
  check("the test double really dropped the copy", textureHasPixels(tex) === false);
  check("...and registered it", releasedTextureCount() === 1);

  const sum = await rehydrateReleasedTextures({ reason: "unit" });
  check("pixels are back", textureHasPixels(tex) === true && tex.image.data === fresh);
  check("needsUpdate set so three re-uploads on the next render", tex.needsUpdate === true);
  check("counted as rehydrated, not failed",
        sum.rehydrated === 1 && sum.failed === 0 && sum.attempted === 1,
        JSON.stringify(sum));
  check("registration PERSISTS (release→restore→release needs no re-register)",
        releasedTextureCount() === 1);

  const sum2 = await rehydrateReleasedTextures({ reason: "unit-again" });
  check("a second pass SKIPS a texture that already has pixels",
        sum2.skipped === 1 && sum2.attempted === 0, JSON.stringify(sum2));

  // Concurrency: several entries, one pass, all served.
  __resetTextureRehydrateForTests();
  const many = [];
  for (let i = 0; i < 9; i++) {
    const t = makeTex();
    many.push(t);
    releaseTextureDataForTest(t, async () => { await turn(1); return { data: new Uint8Array(64) }; },
                              { label: `surf-${i}` });
  }
  const sum3 = await rehydrateReleasedTextures({ reason: "unit-many", concurrency: 4 });
  check("every entry is served under bounded concurrency",
        sum3.rehydrated === 9 && sum3.failed === 0 && many.every(textureHasPixels),
        JSON.stringify(sum3));
}

console.log("PART 3 — a MISS is loud, never silent");
{
  // (a) the rehydrator rejects
  __resetTextureRehydrateForTests();
  {
    const tex = makeTex();
    releaseTextureDataForTest(tex, async () => { throw new Error("record evicted"); }, { label: "surf-boom" });
    const { errs, value } = await captureConsole(() => rehydrateReleasedTextures({ reason: "unit" }));
    check("a rejecting rehydrator is a failure", value.failed === 1 && value.rehydrated === 0);
    check("...and it hits console.error naming the texture",
          errs.some((l) => l.includes("[tex-rehydrate] MISS") && l.includes("surf-boom")),
          JSON.stringify(errs));
    check("...and warns that it will render BLACK",
          errs.some((l) => l.includes("BLACK")));
    check("...and the diag counter records it", textureRehydrateStats().failed === 1);
  }
  // (b) the rehydrator says `false` (a proven-absent record)
  __resetTextureRehydrateForTests();
  {
    const tex = makeTex();
    releaseTextureDataForTest(tex, async () => null, { label: "surf-absent" });
    const { errs, value } = await captureConsole(() => rehydrateReleasedTextures({ reason: "unit" }));
    check("an explicit `false` is a failure", value.failed === 1);
    check("...reported loudly", errs.some((l) => l.includes("surf-absent")));
  }
  // (c) THE dangerous one: resolves successfully but supplied nothing.
  __resetTextureRehydrateForTests();
  {
    const tex = makeTex();
    tex.image.data = null;
    registerReleasedTexture(tex, async () => true, { label: "surf-liar", owner: "unit" });
    const { errs, value } = await captureConsole(() => rehydrateReleasedTextures({ reason: "unit" }));
    check("a rehydrator that CLAIMS success and supplies nothing is still a miss",
          value.failed === 1 && value.rehydrated === 0, JSON.stringify(value));
    check("...and says so", errs.some((l) => l.includes("supplied no pixels")),
          JSON.stringify(errs));
  }
  // (d) a synchronous throw is not allowed to abort the pass
  __resetTextureRehydrateForTests();
  {
    const bad = makeTex(); bad.image.data = null;
    const good = makeTex();
    registerReleasedTexture(bad, () => { throw new Error("sync boom"); }, { label: "sync-bad" });
    releaseTextureDataForTest(good, async () => ({ data: new Uint8Array(64) }), { label: "sync-good" });
    const { value } = await captureConsole(() => rehydrateReleasedTextures({ reason: "unit", concurrency: 1 }));
    check("one throwing entry does not strand the rest",
          value.failed === 1 && value.rehydrated === 1, JSON.stringify(value));
  }
  // (e) dispose DURING a restore is legal — an entry unregistered while the
  //     pass is awaiting an earlier one must be dropped, not reported black.
  __resetTextureRehydrateForTests();
  {
    const slow = makeTex(); slow.image.data = null;
    const doomed = makeTex(); doomed.image.data = null;
    let doomedCalls = 0;
    registerReleasedTexture(slow, async () => {
      // Disposed mid-pass, the way LB eviction can fire during a restore.
      unregisterReleasedTexture(doomed);
      await turn(2);
      slow.image.data = new Uint8Array(64);
      return true;
    }, { label: "slow" });
    registerReleasedTexture(doomed, async () => { doomedCalls++; return false; }, { label: "doomed" });
    const { errs, value } = await captureConsole(
      () => rehydrateReleasedTextures({ reason: "unit", concurrency: 1 }));
    check("an entry unregistered mid-pass is never attempted",
          doomedCalls === 0 && value.failed === 0 && value.rehydrated === 1,
          JSON.stringify(value));
    check("...and produced no false alarm", errs.length === 0, JSON.stringify(errs));
  }
}

console.log("PART 4 — THE NO-OP: nothing registered ⇒ the restore path stays synchronous");
{
  __resetTextureRehydrateForTests();
  const { canvas, log, live } = makeRecovery();
  canvas.fire("webglcontextlost", lostEvent);
  check("loss pauses the pump", log.join(",") === "pause");
  canvas.fire("webglcontextrestored");
  // No `await` between the event and this assertion: with an empty registry
  // the resume must have happened INSIDE the handler, exactly as before this
  // subsystem existed.
  check("resume fires synchronously with an empty registry — no behaviour change today",
        log.join(",") === "pause,resume", log.join(","));
  check("no rehydrating state was entered", live.__webglRehydrating === undefined);
  check("no pass was even started", textureRehydrateStats().passes === 0);
}

console.log("PART 5 — ORDERING: the pump stays parked until the pass settles");
{
  __resetTextureRehydrateForTests();
  let release;
  const gate = new Promise((r) => { release = r; });
  const tex = makeTex();
  releaseTextureDataForTest(tex, async () => { await gate; return { data: new Uint8Array(64) }; },
                            { label: "slow-surf" });

  const { canvas, log, live, handle } = makeRecovery();
  await captureConsole(async () => {
    canvas.fire("webglcontextlost", lostEvent);
    canvas.fire("webglcontextrestored");
    check("resume did NOT fire synchronously while a texture is pixel-less",
          log.join(",") === "pause", log.join(","));
    await turn(5);
    check("...still parked while the decode is in flight", log.join(",") === "pause", log.join(","));
    check("handle reports the re-hydrating state", handle.isRehydrating() === true);
    check("...and so does liveScene3d", live.__webglRehydrating === true);
    check("the GL context itself is no longer 'lost'", live.__webglContextLost === false);
    release();
    await turn(5);
    check("resume fires ONLY after the pixels are back",
          log.join(",") === "pause,resume" && textureHasPixels(tex), log.join(","));
    check("...and the re-hydrating state cleared", handle.isRehydrating() === false);
  });
  const hist = handle.history.map((h) => h.state).join(",");
  check("the event log records restore then rehydrate", hist === "lost,restored,rehydrated", hist);
}

console.log("PART 6 — no double-fire");
{
  // (a) duplicate `webglcontextrestored` for one loss
  __resetTextureRehydrateForTests();
  {
    const { canvas, log } = makeRecovery();
    await captureConsole(() => {
      canvas.fire("webglcontextlost", lostEvent);
      canvas.fire("webglcontextrestored");
      canvas.fire("webglcontextrestored");
    });
    check("a repeated restore for the same loss resumes once, not twice",
          log.join(",") === "pause,resume", log.join(","));
  }
  // (b) a SECOND loss while the pass is decoding
  __resetTextureRehydrateForTests();
  {
    let release1;
    const gate1 = new Promise((r) => { release1 = r; });
    const tex = makeTex();
    let calls = 0;
    releaseTextureDataForTest(tex, async () => {
      calls++;
      if (calls === 1) { await gate1; return null; }   // pass 1: superseded
      return { data: new Uint8Array(64) };             // pass 2: the real one
    }, { label: "twice-surf" });

    const { canvas, log } = makeRecovery();
    await captureConsole(async () => {
      canvas.fire("webglcontextlost", lostEvent);      // loss #1
      canvas.fire("webglcontextrestored");             // pass 1 starts
      await turn(2);
      canvas.fire("webglcontextlost", lostEvent);      // loss #2 supersedes it
      release1();
      await turn(5);
      check("the superseded pass does NOT resume the pump",
            log.join(",") === "pause,pause", log.join(","));
      canvas.fire("webglcontextrestored");             // loss #2's restore
      await turn(5);
      check("the new restore runs its OWN pass instead of joining the abandoned one",
            calls === 2, `rehydrator calls=${calls}`);
      check("...and only then resumes",
            log.join(",") === "pause,pause,resume", log.join(","));
      check("pixels came back on the second pass", textureHasPixels(tex) === true);
    });
    check("the abandoned pass is recorded as such, not as a success",
          textureRehydrateStats().aborted === 1, String(textureRehydrateStats().aborted));
  }
}

console.log("PART 7 — no deadlock: a wedged rehydrator resumes the pump anyway");
{
  __resetTextureRehydrateForTests();
  const tex = makeTex();
  // Never settles — the shape of a decode stuck behind a wasm module that
  // never loads (bc7_textures.js:685-695 documents that exact hazard).
  releaseTextureDataForTest(tex, () => new Promise(() => {}), { label: "wedged-surf" });
  const { canvas, log } = makeRecovery({ rehydrateTimeoutMs: 25 });
  const { errs } = await captureConsole(async () => {
    canvas.fire("webglcontextlost", lostEvent);
    canvas.fire("webglcontextrestored");
    await turn(5);
    check("parked while inside the deadline", log.join(",") === "pause", log.join(","));
    await turn(80);
    check("the pump resumes after the deadline rather than deadlocking",
          log.join(",") === "pause,resume", log.join(","));
  });
  check("the timeout is reported as a MISS, loudly",
        errs.some((l) => l.includes("MISS (timeout)") && l.includes("wedged-surf")),
        JSON.stringify(errs));
  const st = textureRehydrateStats();
  check("...and counted", st.timedOut === 1 && st.failed === 1, JSON.stringify({ t: st.timedOut, f: st.failed }));
  check("the shipped default deadline is the documented one", DEFAULT_TIMEOUT_MS === 15000);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
