// tests/far_terrain_memory.test.mjs — Area 6: VRAM footprint trim.
// 1. Far terrain render target depth buffer disabled (depthBuffer: false) and lbData typed arrays released on finishPatch.
// 2. Terrain detail normal map array packed as RG8 (THREE.RGFormat) instead of RGBA8.
import assert from "node:assert/strict";
import * as THREE from "three";
import {
  initFarTerrain,
  disposeFarTerrain,
  _finishPatchForTest,
  _bakePatchForTest,
} from "../scene3d/far_terrain.js";
import { loadTerrainDetailNormalArray, TERRAIN_DETAIL_KEYS } from "../scene3d/adapter.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail = "") {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  if (ok) passed++;
  else failed++;
}

console.log("TEST: Far Terrain & Terrain Detail VRAM Footprint Trim");

// ---------------------------------------------------------------------------
// 1. far_terrain: depthBuffer: false on WebGLRenderTarget & lbData release
// ---------------------------------------------------------------------------
{
  disposeFarTerrain();

  const terrainMat = new THREE.ShaderMaterial({
    uniforms: {
      uBakeAlbedo: { value: 0 },
      uAcGouraudEnabled: { value: 0 },
    },
  });

  const scene3d = {
    scene: new THREE.Scene(),
    group: new THREE.Group(),
    terrainGroup: new THREE.Group(),
    terrainMaterials: [terrainMat],
    quality: { flags: {} },
    effectiveFarTerrainRadiusLb: 20,
    farRingSolidRadiusLb: 10,
    farRingMeasuredRadiusLb: 15,
  };

  const renderer = {
    capabilities: {
      getMaxAnisotropy: () => 16,
    },
    getSize: (v) => v.set(800, 600),
    autoClear: false,
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    getScissorTest: () => false,
    setScissorTest: () => {},
    setScissor: () => {},
    setViewport: () => {},
    clear: () => {},
    render: () => {},
  };

  initFarTerrain(scene3d, { parent: scene3d.scene, renderer });

  // Create a mock patch
  const patch = {
    px: 2,
    py: 2,
    state: "loading",
    rt: null,
    lbData: new Map(),
  };

  // Run bakePatch to allocate patch.rt
  _bakePatchForTest(scene3d, renderer, patch);

  check("patch.rt allocated", !!patch.rt);
  check("patch.rt.depthBuffer is false (eliminates unused 512x512 depth renderbuffer)", patch.rt?.depthBuffer === false);
  check("patch.rt.stencilBuffer is false", patch.rt?.stencilBuffer === false);

  // Clean up RT
  if (patch.rt) patch.rt.dispose();

  // Test finishPatch releasing lbData typed arrays
  const testPatch = {
    px: 3,
    py: 3,
    state: "ready",
    geom: null,
    mat: null,
    mesh: null,
    rt: { texture: new THREE.Texture() },
    lbData: new Map(),
  };

  // Populate lbData with typed arrays and dummy geometries
  const dummyEntry1 = {
    positions: new Float32Array(81 * 3),
    indices: new Uint16Array(128 * 3),
    terrainCodes: new Uint8Array(64),
    roadCodes: new Uint8Array(64),
    mergeData: new Float32Array(81),
    heights: new Float32Array(81),
    acNormals: new Float32Array(81 * 3),
    acLightNormals: new Float32Array(81 * 3),
    geom: new THREE.BufferGeometry(),
  };
  const dummyEntry2 = {
    positions: new Float32Array(81 * 3),
    indices: new Uint16Array(128 * 3),
    terrainCodes: new Uint8Array(64),
    roadCodes: new Uint8Array(64),
    mergeData: new Float32Array(81),
    heights: new Float32Array(81),
    acNormals: new Float32Array(81 * 3),
    acLightNormals: new Float32Array(81 * 3),
    geom: new THREE.BufferGeometry(),
  };

  testPatch.lbData.set(0x0C0C0000, dummyEntry1);
  testPatch.lbData.set(0x0C0D0000, dummyEntry2);

  check("pre-finishPatch: lbData has 2 entries", testPatch.lbData.size === 2);

  _finishPatchForTest(scene3d, testPatch);

  check("post-finishPatch: patch.lbData is cleared (size === 0)", testPatch.lbData.size === 0);
  check("post-finishPatch: entry1 positions released (null)", dummyEntry1.positions === null);
  check("post-finishPatch: entry1 indices released (null)", dummyEntry1.indices === null);
  check("post-finishPatch: entry1 heights released (null)", dummyEntry1.heights === null);
  check("post-finishPatch: entry1 normals released (null)", dummyEntry1.acNormals === null);
  check("post-finishPatch: entry1 geom disposed and cleared", dummyEntry1.geom === null);

  disposeFarTerrain();
}

// ---------------------------------------------------------------------------
// 2. adapter.js: loadTerrainDetailNormalArray packs RG8 (THREE.RGFormat)
// ---------------------------------------------------------------------------
{
  const testW = 32;
  const testH = 32;
  const numPixels = testW * testH;

  // Mock global Image & document for decoding
  const oldImage = globalThis.Image;
  const oldDocument = globalThis.document;

  class FakeImage {
    constructor() {
      this.naturalWidth = testW;
      this.naturalHeight = testH;
    }
    set src(val) {
      setTimeout(() => this.onload && this.onload(), 1);
    }
  }

  const fakeCanvas = {
    width: testW,
    height: testH,
    getContext: (type) => ({
      drawImage: () => {},
      getImageData: (x, y, w, h) => {
        const rgba = new Uint8ClampedArray(w * h * 4);
        for (let i = 0; i < w * h; i++) {
          rgba[i * 4 + 0] = (i * 7) & 0xff;     // R
          rgba[i * 4 + 1] = (i * 13) & 0xff;    // G
          rgba[i * 4 + 2] = 255;                // B (should be dropped in RG8)
          rgba[i * 4 + 3] = 255;                // A (should be dropped in RG8)
        }
        return { data: rgba };
      },
    }),
  };

  globalThis.Image = FakeImage;
  globalThis.document = {
    createElement: (tag) => (tag === "canvas" ? fakeCanvas : {}),
  };

  try {
    const res = await loadTerrainDetailNormalArray({ baseUrl: "http://localhost:8000" });
    check("loadTerrainDetailNormalArray returns result", res !== null);
    check("result has 5 keys", res.keys.length === 5);

    const tex = res.texture;
    check("texture format is THREE.RGFormat (RG8 packing)", tex.format === THREE.RGFormat);
    check("texture type is THREE.UnsignedByteType", tex.type === THREE.UnsignedByteType);

    const expectedLayerStride = testW * testH * 2; // 2 bytes per pixel, NOT 4
    const expectedTotalBytes = expectedLayerStride * 5;
    check("texture data length matches RG8 stride (w * h * 2 * 5)", tex.image.data.length === expectedTotalBytes, `bytes=${tex.image.data.length}, expected=${expectedTotalBytes}`);

    // Verify channel packing: R and G preserved from pixel 0
    const firstR = tex.image.data[0];
    const firstG = tex.image.data[1];
    check("first pixel R channel matches decoded R", firstR === (0 & 0xff));
    check("first pixel G channel matches decoded G", firstG === (0 & 0xff));

    const secondR = tex.image.data[2];
    const secondG = tex.image.data[3];
    check("second pixel R channel matches decoded R", secondR === (7 & 0xff));
    check("second pixel G channel matches decoded G", secondG === (13 & 0xff));

    tex.dispose();
  } finally {
    globalThis.Image = oldImage;
    globalThis.document = oldDocument;
  }
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
assert.equal(failed, 0, "All tests must pass");
