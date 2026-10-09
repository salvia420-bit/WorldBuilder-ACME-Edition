// ltattr.mjs — name the main thread's long tasks from an academy run (2026-10-09, Workstream D).
//   node ltattr.mjs acad-<label>.json [acad-<label>.cpuprofile] [--from S] [--to S] [--min MS] [--top N]
// Needs a run with `--longtasks --profile` (academy.mjs). Long tasks are page-clock [startMs, ms];
// the profile records the page clock at its start (`pageMsAtStart`), and the run JSON has the
// page's timeOrigin (net.page.origin) and the run's t0, so both land on the run clock (seconds
// since academy.mjs started). Per long task: the top self-time frames inside its window and the
// outermost app-level entry chain; then the self-time totals across all of them.
import { readFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const pos = argv.filter((x, i) => !x.startsWith("--") && !(i > 0 && argv[i - 1].startsWith("--")));
const jsonPath = pos[0];
if (!jsonPath) { console.error("usage: node ltattr.mjs acad-<label>.json [acad-<label>.cpuprofile] [--from S] [--to S] [--min MS] [--top N]"); process.exit(2); }
const profPath = pos[1] || jsonPath.replace(/\.json$/, ".cpuprofile");
const FROM = +opt("--from", 0), TO = +opt("--to", 1e9), MIN = +opt("--min", 50), TOP = +opt("--top", 25);

const d = JSON.parse(readFileSync(jsonPath, "utf8"));
const origin = d.net?.page?.origin;
if (!Number.isFinite(origin) || !Number.isFinite(d.t0)) { console.error("run JSON lacks net.page.origin / t0"); process.exit(2); }
// page ms + off = run ms. sum.pageClockSkewMs (academy.mjs, 2026-10-09; absent in older runs → 0)
// removes the laptop↔1070 wall-clock skew so the tasks line up with the rows / tunnel* stamps.
const skew = Number.isFinite(d.sum?.pageClockSkewMs) ? d.sum.pageClockSkewMs : 0;
const off = origin - d.t0 - skew;
const lts = (d.longtasks || []).map(([s, dur]) => ({ pageMs: s, s: (s + off) / 1000, dur }))
  .filter((x) => x.s >= FROM && x.s < TO && x.dur >= MIN);
const hist = [50, 100, 200, 400, 800, 1e9], hc = hist.map(() => 0);
for (const x of lts) hc[hist.findIndex((h) => x.dur < h)]++;
console.log(`${lts.length} long tasks >= ${MIN} ms in [${FROM}, ${TO}) s, total ${(lts.reduce((q, x) => q + x.dur, 0) / 1000).toFixed(2)} s`);
console.log(`  histogram <50/<100/<200/<400/<800/>=800 ms: ${hc.join(" ")}`);
const sm = d.sum || {};
console.log(`  run: inWorld ${sm.inWorld} · firstCellMesh ${sm.firstCellMesh} · texturesDone ${sm.texturesDone}` +
  (sm.tunnelReveal != null ? ` · tunnelReveal ${sm.tunnelReveal} · wallsVisible ${sm.wallsVisible}` : ""));

if (!existsSync(profPath)) {
  console.log(`(no profile at ${profPath} — run academy.mjs with --profile to attribute them)`);
  for (const x of lts) console.log(`  @${x.s.toFixed(2)}s ${String(x.dur).padStart(5)} ms`);
  process.exit(0);
}
const p = JSON.parse(readFileSync(profPath, "utf8"));
if (!Number.isFinite(p.pageMsAtStart)) { console.error("profile lacks pageMsAtStart (older academy.mjs?)"); process.exit(2); }
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
const nm = (n) => `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").pop().split("?")[0]}:${n.callFrame.lineNumber + 1}`;
const IDLE = /^\((idle|program|garbage collector)\)/;
// Samples on the page clock: [pageMs, nodeId, dtUs].
const samples = [];
let t = 0;
for (let i = 0; i < p.samples.length; i++) { t += p.timeDeltas[i] || 0; samples.push([p.pageMsAtStart + t / 1000, p.samples[i], p.timeDeltas[i] || 0]); }
const total = new Map();
for (const x of lts.slice().sort((q, r) => r.dur - q.dur).slice(0, TOP)) {
  const s0 = x.pageMs, s1 = s0 + x.dur;
  const self = new Map(), roots = new Map();
  for (const [ms, id, dt] of samples) {
    if (ms < s0 || ms > s1) continue;
    const n = byId.get(id); if (!n) continue;
    const k = nm(n);
    if (IDLE.test(k)) { self.set(k, (self.get(k) || 0) + dt); continue; }
    self.set(k, (self.get(k) || 0) + dt);
    total.set(k, (total.get(k) || 0) + dt);
    const chain = [];
    for (let cur = id; cur != null; cur = parent.get(cur)) chain.push(byId.get(cur));
    const top = chain.reverse().slice(1, 5).map(nm).join(" > ");
    roots.set(top, (roots.get(top) || 0) + dt);
  }
  const topSelf = [...self.entries()].sort((q, r) => r[1] - q[1]).slice(0, 4).map(([k, v]) => `${k} ${(v / 1000).toFixed(0)}ms`).join(" · ");
  const entry = [...roots.entries()].sort((q, r) => r[1] - q[1])[0];
  console.log(`  @${x.s.toFixed(2)}s ${String(x.dur).padStart(5)} ms | ${topSelf.slice(0, 200)}`);
  console.log(`        entry: ${entry ? entry[0].slice(0, 220) : "-"}`);
}
console.log("self time across the attributed long tasks:");
for (const [k, v] of [...total.entries()].sort((q, r) => r[1] - q[1]).slice(0, 15)) console.log(`  ${(v / 1000).toFixed(0).padStart(6)} ms  ${k}`);
