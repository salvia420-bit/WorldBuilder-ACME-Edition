# AC Alt-Client Capability Catalog: Authoritative Sources
**Generated:** 2026-05-25  
**Purpose:** Reference for downstream deficiency analysis vs. holtburger-web implementation

---

## 1. Chorizite Framework (ACProtocol + ACPlugin)

### Networking / Wire Protocol
- **GameActionType enum** (0xF7B1) — Client→Server 66 action opcodes — `/external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Enums/GameActionType.generated.cs`
- **GameEventType enum** (0xF7B0) — Server→Client 46 event opcodes — `/external/chorizite/Chorizite.ACProtocol/Chorizite.ACProtocol/Enums/GameEventType.generated.cs`
- **NetworkParser** — Message dispatch orchestrator — `Chorizite.Core.Net`
- **C2SMessageHandler.generated** — Client→Server message routing — `Chorizite.ACProtocol`
- **S2CMessageHandler.generated** — Server→Client message routing — `Chorizite.ACProtocol`

### Protocol Categories (from GameActionType/GameEventType)
- **Login** — PlayerDescription, login flow orchestration
- **Character** — Movement, teleport, age/birth queries, AFK status, permissions, barber, PK arena
- **Combat** — Targeted melee/missile, cancel attack, mode changes, health queries
- **Movement** — Jump, MoveToState, DoMovementCommand, StopMovement, AutonomyLevel, AutonomousPosition
- **Magic** — CastTargetedSpell, CastUntargetedSpell, RemoveSpell, spell favorites
- **Inventory** — PutItem, GetAndWield, Drop, UseEvent, UseWithTarget, Stackable split/merge
- **Trade** — OpenTrade, AddToTrade, AcceptTrade, DeclineTrade
- **Allegiance** — Swear/Break, Officer assignments, motd, bans, chat gag
- **House** — Buy/Rent/Abandon, guest/storage perms, teleport, hooks visibility
- **Social** — Friends, titles, contracts, squelch
- **Communication** — Chat, Emote, SoulEmote, direct message, channels, AFK messages
- **Vendor** — Buy/Sell items
- **Fellowship** — Create, recruit, leader assignment, openness setting
- **Admin/Advocate** — Plugin query, teleport (advocate)
- **Writing** — Books, inscriptions, page management
- **Game** (Chess) — Join, Move, Stalemate, GameOver
- **Item** — Appraise, mana queries, inscription, salvage
- **Misc** — Portal storms, conference requests

### Plugin API Surface (ACPlugin)
- **Game** (entry point) — ServerName, AccountName, State, Characters, Character, World, Actions — `/external/chorizite/ACPlugin/API/Game.cs`
- **Character** — Attributes, vitals, skills, enchantments, spells, quest flag tracking
- **World** — Objects, landblock position, cells, dungeon/portal navigation
- **Actions** — Spell casting, movement, combat commands, inventory manipulation — `/external/chorizite/ACPlugin/API/Actions.cs`
- **WorldObject** — ID, type, name, model, scale, container contents, physics, velocity — `/external/chorizite/ACPlugin/API/WorldObject.cs`
- **Enchantment** — Spell ID, caster, duration, vitae, hemolymph — `/external/chorizite/ACPlugin/API/Enchantment.cs`
- **SkillInfo** — Level, XP, advancement class, cost formula — `/external/chorizite/ACPlugin/API/SkillInfo.cs`
- **VitalInfo** — Level, XP, max, base, current — `/external/chorizite/ACPlugin/API/VitalInfo.cs`
- **CharacterIdentity** — Name, object ID, account status
- **GameScreen** — CharSelect, DatPatch, gameplay screen enum
- **DragDropManager** — Drag/drop event handling and state

### Rendering / UI Backend (IClientUIBackend)
- **OnScreenChanged** — Game screen transitions
- **OnShowTooltip / OnHideTooltip** — Tooltip lifecycle
- **OnShowRootElement / OnHideRootElement** — UI root visibility
- **IClientBackend** — GameScreen (int), SelectedObjectId, ChatInput, ChatTextAdded, ObjectSelected events — `/external/chorizite/Chorizite/Chorizite.Core/Backend/Client/IClientBackend.cs`

### Core Infrastructure
- **IChoriziteBackend** — Central coordinator (plugins, rendering, input, net, launcher, dats)
- **IClientBackend** — AC client interface (network events, UI backend, game state access)
- **NetworkParser** — S2C/C2S message unpacking and handler dispatch
- **IDatReaderInterface** — DAT file access (leverages DatReaderWriter)
- **RmlUiPlugin** — RML-based UI framework (charselect, datpatch screens)
- **DragDropManager** — Drag/drop event coordination

---

## 2. DatReaderWriter (DAT File Parser)

### DAT Object Types
**Critical types** (0x0n prefix most common):
- **Setup** (0x08) — 3D model rigging, bone hierarchy — `SetupTests.cs`
- **Animation / MotionTable** (0x09) — Animation frames, motion trees — `AnimationTests.cs`, `MotionTableTests.cs`
- **GfxObj** (0x01) — Geometry/mesh asset — `GfxObjTests.cs`
- **Texture / RenderTexture** (0x06) — Texture bitmap data — `RenderTextureTests.cs`
- **Palette / PalSet** (0x04) — Color palette — `PalSetTests.cs`
- **Surface** (0x07) — Texture surface / polygon data — `SurfaceTests.cs`
- **Material / RenderMaterial** — Material definitions and properties — `RenderMaterialTests.cs`
- **ParticleEmitter** — Particle effect definitions — `ParticleEmitterTests.cs`
- **LandBlock** (0x12 or ~0xDB) — Terrain / landscape cell — `LandBlockTests.cs`
- **EnvCell** — Environment cell (dungeon interior) — `EnvCellTests.cs`
- **LandBlockInfo / LandCell** — Terrain metadata — `LandBlockInfoTests.cs`
- **Region** — Dungeon/interior region metadata — `RegionTests.cs`
- **MotionTable** — Animation state machine — `MotionTableTests.cs`
- **CombatTable** — Combat modifiers and behaviors — `CombatTableTests.cs`
- **SpellTable** — Spell definitions and school bindings — `SpellTableTests.cs`
- **SkillTable** — Skill definitions and trainability — `SkillTableTests.cs`
- **SpellComponentTable** — Spell component lookup — `SpellComponentTableTests.cs`
- **CharGen** — Character generation metadata — `CharGenTests.cs`
- **Font** — Text rendering font — `FontTests.cs`
- **SoundTable** — Sound effect asset references — `SoundTableTests.cs`
- **ClothingTable** — Wearable item lookup and variants — `ClothingTableTests.cs`
- **StringTable / LanguageString** — Localized text — `StringTableTests.cs`, `LanguageStringTests.cs`
- **ActionMap** — Hotkey/shortcut assignment — `ActionMapTests.cs`
- **MasterProperty / DBProperties** — World properties and enchantment definitions — `MasterPropertyTests.cs`, `DBPropertiesTests.cs`
- **ContractTable** — NPC quest contracts — `ContractTableTests.cs`
- **SceneGraph / Scene** — 3D scene hierarchy — `SceneTests.cs`
- **Wave** — Audio waveform asset — `WaveTests.cs`
- **ObjectHierarchy** — Model part attachment hierarchy — `ObjectHierarchyTests.cs`
- **PhysicsScript** — Physics simulation scripts — `PhysicsScriptTests.cs`

### DAT Parsing Interfaces
- **DatDatabase** — B-tree file-level access and iteration — `DatDatabase.cs`
- **DatCollection** — Multi-DAT concurrent access — `DatCollection.cs`
- **QualifiedDataId<T>** — Typed file ID with validation
- **IDBObj / DBObj** — Base class for all DAT objects
- **EnumMapper** — Property ID↔Name resolution

**Known caveats:** DRW width/type annotations may diverge from retail wire format; ACE server is considered more authoritative for wire protocol specifics.

---

## 3. ACE Server (GameAction Handlers + Events)

### GameAction Server Handlers (149 files)
**Sample coverage by category:**
- **Combat**: TargetedMeleeAttack, TargetedMissileAttack, ChangeCombatMode, CancelAttack, QueryHealth
- **Movement**: Jump, MoveToState, DoMovementCommand, StopMovement, AutonomyLevel, AutonomousPosition
- **Magic**: CastTargetedSpell, CastUntargetedSpell, RemoveSpell
- **Inventory**: PutItemInContainer, GetAndWieldItem, DropItem, UseEvent, UseWithTarget, Stackable operations
- **Trade**: OpenTradeNegotiations, AddToTrade, AcceptTrade, DeclineTrade
- **Character**: PlayerOptionChanged, Teleport variants (PK, PKLite, Marketplace, Lifestone), Barber, Shortcut management
- **House**: BuyHouse, RentHouse, AbandonHouse, Guest/Storage permissions, Teleport to house
- **Allegiance**: Swear, Break, Officer/vassal management, Chat gag, Motd
- **Fellowship**: Create, Recruit, Leader assignment
- **Social**: AddFriend, RemoveFriend, SetTitle, Contracts
- **Vendor**: BuyItems, SellItems
- **Communication**: Talk, TalkDirect, Emote, SoulEmote, Channels, Squelch
- **Writing**: BookData, AddPage, ModifyPage, DeletePage, Inscribe
- **Admin**: QueryPluginListResponse, QueryPluginResponse
- **Advocate**: Teleport
- **Item**: Appraise, Identification, SetInscription, QueryMana, Salvage
- **Fellowship**: Create, Recruit, UpdateRequest
- **Game** (Chess): Join, Quit, Move, MovePass, Stalemate

**Path:** `/home/wbterminal/ace-server/Source/ACE.Server/Network/GameAction/Actions/`

### GameEvent Server Responses (94 files)
**Coverage by category:**
- **Login**: PlayerDescription, JoinGameResponse, StartGame
- **Combat**: AttackDone, VictimNotification (self/other), AttackerNotification, DefenderNotification, Evasion, CommenceAttack, QueryHealthResponse
- **Magic**: RemoveSpell, UpdateSpell, UpdateEnchantment, RemoveEnchantment, Purge, Dispel
- **Movement/World**: MoveResponse, OpponentTurn (chess)
- **Character**: QueryAgeResponse, QueryBirthResponse, ConfirmationRequest/Done, ReturnPing
- **Inventory**: ViewContents, SaysMoveItem, GetInscriptionResponse, QueryItemMana, UseDone, Salvage results
- **Item**: SetAppraiseInfo, AppraiseDone, WearItem, StopViewingContents
- **Trade**: RegisterTrade, OpenTrade, CloseTrade, AddToTrade, RemoveFromTrade, Accept, Decline, Failure, ClearAcceptance
- **Allegiance**: AllegianceUpdate, UpdateDone, LoginNotification, InfoResponse
- **Fellowship**: FullUpdate, Disband, UpdateFellow, UpdateDone, StatsDone
- **House**: HouseProfile, HouseData, HouseStatus, UpdateRentTime, UpdateRentPayment, UpdateRestrictions, AvailableHouses
- **Social**: FriendsUpdate, CharacterTitleTable, AddOrSetCharacterTitle, ContractTrackerTable, SendClientContractTracker
- **Vendor**: VendorInfo
- **Communication**: PopUpString, HearDirectSpeech, ChatRoomTracker, ChannelBroadcast, ChannelList, ChannelIndex, WeenieError/ErrorWithString, TransientString, SetSquelchDB
- **Writing**: BookOpen, BookAddPageResponse, BookDeletePageResponse, BookPageDataResponse
- **Game** (Chess): JoinGameResponse, StartGame, MoveResponse, OpponentTurn, OpponentStalemateState, GameOver
- **Misc**: PortalStormBrewing, PortalStormImminent, PortalStorm, PortalStormSubsided
- **Admin**: QueryPluginList, QueryPlugin, QueryPluginResponse2

**Path:** `/home/wbterminal/ace-server/Source/ACE.Server/Network/GameEvent/Events/`

---

## 4. Retail Client (acclient.c + acclient.h)

### Major Subsystems & Entry Points

#### Rendering / Graphics
- **CRender** — Main rendering controller — `acclient.c` method bodies
- **CPhysicsObj** — 3D object with physics simulation, model, animation state
- **CSetup** — Model setup/skeleton binding
- **CGfxObj** — Geometry asset with vertex/index buffers
- **CAnimation / CMotionInterp** — Animation interpolation and state machine
- **CParticleEmitter / CParticleManager** — Particle effect system
- **CMaterial / CRenderMaterial** — Material and texture binding
- **CSurface / CRenderSurface** — Polygon surface definition
- **CTexture / CRenderTexture** — Texture asset

#### Terrain / World
- **CLandBlock / CLandCell** — Terrain landblock and individual cell
- **CLandBlockInfo** — Terrain metadata (walkable, blocked)
- **CEnvironment / CEnvCell** — Interior/dungeon cell and environment
- **CPortalPoly / CCellPortal** — Portal geometry and destination linking
- **CObjCell** — Object/instance cell containing dynamic objects
- **CTerrainType / CTerrainDesc** — Terrain material/surface types

#### Physics / Movement
- **CPhysicsObj** — Physics-enabled object (movement, collision, velocity, acceleration)
- **CPhysics** — Physics simulation engine and world state
- **CPhysicsPart** — Part-level physics (collision volumes, constraints)
- **CMotionInterp** — Movement interpolation for smooth client-side prediction
- **MotionTable** — Animation state tree linking states to motion data

#### Combat / Gameplay
- **CCombatTable** — Combat hit chance, damage formulas, modifiers
- **CSpellTable / CSpellBook** — Spell registry and character spell list
- **CSpellBase** — Individual spell definition (components, school, duration)

#### Networking / Protocol
- **CNetLayerPacket** — Wire-level packet framing
- **NetworkParser** (in Chorizite) — Message dispatch (canonical in alt-client)
- **GameMessage** / **GameAction** / **GameEvent** — Protocol message types

#### UI / Input
- **CMasterInputMap** — Global input key binding and action mapping
- **CInputManager / CInputHandler** — Input event capture and dispatch
- **CInputManager_WIN32** — Windows-specific input (keyboard, mouse)
- **CChatWindow / CChatEvent** — Chat UI and event processing
- **CMaster** (UI coordinator) — Screen/panel management
- **CInvSlotModule** — Inventory UI slot handling

#### Character / Account
- **CCharGenData / CCharGenResult** — Character generation flow data
- **CObjectInventory** — Character inventory container
- **CCWeenieObject** — Weenie (game object) base class
- **CAllegianceData** — Allegiance tree structure (at login)
- **CAllegianceProfile** — Allegiance metadata

#### World State / Data
- **CWorldObject** — Base class for all world objects (players, NPCs, items)
- **CBuildingObj** — Building/structure game object
- **CObjectMaint** — Object lifecycle and creation/deletion
- **CContractTable** — NPC quest/contract registry
- **CExperienceTable** — Level/XP progression
- **CVitalTable** — Vital (health, mana, stamina) progression
- **CSkillTable** — Skill progression and formulas

#### System Infrastructure
- **CCommunicationSystem** — Message bus and event routing
- **CClientsideLoginStateHandler** — Login state machine (CharSelect → InGame)
- **CAsyncStateMachine** — Async request handling (DDD, patching, etc.)
- **CLCache / CLOCache** — Object/landblock caching
- **CQuestDefDB** — Quest definition database

#### Misc Categories (CM_* modules)
- **CM_Login** — Login flow
- **CM_Character** — Character vitals, attributes, training
- **CM_Combat** — Combat interactions
- **CM_Magic** — Spell casting and enchantment
- **CM_Inventory** — Item management
- **CM_Allegiance** — Allegiance operations
- **CM_House** — House ownership and management
- **CM_Fellowship** — Fellowship operations
- **CM_Trade** — Peer-to-peer trade
- **CM_Social** — Friends, titles, chat
- **CM_Admin** — Admin commands and telemetry
- **CM_Physics** — Physics queries and movement validation
- **CM_UI** — UI rendering and state

### Header Enums (acclient.h: 348 enums + 6,936 structs)
- **GameActionType** — Client→Server opcodes (0xF7B1 base; 0xF6xx movement variants)
- **GameEventType** — Server→Client opcodes (0xF7B0 base)
- **ClientState** — Login/gameplay state machine
- **SkillID** — Melee, Missile, Magic School, etc.
- **PropertyID** — WeenieProp_* attributes/vitals/spells
- **EnchantmentType** — Spell type categorization
- **QuestFlag** — Quest progress tracking
- **ContractID** — Quest/NPC contract ID

---

## 5. WorldBuilder Terminal / Chorizite-Parity Validators

### Existing Validators
**Path:** `/external/holtburger/apps/holtburger-web/scripts/chorizite-parity/`
- **dispatch-cases.json / dispatch-cases.cjs** — GameAction/GameEvent dispatch coverage tracking

These reveal which protocol surfaces have existing validation coverage; downstream deficiency analysis should cross-reference.

---

## Cross-Source Notes

### Known Divergences & Caveats

1. **DatReaderWriter vs. Wire Protocol**
   - DRW is authoritative for DAT file format but may mislabel width/type annotations
   - ACE server and Chorizite wire format take precedence for GameAction/GameEvent structure
   - Key: DRW 0x09 (MotionTable) and 0x08 (Setup) are complex; verify against Chorizite.ACProtocol message bodies

2. **Retail Client (acclient.c) Caveat**
   - 31MB / 938k lines decompiled C++ with 1,078 class bodies
   - Symbol names are best-effort (IDA Pro inference); manual verification required
   - Physics, terrain, and particle systems are sophisticated; no guarantee of 100% fidelity in alt-client implementations

3. **ACE Server Coverage**
   - 149 GameAction handlers + 94 GameEvent responses → comprehensive
   - Not all actions have corresponding events (e.g., admin-only operations may be stubs)
   - Asynchronous operations (trading, house rental) may have complex multi-packet flows

4. **Chorizite Plugin API**
   - High-level C# API abstracting native client complexity
   - Does not expose all low-level rendering details (shaders, D3D state, BSP collision trees)
   - Suited for plugins/mods; full-fidelity alt-clients may need lower-level interfaces

5. **Movement Opcodes**
   - Located at 0xF6xx range (Jump_NonAutonomous, Jump, MoveToState, etc.)
   - Critical for client-side prediction and state synchronization
   - Must cross-validate timing and authority model with ACE server

6. **Chat & Communication**
   - Channel-based (broadcast, direct, emote, soul-emote)
   - Squelch (character/account/global) requires tri-part filtering
   - Portal storms have special broadcast mechanics

7. **Trade & House Operations**
   - Multi-step handshake with state transitions (OpenTrade → AddToTrade → AcceptTrade)
   - House rental involves lease time, payment cycle, permission matrices
   - Salvage operations async; completion requires listening for specific GameEvent

8. **Enchantment & Buff System**
   - Enchantment = Spell instance on target (caster, duration, spell ID, vitae)
   - UpdateEnchantment / RemoveEnchantment messages for active buffs
   - Dispel mechanics require filtering by school/type and vitae eligibility

9. **PhysicsObj & Collision**
   - Not directly exposed in Chorizite API; must infer from C++ decompilation
   - Landblock/EnvCell BSP trees drive walkability and clipping
   - Critical for accurate movement validation and dungeon navigation

10. **Quest Flags vs. Contracts**
    - Quest flags are bitmaps (PropertyID) updated via GameEvent
    - Contracts are NPC-driven quest/task objects (ContractTable enumeration)
    - Both must be tracked for quest state UI

---

## Summary: Categories Requiring Attention for Deficiency Analysis

**High Priority (Protocol/Core):**
- GameAction dispatch (all 66 opcodes)
- GameEvent dispatch (all 46 opcodes)
- Movement (Jump, MoveToState, AutonomyLevel)
- Combat (TargetedAttack, CancelAttack)
- Magic (CastSpell, RemoveSpell, UpdateEnchantment)
- Inventory (UseEvent, UseWithTarget, Drop, Wield)

**Medium Priority (Gameplay):**
- Trade (multi-step handshake)
- Fellowship (recruitment, stat sync)
- Allegiance (hierarchy sync, motd, bans)
- House (permissions, rental, teleport)
- Character (AFK, options, shortcuts, title)

**Low Priority (Extended):**
- Chess game (Join, Move, Stalemate)
- Salvage operations (async)
- Admin/Advocate commands
- Writing system (books, inscriptions)

**Infrastructure:**
- DAT parsing (Setup, Animation, GfxObj, Texture, ParticleEmitter)
- Physics/Collision (LandBlock BSP, terrain walkability)
- Rendering (CPhysicsObj state sync, particle effects, sky dome)
- Audio (SoundTable, Wave assets)
- UI/HUD (CMaster, CChatWindow, CMasterInputMap)

