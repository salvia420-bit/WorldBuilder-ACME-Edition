// vehicle-observe.eval.js — any page: what this session sees of vehicles. Finds stand-in entities by name
// (window.__vehicleRun.name, default "Hellcat"), samples their positions for sampleMs, reports the HBV1 traffic this
// session received (a non-capable session must report 0) and whether the capable module is loaded.
const R = window.__vehicleRun || {};
const name = R.name || "Hellcat";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const em = window.liveScene3d.entityManager;
const me = () => em.entityMap.get((window.getLocalPlayerGuid?.() ?? 0) >>> 0)?.root?.position;
const find = () => [...em.entityMap.entries()].filter(([, i]) => (i.meta?.name ?? "") === name).map(([g, i]) => ({ guid: g >>> 0, inst: i }));
const samples = [];
const t0 = performance.now();
while (performance.now() - t0 < (R.sampleMs ?? 4000)) {
  const m = me();
  samples.push({ t: Math.round(performance.now() - t0), ents: find().map(({ guid, inst }) => { const p = inst.root.position; return { guid, x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), visible: inst.root.visible, dist: m ? +Math.hypot(p.x - m.x, p.y - m.y).toFixed(1) : null }; }) });
  await sleep(R.everyMs ?? 1000);
}
let wire = null;
try { wire = JSON.parse(window.__sessionHandle.vehicleWireStats()); } catch (e) { wire = { err: String(e) }; }
const ents = find();
const first = samples.find((s) => s.ents.length)?.ents[0], last = [...samples].reverse().find((s) => s.ents.length)?.ents[0];
const out = {
  capableModule: typeof window.__vehicles === "object",
  vehiclesStatus: window.__vehicles ? window.__vehicles.status() : null,
  wire,
  entities: ents.map(({ guid, inst }) => ({ guid: "0x" + guid.toString(16), setup: inst.meta?.setupId ?? inst.meta?.modelId ?? null, visible: inst.root.visible })),
  moved: first && last ? +Math.hypot(last.x - first.x, last.y - first.y, last.z - first.z).toFixed(2) : null,
  samples,
};
out.summary = { capable: out.capableModule, standIns: out.entities.length, hbv1Received: wire?.received_total ?? null, moved: out.moved, firstDist: first?.dist ?? null };
return out;
