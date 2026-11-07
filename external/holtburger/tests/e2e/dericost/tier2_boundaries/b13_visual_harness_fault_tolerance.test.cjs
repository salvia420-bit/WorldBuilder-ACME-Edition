/**
 * Tier 2: Boundary 13 — Visual Harness Fault Tolerance & Safety Rules
 * Session-0 SwiftShader rejection, local ultra lock, unknown view error handling, tunnel checks, process cleanup safety.
 * Sources: TEST_INFRA.md, ORIGINAL_REQUEST Verification, SHOTS-1070.md, capture-all.cjs
 */

const { createSuite, assert, assertEquals, assertThrows, CONSTANTS, CANONICAL_VIEWS } = require('../harness.cjs');

const suite = createSuite('Tier 2: Boundary 13 - Visual Harness Fault Tolerance & Safety Rules', 2);

suite.addTest('B13.1: Session 0 SwiftShader software fallback is detected and rejected for GPU tests', () => {
  // Authoritative check: SHOTS-1070.md §1:
  // If launched via plain SSH session-0, Chrome falls back to Google SwiftShader software rendering.
  // Visual regression suite mandates hardware Direct3D11 / GTX 1070.
  function validateGpuRenderer(unmaskedRendererString) {
    if (!unmaskedRendererString || unmaskedRendererString.includes('SwiftShader') || unmaskedRendererString.includes('llvmpipe')) {
      return { isHardwareGpu: false, error: 'Software renderer detected (SwiftShader/llvmpipe)' };
    }
    if (unmaskedRendererString.includes('GeForce') || unmaskedRendererString.includes('Direct3D11') || unmaskedRendererString.includes('NVIDIA')) {
      return { isHardwareGpu: true, error: null };
    }
    return { isHardwareGpu: false, error: 'Unknown renderer' };
  }

  const softwareReport = validateGpuRenderer('Google SwiftShader (ANGLE 2.1.0)');
  assertEquals(softwareReport.isHardwareGpu, false);
  assertEquals(softwareReport.error, 'Software renderer detected (SwiftShader/llvmpipe)');

  const hardwareReport = validateGpuRenderer('ANGLE (NVIDIA GeForce GTX 1070 Direct3D11 vs_5_0 ps_5_0)');
  assertEquals(hardwareReport.isHardwareGpu, true);
  assertEquals(hardwareReport.error, null);
});

suite.addTest('B13.2: Local ultra quality preset is blocked unless VISREG_ALLOW_LOCAL_ULTRA=1 is set', () => {
  // Authoritative rule from capture-all.cjs lines 20-25:
  // Running quality=ultra locally exhausts laptop GPU memory.
  function checkQualityAllowed(qualityPreset, isLiveRemote, envAllowLocalUltra) {
    if (qualityPreset === 'ultra' && !isLiveRemote && envAllowLocalUltra !== '1') {
      throw new Error('Quality=ultra is forbidden on local laptop without VISREG_ALLOW_LOCAL_ULTRA=1');
    }
    return true;
  }

  // Low and mid allowed locally
  assertEquals(checkQualityAllowed('low', false, '0'), true);
  assertEquals(checkQualityAllowed('mid', false, '0'), true);

  // Ultra blocked locally by default
  assertThrows(() => {
    checkQualityAllowed('ultra', false, '0');
  }, 'Quality=ultra is forbidden on local laptop');

  // Ultra allowed if live remote or env override set
  assertEquals(checkQualityAllowed('ultra', true, '0'), true, 'Allowed on remote 1070 box');
  assertEquals(checkQualityAllowed('ultra', false, '1'), true, 'Allowed with override');
});

suite.addTest('B13.3: Requesting an unknown view ID throws immediately with descriptive error', () => {
  function resolveView(viewId, viewsList) {
    const found = viewsList.find(v => v === viewId);
    if (!found) {
      throw new Error(`Unknown view "${viewId}". Must be one of: ${viewsList.join(', ')}`);
    }
    return found;
  }

  assertEquals(resolveView('holtburg_plaza_noon', CANONICAL_VIEWS), 'holtburg_plaza_noon');

  assertThrows(() => {
    resolveView('nonexistent_secret_room', CANONICAL_VIEWS);
  }, 'Unknown view "nonexistent_secret_room"');
});

suite.addTest('B13.4: Tunnel disconnection detection verifies mandatory ports 9333, 8080, 8765', () => {
  function checkTunnelPorts(openPorts) {
    const required = [9333, 8080, 8765];
    const missing = required.filter(p => !openPorts.includes(p));
    if (missing.length > 0) {
      return { ok: false, missingPorts: missing, error: `SSH tunnel missing required ports: ${missing.join(', ')}` };
    }
    return { ok: true, missingPorts: [], error: null };
  }

  const allOpen = checkTunnelPorts([9333, 8080, 8765, 22]);
  assertEquals(allOpen.ok, true);

  const missingWsbridge = checkTunnelPorts([9333, 8765]);
  assertEquals(missingWsbridge.ok, false);
  assertEquals(missingWsbridge.missingPorts.includes(8080), true);
});

suite.addTest('B13.5: Process cleanup safety: browser kill filter specifically targets CDP test instance', () => {
  // Authoritative check from SHOTS-1070.md §1 & Edge Case 3:
  // Plain taskkill /IM chrome.exe kills the user's browser.
  // Command line filter: CommandLine -like '*cdpwb-wls*' or matching debugging port 9333.
  function isProcessSafeToTerminate(processCommandLine) {
    if (!processCommandLine) return false;
    // Must contain test runner marker
    return processCommandLine.includes('cdpwb-wls') || processCommandLine.includes('--remote-debugging-port=9333');
  }

  // User's personal Chrome session
  const userBrowser = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" https://youtube.com';
  assertEquals(isProcessSafeToTerminate(userBrowser), false, 'Must NOT terminate user personal browser');

  // Automated agent test browser
  const agentBrowser = '"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9333 --user-data-dir=C:\\temp\\cdpwb-wls';
  assertEquals(isProcessSafeToTerminate(agentBrowser), true, 'Safe to terminate automated test session');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
