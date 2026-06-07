// Batch 4 — MaterialCache paletted LRU cap + dispose() extension test.
//
// Finding #22 (+ anim-frames fold-in): `installPaletted` grew
// `palettedMaterials` / `palettedTextures` unbounded (the one live cache
// leak), and `dispose()` only freed textures/materials/normal/height —
// leaking frontSide/wire/didMaterials/paletted/anim-frame GPU resources
// on page teardown.
//
// Batch 4 adds:
//   - PALETTED_CACHE_CAP (256) insertion-order LRU eviction in
//     installPaletted: disposes the oldest material AND its paired owned
//     texture together; never evicts the entry just installed this call;
//     a same-frame-baked material stays retrievable same frame.
//   - dispose() extension: frontSide/wire/wireFill/didMaterials(wire+fill)/
//     paletted(mat+tex)/anim-frame DataTextures all freed; fail-soft;
//     idempotent (clears every map). The LRU path NEVER calls dispose().
//     anim-frame entry.mat is the SAME object as this.materials.get(d) so
//     it must NOT be double-disposed — only the frame textures are.
//
// Mirrors the loadModule/stripExports harness in
// test_visfid_c4_program_cache_key.mjs.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/path/to/three.module.js node test_materials_paletted_lru.mjs

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { existsSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
    else passed += 1;
}

function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        return process.env.THREE_PATH;
    }
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("paletted-LRU ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/path/to/three.module.js node test_materials_paletted_lru.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("Batch 4 — MaterialCache paletted LRU cap + dispose() (#22, anim-frames)");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Load a module source, strip the bare `import * as THREE` line + the
// adapter import, and de-`export` so it runs inside a `new Function`.
function loadModule(relPath) {
    const full = resolvePath(__dirname, relPath);
    let src = readFileSync(full, "utf8");
    src = src.replace(
        /^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m,
        ""
    );
    return src;
}

const matsSrc = loadModule("scene3d/materials.js");
const matsPatched = matsSrc
    .replace(/^\s*import\s+\{[^}]+\}\s+from\s+["']\.\/adapter\.js["'];?\s*$/m, "")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ")
    .replace(/^\s*export\s+const\s+/gm, "const ");
const matsFactory = new Function(
    "THREE",
    matsPatched + "\n; return { MaterialCache };"
);
const { MaterialCache } = matsFactory(THREE);

check("MaterialCache class loaded from materials.js", typeof MaterialCache === "function");

// A lightweight spy material/texture: just a dispose counter. installPaletted
// and dispose() only ever call `.dispose?.()` and read `.userData`, so a POJO
// with a dispose() is sufficient (and avoids GPU-context churn).
function spy(tag) {
    return {
        __tag: tag,
        disposed: 0,
        userData: {},
        dispose() { this.disposed += 1; },
    };
}

// Read the live cap baked into the module so the test tracks the constant.
// Construct a cache, fill it past cap, infer cap from the survivor count.
function freshCache() {
    return new MaterialCache({});
}

// ----------------------------------------------------------------------
// LRU CAP: install CAP + 50 distinct keys, assert eviction of the oldest.
// ----------------------------------------------------------------------
{
    const cache = freshCache();
    // Determine the cap empirically: install a big batch, the survivor
    // count IS the cap. (Avoids hard-coding 256 in the test in case the
    // constant is later tuned — but we ALSO assert it's the generous 256.)
    const OVER = 50;
    const mats = [];
    const texs = [];
    // First, find cap by overflowing generously.
    const probe = freshCache();
    const PROBE_N = 1000;
    for (let i = 0; i < PROBE_N; i += 1) {
        probe.installPaletted(i, 0, null, spy("pm" + i), spy("pt" + i));
    }
    const cap = probe.palettedMaterials.size;
    check("cap is the generous 256 (same-frame entry not evicted)", cap === 256, `cap=${cap}`);
    check("palettedTextures size tracks materials under cap", probe.palettedTextures.size === cap, `tex=${probe.palettedTextures.size}`);

    const COUNT = cap + OVER;
    for (let i = 0; i < COUNT; i += 1) {
        const m = spy("m" + i);
        const t = spy("t" + i);
        mats.push(m);
        texs.push(t);
        cache.installPaletted(i, 0, null, m, t);
    }

    check(
        "palettedMaterials.size <= cap after overflow",
        cache.palettedMaterials.size <= cap && cache.palettedMaterials.size === cap,
        `size=${cache.palettedMaterials.size}, cap=${cap}`
    );
    check(
        "palettedTextures.size <= cap after overflow",
        cache.palettedTextures.size === cap,
        `size=${cache.palettedTextures.size}`
    );

    // Exactly (COUNT - cap) oldest materials AND their textures disposed.
    let matDisposed = 0, texDisposed = 0;
    let oldestUndisposed = -1, recentDisposed = -1;
    for (let i = 0; i < COUNT; i += 1) {
        if (mats[i].disposed === 1) matDisposed += 1;
        else if (oldestUndisposed === -1) oldestUndisposed = i;
        if (texs[i].disposed === 1) texDisposed += 1;
    }
    // The recent half must all survive.
    for (let i = COUNT - 1; i >= 0; i -= 1) {
        if (mats[i].disposed === 1) { recentDisposed = i; break; }
    }
    check(
        "exactly (count-cap) oldest materials disposed",
        matDisposed === OVER,
        `disposed=${matDisposed}, expected=${OVER}`
    );
    check(
        "each evicted material's PAIRED texture disposed together",
        texDisposed === OVER,
        `texDisposed=${texDisposed}, expected=${OVER}`
    );
    check(
        "eviction is oldest-by-insertion (the first OVER keys went, the most-recent survive)",
        recentDisposed === OVER - 1 && oldestUndisposed === OVER,
        `lastDisposedIdx=${recentDisposed}, firstSurvivorIdx=${oldestUndisposed}`
    );
    // Most-recent key still retrievable.
    check(
        "most-recently installed key still present",
        cache.getCachedPaletted(COUNT - 1, 0, null) === mats[COUNT - 1],
        `present=${cache.getCachedPaletted(COUNT - 1, 0, null) === mats[COUNT - 1]}`
    );
    // No material disposed twice.
    check(
        "no material/texture disposed more than once during LRU",
        mats.every((m) => m.disposed <= 1) && texs.every((t) => t.disposed <= 1),
        ""
    );
}

// ----------------------------------------------------------------------
// SAME-FRAME RETRIEVABILITY: a paletted material installed this frame
// stays retrievable in the same frame even when the cache is at cap.
// ----------------------------------------------------------------------
{
    const cache = freshCache();
    // fill exactly to cap
    let cap = 256;
    for (let i = 0; i < cap; i += 1) cache.installPaletted(i, 0, null, spy("a" + i), spy("b" + i));
    check("filled to cap exactly", cache.palettedMaterials.size === cap, `size=${cache.palettedMaterials.size}`);
    // install one MORE (the (cap)th distinct key) — should evict oldest, keep new.
    const fresh = spy("fresh");
    cache.installPaletted(99999, 0, null, fresh, spy("freshTex"));
    check(
        "freshly-installed (cap-overflowing) entry is retrievable same frame",
        cache.getCachedPaletted(99999, 0, null) === fresh && fresh.disposed === 0,
        `present=${cache.getCachedPaletted(99999, 0, null) === fresh}, disposed=${fresh.disposed}`
    );
}

// ----------------------------------------------------------------------
// RE-INSERTING AN EXISTING KEY does NOT evict a live recent entry.
// (Re-set keeps original Map position; oldestKey===key guard protects it.)
// ----------------------------------------------------------------------
{
    const cache = freshCache();
    const cap = 256;
    const mats = [];
    for (let i = 0; i < cap; i += 1) {
        const m = spy("k" + i);
        mats.push(m);
        cache.installPaletted(i, 0, null, m, spy("kt" + i));
    }
    // Re-install the OLDEST key (i=0) with a new material — Map keeps key 0
    // at the head, so it is the oldest; the guard must NOT evict it because
    // it is the key we just installed this call. Size stays at cap.
    const sizeBefore = cache.palettedMaterials.size;
    const reMat = spy("re0");
    cache.installPaletted(0, 0, null, reMat, spy("re0tex"));
    check(
        "re-inserting existing key keeps size at cap (no eviction needed)",
        cache.palettedMaterials.size === sizeBefore,
        `before=${sizeBefore}, after=${cache.palettedMaterials.size}`
    );
    check(
        "re-inserted key NOT self-evicted (guard oldestKey===key)",
        cache.getCachedPaletted(0, 0, null) === reMat && reMat.disposed === 0,
        `present=${cache.getCachedPaletted(0, 0, null) === reMat}, disposed=${reMat.disposed}`
    );
    check(
        "no other recent live entry evicted by a same-key re-insert",
        mats[cap - 1].disposed === 0 && cache.getCachedPaletted(cap - 1, 0, null) === mats[cap - 1],
        `recentDisposed=${mats[cap - 1].disposed}`
    );
}

// ----------------------------------------------------------------------
// LRU NEVER calls dispose() (the page-teardown method). Spy the instance
// method to prove eviction took the per-resource .dispose() path only.
// ----------------------------------------------------------------------
{
    const cache = freshCache();
    let instanceDisposeCalls = 0;
    const realDispose = cache.dispose.bind(cache);
    cache.dispose = function () { instanceDisposeCalls += 1; return realDispose(); };
    for (let i = 0; i < 256 + 5; i += 1) {
        cache.installPaletted(i, 0, null, spy("x" + i), spy("xt" + i));
    }
    check(
        "LRU eviction NEVER calls MaterialCache.dispose()",
        instanceDisposeCalls === 0,
        `disposeCalls=${instanceDisposeCalls}`
    );
}

// ----------------------------------------------------------------------
// installPaletted with NO texture: material-only eviction still works.
// ----------------------------------------------------------------------
{
    const cache = freshCache();
    const mats = [];
    for (let i = 0; i < 256 + 3; i += 1) {
        const m = spy("n" + i);
        mats.push(m);
        cache.installPaletted(i, 0, null, m, null); // no texture
    }
    check(
        "texture-less paletted entries cap + evict cleanly (no throw)",
        cache.palettedMaterials.size === 256 && mats[0].disposed === 1 && mats[2].disposed === 1,
        `size=${cache.palettedMaterials.size}, oldest0=${mats[0].disposed}, oldest2=${mats[2].disposed}`
    );
}

// ----------------------------------------------------------------------
// dispose(): populate EVERY map with spies, call dispose() TWICE.
//  - all resources disposed exactly once (idempotent: 2nd call no-ops)
//  - anim-frame textures disposed; entry.mat NOT double-disposed
//  - no throw even when a spy's dispose() throws (fail-soft)
// ----------------------------------------------------------------------
{
    const cache = freshCache();

    // Real-ish textures/materials maps. anim-frame entry.mat is shared with
    // this.materials (mirrors the build-path guard this.materials.get(d)===mat).
    const sharedMat = spy("animMat");
    cache.materials.set(7, sharedMat);

    const texA = spy("texA");
    cache.textures.set(1, texA);
    const normA = spy("normA");
    cache.normalTextures.set(1, normA);
    const heightA = spy("heightA");
    cache.heightTextures.set(1, heightA);

    const front = spy("front");
    cache.frontSideMaterials.set(1, front);

    const wire = spy("wire");
    cache.wireframeBuckets.set(0, wire);
    const wfill = spy("wfill");
    cache.wireframeFillBuckets.set(0, wfill);

    const didWire = spy("didWire");
    const didFill = spy("didFill");
    cache.didMaterials.set(5, { wire: didWire, fill: didFill });

    const pmat = spy("pmat");
    const ptex = spy("ptex");
    cache.installPaletted(123, 0, null, pmat, ptex);

    // anim-frame entry — frames are separate DataTexture-likes; mat is shared.
    const frame0 = spy("frame0");
    const frame1 = spy("frame1");
    cache._animatedMaterials.set(7, { mat: sharedMat, frames: [frame0, frame1], idx: 0, accumS: 0 });

    // Inject one throwing dispose to prove fail-soft.
    const thrower = { disposed: 0, userData: {}, dispose() { this.disposed += 1; throw new Error("boom"); } };
    cache.textures.set(99, thrower);

    let threw = false;
    try {
        cache.dispose();
    } catch (_) {
        threw = true;
    }
    check("dispose() does not throw even with a throwing resource (fail-soft)", !threw);

    check("base textures disposed", texA.disposed === 1 && normA.disposed === 1 && heightA.disposed === 1,
        `texA=${texA.disposed}, normA=${normA.disposed}, heightA=${heightA.disposed}`);
    check("throwing resource still disposed once (loop continued)", thrower.disposed === 1, `d=${thrower.disposed}`);
    check("frontSide material disposed", front.disposed === 1, `d=${front.disposed}`);
    check("wireframe + fill bucket materials disposed", wire.disposed === 1 && wfill.disposed === 1,
        `wire=${wire.disposed}, fill=${wfill.disposed}`);
    check("didMaterials wire + fill disposed", didWire.disposed === 1 && didFill.disposed === 1,
        `wire=${didWire.disposed}, fill=${didFill.disposed}`);
    check("paletted material + paired texture disposed", pmat.disposed === 1 && ptex.disposed === 1,
        `mat=${pmat.disposed}, tex=${ptex.disposed}`);
    check("anim-frame textures disposed", frame0.disposed === 1 && frame1.disposed === 1,
        `f0=${frame0.disposed}, f1=${frame1.disposed}`);
    check(
        "anim-frame entry.mat NOT double-disposed (shared with this.materials → disposed once total)",
        sharedMat.disposed === 1,
        `sharedMat.disposed=${sharedMat.disposed}`
    );

    // Maps cleared → idempotent.
    check("all maps cleared after dispose()",
        cache.palettedMaterials.size === 0 && cache.palettedTextures.size === 0 &&
        cache.materials.size === 0 && cache.textures.size === 0 &&
        cache.frontSideMaterials.size === 0 && cache.wireframeBuckets.size === 0 &&
        cache.wireframeFillBuckets.size === 0 && cache.didMaterials.size === 0 &&
        cache._animatedMaterials.size === 0,
        "");

    // Second dispose(): no resource disposed again, no throw.
    let threw2 = false;
    try { cache.dispose(); } catch (_) { threw2 = true; }
    check("second dispose() is idempotent (no throw, no re-dispose)",
        !threw2 && texA.disposed === 1 && pmat.disposed === 1 && frame0.disposed === 1 && sharedMat.disposed === 1,
        `texA=${texA.disposed}, pmat=${pmat.disposed}, frame0=${frame0.disposed}, sharedMat=${sharedMat.disposed}`);
}

console.log("=========================");
if (failed === 0) {
    console.log(`PASS: ${passed}/${passed} paletted-LRU + dispose() checks green.`);
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} of ${passed + failed} checks failed.`);
    process.exit(1);
}
