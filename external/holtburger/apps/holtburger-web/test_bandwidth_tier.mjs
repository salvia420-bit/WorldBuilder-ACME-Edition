// test_bandwidth_tier.mjs — scene3d/bandwidth_tier.js (`?bandwidth`).
//
// What must hold:
//   - flag grammar: low/slow/small ⇒ low, high/fast/full ⇒ high, auto/"" ⇒ auto,
//     garbage ⇒ ignored (falls through to the saved setting / detection);
//   - precedence: URL > saved setting > saveData > this page's measurement >
//     the previous visit's measurement > NetInfo downlink > "high";
//   - the throughput meter counts only bytes that crossed the network (cache,
//     SW and 304 revalidations excluded) and divides by the UNION of transfer
//     intervals, so N parallel downloads read as the link, not as 1/N of it;
//   - too little evidence ⇒ no measurement (null), never a guess;
//   - the two measured shapes from the 1070 runs classify correctly: the
//     666 kbps shaped boot (~81 KB/s) is low, the tailnet boot is high.
//
// Run: cd apps/holtburger-web && node test_bandwidth_tier.mjs
import {
  LOW_BANDWIDTH_BYTES_PER_SEC,
  normalizeBandwidthValue,
  bandwidthPreference,
  aggregateThroughput,
  decideBandwidthTier,
  setBandwidthSetting,
  bandwidthSetting,
  BANDWIDTH_SETTING_KEY,
  bandwidthTier,
  lowBandwidth,
  groundDrawn,
  holdForGround,
  _resetBandwidthTierForTest,
} from "./scene3d/bandwidth_tier.js";

let passed = 0, failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${ok || !detail ? "" : " — " + detail}`);
  ok ? passed++ : failed++;
}

// minimal localStorage + window stand-ins
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
function setSearch(s) {
  globalThis.window = globalThis.window || {};
  globalThis.window.location = { search: s, origin: "http://game.test" };
}

console.log("\nPART 1 — spelling");
{
  for (const v of ["low", "LOW", "slow", "small", " low "]) check(`'${v}' ⇒ low`, normalizeBandwidthValue(v) === "low");
  for (const v of ["high", "fast", "full", "High"]) check(`'${v}' ⇒ high`, normalizeBandwidthValue(v) === "high");
  for (const v of ["auto", ""]) check(`'${v}' ⇒ auto`, normalizeBandwidthValue(v) === "auto");
  check("garbage ⇒ null", normalizeBandwidthValue("banana") === null);
  check("absent ⇒ null", normalizeBandwidthValue(null) === null);
}

console.log("\nPART 2 — preference precedence (URL > setting > default)");
{
  store.clear();
  setSearch("");
  check("nothing set ⇒ auto/default", JSON.stringify(bandwidthPreference()) === '{"pref":"auto","source":"default"}');
  setBandwidthSetting("low");
  check("setting persisted under its key", store.get(BANDWIDTH_SETTING_KEY) === "low" && bandwidthSetting() === "low");
  check("saved setting ⇒ low/setting", bandwidthPreference().pref === "low" && bandwidthPreference().source === "setting");
  setSearch("?bandwidth=high");
  check("URL beats the saved setting", bandwidthPreference().pref === "high" && bandwidthPreference().source === "url");
  setSearch("?bandwidth=auto");
  check("?bandwidth=auto falls through to the saved setting", bandwidthPreference().pref === "low");
  setSearch("?bandwidth=banana");
  check("garbage URL value is ignored", bandwidthPreference().pref === "low");
  setBandwidthSetting("auto");
  setSearch("");
  check("setting back to auto ⇒ auto", bandwidthPreference().pref === "auto" && bandwidthSetting() === "auto");
  setBandwidthSetting("nonsense");
  check("garbage setting stored as auto", store.get(BANDWIDTH_SETTING_KEY) === "auto");
}

console.log("\nPART 3 — aggregate throughput meter");
{
  const net = (s, t, bytes) => ({ responseStart: s, responseEnd: t, transferSize: bytes, encodedBodySize: bytes - 300 });
  // One 2 MB download over 1 s ⇒ ~2 MB/s.
  let m = aggregateThroughput([net(0, 1000, 2_000_000)]);
  check("single transfer rate", m && Math.abs(m.bps - 2_000_000) < 1, JSON.stringify(m));
  // Six parallel 1 MB downloads sharing a 6 MB/s link over the same 1 s
  // window read as 6 MB/s — NOT 1 MB/s.
  m = aggregateThroughput(Array.from({ length: 6 }, () => net(0, 1000, 1_000_000)));
  check("parallel transfers measure the link, not one share", m && Math.abs(m.bps - 6_000_000) < 1, JSON.stringify(m));
  // Gaps are excluded: two 1 MB transfers 10 s apart, 1 s each ⇒ 1 MB/s.
  m = aggregateThroughput([net(0, 1000, 1_000_000), net(11_000, 12_000, 1_000_000)]);
  check("idle gaps do not dilute the rate", m && Math.abs(m.bps - 1_000_000) < 1, JSON.stringify(m));
  // Cache hits / SW hits / 304s are excluded.
  m = aggregateThroughput([
    { responseStart: 0, responseEnd: 1000, transferSize: 0, encodedBodySize: 5_000_000 },     // cache
    { responseStart: 0, responseEnd: 1000, transferSize: 310, encodedBodySize: 5_000_000 },   // 304
    net(0, 1000, 1_000_000),
  ]);
  check("cache/304 entries excluded", m && m.bytes === 1_000_000, JSON.stringify(m));
  check("too few bytes ⇒ null", aggregateThroughput([net(0, 1000, 100_000)]) === null);
  check("too short ⇒ null", aggregateThroughput([net(0, 50, 2_000_000)]) === null);
  check("empty ⇒ null", aggregateThroughput([]) === null && aggregateThroughput(undefined) === null);
  // The shaped 1070 boot: ~4.5 MB of module graph + wasm over ~55 s busy.
  m = aggregateThroughput([net(0, 30_000, 2_500_000), net(30_000, 55_000, 2_100_000)]);
  check("666 kbps shaped boot classifies LOW", m && m.bps < LOW_BANDWIDTH_BYTES_PER_SEC, JSON.stringify(m));
  // The tailnet boot: 5.6 MB in ~2.8 s busy.
  m = aggregateThroughput([net(0, 2000, 3_500_000), net(1500, 2800, 2_100_000)]);
  check("tailnet boot classifies HIGH", m && m.bps >= LOW_BANDWIDTH_BYTES_PER_SEC, JSON.stringify(m));
}

console.log("\nPART 4 — decision precedence");
{
  const pref = (p, s = "default") => ({ pref: p, source: s });
  const slow = { bps: 80_000 }, fast = { bps: 5_000_000 };
  check("explicit low wins over a fast measurement",
    decideBandwidthTier({ preference: pref("low", "url"), measured: fast }).tier === "low");
  check("explicit high wins over saveData",
    decideBandwidthTier({ preference: pref("high", "setting"), connection: { saveData: true } }).tier === "high");
  check("saveData ⇒ low", decideBandwidthTier({ preference: pref("auto"), connection: { saveData: true }, measured: fast }).source === "save-data");
  check("measured slow ⇒ low/measured", JSON.stringify(decideBandwidthTier({ preference: pref("auto"), measured: slow })) === '{"tier":"low","source":"measured","bps":80000}');
  check("measured fast ⇒ high", decideBandwidthTier({ preference: pref("auto"), measured: fast }).tier === "high");
  check("this page's measurement beats the saved one",
    decideBandwidthTier({ preference: pref("auto"), measured: fast, saved: slow }).tier === "high");
  check("saved measurement used when nothing was measured (warm boot)",
    decideBandwidthTier({ preference: pref("auto"), saved: slow }).source === "measured-earlier");
  check("NetInfo downlink fallback",
    decideBandwidthTier({ preference: pref("auto"), connection: { downlink: 0.7 } }).tier === "low"
    && decideBandwidthTier({ preference: pref("auto"), connection: { downlink: 10 } }).tier === "high");
  check("nothing at all ⇒ high/default", JSON.stringify(decideBandwidthTier({ preference: pref("auto") })) === '{"tier":"high","source":"default","bps":null}');
}

console.log("\nPART 5 — memoised production entry");
{
  store.clear();
  setSearch("?bandwidth=low");
  globalThis.performance = globalThis.performance || {};
  _resetBandwidthTierForTest();
  check("URL low resolves low", bandwidthTier().tier === "low" && lowBandwidth() === true);
  setSearch("?bandwidth=high");
  check("memoised: a later search change does not flip a live session", lowBandwidth() === true);
  _resetBandwidthTierForTest({ tier: "high" });
  check("test hook can force a tier", lowBandwidth() === false);
  _resetBandwidthTierForTest();
}

// 2026-10-09 "ground first": optional downloads on a LOW session wait for the
// first terrain mesh (terrain.js latches window.__groundDrawnAt); any other
// session never waits.
{
  delete globalThis.window.__groundDrawnAt;
  _resetBandwidthTierForTest({ tier: "high" });
  check("not low: holdForGround resolves at once", (await holdForGround()) === "not-low");
  _resetBandwidthTierForTest({ tier: "low" });
  check("groundDrawn is false before the latch", groundDrawn() === false);
  let settled = null;
  const p = holdForGround({ pollMs: 10 }).then((v) => { settled = v; return v; });
  await new Promise((r) => setTimeout(r, 60));
  check("low: still holding while no terrain is drawn", settled === null);
  globalThis.window.__groundDrawnAt = 4321;
  check("low: released by the ground latch", (await p) === "ground" && groundDrawn() === true);
  delete globalThis.window.__groundDrawnAt;
  let t = 0;
  check("low: the ceiling releases a session that never draws terrain (sealed dungeon)",
    (await holdForGround({ maxMs: 100, pollMs: 5, now: () => (t += 50) })) === "timeout");
  _resetBandwidthTierForTest();
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
