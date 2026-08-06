// 2026-08-05 — the texture WeakRef census (`scene3d/texture_census.js`).
//
// The census exists to answer ONE question the GL counters cannot: of the
// textures this page has ever uploaded, how many are still ALIVE in the heap
// while nothing in the scene points at them. Every part of that sentence is a
// place to get it wrong, so:
//
//   PART 1 — the flag is a strict `=on` opt-in. A tracer that retains a record
//            per texture must never read ON by accident.
//   PART 2 — byte accounting dedupes by underlying ArrayBuffer. Views sharing
//            one buffer are THE over-count that produced the retracted
//            "textures are ~1.2 GB CPU-side" figure.
//   PART 3 — install hooks `Texture.prototype`, traces on the `dispose`
//            listener three attaches at first upload, and does not disturb
//            three's own listener or dispose behaviour.
//   PART 4 — orphan classification: alive + scene-reachable is NOT a leak;
//            alive + unreachable is. Disposed-but-alive is its own row (GPU
//            released, CPU bytes not).
//   PART 5 — owner probes attribute orphans to the cache holding them, and an
//            orphan no probe claims lands in `unknown` rather than vanishing.
//   PART 6 — static: the shipped renderer installs the tracer at import time
//            and exposes `__diag.textures`.
//
// WHAT THIS SUITE CANNOT SEE. The textures here are a stub hierarchy, and three
// is loaded from a CDN (index.html:969) with no local copy to import. A
// stub-only suite passed while the byte accounting DOUBLE-CHARGED every
// DataTexture on the page, because in real three r184 `texture.image` and
// `texture.source.data` are the SAME object and the walk visited both. That was
// caught by a companion smoke that imports the real r184 build
// (`real-three-smoke.mjs`, kept with the session scratchpad since the bundle is
// not vendored). If you change `textureCpuBytes`, re-run that against real three
// — this file will not tell you.
//
// Run:
//   cd apps/holtburger-web/
//   node test_texture_census.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import {
  texCensusEnabled,
  installTextureCensus,
  textureCensus,
  textureCpuBytes,
  registerTextureOwnerProbe,
  __resetTextureCensusForTests,
} from "./scene3d/texture_census.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

// ---------------------------------------------------------------------------
// A three-shaped stand-in: `Texture` extends an `EventDispatcher` exactly as
// three does, so a prototype hook on Texture is exercised the same way.
// ---------------------------------------------------------------------------
let nextId = 1;
class FakeDispatcher {
  addEventListener(type, fn) {
    (this._l ??= {});
    (this._l[type] ??= []).push(fn);
  }
}
class FakeTexture extends FakeDispatcher {
  constructor(data, w = 4, h = 4) {
    super();
    this.isTexture = true;
    this.isDataTexture = true;
    this.id = nextId++;
    this.image = { data, width: w, height: h };
    this.disposedCalled = 0;
  }
  dispose() { this.disposedCalled++; }
}
const THREE_STUB = { Texture: FakeTexture };
/** What three does at first upload (three.module.js:11711). */
const upload = (t) => t.addEventListener("dispose", () => {});

console.log("PART 1 — strict opt-in");
{
  check("?texCensus=on arms it", texCensusEnabled("?texCensus=on") === true);
  for (const s of ["", "?texCensus=1", "?texCensus=true", "?texCensus", "?texCensus=off", "?other=on"]) {
    check(`"${s}" does not`, texCensusEnabled(s) === false);
  }
}

console.log("PART 2 — byte accounting dedupes shared buffers");
{
  const buf = new ArrayBuffer(1000);
  const a = new Uint8Array(buf);            // 1000 B
  const b = new Uint32Array(buf);           // the SAME 1000 B, different view
  const t1 = new FakeTexture(a);
  const t2 = new FakeTexture(b);
  check("one texture charges its own bytes", textureCpuBytes(t1, null) === 1000);
  const seen = new Set();
  const total = textureCpuBytes(t1, seen) + textureCpuBytes(t2, seen);
  check(
    "two views over one buffer charge ONCE across a census walk",
    total === 1000,
    `${total} (a naive sum says 2000)`,
  );
  const solo = new FakeTexture(new Uint8Array(64));
  solo.mipmaps = [{ data: new Uint8Array(32) }, { data: new Uint8Array(16) }];
  check("mip levels are counted", textureCpuBytes(solo, null) === 112, String(textureCpuBytes(solo, null)));
  check("a texture with no data charges 0", textureCpuBytes(new FakeTexture(null), null) === 0);
}

console.log("PART 3 — install is transparent to three");
{
  __resetTextureCensusForTests();
  check("install returns true", installTextureCensus(THREE_STUB) === true);
  const t = new FakeTexture(new Uint8Array(10));
  let heard = 0;
  t.addEventListener("dispose", () => heard++);
  check("the wrapped addEventListener still registers the listener", t._l.dispose.length === 1);
  t.dispose();
  check("the wrapped dispose still calls through", t.disposedCalled === 1);
  const c = textureCensus(null);
  check("the uploaded texture was traced", c.traced === 1, `traced=${c.traced}`);
  check("the dispose call was counted", c.disposeCalls === 1);
  check("dispose does not untrace a still-alive texture", c.alive === 1 && c.disposedButAlive === 1,
        `alive=${c.alive} disposedButAlive=${c.disposedButAlive}`);
  // A non-dispose listener must not trace, or every unrelated hook inflates
  // the population and every ratio computed from it is wrong.
  const t2 = new FakeTexture(new Uint8Array(10));
  t2.addEventListener("update", () => {});
  const after = textureCensus(null);
  check("a non-'dispose' listener does not trace", after.traced === 1,
        `traced=${after.traced} (only the uploaded one should count)`);
}

console.log("PART 4 — orphan classification");
{
  __resetTextureCensusForTests();
  installTextureCensus(THREE_STUB);
  const held = new FakeTexture(new Uint8Array(4096));   // reachable from the scene
  const orphan = new FakeTexture(new Uint8Array(8192)); // alive, nothing points at it
  upload(held); upload(orphan);
  // A scene that reaches exactly one of them.
  const scene = {
    traverse(fn) { fn({ material: { map: held } }); },
  };
  const c = textureCensus(scene);
  check("both are alive", c.alive === 2, `alive=${c.alive}`);
  check("reachability was computed", c.reachable === 1, `reachable=${c.reachable}`);
  check("only the unreachable one is an orphan", c.orphanedAlive === 1, `orphans=${c.orphanedAlive}`);
  check("orphan bytes are the orphan's, not the total", c.orphanedAliveBytes === 8192,
        `${c.orphanedAliveBytes}`);
  check("aliveBytes covers both", c.aliveBytes === 4096 + 8192, `${c.aliveBytes}`);
  check("byKind is populated", (c.byKind.DataTexture?.alive ?? 0) === 2, JSON.stringify(c.byKind));

  // Without a scene there is no reachability, so NOTHING may be called an
  // orphan — a census run before the scene exists must not report a 100% leak.
  const noScene = textureCensus(null);
  check("no scene ⇒ no orphans claimed", noScene.orphanedAlive === 0 && noScene.sceneSupplied === false);

  // ...but a scene that reaches NOTHING is the opposite case and must report
  // every alive texture as an orphan. Keying orphanhood off "reachable > 0"
  // instead of "a scene was supplied" turns the worst case into a clean bill.
  const emptyScene = textureCensus({ traverse(fn) { fn({}); } });
  check("empty scene ⇒ everything alive is an orphan",
        emptyScene.orphanedAlive === emptyScene.alive && emptyScene.alive === 2,
        `orphans=${emptyScene.orphanedAlive} alive=${emptyScene.alive}`);
}

console.log("PART 5 — owner attribution");
{
  __resetTextureCensusForTests();
  installTextureCensus(THREE_STUB);
  const cached = new FakeTexture(new Uint8Array(2048));
  const mystery = new FakeTexture(new Uint8Array(1024));
  upload(cached); upload(mystery);
  const fakeCache = new Set([cached]);
  registerTextureOwnerProbe("materialCache", (t) => fakeCache.has(t));
  const c = textureCensus({ traverse(fn) { fn({}); } });
  check("the cache's orphan is attributed to it", c.byOwner.materialCache?.bytes === 2048,
        JSON.stringify(c.byOwner));
  check("an unclaimed orphan lands in `unknown`", c.byOwner.unknown?.bytes === 1024,
        JSON.stringify(c.byOwner));
  check("topOwners ranks by bytes", c.topOwners[0].startsWith("materialCache"), c.topOwners.join(" | "));
  // A probe that throws must not take the census down with it.
  registerTextureOwnerProbe("explodes", () => { throw new Error("boom"); });
  let survived = true;
  try { textureCensus({ traverse(fn) { fn({}); } }); } catch (_) { survived = false; }
  check("a throwing owner probe is absorbed", survived);
}

console.log("PART 6 — the shipped renderer wires it");
{
  const idx = readFileSync(joinPath(__dirname, "scene3d", "index.js"), "utf8");
  check("index.js imports the census", /from\s+"\.\/texture_census\.js"/.test(idx));
  check(
    "the tracer installs at MODULE scope, not inside init3D (a texture uploaded before the hook is invisible forever)",
    /^if \(texCensusEnabled\(\)\) \{\n\s+installTextureCensus\(THREE\);/m.test(idx),
  );
  check("__diag.textures is exposed", /window\.__diag\.textures\s*=/.test(idx));
  check(
    "it censuses the real `scene` binding, not the liveScene3d snapshot",
    /const out = textureCensus\(scene\);/.test(idx),
  );
  check(
    "orphans get attributed to a named retainer (evicted != disposed != GC'd)",
    /registerTextureOwnerProbe\("matCache\.perDid"/.test(idx) &&
      /registerTextureOwnerProbe\("tagged\.__rp4Pooled"/.test(idx),
  );
  check(
    "the BC7 record cache is reported alongside (it holds bytes textures dying does not free)",
    /out\.bc7Records = bc7RecordCacheBytes\(\)/.test(idx),
  );
  const bc7 = readFileSync(joinPath(__dirname, "scene3d", "bc7_textures.js"), "utf8");
  check(
    "...and that accessor dedupes by ArrayBuffer (mip levels are subarrays of one buffer)",
    /export function bc7RecordCacheBytes/.test(bc7) && /seen\.has\(buf\)/.test(bc7),
  );
  const doc = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");
  check("?texCensus has a docs row (lint-url-flags gate)", /\|\s*`texCensus`\s*\|/.test(doc));
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
