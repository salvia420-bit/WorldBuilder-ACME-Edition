// analyze-census.mjs — turn results.jsonl into the tracking doc.
//
// The verdict logic is the whole point, so it is spelled out rather than tuned:
//
// The NOISE BAND IS MEASURED, NOT ASSUMED. Baseline runs are interleaved every
// Nth iteration and are all identical in configuration, so their spread IS this
// night's noise floor. A flag only counts as having an effect when it moves a
// metric further than the baselines moved among themselves. This matters
// because cross-boot p50 on this workload ranged 25.2-32.3 ms today purely from
// entity-population differences: a fixed "5% is significant" rule would have
// manufactured dozens of findings.
//
// Each flag is compared against the baselines that BRACKET it in time (the one
// before and the one after), so slow drift across the night cancels rather than
// accumulating into a false effect.
//
// Verdicts:
//   BOOT-FAIL / BOOT-TIMEOUT  the escape arm breaks the client. A finding.
//   PERF        a structural metric AND p50 moved beyond the band
//   STRUCTURAL  a structural metric moved; p50 did not clear the band
//   NO-OBSERVABLE-EFFECT   nothing moved beyond the band on ANY metric.
//               For a flag DOCUMENTED AS DEFAULT-ON this is the headline
//               result: either it is dead code, or its reader does not do what
//               the docs claim, or its effect needs a context this run did not
//               visit (indoors, combat, weather). All three are worth knowing,
//               and the third is why this is reported as "no observable effect
//               AT NANTO, PARKED" and never as "the flag does nothing".

import { readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] || '/mnt/wbterminal2/flag-census/results.jsonl';
const OUT = process.argv[3] || '/mnt/wbterminal2/flag-census/TRACKING.md';

const rows = readFileSync(IN, 'utf8').split('\n').filter((l) => l.trim()).map((l) => {
  try { return JSON.parse(l); } catch (_) { return null; }
}).filter(Boolean);

const METRICS = [
  ['draws', 'draws/frame'], ['ktris', 'ktris/frame'], ['p50', 'p50 ms'],
  ['renderables', 'renderables'], ['batchedMeshes', 'batched'], ['staticBatchC', 'batch-c'],
  ['atlasBuckets', 'atlasBk'], ['plainMeshes', 'meshes'], ['distinctMaterials', 'materials'],
  ['distinctPrograms', 'programs'], ['distinctGeometries', 'geoms'],
  ['transparentMaterials', 'transpMat'], ['heapMB', 'heapMB'], ['texMB', 'texMB'],
  ['infoTextures', 'texObjs'], ['programsCompiled', 'progsCompiled'],
];

const baselines = rows.filter((r) => !r.flag && r.verdict === 'OK');
const flagRows = rows.filter((r) => r.flag);

// --- measured noise band, per metric, from the baselines' own spread ---
const band = {};
for (const [k] of METRICS) {
  const v = baselines.map((b) => b[k]).filter((x) => typeof x === 'number');
  if (v.length < 2) { band[k] = null; continue; }
  const mean = v.reduce((a, c) => a + c, 0) / v.length;
  const sd = Math.sqrt(v.reduce((a, c) => a + (c - mean) ** 2, 0) / (v.length - 1));
  band[k] = { n: v.length, mean, sd, min: Math.min(...v), max: Math.max(...v),
              // band = the larger of observed full range and 3sd, so a lucky-tight
              // set of baselines cannot make everything look significant
              half: Math.max((Math.max(...v) - Math.min(...v)) / 2, 3 * sd) };
}

function bracketingBaseline(row, k) {
  const t = new Date(row.t).getTime();
  let before = null, after = null;
  for (const b of baselines) {
    if (typeof b[k] !== 'number') continue;
    const bt = new Date(b.t).getTime();
    if (bt <= t) before = b; else if (!after) after = b;
  }
  if (before && after) return (before[k] + after[k]) / 2;
  return (before ?? after)?.[k] ?? band[k]?.mean ?? null;
}

// How many metrics we can actually judge. If this is 0 the run can say NOTHING
// about a flag, and it must NOT be reported as "no effect".
//
// This guard exists because the first version did exactly that: run against
// smoke data with a single baseline, every band was null, every effect was
// skipped, and `animSceneryInstanced=off` — which adds 1,353 draws/frame and is
// the single largest effect in the tree — came out as NO-OBSERVABLE-EFFECT.
// Silence looked identical to success. A "nothing happened" verdict is only
// meaningful when the instrument could have detected something.
const MIN_BASELINES = 3;
const judgeable = METRICS.filter(([k]) => band[k]).length;
const canJudge = baselines.length >= MIN_BASELINES && judgeable > 0;

const analysed = flagRows.map((r) => {
  if (r.verdict !== 'OK') return { ...r, effects: [], verdictFinal: r.verdict };
  if (!canJudge) return { ...r, effects: [], verdictFinal: 'INSUFFICIENT-BASELINE' };
  const effects = [];
  for (const [k, label] of METRICS) {
    if (typeof r[k] !== 'number' || !band[k]) continue;
    const base = bracketingBaseline(r, k);
    if (base === null) continue;
    const d = r[k] - base;
    if (Math.abs(d) > band[k].half && band[k].half > 0) {
      effects.push({ k, label, base: +base.toFixed(1), val: r[k], d: +d.toFixed(1),
                     pct: base ? +(100 * d / base).toFixed(1) : null });
    }
  }
  const structural = effects.filter((e) => e.k !== 'p50');
  const perf = effects.some((e) => e.k === 'p50');
  let v = 'NO-OBSERVABLE-EFFECT';
  if (structural.length && perf) v = 'PERF';
  else if (structural.length) v = 'STRUCTURAL';
  else if (perf) v = 'PERF-ONLY(weak)';
  if ((r.errorCount ?? 0) > 0) v += '+ERRORS';
  return { ...r, effects, structural, verdictFinal: v };
});

const byVerdict = {};
for (const a of analysed) (byVerdict[a.verdictFinal] ||= []).push(a);

const fmtEffects = (e) => e.length
  ? e.slice(0, 6).map((x) => `${x.label} ${x.val} vs ${x.base} (${x.d > 0 ? '+' : ''}${x.d}${x.pct !== null ? `, ${x.pct > 0 ? '+' : ''}${x.pct}%` : ''})`).join('; ')
  : '—';

let md = `# URL-flag census — what each default-ON flag is actually paying for\n\n`;
md += `Generated ${new Date().toISOString()} from \`${IN}\`.\n\n`;
md += `**Method.** Each default-ON flag is booted once with its documented escape (\`?flag=off\`), at a fixed POI `;
md += `(parked camera, settle-gated on draws/frame), against BASELINE runs interleaved every few iterations. `;
md += `No client code is modified; this is measurement only.\n\n`;
md += `**The noise band is measured, not assumed.** Baselines are configuration-identical, so their own spread is `;
md += `this night's noise floor, and a flag only registers an effect when it moves a metric further than the `;
md += `baselines moved among themselves. Each flag is compared to the baselines BRACKETING it in time, so drift cancels. `;
md += `This matters: cross-boot p50 on this workload spans several ms purely from entity-population differences, so a `;
md += `fixed "5% is significant" rule would manufacture findings.\n\n`;
md += `**Read \`NO-OBSERVABLE-EFFECT\` carefully.** It means *no observable effect at this POI, parked, on these metrics*. `;
md += `It is evidence a flag may be dead or mis-documented — this tree has that history — but a flag whose effect needs `;
md += `an unvisited context (indoors, combat, weather, motion) will also land here. It is a lead, not a verdict.\n\n`;

md += canJudge
  ? `**Instrument check:** ${baselines.length} baselines, ${judgeable} metrics with a computable band — verdicts below are meaningful.\n\n`
  : `> ⚠ **INSTRUMENT CANNOT JUDGE.** Only ${baselines.length} baseline(s) and ${judgeable} judgeable metric(s); a band needs at least ${MIN_BASELINES} baselines. Every flag is reported as INSUFFICIENT-BASELINE rather than "no effect", because with no band a 1,353-draw change and a zero change are indistinguishable.\n\n`;
md += `## Runs\n\n`;
md += `| | count |\n|---|---|\n`;
md += `| baselines | ${baselines.length} |\n| flags tested | ${flagRows.length} |\n`;
for (const [k, v] of Object.entries(byVerdict).sort((a, b) => b[1].length - a[1].length)) {
  md += `| ${k} | ${v.length} |\n`;
}

md += `\n## Measured noise band (from ${baselines.length} baselines)\n\n`;
md += `| metric | mean | sd | min | max | band (±) |\n|---|---|---|---|---|---|\n`;
for (const [k, label] of METRICS) {
  const b = band[k];
  if (!b) continue;
  md += `| ${label} | ${b.mean.toFixed(1)} | ${b.sd.toFixed(2)} | ${b.min} | ${b.max} | ${b.half.toFixed(1)} |\n`;
}

const order = ['INSUFFICIENT-BASELINE', 'BOOT-FAIL', 'BOOT-TIMEOUT', 'RUN-ERROR', 'INFRA-FAIL', 'PERF', 'PERF+ERRORS', 'STRUCTURAL', 'STRUCTURAL+ERRORS', 'PERF-ONLY(weak)', 'NO-OBSERVABLE-EFFECT'];
for (const v of order) {
  const list = byVerdict[v];
  if (!list?.length) continue;
  md += `\n## ${v} (${list.length})\n\n`;
  if (v === 'INSUFFICIENT-BASELINE') {
    md += `**The instrument could not judge these.** Fewer than ${MIN_BASELINES} baselines, or no metric with a computable band — so nothing can be concluded either way. Listed so they are re-run, NOT so they are read as "no effect".\n\n`;
    md += `| flag | escape |\n|---|---|\n`;
    for (const a of list) md += `| \`${a.flag}\` | \`=${a.escape}\` |\n`;
  } else if (v === 'NO-OBSERVABLE-EFFECT') {
    md += `Documented default-ON, yet escaping it moved nothing beyond the noise band. Dead-flag candidates — verify a reader exists before acting.\n\n`;
    md += `| flag | escape | draws | p50 | materials | heapMB |\n|---|---|---|---|---|---|\n`;
    for (const a of list.sort((x, y) => x.flag.localeCompare(y.flag))) {
      md += `| \`${a.flag}\` | \`=${a.escape}\` | ${a.draws ?? '-'} | ${a.p50 ?? '-'} | ${a.distinctMaterials ?? '-'} | ${a.heapMB ?? '-'} |\n`;
    }
  } else if (v.startsWith('BOOT') || v.startsWith('RUN') || v.startsWith('INFRA')) {
    md += `| flag | escape | detail |\n|---|---|---|\n`;
    for (const a of list) {
      const d = (a.error || a.lastState || (a.errors || []).join(' | ') || '').slice(0, 140).replace(/\|/g, '\\|');
      md += `| \`${a.flag}\` | \`=${a.escape}\` | ${d || '—'} |\n`;
    }
  } else {
    const rank = list.sort((x, y) => {
      const m = (r) => Math.max(...r.effects.map((e) => Math.abs(e.pct ?? 0)), 0);
      return m(y) - m(x);
    });
    md += `| flag | escape | what moved |\n|---|---|---|\n`;
    for (const a of rank) {
      md += `| \`${a.flag}\` | \`=${a.escape}\` | ${fmtEffects(a.effects).replace(/\|/g, '\\|')} |\n`;
    }
  }
}

md += `\n## Requeue list (confirm these with interleaved repeats)\n\n`;
const requeue = analysed.filter((a) => a.verdictFinal.startsWith('PERF') || a.verdictFinal.startsWith('STRUCTURAL'))
  .sort((x, y) => Math.max(...y.effects.map((e) => Math.abs(e.pct ?? 0)), 0) - Math.max(...x.effects.map((e) => Math.abs(e.pct ?? 0)), 0))
  .slice(0, 25).map((a) => a.flag);
md += requeue.length ? '```\n' + requeue.join('\n') + '\n```\n' : '_none yet_\n';

writeFileSync(OUT, md);
console.log(`wrote ${OUT}`);
console.log(`baselines=${baselines.length} flags=${flagRows.length}`);
for (const [k, v] of Object.entries(byVerdict).sort((a, b) => b[1].length - a[1].length)) console.log(`  ${k.padEnd(24)} ${v.length}`);
