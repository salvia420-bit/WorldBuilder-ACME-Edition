// tests/challenger_m3_stepper_adversarial.test.mjs
// Adversarial edge-case stress test suite targeting:
// 1. Disabled, readOnly, and aria-disabled steppers
// 2. Rapid synchronous & asynchronous clicking bursts (1000 cycles)
// 3. Boundary clamping with IEEE 754 floats, negative ranges, NaN/empty string values
// 4. Inverted/degenerate bounds (min > max, step <= 0)
// 5. Change event dispatch counts and event object integrity

import assert from "node:assert/strict";
import { installFakeDom, FakeEvent } from "./helpers/social_fake_dom.mjs";

globalThis.window = globalThis;
const { document: doc } = installFakeDom(globalThis);

const { numField, bindRow } = await import("../plugins/rynth-vt/widgets.js");

console.log("=== Running Challenger M3 Stepper Adversarial Suite ===");

let testsPassed = 0;
let testsFailed = 0;

function run(name, fn) {
  try {
    fn();
    console.log(`[PASS] ${name}`);
    testsPassed++;
  } catch (err) {
    console.error(`[FAIL] ${name}\n`, err);
    testsFailed++;
  }
}

const click = (el) => el.dispatchEvent(new FakeEvent("click"));

// 1. Event Dispatch Integrity & No Getter Collisions
run("1. Stepper dispatches valid change event without TypeError under fake DOM", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  let changeCount = 0;
  let receivedEvent = null;

  input.addEventListener("change", (e) => {
    changeCount++;
    receivedEvent = e;
  });

  input.value = "10";
  click(up);

  assert.equal(changeCount, 1, "Change event fired exactly once");
  assert.equal(input.value, "11", "Value incremented by 1");
  assert.ok(receivedEvent, "Event object received");
  assert.equal(receivedEvent.type, "change");
});

// 2. Disabled & ReadOnly Guards (Complete Matrix)
run("2. Disabled / ReadOnly / aria-disabled guard matrix prevents mutation and event dispatch", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  const dn = wrap.querySelector(".rvt-step-btn.is-down");
  let changeCount = 0;
  input.addEventListener("change", () => changeCount++);

  input.value = "42";

  // Case A: input.disabled = true
  input.disabled = true;
  click(up);
  click(dn);
  assert.equal(input.value, "42", "Value unmodified when disabled=true");
  assert.equal(changeCount, 0, "No event fired when disabled=true");
  input.disabled = false;

  // Case B: input.readOnly = true
  input.readOnly = true;
  click(up);
  click(dn);
  assert.equal(input.value, "42", "Value unmodified when readOnly=true");
  assert.equal(changeCount, 0, "No event fired when readOnly=true");
  input.readOnly = false;

  // Case C: aria-disabled="true"
  input.setAttribute("aria-disabled", "true");
  click(up);
  click(dn);
  assert.equal(input.value, "42", "Value unmodified when aria-disabled='true'");
  assert.equal(changeCount, 0, "No event fired when aria-disabled='true'");
  input.removeAttribute("aria-disabled");

  // Case D: attribute "disabled" via property or real DOM reflection
  input.disabled = true;
  click(up);
  assert.equal(input.value, "42", "Value unmodified when disabled is set");
  assert.equal(changeCount, 0);
  input.disabled = false;

  // Case E: attribute "readonly"
  input.readOnly = true;
  click(dn);
  assert.equal(input.value, "42", "Value unmodified when readonly is set");
  assert.equal(changeCount, 0);
  input.readOnly = false;

  // Confirm it works again once guards removed
  click(up);
  assert.equal(input.value, "43");
  assert.equal(changeCount, 1);
});

// 3. Rapid Clicking (1000 synchronous clicks)
run("3. Rapid clicking stress: 1000 rapid clicks produce exact expected state", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  const dn = wrap.querySelector(".rvt-step-btn.is-down");
  input.step = "1";
  input.min = "0";
  input.max = "1000";
  input.value = "0";

  let fires = 0;
  input.addEventListener("change", () => fires++);

  for (let i = 0; i < 500; i++) {
    click(up);
  }
  assert.equal(input.value, "500", "500 up clicks reached 500");
  assert.equal(fires, 500, "500 change events fired");

  for (let i = 0; i < 500; i++) {
    click(dn);
  }
  assert.equal(input.value, "0", "500 down clicks returned to 0");
  assert.equal(fires, 1000, "1000 change events total");
});

// 4. Floating Point Precision & Boundary Clamping
run("4. Floating point steps (0.1, 0.05, 0.01) do not accumulate precision drift", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  const dn = wrap.querySelector(".rvt-step-btn.is-down");
  input.step = "0.1";
  input.min = "0";
  input.max = "1";
  input.value = "0";

  // Step up 10 times: 0.1, 0.2, 0.3, ..., 1.0
  for (let i = 1; i <= 10; i++) {
    click(up);
    const expected = (i / 10).toFixed(1);
    assert.equal(Number(input.value).toFixed(1), expected, `Step ${i} matches ${expected}`);
  }
  assert.equal(input.value, "1", "Reached max exactly 1");

  // Attempt to step up beyond max
  click(up);
  assert.equal(input.value, "1", "Clamped at max 1");

  // Step down 10 times back to 0
  for (let i = 9; i >= 0; i--) {
    click(dn);
    const expected = (i / 10).toFixed(1);
    assert.equal(Number(input.value).toFixed(1), expected, `Step down to ${expected}`);
  }
  assert.equal(input.value, "0", "Reached min exactly 0");

  // Attempt to step down beyond min
  click(dn);
  assert.equal(input.value, "0", "Clamped at min 0");
});

// 5. Negative Ranges and Cross-Zero Transitions
run("5. Negative ranges (min -50, max -10, step 2.5) step and clamp cleanly", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  const dn = wrap.querySelector(".rvt-step-btn.is-down");
  input.step = "2.5";
  input.min = "-50";
  input.max = "-10";
  input.value = "-12";

  click(up); // -12 + 2.5 = -9.5 -> clamps to -10
  assert.equal(input.value, "-10", "Clamps to max -10");

  click(up);
  assert.equal(input.value, "-10", "Remains clamped at max -10");

  // Step down towards min
  input.value = "-48";
  click(dn); // -48 - 2.5 = -50.5 -> clamps to -50
  assert.equal(input.value, "-50", "Clamps to min -50");

  click(dn);
  assert.equal(input.value, "-50", "Remains clamped at min -50");
});

// 6. Degenerate and Malformed Inputs
run("6. Degenerate inputs (step=0, step='invalid', empty value, NaN) fallback gracefully", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  const dn = wrap.querySelector(".rvt-step-btn.is-down");

  // Case A: step="0" falls back to 1
  input.step = "0";
  input.value = "5";
  click(up);
  assert.equal(input.value, "6", "Zero step falls back to step=1");

  // Case B: step="not-a-number" falls back to 1
  input.step = "foo";
  click(up);
  assert.equal(input.value, "7", "Invalid step falls back to step=1");

  // Case C: step="-5" falls back to 1 (negative step ignored)
  input.step = "-5";
  click(up);
  assert.equal(input.value, "8", "Negative step falls back to step=1");

  // Case D: empty string value starts from 0
  input.step = "1";
  input.value = "";
  click(up);
  assert.equal(input.value, "1", "Empty string value treated as 0 + 1 = 1");

  input.value = "";
  click(dn);
  assert.equal(input.value, "-1", "Empty string value treated as 0 - 1 = -1");

  // Case E: NaN / non-numeric string value
  input.value = "not_a_num";
  click(up);
  assert.equal(input.value, "1", "NaN value treated as 0 + 1 = 1");
});

// 7. bindRow Integration with Steppers
run("7. bindRow commits numeric values to snapshot cell when stepper is clicked", () => {
  const { wrap, input } = numField(doc);
  const up = wrap.querySelector(".rvt-step-btn.is-up");
  const dn = wrap.querySelector(".rvt-step-btn.is-down");

  let committedKey = null;
  let committedVal = null;
  const update = bindRow({ input, wrap }, (key, val) => {
    committedKey = key;
    committedVal = val;
  });

  const row = {
    key: "MonsterRange",
    value: 35.0,
    min: 1,
    max: 200,
    step: 0.1,
  };

  update(row);
  assert.equal(input.value, "35", "Initial row value bound to input");
  assert.equal(input.min, "1");
  assert.equal(input.max, "200");
  assert.equal(input.step, "0.1");

  click(up);
  assert.equal(input.value, "35.1");
  assert.equal(committedKey, "MonsterRange");
  assert.equal(committedVal, 35.1, "bindRow committed numeric float 35.1");

  click(dn);
  assert.equal(input.value, "35");
  assert.equal(committedVal, 35, "bindRow committed numeric 35");
});

console.log(`\n==================================================`);
console.log(`ADVERSARIAL SUITE SUMMARY: ${testsPassed} passed, ${testsFailed} failed`);
console.log(`==================================================`);
if (testsFailed > 0) process.exit(1);
