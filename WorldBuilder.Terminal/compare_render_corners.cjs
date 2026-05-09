#!/usr/bin/env node
// Sweep WorldBuilder.Terminal's `compare-render-corners` across a set of
// landblocks and report pass/fail per LB.
//
// Each building's footprint corners get rotated two ways: full quaternion
// (Vector3.Transform — what the validator and the C# render-preview use)
// vs yaw-only (the same atan2 formula holtburger-web's wasm uses). If the
// two match within --tolerance metres for every corner, the LB is safe to
// ship through emit-dynamic-site's top-down sprite renderer. If any
// building diverges, the LB has placements with a non-trivial pitch/roll
// component and the renderer's yaw-only path is unsafe — flag for triage.
//
// Usage:
//   node compare_render_corners.cjs --project /path/to.wbproj --lbs 169,180 170,180
//   node compare_render_corners.cjs --project ... --towns      # sweep curated town list
//   node compare_render_corners.cjs --project ... --all        # sweep every LB with structures
//
// Env overrides: WB_PROJECT, WB_TERMINAL_DLL, DOTNET, WB_TOLERANCE.

const child = require("node:child_process");
const fs = require("node:fs");

const args = parseArgs(process.argv.slice(2));

const project = args.project ?? process.env.WB_PROJECT;
if (!project || !fs.existsSync(project)) {
    console.error(`error: --project <path-to-.wbproj> required (got ${project})`);
    process.exit(2);
}
const dotnet = args.dotnet ?? process.env.DOTNET ?? "/home/wbterminal/.dotnet/dotnet";
const dll = args.dll ?? process.env.WB_TERMINAL_DLL
    ?? `${__dirname}/bin/Release/net8.0/WorldBuilder.Terminal.dll`;
if (!fs.existsSync(dll)) {
    console.error(`error: terminal dll not found at ${dll}`);
    process.exit(2);
}
const tolerance = Number(args.tolerance ?? process.env.WB_TOLERANCE ?? "0.05");
const verbose = !!args.verbose;

// Curated towns — coordinates lifted from `town_gazetteer.json`.
const TOWN_LBS = [
    [169, 180, "Holtburg"],
    [126, 99,  "Yaraq"],
    [217, 85,  "Shoushi"],
    [188, 159, "Cragstone"],
    [151, 123, "Samsur"],
    [161, 164, "Glenden Wood"],
    [206, 149, "Eastham"],
    [229, 50,  "Mayoi"],
    [191, 128, "Lytelthorpe"],
    [200, 140, "Rithwic"],
    [179, 112, "Yanshi"],
    [248, 93,  "Tou-Tou"],
    [162, 30,  "Linvak Tukal"],
];

let lbs;
if (args.lbs?.length) {
    lbs = args.lbs.map((s) => {
        const [x, y, name] = s.split(",");
        return [Number(x), Number(y), name ?? `LB(${x},${y})`];
    });
} else if (args.towns) {
    lbs = TOWN_LBS;
} else {
    console.error(
        "error: pass either --lbs lbX,lbY[,name] (repeatable) or --towns or --all"
    );
    process.exit(2);
}

(async () => {
    const proc = child.spawn(dotnet, [dll, "--stdin"], {
        stdio: ["pipe", "pipe", "inherit"],
    });

    const outLines = readLines(proc.stdout);
    const send = (cmd) => proc.stdin.write(JSON.stringify(cmd) + "\n");

    // Wait for ready banner.
    await waitFor(outLines, (o) => o.command === "ready");
    send({ command: "load", path: project });
    await waitFor(outLines, (o) => o.command === "load");

    const results = [];
    for (const [lbX, lbY, name] of lbs) {
        send({
            command: "compare-render-corners",
            lbX, lbY, toleranceMetres: tolerance,
        });
        const r = await waitFor(outLines, (o) => o.command === "compare-render-corners");
        results.push({ lbX, lbY, name, ...r });
        const tag = r.failedCount === 0 ? "PASS" : "FAIL";
        console.log(
            `[${tag}] ${name.padEnd(16)} ${r.landblock}  buildings=${r.buildingCount}  passed=${r.passedCount}  failed=${r.failedCount}`
        );
        if (r.failedCount > 0 || verbose) {
            for (const f of r.failures) {
                console.log(
                    `       ${f.modelId}  yaw=${f.yawRadians.toFixed(3)}rad  maxDelta=${f.maxCornerDeltaMetres.toFixed(3)}m  origin=(${f.origin.x.toFixed(2)},${f.origin.y.toFixed(2)},${f.origin.z.toFixed(2)})`
                );
            }
        }
    }
    send({ command: "quit" });
    proc.stdin.end();

    const failed = results.filter((r) => r.failedCount > 0);
    const totalBuildings = results.reduce((s, r) => s + r.buildingCount, 0);
    console.log(
        `\n=== summary === ${lbs.length} LB(s), ${totalBuildings} buildings, tolerance=${tolerance}m`
    );
    if (failed.length === 0) {
        console.log("PASS — every building's yaw-only render agrees with full-quat within tolerance.");
        process.exit(0);
    }
    console.log(`FAIL — ${failed.length} LB(s) had buildings whose yaw-only render diverges:`);
    for (const r of failed) {
        console.log(`  ${r.landblock} ${r.name}: ${r.failedCount} of ${r.buildingCount}`);
    }
    process.exit(1);
})().catch((e) => {
    console.error("FATAL:", e);
    process.exit(2);
});

// --- helpers ---

function parseArgs(argv) {
    const out = { lbs: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === "--project") out.project = argv[++i];
        else if (a === "--lbs") out.lbs.push(argv[++i]);
        else if (a === "--tolerance") out.tolerance = argv[++i];
        else if (a === "--towns") out.towns = true;
        else if (a === "--all") out.all = true;
        else if (a === "--verbose") out.verbose = true;
        else if (a === "--dotnet") out.dotnet = argv[++i];
        else if (a === "--dll") out.dll = argv[++i];
        else throw new Error(`unknown arg: ${a}`);
    }
    return out;
}

function readLines(stream) {
    let buffer = "";
    const queue = [];
    let waiter = null;
    stream.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let i;
        while ((i = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, i).trim();
            buffer = buffer.slice(i + 1);
            if (line) {
                if (waiter) { waiter(line); waiter = null; }
                else queue.push(line);
            }
        }
    });
    stream.on("end", () => {
        if (waiter) { waiter(null); waiter = null; }
    });
    return {
        next() {
            return queue.length > 0
                ? Promise.resolve(queue.shift())
                : new Promise((r) => { waiter = r; });
        },
    };
}

async function waitFor(lines, predicate, timeoutMs = 120000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const line = await lines.next();
        if (line == null) throw new Error("stdin closed before match");
        let parsed;
        try { parsed = JSON.parse(line); }
        catch { continue; }
        if (predicate(parsed)) return parsed;
        // ignore non-matching lines (e.g. noisy log lines)
    }
    throw new Error(`timeout waiting for response`);
}
