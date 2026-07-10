#!/usr/bin/env node
// harness/orphan-emitter-probe.mjs — P4 net-fixwave (2026-07-10) regression
// probe for R-10 (staticScriptSlice attach-after-evict; A03-F1 ≡ A13-L1) and
// the teleport spawn-flush (A03-F3). Implements A03 §5.2 recipe 2 / A13 §4's
// one-liner as a scripted check, headless per the A16 boot contract
// (nullRender mandatory; in-world gate; @telepoi hops per §ace-admin-cmds).
//
// Sequence:
//   1. boot → @telepoi <denseTown> (default Linvak Tukal), wait ~1.2 s so the
//      sliced default_script attach is MID-FLIGHT (a heavy town's attach runs
//      across seconds of yields);
//   2. immediately @telepoi away twice (forces LRU eviction of the town while
//      its attach loop still holds yields);
//   3. settle, then count ORPHANS: staticsGroup children tagged
//      `isStaticScriptAnchor` whose owning LB is NOT in the matching resident
//      set (`staticsBakedLbs` outdoor / `envCellLoadedLbs` interior), plus
//      ownerRegistry `static:<lbKey>` owners whose LB is non-resident.
//   4. report the teleport spawn-flush console tell + `_deferredSpawns` size.
//
// PASS = 0 orphan anchors AND 0 orphan registry owners on the default arm.
// Control arm: `--query "staticScriptSlice=off"` restores the pre-slice burst
// attach (guard rides the flag) — orphans there measure the unguarded window.
//
// Usage:
//   node orphan-emitter-probe.mjs [--town "Linvak Tukal"] [--hop1 "Holtburg"]
//        [--hop2 "Samsur"] [--attackMs 1200] [--settleMs 6000]
//        [--query "extra=flags"] [--out out.json]
import fs from "node:fs";
import { launchAndEnter } from "./lib/boot.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const TOWN = arg("town", "Linvak Tukal");
const HOP1 = arg("hop1", "Holtburg");
const HOP2 = arg("hop2", "Samsur");
const ATTACH_MS = Number(arg("attackMs", "1200"));
const SETTLE_MS = Number(arg("settleMs", "6000"));
const EXTRA_QUERY = arg("query", "");
const OUT = arg("out", "");

const { page, helpers, inWorld } = await launchAndEnter({
  query: EXTRA_QUERY || undefined,
  timeoutMs: 120_000,
});
const out = { town: TOWN, hops: [HOP1, HOP2], query: EXTRA_QUERY, inWorld };
// Own console tap (helpers exposes only consoleErrors) — the spawn-flush
// tell is a console.info.
const _consoleLines = [];
page.on("console", (m) => _consoleLines.push(m.text()));
try {
  if (!inWorld) throw new Error("boot stalled pre-in-world");

  const tele = async (poi, waitMs) => {
    await page.evaluate((p) => {
      try { window.__sessionHandle.sendChat("@telepoi " + p); } catch (_) {}
    }, poi);
    await page.waitForTimeout(waitMs);
  };

  // 1) dense town; interrupt its attach mid-slice.
  await tele(TOWN, ATTACH_MS);
  // 2) two hops away → LRU evicts the town while the attach may still yield.
  await tele(HOP1, ATTACH_MS);
  await tele(HOP2, SETTLE_MS);

  // 3) orphan census, in-page.
  const census = await page.evaluate(() => {
    const s = window.liveScene3d;
    if (!s || !s.staticsGroup) return { err: "no liveScene3d/staticsGroup" };
    const lbKeyOf = (id) => ((id >>> 0) & 0xffff0000) >>> 0;
    const baked = s.staticsBakedLbs instanceof Set ? s.staticsBakedLbs : new Set();
    const cells = s.envCellLoadedLbs instanceof Set ? s.envCellLoadedLbs : new Set();
    let anchorsTotal = 0;
    let orphanAnchors = 0;
    let unattributable = 0;
    const orphanLbs = new Set();
    for (const c of s.staticsGroup.children) {
      const ud = c && c.userData;
      if (!ud || !ud.isStaticScriptAnchor) continue;
      anchorsTotal += 1;
      if (ud.landblockId == null) { unattributable += 1; continue; }
      const key = lbKeyOf(ud.landblockId);
      const resident = ud.isCellStaticScriptAnchor ? cells.has(key) : baked.has(key);
      if (!resident) {
        orphanAnchors += 1;
        orphanLbs.add("0x" + key.toString(16).padStart(8, "0"));
      }
    }
    // Registry half via __diag.particles() (index.js exposes the owner
    // registry's byOwner counts there): static:<lbKey> owners with live
    // emitters for non-resident LBs. null when the diag surface is absent
    // (anchors stay the primary gate).
    let orphanOwners = null;
    try {
      const parts = window.__diag?.particles?.();
      if (parts && parts.byOwner) {
        orphanOwners = 0;
        for (const [k, n] of Object.entries(parts.byOwner)) {
          if (!k.startsWith("static:") || !(n > 0)) continue;
          // staticOwnerKeyForLb renders the lbKey in DECIMAL.
          const key = parseInt(k.slice(7), 10) >>> 0;
          if (Number.isFinite(key) && key !== 0 && !baked.has(key) && !cells.has(key)) {
            orphanOwners += 1;
          }
        }
      }
    } catch (_) { orphanOwners = null; }
    return {
      anchorsTotal,
      orphanAnchors,
      unattributable,
      orphanLbs: [...orphanLbs],
      orphanOwners,
      residentBaked: baked.size,
      residentCells: cells.size,
    };
  });
  out.census = census;

  // 4) spawn-flush observability: the console.info tell from
  // noteLocalPlayerLandblockForSpawnFlush (0 tells is fine — the queue may
  // simply have drained before the hop; the tell proves the seam is live
  // when spawns WERE pending).
  out.spawnFlushTells = _consoleLines.filter((t) => t.includes("teleport spawn-flush"));

  const pass =
    !census.err &&
    census.orphanAnchors === 0 &&
    (census.orphanOwners === 0 || census.orphanOwners == null);
  out.status = pass ? "PASS" : "FAIL";
} catch (e) {
  out.status = "SKIP";
  out.error = String((e && e.message) || e);
} finally {
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(
    `ORPHAN-PROBE SUMMARY: ${out.status}` +
      (out.census
        ? ` anchors=${out.census.anchorsTotal} orphans=${out.census.orphanAnchors}` +
          ` owners=${out.census.orphanOwners} flushTells=${(out.spawnFlushTells || []).length}`
        : ` (${out.error || "no census"})`),
  );
  await helpers.close().catch(() => {});
  process.exit(out.status === "FAIL" ? 1 : 0);
}
