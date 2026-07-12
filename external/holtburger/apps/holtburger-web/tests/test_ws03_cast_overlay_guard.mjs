// test_ws03_cast_overlay_guard.mjs — WS03 (S2) weight-restore bookkeeping.
//   PART 1 behavioral (16 checks): swap-safe base suppression/restore +
//           install-underneath + forward-edge anim-break, against DOM-free fakes
//           (a faithful transcription of the H1-H3 contract).
//   PART 2 static: entities.js + url-flags.md carry the ?castOverlayGuard patch
//           shape, AND the new restore guards live strictly INSIDE the flag gate
//           (MF1 — flag-OFF must stay byte-identical: the legacy same-action gate
//           survives verbatim in the `else`).
// Run: node tests/test_ws03_cast_overlay_guard.mjs   (from apps/holtburger-web/)
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
let failed = 0, passed = 0;
const check = (n, ok, d) => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };

// ---- DOM-free fakes ----
class FakeAction { constructor(k){this.key=k;this._w=0;this._run=false;this.enabled=false;this.time=0;}
  setEffectiveWeight(w){this._w=w;return this;} getEffectiveWeight(){return this._w;}
  setEffectiveTimeScale(){return this;} reset(){this.time=0;return this;}
  play(){this._run=true;this.enabled=true;return this;} stop(){this._run=false;return this;}
  isRunning(){return this._run;} setLoop(){return this;} }
class FakeMixer { constructor(){this.ls=[];} addEventListener(t,f){this.ls.push([t,f]);}
  removeEventListener(t,f){this.ls=this.ls.filter(([tt,ff])=>!(tt===t&&ff===f));}
  fireFinished(a){for(const [t,f] of [...this.ls]) if(t==="finished") f({action:a});} }
const newInst = () => ({ actions:new Map(), mixer:new FakeMixer(), _locoCycleKey:null,
  _baseSuppressAction:null, _baseSuppressSaved:null, currentAction:null, currentActionKey:null });

// ---- transcription of the patched (?castOverlayGuard=on) logic ----
function suppress(inst, overlay, hookDrain){
  if(!inst||!overlay||!inst.mixer) return;
  if(inst._baseSuppressAction===overlay) return;
  const base=inst.actions.get(inst._locoCycleKey);
  if(!base||base===overlay) return;
  if(typeof base.isRunning==="function" && !base.isRunning()) return;
  const saved=base.getEffectiveWeight();
  base.setEffectiveWeight(0);
  inst._baseSuppressAction=overlay; inst._baseSuppressSaved={savedWeight:saved};
  if(hookDrain) return;
  const onFinished=(e)=>{ if(e.action!==overlay) return;
    inst.mixer.removeEventListener("finished",onFinished);
    if(inst._baseSuppressAction!==overlay) return;   // stale/anim-broken → inert
    inst._baseSuppressAction=null; restoreCurrent(inst); };
  inst.mixer.addEventListener("finished",onFinished);
}
function restoreCurrent(inst){ const s=inst._baseSuppressSaved; inst._baseSuppressSaved=null;
  const cur=inst.actions.get(inst._locoCycleKey);
  if(cur && (typeof cur.isRunning!=="function"||cur.isRunning()))
    cur.setEffectiveWeight(s&&s.savedWeight>0?s.savedWeight:1.0); }
function completeOverlay(inst, action){ if(inst&&action&&inst._baseSuppressAction===action){
  inst._baseSuppressAction=null; restoreCurrent(inst); } }
function installUnder(inst, base, key){ const pk=inst._locoCycleKey;
  if(pk&&pk!==key){ const p=inst.actions.get(pk); if(p&&p!==base) p.stop(); }
  base.reset(); base.enabled=true; base.setEffectiveWeight(0); base.play();
  inst.actions.set(key,base); inst._locoCycleKey=key; }
function animBreak(inst){ const ov=inst._baseSuppressAction;
  if(ov&&typeof ov.isRunning==="function"&&ov.isRunning()) ov.stop();
  inst._baseSuppressAction=null; restoreCurrent(inst); }
function playOverlay(inst, key){ const a=new FakeAction(key); a.play().setEffectiveWeight(1.0);
  inst.actions.set(key,a); inst.currentAction=a; inst.currentActionKey=key; return a; }

console.log("PART 1: contract");
{ const i=newInst(); const run=new FakeAction("run"); run.play().setEffectiveWeight(1.0);
  i.actions.set("run",run); i._locoCycleKey="run"; const ov=playOverlay(i,"swing:132:49");
  suppress(i,ov,true);
  check("suppress zeroes base", run.getEffectiveWeight()===0);
  check("overlay stays weight 1", ov.getEffectiveWeight()===1); }
{ const i=newInst(); const walk=new FakeAction("walk"); walk.play().setEffectiveWeight(1.0);
  i.actions.set("walk",walk); i._locoCycleKey="walk"; const ov=playOverlay(i,"swing:132:49");
  suppress(i,ov,true); const run=new FakeAction("run"); installUnder(i,run,"run");
  if(i._baseSuppressAction===ov) run.setEffectiveWeight(0);
  check("swap: overlay NOT stopped", ov.isRunning());
  check("swap: old base stopped", !walk.isRunning());
  check("swap: new base weight 0", run.getEffectiveWeight()===0);
  check("swap: _locoCycleKey repointed", i._locoCycleKey==="run");
  completeOverlay(i,ov);
  check("complete: NEW base restored to 1", run.getEffectiveWeight()===1);
  check("complete: old base not resurrected", walk.getEffectiveWeight()===0 && !walk.isRunning());
  check("complete: bookkeeping cleared", i._baseSuppressAction===null && i._baseSuppressSaved===null); }
{ const i=newInst(); const walk=new FakeAction("walk"); walk.play().setEffectiveWeight(1.0);
  i.actions.set("walk",walk); i._locoCycleKey="walk"; const ov=playOverlay(i,"swing:70:49");
  suppress(i,ov,false); const run=new FakeAction("run"); installUnder(i,run,"run");
  if(i._baseSuppressAction===ov) run.setEffectiveWeight(0); i.mixer.fireFinished(ov);
  check("non-drain: NEW base restored via finished", run.getEffectiveWeight()===1);
  check("non-drain: listener removed", i.mixer.ls.length===0);
  i.mixer.fireFinished(ov);
  check("non-drain: no double-restore on stale finished", run.getEffectiveWeight()===1); }
{ const i=newInst(); const run=new FakeAction("run"); run.play().setEffectiveWeight(1.0);
  i.actions.set("run",run); i._locoCycleKey="run"; const ov=playOverlay(i,"swing:132:49");
  suppress(i,ov,true); animBreak(i);
  check("anim-break: overlay STOPPED", !ov.isRunning());
  check("anim-break: base restored to 1", run.getEffectiveWeight()===1);
  check("anim-break: bookkeeping cleared", i._baseSuppressAction===null); }
{ const i=newInst(); const run=new FakeAction("run"); run.play().setEffectiveWeight(1.0);
  i.actions.set("run",run); i._locoCycleKey="run"; const ov=playOverlay(i,"swing:70:49");
  suppress(i,ov,false); animBreak(i); run.setEffectiveWeight(0.5); i.mixer.fireFinished(ov);
  check("anim-break: stale finished is inert (no double-touch)", run.getEffectiveWeight()===0.5); }

console.log("PART 2: static source shape");
const ent = readFileSync(join(ROOT, "scene3d/entities.js"), "utf8");
check("entities.js defines CAST_OVERLAY_GUARD (=='on' opt-in)",
  /CAST_OVERLAY_GUARD[\s\S]{0,300}get\("castOverlayGuard"\)\s*\?\.\s*toLowerCase\(\)\s*===\s*"on"/.test(ent));
check("setMotion install-underneath guards on _baseSuppressAction.isRunning() → weight 0",
  /CAST_OVERLAY_GUARD\s*&&[\s\S]{0,220}_baseSuppressAction[\s\S]{0,200}isRunning\(\)[\s\S]{0,700}setEffectiveWeight\(0\)/.test(ent));
check("install-underneath no-ops on same-cycle re-issue",
  /cacheKey === inst\._locoCycleKey[\s\S]{0,200}return;/.test(ent));
check("cancelCastSequence hard-cuts the overlay under the flag",
  /cancelCastSequence\(guid, cause\) \{[\s\S]{0,1400}CAST_OVERLAY_GUARD[\s\S]{0,260}_baseSuppressAction[\s\S]{0,200}\.stop\(\)/.test(ent));
// MF1: the swap-safe early-return must live INSIDE the flag gate, and the legacy
// same-action gate must survive verbatim in the `else` (flag-OFF byte-identical).
check("restore early-return is INSIDE the flag gate (onFinished)",
  /if \(CAST_OVERLAY_GUARD\)\s*\{[\s\S]{0,260}if \(inst\._baseSuppressAction !== overlayAction\) return;/.test(ent));
check("flag-OFF keeps the legacy same-action restore verbatim (else cur === baseAction)",
  /\}\s*else\s*\{[\s\S]{0,500}if \(cur === baseAction\)/.test(ent));
const flags = readFileSync(join(ROOT, "docs/url-flags.md"), "utf8");
check("url-flags.md documents ?castOverlayGuard", /\|\s*`castOverlayGuard`\s*\|/.test(flags));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
