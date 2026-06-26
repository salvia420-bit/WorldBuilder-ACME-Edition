// P4.0a — reproducible proof of S0 (the severed C#↔JS descriptor channel).
// Runs the REAL parser over the REAL served catalog. Expect withComps:0, withConfig:0.
//   node docs/phase4-bake/probe-s0.mjs        (run from repo root)
import { parseDescriptorsJsonl } from '../../external/holtburger/apps/holtburger-web/scene3d/vfx_catalog.js';
import { readFileSync, realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const here = dirname(fileURLToPath(import.meta.url));
const catalog = resolve(here, '../../external/holtburger/apps/holtburger-web/dist/vfx/visual_descriptors.jsonl');
let text = readFileSync(catalog, 'utf8');
const hadBom = text.charCodeAt(0) === 0xFEFF;
text = text.replace(/^﻿/, '');      // browsers' res.text() strips the BOM; match that
const map = parseDescriptorsJsonl(text);
let withComps = 0, withConfig = 0;
for (const [, d] of map) { if (d.componentIds?.size > 0) withComps++; if (d.config && Object.keys(d.config).length > 0) withConfig++; }
console.log(JSON.stringify({ served: realpathSync(catalog), servedNonEmptyLines: text.split('\n').filter(l => l.trim()).length, hadBom, parsed: map.size, withComps, withConfig }));
const first = [...map.values()][0];
console.log('first.raw.components =', JSON.stringify(first.raw.components).slice(0, 160));
console.log('first.componentIds  =', JSON.stringify([...first.componentIds]), '| config keys =', JSON.stringify(Object.keys(first.config)));
