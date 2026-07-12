// Batch 2 — picking hit-resolution (#18), pick-destroy cancelCharge,
// and debug-overlay cursor-pick memoization (#32).
//
// Loads scene3d/picking.js by stripping its `import * as THREE` and the
// `../ui/...` helper imports, injecting THREE + no-op stubs for the
// helpers (none are exercised on the pick / destroy paths under test).
// Then loads plugins/debug-overlay.js's updateValues / mousemove handler
// via the same factory trick to assert #32's re-pick gating.
//
// Run with:
//   cd apps/holtburger-web/
//   THREE_PATH=/path/to/three.module.js node test_picking_resolve.mjs
//
// SKIP gracefully if three can't be located (mirrors the sibling tests).
//
// What this proves:
//   #18  — pickEntityAt walks distance-sorted hits and returns the first
//          NON-local guid, stepping past the local rig (which is in
//          `roots` but excluded from `guidByRoot`). Inverses: only-other
//          → otherGuid; empty → null; only-local → null.
//   destroy — calling the returned handle's destroy() cancels an
//          in-flight charge (cancelAnimationFrame + setMovementInput(0)).
//   #32  — debug-overlay re-picks ONLY when the cursor moved; a 2nd
//          updateValues() with no mousemove does NOT re-invoke
//          __pickEntityAt, but one after a mousemove DOES.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
    else passed += 1;
}

// ---- locate `three` --------------------------------------------------
function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        return process.env.THREE_PATH;
    }
    try {
        return require.resolve("three");
    } catch (_) {}
    const candidates = [];
    try {
        const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
        if (existsSync(npxRoot)) {
            const fs = require("node:fs");
            for (const dir of fs.readdirSync(npxRoot)) {
                candidates.push(joinPath(npxRoot, dir, "node_modules/three/build/three.module.js"));
            }
        }
    } catch (_) {}
    for (const c of candidates) if (existsSync(c)) return c;
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("picking-resolve test: SKIP (three not located).");
    console.log("  hint: THREE_PATH=/path/to/three.module.js node test_picking_resolve.mjs");
    process.exit(0);
}

const THREE = await import("file://" + threePath);

console.log("Batch 2 — picking hit-resolution + pick-destroy + overlay #32");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// ---- module load helpers --------------------------------------------
function stripExports(src) {
    return src
        .replace(/^\s*export\s+function\s+/gm, "function ")
        .replace(/^\s*export\s+class\s+/gm, "class ")
        .replace(/^\s*export\s+const\s+/gm, "const ")
        .replace(/^\s*export\s+default\s+/gm, "")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
}

// Load picking.js: strip the THREE import + the `../ui/...` helper
// imports (none invoked on the pick/destroy paths) and the eager
// `loadCombatManeuverTable()` import-time call.
function loadPicking() {
    const full = resolvePath(__dirname, "scene3d/picking.js");
    let src = readFileSync(full, "utf8");
    src = src
        .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
        // Remove every `import ... from "../ui/....js"` line (single- or
        // multi-line braced form) and replace the named bindings with
        // module-scope no-op stubs.
        .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\.\.\/ui\/[^"']+["'];?\s*$/gms, "")
        .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\.\.\/ui\/[^"']+["'];?\s*$/gm, "")
        // WS05: strip the sibling `./spell_range.js` import too (its bindings
        // are stubbed below; the range-warn path isn't exercised here).
        .replace(/^\s*import\s+\{[^}]*\}\s+from\s+["']\.\/[^"']+["'];?\s*$/gm, "");
    return src;
}

let pickingSrc = loadPicking();
// Prepend stubs for every binding the stripped `../ui/...` imports
// provided, so the function bodies (never reached in these tests) still
// reference defined symbols.
const uiStubs = `
const ATTACK_TYPE = { Undef: 0, Slash: 0x04, Punch: 0x01, Kick: 0x08 };
const getCombatManeuver = () => 0;
const loadCombatManeuverTable = () => {};
const inferAttackTypeForWeapon = () => 0;
const getAimLevelForVelocity = () => 0;
const getAimLevelForBallisticArc = () => 0;
const isAttackerBehindDefender = () => false;
const classifySpell = () => null;
const pickSkillLevel = () => 0;
const determineSpellRange = () => 0;
`;

const pickingComposite =
    "// === picking.js ===\n" +
    uiStubs +
    stripExports(pickingSrc) +
    "\n; return { setupClickPicking };";

const pickingFactory = new Function(
    "THREE",
    "window",
    "document",
    "performance",
    "console",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    pickingComposite,
);

// ---- shared fake environment ----------------------------------------
// rAF / cancel spies captured per-construction.
let rafCalls = 0;
let cancelCalls = 0;
let lastCancelledId = null;
const fakeRaf = () => { rafCalls += 1; return 12345; };
const fakeCancel = (id) => { cancelCalls += 1; lastCancelledId = id; };

const fakeDoc = {
    addEventListener: () => {},
    removeEventListener: () => {},
};
const fakeWindow = {};

function makeFakeCanvas() {
    return {
        addEventListener: () => {},
        removeEventListener: () => {},
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    };
}

// A minimal entity root that masquerades as a THREE.Object3D for the
// raycaster intersect contract — picking.js only reads `.parent` while
// walking up to a guidByRoot match.
function makeRoot() {
    return { parent: null };
}

// Build an entityManager with the local player + arbitrary other
// entities. The local rig is present in entityMap (so it lands in
// `roots`) but excluded from guidByRoot inside pickEntityAt.
function makeEntityManager(localGuid, others) {
    const entityMap = new Map();
    entityMap.set(localGuid >>> 0, { root: makeRoot() });
    const otherRoots = {};
    for (const [guid, ] of others) {
        const root = makeRoot();
        otherRoots[guid] = root;
        entityMap.set(guid >>> 0, { root });
    }
    return { entityManager: { entityMap }, localRoot: entityMap.get(localGuid >>> 0).root, otherRoots };
}

// Stub Raycaster.intersectObjects via the prototype so the closure-local
// `new THREE.Raycaster()` picks it up. `setFromCamera` is also stubbed
// to avoid touching a real camera matrix.
let nextHits = [];
const origIntersect = THREE.Raycaster.prototype.intersectObjects;
const origSetFromCamera = THREE.Raycaster.prototype.setFromCamera;
THREE.Raycaster.prototype.setFromCamera = function () {};
THREE.Raycaster.prototype.intersectObjects = function () {
    // Return clones referencing the live roots so the up-walk works.
    return nextHits.map((object) => ({ object, distance: 0 }));
};

function buildPicking(localGuid, others) {
    rafCalls = 0;
    cancelCalls = 0;
    lastCancelledId = null;
    const em = makeEntityManager(localGuid, others);
    const liveScene3d = {
        camera: {},
        cameraSwitcher: null,
        entityManager: em.entityManager,
    };
    const sessionMovementCalls = [];
    const sessionHandle = {
        setMovementInput: (...a) => { sessionMovementCalls.push(a); },
        getLocalPlayerPose: () => ({ x: 10, y: 20, z: 0, heading: 0, landblockId: 0 }),
        // Melee fire path requires `attack` to be a function before it
        // arms the charge; magic/missile not exercised here.
        attack: () => {},
    };
    const handle = pickingFactory(
        THREE,
        fakeWindow,
        fakeDoc,
        { now: () => 1000 },
        { log: () => {}, warn: () => {} },
        fakeRaf,
        fakeCancel,
    ).setupClickPicking({
        canvas: makeFakeCanvas(),
        liveScene3d,
        sessionHandle,
        isInMeleeStance: () => true,
        isInRangedStance: () => false,
        isInMagicStance: () => false,
        getLocalPlayerGuid: () => localGuid,
    });
    return { handle, liveScene3d, em, sessionMovementCalls,
             pickEntityAt: fakeWindow.__pickEntityAt };
}

// ===================================================================
// #18 — distance-sorted hit resolution, skip local rig
// ===================================================================
console.log("\n#18 — pickEntityAt walks sorted hits, returns first non-local guid");
{
    const LOCAL = 0x50000001;
    const OTHER = 0x50000002;
    const { em, pickEntityAt } = buildPicking(LOCAL, [[OTHER, null]]);

    // (A) local rig in front, NPC behind → must skip self, return OTHER.
    nextHits = [em.localRoot, em.otherRoots[OTHER]];
    check("local-then-other → returns other guid (not null)",
        (pickEntityAt(100, 100) >>> 0) === (OTHER >>> 0),
        "got=0x" + ((pickEntityAt(100, 100) >>> 0).toString(16)));

    // (B) only the other entity → returns OTHER.
    nextHits = [em.otherRoots[OTHER]];
    check("only-other → returns other guid",
        (pickEntityAt(100, 100) >>> 0) === (OTHER >>> 0));

    // (C) no hits → null.
    nextHits = [];
    check("empty hits → null", pickEntityAt(100, 100) === null);

    // (D) only the local rig → null (can't pick yourself).
    nextHits = [em.localRoot];
    check("only-local → null (can't pick yourself)", pickEntityAt(100, 100) === null);
}

// Child-mesh walk: a hit on a rig PART (child of the entity root) must
// still resolve up to the root's guid.
console.log("\n#18 — child-mesh hit resolves up to entity root guid");
{
    const LOCAL = 0x60000001;
    const OTHER = 0x60000002;
    const { em, pickEntityAt } = buildPicking(LOCAL, [[OTHER, null]]);
    const childPart = { parent: em.otherRoots[OTHER] };
    // Local rig in front (occluder), then a CHILD mesh of the NPC.
    nextHits = [em.localRoot, childPart];
    check("local-then-otherChild → returns other root guid",
        (pickEntityAt(100, 100) >>> 0) === (OTHER >>> 0));
}

// ===================================================================
// pick-destroy — destroy() cancels an in-flight charge
// ===================================================================
console.log("\npick-destroy — destroy() cancels in-flight charge (rAF + movement stop)");
{
    const LOCAL = 0x70000001;
    const OTHER = 0x70000002;
    const { handle, em, sessionMovementCalls } = buildPicking(LOCAL, [[OTHER, null]]);

    // Simulate an in-flight charge by driving __fireAttackOnTarget on a
    // selected, out-of-range target so startCharge arms the rAF loop.
    em.entityManager.entityMap.get(OTHER >>> 0).root.position = { x: 5000, y: 5000, z: 0 };
    em.entityManager.entityMap.get(OTHER >>> 0).root.position.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; };
    // getSelectedTarget returns OTHER; entityAcPosition reads root.position.
    em.entityManager.getSelectedTarget = () => OTHER >>> 0;
    // Add minimal helpers used along the melee fire path.
    em.entityManager.getEquippedWeapon = () => null;
    em.entityManager.isDualWield = () => false;
    em.entityManager.setSwingMotion = () => {};

    // Provide a position for the local root too (entityAcPosition path).
    fakeWindow.__combatBarState = { chargeAttack: true, attackHeight: 2, powerLevel: 1 };
    const before = { raf: rafCalls, cancel: cancelCalls };
    try { fakeWindow.__fireAttackOnTarget(2); } catch (_) {}
    const chargeArmed = rafCalls > before.raf;
    check("charge armed an rAF loop (precondition)", chargeArmed,
        "rafCalls=" + rafCalls);

    const movesBefore = sessionMovementCalls.length;
    handle.destroy();
    const cancelledAfter = cancelCalls > before.cancel;
    // destroy() → cancelCharge() → cancelAnimationFrame + setMovementInput(0,0,0,false)
    const stopped = sessionMovementCalls.some(
        (a) => a[0] === 0 && a[1] === 0 && a[2] === 0 && a[3] === false,
    );
    check("destroy() called cancelAnimationFrame", cancelledAfter,
        "cancelCalls=" + cancelCalls);
    check("destroy() zeroed movement input", stopped,
        "moves=" + JSON.stringify(sessionMovementCalls.slice(movesBefore)));
}

// restore prototype patches before loading the overlay
THREE.Raycaster.prototype.intersectObjects = origIntersect;
THREE.Raycaster.prototype.setFromCamera = origSetFromCamera;

// ===================================================================
// #32 — debug-overlay re-picks ONLY when the cursor moved
// ===================================================================
console.log("\n#32 — debug-overlay cursor-pick gated on mousemove");
{
    // debug-overlay.js gates its IIFE on `?debug=1` via window.location.
    // Strip the export footer; expose the internals we drive.
    const full = resolvePath(__dirname, "plugins/debug-overlay.js");
    let src = readFileSync(full, "utf8")
        .replace(/^\s*export\s+\{[^}]+\}[\s;]*$/gm, "");
    const composite =
        "// === debug-overlay.js ===\n" +
        src +
        "\n; return { onCanvasMouseMove, onCanvasMouseLeave, updateValues, mountOverlay };";

    // A DOM stub good enough for mountOverlay + updateValues.
    const valueStore = {};
    function makeEl() {
        return {
            id: "", className: "", textContent: "", hidden: false,
            style: {},
            appendChild() {},
            remove() {},
            get parentNode() { return null; },
        };
    }
    const fakeDocOverlay = {
        readyState: "complete",
        createElement: () => makeEl(),
        getElementById: () => null,
        addEventListener: () => {},
        removeEventListener: () => {},
        head: { appendChild() {} },
        body: { appendChild() {} },
    };

    // Spy on __pickEntityAt.
    let pickInvocations = 0;
    const overlayWindow = {
        location: { search: "?debug=1" },
        requestAnimationFrame: () => 1,
        cancelAnimationFrame: () => {},
        __pickEntityAt: (x, y) => { pickInvocations += 1; return 0xABCD0001; },
        getLocalPlayerGuid: () => 0,
        liveScene3d: {
            renderer: { info: { render: {}, memory: {}, programs: [] } },
            entityManager: { getSelectedTarget: () => 0 },
            landblockLru: null,
            cameraSwitcher: null,
            camera: { position: { x: 0, y: 0, z: 0 } },
        },
    };

    const overlayFactory = new Function(
        "window",
        "document",
        "performance",
        "URLSearchParams",
        composite,
    );
    const overlay = overlayFactory(
        overlayWindow,
        fakeDocOverlay,
        { now: () => 0 },
        URLSearchParams,
    );

    overlay.mountOverlay();

    // First, simulate the cursor moving over the canvas → marks dirty.
    overlay.onCanvasMouseMove({ clientX: 100, clientY: 100 });
    overlay.updateValues();
    const afterFirst = pickInvocations;
    check("re-picks once after a mousemove", afterFirst === 1,
        "pickInvocations=" + afterFirst);

    // Second updateValues() with NO new mousemove → must NOT re-pick.
    overlay.updateValues();
    overlay.updateValues();
    check("no re-pick on subsequent ticks without mousemove",
        pickInvocations === afterFirst,
        "pickInvocations=" + pickInvocations);

    // A new mousemove → re-pick on the next tick.
    overlay.onCanvasMouseMove({ clientX: 120, clientY: 130 });
    overlay.updateValues();
    check("re-picks again after a fresh mousemove",
        pickInvocations === afterFirst + 1,
        "pickInvocations=" + pickInvocations);
}

// ---- summary ---------------------------------------------------------
console.log("\n=========================");
console.log(`picking-resolve test: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
