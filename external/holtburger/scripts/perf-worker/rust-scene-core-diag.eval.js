// rust-scene-core-diag.eval.js — page-side body of an async fn (`node hbsess.mjs eval rust-scene-core-diag.eval.js`),
// 2026-10-26, for the 1070 queue batch RC (docs/reengineering/queue-1070/batch-RC-rust-scene-core-2026-10-26.json).
//
// Is every Rust scene-core lane actually running on this page, and is the draw executor exact against the real
// driver? Reads each lane's diagnostic (a silent fallback to the JS path shows up as `available: false`, zero
// counts or `failures > 0`), runs the executor's per-draw self-check `__drawExec.verify(N)` (window.__rcVerifyFrames,
// default 120), and returns the console-error tally hbsess's boot installs. Same reads as the laptop smoke
// (scripts/perf-worker/laptop-rust-boot-smoke.mjs). Changes nothing on the page.
// 2026-10-29: also `__drawExec.census(N)` first when window.__rcCensusFrames is set (every draw by kind and
// outcome), the executor's bar in one place (`drawExecBar`: verify fails 0 with checks > 0, stats.texDemoted 0),
// and the round-2 lanes' diags for their arms: ?rustEntityWorld (`__entityWorld.stats()`), ?rustWorld
// (`__rustWorld.stats()` + `audit()`), ?hotTerrainShared (`__terrainShared.stats()` + `verify()`),
// ?hotWeaponFxSync (`__weaponFx.stats()`).

const call = (f) => { try { return typeof f === "function" ? f() : null; } catch (e) { return { error: String(e?.message ?? e) }; } };
const frames = window.__rcVerifyFrames || 120;
let census = null;
if (window.__rcCensusFrames > 0) {
  try { census = window.__drawExec?.census ? await window.__drawExec.census(window.__rcCensusFrames) : null; } catch (e) { census = { error: String(e?.message ?? e) }; }
}
let verify = null;
try { verify = window.__drawExec?.verify ? await window.__drawExec.verify(frames) : null; } catch (e) { verify = { error: String(e?.message ?? e) }; }
let meshes = 0;
try { window.liveScene3d?.scene?.traverse((o) => { if (o.isMesh) meshes += 1; }); } catch (_) { /* gone */ }
const errs = window.__hbConsoleErrors;
return {
  url: location.search,
  bootState: window.__bootState ?? null,
  meshes,
  sceneCoreAbi: (() => { try { return window.__hbSceneWasm?.sceneCoreAbi?.() ?? null; } catch (_) { return null; } })(),
  drawExecVerify: verify,
  drawExec: (() => { try { const st = window.__drawExec?.stats; return st ? { ...st } : null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
  drawExecBar: (() => {
    const st = window.__drawExec?.stats;
    if (!verify || verify.error || !st) return null;
    return { checks: verify.checks, fails: verify.fails, texDemoted: st.texDemoted, vaoFixLate: st.vaoFixLate, errors: st.errors,
      pass: verify.fails === 0 && verify.checks > 0 && st.texDemoted === 0 };
  })(),
  drawExecCensus: census,
  // ?rustEntityWorld: `projections` must be 1 (0 with the flag on = only the walk half runs; builds
  // before 2026-10-29 never installed the projection), renders > 0, cold ≈ visible part meshes.
  entityWorld: call(window.__entityWorld?.stats),
  rustWorld: call(window.__rustWorld?.stats),
  // audit() also returns its input arena (every instance matrix): never hand that back over CDP.
  rustWorldAudit: (() => { try { const a = window.__rustWorld?.audit?.(); return a ? { mismatches: a.mismatches, report: a.report } : null; } catch (e) { return { error: String(e?.message ?? e) }; } })(),
  terrainShared: call(window.__terrainShared?.stats),
  terrainSharedVerify: call(window.__terrainShared?.verify),
  weaponFx: call(window.__weaponFx?.stats),
  rustRig: call(window.__rustRig?.stats),
  rigMeshAlias: call(window.__rigMeshAlias?.stats),
  rustCull: call(window.__rustCull?.stats),
  rustCullVerify: call(window.__rustCull?.verify),
  rustAnimScenery: call(window.__rustAnimScenery?.stats),
  rustTerrainFx: call(window.__rustTerrainFx?.stats),
  particles: call(window.__particleInstancingDiag),
  consoleErrors: Array.isArray(errs) ? { count: errs.length, first: errs.slice(0, 10) } : (errs ?? null),
};
