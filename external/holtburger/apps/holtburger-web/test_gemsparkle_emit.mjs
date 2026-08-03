// Functional verifier for particle.gemSparkle (TASK 06). Plain node, no three.
// Exercises: contract validity, emit(ctx) spec shape, the persistent-additive POJO
// invariants, determinism (no Math.random), the geometry read, and the OFF =>
// no-emitter (byte-identical) guarantee via the attach-layer enabled-gate filter.
import { validateComponent } from "./scene3d/vfx/registry.js";
import { gemSparkle, gemSparkleEmitterInfo } from "./scene3d/vfx/components/gemSparkle.js";
import { gemSparkleEnabled, _resetVfxFlags } from "./scene3d/vfx_flags.js";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  [OK] ${l}`); } else { fail++; console.log(`  [FAIL] ${l} ${x}`); } };

// ---- contract ----
ok("validateComponent(gemSparkle) == [] (manifest valid)", validateComponent(gemSparkle).length === 0, JSON.stringify(validateComponent(gemSparkle)));
ok("id == particle.gemSparkle", gemSparkle.id === "particle.gemSparkle");
ok("family/mech/channel == particle/particle/emitter", gemSparkle.family === "particle" && gemSparkle.mech === "particle" && gemSparkle.channel === "emitter");
ok("linkVariant() === '' (no shader)", gemSparkle.linkVariant() === "");
ok("cacheKeyScope none (D2), deterministic true, lightCountDelta 0", gemSparkle.cacheKeyScope === "none" && gemSparkle.deterministic === true && gemSparkle.lightCountDelta === 0);
ok("reads == [geometry,clock], writes == [emitter]", JSON.stringify(gemSparkle.reads) === '["geometry","clock"]' && JSON.stringify(gemSparkle.writes) === '["emitter"]');
ok("enabled is the gemSparkleEnabled gate fn", gemSparkle.enabled === gemSparkleEnabled);

// ---- emit(ctx) spec shape ----
const specs = gemSparkle.emit({});
ok("emit() returns exactly ONE spec", Array.isArray(specs) && specs.length === 1);
const s0 = specs[0];
ok("spec has {emitterInfo, partIndex, parentOffset}", s0 && s0.emitterInfo && "partIndex" in s0 && "parentOffset" in s0);
ok("default partIndex == -1 (root anchor)", s0.partIndex === -1);
ok("default parentOffset == null (no lift)", s0.parentOffset === null);

// ---- persistent-additive POJO invariants ----
const e = s0.emitterInfo;
ok("persistent: totalSeconds==0 && totalParticles==0", e.totalSeconds === 0 && e.totalParticles === 0);
ok("emitterType==1 (BirthratePerSec)", e.emitterType === 1);
ok("particleType==0 (Still) for riseSpeed 0 default", e.particleType === 0);
ok("hwGfxObjId==0x010010F9 (D3: DAT-verified additive sparkleStar twinkle, from particle_sprites.js)", e.hwGfxObjId === 0x010010F9);
ok("maxParticles in 2..4 (==4 default), << 64 low-quality cap", e.maxParticles === 4);
ok("startScale > finalScale (shrink as it fades)", e.startScale > e.finalScale);
ok("startTrans < finalTrans (fade OUT: opaque->invisible, ACE polarity)", e.startTrans < e.finalTrans && e.startTrans === 0 && e.finalTrans === 1);
ok("isotropic spawn ball: offsetDir==0, maxOffset>0", e.offsetDirX === 0 && e.offsetDirY === 0 && e.offsetDirZ === 0 && e.maxOffset > 0);
ok("Still ⇒ zero velocity (a==0, maxA==0) ⇒ tight sortingSphere", e.aX === 0 && e.aY === 0 && e.aZ === 0 && e.maxA === 0);
ok("flat POJO fields only (no THREE vectors) — addEmitter-constructible", typeof e.aX === "number" && typeof e.offsetDirZ === "number");
ok("isParentLocal default true (hugs the gem part)", e.isParentLocal === true);

// ---- geometry read sizes the spawn ball ----
const big = gemSparkleEmitterInfo({}, { geometry: { halfExtent: 0.2 } });
ok("ctx.geometry.halfExtent drives maxOffset (clamped)", big.maxOffset === 0.2);
const fromBox = gemSparkleEmitterInfo({}, { geometry: { partBox: { min: [0, 0, 0], max: [0.1, 0.02, 0.02] } } });
ok("partBox max-span/2 sizes maxOffset", Math.abs(fromBox.maxOffset - 0.05) < 1e-9);
const huge = gemSparkleEmitterInfo({}, { geometry: { halfExtent: 999 } });
ok("oversize anchor clamped to 0.25 m (no fill bomb)", huge.maxOffset === 0.25);

// ---- determinism (no Math.random): same ctx => deep-equal; hash01 perturbs bounded ----
const a1 = JSON.stringify(gemSparkleEmitterInfo({}, { hash01: 0.37 }));
const a2 = JSON.stringify(gemSparkleEmitterInfo({}, { hash01: 0.37 }));
ok("deterministic: identical ctx => identical POJO", a1 === a2);
const h0 = gemSparkleEmitterInfo({}, { hash01: 0.0 });
const h9 = gemSparkleEmitterInfo({}, { hash01: 0.99 });
ok("hash01 desyncs birthrate within ±15% bound", h9.birthrate !== h0.birthrate && h9.birthrate <= 0.45 * 1.16 && h0.birthrate >= 0.45 * 0.84);
ok("hash01 initialParticles bounded 0..maxParticles", h0.initialParticles >= 0 && h9.initialParticles <= 4);

// ---- drift variant: riseSpeed>0 => LocalVelocity, tight cull (maxA==riseSpeed) ----
const drift = gemSparkleEmitterInfo({ riseSpeed: 0.03 }, {});
ok("riseSpeed>0 ⇒ particleType 1 (LocalVelocity), aZ unit, maxA==riseSpeed", drift.particleType === 1 && drift.aZ === 1 && drift.maxA === 0.03);

// ---- liftZ => parentOffset frame ----
const lifted = gemSparkle.emit({ config: { liftZ: 0.08 } })[0];
ok("liftZ ⇒ parentOffset.position.z set, identity quat", lifted.parentOffset && lifted.parentOffset.position.z === 0.08 && lifted.parentOffset.quaternion.w === 1);

// ---- OFF => byte-identical: the attach-layer enabled-gate filter (mirror frag_attach:96) ----
// Simulate window.location.search so vfx_flags reads the flag.
function setSearch(q) { globalThis.window = { location: { search: q } }; _resetVfxFlags(); }
// frag_attach.js:96 idiom: if (typeof comp.enabled === "function" && !comp.enabled()) drop.
const dropped = () => (typeof gemSparkle.enabled === "function" && !gemSparkle.enabled());

setSearch(""); // default: no flags → DEFAULT-ON (2026-06-24)
ok("DEFAULT (no flags): enabled()==true ⇒ KEPT ⇒ emitter synthesized (default-on)", dropped() === false && gemSparkleEnabled() === true);
setSearch("?gemSparkle=off");
ok("?gemSparkle=off: explicitly DROPPED (opt-out escape) ⇒ byte-identical", dropped() === true && gemSparkleEnabled() === false);
setSearch("?visualAll=off");
ok("?visualAll=off: per-effect fallback off ⇒ DROPPED", dropped() === true && gemSparkleEnabled() === false);
setSearch("?visualAll=off&gemSparkle=on");
ok("?visualAll=off&gemSparkle=on: surgical re-enable ⇒ KEPT", dropped() === false && gemSparkleEnabled() === true);
setSearch("?visual=all");
ok("?visual=all: KEPT", dropped() === false && gemSparkleEnabled() === true);
delete globalThis.window;

// ---------------------------------------------------------------------------
// ★★★ THE RESOLVED ANCHOR — driven through the REAL attach layer (2026-08-03).
//
// Everything above this line feeds emit() a HAND-BUILT ctx (`{geometry:{...}}`,
// `{partIndex}`). The runtime never builds that shape. `attachParticleEmitters`
// builds `{did, numParts, partBoxes, rig, hash01, seed, clock, tSec, weather,
// env, anchor, config}` — the resolved anchor is on `ctx.anchor` — so gemSparkle,
// which read only `ctx.geometry`/`ctx.partIndex`, discarded the entire P3.6
// anchor selection: every sparkle sat at the model origin with the authored
// 0.05 m ball no matter what the bake resolved. The hand-built ctx is exactly
// what made that invisible for a month.
//
// So this block calls the REAL `attachParticleEmitters` with the REAL
// `_resolveAnchor` in the loop and inspects what actually reaches addEmitter.
// If the ctx field names ever drift again, these go red.
// ---------------------------------------------------------------------------
{
  const { attachParticleEmitters } = await import("./scene3d/vfx/particle_attach.js");
  const { setVfxCatalog } = await import("./scene3d/vfx_catalog.js");

  // A real catalog entry whose config asks for a NON-root anchor role, which is
  // what makes _resolveAnchor pick a part from partBoxes.
  const DID = 0x0200aa01;
  setVfxCatalog(new Map([[DID, {
    archetype: "magic-gem",
    componentIds: new Set(["particle.gemSparkle"]),
    config: { "particle.gemSparkle": { anchor: "canopy" } },
    raw: {},
  }]]));

  // Two parts; part 1 is the topmost centroid, so _resolveAnchor must pick it.
  // Its bbox is 0.24 m across ⇒ radius 0.12 (inside the 0.25 clamp, and far from
  // the authored 0.05 default, so a pass cannot be a coincidence).
  const partBoxes = [
    { minX: -0.5, maxX: 0.5, minY: -0.5, maxY: 0.5, minZ: 0.0, maxZ: 0.2, cx: 0, cy: 0, cz: 0.1 },
    { minX: -0.12, maxX: 0.12, minY: -0.1, maxY: 0.1, minZ: 1.0, maxZ: 1.2, cx: 0.3, cy: -0.4, cz: 1.1 },
  ];

  const calls = [];
  const mgr = { async addEmitter(req) { calls.push(req); return calls.length; } };
  const res = await attachParticleEmitters(
    {}, [{ modelId: DID, landblockId: 0xab940001, x: 1, y: 2, z: 3 }], {},
    () => "static:0",
    {
      manager: mgr,
      buildParent: () => ({ position: {}, quaternion: {} }),
      geometryFor: () => ({ numParts: 2, partBoxes, rig: null }),
      useOwnerRegistry: false,
      clockNow: () => 0,
    },
  );

  ok("★ real attach path produces exactly one gemSparkle emitter",
    res.emitterCount === 1 && calls.length === 1, `count=${res.emitterCount}`);

  const req = calls[0] || {};
  ok("★ BEHAVIOUR: the RESOLVED part index reaches addEmitter (not the -1 root default)",
    req.partIndex === 1, `partIndex=${req.partIndex}`);
  ok("★ BEHAVIOUR: the spawn ball is sized from the RESOLVED part bbox, not cfg.spawnRadius",
    req.emitterInfo && Math.abs(req.emitterInfo.maxOffset - 0.12) < 1e-9,
    `maxOffset=${req.emitterInfo && req.emitterInfo.maxOffset}`);
  ok("★ ...and that is demonstrably NOT the authored default (0.05)",
    req.emitterInfo && Math.abs(req.emitterInfo.maxOffset - 0.05) > 1e-6);
  ok("★ BEHAVIOUR: parentOffset carries the resolved anchor CENTRE (ball sits on the gem)",
    req.parentOffset && Math.abs(req.parentOffset.position.x - 0.3) < 1e-9
      && Math.abs(req.parentOffset.position.y - (-0.4)) < 1e-9
      && Math.abs(req.parentOffset.position.z - 1.1) < 1e-9,
    JSON.stringify(req.parentOffset && req.parentOffset.position));

  // NEGATIVE CONTROL: role "root" must NOT inherit _resolveAnchor's radius, which
  // is `config.maxOffset || 1` — a literal 1 m, 20x the authored ball. A naive
  // "just use anchor.radius" fix passes the assertions above and fails this one.
  setVfxCatalog(new Map([[DID, {
    archetype: "magic-gem",
    componentIds: new Set(["particle.gemSparkle"]),
    config: {},                       // no anchor role ⇒ role "root"
    raw: {},
  }]]));
  const calls2 = [];
  const mgr2 = { async addEmitter(req2) { calls2.push(req2); return calls2.length; } };
  await attachParticleEmitters(
    {}, [{ modelId: DID, landblockId: 0xab940001 }], {}, () => "static:0",
    {
      manager: mgr2,
      buildParent: () => ({ position: {}, quaternion: {} }),
      geometryFor: () => ({ numParts: 2, partBoxes, rig: null }),
      useOwnerRegistry: false, clockNow: () => 0,
    },
  );
  ok("★ NEGATIVE CONTROL: a ROOT anchor keeps the authored 0.05 m ball (not _resolveAnchor's 1 m)",
    calls2.length === 1 && Math.abs(calls2[0].emitterInfo.maxOffset - 0.05) < 1e-9,
    `maxOffset=${calls2.length && calls2[0].emitterInfo.maxOffset}`);
  ok("root anchor still reports partIndex -1", calls2.length === 1 && calls2[0].partIndex === -1);
  ok("root anchor with no lift keeps parentOffset null (byte-identical default path)",
    calls2.length === 1 && calls2[0].parentOffset === null);

  setVfxCatalog(new Map());
}

console.log(`\ngemSparkle emit/firewall: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
