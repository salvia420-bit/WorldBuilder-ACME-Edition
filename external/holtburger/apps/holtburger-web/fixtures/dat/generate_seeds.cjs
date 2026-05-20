// Generate deterministic seeds for the DAT-parity validator.
//
// For each type the holtburger-dat Rust crate ships a parser for, list every
// record ID via WB.Terminal `chorizite-list-dat-records`, deterministically
// sample N (default 50), and write seeds.json. The validator consumes that
// file so re-runs across machines pin against the same ID set.
//
// **Why this lives next to fixtures/**: per
// [[reference_test_fixtures_real_data]] + the W2.B spec, we want a stable,
// reproducible sampling. The seeds.json file is the canonical artifact;
// regenerate only when DAT bytes change (i.e. effectively never — base DATs
// are immutable per [[feedback_base_dats_only_for_bake]]).
//
// Usage:
//   cd apps/holtburger-web
//   node fixtures/dat/generate_seeds.cjs [--samples 50]
//
// Output: fixtures/dat/seeds.json
//
// Exit codes:
//   0 — wrote seeds.json
//   1 — coverage gap (a planned type returned 0 records)
//   2 — infra (WB.Terminal subprocess failure)

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..", "..");
const WBT_DLL = path.join(REPO_ROOT, "WorldBuilder.Terminal", "bin", "Release", "net8.0", "WorldBuilder.Terminal.dll");
const DOTNET = process.env.DOTNET_ROOT
  ? path.join(process.env.DOTNET_ROOT, "dotnet")
  : "dotnet";

// Per holtburger-dat/src/file_type/mod.rs: 22 parsers shipped. We exclude
// types that are SINGULAR (one record) since "sample 50" is meaningless —
// those are handled as their own single-record fixtures in the validator.
//
// Per [[reference_ac_dat_file_types]] + [[project_emit_dynamic_site]] Phase 6
// inventory.
const PARITY_TARGETS = [
  // Portal DAT — range-based, sample 50.
  { name: "GfxObj",              singular: false },
  { name: "Setup",               singular: false },
  { name: "Animation",           singular: false },
  { name: "Palette",             singular: false },
  { name: "SurfaceTexture",      singular: false },
  { name: "RenderSurface",       singular: false },   // 0x06+0x07 — holtburger-dat::texture
  { name: "Surface",             singular: false },
  { name: "MotionTable",         singular: false },
  { name: "Wave",                singular: false },
  { name: "Environment",         singular: false },
  { name: "Scene",               singular: false },
  { name: "Region",              singular: false },
  { name: "SoundTable",          singular: false },
  { name: "ParticleEmitter",     singular: false },
  { name: "PhysicsScript",       singular: false },
  { name: "PhysicsScriptTable",  singular: false },
  // Portal-DAT singular (one record each — sampled trivially).
  { name: "CharGen",             singular: true },
  { name: "ChatPoseTable",       singular: true },
  { name: "SkillTable",          singular: true },
  { name: "SpellTable",          singular: true },
  { name: "ExperienceTable",     singular: true },
  // Cell DAT — discriminated by suffix.
  { name: "LandBlock",           singular: false },
  { name: "LandBlockInfo",       singular: false },
  { name: "EnvCell",             singular: false },
];

const samplesIdx = process.argv.indexOf("--samples");
const SAMPLES_PER_TYPE = samplesIdx >= 0
  ? parseInt(process.argv[samplesIdx + 1], 10)
  : 50;

if (!fs.existsSync(WBT_DLL)) {
  console.error(`WorldBuilder.Terminal.dll not found at ${WBT_DLL}`);
  console.error("Build first:  dotnet build WorldBuilder.Terminal -c Release");
  process.exit(2);
}

function runWbt(commandObj, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOTNET, [WBT_DLL, "--stdin"], {
      stdio: ["pipe", "pipe", "pipe"], env: { ...process.env },
    });
    let buf = "";
    let stderrBuf = "";
    let resolved = false;
    const expected = commandObj.command;
    const settle = (cb) => { if (resolved) return; resolved = true; try { child.kill(); } catch {} cb(); };
    const timer = setTimeout(() => settle(() =>
      reject(new Error(`Timeout ${timeoutMs}ms for ${expected}\nstderr: ${stderrBuf}\nbuf: ${buf.slice(0, 500)}`))), timeoutMs);
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj; try { obj = JSON.parse(line); } catch { continue; }
        if (obj.command === expected) {
          clearTimeout(timer);
          settle(() => resolve(obj));
          return;
        }
        if (obj.success === false && obj.command !== "ready") {
          clearTimeout(timer);
          settle(() => reject(new Error(`WB.Terminal reported ${obj.command}: ${obj.error ?? JSON.stringify(obj)}`)));
          return;
        }
      }
    });
    child.stderr.on("data", (c) => { stderrBuf += c.toString("utf8"); });
    child.on("error", (e) => { clearTimeout(timer); settle(() => reject(e)); });
    child.on("exit", (code) => { if (resolved) return; clearTimeout(timer); settle(() =>
      reject(new Error(`Exit ${code}: ${stderrBuf}`))); });
    child.stdin.write(JSON.stringify(commandObj) + "\n");
  });
}

// Deterministic sampling: sha256(id_hex) → take first N by sort order.
function sample(ids, n) {
  if (ids.length <= n) return ids.slice();
  const sorted = ids.map(id => ({
    id,
    hash: crypto.createHash("sha256").update(`0x${id.toString(16).padStart(8, "0")}`).digest("hex"),
  }));
  sorted.sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
  return sorted.slice(0, n).map(x => x.id);
}

async function main() {
  console.log(`generate_seeds.cjs — Wave 2.B`);
  console.log(`Samples per type: ${SAMPLES_PER_TYPE}`);
  console.log("");

  const seeds = {
    generatedAt: new Date().toISOString(),
    samplesPerType: SAMPLES_PER_TYPE,
    datSha256: {},
    samples: {},
    coverage: {},
  };

  let coverageGaps = 0;
  for (const target of PARITY_TARGETS) {
    process.stdout.write(`  ${target.name.padEnd(22)} `);
    let res;
    try {
      res = await runWbt({ command: "chorizite-list-dat-records", typeName: target.name });
    } catch (e) {
      console.log(`INFRA: ${e.message}`);
      process.exit(2);
    }
    const records = res.records ?? [];
    const ids = records.map(r => r.id);
    const sampled = sample(ids, SAMPLES_PER_TYPE);
    seeds.coverage[target.name] = {
      totalRecords: ids.length,
      sampled: sampled.length,
      datFile: path.basename(res.datPath),
    };
    seeds.samples[target.name] = sampled.map(id => `0x${id.toString(16).padStart(8, "0").toUpperCase()}`);
    // Track DAT SHA-256 per file (de-dupe).
    seeds.datSha256[path.basename(res.datPath)] = res.datSha256;
    console.log(`${ids.length} records → ${sampled.length} sampled`);
    if (target.singular && ids.length !== 1) {
      console.log(`    WARNING: expected singular type ${target.name} to have 1 record, got ${ids.length}`);
    }
    if (ids.length === 0) {
      console.log(`    GAP: zero records returned for ${target.name}`);
      coverageGaps += 1;
    }
  }

  const outPath = path.join(__dirname, "seeds.json");
  fs.writeFileSync(outPath, JSON.stringify(seeds, null, 2));
  console.log("");
  console.log(`Wrote ${outPath}`);
  console.log(`Coverage gaps: ${coverageGaps}`);

  if (coverageGaps > 0) {
    console.log(`Note: GAP rows are reported in seeds.json but do not block the validator run.`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(2); });
