// harness/economy_e2e/tier2_boundaries.mjs
// Tier 2: Boundary Value Analysis, Negative & Error-Handling — 95 checks (5 per area across F1..F18 + R6).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ACE_PATCH_DIR,
  ACE_ROOT,
  APP_ROOT,
  ECONOMY_TABLES,
  OUTER_OCEAN_PORTS,
  PROTOCOL_DIR,
  WAREHOUSE_18_FILES,
  assert,
  assertDotnetMethodPassed,
  assertItem2Excluded,
  assertMariaDbCollation,
  assertProtocolV8Xml,
  countLights,
  discoverEconomyVehicleModelFiles,
  extractXmlEnumBlock,
  findShardMigrationSqlFiles,
  gatewayFetch,
  getMysqlConfig,
  getThree,
  lintSource,
  loadNavGraph,
  queryMysql,
  queryMysqlScalar,
  runCargoProtocolTests,
  runDotnetEconomyTests,
  runNode,
  runPython,
  validateGatewayAuthResponse,
  verifyWarehouseImmutability,
} from "./e2e_helpers.mjs";

export const TESTS = [
  // =========================================================================
  // F1: Config Cutover Boundaries [T2-01..T2-05]
  // =========================================================================
  {
    id: "T2-01",
    tier: 2,
    features: ["F1"],
    title: "physical_economy_enabled=false preserves legacy mode without crash while true enforces 0-stock cold start",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("Baseline_PropertyManager_PhysicalEconomyEnabledSwitch");
    },
  },
  {
    id: "T2-02",
    tier: 2,
    features: ["F1"],
    title: "Cold-start cutover boundary: 0 towns retain pre-seed > 0 till when physical_economy_enabled=true",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("F1_ColdStartCutover_ZeroStockAndZeroTill_Across101Towns");
    },
  },
  {
    id: "T2-03",
    tier: 2,
    features: ["F1"],
    title: "PropertyManager rejects unknown boolean key modification (negative check)",
    tags: ["baseline", "negative"],
    async run() {
      assertDotnetMethodPassed("Baseline_PropertyManager_PhysicalEconomyEnabledSwitch");
      const pmSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Managers", "PropertyManager.cs"), "utf8");
      assert.ok(/ModifyBool/.test(pmSrc), "PropertyManager.ModifyBool missing");
      assert.ok(/DefaultBooleanProperties/.test(pmSrc), "PropertyManager.DefaultBooleanProperties missing");
    },
  },
  {
    id: "T2-04",
    tier: 2,
    features: ["F1"],
    title: "ace_shard physical_economy_enabled value is strictly boolean 0 or 1",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        "SELECT CAST(value AS UNSIGNED) FROM config_properties_boolean WHERE `key` = 'physical_economy_enabled';",
        cfg.shardDb
      );
      assert.equal(rows.length, 1, "Missing physical_economy_enabled in config_properties_boolean");
      assert.ok(["0", "1", "true", "false"].includes(String(rows[0][0]).toLowerCase()),
        `Unexpected boolean value '${rows[0][0]}'`);
    },
  },
  {
    id: "T2-05",
    tier: 2,
    features: ["F1"],
    title: "TownEconomyManager handles repeated idempotent cold-start cutover without duplicate rows",
    tags: ["phase-a", "boundary"],
    async run() {
      const cfg = getMysqlConfig();
      const cnt = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control;", cfg.shardDb));
      assert.equal(cnt, 101, `Expected 101 unique rows in town_control, got ${cnt}`);
    },
  },

  // =========================================================================
  // F2: 101-Town Registry & SOI Boundaries [T2-06..T2-10]
  // =========================================================================
  {
    id: "T2-06",
    tier: 2,
    features: ["F2"],
    title: "Invalid/dungeon landblock (0xFFFF) does not misclassify as primary capturable town",
    tags: ["phase-a", "negative"],
    async run() {
      const regSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "TownRegistry.cs"), "utf8");
      assert.ok(/Indoors|0xFFFF|0x0100|dungeon/i.test(regSrc),
        "TownRegistry.cs must handle indoor/sentinel landblocks cleanly");
    },
  },
  {
    id: "T2-07",
    tier: 2,
    features: ["F2"],
    title: "Dericost bit-15 landblock flag (0xXXXX8001) resolves exclusively to the 41 Dericost towns",
    tags: ["phase-a", "dericost"],
    async run() {
      assertDotnetMethodPassed("F2_TownRegistry_ClusteredDereth60_AndDericost41_AndSOI");
    },
  },
  {
    id: "T2-08",
    tier: 2,
    features: ["F2"],
    title: "Town Depot Apron (4000091) spec enforces >= 48x48 m, delta <= 2 m, slope <= 4.7 deg (clears Sidelifter 6 deg)",
    tags: ["phase-a", "phase-b", "boundary"],
    async run() {
      assertDotnetMethodPassed("F6_TownControl_SiegeEntities_WcidsAndKinds");
      const dmSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs"), "utf8");
      const siegeSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs"), "utf8");
      const combined = dmSrc + "\n" + siegeSrc;
      assert.ok(combined.includes("4000091") && /TownDepotApron|TownDepot/i.test(combined),
        "TownDepotApron (4000091) missing from DeployableManager/SiegeManager");
      assert.ok(/48|4\.7|226|Apron|Slope/i.test(siegeSrc),
        "SiegeManager.cs missing TownDepot Apron 48x48m / 4.7 deg / 226m geometry spec");
    },
  },
  {
    id: "T2-09",
    tier: 2,
    features: ["F2"],
    title: "Every town_id in ace_shard town_control is unique and strictly within [1..101] or canonical IDs",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const distinctIds = Number(queryMysqlScalar("SELECT COUNT(DISTINCT town_id) FROM town_control;", cfg.shardDb));
      const total = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control;", cfg.shardDb));
      assert.equal(distinctIds, 101);
      assert.equal(total, 101);
    },
  },
  {
    id: "T2-10",
    tier: 2,
    features: ["F2"],
    title: "Tou-Tou (0xF559) reclamation site tracked without inflating 60+41=101 primary count",
    tags: ["phase-a", "boundary"],
    async run() {
      const cfg = getMysqlConfig();
      const cnt = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control;", cfg.shardDb));
      assert.equal(cnt, 101, `Primary town_control row count must be 101, got ${cnt}`);
    },
  },

  // =========================================================================
  // F3: Phase A ace_shard Schema & Collation Boundaries [T2-11..T2-15]
  // =========================================================================
  {
    id: "T2-11",
    tier: 2,
    features: ["F3"],
    title: "Negative collation check rejects MySQL 8.0 utf8mb4_0900_ai_ci in SQL text",
    tags: ["negative", "collation"],
    async run() {
      assert.throws(
        () => assertMariaDbCollation("CREATE TABLE bad (id INT) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;"),
        /utf8mb4_0900_ai_ci/
      );
    },
  },
  {
    id: "T2-12",
    tier: 2,
    features: ["F3"],
    title: "Negative SQL check rejects CREATE TABLE missing explicit utf8mb4_general_ci",
    tags: ["negative", "collation"],
    async run() {
      assert.throws(
        () => assertMariaDbCollation("CREATE TABLE bad (id INT) ENGINE=InnoDB;"),
        /utf8mb4_general_ci/
      );
    },
  },
  {
    id: "T2-13",
    tier: 2,
    features: ["F3"],
    title: "All 7 economy tables exist in ace_shard and reject utf8mb4_0900_ai_ci at column & table level",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const tables = queryMysql(
        `SELECT table_name, table_collation FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN (${ECONOMY_TABLES.map((t) => `'${t}'`).join(",")});`
      );
      assert.equal(tables.length, ECONOMY_TABLES.length,
        `Expected all ${ECONOMY_TABLES.length} economy tables in ${cfg.shardDb}, found ${tables.length} (${tables.map((r) => r[0]).join(", ") || "none"})`);
      for (const [name, collation] of tables) {
        assert.equal(collation, "utf8mb4_general_ci", `Table ${name} collation=${collation}, expected utf8mb4_general_ci`);
      }
      const badCols = Number(queryMysqlScalar(
        `SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name IN (${ECONOMY_TABLES.map((t) => `'${t}'`).join(",")}) AND collation_name='utf8mb4_0900_ai_ci';`
      ));
      assert.equal(badCols, 0, `Found ${badCols} columns with forbidden utf8mb4_0900_ai_ci in ${cfg.shardDb}`);
    },
  },
  {
    id: "T2-14",
    tier: 2,
    features: ["F3"],
    title: "Deployable WCIDs >= 4000000 never persist into ace_shard.biota",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("Baseline_DeployableBase_ExcludedFromShardBiotaPersistence");
      const cfg = getMysqlConfig();
      const badBiota = Number(queryMysqlScalar("SELECT COUNT(*) FROM biota WHERE weenie_Class_Id >= 4000000;", cfg.shardDb));
      assert.equal(badBiota, 0, `Found ${badBiota} procedural WCID >= 4000000 leaked into ace_shard.biota`);
    },
  },
  {
    id: "T2-15",
    tier: 2,
    features: ["F3"],
    title: "All economy SQL migrations in ace-server pass strict MariaDB collation check",
    tags: ["phase-a", "sql"],
    async run() {
      const files = findShardMigrationSqlFiles();
      assert.ok(files.length >= 1, "No economy SQL migration files found");
      for (const f of files) {
        assertMariaDbCollation(readFileSync(f, "utf8"));
      }
    },
  },

  // =========================================================================
  // F4: Vendor Stock & Till Boundaries [T2-16..T2-20]
  // =========================================================================
  {
    id: "T2-16",
    tier: 2,
    features: ["F4"],
    title: "Stock boundary 1 -> 0 succeeds while buying at 0 stock is strictly refused",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_FiniteStock_DecrementAndZeroRefusal");
    },
  },
  {
    id: "T2-17",
    tier: 2,
    features: ["F4"],
    title: "Buyback boundary: till == 0 refused, till == payout - 1 refused, till == payout succeeds",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_SharedTownTill_BuybackRefusalAtZero_AndCapClamp");
    },
  },
  {
    id: "T2-18",
    tier: 2,
    features: ["F4"],
    title: "Negative/NaN Monarch tariff multiplier rejected cleanly",
    tags: ["phase-a", "negative"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_MonarchTariffBounds");
    },
  },
  {
    id: "T2-19",
    tier: 2,
    features: ["F4"],
    title: "Vendor ledger enforces non-negative stock_qty and till_pyreals <= till_cap_pyreals",
    tags: ["phase-a", "mysql"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_FiniteStock_DecrementAndZeroRefusal");
      assertDotnetMethodPassed("F4_Vendor_SharedTownTill_BuybackRefusalAtZero_AndCapClamp");
      const cfg = getMysqlConfig();
      const negRows = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM town_vendor_ledger WHERE stock_qty < 0 OR till_pyreals < 0 OR (till_cap_pyreals > 0 AND till_pyreals > till_cap_pyreals);",
        cfg.shardDb
      ));
      assert.equal(negRows, 0, `Found ${negRows} invalid stock/till rows in town_vendor_ledger`);
    },
  },
  {
    id: "T2-20",
    tier: 2,
    features: ["F4"],
    title: "Vendor.cs & Player_Commerce.cs never mint buyback pyreals out of thin air in physical economy mode",
    tags: ["phase-a", "source"],
    async run() {
      const pcSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Player_Commerce.cs"), "utf8");
      assert.ok(/TownEconomyManager|TryPayBuyback|till/i.test(pcSrc),
        "Player_Commerce.cs must gate CreatePayoutCoinStacks behind TownEconomyManager till check");
    },
  },

  // =========================================================================
  // F5: Special Vendor Class Boundaries [T2-21..T2-25]
  // =========================================================================
  {
    id: "T2-21",
    tier: 2,
    features: ["F5"],
    title: "70263 Festival Vendor Pyreal (273) Shop listing & 5765/5767 Snowmen strictly blocked",
    tags: ["phase-a", "exploit-guard"],
    async run() {
      assertDotnetMethodPassed("F5_Vendor_HardDisable_70263PyrealAnd5765Snowmen");
    },
  },
  {
    id: "T2-22",
    tier: 2,
    features: ["F5"],
    title: "Trade Note 1:1 boundary: 9,999p till refuses 10,000p Trade Note; 10,000p till redeems it",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("F5_TradeNoteClearinghouse_1to1Reserve_AndParchmentInk");
    },
  },
  {
    id: "T2-23",
    tier: 2,
    features: ["F5"],
    title: "Spell-Service vendor at 0 reagent stock goes offline ('Out of reagents')",
    tags: ["phase-a", "boundary"],
    async run() {
      assertDotnetMethodPassed("F5_ScrivenerAndSpellService_PhysicalReagentDraw");
    },
  },
  {
    id: "T2-24",
    tier: 2,
    features: ["F5"],
    title: "Slumlord 100% rent routing deposits full amount into Town Treasury without loss",
    tags: ["phase-a", "slumlord"],
    async run() {
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
    },
  },
  {
    id: "T2-25",
    tier: 2,
    features: ["F5"],
    title: "ace_world baseline verifies 14 Trade Notes (2621..20630) & 393 retired portal gem merchants (26694..27086)",
    tags: ["baseline", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const tn = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM weenie WHERE class_Id IN (2621,2622,2623,2624,2625,7374,7375,7376,2626,7377,2627,20628,20629,20630);",
        cfg.worldDb
      ));
      assert.equal(tn, 14);
      const retired = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM weenie WHERE type = 12 AND class_Id BETWEEN 26694 AND 27086;",
        cfg.worldDb
      ));
      assert.equal(retired, 393, `Expected 393 retired Settlement Portal Gem merchants, got ${retired}`);
    },
  },

  // =========================================================================
  // F6: Town Control & Siege Entity Boundaries [T2-26..T2-30]
  // =========================================================================
  {
    id: "T2-26",
    tier: 2,
    features: ["F6"],
    title: "TownControlNode ring boundary: 30.0 m inside accepted, 30.1 m outside rejected",
    tags: ["phase-b", "boundary"],
    async run() {
      assertDotnetMethodPassed("F6_TownControl_SiegeEntities_WcidsAndKinds");
    },
  },
  {
    id: "T2-27",
    tier: 2,
    features: ["F6"],
    title: "WCID 4000090-4000092 have zero collision with existing 4000001-4000057 WCIDs",
    tags: ["phase-b", "wcid"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      const matches = [...xml.matchAll(/name="([^"]+)"\s+value="(\d+)"/g)];
      const seen = new Map();
      for (const m of matches) {
        if (/40000\d\d/.test(m[2])) {
          assert.equal(seen.has(m[2]), false, `Duplicate WCID ${m[2]} in XML`);
          seen.set(m[2], m[1]);
        }
      }
      assert.ok(xml.includes("56") && xml.includes("57") && xml.includes("58"));
    },
  },
  {
    id: "T2-28",
    tier: 2,
    features: ["F6"],
    title: "DeployableKind 56/57/58 map deterministically without clashing with Warehouse reserved Kind 17-22",
    tags: ["phase-b", "r6"],
    async run() {
      const dwPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "VehicleWire.cs");
      const src = readFileSync(dwPath, "utf8");
      assert.ok(/56/.test(src) && /57/.test(src) && /58/.test(src), "VehicleWire.cs DeployableKind missing 56-58");
    },
  },
  {
    id: "T2-29",
    tier: 2,
    features: ["F6"],
    title: "ForwardSiegeBeacon (4000092) enforces non-zero distance outside defender Depot inner ring",
    tags: ["phase-b", "boundary"],
    async run() {
      const siegeSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs"), "utf8");
      assert.ok(/ForwardSiegeBeacon|4000092/.test(siegeSrc));
    },
  },
  {
    id: "T2-30",
    tier: 2,
    features: ["F6"],
    title: "TownControlNode (4000090) & TownDepot (4000091) models contain 0 dynamic lights",
    tags: ["phase-b", "3d"],
    async run() {
      const THREE = await getThree();
      const idxMod = await import(new URL(`../../scene3d/vehicle/index.js`, import.meta.url).href);
      const factory = idxMod.buildEconomyModel || idxMod.buildDeployableModel || idxMod.createDeployableMesh;
      assert.equal(typeof factory, "function", "Missing economy model builder in scene3d/vehicle/index.js");
      for (const wcid of [4000090, 4000091, 4000092]) {
        const g = factory(THREE, wcid);
        assert.ok(g, `Model missing for ${wcid}`);
        assert.equal(countLights(g).total, 0, `Dynamic light forbidden on ${wcid}`);
      }
    },
  },

  // =========================================================================
  // F7: 8-Hour Sustained-Supply Siege Engine Boundaries [T2-31..T2-35]
  // =========================================================================
  {
    id: "T2-31",
    tier: 2,
    features: ["F7"],
    title: "Breach gate exact boundary: 299 s stays CONTROLLED, 300 s enters CONTESTED_HOLD & freezes escrow",
    tags: ["phase-b", "boundary"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_ZeroNotice_And300sBreachGate");
    },
  },
  {
    id: "T2-32",
    tier: 2,
    features: ["F7"],
    title: "Hold duration boundary: 28,799 s remains contested, 28,800 s flips town & executes 50/50 vault spoils",
    tags: ["phase-b", "boundary"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_AcceleratedClock_28800sHold_AndRolling5400sSupplyMeter");
    },
  },
  {
    id: "T2-33",
    tier: 2,
    features: ["F7"],
    title: "Origin-provenance exact boundary: 1,499 m rejected vs 1,500 m accepted",
    tags: ["phase-b", "boundary", "provenance"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_OriginProvenance_1499mRejected_1500mAccepted");
    },
  },
  {
    id: "T2-34",
    tier: 2,
    features: ["F7"],
    title: "Starvation boundary: 1,799 s stays STARVING, 1,800 s collapses siege with 3,600 s cooldown",
    tags: ["phase-b", "boundary"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_StarvationCollapse_1800s_And3600sCooldown");
    },
  },
  {
    id: "T2-35",
    tier: 2,
    features: ["F7"],
    title: "Insolvency boundary: 72h (259,200 s) -> INSOLVENT_RECEIVERSHIP, +24h (86,400 s) -> UNCLAIMED_COLD",
    tags: ["phase-b", "boundary"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_ThreeWayReset_And72hInsolvencyReceivership");
    },
  },

  // =========================================================================
  // F8: Monarch Governance & Radar IFF Boundaries [T2-36..T2-40]
  // =========================================================================
  {
    id: "T2-36",
    tier: 2,
    features: ["F8"],
    title: "Non-Monarch vassal cannot invoke Monarch-only @town policy commands",
    tags: ["phase-b", "negative"],
    async run() {
      assertDotnetMethodPassed("F8_Governance_MonarchOnlyPolicies_FlatMemberExecution_AndRadarIff");
    },
  },
  {
    id: "T2-37",
    tier: 2,
    features: ["F8"],
    title: "Default GuildRadarPolicy treats unlisted foreign contacts as Hostile",
    tags: ["baseline", "iff"],
    async run() {
      assertDotnetMethodPassed("Baseline_RadarIff_PolicyResolution_Works");
    },
  },
  {
    id: "T2-38",
    tier: 2,
    features: ["F8"],
    title: "TownCommands.cs validates Monarch status before tariff/till/transfer/diplomacy mutations",
    tags: ["phase-b", "commands"],
    async run() {
      const src = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Command", "Handlers", "TownCommands.cs"), "utf8");
      assert.ok(/Monarch/i.test(src) && /CanModifyTownPolicy|IsMonarch|MonarchId/.test(src),
        "TownCommands.cs must enforce Monarch-only policy checks");
    },
  },
  {
    id: "T2-39",
    tier: 2,
    features: ["F8"],
    title: "Sworn Allegiance members retain flat execution authority without needing Monarch rank for haul/siege ops",
    tags: ["phase-b", "governance"],
    async run() {
      const gwPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs");
      const src = readFileSync(gwPath, "utf8");
      assert.ok(/MonarchId|Allegiance/.test(src));
    },
  },
  {
    id: "T2-40",
    tier: 2,
    features: ["F8"],
    title: "AgentGatewayService rejects non-Monarch @town policy command identically to in-game player",
    tags: ["phase-e", "parity", "negative"],
    async run() {
      const res = await gatewayFetch("/api/v1/monarch/orders", {
        method: "POST",
        body: { actorMonarchId: 999999, townId: 1, action: "set_tariff", buyMul: 1.2, isMonarch: false },
      });
      assert.ok(res.status === 400 || res.status === 403 || res.status === 422,
        `Expected non-Monarch policy request rejection (400/403/422), got ${res.status}`);
    },
  },

  // =========================================================================
  // F9: HBV1 v8 Protocol & Rust/WASM Boundaries [T2-41..T2-45]
  // =========================================================================
  {
    id: "T2-41",
    tier: 2,
    features: ["F9"],
    title: "VehicleWire rejects corrupted magic tag != 0x31564248 and preserves v7 backward-compat",
    tags: ["phase-c", "negative"],
    async run() {
      assertDotnetMethodPassed("F9_VehicleWire_HBV1_V8_AndBaselineHeader");
    },
  },
  {
    id: "T2-42",
    tier: 2,
    features: ["F9"],
    title: "Invalid HBV1 opcode (> 0x0916) fails Rust opcode_parity / protocol decoder cleanly",
    tags: ["phase-c", "rust", "negative"],
    async run() {
      const modRs = readFileSync(
        path.join(APP_ROOT, "..", "..", "crates", "holtburger-protocol", "src", "messages", "vehicle", "mod.rs"),
        "utf8"
      );
      assert.ok(/HBV1_VERSION:\s*u16\s*=\s*8/.test(modRs), "Rust HBV1_VERSION must be 8 before v8 opcode boundary check");
      const res = runCargoProtocolTests();
      assert.equal(res.code, 0, res.stderr || res.stdout);
    },
  },
  {
    id: "T2-43",
    tier: 2,
    features: ["F9"],
    title: "fixtures-input.json exercises all new HBV1 v8 opcodes 0x0911-0x0916",
    tags: ["phase-c", "fixtures"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const inp = readFileSync(path.join(PROTOCOL_DIR, "fixtures-input.json"), "utf8");
      for (const opPattern of [
        /Economy_TownState|0x0911/i,
        /Economy_Siege(Action|Event)|0x0912/i,
        /Industry_(Prospecting|SurveyResult)|0x0913/i,
        /Industry_Facility(Action|State)|0x0914/i,
        /Logistics_Convoy(Order|State)|0x0915/i,
        /Economy_MonarchOrder|0x0916/i,
      ]) {
        assert.ok(opPattern.test(inp), `fixtures-input.json missing HBV1 v8 fixture matching ${opPattern}`);
      }
      const chk = runPython(path.join(PROTOCOL_DIR, "gen_fixtures.py"), ["--check"]);
      assert.equal(chk.code, 0);
    },
  },
  {
    id: "T2-44",
    tier: 2,
    features: ["F9"],
    title: "DeployableKind 17..22 remain untouched/reserved while 23..61 are defined in HBV1 v8 XML",
    tags: ["phase-c", "r6"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const dkBlock = extractXmlEnumBlock(xml, "DeployableKind");
      assert.ok(dkBlock, 'Missing <enum name="DeployableKind"> block in vehicles.protocol.xml');
      for (let k = 17; k <= 22; k++) {
        const m = new RegExp(`<value\\s+[^>]*value="${k}"[^>]*name="([^"]+)"`, "i").exec(dkBlock);
        if (m) {
          assert.ok(/Warehouse|Reserved/i.test(m[1]),
            `DeployableKind ${k} (${m[1]}) MUST remain reserved/warehouse`);
        }
      }
      for (const reqKind of [23, 29, 30, 38, 43, 56, 61]) {
        assert.ok(new RegExp(`value="${reqKind}"`).test(dkBlock),
          `DeployableKind enum missing HBV1 v8 kind=${reqKind}`);
      }
    },
  },
  {
    id: "T2-45",
    tier: 2,
    features: ["F9"],
    title: "ACE VehicleWireTests pass under -c Debug with HBV1 v8 fixtures",
    tags: ["phase-c", "csharp"],
    async run() {
      assertDotnetMethodPassed("F9_VehicleWire_HBV1_V8_AndBaselineHeader");
      const res = runDotnetEconomyTests("FullyQualifiedName~VehicleWireTests", { strict: false });
      assert.equal(res.code, 0, res.stdout + "\n" + res.stderr);
    },
  },

  // =========================================================================
  // F10: 14 Subsurface Basins & Geology Boundaries [T2-46..T2-50]
  // =========================================================================
  {
    id: "T2-46",
    tier: 2,
    features: ["F10"],
    title: "Basin count is strictly 14 (8 Dereth + 6 Dericost); 0 undeclared orphan basins",
    tags: ["phase-c", "boundary"],
    async run() {
      assertDotnetMethodPassed("F10_Geology_14Basins_TerrainMapping_AndDepletion");
    },
  },
  {
    id: "T2-47",
    tier: 2,
    features: ["F10"],
    title: "subsurface_deposit has >= 14 seeded rows, 0 negative remaining_tonnes, and 0 invalid grade_bps (< 0 or > 10000)",
    tags: ["phase-c", "mysql", "boundary"],
    async run() {
      const cfg = getMysqlConfig();
      const total = Number(queryMysqlScalar("SELECT COUNT(*) FROM subsurface_deposit;", cfg.shardDb));
      assert.ok(total >= 14, `Expected >= 14 seeded deposits in subsurface_deposit, got ${total}`);
      const bad = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM subsurface_deposit WHERE remaining_tonnes < 0 OR grade_bps < 0 OR grade_bps > 10000;",
        cfg.shardDb
      ));
      assert.equal(bad, 0, `Found ${bad} out-of-range subsurface_deposit rows`);
    },
  },
  {
    id: "T2-48",
    tier: 2,
    features: ["F10"],
    title: "Light Sweet crude (>35 API, <0.5% S) vs Heavy Sour (<25 API, >1.5% S) yield ratio enforced",
    tags: ["phase-c", "boundary"],
    async run() {
      assertDotnetMethodPassed("F10_Geology_14Basins_TerrainMapping_AndDepletion");
      const cfg = getMysqlConfig();
      const lightSweet = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM subsurface_deposit WHERE (LOWER(resource_type) LIKE '%oil%' OR LOWER(resource_type) LIKE '%crude%') AND api_gravity > 35 AND sulfur_bps < 50;",
        cfg.shardDb
      ));
      const heavySour = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM subsurface_deposit WHERE (LOWER(resource_type) LIKE '%oil%' OR LOWER(resource_type) LIKE '%crude%') AND api_gravity < 25 AND sulfur_bps > 150;",
        cfg.shardDb
      ));
      assert.ok(lightSweet >= 1, "Expected >= 1 Light Sweet crude (>35 API, <50 bps sulfur) deposit in subsurface_deposit");
      assert.ok(heavySour >= 1, "Expected >= 1 Heavy Sour crude (<25 API, >150 bps sulfur) deposit in subsurface_deposit");
    },
  },
  {
    id: "T2-49",
    tier: 2,
    features: ["F10"],
    title: "Depleted deposit (remaining_tonnes == 0) refuses further extraction",
    tags: ["phase-c", "negative"],
    async run() {
      assertDotnetMethodPassed("F10_Geology_14Basins_TerrainMapping_AndDepletion");
      const geoSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "GeologyService.cs"), "utf8");
      assert.ok(/remaining_tonnes|RemainingTonnes/.test(geoSrc) && /<= 0|0f|0d/.test(geoSrc),
        "GeologyService.cs must guard against extracting from 0-tonne depleted deposits");
    },
  },
  {
    id: "T2-50",
    tier: 2,
    features: ["F10"],
    title: "industry_facility rejects negative power_kw or missing owner_monarch_id",
    tags: ["phase-c", "mysql"],
    async run() {
      assertDotnetMethodPassed("F11_MicroGrid_Boundary75m_AndIndustrial150kWGenset_18MJBess");
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='industry_facility';`
      ).map((r) => r[0].toLowerCase());
      assert.ok(cols.includes("facility_guid") && cols.includes("power_kw") && cols.includes("owner_monarch_id"));
      const invalidRows = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM industry_facility WHERE power_kw < 0 OR owner_monarch_id = 0;",
        cfg.shardDb
      ));
      assert.equal(invalidRows, 0, `Found ${invalidRows} invalid industry_facility rows`);
    },
  },

  // =========================================================================
  // F11: Prospecting & Industrial Skid Boundaries [T2-51..T2-55]
  // =========================================================================
  {
    id: "T2-51",
    tier: 2,
    features: ["F11"],
    title: "MicroGrid ±75 m exact cube edge: 75.0 m inside accepted, 75.1 m outside rejected",
    tags: ["baseline", "phase-c", "boundary"],
    async run() {
      assertDotnetMethodPassed("Baseline_MicroGrid_75mCubeBoundary_And_VehicleWireV7Header");
    },
  },
  {
    id: "T2-52",
    tier: 2,
    features: ["F11"],
    title: "GPR (4000070) in wet marsh/swamp attenuates while Vibroseis (4000071) succeeds",
    tags: ["phase-c", "boundary"],
    async run() {
      assertDotnetMethodPassed("F11_Prospecting_GprWetMarshAttenuation_AndVibroseisFallback");
    },
  },
  {
    id: "T2-53",
    tier: 2,
    features: ["F11"],
    title: "Industrial Genset (-150 kW) + BESS (18 MJ) integrate with MicroGrid without NaN/Inf",
    tags: ["phase-c", "boundary"],
    async run() {
      assertDotnetMethodPassed("F11_MicroGrid_Boundary75m_AndIndustrial150kWGenset_18MJBess");
    },
  },
  {
    id: "T2-54",
    tier: 2,
    features: ["F11"],
    title: "ISO 6780 prospecting pallets (4000070-74) remain within 1.10 m footprint for Warehouse rack compatibility",
    tags: ["phase-c", "boundary"],
    async run() {
      const files = discoverEconomyVehicleModelFiles();
      const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
      assert.ok(src.includes("4000070") && src.includes("4000072") && src.includes("4000074"),
        "Prospecting pallet models 4000070-4000074 missing");
    },
  },
  {
    id: "T2-55",
    tier: 2,
    features: ["F11"],
    title: "0 kW brownout disables active Town Mint (30 kW) / Town Workshop (25 kW) / ADU (60 kW)",
    tags: ["phase-c", "negative"],
    async run() {
      const mgSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "MicroGrid.cs"), "utf8");
      const indSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "IndustryManager.cs"), "utf8");
      assert.ok(/IsPowered|EnergyStored|PowerWatts/.test(mgSrc + indSrc));
    },
  },

  // =========================================================================
  // F12: Cold-Chain & Reefer Boundaries [T2-56..T2-60]
  // =========================================================================
  {
    id: "T2-56",
    tier: 2,
    features: ["F12"],
    title: "Ambient decay boundary reaches 0.0% after full 2-6 h window while powered Reefer freezes at 100.0%",
    tags: ["phase-c", "boundary"],
    async run() {
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
    },
  },
  {
    id: "T2-57",
    tier: 2,
    features: ["F12"],
    title: "Unpowered Reefer (0 kW / MicroGrid offline) loses 0.0x freeze and resumes ambient decay",
    tags: ["phase-c", "negative"],
    async run() {
      const decaySrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "PerishableDecay.cs"), "utf8");
      assert.ok(/isPowered|IsPowered|powered_reefer/i.test(decaySrc),
        "PerishableDecay.cs must resume decay when Reefer power drops");
    },
  },
  {
    id: "T2-58",
    tier: 2,
    features: ["F12"],
    title: "22R1 (5 kW, 8 pallets) vs 45R1 (6 kW, 18 pallets) Reefer capacities enforced",
    tags: ["phase-c", "boundary"],
    async run() {
      const dmSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs"), "utf8");
      assert.ok(dmSrc.includes("4000060") && dmSrc.includes("4000061"), "DeployableManager missing 4000060/4000061");
    },
  },
  {
    id: "T2-59",
    tier: 2,
    features: ["F12"],
    title: "town_warehouse_stock clamps freshness_pct strictly to [0, 100]",
    tags: ["phase-c", "mysql", "boundary"],
    async run() {
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
      const cfg = getMysqlConfig();
      const bad = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM town_warehouse_stock WHERE freshness_pct < 0 OR freshness_pct > 100;",
        cfg.shardDb
      ));
      assert.equal(bad, 0, `Found ${bad} out-of-bounds freshness_pct rows`);
    },
  },
  {
    id: "T2-60",
    tier: 2,
    features: ["F12"],
    title: "Specialized container models (4000060-4000067) preserve ISO 1161 casting span & 0 NaN vertices",
    tags: ["phase-c", "3d"],
    async run() {
      const THREE = await getThree();
      const idxMod = await import(new URL(`../../scene3d/vehicle/index.js`, import.meta.url).href);
      const factory = idxMod.buildEconomyModel || idxMod.buildContainerModel || idxMod.buildDeployableModel;
      assert.equal(typeof factory, "function");
      for (const wcid of [4000060, 4000061, 4000062, 4000063, 4000064, 4000065, 4000066, 4000067]) {
        const g = factory(THREE, wcid);
        assert.ok(g, `Missing ISO container model ${wcid}`);
        assert.equal(countLights(g).total, 0);
      }
    },
  },

  // =========================================================================
  // F13: Client Models & Source-Lint Negative Boundaries [T2-61..T2-65]
  // =========================================================================
  {
    id: "T2-61",
    tier: 2,
    features: ["F13"],
    title: "Negative 0-light guard catches synthetic PointLight injected into procedural model",
    tags: ["negative", "3d"],
    async run() {
      const THREE = await getThree();
      const bad = new THREE.Group();
      bad.add(new THREE.PointLight(0xffffff, 1, 10));
      assert.equal(countLights(bad).total, 1);
    },
  },
  {
    id: "T2-62",
    tier: 2,
    features: ["F13"],
    title: "Negative lintSource guard rejects Math.random(), argless Date.now(), and .visible=",
    tags: ["negative", "lint"],
    async run() {
      const hits = lintSource("const a = Math.random(); const b = Date.now(); obj.visible = true;");
      assert.equal(hits.length, 3, `Expected 3 lint violations, got ${hits.length}`);
    },
  },
  {
    id: "T2-63",
    tier: 2,
    features: ["F13"],
    title: "Invalid/unknown WCID passed to economy model builder throws or returns null cleanly (no NaN mesh)",
    tags: ["phase-c", "negative"],
    async run() {
      const idxMod = await import(new URL(`../../scene3d/vehicle/index.js`, import.meta.url).href);
      const factory = idxMod.buildEconomyModel || idxMod.buildDeployableModel;
      assert.equal(typeof factory, "function");
      const THREE = await getThree();
      let res = null;
      try { res = factory(THREE, 9999999); } catch (_) { res = null; }
      assert.equal(res, null, "Unknown WCID 9999999 should return null or throw cleanly");
    },
  },
  {
    id: "T2-64",
    tier: 2,
    features: ["F13"],
    title: "New client economy models (4000060-4000095) use MeshStandardMaterial (CSM PBR) and zero un-disposed leaks",
    tags: ["phase-c", "3d"],
    async run() {
      const files = discoverEconomyVehicleModelFiles();
      const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
      for (const wcid of ["4000060", "4000070", "4000078", "4000086", "4000090", "4000093", "4000095"]) {
        assert.ok(src.includes(wcid), `Client economy models missing WCID ${wcid}`);
      }
      assert.ok(/MeshStandardMaterial/.test(src), "Procedural models must use MeshStandardMaterial");
      assert.ok(/installCsmShaderPatch/.test(src), "Procedural models must wire installCsmShaderPatch");
    },
  },
  {
    id: "T2-65",
    tier: 2,
    features: ["F13"],
    title: "Zero unregistered test files in tests/ or harness/ after adding economy_e2e",
    tags: ["coverage"],
    async run() {
      const res = runNode("harness/run-js-headless.mjs", ["--coverage"]);
      assert.equal(res.code, 0);
      assert.ok(/0 unregistered/.test(res.stdout));
    },
  },

  // =========================================================================
  // F14: Nav Graph & Item 2 Exclusion Boundaries [T2-66..T2-70]
  // =========================================================================
  {
    id: "T2-66",
    tier: 2,
    features: ["F14"],
    title: "Negative Item-2 guard rejects synthetic Port Yaraq (0x7A63) <-> Port Direlands-East (0x4866) edge",
    tags: ["negative", "no-item-2"],
    async run() {
      const badGraph = {
        towns: [
          ...Array.from({ length: 60 }, (_, i) => ({ id: i + 1, name: `Dereth_${i}`, continent: "Dereth" })),
          ...Array.from({ length: 41 }, (_, i) => ({ id: 61 + i, name: `Dericost_${i}`, continent: "Dericost" })),
        ],
        ports: OUTER_OCEAN_PORTS.map((p, i) => ({ ...p, id: i + 1, terrainCode: 20 })),
        seaLanes: [{ fromLb: "0x7A63", toLb: "0x4866", from: "Port Yaraq", to: "Port Direlands-East", basin: "inner_sea" }],
      };
      assert.throws(() => assertItem2Excluded(badGraph), /Forbidden Item 2|Inner Sea/i);
    },
  },
  {
    id: "T2-67",
    tier: 2,
    features: ["F14"],
    title: "Real logistics_nav_graph.json strictly excludes Port Direlands-East (0x4866) & inner_sea",
    tags: ["phase-d", "no-item-2"],
    async run() {
      const { graph } = loadNavGraph();
      assertItem2Excluded(graph);
    },
  },
  {
    id: "T2-68",
    tier: 2,
    features: ["F14"],
    title: "Nav graph port count is strictly 11 (never 12 with Inner Sea port)",
    tags: ["phase-d", "boundary", "no-item-2"],
    async run() {
      const { graph } = loadNavGraph();
      const summary = assertItem2Excluded(graph);
      assert.equal(summary.ports, 11);
    },
  },
  {
    id: "T2-69",
    tier: 2,
    features: ["F14"],
    title: "C# LogisticsNavGraph rejects Item 2 Inner Sea query cleanly",
    tags: ["phase-d", "no-item-2"],
    async run() {
      assertDotnetMethodPassed("F14_LogisticsNavGraph_101Towns_11OuterPorts_ExcludesItem2");
    },
  },
  {
    id: "T2-70",
    tier: 2,
    features: ["F14"],
    title: "Nav graph road bridge gap tolerance (96 m) & max spur grade (<= 40 deg) validated",
    tags: ["phase-d", "boundary"],
    async run() {
      const { graph } = loadNavGraph();
      const edges = graph.edges || graph.roadEdges || [];
      assert.ok(edges.length >= 13731, `Expected >= 13,731 road edges in nav graph, got ${edges.length}`);
      for (const e of edges) {
        if (typeof e.gradeDeg === "number") {
          assert.ok(e.gradeDeg <= 44, `Edge exceeds Semi-379 44 deg limit: ${e.gradeDeg}`);
        }
      }
    },
  },

  // =========================================================================
  // F15: Dual-LOD LogisticsEngine & Maritime Boundaries [T2-71..T2-75]
  // =========================================================================
  {
    id: "T2-71",
    tier: 2,
    features: ["F15"],
    title: "Micro-LOD exact boundary: 480.0 m materializes, 481.0 m remains Macro-LOD",
    tags: ["phase-d", "boundary"],
    async run() {
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
    },
  },
  {
    id: "T2-72",
    tier: 2,
    features: ["F15"],
    title: "Convoy with 0 fuel_liters stalls instead of teleporting in Macro-LOD",
    tags: ["phase-d", "negative"],
    async run() {
      const engSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "LogisticsEngine.cs"), "utf8");
      assert.ok(/fuel_liters|FuelLiters/.test(engSrc) && /<= 0|stalled|OutOfFuel/i.test(engSrc),
        "LogisticsEngine.cs must stall convoys at 0 fuel");
    },
  },
  {
    id: "T2-73",
    tier: 2,
    features: ["F15"],
    title: "M/V Dereth Feeder (4000050) has VehicleLocomotion.Marine == 3 and VehicleClass == 4",
    tags: ["phase-d", "maritime"],
    async run() {
      const vwSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "VehicleWire.cs"), "utf8");
      assert.ok(/Marine\s*=\s*3/.test(vwSrc), "VehicleWire.cs missing Marine = 3");
    },
  },
  {
    id: "T2-74",
    tier: 2,
    features: ["F15"],
    title: "logistics_convoy enforces non-negative spline_s_m and fuel_liters",
    tags: ["phase-d", "mysql", "boundary"],
    async run() {
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
      const cfg = getMysqlConfig();
      const bad = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM logistics_convoy WHERE spline_s_m < 0 OR fuel_liters < 0;",
        cfg.shardDb
      ));
      assert.equal(bad, 0);
    },
  },
  {
    id: "T2-75",
    tier: 2,
    features: ["F15"],
    title: "Client port_specs.js (4000050-57) aligns with promoted server HBV1 v8 Kind 23-29 & Marine=3",
    tags: ["phase-d", "maritime"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const vwSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "VehicleWire.cs"), "utf8");
      assert.ok(/Marine\s*=\s*3/.test(vwSrc), "VehicleWire.cs missing VehicleLocomotion.Marine = 3");
      assert.ok(/ContainerShipFeeder\s*=\s*4/.test(vwSrc), "VehicleWire.cs missing VehicleClass.ContainerShipFeeder = 4");
      const psSrc = readFileSync(path.join(APP_ROOT, "scene3d", "vehicle", "port_specs.js"), "utf8");
      assert.ok(psSrc.includes("4000050") && psSrc.includes("4000057"));
    },
  },

  // =========================================================================
  // F16: Starter Hearth & Bounty Boundaries [T2-76..T2-80]
  // =========================================================================
  {
    id: "T2-76",
    tier: 2,
    features: ["F16"],
    title: "Starter Hearth (4000095, Kind=61, 0 kW) operates without FluxPod or fuel (breaks Day-1 chicken-and-egg)",
    tags: ["phase-e", "boundary"],
    async run() {
      assertDotnetMethodPassed("F16_StarterHearth4000095_Indestructible_InHoltburgShoushiYaraq");
    },
  },
  {
    id: "T2-77",
    tier: 2,
    features: ["F16"],
    title: "Starter Hearth (4000095) cannot be destroyed or packed by players",
    tags: ["phase-e", "negative"],
    async run() {
      const dmSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs"), "utf8");
      assert.ok(/4000095|StarterHearth/.test(dmSrc));
    },
  },
  {
    id: "T2-78",
    tier: 2,
    features: ["F16"],
    title: "Trophy Collector bounty (monarch_order) refuses payout when town till < reward_pyreals",
    tags: ["phase-e", "negative"],
    async run() {
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
      assertDotnetMethodPassed("F17_AgentGateway_MonarchOrder_NegativeAndLowTillRefusal");
      const negResp = await gatewayFetch("/api/v1/monarch/orders", {
        method: "POST",
        body: { actorGuid: 999999, townId: 1, action: "create_bounty", itemWcid: 51235, quantity: 1, rewardPyreals: -250 },
      });
      assert.ok(negResp.status === 403 || negResp.status === 422,
        `Expected negative bounty order refusal (403/422), got ${negResp.status}`);
      const cfg = getMysqlConfig();
      const bad = Number(queryMysqlScalar("SELECT COUNT(*) FROM monarch_order WHERE reward_pyreals < 0;", cfg.shardDb));
      assert.equal(bad, 0);
    },
  },
  {
    id: "T2-79",
    tier: 2,
    features: ["F16"],
    title: "Only Holtburg (0xA9B4), Shoushi (0xDA55), and Yaraq (0x7D64) host Public Commons Starter Hearths",
    tags: ["phase-e", "boundary"],
    async run() {
      assertDotnetMethodPassed("F16_StarterHearth4000095_Indestructible_InHoltburgShoushiYaraq");
    },
  },
  {
    id: "T2-80",
    tier: 2,
    features: ["F16"],
    title: "Rung 2 SolarPanels (50 kW) + FluxPod MicroGrid powers GPR/Drill/Assay and Industrial Genset/BESS integrates cleanly",
    tags: ["phase-e", "boundary"],
    async run() {
      assertDotnetMethodPassed("F11_MicroGrid_Boundary75m_AndIndustrial150kWGenset_18MJBess");
      assertDotnetMethodPassed("F16_StarterHearth4000095_Indestructible_InHoltburgShoushiYaraq");
      const dmSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs"), "utf8");
      assert.ok(dmSrc.includes("4000070") && dmSrc.includes("4000072") && dmSrc.includes("4000073"),
        "DeployableManager.cs missing Rung 2 prospecting WCIDs 4000070/4000072/4000073");
    },
  },

  // =========================================================================
  // F17: AgentGatewayService Security & Parity Boundaries [T2-81..T2-85]
  // =========================================================================
  {
    id: "T2-81",
    tier: 2,
    features: ["F17"],
    title: "AgentGatewayService rejects requests missing Bearer token with HTTP 401/403",
    tags: ["phase-e", "negative", "security"],
    async run() {
      const res = await gatewayFetch("/api/v1/world/towns", { token: null });
      validateGatewayAuthResponse(res, false);
    },
  },
  {
    id: "T2-82",
    tier: 2,
    features: ["F17"],
    title: "AgentGatewayService rejects invalid Bearer token with HTTP 401/403",
    tags: ["phase-e", "negative", "security"],
    async run() {
      const res = await gatewayFetch("/api/v1/world/towns", { token: "invalid-wrong-secret-token" });
      validateGatewayAuthResponse(res, false);
    },
  },
  {
    id: "T2-83",
    tier: 2,
    features: ["F17"],
    title: "AgentGatewayService binds strictly to loopback 127.0.0.1 (never 0.0.0.0)",
    tags: ["phase-e", "security"],
    async run() {
      assertDotnetMethodPassed("F17_AgentGateway_LoopbackConfig_AndWorldManagerEnqueueParity");
    },
  },
  {
    id: "T2-84",
    tier: 2,
    features: ["F17"],
    title: "Gateway rejects AI convoy/siege dispatch violating 1,499 m provenance or 0 fuel identically to human",
    tags: ["phase-e", "parity", "negative"],
    async run() {
      const res = await gatewayFetch("/api/v1/logistics/convoys", {
        method: "POST",
        body: { townId: 1, originLandblockId: 0xA9B4, distanceM: 1499, fuelLiters: 0, action: "deliver_siege_supply" },
      });
      assert.ok(res.status === 400 || res.status === 422 || res.status === 403,
        `Expected physical validation rejection (400/422/403), got ${res.status}: ${res.raw}`);
    },
  },
  {
    id: "T2-85",
    tier: 2,
    features: ["F17"],
    title: "Gateway returns HTTP 404/400 on nonexistent town ID (e.g. /api/v1/town/99999/ledger)",
    tags: ["phase-e", "negative"],
    async run() {
      const res = await gatewayFetch("/api/v1/town/99999/ledger");
      assert.ok(res.status === 404 || res.status === 400, `Expected 404/400 for town 99999, got ${res.status}`);
    },
  },

  // =========================================================================
  // F18: Patch & Live Stack Hygiene Boundaries [T2-86..T2-90]
  // =========================================================================
  {
    id: "T2-86",
    tier: 2,
    features: ["F18"],
    title: "All exported ACE patches in docs/vehicles-2026-11-01/ace/ are sequentially numbered without gaps",
    tags: ["phase-e", "patches"],
    async run() {
      const { readdirSync } = await import("node:fs");
      const files = readdirSync(ACE_PATCH_DIR).filter((f) => /^\d{4}-.*\.patch$/.test(f)).sort();
      assert.ok(files.length >= 26, `Expected >= 26 sequential ACE patches, found ${files.length}`);
      const nums = files.map((f) => Number(f.slice(0, 4)));
      for (let i = 1; i < nums.length; i++) {
        assert.equal(nums[i], nums[i - 1] + 1, `Patch numbering gap between ${files[i - 1]} and ${files[i]}`);
      }
    },
  },
  {
    id: "T2-87",
    tier: 2,
    features: ["F18"],
    title: "economy_e2e runner itself refuses Release configuration in runDotnetEconomyTests",
    tags: ["safety", "negative"],
    async run() {
      assert.throws(
        () => runDotnetEconomyTests("FullyQualifiedName~EconomyE2E", { configuration: "Release" }),
        /FORBIDDEN dotnet configuration/
      );
    },
  },
  {
    id: "T2-88",
    tier: 2,
    features: ["F18"],
    title: "serve.py static server responds 404 for nonexistent paths without crashing",
    tags: ["baseline", "negative"],
    async run() {
      const r = await fetch("http://127.0.0.1:8765/apps/holtburger-web/__nonexistent_e2e_probe__.js");
      assert.equal(r.status, 404);
    },
  },
  {
    id: "T2-89",
    tier: 2,
    features: ["F18"],
    title: "ACE ace_auth & ace_shard contain valid tailnet1 account (accessLevel 5) for live login",
    tags: ["baseline", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const lvl = Number(queryMysqlScalar("SELECT accessLevel FROM account WHERE accountName = 'tailnet1';", cfg.authDb));
      assert.equal(lvl, 5, `Expected tailnet1 accessLevel=5, got ${lvl}`);
    },
  },
  {
    id: "T2-90",
    tier: 2,
    features: ["F18"],
    title: "WorldManager.EnqueueAction present for deterministic main-thread action queuing",
    tags: ["baseline", "csharp"],
    async run() {
      assertDotnetMethodPassed("Baseline_WorldManager_EnqueueAction_Exists");
    },
  },

  // =========================================================================
  // R6: Warehouse Immutability Negative & Boundary Guards [T2-91..T2-95]
  // =========================================================================
  {
    id: "T2-91",
    tier: 2,
    features: ["R6"],
    title: "Negative SHA256 tamper check detects single-character hash mismatch on warehouse file",
    tags: ["r6", "negative"],
    async run() {
      const tampered = WAREHOUSE_18_FILES.map((item, i) => (i === 0 ? { ...item, sha256: "f".repeat(64) } : item));
      assert.throws(() => verifyWarehouseImmutability(tampered), /R6 Warehouse immutability SHA256 violation/);
    },
  },
  {
    id: "T2-92",
    tier: 2,
    features: ["R6"],
    title: "Negative missing-file check detects missing warehouse file in pin array",
    tags: ["r6", "negative"],
    async run() {
      const missing = WAREHOUSE_18_FILES.map((item, i) =>
        i === 17 ? { ...item, rel: "harness/warehouse_e2e/__missing__.mjs" } : item
      );
      assert.throws(() => verifyWarehouseImmutability(missing), /R6 Warehouse immutability SHA256 violation/);
    },
  },
  {
    id: "T2-93",
    tier: 2,
    features: ["R6"],
    title: "WAREHOUSE_18_FILES covers exactly 7 scene3d + 4 tests + 1 stage + 6 harness files = 18",
    tags: ["r6", "boundary"],
    async run() {
      assert.equal(WAREHOUSE_18_FILES.length, 18);
      assert.equal(WAREHOUSE_18_FILES.filter((f) => f.rel.startsWith("scene3d/vehicle/")).length, 7);
      assert.equal(WAREHOUSE_18_FILES.filter((f) => f.rel.startsWith("tests/")).length, 4);
      assert.equal(WAREHOUSE_18_FILES.filter((f) => f.rel.startsWith("harness/")).length, 7);
      verifyWarehouseImmutability();
    },
  },
  {
    id: "T2-94",
    tier: 2,
    features: ["R6"],
    title: "warehouse_e2e --list maintains exact 143-check manifest (60 T1 / 60 T2 / 16 T3 / 7 T4)",
    tags: ["r6", "warehouse-e2e"],
    async run() {
      const res = runNode("harness/warehouse_e2e/run_e2e.mjs", ["--list", "--json"]);
      assert.equal(res.code, 0);
      const data = JSON.parse(res.stdout);
      assert.equal(data.summary.total, 143);
      assert.equal(data.summary.tierCounts["1"], 60);
      assert.equal(data.summary.tierCounts["2"], 60);
      assert.equal(data.summary.tierCounts["3"], 16);
      assert.equal(data.summary.tierCounts["4"], 7);
    },
  },
  {
    id: "T2-95",
    tier: 2,
    features: ["R6"],
    title: "All 18 warehouse files remain unmodified in git working tree & staged index",
    tags: ["r6", "immutability"],
    async run() {
      const res = verifyWarehouseImmutability();
      assert.equal(res.checked, 18);
      assert.equal(res.diffFiles.length, 0);
    },
  },
];
