// ─────────────────────────────────────────────────────────────────────────
// QUARANTINED 2D PIXI render pipeline — retired 2026-06-18 (2D-PIXI-retirement,
// Phase 3 / item 7a). Extracted verbatim from index.html. Reference only per
// RULINGS.md item 2 — NOT imported/wired (references the 2D PIXI closures:
// liveScene, PIXI, the terrain/atlas constants, etc.). The 3D three.js path in
// scene3d/ replaces all of this. Shared state the 2D path exposed
// (window.entityMap, getLocalPlayerGuid/setLocalPlayerGuid) is also exposed at
// module scope in index.html (4605-4607), so it survives this removal; the
// other window.* exposures here (liveScene/cellContainers/buildingMap/
// handleEntitySpawn/handlePositionUpdate) were redundant capture-script taps
// (live dispatch uses the functions directly; scene3d guards on typeof).
// ─────────────────────────────────────────────────────────────────────────

// ===== renderNeighbourhood (2D PIXI render orchestrator) =====
      async function renderNeighbourhood(canvasElem, neighbourhood, meshes, objects, spriteMap, colourMap) {
        const app = new PIXI.Application();
        await app.init({
          canvas: canvasElem,
          width: canvasElem.width,
          height: canvasElem.height,
          background: 0x101010,
          antialias: true,
          // Force WebGL backend; the custom shader is GLSL ES 3.00 and
          // would need a separate WGSL pair for WebGPU. Step 3 ships
          // WebGL2 only; WebGPU + WGSL is a future polish step.
          preference: "webgl",
        });

        // Step 3.5: real AC textures replace the placeholder palette.
        // `buildTerrainAtlas` fetches all 33 retail terrain textures
        // via the wasm export, downscales each 512×512 → 256×256, and
        // packs them into a single 1536×1536 RGBA atlas (~9 MB GPU).
        // Step 3.6 (revised): the shader does bilinear 4-corner blend
        // of per-vertex terrain types — same algorithm
        // emit-static-site uses. Roads draw as vector lines on top
        // (per-LB PIXI.Graphics layer in `buildLandblockChildren`).
        // The alpha-mask atlas + per-cell palette decoder built into
        // earlier 3.6 commits are no longer reached from the render
        // path; `fetch_terrain_alpha_masks` is kept available in the
        // wasm bundle for any future authentic-TexMerge mode.
        const { atlasTexture, roadTexture } = await buildTerrainAtlas();

        // Scene graph:
        //   stage
        //   └── cameraContainer  (world metres → canvas pixels)
        //       └── worldContainer  (one-time AC y-flip)
        //           ├── outdoorContainer            (toggleable group)
        //           │   ├── landblockContainer × 9  (terrain, beneath)
        //           │   ├── buildingsBundle.container (per-part building meshes)
        //           │   └── objectsContainer          (static sprites)
        //           ├── cellContainers (added dynamically by
        //           │   ensureCellContainersForLandblock — interior
        //           │   geometry, must stay visible while indoor)
        //           └── entityContainer             (live entities, on top — Phase 4 step 2b)
        //
        // `outdoorContainer.visible` is flipped by `tickCellVisibility`
        // based on the wasm-side `isCurrentCellIndoor()` flag — when
        // the player walks into an interior cell the entire outdoor
        // group hides as one PIXI batch toggle. Cell containers + live
        // entities stay direct children of `worldContainer` so they
        // remain visible while indoor (cells render the interior
        // geometry; entities can be NPCs that exist inside or out).
        const cameraContainer = new PIXI.Container();
        app.stage.addChild(cameraContainer);

        const worldContainer = new PIXI.Container();
        worldContainer.scale.set(1, -1); // AC +north → canvas-up
        cameraContainer.addChild(worldContainer);

        const outdoorContainer = new PIXI.Container();
        worldContainer.addChild(outdoorContainer);

        for (let i = 0; i < neighbourhood.length; i += 1) {
          const n = neighbourhood[i];
          addLandblockToScene(
            outdoorContainer,
            meshes[i],
            n.x,
            n.y,
            atlasTexture,
            roadTexture
          );
          // Mark this LB's terrain mesh as already painted so
          // ensureTerrainAroundLandblock skips re-rendering when the
          // local player's first position update fires for the spawn
          // LB. The wasm-side `terrainPrefetchedLbs` cache is
          // separately populated by the same path.
          const lbId = ((n.x << 24) | (n.y << 16)) >>> 0;
          terrainMeshAddedLbs.add(lbId);
        }

        // Step 6: live-render every unique placed model into a
        // PIXI.RenderTexture (per-poly UV-mapped texture sampling
        // modulated by per-vertex Lambert shade — runtime port of the
        // static-site emitter's DrawTriangle pipeline). Cached by
        // model_id, takes priority over the static atlas. Falls back
        // to atlas → coloured-dot for models the live walk fails on.
        // `invisible` carries model_ids whose walk yielded 0 triangles
        // (NoPos-only geometry) — engine-internal anchors that the
        // renderer suppresses entirely (no fallback dot).
        let liveSpriteMap = new Map();
        let invisibleModels = new Set();
        try {
          const result = await buildLiveSpriteMap(app, objects);
          liveSpriteMap = result.liveMap;
          invisibleModels = result.invisible;
          const uniqueCount = new Set(objects.map((o) => o.modelId)).size;
          console.log(`[step6] live-rendered ${liveSpriteMap.size} of ${uniqueCount} unique models (${invisibleModels.size} deliberately invisible)`);
        } catch (e) {
          console.warn("[step6] buildLiveSpriteMap failed; falling back to static atlas:", e);
        }

        // Phase 6 step A: split building placements out of the object
        // list and route them through the per-part bake. Buildings get
        // a `PIXI.Container` of N child sprites (one per Setup part)
        // tagged `{ buildingId, partIndex }`; non-building objects keep
        // the existing single-fused sprite path. The fused
        // `liveSpriteMap` still has entries for building model_ids
        // (from `buildLiveSpriteMap` above) — those serve as a fallback
        // texture if the per-part bake fails for a model_id.
        const buildings = objects.filter((o) => o.isBuilding);
        const nonBuildings = objects.filter((o) => !o.isBuilding);
        let perPartBuildingMap = new Map();
        try {
          const uniqueBuildingIds = [...new Set(buildings.map((o) => o.modelId))];
          perPartBuildingMap = await bakePerPartBuildingTextures(app, uniqueBuildingIds);
          console.log(
            `[phase6.A] per-part bake: ${perPartBuildingMap.size} of `
            + `${uniqueBuildingIds.length} unique building model_ids (${buildings.length} placements)`
          );
        } catch (e) {
          console.warn("[phase6.A] bakePerPartBuildingTextures failed; buildings will use fused fallback:", e);
        }
        const buildingsBundle = buildBuildingsContainer(
          neighbourhood, buildings, perPartBuildingMap, liveSpriteMap, invisibleModels
        );
        outdoorContainer.addChild(buildingsBundle.container);

        // Step 4: object sprites on top of the textured terrain.
        // Step 4.5: tinted with the per-model real ARGB resolved from
        // each model's Surface chain (`colourMap`); models without a
        // resolved colour fall back to the legacy 2-bucket palette.
        // Step 6: prefer live-rendered tiles (`liveSpriteMap`) over
        // the static atlas; fall back to atlas, then to colour-tinted
        // dot. Models in `invisibleModels` get nothing — they're
        // engine-internal anchors meant to be unseen in-game.
        // Phase 6 step A: only non-building placements come through
        // here; buildings render via `buildingsBundle.container` above.
        const { container: objectsContainer, withSprite, fallback, withLive, invisible } =
          buildObjectsContainer(neighbourhood, nonBuildings, spriteMap, colourMap, liveSpriteMap, invisibleModels);
        outdoorContainer.addChild(objectsContainer);
        // Mark the initial neighbourhood as already rendered so the
        // first-position-update LB-change handler doesn't re-bake +
        // re-add buildings/objects for the spawn area.
        for (const n of neighbourhood) {
          const lbId = ((n.x << 24) | (n.y << 16)) >>> 0;
          objectsRenderAddedLbs.add(lbId);
        }
        // Same for already-resolved colours — mark every object's
        // model id so we don't re-fetch on first LB change.
        for (const o of objects) {
          colourResolveAttempted.add(o.modelId);
        }
        // Stash the counts on the app for the stage-info panel.
        app._stepFourCounts = { withSprite, fallback, withLive, invisible };
        app._phase6BuildingCounts = {
          withParts: buildingsBundle.withParts,
          withFallback: buildingsBundle.withFallback,
          dropped: buildingsBundle.dropped,
        };

        // Phase 4 step 2b: live-entity layer. Sits on top of the
        // static objectsContainer so dynamic NPCs / monsters / players
        // draw above placed buildings. The recv loop's
        // `pollEntityUpdates()` events drive this layer; static
        // landblock objects are not affected.
        const entityContainer = new PIXI.Container();
        worldContainer.addChild(entityContainer);
        // Phase 4 step 6e: nameplate layer. Sibling of cameraContainer
        // on app.stage so it's NOT scaled or y-flipped — text stays
        // at constant 12px screen-space at every zoom level.
        // updateNameplatePositions() projects each entity's world coords
        // through cameraContainer's transform every rAF tick.
        const nameplateContainer = new PIXI.Container();
        app.stage.addChild(nameplateContainer);
        liveScene = {
            app,
            cameraContainer,
            worldContainer,
            outdoorContainer,
            entityContainer,
            nameplateContainer,
            // 2026-05-09 follow-up: stashed for ensureTerrainAroundLandblock
            // so terrain meshes for new LBs (player walks across an LB
            // boundary, portals out, dies and respawns elsewhere) can
            // be added to outdoorContainer using the same atlas/road
            // textures the startup paint baked. Without these, the
            // terrain prefetch only populates the wasm-side height
            // cache and the player walks over an empty void.
            atlasTexture,
            roadTexture,
            liveSpriteMap,
            spriteMap,
            invisibleModels,
            buildingMap: buildingsBundle.buildingMap,
            // 2026-05-09 follow-up: stashed for ensureLandblockObjects-
            // ForLandblock. perPartBuildingMap is the per-model bake
            // cache (modelId → Vec<PartBake>); reused across LBs so
            // the same building model appearing in two landblocks
            // bakes once. colourMap is per-model representative ARGB;
            // extended for new models discovered on new-LB entry.
            perPartBuildingMap,
            colourMap,
            // Phase 6 step C: shared cell-container registry. Pre-
            // populate empty so capture probes can read
            // `liveScene.cellContainers.size === 0` before any LB
            // entry has triggered the lazy bake. Once
            // `ensureCellContainersForLandblock` runs, entries land
            // here AND in `window.cellContainers` (same Map).
            cellContainers: cellContainerRegistry,
        };
        // Expose for capture-script telemetry (Phase 4 step 2b
        // capture probes `window.liveScene.entityContainer.children.length`).
        // Strictly debug-only; not relied on by production code paths.
        window.liveScene = liveScene;
        window.entityMap = entityMap;
        // Phase 6 step A: per-building per-part container registry.
        // Keyed by stable `${landblockId}_${x}_${y}_${modelId}` strings;
        // values are `PIXI.Container`s whose children are sprites
        // tagged `{ buildingId, partIndex }` so Phase E can rotate door
        // GfxObjs around their hinge frames by part_index lookup.
        window.buildingMap = buildingsBundle.buildingMap;
        // Phase 6 step C: per-EnvCell PIXI.Container registry. Populated
        // lazily on landblock entry by
        // `ensureCellContainersForLandblock`. Each entry is keyed by
        // the cell's full 32-bit cell_id (XXYY01XX etc.) and tagged
        // with `__cellId`, `__environmentId`, `__landblockId`. The
        // capture script reads either `window.cellContainers` or
        // `window.liveScene.cellContainers` (both point to the same
        // Map).
        window.cellContainers = cellContainerRegistry;
        // Phase 6 step E: door GUID → "open"|"closed" state map.
        // Populated by the kind=15 DoorStateChanged ClientEvent in
        // drainEvents below; mirrored on liveScene.doorStates so the
        // capture script's `entry.__doorState` / `sprite.rotation`
        // probes can find the live state. Open doors have their
        // building-AABB entry's `active` flag toggled wasm-side, so
        // the integrator's swept clamp lets the player walk through.
        // __doorStates is hoisted to module scope; just link the 2D liveScene.
        liveScene.doorStates = window.__doorStates;
        // Phase 6 step C: marker symbol the smoke checks via
        // `typeof wasm.init_cell_containers === "function"`. Calling
        // it is a no-op; the JS render pipeline owns the registry's
        // lifetime, the wasm export only signals presence.
        try { init_cell_containers(); } catch (_) { /* ignore */ }
        // Phase 4 step 6 capture surface: same window-exposure pattern.
        // capture_step6.cjs injects synthetic EntityUpdate-shaped objects
        // through these so we can demonstrate step 6 visuals without a
        // running ACE. Production code paths drive these via the
        // pollEntityUpdates drain in drainEvents and never read window.*.
        window.handleEntitySpawn = handleEntitySpawn;
        window.handleEntityRemove = handleEntityRemove;
        window.handlePositionUpdate = handlePositionUpdate;
        window.setLocalPlayerGuid = setLocalPlayerGuid;
        window.getLocalPlayerGuid = getLocalPlayerGuid;
        window.updateNameplatePositions = updateNameplatePositions;
        // Phase 4 step 6 Tier 2 capture surface: expose the
        // walk-bake kicker + cache-key derivation so capture
        // scripts can force a bake without waiting for the rAF
        // cycler's velocity threshold to organically trip.
        window.kickWalkFrameBakeIfNeeded = kickWalkFrameBakeIfNeeded;
        window.computeEntitySpriteKey = computeEntitySpriteKey;
        window.tickEntityAnimations = tickEntityAnimations;
        window.tickEntityInterpolation = tickEntityInterpolation;
        window.handleEntityVelocity = handleEntityVelocity;
        window.handleEntityMotion = handleEntityMotion;

        // Initial camera: centre on Holtburg's geometric centre at a
        // scale that fits the 3×3 grid in the canvas with a margin.
        const centreWorld = {
          x: HOLTBURG_X * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
          y: HOLTBURG_Y * METERS_PER_LANDBLOCK + METERS_PER_LANDBLOCK / 2,
        };
        const margin = 16;
        const fitMetres = 3 * METERS_PER_LANDBLOCK;
        const initialScale = (Math.min(canvasElem.width, canvasElem.height) - margin * 2) / fitMetres;
        cameraContainer.scale.set(initialScale, initialScale);
        // Place world (centreWorld) at canvas centre. The y-flip is in
        // worldContainer, so cameraContainer.position uses canvas y
        // increasing downward.
        cameraContainer.position.set(
          canvasElem.width / 2 - centreWorld.x * initialScale,
          canvasElem.height / 2 + centreWorld.y * initialScale
        );

        // ----- input: wheel zoom + pointer drag --------------------
        const SCALE_MIN = 0.05;
        // Bumped from 5.0 → 120.0 so you can zoom close enough to
        // actually see yourself running. The default render scale
        // for a 3×3 LB neighbourhood fitting a 512px canvas works
        // out to ~0.9 px/m; even at the previous 5x cap a humanoid
        // sprite was only ~9 px tall. 120 px/m makes a humanoid
        // ~150 px — clearly visible at typical phone resolutions.
        const SCALE_MAX = 120.0;

        app.stage.eventMode = "static";
        app.stage.hitArea = app.screen;

        app.stage.on("wheel", (e) => {
          // Zoom around the cursor: keep the world point under the
          // cursor stationary across the scale change.
          // Bumped from 1.1× → 1.25× so the wheel reaches useful
          // zoom levels in fewer notches (10 clicks ≈ 9× vs 2.6×).
          const factor = e.deltaY > 0 ? 1 / 1.25 : 1.25;
          const next = cameraContainer.scale.x * factor;
          if (next < SCALE_MIN || next > SCALE_MAX) return;

          const cursorScreen = { x: e.global.x, y: e.global.y };
          const cursorWorldPre = {
            x: (cursorScreen.x - cameraContainer.position.x) / cameraContainer.scale.x,
            y: (cursorScreen.y - cameraContainer.position.y) / cameraContainer.scale.y,
          };
          cameraContainer.scale.set(next, next);
          const cursorWorldPost = {
            x: (cursorScreen.x - cameraContainer.position.x) / next,
            y: (cursorScreen.y - cameraContainer.position.y) / next,
          };
          cameraContainer.position.x += (cursorWorldPost.x - cursorWorldPre.x) * next;
          cameraContainer.position.y += (cursorWorldPost.y - cursorWorldPre.y) * next;
        });

        let dragging = false;
        let lastPointer = null;
        const onDragEnd = () => {
          dragging = false;
          lastPointer = null;
          canvasElem.classList.remove("dragging");
        };
        app.stage.on("pointerdown", (e) => {
          dragging = true;
          lastPointer = { x: e.global.x, y: e.global.y };
          canvasElem.classList.add("dragging");
        });
        app.stage.on("pointerup", onDragEnd);
        app.stage.on("pointerupoutside", onDragEnd);
        app.stage.on("pointerleave", onDragEnd);
        app.stage.on("pointermove", (e) => {
          if (!dragging) return;
          cameraContainer.position.x += e.global.x - lastPointer.x;
          cameraContainer.position.y += e.global.y - lastPointer.y;
          lastPointer = { x: e.global.x, y: e.global.y };
        });

        return { withLive, withSprite, fallback, invisible, liveSpriteMap };
      }


// ===== 2D PIXI bakers + interspersed terrain/livemodel GLSL shaders + atlas/sun
// constants (buildTerrainAtlas → addLandblockToScene). All 2D-only; callers were
// renderNeighbourhood [gone] + each other + the ensure* PIXI tails [removed 7c]. =====
      async function buildTerrainAtlas() {
        // Fetch all 33 retail terrain textures via the wasm export
        // and pack them into a single RGBA atlas canvas. Phase 5.0b:
        // reads from the global manifest source (no URL arg).
        //
        // Returns { atlasTexture, roadTexture }. The 6×6 atlas covers
        // codes 0-31 for the per-vertex terrain shader. Code 32
        // (RoadType, DID 0x05001458) is also written into the atlas
        // for completeness, AND extracted as a standalone wrapping
        // texture for the road overlay's tiled stroke (mirrors
        // `RenderPreviewRenderer.cs:526-545`'s
        // `SKShader.CreateBitmap(roadTile, Repeat, Repeat)`).
        const textures = await fetch_terrain_textures();
        if (textures.length !== 33) {
          throw new Error(
            `expected 33 terrain textures, got ${textures.length}`
          );
        }

        const atlas = document.createElement("canvas");
        atlas.width = ATLAS_PX;
        atlas.height = ATLAS_PX;
        const actx = atlas.getContext("2d");

        // Working canvas for one tile's RGBA → ImageBitmap.
        const tileCanvas = document.createElement("canvas");
        const tctx = tileCanvas.getContext("2d");

        let roadTexture = null;

        for (const tex of textures) {
          const code = tex.terrainType;
          const w = tex.width;
          const h = tex.height;
          const px = tex.pixels; // wasm-bindgen Uint8Array, length w*h*4

          tileCanvas.width = w;
          tileCanvas.height = h;
          // ImageData wants Uint8ClampedArray; coerce. The buffer
          // copy is unavoidable since wasm-bindgen returns a fresh
          // typed-array we own.
          const clamped = new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
          const img = new ImageData(clamped, w, h);
          tctx.putImageData(img, 0, 0);

          const col = code % ATLAS_COLS;
          const row = (code / ATLAS_COLS) | 0;
          const dx = col * ATLAS_TILE_PX;
          const dy = row * ATLAS_TILE_PX;
          actx.drawImage(
            tileCanvas,
            0, 0, w, h,
            dx, dy, ATLAS_TILE_PX, ATLAS_TILE_PX
          );

          // Extract code 32 (RoadType) as a standalone wrapping
          // texture for the road overlay's tiled stroke. Use a
          // dedicated canvas so the source is exactly w×h (not
          // ATLAS_TILE_PX) — preserves the texture's native
          // resolution for the stroke sampler.
          if (code === 32) {
            const roadCanvas = document.createElement("canvas");
            roadCanvas.width = w;
            roadCanvas.height = h;
            const rctx = roadCanvas.getContext("2d");
            rctx.putImageData(new ImageData(new Uint8ClampedArray(clamped), w, h), 0, 0);
            roadTexture = PIXI.Texture.from(roadCanvas);
            if (roadTexture.source) {
              roadTexture.source.scaleMode = "linear";
              roadTexture.source.autoGenerateMipmaps = true;
              // Wrap addressing so the stroke sampler tiles the
              // texture across long road runs instead of clamping to
              // the edge. Mirrors C# `SKShaderTileMode.Repeat`.
              roadTexture.source.style.addressModeU = "repeat";
              roadTexture.source.style.addressModeV = "repeat";
            }
          }

          tex.free();
        }

        const texture = PIXI.Texture.from(atlas);
        // LINEAR + mipmaps: huge visual win at zoom-out (smooth tiles
        // instead of aliased mosaic). The minor bleed at atlas region
        // boundaries is masked by the SW-corner `flat` shading — only
        // fragments at exactly cell-uv ≈ 1.0 sample slightly into the
        // next region, and at 24m cell scale that's sub-pixel noise.
        if (texture.source) {
          texture.source.scaleMode = "linear";
          texture.source.autoGenerateMipmaps = true;
        }
        return { atlasTexture: texture, roadTexture };
      }


      // Helper — wrap a Uint8ClampedArray of RGBA8 bytes into a small
      // PIXI.Texture. Use `nearest` filtering: cell-data values are
      // discrete bytes the shader integer-decodes via texelFetch, so
      // any interpolation would corrupt them.
      function makeR8DataTexture(bytes, w, h) {
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.putImageData(new ImageData(bytes, w, h), 0, 0);
        const tex = PIXI.Texture.from(canvas);
        if (tex.source) {
          tex.source.scaleMode = "nearest";
          tex.source.autoGenerateMipmaps = false;
        }
        return tex;
      }

      // Custom Mesh shader for the per-cell atlas sample. GLSL ES 3.00
      // (WebGL2). Uniforms mirror PixiJS 8's WebGL mesh shader template
      // (local-uniform-bit + global-uniforms-bit in the bundle source)
      // — **individual uniforms**, not UBO blocks. The MeshPipe's
      // UniformGroups in groups[100] (global) and groups[101] (local)
      // drive glUniform* calls by name, so the GLSL just declares
      // each uniform on its own line.
      //
      // Both vTerrainCode and vRoadCode use `flat` interpolation from
      // the SW-corner provoking vertex (last index of each triangle
      // per lib.rs build_mesh). Hard edges on cell boundaries.
      //
      // Step 3.5: real AC textures replace the 32-colour placeholder
      // atlas. Each terrain code maps to a 256×256 tile in a 6×6 atlas
      // grid (1536×1536 total), pre-built in JS from wasm-decoded
      // RGBA8 blobs. The shader does:
      //   1. Compute the cell's SW-corner terrain & road codes (`flat`
      //      from provoking vertex).
      //   2. Compute cell-local tile UV from the world position
      //      (aPosition / 24m, fract'd in fragment) so each cell tiles
      //      its texture across the 24×24 m face.
      //   3. Atlas sample at `regionOrigin + regionSize * tileUv`.
      //
      // Why hard edges still: AC's actual surface table uses corner/
      // side blend maps for proper transitions (CornerTerrainMaps /
      // SideTerrainMaps in TexMerge). That's a multi-pass renderer;
      // step 3.5 stays single-pass and per-cell. The visual upgrade
      // from placeholder colours to real tiles is the load-bearing
      // improvement here.
      const TERRAIN_VERTEX_GLSL = `#version 300 es
precision highp float;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;

uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;

in vec2 aPosition;

out vec2 vGridUv;
out vec4 vColor;

void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec2 pos = (mvp * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4(pos, 0.0, 1.0);
    // Per-vertex grid coordinate in [0, 8] across the 192 m landblock
    // (8 cells × 24 m each). Fragment splits into integer cell index
    // + intra-cell UV, looks up the cell's render program from the
    // 6 cell-data textures, samples primary + overlays + roads with
    // alpha-mask compositing — see TERRAIN_FRAGMENT_GLSL.
    vGridUv = aPosition / 24.0;
    vColor = uColor * uWorldColorAlpha;
}
`;

      const TERRAIN_FRAGMENT_GLSL = `#version 300 es
precision highp float;
precision highp int;

// Step 3.6 (revised): bilinear 4-corner terrain blend, mirroring
// emit-static-site's RenderPreviewRenderer.cs:467-485. Each
// fragment samples the 4 surrounding vertices terrain types from
// uVertexTypes (9x9 RGBA8 per LB; R = terrain type byte) and
// blends 4 atlas samples by bilinear weights derived from the
// fragment cell-local position. Roads are drawn as vector lines
// on top in a separate PIXI.Graphics pass -- NOT here.
//
// Why this beats TexMerge alpha masks for our use case: the static
// site that emit-dynamic-site renders against is itself bilinear
// (TexMerge per-cell hand-tuned overlays produce visible 24m cell
// artefacts unwelcome at the zoom levels we render). The
// alpha-mask path stays available in the wasm export
// fetch_terrain_alpha_masks for any future authentic-AC mode.
uniform sampler2D uAtlas;             // 6×6 grid of 256×256 retail terrain tiles
uniform vec2 uAtlasGridSize;           // (cols, rows) — typically (6, 6)
uniform sampler2D uVertexTypes;        // 9×9 RGBA8: R = terrain type byte, A = 255

in vec2 vGridUv;
in vec4 vColor;

out vec4 fragColor;

// Map terrain code (0..32) → atlas UV at the given cell-local UV.
// The retail terrain atlas is a 6×6 grid; tile index = code.
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
    // vGridUv is [0, 8] across the 192m LB. Bilinear 4-corner blend:
    // identify the cell (iu, iv) the fragment sits in, find its 4
    // surrounding vertices, sample each corner's terrain tile at the
    // SAME cell-local UV (so the tiles wrap identically), then blend
    // by (1-fu)(1-fv) / fu(1-fv) / (1-fu)fv / fu fv weights.
    vec2 grid = vGridUv;
    int iu = int(floor(grid.x));
    int iv = int(floor(grid.y));
    iu = clamp(iu, 0, 7);
    iv = clamp(iv, 0, 7);
    float fu = grid.x - float(iu);
    float fv = grid.y - float(iv);
    vec2 cellUv = vec2(fu, fv);

    int t00 = vertexTypeAt(iu,     iv    );  // SW
    int t10 = vertexTypeAt(iu + 1, iv    );  // SE
    int t01 = vertexTypeAt(iu,     iv + 1);  // NW
    int t11 = vertexTypeAt(iu + 1, iv + 1);  // NE

    vec3 c00 = texture(uAtlas, atlasUvFor(clamp(t00, 0, 32), cellUv)).rgb;
    vec3 c10 = texture(uAtlas, atlasUvFor(clamp(t10, 0, 32), cellUv)).rgb;
    vec3 c01 = texture(uAtlas, atlasUvFor(clamp(t01, 0, 32), cellUv)).rgb;
    vec3 c11 = texture(uAtlas, atlasUvFor(clamp(t11, 0, 32), cellUv)).rgb;

    float w00 = (1.0 - fu) * (1.0 - fv);
    float w10 = fu * (1.0 - fv);
    float w01 = (1.0 - fu) * fv;
    float w11 = fu * fv;

    vec3 result = c00 * w00 + c10 * w10 + c01 * w01 + c11 * w11;

    fragColor = vec4(result, 1.0) * vColor;
}
`;

      // Per-LB shader instance — each landblock gets its own
      // `PIXI.Shader` (sharing the GlProgram across instances) so it
      // can bind its own 9×9 vertex-types texture. The atlas is
      // shared across all 9 LBs.
      let _sharedTerrainGlProgram = null;
      function buildTerrainShader(atlasTexture, vertexTypesTexture) {
        if (_sharedTerrainGlProgram === null) {
          _sharedTerrainGlProgram = PIXI.GlProgram.from({
            vertex: TERRAIN_VERTEX_GLSL,
            fragment: TERRAIN_FRAGMENT_GLSL,
            name: "terrain-bilinear-step3.6",
          });
        }
        // The MeshPipe sets `shader.groups[100]` and `[101]` to its own
        // global / local UniformGroups every frame; PixiJS's
        // GlShaderSystem binds the individual `uTransformMatrix` /
        // `uColor` / `uRound` / matrix uniforms by name from those
        // groups. Atlas + vertex-types texture + grid-size uniforms
        // live on the user shader.
        return new PIXI.Shader({
          glProgram: _sharedTerrainGlProgram,
          resources: {
            uAtlas: atlasTexture.source,
            uVertexTypes: vertexTypesTexture.source,
            terrainUniforms: {
              uAtlasGridSize: {
                value: new Float32Array([ATLAS_COLS, ATLAS_ROWS]),
                type: "vec2<f32>",
              },
            },
          },
        });
      }

      // Build a 9x9 RGBA8 texture from this LB's per-vertex terrain
      // types. Mirrors the data path emit-static-site uses (vertex
      // grid in, bilinear sample out).
      //
      // CRITICAL transpose: wasm `terrainCodes` is laid out
      // **column-major** -- vertex i has gridX = i/9, gridY = i%9
      // (verified empirically vs WB.Terminal `get-terrain-data`
      // 2026-05-06; the previous "y * 9 + x" indexing produced a
      // diagonal-mirrored render where Holtburg's water ended up in
      // the wrong LB and the road network ran perpendicular to its
      // true direction). Canvas + GL textures are row-major, so we
      // transpose on upload: canvas (col, row) <- terrainCodes[col * 9 + row].
      // Then the shader's `texelFetch(uVertexTypes, ivec2(iu, iv))`
      // returns the type at the *physical* vertex (gridX = iu,
      // gridY = iv).
      //
      // Force A=255: canvas -> PIXI texture upload premultiplies
      // alpha; A=0 would silently zero RGB.
      function buildVertexTypesTexture(terrainCodes) {
        const bytes = new Uint8ClampedArray(9 * 9 * 4);
        for (let row = 0; row < 9; row += 1) {
          for (let col = 0; col < 9; col += 1) {
            const dst = (row * 9 + col) * 4;
            const src = col * 9 + row;
            bytes[dst + 0] = terrainCodes[src];
            bytes[dst + 1] = 0;
            bytes[dst + 2] = 0;
            bytes[dst + 3] = 255;
          }
        }
        return makeR8DataTexture(bytes, 9, 9);
      }

      // ----- Phase 3 step 4: object sprites ----------------------

      const ATLAS_PNG_URL = "./sprites/atlas.png";
      const ATLAS_JS_URL = "./sprites/atlas.js";

      async function loadSpriteAtlas() {
        // Static-site sprite atlas = 4096×1296 RGBA8 of greyscale
        // top-down silhouettes for ~108 model IDs. atlas.js declares
        // `const SPRITE_ATLAS = {modelHex: {x, y, w, h, worldBounds}, ...}`.
        // We fetch + eval it via Function() (the file isn't an ES
        // module — it's a DOM-style script that pollutes globals).
        const atlasJsResp = await fetch(ATLAS_JS_URL);
        if (!atlasJsResp.ok) {
          throw new Error(`atlas.js fetch failed: HTTP ${atlasJsResp.status}`);
        }
        const atlasJsText = await atlasJsResp.text();
        const SPRITE_ATLAS = new Function(
          atlasJsText + "; return SPRITE_ATLAS;"
        )();

        const baseTexture = await PIXI.Assets.load(ATLAS_PNG_URL);
        const source = baseTexture.source;

        const spriteMap = new Map();
        for (const [hexId, region] of Object.entries(SPRITE_ATLAS)) {
          const modelId = parseInt(hexId, 16);
          const subTexture = new PIXI.Texture({
            source,
            frame: new PIXI.Rectangle(region.x, region.y, region.w, region.h),
          });
          spriteMap.set(modelId, {
            texture: subTexture,
            worldBounds: region.worldBounds,
          });
        }
        return spriteMap;
      }

      // ----- Phase 3 step 6: live runtime per-model rasterizer ---
      //
      // Walks each unique placed model's GfxObj/SetupModel chain via
      // `fetch_model_meshes` (Rust), fetches each surface's RGBA8
      // pixels via `fetch_surfaces_pixels` (Rust), then rasterizes
      // top-down in PIXI: per-poly UV-mapped texture sampling
      // modulated by per-vertex Lambert shade. Output goes to a
      // PIXI.RenderTexture cached by model_id.
      //
      // Mirrors `WorldBuilder.Terminal/ObjectSpriteGenerator.cs`'s
      // bake-time pipeline (DrawTriangle + ShadeColor) but at
      // runtime — so user-imported custom models render without a
      // re-bake step. Final pixels match the static-site emitter for
      // the cases the static side already gets right; for cases
      // where the static side fell back to grey-shaded geometry
      // (most retail buildings, see step 4.5 atlas inspection),
      // the live walk now resolves the textures correctly courtesy
      // of the GfxObj polygon parser fix in `8c41045` + DXT
      // decoder in step 4.5b.

      // Sun direction matching ObjectSpriteGenerator's hillshade:
      // azimuth 135° (north-west), elevation 60°. Same constants the
      // static atlas was baked with so live-rendered models read
      // consistently next to atlas tiles for fallback models.
      const SUN_AZIMUTH_DEG = 135;
      const SUN_ELEVATION_DEG = 60;
      const SUN_DIR = (() => {
        const az = (SUN_AZIMUTH_DEG * Math.PI) / 180;
        const el = (SUN_ELEVATION_DEG * Math.PI) / 180;
        const cosE = Math.cos(el);
        // (sin(az), cos(az), sin(el)) — roughly matching the C# convention
        // ComputeSunDirection produces.
        const x = Math.sin(az) * cosE;
        const y = Math.cos(az) * cosE;
        const z = Math.sin(el);
        return [x, y, z];
      })();

      // Pixels-per-metre for the rendered tile. The static-site emitter
      // computes this per-model based on the largest worldBounds dim
      // (so all models hit the same on-disk pixel resolution); we mirror
      // that here so a 12 m × 13.6 m house tile is 256×~290 px regardless
      // of the building's absolute size. 256 px target matches the small
      // atlas's tile resolution; bump to 512 to match the production atlas.
      const TILE_TARGET_PX = 512;

      const LIVE_MODEL_VERTEX_GLSL = `#version 300 es
precision highp float;

uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;

uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;

in vec2 aPosition;
in vec2 aUv;
in float aShade;

out vec2 vUv;
out float vShade;
out vec4 vColor;

void main() {
    mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
    vec2 pos = (mvp * vec3(aPosition, 1.0)).xy;
    gl_Position = vec4(pos, 0.0, 1.0);
    vUv = aUv;
    vShade = aShade;
    vColor = uColor * uWorldColorAlpha;
}
`;

      const LIVE_MODEL_FRAGMENT_GLSL = `#version 300 es
precision highp float;

uniform sampler2D uTexture;

in vec2 vUv;
in float vShade;
in vec4 vColor;

out vec4 fragColor;

void main() {
    vec4 tex = texture(uTexture, vUv);
    // Modulate by per-vertex Lambert shade. Mirrors the C# Modulate
    // blend mode used by ObjectSpriteGenerator.DrawTriangle.
    fragColor = vec4(tex.rgb * vShade, tex.a) * vColor;
}
`;

      function buildLiveModelShader(surfaceTexture) {
        const glProgram = PIXI.GlProgram.from({
          vertex: LIVE_MODEL_VERTEX_GLSL,
          fragment: LIVE_MODEL_FRAGMENT_GLSL,
          name: "live-model-step6",
        });
        return new PIXI.Shader({
          glProgram,
          resources: {
            uTexture: surfaceTexture.source,
          },
        });
      }

      // Group a model's per-triangle data by surface_idx → so we can
      // make one PIXI.Mesh per surface (one texture per draw call) and
      // composite them all into the same RenderTexture.
      function groupTrianglesBySurface(mesh) {
        const groups = new Map(); // surface_idx → { positions[], uvs[], shades[] }
        const triCount = mesh.triCount;
        // Snapshot the typed arrays (each getter allocates a fresh copy).
        const positions = mesh.positions;
        const uvs = mesh.uvs;
        const normals = mesh.normals;
        const sIdx = mesh.surfaceIndices;
        for (let t = 0; t < triCount; t += 1) {
          const surface = sIdx[t];
          let g = groups.get(surface);
          if (!g) {
            g = { positions: [], uvs: [], shades: [] };
            groups.set(surface, g);
          }
          const nx = normals[t * 3];
          const ny = normals[t * 3 + 1];
          const nz = normals[t * 3 + 2];
          // Lambert shade: 0.55 + 0.55 * |dot(normal, sun)|, clamp [0.55, 1.0].
          const dot = Math.abs(nx * SUN_DIR[0] + ny * SUN_DIR[1] + nz * SUN_DIR[2]);
          let shade = 0.55 + 0.55 * dot;
          if (shade > 1.0) shade = 1.0;
          for (let v = 0; v < 3; v += 1) {
            g.positions.push(positions[t * 9 + v * 3], positions[t * 9 + v * 3 + 1]);
            g.uvs.push(uvs[t * 6 + v * 2], uvs[t * 6 + v * 2 + 1]);
            g.shades.push(shade);
          }
        }
        return groups;
      }

      // Build a fallback flat-colour PIXI.Texture for surfaces that
      // failed the walk (zero-size SurfacePixels). 1×1 grey so the
      // shader still samples uniformly. Round-trip through a canvas
      // matches the same pattern `buildTerrainAtlas` uses — PIXI.8's
      // BufferResource path is finicky in some build modes.
      const FLAT_FALLBACK_PIXELS = new Uint8ClampedArray([0xa0, 0xa0, 0xa0, 0xff]);
      function makeFlatTexture() {
        const c = document.createElement("canvas");
        c.width = 1;
        c.height = 1;
        const ctx = c.getContext("2d");
        ctx.putImageData(new ImageData(FLAT_FALLBACK_PIXELS, 1, 1), 0, 0);
        return PIXI.Texture.from(c);
      }

      // Render one model to a PIXI.RenderTexture: per-surface group
      // → textured Mesh → batch-draw into the destination tile.
      // Returns the RenderTexture (caller wraps in a Sprite).
      function renderModelTile(app, mesh, surfaceTextures) {
        // Tile size: scale the largest worldBounds dim to TILE_TARGET_PX.
        // The smaller dim gets proportional pixels — matches the
        // static-site emitter's "uniform world-units-per-pixel".
        const wb = mesh.worldBounds;
        const worldW = Math.max(wb[0], 1e-3);
        const worldH = Math.max(wb[1], 1e-3);
        const pxPerUnit = TILE_TARGET_PX / Math.max(worldW, worldH);
        const tileW = Math.max(1, Math.ceil(worldW * pxPerUnit));
        const tileH = Math.max(1, Math.ceil(worldH * pxPerUnit));
        const bbox = mesh.bbox; // [minX, minY, minZ, maxX, maxY, maxZ]
        const minX = bbox[0];
        const maxY = bbox[4];

        // Build the destination RenderTexture. transparent so the
        // sprite blends cleanly over the terrain.
        const renderTexture = PIXI.RenderTexture.create({ width: tileW, height: tileH });

        // Painter Z-sort triangles so high-Z faces draw last (roofs,
        // foliage). Easiest to do in JS now: gather triangles with
        // their centroid Z, sort, regroup. For step 6 v1 we skip this
        // and let HashMap iteration order win — most AC buildings
        // happen to have the right draw order naturally because the
        // C# polygon ordering carries through. Add Z-sort if a model's
        // roof renders under its walls.

        const groups = groupTrianglesBySurface(mesh);
        const stage = new PIXI.Container();
        // World→tile-pixel transform: translate by (-minX, -maxY) (with
        // Y flipped to canvas-down), scale by pxPerUnit. The shader's
        // uTransformMatrix consumes this.
        stage.position.set(-minX * pxPerUnit, maxY * pxPerUnit);
        stage.scale.set(pxPerUnit, -pxPerUnit);

        const meshObjects = []; // hold refs so we can dispose after rendering
        for (const [surfIdx, group] of groups) {
          const tex = surfIdx === 0xff
            ? makeFlatTexture()
            : (surfaceTextures[surfIdx] ?? makeFlatTexture());
          const shader = buildLiveModelShader(tex);
          const positions = new Float32Array(group.positions);
          const uvsBuf = new Float32Array(group.uvs);
          const shadesBuf = new Float32Array(group.shades);
          const geometry = new PIXI.Geometry({
            attributes: {
              aPosition: { buffer: positions, format: "float32x2" },
              aUv: { buffer: uvsBuf, format: "float32x2" },
              aShade: { buffer: shadesBuf, format: "float32" },
            },
            topology: "triangle-list",
          });
          const meshObj = new PIXI.Mesh({ geometry, shader });
          stage.addChild(meshObj);
          meshObjects.push({ mesh: meshObj, geometry, shader, tex });
        }

        app.renderer.render({ target: renderTexture, container: stage });

        // Cleanup intermediate resources. RenderTexture lives until the
        // cache evicts; everything else can go.
        for (const m of meshObjects) {
          m.mesh.destroy({ children: true });
          m.geometry.destroy();
          m.shader.destroy();
        }

        return renderTexture;
      }

      // Convert a `SurfacePixels` (from `fetch_surfaces_pixels`) into a
      // PIXI.Texture. Empty surfaces (width=0) return a flat fallback.
      // Same canvas-roundtrip pattern as buildTerrainAtlas — wasm
      // returns a fresh Uint8Array per `pixels` getter, which we
      // coerce to Uint8ClampedArray for ImageData and let canvas2d
      // own the GPU upload.
      function surfacePixelsToTexture(sp) {
        if (sp.width === 0 || sp.height === 0) return makeFlatTexture();
        const c = document.createElement("canvas");
        c.width = sp.width;
        c.height = sp.height;
        const ctx = c.getContext("2d");
        const px = sp.pixels;
        const clamped = new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength);
        ctx.putImageData(new ImageData(clamped, sp.width, sp.height), 0, 0);
        return PIXI.Texture.from(c);
      }

      // Build live-rendered tiles for every unique model id in `objects`.
      // Returns `{ liveMap, invisible }` where:
      //   liveMap: Map&lt;modelId, { texture, worldBounds }&gt; — same shape
      //     as the static atlas's spriteMap, so callers can swap them.
      //   invisible: Set&lt;modelId&gt; — model_ids whose live walk yielded
      //     0 triangles. These are typically engine-internal anchors
      //     (light-source markers, particle emitter sites — e.g.
      //     Holtburg's 0x02000364) with NoPos-stippled geometry and no
      //     weenie binding; the renderer suppresses fallback dots for
      //     these so they read as invisible (matching in-game).
      async function buildLiveSpriteMap(app, objects) {
        const uniqueIds = [...new Set(objects.map((o) => o.modelId))];
        if (uniqueIds.length === 0) return { liveMap: new Map(), invisible: new Set() };
        const liveMap = new Map();
        const invisible = new Set();
        await addModelsToLiveSpriteMap(app, uniqueIds, liveMap, invisible);
        return { liveMap, invisible };
      }

      // Phase 4 step 2b follow-on: shared helper that fetches a list
      // of model IDs through the same `fetch_model_meshes` +
      // `fetch_surfaces_pixels` + `renderModelTile` pipeline as the
      // initial bulk Holtburg load (Phase 3 step 6), and appends to
      // an existing liveMap + invisible set. Used both for the
      // initial neighbourhood load and for on-demand entity model
      // fetches when ACE streams in an NPC / creature whose csetup_id
      // wasn't in the static placement set.
      async function addModelsToLiveSpriteMap(app, modelIds, liveMap, invisible) {
        if (modelIds.length === 0) return;
        const meshes = await fetch_model_meshes(new Uint32Array(modelIds));

        // Collect every distinct surface DID across all meshes for
        // one batched fetch. JS dedupes; Rust returns one entry per
        // input id.
        const allSurfaces = new Set();
        for (const m of meshes) {
          for (const sid of m.surfaces) allSurfaces.add(sid);
        }
        const surfaceList = [...allSurfaces];
        const surfacePixels = surfaceList.length > 0
          ? await fetch_surfaces_pixels(new Uint32Array(surfaceList))
          : [];
        const surfaceTexBySid = new Map();
        for (let i = 0; i < surfaceList.length; i += 1) {
          surfaceTexBySid.set(surfaceList[i], surfacePixelsToTexture(surfacePixels[i]));
        }

        for (let i = 0; i < modelIds.length; i += 1) {
          const id = modelIds[i];
          const mesh = meshes[i];
          if (mesh.triCount === 0) {
            // 0 triangles after the polygon walk = engine-internal
            // anchor (e.g. light/particle marker with NoPos stippling).
            // Track the id so the renderer can suppress the fallback
            // dot — these are deliberately invisible in-game.
            invisible.add(id);
            mesh.free();
            continue;
          }
          // Per-surface texture array indexed by mesh.surfaces position.
          const sList = mesh.surfaces;
          const texArr = new Array(sList.length);
          for (let s = 0; s < sList.length; s += 1) {
            texArr[s] = surfaceTexBySid.get(sList[s]) ?? makeFlatTexture();
          }
          const renderTex = renderModelTile(app, mesh, texArr);
          const wb = mesh.worldBounds;
          liveMap.set(id, {
            texture: renderTex,
            worldBounds: [wb[0], wb[1]],
          });
          mesh.free();
        }
        for (const sp of surfacePixels) sp.free();
      }

      // ----- Phase 6 step A: per-part building bake ---------------
      //
      // Buildings and objects share the existing `fetch_landblock_objects`
      // call but route differently: buildings (`isBuilding === true`) go
      // through `fetchBuildingPlacement` to get N per-part meshes per
      // model_id, each baked into its own `RenderTexture`. Each placement
      // becomes a `PIXI.Container` of N child sprites, tagged with
      // `{ buildingId, partIndex }` in user-data so Phase E can rotate a
      // door GfxObj around its hinge frame by part_index lookup. The
      // single-fused atlas/dot fallback path is kept as a safety net for
      // model_ids the per-part bake fails on.
      async function bakePerPartBuildingTextures(app, modelIds) {
        // Map<modelId, Array<{ texture, worldBounds, partIndex } | null>>
        // Position in the inner array IS the part_index; null entries
        // mark parts whose triangulation produced 0 triangles (engine-
        // internal anchors inside a building Setup, e.g. invisible
        // collision proxies — preserved as null to keep the slot
        // addressable for later phases).
        const perPart = new Map();
        if (modelIds.length === 0) return perPart;
        const allSurfaceIds = new Set();
        const buildingBakes = new Map();
        for (const modelId of modelIds) {
          let bundle;
          try {
            bundle = await fetchBuildingPlacement(modelId);
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(
              `[phase6.A] fetchBuildingPlacement(0x${(modelId >>> 0).toString(16)}) failed:`, e
            );
            continue;
          }
          const partCount = bundle.partCount;
          if (partCount === 0) {
            bundle.free();
            continue;
          }
          const meshes = bundle.takePartMeshes();
          // Phase 6 step E follow-up (2026-05-09): pull per-part hinge
          // frames alongside the meshes so `buildBuildingsContainer` can
          // wrap each part sprite in a hinge-pivoted Container. Frames
          // are in model-local coords; identity-frame parts (raw 0x01
          // GfxObj or Setup with no placement_frames) get (0, 0, 0, q=1)
          // and rotate around the model origin — harmless for non-door
          // parts since we never set their rotation.
          const hingeFrames = bundle.takePartHingeFrames();
          buildingBakes.set(modelId, { meshes, hingeFrames });
          bundle.free();
          for (const m of meshes) {
            for (const sid of m.surfaces) allSurfaceIds.add(sid);
          }
        }

        const surfaceList = [...allSurfaceIds];
        const surfacePixels = surfaceList.length > 0
          ? await fetch_surfaces_pixels(new Uint32Array(surfaceList))
          : [];
        const surfaceTexBySid = new Map();
        for (let i = 0; i < surfaceList.length; i += 1) {
          surfaceTexBySid.set(surfaceList[i], surfacePixelsToTexture(surfacePixels[i]));
        }

        for (const [modelId, bake] of buildingBakes) {
          const { meshes, hingeFrames } = bake;
          const partEntries = new Array(meshes.length);
          for (let pi = 0; pi < meshes.length; pi += 1) {
            const mesh = meshes[pi];
            if (mesh.triCount === 0) {
              partEntries[pi] = null;
              mesh.free();
              continue;
            }
            const sList = mesh.surfaces;
            const texArr = new Array(sList.length);
            for (let s = 0; s < sList.length; s += 1) {
              texArr[s] = surfaceTexBySid.get(sList[s]) ?? makeFlatTexture();
            }
            const renderTex = renderModelTile(app, mesh, texArr);
            const wb = mesh.worldBounds;
            const bbox = mesh.bbox;
            // Phase 6 step E follow-up (2026-05-09): hinge frame for
            // this part. `compute_hinge_frames` returns one entry per
            // part in the same order as `take_part_meshes` (or an
            // identity (0, 0, 0, q=1) for missing/raw-GfxObj parts).
            // JS only consumes (x, y) — the rotation axis for top-down
            // door swing is Z, which corresponds to the entity's
            // `rotation` property (not the quaternion itself). Snapshot
            // the (x, y) immediately and free the wasm-bindgen handle
            // before the per-model loop drops the reference.
            const hinge = hingeFrames[pi];
            const hingeOffset = hinge
              ? [hinge.x, hinge.y]
              : [0, 0];
            partEntries[pi] = {
              texture: renderTex,
              worldBounds: [wb[0], wb[1]],
              triCount: mesh.triCount,
              // bbox.min in model-local x/y so the per-part sprite can
              // anchor on the part's centre rather than the whole
              // building's centre — without this every leaf draws
              // stacked at the placement origin, defeating per-part
              // addressability.
              localOffset: [
                (bbox[0] + bbox[3]) * 0.5,
                (bbox[1] + bbox[4]) * 0.5,
              ],
              hingeOffset,
              partIndex: pi,
            };
            mesh.free();
          }
          for (const h of hingeFrames) {
            if (h && typeof h.free === "function") h.free();
          }
          perPart.set(modelId, partEntries);
        }
        for (const sp of surfacePixels) sp.free();
        return perPart;
      }

      // Build a `PIXI.Container` of per-building per-part sprites and
      // populate `buildingMap`. Per-placement key is
      // `${landblockId.toString(16)}_${x.toFixed(2)}_${y.toFixed(2)}_${modelId.toString(16)}`
      // — stable across re-renders because the inputs come from the
      // server-authoritative `LandblockInfo.buildings` list, which
      // doesn't shift between fetches. Phase E will use the
      // `buildingMap` lookup to find the exact placement whose door
      // toggled.
      function buildBuildingsContainer(neighbourhood, buildings, perPartMap, fallbackMap, fallbackInvisible) {
        const container = new PIXI.Container();
        const buildingMap = new Map();
        const lbIndex = new Map();
        for (const n of neighbourhood) lbIndex.set((n.x << 16) | n.y, n);

        let withParts = 0;
        let withFallback = 0;
        let dropped = 0;

        for (const obj of buildings) {
          const lbX = (obj.landblockId >>> 24) & 0xff;
          const lbY = (obj.landblockId >>> 16) & 0xff;
          const n = lbIndex.get((lbX << 16) | lbY);
          if (!n) continue;
          const wx = n.x * METERS_PER_LANDBLOCK + obj.x;
          const wy = n.y * METERS_PER_LANDBLOCK + obj.y;
          const buildingKey =
            `${(obj.landblockId >>> 0).toString(16).padStart(8, "0")}_`
            + `${obj.x.toFixed(2)}_${obj.y.toFixed(2)}_`
            + `${(obj.modelId >>> 0).toString(16).padStart(8, "0")}`;

          const partEntries = perPartMap.get(obj.modelId);
          if (partEntries && partEntries.some((p) => p !== null)) {
            const buildingContainer = new PIXI.Container();
            buildingContainer.position.set(wx, wy);
            buildingContainer.rotation = -obj.rotationZ;
            buildingContainer.__buildingKey = buildingKey;
            buildingContainer.__buildingId = obj.modelId;
            buildingContainer.__landblockId = obj.landblockId;
            for (let pi = 0; pi < partEntries.length; pi += 1) {
              const part = partEntries[pi];
              if (!part) continue;
              const sprite = new PIXI.Sprite(part.texture);
              sprite.anchor.set(0.5, 0.5);
              // Phase 6 step E follow-up (2026-05-09): wrap each part
              // in an inner Container pivoted at the part's hinge, so
              // setting `partWrapper.rotation = θ` rotates the part
              // around the hinge edge instead of its geometric centre.
              // The wrapper sits at the hinge in model-local coords;
              // the inner sprite is offset to (localOffset - hinge) so
              // it visually lands at `localOffset` when rotation = 0.
              // Non-door parts have identity hinges (or arbitrary
              // placement_frames[0] origins) and never rotate, so the
              // wrapper is a no-op for them.
              const hox = part.hingeOffset[0];
              const hoy = part.hingeOffset[1];
              sprite.position.set(
                part.localOffset[0] - hox,
                part.localOffset[1] - hoy,
              );
              sprite.width = part.worldBounds[0];
              sprite.height = part.worldBounds[1];
              // Mirror compensation: same per-sprite pattern as the
              // fused single-sprite path. Without it the parent
              // worldContainer's scale.y=-1 puts model NORTH at screen
              // SOUTH (see the long comment in `buildObjectsContainer`).
              sprite.scale.y = -sprite.scale.y;
              const partWrapper = new PIXI.Container();
              partWrapper.position.set(hox, hoy);
              partWrapper.__buildingId = obj.modelId;
              partWrapper.__partIndex = pi;
              partWrapper.__triCount = part.triCount;
              partWrapper.__hingeOffset = [hox, hoy];
              partWrapper.__partLocalOffset = [
                part.localOffset[0],
                part.localOffset[1],
              ];
              partWrapper.addChild(sprite);
              buildingContainer.addChild(partWrapper);
            }
            container.addChild(buildingContainer);
            buildingMap.set(buildingKey, buildingContainer);
            withParts += 1;
          } else {
            // Per-part bake unavailable; fall back to the fused single-
            // sprite path so the building still renders. JS still adds
            // a buildingMap entry (Container with one fused-sprite
            // child) so capture probes find it.
            const fused = fallbackMap?.get(obj.modelId);
            const buildingContainer = new PIXI.Container();
            buildingContainer.position.set(wx, wy);
            buildingContainer.rotation = -obj.rotationZ;
            buildingContainer.__buildingKey = buildingKey;
            buildingContainer.__buildingId = obj.modelId;
            buildingContainer.__landblockId = obj.landblockId;
            if (fused) {
              const sprite = new PIXI.Sprite(fused.texture);
              sprite.anchor.set(0.5, 0.5);
              sprite.position.set(0, 0);
              sprite.width = fused.worldBounds[0];
              sprite.height = fused.worldBounds[1];
              sprite.scale.y = -sprite.scale.y;
              sprite.__buildingId = obj.modelId;
              sprite.__partIndex = 0;
              buildingContainer.addChild(sprite);
              withFallback += 1;
            } else if (fallbackInvisible?.has(obj.modelId)) {
              dropped += 1;
            } else {
              dropped += 1;
            }
            // Suppress empty fallback buildingContainers (per-part bake
            // missed AND no fused fallback) — they have nothing to
            // draw. buildingMap skip is safe: door-state rotation
            // matches against buildings with renderable parts, and a
            // building with zero parts has no doors to rotate.
            if (buildingContainer.children.length === 0) continue;
            container.addChild(buildingContainer);
            buildingMap.set(buildingKey, buildingContainer);
          }
        }
        return { container, buildingMap, withParts, withFallback, dropped };
      }

      // ----- Phase 6 step C: EnvCell render ------------------------
      //
      // A landblock's interior cells live behind doors. Each EnvCell
      // ships an environment_id (`0x0D…`), a frame transform in
      // landblock-local space, a portal table linking to neighbour
      // cells (Phase D's traversal graph), and a static-object list
      // (chairs, tables, chests). The wasm side
      // (`fetchEnvCellsInLandblock`) does the LandblockInfo →
      // EnvCell → Environment walk and ships placements as
      // `EnvCellPlacement` records: pre-baked mesh in cell-local
      // coords + per-static-object placements in world coords.
      //
      // The JS-side bake mirrors `bakePerPartBuildingTextures`
      // closely: one PIXI.RenderTexture per (cell_id, environment_id)
      // pair, baked from the wasm-returned mesh. Cells are stamped
      // into the scene graph at the cell origin with the cell
      // orientation applied. Phase D will gate per-cell `.visible` on
      // the active render set; Phase C unconditionally shows every
      // cell in a populated landblock.
      //
      // Phase 6 step D: per-frame visibility is driven by the player's
      // active cell + BFS render set (see `tickCellVisibility` below).
      // The pre-D `__cellRenderEnabled` toggle is gone — cells default
      // invisible and the rAF tick toggles `.visible = renderSet.has(cellId)`
      // each frame, with diff-only updates to avoid PIXI batch churn.

      async function bakeCellTextures(app, cellPlacements) {
        // Map<cell_id, { mesh: ModelMesh, environmentId, ...renderData }>.
        // The placement bundles already carry baked meshes per cell;
        // here we render each into a RenderTexture (one per cell since
        // the cell origin shifts the bake into a unique tile).
        // Buildings use one texture per (model_id, part_index) cached
        // because every placement is the same setup; cells, in
        // contrast, are unique geometries — every (cell_id,
        // environment_id) pair is a one-shot bake.
        const baked = new Map();
        if (cellPlacements.length === 0) return baked;
        const allSurfaceIds = new Set();
        const meshByCell = new Map();
        for (const placement of cellPlacements) {
          const cellId = placement.cellId;
          const mesh = placement.takeMesh();
          if (mesh.triCount === 0) {
            // No drawable geometry — skip cell-level render but keep
            // the placement entry visible to Phase D so the static-
            // object children still show up.
            mesh.free();
            meshByCell.set(cellId, null);
            continue;
          }
          for (const sid of mesh.surfaces) allSurfaceIds.add(sid);
          meshByCell.set(cellId, { mesh, environmentId: placement.environmentId });
        }

        const surfaceList = [...allSurfaceIds];
        const surfacePixels = surfaceList.length > 0
          ? await fetch_surfaces_pixels(new Uint32Array(surfaceList))
          : [];
        const surfaceTexBySid = new Map();
        for (let i = 0; i < surfaceList.length; i += 1) {
          surfaceTexBySid.set(surfaceList[i], surfacePixelsToTexture(surfacePixels[i]));
        }

        for (const [cellId, entry] of meshByCell) {
          if (!entry) continue;
          const { mesh, environmentId } = entry;
          const sList = mesh.surfaces;
          const texArr = new Array(sList.length);
          for (let s = 0; s < sList.length; s += 1) {
            texArr[s] = surfaceTexBySid.get(sList[s]) ?? makeFlatTexture();
          }
          const renderTex = renderModelTile(app, mesh, texArr);
          const wb = mesh.worldBounds;
          const bbox = mesh.bbox;
          baked.set(cellId, {
            texture: renderTex,
            worldBounds: [wb[0], wb[1]],
            triCount: mesh.triCount,
            // Same per-part offset trick as buildings: anchor the
            // sprite at the bake's bbox centre rather than the cell
            // origin, so the sprite covers the geometry regardless of
            // where the geometry sits relative to the cell origin
            // frame.
            localOffset: [
              (bbox[0] + bbox[3]) * 0.5,
              (bbox[1] + bbox[4]) * 0.5,
            ],
            environmentId,
          });
          mesh.free();
        }
        for (const sp of surfacePixels) sp.free();
        return baked;
      }

      // Build a `PIXI.Container` of per-cell containers (mesh sprite +
      // static-object children). Returns the parent container plus a
      // `cellContainers: Map<cell_id, PIXI.Container>` for capture-
      // script telemetry. Each cell container is tagged with
      // `__cellId`, `__environmentId`, `__landblockId`. Static-object
      // children carry `__staticObjectDid`. Static objects route
      // through the existing static-placement sprite map (atlas /
      // live tile / colour dot) — Phase C doesn't bake new sprites for
      // them; it only PLACES them at the cell-origin-rotated
      // positions exported by the wasm bundle.
      function buildCellsContainer(neighbourhood, cellPlacements, bakedCells, fallbackInvisible) {
        const container = new PIXI.Container();
        const cellContainers = new Map();
        const lbIndex = new Map();
        for (const n of neighbourhood) lbIndex.set((n.x << 16) | n.y, n);

        let withMesh = 0;
        let withStatics = 0;
        let totalStatics = 0;

        for (const placement of cellPlacements) {
          const cellId = placement.cellId;
          const landblockId = (cellId & 0xFFFF0000) >>> 0;
          const lbX = (landblockId >>> 24) & 0xff;
          const lbY = (landblockId >>> 16) & 0xff;
          // Cells outside the active neighbourhood drop. lbIndex is
          // populated from the rendered LB ring; cells whose parent
          // LB isn't in the ring are skipped.
          if (!lbIndex.has((lbX << 16) | lbY)) continue;
          const wx = placement.cellOriginX;
          const wy = placement.cellOriginY;
          const baked = bakedCells.get(cellId);
          const cellContainer = new PIXI.Container();
          cellContainer.position.set(wx, wy);
          // Cell orientation → yaw. Same atan2 reduction as
          // `frame_to_placement` on the Rust side.
          const qw = placement.cellOrientationQw;
          const qx = placement.cellOrientationQx;
          const qy = placement.cellOrientationQy;
          const qz = placement.cellOrientationQz;
          const siny_cosp = 2.0 * (qw * qz + qx * qy);
          const cosy_cosp = 1.0 - 2.0 * (qy * qy + qz * qz);
          const yaw = Math.atan2(siny_cosp, cosy_cosp);
          cellContainer.rotation = -yaw;
          cellContainer.__cellId = cellId;
          cellContainer.__environmentId = placement.environmentId;
          cellContainer.__landblockId = landblockId;
          if (baked) {
            const sprite = new PIXI.Sprite(baked.texture);
            sprite.anchor.set(0.5, 0.5);
            sprite.position.set(baked.localOffset[0], baked.localOffset[1]);
            sprite.width = baked.worldBounds[0];
            sprite.height = baked.worldBounds[1];
            sprite.scale.y = -sprite.scale.y;
            sprite.__triCount = baked.triCount;
            sprite.__cellMesh = true;
            cellContainer.addChild(sprite);
            withMesh += 1;
          }
          // Static objects: positions are already in WORLD coords (the
          // wasm side applied cell origin + cell rotation). Strip out
          // the parent cellContainer's offset+rotation by parking the
          // child at world coords directly inside cellContainer's
          // local frame: child.position = (worldX - wx, worldY - wy)
          // pre-rotation — but cellContainer's rotation will rotate
          // the child too, distorting the world placement. Use a
          // sibling child container (no rotation) to anchor static
          // objects in world space while the cell mesh sprite
          // continues to rotate with the cellContainer.
          const placementStatics = placement.takeStaticObjects();
          if (placementStatics.length > 0) {
            withStatics += 1;
            for (const so of placementStatics) {
              const childContainer = new PIXI.Container();
              // Park at world coord; subtract cell origin so the child
              // sits at the right global position inside the
              // cellContainer's pre-rotation frame. Then counter-
              // rotate so the child stays world-aligned.
              const localX = so.x - wx;
              const localY = so.y - wy;
              childContainer.position.set(localX, localY);
              // Counter-rotate to undo the parent's rotation.
              childContainer.rotation = yaw;
              childContainer.__staticObjectDid = so.did;
              childContainer.__staticObjectAabbLocal = so.aabbLocal;
              cellContainer.addChild(childContainer);
              so.free();
              totalStatics += 1;
            }
          }
          // Suppress empty cellContainers (no baked mesh AND no
          // statics) — they're scene-graph waste with nothing to draw.
          // Most empties come from `bakeCellTextures` skipping cells
          // with `triCount === 0` while no static objects fill in. The
          // registry skip is safe: `tickCellVisibility` only toggles
          // entries it finds in the registry, and there's nothing to
          // show for these cells anyway.
          if (cellContainer.children.length === 0) continue;
          container.addChild(cellContainer);
          cellContainers.set(cellId, cellContainer);
          // Phase 6 step D: cells start invisible; the per-frame
          // `tickCellVisibility` walk toggles them on once the player's
          // current-cell render set includes them. The pre-D
          // `__cellRenderEnabled` global is dropped — Phase D's BFS
          // is the single source of truth.
          cellContainer.visible = false;
        }
        return { container, cellContainers, withMesh, withStatics, totalStatics };
      }

      // ----- Phase 3 step 4 / 4.5 / 6: object sprite container ----

      function buildObjectsContainer(neighbourhood, objects, spriteMap, colourMap, liveSpriteMap, invisibleModels) {
        // One PIXI.Container holding all objects across all 9 landblocks.
        // Sits inside worldContainer (after the y-flip), so positions
        // are in world metres and the parent scale handles the AC
        // +north-up convention.
        //
        // Tint reasoning: the atlas tiles ship **per-poly real colours**
        // baked at static-site emit time (stone walls, wood beams, roof
        // tiles, etc — see `WorldBuilder.Terminal/ObjectSpriteGenerator.cs`
        // `DrawTriangle` which UV-maps each face's RenderSurface texture
        // into the sprite via `SKShader.CreateBitmap` + `DrawVertices`).
        // PIXI.Sprite.tint defaults to white = identity, so the atlas
        // colours come through unchanged — re-tinting with a single ARGB
        // would multiply per-pixel and destroy the per-poly variety.
        //
        // `colourMap` carries the per-model representative ARGB resolved
        // from each model's Surface chain in Rust (step 4.5). It's only
        // applied to the **fallback dot** path (when the atlas has no
        // tile for the model) — there it gives the dot a real per-model
        // colour rather than the legacy 2-bucket category palette.
        const container = new PIXI.Container();
        // NEIGHBOURHOOD entries carry the CellLandblock id (XXYYFFFF)
        // because that's what the heightmap fetch uses. Object
        // placements come from LandblockInfo (XXYYFFFE), so lookup
        // needs the (XX, YY) pair, not the full id. Stash by
        // (lbX << 16 | lbY) for a clean key.
        const lbIndex = new Map();
        for (const n of neighbourhood) lbIndex.set((n.x << 16) | n.y, n);

        let withLive = 0;
        let withSprite = 0;
        let fallback = 0;
        let invisible = 0;

        for (const obj of objects) {
          const lbX = (obj.landblockId >>> 24) & 0xff;
          const lbY = (obj.landblockId >>> 16) & 0xff;
          const n = lbIndex.get((lbX << 16) | lbY);
          if (!n) continue;
          const wx = n.x * METERS_PER_LANDBLOCK + obj.x;
          const wy = n.y * METERS_PER_LANDBLOCK + obj.y;
          const prefix = (obj.modelId >>> 24) & 0xff;

          // Atlas tile carries per-poly real colours baked at static-
          // site emit time (stone walls, wood beams, roof tiles —
          // ObjectSpriteGenerator.cs's DrawTriangle UV-maps each face's
          // RenderSurface texture into the sprite). PIXI.Sprite.tint
          // defaults to white = identity, so atlas pixels come through
          // unchanged. Re-tinting with one ARGB would multiply per-
          // pixel and destroy the per-poly variety.
          //
          // Fallback dot (atlas miss) gets the resolved per-model ARGB
          // from `fetch_object_colours` (step 4.5 walk); models the
          // walk couldn't resolve fall back to the legacy 2-bucket
          // category palette so the dot is still visible.
          const realColour = colourMap?.get(obj.modelId);
          const fallbackTint =
            realColour !== undefined
              ? realColour & 0x00ffffff
              : prefix === 0x01
                ? 0xa07c52
                : 0x7a8c5e;

          // Step 6: prefer the live-rendered tile if we have one for
          // this model. Falls back to atlas → fallback dot if not.
          const liveEntry = liveSpriteMap?.get(obj.modelId);
          const entry = liveEntry ?? spriteMap.get(obj.modelId);
          if (entry) {
            const sprite = new PIXI.Sprite(entry.texture);
            sprite.anchor.set(0.5, 0.5);
            sprite.position.set(wx, wy);
            sprite.width = entry.worldBounds[0];
            sprite.height = entry.worldBounds[1];
            // Negate yaw because worldContainer.scale.y = -1 mirrors
            // the scene; AC's CCW-from-above yaw reads as CW after
            // the flip.
            sprite.rotation = -obj.rotationZ;
            // Compensate for worldContainer.scale.y = -1.
            // Both bakes — the C# atlas (ObjectSpriteGenerator.cs's
            // WorldToPx: `pxY = (originY - vy) * pxPerUnit`) and our
            // wasm renderModelTile (`stage.scale.set(pxPerUnit, -pxPerUnit)`)
            // — produce textures whose pixel-row-0 is the model's
            // +Y (north) end. The static-site renderer
            // (RenderPreviewRenderer.cs) drops those textures
            // straight onto a Y-flipped canvas, so row 0 lands at
            // canvas-top = north on screen — correct.
            // PIXI by contrast nests the sprite's quad inside a
            // Y-flipped container, which inverts the quad's local
            // Y axis on render. Without this compensation, sprite-
            // local -h/2 (texture row 0, model NORTH) ends up at
            // screen +h/2 — i.e. the model's north side appears
            // SOUTH of its placement on screen. Asymmetric buildings
            // (e.g. Holtburg's `0x01000C1E` with the spiral tower
            // at one end) read as visibly mirrored along their local
            // east-west axis. Symmetric entities mask the bug.
            sprite.scale.y = -sprite.scale.y;
            container.addChild(sprite);
            if (liveEntry) withLive += 1;
            else withSprite += 1;
          } else if (invisibleModels?.has(obj.modelId)) {
            // Live walk yielded a 0-triangle mesh — engine-internal
            // anchor (e.g. light-source position marker, particle
            // emitter site) with NoPos-stippled geometry. These are
            // deliberately invisible in-game, so suppressing the
            // fallback dot keeps the renderer faithful to AC's actual
            // visible state. Confirmed for Holtburg's `0x02000364`:
            // single 8cm × 6cm vertical triangle with a Light, no
            // weenie binding (43,911 retail weenies scanned),
            // not in the static atlas — pure engine-internal scenery.
            invisible += 1;
          } else {
            // Fallback: small coloured dot. 1.5 m radius reads at
            // default zoom, scales naturally with the camera.
            const g = new PIXI.Graphics();
            g.circle(wx, wy, 1.5).fill({ color: fallbackTint, alpha: 0.85 });
            container.addChild(g);
            fallback += 1;
          }
        }
        return { container, withLive, withSprite, fallback, invisible };
      }

      function buildLandblockChildren(mesh, atlasTexture, roadTexture) {
        // Build the per-landblock mesh + road overlay + wireframe.
        // Step 3.6 (revised): the fragment shader does bilinear
        // 4-corner blending of the per-vertex terrain types from a
        // 9×9 vertex-types texture. Roads are drawn as VECTOR LINES
        // here in JS (mirrors emit-static-site's
        // `RenderPreviewRenderer.cs:551-580`), not via the shader —
        // that keeps the road network thin + diagonal regardless of
        // cell alignment, matching the static-site reference.
        //
        // Snapshot positions/indices/terrainCodes/roadCodes once —
        // each getter is a wasm-bindgen call that allocates a fresh
        // typed array.
        const positions3D = mesh.positions;
        const terrainCodes = mesh.terrainCodes;
        const roadCodes = mesh.roadCodes;
        const positions2D = new Float32Array(81 * 2);
        for (let i = 0; i < 81; i += 1) {
          positions2D[i * 2] = positions3D[i * 3];
          positions2D[i * 2 + 1] = positions3D[i * 3 + 1];
        }

        // Per-LB vertex-types texture + shader. Each LB's 9×9 grid of
        // terrain type bytes gets its own 9×9 RGBA8 texture; the
        // shader fragment looks up the 4 surrounding vertices' types
        // via texelFetch and bilinear-blends. Atlas is shared.
        const vertexTypesTexture = buildVertexTypesTexture(terrainCodes);
        const terrainShader = buildTerrainShader(atlasTexture, vertexTypesTexture);

        const indicesU32 = Uint32Array.from(mesh.indices);
        const geometry = new PIXI.Geometry({
          attributes: {
            aPosition: {
              buffer: positions2D,
              format: "float32x2",
            },
          },
          indexBuffer: indicesU32,
          topology: "triangle-list",
        });
        const pixiMesh = new PIXI.Mesh({ geometry, shader: terrainShader });

        // Vector road overlay (NEW step 3.6). Walk the 9×9 vertex
        // grid; for each vertex with `road != 0`, draw a stroked line
        // to its E / N / NE / NW neighbour if that neighbour is also
        // road != 0. Mirrors `RenderPreviewRenderer.cs:551-580` —
        // cardinal-only emission would silently drop diagonal road
        // runs; including NE+NW catches them at the cost of one
        // duplicated edge per L-corner (acceptable schematic noise).
        //
        // Stroke width: 1.5 m world-units. Looks like the static
        // site's mid-zoom road weight; thinner at zoom-in, thicker
        // at zoom-out via PIXI's natural scaling.
        const roadOverlay = new PIXI.Graphics();
        const ROAD_DIRS = [[1, 0], [0, 1], [1, 1], [-1, 1]];
        // Tile the real RoadType (DID 0x05001458) texture along the
        // stroke when available, mirroring C# `SKShader.CreateBitmap(
        // roadTile, Repeat, Repeat)` at RenderPreviewRenderer.cs:538.
        // Falls back to the flat tan placeholder when fetch_terrain_
        // textures didn't produce a code-32 tile (e.g. a custom DAT
        // with no RoadType chain).
        //
        // PIXI 8 StrokeStyle extends FillStyle, so `texture` +
        // `matrix` + `textureSpace: 'global'` work directly on the
        // stroke. With textureSpace: 'global', PIXI computes
        // textureMatrix = scale(1/srcW, 1/srcH) * inv(style.matrix),
        // i.e. UV = pos * inv(style.matrix) / sourceSize. To make the
        // texture tile every T world metres regardless of native
        // source resolution we set style.matrix = scale(T/srcW, T/srcH).
        // T = 6 m gives a road weight that reads as cobble/dirt at
        // the project's typical zoom (~8 px/m).
        const ROAD_TEXTURE_TILE_M = 6.0;
        const roadStrokeStyle = roadTexture
          ? {
              width: 1.5,
              texture: roadTexture,
              matrix: new PIXI.Matrix().scale(
                ROAD_TEXTURE_TILE_M / Math.max(1, roadTexture.source?.width ?? 64),
                ROAD_TEXTURE_TILE_M / Math.max(1, roadTexture.source?.height ?? 64),
              ),
              textureSpace: "global",
              alpha: 0.95,
              cap: "round",
            }
          : { width: 1.5, color: 0xC8B888, alpha: 0.95, cap: "round" };
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
              const x0 = positions2D[idx * 2];
              const y0 = positions2D[idx * 2 + 1];
              const x1 = positions2D[nIdx * 2];
              const y1 = positions2D[nIdx * 2 + 1];
              roadOverlay
                .moveTo(x0, y0)
                .lineTo(x1, y1)
                .stroke(roadStrokeStyle);
            }
          }
        }

        // Faint wireframe (step 3.5: was prominent diagnostic from
        // earlier steps; with real textures the cell grid would
        // overpower the actual content, so dialed way down). Still
        // useful for spotting tessellation issues at high zoom-in.
        const wire = new PIXI.Graphics();
        for (let i = 0; i < indicesU32.length; i += 3) {
          const a = indicesU32[i];
          const b = indicesU32[i + 1];
          const c = indicesU32[i + 2];
          wire.poly([
            positions2D[a * 2], positions2D[a * 2 + 1],
            positions2D[b * 2], positions2D[b * 2 + 1],
            positions2D[c * 2], positions2D[c * 2 + 1],
          ]).stroke({ width: 0.2, color: 0x000000, alpha: 0.12 });
        }

        // Z-order: terrain mesh → road lines → wireframe (faint
        // overlay). Roads above mesh so they're visible over any
        // colour blend; wireframe last so it can be toggled off
        // without affecting either content layer.
        return [pixiMesh, roadOverlay, wire];
      }

      function addLandblockToScene(parentContainer, mesh, lbX, lbY, atlasTexture, roadTexture) {
        const lbContainer = new PIXI.Container();
        // Landblock (XX, YY) occupies the world-metre square
        // [XX*192, (XX+1)*192] × [YY*192, (YY+1)*192].
        lbContainer.position.set(
          lbX * METERS_PER_LANDBLOCK,
          lbY * METERS_PER_LANDBLOCK
        );
        const children = buildLandblockChildren(mesh, atlasTexture, roadTexture);
        for (const child of children) lbContainer.addChild(child);
        parentContainer.addChild(lbContainer);
        return lbContainer;
      }

// ===== TERRAIN_TYPES (2D terrain colour-key palette, 32 entries) =====
      const TERRAIN_TYPES = [
        { code: 0x00, name: "BarrenRock",          color: 0xb4ad9a },
        { code: 0x01, name: "Grassland",           color: 0x5d8740 },
        { code: 0x02, name: "Ice",                 color: 0xd8e9f0 },
        { code: 0x03, name: "LushGrass",           color: 0x4f8a31 },
        { code: 0x04, name: "MarshSparseSwamp",    color: 0x6b6a3e },
        { code: 0x05, name: "MudRichDirt",         color: 0x6e4f30 },
        { code: 0x06, name: "ObsidianPlain",       color: 0x3a3530 },
        { code: 0x07, name: "PackedDirt",          color: 0x9d7c4f },
        { code: 0x08, name: "PatchyDirt",          color: 0xb0936c },
        { code: 0x09, name: "PatchyGrassland",     color: 0x82934a },
        { code: 0x0a, name: "SandYellow",          color: 0xd4c082 },
        { code: 0x0b, name: "SandGrey",            color: 0xb0a98e },
        { code: 0x0c, name: "SandRockStrewn",      color: 0xaa9a78 },
        { code: 0x0d, name: "SedimentaryRock",     color: 0xa37050 },
        { code: 0x0e, name: "SemiBarrenRock",      color: 0x948872 },
        { code: 0x0f, name: "Snow",                color: 0xf5f4f1 },
        { code: 0x10, name: "WaterRunning",        color: 0x3a6480 },
        { code: 0x11, name: "WaterStandingFresh",  color: 0x46708a },
        { code: 0x12, name: "WaterShallowSea",     color: 0x5a8398 },
        { code: 0x13, name: "WaterShallowStillSea",color: 0x6a93a4 },
        { code: 0x14, name: "WaterDeepSea",        color: 0x233e58 },
        { code: 0x15, name: "ForestFloor",         color: 0x4a5630 },
        { code: 0x16, name: "FauxWaterRunning",    color: 0x4f7e88 },
        { code: 0x17, name: "SeaSlime",            color: 0x5c7d3f },
        { code: 0x18, name: "Argila",              color: 0x8a5a44 },
        { code: 0x19, name: "Volcano1",            color: 0xb45638 },
        { code: 0x1a, name: "Volcano2",            color: 0x7a3326 },
        { code: 0x1b, name: "BlueIce",             color: 0xb8d4e2 },
        { code: 0x1c, name: "Moss",                color: 0x5a7340 },
        { code: 0x1d, name: "DarkMoss",            color: 0x3e5128 },
        { code: 0x1e, name: "Olthoi",              color: 0x98a356 },
        { code: 0x1f, name: "DesolateLands",       color: 0x8c7b5e },
      ];

// ===== ATLAS_* (2D terrain atlas grid constants) =====
      const ATLAS_COLS = 6;
      const ATLAS_ROWS = 6;
      const ATLAS_TILE_PX = 256;
      const ATLAS_PX = ATLAS_COLS * ATLAS_TILE_PX; // 1536; ATLAS_ROWS too.

// ===== ensureLandblockObjectsForLandblock 2D body (per-LB building/object
// PIXI render: fetch_landblock_objects + colours + bakePerPartBuildingTextures
// + buildBuildingsContainer + buildObjectsContainer + worldContainer.addChild).
// Pure-2D (the fn early-returns on !liveScene); 3D builds objects via init3D. =====
async function ensureLandblockObjectsForLandblock_2dBody(lbId, lbHex) {
        objectsRenderAddInFlight.add(lbId);
        const lbHex = `0x${lbId.toString(16).padStart(8, "0")}`;
        try {
          const cellId = (lbId | 0xfffe) >>> 0;
          const objects = await fetch_landblock_objects(new Uint32Array([cellId]));
          if (!objects || objects.length === 0) {
            objectsRenderAddedLbs.add(lbId);
            return;
          }
          // Resolve representative ARGB for any model id we haven't
          // tried yet. fetch_object_colours returns 0 when the walk
          // can't resolve a colour; we still mark "tried" so we don't
          // re-fetch every LB change for unresolveable models.
          const newColourModels = [...new Set(objects.map((o) => o.modelId))]
            .filter((id) => !colourResolveAttempted.has(id));
          if (newColourModels.length > 0) {
            try {
              const colours = await fetch_object_colours(new Uint32Array(newColourModels));
              for (let i = 0; i < newColourModels.length; i += 1) {
                colourResolveAttempted.add(newColourModels[i]);
                if (colours[i] !== 0) {
                  liveScene.colourMap.set(newColourModels[i], colours[i]);
                }
              }
            } catch (e) {
              for (const id of newColourModels) colourResolveAttempted.add(id);
              console.warn(`[colour] LB-change resolve failed for ${lbHex}:`, e);
            }
          }
          const lbX = (lbId >>> 24) & 0xff;
          const lbY = (lbId >>> 16) & 0xff;
          const neighbourhood = [{ x: lbX, y: lbY, id: cellId }];
          const buildings = objects.filter((o) => o.isBuilding);
          const nonBuildings = objects.filter((o) => !o.isBuilding);
          // Bake per-part textures for any building model we haven't
          // baked before. The bake cache is shared across LBs so a
          // building model that appears in two landblocks bakes once.
          if (buildings.length > 0) {
            const newBuildingModels = [...new Set(buildings.map((o) => o.modelId))]
              .filter((id) => !liveScene.perPartBuildingMap.has(id));
            if (newBuildingModels.length > 0) {
              try {
                const newBakes = await bakePerPartBuildingTextures(
                  liveScene.app, newBuildingModels
                );
                for (const [k, v] of newBakes) {
                  liveScene.perPartBuildingMap.set(k, v);
                }
              } catch (e) {
                console.warn(`[phase6.A] bake failed for ${lbHex}:`, e);
              }
            }
            const buildingsBundle = buildBuildingsContainer(
              neighbourhood,
              buildings,
              liveScene.perPartBuildingMap,
              liveScene.liveSpriteMap,
              liveScene.invisibleModels,
            );
            liveScene.outdoorContainer.addChild(buildingsBundle.container);
            // Merge per-placement entries into the shared buildingMap
            // so wasm-side door state lookups (Phase 6E) find them.
            for (const [k, v] of buildingsBundle.buildingMap) {
              liveScene.buildingMap.set(k, v);
            }
            console.log(
              `[phase6.A] painted ${buildingsBundle.withParts}+${buildingsBundle.withFallback} `
              + `(parts+fallback) buildings, dropped ${buildingsBundle.dropped} for ${lbHex}`
            );
          }
          if (nonBuildings.length > 0) {
            const objectsBundle = buildObjectsContainer(
              neighbourhood,
              nonBuildings,
              liveScene.spriteMap,
              liveScene.colourMap,
              liveScene.liveSpriteMap,
              liveScene.invisibleModels,
            );
            liveScene.outdoorContainer.addChild(objectsBundle.container);
            console.log(
              `[step4] painted ${objectsBundle.withSprite}+${objectsBundle.withLive} `
              + `(atlas+live) objects, fallback ${objectsBundle.fallback}, `
              + `invisible ${objectsBundle.invisible} for ${lbHex}`
            );
          }
          objectsRenderAddedLbs.add(lbId);
        } catch (e) {
          console.warn(`[buildings/objects] LB-change render failed for ${lbHex}:`, e);
        } finally {
          objectsRenderAddInFlight.delete(lbId);
        }
}
