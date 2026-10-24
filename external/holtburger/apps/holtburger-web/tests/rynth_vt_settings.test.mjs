// tests/rynth_vt_settings.test.mjs — rynth/vt/settings schema, VtOptions and
// live cells (PLAN W1-2 SET, §3.5, §4; covers O1, O5-O23 option rows).
//
// Pure node: an in-memory spy Storage, a fake bot shaped like createGrindBot()
// (combat / loot / buff / vitals loops, host, control, setBuffs, buffSpec) and
// the real applyHudOverrides from rynth/boot.js to pin the hudBootOverrides()
// shape. No window, no network.
//
// Run from apps/holtburger-web/:  node tests/rynth_vt_settings.test.mjs

import assert from "node:assert/strict";

const S = await import("../rynth/vt/settings/index.js");
const boot = await import("../rynth/boot.js");
const {
  SCHEMA, findRow, findRowIn, buildIndex, coerce, present, defaults, PRESETS, LIST_KEYS, REF_KEYS, LBF_M,
  ProfileStore, createVtOptions, createLiveCells, HUD_BLOB_KEY,
} = S;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 4).join("\n       ") : e}`);
  }
}

// ── fakes ──────────────────────────────────────────────────────────────────
let T = 1_800_000_000_000;
const now = () => T;
const logs = [];
const quiet = (m) => logs.push(m);

function spyStorage() {
  const m = new Map();
  const s = {
    quota: false,
    writes: [],
    removes: [],
    m,
    get length() {
      return m.size;
    },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      if (s.quota) {
        const e = new Error("The quota has been exceeded.");
        e.name = "QuotaExceededError";
        throw e;
      }
      s.writes.push(k);
      m.set(k, String(v));
    },
    removeItem(k) {
      s.removes.push(k);
      m.delete(k);
    },
  };
  return s;
}

const VITALS_DEFAULT = {
  healAtCombat: 60, getManaAtCombat: 40, restamAtCombat: 30, topOffHp: 95, topOffStam: 95, topOffMana: 95,
  emergencyHp: 30, emergencyStamFloor: 20, manaRechargeStamFloor: 15,
};

/** A createGrindBot()-shaped fake. int1:false = today's loops (no monsterRangeM /
 *  corpseRangeM / rebuffSecondsRemaining fields yet). */
function fakeBot({ int1 = true, buff = true, control = true, nearby = 60 } = {}) {
  const bot = {
    host: { nearbyRangeM: nearby },
    combat: {
      enabled: true, meleePower: 0.6, missileAccuracy: 0.6, attackHeight: 2, blacklistAttempts: 3,
      blacklistTimeoutMs: 30_000, priorities: {}, invalidated: 0,
      invalidateScan() {
        this.invalidated++;
      },
    },
    loot: { enabled: true, minValue: 0 },
    buff: null,
    vitals: { cfg: { ...VITALS_DEFAULT } },
    buffSpec: null,
    setBuffsCalls: [],
    setBuffs(spec) {
      this.setBuffsCalls.push(spec);
      this.buffSpec = spec === "auto" ? "auto" : Array.isArray(spec) ? spec.slice() : [];
      if (!this.buff) this.buff = { enabled: true, ...(int1 ? { rebuffSecondsRemaining: 300 } : {}) };
      return Promise.resolve([]);
    },
  };
  if (int1) {
    bot.combat.monsterRangeM = 40;
    bot.loot.corpseRangeM = 30;
  }
  if (buff) bot.buff = { enabled: true, ...(int1 ? { rebuffSecondsRemaining: 300 } : {}) };
  if (control) {
    bot.control = {
      calls: [],
      setEnabled(name, on) {
        this.calls.push([name, on]);
        const loop = bot[name];
        if (!loop) return { ok: false, error: `no ${name} loop on this bot` };
        loop.enabled = !!on;
        return { ok: true };
      },
    };
  }
  return bot;
}

function mk({ storage = spyStorage(), scope = "1001", bot = null } = {}) {
  const profiles = new ProfileStore({ storage, scope, charName: "Tester", now, log: quiet });
  const options = createVtOptions({ profiles, now, log: quiet });
  let cells = null;
  if (bot) {
    cells = createLiveCells(bot);
    options.bindCells(cells);
  }
  return { storage, profiles, options, cells, bot };
}

const readRecord = (storage, key) => JSON.parse(storage.getItem(key));
const sharedKey = (n) => `rynth.vt.v1.profile.shared.${n}`;

// ── schema ─────────────────────────────────────────────────────────────────
await check("schema: unique keys, VTank names unique case-insensitively, rows well-formed", () => {
  const keys = new Set();
  const names = new Map(); // lower name → row key
  for (const row of SCHEMA) {
    assert.ok(/^[A-Za-z][A-Za-z0-9]*$/.test(row.key), `key ${row.key} is an identifier`);
    assert.ok(!keys.has(row.key), `duplicate key ${row.key}`);
    keys.add(row.key);
    assert.ok(["bool", "int", "float", "enum", "string"].includes(row.type), `${row.key} type`);
    assert.ok(["options", "advanced", "profiles", "vitals", "route", "meta"].includes(row.page), `${row.key} page`);
    assert.ok(row.group && row.label && row.consumer, `${row.key} group/label/consumer`);
    assert.ok(Array.isArray(row.vt) && Object.isFrozen(row), `${row.key} frozen with vt[]`);
    for (const n of new Set([row.key, ...row.vt].map((x) => x.toLowerCase()))) {
      assert.ok(!names.has(n) || names.get(n) === row.key, `name ${n} used by ${names.get(n)} and ${row.key}`);
      names.set(n, row.key);
    }
    if (row.type === "int" || row.type === "float") {
      assert.ok(typeof row.min === "number" && typeof row.max === "number", `${row.key} has a range`);
      assert.ok(row.dflt >= row.min && row.dflt <= row.max, `${row.key} default ${row.dflt} inside [${row.min},${row.max}]`);
      if (row.type === "int") assert.ok(Number.isInteger(row.dflt), `${row.key} int default`);
    }
    if (row.type === "enum") assert.ok(row.values.includes(row.dflt), `${row.key} enum default`);
    if (row.type === "bool") assert.equal(typeof row.dflt, "boolean", `${row.key} bool default`);
    if (row.vtUnit === "lbf") {
      assert.equal(row.unit, "m", `${row.key} lbf rows are metres`);
      assert.ok(row.vt.length > 0 && row.vt.every((n) => n.toLowerCase() !== row.key.toLowerCase()),
        `${row.key}: canonical key must differ from its lbf VTank name`);
    }
  }
  assert.ok(Object.isFrozen(SCHEMA));
});

await check("schema: every guide option (G:1-66) and every §4.2 row is present", () => {
  const want = {
    MonsterRange: "AttackDistance", RingRange: "RingDistance", ApproachRange: "ApproachDistance",
    FollowNavMin: "NavCloseStopRange", EnableBuffing: "EnableBuffing", EnableCombat: "EnableCombat",
    EnableAutostack: "Autostack", EnableAutocram: "Autocram", UseDispelItems: "UseDispelItems",
    CastDispelSelf: "CastDispelSelf", AutoFellowMgmt: "AutoFellowManagement", ManaChargesWhenOff: "ManaChargesWhenOff",
    BoostNavPriority: "NavPriorityBoost", BoostLootPriority: "LootPriorityBoost", PeaceModeWhenIdle: "IdlePeaceMode",
    RebuffWhenIdle: "IdleBuffTopOff", SummonPets: "SummonPets", CustomPetRangeEnabled: "CustomPetRangeEnabled",
    CustomPetRange: "CustomPetRange", PetMinMonsters: "PetMonsterDensity", EnableNavigation: "EnableNav",
    EnableLooting: "EnableLooting", ShowEditor: "ShowEditor", HealAt: "Recharge-Norm-HitP",
    GetManaAt: "Recharge-Norm-Mana", RestamAt: "Recharge-Norm-Stam", TopOffHP: "Recharge-NoTarg-HitP",
    TopOffMana: "Recharge-NoTarg-Mana", TopOffStam: "Recharge-NoTarg-Stam", EnableMeta: "EnableMeta",
    RebuffSecondsRemaining: "RebufTimeRemainingSeconds", CorpseApproachRangeMax: "CorpseApproachRange-Max",
    BlacklistAttempts: "BlacklistMonsterAttemptCount", BlacklistTimeoutSec: "BlacklistMonsterTimeoutSeconds",
    OpenDoorRange: "DoorOpenRange", RefillWornManaItemManaPercent: "RefillWornMana-Item-ManaPercent",
  };
  for (const [key, vtName] of Object.entries(want)) {
    const f = findRow(vtName);
    assert.ok(f, `${vtName} resolves`);
    assert.equal(f.row.key, key, `${vtName} → ${key}`);
  }
  const more = ["EmergencyHP", "EmergencyStamFloor", "ManaRechargeStamFloor", "IdleRebuffWindowSec", "LootMinValue",
    "MeleeAttackPower", "MissileAttackPower", "AttackHeight", "WarSpellMode", "AllowUntargetedRings",
    "SwitchWandsToDebuff", "MinRingTargets", "BoostNavStrict", "PostPortalDelaySec", "OpenDoors", "AutoUnlockDoors",
    "EnableManaTapping", "RefillWornMana", "ManaTankMinimumMana", "ManaStoneLootCount", "MinimumHealKitSuccessChance",
    "SplitPeas", "GrenadeMinMonsters", "PetAutoRefill",
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `MinSkillLevelTier${i}`)];
  for (const k of more) assert.ok(findRow(k)?.row.key === k, `${k} row`);
  // The former "Not on web" rows went live on 2026-10-19; only Show Editor
  // (no function in VTank either, G:58) stays inert.
  assert.deepStrictEqual(SCHEMA.filter((r) => r.consumer === "inert").map((r) => r.key), ["ShowEditor"]);
  const live = {
    LootOnlyRareCorpses: "loot", LootFellowCorpses: "loot", LootAllCorpses: "loot", "CorpseApproachRange-Min": "loot",
    ReadUnknownScrolls: "loot", CombineSalvage: "loot", NavFarStopRange: "nav", FollowAroundCorners: "nav",
    DoorIDRange: "doors", TargetLock: "combat", AttackMinimumDistance: "combat", MonsterDisengageRange: "combat",
    TargetNoProgressTimeoutSec: "combat", DoJiggle: "combat", "SpellDiffExcessThreshold-Hunt": "planner",
    DoHelp: "helpers", HealOthersAt: "helpers", RestamOthersAt: "helpers", InfuseOthersAt: "helpers",
    "Recharge-Helper-HitP": "helpers", HelperDistanceHitP: "helpers", HelperDistanceStam: "helpers",
    HelperDistanceMana: "helpers", UseHealersHeart: "helpers", JumpOutWandCasting: "helpers",
    BuffProfile_Banes: "buff", "BuffProfile-Banes": "buff", BuffArmorImpen: "buff", EnableMissileCrafting: "ammo",
    StartMacroOnLogin: "login", EnableFPSLimit: "display", TargetFPSFocused: "display", TargetFPSBackground: "display",
    ShowTerrainPassability: "overlay",
  };
  for (const [n, c] of Object.entries(live)) assert.equal(findRow(n)?.row.consumer, c, `${n} is live (${c})`);
  assert.equal(SCHEMA.some((r) => r.group === "Not on web"), false, "no 'Not on web' group left");
  // VTank's route display widths drive the in-world route (scene3d/route_overlay.js, 2026-10-19)
  for (const n of ["NavRingThickness", "NavLineThickness"]) assert.equal(findRow(n)?.row.consumer, "overlay", `${n} draws the route`);
  for (const n of ["CorpseApproachRange-Min", "NavFarStopRange", "DoorIDRange", "HelperDistanceHitP", "AttackDistance",
    "ApproachDistance", "RingDistance", "NavCloseStopRange", "CorpseApproachRange-Max", "DoorOpenRange",
    "HelperDistanceStam", "HelperDistanceMana", "AttackMinimumDistance"]) {
    assert.equal(findRow(n).row.vtUnit, "lbf", `${n} is a landblock-fraction name`);
  }
  assert.deepStrictEqual([...LIST_KEYS], ["monsters", "items", "consumables", "buffs", "legacyPriorities"]);
  assert.deepStrictEqual([...REF_KEYS], ["navProfile", "metaName", "lootProfile"]);
});

await check("defaults() reproduce today's literals; every new toggle is off", () => {
  const d = defaults();
  const want = {
    MonsterRange: 40, FollowNavMin: 3, RebuffSecondsRemaining: 300, HealAt: 60, GetManaAt: 40, RestamAt: 30,
    TopOffHP: 95, TopOffMana: 95, TopOffStam: 95, EmergencyHP: 30, EmergencyStamFloor: 20, ManaRechargeStamFloor: 15,
    LootMinValue: 0, CorpseApproachRangeMax: 30, MeleeAttackPower: 0.6, MissileAttackPower: 0.6, AttackHeight: 2,
    BlacklistAttempts: 3, BlacklistTimeoutSec: 30, RingRange: 5, ApproachRange: 4, MinRingTargets: 4,
    EnableCombat: true, EnableBuffing: true, EnableLooting: true, EnableNavigation: false, EnableMeta: false,
    WarSpellMode: "legacy", AllowUntargetedRings: false, IdleRebuffWindowSec: 600, PetMinMonsters: 1,
    CustomPetRange: 5, GrenadeMinMonsters: 0, PostPortalDelaySec: 4,
  };
  for (const [k, v] of Object.entries(want)) assert.equal(d[k], v, `default ${k}`);
  for (const k of Object.keys(VITALS_DEFAULT)) {
    assert.equal(d[S.VITALS_FIELD_KEYS[k]], VITALS_DEFAULT[k], `vitals default ${k} = vitals.js DEFAULTS`);
  }
  const liveToday = new Set(["EnableCombat", "EnableBuffing", "EnableLooting", "PetAutoRefill"]);
  // Owner decision 2026-10-19: the rows made live that day take VTank's /
  // RynthAi's defaults — these start ON.
  const vtankOn = ["DoHelp", "UseHealersHeart", "BuffArmorImpen", "ReadUnknownScrolls", "CombineSalvage",
    "EnableMissileCrafting", "FollowAroundCorners", "EnableFPSLimit"];
  for (const k of vtankOn) {
    assert.equal(d[k], true, `${k} starts on (VTank/RynthAi default)`);
    liveToday.add(k);
  }
  // Owner decision 2026-10-23: the steep-ground tint starts OFF (it read as pink
  // panels on snow and dunes); one switch away on the Route tab.
  assert.equal(d.ShowTerrainPassability, false, "ShowTerrainPassability starts off (owner 2026-10-23)");
  liveToday.add("ShowTerrainPassability");
  assert.equal(d.BuffProfileBanes, "ALFCBPS", "every bane on worn armor (VTank: All)");
  assert.deepStrictEqual([d.HealOthersAt, d.RestamOthersAt, d.InfuseOthersAt, d.HelperHealDistance], [50, 10, 10, 30]);
  assert.deepStrictEqual([d.TargetFPSFocused, d.TargetFPSBackground], [60, 30]);
  for (const row of SCHEMA) {
    if (row.type !== "bool" || row.consumer === "inert" || liveToday.has(row.key)) continue;
    assert.equal(row.dflt, false, `new toggle ${row.key} defaults off`);
  }
  assert.equal(Object.keys(d).length, SCHEMA.length);
});

// ── coercion / units / resolver ────────────────────────────────────────────
await check("lbf round trip at the VTank-name boundary only (AttackDistance ⇔ 40 m, NavCloseStopRange ⇔ 3 m)", () => {
  const ad = findRow("AttackDistance");
  assert.equal(ad.viaVt, true);
  assert.deepStrictEqual(coerce(ad.row, "0.1666667", { viaVt: true }), { ok: true, value: 40 });
  assert.ok(Math.abs(present(ad.row, 40, { viaVt: true }) - 0.1666667) < 1e-6);
  assert.equal(coerce(ad.row, present(ad.row, 40, { viaVt: true }), { viaVt: true }).value, 40);
  const nc = findRow("NavCloseStopRange");
  assert.equal(nc.row.key, "FollowNavMin");
  assert.equal(coerce(nc.row, "0.0125", { viaVt: true }).value, 3);
  assert.equal(present(nc.row, 3, { viaVt: true }), 0.0125);
  assert.equal(LBF_M, 240);
  // canonical keys never convert
  assert.equal(present(ad.row, 40, { viaVt: false }), 40);
  assert.deepStrictEqual(coerce(ad.row, "0.5"), { ok: true, value: 1, clamped: true }, "MonsterRange 0.5 m clamps to 1");
  const { options } = mk();
  assert.equal(options.set("AttackDistance", "0.1666667").ok, true);
  assert.equal(options.getValue("MonsterRange"), 40);
  assert.equal(options.set("AttackDistance", 0.0833, { source: "command" }).value, 19.992);
  assert.equal(options.get("AttackDistance", { vtUnits: true }).value, 0.0833);
  assert.equal(options.get("AttackDistance").value, 19.992, "vtUnits:false reads canonical metres");
  assert.equal(options.get("MonsterRange", { vtUnits: true }).value, 19.992, "canonical key never converts");
  assert.equal(options.set("navclosestoprange", "0.0125").value, 3, "C# alias → FollowNavMin, lbf");
  assert.equal(options.getValue("FollowNavMin"), 3);
});

await check("bool parse table; other numeric ≠ 0; garbage rejected", () => {
  const row = findRow("SummonPets").row;
  const table = [
    ["true", true], ["TRUE", true], ["on", true], ["On", true], ["yes", true], ["YES", true], ["1", true],
    ["false", false], ["False", false], ["off", false], ["OFF", false], ["no", false], ["No", false], ["0", false],
    [" true ", true], ["2", true], ["-1", true], ["0.0", false], ["0.5", true], [true, true], [false, false],
    [1, true], [0, false], [3.5, true],
  ];
  for (const [raw, want] of table) {
    const r = coerce(row, raw);
    assert.equal(r.ok, true, `parse ${JSON.stringify(raw)}`);
    assert.equal(r.value, want, `bool ${JSON.stringify(raw)}`);
  }
  for (const raw of ["maybe", "", "t", null, undefined, { t: "list", items: [] }]) {
    assert.equal(coerce(row, raw).ok, false, `reject ${JSON.stringify(raw)}`);
  }
});

await check("int rounding, numeric clamping, enum/string values", () => {
  const pm = findRow("PetMinMonsters").row;
  assert.equal(coerce(pm, "3.6").value, 4);
  assert.equal(coerce(pm, "3.4").value, 3);
  assert.equal(coerce(pm, "-2").value, 1);
  assert.equal(coerce(pm, "99").value, 20);
  assert.equal(coerce(pm, "0x5").value, 5, "hex");
  assert.equal(coerce(pm, "abc").ok, false);
  assert.equal(coerce(findRow("HealAt").row, 150).value, 100);
  assert.equal(coerce(findRow("Recharge-Norm-HitP").row, "72.5").value, 73);
  const ah = findRow("AttackHeight").row;
  assert.equal(coerce(ah, "3").value, 3);
  assert.equal(coerce(ah, 1).value, 1);
  assert.equal(coerce(ah, "4").ok, false);
  assert.equal(coerce(findRow("WarSpellMode").row, "VTANK").value, "vtank");
  assert.equal(coerce(findRow("WarSpellMode").row, "nope").ok, false);
  assert.equal(coerce(findRow("ShowEditor").row, 12).value, true, "a bool row takes a number");
  assert.equal(coerce(findRow("BuffProfile_Banes").row, 7).value, "BPSAC", "the bane profile is VTank's enum or letters");
  assert.equal(coerce(findRow("BuffProfile_Banes").row, 12).ok, false);
  assert.equal(coerce(findRow("MeleeAttackPower").row, "1.7").value, 1);
});

await check("resolver order: key > VTank name > case-insensitive key > alias; fixed C# aliases; exactCase", () => {
  // order on a synthetic schema where one string is both a key and another row's VTank name
  const idx = buildIndex([
    { key: "Foo", vt: ["Bar"], type: "int", dflt: 0, min: 0, max: 9 },
    { key: "Bar", vt: ["Baz"], type: "int", dflt: 0, min: 0, max: 9 },
  ]);
  assert.equal(findRowIn(idx, "Bar").row.key, "Bar", "exact key wins over another row's VTank name");
  assert.equal(findRowIn(idx, "Bar").viaVt, false);
  assert.equal(findRowIn(idx, "baz").row.key, "Bar");
  assert.equal(findRowIn(idx, "bar").row.key, "Foo", "case-insensitive VTank name before case-insensitive key");
  assert.equal(findRowIn(idx, "bar", { exactCase: true }), null);

  assert.deepStrictEqual([findRow("MonsterRange").row.key, findRow("MonsterRange").viaVt], ["MonsterRange", false]);
  assert.deepStrictEqual([findRow("attackdistance").row.key, findRow("attackdistance").viaVt], ["MonsterRange", true]);
  assert.deepStrictEqual([findRow("monsterrange").row.key, findRow("monsterrange").viaVt], ["MonsterRange", false]);
  // the three C# alias bugs, fixed
  assert.equal(findRow("navclosestoprange").row.key, "FollowNavMin");
  assert.equal(findRow("switchwandstodebuff").row.key, "SwitchWandsToDebuff");
  assert.equal(findRow("lootonlyrarecorpses").row.key, "LootOnlyRareCorpses");
  // more VTank / RynthAi spellings
  assert.equal(findRow("enablenav").row.key, "EnableNavigation");
  assert.equal(findRow("idlepeacemode").row.key, "PeaceModeWhenIdle");
  assert.equal(findRow("mchargeswhenoff").row.key, "ManaChargesWhenOff");
  assert.equal(findRow("manastonekeepcount").row.key, "ManaStoneLootCount");
  assert.equal(findRow("rebuftimeremainingseconds").row.key, "RebuffSecondsRemaining");
  assert.equal(findRow("corpseapproachrange-max").row.key, "CorpseApproachRangeMax");
  // exactCase (setting_X, G:133)
  assert.equal(findRow("AttackDistance", { exactCase: true }).row.key, "MonsterRange");
  assert.equal(findRow("attackDistance", { exactCase: true }), null);
  assert.equal(findRow("MonsterRange", { exactCase: true }).row.key, "MonsterRange");
  assert.equal(findRow("monsterRange", { exactCase: true }), null);
  assert.equal(findRow("NoSuchOption"), null);
  assert.equal(findRow(""), null);
  assert.equal(findRow(null), null);
  const { options } = mk();
  assert.equal(options.get("attackdistance", { exactCase: true }).ok, false);
  assert.equal(options.get("AttackDistance", { exactCase: true, vtUnits: true }).value, 40 / 240);
  // an alias that is a lower-case VTank lbf name converts like that name, also on the exact-case path
  // (setting_navclosestoprange must not read metres where /vt opt get navclosestoprange reads lbf)
  assert.deepStrictEqual([findRow("navclosestoprange", { exactCase: true }).row.key,
    findRow("navclosestoprange", { exactCase: true }).viaVt], ["FollowNavMin", true]);
  assert.equal(options.get("navclosestoprange", { exactCase: true, vtUnits: true }).value, 0.0125);
  assert.equal(options.get("navclosestoprange", { vtUnits: true }).value, 0.0125);
  assert.equal(findRow("manastonekeepcount", { exactCase: true }).viaVt, false, "a RynthAi-name alias never converts");
});

await check("unknown option ⇒ error and NO write; meta bag holds unknown names", () => {
  const { options, storage, profiles } = mk();
  profiles.saveAs("Main", { current: { settings: {}, lists: {}, refs: {} } });
  const writes = storage.writes.length;
  const events = [];
  options.onChange((e) => events.push(e));
  const r = options.set("NoSuchOption", "5", { source: "command" });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown option NoSuchOption/);
  assert.equal(storage.writes.length, writes, "nothing written");
  assert.deepStrictEqual(events, []);
  assert.equal(Object.keys(profiles.record().settings).length, 0);
  assert.equal(options.get("NoSuchOption").ok, false);
  assert.equal(options.set("HealAt", "lots").ok, false, "a bad value is refused too");
  assert.equal(storage.writes.length, writes);
  // bag (D19)
  assert.equal(options.bag.has("MyMetaFlag"), false);
  assert.equal(options.bag.set("MyMetaFlag", 7).ok, true);
  assert.equal(options.bag.get("mymetaflag"), 7, "case-insensitive");
  assert.equal(options.bag.has("MYMETAFLAG"), true);
  assert.equal(options.bag.get("other"), undefined);
});

await check("inert rows store, round-trip and echo '(not implemented on web)'; echo uses the name as typed", () => {
  const { options } = mk();
  const r = options.set("ShowEditor", "true", { source: "meta" });
  assert.equal(r.ok, true);
  assert.equal(r.echo, "[RynthSuite] Set option ShowEditor = true (not implemented on web)");
  assert.equal(options.getValue("ShowEditor"), true);
  assert.equal(options.get("showeditor").value, true);
  // the rows made live on 2026-10-19 echo plainly, lbf converting as before
  const live = options.set("LootOnlyRareCorpses", "true", { source: "meta" });
  assert.equal(live.echo, "[RynthSuite] Set option LootOnlyRareCorpses = true");
  const n = options.set("NavFarStopRange", "0.25");
  assert.equal(options.getValue("NavFarStopDistance"), 60, "lbf row converts");
  assert.equal(n.echo, "[RynthSuite] Set option NavFarStopRange = 0.25");
  // VTank's bane profile: its enum, All/None or letters → the canonical letters
  assert.equal(options.set("BuffProfile_Banes", 5).value, "BPS", "VTank 5 = BPS");
  assert.equal(options.getValue("BuffProfileBanes"), "BPS");
  assert.equal(options.set("BuffProfile-Banes", "s, a").value, "AS", "letters, any order");
  assert.equal(options.set("BuffProfile_Banes", "None").value, "");
  assert.equal(options.set("BuffProfile_Banes", "All").value, "ALFCBPS");
  assert.equal(options.set("BuffProfile_Banes", "Banes1").ok, false, "not a bane profile");
  assert.equal(options.set("BuffProfile_Banes", 1).ok, false, "1 (Custom) names no letters of its own");
  assert.equal(options.getValue("BuffProfileBanes"), "ALFCBPS", "a refused value leaves it as it was");
  assert.equal(options.set("Recharge-Norm-Mana", 30).echo, "[RynthSuite] Set option Recharge-Norm-Mana = 30");
  assert.equal(options.set("AttackDistance", "0.0833").echo, "[RynthSuite] Set option AttackDistance = 0.0833");
  assert.equal(options.set("EnableNav", "on").echo, "[RynthSuite] Set option EnableNav = true");
});

// ── live cells ─────────────────────────────────────────────────────────────
await check("cells: vitals.cfg synchronous; Enable* via control.setEnabled with loop fallback", () => {
  const bot = fakeBot();
  const { options } = mk({ bot });
  assert.equal(options.set("HealAt", 72).ok, true);
  assert.equal(bot.vitals.cfg.healAtCombat, 72, "synchronous");
  options.set("Recharge-NoTarg-Mana", 88);
  assert.equal(bot.vitals.cfg.topOffMana, 88);
  bot.vitals.cfg.restamAtCombat = 33; // the HUD writes the same field
  assert.equal(options.getValue("RestamAt"), 33, "the loop field IS the storage");
  options.set("EnableCombat", false);
  assert.deepStrictEqual(bot.control.calls, [["combat", false]]);
  assert.equal(bot.combat.enabled, false);
  assert.equal(options.getValue("EnableCombat"), false);
  options.set("EnableLooting", "off");
  assert.equal(bot.loot.enabled, false);
  // no control: loop.enabled fallback
  const bot2 = fakeBot({ control: false });
  const o2 = mk({ bot: bot2 }).options;
  o2.set("EnableCombat", false);
  assert.equal(bot2.combat.enabled, false);
  // a failing control falls back to the field
  const bot3 = fakeBot();
  bot3.control.setEnabled = () => ({ ok: false, error: "nope" });
  mk({ bot: bot3 }).options.set("EnableLooting", false);
  assert.equal(bot3.loot.enabled, false);
});

await check("cells: EnableBuffing true with no buff loop calls bot.setBuffs(profile spec ?? 'auto')", async () => {
  const bot = fakeBot({ buff: false });
  const { options } = mk({ bot });
  assert.equal(options.getValue("EnableBuffing"), true, "no loop ⇒ profile/default");
  options.set("EnableBuffing", false);
  assert.deepStrictEqual(bot.setBuffsCalls, [], "false with no loop: nothing to stop");
  options.set("EnableBuffing", true);
  assert.deepStrictEqual(bot.setBuffsCalls, ["auto"]);
  const bot2 = fakeBot({ buff: false });
  const m2 = mk({ bot: bot2 });
  m2.profiles.patch({ lists: { buffs: { spec: [2, 24], disabled: [], itemSpells: {} } } });
  m2.options.set("EnableBuffing", false);
  m2.options.set("EnableBuffing", true);
  assert.deepStrictEqual(bot2.setBuffsCalls, [[2, 24]]);
  await Promise.resolve();
  assert.ok(bot2.buff, "the loop now exists");
  assert.equal(m2.options.getValue("EnableBuffing"), true);
});

await check("cells: MonsterRange → combat.monsterRangeM + host.nearbyRangeM rule + invalidateScan", () => {
  const bot = fakeBot();
  const { options } = mk({ bot });
  options.set("MonsterRange", 100);
  assert.equal(bot.combat.monsterRangeM, 100);
  assert.equal(bot.combat.invalidated, 1);
  assert.equal(bot.host.nearbyRangeM, 105, "max(60, 100+5, 4+5)");
  options.set("ApproachRange", 150);
  assert.equal(bot.host.nearbyRangeM, 155, "ApproachRange re-derives the nearby range");
  options.set("ApproachRange", 4);
  options.set("MonsterRange", 20);
  assert.equal(bot.host.nearbyRangeM, 60, "never below the boot value");
  options.set("AttackDistance", "0.5");
  assert.equal(bot.combat.monsterRangeM, 120);
  assert.equal(bot.host.nearbyRangeM, 125);
  // config.nearbyRangeM 100 is the floor (critic B6); 0 = unlimited is never narrowed
  const b100 = fakeBot({ nearby: 100 });
  mk({ bot: b100 }).options.set("MonsterRange", 50);
  assert.equal(b100.host.nearbyRangeM, 100);
  const b0 = fakeBot({ nearby: 0 });
  mk({ bot: b0 }).options.set("MonsterRange", 150);
  assert.equal(b0.host.nearbyRangeM, 0, "0 = every tracked entity stays unlimited");
  assert.equal(b0.combat.monsterRangeM, 150);
});

await check("cells: a configured nearbyRangeM below MonsterRange+5 is kept at Default; only a range beyond its schema default widens it (V-2, review regress-2)", () => {
  const b30 = fakeBot({ nearby: 30 });
  const { options } = mk({ bot: b30 });
  options.applyToCells({}); // the attach-time push at Default
  assert.equal(b30.combat.monsterRangeM, 40);
  assert.equal(b30.host.nearbyRangeM, 30, "attach at Default keeps the configured 30 m");
  options.set("MonsterRange", 50);
  assert.equal(b30.host.nearbyRangeM, 55, "a profile range beyond 40 m widens the scan");
  options.set("MonsterRange", 40);
  assert.equal(b30.host.nearbyRangeM, 30, "back at the default: the configured base again");
  options.set("ApproachRange", 10);
  assert.equal(b30.host.nearbyRangeM, 30, "10+5 < 30");
  options.set("ApproachRange", 40);
  assert.equal(b30.host.nearbyRangeM, 45);
  options.set("ApproachRange", 4);
  assert.equal(b30.host.nearbyRangeM, 30);
  for (const n of [44, 45, 50, 60]) {
    const b = fakeBot({ nearby: n });
    mk({ bot: b }).options.applyToCells({});
    assert.equal(b.host.nearbyRangeM, n, `configured ${n} m unchanged at Default`);
  }
});

await check("cells: BlacklistTimeoutSec ×1000, power/height/attempts, loot fields, legacyPriorities copy", () => {
  const bot = fakeBot();
  const { options, cells } = mk({ bot });
  options.set("BlacklistMonsterTimeoutSeconds", 45);
  assert.equal(bot.combat.blacklistTimeoutMs, 45_000);
  bot.combat.blacklistTimeoutMs = 12_000;
  assert.equal(options.getValue("BlacklistTimeoutSec"), 12);
  options.set("BlacklistAttempts", 5);
  assert.equal(bot.combat.blacklistAttempts, 5);
  options.set("MeleeAttackPower", 0.9);
  options.set("MissileAttackPower", 0.3);
  options.set("AttackHeight", 3);
  assert.deepStrictEqual([bot.combat.meleePower, bot.combat.missileAccuracy, bot.combat.attackHeight], [0.9, 0.3, 3]);
  options.set("LootMinValue", 2500);
  options.set("CorpseApproachRange-Max", "0.125");
  assert.deepStrictEqual([bot.loot.minValue, bot.loot.corpseRangeM], [2500, 30], "0.125 lbf = 30 m");
  options.set("RebufTimeRemainingSeconds", 600);
  assert.equal(bot.buff.rebuffSecondsRemaining, 600);
  const pr = { drudge: 5, rat: 1 };
  assert.equal(options.setList("legacyPriorities", pr).ok, true);
  assert.deepStrictEqual(bot.combat.priorities, pr);
  assert.notEqual(bot.combat.priorities, pr, "a copy is assigned");
  assert.deepStrictEqual(options.getList("legacyPriorities"), pr);
  // absent loops: get undefined, set ok (profile keeps it)
  const bare = createLiveCells({});
  assert.equal(bare.get("HealAt"), undefined);
  assert.equal(bare.get("EnableCombat"), undefined);
  assert.equal(bare.set("HealAt", 50).ok, true);
  assert.equal(bare.set("MonsterRange", 50).ok, true);
  assert.equal(bare.set("Nope", 1).ok, false);
  assert.ok(cells.keys().includes("buffs") && cells.has("MonsterRange") && !cells.has("RingRange"));
  // a bot surface that throws reads as "no cell value"
  const evil = { get combat() { throw new Error("boom"); } };
  const ev = mk({ bot: evil }).options;
  assert.equal(ev.getValue("MeleeAttackPower"), 0.6);
  assert.equal(ev.set("MeleeAttackPower", 0.5).ok, true);
});

// ── applyToCells (§4.5) ────────────────────────────────────────────────────
await check("applyToCells under Default: no legacy push, profile-owned keys pushed at defaults", () => {
  const bot = fakeBot({ int1: false }); // today's loops: the new fields do not exist yet
  bot.vitals.cfg.healAtCombat = 55; // a non-default boot value (HUD override)
  bot.combat.enabled = false; // ?botPersona=explorer
  const { options } = mk({ bot });
  const r = options.applyToCells({ legacy: true, urlPinned: new Set() });
  assert.deepStrictEqual(r.pushed.sort(), ["CorpseApproachRangeMax", "MonsterRange", "RebuffSecondsRemaining"]);
  assert.equal(bot.combat.monsterRangeM, 40);
  assert.equal(bot.loot.corpseRangeM, 30);
  assert.equal(bot.buff.rebuffSecondsRemaining, 300);
  assert.equal(bot.vitals.cfg.healAtCombat, 55, "legacy cell untouched");
  assert.equal(bot.combat.enabled, false, "legacy cell untouched");
  assert.deepStrictEqual(bot.control.calls, []);
  assert.deepStrictEqual(bot.setBuffsCalls, []);
  assert.equal(bot.host.nearbyRangeM, 60);
  // INT-1 loops already at the defaults: a strict no-op (no invalidateScan, nothing assigned)
  const b2 = fakeBot();
  const o2 = mk({ bot: b2 }).options;
  assert.deepStrictEqual(o2.applyToCells({ legacy: true }).pushed, []);
  assert.equal(b2.combat.invalidated, 0);
  // the Default overlay IS pushed on first attach (normally empty)
  const b3 = fakeBot();
  const m3 = mk({ bot: b3 });
  m3.profiles.patch({ settings: { HealAt: 71 } });
  m3.options.applyToCells({ legacy: true });
  assert.equal(b3.vitals.cfg.healAtCombat, 71);
});

function userProfile(m, name = "Main") {
  const rec = {
    settings: { EnableCombat: false, EnableLooting: false, HealAt: 70, LootMinValue: 500, MonsterRange: 25, RingRange: 8 },
    lists: { buffs: { spec: "auto", disabled: [], itemSpells: {} }, legacyPriorities: { drudge: 5 } },
    refs: { navProfile: "loop1" },
  };
  assert.equal(m.profiles.saveAs(name, { current: rec }).ok, true);
  return rec;
}

await check("applyToCells under a user profile: legacy push on legacy:true only; urlPinned honoured", async () => {
  // later attach (takeover / HUD restart): legacy false ⇒ only the profile-owned keys
  const b1 = fakeBot();
  const m1 = mk({ bot: b1 });
  userProfile(m1);
  m1.options.applyToCells({ legacy: false });
  assert.equal(b1.combat.enabled, true);
  assert.equal(b1.vitals.cfg.healAtCombat, 60);
  assert.deepStrictEqual(b1.setBuffsCalls, []);
  assert.equal(b1.combat.monsterRangeM, 25, "MonsterRange is profile-owned");
  // first attach with ?botPersona=explorer pins
  const b2 = fakeBot();
  const m2 = mk({ bot: b2 });
  userProfile(m2);
  b2.combat.enabled = true;
  const r = m2.options.applyToCells({ legacy: true, urlPinned: new Set(["EnableCombat", "EnableLooting"]) });
  assert.equal(b2.combat.enabled, true, "pinned");
  assert.equal(b2.loot.enabled, true, "pinned");
  assert.equal(b2.vitals.cfg.healAtCombat, 70);
  assert.equal(b2.loot.minValue, 500);
  assert.equal(b2.combat.monsterRangeM, 25);
  assert.deepStrictEqual(b2.setBuffsCalls, ["auto"]);
  assert.deepStrictEqual(b2.combat.priorities, { drudge: 5 });
  assert.ok(r.pushed.includes("HealAt") && !r.pushed.includes("EnableCombat"));
  // ?botBuffs pins the buff list
  const b3 = fakeBot();
  const m3 = mk({ bot: b3 });
  userProfile(m3);
  m3.options.applyToCells({ legacy: true, urlPinned: new Set(["buffs"]) });
  assert.deepStrictEqual(b3.setBuffsCalls, []);
  assert.equal(b3.combat.enabled, false, "not pinned ⇒ the profile's EnableCombat false");
  // an autosave never absorbs a URL pin into the profile
  b3.buffSpec = [1, 2, 3];
  T += 5000;
  m3.options.autosaveTick(T);
  const stored = readRecord(m3.storage, sharedKey("Main"));
  assert.equal(stored.lists.buffs.spec, "auto");
});

await check("hudBootOverrides(): null under Default; applyHudOverrides shape under a user profile", () => {
  const m = mk();
  assert.equal(m.options.hudBootOverrides(), null);
  userProfile(m);
  const o = m.options.hudBootOverrides();
  assert.deepStrictEqual(o, { buffs: "auto", priorities: { drudge: 5 }, lootMin: 500, vitals: { healAtCombat: 70 } });
  const cfg = boot.applyHudOverrides({}, o);
  assert.equal(cfg.buffs, "auto");
  assert.deepStrictEqual(cfg.priorities, { drudge: 5 });
  assert.equal(cfg.loot.minValue, 500);
  assert.deepStrictEqual(cfg.vitals, { healAtCombat: 70 });
  // explicit buff ids + every vitals key name maps back to vitals.cfg fields
  m.options.setList("buffs", { spec: [2, 24] }, { source: "ui" });
  m.options.set("TopOffStam", 90);
  m.options.set("EmergencyStamFloor", 25);
  const o2 = m.options.hudBootOverrides();
  assert.deepStrictEqual(o2.buffs, [2, 24]);
  assert.deepStrictEqual(o2.vitals, { healAtCombat: 70, topOffStam: 90, emergencyStamFloor: 25 });
  assert.deepStrictEqual(boot.applyHudOverrides({}, o2).vitals, o2.vitals);
  const empty = mk();
  empty.profiles.saveAs("Blank", { current: { settings: {}, lists: {}, refs: {} } });
  assert.deepStrictEqual(empty.options.hudBootOverrides(), {});
});

await check("noteLegacyEdit: Default ⇒ overlay only (nothing stored); user profile ⇒ record saved at once", () => {
  const m = mk();
  const writes = m.storage.writes.length;
  m.options.noteLegacyEdit("lootMin", 750);
  m.options.noteLegacyEdit("priorities", { Drudge: 4, rat: 2 });
  m.options.noteLegacyEdit("vitals", { healAtCombat: 66, topOffHp: 90 });
  m.options.noteLegacyEdit("buffs", [2, 24]);
  assert.equal(m.storage.writes.length, writes, "Default never written");
  const ov = m.profiles.overlay();
  assert.equal(ov.settings.LootMinValue, 750);
  assert.deepStrictEqual(ov.lists.legacyPriorities, { drudge: 4, rat: 2 });
  assert.deepStrictEqual([ov.settings.HealAt, ov.settings.TopOffHP], [66, 90]);
  assert.deepStrictEqual(ov.lists.buffs.spec, [2, 24]);
  assert.equal(m.options.getValue("LootMinValue"), 750);
  assert.equal(m.options.noteLegacyEdit("bogus", 1).ok, false);
  assert.equal(m.options.noteLegacyEdit("lootMin", -1).ok, false);
  // user profile: saved immediately; buffs keeps disabled/itemSpells; a priority removal is a full map
  const u = mk();
  u.profiles.saveAs("Main", { current: { settings: {}, lists: { buffs: { spec: null, disabled: [7], itemSpells: { 9: ["impen"] } } }, refs: {} } });
  u.options.noteLegacyEdit("buffs", "auto");
  u.options.noteLegacyEdit("priorities", { drudge: 3 });
  u.options.noteLegacyEdit("vitals", { restamAtCombat: 35 });
  let rec = readRecord(u.storage, sharedKey("Main"));
  assert.deepStrictEqual(rec.lists.buffs, { spec: "auto", disabled: [7], itemSpells: { 9: ["impen"] } });
  assert.deepStrictEqual(rec.lists.legacyPriorities, { drudge: 3 });
  assert.equal(rec.settings.RestamAt, 35);
  u.options.noteLegacyEdit("priorities", {});
  rec = readRecord(u.storage, sharedKey("Main"));
  assert.deepStrictEqual(rec.lists.legacyPriorities, {});
});

await check("autosaveTick: a director cell change is persisted within 2 s (user profile); nothing under Default", () => {
  T = 1_800_000_100_000;
  const bot = fakeBot();
  const m = mk({ bot });
  userProfile(m);
  m.options.applyToCells({ legacy: true });
  m.options.autosaveTick(T); // baseline pass
  const writes = m.storage.writes.length;
  m.options.autosaveTick(T + 500);
  assert.equal(m.storage.writes.length, writes, "no drift ⇒ no write");
  bot.loot.minValue = 1234; // ai/actions.js set_loot_min_value
  bot.combat.priorities = { olthoi: 9 }; // set_priorities
  m.options.autosaveTick(T + 1000); // inside the 2 s window: not yet
  assert.equal(readRecord(m.storage, sharedKey("Main")).settings.LootMinValue, 500);
  m.options.autosaveTick(T + 2000);
  const rec = readRecord(m.storage, sharedKey("Main"));
  assert.equal(rec.settings.LootMinValue, 1234);
  assert.deepStrictEqual(rec.lists.legacyPriorities, { olthoi: 9 });
  assert.equal(rec.settings.HealAt, 70, "stored settings kept");
  assert.equal(rec.settings.RingRange, 8, "profile-only settings kept");
  assert.equal(rec.refs.navProfile, "loop1", "refs kept");
  // Default: the same drift writes nothing, ever
  const b2 = fakeBot();
  const d = mk({ bot: b2 });
  d.options.applyToCells({ legacy: true });
  b2.loot.minValue = 99;
  for (let i = 0; i < 5; i++) d.options.autosaveTick(T + i * 2500);
  d.options.flushNow();
  assert.deepStrictEqual(d.storage.writes, []);
});

await check("set() from ui/command/meta saves synchronously under a user profile; other sources wait for autosave", () => {
  const m = mk();
  m.profiles.saveAs("Main", { current: { settings: {}, lists: {}, refs: {} } });
  for (const [source, key, v] of [["ui", "RingRange", 9], ["command", "SummonPets", true], ["meta", "PetMinMonsters", 3]]) {
    const r = m.options.set(key, v, { source });
    assert.equal(r.ok, true);
    assert.equal(readRecord(m.storage, sharedKey("Main")).settings[key], v, `${source} write is on disk immediately`);
  }
  m.options.set("MinRingTargets", 6, { source: "boot" });
  assert.equal(readRecord(m.storage, sharedKey("Main")).settings.MinRingTargets, undefined);
  T += 3000;
  m.options.autosaveTick(T);
  assert.equal(readRecord(m.storage, sharedKey("Main")).settings.MinRingTargets, 6);
  // a value set back to its default leaves the record (profiles store the diff)
  m.options.set("RingRange", 5);
  assert.equal("RingRange" in readRecord(m.storage, sharedKey("Main")).settings, false);
  assert.equal(m.options.getValue("RingRange"), 5);
});

await check("PRESETS.vtank: refused on Default; applied (and saved) on a user profile", () => {
  const m = mk({ bot: fakeBot() });
  const r = m.options.applyPreset("vtank");
  assert.equal(r.ok, false);
  assert.match(r.error, /Default is read-only/);
  assert.equal(m.options.getValue("EnableAutostack"), false);
  m.options.saveAs("Vt");
  const r2 = m.options.applyPreset("vtank");
  assert.equal(r2.ok, true);
  assert.deepStrictEqual(r2.applied.sort(), Object.keys(PRESETS.vtank).sort());
  const rec = readRecord(m.storage, sharedKey("Vt"));
  for (const [k, v] of Object.entries(PRESETS.vtank)) {
    assert.equal(m.options.getValue(k), v, `${k}`);
    if (v !== defaults()[k]) assert.equal(rec.settings[k], v, `${k} saved`);
  }
  assert.equal(m.options.applyPreset("nope").ok, false);
});

await check("importHud(): refused on Default; imports the HUD blob into the active user profile", () => {
  const storage = spyStorage();
  storage.setItem(HUD_BLOB_KEY, JSON.stringify({
    vitals: { healAtCombat: 70, topOffMana: 80 }, lootMin: 300, buffs: "auto", priorities: { drudge: 6 }, route: "x",
  }));
  const bot = fakeBot({ buff: false });
  const m = mk({ storage, bot });
  const r0 = m.options.importHud();
  assert.equal(r0.ok, false);
  assert.match(r0.error, /Save As/);
  assert.equal(bot.vitals.cfg.healAtCombat, 60, "nothing applied on Default");
  m.options.saveAs("Imported");
  const r = m.options.importHud();
  assert.equal(r.ok, true);
  assert.deepStrictEqual(r.imported.sort(), ["HealAt", "LootMinValue", "TopOffMana", "buffs", "legacyPriorities"]);
  assert.equal(bot.vitals.cfg.healAtCombat, 70);
  assert.equal(bot.loot.minValue, 300);
  assert.deepStrictEqual(bot.setBuffsCalls, ["auto"]);
  const rec = readRecord(storage, sharedKey("Imported"));
  assert.equal(rec.settings.HealAt, 70);
  assert.equal(rec.lists.buffs.spec, "auto");
  assert.deepStrictEqual(rec.lists.legacyPriorities, { drudge: 6 });
  const empty = mk();
  empty.options.saveAs("X");
  assert.equal(empty.options.importHud().ok, false, "no blob");
});

await check("selectProfile(): pushes every key of the new profile, fires onChange{kind:'profile'}, loads no refs", () => {
  const bot = fakeBot();
  const m = mk(); // the profile is made before the bot exists (panel, no bot)
  userProfile(m, "Main"); // now active
  m.options.selectProfile("Default");
  m.options.bindCells(createLiveCells(bot)); // the bot attaches under Default
  const events = [];
  m.options.onChange((e) => events.push(e));
  bot.combat.enabled = true;
  const r = m.options.selectProfile("Main", "shared");
  assert.equal(r.ok, true);
  assert.deepStrictEqual(r.active, { name: "Main", kind: "shared", writable: true });
  assert.equal(bot.combat.enabled, false, "legacy keys pushed (no URL pins at runtime)");
  assert.equal(bot.vitals.cfg.healAtCombat, 70);
  assert.equal(bot.combat.monsterRangeM, 25);
  assert.deepStrictEqual(bot.combat.priorities, { drudge: 5 });
  assert.deepStrictEqual(bot.setBuffsCalls, ["auto"]);
  assert.deepStrictEqual(events.map((e) => e.kind), ["profile"], "exactly one event, no ref events");
  assert.deepStrictEqual(events[0].value, { name: "Main", kind: "shared" });
  assert.equal(m.options.getRef("navProfile"), "loop1", "ref readable; loading it is INT-2's job");
  // Default pushes the schema defaults for every key
  m.options.selectProfile("Default");
  assert.equal(bot.combat.enabled, true);
  assert.equal(bot.loot.enabled, true);
  assert.equal(bot.vitals.cfg.healAtCombat, 60);
  assert.equal(bot.loot.minValue, 0);
  assert.equal(bot.combat.monsterRangeM, 40);
  assert.deepStrictEqual(bot.combat.priorities, {});
  assert.equal(m.options.getRef("navProfile"), null);
  assert.equal(m.options.selectProfile("Nope").ok, false);
  // same profile again: no-op, no event
  const n = events.length;
  m.options.selectProfile("Default");
  assert.equal(events.length, n);
});

await check("re-selecting Default pushes the schema defaults, not the edits an earlier Default session made (PLAN §4.5(4), G:48, review guide-2)", () => {
  const bot = fakeBot();
  const m = mk({ bot });
  m.options.applyToCells({});
  // Edits under Default live in the session overlay (nothing is written).
  m.options.set("HealAt", 80);
  m.options.set("EnableNavigation", true);
  assert.equal(bot.vitals.cfg.healAtCombat, 80);
  assert.equal(m.options.getValue("EnableNavigation"), true);
  assert.equal(m.storage.writes.length, 0, "Default never writes");
  assert.equal(m.options.saveAs("Hunt").ok, true, "Save As copies the overlay into Hunt");
  m.options.set("HealAt", 55);
  assert.equal(m.options.selectProfile("Default").ok, true);
  assert.equal(bot.vitals.cfg.healAtCombat, 60, "the schema default, not the old overlay's 80");
  assert.equal(m.options.getValue("EnableNavigation"), false, "enable flags do not come back with Default");
  assert.deepStrictEqual(m.profiles.overlay().settings, {}, "a fresh overlay");
  assert.equal(m.options.selectProfile("Hunt").ok, true);
  assert.equal(bot.vitals.cfg.healAtCombat, 55, "Hunt keeps its own values");
  assert.equal(m.options.getValue("EnableNavigation"), true);
  // Removing the active profile falls back to a fresh Default too.
  m.options.selectProfile("Default");
  m.options.set("HealAt", 75);
  m.options.saveAs("Tmp");
  assert.equal(m.profiles.remove("Tmp").ok, true);
  assert.equal(m.profiles.active().kind, "default");
  assert.deepStrictEqual(m.profiles.overlay().settings, {}, "remove()'s fall-back starts a fresh overlay");
  // Edits made under Default stay for the session while Default stays active.
  m.options.set("HealAt", 70);
  assert.equal(m.options.selectProfile("Default").ok, true, "same profile: a no-op");
  assert.equal(m.options.getValue("HealAt"), 70);
});

await check("an explicit selectProfile() lifts the URL pins; a cell with no loop is never reported as pushed", () => {
  const bot = fakeBot({ buff: false });
  const m = mk(); // the profile is made before the bot exists
  userProfile(m, "Main");
  m.options.selectProfile("Default");
  m.options.bindCells(createLiveCells(bot)); // the bot attaches under Default
  bot.combat.enabled = false; // ?botPersona=explorer boot
  const r0 = m.options.applyToCells({ legacy: true, urlPinned: new Set(["EnableCombat", "EnableLooting"]) });
  assert.ok(!r0.pushed.includes("RebuffSecondsRemaining"), "no buff loop ⇒ nothing pushed");
  m.options.selectProfile("Main");
  assert.equal(bot.combat.enabled, false);
  bot.combat.enabled = true; // a HUD toggle after the operator picked the profile
  T += 5000;
  m.options.autosaveTick(T);
  assert.equal("EnableCombat" in readRecord(m.storage, sharedKey("Main")).settings, false,
    "persisted (true = default ⇒ dropped from the diff) because the pin no longer applies");
});

await check("syncCells: a buff loop that appears later gets the profile's RebuffSecondsRemaining", async () => {
  T += 10_000;
  const bot = fakeBot({ buff: false });
  const m = mk({ bot });
  m.profiles.saveAs("Main", { current: { settings: { RebuffSecondsRemaining: 600 }, lists: {}, refs: {} } });
  m.options.applyToCells({ legacy: true });
  assert.equal(m.options.getValue("RebuffSecondsRemaining"), 600, "no loop ⇒ profile value");
  await bot.setBuffs("auto"); // the HUD Buff toggle builds the loop at its default 300
  assert.equal(bot.buff.rebuffSecondsRemaining, 300);
  m.options.autosaveTick(T); // syncs before it snapshots
  assert.equal(bot.buff.rebuffSecondsRemaining, 600);
  assert.equal(readRecord(m.storage, sharedKey("Main")).settings.RebuffSecondsRemaining, 600, "never persisted as 300");
  // Default: the overlay value reaches a late loop too
  const b2 = fakeBot({ buff: false });
  const d = mk({ bot: b2 });
  d.options.set("RebuffSecondsRemaining", 900);
  d.options.applyToCells({ legacy: true });
  await b2.setBuffs("auto");
  assert.deepStrictEqual(d.options.syncCells(), ["RebuffSecondsRemaining"]);
  assert.equal(b2.buff.rebuffSecondsRemaining, 900);
});

await check("switching away from / copying a user profile first persists its unsaved cell drift (C# SwitchProfile)", () => {
  T += 10_000;
  const bot = fakeBot();
  const m = mk({ bot });
  assert.equal(m.options.saveAs("Main").ok, true); // record = the live values
  m.options.autosaveTick(T);
  bot.loot.minValue = 777; // director set_loot_min_value, < 2 s before the switch (no autosave in between)
  bot.combat.priorities = { olthoi: 7 };
  assert.equal(m.options.selectProfile("Default").ok, true);
  let rec = readRecord(m.storage, sharedKey("Main"));
  assert.equal(rec.settings.LootMinValue, 777, "drift saved into the outgoing profile");
  assert.deepStrictEqual(rec.lists.legacyPriorities, { olthoi: 7 });
  assert.equal(bot.loot.minValue, 0, "then Default is pushed");
  assert.equal(m.options.selectProfile("Main").ok, true);
  assert.equal(bot.loot.minValue, 777, "and it comes back with the profile");
  bot.vitals.cfg.healAtCombat = 66;
  assert.equal(m.options.saveAs("Copy").ok, true);
  assert.equal(readRecord(m.storage, sharedKey("Main")).settings.HealAt, 66, "Save As keeps the outgoing drift too");
  assert.equal(readRecord(m.storage, sharedKey("Copy")).settings.HealAt, 66);
  // Default is still never written by a switch
  const d = mk({ bot: fakeBot() });
  d.options.selectProfile("[By char]");
  d.options.selectProfile("Default");
  const w = d.storage.writes.length;
  d.options.selectProfile("Default");
  assert.equal(d.storage.writes.length, w);
});

/** bot.js setBuffs: the buff loop appears only after the ladder load (async). */
function asyncBuffBot() {
  const bot = fakeBot({ buff: false });
  bot.setBuffs = function (spec) {
    this.setBuffsCalls.push(spec);
    return Promise.resolve().then(() => {
      this.buffSpec = spec === "auto" ? "auto" : Array.isArray(spec) ? spec.slice() : [];
      if (!this.buff) this.buff = { enabled: true, rebuffSecondsRemaining: 300 };
      return [];
    });
  };
  return bot;
}
const settle = () => new Promise((r) => setImmediate(r));

await check("a buff list that builds the loop keeps a stored EnableBuffing=false (attach, selectProfile, Buffs tab)", async () => {
  const noBuff = { settings: { EnableBuffing: false }, lists: { buffs: { spec: [2, 24], disabled: [], itemSpells: {} } }, refs: {} };
  // selectProfile at runtime
  const m = mk(); // the profile exists before the bot
  m.profiles.saveAs("NoBuff", { current: noBuff });
  m.options.selectProfile("Default");
  const bot = asyncBuffBot();
  m.options.bindCells(createLiveCells(bot));
  m.options.selectProfile("NoBuff");
  assert.deepStrictEqual(bot.setBuffsCalls, [[2, 24]]);
  await settle();
  assert.ok(bot.buff, "the loop was built");
  assert.equal(bot.buff.enabled, false, "and switched off: the profile says EnableBuffing false");
  assert.equal(m.options.getValue("EnableBuffing"), false);
  // first attach (applyToCells legacy:true)
  const b1 = asyncBuffBot();
  const m1 = mk();
  m1.profiles.saveAs("NoBuff", { current: noBuff });
  m1.options.bindCells(createLiveCells(b1));
  m1.options.applyToCells({ legacy: true });
  await settle();
  assert.equal(b1.buff.enabled, false);
  // Buffs-tab edit while buffing is off and no loop exists
  const b2 = asyncBuffBot();
  const m2 = mk({ bot: b2 });
  m2.options.saveAs("Off");
  m2.options.set("EnableBuffing", false, { source: "ui" });
  m2.options.setList("buffs", { spec: "auto" }, { source: "ui" });
  assert.deepStrictEqual(b2.setBuffsCalls, ["auto"]);
  await settle();
  assert.equal(b2.buff.enabled, false);
  // EnableBuffing at its default (true): the new loop stays on
  const b3 = asyncBuffBot();
  const m3 = mk({ bot: b3 });
  m3.options.setList("buffs", { spec: "auto" }, { source: "ui" });
  await settle();
  assert.equal(b3.buff.enabled, true);
});

/** bot.js setBuffs exactly: calls are serialised on a chain and bot.buffSpec is
 *  set when a call's turn RUNS, then the run awaits the spell-ladder load. */
function chainedBuffBot(initialSpec = "auto") {
  const bot = fakeBot();
  bot.buffSpec = initialSpec;
  let release;
  const ladder = new Promise((r) => { release = r; });
  let chain = Promise.resolve();
  bot.setBuffs = function (ids) {
    this.setBuffsCalls.push(ids);
    const run = async () => {
      bot.buffSpec = ids === "auto" ? "auto" : Array.isArray(ids) ? ids.slice() : [];
      await ladder;
      return [];
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  };
  return { bot, release: () => release() };
}
const drain = async () => {
  for (let i = 0; i < 20; i++) await settle();
};

await check("async bot.setBuffs: reads, the immediate save and a revert see the pushed spec, not bot.buffSpec's old one", async () => {
  T += 10_000;
  const { bot, release } = chainedBuffBot("auto");
  const m = mk({ bot });
  m.options.saveAs("Main");
  const disk = () => readRecord(m.storage, sharedKey("Main")).lists.buffs?.spec;
  assert.equal(m.options.setList("buffs", { spec: [2] }, { source: "ui" }).ok, true);
  assert.deepStrictEqual(m.options.getList("buffs").spec, [2], "before bot.buffSpec changes");
  assert.deepStrictEqual(disk(), [2], "the immediate save writes the operator's spec");
  await settle(); // run #1 starts (bot.buffSpec = [2]) and waits for the ladder
  assert.equal(m.options.setList("buffs", { spec: [2, 24] }, { source: "ui" }).ok, true); // queued behind run #1
  assert.deepStrictEqual(bot.buffSpec, [2], "the bot still shows the previous spec");
  assert.deepStrictEqual(m.options.getList("buffs").spec, [2, 24]);
  assert.deepStrictEqual(disk(), [2, 24]);
  // the Buffs tab reverts to the value bot.buffSpec shows right now: it must still be pushed
  assert.equal(m.options.setList("buffs", { spec: [2] }, { source: "ui" }).ok, true);
  assert.deepStrictEqual(bot.setBuffsCalls, [[2], [2, 24], [2]]);
  assert.deepStrictEqual(m.options.getList("buffs").spec, [2]);
  release();
  await drain();
  assert.deepStrictEqual(bot.buffSpec, [2], "the operator's last choice wins");
  T += 5000;
  m.options.autosaveTick(T);
  assert.deepStrictEqual(disk(), [2]);
  assert.deepStrictEqual(m.options.getList("buffs").spec, [2], "after settling the bot is read again");
  bot.buffSpec = "auto"; // e.g. the director / HUD changed it later
  assert.equal(m.options.getList("buffs").spec, "auto");
  // EnableBuffing true with no loop builds it through the same async call
  const c2 = chainedBuffBot(null);
  c2.bot.buff = null;
  const m2 = mk({ bot: c2.bot });
  m2.options.saveAs("Main");
  m2.options.set("EnableBuffing", false, { source: "ui" });
  m2.options.set("EnableBuffing", true, { source: "ui" });
  assert.deepStrictEqual(c2.bot.setBuffsCalls, ["auto"]);
  assert.equal(m2.options.getList("buffs").spec, "auto", "the spec being applied, not null");
  c2.release();
  await drain();
  // a rebind drops an in-flight spec of the previous bot
  const c3 = chainedBuffBot([7]);
  const m3 = mk({ bot: c3.bot });
  m3.options.setList("buffs", { spec: [8] });
  m3.options.bindCells(createLiveCells(fakeBot()));
  assert.equal(m3.options.getList("buffs").spec, null, "the new bot's own spec");
  c3.release();
  await drain();
});

await check("noteLegacyEdit('buffs') before the HUD's own bot.setBuffs ran: the save writes the HUD's spec", async () => {
  T += 10_000;
  const { bot, release } = chainedBuffBot("auto");
  const m = mk({ bot });
  m.options.saveAs("Main");
  // hud_bridge.setBuffs: persist() (→ noteLegacyEdit) runs before `await b.setBuffs(list)`
  m.options.noteLegacyEdit("buffs", [2, 24]);
  assert.deepStrictEqual(readRecord(m.storage, sharedKey("Main")).lists.buffs.spec, [2, 24]);
  assert.deepStrictEqual(m.options.getList("buffs").spec, [2, 24]);
  const p = bot.setBuffs([2, 24]);
  await settle();
  assert.deepStrictEqual(bot.buffSpec, [2, 24]);
  bot.buffSpec = [9]; // anything that changes the bot afterwards is read live again
  assert.deepStrictEqual(m.options.getList("buffs").spec, [9]);
  release();
  await p;
});

await check("a later attach (legacy:false) re-applies the stored keys no boot path carries; Default stays untouched", () => {
  T += 10_000;
  const win = {};
  const storage = spyStorage();
  const s = S.getVtSession(win, 1001, { storage, now, log: quiet });
  const b1 = fakeBot();
  s.options.bindCells(createLiveCells(b1));
  s.options.applyToCells({ legacy: s.attachCount++ === 0 });
  s.options.saveAs("Main");
  for (const [k, v] of [["MeleeAttackPower", 0.9], ["MissileAttackPower", 0.4], ["AttackHeight", 3],
    ["BlacklistAttempts", 7], ["BlacklistTimeoutSec", 60], ["HealAt", 70]]) s.options.set(k, v, { source: "ui" });
  // takeover rebind / HUD Restart: dispose, a fresh bot at the ctor defaults, later attach
  s.options.flushNow();
  s.options.bindCells(null);
  const b2 = fakeBot();
  const again = S.getVtSession(win, 1001, { storage, now, log: quiet });
  again.options.bindCells(createLiveCells(b2));
  const r = again.options.applyToCells({ legacy: again.attachCount++ === 0 });
  assert.deepStrictEqual(r.pushed.sort(),
    ["AttackHeight", "BlacklistAttempts", "BlacklistTimeoutSec", "MeleeAttackPower", "MissileAttackPower"]);
  assert.deepStrictEqual([b2.combat.meleePower, b2.combat.missileAccuracy, b2.combat.attackHeight, b2.combat.blacklistAttempts,
    b2.combat.blacklistTimeoutMs], [0.9, 0.4, 3, 7, 60_000]);
  assert.equal(b2.vitals.cfg.healAtCombat, 60, "vitals ride the boot carry-over / hudBootOverrides, not this push");
  T += 5000;
  again.options.autosaveTick(T);
  const rec = readRecord(storage, sharedKey("Main")).settings;
  assert.deepStrictEqual([rec.MeleeAttackPower, rec.AttackHeight, rec.BlacklistAttempts, rec.BlacklistTimeoutSec], [0.9, 3, 7, 60],
    "the profile keeps them through the rebind");
  // Default with an empty overlay: a later attach pushes nothing (V-2)
  const b3 = fakeBot();
  b3.combat.meleePower = 0.8; // a programmatic config.combat value
  const d = mk({ bot: b3 });
  assert.deepStrictEqual(d.options.applyToCells({ legacy: false }).pushed, []);
  assert.equal(b3.combat.meleePower, 0.8);
});

await check("autosave survives a clock stepped backwards; EnableBuffing false with no loop is not reported as pushed", () => {
  const bot = fakeBot({ buff: false });
  const m = mk({ bot });
  m.options.saveAs("Main");
  m.options.autosaveTick(5_000_000);
  m.options.autosaveTick(1_000_000); // the wall clock stepped back
  bot.loot.minValue = 42;
  m.options.autosaveTick(1_002_500);
  assert.equal(readRecord(m.storage, sharedKey("Main")).settings.LootMinValue, 42);
  const p = mk();
  p.profiles.saveAs("Off", { current: { settings: { EnableBuffing: false }, lists: {}, refs: {} } });
  const b2 = fakeBot({ buff: false });
  p.options.bindCells(createLiveCells(b2));
  const r = p.options.applyToCells({ legacy: true });
  assert.ok(!r.pushed.includes("EnableBuffing"), "nothing to switch off");
  assert.deepStrictEqual(b2.setBuffsCalls, []);
  assert.equal(p.options.getValue("EnableBuffing"), false);
});

await check("lists and refs: getList/setList/getRef/setRef; live buff spec merged over the profile list", () => {
  const bot = fakeBot();
  const m = mk({ bot });
  assert.deepStrictEqual(m.options.getList("items"), []);
  assert.deepStrictEqual(m.options.getList("monsters"), [], "no monsters list ⇒ [] (the CMB model adds DEFAULT)");
  assert.deepStrictEqual(m.options.getList("buffs"), { spec: null, disabled: [], itemSpells: {} });
  const items = [{ guid: 5, name: "Shield", wcid: 1, kind: "shield", element: null, noBuffs: false }];
  const events = [];
  m.options.onChange((e) => events.push(e));
  assert.equal(m.options.setList("items", items).ok, true);
  const got = m.options.getList("items");
  assert.deepStrictEqual(got, items);
  got[0].name = "mutated";
  assert.equal(m.options.getList("items")[0].name, "Shield", "getList returns a copy");
  assert.equal(m.options.setList("items", "nope").ok, false);
  assert.equal(m.options.setList("bogus", []).ok, false);
  m.options.setList("buffs", { spec: null, disabled: [2], itemSpells: { 5: ["impen", "bane:fire"] } });
  bot.buffSpec = "auto";
  assert.deepStrictEqual(m.options.getList("buffs"), { spec: "auto", disabled: [2], itemSpells: { 5: ["impen", "bane:fire"] } });
  assert.equal(m.options.setRef("navProfile", "Route A").ok, true);
  assert.equal(m.options.getRef("navProfile"), "Route A");
  assert.equal(m.options.setRef("navProfile", null).ok, true);
  assert.equal(m.options.getRef("navProfile"), null);
  assert.equal(m.options.setRef("bogus", "x").ok, false);
  assert.deepStrictEqual(events.map((e) => `${e.kind}:${e.key}`), ["list:items", "list:buffs", "ref:navProfile", "ref:navProfile"]);
  const un = m.options.onChange(() => { throw new Error("listener boom"); });
  assert.equal(m.options.set("RingRange", 6).ok, true, "a throwing listener never breaks a write");
  un();
});

await check("snapshot() equals the live loop values at Default; list() exposes VTank names and units", () => {
  const bot = fakeBot();
  bot.vitals.cfg.healAtCombat = 61;
  bot.combat.priorities = { rat: 1 };
  const { options } = mk({ bot });
  const s = options.snapshot();
  assert.deepStrictEqual(s.settings, { HealAt: 61 });
  assert.deepStrictEqual(s.lists, { legacyPriorities: { rat: 1 } });
  assert.deepStrictEqual(s.refs, {});
  const rows = options.list("attackdistance");
  assert.equal(rows.length, 1);
  assert.deepStrictEqual([rows[0].key, rows[0].vtName, rows[0].value, rows[0].vtValue], ["MonsterRange", "AttackDistance", 40, 40 / 240]);
  assert.equal(options.list().length, SCHEMA.length);
  assert.ok(options.list("vitals").every((r) => r.row.page === "vitals" || /vitals/i.test(r.row.group)));
  assert.ok(options.list("Not on web").every((r) => r.inert));
});

await check("NamedStore.list() re-parses a record only when its stored text changed (a 500 ms panel refresh over a big meta library, review runtime-7)", () => {
  const storage = spyStorage();
  const store = new S.NamedStore({ storage, prefix: "rynth.vt.v1.meta.", now, log: quiet });
  const big = { rules: Array.from({ length: 400 }, (_, i) => ({ id: `r${i}`, cond: { t: "Expr", expr: `getvar[x]==${i}` } })) };
  for (const n of ["Alpha", "Beta", "Gamma"]) assert.equal(store.put(n, big).ok, true);
  const realParse = JSON.parse;
  let parses = 0;
  JSON.parse = (...a) => (parses++, realParse(...a));
  try {
    const first = store.list();
    assert.deepStrictEqual(first.map((e) => e.name), ["Alpha", "Beta", "Gamma"]);
    const n1 = parses;
    const second = store.list();
    assert.equal(parses, n1, "an unchanged library parses nothing");
    assert.deepStrictEqual(second, first, "same listing");
    second[0].name = "mutated";
    assert.equal(store.list()[0].name, "Alpha", "callers get copies");
    T += 5000;
    assert.equal(store.put("Delta", { rules: [] }).ok, true);
    const n2 = parses;
    const third = store.list();
    assert.equal(parses - n2, 1, "only the new record is parsed");
    assert.deepStrictEqual(third.map((e) => e.name), ["Alpha", "Beta", "Delta", "Gamma"]);
    // Another tab rewrites Beta (same key): re-parsed, the new savedAt shows.
    T += 5000;
    storage.setItem("rynth.vt.v1.meta.beta", JSON.stringify({ name: "Beta", savedAt: T, value: { rules: [] } }));
    const fourth = store.list();
    assert.equal(fourth.find((e) => e.name === "Beta").savedAt, T);
    assert.ok(fourth.find((e) => e.name === "Beta").bytes < first[1].bytes);
    assert.equal(store.remove("Alpha").ok, true);
    assert.deepStrictEqual(store.list().map((e) => e.name), ["Beta", "Delta", "Gamma"], "a removed record leaves the listing");
    // A record corrupted in place is skipped, as before.
    storage.setItem("rynth.vt.v1.meta.gamma", "{not json");
    assert.deepStrictEqual(store.list().map((e) => e.name), ["Beta", "Delta"]);
  } finally {
    JSON.parse = realParse;
  }
});

await check("never throws on garbage input", () => {
  const { options } = mk({ bot: fakeBot() });
  assert.equal(options.set(null, 1).ok, false);
  assert.equal(options.set(undefined).ok, false);
  assert.equal(options.set("HealAt", { t: "err", msg: "x" }).ok, false);
  assert.equal(options.get(undefined).ok, false);
  assert.equal(options.getValue("nope"), undefined);
  assert.equal(options.setList(null, null).ok, false);
  assert.equal(options.selectProfile(undefined).ok, false);
  assert.equal(options.saveAs(undefined).ok, false);
  assert.equal(options.noteLegacyEdit(undefined, undefined).ok, false);
  options.autosaveTick(NaN);
  options.flushNow();
  options.applyToCells();
  options.bindCells({ nope: true });
  assert.equal(options.getValue("HealAt"), 60);
});

console.log(fail === 0 ? `rynth_vt_settings: all ${pass} checks passed` : `rynth_vt_settings: ${fail} FAILED (${pass} passed)`);
process.exit(fail === 0 ? 0 : 1);
