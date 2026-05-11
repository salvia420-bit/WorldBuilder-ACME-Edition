// Follow-on #10 — standalone ESM test for `scene3d/hud.js` against real
// `three` (loaded from npm, not the importmap). Run with:
//
//   cd apps/holtburger-web/
//   THREE_PATH=/abs/path/to/three.module.js node test_f10_hud_nameplate.mjs
//
// Same locate-three pattern as test_phase7_4a_animation_clip.mjs. Falls
// back to the host's installed copy of `three` (Playwright is bundled
// at ~/.npm/_npx/.../node_modules/three on this box). If `three` can't
// be located the test prints SKIP and exits 0 (the smoke test's regex
// check stays the floor).
//
// Three stages:
//
//   1. Construct a NameplateLayer with a mock DOM root + mock canvas.
//      Add one fake entity (THREE.Object3D at origin) + one perspective
//      camera positioned behind/above the entity. Call `tick(camera)`
//      and verify the nameplate div was injected + got sensible left/top
//      pixel coordinates.
//
//   2. Move the camera so the entity is BEHIND it (z > 1 in NDC). Tick
//      again and verify the nameplate's display flips to "none".
//
//   3. setNameplate idempotency + removeNameplate teardown.
//
// 5+ assertions guarded.
//
// Note: this test deliberately uses a tiny synthetic DOM (a fake
// document via plain object literals) — three.js itself doesn't touch
// the DOM for Vector3.project(camera); only the layer's DOM writes do.
// The mock DOM exercises `createElement` + `appendChild` + style.left/
// top writes; that's all the test needs to verify the projection
// pipeline + hide logic.

import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath, join as joinPath } from "node:path";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let failed = 0;
function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failed += 1;
}

// ---- locate `three` --------------------------------------------------
function locateThree() {
    if (process.env.THREE_PATH && existsSync(process.env.THREE_PATH)) {
        return process.env.THREE_PATH;
    }
    try {
        return require.resolve("three");
    } catch (_) {}
    const candidates = [
        joinPath(process.env.HOME ?? "", ".npm/_npx/e41f203b7505f1fb/node_modules/three"),
    ];
    try {
        const npxRoot = joinPath(process.env.HOME ?? "", ".npm/_npx");
        if (existsSync(npxRoot)) {
            const fs = require("node:fs");
            for (const dir of fs.readdirSync(npxRoot)) {
                candidates.push(joinPath(npxRoot, dir, "node_modules/three"));
            }
        }
    } catch (_) {}
    for (const c of candidates) {
        const idx = joinPath(c, "build/three.module.js");
        if (existsSync(idx)) return idx;
    }
    return null;
}

const threePath = locateThree();
if (!threePath) {
    console.log("F#10 nameplate ESM test: SKIP (three not located).");
    console.log("  hint: `THREE_PATH=/abs/path/to/three.module.js node test_f10_hud_nameplate.mjs`");
    process.exit(0);
}

const threeUrl = "file://" + threePath;
const THREE = await import(threeUrl);

console.log("F#10 — nameplate overlay standalone ESM test");
console.log(`three loaded from: ${threePath}`);
console.log("=========================");

// Load hud.js and patch the bare `import * as THREE from "three"` to use
// the THREE we just loaded. Same factory pattern as test_phase7_4a.
const hudPath = resolvePath(__dirname, "scene3d", "hud.js");
if (!existsSync(hudPath)) {
    check("hud.js exists", false, hudPath);
    process.exit(failed > 0 ? 1 : 0);
}
const hudSrc = await import("node:fs").then((m) =>
    m.readFileSync(hudPath, "utf8"),
);
const patched = hudSrc
    .replace(/^\s*import\s+\*\s+as\s+THREE\s+from\s+["']three["'];?\s*$/m, "")
    .replace(/^\s*export\s+function\s+/gm, "function ")
    .replace(/^\s*export\s+class\s+/gm, "class ");
const factory = new Function(
    "THREE",
    `${patched}\n; return { NameplateLayer, createNameplateOverlay };`,
);
const { NameplateLayer } = factory(THREE);

check(
    "NameplateLayer constructor importable from hud.js",
    typeof NameplateLayer === "function",
    `typeof=${typeof NameplateLayer}`,
);

// ---- mock DOM --------------------------------------------------------
// Tiny DOM shim: just enough for setNameplate / removeNameplate / tick
// to exercise their full code paths. Each element tracks its children,
// style, textContent, parentNode (so removeChild works).
function makeMockEl(tag) {
    const el = {
        tagName: tag,
        children: [],
        style: {},
        textContent: "",
        className: "",
        id: "",
        parentNode: null,
        appendChild(child) {
            child.parentNode = this;
            this.children.push(child);
        },
        removeChild(child) {
            const i = this.children.indexOf(child);
            if (i >= 0) {
                this.children.splice(i, 1);
                child.parentNode = null;
            }
        },
    };
    return el;
}
const mockDoc = {
    createElement(tag) {
        return makeMockEl(tag);
    },
};
const mockDomRoot = makeMockEl("div");
mockDomRoot.ownerDocument = mockDoc;
const mockCanvas = makeMockEl("canvas");
mockCanvas.clientWidth = 1280;
mockCanvas.clientHeight = 720;
mockCanvas.ownerDocument = mockDoc;

// ---- Stage 1: construct + tick in-front-of-camera --------------------
const layer = new NameplateLayer(mockDomRoot, mockCanvas);
check(
    "NameplateLayer instance has a `nodes` Map + `tick` + `setNameplate` + `removeNameplate`",
    layer instanceof NameplateLayer &&
        layer.nodes instanceof Map &&
        typeof layer.tick === "function" &&
        typeof layer.setNameplate === "function" &&
        typeof layer.removeNameplate === "function",
    `nodes=${layer.nodes?.constructor?.name}, tick=${typeof layer.tick}`,
);

// Fake entity: a THREE.Object3D at the origin. The camera will look at
// it from a distance + up so it projects to roughly the middle of the
// screen.
const fakeEntity = new THREE.Object3D();
fakeEntity.name = "fake_entity_1";
fakeEntity.position.set(0, 0, 0);
fakeEntity.updateMatrixWorld(true);

const cam = new THREE.PerspectiveCamera(60, 1280 / 720, 0.1, 1000);
// 10 m in front of the entity (along three world +Z) at +Y height 1.8 m
// (~head-on view but slightly raised). The nameplate offset bumps the
// projection point up to (0, 1.9, 0); from a camera at (0, 1.8, 10)
// looking at (0, 0.5, 0), the projection point lands solidly inside the
// frustum and a bit above screen centre.
cam.position.set(0, 1.8, 10);
cam.lookAt(0, 0.5, 0);
cam.updateMatrixWorld(true);

const TEST_GUID = 0x12345678;
layer.setNameplate(TEST_GUID, "Sparring Golem", fakeEntity);
check(
    "After setNameplate: layer.nodes contains the GUID",
    layer.nodes.has(TEST_GUID >>> 0),
    `size=${layer.nodes.size}, has=${layer.nodes.has(TEST_GUID >>> 0)}`,
);
const entry = layer.nodes.get(TEST_GUID >>> 0);
check(
    "Nameplate DOM <div> was appended to domRoot with textContent=name",
    entry?.el != null &&
        mockDomRoot.children.includes(entry.el) &&
        entry.el.textContent === "Sparring Golem",
    `appended=${mockDomRoot.children.includes(entry?.el)}, ` +
        `text=${entry?.el?.textContent}`,
);
// Before tick, display is "none" so the DIV doesn't briefly land at
// (0,0) before first projection.
check(
    "Pre-tick: nameplate display='none' (not yet projected)",
    entry.el.style.display === "none",
    `display=${entry.el.style.display}`,
);

// Project. The entity is in front of the camera so display should
// flip to "block" and (left, top) should be sensible pixel coords inside
// the 1280×720 viewport.
layer.tick(cam);
check(
    "Post-tick (in front of camera): nameplate display='block'",
    entry.el.style.display === "block",
    `display=${entry.el.style.display}`,
);
// left / top are strings like "640px". Parse + verify they're in range.
const left1 = parseInt(entry.el.style.left, 10);
const top1 = parseInt(entry.el.style.top, 10);
check(
    "Post-tick: pixel coords inside the 1280×720 viewport (with slight margin)",
    Number.isFinite(left1) &&
        Number.isFinite(top1) &&
        left1 >= -64 &&
        left1 <= 1280 + 64 &&
        top1 >= -64 &&
        top1 <= 720 + 64,
    `left=${entry.el.style.left}, top=${entry.el.style.top}`,
);
// Looking straight at the entity from (0, 1.8, 10) with the +1.9 Y
// offset, the projection point should land near the horizontal centre
// of the screen and somewhere on screen vertically (close to centre,
// possibly upper-half because the camera is below the projection
// point). Verify the X is within ~150 px of centre (1280/2 = 640).
check(
    "Post-tick: pixel X near horizontal centre (head-on view)",
    Math.abs(left1 - 640) < 150,
    `left=${left1}, centre=640, delta=${Math.abs(left1 - 640)}`,
);

// Diagnostics counters bumped.
check(
    "Post-tick: lastTickVisibleCount === 1",
    layer.lastTickVisibleCount === 1 && layer.lastTickHiddenBehindCount === 0,
    `visible=${layer.lastTickVisibleCount}, hidden=${layer.lastTickHiddenBehindCount}`,
);

// ---- Stage 2: camera behind the entity → hide ------------------------
// Reposition the camera so the entity is BEHIND it (entity at origin,
// camera at (0, 1.8, -10) looking AWAY from origin toward -Z).
// `Vector3.project(camera)` will return ndc.z > 1 for the entity in
// this configuration → the layer must hide it.
cam.position.set(0, 1.8, -10);
cam.lookAt(0, 1.8, -100); // looking away from the entity
cam.updateMatrixWorld(true);
layer.tick(cam);
check(
    "Behind-camera tick: nameplate hides (display='none', counter incremented)",
    entry.el.style.display === "none" &&
        layer.lastTickHiddenBehindCount === 1,
    `display=${entry.el.style.display}, hidden=${layer.lastTickHiddenBehindCount}`,
);

// ---- Stage 3: setNameplate idempotency + removeNameplate -------------
// Re-calling with the same GUID + same name should reuse the same el
// (no duplicate child appended to domRoot).
layer.setNameplate(TEST_GUID, "Sparring Golem", fakeEntity);
check(
    "setNameplate(same guid, same name) is idempotent (same el, no dup append)",
    mockDomRoot.children.filter((c) => c === entry.el).length === 1 &&
        layer.nodes.size === 1,
    `domChildren=${mockDomRoot.children.length}, mapSize=${layer.nodes.size}`,
);

// Re-calling with a new name updates textContent in place.
layer.setNameplate(TEST_GUID, "Drudge Toiler", fakeEntity);
check(
    "setNameplate(same guid, new name) updates textContent in place",
    entry.el.textContent === "Drudge Toiler" && layer.nodes.size === 1,
    `text=${entry.el.textContent}`,
);

// Remove + verify the DOM child is detached and the map entry dropped.
layer.removeNameplate(TEST_GUID);
check(
    "removeNameplate: drops the entry + detaches the DOM child",
    layer.nodes.size === 0 &&
        !mockDomRoot.children.includes(entry.el),
    `mapSize=${layer.nodes.size}, stillChild=${mockDomRoot.children.includes(entry.el)}`,
);

// ---- Summary --------------------------------------------------------
console.log("=========================");
if (failed === 0) {
    console.log("PASS: all F#10 nameplate-layer checks green.");
    process.exit(0);
} else {
    console.log(`FAIL: ${failed} check(s) failed.`);
    process.exit(1);
}
