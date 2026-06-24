// scene3d/vfx/particle_sprites.js — Phase 3 (P3.2) shared billboard sprite palette.
//
// A name→hwGfxObjId map of EXISTING retail DAT particle sprite gfxobjs that a
// synthesized `emitterInfo` POJO names in its `hwGfxObjId` field (see
// scene3d/particles/particle_emitter_info.js:54-109). The geometry/material
// factories (entities.js:9019-9074 → materialCache.getParticleUnlit) fetch the
// sprite gfxobj's mesh + surface with ZERO wasm rebuild — Phase 3 SYNTHESIZES
// emitters, it does not author new sprites and does not replay DAT 0x32.
//
// BLEND IS NOT CHOSEN HERE. particle_manager.js:553-601 decides additive-vs-alpha
// from the sprite gfxobj's Surface bitfield (`surfaceTypeFlags & 0x10000`,
// materials.js:65 SURFACE_TYPE.Additive). So this palette can freely mix additive
// glow sprites and alpha smoke/leaf sprites; each renders with the correct blend
// automatically. The `blend` field below is the GROUND-TRUTH surface decode, not
// a request — it documents what the pipeline will pick.
//
// PROVENANCE — every id below was read from the retail portal DAT
// (client_portal.dat) on 2026-06-24 by the P3.2 sprite probe
// (artifacts/03-dat-sprites/probe/, DatReaderWriter). For each: the 0x32 emitter
// that references it, its GfxObj→Surface chain, the Surface `type` bitfield (hex),
// and a PNG eyeball of the RenderSurface. Cross-checked against WB.Terminal
// `asset-refs` + `surface-fingerprint` (two independent DAT readers agree). NONE
// of these resolves to a null surface → NO white-box risk (particle_manager.js:23-46).
//
// surface_type bit reference: Base1Solid 0x1 · Base1Image 0x2 · Base1ClipMap 0x4
//                             · Alpha 0x100 · Additive 0x10000

/** name → hwGfxObjId (the 0x01xxxxxx sprite GfxObj the emitter POJO renders). */
export const PARTICLE_SPRITES = Object.freeze({
  // ── ADDITIVE GLOW family (surface_type 0x10102 = Base1Image|Alpha|Additive, luminosity 1) ──
  softGlowDot: 0x01001062,   // round soft blue-white radial glow — THE soft-dot
  sparkleStar: 0x010010F9,   // white 4-point twinkle star — gem-sparkle PRIMARY
  flameCore:   0x01000FF4,   // warm-orange fire blob — most-used additive sprite in retail (brazier embers)
  ember:       0x0100168C,   // small, short-life additive mote — spark/ember
  glowPlume:   0x010011BF,   // additive halo that scales up large — bloom / soft glow swell
  moonStarBlue:  0x01001A61, // blue ambient star glint (moon emitter 0x32000455)
  moonStarGreen: 0x01001A62, // green ambient star glint (moon emitter 0x32000456)

  // ── ALPHA family (surface_type 0x102 = Base1Image|Alpha — pipeline auto-picks alpha blend) ──
  smokePuff:   0x010016BE,   // soft grey cloud puff — canonical smoke
  smokeDark:   0x01000FBF,   // dark smoke puff — Track-B flame's paired smoke (emitter 0x32000270)

  // ── ADDITIVE droplet (downward) ──
  dropletGlow: 0x010028B3,   // additive teardrop, falls — drip/droplet (LOW confidence, see meta)

  // ── CLIPMAP-ALPHA family (surface_type 0x104 = Base1ClipMap|Alpha — alphaTest cutout) ──
  leafMote:    0x010014D7,   // green foliage mote, lateral flutter+fall — leaf (MED confidence)
  snowflake:   0x0100112F,   // white snowflake cutout — weather/frost (bonus, confirmed)
});

/**
 * Per-sprite ground-truth metadata read from the DAT. Intended for tests /
 * the cost-model / anchor docs — NOT consumed by the emitter POJO (which only
 * needs the hwGfxObjId). `surfaceType` is the raw Surface.type bitfield.
 * `blend` is what particle_manager.js:553-601 will select from that bitfield.
 */
export const PARTICLE_SPRITE_META = Object.freeze({
  softGlowDot:   { hwGfxObjId: 0x01001062, surface: 0x080002E9, surfaceType: 0x10102, blend: "additive", tex: 0x0500135A, renderSurface: 0x06003BE5, verts: 4, users: 44, sourceEmitter: null,       visual: "round soft blue-white radial glow" },
  sparkleStar:   { hwGfxObjId: 0x010010F9, surface: 0x080002F0, surfaceType: 0x10102, blend: "additive", tex: 0x0500131E, renderSurface: 0x06003BEC, verts: 4, users: 52, sourceEmitter: null,       visual: "white 4-point twinkle star" },
  flameCore:     { hwGfxObjId: 0x01000FF4, surface: 0x08000041, surfaceType: 0x10102, blend: "additive", tex: 0x0500171A, renderSurface: 0x060037CC, verts: 4, users: 93, sourceEmitter: 0x3200026E, visual: "warm-orange fire blob (Track-B 3D weapon flame core)" },
  ember:         { hwGfxObjId: 0x0100168C, surface: 0x08000163, surfaceType: 0x10102, blend: "additive", tex: 0x050016C4, renderSurface: null,       verts: 4, users: 14, sourceEmitter: null,       visual: "small short-life additive mote (life 0.6s)" },
  glowPlume:     { hwGfxObjId: 0x010011BF, surface: 0x08000072, surfaceType: 0x10102, blend: "additive", tex: 0x0500126C, renderSurface: null,       verts: 4, users:  1, sourceEmitter: 0x32000271, visual: "additive halo, scale 0.3→10 swell" },
  moonStarBlue:  { hwGfxObjId: 0x01001A61, surface: 0x0800003F, surfaceType: 0x10102, blend: "additive", tex: 0x0500172F, renderSurface: 0x060037CA, verts: 4, users:  1, sourceEmitter: 0x32000455, visual: "blue soft star glint" },
  moonStarGreen: { hwGfxObjId: 0x01001A62, surface: 0x08000040, surfaceType: 0x10102, blend: "additive", tex: 0x0500172A, renderSurface: 0x060037CB, verts: 4, users:  1, sourceEmitter: 0x32000456, visual: "green soft star glint" },
  smokePuff:     { hwGfxObjId: 0x010016BE, surface: 0x08000326, surfaceType: 0x00102, blend: "alpha",    tex: 0x050016E5, renderSurface: 0x06003C21, verts: 4, users: 30, sourceEmitter: null,       visual: "soft grey cloud puff (grows 0.7→1.6)" },
  smokeDark:     { hwGfxObjId: 0x01000FBF, surface: 0x080000E6, surfaceType: 0x00102, blend: "alpha",    tex: 0x0500126A, renderSurface: 0x060038AF, verts: 4, users: 48, sourceEmitter: 0x32000270, visual: "dark smoke puff (Track-B flame smoke)" },
  dropletGlow:   { hwGfxObjId: 0x010028B3, surface: 0x08000E39, surfaceType: 0x10102, blend: "additive", tex: 0x05001E8E, renderSurface: null,       verts: 4, users:  4, sourceEmitter: null,       visual: "additive teardrop, falls (az -0.38)", confidence: "low" },
  leafMote:      { hwGfxObjId: 0x010014D7, surface: 0x08000C66, surfaceType: 0x00104, blend: "alpha-clipmap", tex: 0x05001475, renderSurface: 0x06004DE5, verts: 3, users: 9, sourceEmitter: null, visual: "green foliage mote, lateral flutter+fall", confidence: "med" },
  snowflake:     { hwGfxObjId: 0x0100112F, surface: 0x08000312, surfaceType: 0x00104, blend: "alpha-clipmap", tex: 0x05001330, renderSurface: 0x06003C0E, verts: 4, users: 22, sourceEmitter: null, visual: "white snowflake cutout" },
});

/**
 * Recommended sprite for the FIRST vertical slice `particle.gemSparkle`
 * (P3.3). A persistent additive twinkle. `sparkleStar` reads as a gem glint;
 * pair with `softGlowDot` as a soft halo for the 2–4 sprite spread.
 */
export const GEM_SPARKLE_SOFT_DOT = PARTICLE_SPRITES.sparkleStar;   // 0x010010F9
export const GEM_SPARKLE_HALO     = PARTICLE_SPRITES.softGlowDot;   // 0x01001062
