// harness/test_page_resample_texref.mjs — PAGE-RESAMPLE (T22 D2), client half.
//
// The bake now declares FULL-TIER dims in the TEXREF row and marks
// page-resampled members with `FULL_PAGE_DIMS` (bit 5). `texRefPageInfo()`
// in `scene3d/bc7_textures.js` is the ONE client-side decode of that row, so
// the pool producer and any other consumer read the same thing.
//
// What this battery is defending, specifically:
//   * the bit is the authority, the dims byte is not (the non-pow2 case);
//   * an unarmed seam reads null, so nothing here can affect the OFF arm;
//   * the counters move, so a bake regression is visible in `__texStats`
//     rather than only in a pack report nobody reads at runtime.
//
// Run: node harness/test_page_resample_texref.mjs   (from apps/holtburger-web)

import {
  texRefPageInfo,
  texStats,
  bc7Stats,
  initTexCompressedOnly,
  _resetTexCompressedOnlyForTest,
  TIER_BIT_PVW_PRESENT,
  TIER_BIT_FULL_XU7_PRESENT,
  TIER_BIT_FULL_PAGE_DIMS,
} from "../scene3d/bc7_textures.js";
import { pageDimsOf, needsResample, PAGE_TIER_MIN, PAGE_TIER_MAX }
  from "../scene3d/pool_class_key.js";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass += 1; } else { fail += 1; console.error(`  FAIL ${name}`); }
}
function eq(name, got, want) {
  ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`,
    JSON.stringify(got) === JSON.stringify(want));
}

/** Encode a TEXREF row the way `pack_texref` hands it over. */
function packed(tierBits, log2w, log2h) {
  return ((tierBits & 0xff) << 8) | (((log2w & 0x0f) << 4) | (log2h & 0x0f));
}

function arm(rows) {
  _resetTexCompressedOnlyForTest();
  initTexCompressedOnly({
    wasmNs: {
      surface_meta_sync: () => "",
      pack_pvw_blocks: () => new Uint8Array(0),
      pack_texref: (rs) => (rs in rows ? rows[rs] : -1),
    },
    controller: { armed: true },
  });
}

// --- PART 1: unarmed seam is inert -----------------------------------------
_resetTexCompressedOnlyForTest();
eq("P1 unarmed reads null", texRefPageInfo(0x06003789), null);

// --- PART 2: an on-page row decodes to its page -----------------------------
const ON = TIER_BIT_PVW_PRESENT | TIER_BIT_FULL_XU7_PRESENT | TIER_BIT_FULL_PAGE_DIMS;
arm({
  0x06003789: packed(ON, 11, 11),               // 2048² page
  0x0600378B: packed(ON, 8, 8),                 // 256² page
  // OFF-page: a 512x1024 full tier, page would be 1024².
  0x060037EE: packed(TIER_BIT_PVW_PRESENT | TIER_BIT_FULL_XU7_PRESENT, 9, 10),
  // The LOSSY case: 1096² rounds to 2^11 x 2^11 and LOOKS like a real page,
  // but the bake did not set the bit because the payload is not page-sized.
  0x06001096: packed(TIER_BIT_PVW_PRESENT | TIER_BIT_FULL_XU7_PRESENT, 11, 11),
  // Legacy lane: a TEXREF row with no full tier at all.
  0x06000042: packed(TIER_BIT_PVW_PRESENT, 7, 7),
});

const a = texRefPageInfo(0x06003789);
ok("P2 on-page row is onPage", a.onPage === true);
eq("P2 on-page dims", [a.w, a.h], [2048, 2048]);
ok("P2 on-page hasFullTier", a.hasFullTier === true);
ok("P2 on-page hasPreview", a.hasPreview === true);
const b = texRefPageInfo(0x0600378B);
eq("P2 256 page dims", [b.w, b.h], [256, 256]);
ok("P2 256 page onPage", b.onPage === true);

// --- PART 3: the bit is the authority, not the byte -------------------------
const lossy = texRefPageInfo(0x06001096);
ok("P3 1096-shaped row decodes to a page-SHAPED byte", lossy.w === 2048 && lossy.h === 2048);
ok("P3 ... but is NOT reported on-page", lossy.onPage === false);
ok("P3 a consumer trusting the byte alone would be wrong",
  lossy.w === lossy.h
  && Math.log2(lossy.w) >= PAGE_TIER_MIN && Math.log2(lossy.w) <= PAGE_TIER_MAX
  && lossy.onPage === false);

// --- PART 4: an off-page row, cross-checked against the class key ------------
const off = texRefPageInfo(0x060037EE);
ok("P4 off-page row is not onPage", off.onPage === false);
eq("P4 off-page declared dims", [off.w, off.h], [512, 1024]);
const rec = { hasTex: true, texW: off.w, texH: off.h };
eq("P4 pool_class_key agrees it needs a resample", needsResample(rec), true);
eq("P4 pool_class_key's page for it", pageDimsOf(rec), { width: 1024, height: 1024 });
// And the on-page row must satisfy the predicate the pools will apply.
const recOn = { hasTex: true, texW: a.w, texH: a.h };
eq("P4 on-page row satisfies needsResample=false", needsResample(recOn), false);

// --- PART 5: legacy lane + absent rows --------------------------------------
const legacy = texRefPageInfo(0x06000042);
ok("P5 legacy row has no full tier", legacy.hasFullTier === false);
ok("P5 legacy row is off-page (128² < the 256² floor)", legacy.onPage === false);
eq("P5 absent rsId reads null", texRefPageInfo(0x06009999), null);

// --- PART 6: counted, and surfaced where the registry says ------------------
const cov = texStats().coverage;
ok("P6 coverage carries the two counters",
  typeof cov.texRefOnPage === "number" && typeof cov.texRefOffPage === "number");
ok("P6 on-page reads counted", cov.texRefOnPage === 2);
ok("P6 off-page reads counted", cov.texRefOffPage === 3);
ok("P6 null reads are NOT counted",
  cov.texRefOnPage + cov.texRefOffPage === 5); // P2..P5 non-null reads only (2 on + 3 off)
const before = bc7Stats().texRefOffPage;
texRefPageInfo(0x060037EE);
ok("P6 the tally is a read tally, not a distinct-rsId tally",
  bc7Stats().texRefOffPage === before + 1);

// --- PART 7: the tier-bit constants mirror pack_format.rs -------------------
eq("P7 PVW_PRESENT", TIER_BIT_PVW_PRESENT, 1);
eq("P7 FULL_XU7_PRESENT", TIER_BIT_FULL_XU7_PRESENT, 2);
eq("P7 FULL_PAGE_DIMS", TIER_BIT_FULL_PAGE_DIMS, 32);

_resetTexCompressedOnlyForTest();
console.log(`PAGE-RESAMPLE-TEXREF: ${pass} passed, ${fail} failed`);
console.log(fail === 0 ? "PAGE-RESAMPLE-TEXREF ✅" : "PAGE-RESAMPLE-TEXREF ❌");
process.exit(fail === 0 ? 0 : 1);
