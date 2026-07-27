// P4.1 / LEAK-01 (2026-07-27) — the nine per-GUID bridge caches join the
// A8-M1 delete fan-out (`maintain_bridge_indexes_on_delete`), which
// previously pruned eight siblings and skipped them entirely. Via ACE
// dynamic-GUID reuse the omission is a stale-data bug (NQ-19: "items have
// been placed in packs and didn't appear later"), not only a leak.
//
// Standalone node ESM test (no live ACE session, no browser, no wasm).
// Two parts, mirroring test_a8_m3_kind17_dispatch.mjs:
//   PART 1 — behavioral: the prune CONTRACT, modelled in JS against a
//            recording store factory. The shipped implementation is Rust
//            (`PerGuidBridgeIndexes::prune_guid`), so PART 1 pins the
//            semantics and PART 2 pins the Rust source to those
//            semantics. Neither half is meaningful without the other.
//   PART 2 — static: read src/lib.rs + index.html as text and assert the
//            nine stores are actually wired into the fan-out, that the
//            create-side reuse purge exists, and that the __diag probe
//            is installed.
//
// Run:
//   cd apps/holtburger-web/
//   node test_leak01_bridge_index_prune.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// The nine stores, named exactly as `PerGuidBridgeIndexes::sizes()`
// reports them through `bridgeIndexSizes()`.
const STORE_NAMES = [
  "latestVendorState",
  "latestContainerContents",
  "latestObjectIcons",
  "latestInscriptions",
  "latestAppraisals",
  "identifyMetaIndex",
  "doorPartSnapshot",
  "rynthIdTimes",
  "remoteAirborneState",
];

// =====================================================================
// PART 1 — behavioral: the prune contract.
// =====================================================================
console.log("PART 1 — per-guid prune contract");

// Factory mirroring the Rust struct: nine guid-keyed maps plus the
// two cumulative counters, with the delete/reuse entry points.
function makeBridgeIndexes() {
  const stores = new Map(STORE_NAMES.map((n) => [n, new Map()]));
  let deletePrunes = 0;
  let reusePrunes = 0;

  function pruneGuid(g) {
    for (const m of stores.values()) m.delete(g);
    // Contents-list strip: looting a corpse slot-by-slot deletes the
    // CONTENTS, never the container, so the container's cached GUID
    // list must lose the item too.
    for (const list of stores.get("latestContainerContents").values()) {
      const i = list.indexOf(g);
      if (i >= 0) list.splice(i, 1);
    }
  }

  return {
    stores,
    set: (store, g, v) => stores.get(store).set(g, v),
    get: (store, g) => stores.get(store).get(g),
    onDelete(g) { pruneGuid(g); deletePrunes += 1; },
    onCreate(g) { pruneGuid(g); reusePrunes += 1; },
    sizes() {
      const out = {};
      for (const [n, m] of stores) out[n] = m.size;
      out.deletePrunes = deletePrunes;
      out.reusePrunes = reusePrunes;
      return out;
    },
  };
}

const PACK = 0x80001234;
const ITEM_A = 0x80009991;
const ITEM_B = 0x80009992;

function populateAll(idx, guid) {
  idx.set("latestVendorState", guid, { items: [1, 2] });
  idx.set("latestContainerContents", guid, [ITEM_A, ITEM_B]);
  idx.set("latestObjectIcons", guid, 0x06001111);
  idx.set("latestInscriptions", guid, "signed by Asheron");
  idx.set("latestAppraisals", guid, '{"name":"Old Pack"}');
  idx.set("identifyMetaIndex", guid, [true, 7]);
  idx.set("doorPartSnapshot", guid, { part: 3 });
  idx.set("rynthIdTimes", guid, 1234.5);
  idx.set("remoteAirborneState", guid, true);
}

// (1) despawn removes the guid from EVERY one of the nine.
{
  const idx = makeBridgeIndexes();
  populateAll(idx, PACK);
  const before = idx.sizes();
  check(
    "all nine populated before despawn",
    STORE_NAMES.every((n) => before[n] === 1),
    JSON.stringify(before),
  );
  idx.onDelete(PACK);
  const after = idx.sizes();
  const survivors = STORE_NAMES.filter((n) => after[n] !== 0);
  check(
    "despawn removes the guid from every one of the nine",
    survivors.length === 0,
    survivors.length ? `survivors: ${survivors.join(", ")}` : "",
  );
  check("deletePrunes counter incremented", after.deletePrunes === 1);
}

// (2) NQ-19 core: guid reuse yields FRESH data, never the previous
// occupant's. Pack P despawns; ACE recycles its guid for a new pack;
// the new pack's contents must not read back as the old pack's.
{
  const idx = makeBridgeIndexes();
  populateAll(idx, PACK);
  idx.onDelete(PACK);
  // ACE recycles PACK's guid for a different object; ObjectCreate lands.
  idx.onCreate(PACK);
  check(
    "recycled guid returns no stale appraisal",
    idx.get("latestAppraisals", PACK) === undefined,
  );
  check(
    "recycled guid returns no stale container contents",
    idx.get("latestContainerContents", PACK) === undefined,
  );
  // Now the new occupant is opened and populates fresh state.
  idx.set("latestContainerContents", PACK, [0xAAAA]);
  check(
    "post-reuse read returns the NEW occupant's contents",
    JSON.stringify(idx.get("latestContainerContents", PACK)) === "[43690]",
    JSON.stringify(idx.get("latestContainerContents", PACK)),
  );
}

// (3) reuse purge is load-bearing on its own: if the client never saw
// the delete (out-of-range despawn, missed packet), the create-side
// purge is the only thing standing between the recycled guid and the
// previous occupant's data.
{
  const idx = makeBridgeIndexes();
  populateAll(idx, PACK);
  idx.onCreate(PACK); // no onDelete at all
  const after = idx.sizes();
  check(
    "create-side purge alone clears a missed-delete survivor",
    STORE_NAMES.every((n) => after[n] === 0),
    JSON.stringify(after),
  );
  check("reusePrunes counter incremented", after.reusePrunes === 1);
}

// (4) NQ-19's other half: looting a container item-by-item deletes the
// CONTENTS, not the container. The container's cached list must lose
// the looted guid or a reopen renders items that are gone.
{
  const idx = makeBridgeIndexes();
  idx.set("latestContainerContents", PACK, [ITEM_A, ITEM_B]);
  idx.onDelete(ITEM_A);
  check(
    "looted item stripped from the surviving container's list",
    JSON.stringify(idx.get("latestContainerContents", PACK)) === JSON.stringify([ITEM_B]),
    JSON.stringify(idx.get("latestContainerContents", PACK)),
  );
  check(
    "container entry itself survives a contents-only delete",
    idx.sizes().latestContainerContents === 1,
  );
}

// (5) the leak assertion the headless soak makes: sizes must not grow
// across repeated spawn/despawn cycles.
{
  const idx = makeBridgeIndexes();
  for (let cycle = 0; cycle < 200; cycle += 1) {
    const g = 0x80000000 + cycle; // ACE hands out a fresh dynamic guid
    idx.onCreate(g);
    populateAll(idx, g);
    idx.onDelete(g);
  }
  const after = idx.sizes();
  const growing = STORE_NAMES.filter((n) => after[n] !== 0);
  check(
    "200 spawn/despawn cycles leave every store at 0",
    growing.length === 0,
    growing.length ? `grew: ${growing.map((n) => `${n}=${after[n]}`).join(", ")}` : "",
  );
  check(
    "counters prove the fan-out actually ran (not just a flat map)",
    after.deletePrunes === 200 && after.reusePrunes === 200,
    `delete=${after.deletePrunes} reuse=${after.reusePrunes}`,
  );
}

// =====================================================================
// PART 2 — static: shipped source wiring.
// =====================================================================
console.log("PART 2 — static source wiring");

const libRs = readFileSync(joinPath(__dirname, "src", "lib.rs"), "utf8");
const indexHtml = readFileSync(joinPath(__dirname, "index.html"), "utf8");

// The Rust field names behind the nine JS-facing store names.
const RUST_FIELDS = [
  "latest_vendor_state",
  "latest_container_contents",
  "latest_object_icons",
  "latest_inscriptions",
  "latest_appraisals",
  "identify_meta_index",
  "door_part_snapshot",
  "rynth_id_times",
];

// (2.1) the borrow-struct exists and carries all eight Rc-held stores.
const structStart = libRs.indexOf("struct PerGuidBridgeIndexes<'a> {");
const structSlice = structStart >= 0 ? libRs.slice(structStart, structStart + 2000) : "";
check("lib.rs defines PerGuidBridgeIndexes", structStart >= 0);
for (const f of RUST_FIELDS) {
  check(`  PerGuidBridgeIndexes carries ${f}`, new RegExp(`\\b${f}:\\s*&'a`).test(structSlice));
}

// (2.2) prune_guid removes every one of the nine (eight fields + the
// REMOTE_AIRBORNE_STATE thread-local) and strips container lists.
const pruneStart = libRs.indexOf("fn prune_guid(&self, g: u32)");
const pruneSlice = pruneStart >= 0 ? libRs.slice(pruneStart, pruneStart + 1400) : "";
check("lib.rs defines prune_guid", pruneStart >= 0);
for (const f of RUST_FIELDS) {
  check(
    `  prune_guid removes from ${f}`,
    new RegExp(`self\\.${f}[\\s\\S]{0,80}?\\.remove\\(&g\\)`).test(pruneSlice),
  );
}
check(
  "  prune_guid removes from the REMOTE_AIRBORNE_STATE thread-local",
  /REMOTE_AIRBORNE_STATE\.with\([\s\S]{0,80}?\.remove\(&g\)/.test(pruneSlice),
);
check(
  "  prune_guid strips the deleted guid from cached container lists",
  /for items in contents\.values_mut\(\)[\s\S]{0,120}?retain\(\|item\| \*item != g\)/.test(pruneSlice),
);

// (2.3) the SAME lifecycle: the fan-out the eight siblings already use
// calls prune_on_delete, and takes the struct as a param.
const fanoutStart = libRs.indexOf("fn maintain_bridge_indexes_on_delete(");
// Slice must clear the fan-out's full body: the param list and the
// per-sibling comments push the trailing prune call past 3.2 KB.
const fanoutSlice = fanoutStart >= 0 ? libRs.slice(fanoutStart, fanoutStart + 5000) : "";
check("lib.rs still has maintain_bridge_indexes_on_delete", fanoutStart >= 0);
check(
  "  fan-out takes &PerGuidBridgeIndexes (no new lifecycle)",
  /per_guid:\s*&PerGuidBridgeIndexes<'_>/.test(fanoutSlice),
);
check("  fan-out calls per_guid.prune_on_delete", fanoutSlice.includes("per_guid.prune_on_delete("));
// The eight pre-existing siblings must still be pruned in the same body.
for (const sib of [
  "MOTION_ACTION_STAMPS",
  "PROJECTILE_GRAVITY_GUIDS",
  "DEFAULT_SCRIPT_INDEX",
  "UI_EFFECTS_INDEX",
]) {
  check(`  sibling ${sib} still pruned in the same body`, fanoutSlice.includes(sib));
}

// (2.4) guid-reuse overwrite: BOTH create paths purge.
for (const fn of ["maintain_bridge_indexes_on_routed_create", "apply_inventory_object_create"]) {
  const s = libRs.indexOf(`fn ${fn}(`);
  const slice = s >= 0 ? libRs.slice(s, s + 2600) : "";
  check(`${fn} purges on guid reuse`, slice.includes("per_guid.prune_on_guid_reuse("));
}

// (2.5) every call site threads the struct through — no arm left behind.
const deleteCalls = libRs.match(/maintain_bridge_indexes_on_delete\(/g) || [];
check(
  "maintain_bridge_indexes_on_delete has 3 call sites + 1 definition",
  deleteCalls.length === 4,
  `found ${deleteCalls.length}`,
);
check(
  "no delete/create call site omits per_guid_bridge_indexes",
  (libRs.match(/&per_guid_bridge_indexes/g) || []).length === 6,
  `found ${(libRs.match(/&per_guid_bridge_indexes/g) || []).length} of 6`,
);

// (2.6) the diag getter + its JS probe.
check("lib.rs exports bridgeIndexSizes", libRs.includes("js_name = bridgeIndexSizes"));
// The counter keys are emitted through Rust string literals, so they
// appear ESCAPED in the source text (`\"deletePrunes\"`).
check(
  "bridgeIndexSizes reports both prune counters",
  libRs.includes('\\"deletePrunes\\":') && libRs.includes('\\"reusePrunes\\":'),
);
check(
  "sizes() reports all nine store names",
  STORE_NAMES.every((n) => libRs.includes(`"${n}"`)),
  STORE_NAMES.filter((n) => !libRs.includes(`"${n}"`)).join(", "),
);
check("index.html installs __diag.bridgeIndexes", indexHtml.includes("window.__diag.bridgeIndexes"));
check(
  "  probe reads the handle dynamically (survives reconnect)",
  /__diag\.bridgeIndexes\s*=\s*\(\)\s*=>\s*\{[\s\S]{0,200}?window\.__sessionHandle/.test(indexHtml),
);

// (2.7) regression guard: the nine must never again sit in lib.rs with
// zero removal sites. Each Rust field needs at least one `.remove(`.
for (const f of RUST_FIELDS) {
  const hits = (libRs.match(new RegExp(`${f}[\\s\\S]{0,80}?\\.remove\\(`, "g")) || []).length;
  check(`${f} has at least one removal site`, hits >= 1, `${hits} found`);
}

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
