// Wave 4.A (2026-05-28) — train-skills plugin pure-helper tests.
//
// Run with:
//   cd /home/wbterminal/WorldBuilder-ACME-Edition && \
//     node external/holtburger/apps/holtburger-web/test_train_skill.mjs
//
// Validates two pure exports + manifest shape:
//   - `computeNextRaiseCost(snap)` — extract next-rank XP cost from a
//     5-tuple skill snapshot (`{ training, xp }`).
//   - `decideTrainAction(action, client)` — dispatch decision returning
//     `{ called: "trainSkill"|"raiseSkill"|null, args, reason? }`.
//
// Pattern mirrors `test_lifestone_popup.mjs` (Wave 6.B) — pure helpers
// covered without DOM / wasm so the load-bearing branches stay testable
// outside the browser stack. The plugin's DOM-side `doMount()` is
// exercised by the visual smoke (see "Visibility check" in the wave-4.A
// brief).

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── jsdom-lite shim ──────────────────────────────────────────────
// train-skills.js touches document.head/createElement (for ensureStyles)
// on import — install the shim before dynamic-import keeps that side
// effect harmless. We don't drive mount() in this test; only pure helpers.
function installDomShim() {
  if (typeof globalThis.document !== "undefined") return;
  const elementProto = {
    appendChild() { return null; },
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    style: undefined,
  };
  function mkEl() {
    return Object.assign(Object.create(elementProto), {
      style: {},
      dataset: {},
      attrs: {},
      classList: {
        add() {}, remove() {}, contains() { return false; }, toggle() { return false; },
      },
    });
  }
  globalThis.document = {
    head: mkEl(),
    body: mkEl(),
    createElement: () => mkEl(),
    getElementById: () => null,
  };
  globalThis.window = globalThis;
}
installDomShim();

const url = pathToFileURL(
  resolvePath(__dirname, "plugins/train-skills.js")
).href;
const {
  computeNextRaiseCost,
  decideTrainAction,
  TRAINING,
  manifest,
} = await import(url);

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}
function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${label}: expected ${e}, got ${a}`);
  }
}

console.log("===========================================================");
console.log("Wave 4.A — train-skills pure-helper test");
console.log("===========================================================");

console.log("\n[1] Module surface");

check("exports manifest with id=train-skills", () => {
  if (manifest.id !== "train-skills") {
    throw new Error(`bad manifest.id: ${manifest.id}`);
  }
  if (!manifest.iconHidden) {
    throw new Error("manifest.iconHidden should be true (no bar icon)");
  }
  if (manifest.version !== "0.1.0") {
    throw new Error(`bad manifest.version: ${manifest.version}`);
  }
});

check("exports TRAINING constants matching TrainingLevel enum", () => {
  // Mirrors holtburger_common::stats::TrainingLevel (stats.rs:287-292).
  assertEq(TRAINING.UNUSABLE, 0, "Unusable");
  assertEq(TRAINING.UNTRAINED, 1, "Untrained");
  assertEq(TRAINING.TRAINED, 2, "Trained");
  assertEq(TRAINING.SPECIALIZED, 3, "Specialized");
});

check("exports computeNextRaiseCost + decideTrainAction", () => {
  if (typeof computeNextRaiseCost !== "function") {
    throw new Error("computeNextRaiseCost not exported");
  }
  if (typeof decideTrainAction !== "function") {
    throw new Error("decideTrainAction not exported");
  }
});

console.log("\n[2] computeNextRaiseCost — extract next-rank XP cost");

check("trained skill with xp>0 returns xp as u32", () => {
  const cost = computeNextRaiseCost({ training: TRAINING.TRAINED, xp: 5000 });
  assertEq(cost, 5000, "trained next-rank cost");
});

check("specialized skill with xp>0 returns xp as u32", () => {
  const cost = computeNextRaiseCost({ training: TRAINING.SPECIALIZED, xp: 12500 });
  assertEq(cost, 12500, "specialized next-rank cost");
});

check("untrained skill returns null (cannot raise)", () => {
  const cost = computeNextRaiseCost({ training: TRAINING.UNTRAINED, xp: 5000 });
  assertEq(cost, null, "untrained raise blocked");
});

check("unusable skill returns null", () => {
  const cost = computeNextRaiseCost({ training: TRAINING.UNUSABLE, xp: 5000 });
  assertEq(cost, null, "unusable raise blocked");
});

check("xp=0 (max rank) returns null", () => {
  const cost = computeNextRaiseCost({ training: TRAINING.TRAINED, xp: 0 });
  assertEq(cost, null, "max-rank returns null");
});

check("missing snapshot returns null", () => {
  assertEq(computeNextRaiseCost(null), null, "null snap");
  assertEq(computeNextRaiseCost(undefined), null, "undefined snap");
  assertEq(computeNextRaiseCost({}), null, "empty snap");
});

check("malformed xp returns null", () => {
  const cost = computeNextRaiseCost({ training: TRAINING.TRAINED, xp: "5000" });
  assertEq(cost, null, "string xp rejected");
});

console.log("\n[3] decideTrainAction — train branch");

const fakeClient = {
  player: {
    trainSkill: () => {},
    raiseSkill: () => {},
  },
};

check("train with sufficient credits → trainSkill called", () => {
  const out = decideTrainAction(
    { kind: "train", skillId: 6, cost: 10, availableXp: 0, availableCredits: 50 },
    fakeClient,
  );
  assertEq(out.called, "trainSkill", "method name");
  assertEq(out.args, [6, 10], "args");
});

check("train with insufficient credits → null + reason", () => {
  const out = decideTrainAction(
    { kind: "train", skillId: 6, cost: 50, availableXp: 0, availableCredits: 10 },
    fakeClient,
  );
  assertEq(out.called, null, "method blocked");
  assertEq(out.reason, "insufficient-credits", "reason set");
});

check("train without facade → null + no-facade", () => {
  const out = decideTrainAction(
    { kind: "train", skillId: 6, cost: 10, availableXp: 0, availableCredits: 50 },
    { player: {} },
  );
  assertEq(out.called, null, "no-facade blocked");
  assertEq(out.reason, "no-facade", "reason set");
});

console.log("\n[4] decideTrainAction — raise branch");

check("raise with sufficient xp → raiseSkill called", () => {
  const out = decideTrainAction(
    { kind: "raise", skillId: 22, cost: 500, availableXp: 10000, availableCredits: 0 },
    fakeClient,
  );
  assertEq(out.called, "raiseSkill", "method name");
  assertEq(out.args, [22, 500], "args");
});

check("raise with insufficient xp → null + reason", () => {
  const out = decideTrainAction(
    { kind: "raise", skillId: 22, cost: 5000, availableXp: 100, availableCredits: 0 },
    fakeClient,
  );
  assertEq(out.called, null, "method blocked");
  assertEq(out.reason, "insufficient-xp", "reason set");
});

console.log("\n[5] decideTrainAction — args are u32-coerced");

check("skillId / cost coerced to u32", () => {
  const out = decideTrainAction(
    { kind: "raise", skillId: 0xFFFFFFFF, cost: 0xFFFFFFFF,
      availableXp: 0xFFFFFFFF, availableCredits: 0 },
    fakeClient,
  );
  assertEq(out.called, "raiseSkill", "method name");
  assertEq(out.args, [0xFFFFFFFF, 0xFFFFFFFF], "u32 coercion");
});

console.log("\n[6] decideTrainAction — cancel/unknown branches");

check("cancel → no-op", () => {
  const out = decideTrainAction(
    { kind: "cancel", skillId: 0, cost: 0, availableXp: 0, availableCredits: 0 },
    fakeClient,
  );
  assertEq(out.called, null, "no method");
  assertEq(out.reason, "noop", "noop reason");
});

console.log("\n===========================================================");
console.log(`Result: ${passed} passed, ${failed} failed`);
console.log("===========================================================");

if (failed > 0) process.exit(1);
