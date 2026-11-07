/**
 * Tier 1: Feature 4 — Dericost Spatial Placement (North Gap)
 * Coordinate bounds: Departure Y=48,960m, Gap=19,968m (104 LBs), Landfall Y=68,928m, Polar Y=117,888m.
 * CDLOD quadtree root enclosure check: [-73,728m, +122,880m].
 * Sources: ORIGINAL_REQUEST §R2, PROJECT.md §Architecture, Survey 3 §2.2 & §4.1
 */

const { createSuite, assert, assertEquals, assertNear, CONSTANTS } = require('../harness.cjs');

const suite = createSuite('Tier 1: Feature 4 - Dericost Spatial Placement (North Gap)', 1);

suite.addTest('F4.1: Dereth North Shore departure coordinate is 48,960.0 meters', () => {
  // Authoritative derivation: 255 LBs * 192.0 m = 48,960.0 m (lbY = 255)
  assertEquals(CONSTANTS.DERETH_NORTH_SHORE_Y, 48960.0, 'Departure coordinate must be Y=48,960.0 m');
  const departureLB = CONSTANTS.DERETH_NORTH_SHORE_Y / CONSTANTS.LB_SIZE;
  assertEquals(departureLB, 255, 'Departure landblock boundary must be 255');
});

suite.addTest('F4.2: Ocean transit corridor spans exactly 104 landblocks (19,968.0 meters)', () => {
  // Authoritative derivation: 104 * 192.0 = 19,968.0 m
  assertEquals(CONSTANTS.OCEAN_GAP_LBS, 104, 'Gap must be exactly 104 landblocks');
  assertEquals(CONSTANTS.OCEAN_GAP_METERS, 19968.0, 'Gap must be exactly 19,968.0 meters');
  const derivedMeters = CONSTANTS.OCEAN_GAP_LBS * CONSTANTS.LB_SIZE;
  assertEquals(derivedMeters, CONSTANTS.OCEAN_GAP_METERS);
});

suite.addTest('F4.3: Dericost South Shore landfall coordinate is 68,928.0 meters', () => {
  // Authoritative derivation: 48,960.0 + 19,968.0 = 68,928.0 m
  const landfallY = CONSTANTS.DERETH_NORTH_SHORE_Y + CONSTANTS.OCEAN_GAP_METERS;
  assertEquals(landfallY, 68928.0, 'Landfall must be at Y = 68,928.0 meters');
  assertEquals(CONSTANTS.DERICOST_SOUTH_SHORE_Y, 68928.0);
  const landfallLB = landfallY / CONSTANTS.LB_SIZE;
  assertEquals(landfallLB, 359, 'Landfall landblock index must be 359 (255 + 104)');
});

suite.addTest('F4.4: Dericost Northern polar boundary is 117,888.0 meters', () => {
  // Authoritative derivation: 68,928.0 + 48,960.0 = 117,888.0 m
  const polarY = CONSTANTS.DERICOST_SOUTH_SHORE_Y + CONSTANTS.WORLD_METERS;
  assertEquals(polarY, 117888.0, 'Northern polar boundary must be Y = 117,888.0 meters');
  assertEquals(CONSTANTS.DERICOST_NORTH_BOUND_Y, 117888.0);
  const polarLB = polarY / CONSTANTS.LB_SIZE;
  assertEquals(polarLB, 614, 'Polar boundary landblock index must be 614 (359 + 255)');
});

suite.addTest('F4.5: Full Dericost coordinate span fits strictly within CDLOD root quadtree', () => {
  // Authoritative derivation: ROOT_ORIGIN = -73,728.0 m, ROOT_SPAN = 196,608.0 m, ROOT_MAX = +122,880.0 m
  // Dericost max Y is 117,888.0 m <= 122,880.0 m
  const cdlodMax = CONSTANTS.CDLOD_ROOT_ORIGIN + CONSTANTS.CDLOD_ROOT_SPAN;
  assertEquals(cdlodMax, CONSTANTS.CDLOD_ROOT_MAX, 'CDLOD quadtree ceiling must be 122,880.0 m');
  assert(CONSTANTS.DERICOST_NORTH_BOUND_Y <= CONSTANTS.CDLOD_ROOT_MAX,
    `Dericost north bound (${CONSTANTS.DERICOST_NORTH_BOUND_Y}m) must be <= CDLOD max (${CONSTANTS.CDLOD_ROOT_MAX}m)`);
  const safetyMarginMeters = CONSTANTS.CDLOD_ROOT_MAX - CONSTANTS.DERICOST_NORTH_BOUND_Y;
  assertEquals(safetyMarginMeters, 4992.0, 'Safety margin between Dericost polar bound and CDLOD edge must be 4,992.0m (26 LBs)');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
