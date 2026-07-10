#!/usr/bin/env node
// harness/surface-ladder-probe.mjs — P3 net-fixwave (2026-07-09) regression
// probe for R-2 (JS negative-cache un-poison + recovery-ladder restore) and
// R-8 (dyed-path ladder twin). Runs headless on the laptop against the live
// app (boot contract: A16 — nullRender mandatory, in-world gate, never
// 'ready'); no GPU readback anywhere (materials exist under ?nullRender=1).
//
// Legs (each independently PASS / FAIL / SKIP):
//   negcache-abi   MaterialCache.get() with a stubbed fetcher: a zero-dim
//                  result WITHOUT `provenAbsent` (legacy wasm) must NOT
//                  poison missingSurfaces; one WITH `provenAbsent` listing
//                  the DID must poison it (flag default-on).
//   plain-ladder   Simulate the era failure on a live plain-path entity
//                  mesh: force a transient (monkey-patch window.fetch to
//                  reject shard URLs — in-page, reversible), drop the DID's
//                  cached material, verify missingSurfaces does NOT grow,
//                  poison the Set by hand (the legacy-poisoned state), arm
//                  _scheduleEntitySurfaceRefresh and assert the mesh regains
//                  a .map within the ladder's early rungs AND the DID left
//                  missingSurfaces (the un-poison). If the main-thread wasm
//                  already holds the shard bytes (insert-only cache) the
//                  transient can't be induced — the leg degrades to the
//                  poison-only variant and says so.
//   dyed-ladder    Simulate a whole-outfit blank on a live dyed entity
//                  (fallback material + paletted-cache purge), arm
//                  _scheduleDyedSurfaceRefresh with the entity's own
//                  (paletteId, subPalettes) and assert the parameter-
//                  preserving refetch re-textures the mesh in-schedule.
//
// Usage (laptop):
//   node surface-ladder-probe.mjs [--telepoi "Holtburg"] [--query "extra=flags"]
//        [--healMs 12000] [--out out.json]
// Output: JSON to stdout/--out + trailing "LADDER-PROBE SUMMARY: ..." line.
// Exit 0 = every non-skipped leg passed.

import { pathToFileURL } from "node:url";
import fs from "node:fs";

const BOOT_MJS = process.env.BOOT_MJS ||
  new URL("./lib/boot.mjs", import.meta.url).pathname;

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const TELEPOI = arg("telepoi", "");
const EXTRA_QUERY = arg("query", "");
const HEAL_MS = Number(arg("healMs", "12000"));
const OUT = arg("out", "");

// ── in-page probe: one async evaluate, self-contained ──────────────────────
const runProbe = async (cfg) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { legs: {}, notes: [] };
  const s3 = window.liveScene3d;
  const em = s3 && s3.entityManager;
  const mc = s3 && s3.materialCache;
  const wasm = em && em.wasmExports;
  if (!s3 || !em || !mc || !wasm) {
    return { ok: false, reason: "scene/entityManager/materialCache/wasm missing" };
  }

  // ---- leg 1: negcache-abi (synthetic fetcher, no network) ----------------
  {
    const leg = { name: "negcache-abi", status: "FAIL" };
    try {
      const didLegacy = 0x08e99901 >>> 0;
      const didProven = 0x08e99902 >>> 0;
      mc.missingSurfaces.delete(didLegacy);
      mc.missingSurfaces.delete(didProven);
      const zero = () => ({ width: 0, height: 0 });
      // legacy wasm shape: plain array, no audit fields
      const m1 = await mc.get(didLegacy, async () => [zero()]);
      leg.legacyReturnedFallback = m1 === mc.fallbackMaterial;
      leg.legacyPoisoned = mc.missingSurfaces.has(didLegacy);
      // new-wasm shape: call-level provenAbsent listing the DID
      const results = [zero()];
      results.provenAbsent = ["0x" + didProven.toString(16).padStart(8, "0").toUpperCase()];
      results.decodeMisses = 0;
      const m2 = await mc.get(didProven, async () => results);
      leg.provenReturnedFallback = m2 === mc.fallbackMaterial;
      leg.provenPoisoned = mc.missingSurfaces.has(didProven);
      const expectPoison = mc._negCacheEnabled === true;
      leg.status =
        leg.legacyReturnedFallback && !leg.legacyPoisoned &&
        leg.provenReturnedFallback && leg.provenPoisoned === expectPoison
          ? "PASS" : "FAIL";
      // cleanup — synthetic DIDs must not outlive the probe
      mc.missingSurfaces.delete(didLegacy);
      mc.missingSurfaces.delete(didProven);
    } catch (e) {
      leg.error = String((e && e.message) || e);
    }
    out.legs["negcache-abi"] = leg;
  }

  // helpers shared by the entity legs -----------------------------------------
  const needsTex = (mat) => !!mat && !mat.map;
  const findPlainTarget = () => {
    for (const inst of em.entityMap.values()) {
      if (!inst || !inst.root || inst._disposed) continue;
      let found = null;
      inst.root.traverse((o) => {
        if (found || !o.isMesh || !o.userData || o.userData.surfaceDid == null) return;
        const m = o.material;
        // plain path = the SHARED cache material (scene3d-surface-<did>)
        if (m && m.map && typeof m.name === "string" && m.name.startsWith("scene3d-surface-")) {
          found = o;
        }
      });
      if (found) return { inst, mesh: found, did: found.userData.surfaceDid >>> 0 };
    }
    return null;
  };
  const findDyedTarget = () => {
    for (const inst of em.entityMap.values()) {
      if (!inst || !inst.root || inst._disposed) continue;
      if (!inst._entityMaterials || inst._entityMaterials.size === 0) continue;
      const meta = inst.meta || {};
      const paletteId = (meta.paletteId ?? 0) >>> 0;
      const subPalettes = meta.subPalettes ?? [];
      if (paletteId === 0 && !(subPalettes && subPalettes.length > 0)) continue;
      let found = null;
      inst.root.traverse((o) => {
        if (found || !o.isMesh || !o.userData || o.userData.surfaceDid == null) return;
        const did = o.userData.surfaceDid >>> 0;
        const m = o.material;
        if (m && m.map && inst._entityMaterials.has(did)) found = o;
      });
      if (found) {
        return { inst, mesh: found, did: found.userData.surfaceDid >>> 0, paletteId, subPalettes };
      }
    }
    return null;
  };
  const pollHeal = async (mesh, did, deadlineMs) => {
    const t0 = performance.now();
    while (performance.now() - t0 < deadlineMs) {
      if (!needsTex(mesh.material) && !mc.missingSurfaces.has(did)) {
        return { healed: true, ms: Math.round(performance.now() - t0) };
      }
      await sleep(500);
    }
    return {
      healed: false, ms: deadlineMs,
      stillMapless: needsTex(mesh.material),
      stillPoisoned: mc.missingSurfaces.has(did),
    };
  };

  // ---- leg 2: plain-ladder ------------------------------------------------
  {
    const leg = { name: "plain-ladder", status: "FAIL" };
    const target = findPlainTarget();
    if (!target) {
      leg.status = "SKIP";
      leg.reason = "no plain-path entity mesh with a shared textured material in scene";
    } else {
      const { inst, mesh, did } = target;
      leg.did = "0x" + did.toString(16).padStart(8, "0");
      const missingBaseline = mc.missingSurfaces.size;
      // 1) transient window: reject shard fetches (reversible, main thread
      //    only — the bake worker's fetches live in the worker global scope)
      const realFetch = window.fetch;
      let blocked = 0;
      window.fetch = function (input, init) {
        const url = typeof input === "string" ? input : (input && input.url) || "";
        if (url.includes("/shards/")) {
          blocked += 1;
          return Promise.reject(new TypeError("surface-ladder-probe: simulated shard outage"));
        }
        return realFetch.call(this, input, init);
      };
      try {
        // 2) drop the resolved material so the next decode is a real walk
        mc.materials.delete(did);
        mc.pendingFetches.delete(did);
        mesh.material = mc.fallbackMaterial;
        try {
          await mc.preload([did], wasm.fetch_surfaces_pixels);
        } catch (_) { /* a thrown bulk fetch is also a transient */ }
        leg.transientInduced = !mc.materials.has(did);
        leg.blockedFetches = blocked;
        // 3) R-2 core assertion: the transient zero-dim must NOT have poisoned
        leg.missingGrew = mc.missingSurfaces.size > missingBaseline;
      } finally {
        window.fetch = realFetch; // reversible — restore unconditionally
      }
      // 4) legacy-poisoned state (what a pre-fix session latched), then arm
      //    the ladder: heal proves both the un-poison and the retry path.
      mc.missingSurfaces.add(did);
      if (!leg.transientInduced) {
        // main wasm already had the shard bytes (insert-only cache) so no
        // transient was induced; the leg still proves the un-poison.
        leg.variant = "poison-only";
        mc.materials.delete(did);
        mc.pendingFetches.delete(did);
        mesh.material = mc.fallbackMaterial;
      } else {
        leg.variant = "transient+poison";
      }
      em._scheduleEntitySurfaceRefresh(inst, 0);
      const heal = await pollHeal(mesh, did, cfg.healMs);
      leg.heal = heal;
      leg.status = !leg.missingGrew && heal.healed ? "PASS" : "FAIL";
    }
    out.legs["plain-ladder"] = leg;
  }

  // ---- leg 3: dyed-ladder -------------------------------------------------
  {
    const leg = { name: "dyed-ladder", status: "FAIL" };
    if (typeof em._scheduleDyedSurfaceRefresh !== "function") {
      leg.reason = "_scheduleDyedSurfaceRefresh missing (pre-P3 build)";
      out.legs["dyed-ladder"] = leg;
    } else {
      const target = findDyedTarget();
      if (!target) {
        leg.status = "SKIP";
        leg.reason = "no dyed entity (paletteId/subPalettes) with a textured part in scene";
      } else {
        const { inst, mesh, did, paletteId, subPalettes } = target;
        leg.did = "0x" + did.toString(16).padStart(8, "0");
        leg.paletteId = paletteId;
        const missingBaseline = mc.missingSurfaces.size;
        // whole-outfit blank simulation: fallback on the mesh + purge the
        // shared paletted cache entry so the ladder must really refetch
        const pkey = mc._paletteKey(did, paletteId, subPalettes);
        mc.palettedMaterials.delete(pkey);
        mc.palettedTextures.delete(pkey);
        inst._entityMaterials.delete(did);
        mesh.material = mc.fallbackMaterial;
        em._cancelDyedSurfaceRefresh(inst);
        em._scheduleDyedSurfaceRefresh(inst, {
          paletteId,
          subPalettes,
          dids: new Uint32Array([did]),
          missArmed: false,
        }, 0);
        const heal = await pollHeal(mesh, did, cfg.healMs);
        leg.heal = heal;
        // the dyed path must never touch the bare-DID negative cache
        leg.missingGrew = mc.missingSurfaces.size > missingBaseline;
        leg.status = heal.healed && !leg.missingGrew ? "PASS" : "FAIL";
      }
      out.legs["dyed-ladder"] = leg;
    }
  }

  out.missingSurfacesFinal = mc.missingSurfaces.size;
  out.ok = Object.values(out.legs).every((l) => l.status !== "FAIL");
  return out;
};

// ── driver (A16 boot contract) ──────────────────────────────────────────────
const boot = await import(pathToFileURL(BOOT_MJS).href);
const query = { nosw: "1" };
if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) query[k] = v;
const { page, helpers, inWorld } = await boot.launchAndEnter({ query, timeoutMs: 120_000 });
if (!inWorld) {
  console.log(JSON.stringify({ ok: false, reason: "boot-stalled" }));
  console.log("LADDER-PROBE SUMMARY: SKIP boot-stalled");
  await helpers.close(); process.exit(2);
}
// liveScene3d appears well after in-world on some routes — poll, don't assume.
for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}
if (TELEPOI) {
  await helpers.evalInPage((p) => { try { window.__sessionHandle.sendChat("@telepoi " + p); } catch (_) {} }, TELEPOI);
  await page.waitForTimeout(15_000);
  for (let i = 0; i < 30; i++) { // liveScene3d transiently nulled during teleport
    if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
    await page.waitForTimeout(1000);
  }
}
// let the spawn wave settle so targets have textured materials to steal
await page.waitForTimeout(10_000);
const result = await helpers.evalInPage(runProbe, { healMs: HEAL_MS });
const errors = helpers.consoleErrors();
const payload = { ok: !!(result && result.ok), telepoi: TELEPOI || null,
                  healMs: HEAL_MS, result,
                  consoleErrorCount: errors.length, consoleErrors: errors.slice(0, 20) };
const json = JSON.stringify(payload, null, 2);
if (OUT) fs.writeFileSync(OUT, json);
console.log(json);
const legs = (result && result.legs) || {};
const summary = ["negcache-abi", "plain-ladder", "dyed-ladder"]
  .map((k) => `${k}=${legs[k] ? legs[k].status : "MISSING"}`).join(" ");
console.log(`LADDER-PROBE SUMMARY: ${summary} missingFinal=${result && result.missingSurfacesFinal}`);
await helpers.close();
process.exit(payload.ok ? 0 : 1);
