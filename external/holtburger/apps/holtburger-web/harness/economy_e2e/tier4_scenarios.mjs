// harness/economy_e2e/tier4_scenarios.mjs
// Tier 4: Real-World End-to-End Application Scenarios — 6 scenarios (T4-01..T4-06).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ACE_PATCH_DIR,
  ACE_ROOT,
  APP_ROOT,
  ECONOMY_TABLES,
  assert,
  assertDotnetMethodPassed,
  assertItem2Excluded,
  bootLiveClient,
  countLights,
  discoverEconomyVehicleModelFiles,
  gatewayFetch,
  gatewayWs,
  getMysqlConfig,
  getThree,
  loadNavGraph,
  probeTcpPort,
  queryMysql,
  queryMysqlScalar,
  runCargoProtocolTests,
  runNode,
  runWarehouseE2E,
  runWarehouseUnitTests,
  verifyWarehouseImmutability,
} from "./e2e_helpers.mjs";

export const TESTS = [
  {
    id: "T4-01",
    tier: 4,
    features: ["F1", "F2", "F3", "F4", "F5", "F11", "F16"],
    title: "S1: Day-1 Cold-Start Bootstrap (Rung 0 -> Rung 3) from 0 stock/0 till via Starter Hearth, Solar, Drilling & Finite Vendors",
    tags: ["scenario", "cold-start"],
    async run() {
      // 1. Verify global config switch & 101-town 0-till cutover
      assertDotnetMethodPassed("Baseline_PropertyManager_PhysicalEconomyEnabledSwitch");
      assertDotnetMethodPassed("F1_ColdStartCutover_ZeroStockAndZeroTill_Across101Towns");
      // 2. Verify Starter Hearth (4000095) in Holtburg, Shoushi, Yaraq
      assertDotnetMethodPassed("F16_StarterHearth4000095_Indestructible_InHoltburgShoushiYaraq");
      // 3. Verify Rung 2 Solar (50 kW) -> GPR/CoreDrill/Assay -> Genset (150 kW) / BESS (18 MJ) power loop
      assertDotnetMethodPassed("F11_MicroGrid_Boundary75m_AndIndustrial150kWGenset_18MJBess");
      // 4. Verify finite vendor stock, 0-till buyback refusal, 70263 exploit block, Slumlord rent, Trophy procurement
      assertDotnetMethodPassed("F4_Vendor_FiniteStock_DecrementAndZeroRefusal");
      assertDotnetMethodPassed("F4_Vendor_SharedTownTill_BuybackRefusalAtZero_AndCapClamp");
      assertDotnetMethodPassed("F5_Vendor_HardDisable_70263PyrealAnd5765Snowmen");
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
    },
  },
  {
    id: "T4-02",
    tier: 4,
    features: ["F4", "F5", "F6", "F7", "F8"],
    title: "S2: 8-Hour Sustained-Supply Siege, Supply Interdiction, Starvation Collapse & 50/50 Vault Spoils",
    tags: ["scenario", "siege"],
    async run() {
      assertDotnetMethodPassed("F6_TownControl_SiegeEntities_WcidsAndKinds");
      assertDotnetMethodPassed("F7_SiegeEngine_ZeroNotice_And300sBreachGate");
      assertDotnetMethodPassed("F7_SiegeEngine_OriginProvenance_1499mRejected_1500mAccepted");
      assertDotnetMethodPassed("F7_SiegeEngine_StarvationCollapse_1800s_And3600sCooldown");
      assertDotnetMethodPassed("F7_SiegeEngine_AcceleratedClock_28800sHold_AndRolling5400sSupplyMeter");
      assertDotnetMethodPassed("F7_SiegeEngine_ThreeWayReset_And72hInsolvencyReceivership");
      assertDotnetMethodPassed("F8_Governance_MonarchOnlyPolicies_FlatMemberExecution_AndRadarIff");
    },
  },
  {
    id: "T4-03",
    tier: 4,
    features: ["F2", "F9", "F10", "F11", "F12", "F14", "F15"],
    title: "S3: Dereth <-> Dericost Outer Ocean Reefer Supply Chain (Dericost Marsh -> 22R1/45R1 -> M/V Dereth Feeder -> NE Terminal, No Item 2)",
    tags: ["scenario", "cold-chain", "maritime", "no-item-2"],
    async run() {
      // 1. Verify HBV1 v8 Rust + C# protocol
      const cargoRes = runCargoProtocolTests();
      assert.equal(cargoRes.code, 0, cargoRes.stderr || cargoRes.stdout);
      assertDotnetMethodPassed("F9_VehicleWire_HBV1_V8_AndBaselineHeader");
      // 2. Verify 14 basins & Dericost Marsh GPR EM attenuation -> Vibroseis fallback
      assertDotnetMethodPassed("F10_Geology_14Basins_TerrainMapping_AndDepletion");
      assertDotnetMethodPassed("F11_Prospecting_GprWetMarshAttenuation_AndVibroseisFallback");
      // 3. Verify Cold-Chain 2-6h ambient decay vs 0.0x powered Reefer freeze
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
      // 4. Verify baked Outer Ocean nav graph & Dual-LOD LogisticsEngine (strictly excluding Item 2)
      const { graph } = loadNavGraph();
      assertItem2Excluded(graph);
      assertDotnetMethodPassed("F14_LogisticsNavGraph_101Towns_11OuterPorts_ExcludesItem2");
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
    },
  },
  {
    id: "T4-04",
    tier: 4,
    features: ["F8", "F9", "F13", "F15", "F17", "F18"],
    title: "S4: Unified Human + AI Agent Gateway (127.0.0.1:8090): Auth, All 7 Routes, Physical Validation Parity & WS Alerts",
    tags: ["scenario", "gateway", "live"],
    async run() {
      // 1. Unauthenticated must 401/403
      const unauth = await gatewayFetch("/api/v1/world/towns", { token: null });
      assert.ok(unauth.status === 401 || unauth.status === 403, `Expected 401/403 without token, got ${unauth.status}`);

      // 2. Query all 7 read endpoints
      for (const route of [
        "/api/v1/world/towns",
        "/api/v1/town/1/ledger",
        "/api/v1/town/1/siege",
        "/api/v1/geology/surveys",
        "/api/v1/logistics/routes",
        "/api/v1/logistics/convoys",
        "/api/v1/monarch/orders",
      ]) {
        const resp = await gatewayFetch(route);
        assert.equal(resp.status, 200, `Gateway ${route} returned ${resp.status}: ${resp.raw}`);
      }

      // 3. Physical validation parity: 1,499 m provenance + 0 fuel + non-Monarch policy must reject
      const badConvoy = await gatewayFetch("/api/v1/logistics/convoys", {
        method: "POST",
        body: { townId: 1, originLandblockId: 0xA9B4, distanceM: 1499, fuelLiters: 0, action: "deliver_siege_supply" },
      });
      assert.ok(badConvoy.status === 400 || badConvoy.status === 422 || badConvoy.status === 403,
        `Expected physical rejection, got ${badConvoy.status}`);

      // 4. WebSocket connection + real-time alert verification (siege_started / supply_low / convoy_interdicted / town_flipped)
      const ALLOWED_ALERTS = new Set(["siege_started", "supply_low", "convoy_interdicted", "town_flipped"]);
      const wsConn = await gatewayWs();
      try {
        assert.equal(wsConn.ws.readyState, 1, "Gateway WebSocket must be OPEN");
        // Subscribe / trigger an alert event via gateway action or test alert endpoint and verify live WS broadcast
        const trig = await gatewayFetch("/api/v1/town/1/siege", {
          method: "POST",
          body: { action: "probe_alert", alertType: "supply_low", townId: 1 },
        });
        if (trig.status >= 200 && trig.status < 300) {
          // Wait for real-time alert broadcast when trigger is accepted
          const ev = await wsConn.waitForEvent(
            (msg) => msg && typeof msg === "object" && ALLOWED_ALERTS.has(msg.type || msg.event || msg.alertType),
            5000
          );
          const kind = ev.type || ev.event || ev.alertType;
          assert.ok(ALLOWED_ALERTS.has(kind), `Unexpected WS alert type: ${kind}`);
        } else {
          // Wait for any real-time alert emitted by simulation/test event or fail if none arrive
          const ev = await wsConn.waitForEvent(
            (msg) => msg && typeof msg === "object" && ALLOWED_ALERTS.has(msg.type || msg.event || msg.alertType),
            5000
          );
          const kind = ev.type || ev.event || ev.alertType;
          assert.ok(ALLOWED_ALERTS.has(kind), `Unexpected WS alert type: ${kind}`);
        }
      } finally {
        wsConn.close();
      }
    },
  },
  {
    id: "T4-05",
    tier: 4,
    features: ["F18", "R6"],
    title: "S5: Automated Warehouse Immutability (18 SHA256 + git diff), 4 Unit Tests, 143-Check Warehouse E2E, Coverage & ACE Patches",
    tags: ["scenario", "r6", "regression"],
    async run() {
      verifyWarehouseImmutability();
      runWarehouseUnitTests();
      const we2e = runWarehouseE2E(["--tier=all", "--json"]);
      const parsed = JSON.parse(we2e.stdout);
      assert.equal(parsed.passed, 143);
      assert.equal(parsed.failed, 0);

      const cov = runNode("harness/run-js-headless.mjs", ["--coverage"]);
      assert.equal(cov.code, 0);
      assert.ok(/0 unregistered/.test(cov.stdout));

      assert.ok(existsSync(ACE_PATCH_DIR));
      const post25 = readdirSync(ACE_PATCH_DIR).filter((f) => /^\d{4}-.*\.patch$/.test(f) && Number(f.slice(0, 4)) >= 26);
      assert.ok(post25.length >= 1, "Expected ACE patches >= 0026 exported");
    },
  },
  {
    id: "T4-06",
    tier: 4,
    features: ["F13", "F17", "F18"],
    title: "S6: Live Vast Stack (:3306/:8080/:8765/:8090) + Headless Chromium Client Boot to in-world with 0 Console/Page Errors",
    tags: ["scenario", "live", "browser"],
    async run() {
      // 1. Verify live TCP ports & MariaDB 7 tables
      for (const port of [3306, 8080, 8765, 8090]) {
        const probe = await probeTcpPort("127.0.0.1", port);
        assert.ok(probe.ok, `Live service port :${port} not listening (${probe.detail})`);
      }
      const cfg = getMysqlConfig();
      const tables = queryMysql(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN (${ECONOMY_TABLES.map((t) => `'${t}'`).join(",")});`
      );
      assert.equal(tables.length, ECONOMY_TABLES.length, "Expected all 7 ace_shard economy tables live");

      // 2. Verify offscreen 0-light procedural models
      const THREE = await getThree();
      const files = discoverEconomyVehicleModelFiles();
      assert.ok(files.length > 0, "Expected new procedural economy model files");
      const idxMod = await import(new URL(`../../scene3d/vehicle/index.js`, import.meta.url).href);
      const factory = idxMod.buildEconomyModel || idxMod.buildDeployableModel;
      if (typeof factory === "function") {
        assert.equal(countLights(factory(THREE, 4000090)).total, 0);
      }

      // 3. Boot headless Chromium against live ACE :9000 via wsbridge :8080 & serve.py :8765
      const boot = await bootLiveClient({}, {
        onInWorld: async (page) => {
          await page.waitForFunction(
            () => Boolean(window.__vehicles) && (window.__vehicles.status?.()?.caps?.granted ?? null) !== null,
            null,
            { timeout: 30000 }
          );
          return page.evaluate(() => ({
            hasVehicles: Boolean(window.__vehicles),
            capsGranted: window.__vehicles?.status?.()?.caps?.granted ?? null,
            pose: window.__sessionHandle?.getLocalPlayerPose?.() || null,
          }));
        },
      });
      assert.ok(
        Array.isArray(boot.bootState?.history) && boot.bootState.history.some((e) => e && e.state === "in-world"),
        `Expected "in-world" transition in bootState.history: ${JSON.stringify(boot.bootState)}`
      );
      assert.ok(
        boot.bootState?.bootState === "in-world" || boot.bootState?.bootState === "ready",
        `Expected bootState "in-world" or "ready", got ${JSON.stringify(boot.bootState?.bootState)}`
      );
      assert.equal(boot.evalResult?.hasVehicles, true, "Expected window.__vehicles initialized in-world");
      assert.equal((boot.evalResult?.capsGranted & 0x03), 0x03,
        `Expected HBV1 capability ack (CapObserve|CapPilot = 0x03), got ${boot.evalResult?.capsGranted}`);
      assert.equal(boot.pageErrors.length, 0, `Unexpected page errors: ${boot.pageErrors.join("; ")}`);
      assert.equal(boot.filtered.failing.length, 0);
    },
  },
];
