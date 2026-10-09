// scene3d/particles/render_layer.js — which render layer an emitter attached
// to a server ENTITY draws on (2026-10-09). Leaf module: no imports.
//
// Entities draw on the INDOOR layer (1): index.js stamps `entitiesGroup` and
// every entity root with it, so in the indoor depth split (`?indoorDepthSplit`,
// armed in any EnvCell: world pass on layer 0 → full depth wipe → cells pass
// on layer 1) and in the outdoor `?portalPunch` pass they composite with the
// interior. Their particle meshes did not inherit that layer (a three.js layer
// mask is per object), so they stayed on layer 0 and the cells pass painted
// the dungeon over them: in the Town Network every portal swirl was hidden
// behind its alcove, and every NPC/item effect indoors vanished the same way
// (1070, 2026-10-09). Emitters anchored to an entity now ride the entity's
// layer. Static chains choose their own layer in statics.js.
//
// `?indoorParticleLayer=off` (the existing escape for the static interior
// chains) also keeps entity particles on layer 0.

/** The INDOOR render layer (index.js / cells.js `RENDER_LAYER_INDOOR`). */
export const RENDER_LAYER_INDOOR = 1;

export function indoorParticleLayerEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    return new URLSearchParams(s).get("indoorParticleLayer")?.toLowerCase() !== "off";
  } catch (_) {
    return true;
  }
}

/** `renderLayer` for `ParticleManager.addEmitter` when the parent is an entity. */
export function entityParticleRenderLayer(search) {
  return indoorParticleLayerEnabled(search) ? RENDER_LAYER_INDOOR : 0;
}
