import pw from '/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core/index.js';
import fs from 'node:fs';
const { chromium } = pw;
const browser = await chromium.connectOverCDP('http://127.0.0.1:9334');
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/apps/holtburger-web/index.html'));
if (!page) { console.log('NO PAGE'); process.exit(2); }
const dump = await page.evaluate(() => {
  const T = window.__snapTap;
  if (!T) return null;
  return JSON.stringify({ wall0: T.wall0, t0: T.t0, nSamples: T.samples.length, samples: T.samples, snaps: T.snaps, wires: T.wires });
});
fs.writeFileSync('/home/wbterminal/.claude/jobs/333ff13e/tmp/snaptap-dump.json', dump ?? 'null');
console.log('dumped', dump ? dump.length : 0, 'bytes');
process.exit(0);
