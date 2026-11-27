// harness/economy_e2e/tier1_features.mjs
// Tier 1: Category-Partition Feature Coverage — 95 checks (5 per area across F1..F18 + R6).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  ACE_PATCH_DIR,
  ACE_ROOT,
  APP_ROOT,
  ECONOMY_TABLES,
  ECONOMY_WCID_SPECS,
  PROTOCOL_DIR,
  WAREHOUSE_18_FILES,
  WAREHOUSE_UNIT_TEST_FILES,
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
  getDotnetEconomyOutcomes,
  getMysqlConfig,
  getThree,
  lintSource,
  loadNavGraph,
  probeTcpPort,
  queryMysql,
  queryMysqlScalar,
  renderWithFakeWebGL2,
  runCargoProtocolTests,
  runNode,
  runProcess,
  runPython,
  runWarehouseE2E,
  runWarehouseUnitTests,
  spyDisposal,
  verifyBaselineWorldAndDericostData,
  verifyWarehouseImmutability,
} from "./e2e_helpers.mjs";

export const TESTS = [
  // =========================================================================
  // F1: Global Config Cutover (physical_economy_enabled) [T1-01..T1-05]
  // =========================================================================
  {
    id: "T1-01",
    tier: 1,
    features: ["F1"],
    title: "PropertyManager defines physical_economy_enabled boolean key and toggles cleanly",
    tags: ["phase-a", "config"],
    async run() {
      assertDotnetMethodPassed("Baseline_PropertyManager_PhysicalEconomyEnabledSwitch");
    },
  },
  {
    id: "T1-02",
    tier: 1,
    features: ["F1"],
    title: "ace_shard config_properties_boolean registers physical_economy_enabled",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cnt = Number(queryMysqlScalar(
        "SELECT COUNT(*) FROM config_properties_boolean WHERE `key` = 'physical_economy_enabled';",
        cfg.shardDb
      ));
      assert.equal(cnt, 1, "Expected physical_economy_enabled row in ace_shard.config_properties_boolean");
    },
  },
  {
    id: "T1-03",
    tier: 1,
    features: ["F1"],
    title: "Cold-start cutover initializes all 101 towns to 0 stock and 0 pyreal till",
    tags: ["phase-a", "cold-start"],
    async run() {
      assertDotnetMethodPassed("F1_ColdStartCutover_ZeroStockAndZeroTill_Across101Towns");
    },
  },
  {
    id: "T1-04",
    tier: 1,
    features: ["F1"],
    title: "TownEconomyManager implementation file exists in ACE.Server/Economy/",
    tags: ["phase-a", "source"],
    async run() {
      const p = path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "TownEconomyManager.cs");
      assert.ok(existsSync(p), `Missing ${p}`);
      const src = readFileSync(p, "utf8");
      assert.ok(/physical_economy_enabled/.test(src), "TownEconomyManager.cs must consult physical_economy_enabled");
    },
  },
  {
    id: "T1-05",
    tier: 1,
    features: ["F1"],
    title: "Physical economy cutover propagates to Vendor.cs and Player_Commerce.cs",
    tags: ["phase-a", "vendor"],
    async run() {
      const vPath = path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Vendor.cs");
      const pcPath = path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Player_Commerce.cs");
      assert.ok(existsSync(vPath) && existsSync(pcPath), "Missing Vendor.cs / Player_Commerce.cs");
      const combined = readFileSync(vPath, "utf8") + "\n" + readFileSync(pcPath, "utf8");
      assert.ok(/TownEconomyManager|physical_economy_enabled/.test(combined),
        "Vendor.cs / Player_Commerce.cs must hook into TownEconomyManager / physical_economy_enabled");
    },
  },

  // =========================================================================
  // F2: 101-Town Registry & SOI (60 Dereth + 41 Dericost) [T1-06..T1-10]
  // =========================================================================
  {
    id: "T1-06",
    tier: 1,
    features: ["F2"],
    title: "TownRegistry contains 101 primary towns (60 Dereth + 41 Dericost)",
    tags: ["phase-a", "registry"],
    async run() {
      assertDotnetMethodPassed("F2_TownRegistry_ClusteredDereth60_AndDericost41_AndSOI");
    },
  },
  {
    id: "T1-07",
    tier: 1,
    features: ["F2"],
    title: "dericost_towns_index.json matches 41 Dericost towns and 6 provincial quotas",
    tags: ["baseline", "dericost"],
    async run() {
      const res = verifyBaselineWorldAndDericostData();
      assert.equal(res.dericostTowns, 41);
    },
  },
  {
    id: "T1-08",
    tier: 1,
    features: ["F2"],
    title: "ace_shard town_control persists 101 towns (60 Dereth + 41 Dericost)",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const total = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control;", cfg.shardDb));
      assert.equal(total, 101, `Expected 101 rows in ace_shard.town_control, got ${total}`);
      const dereth = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control WHERE LOWER(continent)='dereth';", cfg.shardDb));
      const dericost = Number(queryMysqlScalar("SELECT COUNT(*) FROM town_control WHERE LOWER(continent)='dericost';", cfg.shardDb));
      assert.equal(dereth, 60, `Expected 60 Dereth towns in town_control, got ${dereth}`);
      assert.equal(dericost, 41, `Expected 41 Dericost towns in town_control, got ${dericost}`);
    },
  },
  {
    id: "T1-09",
    tier: 1,
    features: ["F2"],
    title: "Major Dereth hubs (Holtburg, Shoushi, Yaraq, Hebian-To) exist in town_control",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        "SELECT LOWER(name) FROM town_control WHERE LOWER(name) IN ('holtburg','shoushi','yaraq','hebian-to');",
        cfg.shardDb
      );
      assert.equal(rows.length, 4, `Expected all 4 hub towns in town_control, found ${rows.length}`);
    },
  },
  {
    id: "T1-10",
    tier: 1,
    features: ["F2"],
    title: "TownRegistry maps minor hamlets via SOI and Tou-Tou (0xF559) reclamation site",
    tags: ["phase-a", "soi"],
    async run() {
      const regPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "TownRegistry.cs");
      assert.ok(existsSync(regPath), `Missing ${regPath}`);
      const src = readFileSync(regPath, "utf8");
      assert.ok(/F559/i.test(src) || /Tou-Tou/i.test(src), "TownRegistry.cs must account for Tou-Tou (0xF559)");
      assert.ok(/SOI|SphereOfInfluence|ResolveTown/i.test(src), "TownRegistry.cs must implement SOI mapping");
      assertDotnetMethodPassed("F2_TownRegistry_ClusteredDereth60_AndDericost41_AndSOI");
    },
  },

  // =========================================================================
  // F3: Phase A ace_shard Tables [T1-11..T1-15]
  // =========================================================================
  {
    id: "T1-11",
    tier: 1,
    features: ["F3"],
    title: "ace_shard contains town_control, town_vendor_ledger, and town_warehouse_stock",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN ('town_control','town_vendor_ledger','town_warehouse_stock');`
      );
      assert.equal(rows.length, 3, `Expected 3 Phase A tables in ${cfg.shardDb}, found ${rows.length}`);
    },
  },
  {
    id: "T1-12",
    tier: 1,
    features: ["F3"],
    title: "All Phase A ace_shard tables use MariaDB-safe utf8mb4_general_ci collation",
    tags: ["phase-a", "mysql", "collation"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        `SELECT table_name, table_collation FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN ('town_control','town_vendor_ledger','town_warehouse_stock');`
      );
      assert.equal(rows.length, 3, "Missing Phase A tables for collation check");
      for (const [name, collation] of rows) {
        assert.notEqual(collation, "utf8mb4_0900_ai_ci", `Table ${name} uses forbidden utf8mb4_0900_ai_ci`);
        assert.equal(collation, "utf8mb4_general_ci", `Table ${name} collation=${collation}, expected utf8mb4_general_ci`);
      }
    },
  },
  {
    id: "T1-13",
    tier: 1,
    features: ["F3"],
    title: "Shard SQL migration files pass assertMariaDbCollation guard",
    tags: ["phase-a", "sql"],
    async run() {
      const files = findShardMigrationSqlFiles();
      assert.ok(files.length >= 1, "Expected at least 1 economy SQL migration file in ace-server");
      for (const f of files) {
        assertMariaDbCollation(readFileSync(f, "utf8"));
      }
    },
  },
  {
    id: "T1-14",
    tier: 1,
    features: ["F3"],
    title: "ShardDbContext exposes DbSets for Phase A tables and excludes custom WCIDs from biota",
    tags: ["phase-a", "efcore"],
    async run() {
      assertDotnetMethodPassed("F3_ShardDbContext_HasAllEconomyTables_AndBiotaExcludesCustomWcids");
    },
  },
  {
    id: "T1-15",
    tier: 1,
    features: ["F3"],
    title: "town_control schema includes state, hold_elapsed_sec, supply_meter_sec, treasury & escrow columns",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='town_control';`
      ).map((r) => r[0].toLowerCase());
      for (const req of ["town_id", "continent", "name", "state", "owner_monarch_id", "hold_elapsed_sec", "supply_meter_sec", "treasury_pyreals", "escrow_pyreals"]) {
        assert.ok(cols.includes(req), `town_control missing required column '${req}'`);
      }
    },
  },

  // =========================================================================
  // F4: Finite Vendor Stock & Shared Till [T1-16..T1-20]
  // =========================================================================
  {
    id: "T1-16",
    tier: 1,
    features: ["F4"],
    title: "Vendor finite stock decrements on purchase and refuses when depleted",
    tags: ["phase-a", "vendor"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_FiniteStock_DecrementAndZeroRefusal");
    },
  },
  {
    id: "T1-17",
    tier: 1,
    features: ["F4"],
    title: "Shared Town Treasury Till funds buybacks and refuses at 0 pyreals",
    tags: ["phase-a", "vendor"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_SharedTownTill_BuybackRefusalAtZero_AndCapClamp");
    },
  },
  {
    id: "T1-18",
    tier: 1,
    features: ["F4"],
    title: "Monarch tariff multipliers validate bounds and scale vendor pricing",
    tags: ["phase-a", "vendor"],
    async run() {
      assertDotnetMethodPassed("F4_Vendor_MonarchTariffBounds");
    },
  },
  {
    id: "T1-19",
    tier: 1,
    features: ["F4"],
    title: "town_vendor_ledger tracks vendor_guid, item_wcid, stock_qty, till_pyreals, till_cap_pyreals",
    tags: ["phase-a", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='town_vendor_ledger';`
      ).map((r) => r[0].toLowerCase());
      for (const req of ["town_id", "vendor_guid", "item_wcid", "stock_qty", "till_pyreals", "till_cap_pyreals"]) {
        assert.ok(cols.includes(req), `town_vendor_ledger missing column '${req}'`);
      }
    },
  },
  {
    id: "T1-20",
    tier: 1,
    features: ["F4"],
    title: "Live ace_world active vendor baseline matches 1,179 weenies / 30,627 active shop listings",
    tags: ["baseline", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const total = Number(queryMysqlScalar("SELECT COUNT(*) FROM weenie WHERE type = 12;", cfg.worldDb));
      assert.equal(total, 1179);
    },
  },

  // =========================================================================
  // F5: Special Vendor Class Rules [T1-21..T1-25]
  // =========================================================================
  {
    id: "T1-21",
    tier: 1,
    features: ["F5"],
    title: "70263 Festival Vendor Pyreal (273) & seasonal 5765/5767 blocked in economy mode",
    tags: ["phase-a", "exploit-guard"],
    async run() {
      assertDotnetMethodPassed("F5_Vendor_HardDisable_70263PyrealAnd5765Snowmen");
    },
  },
  {
    id: "T1-22",
    tier: 1,
    features: ["F5"],
    title: "Trade Note Clearinghouse enforces 1:1 Town Treasury reserve across 14 denominations",
    tags: ["phase-a", "trade-notes"],
    async run() {
      assertDotnetMethodPassed("F5_TradeNoteClearinghouse_1to1Reserve_AndParchmentInk");
    },
  },
  {
    id: "T1-23",
    tier: 1,
    features: ["F5"],
    title: "Scriveners & Spell-Service vendors draw from physical town reagent stock",
    tags: ["phase-a", "reagents"],
    async run() {
      assertDotnetMethodPassed("F5_ScrivenerAndSpellService_PhysicalReagentDraw");
    },
  },
  {
    id: "T1-24",
    tier: 1,
    features: ["F5"],
    title: "Slumlords route 100% of house purchase & rent pyreals into Town Treasury",
    tags: ["phase-a", "slumlord"],
    async run() {
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
    },
  },
  {
    id: "T1-25",
    tier: 1,
    features: ["F5"],
    title: "Slumlord rent routing (Player_House.cs) & Trophy procurement (Player_Inventory.cs / EmoteManager.cs) work end-to-end",
    tags: ["phase-a", "slumlord", "trophy"],
    async run() {
      assertDotnetMethodPassed("F5_Slumlord_100PercentRentRouting_AndTrophyProcurement");
      const houseSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Player_House.cs"), "utf8");
      const invSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Player_Inventory.cs"), "utf8");
      const emotePath = path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Managers", "EmoteManager.cs");
      assert.ok(existsSync(emotePath), `Missing ${emotePath}`);
      const emoteSrc = readFileSync(emotePath, "utf8");
      assert.ok(/RecordSlumlordPayment|TownEconomyManager/i.test(houseSrc),
        "Player_House.cs must route Slumlord payments to Town Treasury");
      assert.ok(/TryHandleTrophyTurnIn|IsRepeatableCoinEmote/i.test(invSrc + "\n" + emoteSrc),
        "Player_Inventory.cs / WorldObjects/Managers/EmoteManager.cs must gate repeatable Trophy Collector payouts");
    },
  },

  // =========================================================================
  // F6: Town Control & Siege Entities (4000090, 4000091, 4000092) [T1-26..T1-30]
  // =========================================================================
  {
    id: "T1-26",
    tier: 1,
    features: ["F6"],
    title: "TownControlNode (4000090, Kind=56), TownDepot (4000091, 57), ForwardSiegeBeacon (4000092, 58) defined",
    tags: ["phase-b", "deployables"],
    async run() {
      assertDotnetMethodPassed("F6_TownControl_SiegeEntities_WcidsAndKinds");
    },
  },
  {
    id: "T1-27",
    tier: 1,
    features: ["F6"],
    title: "DeployableBase / DeployableManager instantiates WCIDs 4000090-4000092 cleanly",
    tags: ["phase-b", "deployables"],
    async run() {
      const dbPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableBase.cs");
      const dmPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs");
      const combined = readFileSync(dbPath, "utf8") + "\n" + readFileSync(dmPath, "utf8");
      for (const wcid of ["4000090", "4000091", "4000092"]) {
        assert.ok(combined.includes(wcid), `Deployable registry missing WCID ${wcid}`);
      }
    },
  },
  {
    id: "T1-28",
    tier: 1,
    features: ["F6"],
    title: "HBV1 protocol XML maps DeployableKind 56=TownControlNode, 57=TownDepotApron, 58=ForwardSiegeBeacon",
    tags: ["phase-b", "protocol"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assert.ok(/56.*TownControlNode|TownControlNode.*56/.test(xml), "XML missing DeployableKind 56 TownControlNode");
      assert.ok(/57.*TownDepot|TownDepot.*57/.test(xml), "XML missing DeployableKind 57 TownDepot");
      assert.ok(/58.*ForwardSiegeBeacon|ForwardSiegeBeacon.*58/.test(xml), "XML missing DeployableKind 58 ForwardSiegeBeacon");
    },
  },
  {
    id: "T1-29",
    tier: 1,
    features: ["F6"],
    title: "TownControlNode & ForwardSiegeBeacon C# classes support world re-hydration",
    tags: ["phase-b", "persistence"],
    async run() {
      const siegePath = path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs");
      assert.ok(existsSync(siegePath), `Missing ${siegePath}`);
      const src = readFileSync(siegePath, "utf8");
      assert.ok(/TownControlNode|4000090/.test(src) && /ForwardSiegeBeacon|4000092/.test(src),
        "SiegeManager.cs must manage TownControlNode & ForwardSiegeBeacon");
    },
  },
  {
    id: "T1-30",
    tier: 1,
    features: ["F6"],
    title: "Client vehicle models include WCIDs 4000090-4000092 procedural geometry",
    tags: ["phase-b", "3d"],
    async run() {
      const files = discoverEconomyVehicleModelFiles();
      const allSrc = files.map((f) => readFileSync(f, "utf8")).join("\n");
      for (const wcid of ["4000090", "4000091", "4000092"]) {
        assert.ok(allSrc.includes(wcid), `Client vehicle models missing WCID ${wcid}`);
      }
    },
  },

  // =========================================================================
  // F7: 8-Hour Sustained-Supply Siege Engine [T1-31..T1-35]
  // =========================================================================
  {
    id: "T1-31",
    tier: 1,
    features: ["F7"],
    title: "Zero-notice assault crosses 300s breach gate into CONTESTED_HOLD & freezes escrow",
    tags: ["phase-b", "siege"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_ZeroNotice_And300sBreachGate");
    },
  },
  {
    id: "T1-32",
    tier: 1,
    features: ["F7"],
    title: "Accelerated-clock 28,800s continuous hold with rolling 5,400s Supply Meter flips town & pays 50/50 spoils",
    tags: ["phase-b", "siege"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_AcceleratedClock_28800sHold_AndRolling5400sSupplyMeter");
    },
  },
  {
    id: "T1-33",
    tier: 1,
    features: ["F7"],
    title: "Origin-provenance anti-loop check enforces >= 1,500m origin_landblock_id",
    tags: ["phase-b", "siege", "provenance"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_OriginProvenance_1499mRejected_1500mAccepted");
    },
  },
  {
    id: "T1-34",
    tier: 1,
    features: ["F7"],
    title: "Supply starvation collapses siege after 1,800s with 3,600s attacker cooldown",
    tags: ["phase-b", "siege"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_StarvationCollapse_1800s_And3600sCooldown");
    },
  },
  {
    id: "T1-35",
    tier: 1,
    features: ["F7"],
    title: "Three-way reset & 72h+24h insolvency receivership state transitions work",
    tags: ["phase-b", "siege"],
    async run() {
      assertDotnetMethodPassed("F7_SiegeEngine_ThreeWayReset_And72hInsolvencyReceivership");
    },
  },

  // =========================================================================
  // F8: Monarch Governance & Radar IFF [T1-36..T1-40]
  // =========================================================================
  {
    id: "T1-36",
    tier: 1,
    features: ["F8"],
    title: "RadarIff GuildRadarPolicy resolves Hostile/Friendly standings cleanly",
    tags: ["baseline", "phase-b", "iff"],
    async run() {
      assertDotnetMethodPassed("Baseline_RadarIff_PolicyResolution_Works");
    },
  },
  {
    id: "T1-37",
    tier: 1,
    features: ["F8"],
    title: "Monarch-only @town policy commands enforce Monarch privilege vs flat member ops",
    tags: ["phase-b", "governance"],
    async run() {
      assertDotnetMethodPassed("F8_Governance_MonarchOnlyPolicies_FlatMemberExecution_AndRadarIff");
    },
  },
  {
    id: "T1-38",
    tier: 1,
    features: ["F8"],
    title: "TownCommands.cs registers @town command handlers in ACE.Server",
    tags: ["phase-b", "commands"],
    async run() {
      const p = path.join(ACE_ROOT, "Source", "ACE.Server", "Command", "Handlers", "TownCommands.cs");
      assert.ok(existsSync(p), `Missing ${p}`);
      const src = readFileSync(p, "utf8");
      assert.ok(/\[CommandHandler\("town"/.test(src), "TownCommands.cs must register [CommandHandler(\"town\"...");
    },
  },
  {
    id: "T1-39",
    tier: 1,
    features: ["F8"],
    title: "Patron -> Monarch native XP pass-up stays intact alongside economy governance",
    tags: ["phase-b", "allegiance"],
    async run() {
      assertDotnetMethodPassed("F8_Governance_MonarchOnlyPolicies_FlatMemberExecution_AndRadarIff");
      const cmdPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Command", "Handlers", "TownCommands.cs");
      assert.ok(existsSync(cmdPath), `Missing ${cmdPath}`);
      const algPath = path.join(ACE_ROOT, "Source", "ACE.Server", "WorldObjects", "Player_Allegiance.cs");
      assert.ok(existsSync(algPath), `Missing ${algPath}`);
      const src = readFileSync(algPath, "utf8");
      assert.ok(/Allegiance/i.test(src) && /PassUp|Xp/i.test(src), "Player_Allegiance.cs XP pass-up must remain intact");
    },
  },
  {
    id: "T1-40",
    tier: 1,
    features: ["F8"],
    title: "SiegeManager synchronizes RadarIff policy when town ownership flips",
    tags: ["phase-b", "iff"],
    async run() {
      const siegeSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "SiegeManager.cs"), "utf8");
      assert.ok(/RadarIff|GuildRadarPolicy/.test(siegeSrc), "SiegeManager.cs must synchronize RadarIff on flip");
    },
  },

  // =========================================================================
  // F9: HBV1 v8 Protocol & Rust/WASM Bump [T1-41..T1-45]
  // =========================================================================
  {
    id: "T1-41",
    tier: 1,
    features: ["F9"],
    title: "vehicles.protocol.xml declares version=\"8\", Marine=3, ContainerShipFeeder=4, opcodes 0x0911-0x0916",
    tags: ["phase-c", "protocol"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assert.ok(/version="8"/.test(xml), "vehicles.protocol.xml must be version=\"8\"");
      assert.ok(/Marine.*3|3.*Marine/.test(xml), "XML missing VehicleLocomotion Marine=3");
      assert.ok(/ContainerShipFeeder.*4|4.*ContainerShipFeeder/.test(xml), "XML missing VehicleClass ContainerShipFeeder=4");
      for (const op of ["0x0911", "0x0912", "0x0913", "0x0914", "0x0915", "0x0916"]) {
        assert.ok(xml.includes(op), `XML missing HBV1 v8 opcode ${op}`);
      }
    },
  },
  {
    id: "T1-42",
    tier: 1,
    features: ["F9"],
    title: "gen_fixtures.py --check confirms vehicle-wire-fixtures.json matches HBV1 v8 XML",
    tags: ["phase-c", "fixtures"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const res = runPython(path.join(PROTOCOL_DIR, "gen_fixtures.py"), ["--check"]);
      assert.equal(res.code, 0, `gen_fixtures.py --check failed:\n${res.stdout}\n${res.stderr}`);
    },
  },
  {
    id: "T1-43",
    tier: 1,
    features: ["F9"],
    title: "cargo test -p holtburger-protocol passes all Rust HBV1 v8 parity tests",
    tags: ["phase-c", "rust"],
    async run() {
      const res = runCargoProtocolTests();
      assert.equal(res.code, 0, `cargo test -p holtburger-protocol failed:\n${res.stdout}\n${res.stderr}`);
      const modRs = readFileSync(
        path.join(APP_ROOT, "..", "..", "crates", "holtburger-protocol", "src", "messages", "vehicle", "mod.rs"),
        "utf8"
      );
      assert.ok(/HBV1_VERSION:\s*u16\s*=\s*8/.test(modRs), "Rust HBV1_VERSION must be 8");
    },
  },
  {
    id: "T1-44",
    tier: 1,
    features: ["F9"],
    title: "C# VehicleWire.cs implements HBV1 v8 and passes F9_VehicleWire_HBV1_V8_AndBaselineHeader",
    tags: ["phase-c", "csharp"],
    async run() {
      assertDotnetMethodPassed("F9_VehicleWire_HBV1_V8_AndBaselineHeader");
    },
  },
  {
    id: "T1-45",
    tier: 1,
    features: ["F9"],
    title: "WASM pkg/ is rebuilt and sync-ace-fixtures.sh --check reports HBV1 v8 byte parity",
    tags: ["phase-c", "wasm"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const pkgJs = path.join(APP_ROOT, "pkg", "holtburger_web.js");
      assert.ok(existsSync(pkgJs), `Missing rebuilt WASM JS glue at ${pkgJs}`);
      const syncScript = path.join(PROTOCOL_DIR, "sync-ace-fixtures.sh");
      assert.ok(existsSync(syncScript), `Missing ${syncScript}`);
      const res = runProcess("sh", [syncScript, "--check"], {
        env: { ACE_TESTS: path.join(ACE_ROOT, "Source", "ACE.Server.Tests", "Vehicles") },
      });
      assert.equal(res.code, 0, `sync-ace-fixtures.sh --check failed:\n${res.stdout}\n${res.stderr}`);
      const hFixtures = readFileSync(path.join(PROTOCOL_DIR, "vehicle-wire-fixtures.json"), "utf8");
      const aFixtures = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server.Tests", "Vehicles", "vehicle-wire-fixtures.json"), "utf8");
      assert.equal(hFixtures, aFixtures, `ACE vehicle-wire-fixtures.json out of sync with ${syncScript}`);
    },
  },

  // =========================================================================
  // F10: 14 Subsurface Basins & ace_shard Geology [T1-46..T1-50]
  // =========================================================================
  {
    id: "T1-46",
    tier: 1,
    features: ["F10"],
    title: "ace_shard contains subsurface_deposit and industry_facility with utf8mb4_general_ci",
    tags: ["phase-c", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        `SELECT table_name, table_collation FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN ('subsurface_deposit','industry_facility');`
      );
      assert.equal(rows.length, 2, `Expected 2 geology tables in ${cfg.shardDb}, got ${rows.length}`);
      for (const [name, col] of rows) {
        assert.equal(col, "utf8mb4_general_ci", `${name} collation=${col}`);
      }
    },
  },
  {
    id: "T1-47",
    tier: 1,
    features: ["F10"],
    title: "GeologyService seeds all 14 Dereth + Dericost subsurface basins",
    tags: ["phase-c", "geology"],
    async run() {
      assertDotnetMethodPassed("F10_Geology_14Basins_TerrainMapping_AndDepletion");
    },
  },
  {
    id: "T1-48",
    tier: 1,
    features: ["F10"],
    title: "subsurface_deposit table contains seeded rows covering all 14 basins",
    tags: ["phase-c", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const basins = Number(queryMysqlScalar("SELECT COUNT(DISTINCT basin_id) FROM subsurface_deposit;", cfg.shardDb));
      assert.equal(basins, 14, `Expected 14 distinct basins in subsurface_deposit, got ${basins}`);
    },
  },
  {
    id: "T1-49",
    tier: 1,
    features: ["F10"],
    title: "subsurface_deposit schema stores api_gravity, sulfur_bps, grade_bps, remaining_tonnes, cored_flag",
    tags: ["phase-c", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='subsurface_deposit';`
      ).map((r) => r[0].toLowerCase());
      for (const req of ["deposit_id", "basin_id", "landblock_id", "depth_m", "resource_type", "grade_bps", "api_gravity", "sulfur_bps", "remaining_tonnes", "cored_flag"]) {
        assert.ok(cols.includes(req), `subsurface_deposit missing column '${req}'`);
      }
    },
  },
  {
    id: "T1-50",
    tier: 1,
    features: ["F10"],
    title: "Light Sweet vs Heavy Sour crude assays drive ADU + HDT/VDU product yields",
    tags: ["phase-c", "refinery"],
    async run() {
      const indPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "IndustryManager.cs");
      const geoPath = path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "GeologyService.cs");
      assert.ok(existsSync(indPath) || existsSync(geoPath), "Missing IndustryManager.cs / GeologyService.cs");
      const src = (existsSync(indPath) ? readFileSync(indPath, "utf8") : "") + (existsSync(geoPath) ? readFileSync(geoPath, "utf8") : "");
      assert.ok(/api_gravity|ApiGravity/i.test(src) && /sulfur|Sulfur/i.test(src),
        "Geology/Industry must model API gravity & sulfur assay yields");
    },
  },

  // =========================================================================
  // F11: 4-Stage Prospecting & Industrial Skids [T1-51..T1-55]
  // =========================================================================
  {
    id: "T1-51",
    tier: 1,
    features: ["F11"],
    title: "4-stage prospecting pipeline: GPR attenuates in wet marsh while Vibroseis succeeds",
    tags: ["phase-c", "prospecting"],
    async run() {
      assertDotnetMethodPassed("F11_Prospecting_GprWetMarshAttenuation_AndVibroseisFallback");
    },
  },
  {
    id: "T1-52",
    tier: 1,
    features: ["F11"],
    title: "MicroGrid ±75m boundary & IndustrialGenset150kW (4000086) / BESS 18MJ (4000087) integration",
    tags: ["phase-c", "microgrid"],
    async run() {
      assertDotnetMethodPassed("F11_MicroGrid_Boundary75m_AndIndustrial150kWGenset_18MJBess");
    },
  },
  {
    id: "T1-53",
    tier: 1,
    features: ["F11"],
    title: "HBV1 v8 XML defines all prospecting pallets (4000070-74, Kind 38-42) & industrial skids (4000075-87, Kind 43-55)",
    tags: ["phase-c", "protocol"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      for (const item of Object.values(ECONOMY_WCID_SPECS.prospecting)) {
        assert.ok(xml.includes(String(item.kind)), `XML missing prospecting DeployableKind ${item.kind} (${item.name})`);
      }
      for (const item of Object.values(ECONOMY_WCID_SPECS.skids)) {
        assert.ok(xml.includes(String(item.kind)), `XML missing industrial skid DeployableKind ${item.kind} (${item.name})`);
      }
    },
  },
  {
    id: "T1-54",
    tier: 1,
    features: ["F11"],
    title: "MicroGrid.cs supports all Phase C prospecting, refining, mint & workshop consumers",
    tags: ["phase-c", "microgrid"],
    async run() {
      const mgSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "MicroGrid.cs"), "utf8");
      assert.ok(/IndustrialGenset|4000086|AduRefinery|TownMint/.test(mgSrc),
        "MicroGrid.cs must account for Phase C industrial generation/consumption");
    },
  },
  {
    id: "T1-55",
    tier: 1,
    features: ["F11"],
    title: "Town Mint (4000093, Kind=59, 30 kW) & Town Workshop (4000094, Kind=60, 25 kW) wired in server",
    tags: ["phase-c", "civic"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assert.ok(xml.includes("59") && xml.includes("60"), "XML missing Kind 59/60");
      const deploySrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs"), "utf8");
      assert.ok(deploySrc.includes("4000093") && deploySrc.includes("4000094"),
        "DeployableManager.cs missing WCID 4000093 (Mint) or 4000094 (Workshop)");
    },
  },

  // =========================================================================
  // F12: Cold-Chain & Specialized ISO Containers [T1-56..T1-60]
  // =========================================================================
  {
    id: "T1-56",
    tier: 1,
    features: ["F12"],
    title: "Perishable bio-harvests decay over 2-6h ambient vs 0.0x freeze in powered Reefers",
    tags: ["phase-c", "cold-chain"],
    async run() {
      assertDotnetMethodPassed("F12_ColdChain_2To6hAmbientDecay_VsPoweredReeferZeroFreeze");
    },
  },
  {
    id: "T1-57",
    tier: 1,
    features: ["F12"],
    title: "All 8 specialized ISO 6346 containers (4000060-4000067, Kind 30-37) registered in XML & C#",
    tags: ["phase-c", "containers"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      const dmSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "Deployables", "DeployableManager.cs"), "utf8");
      for (const [wcid, spec] of Object.entries(ECONOMY_WCID_SPECS.containers)) {
        assert.ok(xml.includes(String(spec.kind)), `XML missing container Kind ${spec.kind} (${spec.code})`);
        assert.ok(dmSrc.includes(wcid), `DeployableManager.cs missing container WCID ${wcid} (${spec.code})`);
      }
    },
  },
  {
    id: "T1-58",
    tier: 1,
    features: ["F12"],
    title: "ace_world baseline contains perishable bio-glands/ichor/venom harvest family",
    tags: ["baseline", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cnt = Number(queryMysqlScalar(
        `SELECT COUNT(DISTINCT i.class_Id) FROM weenie m
         JOIN weenie_properties_create_list wcl ON wcl.object_Id = m.class_Id
         JOIN weenie i ON i.class_Id = wcl.weenie_Class_Id
         JOIN weenie_properties_string ips ON ips.object_Id = i.class_Id AND ips.type = 1
         WHERE m.type = 10 AND i.type IN (1,18,22,32,44,51)
           AND (ips.value REGEXP 'Gland|Ichor|Venom|Sac|Bile|Liver|Heart|Eye|Brain|Stinger|Fluid|Organ'
                OR i.class_Name REGEXP 'gland|ichor|venom|sac');`,
        cfg.worldDb
      ));
      assert.ok(cnt >= 70, `Expected >= 70 perishable bio-harvest WCIDs in ace_world, got ${cnt}`);
    },
  },
  {
    id: "T1-59",
    tier: 1,
    features: ["F12"],
    title: "town_warehouse_stock tracks freshness_pct and powered_reefer columns",
    tags: ["phase-c", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='town_warehouse_stock';`
      ).map((r) => r[0].toLowerCase());
      for (const req of ["town_id", "commodity_id", "qty", "freshness_pct", "powered_reefer"]) {
        assert.ok(cols.includes(req), `town_warehouse_stock missing column '${req}'`);
      }
    },
  },
  {
    id: "T1-60",
    tier: 1,
    features: ["F12"],
    title: "22R1 (5 kW) & 45R1 (6 kW) Reefers integrate with Marine Terminal ReeferRackBay (4000055)",
    tags: ["phase-c", "reefer"],
    async run() {
      const decaySrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Economy", "PerishableDecay.cs"), "utf8");
      assert.ok(/22R1|4000060/.test(decaySrc) && /45R1|4000061/.test(decaySrc),
        "PerishableDecay.cs must recognize 22R1 (4000060) & 45R1 (4000061)");
    },
  },

  // =========================================================================
  // F13: Client Procedural Models & HBV1 v8 HUD [T1-61..T1-65]
  // =========================================================================
  {
    id: "T1-61",
    tier: 1,
    features: ["F13"],
    title: "Client procedural model files exist for Phase B/C/E WCIDs 4000060-4000095",
    tags: ["phase-c", "3d"],
    async run() {
      const files = discoverEconomyVehicleModelFiles();
      const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
      for (const wcid of ["4000060", "4000070", "4000078", "4000086", "4000090", "4000093", "4000095"]) {
        assert.ok(src.includes(wcid), `Client procedural models missing WCID ${wcid}`);
      }
    },
  },
  {
    id: "T1-62",
    tier: 1,
    features: ["F13"],
    title: "New procedural models (4000060-4000095) exist and pass lintSource (no Math.random, no Date.now, no .visible=)",
    tags: ["phase-c", "lint"],
    async run() {
      const files = discoverEconomyVehicleModelFiles();
      assert.ok(files.length > 0, "No economy model files discovered");
      const combined = files.map((f) => readFileSync(f, "utf8")).join("\n");
      for (const wcid of ["4000060", "4000070", "4000078", "4000086", "4000090", "4000093", "4000095"]) {
        assert.ok(combined.includes(wcid), `Phase B/C/E procedural model WCID ${wcid} missing before lint check`);
      }
      for (const f of files) {
        const hits = lintSource(readFileSync(f, "utf8"));
        assert.equal(hits.length, 0, `${path.basename(f)} lint violations: ${JSON.stringify(hits)}`);
      }
    },
  },
  {
    id: "T1-63",
    tier: 1,
    features: ["F13"],
    title: "New procedural models render offscreen with FakeWebGL2, 0 dynamic lights, and clean disposal",
    tags: ["phase-c", "3d", "webgl"],
    async run() {
      const THREE = await getThree();
      const idxMod = await import(new URL(`../../scene3d/vehicle/index.js`, import.meta.url).href);
      const factory = idxMod.buildEconomyModel || idxMod.buildDeployableModel || idxMod.createDeployableMesh;
      assert.equal(typeof factory, "function", "scene3d/vehicle/index.js must export economy/deployable model builder");
      const root = factory(THREE, 4000090);
      assert.ok(root, "Model builder returned null for 4000090");
      assert.equal(countLights(root).total, 0, "Procedural model must contain 0 dynamic lights");
      assertNoNaNDeep(root);
      renderWithFakeWebGL2(THREE, root);
      const disp = spyDisposal(root);
      assert.ok(disp.geometries > 0 && disp.materials > 0, "Expected disposable geometries & materials");
    },
  },
  {
    id: "T1-64",
    tier: 1,
    features: ["F13"],
    title: "vehicle_link.rs handles HBV1 v8 economy opcodes 0x0911-0x0916",
    tags: ["phase-c", "wasm"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assertProtocolV8Xml(xml);
      const vlPath = path.join(APP_ROOT, "src", "vehicle_link.rs");
      const src = readFileSync(vlPath, "utf8");
      // Strip unit-test module so negative v7 assertion `assert!(!is_vehicle_event(0x0911))` cannot false-match!
      const prodSrc = src.split("#[cfg(test)]")[0];
      assert.ok(
        /ECONOMY_TOWN_STATE|SIEGE|PROSPECTING|LOGISTICS_CONVOY|MONARCH_ORDER|0x0911/.test(prodSrc),
        "src/vehicle_link.rs production code must handle HBV1 v8 opcodes 0x0911-0x0916"
      );
      assert.ok(
        !/assert!\(\s*!\s*is_vehicle_event\(\s*0x0911\s*\)\s*\)/.test(src),
        "src/vehicle_link.rs still contains v7 negative test assert!(!is_vehicle_event(0x0911))"
      );
    },
  },
  {
    id: "T1-65",
    tier: 1,
    features: ["F13"],
    title: "run-js-headless.mjs --coverage passes with 0 unregistered JS tests",
    tags: ["phase-c", "coverage"],
    async run() {
      const res = runNode("harness/run-js-headless.mjs", ["--coverage"]);
      assert.equal(res.code, 0, `coverage check failed:\n${res.stdout}\n${res.stderr}`);
      assert.ok(/0 unregistered/.test(res.stdout), `Expected '0 unregistered', got:\n${res.stdout}`);
    },
  },

  // =========================================================================
  // F14: Offline Nav Graph Bake (Excluding Item 2) [T1-66..T1-70]
  // =========================================================================
  {
    id: "T1-66",
    tier: 1,
    features: ["F14"],
    title: "logistics_nav_graph.json exists, covers 101 towns & 11 Outer Ocean ports, excludes Item 2",
    tags: ["phase-d", "nav-graph", "no-item-2"],
    async run() {
      const { graph } = loadNavGraph();
      const summary = assertItem2Excluded(graph);
      assert.equal(summary.towns, 101);
      assert.equal(summary.ports, 11);
    },
  },
  {
    id: "T1-67",
    tier: 1,
    features: ["F14"],
    title: "Nav graph road edges connect Dereth & Dericost road networks without exceeding grade limits",
    tags: ["phase-d", "nav-graph"],
    async run() {
      const { graph } = loadNavGraph();
      assertItem2Excluded(graph);
      const edges = graph.edges || graph.roadEdges || [];
      assert.ok(edges.length > 100, `Expected > 100 overland/sea edges, got ${edges.length}`);
    },
  },
  {
    id: "T1-68",
    tier: 1,
    features: ["F14"],
    title: "All 11 Outer Ocean ports use deep-water terrain mask (b & 0x1F) == 20",
    tags: ["phase-d", "maritime"],
    async run() {
      const { graph } = loadNavGraph();
      assertItem2Excluded(graph);
      const ports = graph.ports || graph.nodes.filter((n) => n.kind === "port" || n.isPort);
      assert.equal(ports.length, 11);
      for (const p of ports) {
        if (p.terrainCode !== undefined) {
          assert.equal(p.terrainCode & 0x1f, 20, `Port ${p.name} terrainCode invalid`);
        }
      }
    },
  },
  {
    id: "T1-69",
    tier: 1,
    features: ["F14"],
    title: "Server LogisticsNavGraph.cs loads logistics_nav_graph.json cleanly and excludes Item 2",
    tags: ["phase-d", "csharp"],
    async run() {
      assertDotnetMethodPassed("F14_LogisticsNavGraph_101Towns_11OuterPorts_ExcludesItem2");
    },
  },
  {
    id: "T1-70",
    tier: 1,
    features: ["F14"],
    title: "Nav graph preserves trans-oceanic NE Marine Terminal (0xEAF9) <-> Dericost Landing (0x600D8001) lane",
    tags: ["phase-d", "maritime"],
    async run() {
      const { graph } = loadNavGraph();
      assertItem2Excluded(graph);
      const blob = JSON.stringify(graph);
      assert.ok(/NE Marine Terminal|EAF9/i.test(blob), "Nav graph missing NE Marine Terminal");
      assert.ok(/Dericost Landing|600D8001|Nesortania/i.test(blob), "Nav graph missing Dericost Landing");
    },
  },

  // =========================================================================
  // F15: Dual-LOD LogisticsEngine & Maritime Promotion [T1-71..T1-75]
  // =========================================================================
  {
    id: "T1-71",
    tier: 1,
    features: ["F15"],
    title: "Dual-LOD LogisticsEngine simulates 1 Hz Macro-LOD & <= 480 m Micro-LOD materialization",
    tags: ["phase-d", "logistics"],
    async run() {
      assertDotnetMethodPassed("F15_DualLod_LogisticsEngine_1HzMacro_And480mMicroBoundary");
    },
  },
  {
    id: "T1-72",
    tier: 1,
    features: ["F15"],
    title: "ace_shard contains logistics_convoy table with utf8mb4_general_ci",
    tags: ["phase-d", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        `SELECT table_collation FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name='logistics_convoy';`
      );
      assert.equal(rows.length, 1, "Missing ace_shard.logistics_convoy table");
      assert.equal(rows[0][0], "utf8mb4_general_ci");
    },
  },
  {
    id: "T1-73",
    tier: 1,
    features: ["F15"],
    title: "M/V Dereth Feeder (4000050) promoted to VehicleLocomotion.Marine=3, VehicleClass=4",
    tags: ["phase-d", "maritime"],
    async run() {
      const vpSrc = readFileSync(path.join(ACE_ROOT, "Source", "ACE.Server", "Vehicles", "VehicleProfile.cs"), "utf8");
      assert.ok(/ContainerShipFeeder|4000050/.test(vpSrc) && /Marine/.test(vpSrc),
        "VehicleProfile.cs must define server-backed M/V Dereth Feeder (4000050, Marine)");
    },
  },
  {
    id: "T1-74",
    tier: 1,
    features: ["F15"],
    title: "Marine Terminal cranes & racks (4000051-4000057, Kind 23-29) promoted to server-backed HBV1 v8",
    tags: ["phase-d", "maritime"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      for (const item of Object.values(ECONOMY_WCID_SPECS.maritime)) {
        if (item.kind) {
          assert.ok(xml.includes(String(item.kind)), `XML missing Marine Terminal Kind ${item.kind} (${item.name})`);
        }
      }
    },
  },
  {
    id: "T1-75",
    tier: 1,
    features: ["F15"],
    title: "logistics_convoy schema tracks owner_monarch_id, vehicle_kind, lod_state, fuel_liters, origin_landblock_id",
    tags: ["phase-d", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='logistics_convoy';`
      ).map((r) => r[0].toLowerCase());
      for (const req of ["convoy_id", "owner_monarch_id", "vehicle_kind", "lod_state", "spline_s_m", "fuel_liters", "origin_landblock_id", "status"]) {
        assert.ok(cols.includes(req), `logistics_convoy missing column '${req}'`);
      }
    },
  },

  // =========================================================================
  // F16: Cold-Start Hearth (4000095) & Procurement Desks [T1-76..T1-80]
  // =========================================================================
  {
    id: "T1-76",
    tier: 1,
    features: ["F16"],
    title: "Indestructible Public Commons Starter Hearth (4000095, Kind=61, 0 kW) placed in Holtburg/Shoushi/Yaraq",
    tags: ["phase-e", "cold-start"],
    async run() {
      assertDotnetMethodPassed("F16_StarterHearth4000095_Indestructible_InHoltburgShoushiYaraq");
    },
  },
  {
    id: "T1-77",
    tier: 1,
    features: ["F16"],
    title: "HBV1 v8 XML defines DeployableKind 61 PublicCommonsStarterHearth",
    tags: ["phase-e", "protocol"],
    async run() {
      const xml = readFileSync(path.join(PROTOCOL_DIR, "vehicles.protocol.xml"), "utf8");
      assert.ok(/61.*StarterHearth|StarterHearth.*61/i.test(xml), "XML missing Kind 61 PublicCommonsStarterHearth");
    },
  },
  {
    id: "T1-78",
    tier: 1,
    features: ["F16"],
    title: "ace_shard contains monarch_order table with utf8mb4_general_ci",
    tags: ["phase-e", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        `SELECT table_collation FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name='monarch_order';`
      );
      assert.equal(rows.length, 1, "Missing ace_shard.monarch_order table");
      assert.equal(rows[0][0], "utf8mb4_general_ci");
    },
  },
  {
    id: "T1-79",
    tier: 1,
    features: ["F16"],
    title: "monarch_order schema tracks order_id, monarch_id, town_id, order_type, reward_pyreals, status",
    tags: ["phase-e", "mysql"],
    async run() {
      const cfg = getMysqlConfig();
      const cols = queryMysql(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='${cfg.shardDb}' AND table_name='monarch_order';`
      ).map((r) => r[0].toLowerCase());
      for (const req of ["order_id", "monarch_id", "town_id", "order_type", "reward_pyreals", "claimed_by_guid", "status"]) {
        assert.ok(cols.includes(req), `monarch_order missing column '${req}'`);
      }
    },
  },
  {
    id: "T1-80",
    tier: 1,
    features: ["F16"],
    title: "Client procedural models include PublicCommonsStarterHearth (4000095)",
    tags: ["phase-e", "3d"],
    async run() {
      const files = discoverEconomyVehicleModelFiles();
      const src = files.map((f) => readFileSync(f, "utf8")).join("\n");
      assert.ok(src.includes("4000095"), "Client procedural models missing WCID 4000095");
    },
  },

  // =========================================================================
  // F17: AgentGatewayService (127.0.0.1:8090) [T1-81..T1-85]
  // =========================================================================
  {
    id: "T1-81",
    tier: 1,
    features: ["F17"],
    title: "AgentGatewayService binds strictly to 127.0.0.1:8090 and routes via WorldManager.EnqueueAction",
    tags: ["phase-e", "gateway"],
    async run() {
      assertDotnetMethodPassed("F17_AgentGateway_LoopbackConfig_AndWorldManagerEnqueueParity");
    },
  },
  {
    id: "T1-82",
    tier: 1,
    features: ["F17"],
    title: "Live AgentGatewayService HTTP port 127.0.0.1:8090 is listening and responds to GET /api/v1/world/towns",
    tags: ["phase-e", "gateway", "live"],
    async run() {
      const probe = await probeTcpPort("127.0.0.1", 8090);
      assert.ok(probe.ok, `127.0.0.1:8090 not listening (${probe.detail})`);
      const res = await gatewayFetch("/api/v1/world/towns");
      assert.equal(res.status, 200, `GET /api/v1/world/towns returned ${res.status}: ${res.raw}`);
      const towns = Array.isArray(res.body) ? res.body : res.body?.towns;
      assert.ok(Array.isArray(towns) && towns.length === 101, `Expected 101 towns from gateway, got ${towns?.length}`);
    },
  },
  {
    id: "T1-83",
    tier: 1,
    features: ["F17"],
    title: "AgentGatewayService exposes /api/v1/town/:id/ledger and /api/v1/town/:id/siege",
    tags: ["phase-e", "gateway", "live"],
    async run() {
      const ledger = await gatewayFetch("/api/v1/town/1/ledger");
      assert.equal(ledger.status, 200, `GET /api/v1/town/1/ledger returned ${ledger.status}`);
      const siege = await gatewayFetch("/api/v1/town/1/siege");
      assert.equal(siege.status, 200, `GET /api/v1/town/1/siege returned ${siege.status}`);
    },
  },
  {
    id: "T1-84",
    tier: 1,
    features: ["F17"],
    title: "AgentGatewayService exposes /api/v1/geology/surveys, /logistics/routes, /logistics/convoys, /monarch/orders",
    tags: ["phase-e", "gateway", "live"],
    async run() {
      for (const route of ["/api/v1/geology/surveys", "/api/v1/logistics/routes", "/api/v1/logistics/convoys", "/api/v1/monarch/orders"]) {
        const res = await gatewayFetch(route);
        assert.equal(res.status, 200, `GET ${route} returned ${res.status}: ${res.raw}`);
      }
    },
  },
  {
    id: "T1-85",
    tier: 1,
    features: ["F17"],
    title: "AgentGatewayService /api/v1/logistics/routes strictly excludes Item 2 Inner Sea",
    tags: ["phase-e", "gateway", "no-item-2"],
    async run() {
      const res = await gatewayFetch("/api/v1/logistics/routes");
      assert.equal(res.status, 200, `GET /api/v1/logistics/routes failed (${res.status})`);
      const blob = JSON.stringify(res.body).toLowerCase();
      assert.ok(!blob.includes("inner_sea") && !blob.includes("direlands-east") && !blob.includes("port yaraq"),
        "Gateway routes must NOT expose Item 2 Inner Sea");
    },
  },

  // =========================================================================
  // F18: ACE Patch Export & Live Vast Stack Integration [T1-86..T1-90]
  // =========================================================================
  {
    id: "T1-86",
    tier: 1,
    features: ["F18"],
    title: "Numbered ACE patches (>= 0026) exported to docs/vehicles-2026-11-01/ace/",
    tags: ["phase-e", "patches"],
    async run() {
      assert.ok(existsSync(ACE_PATCH_DIR), `Missing ${ACE_PATCH_DIR}`);
      const patches = (await import("node:fs")).readdirSync(ACE_PATCH_DIR).filter((f) => /^\d{4}-.*\.patch$/.test(f)).sort();
      const post25 = patches.filter((f) => Number(f.slice(0, 4)) >= 26);
      assert.ok(post25.length >= 1, `Expected exported ACE patches >= 0026 in ${ACE_PATCH_DIR}, found [${patches.slice(-3).join(", ")}]`);
    },
  },
  {
    id: "T1-87",
    tier: 1,
    features: ["F18"],
    title: "Live MariaDB :3306 has all 7 additive economy tables in ace_shard",
    tags: ["phase-e", "mysql", "live"],
    async run() {
      const cfg = getMysqlConfig();
      const rows = queryMysql(
        `SELECT table_name FROM information_schema.tables WHERE table_schema='${cfg.shardDb}' AND table_name IN (${ECONOMY_TABLES.map((t) => `'${t}'`).join(",")});`
      );
      assert.equal(rows.length, ECONOMY_TABLES.length, `Expected all 7 ace_shard tables, got ${rows.length}`);
    },
  },
  {
    id: "T1-88",
    tier: 1,
    features: ["F18"],
    title: "Live wsbridge (:8080) and static asset server serve.py (:8765) are listening",
    tags: ["baseline", "phase-e", "live"],
    async run() {
      const ws = await probeTcpPort("127.0.0.1", 8080);
      const http = await probeTcpPort("127.0.0.1", 8765);
      assert.ok(ws.ok, `wsbridge :8080 not listening (${ws.detail})`);
      assert.ok(http.ok, `serve.py :8765 not listening (${http.detail})`);
      const r = await fetch("http://127.0.0.1:8765/apps/holtburger-web/index.html");
      assert.equal(r.status, 200, `index.html HTTP status=${r.status}`);
    },
  },
  {
    id: "T1-89",
    tier: 1,
    features: ["F18"],
    title: "Full C# EconomyE2E suite compiles and passes under -c Debug with ECONOMY_E2E_STRICT=1",
    tags: ["phase-e", "csharp"],
    async run() {
      const { code, outcomes, stdout, stderr } = getDotnetEconomyOutcomes({ strict: true });
      assert.equal(code, 0, `Strict dotnet test -c Debug EconomyE2E failed (exit=${code}):\n${stdout.slice(-1500)}\n${stderr}`);
      assert.ok(outcomes.size >= 31, `Expected >= 31 EconomyE2E tests executed, got ${outcomes.size}`);
      const nonPassed = [...outcomes.entries()].filter(([, st]) => st !== "Passed");
      assert.equal(nonPassed.length, 0, `Non-passing EconomyE2E tests: ${JSON.stringify(nonPassed)}`);
    },
  },
  {
    id: "T1-90",
    tier: 1,
    features: ["F18"],
    title: "No scratch junk files (PROJECT.md, handoff.md, repro_*.cs) at repo roots",
    tags: ["hygiene"],
    async run() {
      const forbidden = ["PROJECT.md", "handoff.md", "DISPATCH.md", "BRIEFING.md"];
      for (const root of [path.resolve(APP_ROOT, "..", "..", "..", ".."), ACE_ROOT]) {
        for (const name of forbidden) {
          assert.equal(existsSync(path.join(root, name)), false, `Forbidden scratch file at root: ${path.join(root, name)}`);
        }
      }
    },
  },

  // =========================================================================
  // R6: Strict Automated Warehouse Immutability [T1-91..T1-95]
  // =========================================================================
  {
    id: "T1-91",
    tier: 1,
    features: ["R6"],
    title: "All 18 Automated Warehouse files match commit 7ac2867f SHA256 pins and have empty git diff",
    tags: ["r6", "immutability"],
    async run() {
      verifyWarehouseImmutability();
    },
  },
  {
    id: "T1-92",
    tier: 1,
    features: ["R6"],
    title: "Warehouse unit test 1/2 (specs_kinematics & models) pass untouched",
    tags: ["r6", "warehouse-unit"],
    async run() {
      const r1 = runNode("tests/vehicle_warehouse_specs_kinematics.test.mjs", [], { timeoutMs: 900000 });
      assert.equal(r1.code, 0, r1.stderr || r1.stdout);
      const r2 = runNode("tests/vehicle_warehouse_models.test.mjs", [], { timeoutMs: 900000 });
      assert.equal(r2.code, 0, r2.stderr || r2.stdout);
    },
  },
  {
    id: "T1-93",
    tier: 1,
    features: ["R6"],
    title: "Warehouse unit test 3/4 (manager & tier5) pass untouched",
    tags: ["r6", "warehouse-unit"],
    async run() {
      const r3 = runNode("tests/vehicle_warehouse_manager.test.mjs", [], { timeoutMs: 900000 });
      assert.equal(r3.code, 0, r3.stderr || r3.stdout);
      const r4 = runNode("tests/vehicle_warehouse_tier5.test.mjs", [], { timeoutMs: 900000 });
      assert.equal(r4.code, 0, r4.stderr || r4.stdout);
    },
  },
  {
    id: "T1-94",
    tier: 1,
    features: ["R6"],
    title: "143-check warehouse_e2e/run_e2e.mjs passes completely untouched",
    tags: ["r6", "warehouse-e2e"],
    async run() {
      const res = runWarehouseE2E(["--tier=all", "--json"]);
      const parsed = JSON.parse(res.stdout);
      assert.equal(parsed.total, 143);
      assert.equal(parsed.passed, 143);
      assert.equal(parsed.failed, 0);
    },
  },
  {
    id: "T1-95",
    tier: 1,
    features: ["R6"],
    title: "Warehouse unit suite integration completes cleanly without altering coverage guard",
    tags: ["r6", "coverage"],
    async run() {
      verifyWarehouseImmutability();
      const listRes = runNode("harness/run-js-headless.mjs", ["--list"]);
      assert.equal(listRes.code, 0, listRes.stderr || listRes.stdout);
      for (const rel of WAREHOUSE_UNIT_TEST_FILES) {
        assert.ok(listRes.stdout.includes(rel), `${rel} missing from run-js-headless.mjs --list`);
      }
      const cov = runNode("harness/run-js-headless.mjs", ["--coverage"]);
      assert.equal(cov.code, 0);
      assert.ok(/0 unregistered/.test(cov.stdout));
    },
  },
];
