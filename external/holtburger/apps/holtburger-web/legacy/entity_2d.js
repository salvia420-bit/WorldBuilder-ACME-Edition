// ─────────────────────────────────────────────────────────────────────────
// QUARANTINED 2D PIXI entity code — retired 2026-06-18 (item 7b). Reference
// only per RULINGS item 2; NOT wired (references the 2D liveScene/PIXI sprite
// state). The 3D entity path is scene3d/entities.js (EntityManager).
// ─────────────────────────────────────────────────────────────────────────

// ===== handlePositionUpdate's 2D-sprite tail (sprite manipulation, lerp seed,
// velocity sampler, portal-swirl reposition). The shared streaming body ABOVE
// this in handlePositionUpdate stayed in index.html. =====
function handlePositionUpdate_2dTail(upd, guid, isLocal) {
        // 2D-only branch below (sprite manipulation, lerp setup,
        // velocity sampler) — these require a sprite entry that only
        // `liveScene` (and thus only 2D mode) can provide. Return
        // early in 3D mode where ensureEntitySprite returns null.
        const entry = ensureEntitySprite(guid, 0, null);
        if (!entry) return;
        if (entry.guid === undefined) entry.guid = guid;
        const { wx, wy } = landblockToWorldXY(upd.landblockId, upd.x, upd.y);
        // Tier 2: sample velocity from the position delta. Speed in
        // m/s — used by tickEntityAnimations to gate walk-cycle
        // playback (only animate while moving above threshold).
        const now = performance.now();
        if (entry.lastPosT !== undefined) {
          const dt = (now - entry.lastPosT) / 1000;
          if (dt > 0 && dt < 1.0) {  // ignore stale / first-update
            const dx = wx - entry.lastPosX;
            const dy = wy - entry.lastPosY;
            // Exponential moving average so a single
            // PublicUpdatePosition jitter doesn't immediately
            // flip the moving-state.
            const inst = Math.hypot(dx, dy) / dt;
            entry.speedMps = (entry.speedMps ?? 0) * 0.5 + inst * 0.5;
          }
        }
        entry.lastPosX = wx;
        entry.lastPosY = wy;
        entry.lastPosT = now;
        // Position interpolation polish: for non-local entities,
        // lerp from the sprite's current visual position to the
        // new authoritative target over ENTITY_LERP_DURATION_MS.
        // ACE pushes PublicUpdatePosition at ~100-300 ms cadence;
        // snap-rendering looked stuttery in crowded zones. The
        // local player skips this branch — its step 3.5 keystate-
        // driven prediction is what makes WASD feel responsive,
        // and lerping the local sprite would add input lag on top
        // of every PrivateUpdatePosition reconciliation.
        const isLocal =
          localPlayerGuid !== null && guid === (localPlayerGuid >>> 0);
        if (isLocal) {
          // 2026-05-10 academy-rubberband fix: do NOT sync the local
          // sprite to ACE's UpdatePosition broadcast at all. The
          // wasm-side integrator + JS-side step-3.5 prediction
          // together own the sprite's position; the heartbeat carries
          // our predicted pose to the server, and ACE's force-position
          // mechanism (via `force_position_sequence` advances) handles
          // genuine server overrides through the wasm UpdatePosition
          // handler's reconciliation gate, not through this JS branch.
          //
          // Why the snap was wrong: many AC server states leave the
          // server-side player position lagging client prediction —
          // e.g. fresh characters whose Run skill is 0 mean the
          // server-side run speed is effectively walking pace while
          // the JS-side `FALLBACK_RUN_RATE_SCALAR=4.5 m/s` predicts
          // a fast jog. ACE happily accepts our heartbeats (no
          // force_position_sequence advance), but its authoritative
          // pose stays at-or-near spawn. Re-syncing the sprite to
          // that authoritative pose on every UpdatePosition was the
          // user-visible "snaps back to starting spot when I move"
          // symptom. Mirrors how the upstream cli's TUI map renders
          // off `world.local_player_runtime_pose()` (the integrator-
          // owned body.pose) — not off the raw server broadcast.
          //
          // 2026-05-13 teleport-snap follow-on: the no-snap policy is
          // correct for same-LB heartbeats, but a server-issued
          // PlayerTeleport (or @teleloc) crosses to a new landblock
          // and the JS-side step-3.5 prediction has no concept of the
          // teleport — it keeps integrating WASD on top of the OLD
          // sprite position. Detect the LB crossing here (high 16
          // bits of upd.landblockId) and snap sprite to the new
          // (wx, wy), then reset the step-3.5 prediction
          // bookkeeping so it restarts from the new pose. First
          // PrivateUpdatePosition after spawn also snaps because
          // entry.lastLocalLbId is undefined. Same-LB heartbeats
          // leave the rubberband fix above intact.
          const lbHigh = ((upd.landblockId >>> 16) << 16) >>> 0;
          if (entry.lastLocalLbId !== lbHigh) {
            entry.sprite.x = wx;
            entry.sprite.y = wy;
            window.__predLastPos = { x: wx, y: wy };
            window.__predFirstPos = undefined;
            window.__predLastTickMs = undefined;
            entry.lastLocalLbId = lbHigh;
          }
          entry.lerpStartMs = undefined;
          entry.lerpDurationMs = undefined;
        } else {
          entry.lerpFromX = entry.sprite.x;
          entry.lerpFromY = entry.sprite.y;
          entry.lerpToX = wx;
          entry.lerpToY = wy;
          entry.lerpStartMs = now;
        }
        // Rotation handling: trust JS prediction's rotation while the
        // user is actively turning, or if they recently moved/turned
        // (server lags client prediction). Otherwise sync rotation
        // from the server pose. Without this gate the unconditional
        // `entry.sprite.rotation =` snap fights the JS-side step-3.5
        // prediction's heading integration on every server broadcast,
        // and the user sees the sprite jerk to an older heading
        // mid-turn.
        let turningNow = false;
        if (isLocal) {
          const sigParts = (window.__lastInputSig ?? "0,0,0,false").split(",");
          const turnAxis = sigParts[2] || "0";
          turningNow = turnAxis !== "0";
        }
        const recentLocalActivity =
          isLocal
          && window.__predLastTickMs !== undefined
          && (now - window.__predLastTickMs) < 1500;
        if (!turningNow && !recentLocalActivity) {
            entry.sprite.rotation = -quaternionToYaw(upd.qw, upd.qx, upd.qy, upd.qz) + SPRITE_HEADING_OFFSET;
        }
        // Portal swirl tracks the sprite — `tickEntityInterpolation`
        // syncs it along with the lerp so we don't snap the swirl
        // to the target position while the sprite is mid-lerp.
        // For local-player snap and post-lerp finalization, the
        // swirl is repositioned in those branches.
        if (isLocal && entry.portalSwirl) {
          entry.portalSwirl.position.set(wx, wy);
        }
}

// ===== cloneEntitySpawn + placeholder glyph stack (ITEM_TYPE/CATEGORY_TINT/categoryForItemType/drawGlyphForCategory) =====
      function cloneEntitySpawn(upd) {
        // A15-Q2: under `?unifiedClone=on`, use the shared schema. The
        // deferred spawn is replayed through handleEntitySpawn →
        // metaFromSpawn, which re-normalizes (`>>> 0` / `|| ""`), so the
        // unified clone's normalization + array-copy is behavior-safe and
        // strictly more self-contained than the legacy raw-field copy.
        if (__UNIFIED_CLONE) {
          return __unifiedCloneEntityUpdate(upd);
        }
        return {
          kind: upd.kind,
          guid: upd.guid,
          modelId: upd.modelId,
          landblockId: upd.landblockId,
          x: upd.x, y: upd.y, z: upd.z,
          qw: upd.qw, qx: upd.qx, qy: upd.qy, qz: upd.qz,
          wcid: upd.wcid,
          itemType: upd.itemType,
          name: upd.name,
          objScale: upd.objScale,
          iconId: upd.iconId,
          paletteId: upd.paletteId,
          mtableId: upd.mtableId,
          // wasm-bindgen Vec<u32> getters return a fresh Uint32Array
          // each call; capture the array directly so the clone is
          // self-contained.
          modelChanges: upd.modelChanges,
          textureChanges: upd.textureChanges,
          subPalettes: upd.subPalettes,
          // H2: entity's PhysicsScript DID for in-world particle effects.
          physicsScriptDid: upd.physicsScriptDid,
          // Task E (2026-05-12): entity's SoundTable DID. Plumbed parallel
          // to physicsScriptDid through the deferred-spawn clone pipe so
          // the 2D drainEvents → ensureEntitySprite flow doesn't lose it.
          soundTableDid: upd.soundTableDid,
        };
      }

      // Phase 4 step 6a/6b: ItemType bitmask values from
      // external/ACE/Source/ACE.Entity/Enum/ItemType.cs:6 — the wire
      // PublicWeenieDescription.item_type IS this bitmask. Used by
      // `categoryForItemType` to derive the visual category for tinting
      // and glyph fallback. We mirror the subset that drives rendering;
      // the full enum has more (Gameboard, TinkeringMaterial, etc.)
      // that we don't differentiate visually yet.
      const ITEM_TYPE = Object.freeze({
        MELEE_WEAPON:     0x00000001,
        ARMOR:            0x00000002,
        CLOTHING:         0x00000004,
        JEWELRY:          0x00000008,
        CREATURE:         0x00000010,
        FOOD:             0x00000020,
        MONEY:            0x00000040,
        MISC:             0x00000080,
        MISSILE_WEAPON:   0x00000100,
        CONTAINER:        0x00000200,
        USELESS:          0x00000400,
        GEM:              0x00000800,
        SPELL_COMPONENTS: 0x00001000,
        WRITABLE:         0x00002000,
        KEY:              0x00004000,
        CASTER:           0x00008000,
        PORTAL:           0x00010000,
        LIFE_STONE:       0x10000000,
      });

      // Map an ItemType bitmask to a single visual category string. The
      // wire bitmask can carry multiple bits (e.g. PortalMagicTarget =
      // Portal | LifeStone), so order matters — Portal wins over
      // LifeStone, Creature wins over Container, etc. Mirrors the
      // category dispatch in WorldBuilder.Terminal/ObjectSpriteGenerator
      // .cs:683-694 + RenderPreviewRenderer.cs:230-299, scaled down to
      // the data we have on the wire (no WeenieType, no tags).
      function categoryForItemType(itemType) {
        const t = itemType >>> 0;
        if (!t) return "unknown";
        if (t & ITEM_TYPE.PORTAL) return "portal";
        if (t & ITEM_TYPE.LIFE_STONE) return "lifestone";
        if (t & ITEM_TYPE.CREATURE) return "creature";
        if (t & ITEM_TYPE.CONTAINER) return "container";
        if (t & (ITEM_TYPE.MELEE_WEAPON | ITEM_TYPE.MISSILE_WEAPON | ITEM_TYPE.CASTER)) return "weapon";
        if (t & (ITEM_TYPE.ARMOR | ITEM_TYPE.CLOTHING)) return "armor";
        if (t & ITEM_TYPE.WRITABLE) return "writable";
        if (t & ITEM_TYPE.KEY) return "key";
        if (t & ITEM_TYPE.GEM) return "gem";
        if (t & ITEM_TYPE.MONEY) return "money";
        if (t & ITEM_TYPE.FOOD) return "food";
        return "misc";
      }

      // Tint applied multiplicatively to the rasterized sprite for each
      // visual category. White = no tint (the model's own colours win).
      // Hot categories (Portal, Creature) get a saturated overlay to
      // make them readable at zoom-out; subtle categories (weapon,
      // armor, gem) get a near-white tint that barely shifts the model.
      // Mirrors ObjectSpriteGenerator.cs:683-694's per-WeenieType colour.
      const CATEGORY_TINT = Object.freeze({
        portal:    0x6EC8E0,  // cyan — matches static-site Portal=7
        lifestone: 0x4DA0E8,  // blue — radar-NE matches LifeStone
        creature:  0xE8A0A0,  // soft red wash on creature models
        container: 0xE8D8B0,  // warm tan over chests/coffers
        weapon:    0xF0F0F0,
        armor:     0xF0E8D8,
        writable:  0xF0C870,  // amber — signs and books
        key:       0xF0D060,  // gold
        gem:       0xC0E8F0,
        money:     0xF8E090,
        food:      0xF0E0C0,
        misc:      0xFFFFFF,
        unknown:   0xFFFFFF,
      });

      // Build the placeholder Graphics for a category. Replaces the
      // generic magenta dot that step 2b shipped with the static-site
      // glyph shapes, so even pre-rasterization the user can see "that
      // blob is a portal, that one is a creature." Sized in world
      // metres (the entityContainer is in world space). Mirrors the
      // glyph table at RenderPreviewRenderer.cs:230-299.
      function drawGlyphForCategory(category) {
        const g = new PIXI.Graphics();
        switch (category) {
          case "portal":
            // cyan ring — distinctive even at small sizes
            return g.circle(0, 0, 0.8)
              .stroke({ color: 0x6EC8E0, width: 0.18, alignment: 0.5 });
          case "lifestone":
            return g.circle(0, 0, 0.7).fill({ color: 0x4DA0E8 });
          case "creature":
            // red diamond
            return g.poly([0, -0.8, 0.7, 0, 0, 0.8, -0.7, 0])
              .fill({ color: 0xC0392B });
          case "container":
            // brown square
            return g.rect(-0.6, -0.6, 1.2, 1.2).fill({ color: 0x8A7B5A });
          case "weapon":
            return g.rect(-0.3, -0.7, 0.6, 1.4).fill({ color: 0xCDCDCD });
          case "armor":
            return g.rect(-0.6, -0.4, 1.2, 0.8).fill({ color: 0x9B8A6F });
          case "writable":
            // orange triangle (signs / books)
            return g.poly([0, -0.8, 0.7, 0.6, -0.7, 0.6])
              .fill({ color: 0xE09A3F });
          case "key":
            return g.rect(-0.2, -0.6, 0.4, 1.2).fill({ color: 0xE8C46A });
          case "gem":
            return g.poly([0, -0.5, 0.4, 0, 0, 0.5, -0.4, 0])
              .fill({ color: 0x80C0F0 });
          case "money":
            return g.circle(0, 0, 0.5).fill({ color: 0xF0D060 });
          case "food":
            return g.circle(0, 0, 0.5).fill({ color: 0xC8A060 });
          case "misc":
          case "unknown":
          default:
            return g.circle(0, 0, 0.6).fill({ color: 0xb0b0b0 });
        }
      }

// ===== 2D entity-sprite stack: fetch/bake/cache + nameplate + handleEntitySpawn + ensurePortalSwirl/drawPortalSwirl (per the §9 ruling: 2D per-portal ring retired; 3D uses the global portal_space.js donut) =====
      function fetchEntityModelOnDemand(modelId, meta) {
        if (!liveScene) return Promise.resolve(null);
        // Phase 4 step 6 Phase A: composite cache key. NPCs sharing the
        // same csetup_id (e.g. two Holtburg humans) but different
        // equipped armor produce different visual sprites — caching
        // by raw modelId would alias them. Build a deterministic key
        // from modelId + a hash of model_changes + texture_changes
        // (the wire substitution data) so substituted sprites get
        // their own cache entry, but unsubstituted entities still hit
        // the original modelId cache.
        const key = computeEntitySpriteKey(modelId, meta);
        const cached = liveScene.liveSpriteMap?.get(key);
        if (cached) return Promise.resolve(cached);
        if (liveScene.invisibleModels?.has(key)) return Promise.resolve(null);
        if (pendingModelFetches.has(key)) return pendingModelFetches.get(key);
        const app = liveScene.app;
        if (!app) return Promise.resolve(null);
        const liveMap = liveScene.liveSpriteMap;
        const invisibleSet = liveScene.invisibleModels;
        const hasSubs = meta?.hasSubstitutions === true;
        const promise = (async () => {
          try {
            if (hasSubs) {
              // Substituted path: drive the new fetchEntityModelRender
              // export, which applies model_data.model_changes (per-
              // part GfxObj swaps) + model_data.texture_changes (per-
              // part texture remaps) at triangulation time. Result is
              // the fully-composed NPC mesh, packed back into the
              // same liveMap entry shape so the caller is agnostic.
              await addEntityRenderToLiveSpriteMap(
                app, key, modelId, meta, liveMap, invisibleSet,
              );
            } else {
              // Unsubstituted path: original Phase 3 step 6 fetch.
              // key === modelId here so the existing cache continues
              // to share entries across all callers of this id.
              await addModelsToLiveSpriteMap(app, [modelId], liveMap, invisibleSet);
            }
            return liveMap.get(key) ?? null;
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[entity-model-fetch] key=${key} modelId=0x${modelId.toString(16)} failed:`, err);
            return null;
          } finally {
            pendingModelFetches.delete(key);
          }
        })();
        pendingModelFetches.set(key, promise);
        return promise;
      }

      // Phase 4 step 6 Phase A: derive a cache key for an entity
      // sprite. For unsubstituted entities the key is the bare
      // modelId — same string the static-placement path uses, so
      // existing cache entries are reused. For substituted entities
      // (NPCs etc.) the key folds in a content hash of the
      // substitution arrays so different equipment combinations on
      // the same csetup_id don't alias each other in the cache.
      function computeEntitySpriteKey(modelId, meta) {
        if (!meta?.hasSubstitutions) return modelId;
        // Cheap fnv-1a 32-bit over the flat substitution buffers + the
        // entity's base palette ID. Two NPCs sharing the same csetup_id
        // and same equipped armor but with different skin tones (different
        // PaletteBaseDID) get distinct sprites in the cache. Collisions
        // are visually tolerable (worst case: two NPCs share a sprite);
        // rate is sub-ppm for reasonable equipment counts. Stringify the
        // result so liveMap doesn't confuse it with a numeric modelId
        // on the unsubstituted path.
        let h = 0x811C9DC5 >>> 0;
        const mix = (arr) => {
          if (!arr) return;
          for (let i = 0; i < arr.length; i++) {
            h ^= arr[i] >>> 0;
            h = Math.imul(h, 0x01000193) >>> 0;
          }
        };
        mix(meta.modelChanges);
        mix(meta.textureChanges);
        mix(meta.subPalettes);
        // Fold paletteId in as a single-element array (so it
        // participates in the same fnv mixing).
        if (meta.paletteId) mix([meta.paletteId]);
        return `${modelId.toString(16)}:${h.toString(16)}`;
      }

      // Phase 4 step 6 Phase A + B: substituted-entity render path.
      // Mirrors addModelsToLiveSpriteMap exactly, but:
      //  - mesh comes from fetchEntityModelRender (applies the
      //    per-part GfxObj + texture-DID swaps ACE pre-computed in
      //    CalculateObjDesc, Phase A);
      //  - surface pixels come from fetchEntitySurfacesPixels when
      //    the entity carries a base palette override OR sub-palette
      //    overlays (Phase B), so creature skin tones / dyed armour
      //    render with the right colours instead of every NPC's
      //    intrinsic-palette default.
      // Output entry shape ({ texture, worldBounds }) matches the
      // unsubstituted path so downstream sprite construction code is
      // path-agnostic.
      async function addEntityRenderToLiveSpriteMap(
        app, cacheKey, modelId, meta, liveMap, invisibleSet,
      ) {
        const mesh = await fetchEntityModelRender(
          modelId,
          meta.modelChanges ?? new Uint32Array(0),
          meta.textureChanges ?? new Uint32Array(0),
          meta.mtableId >>> 0,
        );
        if (mesh.triCount === 0) {
          if (invisibleSet) invisibleSet.add(cacheKey);
          mesh.free();
          return;
        }
        const sList = mesh.surfaces;
        // Phase B: drive the palette-aware surface fetch when the
        // entity has either a base palette override or any sub-
        // palette overlay; otherwise keep the cheaper fetch_surfaces_
        // pixels path so the no-recolour case stays free.
        const hasPaletteSubs =
          (meta?.paletteId && meta.paletteId !== 0)
          || (meta?.subPalettes && meta.subPalettes.length > 0);
        const surfacePixels = sList.length === 0
          ? []
          : (hasPaletteSubs
              ? await fetchEntitySurfacesPixels(
                  new Uint32Array(sList),
                  meta.paletteId >>> 0,
                  meta.subPalettes ?? new Uint32Array(0),
                )
              : await fetch_surfaces_pixels(new Uint32Array(sList))
            );
        const texArr = new Array(sList.length);
        for (let s = 0; s < sList.length; s += 1) {
          texArr[s] = surfacePixelsToTexture(surfacePixels[s]) ?? makeFlatTexture();
        }
        const renderTex = renderModelTile(app, mesh, texArr);
        const wb = mesh.worldBounds;
        liveMap.set(cacheKey, {
          texture: renderTex,
          worldBounds: [wb[0], wb[1]],
          // Tier 2 + stance-keyed cycles: per-stance walk/run frames
          // + framerates from the MotionTable's AnimData. Populated
          // lazily on first detected movement; additional stance
          // entries land when the entity's motionStance changes
          // (NPC engages combat → bake HandCombat cycles, etc.).
          //
          // Map<stance_u16, { walkFrames: Texture[], walkFramerate,
          //                   runFrames: Texture[], runFramerate }>
          //
          // Stance is the u16 MotionStance.interpreted() value
          // (low 16 bits of the 0x8000_xxxx form). Empty Texture[]
          // for cycles the MotionTable doesn't define for this
          // stance — the gate falls back to defaultStance's bake.
          cycleBakes: new Map(),
          // Stances we've fired a bake for (whether or not it landed
          // yet, and whether or not it produced any frames). Stops
          // re-baking the same stance on every rAF tick after a
          // miss. Keys are u16 stances; the special value `0` means
          // "the initial pre-UpdateMotion bake before motionStance
          // was known" — once that bake lands we record the
          // resolved stance under cycleBakes and add it to this set
          // too so the gate doesn't re-kick when motionStance arrives
          // matching the resolved default.
          cycleBakesInFlight: new Set(),
          // The MotionTable's `default_style` discovered at first
          // bake. Used as the fallback target when motionStance
          // doesn't have its own cycle baked yet (or when the
          // entity's stance has no MotionTable cycle at all).
          // u16; 0 = unknown / first-bake pending.
          defaultStance: 0,
        });
        mesh.free();
        for (const sp of surfacePixels) sp.free();
      }

      // Per-setup cap on stance bakes. Each (stance, walk+run) bake
      // costs ~6-15 MB of texture memory per entity setup; allowing
      // unbounded bakes risks runaway memory in dense combat zones
      // where NPCs flip stance frequently. 4 stances covers
      // (NonCombat, HandCombat, SwordCombat, Magic) which is the
      // realistic upper bound for a single creature. Beyond that,
      // the gate degrades to defaultStance fallback.
      const MAX_BAKES_PER_SETUP = 4;

      // Tier 2 + stance-keyed cycles: lazily bake walk + run cycle
      // frame textures for a (cacheKey, stance) combination. Skipped
      // when (a) entity has no setup (modelId === 0), (b) this stance
      // has already been baked OR is in flight, (c) the cached
      // liveMap entry is gone, or (d) the per-setup bake cap is hit.
      //
      // `stance` is the u16 MotionStance.interpreted() value (low 16
      // bits of the 0x8000_xxxx form), OR `0` for the first-bake
      // pre-UpdateMotion call which lets the wasm export resolve
      // against the MotionTable's default_style. The export returns
      // the actual `resolvedStance` it used so we can key the cache
      // by that — a later motionStance update matching the resolved
      // default-style hits the cache instead of triggering a
      // redundant bake.
      //
      // Fire-and-forget: the per-rAF cycler picks up cycleBakes once
      // populated; until then sprites stay on the idle texture (or
      // the previously-cached stance's frames if any).
      function kickCycleFrameBakeIfNeeded(cacheKey, modelId, meta, stance) {
        if (!liveScene || !modelId) return;
        const entry = liveScene.liveSpriteMap?.get(cacheKey);
        if (!entry) return;
        const reqStance = (stance ?? 0) >>> 0;
        // Already baked or baking? Skip.
        if (entry.cycleBakes.has(reqStance) || entry.cycleBakesInFlight.has(reqStance)) {
          return;
        }
        // Per-setup cap. Once hit, the gate keeps using whichever
        // stances ARE baked + falls back to defaultStance.
        if (entry.cycleBakes.size >= MAX_BAKES_PER_SETUP) {
          return;
        }
        entry.cycleBakesInFlight.add(reqStance);
        const app = liveScene.app;
        if (!app) {
          entry.cycleBakesInFlight.delete(reqStance);
          return;
        }
        (async () => {
          let cycleSet = null;
          try {
            cycleSet = await fetchEntityCycleFrames(
              modelId,
              meta?.modelChanges ?? new Uint32Array(0),
              meta?.textureChanges ?? new Uint32Array(0),
              (meta?.mtableId ?? 0) >>> 0,
              reqStance,
            );
            const resolvedStance = cycleSet.resolvedStance >>> 0;
            const walkMeshes = cycleSet.takeWalkFrames();
            const runMeshes = cycleSet.takeRunFrames();
            const walkFramerate = cycleSet.walkFramerate;
            const runFramerate = cycleSet.runFramerate;
            // Each frame across BOTH cycles uses the same surface
            // textures as the idle bake (walk/run pose changes part
            // transforms, not surface assignments). Look up their
            // RGBA8 once via the first available mesh, reuse across
            // every frame's per-poly rasterizer pass.
            const refMesh = walkMeshes[0] ?? runMeshes[0];
            // Stash key: prefer the wasm-resolved stance (the
            // MotionTable's actual default when reqStance was 0;
            // identical to reqStance when it was specified). Falls
            // back to reqStance for setups where no cycles resolved
            // at all (raw GfxObj 0x01, mtable load failure) so we
            // still cache the "no cycles" verdict and don't retry.
            const cacheStance = resolvedStance !== 0 ? resolvedStance : reqStance;
            if (!refMesh) {
              // No cycles resolved under this stance. Cache an
              // empty entry to prevent re-bake; gate falls back to
              // defaultStance or the idle texture.
              entry.cycleBakes.set(cacheStance, {
                walkFrames: [],
                walkFramerate: 0,
                runFrames: [],
                runFramerate: 0,
              });
              if (entry.defaultStance === 0 && reqStance === 0) {
                entry.defaultStance = cacheStance;
              }
              return;
            }
            const sList = refMesh.surfaces;
            const hasPaletteSubs =
              (meta?.paletteId && meta.paletteId !== 0)
              || (meta?.subPalettes && meta.subPalettes.length > 0);
            const surfacePixels = sList.length === 0
              ? []
              : (hasPaletteSubs
                  ? await fetchEntitySurfacesPixels(
                      new Uint32Array(sList),
                      meta.paletteId >>> 0,
                      meta.subPalettes ?? new Uint32Array(0),
                    )
                  : await fetch_surfaces_pixels(new Uint32Array(sList))
                );
            const texArr = new Array(sList.length);
            for (let s = 0; s < sList.length; s += 1) {
              texArr[s] = surfacePixelsToTexture(surfacePixels[s]) ?? makeFlatTexture();
            }
            const bake = (meshes) => {
              const out = [];
              for (const mesh of meshes) {
                if (mesh.triCount === 0) {
                  mesh.free();
                  continue;
                }
                const tex = renderModelTile(app, mesh, texArr);
                out.push(tex);
                mesh.free();
              }
              return out;
            };
            entry.cycleBakes.set(cacheStance, {
              walkFrames: bake(walkMeshes),
              walkFramerate,
              runFrames: bake(runMeshes),
              runFramerate,
            });
            // Discover the entity's default stance on first bake
            // (when reqStance was 0). Subsequent bakes for non-zero
            // stances don't overwrite this — defaultStance is the
            // MotionTable's `default_style`, NOT whatever stance is
            // currently active.
            if (entry.defaultStance === 0 && reqStance === 0) {
              entry.defaultStance = cacheStance;
            }
            for (const sp of surfacePixels) sp.free();
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(`[cycle-bake] key=${cacheKey} modelId=0x${modelId.toString(16)} stance=0x${reqStance.toString(16)} failed:`, err);
            // Cache an empty entry to prevent retry storm; gate
            // falls back to defaultStance or idle.
            entry.cycleBakes.set(reqStance, {
              walkFrames: [],
              walkFramerate: 0,
              runFrames: [],
              runFramerate: 0,
            });
          } finally {
            if (cycleSet) cycleSet.free();
            entry.cycleBakesInFlight.delete(reqStance);
          }
        })();
      }
      // Backwards-compat alias kept for capture scripts that use
      // the old name. Defaults to stance=0 (use MotionTable's
      // default_style), which matches the pre-stance-aware semantic.
      const kickWalkFrameBakeIfNeeded = (cacheKey, modelId, meta) =>
        kickCycleFrameBakeIfNeeded(cacheKey, modelId, meta, 0);

      // Apply the visual category's tint + scale to a freshly minted
      // sprite. Idempotent — safe to call from both `ensureEntitySprite`
      // (initial placement) and `upgradeEntitySprite` (after on-demand
      // fetch resolves). For the placeholder/invisible kinds, tint is a
      // no-op (Graphics already encode their colour, Containers have no
      // tint slot). For the real-sprite kind, it sets PIXI.Sprite.tint
      // (multiplicative — white = identity) and scales worldBounds by
      // meta.objScale.
      function applyMetaToSprite(entry, renderEntry) {
        if (!entry || !entry.sprite) return;
        const meta = entry.meta || {};
        const category = meta.category || "unknown";
        const objScale = meta.objScale && meta.objScale > 0 ? meta.objScale : 1.0;
        if (entry.kind === "sprite" && renderEntry) {
          // Re-apply width/height in case objScale changed between fetch
          // and meta arrival, and tint based on category.
          if (renderEntry.worldBounds) {
            entry.sprite.width = renderEntry.worldBounds[0] * objScale;
            entry.sprite.height = renderEntry.worldBounds[1] * objScale;
          }
          // Skip tinting "misc"/"unknown" (white = identity) — and skip
          // tinting "creature" if we haven't yet plumbed friend/foe to
          // avoid red-washing every NPC. Step 6e (nameplates) will
          // colour-code via the radar_blip_color path; for now leave
          // creatures untinted so retail-coloured models read clean.
          const tint = CATEGORY_TINT[category];
          if (tint !== undefined && category !== "misc" && category !== "unknown" && category !== "creature") {
            entry.sprite.tint = tint;
          }
        }
      }

      // Replace the placeholder glyph in `entry` with a real model
      // sprite once the on-demand fetch completes. Driven by
      // `entry.pendingFetchModelId` rather than `entry.modelId === 0`
      // so it doesn't collide with the pre-ObjectCreate placeholder
      // path the recv loop's PrivateUpdatePosition arm uses.
      function upgradeEntitySprite(guid, modelId, renderEntry) {
        if (!liveScene) return;
        const entry = entityMap.get(guid);
        if (!entry) return;  // entity already removed
        if (entry.pendingFetchModelId !== modelId) return;  // newer fetch superseded this one
        entry.pendingFetchModelId = null;
        if (!renderEntry) return;  // fetch failed; keep placeholder
        // Preserve world position + rotation from the placeholder.
        const { x, y, rotation } = entry.sprite;
        entry.sprite.destroy();
        const sprite = new PIXI.Sprite(renderEntry.texture);
        sprite.anchor.set(0.5, 0.5);
        sprite.position.set(x, y);
        sprite.rotation = rotation;
        // worldBounds are pre-objScale; applyMetaToSprite multiplies.
        if (renderEntry.worldBounds) {
          sprite.width = renderEntry.worldBounds[0];
          sprite.height = renderEntry.worldBounds[1];
        }
        // worldContainer Y-flip compensation — see the long comment
        // on the static-placement sprite at the top of
        // buildObjectsContainer for the full derivation. Same fix
        // applied uniformly so symmetric entities also render in
        // the correct orientation rather than being secretly mirrored.
        sprite.scale.y = -sprite.scale.y;
        liveScene.entityContainer.addChild(sprite);
        entry.sprite = sprite;
        entry.modelId = modelId;
        entry.kind = "sprite";
        applyMetaToSprite(entry, renderEntry);
        // Phase 4 step 5: re-attach the click handler to the new
        // sprite (the placeholder's handler died with its
        // PIXI.Graphics instance). Skips the local player + non-
        // interactable categories.
        setupEntityClickability(sprite, guid, entry.meta);
      }

      // Phase 4 step 5 (interactive entities) — wire a per-sprite
      // pointerdown handler that dispatches `handle.useObject(guid)`
      // when the player clicks. Skips:
      // - The local player's own sprite (self-click is a no-op).
      // - Categories ACE doesn't respond meaningfully to (food,
      //   gem, money, key, weapon, armor — these only react when
      //   the player picks them up via `MoveToObject`-style flow,
      //   not click-and-use; deferring drag/pickup to a future step).
      //
      // Interactable categories (Portal, LifeStone, Creature —
      // includes Vendors and NPCs — Container, Writable — signs and
      // books) get cursor=pointer + a hover-tint shift and the click
      // handler. `e.stopPropagation()` keeps the camera-pan handler
      // (which lives on `app.stage`) from also firing on the same
      // pointerdown.
      function setupEntityClickability(sprite, guid, meta) {
        if (!sprite || !meta) return;
        if (guid === getLocalPlayerGuid()) return;
        const cat = meta.category;
        const interactable =
          cat === "portal"
          || cat === "lifestone"
          || cat === "creature"
          || cat === "container"
          || cat === "writable";
        if (!interactable) return;
        sprite.eventMode = "static";
        sprite.cursor = "pointer";
        // Hover affordance — slight tint multiply on the sprite. The
        // existing `applyMetaToSprite` may already set a tint for
        // category styling; we read+restore it on pointerout to
        // avoid clobbering. PIXI defaults the tint to 0xFFFFFF.
        const baseTint = sprite.tint != null ? sprite.tint : 0xFFFFFF;
        sprite.on("pointerover", () => {
          // Brighten by ~15% via channelwise saturating add.
          sprite.tint = brightenTint(baseTint, 0x202020);
        });
        sprite.on("pointerout", () => {
          sprite.tint = baseTint;
        });
        sprite.on("pointerdown", (ev) => {
          // Block the camera-pan handler on app.stage.
          if (ev && typeof ev.stopPropagation === "function") {
            ev.stopPropagation();
          }
          const h = window.__sessionHandle;
          if (!h) return;
          // Phase C/E — branch on local combat stance. Melee →
          // attack(guid); ranged → missileAttack(guid); else →
          // useObject (portal / vendor / door / etc). ACE owns
          // auto-repeat so we send one packet per engagement.
          // Combat-bar plugin state (window.__combatBarState) drives
          // height + slider; defaults to MEDIUM / 1.0 when unset.
          const cb = window.__combatBarState;
          const cbHeight = cb && typeof cb.attackHeight === "number" ? cb.attackHeight : 2;
          const cbSlider = cb && typeof cb.powerLevel === "number" ? cb.powerLevel : 1.0;
          try {
            if (cat === "creature" && isInRangedStance() && typeof h.missileAttack === "function") {
              h.missileAttack(guid, cbHeight, cbSlider);
            } else if (cat === "creature" && isInMeleeStance() && typeof h.attack === "function") {
              h.attack(guid, cbHeight, cbSlider);
            } else if (typeof h.useObject === "function") {
              h.useObject(guid);
            }
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(`click(0x${guid.toString(16)}): ${e?.message ?? e}`);
          }
        });
      }

      // Phase 4 step 5: channelwise saturating-add for hover tint.
      // PIXI tint is a 24-bit RGB int; we add a small RGB delta and
      // clamp at 0xFF per channel.
      function brightenTint(base, delta) {
        const br = (base >> 16) & 0xff, bg = (base >> 8) & 0xff, bb = base & 0xff;
        const dr = (delta >> 16) & 0xff, dg = (delta >> 8) & 0xff, db = delta & 0xff;
        const r = Math.min(255, br + dr);
        const g = Math.min(255, bg + dg);
        const b = Math.min(255, bb + db);
        return (r << 16) | (g << 8) | b;
      }

      // Build (or fetch existing) entityMap entry for a given GUID.
      // `meta` carries the Phase 4 step 6a weenie metadata (itemType,
      // name, objScale, …) and is only populated on Spawn. Position
      // updates pass meta=null and reuse whatever meta the previous
      // Spawn deposited. The placeholder→real-sprite upgrade path
      // (existing-entry with modelId===0 + new modelId !==0) preserves
      // the meta across the swap.
      function ensureEntitySprite(guid, modelId, meta) {
        if (!liveScene) return null;
        let entry = entityMap.get(guid);
        if (entry) {
          if (meta) entry.meta = meta;  // Spawn refreshes meta in place
          if (entry.modelId === 0 && modelId !== 0) {
            // Upgrade placeholder → real model sprite.
            entry.sprite.destroy();
            entityMap.delete(guid);
            entry = null;
          } else {
            return entry;
          }
        }
        // Look up the model in the live render cache (Phase 3 step 6;
        // populated by buildLiveSpriteMap during renderNeighbourhood)
        // first, then fall back to the static atlas. If neither has
        // it, install a placeholder glyph (Phase 4 step 6b — keyed on
        // ItemType category) AND kick off an on-demand model fetch —
        // when the fetch resolves, the placeholder is upgraded to a
        // real textured sprite via `upgradeEntitySprite`.
        //
        // Phase 4 step 6 Phase A: cache key folds in substitution
        // hash for NPCs; bare modelId for unsubstituted entries
        // (preserves the static-placement cache reuse).
        const cacheKey = computeEntitySpriteKey(modelId, meta);
        const renderEntry =
          liveScene.liveSpriteMap?.get(cacheKey) ??
          liveScene.spriteMap?.get(modelId);
        let sprite;
        let kind;  // "sprite" | "placeholder" | "invisible"
        if (renderEntry) {
          sprite = new PIXI.Sprite(renderEntry.texture);
          sprite.anchor.set(0.5, 0.5);
          if (renderEntry.worldBounds) {
            sprite.width = renderEntry.worldBounds[0];
            sprite.height = renderEntry.worldBounds[1];
          }
          // worldContainer Y-flip compensation; see
          // buildObjectsContainer for the full derivation.
          sprite.scale.y = -sprite.scale.y;
          kind = "sprite";
        } else if (liveScene.invisibleModels?.has(cacheKey)) {
          // Engine-internal anchor (e.g. light marker). Keep a tiny
          // invisible Container so position updates still find a
          // sprite to mutate, but render nothing visible.
          sprite = new PIXI.Container();
          kind = "invisible";
        } else {
          // Phase 4 step 6b: glyph keyed on the meta's category instead
          // of the previous magenta-dot fallback. Until ObjectCreate
          // lands the meta is missing → "unknown" grey dot; once it
          // arrives the placeholder is destroyed + recreated from the
          // glyph table, OR the on-demand fetch resolves and replaces
          // the placeholder with the textured sprite.
          const cat = meta?.category || "unknown";
          sprite = drawGlyphForCategory(cat);
          kind = "placeholder";
        }
        liveScene.entityContainer.addChild(sprite);
        entry = { sprite, modelId, pendingFetchModelId: null, kind, meta: meta || null };
        entityMap.set(guid, entry);
        // Apply tint + objScale immediately for the cache-hit path. For
        // the placeholder path, applyMetaToSprite is a no-op because
        // Graphics already encode their colour. For the on-demand fetch
        // path, it's re-applied inside upgradeEntitySprite.
        applyMetaToSprite(entry, renderEntry);
        // Phase 4 step 5: per-sprite pointerdown handler for the
        // click-to-use loop. Only attaches for interactable categories
        // (portal / vendor / lifestone / container / sign).
        setupEntityClickability(sprite, guid, entry.meta);
        // For cache-miss real-modelId arrivals, kick off an on-demand
        // fetch. When it resolves, the placeholder glyph is swapped
        // for the real textured sprite via `upgradeEntitySprite`.
        // Modelid=0 means "no model yet" (PrivateUpdatePosition
        // before ObjectCreate); skip the fetch — the next
        // ObjectCreate will retry with the real csetup_id.
        if (!renderEntry && !liveScene.invisibleModels?.has(cacheKey) && modelId !== 0) {
          entry.pendingFetchModelId = modelId;
          fetchEntityModelOnDemand(modelId, meta)
            .then((re) => upgradeEntitySprite(guid, modelId, re));
        }
        return entry;
      }

      // Project an EntityUpdate's Spawn-only fields to the meta object
      // entityMap entries store. Position / Remove updates have these
      // fields zeroed/empty on the Rust side; we never call this for
      // them. category is precomputed once so the per-frame tint paths
      // don't redo the bitmask switch.
      function metaFromSpawn(upd) {
        const itemType = upd.itemType >>> 0;
        // Phase 4 step 6 Phase A: pull the model_data substitutions
        // ACE pre-computed and shipped on the wire. Empty arrays for
        // entities without substitutions (most static placements);
        // populated for NPCs / players / creatures with equipped
        // items. Each is a flat Uint32Array — see EntityUpdate's
        // wasm-bindgen getter doc-comments for the exact shape.
        const modelChanges = upd.modelChanges;
        const textureChanges = upd.textureChanges;
        const subPalettes = upd.subPalettes;
        return {
          wcid: upd.wcid >>> 0,
          itemType,
          category: categoryForItemType(itemType),
          name: upd.name || "",
          objScale: upd.objScale > 0 ? upd.objScale : 1.0,
          iconId: upd.iconId >>> 0,
          paletteId: upd.paletteId >>> 0,
          mtableId: upd.mtableId >>> 0,
          modelChanges: modelChanges && modelChanges.length > 0 ? modelChanges : null,
          textureChanges: textureChanges && textureChanges.length > 0 ? textureChanges : null,
          subPalettes: subPalettes && subPalettes.length > 0 ? subPalettes : null,
          // Phase 4 step 6 Phase A + B: route through the entity-render
          // path if ANY of the substitution fields are populated —
          // model/texture swaps OR a base palette override OR
          // sub-palette overlays. Otherwise (most static placements)
          // the cheaper fetch_model_meshes + fetch_surfaces_pixels
          // path still wins.
          hasSubstitutions:
            (modelChanges && modelChanges.length > 0)
            || (textureChanges && textureChanges.length > 0)
            || (subPalettes && subPalettes.length > 0)
            || ((upd.paletteId >>> 0) !== 0),
        };
      }

      // Phase 4 step 6e: nameplate colour-coding. We have less info on
      // the wire than retail (no friend/foe flag), so the categories
      // here are a coarse approximation: creature/portal/sign/container
      // each get distinctive colours; everything else gets a neutral
      // off-white. radar_blip_color (NPC=Yellow, Vendor=Yellow,
      // Creature=Gold, Portal=Purple — see external/ACE/Source/
      // ACE.Entity/Enum/RadarColor.cs) would refine this further; for
      // now we read from item_type only.
      function nameplateColorForCategory(category) {
        switch (category) {
          case "creature":  return 0xE07070;
          case "portal":    return 0x6EC8E0;
          case "container": return 0xCDA060;
          case "writable":  return 0xE09A3F;
          case "lifestone": return 0x4DA0E8;
          case "weapon":
          case "armor":
          case "key":
          case "gem":
          case "money":
          case "food":      return 0xC8C8B0;
          default:          return 0xE0E0C8;
        }
      }

      // Lazily mint a PIXI.Text in nameplateContainer for entries that
      // have a name. Skips the local player and any entry without a
      // name. Idempotent — safe to call multiple times for the same
      // entry; only the first call allocates. Position is updated each
      // frame in updateNameplatePositions; allocation here is the
      // text-only step. Pre-multiplied alpha + black stroke matches
      // retail's readable-on-anything style.
      //
      // Phase 4 step 6d: signs (`category === "writable"`) get a
      // distinct italic / parchment-coloured style mirroring
      // WorldBuilder.Terminal/RenderPreviewRenderer.cs:911-938 — the
      // static-site visual the dynamic-site is meant to match. Cream
      // fill (0xF0E8D0) + black stroke at 80% alpha + italic font
      // distinguishes "this is a written sign" from "this is an
      // entity name" at a glance. Other categories keep the bold
      // monospace step 6e style.
      function ensureNameplate(entry) {
        if (!liveScene || !entry || !entry.meta) return;
        if (entry.nameplate) return;
        const meta = entry.meta;
        if (!meta.name) return;
        if (entry.guid >>> 0 === (localPlayerGuid ?? 0xffffffff)) return;
        const isSign = meta.category === "writable";
        const text = isSign
          ? new PIXI.Text({
              text: meta.name,
              style: {
                fontFamily: "Georgia, serif",
                fontSize: 12,
                fontStyle: "italic",
                fill: 0xF0E8D0,
                stroke: { color: 0x000000, alpha: 0.8, width: 2.5 },
                align: "center",
              },
            })
          : new PIXI.Text({
              text: meta.name,
              style: {
                fontFamily: "monospace",
                fontSize: 13,
                fontWeight: "bold",
                fill: nameplateColorForCategory(meta.category),
                stroke: { color: 0x000000, width: 3 },
                align: "center",
              },
            });
        text.anchor.set(0.5, 1.0);  // bottom-centred above the sprite
        liveScene.nameplateContainer.addChild(text);
        entry.nameplate = text;
        entry.nameplateIsSign = isSign;
      }

      // Walk entityMap once per rAF tick and project each entry's world
      // coords through the camera+world transforms to canvas pixels for
      // its nameplate. Nameplate sits in nameplateContainer (sibling of
      // cameraContainer on app.stage), NOT scaled by the camera, so it
      // stays at 12px screen-space at every zoom level. Hides
      // nameplates entirely when the camera is zoomed out enough that
      // text would crowd (sx < 0.3 px/m ≈ a single landblock taking
      // ~58px on screen — far enough out that names would overlap).
      function updateNameplatePositions() {
        if (!liveScene) return;
        const cam = liveScene.cameraContainer;
        const sx = cam.scale.x;
        const ox = cam.position.x;
        const oy = cam.position.y;
        const visible = sx >= 0.3;
        liveScene.nameplateContainer.visible = visible;
        if (!visible) return;
        for (const [, entry] of entityMap) {
          const wx = entry.sprite.x;
          const wy = entry.sprite.y;
          // worldContainer flips y: screen y = -wy * sx + oy.
          if (entry.nameplate) {
            // Lift 14px above the sprite centre.
            entry.nameplate.position.set(wx * sx + ox, -wy * sx + oy - 14);
          }
          // Phase 4 step 6f: portal destination chip sits 14px
          // BELOW the sprite (anchor.y = 0.0 means top-of-text at
          // that screen y, so the chip drops down). Per-frame
          // re-projection so the chip tracks the portal as the
          // camera pans / zooms.
          if (entry.portalChip) {
            entry.portalChip.position.set(wx * sx + ox, -wy * sx + oy + 14);
          }
        }
      }

      function handleEntitySpawn(upd) {
        const meta = metaFromSpawn(upd);
        const guid = upd.guid >>> 0;
        const entry = ensureEntitySprite(guid, upd.modelId, meta);
        if (!entry) return;
        entry.guid = guid;
        const { wx, wy } = landblockToWorldXY(upd.landblockId, upd.x, upd.y);
        entry.sprite.position.set(wx, wy);
        entry.sprite.rotation = -quaternionToYaw(upd.qw, upd.qx, upd.qy, upd.qz) + SPRITE_HEADING_OFFSET;
        // Tier 2: capture initial position so the velocity sampler
        // has a baseline. Without it, the first PositionUpdate would
        // see Δt = 0 and falsely flag the entity as moving infinitely
        // fast on its very first frame after spawn.
        entry.lastPosX = wx;
        entry.lastPosY = wy;
        entry.lastPosT = performance.now();
        entry.speedMps = 0.0;
        ensureNameplate(entry);
        ensurePortalSwirl(entry);
      }

      // Phase 4 step 6d (portal swirls): for portal-category entities,
      // overlay a thin cyan PIXI.Graphics ring as a sibling sprite in
      // entityContainer. The ring's radius + alpha pulse on a ~1.5s
      // loop driven from `tickEntityAnimations` (mirrors the static-
      // site Portal=cyan glyph but animated). Idempotent — safe to
      // call multiple times; only the first call allocates. Cleanup
      // hooks into `handleEntityRemove`.
      //
      // The ring sits on top of the sprite so it's visible regardless
      // of whether the model is a textured sprite, a placeholder
      // glyph, or invisible. Its world-coord position tracks the
      // sprite (so the per-rAF animation only animates radius/alpha,
      // not position — that lives on the sibling sprite).
      function ensurePortalSwirl(entry) {
        if (!liveScene || !entry || !entry.meta) return;
        if (entry.portalSwirl) return;
        if (entry.meta.category !== "portal") return;
        const ring = new PIXI.Graphics();
        liveScene.entityContainer.addChild(ring);
        ring.position.set(entry.sprite.x, entry.sprite.y);
        entry.portalSwirl = ring;
        // First draw — tickPortalSwirl will redraw each frame with
        // pulsed radius / alpha. Without this initial draw the ring
        // would be invisible until the first animation tick.
        drawPortalSwirl(ring, /*phase=*/0);
      }

      // Phase 4 step 6d: redraw the portal ring at the given phase
      // (0..1, where 0 is fully contracted + full alpha and 1 is
      // fully expanded + zero alpha). Two concentric rings inset
      // by 0.3 m so the swirl reads as a halo instead of a flat
      // line at zoom-out.
      function drawPortalSwirl(g, phase) {
        const baseRadius = 1.4;             // world metres
        const expand = 0.9;                 // metres added at peak
        const r1 = baseRadius + expand * phase;
        const r2 = r1 + 0.35;
        const alpha = 1.0 - phase;
        g.clear();
        g.circle(0, 0, r1).stroke({
          color: 0x6EC8E0,
          width: 0.18,
          alpha: alpha * 0.85,
          alignment: 0.5,
        });
        g.circle(0, 0, r2).stroke({
          color: 0x9EE8F8,
          width: 0.10,
          alpha: alpha * 0.55,
          alignment: 0.5,
        });
      }

// ===== tickEntityInterpolation (per-rAF 2D sprite lerp) =====
      function tickEntityInterpolation() {
        if (!liveScene) return;
        const now = performance.now();
        for (const [, entry] of entityMap) {
          if (entry.lerpStartMs === undefined) continue;
          const elapsed = now - entry.lerpStartMs;
          // 2026-05-10 academy-rubberband fix: the local-player
          // idle-reconciliation lerp uses a longer duration
          // (`entry.lerpDurationMs`, set when the lerp is seeded
          // from `applyEntityUpdate`'s isLocal branch) so the
          // idle convergence is a smooth glide rather than a
          // tight 150 ms snap.
          const lerpDuration = entry.lerpDurationMs ?? ENTITY_LERP_DURATION_MS;
          let x;
          let y;
          if (elapsed >= lerpDuration) {
            // Catch-up lerp complete. Either extrapolate forward
            // via the most-recent velocity hint (smooth continuous
            // motion past the authoritative target) or freeze at
            // lerpTo and stop ticking this entry.
            const hasFreshVelocity =
              entry.velUpdatedMs !== undefined &&
              now - entry.velUpdatedMs < ENTITY_VELOCITY_STALE_MS;
            if (hasFreshVelocity) {
              const extraSec = (elapsed - lerpDuration) / 1000;
              x = entry.lerpToX + entry.velX * extraSec;
              y = entry.lerpToY + entry.velY * extraSec;
            } else {
              x = entry.lerpToX;
              y = entry.lerpToY;
              entry.lerpStartMs = undefined;
              entry.lerpDurationMs = undefined;
            }
          } else {
            const t = elapsed / lerpDuration;
            x = entry.lerpFromX + (entry.lerpToX - entry.lerpFromX) * t;
            y = entry.lerpFromY + (entry.lerpToY - entry.lerpFromY) * t;
          }
          entry.sprite.x = x;
          entry.sprite.y = y;
          // Portal swirl tracks the sprite so the ring stays
          // centred on the portal during the lerp; if the swirl
          // were left at the previous target it'd visually
          // detach during motion.
          if (entry.portalSwirl) {
            entry.portalSwirl.position.set(x, y);
          }
        }
      }

// ===== tickCellVisibility (per-rAF 2D cell-container .visible toggle) =====
      function tickCellVisibility() {
        if (!liveScene || !window.__sessionHandle) return;
        let cellId = 0;
        let renderSet;
        let isIndoor = false;
        try {
          cellId = window.__sessionHandle.getCurrentCellId() >>> 0;
          renderSet = window.__sessionHandle.getRenderSet(1);
          isIndoor = !!window.__sessionHandle.isCurrentCellIndoor();
        } catch (_) {
          return;
        }
        // Capture-script telemetry. Always update so probes see live
        // values even if no cell visibility change happens this frame.
        window.__currentCellId = cellId;
        window.__renderSet = Array.isArray(renderSet)
          ? Array.from(renderSet, (v) => v >>> 0)
          : [];
        window.__isIndoor = isIndoor;
        // Pre-spawn / pre-snapshot: cellId is 0. Leave existing cell
        // visibility alone — the tick that follows the next snapshot
        // publish takes care of the first paint.
        if (cellId === 0) return;
        // Outdoor toggle: do this BEFORE the diff-guard so a transition
        // from outdoor → indoor that doesn't change render_set (rare —
        // crossing a portal usually changes render_set too — but
        // possible during teleport) still flips the outdoor layer.
        const wantOutdoorVisible = !isIndoor;
        if (lastOutdoorVisible !== wantOutdoorVisible && liveScene.outdoorContainer) {
          liveScene.outdoorContainer.visible = wantOutdoorVisible;
          lastOutdoorVisible = wantOutdoorVisible;
        }
        // Diff guard. Compare a stable signature of the (current_cell,
        // render_set) tuple to last frame's. Skip the per-cell walk on
        // no change — Pixi batch state stays put.
        const sig = `${cellId}|${window.__renderSet.join(",")}`;
        if (sig === lastCellRenderSetSig && cellId === lastCurrentCellId) {
          return;
        }
        lastCellRenderSetSig = sig;
        lastCurrentCellId = cellId;
        const visibleSet = new Set(window.__renderSet);
        const registry = liveScene.cellContainers ?? window.cellContainers;
        if (!registry) return;
        for (const [thisCellId, container] of registry) {
          const want = visibleSet.has(thisCellId >>> 0);
          if (container.visible !== want) {
            container.visible = want;
          }
        }
      }

// ===== tickEntityAnimations (per-rAF 2D walk-frame texture swap + portal-swirl pulse) =====
      function tickEntityAnimations() {
        if (!liveScene) return;
        const now = performance.now();
        const dt = lastAnimTickTime !== null
          ? Math.min((now - lastAnimTickTime) / 1000, 0.1)
          : 0;
        lastAnimTickTime = now;
        walkPhase += dt * WALK_FRAME_RATE;
        // Phase 4 step 6d: portal swirl pulse phase. 1.5 s loop
        // (matches the design-doc target). Same global phase for
        // every portal — synced pulses look more deliberate than
        // randomised offsets.
        const PORTAL_PULSE_PERIOD_S = 1.5;
        const portalPhase = (now / 1000.0 / PORTAL_PULSE_PERIOD_S) % 1.0;
        for (const [, entry] of entityMap) {
          // Tier 2 + stance-keyed walk-cycle animation: sprite-kind
          // entries only.
          if (entry.kind === "sprite") {
            const renderEntry = liveScene.liveSpriteMap?.get(
              computeEntitySpriteKey(entry.modelId, entry.meta)
            );
            // Defensive: the static-placement render path
            // (`addModelsToLiveSpriteMap`, line ~1477) creates
            // liveMap entries with only `{texture, worldBounds}` —
            // no `cycleBakes` field. `computeEntitySpriteKey`
            // returns the bare modelId for entities WITHOUT
            // substitutions, which collides with the static-
            // placement key. Hitting this path on a static-shaped
            // entry without a guard causes
            // `renderEntry.cycleBakes.size` → undefined.size →
            // throws → kills the rAF drainEvents loop →
            // setMovementInput never fires → server-side player
            // freezes → ACE corrects the client back to last-
            // confirmed pose (visible as rubberbanding). Skipping
            // the bake-gate logic for static-shaped entries paints
            // the static texture as fallback — same as before the
            // stance-keyed cycles refactor masked this collision
            // via an `=== null` check that no-op'd on undefined.
            if (renderEntry?.texture && renderEntry.cycleBakes) {
              // Animation gate: prefer ACE's authoritative motion
              // command (kind=5 UpdateMotion) when fresh; fall back
              // to the EMA-on-position-deltas heuristic otherwise.
              // The EMA flaps around ~0.4 m/s for entities that
              // shuffle between PublicUpdatePosition echoes —
              // server's STOP / WALK_FORWARD / RUN_FORWARD is a
              // hard-edge signal that doesn't false-positive.
              const hasFreshMotion =
                entry.motionUpdatedMs !== undefined &&
                now - entry.motionUpdatedMs < ENTITY_MOTION_STALE_MS;
              const cmd = hasFreshMotion ? (entry.motionCommand ?? 0) : 0;
              let moving;
              if (hasFreshMotion) {
                moving =
                  cmd === MOTION_CMD_WALK_FORWARD ||
                  cmd === MOTION_CMD_WALK_BACKWARDS ||
                  cmd === MOTION_CMD_RUN_FORWARD;
              } else {
                moving = (entry.speedMps ?? 0) >= WALK_MOVING_THRESHOLD_MPS;
              }
              // Stance-keyed cycle lookup. Two fallback layers:
              //   1. Active stance (from kind=5 motionStance, or 0
              //      pre-UpdateMotion which the bake resolves to
              //      MotionTable.default_style).
              //   2. defaultStance — the MotionTable's default_style
              //      discovered by the first bake. Used when the
              //      entity's current stance has no MotionTable
              //      cycles (combat-stance walk for a creature with
              //      no combat anims).
              // The cacheStance dispatch:
              //   - motionStance present + has its own bake → use it
              //   - motionStance present + cycleBakes empty for it +
              //     no in-flight bake → kick bake; meanwhile use
              //     defaultStance bake (or fall through to idle)
              //   - motionStance absent (creature pre-UpdateMotion
              //     or local player) → use defaultStance bake
              const activeStance = (entry.motionStance ?? 0) >>> 0;
              const cacheKey = computeEntitySpriteKey(entry.modelId, entry.meta);
              // Kick first bake when entity becomes movable AND no
              // bakes have landed yet AND none are in flight.
              if (moving && renderEntry.cycleBakes.size === 0
                  && renderEntry.cycleBakesInFlight.size === 0) {
                kickCycleFrameBakeIfNeeded(
                  cacheKey, entry.modelId, entry.meta, 0
                );
              }
              // Kick stance-specific bake when we have an active
              // stance that differs from defaultStance and isn't
              // already in cycleBakes / in flight.
              if (moving && activeStance !== 0
                  && renderEntry.defaultStance !== 0
                  && activeStance !== renderEntry.defaultStance
                  && !renderEntry.cycleBakes.has(activeStance)
                  && !renderEntry.cycleBakesInFlight.has(activeStance)) {
                kickCycleFrameBakeIfNeeded(
                  cacheKey, entry.modelId, entry.meta, activeStance
                );
              }
              // Pick the cycle bake to play this frame. Try active
              // stance first; fall back to defaultStance.
              let cycleBake = null;
              if (activeStance !== 0 && renderEntry.cycleBakes.has(activeStance)) {
                const c = renderEntry.cycleBakes.get(activeStance);
                if (c.walkFrames.length > 0 || c.runFrames.length > 0) {
                  cycleBake = c;
                }
              }
              if (!cycleBake && renderEntry.defaultStance !== 0
                  && renderEntry.cycleBakes.has(renderEntry.defaultStance)) {
                const c = renderEntry.cycleBakes.get(renderEntry.defaultStance);
                if (c.walkFrames.length > 0 || c.runFrames.length > 0) {
                  cycleBake = c;
                }
              }
              // Pick walk vs run within the chosen bake. Run when
              // ACE explicitly says RUN_FORWARD; walk for everything
              // else that's moving (including WALK_BACKWARDS — no
              // separate walk-back cycle in retail data, the walk
              // forward anim covers it). Falls back to the other
              // cycle when the requested one is missing — many
              // retail creatures have walk-only or run-only entries.
              const wantRun = cmd === MOTION_CMD_RUN_FORWARD;
              let activeFrames = null;
              let activeFramerate = 0;
              if (moving && cycleBake) {
                if (wantRun && cycleBake.runFrames.length > 0) {
                  activeFrames = cycleBake.runFrames;
                  activeFramerate = cycleBake.runFramerate;
                } else if (cycleBake.walkFrames.length > 0) {
                  activeFrames = cycleBake.walkFrames;
                  activeFramerate = cycleBake.walkFramerate;
                } else if (cycleBake.runFrames.length > 0) {
                  activeFrames = cycleBake.runFrames;
                  activeFramerate = cycleBake.runFramerate;
                }
              }
              if (activeFrames) {
                // Per-entity time-based frame index using the
                // MotionTable-authored framerate (typically 8-30 fps
                // depending on creature). Falls back to the legacy
                // 12 fps constant when the AnimData carries 0.0
                // (malformed or missing).
                const fps = activeFramerate > 0 ? activeFramerate : WALK_FRAME_RATE;
                const idx = Math.floor((now / 1000) * fps) % activeFrames.length;
                entry.sprite.texture = activeFrames[idx];
              } else {
                entry.sprite.texture = renderEntry.texture;
              }
            } else if (renderEntry?.texture) {
              // Static-placement render entry (no cycleBakes field).
              // Live entities without substitutions share the same
              // cache key as the static-placement render path, so
              // some entityMap entries land on these static entries.
              // No walk-cycle data, just paint the idle texture.
              entry.sprite.texture = renderEntry.texture;
            }
          }
          // Phase 4 step 6d: portal swirl pulse. Independent of
          // sprite kind — placeholder portals get the swirl too.
          if (entry.portalSwirl) {
            drawPortalSwirl(entry.portalSwirl, portalPhase);
          }
        }
      }
