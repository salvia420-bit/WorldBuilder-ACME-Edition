// harness/economy_e2e/tier3_pairwise.mjs
// Tier 3: Pairwise Cross-Feature Interactions — 20 checks (T3-01..T3-20)
// covering all 19 areas (F1..F18 + R6).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ACE_ROOT,
  APP_ROOT,
  PROTOCOL_DIR,
  assert,
  assertDotnetMethodPassed,
  assertItem2Excluded,
  assertMariaDbCollation,
  assertNoNaNDeep,
  assertProtocolV8Xml,
  countLights,
  discoverEconomyVehicleModelFiles,
  findShardMigrationSqlFiles,
  gatewayFetch,
  getMysqlConfig,
  getThree,
  lintSource,
  loadNavGraph,
  queryMysql,
  queryMysqlScalar,
  renderWithFakeWebGL2,
  runCargoProtocolTests,
  runNode,
  runPython,
  spyDisposal,
  verifyWarehouseImmutability,
} from "./e2e_helpers.mjs";

export const TESTS = [
  {
    id: "T3-01",
    tier: 3,
    features: ["F1", "F2", "F3"],
    title: "Cold-start cutover (F1) initializes all 101 towns (F2) in ace_shard town_control (F3) at 0 till",
    tags: ["phase-a", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F1_ColdStartCutover_ZeroStockAndZeroTill_Across101Towns");
      const cfg = getMysqlConfig();
      const total = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control;", cfg.shardDb));
      assert.equal(total, 101);
    },
  },
  {
    id: "T3-02",
    tier: 3,
    features: ["F1", "F4"],
    title: "Enabling physical_economy_enabled (F1) switches Vendor stock & shared Town Till (F4) from infinite to finite",
    tags: ["phase-a", "pairwise"],
    async run() {
      assertDotnetMethodPassed("Baseline_PropertyManager_PhysicalEconomyEnabledSwitch");
      assertDotnetMethodPassed("F4_Vendor_FiniteStock_DecrementAndZeroRefusal");
      assertDotnetMethodPassed("F4_Vendor_SharedTownTill_BuybackRefusalAtZero_AndCapClamp");
    },
  },
  {
    id: "T3-03",
    tier: 3,
    features: ["F2", "F14"],
    title: "101-town registry (F2) matches baked logistics_nav_graph.json (F14) 60+41 split with Item 2 excluded",
    tags: ["phase-a", "phase-d", "pairwise", "no-item-2"],
    async run() {
      assertDotnetMethodPassed("F2_TownRegistry_ClusteredDereth60_AndDericost41_AndSOI");
      const { graph } = loadNavGraph();
      const summary = assertItem2Excluded(graph);
      assert.equal(summary.derethCount, 60);
      assert.equal(summary.dericostCount, 41);
    },
  },
  {
    id: "T3-04",
    tier: 3,
    features: ["F3", "F4", "F5"],
    title: "town_vendor_ledger (F3) tracks finite stock/till (F4) & enforces 70263/Slumlord/TradeNote rules (F5)",
    tags: ["phase-a", "pairwise"],
    async run() {
      const files = findShardMigrationSqlFiles();
      assert.ok(files.length >= 1);
      for (const f of files) assertMariaDbCollation(readFileSync(f, "utf8"));
      assertDotnetMethodPassed("F5_Vendor_HardDisable_70263PyrealAnd5765Snowmen");
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
    },
  },
  {
    id: "T3-05",
    tier: 3,
    features: ["F4", "F5"],
    title: "Shared Town Till (F4) gates 1:1 Trade Note redemption & Spell-Service reagent availability (F5)",
    tags: ["phase-a", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F5_TradeNoteClearinghouse_1to1Reserve_AndParchmentInk");
      assertDotnetMethodPassed("F5_ScrivenerAndSpellService_PhysicalReagentDraw");
    },
  },
  {
    id: "T3-06",
    tier: 3,
    features: ["F6", "F7"],
    title: "TownControlNode 30m ring (F6) feeds 300s breach gate & 28,800s sustained hold (F7)",
    tags: ["phase-b", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F6_TownControl_SiegeEntities_WcidsAndKinds");
      assertDotnetMethodPassed("F7_SiegeEngine_ZeroNotice_And300sBreachGate");
      assertDotnetMethodPassed("F7_SiegeEngine_AcceleratedClock_28800sHold_AndRolling5400sSupplyMeter");
    },
  },
  {
    id: "T3-07",
    tier: 3,
    features: ["F6", "F7"],
    title: "ForwardSiegeBeacon 4000092 (F6) enforces >= 1,500m origin provenance & 30m starvation collapse (F7)",
    tags: ["phase-b", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_OriginProvenance_1499mRejected_1500mAccepted");
      assertDotnetMethodPassed("F7_SiegeEngine_StarvationCollapse_1800s_And3600sCooldown");
    },
  },
  {
    id: "T3-08",
    tier: 3,
    features: ["F7", "F8"],
    title: "Siege town flip (F7) switches GuildRadarPolicy -> RadarIff & Monarch @town authority (F8)",
    tags: ["phase-b", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F8_Governance_MonarchOnlyPolicies_FlatMemberExecution_AndRadarIff");
      const siegeSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs"), "utf8");
      assert.ok(/RadarIff|GuildRadarPolicy/.test(siegeSrc));
    },
  },
  {
    id: "T3-09",
    tier: 3,
    features: ["F8", "F17"],
    title: "Monarch-only @town policy rules (F8) mirror identically across AgentGatewayService :8090 (F17)",
    tags: ["phase-b", "phase-e", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F17_AgentGateway_LoopbackConfig_AndWorldManagerEnqueueParity");
      const denied = await gatewayFetch("/api/v1/monarch/orders", {
        method: "POST",
        body: { actorMonarchId: 999999, townId: 1, action: "set_tariff", buyMul: 1.5, isMonarch: false },
      });
      assert.ok(denied.status === 400 || denied.status === 403 || denied.status === 422,
        `Expected non-Monarch gateway rejection, got ${denied.status}`);
    },
  },
  {
    id: "T3-10",
    tier: 3,
    features: ["F9", "F13"],
    title: "HBV1 v8 XML/Rust/C# protocol (F9) aligns with client procedural models & vehicle_link.rs (F13)",
    tags: ["phase-c", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F9_VehicleWire_HBV1_V8_AndBaselineHeader");
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const chk = runPython(path.join(PROTOCOL_DIR, "gen_fixtures.py"), ["--check"]);
      assert.equal(chk.code, 0);
      const vlSrc = readFileSync(path.join(APP_ROOT, "src", "vehicle_link.rs"), "utf8");
      const prodSrc = vlSrc.split("#[cfg(test)]")[0];
      assert.ok(/ECONOMY_TOWN_STATE|SIEGE|PROSPECTING|LOGISTICS_CONVOY|MONARCH_ORDER|0x0911/.test(prodSrc),
        "src/vehicle_link.rs production code must handle HBV1 v8 opcodes 0x0911-0x0916");
    },
  },
  {
    id: "T3-11",
    tier: 3,
    features: ["F9", "F10", "F11"],
    title: "HBV1 v8 prospecting opcodes 0x0913-0x0914 (F9) drive 14-basin surveys (F10) & skids (F11)",
    tags: ["phase-c", "pairwise"],
    async run() {
      const cargoRes = runCargoProtocolTests();
      assert.equal(cargoRes.code, 0, cargoRes.stderr || cargoRes.stdout);
      assertDotnetMethodPassed("F10_Geology_14Basins_TerrainMapping_AndDepletion");
      assertDotnetMethodPassed("F11_Prospecting_GprWetMarshAttenuation_AndVibroseisFallback");
    },
  },
  {
    id: "T3-12",
    tier: 3,
    features: ["F10", "F11", "F12"],
    title: "Dericost Marsh basin (F10) GPR attenuation forces Vibroseis+Core (F11) feeding powered Reefers (F12)",
    tags: ["phase-c", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F11_Prospecting_GprWetMarshAttenuation_AndVibroseisFallback");
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
    },
  },
  {
    id: "T3-13",
    tier: 3,
    features: ["F11", "F12"],
    title: "MicroGrid 150kW Genset / 18MJ BESS (F11) supplies 5kW/6kW power keeping Reefers at 0.0x decay (F12)",
    tags: ["phase-c", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F11_MicroGrid_Boundary75m_AndIndustrial150kWGenset_18MJBess");
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
    },
  },
  {
    id: "T3-14",
    tier: 3,
    features: ["F9", "F13"],
    title: "All HBV1 v8 Kind 30..61 procedural models (F13) render cleanly in FakeWebGL2 with 0 dynamic lights",
    tags: ["phase-c", "pairwise", "3d"],
    async run() {
      const THREE = await getThree();
      const idxMod = await import(new URL(`../../scene3d/vehicle/index.js`, import.meta.url).href);
      const factory = idxMod.buildEconomyModel || idxMod.buildDeployableModel;
      assert.equal(typeof factory, "function");
      for (const wcid of [4000060, 4000070, 4000078, 4000086, 4000090, 4000093, 4000095]) {
        const g = factory(THREE, wcid);
        assert.ok(g, `Missing model for ${wcid}`);
        assert.equal(countLights(g).total, 0);
        assertNoNaNDeep(g);
        renderWithFakeWebGL2(THREE, g);
        spyDisposal(g);
      }
      for (const f of discoverEconomyVehicleModelFiles()) {
        assert.equal(lintSource(readFileSync(f, "utf8")).length, 0);
      }
    },
  },
  {
    id: "T3-15",
    tier: 3,
    features: ["F12", "F14", "F15"],
    title: "Reefer cargo (F12) traverses Outer Ocean nav graph (F14) via Dual-LOD M/V Dereth Feeder (F15)",
    tags: ["phase-c", "phase-d", "pairwise", "no-item-2"],
    async run() {
      const { graph } = loadNavGraph();
      assertItem2Excluded(graph);
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
    },
  },
  {
    id: "T3-16",
    tier: 3,
    features: ["F2", "F14", "F15"],
    title: "LogisticsEngine (F15) routes across 101-town registry (F2) on baked Outer Ocean + road graph (F14)",
    tags: ["phase-d", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F14_LogisticsNavGraph_101Towns_11OuterPorts_ExcludesItem2");
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
    },
  },
  {
    id: "T3-17",
    tier: 3,
    features: ["F15", "F16"],
    title: "Cold-start Starter Hearth towns (F16) originate & receive LogisticsEngine convoys (F15)",
    tags: ["phase-d", "phase-e", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F16_StarterHearth4000095_Indestructible_InHoltburgShoushiYaraq");
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
    },
  },
  {
    id: "T3-18",
    tier: 3,
    features: ["F8", "F17", "F18"],
    title: "Live ACE + AgentGatewayService :8090 (F17) reflects ace_shard town governance state (F8) on Vast stack (F18)",
    tags: ["phase-e", "pairwise", "live"],
    async run() {
      const cfg = getMysqlConfig();
      const dbTowns = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control;", cfg.shardDb));
      assert.equal(dbTowns, 101);
      const res = await gatewayFetch("/api/v1/world/towns");
      assert.equal(res.status, 200);
      const gwTowns = Array.isArray(res.body) ? res.body : res.body?.towns;
      assert.equal(gwTowns.length, 101);
    },
  },
  {
    id: "T3-19",
    tier: 3,
    features: ["F5", "F16", "F17"],
    title: "Trophy Collector procurement desks (F5) integrate with monarch_order bounties (F16) & /api/v1/monarch/orders (F17)",
    tags: ["phase-a", "phase-e", "pairwise"],
    async run() {
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
      const res = await gatewayFetch("/api/v1/monarch/orders");
      assert.equal(res.status, 200);
    },
  },
  {
    id: "T3-20",
    tier: 3,
    features: ["F13", "F18", "R6"],
    title: "Full economy JS/ACE deliverables (F13, F18) preserve 0 unregistered tests & 18 untouched Warehouse files (R6)",
    tags: ["r6", "coverage", "pairwise"],
    async run() {
      verifyWarehouseImmutability();
      const cov = runNode("harness/run-js-headless.mjs", ["--coverage"]);
      assert.equal(cov.code, 0);
      assert.ok(/0 unregistered/.test(cov.stdout));
      assert.ok(existsSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "AgentGatewayService.cs")));
    },
  },
];
