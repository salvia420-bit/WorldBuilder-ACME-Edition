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
// Roads are rendered as a thin triangle-strip overlay mesh, lifted
// 0.1 m above terrain to avoid Z-fighting. Mirrors the directional
// scan from `index.html:2113-2176` (E / N / NE / NW pairs), but uses
// triangle pairs instead of `PIXI.Graphics` strokes.

import * as THREE from "three";
import {
  landblockMeshToGeometry,
  subdividedLandblockMeshToGeometry,
  buildVertexTypesDataTexture,
  buildTerrainAtlasCanvas,
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
// Below `TRIPLANAR_SLOPE_LO`, pure grid-UV sampling. Above
// `TRIPLANAR_SLOPE_HI`, pure triplanar. Between, `smoothstep` lerp.
// 0.2 / 0.5 mirrors the hand-off-note recommendation; 0.2 ≈ 11° from
// horizontal (treats gentle rises as flat), 0.5 ≈ 30° (point at which
// stretching becomes objectionable).
//
// Triplanar sharpness 6.0 is the centre of the 4-8 sweet spot per the
// hand-off note. Lower values produce muddy blends; higher values
// produce hard seams at 45°.
const TRIPLANAR_SLOPE_LO = 0.2;
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
  // Phase 2.2 — quality-gated time-varying displacement on water + lava
  // terrain. uDisplacementEnabled is 0.0 when subdivLevel < 2 (the
  // vertices are 24 m apart at level 1 and the wave wavelength would
  // exceed the screen). The bitmask lookups are 32-bit shifts; both
  // masks are constructed JS-side from the TERRAIN_WATER_CODES /
  // TERRAIN_LAVA_CODES sets so the GLSL stays free of per-code if/elif
  // chains.
  if (uDisplacementEnabled > 0.5 && code >= 0 && code < 32) {
    int bit = 1 << code;
    // World-frame XY = per-LB origin + LB-local position. Using the
    // world frame (not LB-local) is what makes the wave continuous
    // across LB seams when paired with the shared uTime: matching
    // world coords on either side of the seam evaluate to the same
    // wave phase.
    vec2 worldXy = uLbOriginXy + position.xy;
    if ((uWaterCodeMask & bit) != 0) {
      // Two-wavelet sine sum at different frequencies + phases. Total
      // envelope ~0.25 m, well under the 0.4 m plan-doc cap.
      float wave = sin(uTime * 0.5 + worldXy.x * 0.1) * 0.15
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
  gl_Position = projectionMatrix * modelViewMatrix * vec4(displacedPos, 1.0);
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

uniform sampler2D uAtlas;             // 6×6 grid of 256×256 retail terrain tiles
uniform vec2 uAtlasGridSize;          // (cols, rows) — typically (6, 6)
uniform sampler2D uVertexTypes;       // 9×9 RGBA8: R = terrain type byte, A = 255

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

in vec2 vGridUv;
in vec3 vWorldPos;
flat in int vTerrainCode;             // provoking-vertex terrain code
in vec3 vAcPos;                       // Phase 1.3 — LB-local AC pos (z=up)
in vec3 vAcNormal;                    // Phase 1.3 — geometry normal (AC z-up)
flat in int vIsWater;                 // Phase 2.2 — 1 if water, 0 otherwise

out vec4 fragColor;

// Map terrain code (0..32) → atlas UV at the given cell-local UV.
// Retail terrain atlas is a 6×6 grid; tile index = code.
vec2 atlasUvFor(int code, vec2 cellUv) {
  int cols = int(uAtlasGridSize.x);
  int col = code - (code / cols) * cols;
  int row = code / cols;
  vec2 origin = vec2(float(col), float(row)) / uAtlasGridSize;
  vec2 size = vec2(1.0) / uAtlasGridSize;
  return origin + size * cellUv;
}

int vertexTypeAt(int iu, int iv) {
  return int(texelFetch(uVertexTypes, ivec2(iu, iv), 0).r * 255.0 + 0.5);
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

  vec3 c00 = texture(uAtlas, atlasUvFor(clamp(t00, 0, 32), uv00)).rgb;
  vec3 c10 = texture(uAtlas, atlasUvFor(clamp(t10, 0, 32), uv10)).rgb;
  vec3 c01 = texture(uAtlas, atlasUvFor(clamp(t01, 0, 32), uv01)).rgb;
  vec3 c11 = texture(uAtlas, atlasUvFor(clamp(t11, 0, 32), uv11)).rgb;

  float w00 = (1.0 - fu) * (1.0 - fv);
  float w10 = fu * (1.0 - fv);
  float w01 = (1.0 - fu) * fv;
  float w11 = fu * fv;

  vec3 result = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;

  // Phase 2.2 — water tint shift. Subtle bluish modulation that breathes
  // over time (period ~21 s at uTime * 0.3). Only applied on water-
  // flagged provoking vertices; non-water surfaces stay colour-stable.
  if (uDisplacementEnabled > 0.5 && vIsWater == 1) {
    vec3 tint = mix(vec3(0.9, 0.95, 1.05), vec3(1.0, 1.0, 1.0),
                    0.5 + 0.5 * sin(uTime * 0.3));
    result *= tint;
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

  // Sun-direction approximation — we don't yet expose the skybox's
  // dir_heading/dir_pitch driver here; phase 2.x sky_lighting work
  // owns the unified sun uniform. For now, fix a light-from-above-and-
  // slightly-southwest direction so NdotL is non-trivial against a
  // (0, 0, 1) surface normal.
  vec3 sunDir = normalize(vec3(-0.4, -0.3, 1.0));

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
        ? smoothstep(${TRIPLANAR_SLOPE_LO.toFixed(3)}, ${TRIPLANAR_SLOPE_HI.toFixed(3)}, slope)
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

  fragColor = vec4(result * ndotl * cloudShadow, 1.0);
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

/**
 * Build a thin triangle-strip road overlay mesh for one landblock.
 *
 * Mirrors the 2D vector-stroke pass at `index.html:2113-2176`. For
 * each vertex with `roadCode != 0`, emit a thin quad (two triangles)
 * to its E / N / NE / NW neighbour if that neighbour is also road.
 *
 * Quad construction: take the 3D segment from vertex A to vertex B
 * (xy from `positions`, z = height + 0.1 m to lift above terrain),
 * compute a 2D perpendicular in the xy plane, and emit two corner
 * pairs (A±perp*halfWidth, B±perp*halfWidth) as a 2-triangle quad.
 * Z lift dodges Z-fighting against the heightfield without needing
 * `polygonOffset` (which works but is fiddly per-driver).
 *
 * Returns null if the LB has no roads (skips the empty-mesh allocation
 * + draw-call cost). Holtburg has roads in every LB per the 2D
 * `render-preview` baseline, but neighbouring LBs may not.
 */
function buildRoadOverlayMesh(positions, roadCodes, roadTexture) {
  const halfWidth = 0.75; // 1.5 m total — matches 2D `width: 1.5`.
  // Phase 2.1 carry-over + Phase 2.2 follow-on (2026-05-13): the road
  // overlay walks the 9×9 control grid (NOT the subdivided heights), so
  // when subdivLevel>=2 raises terrain vertices up to ±0.3 m via clamped
  // noise (`terrain_subdiv.rs::VISUAL_VS_COLLISION_MAX_M`), the original
  // 0.1 m lift was insufficient to clear z-fight on hilly LBs. Raised
  // to 0.4 m so the road stays cleanly above the subdivision noise (the
  // road is also rendered with polygonOffset as a belt-and-braces
  // safety). Phase 2.2 water displacement adds another ±0.25 m envelope
  // but only on water-typed cells; Holtburg roads don't cross water
  // cells in retail, so the 0.4 m road lift suffices. Routing the road
  // overlay THROUGH the subdivided heights would be cleaner (no fixed
  // lift) but non-trivial — no per-grid-vertex correspondence in the
  // subdivided mesh — and is deferred to a future phase.
  const liftZ = 0.4;
  const ROAD_DIRS = [
    [1, 0],
    [0, 1],
    [1, 1],
    [-1, 1],
  ];

  const verts = [];
  const indices = [];
  const uvs = [];

  let edgeCount = 0;
  // Tile the road texture every 6 m along each segment, mirroring the
  // 2D path's `ROAD_TEXTURE_TILE_M = 6.0`. Native tile is sampled with
  // RepeatWrapping in the caller; the V coord goes [0, halfWidth*2 / TILE]
  // across the stroke width, U progresses by segment length / TILE.
  const TILE_M = 6.0;
  for (let vv = 0; vv < 9; vv += 1) {
    for (let vu = 0; vu < 9; vu += 1) {
      const idx = vv * 9 + vu;
      if (!roadCodes[idx]) continue;
      for (const [du, dv] of ROAD_DIRS) {
        const nu = vu + du;
        const nv = vv + dv;
        if (nu < 0 || nu > 8 || nv < 0 || nv > 8) continue;
        const nIdx = nv * 9 + nu;
        if (!roadCodes[nIdx]) continue;

        const ax = positions[idx * 3 + 0];
        const ay = positions[idx * 3 + 1];
        const az = positions[idx * 3 + 2] + liftZ;
        const bx = positions[nIdx * 3 + 0];
        const by = positions[nIdx * 3 + 1];
        const bz = positions[nIdx * 3 + 2] + liftZ;

        const dx = bx - ax;
        const dy = by - ay;
        const len = Math.hypot(dx, dy);
        if (len < 1e-4) continue;

        // 2D perpendicular in the xy plane. Rotate (dx, dy) by 90°.
        const px = -dy / len;
        const py = dx / len;
        const ox = px * halfWidth;
        const oy = py * halfWidth;

        const base = (verts.length / 3) | 0;
        // 4 corners: A-left, A-right, B-left, B-right.
        verts.push(ax + ox, ay + oy, az);
        verts.push(ax - ox, ay - oy, az);
        verts.push(bx + ox, by + oy, bz);
        verts.push(bx - ox, by - oy, bz);

        const uMax = len / TILE_M;
        const vMax = (halfWidth * 2) / TILE_M;
        // UVs: U progresses along the segment, V across the stroke.
        // Left edge V=0, right V=vMax.
        uvs.push(0, 0, 0, vMax, uMax, 0, uMax, vMax);

        // Two triangles, CCW from the +Z-up side (terrain side).
        indices.push(base + 0, base + 1, base + 2);
        indices.push(base + 1, base + 3, base + 2);

        edgeCount += 1;
      }
    }
  }

  if (edgeCount === 0) return null;

  const geom = new THREE.BufferGeometry();
  geom.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(verts), 3, false)
  );
  geom.setAttribute(
    "uv",
    new THREE.BufferAttribute(new Float32Array(uvs), 2, false)
  );
  geom.setIndex(
    new THREE.BufferAttribute(new Uint32Array(indices), 1)
  );
  geom.computeBoundingSphere();

  // Polygon offset belt-and-braces with the 0.1 m Z lift. polygonOffset
  // handles cases where the lift gets compressed by clip-space depth
  // precision at long view distances.
  const mat = roadTexture
    ? new THREE.MeshBasicMaterial({
        map: roadTexture,
        transparent: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    : new THREE.MeshBasicMaterial({
        color: 0xc8b888,
        transparent: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      });

  const mesh = new THREE.Mesh(geom, mat);
  mesh.name = "road-overlay";
  return mesh;
}

// ----- world-expand step 1 — once-per-ring shader uniform constants
//
// Shared by every per-LB material the ring bakes. Lifted out of the
// inner loop so the ring driver builds them once and threads them via
// `opts` to `bakeTerrainForLandblock` rather than recomputing per LB.
const ATLAS_GRID_SIZE = new THREE.Vector2(6, 6);

/**
 * Resolve the once-per-ring opts the per-LB baker consumes. Reads
 * quality flags / detail-normal array off `scene3d`, computes the
 * shared bitmasks, and (optionally) builds the atlas + road textures
 * from the wasm `fetch_terrain_textures()` payload.
 *
 * Callers that already have an atlas/road texture pair (e.g. the lazy
 * hook reusing a previously baked ring's textures) should pass them via
 * `existing.atlasTexture` / `existing.roadTexture` / `existing.atlasCanvas`
 * / `existing.roadCanvas` to skip the canvas + texture build.
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
  // textures here so we don't redo the canvas work.
  let atlasTexture = existing?.atlasTexture ?? null;
  let roadTexture = existing?.roadTexture ?? null;
  let atlasCanvas = existing?.atlasCanvas ?? null;
  let roadCanvas = existing?.roadCanvas ?? null;
  if (!atlasTexture) {
    const terrainTextures = await wasmExports.fetch_terrain_textures();
    const canvases = buildTerrainAtlasCanvas(terrainTextures);
    atlasCanvas = canvases.atlasCanvas;
    roadCanvas = canvases.roadCanvas;

    atlasTexture = new THREE.CanvasTexture(atlasCanvas);
    // Atlas tiles are colour data — sRGB so three's renderer linearises
    // them before the fragment shader does its bilinear blend.
    atlasTexture.colorSpace = THREE.SRGBColorSpace;
    atlasTexture.magFilter = THREE.LinearFilter;
    atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
    atlasTexture.generateMipmaps = true;
    // THREE.CanvasTexture defaults flipY=true so the GPU vertically
    // mirrors the canvas at upload. The fragment shader's
    // `atlasUvFor(code, ...)` packs slots as `row = code/6`; with
    // flipY=true every code C ends up sampling slot `(5 - C/6)*6 +
    // C%6` instead of slot C — e.g. Grassland (1) → DesolateLands (31),
    // LushGrass (3) → empty slot 33 (black), PatchyGrassland (9) →
    // BlueIce (27, cyan). Matches adapter.js's surface-texture pattern
    // (flipY=false at lines 588 / 644 / 691). Latent since the initial
    // Phase 7.1 3D port; surfaced visually once the 13×13 ring (commit
    // 2bbb0ad) exposed enough non-water LBs to show the discrepancy.
    atlasTexture.flipY = false;
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
    codeToSliceArr,
    subdivLevel,
    canSubdivide,
    displacementEnabled,
    waterCodeMask,
    lavaCodeMask,
    atlasTexture,
    roadTexture,
    atlasCanvas,
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

  // 3. Snapshot what we need from the wasm mesh BEFORE freeing it. The
  // adapter copies the buffers into BufferAttributes, but the road
  // overlay needs raw `positions` + `roadCodes` to walk neighbours;
  // copy those once here so we can free the wasm struct safely.
  const positionsCopy = Float32Array.from(wasmMesh.positions);
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
  const vertexTypesTex = buildVertexTypesDataTexture(terrainCodesCopy);

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
      uAtlasGridSize: { value: ATLAS_GRID_SIZE },
      uVertexTypes: { value: vertexTypesTex },
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

  const lbMesh = new THREE.Mesh(geom, material);
  lbMesh.name = `terrain-lb-${lbX.toString(16)}-${lbY.toString(16)}`;
  // Visual-fidelity Phase 0.1 + 3.3 — flag the terrain mesh as a shadow
  // receiver under EITHER the single-shadow path (shadowsEnabled) OR
  // the CSM path (csmEnabled). Note: the terrain's custom GLSL3
  // ShaderMaterial does NOT currently honour the flag (it skips three's
  // shadow chunks); this is documented in the Phase 0.1 plan as
  // deferred to Phase 1.* / 2.*. Phase 3.3 inherits the same gap — to
  // render shadows on terrain, the custom shader needs explicit CSM
  // sampling injected. Out of scope for the initial Phase 3.3 push;
  // tracked in the report doc.
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
  lbMesh.userData = {
    lbX,
    lbY,
    lbId: ((lbX << 24) | (lbY << 16) | 0xffff) >>> 0,
    heightMin,
    heightMax,
    vertexTypesTexture: vertexTypesTex,
    terrainCodes: terrainCodesCopy,
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
    triplanarSlopeLo: TRIPLANAR_SLOPE_LO,
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

  // Group keeps the road overlay parented under the same lbMesh
  // transform — simpler than a sibling group, and toggling
  // `lbMesh.visible` still hides both atomically.
  scene3d.terrainGroup.add(lbMesh);

  const roadMesh = buildRoadOverlayMesh(
    positionsCopy,
    roadCodesCopy,
    opts.roadTexture
  );
  if (roadMesh) {
    lbMesh.add(roadMesh);
  }

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
  // prior `buildHoltburgTerrain` return shape.
  let lbWithRoads = 0;
  for (const m of lbMeshes) {
    if (!m) continue;
    for (const child of m.children) {
      if (child?.name === "road-overlay") {
        lbWithRoads += 1;
        break;
      }
    }
  }

  // Stash on the scene3d for later phases (Phase 7.5 camera, Phase 7.7
  // cleanup, and the lazy LB-entry path that Objective 6 will wire).
  scene3d.terrainAtlasTexture = opts.atlasTexture;
  scene3d.terrainRoadTexture = opts.roadTexture;
  scene3d.terrainAtlasCanvas = opts.atlasCanvas;
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
    atlasCanvas: opts.atlasCanvas,
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
 * Returns a summary `{ atlasTexture, roadTexture, lbCount, atlasCanvas,
 * roadCanvas }` with the shared atlas / road textures stashed for later
 * phases (Phase 7.5 camera, Phase 7.7 cleanup) to reuse.
 *
 * world-expand step 1 (Objective 2): preserved as a thin radius=1
 * wrapper around `bakeTerrainRing`. Existing captures + smoke tests
 * call this directly and rely on the 9-LB Holtburg behaviour; the lazy
 * LB-entry / per-LB-baker symbol is the new `bakeTerrainForLandblock`.
 */
export async function buildHoltburgTerrain(scene3d, wasmExports) {
  return bakeTerrainRing(scene3d, HOLTBURG_X, HOLTBURG_Y, 1, wasmExports);
}
