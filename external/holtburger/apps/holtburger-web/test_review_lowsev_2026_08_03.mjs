// test_review_lowsev_2026_08_03.mjs — the behavioural half of the 2026-08-03
// lower-severity sweep (task #152).
//
//   b) diag.diff() reported PASS for an oracle describing a DIFFERENT
//      landblock — a comparison with zero comparanda reading green.
//   d) the adaptive render-scale controller dropped resolution on a SINGLE
//      long frame (indistinguishable from a main-thread bake stall), and
//      counted a "change" even when the scale never actually moved.
//
// Run: node test_review_lowsev_2026_08_03.mjs

let clock = 1000;
const _realNow = () => Number(process.hrtime.bigint() / 1000000n);
const _base = _realNow();
globalThis.performance = { now: () => (_realNow() - _base) + clock };
globalThis.window = globalThis;

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

// ── (b) a vacuous diff must not read PASS ──────────────────────────────────
{
  const { installDiag } = await import("./scene3d/diag.js");
  delete globalThis.__diag;
  const d = installDiag();
  const LB_A = 0xa9b40000, LB_B = 0x00010000;
  d.setExpected({ landblockId: LB_A, npcs: [{ wcid: 1, name: "x", x: 1, y: 2, z: 3 }] });

  const wrong = d.diff(LB_B);
  check("(b) a diff against an unrelated landblock is flagged vacuous",
    wrong.vacuous === true, JSON.stringify({ vacuous: wrong.vacuous, n: wrong.expectedCount }));
  check("(b) …and names the oracle's actual landblock",
    wrong.oracleLandblockId === "0xa9b40000", String(wrong.oracleLandblockId));
  check("(b) …and runAll reports NO-ORACLE, not PASS",
    d.runAll(LB_B).summary.spawns === "NO-ORACLE", d.runAll(LB_B).summary.spawns);

  const right = d.diff(LB_A);
  check("(b) the matching landblock still compares for real",
    right.vacuous === false && right.expectedCount === 1,
    JSON.stringify({ vacuous: right.vacuous, n: right.expectedCount }));
  check("(b) …and a genuinely missing NPC is still DRIFT",
    d.runAll(LB_A).summary.spawns === "DRIFT", d.runAll(LB_A).summary.spawns);
  check("(b) runAll names surfaces whose attach never produced a diff",
    Array.isArray(d.runAll(LB_A).missingSurfaces));
}

// ── (d) the adaptive controller ────────────────────────────────────────────
{
  const { AdaptiveRenderScaleController } = await import("./scene3d/adaptive_render_scale.js");

  // A single catastrophic frame (a terrain bake / shard decode / GC pause)
  // must NOT drop the resolution.
  {
    let scale = 1, t = 0;
    const c = new AdaptiveRenderScaleController({
      getScale: () => scale, applyScale: (s) => { scale = s; }, now: () => t,
    });
    t = 16; c.recordFrame();
    t = 32; c.recordFrame();
    t = 900; c.recordFrame();            // one 868 ms stall
    t = 916; c.recordFrame();            // …and straight back to 60 fps
    check("(d) a single long frame does not drop the scale",
      scale === 1 && c.changes === 0, `scale=${scale} changes=${c.changes}`);
  }

  // A sustained fill-bound GPU (the 4 s / 4K turn this path exists for) must
  // still drop immediately — the fast path keeps its job.
  {
    let scale = 1, t = 0;
    const c = new AdaptiveRenderScaleController({
      getScale: () => scale, applyScale: (s) => { scale = s; }, now: () => t,
    });
    t = 16; c.recordFrame();
    t = 1016; c.recordFrame();           // 1 s frame
    t = 2016; c.recordFrame();           // …and another
    check("(d) two consecutive catastrophic frames still drop immediately",
      scale < 1 && c.changes === 1, `scale=${scale} changes=${c.changes}`);
  }

  // A controller whose applyScale silently no-ops (the production wrapper
  // swallows its own errors) must not report changes it did not make.
  {
    let t = 0;
    const c = new AdaptiveRenderScaleController({
      getScale: () => 1,                 // never moves, whatever we "apply"
      applyScale: () => { /* swallowed, exactly like index.js's wrapper */ },
      now: () => t,
    });
    t = 16; c.recordFrame();
    t = 1016; c.recordFrame();
    t = 2016; c.recordFrame();
    check("(d) a no-op applyScale is NOT counted as a change",
      c.changes === 0, `changes=${c.changes}`);
    check("(d) …it is counted as a no-op instead (visible, not silent)",
      c.applyNoOps > 0, `applyNoOps=${c.applyNoOps}`);
  }

  // A throwing applyScale is likewise visible.
  {
    let t = 0;
    const c = new AdaptiveRenderScaleController({
      getScale: () => 1,
      applyScale: () => { throw new Error("no renderer"); },
      now: () => t,
    });
    t = 16; c.recordFrame();
    t = 1016; c.recordFrame();
    t = 2016; c.recordFrame();
    check("(d) a throwing applyScale is counted, not swallowed silently",
      c.changes === 0 && c.applyFailures > 0, `failures=${c.applyFailures}`);
  }

  // The healthy raise path is untouched.
  {
    let scale = 0.5, t = 0;
    const c = new AdaptiveRenderScaleController({
      getScale: () => scale, applyScale: (s) => { scale = s; }, now: () => t,
    });
    for (let i = 0; i < 200; i += 1) { t += 16; c.recordFrame(); }
    check("(d) a healthy GPU still raises the scale back up",
      scale > 0.5, `scale=${scale}`);
  }
}

console.log("");
console.log(`review low-sev 2026-08-03: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
