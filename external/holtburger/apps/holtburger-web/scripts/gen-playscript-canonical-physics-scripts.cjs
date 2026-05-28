#!/usr/bin/env node
// scripts/gen-playscript-canonical-physics-scripts.cjs
//
// Generates `data/playscript-canonical-physics-scripts.json` — a
// PlayScript ID → canonical PhysicsScript DID map derived from every
// PhysicsScriptTable (DAT file-type 0x34) in retail's
// `client_portal.dat`. The next agent (Wave 2.C-followon-N) consumes
// this to build hardcoded `ParticleEmitterInfo` templates for the
// `_runPlaceholderDispatch` fallback path in `scene3d/play_effect_vfx.js`
// (entities WITHOUT a `physicsScriptTableDid` still hit placeholders).
//
// Wave 2.C / Phase 55 of the team-agents-plan-2026-05-27.
//
// ## Usage
//
//   cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
//   export PATH="$HOME/.cargo/bin:$PATH"
//   export HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat
//   node apps/holtburger-web/scripts/gen-playscript-canonical-physics-scripts.cjs
//
// Writes to `apps/holtburger-web/data/playscript-canonical-physics-scripts.json`.
//
// ## What it does
//
//   1. Shells out to `cargo run -p holtburger-dat --example dump_physics_scripts`
//      to enumerate every PhysicsScriptTable (0x34) and every referenced
//      PhysicsScript (0x33) → CreateParticle/CreateBlockingParticle hooks.
//   2. For each PlayScript key found, identifies the MOST FREQUENTLY
//      referenced PhysicsScript DID (the "canonical" choice — the script
//      that the bulk of weapons/spells point to for that PScript ID).
//   3. Emits the mapping plus a list of PlayScript IDs (0x00..0xAD) that
//      are absent from EVERY retail table (placeholder-only by design).
//
// ## Schema
//
//   {
//     "_comment": "...",
//     "_generated_via": "...",
//     "_retail_table_count": 164,
//     "_unique_scripts_total": 2015,
//     "_canonical_mappings": 147,
//     "_absent_play_script_ids": [{ "hex": "0x00", "name": "Invalid" }, ...],
//     "canonical": {
//       "4":  { "scriptDid": "0x33000E62", "refCount": 6, "uniqueScripts": 103, "hookCount": N },
//       "5":  { "scriptDid": "0x3300011E", "refCount": 5, "uniqueScripts": 70,  "hookCount": N },
//       ...
//     }
//   }
//
// ## Why canonical-by-frequency
//
// Most PScript IDs (e.g. EnchantDownRed) point to the SAME PhysicsScript
// across ~101 of 164 retail tables (the script is "what an Enchant Red
// debuff looks like" and is shared by every weapon-class table). For
// those, the canonical pick is unambiguous.
//
// For Launch (0x04) and Explode (0x05), each weapon/spell has its OWN
// distinct PhysicsScript (103 and 70 unique respectively) — these IDs
// are the ones the live resolver chain handles correctly through the
// per-entity `physicsScriptTableDid` lookup. The placeholder fallback
// here would use the most-referenced as a "best guess" — visually
// acceptable for a Launch you can't otherwise identify the weapon for.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// __dirname = .../external/holtburger/apps/holtburger-web/scripts
// 5 ups → repo root
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const OUTPUT = path.resolve(__dirname, '../data/playscript-canonical-physics-scripts.json');

// PlayScript enum mirror (kept locally to avoid an ES-module import in a
// CommonJS script). Cross-check with `ui/ac_play_script.js`'s
// `PLAY_SCRIPT` const — these MUST stay in sync.
const PLAY_SCRIPT_NAMES = {};
{
  // Parse from the JS mirror so the names always match the live module.
  const psFile = path.resolve(__dirname, '../ui/ac_play_script.js');
  const psBody = fs.readFileSync(psFile, 'utf8');
  const re = /(\w+):\s+0x([0-9A-Fa-f]+),?\s*(?:\/\/.*)?$/gm;
  let m;
  while ((m = re.exec(psBody)) !== null) {
    const name = m[1];
    const id = parseInt(m[2], 16);
    if (!Number.isFinite(id)) continue;
    if (id < 0 || id > 0xFF) continue;
    PLAY_SCRIPT_NAMES[id] = name;
  }
  if (Object.keys(PLAY_SCRIPT_NAMES).length < 100) {
    console.error('FAIL: PLAY_SCRIPT parse pulled fewer than 100 names; check the regex.');
    process.exit(2);
  }
}

function runDump() {
  const cwd = path.join(REPO_ROOT, 'external/holtburger');
  const cargoPath = `${process.env.HOME}/.cargo/bin/cargo`;
  const args = [
    'run', '-p', 'holtburger-dat',
    '--example', 'dump_physics_scripts',
  ];
  console.error(`[gen-playscript-canonical] running: ${cargoPath} ${args.join(' ')}`);
  const r = spawnSync(cargoPath, args, {
    cwd,
    env: {
      ...process.env,
      PATH: `${process.env.HOME}/.cargo/bin:${process.env.PATH}`,
      HOLTBURGER_PORTAL_DAT:
        process.env.HOLTBURGER_PORTAL_DAT ||
        `${process.env.HOME}/ac_base_dats/client_portal.dat`,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 128 * 1024 * 1024, // 128 MB ceiling for the 4 MB+ JSON
  });
  if (r.status !== 0) {
    console.error(`[gen-playscript-canonical] cargo exited ${r.status}`);
    process.exit(r.status ?? 1);
  }
  return JSON.parse(r.stdout);
}

function main() {
  const dump = runDump();

  // For each PScript key, count which scriptDids appear (across all
  // referencing tables) so we can pick the canonical = most-referenced.
  const scriptDidsPerKey = {};
  for (const table of Object.values(dump.tables)) {
    for (const [k, entries] of Object.entries(table.scripts)) {
      if (!scriptDidsPerKey[k]) scriptDidsPerKey[k] = new Map();
      for (const e of entries) {
        const cur = scriptDidsPerKey[k].get(e.scriptDid) || 0;
        scriptDidsPerKey[k].set(e.scriptDid, cur + 1);
      }
    }
  }

  const canonical = {};
  for (const [k, m] of Object.entries(scriptDidsPerKey)) {
    const sorted = [...m.entries()].sort((a, b) => b[1] - a[1]);
    const [topDid, topCount] = sorted[0];
    const hooks = dump.script_hooks[topDid];
    const hookCount = hooks ? hooks.particle_hooks.length : 0;
    canonical[k] = {
      scriptDid: topDid,
      refCount: topCount,
      uniqueScripts: m.size,
      hookCount,
    };
  }

  // Build absent list (IDs in 0x00..0xAD not seen in any retail table).
  const absent = [];
  for (let id = 0; id <= 0xAD; id++) {
    if (!canonical[String(id)]) {
      absent.push({
        hex: '0x' + id.toString(16).padStart(2, '0'),
        name: PLAY_SCRIPT_NAMES[id] || `(unknown 0x${id.toString(16)})`,
      });
    }
  }

  const out = {
    _comment:
      'Generated by `node apps/holtburger-web/scripts/gen-playscript-canonical-physics-scripts.cjs`. ' +
      'Maps each PlayScript ID (decimal-string key) to its most-typical PhysicsScript DID ' +
      'across all retail PhysicsScriptTables. Wave 2.C / Phase 55 (2026-05-28).',
    _generated_via: 'cargo run -p holtburger-dat --example dump_physics_scripts',
    _retail_table_count: Object.keys(dump.tables).length,
    _unique_scripts_total: Object.keys(dump.script_hooks).length,
    _canonical_mappings: Object.keys(canonical).length,
    _absent_play_script_ids: absent,
    canonical,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.error(`[gen-playscript-canonical] wrote ${OUTPUT}`);
  console.error(
    `[gen-playscript-canonical] ${Object.keys(canonical).length} canonical mappings, ` +
      `${absent.length} IDs absent from retail tables`,
  );
}

main();
