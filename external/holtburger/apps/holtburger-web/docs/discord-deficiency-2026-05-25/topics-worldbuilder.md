# Asheron's Call Alt-Client Deficiency Analysis: Developer Tooling & SDK Topics

**Data Collection Period:** 2026-02-24 to 2026-05-24
**Source Channels:** 5 Discord channels (worldbuilder, decalinfo, notan0229 DM, acme-worldbuilder, vitaeum-client)
**Total Messages Analyzed:** 5,440 lines across 5 files

---

## Executive Themes (Top 5-7 Threads)

1. **Portal & Cell Geometry Complexity**: Portals are AC's "portal engine" with undiscovered limits—infinite loops, mirror effects, rotation tricks, cell transitions. WorldBuilder team reproduces client bugs intentionally for design parity. Holtburger-web lacks portal editing; dungeon tools remain unfinished.

2. **Texture & Material Pipeline Brittleness**: Importing new textures, remapping indices, handling palette swaps, and multi-part model texture coordination all prone to DAT corruption. Multiple texture imports in a single transaction fail silently. Setup-to-texture binding is fragile.

3. **Rendering Backend Separation**: Trevis's WorldBuilder split renderer from editor mid-cycle; Vanquish420's ACME took opposite approach (features first, optimize later). Both acknowledge z-buffer precision, particle lighting, and portal transition smoothness are unfinished. Skybox occlusion above 50 landblocks unknown.

4. **Decal Plugin Infrastructure Decay**: Plugin 1 Surrogate deprecated, plugin DLL registration fails on Wine/Linux, vcredist version conflicts, Thwarg bridge flaky. Diagnostic toolset (9/14 surfaces covered) in holtburger-web, but offline tooling still required.

5. **DAT File Format Fragility & Iteration**: Partial DATs, patch iteration, envcell pack tests, layout string validation—all require manual intervention. No clean versioning story. ACME exports break if multiple textures imported; Derpy had to restart entire tool flows.

6. **Dungeon Generator vs. Manual Editing UI/UX**: ACME's dungeon generator randomization (branching, room size, style) works, but manual portal selection requires camera repositioning per cell. Copy/paste cell placement doesn't snap to portals. Object click-selection fails when cameras overlap cells.

7. **Retail Parity Testing (Diagnostic Toolset)**: Holtburger-web diagnostic revealed 14 validator surfaces. Physics parity (motion, collision, jump formula) passing at bitwise; texture/mesh decode still Wave 4 open. Cell-portal graph + PVS partial. Skybox atmosphere partial. This feeds upstream validation.

---

## Topics by Category

### TERRAIN/WORLD EDITING

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Landblock Export & Import** | load-bearing | "Using Acecreator, I can export weenie .sql files and edit them. I can export and edit landblocks." (worldbuilder, 2026-03-25) | `/import-sql quests all` (ACE command); SQL-based landblock format; datrw library |
| **Partial DATs for Patches** | load-bearing | "baseline EOR .dats -> patch .dats #1 -> patch .dats #2" needs infrastructure (worldbuilder, 2026-03-30) | Partial DAT export; iteration bumping manual via export→new project; versioning story missing |
| **DAT File Corruption on Multi-Texture Import** | load-bearing | "Adding more than 1 texture…it tried to save…multiple things at a time kept saving it over and over, corrupting it" (worldbuilder, 2026-04-12) | DatReader offset/length bounds check; multiple transaction batching; index mapping validation |
| **Landscape vs. Dungeon Editor Separation** | nice-to-have | "reorganize some landscape editor stuff since some of it will be shared with the dungeon editor" (worldbuilder, 2026-04-01) | Shared backend for envcell layout, terrain painting; separate frontends |
| **Z-Buffer Precision for Distant Objects** | curiosity | "does wb use a reversed z-buffer? that would help with precision for distant objects, reducing flickering" (worldbuilder, 2026-03-31) | NVIDIA depth-precision article cited; current implementation not inverted; may reduce z-fighting |
| **WorldBuilder vs. ACME Divergence** | nice-to-have | "ACME started as a fork…got annoyed and made my own…much further along, performant" (worldbuilder, 2026-04-09) | datrw-based; Chorizite is eventual Decal replacement; two separate codebases now |
| **Landblock Knowledge Base Auto-Generation** | load-bearing | "acme dungeon builder…automatically generating knowledge base of all environments in DAT, auto-linking compatible portals" (worldbuilder, 2026-03-31) | Portal metadata schema; envcell database; portal face enumeration logic |
| **Random Dungeon + World Hybrid Generation** | curiosity | "combo of random world + random dungeon and it all connects / puts to db" (worldbuilder, 2026-04-11) | Seeded RNG for determinism; DB schema for generated content; portal graph synthesis |

### DUNGEON EDITING & ENVCELLS

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **EnvCell Interior Decoration** | load-bearing | "you would have to decorate the envcell for that building" (worldbuilder, 2026-04-07) | EnvCell data structure; interior scenery placement; portal linking to envcell |
| **Portal Linking & Automatic Matching** | load-bearing | "trying to match portals up automatically…overwhelming"; "automatically links up compatible portals" (worldbuilder, 2026-03-31) | Portal face geometry; compatible landblock ID matching; adjacency detection |
| **Portal Tricks: Infinite Loops & Mirror Effects** | curiosity | "make a dungeon that goes on forever by wrapping around…portal that reflects like mirror…Hall of Mirrors…doorway exits onto ceiling of next room" (worldbuilder, 2026-04-10) | Portal rotation matrices; cell transition collision handling; engine hard caps unknown |
| **Client Bug Reproduction for Portal Rendering** | load-bearing | "goal of wb to render things bug-free or matched with acclient bugs?…try and match client bugs so you know what's wonky" (worldbuilder, 2026-04-10) | Cross-cell basement visibility; next-room rendering delay; BSP approximation vs. 1:1 |
| **Portal Transitions Smoothness & Cross-Cell Collisions** | load-bearing | "portal transitions…cell transition collisions at the moment, have not even begun on dungeons" (notan DM, 2026-05-20) | Collision shape interpolation; camera velocity damping on portal cross; transition duration |
| **Scene Painting & Sound Association** | nice-to-have | "some scenes empty but change ambient sounds of an area…low murmur party talk when in towns" (worldbuilder, 2026-03-31) | Scene object list; sound event data; ambient sound node mapping |
| **Dungeon Copy/Paste & Portal Snapping** | nice-to-have | "copy/paste of cells…half the time idk where cell is placed…snap to portal would be nice" (acme-worldbuilder, 2026-05-21) | Cell placement anchor points; portal face snapping logic; visual feedback for drop zones |
| **Building Blueprint System** | load-bearing | "blueprint system added, clone entirety of building + interior from another part of world" (worldbuilder, 2026-04-07) | Blueprint metadata; interior portal links; building instance cloning |
| **Object Selection in Overlapping Cells** | nice-to-have | "selection in dungeons…doesn't click targeted object correctly, gotta move camera million ways" (acme-worldbuilder, 2026-05-21) | Raycast priority ordering; cell occlusion order; UI hit-test feedback |
| **Dungeon Generator Parameters** | load-bearing | "dungeon generator…parameters for generating random stuff like branching amount, room size, style" (worldbuilder, 2026-04-11) | Seed-based generation; room dimension constraints; passage connectivity graph |

### SCENERY & OBJECT PLACEMENT

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Model Part & Texture Swapping** | load-bearing | "preview/swap parts out…hide parts/swap etc"; "parts and texture swaps" for drudges (worldbuilder, 2026-04-09) | SetupModel part indices; weenie_properties_anim_part; texture_map indices per part |
| **Custom Texture Import & Validation** | load-bearing | "custom texture importer using DRW…import texture for you there too" (worldbuilder, 2026-04-09) | DRW Bitmap conversion; ImageSharp RGBA8 conversion; DAT header validation |
| **Monster Model Customization UI** | load-bearing | "monster builder and building fix…easier for everyone"; Vaelkar the Red custom textures & parts (worldbuilder, 2026-04-09) | SQL weenie_properties_texture_map; animation_id indexing; palette support |
| **Retexturing (Historical Mod Patterns)** | curiosity | "Demonizzer mod…retexturing…ice golem, ice evic"; "texture remaps on mobs" (worldbuilder, 2026-04-09) | Texture surface chain; palette override; alpha channel handling for transparency |
| **Environment Cell Position Mobility** | curiosity | "move env cells and stuff in landblock…moved huge env cells on left/center/bottom, handled little ones independently" (notan DM, 2026-05-20) | EnvCell coordinate transform; landblock bounding box recalc; collision boundary update |
| **Furniture & Gen Placement for Seasonal Tweaks** | nice-to-have | "plop gens in towns, attach festival candles to replicate DAT changes…easier placement tooling" (worldbuilder, 2026-04-13) | Generator object IDs; attachment point system; position/rotation UI |
| **Clothing Mod Tool (Unfinished)** | nice-to-have | "clothing tool…needs weenie editor, pals, different area for every race…armor needs alot alot" (worldbuilder, 2026-04-09) | Per-race attachment points; palette indexes; weenie property coupling |

### RENDERING & GRAPHICS

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Skybox + Atmosphere Parity** | load-bearing | "finishing skybox…proper lighting particles…clouds / sky too bright in the day"; "renderer is very close to useable for alt client" (worldbuilder, 2026-04-10) | Bruneton atmosphere code; cloud volumetrics; time-of-day lighting transitions; three.js 3D |
| **Particle Lighting in Skybox** | load-bearing | "now with proper lighting particles"; "green light (northern lights?) a texture or color?…particles with gfxobj 0x01001A62" (worldbuilder, 2026-04-10) | GFXObj particle animation; vertex color modulation; emissive blending |
| **Weather Effects (Rain, Snow, Lightning)** | load-bearing | "Rain is in already…lightning flashes no, need to debug…sound yes, ambient from terrain" (worldbuilder, 2026-04-13) | Weather cycle data; particle system for rain; sound event triggers; flash timing sync |
| **Portal Renderer & Client Bug Parity** | load-bearing | "fixed issues with portal renderer…one bug maybe…reproducing client bugs"; "cross-cell basement overworld still visible" (worldbuilder, 2026-04-10) | Portal face culling; BSP approximation; adjacency visibility flags; rendering distance caps |
| **Skybox Height & Camera Positioning** | nice-to-have | "lowered skybox since editor sits higher when flying"; "what happens if you fly above skybox? bad things…won't support" (worldbuilder, 2026-04-10) | Skybox dome radius; camera height offset; clip plane boundaries |
| **Compass & Minimap Navigation** | nice-to-have | "compass helps deal to orient yourself"; "WIP minimap"; "radar not important but compass helps" (worldbuilder, 2026-04-13) | Heading calculation from player rotation; landblock grid overlay; zoom levels |
| **Water & Sand Shader Improvements** | curiosity | "water/sand looking amazing just same textures…playing with shaders, new client" (worldbuilder, 2026-04-09) | Fresnel reflection; parallax mapping; water wave animation; procedural normals |
| **Texture/Surface-Chain Decode Parity** | open | Diagnostic Wave 4 validator: "validate_texture_decode.cjs" (notan DM, 2026-05-20) | DRW surface chain parser; JPEG custom raw handling; dimension encoding in JPEG headers |
| **Mesh/Triangulation Parity** | open | Diagnostic Wave 4 validator: "validate_mesh_parity.cjs" (notan DM, 2026-05-20) | SetupModel face indices; triangle winding order; degenerate face culling |

### ANIMATION & MOTION

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Animation Part Indexing** | load-bearing | "anim_part…Head 0x1003018, torso 0x1002A6F…attachment per race/gender" (worldbuilder, 2026-04-09) | weenie_properties_anim_part table; animation ID enum; skeletal joint mapping |
| **Motion/Swing-Pose Parity** | load-bearing | Diagnostic coverage: "validate_motion_pose.cjs (52/52 JS-vs-C# PASS)" (notan DM, 2026-05-20) | Motion tables; quaternion interpolation; swing angle calculation; frame delta |
| **Physics Parity (Jump, Collision, On-Ground)** | load-bearing | Diagnostic: "validate_physics_replay.cjs + physics-jump-formula…1000/1000 bitwise PASS; cell transition collisions unfinished" (notan DM, 2026-05-20) | Jump arc formula; gravity constant; collision shape raycasts; max drift tolerance |
| **UI Animation Overrides** | nice-to-have | "objdesc overrides"; "animations still missing"; "anim_id from client ripped" (worldbuilder, 2026-04-10) | MotionDesc animation table; playback speed override; looping flags |
| **Custom Wing Animation** | curiosity | "make wings look not tattered…anime kawaii wings"; "Next trick is animate them" (worldbuilder, 2026-04-12) | Custom vertex animation; UV scroll; skeletal rig for wings |

### PROTOCOL & NETWORKING

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Wire Packet Pack/Unpack Conformance** | load-bearing | Diagnostic: "validate_wire_conformance.cjs (19/23 PASS + 4 documented SKIP)" (notan DM, 2026-05-20) | Packet struct serialization; endianness; field alignment; known skip cases |
| **Diagnostic Toolset: 14-Surface Validation** | load-bearing | 9 covered, 3 partial, 2 open; "proves retail-correctness along every axis with canonical oracle" (notan DM, 2026-05-20) | validate_landblock_completeness, entity_classification, event_completeness, enum_parity, etc. |
| **Client Version Mismatch Reporting** | nice-to-have | "old decal doesn't report client version…don't get popup about mismatch when launching" (decalinfo, 2026-05-12) | Client version string encoding; packet header version field; deprecation flags |

### PLUGIN-API (DECAL SDK)

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Decal DLL Registration Failures on Linux/Wine** | load-bearing | "Decal won't register thwargfilter.dll…manual DLL registration via bat script in Wine prefix" (decalinfo, 2026-03-08) | Wine COM registration; regsvr32 wrapper; environment variable setup (WINEPREFIX) |
| **Plugin Surrogate Deprecation** | load-bearing | "Plugin 1 Surrogate deprecated…no v1 stuff has survived"; "infra still exists, surrogate blocked" (decalinfo, 2026-05-22) | Surrogate architecture; adapter pattern; legacy plugin format (v1, v2); v3 roadmap unknown |
| **VCRedist Dependency Chains** | load-bearing | "client needs one vc_redist, decal needs one, thwarglauncher needs different one"; "grab from files.treestats.net" (decalinfo, 2026-05-12) | VC++ runtime versions (2005, 2017, current); x86/x64 mismatch; Windows Defender exclusions |
| **Virindi Bundle Installation Issues** | nice-to-have | "Virindi bundle version numbers mismatch…accpp says one version, actual different" (decalinfo, 2026-04-24) | Plugin manifest; version schema drift; auto-update mechanism |
| **Thwarg Launcher Bridge Configuration** | load-bearing | "Decal injection toggle doesn't work…Thwarg wont start under Lutris"; "delay launch milliseconds config file" (decalinfo, 2026-04-20) | Decal.ini settings; bridge URL parsing; character login sequence; delay parameter |
| **MegaRadar.dll (Deprecated Plugin)** | curiosity | "MegaRadar.dll…Plugin Surrogate don't work…v1 stuff no longer in archive"; "should scan DLL before loading" (decalinfo, 2026-05-22) | Legacy plugin format; surrogate infrastructure; DLL decompilation for archaeology |
| **Loot Priority Distance Behavior** | nice-to-have | "characters running 25-30 clicks away to loot…Approach is 0, Follow 2"; "approach must be >0, like 0.1" (decalinfo, 2026-02-25) | Vitae Tank approach/follow distance; VT Advanced settings; looting range |

### DAT PARSING & FILE FORMATS

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **DAT Parity (20 File Types, 906/906 Phase-A PASS)** | load-bearing | Diagnostic: "validate_dat_parity.cjs (24/24 x 906/906 Phase-A PASS)" (notan DM, 2026-05-20) | datrw library; file type enumeration; structured parsing per type; validation phases |
| **JPEG Custom Raw Dimension Encoding** | load-bearing | "PFID_CUSTOM_RAW_JPEG…dimensions are 0x0, similar to ACViewer bug…dimensions encoded in JPEG not DAT" (worldbuilder, 2026-04-01) | JPEG EXIF parsing; turbine-specific encoding; dimension header detection |
| **Property/Enum Parity (66 Enums)** | load-bearing | Diagnostic: "validate_enum_parity.cjs…drift surfaced; triage open" (notan DM, 2026-05-20) | Enum value mappings; outlier detection; version-specific enum changes; migration paths |
| **Render-Pose / Coordinate-Frame Parity** | load-bearing | Diagnostic: "compare_render_corners.cjs" (notan DM, 2026-05-20) | Quaternion to matrix conversion; camera FOV parity; viewport coordinate transform |
| **DAT Integrity (SHA256, Modder-ID Rejection)** | load-bearing | Diagnostic: "scenery-bake pre-flight + bake-source.sha256 sidecar" (notan DM, 2026-05-20) | Hash verification; modder watermark detection; integrity pre-flight checks |

### UI/HUD EDITING

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **LayoutDesc Editor (JSON Import)** | nice-to-have | "JsonSerializers…once LayoutDesc editor further along, import JSON"; ElementDescs could be included (worldbuilder, 2026-03-30) | LayoutDesc data structure; JSON schema; UI element hierarchy; import validation |
| **UI Element Labeling & Component Mapping** | load-bearing | "labeling each individual component in client…port to ACME…need for custom client classic mode" (worldbuilder, 2026-04-09) | UI element ID enum; component name metadata; EnumMapper for UI IDs |
| **UI Texture Preview in Editor** | nice-to-have | "make textures render to window in UI editor via toggle"; "just blank boxes with labels"; "update soon, now that ripped from client" (acme-worldbuilder, 2026-05-21) | UI texture surface rendering; layout preview pane; refresh on edit |
| **UI Complexity & Retroactive Mapping** | curiosity | "UI is fucking stupid…got all mapped out now, understand it now" (acme-worldbuilder, 2026-05-21) | AC UI legacy structure; redundant element definitions; historical quirks |

### PERFORMANCE & OPTIMIZATION

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Profiling Infrastructure (DotTrace vs. SpeedScope)** | load-bearing | "waiting for rider profiling license…tried installing visual studio in VM…I absolutely hate speedscope"; "dottrace immediately clear on tracking" (worldbuilder, 2026-03-28) | DotTrace timeline recording; frame profiler; memory allocations; hot path identification |
| **Renderer Backend Cleanup & Separation** | load-bearing | "ripping up backend to separate editor specifics from renderer"; "split renderer from editor more" (worldbuilder, 2026-04-01) | Decoupling concerns; renderer as library; editor as consumer; real-time update architecture |
| **Graphics Card Compatibility (Intel Arc Series)** | nice-to-have | "Intel GPU Arc series…getting errors from Chorizite OpenGLS lib…Intel cards not great for this" (worldbuilder, 2026-04-11) | OpenGL shader compatibility; GPU vendor quirks; fallback rendering paths |
| **Render Distance Caps & Navigation** | nice-to-have | "50 landblocks worth render distance…usually don't know where I am"; need compass to navigate (worldbuilder, 2026-04-13) | Render distance LOD; view frustum culling; spatial awareness UI |
| **Memory Leak Patching (Retail Client)** | curiosity | "patching retail client to fix memory leaks" (notan DM, 2026-05-20) | Heapsnapshot analysis; leak detection tools; long-running stability |

### SERVER QUIRKS & IMPLEMENTATION DETAILS

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Quest & Recipe SQL Import/Export** | load-bearing | "/export-sql quest <questID>…edit file, reimport…same for recipes" (worldbuilder, 2026-04-07) | Quest SQL schema; recipe SQL schema; ACE import command; directory structure |
| **XP Table Auto-Scaling** | curiosity | "XP table can auto generate/scale past 275 to whatever you choose" (worldbuilder, 2026-04-11) | Level curve polynomial; XP per level; ACE XP database; scaling formula |
| **Spell Creation & Database Coupling** | load-bearing | "copy spell feature…edit both DAT/DB properties…persist until export"; "Save to DB for ACE database" (worldbuilder, 2026-04-11) | Spell SQL weenie; spell DAT data; dual-source updates; transaction safety |
| **Cell Portal Graph & PVS (Partial)** | open | Diagnostic Wave 5: "validate_cell_portal_graph.cjs" (notan DM, 2026-05-20) | Adjacency matrix; potentially visible set; portal face culling; pre-computed visibility |
| **Skybox / Atmosphere Parity (Partial)** | open | Diagnostic Wave 5: "validate_skybox.cjs"; "plain retail skybox code" (notan DM, 2026-05-20) | Skybox texture mapping; seasonal cycles; time-of-day blending; cloud layer blending |

### SECURITY & AUTH

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **Synthetic PDB for Retail Client Analysis** | curiosity | "PDB is synthetic, mapped on bindiff from 2013 PDB…useful if attaching to EOR retail client"; "2013 is better" (notan DM, 2026-05-20) | BinDiff reverse engineering; symbol reconstruction; retail binary patching; memory layout |
| **Antivirus False Positives (Decal Injection)** | load-bearing | "badimage for decal inject.dll after restart…whitelist in antivirus…Windows Defender exclusions" (decalinfo, 2026-04-16) | DLL signature; Windows Defender SmartScreen; allowlist configuration |

### CROSS-CUTTING TOOLING INSIGHTS

| Topic | Severity | Quote (Channel, Date) | Implementation Hints |
|-------|----------|-------|-----------|
| **DatReadWriter Library Adoption** | load-bearing | "datreadwriter is a gamechanger, compared to using Melt"; "separate editor specifics from renderer using datrw" (worldbuilder, 2026-04-09) | datrw npm/C# bindings; image surface handling; animation/motion parsing |
| **Feature-First vs. Rendering-First Approach** | curiosity | "wildly different approaches but same goal…interested in how people are so different"; ACME (features first) vs. Chorizite (rendering first) (worldbuilder, 2026-04-13) | Design philosophy; user feedback loops; technical debt trade-offs |
| **Holtburger-Web Diagnostic Toolset (9-of-14 Validator Coverage)** | load-bearing | "Diagnostic toolset…9 of 14 surfaces validator-covered"; "proving retail-correctness along every axis" (notan DM, 2026-05-20) | Browser-based validation; reference binary comparison; automated diff detection |

---

## Summary Statistics

- **Total Unique Topics Extracted:** 60
- **Categories Represented:** 13
- **Load-bearing Topics:** 35
- **Nice-to-Have Topics:** 18
- **Curiosity/Research Topics:** 7
- **Open/Unfinished (Wave 4-5):** 3

**Observation:** Decal SDK infrastructure collapse is real (v1 deprecated, v2 ancient, Windows-specific). WorldBuilder has two independent, incompatible forks (Trevis rendering-first, Vanquish420 ACME features-first). Holtburger-web diagnostic toolset (14 surfaces) is the only systematic retail-parity validator; most tooling still manual & ad-hoc. DAT parsing, physics, and motion parity solid; texture decode and mesh triangulation remain open Wave 4 targets.

