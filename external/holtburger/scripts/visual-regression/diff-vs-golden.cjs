// Phase X.2 — pixelmatch diff between a fresh capture and a stored
// golden. Exits 0 if the pixel delta is <5% (configurable via
// VISREG_DIFF_THRESHOLD), 1 otherwise.
//
// Reads the *most recent* date-stamped PNG under
//   /mnt/wbterminal1/holtburger-goldens/{view}/{quality}/
// and compares to the canonical golden at the same dir:
//   /mnt/wbterminal1/holtburger-goldens/{view}/{quality}/golden.png
//
// The diff visualization is written to:
//   /mnt/wbterminal1/holtburger-goldens/{view}/{quality}/diff-<stamp>.png
//
// Args:
//   --view <id>          required
//   --quality <preset>   required (low|mid|high|ultra)
//   --root <dir>         override goldens root (default /mnt/wbterminal1/holtburger-goldens)
//   --threshold <0..1>   pixel-delta threshold, default 0.05 (5%)
//   --capture <path>     override the new-capture path (defaults to most recent .png)
//
// Run:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node external/holtburger/scripts/visual-regression/diff-vs-golden.cjs \
//     --view holtburg_plaza_noon --quality low

const path = require("node:path");
const fs = require("node:fs");

const PIXELMATCH_PREFIX =
  process.env.PIXELMATCH_PREFIX || "/home/wbterminal/.npm/node_modules";

let PNG;
try {
  ({ PNG } = require(path.join(PIXELMATCH_PREFIX, "pngjs")));
} catch (e) {
  console.error(
    `FAIL: pngjs not found under ${PIXELMATCH_PREFIX}.\n` +
      `      cd ${PIXELMATCH_PREFIX}/.. && npm install --no-save pixelmatch pngjs`
  );
  process.exit(2);
}

function parseArgs(argv) {
  const out = {
    view: null,
    quality: null,
    root: "/mnt/wbterminal1/holtburger-goldens",
    threshold: 0.05,
    capture: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case "--view": out.view = next(); break;
      case "--quality": out.quality = next(); break;
      case "--root": out.root = next(); break;
      case "--threshold": out.threshold = Number(next()); break;
      case "--capture": out.capture = next(); break;
      case "--help":
      case "-h":
        console.log(
          "Usage: diff-vs-golden.cjs --view <id> --quality <preset> [--threshold 0.05]"
        );
        process.exit(0);
        break;
      default:
        if (a.startsWith("--")) {
          console.error(`unknown flag: ${a}`);
          process.exit(2);
        }
    }
  }
  if (!out.view) { console.error("FAIL: --view required"); process.exit(2); }
  if (!out.quality) { console.error("FAIL: --quality required"); process.exit(2); }
  return out;
}

function findMostRecentCapture(dir) {
  if (!fs.existsSync(dir)) return null;
  const entries = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .filter((f) => f !== "golden.png" && !f.startsWith("diff-"))
    .map((f) => ({ name: f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries.length > 0 ? path.join(dir, entries[0].name) : null;
}

function readPng(fpath) {
  const buf = fs.readFileSync(fpath);
  return PNG.sync.read(buf);
}

function writePng(fpath, png) {
  fs.writeFileSync(fpath, PNG.sync.write(png));
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const dir = path.join(args.root, args.view, args.quality);
  const goldenPath = path.join(dir, "golden.png");

  if (!fs.existsSync(goldenPath)) {
    console.error(`FAIL: no golden at ${goldenPath}`);
    console.error(
      `      Accept a recent capture as golden first: cp <capture>.png ${goldenPath}`
    );
    process.exit(2);
  }

  const capturePath = args.capture || findMostRecentCapture(dir);
  if (!capturePath) {
    console.error(`FAIL: no capture PNG found in ${dir}`);
    process.exit(2);
  }

  const pixelmatch = (
    await import(path.join(PIXELMATCH_PREFIX, "pixelmatch", "index.js"))
  ).default;

  const golden = readPng(goldenPath);
  const capture = readPng(capturePath);

  if (golden.width !== capture.width || golden.height !== capture.height) {
    console.error(
      `FAIL: dim mismatch — golden ${golden.width}x${golden.height} ` +
        `vs capture ${capture.width}x${capture.height}`
    );
    console.error(`      golden:  ${goldenPath}`);
    console.error(`      capture: ${capturePath}`);
    process.exit(1);
  }

  const w = golden.width;
  const h = golden.height;
  const diffPng = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(
    golden.data,
    capture.data,
    diffPng.data,
    w,
    h,
    { threshold: 0.1, includeAA: false }
  );

  const totalPixels = w * h;
  const ratio = diffPixels / totalPixels;

  const stamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-")
    .slice(0, 19);
  const diffPath = path.join(dir, `diff-${stamp}.png`);
  writePng(diffPath, diffPng);

  const passed = ratio < args.threshold;
  const summary = {
    view: args.view,
    quality: args.quality,
    goldenPath,
    capturePath,
    diffPath,
    width: w,
    height: h,
    totalPixels,
    diffPixels,
    ratio,
    threshold: args.threshold,
    passed,
    timestamp: stamp,
  };

  const summaryPath = path.join(dir, `diff-${stamp}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));

  console.log("=========================");
  console.log(`[visfid-x2-diff] view=${args.view} quality=${args.quality}`);
  console.log(`  golden:    ${goldenPath}`);
  console.log(`  capture:   ${capturePath}`);
  console.log(`  diff:      ${diffPath}`);
  console.log(`  summary:   ${summaryPath}`);
  console.log(
    `  delta:     ${diffPixels} / ${totalPixels} = ` +
      `${(ratio * 100).toFixed(4)}% (threshold ${(args.threshold * 100).toFixed(2)}%)`
  );
  console.log(`  result:    ${passed ? "PASS" : "FAIL"}`);
  process.exit(passed ? 0 : 1);
})().catch((e) => {
  console.error("[visfid-x2-diff] threw:", e?.message ?? e);
  console.error(e?.stack ?? "");
  process.exit(2);
});
