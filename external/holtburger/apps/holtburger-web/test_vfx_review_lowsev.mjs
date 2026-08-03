// The three lower-severity 2026-08-03 review fixes (task #128):
//   1. particle_attach._particleEffectEnabled bypassed the ?visual master gate
//      for every component that defines `enabled` — i.e. all 11 of them.
//   2. breathFog's synthId collided with terrainDustDevil's (both 0xF0E00010),
//      collapsing the warn-dedup keys that surface "this emitter will not render".
//   3. selection_brackets._probeCornerArt abandoned its waiter queue on the
//      early-return path, leaking four DOM-holding closures per layer.

import { particleEntriesForDescriptor } from "./scene3d/vfx/particle_attach.js";
import { _resetVfxCatalog } from "./scene3d/vfx_catalog.js";
import { _resetVfxFlags } from "./scene3d/vfx_flags.js";
import "./scene3d/vfx/components/index.js";           // register the Tier-1 set
import { breathFog } from "./scene3d/vfx/components/breathFog.js";
import { terrainDustDevil } from "./scene3d/vfx/components/terrainDustDevil.js";
import { terrainSwampFireflies, terrainSwampMidges, terrainMarshGas }
  from "./scene3d/vfx/components/terrainSwampAmbient.js";
import { foliagePollen, foliageFireflies, foliageLeaves } from "./scene3d/vfx/components/foliageAmbient.js";

let pass = 0, fail = 0;
const ok = (l, c, x = "") => {
  if (c) { pass++; console.log(`  [OK] ${l}`); }
  else { fail++; console.log(`  [FAIL] ${l} ${x}`); }
};

function setSearch(search) {
  globalThis.window = { location: { search } };
  _resetVfxFlags();
  _resetVfxCatalog();     // visualEnabled() is memoized in vfx_catalog
}

// ---------------------------------------------------------------------------
// 1. ★ The ?visual master gate must kill the particle path, both arms.
// ---------------------------------------------------------------------------
{
  const descriptorOf = (id) => ({ componentIds: new Set([id]), config: {} });
  // Every component that defines `enabled` — the arm that used to bypass the gate.
  const withEnabled = [
    "particle.foliagePollen", "particle.foliageFireflies", "particle.foliageLeaves",
    "particle.breathFog", "particle.gemSparkle", "particle.brazierEmbers",
  ];

  setSearch("");   // bare default: master ON
  for (const id of withEnabled) {
    ok(`bare default: ${id} is selected (no behaviour change)`,
      particleEntriesForDescriptor(descriptorOf(id)).length === 1);
  }

  setSearch("?visual=off");
  let leaked = [];
  for (const id of withEnabled) {
    if (particleEntriesForDescriptor(descriptorOf(id)).length !== 0) leaked.push(id);
  }
  ok("★ ?visual=off drops EVERY particle component (the master gate is real now)",
    leaked.length === 0, `still selected: ${leaked.join(", ")}`);

  // The terrain components are the sharpest case: their `enabled()` composes only
  // family+effect flags, so with those flags on and ?visual=off the OLD code
  // selected them outright.
  setSearch("?visual=off&terrainSwamp=on&terrainSwampFireflies=on&terrainSwampMidges=on&terrainMarshGas=on");
  const terrainLeaked = ["terrain.swampFireflies", "terrain.swampMidges", "terrain.marshGas"]
    .filter((id) => particleEntriesForDescriptor(descriptorOf(id)).length !== 0);
  ok("★ ?visual=off beats an explicitly-enabled terrain family (was: selected anyway)",
    terrainLeaked.length === 0, `still selected: ${terrainLeaked.join(", ")}`);

  // ...and the same flags WITHOUT ?visual=off must still select, so the fix is a
  // gate and not a blanket disable.
  setSearch("?terrainSwamp=on&terrainSwampFireflies=on");
  ok("★ NEGATIVE CONTROL: the terrain family still selects when ?visual is on",
    particleEntriesForDescriptor(descriptorOf("terrain.swampFireflies")).length === 1);

  delete globalThis.window;
  _resetVfxFlags();
  _resetVfxCatalog();
}

// ---------------------------------------------------------------------------
// 2. ★ synthId uniqueness across every synthesized emitter.
// ---------------------------------------------------------------------------
{
  // (component id, the emitterInfo `id` each of its defaults produces)
  const ids = [
    ["particle.foliagePollen", foliagePollen.defaults.synthId],
    ["particle.foliageFireflies", foliageFireflies.defaults.synthId],
    ["particle.foliageLeaves", foliageLeaves.defaults.synthId],
    ["particle.breathFog", breathFog.defaults.synthId],
    ["terrain.sandDevils", terrainDustDevil.defaults.synthId],
    ["terrain.swampFireflies", terrainSwampFireflies.defaults.synthId],
    ["terrain.swampMidges", terrainSwampMidges.defaults.synthId],
    ["terrain.marshGas/bubbles", terrainMarshGas.defaults.bubbleSynthId],
    ["terrain.marshGas/wisp", terrainMarshGas.defaults.wispSynthId],
  ];
  const seen = new Map();
  const dupes = [];
  for (const [name, id] of ids) {
    if (seen.has(id)) dupes.push(`${name} == ${seen.get(id)} (0x${(id >>> 0).toString(16)})`);
    else seen.set(id, name);
  }
  ok("★ every synthesized emitter carries a UNIQUE synthId (warn-dedup keys stay distinct)",
    dupes.length === 0, dupes.join("; "));
  ok("★ specifically: breathFog !== terrainDustDevil (the 0xF0E00010 collision)",
    breathFog.defaults.synthId !== terrainDustDevil.defaults.synthId,
    `both 0x${(breathFog.defaults.synthId >>> 0).toString(16)}`);
  ok("all synthIds are in the reserved 0xF0E000xx synthesized block",
    ids.every(([, id]) => (id >>> 0) >= 0xF0E00000 && (id >>> 0) <= 0xF0E000FF));
}

// ---------------------------------------------------------------------------
// 3. ★ The corner-art probe must settle its queue on EVERY exit path.
// ---------------------------------------------------------------------------
{
  // `?bracketCornerArt=off` is read at module load, so drive the other early-out:
  // a host with no `Image` constructor (which is also the node/headless case).
  const sb = await import("./scene3d/selection_brackets.js");
  sb._resetCornerArtProbe();

  const verdicts = [];
  // Reach the private queue the way the layer does — via the module's own
  // registration path, which _resetCornerArtProbe/_cornerArtWaiterCount expose.
  const { _cornerArtWaiterCount } = sb;
  ok("setup: the waiter queue starts empty", _cornerArtWaiterCount() === 0);

  // A layer registers one waiter per corner. Simulate four registrations through
  // the real code path by constructing a layer against a minimal DOM.
  const el = () => {
    const node = {
      style: {}, dataset: {}, className: "", parentNode: null,
      children: [], appendChild(c) { c.parentNode = this; this.children.push(c); },
      removeChild(c) { c.parentNode = null; },
      ownerDocument: null,
    };
    node.ownerDocument = { createElement: () => el() };
    return node;
  };
  const domRoot = el();
  const canvas = { clientWidth: 800, clientHeight: 600 };
  const layer = new sb.SelectionBracketLayer(domRoot, canvas);

  ok("★ no `Image` host ⇒ the queue is DRAINED, not abandoned (was: 4 leaked closures)",
    _cornerArtWaiterCount() === 0, `left=${_cornerArtWaiterCount()}`);

  // dispose() must release the target refs as well.
  layer.setTarget(0x1234, { fake: "rig" }, { offset: { x: 0, y: 0, z: 0 }, radius: 1 });
  ok("setup: the layer is holding a target", layer._follow !== null && layer._sphere !== null);
  layer.dispose();
  ok("★ dispose() releases the followed rig + sphere (no retained entity graph)",
    layer._follow === null && layer._sphere === null && layer._guid === 0);
  ok("dispose() then tick() is a safe no-op", (() => {
    try { layer.tick({ matrixWorld: {} }); return true; } catch (_) { return false; }
  })());

  sb._resetCornerArtProbe();
  void verdicts;
}

console.log(`\nVFX review low-severity fixes: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
