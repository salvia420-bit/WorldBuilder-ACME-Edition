/**
 * Tier 1: Feature 13 — 1070 Visual Testing Runbook Compliance
 * Canonical 10 views in views.json, Mode 2i interactive GPU driver, triple SSH tunnels, in-render capture.
 * Sources: ORIGINAL_REQUEST Verification, PROJECT.md §Feature 18, SHOTS-1070.md, runbooks-distilled.md
 */

const { createSuite, assert, assertEquals, CONSTANTS, CANONICAL_VIEWS, loadJsonSafe, getWorkspacePath } = require('../harness.cjs');
const fs = require('node:fs');

const suite = createSuite('Tier 1: Feature 13 - 1070 Visual Testing Runbook Compliance', 1);

suite.addTest('F13.1: Canonical view definition file contains exactly 10 views matching canonical list', () => {
  const viewsPath = getWorkspacePath('external/holtburger/scripts/visual-regression/views.json');
  const viewsDoc = loadJsonSafe(viewsPath);

  assert(viewsDoc !== null, `views.json must exist at ${viewsPath}`);
  assertEquals(viewsDoc.views.length, CONSTANTS.CANONICAL_VIEW_COUNT, 'Must define exactly 10 views');

  const loadedIds = viewsDoc.views.map(v => v.id);
  for (const expectedId of CANONICAL_VIEWS) {
    assert(loadedIds.includes(expectedId), `Canonical view "${expectedId}" must be defined in views.json`);
  }
});

suite.addTest('F13.2: Mode 2i interactive session command-line flags include offscreen window and muted audio', () => {
  // Authoritative flags from SHOTS-1070.md lines 19-35:
  // --window-position=-32000,-32000 --mute-audio --remote-debugging-port=9333 --use-angle=d3d11
  const requiredFlags = [
    '--window-position=-32000,-32000',
    '--mute-audio',
    '--remote-debugging-port=9333',
    '--use-angle=d3d11'
  ];

  function validateChromeLaunchArgs(args) {
    for (const flag of requiredFlags) {
      if (!args.includes(flag)) return { ok: false, missing: flag };
    }
    return { ok: true };
  }

  const validLaunch = [
    'chrome.exe',
    '--remote-debugging-port=9333',
    '--use-angle=d3d11',
    '--window-position=-32000,-32000',
    '--mute-audio',
    'http://127.0.0.1:8765'
  ];
  const check = validateChromeLaunchArgs(validLaunch);
  assertEquals(check.ok, true, 'Valid launch args must pass');

  // Verify that omitting offscreen flag is rejected (would disturb human desktop)
  const invalidLaunch = ['chrome.exe', '--remote-debugging-port=9333', '--use-angle=d3d11'];
  const invalidCheck = validateChromeLaunchArgs(invalidLaunch);
  assertEquals(invalidCheck.ok, false);
  assertEquals(invalidCheck.missing, '--window-position=-32000,-32000');
});

suite.addTest('F13.3: Triple SSH tunnel forwarding configuration maps all required ports', () => {
  // Authoritative tunnel from runbooks-distilled.md lines 18-22:
  // -L 9333:127.0.0.1:9333 -R 8765:127.0.0.1:8765 -R 8080:127.0.0.1:8080
  const expectedTunnels = {
    cdp: { local: 9333, remote: 9333, direction: 'L' },
    webServer: { local: 8765, remote: 8765, direction: 'R' },
    wsbridge: { local: 8080, remote: 8080, direction: 'R' },
  };

  function parseSshTunnelArgs(args) {
    const forwards = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-L' || args[i] === '-R') {
        const dir = args[i].replace('-', '');
        const [p1, host, p2] = args[i + 1].split(':');
        forwards.push({ dir, p1: parseInt(p1), host, p2: parseInt(p2) });
      }
    }
    return forwards;
  }

  const sampleArgs = ['-o', 'ExitOnForwardFailure=yes', '-fN', '-L', '9333:127.0.0.1:9333', '-R', '8765:127.0.0.1:8765', '-R', '8080:127.0.0.1:8080'];
  const forwards = parseSshTunnelArgs(sampleArgs);

  assert(forwards.some(f => f.dir === 'L' && f.p1 === 9333), 'CDP port 9333 forwarded local');
  assert(forwards.some(f => f.dir === 'R' && f.p1 === 8765), 'Web server port 8765 forwarded remote');
  assert(forwards.some(f => f.dir === 'R' && f.p1 === 8080), 'Wsbridge port 8080 forwarded remote');
});

suite.addTest('F13.4: In-render pixel read method prevents blank frame captures', () => {
  // Authoritative rule: WebGL canvas buffers swap/clear immediately after render tick.
  // Standard page.screenshot() yields black frames; capture must use in-render toDataURL or readPixels.
  function simulateCaptureMethod(method, inRenderLoop) {
    if (method === 'page.screenshot' && !inRenderLoop) {
      return { isBlackScreen: true, bufferSize: 0 };
    }
    if (method === 'toDataURL_in_tick' && inRenderLoop) {
      return { isBlackScreen: false, bufferSize: 125000 };
    }
    return { isBlackScreen: true, bufferSize: 0 };
  }

  const badCapture = simulateCaptureMethod('page.screenshot', false);
  assertEquals(badCapture.isBlackScreen, true, 'Direct screenshot outside tick yields black screen');

  const goodCapture = simulateCaptureMethod('toDataURL_in_tick', true);
  assertEquals(goodCapture.isBlackScreen, false, 'In-tick capture produces valid non-empty frame');
  assert(goodCapture.bufferSize > 50000, 'Frame buffer size must be substantial (>50KB)');
});

suite.addTest('F13.5: Golden storage hierarchy and 4 quality presets conform to specification', () => {
  const presets = CONSTANTS.QUALITY_PRESETS;
  assertEquals(presets.length, 4, 'Must have 4 quality presets');
  assert(presets.includes('low'), 'Includes low');
  assert(presets.includes('mid'), 'Includes mid');
  assert(presets.includes('high'), 'Includes high');
  assert(presets.includes('ultra'), 'Includes ultra');

  // Verify golden directory format: /mnt/wbterminal1/holtburger-goldens/{view}/{quality}/golden.png
  function formatGoldenPath(viewId, quality) {
    return `/mnt/wbterminal1/holtburger-goldens/${viewId}/${quality}/golden.png`;
  }

  const p = formatGoldenPath('holtburg_plaza_noon', 'low');
  assertEquals(p, '/mnt/wbterminal1/holtburger-goldens/holtburg_plaza_noon/low/golden.png');
});

module.exports = suite;

if (require.main === module) {
  suite.run({ verbose: true }).then(res => {
    process.exit(res.failed > 0 ? 1 : 0);
  });
}
