#!/usr/bin/env node
// nav_batch_import.cjs — batch import a directory of community-authored
// VTank/uTank2 .nav/.af files into a (node-side, in-memory) Atlas instance via
// nav_import.js, and write:
//   1. a JSON summary of the whole run (per-file points/legs/flag-counts/
//      record-type histogram/warnings + aggregate totals), and
//   2. one "hb-route-v1" interchange-schema JSON file PER ROUTE (an .af with
//      multiple NAV: sections yields one file per section) — the contract a
//      downstream Rust offline validator consumes. Coordinates are WORLD-FRAME
//      AC metres (same worldXY convention atlas.js/route_recorder.js use:
//      globalX = lb.byteX*192+localX), not the landblock-local navPointToLeg
//      x/y, so a leg is self-describing without also carrying `lb`.
//
// This is a node/CommonJS utility (mirrors atlas_mirror.cjs's style), not a
// browser module — the ESM rynth/*.js modules are dynamic-imported.
//
// Usage:
//   node nav_batch_import.cjs <inputDir>[,<inputDir2>,...] [outputDir]
//   RYNTH_NAV_ROUTES_DIR overrides the default output dir when outputDir is
//   omitted. Default: /mnt/wbterminal2/met-corpus/routes-json/
//   A comma-separated inputDir list produces ONE combined summary/run (each
//   file's relative path is computed against its own root, so files from
//   different corpora don't collide in the report).
//
// Exit code: 0 if every discovered .nav/.af file parsed with at least one
// leg (warnings do not fail the run — only a hard parse failure, i.e. zero
// legs from a file that should have produced some, does); 1 otherwise. This
// mirrors the "never silently drop a whole file" spirit of nav_import.js.

"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const DEFAULT_OUT_DIR = process.env.RYNTH_NAV_ROUTES_DIR || "/mnt/wbterminal2/met-corpus/routes-json/";
const RYNTH_DIR = path.join(__dirname); // this file lives in rynth/ itself

async function loadModules() {
  const NI = await import(pathToFileURL(path.join(RYNTH_DIR, "nav_import.js")).href);
  const NF = await import(pathToFileURL(path.join(RYNTH_DIR, "nav_file.js")).href);
  const AtlasMod = await import(pathToFileURL(path.join(RYNTH_DIR, "atlas.js")).href);
  return { NI, NF, Atlas: AtlasMod.Atlas };
}

function worldXY(lb, x, y) {
  return [((lb >>> 24) & 0xff) * 192 + x, ((lb >>> 16) & 0xff) * 192 + y];
}

// route (atlas-shaped, from nav_import.js) -> hb-route-v1 JSON object.
function toHbRouteV1(route, warnings, { fileName } = {}) {
  return {
    schema: "hb-route-v1",
    name: route.name,
    source: "vtank-nav",
    fileName: fileName,
    navType: route.navType,
    legs: route.legs.map((l) => {
      const [wx, wy] = worldXY(l.lb >>> 0, l.x, l.y);
      const leg = { x: wx, y: wy, z: l.z, portal: !!l.portal, indoor: !!l.indoor };
      if (l.meta) leg.meta = l.meta;
      return leg;
    }),
    warnings,
  };
}

function safeOutName(relPath, section) {
  const base = relPath.replace(/[\\/]/g, "__");
  return section ? `${base}__${section}.json` : `${base}.json`;
}

function recordTypeHistogram(legs) {
  const h = {};
  for (const l of legs) {
    const k = l.meta ? l.meta.navType : "pnt";
    h[k] = (h[k] || 0) + 1;
  }
  return h;
}

function mergeHistogram(into, from) {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] || 0) + v;
}

async function main() {
  const [inputDirArg, outputDirArg] = process.argv.slice(2);
  if (!inputDirArg) {
    console.error("usage: node nav_batch_import.cjs <inputDir>[,<inputDir2>,...] [outputDir]");
    process.exit(2);
  }
  const inputDirs = inputDirArg.split(",").map((s) => path.resolve(s.trim())).filter(Boolean);
  const outDir = path.resolve(outputDirArg || DEFAULT_OUT_DIR);
  for (const d of inputDirs) {
    if (!fs.existsSync(d)) {
      console.error(`input dir not found: ${d}`);
      process.exit(2);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });

  const { NI, Atlas } = await loadModules();
  const atlas = new Atlas({ log: () => {} }); // quiet — this tool prints its own summary

  // Recursively find .nav/.af files under one root (met-corpus is flat
  // per-source-dir, but don't assume — walk it properly).
  function walk(dir) {
    const out = [];
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) out.push(...walk(p));
      else if (/\.(nav|af)$/i.test(ent.name)) out.push(p);
    }
    return out;
  }
  // {abs, root} so each file's reported/relative path is against ITS OWN
  // input root — files from different corpora never collide in the report
  // or in the output-JSON naming (safeOutName prefixes by relative path).
  const files = inputDirs
    .flatMap((root) => walk(root).map((abs) => ({ abs, root })))
    .sort((a, b) => a.abs.localeCompare(b.abs));

  const perFile = [];
  const aggregate = {
    filesTotal: files.length,
    filesOk: 0,
    filesFailed: 0,
    routesTotal: 0,
    legsTotal: 0,
    portalLegsTotal: 0,
    recordTypeHistogram: {},
    unrecognizedTypesSeen: new Set(),
    filesWithWarnings: [],
  };

  for (const { abs, root } of files) {
    // Namespace by the input root's basename so two corpora with the same
    // relative filename (e.g. two dirs each containing "tusker-abode.nav")
    // never collide in the report or the output-JSON filenames.
    const rel = path.join(path.basename(root), path.relative(root, abs));
    const ext = path.extname(abs).toLowerCase();
    const text = fs.readFileSync(abs, "utf8");
    const fileEntry = { file: rel, ext, routes: [], error: null };

    try {
      if (ext === ".nav") {
        const { route, warnings } = NI.importNavText(text, { name: rel, atlas, fileName: rel });
        if (!route) {
          fileEntry.error = `no legs produced (${warnings.join("; ")})`;
        } else {
          fileEntry.routes.push({ name: route.name, route, warnings });
          const outName = safeOutName(rel);
          fs.writeFileSync(path.join(outDir, outName), JSON.stringify(toHbRouteV1(route, warnings, { fileName: rel }), null, 2));
        }
      } else {
        const { routes, warnings: topWarnings } = NI.importAfText(text, { atlas, fileName: rel, namePrefix: rel });
        if (!routes.length) {
          fileEntry.error = `no NAV sections found (${topWarnings.join("; ")})`;
        }
        for (const r of routes) {
          if (!r.route) continue;
          fileEntry.routes.push({ name: r.route.name, route: r.route, warnings: r.warnings });
          // section name is whatever followed the namePrefix ":" — recover it
          // for a readable output filename.
          const section = r.name.includes(":") ? r.name.slice(r.name.indexOf(":") + 1) : r.name;
          const outName = safeOutName(rel, section);
          fs.writeFileSync(path.join(outDir, outName), JSON.stringify(toHbRouteV1(r.route, r.warnings, { fileName: rel }), null, 2));
        }
        if (topWarnings.length) fileEntry.topWarnings = topWarnings;
      }
    } catch (e) {
      fileEntry.error = `threw: ${e.message}`;
    }

    // Per-file stats + unrecognized-type loud collection.
    let fileLegs = 0;
    let filePortals = 0;
    const fileHist = {};
    let fileWarned = false;
    for (const r of fileEntry.routes) {
      fileLegs += r.route.legs.length;
      filePortals += r.route.legs.filter((l) => l.portal).length;
      mergeHistogram(fileHist, recordTypeHistogram(r.route.legs));
      for (const w of r.warnings) {
        fileWarned = true;
        const m = /unrecognized nav point type (\d+)/.exec(w) || /unknown waypoint type (\d+)/.exec(w);
        if (m) aggregate.unrecognizedTypesSeen.add(Number(m[1]));
      }
    }
    fileEntry.points = fileLegs; // 1:1 with legs in this pipeline
    fileEntry.legs = fileLegs;
    fileEntry.portalsUsed = filePortals;
    fileEntry.recordTypeHistogram = fileHist;
    fileEntry.warningCount = fileEntry.routes.reduce((n, r) => n + r.warnings.length, 0) + (fileEntry.topWarnings || []).length;

    if (fileEntry.error) aggregate.filesFailed++;
    else aggregate.filesOk++;
    aggregate.routesTotal += fileEntry.routes.length;
    aggregate.legsTotal += fileLegs;
    aggregate.portalLegsTotal += filePortals;
    mergeHistogram(aggregate.recordTypeHistogram, fileHist);
    if (fileWarned) aggregate.filesWithWarnings.push(rel);

    // Strip the heavy `route` object before pushing to the summary (the full
    // route already went to its own hb-route-v1 JSON file above).
    perFile.push({
      file: fileEntry.file,
      ext: fileEntry.ext,
      error: fileEntry.error,
      routeCount: fileEntry.routes.length,
      routeNames: fileEntry.routes.map((r) => r.name),
      points: fileEntry.points,
      legs: fileEntry.legs,
      portalsUsed: fileEntry.portalsUsed,
      recordTypeHistogram: fileEntry.recordTypeHistogram,
      warningCount: fileEntry.warningCount,
      warnings: [...fileEntry.routes.flatMap((r) => r.warnings), ...(fileEntry.topWarnings || [])],
    });
  }

  const summary = {
    inputDirs,
    outDir,
    generatedAt: new Date().toISOString(),
    filesTotal: aggregate.filesTotal,
    filesOk: aggregate.filesOk,
    filesFailed: aggregate.filesFailed,
    routesTotal: aggregate.routesTotal,
    legsTotal: aggregate.legsTotal,
    portalLegsTotal: aggregate.portalLegsTotal,
    recordTypeHistogram: aggregate.recordTypeHistogram,
    unrecognizedTypesSeen: [...aggregate.unrecognizedTypesSeen].sort((a, b) => a - b),
    filesWithWarnings: aggregate.filesWithWarnings,
    perFile,
  };
  const summaryPath = path.join(outDir, "_summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log(`nav_batch_import: ${aggregate.filesOk}/${aggregate.filesTotal} files ok, ${aggregate.routesTotal} routes, ${aggregate.legsTotal} legs, ${aggregate.portalLegsTotal} portal legs`);
  console.log(`record-type histogram: ${JSON.stringify(aggregate.recordTypeHistogram)}`);
  if (aggregate.unrecognizedTypesSeen.size) {
    console.log(`\n*** UNRECOGNIZED NAV POINT TYPES SEEN (nav_file.js could not map these): ${[...aggregate.unrecognizedTypesSeen].join(", ")} ***`);
  }
  if (aggregate.filesFailed) {
    console.log(`\n*** ${aggregate.filesFailed} FILE(S) FAILED TO PRODUCE ANY ROUTE: ***`);
    for (const f of perFile) if (f.error) console.log(`  - ${f.file}: ${f.error}`);
  }
  console.log(`\nsummary written to ${summaryPath}`);
  console.log(`per-route JSON written to ${outDir}`);
  process.exit(aggregate.filesFailed ? 1 : 0);
}

main().catch((e) => {
  console.error(`FATAL ${e.stack || e.message}`);
  process.exit(1);
});
