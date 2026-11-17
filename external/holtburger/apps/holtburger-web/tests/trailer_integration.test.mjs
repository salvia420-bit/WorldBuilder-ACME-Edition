import assert from "node:assert/strict";
import { initHudAdapter } from '../ui/hud_adapter.js';

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

await check("T1_HUD_01 VehicleWire v6 Telemetry Update", async () => {
    let updatedTwistlock = null;
    let updatedChassis = null;
    let capturedCallback = null;
    
    // Mock the HUD API
    const api = {
      on: (event, callback) => {
        if (event === "VehicleWire") {
          capturedCallback = callback;
        }
      }
    };
    
    // Mock window.liveScene3d.hud
    globalThis.window = {
        liveScene3d: {
            hud: {
                setTrailerStatus: (twistlock, chassis) => {
                    updatedTwistlock = twistlock;
                    updatedChassis = chassis;
                }
            }
        }
    };

    initHudAdapter(api);

    const telemetry = {
        version: 6,
        twistlockState: 1,
        chassisTypeID: 4000020
    };

    capturedCallback(telemetry);

    assert.equal(updatedTwistlock, 1, "Twistlock state should be 1");
    assert.equal(updatedChassis, 4000020, "Chassis type ID should be 4000020");
});

console.log(`\nTests passed: ${passed}, failed: ${failed}`);
if (failed > 0) process.exit(1);
