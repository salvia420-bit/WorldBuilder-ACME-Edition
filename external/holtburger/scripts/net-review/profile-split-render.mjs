// profile-split-render — split a V8 CPU profile into IN-FRAME vs BAKE by ANCESTOR.
//
// WHY. cpu-profile-probe reports self-time over the WHOLE MAIN THREAD. `renderCPU`
// (the number this chain optimises) is only the inside of `renderer.render()`.
// Reading one as the other is exactly the error that produced §4c's retracted
// claim that "the frame is bound by program resolve (~19%)".
//
// `getProgram` — the only caller of `getParameters` — has TWO callers:
//   three.module.js:18441  setProgram  -> the PER-FRAME path, inside render()
//   three.module.js:17283  prepareMaterial -> renderer.compile(), i.e. the BAKE
//                          path, reached from prewarmSubtree (statics.js:2297,
//                          terrain.js:3721, terrain_batch.js:431). NOT in the frame.
// So "getParameters is 10.2%" is ambiguous until you know which caller it sits
// under — and §4d measured every per-frame re-resolve trigger as DEAD, which
// predicts the answer is "mostly bake".
//
// METHOD: no timestamps, no clock alignment. A V8 profile is a TREE — each node
// has children ids and a hitCount (self samples). Walk it once, tag every node
// with the region its ANCESTOR CHAIN puts it in, then sum self-samples per
// region. A sample under WebGLRenderer.render IS in the frame, by construction.
//
// Usage: node profile-split-render.mjs <raw-profile.json> [more.json ...]
//   (raw profiles come from cpu-profile-probe.mjs's RAW=<path> env var)
import fs from "node:fs";

const IN_FRAME = /^(WebGLRenderer\.)?render$/;          // three.module.js:17541
const BAKE = /^(prepareMaterial|compile|compileAsync|prewarmSubtree)$/;

const classify = (profile) => {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const region = new Map(); // node id -> "frame" | "bake" | "other"
  const root = profile.nodes[0];

  // DFS from the root, inheriting the region; a node's own frame can OPEN a
  // region (render/compile), and once open it wins for the whole subtree.
  const stack = [[root.id, "other"]];
  const seen = new Set();
  while (stack.length) {
    const [id, inherited] = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    const fn = n.callFrame.functionName || "";
    const url = n.callFrame.url || "";
    let r = inherited;
    if (r === "other") {
      // Only three's own render/compile open a region; an app function named
      // "render" must not (that is why the url is checked).
      if (IN_FRAME.test(fn) && /three\.(module|core)\.js/.test(url)) r = "frame";
      else if (BAKE.test(fn)) r = "bake";
    }
    region.set(id, r);
    for (const c of n.children || []) stack.push([c, r]);
  }

  const total = profile.nodes.reduce((a, n) => a + (n.hitCount || 0), 0);
  const sums = { frame: 0, bake: 0, other: 0 };
  const perRegionFn = { frame: new Map(), bake: new Map(), other: new Map() };
  for (const n of profile.nodes) {
    const h = n.hitCount || 0;
    if (!h) continue;
    const r = region.get(n.id) || "other";
    sums[r] += h;
    const f = n.callFrame;
    const key = `${f.functionName || "(anonymous)"} @ ${(f.url || "(native)").split("/").pop()}:${f.lineNumber + 1}`;
    perRegionFn[r].set(key, (perRegionFn[r].get(key) || 0) + h);
  }
  return { total, sums, perRegionFn };
};

for (const path of process.argv.slice(2)) {
  const profile = JSON.parse(fs.readFileSync(path, "utf8"));
  const { total, sums, perRegionFn } = classify(profile);
  const pct = (n) => `${((100 * n) / total).toFixed(1)}%`;
  console.log(`\n=============== ${path.split("/").pop()} ===============`);
  console.log(`total samples ${total}`);
  console.log(`  INSIDE render()      ${String(sums.frame).padStart(6)}  ${pct(sums.frame).padStart(6)}   <- this is what renderCPU measures`);
  console.log(`  BAKE (compile/prewarm)${String(sums.bake).padStart(5)}  ${pct(sums.bake).padStart(6)}   <- NOT in the frame`);
  console.log(`  everything else      ${String(sums.other).padStart(6)}  ${pct(sums.other).padStart(6)}`);
  for (const r of ["frame", "bake"]) {
    const rows = [...perRegionFn[r].entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
    if (!rows.length) continue;
    console.log(`  --- top self-time ${r === "frame" ? "INSIDE render()" : "in BAKE"} (share of ALL samples) ---`);
    for (const [k, h] of rows) console.log(`      ${pct(h).padStart(6)}  ${k}`);
  }
  // The question that started this: where does getParameters actually live?
  const gp = (r) => [...perRegionFn[r].entries()].filter(([k]) => /getParameters|getProgramCacheKey|getProgram\b/.test(k)).reduce((a, [, h]) => a + h, 0);
  console.log(`  >>> program-resolve (getParameters/getProgramCacheKey/getProgram):`);
  console.log(`        inside render(): ${pct(gp("frame"))}   bake: ${pct(gp("bake"))}   other: ${pct(gp("other"))}`);
}
