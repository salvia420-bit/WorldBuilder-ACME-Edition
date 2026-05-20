// Phase 7.1 — terrain heightfield + bilinear-blend shader.
//
// Ports the GLSL ES 3.00 shader pair from `index.html:975-1082` to a
// `THREE.ShaderMaterial`. The 2D path uses PIXI v8's MeshPipe shader
// chain (`uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix`,
// `vColor` modulation, `aPosition` as vec2) — three.js injects its own
// `projectionMatrix` + `modelViewMatrix` + `position` (vec3) so we
// drop the PIXI plumbing and keep the bilinear-blend body byte-for-
// byte identical, which is what the visual output depends on.
//
// Builds one heightfield Mesh per landblock (Holtburg 9-LB ring), each
// with vertex Z = real terrain height in metres (range [0, 510]). The
// 2D `buildLandblockChildren` path (`index.html:2071-2199`) flattens to
// 2D positions before upload; we keep the third dimension and rely on
// `computeVertexNormals()` (called inside `landblockMeshToGeometry`)
// to set up Lambert sun lighting for Phase 7.6.
//
// Roads are painted inside the terrain shader (uRoadEnabled block
// below) — bilinear-blend on the per-vertex road flag from
// uVertexTypes.G, gated by smoothstep(0.85, 0.95) for a ~5 m band
// matching retail's _road_width (acclient.c:467318). The prior
// triangle-strip overlay mesh is gone.

import * as THREE from "three";
import {
  landblockMeshToGeometry,
  subdividedLandblockMeshToGeometry,
  buildVertexTypesDataTexture,
  buildTerrainAtlasArrayBytes,
} from "./adapter.js";

// ----- AC world-coord constants -------------------------------------
const METERS_PER_LANDBLOCK = 192.0;
const HOLTBURG_X = 0xa9;
const HOLTBURG_Y = 0xb4;

// ----- Phase 1.2 — terrain detail normal mapping --------------------
//
// Region 0x13 ("Dereth") publishes 32 terrain types via `TerrainDesc`.
// Names come from `get-region` against the retail portal.dat. Each code
// maps to one of 5 detail-normal slices (grass / dirt / sand / stone /
// snow) or to the sentinel UNKNOWN (255) for water + swamp + slime,
// which we render flat at the detail layer.
//
// Slice ordering matches `TERRAIN_DETAIL_KEYS` in adapter.js:
//   0 grass | 1 dirt | 2 sand | 3 stone | 4 snow
//
// Verified against Holtburg LB 0xA9B4 (`get-terrain-layers`):
//   3 LushGrass (42%), 1 Grassland (22%), 14 SemiBarrenRock (22%),
//   9 PatchyGrassland (14%) — all map to grass/stone, exercises the
//   blend correctly.
const DETAIL_SLICE_GRASS = 0;
const DETAIL_SLICE_DIRT = 1;
const DETAIL_SLICE_SAND = 2;
const DETAIL_SLICE_STONE = 3;
const DETAIL_SLICE_SNOW = 4;
const DETAIL_SLICE_NONE = 255;

// Indexed by terrain code 0..31. UNKNOWN codes (water, swamp, slime,
// faux-water) get NONE; the shader branches and skips sampling.
const TERRAIN_CODE_TO_DETAIL_SLICE = new Uint8Array([
  /*  0 BarrenRock         */ DETAIL_SLICE_STONE,
  /*  1 Grassland          */ DETAIL_SLICE_GRASS,
  /*  2 Ice                */ DETAIL_SLICE_SNOW,
  /*  3 LushGrass          */ DETAIL_SLICE_GRASS,
  /*  4 MarshSparseSwamp   */ DETAIL_SLICE_NONE,
  /*  5 MudRichDirt        */ DETAIL_SLICE_DIRT,
  /*  6 ObsidianPlain      */ DETAIL_SLICE_STONE,
  /*  7 PackedDirt         */ DETAIL_SLICE_DIRT,
  /*  8 PatchyDirt         */ DETAIL_SLICE_DIRT,
  /*  9 PatchyGrassland    */ DETAIL_SLICE_GRASS,
  /* 10 sand-yellow        */ DETAIL_SLICE_SAND,
  /* 11 sand-grey          */ DETAIL_SLICE_SAND,
  /* 12 sand-rockStrewn    */ DETAIL_SLICE_SAND,
  /* 13 SedimentaryRock    */ DETAIL_SLICE_STONE,
  /* 14 SemiBarrenRock     */ DETAIL_SLICE_STONE,
  /* 15 Snow               */ DETAIL_SLICE_SNOW,
  /* 16 WaterRunning       */ DETAIL_SLICE_NONE,
  /* 17 WaterStandingFresh */ DETAIL_SLICE_NONE,
  /* 18 WaterShallowSea    */ DETAIL_SLICE_NONE,
  /* 19 WaterShallowStillSea*/ DETAIL_SLICE_NONE,
  /* 20 WaterDeepSea       */ DETAIL_SLICE_NONE,
  /* 21 forestfloor        */ DETAIL_SLICE_GRASS,
  /* 22 FauxWaterRunning   */ DETAIL_SLICE_NONE,
  /* 23 SeaSlime           */ DETAIL_SLICE_NONE,
  /* 24 Argila             */ DETAIL_SLICE_DIRT,
  /* 25 Volcano1           */ DETAIL_SLICE_STONE,
  /* 26 Volcano2           */ DETAIL_SLICE_STONE,
  /* 27 BlueIce            */ DETAIL_SLICE_SNOW,
  /* 28 Moss               */ DETAIL_SLICE_GRASS,
  /* 29 DarkMoss           */ DETAIL_SLICE_GRASS,
  /* 30 olthoi             */ DETAIL_SLICE_STONE,
  /* 31 DesolateLands      */ DETAIL_SLICE_DIRT,
]);

// Detail-normal UV scale (tile repeats per landblock metre). The terrain
// is a 192 m landblock with `vGridUv = position.xy / 24` (range [0, 8]).
// uDetailScale of 16 → 8 * 16 = 128 detail-tile repeats per 192 m LB,
// or one detail tile per ~1.5 m. Reads as sub-character-scale at eye
// height.
const DEFAULT_DETAIL_SCALE = 16.0;

// ----- Phase 1.3 — triplanar mapping on terrain slopes --------------
//
// Slope is computed in AC-space (Z-up): `slope = 1.0 - normal.z`.
// Below the LO slope threshold, pure grid-UV sampling. Above
// `TRIPLANAR_SLOPE_HI`, pure triplanar. Between, `smoothstep` lerp.
// HI=0.5 ≈ 30° (point at which UV stretching becomes objectionable).
// LO was 0.2 ≈ 11° from horizontal; Perf D3 moves the LO end into the
// quality preset (`triplanarSlopeThresholdPct`, 0..100 → 0.0..1.0) so
// `mid` can raise it to 0.6 (steep cliffs only) and `high`/`ultra`
// keep the 0.3 audit value.
//
// Triplanar sharpness 6.0 is the centre of the 4-8 sweet spot per the
// hand-off note. Lower values produce muddy blends; higher values
// produce hard seams at 45°.
const TRIPLANAR_SLOPE_HI = 0.5;
const DEFAULT_TRIPLANAR_SHARPNESS = 6.0;

// ----- Phase 2.2 — animated vertex displacement (water + lava) -----
//
// Per-vertex Y-axis (AC Z-axis) displacement driven by `uTime` in the
// vertex shader. Branches on `vTerrainCode` (provoking-vertex code from
// the Phase 1.2 per-vertex attribute).
//
// Codes for Region 0x13 ("Dereth") from the terrain code table in this
// file:
//   water: 16, 17, 18, 19, 20, 22, 23
//   lava:  none — retail Holtburg has no lava terrain (lava is in
//          dungeons via SetupModel floors, not landblock terrain).
//          A region-aware extension would add lava codes for the
//          Volcanic Hills region, etc. The lava branch is present but
//          inactive (no codes match).
//
// Total amplitude ≤ 0.4 m per plan §4 constraint #3 — small enough that
// the player never feels they're walking through visible ridges. Water
// uses two sines summed (~0.25 m envelope); lava (future) would use
// 2D value-noise at 0.4 m.
//
// Quality gate: only installed when `liveScene3d.quality.flags.subdivLevel
// >= 2`. At subdivLevel=1, terrain verts are 24 m apart — the wavelength
// would be larger than the screen and the wave would be invisible.
const TERRAIN_WATER_CODES = new Set([16, 17, 18, 19, 20, 22, 23]);
// Region 0x13 lava codes: none (see comment above). Future region-aware
// extension would populate this for, e.g., Volcanic Hills.
const TERRAIN_LAVA_CODES = new Set([]);

// ----- GLSL — bilinear-blend shader, three.js port ------------------
//
// Vertex shader: drops the PIXI mat3 chain in favour of three.js's
// auto-injected `projectionMatrix` + `modelViewMatrix` + `position`
// (vec3) builtins. The per-fragment `vGridUv = position.xy / 24.0`
// matches the 2D path: position.xy is in LB-local metres (0..192,
// 24 m vertex spacing), so dividing by 24 yields a [0, 8] grid coord
// the fragment shader uses to bilinear-blend.
//
// Vertex Z (height) ends up in clip-space via the same
// `projectionMatrix * modelViewMatrix * vec4(position, 1.0)` chain;
// the fragment shader is height-agnostic — it samples by xy only —
// which is correct because terrain types are 2D footprints, not 3D.
const TERRAIN_VERTEX_GLSL = `
precision highp float;

in float terrainCode;                 // Phase 1.2 — per-vertex (uint8→float)

uniform float uTime;                  // Phase 2.2 — shared wall-clock seconds
uniform int uWaterCodeMask;           // Phase 2.2 — bitmask of water terrain codes (bit i = code i)
uniform int uLavaCodeMask;            // Phase 2.2 — bitmask of lava terrain codes (Region 0x13 = 0)
uniform float uDisplacementEnabled;   // Phase 2.2 — 0.0 OFF / 1.0 ON (quality gate; off when subdivLevel < 2)
uniform vec2 uLbOriginXy;             // Phase 2.2 — per-LB world-frame origin (lbX*192, lbY*192); ensures wave-phase continuity across LB seams

out vec2 vGridUv;
out vec3 vWorldPos;  // Clouds-L: terrain world-space position for cloud-shadow projection
out float vViewDepth; // CSM-on-terrain: view-space depth (positive = in front of camera) for cascade selection
flat out int vTerrainCode;            // Phase 1.2 — passed flat-int to FS
// Phase 1.3 — AC-space LB-local position + interpolated geometry
// normal, used by the fragment shader for slope-gated triplanar
// sampling. Both are in AC coords (Z-up); the worldRoot Y-up rotation
// is applied to a parent transform that we deliberately bypass here
// so the existing 'vGridUv = position.xy / 24.0' semantics extend
// naturally to YZ + XZ planes.
out vec3 vAcPos;
out vec3 vAcNormal;
// Phase 2.2 — 1.0 if the vertex is water, 0.0 otherwise. The fragment
// shader uses this to decide whether to apply UV scroll + tint shift.
// Flat-interpolated alongside vTerrainCode so the fragment sees the
// same provoking-vertex classification.
flat out int vIsWater;
// Perf D1 — vertex-side fold of the two water-modulation sines that
// the fragment shader used to evaluate per-pixel.
//   .x = sin(uTime * 0.3)                       -- water tint breath (constant per draw)
//   .y = sin(uTime * 0.5 + worldXy.x * 0.1)     -- one term of the displacement wave
// Per-vertex linear interpolation across a 24 m cell is visually
// indistinguishable from per-pixel evaluation at these slow
// frequencies (worldXy.x advances by 0.1 rad per 1 m, so a 24 m cell
// spans ~2.4 rad; the curve is still smooth enough that linear
// interpolation across the cell looks identical to a half-pixel eye).
out vec2 vWaveModulation;

// Phase 2.2 — 2D value-noise (Perlin-fade interp). Tiny port from
// Phase 2.1's Rust impl at terrain_subdiv.rs::value_noise_2d. Reserved
// for the lava displacement branch (Region 0x13 has no lava terrain
// codes — branch never executes for retail Holtburg).
float fade(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float hash21(vec2 p) {
  // Cheap deterministic hash — same period as the Rust impl. Stable
  // across LB seams because input is world-frame AC coords.
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float valueNoise2D(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  float u = fade(f.x);
  float v = fade(f.y);
  return mix(mix(a, b, u), mix(c, d, u), v) * 2.0 - 1.0;
}

void main() {
  vec3 displacedPos = position;
  int code = int(terrainCode + 0.5);
  int isWater = 0;
  // World-frame XY = per-LB origin + LB-local position. Hoisted out of
  // the displacement gate so Perf D1's vWaveModulation can read it
  // unconditionally below.
  vec2 worldXy = uLbOriginXy + position.xy;
  // Perf D1 — compute both sine modulations at vertex rate (once per
  // vertex instead of once per fragment). See varying declaration
  // above for the rationale on interpolation fidelity.
  float waveModX = sin(uTime * 0.3);
  float waveModY = sin(uTime * 0.5 + worldXy.x * 0.1);
  vWaveModulation = vec2(waveModX, waveModY);
  // Phase 2.2 — quality-gated time-varying displacement on water + lava
  // terrain. uDisplacementEnabled is 0.0 when subdivLevel < 2 (the
  // vertices are 24 m apart at level 1 and the wave wavelength would
  // exceed the screen). The bitmask lookups are 32-bit shifts; both
  // masks are constructed JS-side from the TERRAIN_WATER_CODES /
  // TERRAIN_LAVA_CODES sets so the GLSL stays free of per-code if/elif
  // chains.
  if (uDisplacementEnabled > 0.5 && code >= 0 && code < 32) {
    int bit = 1 << code;
    if ((uWaterCodeMask & bit) != 0) {
      // Two-wavelet sine sum at different frequencies + phases. Total
      // envelope ~0.25 m, well under the 0.4 m plan-doc cap. waveModY
      // reuses Perf D1's vertex-rate sine for the first wavelet so we
      // do not pay for the same evaluation twice on this vertex.
      float wave = waveModY * 0.15
                 + sin(uTime * 0.7 + worldXy.y * 0.13) * 0.10;
      displacedPos.z += wave;
      isWater = 1;
    } else if ((uLavaCodeMask & bit) != 0) {
      // Slow chunky 2D value-noise — 0.4 m max amplitude. Inactive for
      // Region 0x13 (no lava codes in the mask); kept here for forward
      // compat with region-aware extensions.
      float n = valueNoise2D(worldXy * 0.05 + vec2(uTime * 0.2, 0.0));
      displacedPos.z += n * 0.4;
    }
  }
  vIsWater = isWater;

  vWorldPos = (modelMatrix * vec4(displacedPos, 1.0)).xyz;
  vec4 mvPos = modelViewMatrix * vec4(displacedPos, 1.0);
  vViewDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
  // Per-vertex grid coordinate in [0, 8] across the 192 m landblock
  // (8 cells × 24 m each). Fragment splits into integer cell index
  // + intra-cell UV, looks up the cell's 4 corner terrain types
  // from uVertexTypes, samples uAtlas at each corner, and blends by
  // bilinear weights.
  vGridUv = position.xy / 24.0;
  // Pass terrain code as a flat int for the Phase 1.2 detail-normal
  // slice lookup. Flat interpolation means every fragment of a
  // triangle sees the provoking vertex's code — three corners may
  // disagree but we deliberately pick one per triangle rather than
  // blending (terrain codes are discrete categories).
  vTerrainCode = code;
  // vAcPos passes the UNDISPLACED position so the Phase 1.3 triplanar
  // sampler reads consistent values across frames (displacement is
  // visual-only; collision math + detail-normal projections stay
  // anchored to the bilinear-on-control 24 m surface).
  vAcPos = position;
  vAcNormal = normal;
}
`;

// Fragment shader: ported verbatim from `index.html:1006-1082` minus
// the PIXI-specific `vColor` varying + uColor/uWorldColorAlpha
// modulation. The bilinear-blend body is byte-identical to the 2D
// path — same texelFetch lookup, same atlasUvFor mapping, same 4-
// corner weights — so visual output should match the 2D bilinear
// reference once the camera converges (Phase 7.5+ camera work).
const TERRAIN_FRAGMENT_GLSL = `
precision highp float;
precision highp int;
precision highp sampler2DArray;

uniform sampler2DArray uAtlas;        // 33 layers of 256×256 retail terrain tiles, one per code (0..32). ClampToEdge per layer eliminates the cross-tile bleed that the prior 6×6 packed atlas produced at mip levels ≥3 (the "not flush with vertices" artefact: gutter-less neighbours bled into each other along cell vertex lines).
uniform sampler2D uVertexTypes;       // 9×9 RGBA8: R = terrain code, G = roadCode*64, A = 255
uniform sampler2D uRoadTexture;       // retail road tile (RepeatWrap)
uniform float uRoadTileScale;         // road UV tile rate per LB unit
uniform float uRoadEnabled;           // 0 = no road overlay (back-compat / disable)

// Phase 1.2 — detail-normal array. 5 RGB normal maps (slice order:
// 0 grass | 1 dirt | 2 sand | 3 stone | 4 snow). The shader looks up
// the slice for the provoking vertex's terrain code from uCodeToSlice[]
// then samples uTerrainDetailNormalArray at vGridUv * uDetailScale.
uniform sampler2DArray uTerrainDetailNormalArray;
uniform int uCodeToSlice[32];         // terrain-code → slice (255 = no detail)
uniform float uDetailScale;
uniform vec2 uWindDir;                // unit vec2 (cos, sin) — sand UV rotation
uniform float uDetailNormalEnabled;   // 0.0 OFF / 1.0 ON (quality gate)
// Phase 1.3 — slope-gated triplanar sampling of the detail normal.
// uTriplanarEnabled gates the whole block off when quality is low;
// uTriplanarSharpness is the power applied to abs(normal) before
// normalising the blend weights (4-8 is the sweet spot — see
// DEFAULT_TRIPLANAR_SHARPNESS comment on the JS side).
uniform float uTriplanarEnabled;
uniform float uTriplanarSharpness;
// Perf D3 — slope threshold (LO end of the smoothstep). Driven by the
// quality preset's triplanarSlopeThresholdPct (0..100 -> 0.0..1.0).
// low/100 effectively keeps triBlend at 0; mid/60 restricts triplanar
// to the steepest cliffs; high+ultra/30 matches the legacy 0.3 gate.
// HI end remains the JS constant TRIPLANAR_SLOPE_HI baked into the
// shader source — only the LO end varies per quality.
uniform float uTriplanarSlopeLo;
// Phase 2.2 — shared wall-clock seconds + water flag for UV scroll +
// tint modulation. uDisplacementEnabled gates both effects so they
// stay quiet at subdivLevel=1 (matches the vertex-shader gate).
uniform float uTime;
uniform float uDisplacementEnabled;

// Clouds-L — sample the cloud effect's cascade-0 shadow buffer to dim
// terrain ambient + diffuse where clouds occlude the sun. takram's
// cloud raymarch already produces these as a side effect of its
// self-shadowing pass; we piggyback rather than running a second
// raymarch. uCloudShadowEnabled gates the whole block off when no
// CloudOverlay is wired (e.g. ?clouds=off).
uniform float uCloudShadowEnabled;
uniform sampler2DArray uCloudShadowMap;
uniform mat4 uCloudShadowMatrix0;
uniform float uCloudShadowStrength;

// AC-z-up unit direction TO the sun. Pushed each frame from
// loop.js (tickTerrainSunDir) off the same SkyState the rest of the
// sky stack reads. Default literal kept for the no-state fallback
// (pre-populator) so terrain is never lit from (0,0,0).
uniform vec3 uSunDir;

// CSM-on-terrain. Mirror of materials.js's MeshStandardMaterial patch
// at materials.js:267-445. Three cascade shadow maps, view-space-depth
// selection, blend zones at boundaries. uCsmEnabled gates the whole
// block off so terrain renders correctly when ?shadows=off or quality
// preset has csm:false. Uniforms refreshed each frame by
// csm.refreshCsmUniforms (registered alongside other materialCache
// patched materials in terrain bake).
uniform float uCsmEnabled;
uniform sampler2D uCsmShadowMap0;
uniform sampler2D uCsmShadowMap1;
uniform sampler2D uCsmShadowMap2;
uniform mat4 uCsmMatrix0;
uniform mat4 uCsmMatrix1;
uniform mat4 uCsmMatrix2;
uniform vec2 uCsmSplits;
uniform float uCsmFar;
uniform float uCsmBlend;

float csmSampleCascade(sampler2D sm, mat4 m, vec3 worldPos) {
  vec4 sc = m * vec4(worldPos, 1.0);
  sc.xyz /= max(sc.w, 1e-6);
  if (sc.x < 0.0 || sc.x > 1.0 ||
      sc.y < 0.0 || sc.y > 1.0 ||
      sc.z > 1.0) {
    return 1.0;
  }
  float bias = 0.0005;
  float ref = sc.z - bias;
  float stored = texture(sm, sc.xy).r;
  return stored < ref ? 0.0 : 1.0;
}

float csmShadowFactor(vec3 worldPos, float viewDepth) {
  float blendW0 = uCsmSplits.x * uCsmBlend;
  float blendW1 = uCsmSplits.y * uCsmBlend;
  if (viewDepth > uCsmFar) return 1.0;
  if (viewDepth < uCsmSplits.x - blendW0) {
    return csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
  }
  if (viewDepth < uCsmSplits.x) {
    float s0 = csmSampleCascade(uCsmShadowMap0, uCsmMatrix0, worldPos);
    float s1 = csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float t = (viewDepth - (uCsmSplits.x - blendW0)) / blendW0;
    return mix(s0, s1, clamp(t, 0.0, 1.0));
  }
  if (viewDepth < uCsmSplits.y - blendW1) {
    return csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
  }
  if (viewDepth < uCsmSplits.y) {
    float s1 = csmSampleCascade(uCsmShadowMap1, uCsmMatrix1, worldPos);
    float s2 = csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
    float t = (viewDepth - (uCsmSplits.y - blendW1)) / blendW1;
    return mix(s1, s2, clamp(t, 0.0, 1.0));
  }
  return csmSampleCascade(uCsmShadowMap2, uCsmMatrix2, worldPos);
}

in vec2 vGridUv;
in vec3 vWorldPos;
in float vViewDepth;                  // CSM-on-terrain: view-space depth for cascade selection
flat in int vTerrainCode;             // provoking-vertex terrain code
in vec3 vAcPos;                       // Phase 1.3 — LB-local AC pos (z=up)
in vec3 vAcNormal;                    // Phase 1.3 — geometry normal (AC z-up)
flat in int vIsWater;                 // Phase 2.2 — 1 if water, 0 otherwise
// Perf D1 — water-modulation sines folded to vertex rate.
//   .x = sin(uTime * 0.3)   tint breath (constant per draw, so this is
//                           literally the same value at every vertex
//                           and survives linear interpolation exactly)
//   .y = sin(uTime * 0.5 + worldXy.x * 0.1) -- the displacement wave
//                           term that the vertex shader already needs;
//                           re-exported here so the tint path can read
//                           it without re-evaluating sin() per pixel.
in vec2 vWaveModulation;

out vec4 fragColor;

// Map terrain code (0..32) -> atlas UV at the given cell-local UV.
// Retail terrain codes 0..32 are individual layers of a sampler2DArray.
// cellUv (range [0,1]) is the intra-cell UV; the layer index is the
// code itself -- DataArrayTexture clamps integer layer selection so no
// neighbour-tile bleed at any mip level.
vec3 atlasUvFor(int code, vec2 cellUv) {
  return vec3(cellUv, float(code));
}

// 2D hash to a pseudo-random offset in [0,1).
vec2 hash2(vec2 p) {
  return fract(sin(vec2(
    dot(p, vec2(127.1, 311.7)),
    dot(p, vec2(269.5, 183.3))
  )) * 43758.5453);
}

// Triangle-lattice cell decomposition (Heitz & Neyret 2018, "Procedural
// Stochastic Textures by Tiling and Blending"). Skew UV into a
// rhombic grid, find which of the two triangles in the rhombus the
// fragment falls into, return the three triangle vertex IDs + their
// barycentric weights. The skew matrix maps a 60-degree triangle
// lattice onto integer coordinates so floor()/fract() can pick the
// containing cell trivially.
void triangleGrid(vec2 uv,
                  out vec2 v1, out vec2 v2, out vec2 v3,
                  out float w1, out float w2, out float w3) {
  const mat2 toSkewed = mat2(1.0, 0.0, -0.57735026, 1.15470054);
  vec2 sk = toSkewed * uv;
  vec2 i = floor(sk);
  vec2 f = fract(sk);
  if (f.x + f.y < 1.0) {
    v1 = i;                  w1 = 1.0 - f.x - f.y;
    v2 = i + vec2(1.0, 0.0); w2 = f.x;
    v3 = i + vec2(0.0, 1.0); w3 = f.y;
  } else {
    v1 = i + vec2(1.0, 1.0); w1 = f.x + f.y - 1.0;
    v2 = i + vec2(1.0, 0.0); w2 = 1.0 - f.y;
    v3 = i + vec2(0.0, 1.0); w3 = 1.0 - f.x;
  }
}

// Heitz tile-and-blend sample of a sampler2DArray layer. Samples the
// tile at 3 hashed offsets and blends them by triangle barycentrics,
// then variance-corrects the deviation around the local 3-sample mean
// to recover the contrast a naive weighted blend loses at triangle
// centres (sqrt(w1*w1+w2*w2+w3*w3) -> sqrt(1/3) ~= 0.577x = muddy
// "fog" appearance). Picks ~95% of the Heitz reference contrast with
// no precomputed CDF / histogram bake.
//
// textureGrad samples all 3 offsets at the same un-offset gradient so
// mip selection stays continuous across hex boundaries; without this,
// the discontinuous hashed offsets would push neighbouring fragments
// to different mips and the blend would flicker along hex edges.
//
// Tile rate (4.0) controls how many hexagons fit in one cellUv. At
// the 24 m cell scale this gives ~6 m patches: small enough to fully
// hide the underlying 256x256 tile repeat, large enough that the
// 3-sample cost is amortised.
vec3 heitzSample(int code, vec2 uv) {
  vec2 v1, v2, v3;
  float w1, w2, w3;
  triangleGrid(uv * 4.0, v1, v2, v3, w1, w2, w3);
  vec2 off1 = hash2(v1);
  vec2 off2 = hash2(v2);
  vec2 off3 = hash2(v3);
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  vec3 c1 = textureGrad(uAtlas, vec3(uv + off1, float(code)), dx, dy).rgb;
  vec3 c2 = textureGrad(uAtlas, vec3(uv + off2, float(code)), dx, dy).rgb;
  vec3 c3 = textureGrad(uAtlas, vec3(uv + off3, float(code)), dx, dy).rgb;
  vec3 cMean = (c1 + c2 + c3) * (1.0 / 3.0);
  vec3 cDev = (c1 - cMean) * w1 + (c2 - cMean) * w2 + (c3 - cMean) * w3;
  float wNorm = inversesqrt(w1 * w1 + w2 * w2 + w3 * w3);
  return cMean + cDev * wNorm;
}

int vertexTypeAt(int iu, int iv) {
  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);
}

// Per-vertex road bit, packed into G channel as roadCode*64. Any nonzero
// (i.e. roadCode > 0) returns 1.0, else 0.0. Bilinear-blended across the
// 4 cell corners in the main body to get a smooth road-presence mask.
float vertexRoadAt(int iu, int iv) {
  return texelFetch(uVertexTypes, ivec2(iu, iv), 0).g > 0.125 ? 1.0 : 0.0;
}

void main() {
  // vGridUv is [0, 8] across the 192 m LB. Bilinear 4-corner blend.
  vec2 grid = vGridUv;
  int iu = int(floor(grid.x));
  int iv = int(floor(grid.y));
  iu = clamp(iu, 0, 7);
  iv = clamp(iv, 0, 7);
  float fu = grid.x - float(iu);
  float fv = grid.y - float(iv);
  vec2 cellUv = vec2(fu, fv);

  // Phase 2.2 — water UV scroll. Apply a per-frame offset to the
  // intra-cell UV so the water texture pattern drifts. The scroll is
  // small enough to stay within a tile each frame; fract() wraps
  // cleanly inside the per-tile slot via atlasUvFor's modular indexing
  // because the slot only sees the fractional part. Gated by both the
  // displacement quality flag AND the per-vertex water flag so
  // non-water cells (and low quality) keep their static UV.
  vec2 waterCellUv = cellUv;
  if (uDisplacementEnabled > 0.5 && vIsWater == 1) {
    waterCellUv = fract(cellUv + vec2(uTime * 0.05, uTime * 0.02));
  }

  int t00 = vertexTypeAt(iu,     iv    );  // SW
  int t10 = vertexTypeAt(iu + 1, iv    );  // SE
  int t01 = vertexTypeAt(iu,     iv + 1);  // NW
  int t11 = vertexTypeAt(iu + 1, iv + 1);  // NE

  // Per-corner cellUv: water-typed corners get the scrolled UV, others
  // stay on the static path. This keeps the blend across the water /
  // land seam continuous because non-water corners contribute their
  // unscrolled tile while the water corners drift.
  vec2 uv00 = (t00 >= 16 && t00 <= 23 && t00 != 21) ? waterCellUv : cellUv;
  vec2 uv10 = (t10 >= 16 && t10 <= 23 && t10 != 21) ? waterCellUv : cellUv;
  vec2 uv01 = (t01 >= 16 && t01 <= 23 && t01 != 21) ? waterCellUv : cellUv;
  vec2 uv11 = (t11 >= 16 && t11 <= 23 && t11 != 21) ? waterCellUv : cellUv;

  // Heitz tile-and-blend per corner. Replaces the prior single-sample
  // texture() lookup that produced a visible 256x256 tile repeat
  // inside every 24 m cell. Now each per-corner sample is itself a
  // 3-sample stochastic blend (12 textureGrads/fragment total), with
  // variance-preserving normalisation so it doesn't go muddy at hex
  // centres. See heitzSample doc above.
  vec3 c00 = heitzSample(clamp(t00, 0, 32), uv00);
  vec3 c10 = heitzSample(clamp(t10, 0, 32), uv10);
  vec3 c01 = heitzSample(clamp(t01, 0, 32), uv01);
  vec3 c11 = heitzSample(clamp(t11, 0, 32), uv11);

  float w00 = (1.0 - fu) * (1.0 - fv);
  float w10 = fu * (1.0 - fv);
  float w01 = (1.0 - fu) * fv;
  float w11 = fu * fv;

  vec3 result = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;

  // Phase 2.2 — water tint shift. Subtle bluish modulation that breathes
  // over time (period ~21 s at uTime * 0.3). Only applied on water-
  // flagged provoking vertices; non-water surfaces stay colour-stable.
  // Perf D1 — read the pre-computed sin(uTime * 0.3) from the varying
  // (constant across the cell since uTime is constant per draw call;
  // linear interpolation of a constant is exact).
  if (uDisplacementEnabled > 0.5 && vIsWater == 1) {
    vec3 tint = mix(vec3(0.9, 0.95, 1.05), vec3(1.0, 1.0, 1.0),
                    0.5 + 0.5 * vWaveModulation.x);
    result *= tint;
  }

  // Retail-style road painting. Roads in retail AC are a per-vertex bit
  // (surface code bits 0-1), encoded into uVertexTypes.G during build.
  // Sample the 4 corner road bits with the SAME bilinear weights we
  // used for terrain colour blending — that produces a smooth 0..1
  // road-presence mask across each cell. When the mask is non-zero,
  // sample the retail road texture (tiled across the LB) and blend
  // it into the terrain colour by the mask. This replaces the prior
  // separate road-overlay quad mesh — same painted appearance retail
  // had, naturally flush with the terrain surface.
  if (uRoadEnabled > 0.5) {
    float r00 = vertexRoadAt(iu,     iv    );
    float r10 = vertexRoadAt(iu + 1, iv    );
    float r01 = vertexRoadAt(iu,     iv + 1);
    float r11 = vertexRoadAt(iu + 1, iv + 1);
    float roadMask = r00 * w00 + r10 * w10 + r01 * w01 + r11 * w11;
    // smoothstep(0.85, 0.95) narrows the paint band to ~5 m, matching
    // retail's _road_width = 5.0 (acclient.c:467318). The raw bilinear
    // mask ramps 0..1 across a 24 m cell, so the previous > 0.001 gate
    // smeared the road across full cells (~10x too wide).
    float roadWeight = smoothstep(0.85, 0.95, roadMask);
    if (roadWeight > 0.0) {
      vec3 roadColor = texture(uRoadTexture, vGridUv * uRoadTileScale).rgb;
      result = mix(result, roadColor, roadWeight);
    }
  }

  // ---------------------------------------------------------------
  // Phase 1.2 — detail-normal overlay via reoriented normal blending.
  // ---------------------------------------------------------------
  //
  // Goal: a high-frequency tangent-space normal sampled per terrain
  // category, blended into the surface normal so the sun's NdotL term
  // picks up sub-cell detail (grass blades, sand drifts, pebbles).
  //
  // Reoriented normal mapping (RNM) — see
  //   https://blog.selfshadow.com/publications/blending-in-detail/  §4
  // takes a base tangent-space normal and a detail tangent-space normal
  // and produces a single tangent-space normal that respects the base
  // orientation. The 6 lines below are the standard formulation:
  //   t = base * (2, 2, 2) + (-1, -1,  0)
  //   u = detail * (-2, -2, 2) + (1, 1, -1)
  //   r = normalize(t * dot(t, u) - u * t.z)
  // Then r is treated as the combined tangent-space normal.

  // Sun-direction: AC-z-up unit vector from uSunDir, pushed each frame
  // by loop.js off the same SkyState that drives SkyMaterial /
  // SunDirectionalLight / CloudsEffect. Pre-populator: default uniform
  // value mirrors the original literal so first frames look identical.
  vec3 sunDir = normalize(uSunDir);

  // Base surface normal in tangent space — terrain is flat-Z-up at the
  // grid level, so (0, 0, 1) is the canonical base. (Per-vertex
  // varying normals could be derived from geometry, but at 24 m
  // spacing they're barely non-vertical; the detail layer carries the
  // sub-cell perturbation.)
  vec3 baseN = vec3(0.5, 0.5, 1.0);   // pre-encoded base normal at [0.5, 0.5, 1]

  float ndotl = 1.0;
  if (uDetailNormalEnabled > 0.5) {
    int slice = uCodeToSlice[clamp(vTerrainCode, 0, 31)];
    if (slice < 5) {
      // ----- Phase 1.3 — slope-gated triplanar detail sampling. -----
      //
      // Existing grid-UV path (vGridUv * uDetailScale) is the XY-plane
      // projection of the LB-local position scaled by uDetailScale (16).
      // For triplanar we additionally sample YZ + XZ projections of the
      // same world point and blend by abs(normal)^sharpness.
      //
      // Slope detection: vAcNormal is AC-space (Z-up before worldRoot
      // rotation); flat ground points (0,0,1). slope = 1 - n.z is 0
      // on flat ground, ~1 on vertical cliffs. We always use the
      // normalised normal to keep weights stable across mesh edges.
      vec3 n = normalize(vAcNormal);
      float slope = 1.0 - n.z;
      float triBlend = uTriplanarEnabled > 0.5
        ? smoothstep(uTriplanarSlopeLo, ${TRIPLANAR_SLOPE_HI.toFixed(3)}, slope)
        : 0.0;
      vec2 detailUvXy = vGridUv * uDetailScale;
      // Slice 2 = sand. Rotate the sample UV by uWindDir = (cos θ, sin θ)
      // so the anisotropic drift pattern tracks the wind direction. The
      // rotation is applied to all three triplanar planes consistently
      // so the wind-axis follows the dominant axis at the fragment.
      if (slice == 2) {
        float cw = uWindDir.x;
        float sw = uWindDir.y;
        detailUvXy = vec2(cw * detailUvXy.x - sw * detailUvXy.y,
                          sw * detailUvXy.x + cw * detailUvXy.y);
      }
      vec3 detailEncoded = texture(uTerrainDetailNormalArray,
                                   vec3(detailUvXy, float(slice))).rgb;
      if (triBlend > 0.0) {
        // YZ + XZ samples at the same per-LB frequency as the existing
        // XY path (position scaled by uDetailScale / 24.0).
        float invCell = uDetailScale / 24.0;
        vec2 detailUvYz = vAcPos.yz * invCell;
        vec2 detailUvXz = vAcPos.xz * invCell;
        if (slice == 2) {
          float cw = uWindDir.x;
          float sw = uWindDir.y;
          detailUvYz = vec2(cw * detailUvYz.x - sw * detailUvYz.y,
                            sw * detailUvYz.x + cw * detailUvYz.y);
          detailUvXz = vec2(cw * detailUvXz.x - sw * detailUvXz.y,
                            sw * detailUvXz.x + cw * detailUvXz.y);
        }
        vec3 detailYz = texture(uTerrainDetailNormalArray,
                                vec3(detailUvYz, float(slice))).rgb;
        vec3 detailXz = texture(uTerrainDetailNormalArray,
                                vec3(detailUvXz, float(slice))).rgb;
        // Triplanar blend weights from |normal| raised to sharpness.
        // x-weight pairs with YZ (the plane perpendicular to +x), y with
        // XZ, z with XY — the existing detailEncoded.
        vec3 w = pow(abs(n), vec3(uTriplanarSharpness));
        float wSum = max(w.x + w.y + w.z, 1e-4);
        w /= wSum;
        vec3 detailTri = detailYz * w.x + detailXz * w.y + detailEncoded * w.z;
        detailEncoded = mix(detailEncoded, detailTri, triBlend);
      }
      // RNM blend.
      vec3 t = baseN * vec3(2.0, 2.0, 2.0) + vec3(-1.0, -1.0, 0.0);
      vec3 u = detailEncoded * vec3(-2.0, -2.0, 2.0) + vec3(1.0, 1.0, -1.0);
      vec3 combinedN = normalize(t * dot(t, u) - u * t.z);
      // Apply combined normal to the sun NdotL.
      ndotl = clamp(dot(combinedN, sunDir), 0.0, 1.0);
      // Wrap-lighting bias so unlit faces don't go pure black — terrain
      // shading is otherwise unmodulated, so a pure cosine produces too
      // much contrast at sunset orientations.
      ndotl = mix(0.65, 1.0, ndotl);
    }
  }

  // Clouds-L — cloud-shadow modulation. Project world pos into cascade
  // 0's shadow space; sample the R channel (cloud optical depth along
  // sun ray); attenuate. Cascade 0 covers the closest ~10% of view
  // distance so terrain near the camera gets the highest-detail
  // shadow. Outside cascade 0 (UV outside [0,1]) → no shadow. Real
  // cascade selection by distance is Clouds-L-extended.
  float cloudShadow = 1.0;
  if (uCloudShadowEnabled > 0.5) {
    vec4 sclip = uCloudShadowMatrix0 * vec4(vWorldPos, 1.0);
    sclip /= sclip.w;
    vec2 suv = sclip.xy * 0.5 + 0.5;
    if (suv.x >= 0.0 && suv.x <= 1.0 && suv.y >= 0.0 && suv.y <= 1.0) {
      float density = texture(uCloudShadowMap, vec3(suv, 0.0)).r;
      // Beer-Lambert: transmittance = exp(-density * strength).
      // Clamp to 0.3 so shadowed terrain never goes pure black (sky
      // ambient still fills in even under thick cloud).
      cloudShadow = max(0.3, exp(-density * uCloudShadowStrength));
    }
  }

  // CSM-on-terrain — building / static cast shadows now actually land
  // on the ground. csmShadowFactor returns 0.0 (fully shadowed) or
  // 1.0 (fully lit); mix with a 0.45 floor so shadowed terrain keeps
  // ambient lift, matching the MeshStandardMaterial CSM patch in
  // materials.js (same visual feel for cast shadows across surfaces).
  float csmShadow = 1.0;
  if (uCsmEnabled > 0.5) {
    float s = csmShadowFactor(vWorldPos, vViewDepth);
    csmShadow = mix(0.45, 1.0, s);
  }

  fragColor = vec4(result * ndotl * cloudShadow * csmShadow, 1.0);
}
`;

/**
 * Read `subdivLevel` from `scene3d.quality.flags`, defaulting to 1 if
 * the flag is missing or out of range. Quality preset values are 1, 2,
 * 4, or 8; we coerce any other value to the nearest power-of-two bound.
 */
function pickSubdivLevel(scene3d) {
  const raw = scene3d?.quality?.flags?.subdivLevel;
  if (!Number.isFinite(raw) || raw <= 1) return 1;
  if (raw >= 8) return 8;
  if (raw >= 4) return 4;
  if (raw >= 2) return 2;
  return 1;
}

/**
 * Phase 2.2 — pack a Set<int> of terrain codes into a 32-bit bitmask.
 * Bit `i` is set if code `i` is in the set. Used by the vertex shader's
 * displacement branch (`(uWaterCodeMask & (1 << code)) != 0`) so the
 * GLSL stays free of per-code if/elif chains.
 *
 * Exported for direct unit testing; the production caller is
 * `buildHoltburgTerrain`.
 */
export function computeCodeBitmask(codeSet) {
  let mask = 0;
  for (const code of codeSet) {
    if (Number.isInteger(code) && code >= 0 && code < 32) {
      mask = (mask | (1 << code)) >>> 0;
    }
  }
  // GLSL `int` is signed 32-bit; convert via >>> 0 then |0 so the
  // top bit, if ever set, round-trips correctly through three.js's
  // setUniform path.
  return mask | 0;
}

// Phase 2.2 — exported for tests + capture-script probes.
export const PHASE_2_2_WATER_CODES = TERRAIN_WATER_CODES;
export const PHASE_2_2_LAVA_CODES = TERRAIN_LAVA_CODES;


// ----- world-expand step 1 — once-per-ring shader uniform constants
//
// Shared by every per-LB material the ring bakes. Lifted out of the
// inner loop so the ring driver builds them once and threads them via
// `opts` to `bakeTerrainForLandblock` rather than recomputing per LB.

/**
 * Resolve the once-per-ring opts the per-LB baker consumes. Reads
 * quality flags / detail-normal array off `scene3d`, computes the
 * shared bitmasks, and (optionally) builds the atlas + road textures
 * from the wasm `fetch_terrain_textures()` payload.
 *
 * Callers that already have an atlas/road texture pair (e.g. the lazy
 * hook reusing a previously baked ring's textures) should pass them via
 * `existing.atlasTexture` / `existing.roadTexture` / `existing.roadCanvas`
 * to skip the texture build.
 *
 * `centreLbX` / `centreLbY` are used by the centre-vs-outer subdivision
 * LOD rule preserved from the prior `buildHoltburgTerrain` body. The
 * distance-keyed LOD generalisation is Objective 7's job, not this
 * objective's.
 */
async function resolveTerrainRingOpts(
  scene3d,
  wasmExports,
  centreLbX,
  centreLbY,
  existing
) {
  // Phase 1.2 — terrain detail normal array. Loaded once in index.js
  // and stashed on scene3d, gated behind `quality.flags.terrainDetailNormal`.
  // When the flag is off, `terrainDetailNormalArray` is null and the
  // ShaderMaterial uniforms get the fallback (uDetailNormalEnabled = 0).
  const detailNormalEnabled =
    !!scene3d.quality?.flags?.terrainDetailNormal &&
    !!scene3d.terrainDetailNormalArray;
  const detailNormalArrayTex = detailNormalEnabled
    ? scene3d.terrainDetailNormalArray
    : null;
  // Phase 1.3 — slope-gated triplanar mapping on the detail normal
  // layer. Requires Phase 1.2's array texture to be loaded; off if
  // either the triplanar flag is off OR the detail normal isn't
  // wired (no point triplanar-sampling a no-op).
  const triplanarEnabled =
    !!scene3d.quality?.flags?.triplanar && detailNormalEnabled;
  // Perf D3 — slope LO threshold derived from the quality preset
  // (0..100 int → 0.0..1.0 float). Defensive fallback to 30 (= 0.3)
  // mirrors the high/ultra preset and the audit's documented gate.
  const triplanarSlopeThresholdPct =
    Number.isFinite(scene3d?.quality?.flags?.triplanarSlopeThresholdPct)
      ? scene3d.quality.flags.triplanarSlopeThresholdPct
      : 30;
  const triplanarSlopeLo = triplanarSlopeThresholdPct / 100.0;
  // Per-ring codeToSlice uniform array — int[32] keyed by terrain
  // code. Built once and shared by reference across every LB material.
  const codeToSliceArr = Array.from(TERRAIN_CODE_TO_DETAIL_SLICE).map(
    (slice) => (slice === DETAIL_SLICE_NONE ? 255 : slice)
  );

  // Phase 2.1 — read subdivision level from the resolved quality preset.
  // The flag is `subdivLevel: 1|2|4|8`. Default to 1 (no subdivision) if
  // the flag is missing or the wasm export hasn't been built yet (e.g.
  // tests stubbing wasmExports).
  const subdivLevel = pickSubdivLevel(scene3d);
  const canSubdivide =
    subdivLevel > 1 &&
    typeof wasmExports.fetch_subdivided_landblocks === "function";

  // Phase 2.2 — animated water/lava displacement. Only enabled at
  // subdivLevel >= 2 per plan hand-off note #3 (level=1 has 24 m vertex
  // spacing; the wave wavelength would be larger than the screen).
  // Materials still bind `uTime` / `uDisplacementEnabled` so the JS
  // tick can flip the gate later without rebuilding the shader.
  const displacementEnabled = subdivLevel >= 2;
  const waterCodeMask = computeCodeBitmask(TERRAIN_WATER_CODES);
  const lavaCodeMask = computeCodeBitmask(TERRAIN_LAVA_CODES);

  // Atlas + road textures. Built from `fetch_terrain_textures()` when
  // the caller didn't pass a previously-baked pair. The lazy LB-entry
  // path (added in Objective 5/6) will pass the previously-baked
  // textures here so we don't redo the bake work.
  let atlasTexture = existing?.atlasTexture ?? null;
  let roadTexture = existing?.roadTexture ?? null;
  let roadCanvas = existing?.roadCanvas ?? null;
  if (!atlasTexture) {
    const terrainTextures = await wasmExports.fetch_terrain_textures();
    const built = buildTerrainAtlasArrayBytes(terrainTextures);
    roadCanvas = built.roadCanvas;

    // Per-code layer of a `sampler2DArray`. Replaces the prior
    // `CanvasTexture` of a 6x6 packed atlas (1536x1536); the packed
    // atlas had no inter-tile gutter so the GPU's bilinear+mipmap
    // sampler bled neighbouring slots' colours into each cell at
    // mip levels >=3 — the bleed line landed on the 24 m cell vertex
    // grid, which the user described as "terrain textures not flush
    // with vertices". DataArrayTexture clamps integer layer
    // selection per-sample so cross-tile bleed is structurally
    // impossible at any mip level, and each layer carries its own
    // mipmap chain.
    atlasTexture = new THREE.DataArrayTexture(
      built.atlasArrayBytes,
      built.tileSize,
      built.tileSize,
      built.depth
    );
    atlasTexture.format = THREE.RGBAFormat;
    atlasTexture.type = THREE.UnsignedByteType;
    // sRGB so three.js linearises tile colours before the fragment
    // shader's bilinear-on-control corner blend (same colour-space
    // contract the prior CanvasTexture path had).
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    // RepeatWrapping so the Heitz tile-and-blend sampler (heitzSample
    // in the fragment shader) can offset INSIDE each tile by a
    // pseudo-random uv shift and wrap seamlessly across the tile
    // border. Per-layer isolation (no cross-code bleed) is preserved
    // because DataArrayTexture clamps the integer layer dimension
    // regardless of the in-layer wrap mode -- only the 2D inside of
    // each tile wraps. Retail terrain tiles are designed seamlessly
    // tileable so the wrap stays invisible.
    atlasTexture.wrapS = THREE.RepeatWrapping;
    atlasTexture.wrapT = THREE.RepeatWrapping;
    atlasTexture.magFilter = THREE.LinearFilter;
    atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
    atlasTexture.generateMipmaps = true;
    atlasTexture.needsUpdate = true;

    if (roadCanvas) {
      roadTexture = new THREE.CanvasTexture(roadCanvas);
      roadTexture.colorSpace = THREE.SRGBColorSpace;
      roadTexture.wrapS = THREE.RepeatWrapping;
      roadTexture.wrapT = THREE.RepeatWrapping;
      roadTexture.magFilter = THREE.LinearFilter;
      roadTexture.minFilter = THREE.LinearMipmapLinearFilter;
      roadTexture.generateMipmaps = true;
      // Same flipY=false as the atlas above — the road tile is a single
      // sub-image with RepeatWrapping; flipY=true would vertically
      // mirror the tile and rotate any directional road art (arrows /
      // gravel direction) 180°. Matches adapter.js convention.
      roadTexture.flipY = false;
      roadTexture.needsUpdate = true;
    }
  }

  // world-expand step 1 Objective 7 — distance-keyed subdivision LOD
  // reads its reference LB off `playerLbKey` (preferred) or
  // `initialCentreLbKey` (fallback), both optional fields on scene3d.
  // Threaded through opts so `pickSubdivLevelForLb` stays a pure fn of
  // its inputs (easier to unit-test from outside a ring driver).
  const playerLbKey =
    typeof scene3d?.playerLbKey === "number" ? scene3d.playerLbKey : null;
  const initialCentreLbKey =
    typeof scene3d?.initialCentreLbKey === "number"
      ? scene3d.initialCentreLbKey
      : null;

  return {
    centreLbX,
    centreLbY,
    playerLbKey,
    initialCentreLbKey,
    detailNormalEnabled,
    detailNormalArrayTex,
    triplanarEnabled,
    triplanarSlopeLo,
    codeToSliceArr,
    subdivLevel,
    canSubdivide,
    displacementEnabled,
    waterCodeMask,
    lavaCodeMask,
    atlasTexture,
    roadTexture,
    roadCanvas,
  };
}

/**
 * Pick the subdivision level for a single LB using Chebyshev-distance
 * cascade from the reference LB (world-expand step 1 Objective 7).
 *
 *   - distance 0 (the reference LB itself): full `opts.subdivLevel`.
 *   - distance 1 (the 8 LBs immediately around): `max(1, floor(level/2))`.
 *   - distance ≥ 2 (outer rings at radius≥2): `1` (no subdivision).
 *
 * The reference LB is `scene3d.playerLbKey` when set, otherwise
 * `scene3d.initialCentreLbKey`, otherwise the ring driver's centre
 * (`opts.centreLbX` / `opts.centreLbY`). We do NOT plumb a runtime
 * `playerLbKey` updater in step 1: the brief notes that lazy adds
 * compute distance at bake time from whatever centre was provided, and
 * already-baked LBs do not re-bake on player movement (re-bake-on-LOD-
 * shift is step 2 scope per docs/world-expand-step-1-handoff.md). So
 * in practice, every LB picks its level from the centre passed to
 * `bakeTerrainRing` — which is the spawn LB at init and the lazy-walk
 * centre on subsequent loads.
 *
 * At radius=1 this is IDENTICAL to the prior centre-vs-outer flip:
 *   distance 0 → full, distance 1 → half (no distance ≥ 2 in a 3×3).
 * At radius≥2 (Objective 8 flips to radius=6) the cascade flattens
 * the outer rings to subdivLevel=1 so triangle counts don't explode.
 */
function pickSubdivLevelForLb(opts, lbX, lbY) {
  const fullLevel = opts.subdivLevel;
  const halfLevel = Math.max(1, Math.floor(opts.subdivLevel / 2));
  // Resolve the distance reference. The scene3d ref is threaded through
  // `opts` by `resolveTerrainRingOpts` (which captures the scene3d at
  // ring-bake start). If neither dynamic key is present, fall back to
  // the centre LB passed to the ring driver — preserves radius=1
  // behaviour for callers that never touch the player position.
  const playerLb = opts.playerLbKey ?? opts.initialCentreLbKey ?? null;
  let pX;
  let pY;
  if (playerLb != null) {
    pX = (playerLb >>> 24) & 0xff;
    pY = (playerLb >>> 16) & 0xff;
  } else {
    pX = opts.centreLbX;
    pY = opts.centreLbY;
  }
  const distLb = Math.max(Math.abs(lbX - pX), Math.abs(lbY - pY));
  if (distLb <= 0) return fullLevel;
  if (distLb === 1) return halfLevel;
  return 1;
}

/**
 * world-expand step 1 — per-LB terrain baker.
 *
 * Bakes ONE landblock's terrain mesh (heightfield + bilinear-blend
 * shader + per-LB vertex-types texture + Phase 2.1 subdivision +
 * Phase 2.2 displacement + road overlay) and adds it to
 * `scene3d.terrainGroup`. Idempotent via `scene3d.terrainBakedLbs:
 * Set<u32>` keyed by `((lbX << 24) | (lbY << 16)) >>> 0`.
 *
 * `opts` is the once-per-ring bag built by `resolveTerrainRingOpts`.
 * For the lazy LB-entry path (called from outside a ring driver, e.g.
 * the `handlePositionUpdate` hook Objective 6 will wire), callers can
 * either (a) reuse the previously-baked ring's `opts` straight off
 * `scene3d.terrainOpts` (set by `bakeTerrainRing`) or (b) call
 * `resolveTerrainRingOpts(scene3d, wasmExports, lbX, lbY, scene3d)` to
 * get a fresh one centred on the new LB.
 *
 * `opts.prefetchedMesh` / `opts.prefetchedSubdiv` short-circuit the
 * wasm round-trip when the ring driver has already batched the fetch
 * for this LB. Solo callers leave both unset and the baker fetches via
 * single-element `fetch_landblock_heightmaps` / per-LB
 * `fetch_subdivided_landblock`.
 *
 * Returns the added `THREE.Mesh`, or `null` if the LB was already baked.
 */
export async function bakeTerrainForLandblock(
  scene3d,
  lbX,
  lbY,
  opts,
  wasmExports
) {
  if (!scene3d || !scene3d.terrainGroup) {
    throw new Error(
      "bakeTerrainForLandblock: scene3d.terrainGroup missing (call init3D first)"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_heightmaps !== "function"
  ) {
    throw new Error(
      "bakeTerrainForLandblock: wasmExports missing fetch_landblock_heightmaps"
    );
  }
  if (!opts) {
    throw new Error(
      "bakeTerrainForLandblock: opts missing (call resolveTerrainRingOpts or pass scene3d.terrainOpts)"
    );
  }

  // Idempotency: short-circuit if this LB is already in the baked set.
  // Initialise both the bake set + the per-rAF terrainMaterials registry
  // lazily so solo callers (the future lazy LB-entry hook) work even if
  // the ring driver hasn't run yet.
  if (!(scene3d.terrainBakedLbs instanceof Set)) {
    scene3d.terrainBakedLbs = new Set();
  }
  if (!Array.isArray(scene3d.terrainMaterials)) {
    scene3d.terrainMaterials = [];
  }
  const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
  if (scene3d.terrainBakedLbs.has(lbKey)) {
    return null;
  }

  // 1. Fetch base mesh. Ring drivers pass a prefetched mesh via opts;
  // solo callers (lazy hook) issue a single-element batch call to the
  // same wasm export the ring driver uses.
  const cellId = (lbKey | 0xffff) >>> 0;
  let wasmMesh = opts.prefetchedMesh ?? null;
  if (!wasmMesh) {
    const meshes = await wasmExports.fetch_landblock_heightmaps(
      new Uint32Array([cellId])
    );
    if (!meshes || meshes.length === 0) {
      throw new Error(
        `bakeTerrainForLandblock: fetch_landblock_heightmaps returned 0 meshes for (${lbX.toString(
          16
        )},${lbY.toString(16)})`
      );
    }
    wasmMesh = meshes[0];
  }

  // 2. Subdivided mesh (visual-fidelity Phase 2.1). Either passed in by
  // the ring driver (it batched the per-LB subdiv fetch in parallel) or
  // fetched here for the solo path. The level is the centre-vs-outer
  // pick — same rule as the prior `buildHoltburgTerrain` body.
  let subdivEntry = opts.prefetchedSubdiv ?? null;
  if (!subdivEntry && opts.canSubdivide) {
    const level = pickSubdivLevelForLb(opts, lbX, lbY);
    try {
      const mesh = await wasmExports.fetch_subdivided_landblock(cellId, level);
      subdivEntry = { mesh, level };
    } catch (err) {
      console.warn(
        `[terrain] subdivide failed for (${lbX},${lbY}) @ level=${level}:`,
        err
      );
      subdivEntry = null;
    }
  }

  // Mark baked AFTER successful base fetch but BEFORE building geometry
  // so any in-flight concurrent call for the same LB short-circuits
  // immediately. Three.js mesh construction is sync from here on.
  scene3d.terrainBakedLbs.add(lbKey);

  // 3. Snapshot the per-vertex code arrays before freeing the wasm
  // mesh. terrainCodes feeds uVertexTypes.R; roadCodes feeds .G for
  // the in-shader road painting.
  const roadCodesCopy = Uint8Array.from(wasmMesh.roadCodes);
  const terrainCodesCopy = Uint8Array.from(wasmMesh.terrainCodes);
  const heightMin = wasmMesh.heightMin;
  const heightMax = wasmMesh.heightMax;

  // 4. Phase 2.1 — if the LB has a subdivided mesh, build geometry from
  // it. Otherwise fall back to the 9×9 path. The 9×9 vertex-types
  // texture (`uVertexTypes`) is always the 9×9 control grid — the
  // subdivided mesh's per-vertex `terrainCode` attribute is unused by
  // the current shader (kept on the geometry for forward compat).
  let geom;
  let effectiveSubdiv = 1;
  if (subdivEntry && subdivEntry.mesh) {
    geom = subdividedLandblockMeshToGeometry(subdivEntry.mesh);
    effectiveSubdiv = subdivEntry.level;
    if (typeof subdivEntry.mesh.free === "function") subdivEntry.mesh.free();
  } else {
    geom = landblockMeshToGeometry(wasmMesh);
  }
  const vertexTypesTex = buildVertexTypesDataTexture(terrainCodesCopy, roadCodesCopy);

  // 5. ShaderMaterial — verbatim port from the prior in-loop body.
  // Per-LB uniforms (uVertexTypes, uLbOriginXy) are bound here; the
  // once-per-ring uniforms (uAtlas, uTerrainDetailNormalArray,
  // uCodeToSlice, uWaterCodeMask, etc.) come straight off `opts`.
  const material = new THREE.ShaderMaterial({
    // three.js auto-injects `projectionMatrix`, `modelViewMatrix`,
    // and the `position` attribute. We just supply the user
    // uniforms.
    uniforms: {
      uAtlas: { value: opts.atlasTexture },
      uVertexTypes: { value: vertexTypesTex },
      // Retail-style road painting (replaces the prior road-overlay
      // mesh). The road texture is the same retail-DAT road tile we
      // were previously stamping onto separate quads; now it's sampled
      // directly in the terrain shader, bilinear-blended via the
      // per-vertex road bit packed into uVertexTypes.G.
      // uRoadTileScale = 1/6 means one tile per 6 m along vGridUv
      // (matches the prior ROAD_TEXTURE_TILE_M = 6 from the overlay
      // path). vGridUv is in cell units (1.0 per 24 m), so the scale
      // factor here is 24 / 6 = 4 — four tile repeats per cell.
      uRoadTexture: { value: opts.roadTexture ?? null },
      uRoadTileScale: { value: 4.0 },
      uRoadEnabled: { value: opts.roadTexture ? 1.0 : 0.0 },
      // Phase 1.2 — terrain detail-normal array + per-code slice
      // table + per-frame wind direction + quality gate. When
      // `detailNormalEnabled` is false the texture uniform is set
      // to null (three.js skips the bind) and uDetailNormalEnabled
      // = 0.0 makes the fragment shader branch around the sample.
      uTerrainDetailNormalArray: { value: opts.detailNormalArrayTex },
      uCodeToSlice: { value: opts.codeToSliceArr },
      uDetailScale: { value: DEFAULT_DETAIL_SCALE },
      uWindDir: { value: new THREE.Vector2(1.0, 0.0) },
      uDetailNormalEnabled: {
        value: opts.detailNormalEnabled ? 1.0 : 0.0,
      },
      // Phase 1.3 — triplanar gate + sharpness. When the gate is
      // 0.0 the fragment skips the YZ+XZ samples entirely and the
      // detail-normal falls back to the XY-only Phase 1.2 path.
      uTriplanarEnabled: { value: opts.triplanarEnabled ? 1.0 : 0.0 },
      uTriplanarSharpness: { value: DEFAULT_TRIPLANAR_SHARPNESS },
      // Perf D3 — per-quality slope LO threshold. `opts.triplanarSlopeLo`
      // is resolved from `quality.flags.triplanarSlopeThresholdPct / 100`
      // in resolveTerrainRingOpts (defensive fallback 30 → 0.3).
      uTriplanarSlopeLo: { value: opts.triplanarSlopeLo },
      // Phase 2.2 — animated displacement uniforms. uTime is pushed
      // from `loop.js::tickPerFrame` once per rAF via the shared
      // `scene3d.terrainMaterials` registry below. uWaterCodeMask /
      // uLavaCodeMask are packed bitmasks (bit i = code i). Gate is
      // 1.0 only when subdivLevel >= 2. uLbOriginXy lets the wave
      // phase stay continuous across LB seams (world-frame XY).
      uTime: { value: 0.0 },
      uWaterCodeMask: { value: opts.waterCodeMask },
      uLavaCodeMask: { value: opts.lavaCodeMask },
      uDisplacementEnabled: {
        value: opts.displacementEnabled ? 1.0 : 0.0,
      },
      uLbOriginXy: {
        value: new THREE.Vector2(
          lbX * METERS_PER_LANDBLOCK,
          lbY * METERS_PER_LANDBLOCK
        ),
      },
      // Clouds-L — cloud shadow uniforms. Updated each frame from
      // cloud_volume.js when CloudOverlay is wired. Default off
      // (uCloudShadowEnabled=0) so terrain renders correctly when
      // clouds=on isn't set.
      uCloudShadowEnabled: { value: 0.0 },
      uCloudShadowMap: { value: null },
      uCloudShadowMatrix0: { value: new THREE.Matrix4() },
      uCloudShadowStrength: { value: 2.0 },
      // Initial sun direction = the prior hardcoded literal so the
      // pre-populator fallback matches old behavior exactly.
      uSunDir: { value: new THREE.Vector3(-0.4, -0.3, 1.0).normalize() },
      // CSM-on-terrain. Mirrors materials.js's MeshStandardMaterial
      // patch. Texture refs + matrices refreshed each frame by
      // csm.refreshCsmUniforms once the material is registered on
      // csmState.patchedMaterials below. uCsmEnabled stays 0.0 when
      // csmState is absent (low/mid quality presets, ?shadows=off);
      // shader branch around the sampling cost.
      uCsmEnabled: {
        value: scene3d?.csmState ? 1.0 : 0.0,
      },
      uCsmShadowMap0: {
        value: scene3d?.csmState?.lights?.[0]?.shadow?.map?.texture ?? null,
      },
      uCsmShadowMap1: {
        value: scene3d?.csmState?.lights?.[1]?.shadow?.map?.texture ?? null,
      },
      uCsmShadowMap2: {
        value: scene3d?.csmState?.lights?.[2]?.shadow?.map?.texture ?? null,
      },
      uCsmMatrix0: {
        value: scene3d?.csmState?.lights?.[0]?.shadow?.matrix?.clone() ?? new THREE.Matrix4(),
      },
      uCsmMatrix1: {
        value: scene3d?.csmState?.lights?.[1]?.shadow?.matrix?.clone() ?? new THREE.Matrix4(),
      },
      uCsmMatrix2: {
        value: scene3d?.csmState?.lights?.[2]?.shadow?.matrix?.clone() ?? new THREE.Matrix4(),
      },
      uCsmSplits: {
        value: new THREE.Vector2(
          scene3d?.csmState?.splits?.[0] ?? 30,
          scene3d?.csmState?.splits?.[1] ?? 100,
        ),
      },
      uCsmFar: {
        value: scene3d?.csmState?.splits?.[2] ?? 300,
      },
      uCsmBlend: {
        value: scene3d?.csmState?.blendFrac ?? 0.1,
      },
    },
    vertexShader: TERRAIN_VERTEX_GLSL,
    fragmentShader: TERRAIN_FRAGMENT_GLSL,
    glslVersion: THREE.GLSL3,
    // Heightfield is single-sided: backfaces are looking at the
    // world from below the terrain — never the player's vantage.
    // The F#27 fix in `landblockMeshToGeometry` reverses the wasm's
    // CW-from-AC-+Z index winding so FrontSide is correct post-
    // worldRoot rotation. Don't flip back to DoubleSide without
    // also reverting the adapter's index reversal.
    side: THREE.FrontSide,
  });

  // Phase 2.2 — register the material so the per-rAF tick can push
  // the shared wall-clock `uTime`. Single shared time source means
  // matched wave motion across LB seams (objective #4). The registry
  // entry retains the ShaderMaterial handle directly; on
  // disposal/rebuild the caller should null out scene3d.terrainMaterials.
  scene3d.terrainMaterials.push(material);

  // CSM-on-terrain — register the material on csmState.patchedMaterials
  // so csm.refreshCsmUniforms walks it each frame and pushes fresh
  // shadow.matrix + shadow.map.texture refs onto our uniforms. Mirrors
  // materials.js's MeshStandardMaterial patch but for our raw GLSL3
  // shader. `csmShaderUniforms = material.uniforms` works because
  // ShaderMaterial's uniforms ARE the shader's uniforms (no
  // onBeforeCompile copy).
  if (scene3d.csmState?.patchedMaterials) {
    material.userData = {
      ...(material.userData || {}),
      csmShaderUniforms: material.uniforms,
    };
    scene3d.csmState.patchedMaterials.add(material);
  }

  const lbMesh = new THREE.Mesh(geom, material);
  lbMesh.name = `terrain-lb-${lbX.toString(16)}-${lbY.toString(16)}`;
  // Visual-fidelity Phase 0.1 + 3.3 — flag the terrain mesh as a shadow
  // receiver under EITHER the single-shadow path (shadowsEnabled) OR
  // the CSM path (csmEnabled). CSM sampling is now injected directly
  // into the terrain ShaderMaterial above (the "deferred to Phase
  // 1.* / 2.*" gap is closed); building/static cast shadows land on
  // terrain when ?quality=high or ultra (csm flag on).
  if (scene3d.shadowsEnabled || scene3d.csmEnabled) {
    lbMesh.receiveShadow = true;
  }
  // Per-LB world offset (xy in metres). The geometry is LB-local
  // (x,y in [0, 192]) so the world position is just (lbX*192, lbY*192).
  lbMesh.position.set(
    lbX * METERS_PER_LANDBLOCK,
    lbY * METERS_PER_LANDBLOCK,
    0
  );
  // Stash height range on the userData so the capture can verify
  // terrain isn't flat-zero without a wasm round-trip.
  //
  // Task D (2026-05-12) — `terrainCodes` is the wasm column-major
  // 81-byte block (vertex `i` has gridX = i/9, gridY = i%9; see
  // `adapter.js::buildVertexTypesDataTexture` for the transpose note).
  // The ambient-runtime sampler reads this per tick to look up the
  // player's terrain type for the Region → AmbientSTB chain. Storing
  // the raw bytes (not the DataTexture) keeps the runtime free of
  // GPU readback — sampling is a single byte fetch per tick.
  // Has any vertex with a road bit set? Used by the post-bake summary
  // counter; previously inferred from the road-overlay child mesh
  // which no longer exists (roads are now painted in the terrain
  // shader via uVertexTypes.G).
  let hasRoads = false;
  for (let i = 0; i < roadCodesCopy.length; i += 1) {
    if (roadCodesCopy[i] !== 0) { hasRoads = true; break; }
  }
  lbMesh.userData = {
    lbX,
    lbY,
    lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
    heightMin,
    heightMax,
    vertexTypesTexture: vertexTypesTex,
    terrainCodes: terrainCodesCopy,
    roadCodes: roadCodesCopy,
    hasRoads,
    // Phase 1.2 — capture probes inspect this to verify the detail-
    // normal patch is wired without a GL state pull.
    detailNormalEnabled: opts.detailNormalEnabled,
    detailNormalSlice: opts.detailNormalEnabled ? "array(5)" : "off",
    // Phase 1.3 — same idea for triplanar wiring. `slopeLo`/`slopeHi`
    // come from the JS-side constants the GLSL is interpolated with;
    // captures use them to compute the expected smoothstep blend at
    // any given fragment without re-reading the shader source.
    triplanarEnabled: opts.triplanarEnabled,
    triplanarSharpness: opts.triplanarEnabled ? DEFAULT_TRIPLANAR_SHARPNESS : 0,
    // Perf D3 — opts-driven LO (per-quality) replaces the prior constant.
    // HI end is still the JS-side TRIPLANAR_SLOPE_HI baked into the
    // shader source.
    triplanarSlopeLo: opts.triplanarSlopeLo,
    triplanarSlopeHi: TRIPLANAR_SLOPE_HI,
    // Phase 2.1 — actual subdivision factor used for this LB.
    // 1 = no subdivision (legacy 9×9 path); 2/4/8 = subdivided.
    subdivLevel: effectiveSubdiv,
    // Phase 2.2 — capture probes inspect these to verify the
    // displacement patch is wired. uTime is mutated each rAF by
    // `loop.js::tickPerFrame`; the snapshot here records the wiring
    // state at build time.
    displacementEnabled: opts.displacementEnabled,
    waterCodeMask: opts.waterCodeMask,
    lavaCodeMask: opts.lavaCodeMask,
  };

  scene3d.terrainGroup.add(lbMesh);

  // Roads are now painted inside the terrain shader via the G-channel
  // of uVertexTypes + uRoadTexture (retail-style bilinear-blended,
  // naturally flush with the terrain surface). The prior road-overlay
  // mesh path is gone; see TERRAIN_FRAGMENT_GLSL's `uRoadEnabled` block.

  // Free the wasm mesh now that all needed data is copied. Skip if the
  // mesh came from the prefetch batch — the ring driver owns those and
  // will free them when its loop completes (avoids double-free).
  if (!opts.prefetchedMesh && typeof wasmMesh.free === "function") {
    wasmMesh.free();
  }

  return lbMesh;
}

/**
 * world-expand step 1 — terrain ring driver.
 *
 * Bakes every LB in the `(dx, dy) ∈ [-radius, +radius]² ∩ [0, 255]²`
 * ring around `(centreLbX, centreLbY)`. Resolves once-per-ring shader
 * uniforms / textures (atlas, road, codeToSliceArr, etc.) up front, then
 * batches the per-LB heightmap + subdiv fetches and fans out
 * `bakeTerrainForLandblock` via `Promise.all`.
 *
 * Returns the same summary shape `buildHoltburgTerrain` returned before
 * the refactor, plus `lbCount` reflecting the actual number of LBs in
 * the ring (radius=1 → 9; radius=6 → 169 at full ring, fewer at world
 * edges). The lbCount is the **ring size**, not necessarily the number
 * of LBs added in this call — re-bakes of an already-baked LB
 * short-circuit in `bakeTerrainForLandblock` and don't change the
 * children count of `terrainGroup`.
 *
 * Note on child order: prior `buildHoltburgTerrain` added children in
 * coord-traversal order (`dy:+1→-1, dx:-1→+1`). The ring driver still
 * issues the bakes in that order, but the `Promise.all` fan-out means
 * the actual `terrainGroup.children` order is microtask-resolution
 * order, not coord order. No caller relies on a specific index
 * (capture_phase7_1_terrain asserts only count; capture_visfid_p21_subdiv
 * finds the centre LB via `find(c => c.userData.lbX === 0xa9)`).
 */
export async function bakeTerrainRing(
  scene3d,
  centreLbX,
  centreLbY,
  radius,
  wasmExports
) {
  if (!scene3d || !scene3d.terrainGroup) {
    throw new Error(
      "bakeTerrainRing: scene3d.terrainGroup missing (call init3D first)"
    );
  }
  if (
    !wasmExports ||
    typeof wasmExports.fetch_landblock_heightmaps !== "function" ||
    typeof wasmExports.fetch_terrain_textures !== "function"
  ) {
    throw new Error(
      "bakeTerrainRing: wasmExports missing fetch_landblock_heightmaps / fetch_terrain_textures"
    );
  }

  // 1. Build the coord list. Order matches the prior
  // `holtburgNeighbourhoodCellIds` traversal at radius=1 so the
  // batch-fetch input array stays bit-identical to today's call.
  const coords = [];
  for (let dy = radius; dy >= -radius; dy -= 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const x = centreLbX + dx;
      const y = centreLbY + dy;
      if (x < 0 || x > 0xff || y < 0 || y > 0xff) continue;
      coords.push({
        x,
        y,
        id: ((x << 24) | (y << 16) | 0xffff) >>> 0,
      });
    }
  }

  // 2. Resolve once-per-ring opts (atlas/road textures, detail-normal
  // wiring, subdivision flags, water/lava bitmasks) BEFORE the
  // heightmap batch fetch so the per-LB baker can consume them straight
  // off `opts` without further async work.
  const opts = await resolveTerrainRingOpts(
    scene3d,
    wasmExports,
    centreLbX,
    centreLbY,
    null
  );

  // 3. Batch-fetch heightmaps for the whole ring in a single call —
  // matches today's `fetch_landblock_heightmaps(ids)` shape.
  const ids = new Uint32Array(coords.map((c) => c.id >>> 0));
  const meshes = await wasmExports.fetch_landblock_heightmaps(ids);
  if (meshes.length !== coords.length) {
    throw new Error(
      `bakeTerrainRing: expected ${coords.length} meshes, got ${meshes.length}`
    );
  }

  // 4. Batch-fetch subdivided meshes per LB (still per-call because the
  // wasm export is per-(cellId, level)). Centre LB gets full level;
  // outer LBs get half. Distance-keyed LOD is Objective 7's job.
  let subdivMeshes = null;
  if (opts.canSubdivide) {
    const promises = coords.map((c) => {
      const level = pickSubdivLevelForLb(opts, c.x, c.y);
      return wasmExports
        .fetch_subdivided_landblock(c.id, level)
        .then((m) => ({ mesh: m, level }))
        .catch((err) => {
          console.warn(
            `[terrain] subdivide failed for (${c.x},${c.y}) @ level=${level}:`,
            err
          );
          return null;
        });
    });
    subdivMeshes = await Promise.all(promises);
  }

  // 5. Fan out per-LB bakes. Each baker receives its prefetched
  // wasmMesh + subdivEntry via a shallow-copied `opts` so the once-
  // per-ring fields stay shared by reference and the per-LB prefetch
  // is the only per-call payload variation.
  const bakePromises = coords.map((c, i) => {
    const perLbOpts = {
      ...opts,
      prefetchedMesh: meshes[i],
      prefetchedSubdiv: subdivMeshes ? subdivMeshes[i] : null,
    };
    return bakeTerrainForLandblock(scene3d, c.x, c.y, perLbOpts, wasmExports);
  });
  const lbMeshes = await Promise.all(bakePromises);

  // Free the prefetched base wasm meshes the ring driver owns. The
  // per-LB baker skips freeing prefetched meshes specifically so this
  // loop is the single owner and avoids double-free.
  for (const wasmMesh of meshes) {
    if (wasmMesh && typeof wasmMesh.free === "function") {
      try {
        wasmMesh.free();
      } catch (_) {
        // Already-freed wasm structs throw; swallow because we own
        // single-free here and the alternative is leaking memory if a
        // future refactor stops returning fresh handles per call.
      }
    }
  }

  // Count roads after the bake so the summary stays in sync with the
  // prior `buildHoltburgTerrain` return shape. Roads are painted in the
  // terrain shader now (no separate overlay child); the per-mesh
  // `userData.hasRoads` flag was set during bake from roadCodes.
  let lbWithRoads = 0;
  for (const m of lbMeshes) {
    if (m?.userData?.hasRoads) lbWithRoads += 1;
  }

  // Stash on the scene3d for later phases (Phase 7.5 camera, Phase 7.7
  // cleanup, and the lazy LB-entry path that Objective 6 will wire).
  scene3d.terrainAtlasTexture = opts.atlasTexture;
  scene3d.terrainRoadTexture = opts.roadTexture;
  scene3d.terrainRoadCanvas = opts.roadCanvas;
  scene3d.terrainLbCount = coords.length;
  // Persist the resolved ring opts so the lazy LB-entry hook (Objective
  // 6) can call `bakeTerrainForLandblock` without redoing the canvas /
  // detail-normal / bitmask work. The lazy hook should rebuild only the
  // per-LB prefetch fields (`prefetchedMesh`, `prefetchedSubdiv`) before
  // calling the baker.
  scene3d.terrainOpts = opts;

  return {
    atlasTexture: opts.atlasTexture,
    roadTexture: opts.roadTexture,
    roadCanvas: opts.roadCanvas,
    lbCount: coords.length,
    lbWithRoads,
  };
}

/**
 * Build the Holtburg 9-LB terrain (heightfield meshes + bilinear-blend
 * shader + per-LB vertex-types texture + road overlays) and add it to
 * `scene3d.terrainGroup`.
 *
 * Returns a summary `{ atlasTexture, roadTexture, lbCount, roadCanvas }`
 * with the shared atlas / road textures stashed for later phases
 * (Phase 7.5 camera, Phase 7.7 cleanup) to reuse.
 *
 * world-expand step 1 (Objective 2): preserved as a thin radius=1
 * wrapper around `bakeTerrainRing`. Existing captures + smoke tests
 * call this directly and rely on the 9-LB Holtburg behaviour; the lazy
 * LB-entry / per-LB-baker symbol is the new `bakeTerrainForLandblock`.
 */
export async function buildHoltburgTerrain(scene3d, wasmExports) {
  return bakeTerrainRing(scene3d, HOLTBURG_X, HOLTBURG_Y, 1, wasmExports);
}

// ---------------------------------------------------------------------
// Visual-vs-collision Z reconciliation.
//
// Phase 2.1 subdivision interpolates 9×9 control heights with a bicubic
// Catmull-Rom basis. The resulting visual surface deviates from the
// 24 m bilinear collision surface by up to ±VISUAL_VS_COLLISION_MAX_M
// (= 0.3 m, clamped server-side at terrain_subdiv.rs). Physics
// (`WorldState::terrain_height_at`) queries bilinear; the rendered mesh
// is Catmull-Rom. So a player at the bilinear standing-Z appears to
// sink up to 0.3 m into a Catmull-Rom peak, or float over a Catmull-Rom
// valley dip.
//
// `getTerrainVisualZ` casts a vertical ray against the rendered terrain
// group and returns the visible surface Z at (x, y). Callers (loop.js's
// player pose appliers) substitute this for the bilinear Z when
// positioning the rendered avatar, while leaving the server-
// authoritative collision pose unchanged.
//
// Cost: one raycast per call. THREE's bounding-sphere broad-phase skips
// every LB whose mesh doesn't intersect the vertical ray (only the
// 1–2 LBs directly under the query XY get triangle-tested), so per-
// frame cost is ~one LB's worth of triangle tests — sub-millisecond
// at subdivLevel=8 (≈8K tris/LB).
// ---------------------------------------------------------------------

const _terrainVisualRaycaster = new THREE.Raycaster();
const _terrainVisualRayOrigin = new THREE.Vector3();
const _terrainVisualRayDir = new THREE.Vector3(0, 0, -1);
const _terrainVisualIntersects = [];

export function getTerrainVisualZ(scene3d, x, y, fallbackZ) {
  const group = scene3d?.terrainGroup;
  if (!group || !group.children || group.children.length === 0) {
    return fallbackZ;
  }
  // Cast from well above any plausible terrain height (Holtburg ~96 m
  // peak; AC overall ~200 m max) so the ray origin is always above
  // the surface.
  _terrainVisualRayOrigin.set(x, y, 1000);
  _terrainVisualRaycaster.set(_terrainVisualRayOrigin, _terrainVisualRayDir);
  _terrainVisualRaycaster.far = 2000;
  _terrainVisualIntersects.length = 0;
  _terrainVisualRaycaster.intersectObject(
    group,
    true,
    _terrainVisualIntersects
  );
  if (_terrainVisualIntersects.length === 0) return fallbackZ;
  const z = _terrainVisualIntersects[0].point.z;
  _terrainVisualIntersects.length = 0;
  return Number.isFinite(z) ? z : fallbackZ;
}
