// tests/vehicle_economy_hud_wire.test.mjs — HBV1 v8 Client Wiring, BigInt C2S Coercion & #hb-economy-hud Suite
// Covers:
//   - All 6 S2C v8 message routes in handleMsg() (0x0911..0x0916)
//   - window.__vehicles.economy readouts & status().economy
//   - All 5 C2S SessionHandle wrappers with BigInt coercion on u64 args (convoyId, orderId, rewardPyreals)
//   - deployable_state (Kind 38..61) & container_state (Kind 30..37) instantiation + industry_facility_state visual sync
//   - #hb-economy-hud fake-DOM lifecycle, [id^=hb-] compliance, zero innerHTML, and clean teardown/dispose

import assert from "node:assert/strict";
import * as THREE from "three";
import { installFakeAudio } from "./helpers/fake_audio_context.mjs";
import { initVehicles } from "../scene3d/vehicle/index.js";
import { ECONOMY_HUD_ID, ECONOMY_HUD_STYLE_ID } from "../scene3d/vehicle/economy_hud.js";

installFakeAudio();

let passed = 0;
let failed = 0;

async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed++;
    console.log(`  [FAIL] ${name}: ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
  }
}

function makeFakeDom() {
  const byId = new Map();
  let innerHtmlSets = 0;
  function makeNode(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: "",
      className: "",
      style: {},
      children: [],
      parentNode: null,
      _textContent: "",
      get textContent() { return this._textContent; },
      set textContent(v) { this._textContent = String(v); },
      set innerHTML(_v) { innerHtmlSets++; },
      appendChild(ch) {
        if (ch.parentNode && ch.parentNode !== this) {
          ch.parentNode.removeChild(ch);
        }
        ch.parentNode = this;
        if (!this.children.includes(ch)) this.children.push(ch);
        if (ch.id) byId.set(ch.id, ch);
        return ch;
      },
      removeChild(ch) {
        const idx = this.children.indexOf(ch);
        if (idx >= 0) this.children.splice(idx, 1);
        ch.parentNode = null;
        if (ch.id) byId.delete(ch.id);
        return ch;
      },
      addEventListener() {},
      removeEventListener() {},
      querySelectorAll() { return []; },
    };
    return node;
  }
  const head = makeNode("head");
  const body = makeNode("body");
  const doc = {
    head,
    body,
    createElement(tag) {
      const n = makeNode(tag);
      return new Proxy(n, {
        set(target, prop, val) {
          if (prop === "id") {
            if (target.id) byId.delete(target.id);
            target.id = val;
            if (val) byId.set(val, receiverProxy);
            return true;
          }
          target[prop] = val;
          return true;
        },
      });
    },
    getElementById(id) { return byId.get(id) ?? null; },
    addEventListener() {},
    removeEventListener() {},
    querySelector() { return null; },
  };
  // Fix Proxy receiver self-reference by keeping id registration in appendChild/createElement cleanly:
  const rawCreate = doc.createElement;
  doc.createElement = (tag) => {
    const n = makeNode(tag);
    const p = new Proxy(n, {
      set(target, prop, val) {
        if (prop === "id") {
          if (target.id) byId.delete(target.id);
          target.id = val;
          if (val) byId.set(val, p);
          return true;
        }
        target[prop] = val;
        return true;
      },
    });
    return p;
  };
  return { doc, head, body, byId, getInnerHtmlSets: () => innerHtmlSets };
}

function makeRig() {
  const { doc, head, body, byId, getInnerHtmlSets } = makeFakeDom();
  const inbox = [];
  const calls = {
    siege: [],
    prospect: [],
    facility: [],
    convoy: [],
    monarch: [],
    colliders: [],
  };

  const sessionHandle = {
    drainVehicleMessages() {
      const out = JSON.stringify(inbox);
      inbox.length = 0;
      return out;
    },
    vehicleCapabilities() {},
    upsertContainerCollider(...args) { calls.colliders.push(args); },
    removeContainerCollider() {},
    terrainHeightAt() { return 0; },
    economySiegeAction(...args) { calls.siege.push(args); },
    industryProspecting(...args) { calls.prospect.push(args); },
    industryFacilityAction(...args) { calls.facility.push(args); },
    logisticsConvoyOrder(...args) { calls.convoy.push(args); },
    economyMonarchOrder(...args) { calls.monarch.push(args); },
  };

  const win = {
    document: doc,
    location: { search: "?vehicles=on" },
    __sessionHandle: sessionHandle,
    __bootState: "in-world",
    getLocalPlayerGuid: () => 0x50000001,
    addEventListener() {},
    removeEventListener() {},
  };

  const liveScene3d = {
    worldRoot: new THREE.Group(),
    csmState: null,
    nullRender: true,
    entityManager: { entityMap: new Map(), setFilmHidden() { return true; } },
  };

  const api = initVehicles({ liveScene3d, THREE, window: win });
  const tick = (dtMs = 16.67) => liveScene3d.vehicles.afterTick(1000, dtMs);
  return { api, win, doc, body, head, byId, getInnerHtmlSets, inbox, calls, liveScene3d, tick };
}

console.log("=== HBV1 v8 Client Wiring & #hb-economy-hud Suite ===");

await check("WIRE_01 All 6 S2C v8 messages populate __vehicles.economy & mount #hb-economy-hud", () => {
  const rig = makeRig();
  try {
    rig.inbox.push(
      {
        type: "economy_town_state",
        townId: 7,
        controlState: 3,
        ownerMonarchId: 101,
        attackerMonarchId: 202,
        flags: 0,
        anchorLandblock: 0xa9b40000,
        holdElapsedSec: 3600,
        supplyMeterSec: 4200,
        starvingSec: 0,
        treasuryPyreals: 250000,
        escrowPyreals: 50000,
        tariffBuyMul: 1.1,
        tariffSellMul: 0.9,
      },
      {
        type: "economy_siege_event",
        townId: 7,
        kind: 1,
        controlState: 2,
        ownerMonarchId: 101,
        attackerMonarchId: 202,
        holdElapsedSec: 0,
        supplyMeterSec: 5400,
        starvingSec: 0,
        treasurySpoils: 12500,
      },
      {
        type: "industry_survey_result",
        depositId: 9001,
        landblockId: 0x12340000,
        toolKind: 38,
        flags: 0x03,
        terrainCode: 4,
        resourceKind: 2,
        depthM: 145.5,
        gradeBps: 420,
        apiGravity: 34.2,
        sulfurBps: 85,
        remainingTonnes: 12000,
      },
      {
        type: "industry_facility_state",
        facilityGuid: 0x70000010,
        kind: 54,
        townId: 7,
        depositId: 9001,
        ownerMonarchId: 101,
        status: 1,
        onlineFlags: 1,
        powerWatts: 150000,
        bufferJoules: 5000,
        progressPct: 65,
        recipeId: 3,
      },
      {
        type: "logistics_convoy_state",
        convoyId: 4294967300,
        ownerMonarchId: 101,
        vehicleGuid: 0x70000020,
        vehicleClass: 3,
        lodState: 1,
        status: 1,
        originTownId: 7,
        destTownId: 12,
        originLandblock: 0xa9b40000,
        splineSM: 512.4,
        fuelLiters: 180.5,
        cell: 0,
        position: [10, 20, 0],
        heading: 0.5,
      },
      {
        type: "economy_monarch_order_state",
        orderId: 4294967305,
        monarchId: 101,
        townId: 7,
        orderType: 1,
        status: 1,
        flags: 0,
        claimedByGuid: 0,
        itemWcid: 4000070,
        quantity: 2,
        rewardPyreals: 45000,
        valueF32: 1.0,
      }
    );

    rig.tick();

    const eco = rig.win.__vehicles.economy;
    assert.equal(eco.towns().length, 1);
    assert.equal(eco.town(7).treasuryPyreals, 250000);
    assert.equal(eco.siegeEvents().length, 1);
    assert.equal(eco.surveys().length, 1);
    assert.equal(eco.facilities().length, 1);
    assert.equal(eco.convoys().length, 1);
    assert.equal(eco.orders().length, 1);

    const st = rig.api.status();
    assert.equal(st.economy.towns, 1);
    assert.equal(st.economy.convoys, 1);

    // HUD compliance: [id^=hb-], zero innerHTML, visible after telemetry
    assert.equal(rig.getInnerHtmlSets(), 0, "Zero innerHTML writes");
    assert.ok(rig.byId.has(ECONOMY_HUD_ID), "HUD root mounted with id #hb-economy-hud");
    assert.ok(rig.byId.has(ECONOMY_HUD_STYLE_ID), "HUD style mounted with id #hb-economy-hud-style");
    assert.equal(eco.hud.isVisible(), true);
    eco.hud.hide();
    assert.equal(eco.hud.isVisible(), false);
    assert.equal(eco.hud.toggle(), true);
  } finally {
    rig.api.dispose();
  }
  assert.equal(rig.byId.has(ECONOMY_HUD_ID), false, "HUD root removed on dispose");
  assert.equal(rig.byId.has(ECONOMY_HUD_STYLE_ID), false, "HUD style removed on dispose");
});

await check("WIRE_02 All 5 C2S economy wrappers forward args & coerce u64 args to BigInt", () => {
  const rig = makeRig();
  try {
    const eco = rig.win.__vehicles.economy;
    assert.equal(eco.siegeAction({ townId: 7, beaconGuid: 0x11, action: 2, flags: 1, supplyPoints: 50, originLandblock: 0xa1b20000 }), true);
    assert.deepEqual(rig.calls.siege[0], [7, 0x11, 2, 1, 50, 0xa1b20000]);

    assert.equal(eco.prospect({ toolGuid: 0x22, toolKind: 38, mode: 1, cell: 0xa1b20001, x: 1, y: 2, z: 3 }), true);
    assert.deepEqual(rig.calls.prospect[0], [0x22, 38, 1, 0xa1b20001, 1, 2, 3]);

    assert.equal(eco.facilityAction({ facilityGuid: 0x33, action: 3, recipeId: 12, param: 4 }), true);
    assert.deepEqual(rig.calls.facility[0], [0x33, 3, 12, 4]);

    assert.equal(eco.convoyOrder({ convoyId: 4294967300, action: 1, vehicleClass: 3, flags: 2, originTownId: 7, destTownId: 9, containerKind: 30, commodityId: 100 }), true);
    assert.equal(typeof rig.calls.convoy[0][0], "bigint");
    assert.equal(rig.calls.convoy[0][0], 4294967300n);

    assert.equal(eco.monarchOrder({ orderId: 9001, townId: 7, action: 1, orderType: 2, flags: 0, targetGuid: 0x44, itemWcid: 4000070, quantity: 3, rewardPyreals: 500000, paramF32: 1.25 }), true);
    assert.equal(typeof rig.calls.monarch[0][0], "bigint");
    assert.equal(rig.calls.monarch[0][0], 9001n);
    assert.equal(typeof rig.calls.monarch[0][8], "bigint");
    assert.equal(rig.calls.monarch[0][8], 500000n);
  } finally {
    rig.api.dispose();
  }
});

await check("WIRE_03 deployable_state (Kind 38..61) & container_state (Kind 30..37) spawn 3D models & sync facility state", () => {
  const rig = makeRig();
  try {
    rig.inbox.push(
      {
        type: "deployable_state",
        deployable: 0x70000101,
        kind: 54,
        onlineFlags: 1,
        cell: 0,
        x: 10,
        y: 20,
        z: 0,
        heading: 0.25,
      },
      {
        type: "deployable_state",
        deployable: 0x70000102,
        kind: 56,
        onlineFlags: 1,
        cell: 0,
        x: 20,
        y: 30,
        z: 0,
        heading: 0,
      },
      {
        type: "container_state",
        containerGuid: 0x70000201,
        containerKind: 30,
        doorState: 2,
        doorProgress: 1.0,
        cell: 0,
        position: [30, 40, 0],
        heading: 0,
        slots: [{ slotIndex: 0, palletSize: 2, cargoWcid: 4000070 }],
      },
      {
        type: "industry_facility_state",
        facilityGuid: 0x70000101,
        kind: 54,
        townId: 1,
        depositId: 10,
        ownerMonarchId: 100,
        status: 1,
        onlineFlags: 1,
        powerWatts: 150000,
        bufferJoules: 0,
        progressPct: 80,
        recipeId: 1,
      }
    );
    rig.tick();

    const deps = rig.api.deployables.list();
    assert.equal(deps.length, 2);
    assert.equal(deps[0].wcid, 4000086);
    assert.equal(deps[1].wcid, 4000090);
    assert.equal(deps[0].last.progressPct, 80);

    const conts = rig.api.containers.list();
    assert.equal(conts.length, 1);
    assert.equal(conts[0].kind, 30);
    assert.equal(rig.api.containers.get(0x70000201).wcid, 4000060);
  } finally {
    rig.api.dispose();
  }
});

function collectHudTexts(node, out = []) {
  if (!node) return out;
  if (typeof node.textContent === "string" && node.textContent) out.push(node.textContent);
  if (Array.isArray(node.children)) {
    for (const ch of node.children) collectHudTexts(ch, out);
  }
  return out;
}

await check("WIRE_04 Malformed S2C payloads (tariffBuyMul: 'bad'/NaN) & null/undefined inbox entries never throw or render NaN", () => {
  const rig = makeRig();
  try {
    rig.inbox.push(
      null,
      undefined,
      42,
      "bad_msg",
      {
        type: "economy_town_state",
        townId: "bad_id",
        controlState: "bad",
        ownerMonarchId: NaN,
        attackerMonarchId: null,
        holdElapsedSec: Infinity,
        supplyMeterSec: "bad",
        treasuryPyreals: "bad",
        escrowPyreals: null,
        tariffBuyMul: "bad",
        tariffSellMul: NaN,
      },
      {
        type: "economy_siege_event",
        townId: "bad",
        kind: NaN,
        treasurySpoils: "bad",
      },
      {
        type: "industry_survey_result",
        depositId: "bad",
        flags: "bad",
        depthM: "bad",
        gradeBps: "bad",
        apiGravity: NaN,
      },
      {
        type: "industry_facility_state",
        facilityGuid: "bad",
        kind: "bad",
        powerWatts: "bad",
        progressPct: "bad",
      },
      {
        type: "logistics_convoy_state",
        convoyId: "bad",
        lodState: "bad",
        originTownId: NaN,
        destTownId: "bad",
      },
      {
        type: "economy_monarch_order_state",
        orderId: "bad",
        itemWcid: "bad",
        quantity: NaN,
        rewardPyreals: "bad",
      }
    );

    assert.doesNotThrow(() => rig.tick());
    const hudRoot = rig.byId.get(ECONOMY_HUD_ID);
    assert.ok(hudRoot, "HUD mounted after malformed S2C batch");
    let texts = collectHudTexts(hudRoot).join("\n");
    assert.equal(texts.includes("NaN"), false, `Unexpected NaN in HUD: ${texts}`);
    assert.equal(texts.includes("Infinity"), false, `Unexpected Infinity in HUD: ${texts}`);
    assert.equal(texts.includes("undefined"), false, `Unexpected undefined in HUD: ${texts}`);
    assert.ok(texts.includes("x1.00"), `Expected tariffBuyMul fallback x1.00 in HUD, got: ${texts}`);

    // Direct NaN tariffBuyMul & valid numeric string check
    rig.inbox.push({
      type: "economy_town_state",
      townId: 7,
      controlState: 1,
      treasuryPyreals: 1000,
      escrowPyreals: 0,
      tariffBuyMul: NaN,
    });
    assert.doesNotThrow(() => rig.tick());
    texts = collectHudTexts(hudRoot).join("\n");
    assert.equal(texts.includes("NaN"), false, `Unexpected NaN on tariffBuyMul=NaN: ${texts}`);
    assert.ok(texts.includes("x1.00"), `Expected x1.00 fallback on tariffBuyMul=NaN, got: ${texts}`);
  } finally {
    rig.api.dispose();
  }
});

console.log(`\nvehicle_economy_hud_wire: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
