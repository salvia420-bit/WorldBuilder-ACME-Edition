// EVICT-DISPOSE (2026-10-06): an AnimationCache entry evicted by the LRU cap
// must release its part geometries. GC never frees an uploaded geometry's GL
// buffers (three's WebGLGeometries holds it until 'dispose'), and entity
// despawn skips untagged cache geometries (FU3) — so they leaked.
import { AnimationCache } from "./scene3d/animation.js";

let passed = 0, failed = 0;
const check = (n, ok, d = "") => { console.log(`  [${ok ? "OK" : "FAIL"}] ${n}${d ? " — " + d : ""}`); ok ? passed++ : failed++; };
const geo = () => ({ userData: {}, disposed: 0, dispose() { this.disposed++; } });
const entry = (geos) => Promise.resolve({ partGroups: [{ groups: geos.map((g) => ({ geometry: g })) }, { groups: [] }] });

const c = new AnimationCache();
c.maxEntries = 2;
const a = [geo(), geo()], b = [geo()], d = [geo()];
c.entries.set("A", entry(a));
c.entries.set("B", entry(b));
c.entries.set("D", entry(d));
c.pendingStartTimes.set("B", 0); // in flight: must be skipped, not evicted
c._evictLruIfNeeded();
await new Promise((r) => setTimeout(r, 0));
check("LRU head evicted, in-flight skipped", !c.entries.has("A") && c.entries.has("B") && c.entries.has("D"));
check("evicted entry's geometries disposed", a.every((g) => g.disposed === 1));
check("evicted entry's geometries tagged __disposable (live users now own release)", a.every((g) => g.userData.__disposable === true));
check("surviving entries untouched", b[0].disposed === 0 && d[0].disposed === 0 && !d[0].userData.__disposable);

c.entries.set("R", Promise.reject(new Error("fetch failed")));
c.pendingStartTimes.delete("B");
c.maxEntries = 0;
c._evictLruIfNeeded();
await new Promise((r) => setTimeout(r, 0));
check("rejected entry eviction is a no-op (no throw)", c.entries.size === 0);

const c2 = new AnimationCache();
const e = [geo()];
c2.entries.set("E", entry(e));
c2.dispose();
await new Promise((r) => setTimeout(r, 0));
check("cache dispose() releases every entry's geometry", e[0].disposed === 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
