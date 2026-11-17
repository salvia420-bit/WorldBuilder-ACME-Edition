const h = window.__sessionHandle;
h.sendChat("@tele 41.35N 33.33E");
await new Promise(r => setTimeout(r, 12000));
h.setSkyTimeOverride(0.5);
const T = await import("three");
const { buildSemiTrailer } = await import("./scene3d/vehicle/trailer_models.js");
const s = window.liveScene3d;

// Clear old trailers
s.scene.children.filter(c => c.name.startsWith('semi-trailer')).forEach(c => s.scene.remove(c));

// Create trailers at camera position
const kinds = ['20ft', '40ft'];
kinds.forEach((kind, i) => {
  const tr = buildSemiTrailer(T, kind, { csmState: s.csmState, twistlockState: 1 });
  tr.root.position.set(32468 + i * 10, 34408, 10); // Correctly position near camera
  tr.root.traverse(child => { if (child.isMesh) child.visible = true; });
  s.scene.add(tr.root);
});

return { ok: true };
