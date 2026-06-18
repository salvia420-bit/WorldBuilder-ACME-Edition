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

