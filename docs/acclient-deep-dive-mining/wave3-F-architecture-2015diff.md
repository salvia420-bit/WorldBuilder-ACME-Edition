# Wave 3 — Agent F: `00-architecture.md` (11.4186) + `13-client-differences-2013-vs-2015.md`

Mined 2026-07-26. Docs read line-by-line (419 + 582 lines). Contrast target:
`external/holtburger/`. Cross-referenced against `wave0-palette-leak-patch.md`,
`wave1-A-physics-objectmodel.md`, `wave1-B-networking-combat.md`,
`wave2-C-rendering-audio.md`, `wave2-D-dat-crypto.md`, `VERIFICATION-LOG.md`,
`PHY-07-LIVE-RUN-2026-07-26.md`. Every holtburger citation below was opened, not
grepped-and-assumed. No `rg -r` was used anywhere.

## Method note — the command table was re-derived from scratch

The headline deliverable (§3, the ERA-CHECK REGISTER) rests on a first-party
extraction, not on the doc's prose. I dumped both parallel 408-entry arrays out
of the 2013 decompilation:

- `command_strings[408]`, declaration `ac-headers/acclient.c:43453`, element 0 at
  `:43455`
- `command_ids_1[408]`, declaration `:43864`, element 0 at `:43866`
  (the two sibling copies `command_ids` `:40403` and `command_ids_0` `:40838`
  were diffed and are **byte-identical** to `command_ids_1` — the §9
  "duplicate static constants" trap does not bite here)

then applied doc 13 §5's transformation rules (insert `SkillHealOther`/
`CombatEat`/`CombatDrink` at ordinal `0x10F`, shift every ordinal ≥ `0x10F` by
+3, rename the repurposed `SideBySideVitals` slot to `StretchUI`, append
`AI_TelegraphCast` at `0x19B`) to synthesise the 2015 table. Two independent
arithmetic checks fell out and both matched the doc exactly:

- **271 commands keep their ID** = ordinals `0x000`–`0x10E` = indices 0–270. Doc
  13 §5 says 271. ✔
- **136 shift by +3** = 408 − 271 − 1 (the removed `SideBySideVitals`). Doc says
  136, "nothing shifted by any other amount". ✔
- 2015 table bound = 0x19B + 1 = **0x19C**, up from 0x198. Doc 13 §5 says
  `string2command`'s bound goes `0x198 → 0x19C`. ✔

The doc's claim that **`NextMonster` (`0x0900010F` → `0x09000112`) is the lowest
shifted command** is confirmed directly: index 271 of the 2013 table is
`0x0900010F NextMonster`, index 270 is `0x1000010E SkillHealSelf`.

Working files (scratch, not committed): the derived 2013 and 2015 tables.

---

# 1. COVERAGE LEDGER

**Counts.** 96 dispositioned rows total.

| Disposition | Count |
|---|---|
| TASK | 15 rows (13 distinct task IDs: ARCH-01..02, ERA-01..05, D15-01..06) |
| PARITY-OK | 14 |
| VERIFY-LIVE | 5 |
| N/A-WEB | 22 |
| REF-ONLY | 40 |

Nothing in either document is skipped. Rows that a previous wave already owns are
dispositioned REF-ONLY **with the owning task ID named**, per the no-duplication
rule.

## 1.1 `2013-09-11.4186-v3/00-architecture.md`

### §1 The shape of the program

| # | Claim | Disposition |
|---|---|---|
| 1a | Single-threaded frame pump with exactly one long-lived worker (the DAT loader); the 13-phase order `Timer → Device::DoEventLoop → ClientNet::UseTime → ProcessLogonEventQueue → PacketController::UseTime → CLCache::UseTime → UIElementManager::UseTime → SmartBox::UseTime → PrepareGraphicsDevice → StartFrame → SmartBox::Draw → EndFrame → DoFrameSleep` | **VERIFY-LIVE(VL-F1)** — holtburger's `?singleDriver` is the *same* one-pass model and is **default-ON**: the reader is `params.get("singleDriver") !== "off"` (`apps/holtburger-web/scene3d/index.js:790-794`; per the flag-default footgun that IS default-ON, and `docs/url-flags.md:359` agrees), the claim is latched at `index.js:5275-5276`, and the pump runs as never-budget-gated CRITICAL phase #0 at the top of `tickPerFrame` (`scene3d/loop.js:1652-1692`, which cites `acclient.c:146316`/`:146324`). Confirming check: boot bare-default, assert `window.__scene3dFrameDriverActive === true` and `window.__rafTickCount` frozen (the 2D driver parked) — flag-audit alone is not proof (VERIFICATION-LOG's PHY-07 lesson). |
| 1b | The order is *observed*, transferred from the 2015 Hex-Rays 6.6 decompilation because `Client::UseTime` and `Client::KeepUIAlive` are the only two 11.4186 functions Hex-Rays failed to decompile | **REF-ONLY, and independently confirmed by me**: `acclient.c:552` and `:529` carry only `// idb` prototypes, and no body exists anywhere in the 31 MB file (`gmClient::UseTime` at `:61259` does have one, so the absence is specific, not a search artifact). |
| 1c | `UIFlow::Update` is **not** in the frame pump and has no visible caller; reached through the `Turbine_GUID` registry | N/A-WEB (no COM registry; holtburger's UI is DOM + JS plugins). |
| 1d | No frame cap while the window is active; `Device::DoFrameSleep` throttles to ~10 fps when inactive | N/A-WEB — rAF *is* the cap and the browser throttles occluded tabs for us. Divergence worth knowing: retail keeps *simulating* at ~10 fps when inactive, holtburger **freezes** sim on a long gap (`dt = 0` for `DT_RECOVERY_FRAMES`, `scene3d/index.js:2038-2052`) and relies on `?netWatchdog` (default-ON, `docs/url-flags.md:350`) + the 2.5 s wasm keepalive to keep the session alive. |
| 1e | Physics clamped twice: `CPhysics::UseTime` no-ops unless 1/30 s elapsed; `MIN_QUANTUM` 1/30 gates the remainder after `MAX_QUANTUM` 1/5 slices | REF-ONLY — owned by **PHY-20** and **PHY-08** (`wave1-A:41`, `:45`, `:277-280`). |

### §2 The central abstraction: every object is two objects

| # | Claim | Disposition |
|---|---|---|
| 2a | `CPhysicsObj` (position/cell/velocity/geometry/animation/collision) + `ACCWeenieObject` (name/icon/stats/inventory/UI), cross-linked by pointer | REF-ONLY — owned by wave1-A (`wave1-A:135`, PARITY-OK-by-design: holtburger collapses both halves into one `Entity`). See §4 synthesis for why that collapse is the right call *and* what it costs. |
| 2b | Registered in **parallel** hash tables `object_table` / `weenie_object_table`, each with a `null_` twin for objects whose cell is not loaded | REF-ONLY — wave1-A covers `null_` (4 mentions). Synthesis §4 notes holtburger's single `entities` map + the pre-create buffer (`scene3d/pre_create_buffer.js`) as the `null_`-twin analogue. |
| 2c | A third layer under the weenie: `PlayerDesc : CACQualities : CBaseQualities` holds the sparse property tables | PARITY-OK — holtburger's analogue is `WorldObjectProperties` behind `HasProperties`/`HasPropertiesMut` (`crates/holtburger-world/src/entity.rs:995-1006`), sparse per-type maps, same shape. |
| 2d | `SmartBox` is the world-session hub owning registry + physics + landscape + camera + player; effectively every 3D-world network event enters via `SmartBox::DispatchSmartBoxEvent` | PARITY-OK-by-design — holtburger's equivalent single funnel is `crates/holtburger-world/src/handlers/` (`properties.rs`, `movement.rs`, `player.rs`, …) driven from the recv loop; ownership of camera/landscape sits in JS instead. Structural, discussed in §4. |

### §3 Data flow, end to end

| # | Claim | Disposition |
|---|---|---|
| 3a | `ProtoHeader (20B) → BlobFrag (448B payload) → Indicator dedup/supersede/reassemble → queueID routes 2 control / 4 logon+chat / 5 DAT-DDD / 9 UI events / 10 SmartBox` | REF-ONLY — owned by wave1-B (**NET-13** queue assignment, **NET-14/15** the Indicator). |
| 3b | Queue 10 → `0xF745 CreateObject`, `0xF748 Position`; queue 9 → `0xF7B0` weenie-ordered / `0xF7B1` plain-ordered envelopes → `CACQualities` writes | REF-ONLY — wave1-B ledger rows 2-3. |
| 3c | The UI never reads the network and the network never touches widgets; the seam is the notice bus (157 `SendNotice_*`, 152 `RecvNotice_*`) | N/A-WEB as an implementation, **but the invariant matters** — holtburger's equivalent seam is `WorldEvent` → `client_event_dispatch.js` / `entity_dispatch.js` → plugins. See §4: holtburger's plugins also poll `sessionHandle` getters directly, which is the one place the invariant leaks. |
| 3d | Structural surprise: every `CWeenieObject` is itself a `NoticeRegistrar`, so notices are per-object, not purely global | N/A-WEB (no per-entity subscriber lists in holtburger; `WorldEvent::PropertiesUpdated { guid, updates }` carries the guid so subscribers filter). |
| 3e | A stat update writes `CACQualities`, fires a notice, and the window re-queries and marks itself dirty (pull-after-notify, not push-payload) | REF-ONLY — holtburger's `PropertiesUpdated` event *carries* the payload rather than signalling a re-query. Harmless divergence; noted for the synthesis. |

### §4 Three independent ordering layers

| # | Claim | Disposition |
|---|---|---|
| 4a | **Layer 1** packet sequence: `ProtoHeader.seqID_`, NAK lists, retransmit from `SentPacketStore`, `0x7FFF` look-ahead; the AVL of NAKed seqIDs stores each packet's **crypto key** so retransmits decrypt with the original key | REF-ONLY — owned by wave1-B (**NET-20**, **NET-21**, and the crypto-key row at `wave1-B:265-267`). |
| 4b | **Layer 2** blob ordering: 64-bit `blobID` ordering-type bits 56-60 + 16-bit stamp bits 32-47 + the `0xF7B0`/`0xF7B1` envelopes; the `Indicator` discards stale *ephemeral* fragments before reassembly begins and replaces a half-assembled blob on stamp mismatch (in the counter-intuitive direction) | REF-ONLY — owned by wave1-B (**NET-14**, **NET-15**, open question Q2). |
| 4c | **Layer 3a** per-object versions: `PhysicsDesc` carries `u16 timestamps[9]` | **PARITY-OK** — holtburger models the array with named indices and retail's exact slot assignment: `crates/holtburger-world/src/entity.rs:977-986` (`POSITION=0`, `VECTOR=3` with the `CPhysicsObj::update_times[3]` cite, `TELEPORT=4`, `SERVER_CONTROL=5`, `FORCE_POSITION=6`, `INSTANCE=8`), and gates applies on them in `should_accept_server_position_sequences` (`:1026-1044`) / `apply_server_position_update` (`:1047-1100`), including the position-only `is_newer_u16` reject at `:1071-1078`. |
| 4d | **Layer 3b** per-*property* versions: `ACWTimeStamper` keeps a per-property sequence byte keyed by `stype \| (StatType << 16)`; a stale update is silently dropped | **TASK ARCH-02** — the wire byte is parsed (`crates/holtburger-protocol/src/messages/object/messages/properties.rs:11-33`, `sequence: u8` as the first field of every `UpdateProperty*`) and then **never read**: `crates/holtburger-world/src/handlers/properties.rs` (208 lines) contains **zero** occurrences of `sequence`, and there is no stamper anywhere in the tree. |
| 4e | Consequence: a late movement packet can be dropped at layer 3 even though layers 1-2 delivered it correctly — deliberate reorder tolerance | Mixed: **PARITY-OK for position/vector** (4c) and **ABSENT for properties** (4d → ARCH-02). |

### §5 Almost everything is data-driven from the DATs

| # | Claim | Disposition |
|---|---|---|
| 5a | The DB_TYPE / DID-range table (GfxObj 6 `0x01……`, Setup 7 `0x02……`, Anim 8, Palette 10, Textures 11/12, MotionTable 14 `0x09……`, Clothing 25 `0x10……`, SoundTable 34 `0x20……`, LayoutDesc 35 `0x21……`, StringTable 37 `0x23-0x24……`, Keymap 29 `0x14……`, Landblock/cell 1/2/3) | **PARITY-OK — spot-verified by me** against the 2013 constants: `DB_TYPE_GFXOBJ = 6` (`acclient.c:39281`), `SETUP = 7` (`:39282`), `PALETTE = 10` (`:39285`), `MTABLE = 14` (`:39289`), `CLOTHING = 25` (`:39300`), `KEYMAP = 29` (`:39304`), `STRING_TABLE = 37` (`:39312`). All seven match the doc. The DAT-side parity is wave2-D's. |
| 5b | Almost nothing hardcodes a DID: `master_map_id_m` roots a two-level enum→DID indirection (`DBCache::GetDIDFromEnum`) | REF-ONLY — owned by **DAT-12** (`wave2-D:472-476`), which also *measured* that the EoR assumption holds. |
| 5c | UI windows are `LayoutDesc` trees whose per-state art/sound/animation come from `MediaDesc` playlists run by a bytecode interpreter (Pause/Jump/Message/State) | REF-ONLY / N/A-WEB — wave2-C owns the UI-media surface; holtburger's UI is not `LayoutDesc`-driven at runtime (WorldBuilder.Terminal's `ui-layout-render` is the tooling that does read them). |
| 5d | Skills are a `SkillFormula` record; XP is a table; movement speed is authored animation `MotionData` velocity; keybinds merge user INI over two DAT defaults; the gameplay-options list is DBObj enum 21 | REF-ONLY — the skill-formula divergence (holtburger drops `w`/`x`/`y`) is **CMB-21**; authored-velocity movement is wave1-A's. |

### §6 The standout engineering: the async cache

| # | Claim | Disposition |
|---|---|---|
| 6a | One dedicated I/O thread, 1024-slot lock-free SPSC ring queues + mutex-guarded overflow, event wakeup | N/A-WEB — owned by wave2-D; holtburger's analogue is `fetch` + the bake worker. |
| 6b | **No object construction off-thread** — the worker only reads and inflates (zlib); it does also perform saves and purges | REF-ONLY **with a live divergence worth recording**: holtburger's bake worker *does* construct (it holds its own wasm instance and calls `init_resource_source(manifest)` — MEMORY's staleness-rebuild §"bake web-worker"). That is a deliberate improvement, not a defect, but it is exactly the invariant retail chose not to break, and it is the reason the worker can silently serve stale geometry. |
| 6c | Main-thread completion time-boxed to **25 ms/frame** so a burst degrades smoothly | REF-ONLY — owned by **DAT-21** (`wave2-D:146`, `:559-560`); holtburger's tighter `RP3_DEFAULT_BUDGET_MS = 9` (`scene3d/loop.js:1542`). |
| 6d | Automatic dependency-graph loading (`nGetsRemaining`, `RequestsWaitingForMe`) — a `Setup` completes only when its children arrive | REF-ONLY — wave2-D. |
| 6e | Duplicate concurrent requests are deduplicated | REF-ONLY — wave2-D; holtburger's decode memo is the `thread_local` triangulation cache (MEMORY §perf-maintainability). |
| 6f | The on-disk B-tree is transactional: 64-byte write-ahead record at file offset 256, replayed on open | N/A-WEB — holtburger never writes DATs (baked HBA shards). |
| 6g | DDD writes carry a staleness guard — a newer on-disk iteration silently wins | N/A-WEB — cross-ref **NET-22** (the handshake half). |

### §7 Where authority lives

| # | Claim | Disposition |
|---|---|---|
| 7a | **Client is authoritative for its own movement**: full local physics incl. the restitution impulse `v += −(v·n)(1+e)·n`; it pushes position packs and the server *corrects* | REF-ONLY — wave1-A owns the impulse solver and the position-pack path; the live status of the faithful transition port is **PHY-07 / VERIFY-LIVE** (VERIFICATION-LOG). |
| 7b | **Server is authoritative for everything else**; combat sends only `(targetID, attackHeight, power)`; the client never learns absolute enemy health, only a fraction via `0x1BF` | PARITY-OK — wave1-B verified the opcodes and the fraction path; holtburger follows the same contract. |
| 7c | Structures that *look* like client logic are parsed and never read: CMT contents, `_casting_likelihood`, `_category`/`_power`, spell sets, `DamageOverTime`, the whole `Body` armor model, `CEmoteTable`, `CreationProfile`; **no** client-side chance-to-cast and **no** hit-location logic | REF-ONLY guard-rail — owned by **CMB-06** (holtburger drives the CMT, the *reverse* divergence) and the CMB-30 anti-task. This is the single most useful sentence in the architecture doc for scoping our work and it is already consumed. |
| 7d | No *local* anti-cheat: no debugger detection, integrity check, version self-validation or code checksum; only a voluntary speedhack self-report | REF-ONLY — cross-ref **NET-06** (holtburger throws TimeSync away, so it cannot self-report either). |
| 7e | "Anti-cheat absent" is too strong: a server-driven plugin audit (`ClientAdminSystem::Handle_Admin__Recv_QueryPluginList`) answers with plugin name/author/e-mail/webpage | N/A-WEB — but note holtburger *has* a plugin system (`apps/holtburger-web/plugins/`) and no audit surface; if ACE ever asks, we answer nothing. Filed as an open question, not a task. |
| 7f | This build never installs `SetUnhandledExceptionFilter`; the Turbine filter, 100 MB emergency pool and Watson are gated behind a debug bit cleared by `Turbine::Debug::Init` | N/A-WEB. |
| 7g | `APIManager` deliberately loads a registry-named third-party DLL and hands it a 56-method COM interface, 16 of which are `E_FAIL` stubs | N/A-WEB (doc 13 §3 adds that the vtable has 52 slots in both builds — see the doc-corrections section). |

### §8 Reading the codebase: recurring idioms

| # | Claim | Disposition |
|---|---|---|
| 8a | `PStringBase<T>`: bare pointer with metadata at *negative* offsets in a shared `PSRefBuffer` (vfptr, refcount, capacity, flags, length, data at +20); every destructor inlines `InterlockedDecrement` on `buffer[-1]` + a virtual call at `buffer[-2]` | N/A-WEB (reading aid only). |
| 8b | `Turbine_GUID` is layout-identical to `_GUID`; the root `Interface` vtable is 3 `__stdcall` IUnknown slots + 3 `__thiscall` Turbine slots | N/A-WEB. |
| 8c | `PackObj` serialization: virtual `GetPackSize`/`Pack`/`UnPack`; strings are `u16` length + bytes + 4-byte align; `PackableHashTable` packs bucket count high / element count low in one dword | PARITY-OK — verified by wave1-B (`messages/utils.rs:26-38`, `:66-90`, `:96-106`). |
| 8d | Bitfield-gated optional fields everywhere, and **the gate bits are not field order** — `CBaseQualities` gates int with `0x01` but int64 with `0x80` despite int64 being the second field | PARITY-OK-by-reference — wave1-A owns the `CACQualities::UnPack` mask work. Keep the warning: it is the exact shape of bug that produces a silently mis-offset property blob. |
| 8e | Generated notice boilerplate: each `SendNotice_X` fetches a handler list for a compile-time ID and calls a fixed vtable slot; no dynamic dispatch table | N/A-WEB. |

### §9 Decompiler traps (9 items)

| # | Trap | Disposition |
|---|---|---|
| 9a | Hex-Rays substitutes string literals for large immediates — `0x800000` renders as `"activation type (%s)…"`; it is `SLEDDING_PS` / `Vitae_EnchantmentType` / `MISSILE_AMMO_LOC` by context | REF-ONLY — consumed by wave1-B (the Vitae `0x800000` vs `0x8000000` correction). |
| 9b | Not every strange constant is an artifact: `PhysicsGlobals::floor_z = cos(3437.746770784939)` is a real degrees-for-radians bug ⇒ walkable slope ≈ **48.38°, not 60°** | REF-ONLY — wave1-A/2-D own it. |
| 9c | Duplicate static constants across TUs: 100 `MIN_QUANTUM` initializers, only `_93`/`_97` live | REF-ONLY — and I re-used this trap productively: the three `command_ids*` arrays are the same phenomenon and I diffed all three before trusting one (Method note). |
| 9d | Type tags look like DIDs: `0x10000004`, `0x10000009` are DB_TYPE constants for `GetByEnum`, not data IDs | REF-ONLY — wave1-A `:732` already banked this. |
| 9e | IDA mislabels struct fields (`CACQualities::UnPack` branches; the `Client` command-line members are offset-shifted); trust `SetPackHeader` and `operator new` sizes | REF-ONLY. |
| 9f | Trampolines abound (`MasterDBMap::Init`, `DiskController::LoadData`) — check function length | REF-ONLY. |
| 9g | `__usercall` register args signal a failed *caller*; e.g. `SceneTool::EndFrame(a1@<ebx>…)` is called from the two undecompilable pumps | REF-ONLY — this is also corroborating evidence for 1a/1b. |
| 9h | Prefer header enums to inferred bits (`EnchantmentTypeEnum`, `SpellIndex`, `StatType`, `COMBAT_MODE`, `RadarBlipShape`) | REF-ONLY — consumed by wave1-B. |
| 9i | Notice IDs are address-encoded (`(char *)&loc_XXXXXX + n`), so grepping the decimal finds nothing; misreading `nullsub_1891` as hex produced two phantom notice IDs | REF-ONLY. |
| 9j | Absence of evidence is not evidence of absence — every strong negative came from grep over one decompilation, and two proved false | REF-ONLY, and adopted: every ABSENT below names the exact search and the file that would have contained the thing. |

### §10 Archaeology: what this build is

| # | Claim | Disposition |
|---|---|---|
| 10a | 1999 core intact: sphere-swept collision vs BSP soups; offline "texture merge" terrain; CPU-lit landscape rebuilt per frame; painter's translucency with the alpha list **not sorted at all** (coarse per-part ordering beforehand); portal-clipped visibility; pure fixed-function T&L; 2D DirectSound with software pan and a listener configured once | REF-ONLY — every clause is owned by wave1-A (collision) or wave2-C (terrain/alpha/audio). |
| 10b | Two complete rendering stacks share the process; the newer Turbine material stack (`RenderMaterial`/`MaterialLayer`/`LayerStage`, `RenderPassType` up to `RenderPass_LandscapeShadowMap`) is live but drives only 2D UI, atlas fonts and debug primitives; `SetVertexShader` always passes NULL | REF-ONLY — wave2-C. Load-bearing for scoping: shader-era names in the binary are **not** evidence the world renderer had shaders. |
| 10c | Several expected features do not exist: no shadows, no nameplates/speech bubbles/damage numbers (hover name is a mouse-anchored tooltip), no MIDI music (complete player, no caller), no weather engine (UV-scrolling objects pinned under the player) | REF-ONLY — wave2-C owns all four; holtburger deliberately exceeds retail on shadows/nameplates/weather. |
| 10d | Two earlier-draft claims were wrong: **billboarding does exist** (`CPhysicsPart::calc_draw_frame`, four DAT modes) and **streaming audio does exist** (a live DirectShow filter graph outside `SoundManager`) | REF-ONLY — wave2-C has 21 billboard mentions. Kept as the canonical "one plausible location is not the binary" lesson. |
| 10e | Gameplay accreted: floaty windows parallel to fixed panels; `PlayerModule` carries two generations of options storage; augmentations/luminance/enlightenment/aetheria appear only as bare property literals with the named enums living on the server | REF-ONLY — **and doc 13 §5 upgrades this**: by 2015 Enlightenment is no longer a bare literal; it is read in four `CACQualities` methods and two UI panels. See §5 D15 rows. |
| 10f | Developer tooling shipped in retail (`DebugConsole`, `ProfilerUI`, debug HUD, dxdiag report, `loc`/`render`/`framerate` commands); no GM-only commands ship | REF-ONLY — holtburger's `__diag` surface is the same instinct. |
| 10g | The build is recoverable: 16,232 function symbols, 1,091 module records under `d:\ac1_sep13\output\obj\…\WIN32\retail\`, confirming the `Portal*`/`AC*`/`GAME*`/`ENGINE*` four-layer static-lib split | REF-ONLY. |

### §11 Cross-references table

| # | Claim | Disposition |
|---|---|---|
| 11a | The 11-report map + navigation aids (`INDEX.md` 1,011 classes, `func_index.tsv` 36,601 bodies, `struct_index.txt`) | REF-ONLY. |

## 1.2 `2015-10-11.6096-v3/13-client-differences-2013-vs-2015.md`

### §0 Verdict

| # | Claim | Disposition |
|---|---|---|
| 0a | 11,081 of 11,127 functions byte-identical; **46 changed**; 99.59% unchanged. The 2015 client is the 2013 client plus a small enumerable patch | REF-ONLY — this is the licence for the whole mining corpus: every algorithm/layout/protocol claim in the 2013 pack describes code that is byte-identical in the client our DATs and ACE target. |
| 0b | Two themes cover all 46: **content** (Enlightenment, PK Damage, Overpower, Hear-PK-Deaths, two opcodes, six emote types, four motion commands) and **raised capacity limits** | REF-ONLY → drives §5. |
| 0c | Three of the 46 carry **no behavioural change**: `Handle_PlayerDescription` and `Appraisal_ShowSpecialProperties` (instruction scheduling), `PlayerInReadyPosition` (pure enum renumbering) | REF-ONLY — **explicitly no tasks filed** for these three (see §6 ANTI-TASKS). |
| 0d | That only 46 functions changed in two years is itself the finding: late-era development was data-driven through the server and DATs | REF-ONLY — strategically important: it means our DAT-era assumptions matter far more than our binary-era assumptions. |

### §1 Why the naive comparisons are all wrong

| # | Claim | Disposition |
|---|---|---|
| 1a | Six methods gave 80.7% / 2.7% / 3.5% / 40.2% / 0.84% / **0.41%**; only relocation table + real instruction boundaries is correct | REF-ONLY methodology. |
| 1b | Operand *scanning* desynchronises (masking a 4-byte operand can swallow the next opcode) — produced hundreds of false diffs incl. `ACCWeenieObject::~ACCWeenieObject` | REF-ONLY. |
| 1c | Lockstep comparison fails whenever an address's low byte matches — `ObjectBeingDeleted` was rejected despite being byte-identical | REF-ONLY. |
| 1d | Only `.reloc` is authoritative about which bytes are addresses | REF-ONLY. |

### §2 The two binaries

| # | Claim | Disposition |
|---|---|---|
| 2a | Header table: 4,837,376 → 4,841,472 bytes; MD5s; timestamps 2013-09-06 / 2015-06-12; both `DllCharacteristics 0x0000` (no ASLR/DEP); **PDB build root `d:\ac1_sep13\` → `d:\ac1_acxp\`**; PDB shipped only for 2013 | REF-ONLY. |
| 2b | Sections: `.text` +3,856 (+0.10%); `.data`/`.data1`/`.rsrc` byte-size unchanged; `.rsrc` differs in only 37 of 49,152 bytes (the version string) | REF-ONLY. |
| 2c | **Import tables identical** — 18 DLLs, 372 functions, same order | REF-ONLY. |
| 2d | 16 ASCII strings added, 3 removed — the whole user-visible surface of two years | REF-ONLY → each maps to a §5 row. |
| 2e | `SideBySideVitals` → `StretchUI` is a **slot repurpose, not a rename**: the option key changed but `ID_PlayerOption_SideBySideVitals[_Help]` still exist in 11.6096 and were not renamed | **ERA register row 12** — holtburger inherits the trap: `motion_command_names.rs:102` has the correct 2015 *value* `0x9000161` under the stale *name* `SideBySideVitals`. |
| 2f | **Correction to the 2013 notes:** "file offset == RVA for every section" is false — it holds for `.text`/`.rdata`/`.data` only; `.data1`/`.rsrc`/`.reloc` are shifted by −`0xCF000` | REF-ONLY, but relevant to `wave0-palette-leak-patch.md` (whose patch sites are in `.text`, so `file offset = VA − 0x400000` is correct there — no action). |

### §3 What did *not* change

| # | Claim | Disposition |
|---|---|---|
| 3a | Crypto/hashes/checksums/PRNGs: 27 functions, **0 changed** — ISAAC-32, PJW/ELF, `CalcChecksum32`, L'Ecuyer `ran2`, packet checksum, spell-formula obfuscation all byte-identical | REF-ONLY — licenses `wave2-D` verbatim (which already noted this at `:355`). |
| 3b | DAT container / BTree / disk controller / async cache / `MasterDBMap`: 292 functions, **0 changed**; the 50 `DB_TYPE_*` registrations and 56 extension strings identical | REF-ONLY — licenses wave2-D and my §5a spot-check. |
| 3c | Rendering core (`RenderDeviceD3D`, `D3DPolyRender`, `ImgTex`, `PView`, `SurfaceWindow`): 265, **0** | REF-ONLY — licenses wave2-C. |
| 3d | UI framework (`UIElement*`, `UIRegion`, `UIElementManager`, `MediaMachine`): 710, **0** | REF-ONLY. |
| 3e | Object maintenance (`CObjectMaint`, `ACCObjectMaint`, `ACCWeenieObject`): 116, **0** | REF-ONLY — licenses wave1-A §1/§2. |
| 3f | Audio: 47, **0** | REF-ONLY — licenses wave2-C's audio half. |
| 3g | Physics: 354 functions, **3 changed — all in `CMotionInterp`, on jump gating** | **TASK ERA-01 + ERA-02.** This is the only physics delta in two years and holtburger gets it wrong by exactly the +3 shift. |
| 3h | Network: 199 functions, **2 changed** — `ClientFlowQueue` ctor and the message dispatcher | REF-ONLY + **D15-05** (the dispatcher change is the two new opcodes). |
| 3i | `NetPacket::ComputeChecksum` / `AddFrag` identical; `ClientNet::HandleTimeSynch` / `SharedNet::SharedNet` identical | REF-ONLY — licenses wave1-B's transport work. |
| 3j | Plugin loader intact: `APIManager::Init` byte-identical, same registry key, `IAsheronsCall` vtable **52 slots** in the same order | REF-ONLY — see DOC CORRECTIONS (52 vs the architecture doc's 56). |
| 3k | Command line unchanged: same nine `Client` and seven `gmClient` arguments | N/A-WEB. |
| 3l | Preference system unchanged — same 103-entry UI preference table | N/A-WEB. |
| 3m | `CLCache::SetRegion` / `SetLanguageInternal` identical; region/language sets live in the DATs | REF-ONLY. |
| 3n | All 24 `gmStatManagementUI` functions identical, displaced by exactly `+0xC90` | REF-ONLY. |

### §4 Translating addresses between the builds

| # | Claim | Disposition |
|---|---|---|
| 4a | No single constant offset: the shift grows monotonically `+0x360 → +0x1000` across 471 distinct step values; 98.4% of consecutive steps non-decreasing | REF-ONLY. |
| 4b | The 16-row range table is a **sanity check, not a translation function**; COMDAT reordering relocates individual functions arbitrarily (`GetVendorID`, `PackableList<ContentProfile>::Pack` `0x6ADA10 → 0x55B4A0`) | REF-ONLY. |
| 4c | The reliable method is masked-byte matching; 87% match at exactly one site; code folding makes two differently-named functions share an address (`DArray<portal_info>::grow` and `DArray<ObjectInfo>::grow` both `0x0051ABB0`) | REF-ONLY — and it is why `wave0-palette-leak-patch.md`'s dual-address record (2013 + EoR) is the right pattern for every future patch. |

### §5 The 46 changed functions

| # | Claim | Disposition |
|---|---|---|
| 5a | **Enlightenment** — property `0x186` (390), absent from 11.4186 entirely | PARITY-OK — `crates/holtburger-common/src/properties/property_keys/ints.rs:398` `Enlightenment = 390`. |
| 5b | `CACQualities::InqSkill` adds Enlightenment to **every** skill at Trained+ (`_sac != 1`), **outside** the `if (!raw)` guard | Mixed — **PARITY-OK for the raw/base path** (`crates/holtburger-core/src/client/skill_info.rs:204-205`, `if self.training >= TrainingClass::Trained { base += Enlightenment }`), **divergent for the effective path** (`current`, `:241-297`, recomputes `effective_base` and never adds it). See OPEN QUESTION Q-F3 — this is upstream (`Chorizite/ACPlugin/API/SkillInfo.cs`) and ACE-side, not our bug, and "fixing" it would diverge from the server. Not filed as a task. |
| 5c | `InqRunRate` / `InqJumpVelocity` add Enlightenment to Run/Jump **before** `EnchantSkill`, i.e. inside the enchantment pipeline | PARITY-OK-by-delegation — holtburger feeds `run_rate_from_skill_and_burden` from the **wire** Run skill `current` (`crates/holtburger-world/src/context.rs:155-176`, `RunSkillSource::WireRunSkill`, Quickness fallback retired), so whatever the server computed is what we use. The underlying formulas are byte-identical between builds (doc says `MovementSystem::GetRunRate`/`GetJumpHeight` unchanged). |
| 5d | `InqAttribute2nd` adds `2 × Enlightenment` to **Max Health only**; Stamina and Mana untouched | PARITY-OK — `crates/holtburger-core/src/client/vital_info.rs:168-172` with the ACE cite at `:134-135`, and the Stamina-excluded test at `:487-498`. |
| 5e | `gmCharacterInfoUI::UpdatePlayerBirthAgeDeaths` gains an Enlightenment-tiers line gated `InqInt(0x186) > 0`; `CharExamineUI::SetAppraiseInfo` gains an `Enlightenment:` line | **VERIFY-LIVE(VL-F2)** / low value — the property is available; whether the character panel renders it is a UI question. Check: `?autoLogin` a character with `Enlightenment > 0` and read the character-info panel (`apps/holtburger-web/plugins/character-info.js`). |
| 5f | **Two new combat ratings**: PK Damage `0x17D`/`0x17E` char-side + `0x17F`/`0x180` gear-side; Overpower `0x182`/`0x183` + `0x184`/`0x185` | PARITY-OK on the IDs — `ints.rs:389-392` (381-384 = `0x17D`-`0x180`) and `:394-397` (386-389 = `0x182`-`0x185`). Exact match, including the skipped `0x181`. |
| 5g | `ItemExamineUI::Appraisal_ShowRatings` grows 10 → 14 gear ratings, new lines inserted between Crit Dam Resist and Heal Boost; `CreatureExamineUI`/`CharExamineUI` grow 9 → 13 | **TASK D15-06** — the four new rating properties (and, it turns out, the ten pre-existing ones) have **no appraisal renderer**: grep for `DamageRating`/`CritRating`/`HealingBoostRating`/`NetherResistRating` across `apps/holtburger-web` and `crates` returns only the `property_keys` declarations plus the unrelated `ac_damage_rating.js` *predictor* (`apps/holtburger-web/ui/ac_damage_rating.js:1-46`, which computes outgoing DR from Recklessness/Sneak/DamageMod and explicitly scopes armour ratings out). |
| 5h | `ClientCombatSystem::Handle{Attacker,Defender}NotificationEvent` gain `attack_conditions & 8 → "Overpower! "`, joining `& 4` Sneak and `& 2` Recklessness | REF-ONLY — already **CMB-05** (holtburger declares `OVERPOWER = 0x8` at `crates/holtburger-protocol/src/messages/combat/types.rs:34` and never renders it). Doc 13 confirms `0x8` is a genuine 2015 addition, which *raises* CMB-05's priority: the bit is not legacy cruft. |
| 5i | `Appraisal_ShowSpecialProperties` — **not** a behavioural change (same 1,024 instructions, two `mov`s reordered) | ANTI-TASK (§6). |
| 5j | The property IDs are confirmed **directly in the binaries**, not from decompiler output, because IDA typed `AppraisalProfile::Inq*`'s property parameter as `char` in the 2015 DB and prints only the low byte | REF-ONLY — an important methodology warning for anyone reading the 2015 `.c`. |
| 5k | **Two new network opcodes**: `UIQueueManager::ProcessNetBlobData` dispatches 164 IDs, up from 162; `0x317` and `0x318` added; pivot `cmp edx,0x276 → 0x27A`; routed by two new 160-byte dispatchers to `Handle_Communication__TransientString` and `Handle_Communication__PopUpString`, both handlers byte-identical | **TASK D15-05** — `0x0317`/`0x0318` are absent from holtburger (`crates/holtburger-protocol/src/opcodes.rs` has `CommunicationTransientString = 0x02EB` at `:835` and nothing in `0x03xx` for these), absent from chorizite (`Chorizite.ACProtocol/Enums/GameEventType.generated.cs:210` has only `0x02EB`), and absent from ACE. |
| 5l | `Client::Client` ends `ret 4`; `gmClient::gmClient` gained a `push 0`; the argument is never read — MSVC's hidden most-derived flag, **behaviourally inert** | N/A-WEB. |
| 5m | `ClientCommunicationSystem::IsMessageSafe` gains `if (len > 0x100) return 0` as its first statement — outgoing chat ≥ 256 chars is silently dropped; the existing `<tell:` and newline-injection checks unchanged | **TASK D15-03** — holtburger has **no** `IsMessageSafe` analogue at all: `SessionHandle::send_chat` (`apps/holtburger-web/src/lib.rs:33132-33144`) rejects only `message.is_empty()`, and the `ClientCommand::Talk` arm (`crates/holtburger-core/src/client/commands.rs:271-277`) adds no validation. So both the 2013 checks *and* the 2015 cap are missing. |
| 5n | `Handle_Communication__TextboxString` gains the `[PKDe]` filter: if present and Hear-PK-Deaths is **off**, drop the message; if on, strip the tag and fall through | **TASK D15-02** (dormant against ACE — grep for `PKDe` across `external/ACE/Source` finds only `IsPKDeath()` predicates, never the literal tag, so ACE does not emit it today). |
| 5o | Friend and squelch caps 50 → 100 at exactly five sites (`0x32 → 0x64`); the refusal error `0x561` and its text unchanged | ABSENT / low — holtburger enforces no client-side friend or squelch cap at all (no `50`/`100` bound near friends/squelch anywhere in `crates` or `apps`). Folded into D15-07 as a note, **not** filed as a task: with no cap, we cannot be wrong by the old one. |
| 5p | Hear-PK-Deaths is **option index `0x34` (52)**; 11.4186 has 52 options (`0x00`-`0x33`), 11.6096 has 53; it lives in `PlayerModule::options2_` (`this+0x90`) at **bit 25**, mask `0x02000000`, registered right after `HearSocietyChat` (`0x2E`) | PARITY-OK — `crates/holtburger-common/src/character.rs:170` `ListenToPKDeathMessages = 0x34` and `:85` `HEAR_PK_DEATH = 0x02000000`; the option→mask mapping at `crates/holtburger-world/src/player/types.rs:1266-1268`. ACE agrees (`ACE.Entity/Enum/CharacterOptions2.cs:38`, `CharacterOption.cs:171-172`). |
| 5q | **It defaults to on**: `PlayerModule::PlayerModule` and `PlayerModule::UnPack` initialise `options2_` to `0x00948700` in 2013 and `0x02948700` in 2015 — that single bit is the only difference in either function | **TASK D15-01** — holtburger's `CharacterOptions2::DEFAULT` (`character.rs:92-98`) is `HEAR_GENERAL_CHAT \| HEAR_TRADE_CHAT \| HEAR_LFG_CHAT \| LEAD_MISSILE_TARGETS \| CONFIRM_VOLATILE_RARE_USE \| SHOW_HELM \| SHOW_CLOAK` = `0x100+0x200+0x400+0x8000+0x40000+0x100000+0x800000` = **exactly `0x00948700`** — retail's *2013* constant, bit-for-bit. |
| 5r | **The slash-command table did not change**: `InitializeCommands` registers the same 116 commands, `StartupTurbineChatSystem` the same 15, `HandleFailureEvent` the same 339 case labels; all three byte-differ only because their string/function-pointer immediates moved | REF-ONLY — a load-bearing negative: our WERROR / slash-command work (CMB-19, CMB-20) needs no era qualification. |
| 5s | Emote carriers changed: `Emote::{IsValid,Pack,UnPack,pack_size}`, `EmoteSet::{Pack,UnPack,pack_size}` carry the four new motion/emote names | REF-ONLY → 5x/5y. |
| 5t | `CMotionInterp::{motion_allows_jump, jump_charge_is_allowed, charge_jump}` change which motion states permit a jump; the blocked-set table is identical between builds **except** `0x10000128–0x10000131 → 0x1000012B–0x10000134`, plus two new exacts `0x10000057 Sanctuary` and `0x1000019B AI_TelegraphCast` | **TASK ERA-01** (the shifted range) + **TASK ERA-02** (the two new exacts). |
| 5u | "That shifted range is the most informative single fact in the comparison" — the window did not widen or narrow, it **moved by exactly three** | REF-ONLY, and it is the diagnostic that makes ERA-01 unambiguous. |
| 5v | Root cause in `string2command`: bound `0x198 → 0x19C`; added `SkillHealOther 0x1000010F`, `CombatEat 0x10000110`, `CombatDrink 0x10000111`, `AI_TelegraphCast 0x1000019B`, `StretchUI 0x09000161`; removed `SideBySideVitals 0x0900015E`; of 407 shared commands **271 kept their ID and 136 shifted by exactly +3**, boundary ordinal `0x10F`, spanning **both** namespaces, lowest affected `NextMonster 0x0900010F` | **§3 ERA-CHECK REGISTER** — independently re-derived and confirmed (see Method note). |
| 5w | The blockquote: this is **the one constant in the whole comparison that silently changed meaning** rather than being added; any tool hardcoding an ordinal ≥ `0x10F` in either namespace is wrong by three | **§3**, and it is why ERA-05 files a regression test rather than a comment. |
| 5x | `Emote` type enum grows `1–0x79 (121)` → `1–0x7F (127)`: six new types reusing existing payload shapes; struct layout unchanged | **TASK D15-04** — holtburger stops at `0x79` (`crates/holtburger-common/src/properties/emote.rs:280` `InqContractsFull = 0x79`) and **pins** the old bound with `assert_eq!(EmoteType::from_repr(0x7A), None)` at `:407`. ACE also stops at 121 (`ACE.Entity/Enum/EmoteType.cs:130`). |
| 5y | `EmoteSet` category max `0x26 (38) → 0x27 (39)`; the new category packs the existing `style`/`substyle` pair, no new field | **TASK D15-04** (same task) — holtburger's max is `ReceiveTalkDirect = 0x26` (`emote.rs:89`); ACE's is 38 (`EmoteCategory.cs:50`). |
| 5z | `PlayerInReadyPosition` is in the changed list **for the renumbering reason only** — its accepted motion set is identical, `AtlatlCombat`/`ThrownShieldCombat` merely `0x80000138/9 → 0x8000013B/C` | REF-ONLY — this is the independent confirmation of **CMB-11**'s self-correction. holtburger's `0x8000013b`/`0x8000013c` (`crates/holtburger-protocol/src/messages/movement/types.rs:91-92`) is right. |
| 5aa | Capacity limits: friend/squelch 50→100; 256-char outgoing chat; `HAR::HAR` guest hash **64 → 128 buckets**; `AllegianceHierarchy::UnPack` count **signed i16 → unsigned u32** (previously a 32,768–65,535-node hierarchy unpacked as **zero**); `AllegianceHierarchy::Add` gains `m_total <= 40000`; `ClientFlowQueue` `FlowLevel_` **10 → 1** | Mixed — allegiance count **PARITY-OK** (`crates/holtburger-protocol/src/messages/allegiance/events.rs:453`, `read_u16(...) as usize` = unsigned, so the i16 bug is not reproduced and the 40,000 server ceiling makes >65,535 unreachable); `HAR` buckets **N/A-WEB** (no client-side guest hash); `FlowLevel` **N/A-WEB** (holtburger models no flow-control state — grep for `flow_level`/`FlowLevel` in `crates` is empty; the `0x8000000` Flow *header* is parsed, see wave1-B); friend/squelch → 5o; 256-char → D15-03. |
| 5ab | `CPlayerSystem::OnAction` jump-table bound `0x114 → 0x115`, exactly one new case: action **`0x1000013F`**, which toggles the new option; all 75 pre-existing cases unchanged | PARITY-OK — `crates/holtburger-common/src/properties/ui.rs:357` `PlayerOption_HearPKDeaths = 0x1000013F`. **This is our strongest single piece of era evidence for the ClientAction namespace** (see §3 row 37): the 2013 PDB has no such constant. |
| 5ac | `PlayerModule::{GetOption,SetOption,UnPack,ctor}`, `CPlayerModule::IsAutoSaveOption`, `gmCharacterSettingsUI::InitOptions` all changed because 52 options became 53 | REF-ONLY. |
| 5ad | `gmSpewBoxUI::Update` now forces spew-box text to opaque yellow `{1,1,0,1}` | N/A-WEB (no spew box; the closest analogue is the chat log, which is CSS-styled). |
| 5ae | `CPlayerSystem::Handle_PlayerDescription` — **no semantic change**, 179 instructions both builds, two swapped loads and `lea` operand order; **no new field is unpacked** | ANTI-TASK (§6) — and a useful negative: `PlayerDescription (0x13)` has the *same* wire shape in both builds, so holtburger's hydrate path needs no era qualification. |

### §6 Where the 2013 notes need a footnote

| # | Claim | Disposition |
|---|---|---|
| 6a | `11-memory-leak-investigation.md` §8b — **the vtable labels are inverted**: `0x007E3EA0` is the vptr at `object+0` (`ACCWeenieObject`, slot 1 = `ObjectBeingDeleted`); `0x007E3E88` is the `NoticeRegistrar` base sub-object vptr at `object+0xC` (slot 1 = `RegisterNoticeHandler`). The report calls the first "secondary" and the second "primary". The practical warning still stands | REF-ONLY — a correction to the 2013 pack itself. Relevant only to native-client patching (`wave0-palette-leak-patch.md`'s domain), not to holtburger. Recorded in §6 DOC CORRECTIONS. |
| 6b | `11-memory-leak-investigation.md` §8b — "file offset == RVA for every section" is **false** | REF-ONLY (= 2f). |
| 6c | `04-combat-magic.md` / `03-object-model.md` describe the 2013 rating and property sets; four rating properties and one progression stat were added in 2015; **no existing property changed ID or meaning** | REF-ONLY → 5a/5f. The second clause is the important one: property IDs are era-stable, so only the command namespace needs era-checking. |
| 6d | `01-physics.md` / `05-ui.md` — command IDs at ordinal ≥ `0x10F` shifted by +3; 136 of 407 shared IDs **name a different command** in 11.6096; check any tool or keybinding table that hardcodes command IDs | **§3 ERA-CHECK REGISTER** — this footnote is the reason wave 3 exists. |
| 6e | Everything else in `01-physics.md` describes byte-identical code (`CPhysicsObj`, `CTransition`, `CSequence`, `CObjCell`, `CMotionTable`, the collision primitives: **zero** changed functions) | REF-ONLY — licenses wave1-A's entire physics surface era-wise. |

### §7 Provenance

| # | Claim | Disposition |
|---|---|---|
| 7a | Inventory from the 2013 PDB: 16,232 global + 23,716 static symbols; 11,127 distinct functions ≥ 32 bytes is the comparison population; sub-32-byte functions excluded because they fold | REF-ONLY. |
| 7b | No PDB for 11.6096 — every 2015 address was derived by masked-byte matching and confirmed against the name-stripped decompilation | REF-ONLY. |
| 7c | **Call targets are masked**, so a function whose only change was calling a different callee counts identical; of 30,566 resolvable edges 96.9% land where the mapping predicts, and the residual 3.1% is an **upper bound** dominated by folded bodies | REF-ONLY — the honest limit on "99.59% identical". |
| 7d | Only 2013-side functions were enumerated, so 2015-only functions cannot appear; two are known (the `0x317`/`0x318` dispatchers); the rest of the 3,856-byte `.text` growth is unattributed and could hide further new functions | REF-ONLY — bounds how far D15-05 can be trusted as "the complete opcode delta". |

---

# 2. TASKS

## ARCH-01 — `motion_allows_jump` exists twice, unsynchronised, and the two copies already disagree

- **Source §:** `00-architecture.md` §8 (recurring idioms — one retail function, one place) and doc 13 §3 (physics: 3 changed functions, all in `CMotionInterp`).
- **Retail:** `CMotionInterp::motion_allows_jump` is a single static function taking the substate/motion id and returning `0` (allowed) or WD_Error `72`. Its blocked set is one authored list.
- **holtburger today:** two independent ports.
  1. `crates/holtburger-core/src/client/movement/motion_interp.rs:261-277` — the faithful port, returns `72`/`0`, structured as retail's nested guards (`> 0x40000018` arm, `< 0x40000016` arm with an inner `> 0x1000_0131` test, else-true arm).
  2. `crates/holtburger-world/src/player/types.rs:64-71` — a flattened boolean re-implementation (`!(matches!(...) || ...)`) with its own doc block at `:37-62` citing `external/GDL/PhatSDK/MovementManager.cpp:427-438` (file present).
  Copy 2 is the one the live path uses: `crates/holtburger-core/src/client/movement/jump_charge.rs:142` calls `holtburger_world::player::motion_allows_jump` for the charge gate. Copy 1's only consumers are its own tests (`motion_interp.rs:2312-2326`) — and that same test module reaches for copy 2 via a delegating helper (`motion_interp.rs:3095-3096`, `fn motion_allows_jump_id` → `holtburger_world::player::motion_allows_jump`), which is direct evidence the two are already used as if interchangeable.
- **Proposed change:** delete one. Keep the `holtburger-world` signature the callers already use, re-express it as the retail-shaped guard chain from copy 1 (so the ERA-01 fix lands once), and have `motion_interp.rs` re-export rather than re-implement. If the crate graph forbids that direction, move the predicate to `holtburger-common` and have both depend on it.
- **Payoff:** ERA-01 has to be fixed in two files today, and nothing detects drift between them. The cost of the duplication is already realised — copy 1 encodes the `> 0x1000_0131` boundary as a *guard* and copy 2 as a *range*, which are only accidentally equivalent.
- **Effort:** S.
- **Validation:** move copy 1's test module across; add an exhaustive test that walks every ordinal `0x000`–`0x1FF` in each of the seven class bytes and asserts both entry points agree (they will, because there will be one).

## ARCH-02 — the per-property ordering stamp is parsed and thrown away (ordering layer 3b)

- **Source §:** `00-architecture.md` §4 layer 3 — "`ACWTimeStamper` keeps a per-property sequence byte keyed by `stype | (StatType << 16)`. A stale update is silently dropped", and §4's closing point that layer 3 exists precisely so a late packet that layers 1-2 delivered correctly can still be discarded.
- **Retail:** every `UpdateProperty*` message carries a one-byte sequence. The client keys a `PHashTable<ulong,uchar>` by `property_id | (stat_type << 16)` and drops any update whose byte is not newer. Reordered or retransmitted property writes therefore cannot resurrect an old value.
- **holtburger today:** the byte is **parsed and never read**. `crates/holtburger-protocol/src/messages/object/messages/properties.rs:11-33` — the `define_update_property!` macro makes `sequence: u8` the first unpacked field of `UpdatePropertyInt/Int64/Bool/Float/String/DataId/InstanceId` (`:49-56` alias the Private/Public variants). The consumer, `crates/holtburger-world/src/handlers/properties.rs`, applies every update unconditionally — `PrivateUpdatePropertyInt` at `:32-53`, `PublicUpdatePropertyInt` at `:54-69`, and the same shape for the other six types; the word `sequence` does not occur anywhere in the file's 208 lines, and a tree-wide grep for `stamper`/`TimeStamper`/`prop_seq`/`property_stamp` returns nothing.
- **Proposed change:** add a `PropertyStamper { HashMap<(u32 /*stat_type*/, u32 /*property*/), u8> }` on `Entity` (and on `PlayerState`), keyed exactly as retail keys it, with a `u8` wrap-aware "is newer" comparison (the same shape as `is_newer_u16`, mod 256). Gate all fourteen `Update*Property*` arms on it and count rejects in `__diag`. Do **not** extend it to the messages that carry their own object-level sequence — those are already handled at 4c.
- **Payoff:** closes the last hole in retail's three-layer ordering model. Today a retransmitted `PrivateUpdatePropertyInt` can un-do a newer value; with WS/TCP transport that is rare, but the UDP bridge leg is lossy and wave1-B's NET-14 already shows we apply reordered *position* frames as fresh (the same class of bug, one layer up). It is also a prerequisite for trusting any client-side prediction that reads properties.
- **Effort:** M (fourteen call sites, one new struct, wrap-comparison tests).
- **Validation:** unit-test wrap behaviour (`0xFF` then `0x00` is newer; `0x10` then `0x0F` is not) and replay a captured property burst twice, asserting the second pass produces zero `PropertiesUpdated` events. Live: `__diag` counter must stay 0 in a clean session and become non-zero under a forced retransmit.

## ERA-01 — the jump-block motion range is the 2013 window applied to 2015 IDs: 6 of 10 entries are wrong

- **Source §:** doc 13 §5 "Remaining changed functions" — the `CMotionInterp` comparison table. Both builds block `0x40000008`, `0x40000016`-`18`, `0x4000001E`-`39`, `0x41000012`-`14`, `0x1000006F`-`78`; the sixth row is the only one that moved: **11.4186 `0x10000128`–`0x10000131` → 11.6096 `0x1000012B`–`0x10000134`**.
- **Retail (both eras, self-contained):** the blocked window is the ten **purple magic power-up** windups, `MagicPowerUp01Purple`..`MagicPowerUp10Purple`. In the 2013 command table those occupy ordinals `0x128`–`0x131` (verified: `command_strings`/`command_ids_1` indices 296–305 = `0x10000128 MagicPowerUp01Purple` … `0x10000131 MagicPowerUp10Purple`). Three commands were inserted at ordinal `0x10F` in 2015, so the same ten names moved to `0x12B`–`0x134`. `TripleThrustLow/Med/High` sat at `0x125`–`0x127` in 2013 and at `0x128`–`0x12A` in 2015; **retail never blocked jumping during a TripleThrust windup in either build.**
- **holtburger today:** the 2013 numbers, against 2015 data. Two sites:
  - `crates/holtburger-world/src/player/types.rs:66` — `|| matches!(substate, 0x1000_0128..=0x1000_0131)` (fn at `:64-71`), with the doc block at `:48-49` labelling that range "`TripleThrustLow..MagicPowerUp07Purple`" — which is the honest 2015 decode of a 2013 range, i.e. the file documents the bug. Tests pin it: `:446-460` (comment `:446-447` naming PhatSDK `MovementManager.cpp:430`) asserts `0x1000_0128` "TripleThrustLow must block" (`:451`) and `0x1000_0131` "MagicPowerUp07Purple must block" (`:459`).
  - `crates/holtburger-core/src/client/movement/motion_interp.rs:266-270` — `if substate > 0x1000_0131 { substate == 0x4000_0008 } else { (0x1000_0128..=0x1000_0131).contains(&substate) || … }`.
  Era authority for our data: ACE (end-of-retail) has `TripleThrustLow = 0x10000128`, `MagicPowerUp01Purple = 0x1000012b`, `MagicPowerUp10Purple = 0x10000134` (`external/ACE/Source/ACE.Entity/Enum/MotionCommand.cs:304-316`), and holtburger's own generated name table agrees (`crates/holtburger-dat/tests/common/motion_command_names.rs`, and `crates/holtburger-dat/tests/spell_components_table_parity.rs:43` even writes "(Platinum/Dark/Mana). 0x1000012B..0x10000134").
  **Net effect:** we wrongly block jumping during TripleThrustLow/Med/High (`0x128`-`0x12A`) and wrongly allow it during MagicPowerUp08/09/10Purple (`0x132`-`0x134`). Because `jump_charge.rs:142` shares the predicate, the same six errors hit both the charge gate and the jump itself.
- **Proposed change:** replace both ranges with `0x1000_012B..=0x1000_0134` and the `> 0x1000_0131` guard with `> 0x1000_0134`; retarget the two tests to the 2015 names (`0x12B` MagicPowerUp01Purple blocks, `0x134` MagicPowerUp10Purple blocks, `0x128` TripleThrustLow **allows**); add the era comment ERA-05 prescribes. Do this after (or together with) ARCH-01 so it is one edit.
- **Payoff:** correctness on a mechanic players feel — "You can't jump from this position" firing during a thrust combo, and a jump succeeding out of a high-tier war-magic windup that retail forbids. It is also the only physics behaviour that changed between the two retail builds, so getting it wrong is getting the *entire* 2013→2015 physics delta wrong.
- **Effort:** S.
- **Validation:** unit tests as above (they already exist in the right shape, only the constants and names change). Live: headless with a two-handed weapon, start a TripleThrust and press jump — must jump; cast a level-8 war spell and press jump during the windup — must refuse with WD_Error 72.

## ERA-02 — 2015's two new jump-blocking motions (`Sanctuary`, `AI_TelegraphCast`) are absent

- **Source §:** doc 13 §5 — "Its two *semantic* additions are that jumping is now also blocked during `Sanctuary` (`0x10000057`) and `AI_TelegraphCast` (`0x1000019B`), and that `jump_charge_is_allowed` and `charge_jump` each gained `Sanctuary` as well."
- **Retail:** `Sanctuary` is the lifestone-bind animation; `AI_TelegraphCast` is the 2015-added telegraph windup. In 11.6096 neither permits a jump, and `Sanctuary` additionally blocks *charging* a jump.
- **holtburger today:** ABSENT from both predicates. Neither `0x1000_0057` nor `0x1000_019B` appears in `crates/holtburger-world/src/player/types.rs:64-71` or `crates/holtburger-core/src/client/movement/motion_interp.rs:261-277`. The IDs are not unknown to the tree — `Sanctuary` is in the generated name table (`crates/holtburger-dat/tests/common/motion_command_names.rs:138`, `0x10000057`) and drives the lifestone flow (`apps/holtburger-web/plugins/lifestone-popup.js:13-18`); `0x1000019B` is present but misnamed (ERA-03).
- **Proposed change:** add both as exact matches beside `0x4000_0008`. Note the one asymmetry to record in the comment: retail added `Sanctuary` to all three functions but `AI_TelegraphCast` only to `motion_allows_jump`. Since holtburger routes charge and jump through one predicate, adding both over-applies `AI_TelegraphCast` to the charge gate — harmless (it is a monster-only motion the local player never enters) but it should be written down rather than discovered later.
- **Payoff:** you can currently jump out of the lifestone bind animation. Small, visible, and free once ERA-01 is open in the same function.
- **Effort:** S.
- **Validation:** unit test both IDs block; live check by binding at a lifestone and pressing jump during the animation.

## ERA-03 — the generated MotionCommand name table carries five 2013 IDs and three stale names

- **Source §:** doc 13 §5 `string2command` table + §6 footnote 6d.
- **Retail (2015):** ordinals `0x10F`/`0x110`/`0x111` are the three inserted commands `SkillHealOther` (`0x1000010F`), `CombatEat` (`0x10000110`), `CombatDrink` (`0x10000111`). The six target-cycling commands that used to sit at `0x10F`–`0x114` moved to `0x112`–`0x117`: `NextMonster 0x09000112`, `PreviousMonster 0x09000113`, `ClosestMonster 0x09000114`, `NextPlayer 0x09000115`, `PreviousPlayer 0x09000116`, `ClosestPlayer 0x09000117`.
- **holtburger today:** `crates/holtburger-dat/tests/common/motion_command_names.rs` is auto-generated from `Chorizite.Common/Enums/MotionCommand.cs` (recipe in its own header, `:1-19`), and inherits that file's inconsistency verbatim:
  - `:83` `(0x9000110, "PreviousMonster")` and `:84` `(0x9000111, "ClosestMonster")` — **IDs that do not exist in the 2015 client at all** (in 2015 those ordinals belong to class `0x10`).
  - `:85` `(0x9000112, "NextPlayer")`, `:86` `(0x9000113, "PreviousPlayer")`, `:87` `(0x9000114, "ClosestPlayer")` — right IDs, **wrong names**; those are 2015's `NextMonster`, `PreviousMonster`, `ClosestMonster`.
  - `NextMonster` is absent from the table entirely, as are `CombatEat 0x10000110`, `CombatDrink 0x10000111`, and the real `NextPlayer 0x09000115` / `PreviousPlayer 0x09000116` / `ClosestPlayer 0x09000117`.
  - `:258` `(0x1000019b, "WoahDuplicate2")` — right ID, wrong name; it is `AI_TelegraphCast`. Upstream even documents the guess: "Appears to be the same as Motion_Woah except it starts with 0x10" (`ACE.Entity/Enum/MotionCommand.cs:419`).
  - `:102` `(0x9000161, "SideBySideVitals")` — right ID, stale name; the 2015 slot is `StretchUI`.
  Upstream ACE carries the same five-row block (`MotionCommand.cs:283-287`) with `NextMonster` commented out at its 2013 value (`:282`) and `CombatEat`/`CombatDrink` commented out as "MimeDrinkDuplicate1/2" (`:280-281`) — so ACE knows something is off and guessed wrong.
  **Scope:** this file is test-only (`#![allow(dead_code)]`, lives under `tests/common/`). No production behaviour depends on it; a tree-wide sweep found **no** production consumer of any of the five wrong IDs.
- **Proposed change:** stop regenerating from `Chorizite.Common` for the `0x10B`–`0x117` window and hand-patch those rows from the derived 2015 table, with a comment naming this document and the +3 rule. Add the four missing IDs. Rename `WoahDuplicate2` → `AI_TelegraphCast` and `SideBySideVitals` → `StretchUI` (keeping the old name as a comment, because that is how the DAT-era reader will find it). File the same corrections upstream to Chorizite.Common if we care to.
- **Payoff:** every motion-table inspection probe currently prints wrong names for five ordinals and drops three real commands. That is exactly the kind of diagnostic error that sends the next agent chasing a phantom (this is a VERIFICATION-LOG failure mode, one layer down).
- **Effort:** S.
- **Validation:** a unit test asserting the table is injective, contains `0x09000112 → NextMonster`, `0x10000110 → CombatEat`, `0x10000111 → CombatDrink`, `0x1000019B → AI_TelegraphCast`, and contains **no** entry for `0x09000110`/`0x09000111`.

## ERA-04 — `Chorizite.ACProtocol`'s `Command` enum is pure 2013 and is wired to a wire type; guard against porting it

- **Source §:** doc 13 §5 blockquote ("any tool that hardcodes a command ID with ordinal `0x10F` or higher … will be wrong by three against the 2015 client") + §6 footnote 6d.
- **Retail:** the 2015 client's command table is the +3-shifted one; anything decoding `PackedMotionCommand.CommandId` off an end-of-retail server/DAT must use the 2015 numbering.
- **Upstream today (verified):** `external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Enums/Command.generated.cs` is the **2013** table, ordinal-for-ordinal — `Sanctuary = 0x57` (`:192`), `SkillHealSelf = 0x10E` (`:558`), `TripleThrustLow = 0x125` (`:604`), `MagicPowerUp01Purple = 0x128` (`:610`), `MagicPowerUp10Purple = 0x131` (`:628`), `AtlatlCombat = 0x138` (`:642`), `ThrownShieldCombat = 0x139` (`:644`), `SideBySideVitals = 0x15E` (`:718`), last entry `OffhandPunchSlowLow = 0x197` (`:832`) — i.e. bound `0x198`, exactly the 2013 `string2command` bound. It is **not inert**: `protocol.xml:6410-6411` types `PackedMotionCommand.CommandId` as `Command`, so chorizite decodes live motion commands with 2013 names. `Chorizite/Chorizite.NativeClientBootstrapper/AcClient/_AcClient.cs:833,839` is likewise 2013 (`NextMonster = 0x0900010F`, `SnowAngelState = 0x43000115`).
- **holtburger today:** **not ported — and this is the good news.** There is no `Command` enum anywhere in `crates/` or `apps/` (grep for `pub enum Command`/`Command::` finds only `std::process::Command` in a test at `crates/holtburger-dat/tests/resolve_sound_parity.rs:167` and the unrelated `MovementCommand`/`InterpretedMotionCommand` types). holtburger's motion IDs come from ACE/Chorizite.**Common** (2015) and from the DATs, not from ACProtocol's `Command`.
- **Proposed change:** no code change; add a guard so this stays true. One test in `holtburger-protocol` that asserts a handful of era-discriminating values (`AtlatlCombat == 0x8000013B`, `TripleThrustLow`-as-range-bound, `SkillHealOther == 0x1000010F` present) and a one-paragraph note in the protocol crate's docs saying ACProtocol's `Command` enum is 2013-era and must not be ported wholesale. Also worth a note in the deep-dive pack README.
- **Payoff:** prevents a whole-namespace regression. Our opcode tables *were* ported from ACProtocol (that is stated in the wave prompt and visible in `data/chorizite/chorizite-acprotocol-opcodes.json`), so the next person porting "the missing enum from chorizite" would import 136 wrong constants in one commit.
- **Effort:** S.
- **Validation:** the test itself.

## ERA-05 — pin the `0x10F` boundary with a regression test, not a comment

- **Source §:** doc 13 §5 blockquote + §6 footnote 6d; CMB-11's "comment only" recommendation.
- **Retail:** the boundary is ordinal `0x10F`. Below it, 2013 == 2015. At or above it, 2015 == 2013 + 3 (with one repurposed slot and one appended command).
- **holtburger today:** CMB-11 proposed a source comment at `movement/types.rs:91-92`; that comment does not yet exist (the lines carry only the enum values). Nothing anywhere in the tree states the rule, and 195 name/ID pairs across 12 files silently depend on it (see §3).
- **Proposed change:** one small module — `crates/holtburger-protocol/tests/command_era_parity.rs` — containing (a) the rule as a doc comment with this document's path, (b) a table of ~15 era-discriminating pairs drawn from §3 below, (c) assertions that our constants equal the **2015** value and are **not** the 2013 value. Add the CMB-11 comment at `movement/types.rs:91-92` pointing at that test.
- **Payoff:** the failure mode this defends against has already happened twice in this project — once as a false-positive bug report on `AtlatlCombat` (CMB-11, caught) and once as a real bug in the jump range (ERA-01, not caught). A test turns "read the mining doc first" into a build failure.
- **Effort:** S.
- **Validation:** flip one constant to its 2013 value and confirm the test fails.

## D15-01 — `CharacterOptions2::DEFAULT` is retail's **2013** constant `0x00948700`

- **Source §:** doc 13 §5 "Chat, filtering and social lists" — "**It defaults to on.** Both `PlayerModule::PlayerModule` and `PlayerModule::UnPack` initialise `options2_` to `0x00948700` in 11.4186 and `0x02948700` in 11.6096 — that single bit is the only difference in either function. The constant `0x00948700` occurs exactly twice in the 2013 image and zero times in the 2015 image, and `0x02948700` exactly the reverse."
- **Retail:** a fresh character hears PK death messages unless they turn the option off.
- **holtburger today:** `crates/holtburger-common/src/character.rs:92-98` — `DEFAULT = HEAR_GENERAL_CHAT | HEAR_TRADE_CHAT | HEAR_LFG_CHAT | LEAD_MISSILE_TARGETS | CONFIRM_VOLATILE_RARE_USE | SHOW_HELM | SHOW_CLOAK`. Summing the declared bits (`:64`, `:65`, `:66`, `:72`, `:76`, `:78`, `:81`) gives `0x100 + 0x200 + 0x400 + 0x8000 + 0x40000 + 0x100000 + 0x800000` = **`0x00948700`** — the 2013 value exactly, missing only `HEAR_PK_DEATH = 0x02000000` (`:85`). Consumer: the `CharacterOption::CharacterOptions2Default` → mask mapping at `crates/holtburger-world/src/player/types.rs:1272-1274` (retail's "restore defaults" pseudo-option `0x36`).
- **Proposed change:** add `| Self::HEAR_PK_DEATH.bits()` and a comment recording both constants and their era. While there, sanity-check `CharacterOptions1::DEFAULT` (`:41`) against retail's `options_` initialiser the same way.
- **Payoff:** exact retail-2015 parity on a one-line constant, and it removes a live trap: the value *looks* researched (it is, for the wrong build). Note the practical blast radius is small — `PlayerState::new()` seeds `empty()` and `hydrate_from_player_description` overwrites from the server (VERIFICATION-LOG's OBJ-20), so this only bites a client-side "restore defaults" or a client-minted character.
- **Effort:** S.
- **Validation:** `assert_eq!(CharacterOptions2::DEFAULT.bits(), 0x0294_8700)`.

## D15-02 — the `[PKDe]` chat tag is neither stripped nor filtered

- **Source §:** doc 13 §5 — `Handle_Communication__TextboxString` "now searches the incoming string for the literal `[PKDe]`. If present and the new 'Hear PK Deaths' option is **off**, the message is dropped entirely; if on, the tag is stripped and the message falls through to the unchanged squelch/display path."
- **Retail:** the server marks PK-death broadcasts with an inline `[PKDe]` sentinel; the client is responsible for both the filter and the tag removal, so a client that ignores it shows the raw marker.
- **holtburger today:** ABSENT — grep for `PKDe` across `crates` and `apps` returns only the option plumbing (`character.rs:170`, `ui.rs:357`, `player/types.rs:1266`) and the chorizite enum dump; no chat handler inspects message text for it. **Dormant against our server:** a grep over `external/ACE/Source` finds `IsPKDeath()` predicates (`Player_Combat.cs:707-712`, `Creature_Death.cs:565`) but never the literal `[PKDe]`, so vanilla ACE does not emit the tag today.
- **Proposed change:** implement it once, in the TextboxString handler, keyed off `CharacterOptions2::HEAR_PK_DEATH`: strip-and-show when set, drop when clear. Cheap, and it is the correct behaviour the moment either ACE adds the tag or we connect to anything retail-derived.
- **Payoff:** small but exact; the alternative failure (players seeing `[PKDe]` in their chat log) is embarrassing and trivially avoidable.
- **Effort:** S.
- **Validation:** unit-test both option states against a tagged string; live check only becomes possible if ACE emits the tag (open question).

## D15-03 — there is no `IsMessageSafe` at all: no 256-char cap, no `<tell:` guard, no newline guard

- **Source §:** doc 13 §5 — "`ClientCommunicationSystem::IsMessageSafe`: **new length gate as the first statement:** `if (len > 0x100) return 0`. Any outgoing chat message of 256 characters or more is now classified unsafe and silently dropped. The existing `<tell:` and newline injection checks are unchanged."
- **Retail:** outgoing chat passes a client-side safety filter — reject if ≥ 256 characters (2015), reject if it contains a `<tell:` construct or embedded newlines (both builds). The check lives in the callee, so every caller inherits it.
- **holtburger today:** ABSENT. `SessionHandle::send_chat` (`apps/holtburger-web/src/lib.rs:33132-33144`) validates only `message.is_empty()` before enqueueing `SessionCommand::SendChat`; the eventual send arm (`crates/holtburger-core/src/client/commands.rs:270-277`, `ClientCommand::Talk`) checks only `ClientState::InWorld`. Nothing anywhere caps length or scans for injection markers (grep for `is_message_safe`/`message_safe`/`<tell:` in `crates` and `apps` is empty).
- **Proposed change:** one `fn is_message_safe(&str) -> bool` in `holtburger-core`, called from the `Talk`/`Tell` send arms (the callee-side placement retail uses, so future callers inherit it), implementing all three checks with the retail cite. Surface a local refusal message rather than dropping silently — retail drops silently, but silence here would be indistinguishable from a netcode bug, and we have a chat log to say so in.
- **Payoff:** ACE will reject or truncate an over-long Talk anyway; doing it client-side saves the round trip and, more importantly, closes the `<tell:` injection surface, which is a real spoofing vector in AC's chat markup (that is why retail checks it).
- **Effort:** S.
- **Validation:** unit tests for the 255/256 boundary, a `<tell:` payload and an embedded `\n`; live check that a 300-char paste produces a local refusal and zero `GameAction::Talk` frames in the capture.

## D15-04 — Emote type and category maxima are the 2013 bounds, and a test pins them there

- **Source §:** doc 13 §5 "The rest" — `Emote::{IsValid,Pack,UnPack,pack_size}`: the emote type enum grows from `1–0x79 (121)` to `1–0x7F (127)`, six new types reusing existing payload shapes (string-only, string + two dwords, header-only), struct layout unchanged; `EmoteSet::{Pack,UnPack,pack_size}`: category maximum `0x26 (38) → 0x27 (39)`, the new category packing the existing `style`/`substyle` dword pair with no new field.
- **Retail:** the 2015 client accepts and round-trips emote types up to `0x7F` and emote-set categories up to `0x27`. The six new type numbers are unnamed in the binary (the added strings `AI_TelegraphCast`, `CombatDrink`, `CombatEat`, `SkillHealOther` are what the Emote serialisation changes *carry*).
- **holtburger today:** the 2013 bounds, deliberately pinned. `crates/holtburger-common/src/properties/emote.rs:280` ends the type enum at `InqContractsFull = 0x79`, and `:407` asserts `EmoteType::from_repr(0x7A) == None`; the category enum ends at `ReceiveTalkDirect = 0x26` (`:89`). ACE is at the same bounds (`ACE.Entity/Enum/EmoteType.cs:130` `InqContractsFull = 121`; `EmoteCategory.cs:50` `ReceiveTalkDirect = 38`).
- **Proposed change:** low priority and **explicitly optional**. Since ACE never emits `0x7A`–`0x7F` or category `0x27`, nothing breaks today. The defensible change is narrow: make the *unpacker* tolerate `0x7A`–`0x7F` and category `0x27` as `Unknown(u32)` rather than a hard `None`, so a retail-era emote table (e.g. ingested weenie data or a future ACE that tracks retail) does not fail a whole parse on an unnamed type, and relax the `:407` assertion to test `0x80` instead. Do **not** invent names for the six types — the binary does not name them.
- **Payoff:** removes a hard failure edge on data we may well ingest (LSD weenies, retail-derived emote tables), at the cost of three lines. The test at `:407` is the thing to fix regardless: as written it asserts a 2013 fact as though it were permanent.
- **Effort:** S.
- **Validation:** round-trip an emote with type `0x7C` and a set with category `0x27` through pack/unpack and assert no data loss.

## D15-05 — GameEvent `0x0317` / `0x0318` are unmapped

- **Source §:** doc 13 §5 "Two new network opcodes" — `UIQueueManager::ProcessNetBlobData` dispatches 164 IDs, up from 162; `0x317` and `0x318` added, nothing removed; pivot `cmp edx,0x276 → 0x27A`; new 160-byte dispatchers at `0x006A56F0` → `Handle_Communication__TransientString` and `0x006A5790` → `Handle_Communication__PopUpString`, **both target handlers byte-identical to 11.4186** — new plumbing into existing display paths, not a new message format. Confirmed by `cmp eax,0x317` occurring exactly once in 11.6096 and zero times in 11.4186.
- **Retail:** two additional server→client event IDs that render a single string payload through the pre-existing transient-string and pop-up-string display paths.
- **holtburger today:** ABSENT everywhere. `crates/holtburger-protocol/src/opcodes.rs:835` has `CommunicationTransientString = 0x02EB` and no `0x03xx` entry for either; `Communication_PopUpString` exists only as `0x0004` in the vendored chorizite dump (`apps/holtburger-web/data/chorizite/chorizite-acprotocol-opcodes.json:277`); chorizite's generated `GameEventType` has only `0x02EB` (`Enums/GameEventType.generated.cs:210`); ACE has neither ID.
- **Proposed change:** add `CommunicationTransientString2 = 0x0317` and `CommunicationPopUpString2 = 0x0318` (names flagged as our own, since the binary names only the handlers) with the same payload struct as their existing counterparts, routed to the same handlers. Guard with a comment: these are 2015-only and unused by ACE, so they are compatibility surface, not a feature.
- **Payoff:** two-line completeness on the *entire* protocol delta between the two retail builds. Also removes a future "unknown GameEvent" log line if ACE ever tracks retail here. Doc 13 §7 is careful to say the enumeration only covered 2013-side functions, so treat this as "the two known new opcodes", not "all of them".
- **Effort:** S.
- **Validation:** unpack a synthetic `0x0317` frame and assert it produces the same `GameEvent` shape as `0x02EB`.

## D15-06 — the gear-rating appraisal block is absent, including 2015's four new ratings

- **Source §:** doc 13 §5 "Two new combat ratings" — `ItemExamineUI::Appraisal_ShowRatings` goes from ten gear ratings to fourteen, adding `"PK Dam %d"`, `"PK Dam Resist %d"`, `"Overpower% %d"`, `"Overpower Reduction% %d"` between Crit Dam Resist and Heal Boost; `CreatureExamineUI::SetAppraiseInfo` goes from nine properties to thirteen; `CharExamineUI::SetAppraiseInfo` adds the same four. The extracted immediates are given verbatim: `ShowRatings` 2013 `172…17B` → 2015 `+17F +180 +184 +185`; `CreatureExamineUI` 2013 `133 134 139 13A 13B 13C 143 15E 15F` → 2015 `+17D +17E +182 +183`.
- **Retail:** appraising an item lists every non-zero gear rating as its own line; appraising a creature or your own character lists the character-side ratings.
- **holtburger today:** the property IDs all exist (`crates/holtburger-common/src/properties/property_keys/ints.rs:389-397`) and **nothing renders them**. A sweep of `apps/holtburger-web/plugins/*.js` and `ui/*.js` for `DamageRating`/`CritRating`/`HealingBoostRating`/`NetherResistRating`/`LifeResistRating` finds no appraisal renderer at all; the only rating-shaped code is `ui/ac_damage_rating.js` (header `:1-46`), a *predictor* for outgoing Damage Rating from Recklessness/Sneak Attack/weapon `DamageMod`, which explicitly scopes armour ratings out ("Out of scope for now: per-armor PropertyInt `Damage_Resist_Rating`"), consumed by `plugins/combat-hud.js:493-577` and `plugins/sneak-hud.js:154`.
- **Proposed change:** add a rating block to the appraisal panel driven off a single ordered table of `(PropertyInt, format string)` pairs in retail's order — the ten 2013 ratings **and** the four 2015 ones, inserted exactly where doc 13 says (between Crit Dam Resist and Heal Boost), skipping zero/absent values as retail does. Then wire the character-side four into the creature/character panels. Retail's own insertion order is the spec; the immediates above give it unambiguously.
- **Payoff:** gear ratings are how end-game items are evaluated; today an item's ratings are invisible even though every value is already on the wire and in our property table. Scope note: ten of the fourteen belong to the 2013 report (wave1-A's OBJ-03..OBJ-07 appraisal cluster), so land this **with** that cluster rather than as a separate panel.
- **Effort:** M (S for the four new rows if the block already existed — it does not).
- **Validation:** appraise a known ACE item with non-zero `GearDamageRating` and diff the rendered lines against a `worldbuilder-terminal` `ace-*` DB probe of the same weenie; assert PK/Overpower rows appear only when non-zero.

---

# 3. ERA-CHECK REGISTER

**Verdict, stated once: our codebase carries 2015 / end-of-retail command ordinals.**
Measured, not asserted — I classified every `(name, value)` pair in the holtburger
tree against both derived tables. Of the pairs that discriminate between eras,
**195 match 2015 and 5 match 2013**, and all five 2013 hits are in a single
test-only file. The two production defects are *not* name/ID pairs at all — they
are a raw numeric **range** (`0x128..=0x131`) that was copied from a 2013-era
source and never re-based, which is exactly why a name-based audit would have
missed them.

**Which upstream encodes which era:**

| Upstream | Era | Evidence |
|---|---|---|
| **`Chorizite.ACProtocol/Enums/Command.generated.cs`** | **2013** | `SkillHealSelf 0x10E` (`:558`), `TripleThrustLow 0x125` (`:604`), `MagicPowerUp01Purple 0x128` (`:610`), `AtlatlCombat 0x138` (`:642`), `SideBySideVitals 0x15E` (`:718`), last entry `0x197` (`:832`) ⇒ bound `0x198`. Wired to `PackedMotionCommand.CommandId` (`protocol.xml:6410-6411`). **Not ported into holtburger** — see ERA-04. |
| `Chorizite.Common/Enums/MotionCommand.cs` | **2015**, with a 5-row 2013 island | `SkillHealOther 0x1000010f` (`:279`), `SnowAngelState 0x43000118` (`:288`) are 2015; `:283-287` (`PreviousMonster`..`ClosestPlayer`) are 2013. This is holtburger's generated table's source ⇒ ERA-03. |
| `Chorizite/…/AcClient/_AcClient.cs` | **2013** | `NextMonster 0x0900010F` (`:833`), `SnowAngelState 0x43000115` (`:839`). Unused by holtburger. |
| vanilla ACE `ACE.Entity/Enum/MotionCommand.cs` | **2015**, same 5-row island | `SkillHealOther 0x1000010f` (`:279`), `TripleThrustLow 0x10000128` (`:304`), `MagicPowerUp10Purple 0x10000134` (`:316`); island at `:283-287`; `NextMonster` commented out at its 2013 value (`:282`); `CombatEat`/`CombatDrink` commented out as "MimeDrink" duplicates (`:280-281`). |
| shipped `~/ac_base_dats/client_portal.dat` | **2015 (EoR)** | Established by wave1-B's CMB-11 via MotionTable `0x09000001` resolving `AtlatlCombat`/`ThrownShieldCombat` at `0x8000013b`/`0x8000013c`. |
| **holtburger** | **2015** | 195 discriminating pairs, 12 files; see below. |

**⚠ Two namespaces share the `0x10` class byte and only one of them shifted.**
`ClientAction` (retail's UI input-action IDs: `ToggleCasPanel 0x10000001` …
`PlayerOption_HearPKDeaths 0x1000013F`) is a **different** enumeration from the
408-entry command table, and it did **not** shift. Both exist in the 2013 PDB at
overlapping values — `0x1000010E` carries *both* `Motion_SkillHealSelf` and
`PlayerOption_HearGeneralChat`; `0x1000004A` carries both `Motion_Hop` and
`UseQuickSlot_9`. Do **not** "correct" a `ClientAction` value by +3.

## 3.1 Command namespace (`0x09xxxxxx` action + `0x10xxxxxx`/`0x13`/`0x40`/`0x41`/`0x43`/`0x80` motion) — the shifted one

Ordinals below `0x10F` are era-identical and omitted except where a doc or task
depends on them.

| # | Command (ordinal) | 2013 (11.4186) | 2015 / EoR | holtburger — verified `file:line` | Verdict |
|---|---|---|---|---|---|
| 1 | `SkillHealSelf` (`0x10E`) | `0x1000010E` | `0x1000010E` (unshifted) | `motion_command_names.rs:186`; `player/types.rs:279` | **correct** (era-identical) |
| 2 | `SkillHealOther` (`0x10F`) | — (new in 2015) | `0x1000010F` | `motion_command_names.rs:187`; `player/types.rs:856-857`, `:947` | **correct (2015)** |
| 3 | `CombatEat` (`0x110`) | — (new) | `0x10000110` | **ABSENT** (grep `CombatEat` across `crates`+`apps`: no hits) | needs adding — ERA-03 |
| 4 | `CombatDrink` (`0x111`) | — (new) | `0x10000111` | **ABSENT** | needs adding — ERA-03 |
| 5 | `NextMonster` (`0x10F`→`0x112`) | `0x0900010F` | `0x09000112` | **ABSENT as an ID**; `0x9000112` is named `NextPlayer` at `motion_command_names.rs:85` | **wrong (test-only)** — ERA-03 |
| 6 | `PreviousMonster` (`0x110`→`0x113`) | `0x09000110` | `0x09000113` | `motion_command_names.rs:83` = `0x9000110` | **wrong (2013, test-only)** |
| 7 | `ClosestMonster` (`0x111`→`0x114`) | `0x09000111` | `0x09000114` | `motion_command_names.rs:84` = `0x9000111` | **wrong (2013, test-only)** |
| 8 | `NextPlayer` (`0x112`→`0x115`) | `0x09000112` | `0x09000115` | `motion_command_names.rs:85` = `0x9000112` | **wrong (2013, test-only)** |
| 9 | `PreviousPlayer` (`0x113`→`0x116`) | `0x09000113` | `0x09000116` | `motion_command_names.rs:86` = `0x9000113` | **wrong (2013, test-only)** |
| 10 | `ClosestPlayer` (`0x114`→`0x117`) | `0x09000114` | `0x09000117` | `motion_command_names.rs:87` = `0x9000114` | **wrong (2013, test-only)** |
| 11 | `SnowAngelState` (`0x115`→`0x118`) | `0x43000115` | `0x43000118` | `soul_emote_motion.rs:81` = `0x0118`; `wave_8_motion_inventory.rs:159` = `0x4300_0118`; `scene3d/entities.js:1764` comment | **correct (2015)** |
| 12 | `WarmHands` (`0x116`→`0x119`) | `0x13000116` | `0x13000119` | `soul_emote_motion.rs:88` = `0x0119`; `wave_8_motion_inventory.rs:109` | **correct (2015)** |
| 13 | `CurtseyState` (`0x117`→`0x11A`) | `0x43000117` | `0x4300011A` | `soul_emote_motion.rs:37` = `0x011A` | **correct (2015)** |
| 14 | `AFKState` (`0x118`→`0x11B`) | `0x43000118` | `0x4300011B` | `soul_emote_motion.rs:23` = `0x011B` | **correct (2015)** |
| 15 | `MeditateState` (`0x119`→`0x11C`) | `0x43000119` | `0x4300011C` | `soul_emote_motion.rs:48` = `0x011C` | **correct (2015)** |
| 16 | `TradePanel` (`0x11A`→`0x11D`) | `0x0900011A` | `0x0900011D` | `motion_command_names.rs:88` | **correct (2015)** |
| 17 | `LogOut` (`0x11B`→`0x11E`) | `0x1000011B` | `0x1000011E` | `player/types.rs:143-151` + test `:781-786`; `wave_8_motion_inventory.rs:203` | **correct (2015)** |
| 18 | `DoubleSlashLow` (`0x11C`→`0x11F`) | `0x1000011C` | `0x1000011F` | `player/types.rs:793` | **correct (2015)** |
| 19 | `TripleThrustLow` (`0x125`→`0x128`) | `0x10000125` | `0x10000128` | referenced as a *range bound* in `player/types.rs:66` and `motion_interp.rs:269`; named in `player/types.rs:48` | value correct, **misused** — ERA-01 |
| 20 | `MagicPowerUp01Purple` (`0x128`→`0x12B`) | `0x10000128` | `0x1000012B` | jump-block range **starts at `0x128`** (`player/types.rs:66`, `motion_interp.rs:269`) | **WRONG — 2013 range on 2015 IDs (ERA-01)** |
| 21 | `MagicPowerUp07Purple` (`0x12E`→`0x131`) | `0x1000012E` | `0x10000131` | range **ends at `0x131`** (same two lines); named in `player/types.rs:48` | **WRONG (ERA-01)** |
| 22 | `MagicPowerUp08/09/10Purple` (`0x12F`-`0x131`→`0x132`-`0x134`) | `0x1000012F`-`31` | `0x10000132`-`34` | **outside** the blocked range and outside the `> 0x1000_0131` guard | **WRONG — retail 2015 blocks these (ERA-01)** |
| 23 | `Pickup5`..`Pickup20` (`0x133`-`0x136`→`0x136`-`0x139`) | `0x40000133`-`36` | `0x40000136`-`39` | `wave_8_motion_inventory.rs:190-193` | **correct (2015)** |
| 24 | `HouseRecall` (`0x137`→`0x13A`) | `0x10000137` | `0x1000013A` | `player/types.rs:285`, `:859` | **correct (2015)** |
| 25 | `AtlatlCombat` (`0x138`→`0x13B`) | `0x80000138` | `0x8000013B` | `messages/movement/types.rs:91`; `examples/dump_cmt_ranged_rows.rs:26`; JS whitelists `index.html:2964-2973`, `plugins/combat-bar.js:471-473`, `plugins/combat-hud.js:453-455` | **correct (2015)** — CMB-11; **do not "fix"** |
| 26 | `ThrownShieldCombat` (`0x139`→`0x13C`) | `0x80000139` | `0x8000013C` | `messages/movement/types.rs:92` + same three JS sites | **correct (2015)** |
| 27 | `SitState`/`SitCrossleggedState`/`SitBackState` (`0x13A`-`0x13C`→`0x13D`-`0x13F`) | `0x4300013A`-`3C` | `0x4300013D`-`3F` | `soul_emote_motion.rs:76-78` | **correct (2015)** |
| 28 | `PointLeftState`..`AtEaseState` (`0x13D`-`0x146`→`0x140`-`0x149`) | `0x4300013D`-`46` | `0x43000140`-`49` | `soul_emote_motion.rs:25`, `:39`, `:41`, `:57`, `:59`, `:61`, `:63`, `:65`, `:84`, `:87`; `wave_8_motion_inventory.rs:166-175` | **correct (2015)** |
| 29 | `NudgeLeft`/`NudgeRight`/`PointLeft`/`PointRight`/`PointDown`/`Knock`/`ScanHorizon`/`DrudgeDance`/`HaveASeat` (`0x147`-`0x14F`→`0x14A`-`0x152`) | `0x13000147`-`4F` | `0x1300014A`-`52` | `soul_emote_motion.rs:38`, `:40`, `:45`, `:53`, `:54`, `:56`, `:58`, `:60`, `:67`; `wave_8_motion_inventory.rs:112-117` | **correct (2015)** |
| 30 | `LifestoneRecall` (`0x150`→`0x153`) | `0x10000150` | `0x10000153` | `player/types.rs:295`, `:873` | **correct (2015)** |
| 31 | `CharacterOptionsPanel`..`VitaePanel` (`0x151`-`0x157`→`0x154`-`0x15A`) | `0x09000151`-`57` | `0x09000154`-`5A` | `motion_command_names.rs:89-95` | **correct (2015)** |
| 32 | `SideBySideVitals` → `StretchUI` (`0x15E`→`0x161`) | `0x0900015E` `SideBySideVitals` | `0x09000161` **`StretchUI`** (slot repurposed) | `motion_command_names.rs:102` = `0x9000161` named `"SideBySideVitals"` | value **correct (2015)**, **name stale** — ERA-03 |
| 33 | `Fishing`/`MarketplaceRecall`/`EnterPKLite` (`0x162`-`0x164`→`0x165`-`0x167`) | `0x10000162`-`64` | `0x10000165`-`67` | `player/types.rs:299-300` | **correct (2015)** |
| 34 | `AllegianceChat`..`IssueSlashCommand` (`0x165`-`0x16D`→`0x168`-`0x170`) | `0x09000165`-`6D` | `0x09000168`-`70` | `motion_command_names.rs:106-114` | **correct (2015)** |
| 35 | `OffhandSlashHigh`..`PunchSlowLow` (`0x171`-`0x194` region) | 2013 `0x16E`-`0x191` | 2015 `0x171`-`0x194` | `player/types.rs:306-311` (documents the 2015 block as contiguous class `0x10`) | **correct (2015)** |
| 36 | `AI_TelegraphCast` (`0x19B`) | — (new in 2015) | `0x1000019B` | `motion_command_names.rs:258` = `0x1000019b` named **`"WoahDuplicate2"`** | value **correct (2015)**, **name wrong** — ERA-03; and **absent from the jump gate** — ERA-02 |
| 37 | `Sanctuary` (`0x057`) | `0x10000057` | `0x10000057` (era-identical) | `motion_command_names.rs:138`; used by `plugins/lifestone-popup.js:13-18` | value **correct**; **missing from the jump gate** — ERA-02 |
| 38 | `MagicPowerUp01`..`10` (`0x06F`-`0x078`) | `0x1000006F`-`78` | same (below the boundary) | `player/types.rs:469`, `motion_interp.rs:270` | **correct** (no era exposure) |
| 39 | Motion **stances** `0x8000003C`-`0x80000049`, `0x800000E8/E9` | same | same | `messages/movement/types.rs:73-90` | **correct** — all below `0x10F`, no era exposure |
| 40 | `Ready 0x41000003`, `WalkForward 0x45000005`, `RunForward 0x44000007`, `Crouch/Sitting/Sleeping 0x41000012`-`14`, `Fallen 0x40000008`, `Reload/Unload/Pickup 0x40000016`-`18`, `AimLevel..MagicPray 0x4000001E`-`39` | same | same | `motion_interp.rs:261-277`; `player/types.rs:64-71`; `jump_charge.rs:119` | **correct** (below boundary) |

## 3.2 `ClientAction` namespace — NOT shifted, and 2015-complete

| # | Constant | 2013 (PDB `S_CONSTANT`) | 2015 | holtburger | Verdict |
|---|---|---|---|---|---|
| 41 | `PlayerOption_HearGeneralChat` | `0x1000010E` (coexists with `Motion_SkillHealSelf` at the same value) | unchanged | `properties/ui.rs:311` | **correct — do not shift** |
| 42 | `PlayerOption_HearTradeChat` | `0x1000010F` | unchanged | `properties/ui.rs:312` | **correct — do not shift** (numerically collides with `SkillHealOther`; different namespace) |
| 43 | `PlayerOption_SideBySideVitals` | `0x1000013E` (present in the 2013 PDB) | unchanged | `properties/ui.rs:356` | **correct** |
| 44 | `PlayerOption_HearPKDeaths` | **absent from the 2013 image** | `0x1000013F` (the one new `OnAction` case) | `properties/ui.rs:357`, pinned by tests `:458`, `:462` | **correct (2015)** — strongest single era proof for this namespace |
| 45 | Doc comment "outliers (`0x10000102..0x10000139`)" | — | — | `properties/ui.rs:49` | stale comment — the range now reaches `0x1000013F`; fold into ERA-05 |

## 3.3 Non-command constants that the 2015 patch touched

| # | Constant | 2013 | 2015 / EoR | holtburger | Verdict |
|---|---|---|---|---|---|
| 46 | `Enlightenment` PropertyInt | absent | `0x186` (390) | `property_keys/ints.rs:398` = 390 | **correct (2015)** |
| 47 | PK Damage ratings | absent | `0x17D`/`0x17E` char, `0x17F`/`0x180` gear | `ints.rs:389-392` = 381-384 | **correct (2015)** |
| 48 | Overpower ratings | absent | `0x182`/`0x183` char, `0x184`/`0x185` gear | `ints.rs:394-397` = 386-389 | **correct (2015)** |
| 49 | `AttackConditions` Overpower bit | absent as a tested bit | `0x8` | `messages/combat/types.rs:34` (declared, never rendered) | value **correct**; render gap = CMB-05 |
| 50 | Option index for Hear-PK-Deaths | n/a (52 options, `0x00`-`0x33`) | `0x34` (53 options) | `character.rs:170` = `0x34` | **correct (2015)** |
| 51 | `options2` Hear-PK-Deaths bit | n/a | bit 25, `0x02000000` | `character.rs:85` | **correct (2015)** |
| 52 | `options2` **default** | `0x00948700` | `0x02948700` | `character.rs:92-98` sums to `0x00948700` | **WRONG — 2013 constant (D15-01)** |
| 53 | `Emote` type max | `0x79` | `0x7F` | `emote.rs:280` + test `:407` pins `0x7A → None` | **2013** (D15-04; ACE agrees, so low priority) |
| 54 | `EmoteSet` category max | `0x26` | `0x27` | `emote.rs:89` | **2013** (D15-04) |
| 55 | GameEvent IDs `0x317`/`0x318` | absent | present | **ABSENT** (`opcodes.rs:835` has only `0x02EB`) | missing (D15-05) |
| 56 | Allegiance hierarchy node count | signed i16 (32,768-65,535 unpacked as **zero**) | unsigned u32, ≤ 40,000 | `messages/allegiance/events.rs:453` `read_u16(...) as usize` | **correct — the 2013 bug is not reproduced** |
| 57 | Friend / squelch cap | `0x32` (50) | `0x64` (100) | no client-side cap anywhere | not applicable (cannot be wrong by the old value) |
| 58 | `HAR` guest hash buckets | 64 | 128 | no client-side guest hash | N/A-WEB |
| 59 | `ClientFlowQueue.FlowLevel_` init | 10 | 1 | no flow-control state (`flow_level` grep empty) | N/A-WEB |
| 60 | Outgoing chat length cap | none | `0x100` (256) | none (`lib.rs:33132-33144`) | missing (D15-03) |

---

# 4. ARCHITECTURAL SYNTHESIS

Three concerns from `00-architecture.md` map onto holtburger with very different
degrees of fidelity. What follows separates **structural** (expensive to change
later; sequence these first) from **incremental** (a patch at any time).

## 4.1 The three ordering layers — two are owned, the third is half-built

Retail's insight is that ordering is solved *three times*, at three scopes, for
three different failure modes, and that the layers are independent: a packet can
arrive intact (layer 1), reassemble correctly (layer 2), and still be discarded
as stale (layer 3).

| Layer | Retail mechanism | holtburger | Status |
|---|---|---|---|
| 1 — datagram | `ProtoHeader.seqID_`, NAK lists, `SentPacketStore` retransmit, `0x7FFF` look-ahead, per-seqID crypto key in the NAK AVL | `crates/holtburger-session/src/session/{receive,reliability}.rs`; `MAX_RETRANSMIT_SEQUENCE_IDS = 115` (`types.rs:18`) | **built**, with known gaps (NET-20, NET-21, and the ISAAC `search()`-vs-stored-key divergence) |
| 2 — blob | 64-bit `blobID`: ephemeral bit 63, ordering-type bits 56-60, 16-bit stamp bits 32-47; `Indicator` discards stale ephemeral fragments **before allocating a reassembly buffer** | `blobID` modelled as two opaque `u32`s (`transport.rs:161-168`) driven as `+= 1` counters (`send.rs:337`) | **structurally absent** — NET-14/NET-15. The bits are unreachable, not merely unread |
| 3a — per object | `PhysicsDesc.timestamps[9]` | `entity.rs:977-986` named slots + `should_accept_server_position_sequences` `:1026-1044` + `apply_server_position_update` `:1047-1100` | **built and faithful**, including the position-only `is_newer_u16` reject |
| 3b — per property | `ACWTimeStamper`, keyed `stype \| (StatType << 16)`, stale silently dropped | wire byte parsed (`properties.rs:11-33`) and **never read** (`handlers/properties.rs`, 0 hits for `sequence`) | **absent — ARCH-02** |

**Structural vs incremental.** Layer 2 is **structural**: `BlobId` is a type, and
retrofitting a semantic newtype through the send path, the reassembler and the
dispatcher touches the session crate's public surface. Layer 3b is **incremental**:
one map on `Entity`/`PlayerState` and fourteen guarded call sites, no type
changes, no wire changes. Sequence accordingly — ARCH-02 can land this week;
NET-15 wants a design pass. And note the interaction: NET-14's cheap half (an
ordering-stamp guard at the *dispatch* layer for `UpdatePosition`/`VectorUpdate`/
`UpdateMotion`) is the same idea as ARCH-02 one level up. Build one mechanism —
"is this update newer than what I applied?" — and use it in both places.

## 4.2 The client/server authority boundary — inherited correctly, with one inversion

Retail's split is unusually clean and holtburger already honours it: the client
simulates its own movement and *pushes*; the server owns every roll, number and
outcome and the client *waits*. The corollary in §7 is the more valuable half —
whole structures are parsed and then never read, and the doc names them (CMT
contents, `_casting_likelihood`, `_category`/`_power`, spell sets,
`DamageOverTime`, the `Body` armor model, `CEmoteTable`, `CreationProfile`).
Two consequences for our plan:

1. **The boundary is an argument for deleting work, not adding it.** The
   guard-rail framing wave1-B adopted (CMB-30 as an explicit anti-task) is the
   right default: before implementing a mechanic, check that retail *read* the
   field.
2. **We have exactly one inversion, and it is known.** holtburger drives the
   CombatManeuverTable to derive swings (CMB-06) where retail's copy is inert and
   the swing arrives as `0xF74C`. That is a deliberate divergence, and the reason
   it matters here is authority: a locally-derived swing is a *prediction*, and
   predictions need a reconcile path. CMB-06 already frames the choice; §4.1's
   ordering machinery is what a reconcile would be built on. So CMB-06 should be
   sequenced **after** the ordering work, not before.

Also structural, and cheap to state: retail has **no local anti-cheat** and we
should not invent any. The only client-side enforcement is a voluntary speedhack
self-report (NET-06) and a server-driven plugin audit we have no analogue for.

## 4.3 The two-object model — collapsed, correctly, but the collapse hides one thing

Retail splits every world object into `CPhysicsObj` (spatial) and
`ACCWeenieObject` (logical), cross-linked, registered in **parallel** hash tables
with a `null_` twin per table for objects whose cell has not loaded. holtburger
collapses both halves into one `Entity` (`crates/holtburger-world/src/entity.rs`)
plus `WorldState.player`; wave1-A dispositioned that PARITY-OK-by-design, and
that is right — the split is a C++ lifetime artifact (it is also the direct cause
of the teardown leaks in `11-memory-leak-investigation.md`).

What the collapse *does* hide is the **`null_` half**: retail has a first-class
representation for "I know this object exists but its cell is not resident", and
it exists in both tables independently. holtburger's nearest analogue is
`scene3d/pre_create_buffer.js` (a 25 s placeholder expiry ported from
`acclient.c:310666`) — a render-side buffer, not a world-state one. This is worth
naming because it is the seam where the two live-verified defect clusters meet:
PHY-07's "collision geometry never reaches the driver" (VERIFICATION-LOG) is a
residency question, and MEMORY's residency roadmap ("retail = refcounted DBOCache
+ fixed slot grid") is the same question from the asset side. Retail's answer in
all three cases is one idea: **an object's logical identity outlives its
resident spatial data, and there is an explicit state for the gap.** Any future
residency work should introduce that state deliberately rather than growing three
ad-hoc placeholders.

**Structural vs incremental:** the collapse itself is settled — do not revisit.
Introducing an explicit non-resident state *is* structural, and it should be
sequenced with the residency roadmap, not before it.

## 4.4 The frame pump — already the right shape; keep it that way

Retail runs one synchronous pass per frame with a fixed phase order and exactly
one worker thread that does no object construction. holtburger converged on the
same model deliberately: `?singleDriver` (default-ON, `scene3d/index.js:790-794`)
claims the frame, parks the legacy 2D rAF driver, and runs the whole net/input
pump as never-budget-gated phase #0 at the top of `tickPerFrame`
(`scene3d/loop.js:1652-1692`), with the retail cites in the comment. Physics is
enqueued and awaited across one microtask hop (`index.js:2056-2060`,
`syncTickHop`) so the wasm tick's pose publish lands before this frame's reads.
The deferrable-budget clock (`RP3_DEFAULT_BUDGET_MS = 9`, `loop.js:1542`) is
retail's 25 ms box, re-scaled for 60 Hz.

Two divergences worth writing down rather than fixing:
- holtburger has **three** worker threads (net, bake, keepalive) where retail had
  one, and the bake worker **does** construct objects off-thread — the one
  invariant §6 says retail preserved. That is a real improvement with a real
  cost, and the cost is already documented in MEMORY (stale-worker wasm/atlas).
- retail keeps simulating at ~10 fps when inactive; holtburger freezes sim on a
  long dt gap and leans on `?netWatchdog` + the 2.5 s keepalive. Different
  answer to the same problem; ours is arguably better for a browser.

Sequencing implication: this layer is **done**. It needs a live confirmation
(VL-F1), not work.

---

# 5. 2015-DELTA TASKS — SUMMARY

Every item doc 13 §5 lists, checked against holtburger *and* ACE, with the ones
that need no work marked as such.

| Delta | holtburger | ACE (our server) | Outcome |
|---|---|---|---|
| **Enlightenment** stat `0x186`/390 | `ints.rs:398` ✔ | property exists; ACE applies it to **Health ×2 only** (`CreatureVital.cs:113`), never to skills | PARITY-OK on the ID; skill application diverges three ways → **Q-F3**, no task |
| Enlightenment → every Trained skill (raw **and** current) | base path ✔ (`skill_info.rs:204-205`); current path ✘ (`:241-297`) | absent | upstream/ACE divergence → **Q-F3** |
| Enlightenment → Run/Jump skill | delegated to the wire skill (`context.rs:155-176`) | server-authoritative | PARITY-OK-by-delegation |
| Enlightenment → `2 × Max Health` only | `vital_info.rs:168-172` ✔ | `CreatureVital.cs:113` ✔ | PARITY-OK |
| Enlightenment UI lines | property available; panel unverified | — | **VL-F2** |
| **PK Damage** `0x17D`-`0x180` | `ints.rs:389-392` ✔ | present | PARITY-OK on IDs; no appraisal renderer → **D15-06** |
| **Overpower** `0x182`-`0x185` | `ints.rs:394-397` ✔ | present | same → **D15-06** |
| Overpower attack-condition `& 8` | declared `types.rs:34`, never rendered | ACE sets it (`combat/events.rs:268` test) | **CMB-05** (existing; doc 13 raises its priority — the bit is a genuine 2015 addition) |
| **Hear PK Deaths** option `0x34` / bit 25 | `character.rs:170`, `:85` ✔ | `CharacterOptions2.cs:38`, `CharacterOption.cs:171-172` ✔ | PARITY-OK |
| Hear PK Deaths **defaults ON** | `DEFAULT` = `0x00948700` (2013) | server-side per-character | **D15-01** |
| `[PKDe]` tag filter + strip | absent | never emits the tag | **D15-02** (dormant) |
| **New opcodes** `0x317`/`0x318` | absent | absent | **D15-05** |
| **Six new emote types** `0x7A`-`0x7F` | max `0x79`, pinned by a test | max 121 | **D15-04** (widen the unpacker only) |
| **EmoteSet category** `0x27` | max `0x26` | max 38 | **D15-04** |
| **Four new motion commands** (`SkillHealOther`, `CombatEat`, `CombatDrink`, `AI_TelegraphCast`) | 1 of 4 present and correct; 2 absent; 1 present but misnamed | same gaps | **ERA-03** |
| **Jump gating** — shifted range | 2013 range on 2015 IDs, 2 sites | n/a (client-side) | **ERA-01** |
| **Jump gating** — `Sanctuary` + `AI_TelegraphCast` | absent | n/a | **ERA-02** |
| **Friend/squelch cap** 50 → 100 | no client cap | server-side | no task (5o) |
| **256-char chat cap** (+ the 2013 `<tell:`/newline checks) | no `IsMessageSafe` at all | ACE validates server-side | **D15-03** |
| **House guest table** 64 → 128 buckets | no client-side guest hash | server-side | N/A-WEB |
| **Allegiance node count** i16 → u32 (+ 40,000 ceiling) — fixes a real 2013 bug where a 32,768-65,535-member hierarchy unpacked as **zero** | `events.rs:453` reads it unsigned | ACE enforces the cap | **PARITY-OK — the bug is not reproduced** |
| `ClientFlowQueue.FlowLevel_` 10 → 1 | no flow-control state | n/a | N/A-WEB |
| `Client::Client` `ret 4` / `gmClient` `push 0` | — | — | N/A-WEB (behaviourally inert) |
| `gmSpewBoxUI` yellow spew text | no spew box | — | N/A-WEB |
| Slash-command table **unchanged** (116 + 15 commands, 339 failure cases) | — | — | REF-ONLY, and it licenses CMB-19/CMB-20 era-wise |

---

# 6. ANTI-TASKS, DOC CORRECTIONS, OPEN QUESTIONS

## 6.1 ANTI-TASKS — do not file work for these

1. **The three behaviourally-inert changes.** Doc 13 §0/§5 names them and I am
   naming them again so nobody mines them later:
   `CPlayerSystem::Handle_PlayerDescription` (179 instructions both builds; two
   swapped loads and `lea esi,[eax+ecx]` vs `[ecx+eax]`; **no new field
   unpacked**), `ItemExamineUI::Appraisal_ShowSpecialProperties` (same size, same
   1,024 instructions, two adjacent `mov`s reordered), and
   `ClientCombatSystem::PlayerInReadyPosition` (identical accepted motion set;
   only `AtlatlCombat`/`ThrownShieldCombat` renumbered). Zero tasks.
2. **Do not "fix" `AtlatlCombat` to `0x80000138`.** Restated from CMB-11 because
   doc 13 §5 now independently confirms the renumbering, and because ERA-05's
   test is what makes the restatement stick.
3. **Do not shift `ClientAction` values.** `PlayerOption_HearTradeChat =
   0x1000010F` (`properties/ui.rs:312`) is correct despite colliding with
   `SkillHealOther`. Two namespaces, one class byte; the 2013 PDB proves the
   coexistence (`0x1000010E` = both `Motion_SkillHealSelf` and
   `PlayerOption_HearGeneralChat`).
4. **Do not port `Chorizite.ACProtocol`'s `Command` enum** (ERA-04). It is the
   2013 table and it is wired to a live wire type upstream.
5. **Do not name the six new emote types.** The 2015 binary does not name them
   (§5 says only that they reuse existing payload shapes); inventing names would
   be fabricated data in a table we treat as authoritative.
6. **Do not add local anti-cheat.** Retail has none (§7); the only client-side
   enforcement is the voluntary speedhack self-report already scoped as NET-06.
7. **Do not implement `DamageOverTime`, the `Body` armor model, `CEmoteTable`,
   `CreationProfile`, `_casting_likelihood`, or client-side hit location.**
   Retail parses and never reads all of them (§7). This restates CMB-30's shape
   for the structures §7 lists that CMB-30 did not enumerate.

## 6.2 DOC CORRECTIONS

1. **`00-architecture.md` §7 says the plugin COM interface has 56 methods
   ("a 56-method COM interface … 16 of those 56 methods are `E_FAIL` stubs");
   doc 13 §3 says 52 ("The `IAsheronsCall` vtable has the same 52 slots in the
   same order").** Both cannot be right, and they were written by the same
   project three weeks apart. Neither number is checkable from `acclient.c`
   alone (the vtable is `.rdata`), so I flag it rather than adjudicate:
   `08-client-core.md` is the source for the 56 and should be reconciled with
   doc 13 §3. Low impact (N/A-WEB either way), but it is exactly the kind of
   number a future reader would cite.
2. **`00-architecture.md` §5's DID/DB_TYPE table is confirmed correct** on the
   seven rows I could check against the 2013 constants (`GFXOBJ 6`, `SETUP 7`,
   `PALETTE 10`, `MTABLE 14`, `CLOTHING 25`, `KEYMAP 29`, `STRING_TABLE 37`, at
   `acclient.c:39281`-`:39312`). Recorded as a positive because wave2-D's DAT-12
   depends on the same table.
3. **`00-architecture.md` §1's "only two functions Hex-Rays failed to decompile"
   is confirmed** — `Client::UseTime` (`acclient.c:552`) and
   `Client::KeepUIAlive` (`:529`) have prototypes and no bodies; the sibling
   `gmClient::UseTime` does have a body at `:61259`, so the absence is specific.
4. **Doc 13's own two corrections to the 2013 pack are noted and accepted**
   (§6a: the `11-memory-leak-investigation.md` §8b vtable labels are inverted —
   `0x007E3EA0` is the `ACCWeenieObject` vptr at `object+0`, `0x007E3E88` the
   `NoticeRegistrar` sub-object vptr at `object+0xC`; §6b/§2: "file offset ==
   RVA for every section" is false, it holds for `.text`/`.rdata`/`.data`
   only). Neither affects holtburger; both affect native-client patching, i.e.
   `wave0-palette-leak-patch.md`'s domain — whose sites are in `.text`, so its
   `VA − 0x400000` arithmetic stands.
5. **No error found in doc 13's command-table arithmetic.** I tried: the 271/136
   split, the `0x10F` boundary, the `0x198 → 0x19C` bound, the `NextMonster
   0x0900010F → 0x09000112` claim, and the `0x128-0x131 → 0x12B-0x134` range
   all reproduce exactly from the 2013 arrays. This is the most trustworthy
   section in the corpus so far.
6. **holtburger doc bugs found while verifying (not deep-dive errors), fold into
   ERA-05:** `crates/holtburger-world/src/player/types.rs:48` labels
   `0x10000128..=0x10000131` as "`TripleThrustLow..MagicPowerUp07Purple`" — a
   correct 2015 decode of an incorrect 2013 range, i.e. the file documents its
   own bug; and `crates/holtburger-common/src/properties/ui.rs:49` says the
   `ClientAction` outliers stop at `0x10000139` when the enum reaches
   `0x1000013F`.

## 6.3 OPEN QUESTIONS

- **Q-F1 — do `0x317`/`0x318` exhaust the 2015 opcode delta?** Doc 13 §7 is
  explicit that only 2013-side functions were enumerated, so a 2015-only handler
  reachable from a 2015-only dispatcher would be invisible; the unattributed
  remainder of the 3,856-byte `.text` growth could hold more. D15-05 should be
  worded as "the two known new opcodes", not "the opcode delta".
- **Q-F2 — which era do the shipped `CMasterInputMap` keymaps (`0x14……`) encode?**
  This is the one place a *DAT* carries command IDs, and §5 of the architecture
  doc says keybinds merge a user INI over **two** DAT defaults. If the EoR
  keymaps carry 2015 ordinals (they should), then any holtburger keybinding
  renderer must use the 2015 name table — which makes ERA-03 slightly more than
  cosmetic. Cheap check: `worldbuilder-terminal`
  `chorizite-parse-dat-record` on a keymap DID and look for an ordinal ≥ `0x10F`
  whose 2013 and 2015 names differ. Not done here.
- **Q-F3 — should our local skill `current` include Enlightenment?** Retail 2015
  adds it in `InqSkill` *outside* the `!raw` guard, so both raw and effective
  values carry it. Upstream `Chorizite/ACPlugin/API/SkillInfo.cs` adds it to
  `Base` only, and vanilla ACE adds it to **neither** (its only Enlightenment
  application is Health ×2, `CreatureVital.cs:113`). holtburger mirrors
  chorizite (`skill_info.rs:204-205` yes, `:241-297` no). Since the server is
  authoritative for skills and we display wire values, matching ACE is probably
  correct — but the divergence from retail should be a comment in
  `skill_info.rs`, and someone should decide whether our *local predictions* want
  the retail or the ACE number.
- **Q-F4 — does ACE ever emit a PK-death broadcast we would want tagged?**
  `Creature_Death.cs:565` computes `isPKdeath`; if that path produces a
  broadcast, D15-02 becomes live rather than dormant and the tag convention has
  to be agreed with the server side.
- **Q-F5 — should we answer a plugin audit?** Retail ships
  `Handle_Admin__Recv_QueryPluginList` and answers with plugin name/author/
  e-mail/webpage. We have a real plugin system and no audit surface. Probably
  N/A forever, but it is the only piece of §7's authority discussion with no
  holtburger analogue at all.
- **Q-F6 — is `?singleDriver`'s claim actually held in a normal boot?** VL-F1.
  The flag audit says yes; VERIFICATION-LOG says a flag audit is not a behaviour
  test. One `evaluate_script` on `window.__scene3dFrameDriverActive` settles it.
