// gl-census.eval.js — WebGL calls per second over `seconds` (needs gl-count.init.js), plus the page's contexts.
const R = Object.assign({ seconds: 10 }, window.__carryRun || {});
const G = window.__glCount;
if (!G) return { fatal: "no __glCount (plan.initScript gl-count.init.js)" };
G.reset();
await new Promise((r) => setTimeout(r, R.seconds * 1000));
const perSec = {};
for (const [k, v] of Object.entries(G.counts)) perSec[k] = Math.round((v / R.seconds) * 10) / 10;
const contexts = (G.contexts || []).map((e) => ({ type: e.type, w: e.w, h: e.h, id: String(e.id).slice(0, 40) }));
let workers = null;
try { workers = performance.getEntriesByType("resource").filter((e) => /worker/i.test(e.name)).map((e) => e.name.split("/").pop()).slice(0, 10); } catch (_) { /* */ }
return { label: R.label, perSec, contexts, workers, summary: { glCallsPerSec: Object.values(perSec).reduce((a, b) => a + b, 0) } };
