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

console.log(`\ngemSparkle emit/firewall: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
