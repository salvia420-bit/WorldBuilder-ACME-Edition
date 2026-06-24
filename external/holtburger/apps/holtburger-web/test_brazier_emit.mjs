// Functional verifier for particle.brazierEmbers (P3.6). Plain node, no three.
// Ports agent-09's validate_brazier assertions onto the REAL particle_attach emit(ctx)
// contract (particle_attach.js:356): emit(ctx) takes ONE ctx; a live `ctx.rig` (with
// partFrames) = the ENTITY seam (bowl partIndex + in-part local offset); no rig = the
// STATIC frozen seam (root anchor -1 + model-space offset). Exercises: contract
// validity, the TWO-emitter ember+smoke shapes, anchoring per seam, determinism, and
// the OFF => byte-identical enabled-gate.
import { validateComponent } from "./scene3d/vfx/registry.js";
import { brazierEmbers, buildEmberInfo, buildSmokeInfo } from "./scene3d/vfx/components/brazierEmbers.js";
import { brazierEnabled, _resetVfxFlags } from "./scene3d/vfx_flags.js";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => { if (c) { pass++; console.log(`  [OK] ${l}`); } else { fail++; console.log(`  [FAIL] ${l} ${x}`); } };

// ---- contract ----
ok("validateComponent(brazierEmbers) == []", validateComponent(brazierEmbers).length === 0, JSON.stringify(validateComponent(brazierEmbers)));
ok("id == particle.brazierEmbers", brazierEmbers.id === "particle.brazierEmbers");
ok("family/mech/channel == particle/particle/emitter", brazierEmbers.family === "particle" && brazierEmbers.mech === "particle" && brazierEmbers.channel === "emitter");
ok("linkVariant() === '' (no shader)", brazierEmbers.linkVariant() === "");
ok("cacheKeyScope none (D2), deterministic true, lightCountDelta 0", brazierEmbers.cacheKeyScope === "none" && brazierEmbers.deterministic === true && brazierEmbers.lightCountDelta === 0);
ok("reads == [geometry,clock], writes == [emitter]", JSON.stringify(brazierEmbers.reads) === '["geometry","clock"]' && JSON.stringify(brazierEmbers.writes) === '["emitter"]');
ok("enabled is the brazierEnabled gate fn", brazierEmbers.enabled === brazierEnabled);

// ---- STATIC seam: no ctx.rig => root anchor + model-space offset (0,0,0.77) ----
const stat = brazierEmbers.emit({ did: 0x02000ce2, hash01: 0.3 });
ok("static: emit() returns 2 specs (embers + smoke)", Array.isArray(stat) && stat.length === 2);
ok("static: partIndex == -1 (root anchor)", stat.every((s) => s.partIndex === -1));
ok("static: model-space offset z == 0.77 (bowl rim)", stat[0].parentOffset.position.z === 0.77 && stat[0].parentOffset.quaternion.w === 1);

// ---- ENTITY seam: live rig => bowl partIndex 1 + in-part local offset (0,-0.304,0.303) ----
const ent = brazierEmbers.emit({ did: 0x02000ce2, rig: { partFrames: [{}, {}] } });
ok("entity: 2 specs, partIndex == 1 (resolved bowl)", ent.length === 2 && ent.every((s) => s.partIndex === 1));
ok("entity: in-part local offset (y -0.304, z 0.303)", ent[0].parentOffset.position.y === -0.304 && ent[0].parentOffset.position.z === 0.303);

// ---- ember POJO: additive sprite, persistent, rises, shrinks, fades ----
const em = stat[0].emitterInfo;
ok("ember: hwGfxObjId 0x01000FF4 (additive flameCore)", em.hwGfxObjId === 0x01000ff4);
ok("ember: persistent (totalSeconds 0 && totalParticles 0)", em.totalSeconds === 0 && em.totalParticles === 0);
ok("ember: rises (aZ>0, minA==maxA>0) and shrinks (startScale>finalScale)", em.aZ > 0 && em.minA === em.maxA && em.maxA > 0 && em.startScale > em.finalScale);
ok("ember: fades out (startTrans 0 -> finalTrans 1)", em.startTrans === 0 && em.finalTrans === 1);

// ---- smoke POJO: alpha sprite, grows, fades ----
const sm = stat[1].emitterInfo;
ok("smoke: hwGfxObjId 0x01000FBF (alpha smokeDark)", sm.hwGfxObjId === 0x01000fbf);
ok("smoke: persistent + GROWS (finalScale>startScale)", sm.totalSeconds === 0 && sm.finalScale > sm.startScale);
ok("smoke: fades out (startTrans 0 -> finalTrans 1)", sm.startTrans === 0 && sm.finalTrans === 1);

// ---- count cap (LOW preset maxParticlesPerEmitter 64 headroom) ----
const e = buildEmberInfo(brazierEmbers.defaults), s = buildSmokeInfo(brazierEmbers.defaults);
ok("ember+smoke maxParticles <= 64 (LOW cap headroom)", e.maxParticles + s.maxParticles <= 64, `${e.maxParticles}+${s.maxParticles}`);
ok("flat POJO fields only (addEmitter-constructible)", typeof em.aX === "number" && typeof em.offsetDirZ === "number");

// ---- determinism (no Math.random) ----
const d1 = JSON.stringify(brazierEmbers.emit({ did: 1, rig: null }));
const d2 = JSON.stringify(brazierEmbers.emit({ did: 1, rig: null }));
ok("deterministic: identical ctx => identical specs", d1 === d2);

// ---- OFF => byte-identical (attach-layer enabled-gate, mirror frag_attach:96) ----
function setSearch(q) { globalThis.window = { location: { search: q } }; _resetVfxFlags(); }
const dropped = () => (typeof brazierEmbers.enabled === "function" && !brazierEmbers.enabled());
setSearch("");
ok("DEFAULT: enabled()==false ⇒ DROPPED ⇒ byte-identical", dropped() === true && brazierEnabled() === false);
setSearch("?visual=on");
ok("?visual=on alone: still DROPPED (per-effect default OFF)", dropped() === true);
setSearch("?brazier=on");
ok("?brazier=on: KEPT ⇒ emitters synthesized", dropped() === false && brazierEnabled() === true);
setSearch("?visual=all");
ok("?visual=all lights brazier", brazierEnabled() === true);
setSearch("?brazier=off");
ok("?brazier=off: explicitly DROPPED", dropped() === true);
delete globalThis.window;

console.log(`\nbrazierEmbers emit/firewall: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
