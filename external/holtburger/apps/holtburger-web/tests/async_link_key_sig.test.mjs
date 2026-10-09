// 2026-10-09 — ?asyncLinkKeySig (scene3d/async_link_guard.js): a version move
// whose material key fingerprint changed (a map appeared: texchan roughness/AO,
// luminous emissiveMap, a new patch) is deferred + compiled even when the churn
// trust or the rate cap would have let it draw. Baseline 1070 academy spawn:
// five cell-surface programs linked synchronously (449-716 ms) right after the
// interior hold released the HD re-seats (no-op moves → trust) and the texchan
// sidecars (key change) together.
//
// Run:
//   cd apps/holtburger-web/
//   node tests/async_link_key_sig.test.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const on = await import("../scene3d/async_link_guard.js");
const { materialKeySig, linkDecision, newLinkState, VERSION_NOOP_TRUST, VERSION_DEFER_MAX, SIG_DEFER_MAX } = on;

console.log("PART 1 — materialKeySig");
{
  const tex = () => ({ channel: 0, format: 1023 });
  const base = { type: "MeshStandardMaterial", map: tex(), normalMap: tex(), transparent: false, blending: 1, side: 2,
    customProgramCacheKey() { return "hb|d0|k1"; }, userData: {} };
  const s0 = materialKeySig(base);
  check("flag on by default (no location)", on.asyncLinkKeySigEnabled() === true);
  check("same material ⇒ same fingerprint", materialKeySig(base) === s0);
  check("an albedo re-seat (new texture object, same slot) keeps it", materialKeySig({ ...base, map: tex() }) === s0);
  check("side is excluded (three's two-pass toggles it inside the draw)", materialKeySig({ ...base, side: 1 }) === s0 && materialKeySig({ ...base, side: 0 }) === s0);
  check("an AO map appearing changes it", materialKeySig({ ...base, aoMap: tex() }) !== s0);
  check("a roughness map appearing changes it", materialKeySig({ ...base, roughnessMap: tex() }) !== s0);
  check("an emissive alias appearing changes it", materialKeySig({ ...base, emissiveMap: base.map }) !== s0);
  check("a map moving to another uv channel changes it", materialKeySig({ ...base, map: { channel: 1 } }) !== s0);
  check("a packed (RG) normal map changes it", materialKeySig({ ...base, normalMap: { channel: 0, format: 1030 } }) !== s0);
  check("an RGTC2 (BC5) normal map changes it", materialKeySig({ ...base, normalMap: { channel: 0, format: 36285 } }) !== s0);
  check("a key-neutral normal-map format swap (RGBA → BC7) keeps it", materialKeySig({ ...base, normalMap: { channel: 0, format: 36492 } }) === s0);
  check("alphaTest on/off changes it", materialKeySig({ ...base, alphaTest: 0.5 }) !== s0);
  check("alphaTest value within on does not", materialKeySig({ ...base, alphaTest: 0.5 }) === materialKeySig({ ...base, alphaTest: 0.8 }));
  check("transparent (opaque bit) changes it", materialKeySig({ ...base, transparent: true }) !== s0);
  check("the patch-set key changes it", materialKeySig({ ...base, customProgramCacheKey() { return "hb|d0|k0"; } }) !== s0);
  check("a define changes it", materialKeySig({ ...base, defines: { STANDARD: "" } }) !== materialKeySig({ ...base, defines: { STANDARD: "", X: 1 } }));
  check("a throwing customProgramCacheKey reads stable", materialKeySig({ ...base, customProgramCacheKey() { throw new Error("x"); } }) === materialKeySig({ ...base, customProgramCacheKey() { throw new Error("y"); } }));
  check("null material ⇒ empty", materialKeySig(null) === "");
  // readySigs compares fingerprints ACROSS materials: three keys on shaderIDs[type].
  check("another material type with the same maps + switches changes it",
    materialKeySig({ ...base, type: "MeshBasicMaterial" }) !== materialKeySig({ ...base, type: "MeshLambertMaterial" }) &&
    materialKeySig({ ...base, type: "MeshBasicMaterial" }) !== s0);
}

console.log("PART 2 — linkDecision with a fingerprint");
{
  const ready = { isReady: () => true };
  const tex = { channel: 0 };
  const plain = { version: 9, userData: {}, map: tex, transparent: false, blending: 1 };
  const withAo = { ...plain, aoMap: tex };
  const sigPlain = materialKeySig(plain);
  const st = (o) => Object.assign(newLinkState(), o);
  const drawn = { currentProgram: ready, __version: 1 };
  check("trusted churn, fingerprint unchanged ⇒ draw (no blink)",
    linkDecision(plain, drawn, 0, st({ verNoop: VERSION_NOOP_TRUST, sig: sigPlain })) === 0);
  check("trusted churn, an AO map appeared ⇒ defer + compile (3)",
    linkDecision(withAo, drawn, 0, st({ verNoop: VERSION_NOOP_TRUST, sig: sigPlain })) === 3);
  check("rate-capped burst, fingerprint unchanged ⇒ draw (cap kept)",
    linkDecision(plain, drawn, 0, st({ verDefers: VERSION_DEFER_MAX, verDeferAt: performance.now(), sig: sigPlain })) === 0);
  check("rate-capped burst, an AO map appeared ⇒ defer + compile (3)",
    linkDecision(withAo, drawn, 0, st({ verDefers: VERSION_DEFER_MAX, verDeferAt: performance.now(), sig: sigPlain })) === 3);
  check("never drawn + capped, an AO map appeared ⇒ defer + compile (3)",
    linkDecision(withAo, { currentProgram: ready }, 0, st({ ver: 3, verDefers: VERSION_DEFER_MAX, verDeferAt: performance.now(), sig: sigPlain })) === 3);
  check("the version we compiled draws even if the fingerprint cache is stale",
    linkDecision(withAo, drawn, 0, st({ ver: 9, sig: sigPlain })) === 0);
  check("unknown fingerprint (sig null) ⇒ today's behaviour (trusted draw)",
    linkDecision(withAo, drawn, 0, st({ verNoop: VERSION_NOOP_TRUST })) === 0);
  check(`fingerprint burst cap: after ${SIG_DEFER_MAX} in a window the old rules apply`,
    linkDecision(withAo, drawn, 0, st({ verNoop: VERSION_NOOP_TRUST, sig: sigPlain, sigDefers: SIG_DEFER_MAX, sigDeferAt: performance.now() })) === 0);
  check("…and the cap is a rate (old bursts do not count)",
    linkDecision(withAo, drawn, 0, st({ verNoop: VERSION_NOOP_TRUST, sig: sigPlain, sigDefers: SIG_DEFER_MAX, sigDeferAt: performance.now() - 60000 })) === 3);
  const s = st({ verNoop: VERSION_NOOP_TRUST, sig: sigPlain });
  linkDecision(withAo, drawn, 0, s);
  check("the decision caches the fingerprint it computed (st.curSig)", s.curSig === materialKeySig(withAo));
}

// A three-like fake: per-material `programs` keyed by fingerprint+combo; a draw
// whose key has no READY program is a synchronous link (counted).
function makeRenderer() {
  const props = new WeakMap();
  const cache = new Map(); // three's renderer-wide program cache (by key)
  const r = {
    syncLinks: 0, draws: 0, compiles: 0, cache,
    properties: { get(m) { let p = props.get(m); if (!p) { p = {}; props.set(m, p); } return p; } },
    _prog(mp, key, ready) {
      if (!mp.programs) mp.programs = new Map();
      let p = mp.programs.get(key) || cache.get(key);
      if (!p) {
        let polls = 0;
        p = ready ? { isReady: () => true } : { isReady: () => ++polls > 1 };
        cache.set(key, p);
      }
      mp.programs.set(key, p);
      mp.currentProgram = p;
      mp.batching = false; mp.instancing = false; mp.skinning = false;
      return p;
    },
    renderBufferDirect(camera, sc, g, material) {
      r.draws++;
      const mp = r.properties.get(material);
      if (mp.__version !== material.version) {
        const key = on.materialKeySig(material) + "#" + material.side;
        const had = mp.programs?.get(key) || cache.get(key);
        if (!had || had.isReady() !== true) r.syncLinks++;
        r._prog(mp, key, true);
        mp.__version = material.version;
      }
    },
    compile(root) {
      r.compiles++;
      const set = new Set();
      root.traverse((o) => {
        const m = o.material; set.add(m);
        // three prepareMaterial: a transparent DoubleSide material compiles its Back and Front programs.
        const sides = m.transparent === true && m.side === 2 && m.forceSinglePass !== true ? [1, 0] : [m.side];
        for (const sd of sides) r._prog(r.properties.get(m), on.materialKeySig(m) + "#" + sd, false);
      });
      return set;
    },
  };
  return r;
}

async function scenario(mod, label) {
  const renderer = makeRenderer();
  const scene = { isScene: true };
  globalThis.window = {};
  const api = mod.installAsyncLinkGuard(renderer, () => scene);
  const tex = () => ({ channel: 0 });
  const mat = { type: "MeshStandardMaterial", version: 0, userData: {}, map: tex(), transparent: false, blending: 1,
    customProgramCacheKey() { return "hb|k1"; } };
  const obj = { name: "cell-surface", material: mat };
  const frame = async (n = 1) => { for (let i = 0; i < n; i++) { renderer.renderBufferDirect({}, scene, {}, mat, obj, null); await sleep(25); } };
  // The cells' prewarm compiled it (program ready, never drawn).
  renderer._prog(renderer.properties.get(mat), mod.materialKeySig(mat) + "#" + mat.side, true);
  await frame(3); // first draw: deferred once, compiled (cache hit), drawn
  // Two HD albedo re-seats, seconds apart (same key): no-op compiles → trusted.
  for (let i = 0; i < 2; i++) { mat.map = tex(); mat.version++; await frame(3); await sleep(VERSION_DEFER_WINDOW_MS_PAD); }
  const st = api.stateOf(mat);
  const trusted = st.verNoop >= mod.VERSION_NOOP_TRUST;
  const links0 = renderer.syncLinks;
  // The texchan sidecar lands: roughnessMap + aoMap appear (a real key change).
  mat.roughnessMap = tex(); mat.aoMap = tex(); mat.version++;
  await frame(4);
  const res = { trusted, syncLinks: renderer.syncLinks - links0, stats: { ...api.stats } };
  api.uninstall();
  delete globalThis.window;
  console.log(`    ${label}: ${JSON.stringify(res)}`);
  return res;
}
const VERSION_DEFER_WINDOW_MS_PAD = 30;

console.log("PART 3 — the academy sequence: re-seats (trust) then texchan (key change)");
{
  const a = await scenario(on, "keySig on ");
  check("the no-op re-seats taught the churn trust (precondition)", a.trusted === true);
  check("ON: the key-changing re-seat is deferred, not linked in the draw", a.syncLinks === 0 && a.stats.sigDeferred >= 1, JSON.stringify(a));
  check("ON: no trust revocation needed", a.stats.trustRevoked === 0);
  // Flag off = today: a separate module instance read with ?asyncLinkKeySig=off.
  globalThis.location = { search: "?asyncLinkKeySig=off" };
  const off = await import("../scene3d/async_link_guard.js?asyncLinkKeySig=off");
  delete globalThis.location;
  check("off spelling read", off.asyncLinkKeySigEnabled() === false);
  for (const sp of ["0", "false", "no", "OFF"]) {
    globalThis.location = { search: `?asyncLinkKeySig=${sp}` };
    const m = await import(`../scene3d/async_link_guard.js?asyncLinkKeySig=${sp}`);
    delete globalThis.location;
    check(`asyncLinkKeySig=${sp} ⇒ off`, m.asyncLinkKeySigEnabled() === false);
  }
  const b = await scenario(off, "keySig off");
  check("OFF (today): the trusted key change links synchronously in the draw", b.syncLinks === 1 && b.stats.trustRevoked === 1 && b.stats.sigDeferred === 0, JSON.stringify(b));
}

console.log("PART 4 — churn with an unchanged fingerprint never blinks");
{
  const renderer = makeRenderer();
  const scene = { isScene: true };
  globalThis.window = {};
  const api = on.installAsyncLinkGuard(renderer, () => scene);
  const mat = { type: "MeshStandardMaterial", version: 0, userData: {}, map: { channel: 0 }, transparent: true, blending: 1, side: 2 };
  const obj = { name: "two-pass", material: mat };
  const frame = async () => { for (const side of [1, 0]) { mat.side = side; mat.version++; renderer.renderBufferDirect({}, scene, {}, mat, obj, null); } mat.side = 2; await sleep(25); };
  for (let i = 0; i < 4; i++) await frame();
  await sleep(2050);
  const d0 = api.stats.deferred, n0 = renderer.draws;
  for (let i = 0; i < 8; i++) await frame();
  check("two-pass churn draws both passes every frame once learned", renderer.draws - n0 === 16 && api.stats.deferred === d0, `draws=${renderer.draws - n0} deferred+=${api.stats.deferred - d0}`);
  check("…and the fingerprint never deferred it", api.stats.sigDeferred === 0);
  api.uninstall();
  delete globalThis.window;
}

console.log("PART 5 — a class's later surfaces: a known-ready fingerprint draws at once (no blink)");
{
  const renderer = makeRenderer();
  const scene = { isScene: true };
  globalThis.window = {};
  const api = on.installAsyncLinkGuard(renderer, () => scene);
  const tex = () => ({ channel: 0 });
  const mk = (n, side = 2) => ({ type: "MeshStandardMaterial", version: 0, userData: {}, map: tex(), transparent: false, blending: 1, name: n, side,
    customProgramCacheKey() { return "hb|k1"; } });
  const A = mk("surf-A"), B = mk("surf-B"), C = mk("surf-C-front", 0);
  const objA = { name: "a", material: A }, objB = { name: "b", material: B }, objC = { name: "c", material: C };
  for (const m of [A, B, C]) renderer._prog(renderer.properties.get(m), on.materialKeySig(m) + "#" + m.side, true); // prewarmed
  const frame = async (n = 1) => { for (let i = 0; i < n; i++) { for (const [m, o] of [[A, objA], [B, objB], [C, objC]]) renderer.renderBufferDirect({}, scene, {}, m, o, null); await sleep(25); } };
  await frame(3);
  // A's texchan lands first: deferred + compiled off-frame (the class's first).
  A.roughnessMap = tex(); A.aoMap = tex(); A.version++;
  const drawsA0 = renderer.draws;
  await frame(4);
  check("first surface of the class: deferred, then drawn, no sync link", api.stats.sigDeferred === 1 && renderer.syncLinks === 0, JSON.stringify(api.stats));
  // B's texchan lands: same fingerprint → a program-cache hit → draws THIS frame.
  B.roughnessMap = tex(); B.aoMap = tex(); B.version++;
  const d0 = api.stats.deferred, n0 = renderer.draws;
  renderer.renderBufferDirect({}, scene, {}, B, objB, null);
  check("later surface of the class: drawn in the same frame (no blink)", renderer.draws === n0 + 1 && api.stats.deferred === d0 && api.stats.sigKnown === 1, JSON.stringify(api.stats));
  check("…and still no synchronous link", renderer.syncLinks === 0);
  // C: same maps but FrontSide — a different program; the class's DoubleSide hit must not count.
  C.roughnessMap = tex(); C.aoMap = tex(); C.version++;
  const d1 = api.stats.deferred, n1 = renderer.draws;
  renderer.renderBufferDirect({}, scene, {}, C, objC, null);
  check("a FrontSide surface with the same maps is NOT a known hit (deferred, no sync link)", renderer.draws === n1 && api.stats.deferred === d1 + 1 && renderer.syncLinks === 0, JSON.stringify(api.stats));
  api.uninstall();
  delete globalThis.window;
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
