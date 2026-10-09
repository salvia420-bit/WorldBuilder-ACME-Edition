// scene3d/ibl_environment.js — T3 (terrainplan.md, 2026-07-28): image-based
// lighting from the Bruneton sky. Opt-in `?ibl=on` (strict), default OFF.
//
// What this adds on top of the existing Sky-K.3 lighting (which already
// provides DIFFUSE sky irradiance via the takram SkyLightProbe SH):
//
//   1. `scene.environment` — a PMREM render of `skyDome.skyScene`, so every
//      MeshStandardMaterial (statics / buildings / creatures) gains indirect
//      SPECULAR (and env-driven indirect diffuse). Refreshed at low cadence
//      as the day cycle moves — not per frame.
//   2. A small mipmapped HDR cube (`envCubeTexture`) of the same sky for the
//      custom terrain ShaderMaterial, which can't consume three's PMREM
//      chunks. terrain.js samples it for a per-layer gloss term (ice/snow).
//   3. Diffuse ownership handoff: with `scene.environment` set, three feeds
//      standard materials indirect diffuse FROM THE ENV MAP, so the
//      SkyLightProbe would double-count ambient. While active this mutes the
//      probe (intensity 0 — the LIGHT LIST IS NEVER CHANGED, honoring the
//      frozen-light-count invariant in lighting.js) and drives
//      `scene.environmentIntensity` from the same retail diurnal ambient
//      term the probe used (AtmosphereLights.lastProbeIntensity), keeping
//      the L1 ambBright curve + 0.2 night floor contract intact.
//
// Cost model: one PMREM fromScene + one 6-face cube render every
// `refreshMs` (default 15000 — matches the retail 15 s light tick that
// tickTerrainSunDir already quantises to). Zero per-frame draw calls.
// First `scene.environment` assignment recompiles standard materials once
// (envMap define toggles on); subsequent refreshes swap texture objects
// only — no recompiles.

import * as THREE from "three";
// NIGHT RAMP (2026-08-02, ?nightRamp / ?nightEnv). `lastProbeIntensity` is
// arithmetically PINNED at exactly 0.2 for the whole AC day — it is
// max(0.2, max(0.2, ambBright) * worldLightScale) and Dereth's ambBright never
// exceeds 0.5, so the 0.4 world-light scale pushes the signal below the 0.2
// floor it is then re-clamped to. Characters, statics and the terrain env term
// therefore get IDENTICAL indirect fill at noon and at midnight. This applies
// the missing diurnal term as a multiplier on the indirect path ONLY: placed
// lights and emissive surfaces are absolute and stay exactly as authored, so
// hearths and lit windows gain contrast instead of being crushed with the rest.
import { nightFactorFromAuthoredPitch, nightEnvScale, nightRampEnabled } from "./night_ramp.js";
import { getWarmTarget, compileWithTarget, programsOf, programPending, prunePending, warmSceneMaterials } from "./shader_prewarm.js";

/**
 * 2026-10-09 `?pmremPrecompile` (DEFAULT ON; `off|0|false|no` escape) — the
 * IBL's programs link off the main thread instead of inside a refresh.
 * Measured on the 1070 (academy cold spawn, acad-diagF): the FIRST refresh is a
 * 1,095 ms long task inside tickPerFrame, 933 ms of it in getProgramParameter —
 * PMREMGGXConvolution 761 ms, SkyMaterial 120, SphericalGaussianBlur 104,
 * PMREM.Background 14 — and the second one (15 s later) another 427 ms for the
 * sky members that arrived meanwhile (StarsMaterial 113 ms after the stars.bin
 * fetch, the two AC moon billboards 314 ms after holdForGround).
 *
 * ON: the constructor pre-allocates the PMREM generator's targets (three r184
 * builds its GGX / blur ShaderMaterials there) and `warmPrograms()` compiles
 * them, a proxy of three's PMREM.Background box material, and every sky-scene
 * member the PMREM / cube camera draws (clip-space overlays excluded) against
 * the shared non-null warm target — the variant a cubeUV / cube render target
 * keys. A refresh (and the clouds cube update) that comes due while any of
 * those programs is still linking waits for it, polling three's non-blocking
 * isReady(), at most PMREM_WAIT_MAX_MS; the sky is re-warmed
 * PMREM_WARM_LEAD_MS before each refresh so new members are usually linked
 * by then. Off: every refresh links what it meets synchronously (today).
 */
export function readPmremPrecompileFlag(search) {
  try {
    const s = search ?? (typeof window !== "undefined" && window.location ? window.location.search : "");
    const v = new URLSearchParams(s || "").get("pmremPrecompile");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}
/** A refresh waits at most this long for still-linking sky / PMREM programs. */
export const PMREM_WAIT_MAX_MS = 2000;
/** The sky is re-warmed this long before a refresh is due (≤ 1 call/s). */
export const PMREM_WARM_LEAD_MS = 2500;
/** fromScene's default cube size (three r184) — the size the targets are pre-allocated for. */
export const PMREM_SIZE = 256;
const _isClipSpaceOverlay = (o) => o?.userData?.__clipSpaceOverlay === true;

export function readIblFlag() {
  // DEFAULT ON as of 2026-07-28 (escape `?ibl=off`) after the off-screen
  // 1070 pass together with ?pbrTerrain — the `!== "off"` shape is the
  // DELIBERATE default-on idiom (url-flags.md 2026-07-23 box). Still a
  // no-op when the atmosphere stack is absent (construct site guards on
  // skyDome.skyScene + atmosphereLights).
  try {
    if (typeof window === "undefined" || !window.location) return true;
    const v = new URLSearchParams(window.location.search).get("ibl");
    return !(typeof v === "string" && v.toLowerCase() === "off");
  } catch (_) {
    return true;
  }
}

export function readIblRefreshMs() {
  try {
    const v = Number.parseFloat(
      new URLSearchParams(window.location.search).get("iblRefreshMs")
    );
    return Number.isFinite(v) && v >= 1000 ? v : 15000;
  } catch (_) {
    return 15000;
  }
}

const ENV_CUBE_SIZE = 128;

/**
 * 2026-10-08 `?waterClouds` (DEFAULT ON; `=off` escape) — composite the
 * volumetric clouds into the terrain env cube, so water mirrors the real cloud
 * deck and a moon (or a patch of bright sky) that a cloud covers on screen is
 * covered in the reflection too. Owner on the 1070 at the coast, a storm night:
 * "it also shouldn't work when clouds are blocking it" — the cube is a render
 * of the clear sky scene alone (the takram clouds are a screen-space post
 * effect), so the water reflected a moon the clouds hid.
 */
export function readWaterCloudsFlag(search) {
  try {
    const s = search ?? (typeof window !== "undefined" && window.location ? window.location.search : "");
    const v = new URLSearchParams(s || "").get("waterClouds");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

/** Terrain-cube cadence while clouds are composited (the PMREM keeps refreshMs). */
export const CLOUD_CUBE_REFRESH_MS = 1000;

// The composite: one fullscreen quad per cube face. Each texel takes its own
// direction (the face camera that rendered it), projects that direction into
// the MAIN camera's view and, where it lands on screen, blends the clouds
// buffer over the clear sky exactly as AerialPerspective does on screen
// (premultiplied: dst = cloud.rgb + dst * (1 - cloud.a)). Directions the main
// view cannot see take the mean of the upper screen's clouds (12 taps), so an
// overcast sky still overcasts the reflection of what is above the frame.
export const CLOUD_COMPOSITE_VERT = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;
export const CLOUD_COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uClouds;
uniform mat4 uFaceInvProj;
uniform mat4 uFaceWorld;
uniform mat4 uViewProj;
uniform vec3 uViewPos;
varying vec2 vNdc;
vec4 offscreenClouds() {
  vec4 acc = vec4(0.0);
  for (int i = 0; i < 4; i++) {
    for (int j = 0; j < 3; j++) {
      acc += texture2D(uClouds, vec2(0.125 + 0.25 * float(i), 0.6 + 0.15 * float(j)));
    }
  }
  return acc / 12.0;
}
void main() {
  vec4 v = uFaceInvProj * vec4(vNdc, 1.0, 1.0);
  vec3 dir = normalize(mat3(uFaceWorld) * (v.xyz / v.w));
  vec4 clip = uViewProj * vec4(uViewPos + dir * 1.0e4, 1.0);
  vec4 c = offscreenClouds();
  if (clip.w > 0.0) {
    vec2 uv = clip.xy / clip.w * 0.5 + 0.5;
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) c = texture2D(uClouds, uv);
  }
  c.a = clamp(c.a, 0.0, 1.0);
  c.rgb = max(c.rgb, vec3(0.0));
  gl_FragColor = c;
}`;

export class IblEnvironment {
  /**
   * @param {Object} opts
   * @param {THREE.WebGLRenderer} opts.renderer
   * @param {THREE.Scene} opts.scene — the world scene (environment sink)
   * @param {THREE.Scene} opts.skyScene — skyDome.skyScene (environment source)
   * @param {import('./atmosphere_lights.js').AtmosphereLights} [opts.atmosphereLights]
   * @param {number} [opts.refreshMs=15000]
   * @param {THREE.Camera} [opts.camera] the viewer; both products render from
   *   its position (2026-10-08 — see refresh()). Omitted: the world origin.
   * @param {() => (THREE.Texture|null)} [opts.getCloudsBuffer] the volumetric
   *   clouds' screen buffer for the composite (`?waterClouds`); null = none.
   */
  constructor({ renderer, scene, skyScene, atmosphereLights, refreshMs = 15000, camera = null, getCloudsBuffer = null }) {
    if (!renderer || !scene || !skyScene) {
      throw new Error("IblEnvironment: renderer, scene and skyScene are required");
    }
    this.renderer = renderer;
    this.scene = scene;
    this.skyScene = skyScene;
    this.atmosphereLights = atmosphereLights ?? null;
    this.refreshMs = refreshMs;
    this.camera = camera ?? null;
    this._viewPos = new THREE.Vector3();
    this.getCloudsBuffer = typeof getCloudsBuffer === "function" ? getCloudsBuffer : null;
    this.waterClouds = readWaterCloudsFlag();
    this._cloudComposite = null; // lazy {scene, cam, mat}
    this._lastCubeMs = -Infinity;
    this.cloudComposites = 0;

    this._pmrem = new THREE.PMREMGenerator(renderer);
    this._pmrem.compileCubemapShader();
    this._pmremRT = null;

    // HDR half-float — the takram sky writes physical radiance well above
    // 1.0; an RGBA8 cube would clip the sun-side sky and kill the sparkle
    // the terrain gloss term exists for.
    this._cubeRT = new THREE.WebGLCubeRenderTarget(ENV_CUBE_SIZE, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this._cubeRT.texture.name = "scene3d-ibl-env-cube";
    // Near/far span the sky-scene content: the SkyMaterial quad is
    // clip-space (unaffected) but the stars Points sit at a large radius.
    this._cubeCam = new THREE.CubeCamera(0.1, 1e7, this._cubeRT);
    this.envCubeTexture = this._cubeRT.texture;

    this._lastRefreshMs = -Infinity;
    this.refreshCount = 0;

    // ?pmremPrecompile — see readPmremPrecompileFlag.
    this.pmremPrecompile = readPmremPrecompileFlag();
    this._warmSeen = new WeakMap(); // material -> keys compiled (shader_prewarm.warmSceneMaterials)
    this._warmPending = new Set(); // programs still linking
    this._warmCam = null;
    this._warmFlat = null;
    this._warmMeshes = null; // WeakMap material -> proxy mesh (PMREM internals)
    this._bgProxy = null;
    this._pmremWarmed = false;
    this._lastWarmMs = -Infinity;
    this._waitSince = -1;
    this._firstDueMs = -1;
    // Diag (liveScene3d.iblEnvironment.warmStats): calls, materials compiled,
    // programs still linking, ticks a due refresh / cube update waited, waits
    // cut by the cap, how long the FIRST refresh waited (ms), and whether the
    // PMREM internals were reachable (three r184 private API).
    this.warmStats = { calls: 0, compiled: 0, pending: 0, waitTicks: 0, waitCapped: 0, firstWaitMs: -1, pmremInternals: false };
    if (this.pmremPrecompile) {
      try { this.warmPrograms(); } catch (_) { /* fail-soft: the refresh links as before */ }
    }

    if (this.atmosphereLights) this.atmosphereLights.iblOwnsDiffuse = true;
  }

  /**
   * ?pmremPrecompile: start linking every program a refresh will use (see
   * readPmremPrecompileFlag) and return the ones still linking. Cheap to call
   * again: only new / changed sky members are compiled (version-keyed), the
   * PMREM internals once. Also called by portal_space.js's tunnel warm
   * (`?tunnelWorldWarm`), which always warms the sky; the PMREM internals only
   * under this flag. Never blocks: no LINK_STATUS read, no getUniforms.
   * @returns {Array} programs still linking
   */
  warmPrograms(nowMs) {
    const r = this.renderer;
    this.warmStats.calls += 1;
    this._lastWarmMs = Number.isFinite(nowMs) ? nowMs : (typeof performance !== "undefined" ? performance.now() : Date.now());
    if (!r || typeof r.compile !== "function") return [];
    const target = getWarmTarget();
    const add = (mats) => {
      if (!mats) return;
      mats.forEach((m) => {
        for (const p of programsOf(r, m)) if (programPending(p)) this._warmPending.add(p);
      });
    };
    if (this.pmremPrecompile && !this._pmremWarmed) {
      this._pmremWarmed = true;
      add(this._warmPmremInternals(target));
    }
    if (!this._warmCam) this._warmCam = new THREE.PerspectiveCamera(90, 1, 0.1, 1e7);
    const res = warmSceneMaterials(r, this.skyScene, this._warmCam, target, { seen: this._warmSeen, skip: _isClipSpaceOverlay });
    this.warmStats.compiled += res.compiled;
    add(res.materials);
    this.warmStats.pending = prunePending(this._warmPending);
    return [...this._warmPending];
  }

  // three r184 PMREMGenerator builds its GGX + blur materials (and the ping-pong
  // target) lazily in `_allocateTargets()` on the first fromScene; do that now
  // for fromScene's default size so the very materials the refresh will draw
  // exist to be compiled, plus a key-identical proxy of the lazily built
  // PMREM.Background box material (MeshBasic, BackSide, drawn as its own scene).
  // Private API, feature-checked: absent → only the proxy and the sky warm.
  _warmPmremInternals(target) {
    const pm = this._pmrem;
    try {
      if (pm && pm._pingPongRenderTarget == null && typeof pm._setSize === "function" && typeof pm._allocateTargets === "function") {
        pm._setSize(PMREM_SIZE);
        const rt = pm._allocateTargets();
        try { rt?.dispose?.(); } catch (_) { /* never allocated on the GPU */ }
      }
    } catch (_) { /* fall through: whatever exists is compiled */ }
    const mats = [];
    for (const m of [pm?._ggxMaterial, pm?._blurMaterial]) if (m && m.isMaterial) mats.push(m);
    this.warmStats.pmremInternals = mats.length === 2;
    if (!this._bgProxy) {
      this._bgProxy = new THREE.MeshBasicMaterial({
        name: "PMREM.Background",
        side: THREE.BackSide,
        depthWrite: false,
        depthTest: false,
      });
    }
    mats.push(this._bgProxy);
    if (!this._warmFlat) this._warmFlat = new THREE.OrthographicCamera();
    if (!this._warmMeshes) this._warmMeshes = new WeakMap();
    const out = new Set();
    for (const m of mats) {
      let mesh = this._warmMeshes.get(m);
      // Geometry ATTRIBUTES are key bits (r184 `vertexNormals: !!geometry.attributes.normal`):
      // the GGX / blur lod planes carry position + uv + faceIndex (no normal →
      // an empty geometry keys the same); three's PMREM.Background is a
      // BoxGeometry (normal present), so its proxy must be one too.
      if (!mesh) {
        const g = m === this._bgProxy ? new THREE.BoxGeometry() : new THREE.BufferGeometry();
        mesh = new THREE.Mesh(g, m);
        this._warmMeshes.set(m, mesh);
      }
      // Drawn as `renderer.render(mesh, camera)` → three keys it on an empty
      // scene; compiling the mesh as its own (non-Scene) target does the same.
      const set = compileWithTarget(this.renderer, mesh, this._warmFlat, null, target);
      if (set) set.forEach((x) => out.add(x));
    }
    this.warmStats.compiled += out.size;
    return out;
  }

  /**
   * ?pmremPrecompile: true while a due sky render (refresh / clouds cube) must
   * wait for programs still linking — bounded by PMREM_WAIT_MAX_MS, then it
   * renders anyway (and links what is left synchronously, as before).
   */
  _skyMustWait(nowMs) {
    if (!this.pmremPrecompile) return false;
    let pending = 0;
    try { pending = this.warmPrograms(nowMs).length; } catch (_) { pending = 0; }
    if (pending === 0) { this._waitSince = -1; return false; }
    if (this._waitSince < 0) this._waitSince = nowMs;
    if (nowMs - this._waitSince >= PMREM_WAIT_MAX_MS) {
      this._waitSince = -1;
      this.warmStats.waitCapped += 1;
      return false;
    }
    this.warmStats.waitTicks += 1;
    return true;
  }

  /**
   * 2026-08-03 — hide the CLIP-SPACE members of skyScene while rendering it.
   * `cloud_overlay`'s composite quad writes `gl_Position = vec4(position.xy,
   * 0, 1)` (no matrices), so it is not geometry in the scene at all: through
   * the CubeCamera it covers EVERY face completely, and through `fromScene`
   * it becomes the entire environment. Under `?clouds=on&ibl=on` that means
   * the whole world's indirect light is the cloud composite rather than the
   * sky. World-placed members (the radiance quad, stars, the moon
   * billboards) are left visible on purpose — they are real sky radiance and
   * their contribution to the environment is the point. Returns what it hid.
   */
  _hideClipSpace() {
    const hidden = [];
    try {
      const kids = this.skyScene?.children;
      if (kids) {
        for (let i = 0; i < kids.length; i += 1) {
          const k = kids[i];
          if (k && k.visible && k.userData?.__clipSpaceOverlay === true) {
            k.visible = false;
            hidden.push(k);
          }
        }
      }
    } catch (_) { /* fail-soft: a bad walk must not skip the refresh */ }
    return hidden;
  }

  /**
   * 2026-10-08 — both products render from the VIEWER, not the world origin.
   * The sky scene's world-placed members follow the camera (sky_cell, the AC
   * moon billboards ~1-2 km out); seen from the origin — ~47 km away at
   * Holtburg — a moon landed on the horizon at the wrong azimuth (measured:
   * az 77 deg, el 1.3 deg, against the moon's true az 136, el 9) and every
   * water surface mirrored a moon that was not in the sky (owner pass on the
   * 1070, pre-dawn at the coast). From the viewer the water's reflection
   * tracks Dereth's own moons, in their own colours.
   */
  _updateViewPos() {
    this._viewPos.set(0, 0, 0);
    try {
      if (this.camera && typeof this.camera.getWorldPosition === "function") {
        this.camera.getWorldPosition(this._viewPos);
        if (!Number.isFinite(this._viewPos.x + this._viewPos.y + this._viewPos.z)) this._viewPos.set(0, 0, 0);
      }
    } catch (_) { this._viewPos.set(0, 0, 0); }
  }

  /** The clouds buffer to composite, or null (flag off / no clouds / no camera). */
  _cloudsBuffer() {
    if (!this.waterClouds || !this.getCloudsBuffer || !this.camera) return null;
    try { return this.getCloudsBuffer() || null; } catch (_) { return null; }
  }

  /** The raw mipmapped cube the terrain shader samples: clear sky, then clouds. */
  _renderTerrainCube(nowMs) {
    const hidden = this._hideClipSpace();
    try {
      this._cubeCam.position.copy(this._viewPos);
      this._cubeCam.updateMatrixWorld(true);
      this._cubeCam.update(this.renderer, this.skyScene);
    } finally {
      for (let i = 0; i < hidden.length; i += 1) hidden[i].visible = true;
    }
    const clouds = this._cloudsBuffer();
    if (clouds) {
      try { this._compositeClouds(clouds); } catch (_) { /* the clear-sky cube stands */ }
    }
    this._lastCubeMs = nowMs;
  }

  _compositeClouds(clouds) {
    if (!this._cloudComposite) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uClouds: { value: null },
          uFaceInvProj: { value: new THREE.Matrix4() },
          uFaceWorld: { value: new THREE.Matrix4() },
          uViewProj: { value: new THREE.Matrix4() },
          uViewPos: { value: new THREE.Vector3() },
        },
        vertexShader: CLOUD_COMPOSITE_VERT,
        fragmentShader: CLOUD_COMPOSITE_FRAG,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        toneMapped: false,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
      });
      const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false;
      const scene = new THREE.Scene();
      scene.add(quad);
      this._cloudComposite = { scene, cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat, quad };
    }
    const { scene, cam, mat } = this._cloudComposite;
    const u = mat.uniforms;
    u.uClouds.value = clouds;
    this.camera.updateMatrixWorld?.();
    u.uViewProj.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    u.uViewPos.value.copy(this._viewPos);
    const r = this.renderer;
    const prevTarget = r.getRenderTarget();
    const prevFace = r.getActiveCubeFace();
    const prevMip = r.getActiveMipmapLevel();
    const prevAutoClear = r.autoClear;
    const tex = this._cubeRT.texture;
    const genMips = tex.generateMipmaps;
    r.autoClear = false;
    try {
      const faces = this._cubeCam.children;
      for (let f = 0; f < 6; f += 1) {
        const fc = faces[f];
        if (!fc) continue;
        u.uFaceInvProj.value.copy(fc.projectionMatrixInverse);
        u.uFaceWorld.value.copy(fc.matrixWorld);
        // One mip generation, after the last face (CubeCamera.update's idiom).
        tex.generateMipmaps = f === 5 ? genMips : false;
        r.setRenderTarget(this._cubeRT, f);
        r.render(scene, cam);
      }
    } finally {
      tex.generateMipmaps = genMips;
      r.autoClear = prevAutoClear;
      r.setRenderTarget(prevTarget, prevFace, prevMip);
    }
    this.cloudComposites += 1;
  }

  /** Re-render both environment products from the current sky. */
  refresh(nowMs) {
    this._updateViewPos();
    const hidden = this._hideClipSpace();
    try {
      // PMREM for standard materials. New RT per call (three has no reuse
      // API for fromScene); texture-object swap does not recompile programs.
      const rt = this._pmrem.fromScene(this.skyScene, 0.03, 0.1, 1e7, { position: this._viewPos });
      const old = this._pmremRT;
      this.scene.environment = rt.texture;
      this._pmremRT = rt;
      if (old) old.dispose();
    } finally {
      for (let i = 0; i < hidden.length; i += 1) hidden[i].visible = true;
    }
    // Raw mipmapped cube for the terrain shader (+ the clouds, ?waterClouds).
    this._renderTerrainCube(nowMs);

    this._lastRefreshMs = nowMs;
    this.refreshCount += 1;
  }

  /**
   * Per-frame. Cheap except on refresh frames. `terrainMaterials` is the
   * live per-LB ShaderMaterial registry (scene3d.terrainMaterials) — walked
   * every frame like tickTerrainSunDir so bake/ibl init order never matters.
   */
  /**
   * Night multiplier for the indirect term, in (0, 1]. 1.0 by day and whenever
   * `?nightRamp=off`, so the legacy behaviour is exactly preserved.
   */
  _nightEnvMul() {
    try {
      if (!nightRampEnabled()) return 1.0;
      // AtmosphereLights.tick stashes the SkyState snapshot it was handed
      // (atmosphere_lights.js `this._lastState = state`), which is the same
      // object skyLightingController produced — so this needs no new plumbing
      // and cannot go stale relative to the lights it is modulating.
      const st = this.atmosphereLights?._lastState ?? null;
      const pitch = st && Number.isFinite(st.dirPitch) ? st.dirPitch : null;
      if (pitch == null) return 1.0;
      const n = nightFactorFromAuthoredPitch(pitch);
      return 1.0 + n * (nightEnvScale() - 1.0);
    } catch (_) {
      return 1.0;
    }
  }

  tick(nowMs, terrainMaterials) {
    if (nowMs - this._lastRefreshMs >= this.refreshMs) {
      // ?pmremPrecompile: a due refresh waits (bounded) for still-linking programs.
      if (this._firstDueMs < 0 && this.refreshCount === 0) this._firstDueMs = nowMs;
      if (!this._skyMustWait(nowMs)) {
        if (this.refreshCount === 0 && this._firstDueMs >= 0) this.warmStats.firstWaitMs = Math.round(nowMs - this._firstDueMs);
        this.refresh(nowMs);
      }
    } else if (nowMs - this._lastCubeMs >= CLOUD_CUBE_REFRESH_MS && this._cloudsBuffer()) {
      // Clouds drift; the terrain cube follows them at 1 Hz (the PMREM for
      // the standard materials keeps its refreshMs cadence).
      if (!this._skyMustWait(nowMs)) {
        this._updateViewPos();
        this._renderTerrainCube(nowMs);
      }
    } else if (this.pmremPrecompile && nowMs - this._lastRefreshMs >= this.refreshMs - PMREM_WARM_LEAD_MS &&
               nowMs - this._lastWarmMs >= 1000) {
      // Sky members that arrived since the last refresh (stars, moons) start
      // linking ahead of the refresh that will first draw them.
      try { this.warmPrograms(nowMs); } catch (_) { /* the gate above still bounds it */ }
    }

    // Diurnal intensity: reuse the exact retail ambient term the muted
    // probe would have used (L1 ambBright curve, 0.2 floor, worldLightScale).
    let p = this.atmosphereLights?.lastProbeIntensity;
    if (Number.isFinite(p)) p *= this._nightEnvMul();
    if (Number.isFinite(p)) this.scene.environmentIntensity = p;

    if (Array.isArray(terrainMaterials)) {
      const envI = Number.isFinite(p) ? p : 1.0;
      for (const mat of terrainMaterials) {
        const u = mat?.uniforms;
        if (!u || !u.uIblEnabled) continue;
        u.uIblEnabled.value = 1.0;
        u.uEnvCube.value = this.envCubeTexture;
        u.uEnvIntensity.value = envI;
      }
    }
  }

  dispose() {
    if (this.atmosphereLights) this.atmosphereLights.iblOwnsDiffuse = false;
    this.scene.environment = null;
    if (this._pmremRT) this._pmremRT.dispose();
    this._pmrem.dispose();
    this._cubeRT.dispose();
    if (this._cloudComposite) {
      this._cloudComposite.mat.dispose();
      this._cloudComposite.quad.geometry.dispose();
      this._cloudComposite = null;
    }
    if (this._bgProxy) {
      try { this._warmMeshes?.get(this._bgProxy)?.geometry?.dispose(); } catch (_) {}
      this._bgProxy.dispose();
      this._bgProxy = null;
    }
    this._warmPending.clear();
  }
}
