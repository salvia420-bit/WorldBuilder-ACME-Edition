// residency-dump.eval.js — pull the ?residencyLog record out of the page (scene3d/residency_log.js): summary, per-second
// rows, lead times, holes, flips (10 s and 30 s windows) and the raw events as columns [tRelMs, lb, kind, a, b].
// window.__vehicleRun: {events: true|false (default true), sinceSec: 0}
const R = window.__vehicleRun || {};
const RL = window.__residency;
if (!RL) return { fatal: "window.__residency missing (?residencyLog=on not set, or no frame ran)" };
const d = RL.dump();
const out = {
  summary: d.summary,
  flips10: RL.flips(10),
  flips30: RL.flips(30),
  lead: d.lead,
  holes: d.holes,
  rows: d.rows,
  kinds: d.kinds,
  bits: d.bits,
};
if (R.events !== false) out.events = d.events.filter((e) => e[0] >= (R.sinceSec ?? 0) * 1000);
out.summaryLine = {
  seconds: d.summary.seconds, events: d.summary.events,
  objFlips10: out.flips10.objects.flips, terrainFlips10: out.flips10.terrain.flips, toggles: d.summary.toggles,
  holeFrames: d.holes.holeFrames, holeLbFrames: d.holes.holeLbFrames, holeAhead: d.holes.holeAheadLbFrames,
  leadT: d.lead.terrain, leadO: d.lead.objects, cover: d.summary.cover, fps: d.summary.fps,
};
return out;
