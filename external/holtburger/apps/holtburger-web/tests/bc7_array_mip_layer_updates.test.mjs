// tests/bc7_array_mip_layer_updates.test.mjs
// Verification suite for Area 5: BC7 Array Texture PCIe Upload De-amplification.
//
// In Three.js r184 WebGLTextures.js:1068, texture.clearLayerUpdates() is invoked
// inside the mip loop at mip 0 (i === 0). For mip-chained compressed array textures,
// this leaves texture.layerUpdates empty for mip levels 1..N, causing mips 1..N to fall
// into the else branch and upload all image.depth layers across PCIe on every layer admit
// or atlas refeed (a 16x-64x bandwidth over-upload).
//
// makeBc7ArrayTexture defers clearLayerUpdates across the synchronous mip loop and flushes
// in arr.onUpdate (called by Three.js at the end of uploadTexture).

import * as THREE from "three";
import assert from "node:assert/strict";
import {
  makeBc7ArrayTexture,
  writeBc7ArrayLayer,
  bc7LevelBytes,
} from "../scene3d/bc7_textures.js";

// Helper: create a valid parsed HBC7 structure for testing writeBc7ArrayLayer
function makeMockHbc7(w, h, fillByte = 0x42) {
  const levels = [];
  let lw = w;
  let lh = h;
  while (true) {
    const bytes = bc7LevelBytes(lw, lh);
    const data = new Uint8Array(bytes);
    data.fill(fillByte);
    levels.push({ width: lw, height: lh, data });
    if (lw === 1 && lh === 1) break;
    lw = Math.max(1, lw >> 1);
    lh = Math.max(1, lh >> 1);
  }
  return { width: w, height: h, levels };
}

console.log("TEST: BC7 Array Texture Mip Layer Updates Deferral & PCIe De-amplification");

// 1. Structure & Properties
{
  const tex = makeBc7ArrayTexture(16, 16, 4, { mipChain: true, anisotropy: 8 });
  assert.equal(tex.isCompressedArrayTexture, true, "is CompressedArrayTexture");
  assert.equal(tex.image.width, 16, "width is 16");
  assert.equal(tex.image.height, 16, "height is 16");
  assert.equal(tex.image.depth, 4, "depth is 4");
  assert.equal(tex.mipmaps.length, 5, "16x16 has 5 mip levels (16, 8, 4, 2, 1)");
  assert.equal(tex.minFilter, THREE.LinearMipmapLinearFilter, "mipmapped minFilter");
  assert.equal(tex.anisotropy, 8, "anisotropy preserved");
  assert.equal(typeof tex.clearLayerUpdates, "function", "clearLayerUpdates exists");
  assert.equal(typeof tex.onUpdate, "function", "onUpdate hook installed");
  console.log("  ok - 1. Structure and mip chain allocation");
}

// 2. Layer update deferral across simulated Three.js r184 mip loop
{
  const tex = makeBc7ArrayTexture(16, 16, 8, { mipChain: true });
  tex.addLayerUpdate(2);

  assert.equal(tex.layerUpdates.has(2), true, "layer 2 is marked dirty");
  assert.equal(tex.layerUpdates.size, 1, "exactly 1 layer update marked");

  // Simulate Three.js r184 WebGLTextures uploadTexture mip loop:
  // for (let i = 0; i < mipmaps.length; i++) {
  //   if (texture.layerUpdates.size > 0) {
  //     // upload marked layers for level i
  //     texture.clearLayerUpdates();
  //   } else {
  //     // UPLOAD ALL DEPTH LAYERS (the r184 amplification defect!)
  //   }
  // }
  const uploadedPerLevel = [];
  for (let i = 0; i < tex.mipmaps.length; i++) {
    if (tex.layerUpdates.size > 0) {
      uploadedPerLevel.push([...tex.layerUpdates]);
      tex.clearLayerUpdates(); // Three.js calls this every iteration with dirty layers
    } else {
      uploadedPerLevel.push("ALL_LAYERS_AMPLIFIED");
    }
  }

  // With deferral, NO mip level fell back to ALL_LAYERS_AMPLIFIED
  for (let i = 0; i < tex.mipmaps.length; i++) {
    assert.deepEqual(
      uploadedPerLevel[i],
      [2],
      `level ${i} uploaded only marked layer 2, not all depth layers`,
    );
  }

  // Layer updates should still be deferred (pending flush in onUpdate)
  assert.equal(tex.layerUpdates.has(2), true, "layerUpdates retained across the mip loop");

  // Simulate Three.js reaching the end of uploadTexture:
  // if (texture.onUpdate) texture.onUpdate(texture);
  tex.onUpdate(tex);

  // Now layerUpdates must be flushed and cleared
  assert.equal(tex.layerUpdates.size, 0, "layerUpdates flushed and empty after onUpdate");
  console.log("  ok - 2. Mip loop deferral eliminates PCIe upload amplification");
}

// 3. Multiple layer updates across chain
{
  const tex = makeBc7ArrayTexture(32, 32, 16, { mipChain: true });
  tex.addLayerUpdate(1);
  tex.addLayerUpdate(5);
  tex.addLayerUpdate(12);

  assert.equal(tex.layerUpdates.size, 3, "3 layers marked dirty");

  for (let i = 0; i < tex.mipmaps.length; i++) {
    assert.equal(tex.layerUpdates.size, 3, `level ${i} sees all 3 dirty layers`);
    assert.equal(tex.layerUpdates.has(1), true);
    assert.equal(tex.layerUpdates.has(5), true);
    assert.equal(tex.layerUpdates.has(12), true);
    tex.clearLayerUpdates();
  }

  // End of upload
  tex.onUpdate(tex);
  assert.equal(tex.layerUpdates.size, 0, "all 3 layers cleared on onUpdate");
  console.log("  ok - 3. Multiple layer updates deferred and flushed simultaneously");
}

// 4. Custom onUpdate callback preservation and chaining
{
  let customCalls = 0;
  let receivedArg = null;
  const tex = makeBc7ArrayTexture(16, 16, 4, {
    mipChain: true,
    onUpdate: (t) => {
      customCalls++;
      receivedArg = t;
    },
  });

  tex.addLayerUpdate(0);
  tex.clearLayerUpdates(); // deferred

  tex.onUpdate(tex);
  assert.equal(customCalls, 1, "custom onUpdate called");
  assert.equal(receivedArg, tex, "received texture instance");
  assert.equal(tex.layerUpdates.size, 0, "layerUpdates cleared");

  // Re-assigning onUpdate preserves deferral logic via property getter/setter
  let secondCallbackRan = false;
  tex.onUpdate = (t) => {
    secondCallbackRan = true;
  };

  tex.addLayerUpdate(3);
  tex.clearLayerUpdates();
  tex.onUpdate(tex);

  assert.equal(secondCallbackRan, true, "second callback executed");
  assert.equal(tex.layerUpdates.size, 0, "layerUpdates cleared on subsequent onUpdate");
  console.log("  ok - 4. onUpdate chaining and assignment preserved");
}

// 5. Force-clear support for explicit manual clears
{
  const tex = makeBc7ArrayTexture(16, 16, 4, { mipChain: true });
  tex.addLayerUpdate(1);
  assert.equal(tex.layerUpdates.size, 1);

  // Force clear immediately
  tex.clearLayerUpdates(true);
  assert.equal(tex.layerUpdates.size, 0, "force clear immediately purges layerUpdates");
  console.log("  ok - 5. Explicit force-clear supported");
}

// 6. writeBc7ArrayLayer integration
{
  const tex = makeBc7ArrayTexture(16, 16, 4, { mipChain: true });
  const hbc7 = makeMockHbc7(16, 16, 0xaa);

  const writeOk = writeBc7ArrayLayer(tex, 2, hbc7);
  assert.equal(writeOk, true, "writeBc7ArrayLayer succeeded");
  assert.equal(tex.layerUpdates.has(2), true, "write marked layer 2 dirty");

  // Verify bytes written at level 0 and level 1
  const lvl0Bytes = bc7LevelBytes(16, 16);
  assert.equal(tex.mipmaps[0].data[2 * lvl0Bytes], 0xaa, "level 0 byte written");

  const lvl1Bytes = bc7LevelBytes(8, 8);
  assert.equal(tex.mipmaps[1].data[2 * lvl1Bytes], 0xaa, "level 1 byte written");

  // Simulate upload
  for (let i = 0; i < tex.mipmaps.length; i++) {
    assert.equal(tex.layerUpdates.has(2), true, `level ${i} has layer update`);
    tex.clearLayerUpdates();
  }
  tex.onUpdate(tex);
  assert.equal(tex.layerUpdates.size, 0, "flushed after write upload");
  console.log("  ok - 6. writeBc7ArrayLayer integration with mip-chain write");
}

// 7. Single mip level (level-0-only flat array)
{
  const flat = makeBc7ArrayTexture(16, 16, 4, { mipChain: false });
  assert.equal(flat.mipmaps.length, 1, "1 mip level");
  flat.addLayerUpdate(0);
  flat.clearLayerUpdates();
  assert.equal(flat.layerUpdates.has(0), true, "deferred on flat array");
  flat.onUpdate(flat);
  assert.equal(flat.layerUpdates.size, 0, "cleared on onUpdate for flat array");
  console.log("  ok - 7. Level-0-only flat array operates consistently");
}

console.log("BC7 Array Mip Layer Updates: ALL 7 TEST SUITES PASSED.");
