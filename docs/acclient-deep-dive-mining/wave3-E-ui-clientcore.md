# Wave 3 — Agent E — `05-ui.md` + `08-client-core.md`

Mined 2026-07-26. Sources:
`external/acclient-deep-dives/2013-09-11.4186-v3/05-ui.md` (769 lines, 15 H2)
and `08-client-core.md` (820 lines, 15 H2), plus `00-architecture.md` §9 and the
folder README for the trap list.

Contrast target: `external/holtburger/apps/holtburger-web/` (JS/three.js +
Rust/wasm), `plugins/`, `rynth/`, and `crates/holtburger-*`.

Verification posture per the wave rules: every holtburger claim below cites a
`file:line` I opened in this session. Several retail claims were re-verified
directly against `~/ac-headers/acclient.c` / `acclient.h`, and four against the
**shipped** `~/ac_base_dats/client_portal.dat` through
`WorldBuilder.Terminal chorizite-parse-dat-record` (era check — rule 4).
`rg -r` was never used (rule 5).

**Confidence caveat carried forward:** `08-client-core.md` §2's frame-pump
bodies (`Client::UseTime`, `Client::KeepUIAlive`) were recovered from the 2015
build (11.6096), not from 11.4186 — the doc itself says so. Every conclusion I
draw from the main-loop *ordering* is therefore marked one notch weaker and is
called out inline as **(2015-recovered)**.

---

## 0. Disposition counts

Counted by **primary** disposition, one row per distinct claim
(115 ledger rows; a row may carry a secondary disposition, e.g.
"PARITY-OK + TASK UI-06" counts as PARITY-OK):

| Disposition | Rows (primary) | Rows mentioning it |
|---|---|---|
| PARITY-OK | 36 | 34 |
| TASK | 27 | 40 |
| REF-ONLY | 26 | 27 |
| N/A-WEB | 19 | 19 |
| VERIFY-LIVE | 4 | 5 |
| ANTI-TASK | 3 | 3 |
| **Total ledger rows** | **115** | — |

**34 distinct task IDs** (UI-01…UI-24, CORE-01…CORE-10) across those rows.

Doc corrections: **4** (3 substantive, 1 refinement).
Anti-tasks: **7**.
Open questions: **8**.

Ranked top-10 tasks (rationale in §2): CORE-01, UI-01, CORE-07, CORE-02,
CORE-08, CORE-10, UI-14, UI-05, CORE-03, UI-08.

---

## 1. COVERAGE LEDGER

### 1A. `05-ui.md`

| § | Claim | Disposition | Evidence |
|---|---|---|---|
| §1 | `UIListener → UIRegion → UIElement` retained-mode tree; `HashList<UIRegion*>` children = O(1) lookup + explicit z-sorted paint order | **N/A-WEB** | The DOM *is* a retained-mode tree with O(1) `getElementById` and document order. Porting the class tower buys nothing. |
| §1 | `UIRegion` fields: `m_zlevel`, two `Graphic*`, `m_alphaBlendMod`, `m_visible/m_transparent/m_bBlockClicks/m_bDrawAfterChildren/m_bTooltip`, `BlitMode` | **REF-ONLY** | Field semantics map to CSS (`z-index`, `pointer-events`, `opacity`, `mix-blend-mode`). Useful as a naming source for a window manager (→ UI-04). |
| §1 | Widget factory type IDs 1…0x19, `0xA` = `UIElement_Scrollable` absent from the factory, IDs 4 / 0xF / 0x12 unregistered | **PARITY-OK** | `element_type` is parsed and shipped to JS (`apps/holtburger-web/src/lib.rs:11412-11413` emits `"element_type"`). We never instantiate *by* type, so the factory table is descriptive for us — the values themselves are correct and already in the wire path. |
| §2 | `LayoutDesc : DBObj`, `GetDBOType()` = 35 = `0x23`; **DID band `0x21000000`–`0x21FFFFFF`**; StringTable 37↔`0x23xxxxxx`, ActionMap 39↔`0x26xxxxxx`, Font 46↔`0x40000000`-`0x40000FFF` | **PARITY-OK** | Our loaders use exactly these bands: layouts `0x21…` (`ui/ac_layout.js:56`, `plugins/radar.js:105` `0x21000074`), StringTable `0x23…` (`ui/ac_layout.js:444` default `0x23000004`), ActionMap `0x26000000` (`ui/ac_strings.js:153`). Shipped-DAT check: ActionMap `0x26000000` parses, `stringTableId` = `0x23000005`. |
| §2 | `ElementDesc` carries a **base-layout DID for inheritance, flattened by `LayoutDesc::InqFullDesc`** | **TASK UI-06** | `crates/holtburger-dat/src/file_type/layout.rs:72-73` parses `base_element` + `base_layout_id`, but `fetch_layout` never emits them (`apps/holtburger-web/src/lib.rs:11402-11431` emits key/element_id/element_type/default_state/x/y/w/h/z/edges/state_desc/states/children only). JS cannot resolve inheritance. |
| §2 | `StateDesc` = x, y, w, h, zlevel, `PropertyCollection`, `MediaDesc*[]`; geometry is sparse per incorporation flags | **PARITY-OK** | `layout.rs:96` reads `incorporation_flags` and gates x/y/w/h/z; `ui/ac_layout.js:20-28` documents and handles `undefined`; `computeChildGeometry` (`ac_layout.js:497`) does the edge-anchor resolve. |
| §2 | `m_vGlobalScale` **is never read** — written once to the one-vector in the ctor (156187); the resize path is `RefreshEvent` → root resized to `GetDisplayWidth/Height` in pixels | **PARITY-OK** | Nothing to port; our root is the viewport. Recorded so nobody "implements virtual scaling". |
| §3 | `MediaMachine` is a sequential PC over an opcode list; handler returns advance/block; on block it `RegisterForGlobalMessage(3)` (per-frame tick) and re-enters | **TASK UI-05** | Re-verified in the decomp: `Update` (acclient.c:162444) `UnRegister`s at entry, `break`s out of the `while(1)` on a false return **without advancing `m_curIndex`**, then re-registers (acclient.c:162530). Ours has no interpreter — only a declarative lookup, `getStateMediaByType` (`ui/ac_layout.js:457`). |
| §3 | Opcodes 1 Movie, 2 Alpha, 3 Anim, 4 Cursor, 5 Image, 6 Jump, 7 Message, 8 Pause, 9 Sound, 0xA State, 0xB Fade | **PARITY-OK** | Byte-identical in `crates/holtburger-dat/src/file_type/media_desc.rs:23-37`. I re-read the decomp switch (acclient.c:162472-162516): every case number matches the doc. |
| §3 | Pause rolls a duration in `[min,max]` then blocks on `Timer::compute_time()`; Jump is probabilistic (`RollDice(0,1) <= m_probability`, `m_curIndex = m_jumpItemIndex − 1`); Message needs owner flag bit 17; **State always returns false, halting the playlist** | **TASK UI-05** | Control-flow semantics are the whole value of the interpreter; none of it exists in our tree (grep for a MediaMachine/opcode executor: nothing outside `media_desc.rs`'s parser). |
| §4 | Dirty-rect composition into per-window `UISurface` textures; one texture + one indexed triangle-list quad per top-level window | **N/A-WEB** | The browser compositor does this better and for free. |
| §4 | Z-order kept sorted **at insert time** by `CompareZLevel` in `UIRegion::AddChild` (696988), with `BringToFront` on activation; `ComputeGameViewport` shrinks the 3D viewport around edge-clamped panels | **TASK UI-04** | We have no central z-order owner: hardcoded `z-index` literals scattered across plugins — 50/60/65/70/80/81/90/200/1000/12000/**2147483000** (`plugins/vitals-hud.js:79`, `plugins/radial-menu.js:24,169`, `plugins/spellbook.js:753`, `plugins/social-panel.js:45`, `plugins/status-indicators.js:256`, and ~20 more). `ui/ac_window_position.js` owns position/size/lock only (exports at `:69,316,433,591,633,658`) — no layer or focus concept. |
| §5 | Win32 → `Device::WndProc` → `CInputManager_WIN32::OnMessage`; DirectInput polling | **N/A-WEB** | Browser events. |
| §5 | `OnAction` asymmetry: press `v2 > 4 && v2 <= 0xF` (with **4 swallowed**), release only `5..0xC`; down passes `m_InputExtent`, up passes `m_pcCallback` | **PARITY-OK** | Re-verified verbatim at acclient.c:155252-155274. No analogue needed (browser gives us symmetric down/up), but the asymmetry explains retail quirks and is recorded. |
| §5 | `SetFocusElement` broadcasts message `0x2F` (dwParam 0 out, 1 in) then calls a vtable slot with 3000 = `impri_FocusedUI` | **TASK UI-01** | The focus→input-priority coupling is the piece we lack (see §7 row). Our only focus gate is "is an input focused" (`scene3d/input.js:39-41` `inputGate` = `enteredWorld && !typing`). |
| §5 | **Drag threshold = 4 px radius**: reject test `(dx*dx + dy*dy) < 0x10`; also requires `IsActionInProgress(cidm, 7)` and press-inside-display; the pressed element is asked via attribute `0x3A` ("dragable") for a drag clone | **N/A-WEB** | Re-verified at acclient.c:154905-154926 (`< 0x10` at :154920-154921, `GetAttribute_Bool(v4, 0x3Au, …)` at :154926). We use HTML5 drag-and-drop (`plugins/inventory.js:1206`), whose threshold is platform-native. Do not reimplement. |
| §5 | Tooltips fire after `m_tooltipDelay` of stillness; the tooltip is an ordinary element instantiated from a DAT layout | **TASK UI-07** | Retail defaults recovered fresh: `m_tooltipEnable = 1`, `m_tooltipDelay = 0x3E800000f = **0.25 s**`, `m_tooltipDuration = 0x41200000f = **10 s**` (acclient.c:156170-156173 in the `UIElementManager` ctor), preference `Misc.TooltipDelay` with `SetPreferenceRange(0.0, 10.0)` (acclient.c:63095-63096) and `Misc.TooltipEnable` (registered at acclient.c:155717-155737). Ours: `HOVER_DELAY_MS = 400` hardcoded, no duration cap, no preference (`plugins/hover-tooltip.js:28`, `:117`). |
| §6 | **Two registries**: `gmUIHelper::RegisterElements()` for in-game widgets + eight *screens* via `UIFlow::RegisterFrameworkClass` (`0x10000001`…`0x1000000B`) | **PARITY-OK** | Structural fact; our equivalent split is plugins (widgets) vs. boot screens in `index.html`. See CORE-02 for the mode machine. |
| §6 | All eight mode IDs **collide** with element-class IDs; the `0x1000000x` space is overloaded | **PARITY-OK (era-checked)** | Independently confirmed from shipped data: `client_portal.dat` `0x14000000` (`gmDefaultMap`) keys its input maps `4, 5, 6, 0x10000002…0x1000000D`, and ActionMap `0x26000000` keys 27 categories `1…14, 16, 0x10000002…0x1000000D`. So mode IDs, element-class IDs **and** input-map IDs all share `0x1000000x`. Nothing to fix; a trap to respect. |
| §6 | Element-class ID table, "the registered set is exactly `0x01`–`0x56` minus `0x0B` and `0x55` = **84 entries**" | **PARITY-OK (verified exactly)** | `rg -n -A4 'void __cdecl [A-Za-z_0-9]+::Register\(\)' acclient.c` → 84 distinct `0x100000xx` ids, and the set is precisely `0x01`–`0x56` minus `0x0B`/`0x55`. Spot-checks: gmMapUI `0x10000026` (acclient.c:218302), gmConfigUI `0x10000028` (:215672), gmInventoryUI `0x10000023` (:222366), gmRadarUI `0x10000010` (:263714). |
| §6 | Window roster (84 classes) | **TASK UI-21** | Mapped against our 49 plugins (`plugins/index.json`). Covered or equivalent: 43. **Genuinely absent: gmBarberUI (`0x4A`), gmSlumlordUI (`0x13`), gmAbuseUI (`0x18`), gmUrgentAssistanceUI (`0x1F`), gmSpewBoxUI (`0x16`), gmPageListUI (`0x49`), gmEnvPanelUI (`0x33`), gmAdminQualitiesUI (`0x3F`)**. The 6 indicators (`0x01`-`0x06`) are covered by `plugins/status-indicators.js:5-11`; gmKeyboardUI (`0x0E`) by the on-screen vk pad (`index.html:7115-7125`). |
| §6 | Composition pattern: a window is simultaneously widget + notice sink + range checker + drop target (`gmSecureTradeUI`) | **REF-ONLY** | Our plugins compose by importing helpers instead; equivalent outcome. |
| §7 | `ControlSpecification { m_idxDevice:8, m_eSubControl:8, m_ofsKey:16 }`; `QualifiedControl { m_key, m_metamode, m_activation }` | **PARITY-OK (verified)** | acclient.h:27484-27488 and 27511-27516 read directly — exactly as documented. Our DAT-side shapes match with the on-disk addition of `action_hash` (`crates/holtburger-dat/src/file_type/keymap.rs:71-84`); JS decomposes the same way (`ui/keymap.js:343-353, 417-420`). |
| §7 | Activation bits: 1 press, 2 release, 4 tap (`<= sm_timeTap`), 8 dbl-click, `0x20` dbl-click-in-place, `0x80` axis; composite `0xA9` | **PARITY-OK + DOC-CORR-1** | Bits verified (`v14 \|= 4u` at acclient.c:672498; `0xA9` mask at :112064). The doc omits three more bits — see DOC-CORR-1. Our JS **discards `activation` entirely** (`ui/keymap.js:416-445` reads only `key`/`modifier`) even though wasm already emits it → TASK UI-02. |
| §7 | Two DBObjs: `ActionMap` (type 39, `0x26xxxxxx`) is metadata (`HashList<mapID, HashList<actionID, ActionMapValue>>` + `m_didStringTable` + `m_hashConflictingMaps`); `CMasterInputMap` (type 29, `0x14xxxxxx`) holds the bindings | **PARITY-OK (era-checked against shipped DATs)** | Both read live: ActionMap `0x26000000` → `stringTableId 0x23000005`, **27 input maps, 389 actions**, `conflictingMaps` present (e.g. map `0x10000005` conflicts with 9 others). KeyMap `0x14000000` = `gmDefaultMap`, 2 devices (Keyboard, Mouse), 9 meta-keys, **14 input maps / 133 mappings**. Our loaders hit the right namespaces (`fetch_key_map` → `eor/portal`, `apps/holtburger-web/src/lib.rs:11550-11556`; `fetch_action_map` → `eor/portal`, `:11257-11259`). |
| §7 | Metamode bit masks come from the DAT via `CMasterInputMap::MetaModeFromKey` (a `HashList<ControlSpecification, unsigned long>` lookup) | **PARITY-OK, and TASK UI-03 for robustness** | Verified at acclient.c:676538-676560 (the mask *is* the hash value). Our hardcoded table (`ui/keymap.js:348-355`) is **confirmed correct** against shipped `gmDefaultMap.metaKeys`: LShift `0x2A`→`0x80000000`; LCtrl `0x1D` / RCtrl `0x9D`→`0x40000000`; LAlt `0x38` / RAlt `0xB8`→`0x20000000`; LWin `0xDB` / RWin `0xDC`→`0x10000000`; plus two extra slots `0x08000000` and `0x04000000` we ignore. |
| §7 | Boot merges the user file then unconditionally `AddKeyMap(0x10000001)` + `AddKeyMap(1)`; shutdown saves via `CMasterInputMap::ToFileNode` | **REF-ONLY** | Our persistence is one localStorage table (`ui/keymap.js:24`, `:170-188`). Retail's two-DAT merge is not needed; the *layering* (defaults under overrides) is already ours. |
| §7 | **User bindings win per *control*, not per action** — `push_tail` on a duplicate key never overwrites, and the key is the control, so rebinding leaves the old key bound too | **ANTI-TASK AT-3** | This is a retail *bug*. Our model (override keyed by `labelHash`, `ui/keymap.js:206-219`) is the correct shape. Do not port. |
| §7 | Toggle types 1 momentary / 2 toggle / 3 one-shot (**default when absent**) / 4 held-with-repeat / 5 held-no-repeat; `sm_timeKeyRepeatDelay = 0.25 s`, `sm_timeKeyRepeatSpeed = 0.025 s`; actions 41/42/43 break run-lock | **TASK UI-02** | Re-verified in `CInputManager::FireActionEvent` (acclient.c:112031-112070): `GetToggleType` 0 → forced 3; release deactivates for `v5==1 \|\| (v5>3 && v5<=5)`; press dispatch `2→ToggleActionKey, 3→StartAction, 1→Activate+Deactivate unless activation & 0xA9, default→Activate`; run-lock break for actions 41/42/43 at :112017. Shipped ActionMap `0x26000000` toggle histogram: **Impulse 318, Momentary 53, Toggle 2, AutoRepeat 16**. Ours reads a per-action `toggle` (`ui/keymap.js:604-608`) but nothing consumes it and there is no repeat machinery. |
| §7 | **Input maps are a priority stack**, not a switch: `RegisterInputMap(mapID, cb, priority)` into a sorted list; `impri_Lowest 0`, `impri_Gameplay 1000`, `impri_UnfocusedUI 2000`, `impri_FocusedUI 3000`, `impri_DebugConsole 4000` | **TASK UI-01 (top-3)** | Ours is a **flat 42-row table with no map dimension**: `LOCAL_ACTIONS` (`ui/keymap.js:35-117`, 42 entries `0xFF000001`…`0xFF00002A`). The 10 live conflicts reported by `__diag.input.conflicts()` (`scene3d/diag/input.js:109-135`) are exactly Digit1-9 bound twice (Hotbar Slot N at `:36-44` **and** Magic Use Spell Slot N at `:97-105`) plus `Delete` bound twice (Delete Selected Spell `:58`, Magic Previous Spell `:84`). Retail resolves precisely this with per-mode maps + priority; the data to do it (27 categories, 389 actions, the conflict graph) is already reachable. |
| §7 | 16 and 32 are **not** map IDs — they are `RegisterInputHandler` arg bits (`&0x10` mouse-look list, `&0x20` key-hit handler) | **REF-ONLY** | Recorded so we do not invent map 16/32. |
| §7 | Recovered InputAction IDs: camera block `0x33`-`0x3E`; mouse buttons 7 and 10; movement 41/42/43; `0x1000005A` toggle combat (and the warning that `0x1000005A` is *also* a UI attribute id) | **REF-ONLY** | Our action ids are synthetic (`0xFF0000xx`) by design so they cannot collide with retail hashes (`ui/keymap.js:30-34`). If UI-01 lands, the retail ids become the vocabulary. |
| §7 | Rebinding UI: `UIOption_ActionKeyMap` holds default/saved/current lists; `InitiateBinding` → key-capture; `FindConflictingInputMaps` → `FindConflictingControls` → overwrite / can't-overwrite dialogs | **PARITY-OK (partial) + TASK UI-01** | We have capture + conflict warn + reset-to-default (`ui/keymap.js:243-271` `findConflictingBindings`, `:277-287` `clearBinding`, Controls tab in `plugins/options-panel.js:36-39`). Gap: our scan covers **only the user-override cache** — the code says so at `ui/keymap.js:232-234` — where retail scans the whole map set via the DAT's `conflictingMaps` graph. |
| §7 | IME/DBCS lead-byte state machine; full IME delegated to `keystone.dll` | **N/A-WEB** | Browser IME. |
| §8 | `CameraManager` is a spring-damper follower with separate `t_stiffness`/`r_stiffness`, 5-sample velocity history, `m_bAlignCameraToSlope`; `CameraSet` is the mode layer | **VERIFY-LIVE** | `stiffnessFrac` is ported exactly (`scene3d/camera_math.js:139-144`, `frac = stiffness*dt*10` clamped, snap within 2e-4 of 1.0) but the runtime carrier is **numeric and absent by default**: `?camStiffness=<0..1>`, and with no value `this._camStiffness = null` = hard-lock (`scene3d/camera.js:541-543`). Expected live with `?camStiffness=0.5`: trailing/damped camera. Check: `__diag.render` frame trace + a 1070 eye-test A/B on `?camStiffness=`. |
| §8 | **No discrete first/third-person enum** — first person is `viewer_offset == (0, 0.18, 0)`; `SetInHead` writes that offset with translational stiffness 1.0 | **PARITY-OK** | `IN_HEAD_FORWARD_M = 0.18` (`scene3d/camera_math.js:55`), `_positionInHead` (`scene3d/camera.js:1388-1395`), `CAMERA_DEFAULT_PIVOT_Z = 1.5` (`camera_math.js:58`), in-head dir-z clamp ±0.8 (`camera_math.js:72`). |
| §8 | Zoom is geometric and **asymmetric**: Closer `× (1 − v*0.2)` with a hard refuse below radius 0.5; Farther `× (v*0.2 + 1)` with **no** radius guard, clamping `\|x\|,\|y\| ≤ 10`, `z ≤ 450` | **PARITY-OK** | `RETAIL_ZOOM_IN/OUT_FACTOR` from `1 ∓ 40 × (1/60) × 0.2` (`camera_math.js:18-32`), `RETAIL_ZOOM_MIN_RADIUS 0.5` (`:41`), `RETAIL_ZOOM_MAX_RADIUS 10.0` (`:48`), `retailZoomStep` implements the asymmetry (`:92-106`). Documented deliberate deviation: we *collapse* to in-head at the 0.5 floor instead of refusing (`camera_math.js:36-41`). |
| §8 | Camera collision is a real physics sphere sweep: `makeTransition` → `init_object(player, 92)` → `init_sphere(1, &viewer_sphere, 1.0)` → `init_path` → `find_valid_position`, **`viewer_sphere` radius 0.3**, falling back to `AdjustPosition` then to snapping onto the player | **TASK UI-23** | Radius re-verified: the dword after the zeroed x/y/z is `1050253722` = `0x3E99999A` = **0.3f** (acclient.c:145543). Ours sweeps with `CAM_RADIUS = 0.5` **plus** a `BACKOFF = 0.2 m` (`scene3d/camera.js:1241-1242`) across four separate sweeps (`:1303-1330`), i.e. ~0.7 m of standoff vs retail's 0.3. |
| §8 | Mouse-look: `FilterMouseInput` is an EMA that only blends if the previous sample was within 0.25 s; then `× m_MouseLookSensitivity × 0.06666667` (1/15), negated per `m_InvertMouseLookYAxis`; a 5-frame accumulator is the dead zone; with zero delta + `m_UseMouseTurning` it re-issues a turn to the server every 0.5 s | **PARITY-OK (filter) + VERIFY-LIVE (scale)** | `filterMouseDelta` is a line-for-line port including the 0.25 s window and the pre-sensitivity ordering (`camera_math.js:178-194`), and camera.js applies it before sensitivity (`scene3d/camera.js:789-807`). But our sensitivity is our own: `POINTER_YAW_SENS = 0.0025`, `POINTER_PITCH_SENS = 0.0020` rad/px (`camera.js:207-208`) × `?mouseSens` multiplier — no 1/15 term, and `?mouseSmooth` defaults to null/off (`camera.js:544-546`). Check: side-by-side pixel-per-degree measurement against retail defaults on the 1070. |
| §9 | `gmRadarUI` keeps `SmartArray<RadarInfo>` where colour and shape **are cached snapshots**, refreshed from `OnQualityChanged` / `RecvNotice_ChangeRadarLook` | **PARITY-OK** | Ours reads `inst.meta.radarShape` / `radarColor` per frame from the live entity meta (`plugins/radar.js:67-69`, `:351-357`) — snapshot-vs-live is a non-issue for us. |
| §9 | `enum RadarBlipShape` 1 Circle … 7 XBox with aliases Default=Plus, AllegianceMember=Box, FellowshipLeader=Triangle, Fellowship=InvertedTriangle, Threat=X, ThreatAllegiance=XBox | **PARITY-OK (verified in acclient.h:6575-6591)** | All 7 shapes implemented as clip-paths (`plugins/radar.js:76-79`, `:240-266`). |
| §9 | `GetBlipShape` resolves in **priority order**: fellowship leader → fellow → allegiance → PK/PKL threat → default | **TASK UI-08** | `resolveRadarShape` (`plugins/radar.js:349-357`) has no priority chain at all — it takes the server property, else a per-kind default from `DEFAULT_SHAPE_BY_KIND` (`:80-85`) which maps **player → triangle**, i.e. every plain player renders as retail's *FellowshipLeader* glyph, and creatures render Circle where retail's default is Plus. |
| §9 | `GetBlipColor` honours `pwd._blipColor` 1–10 in switch order Blue, Gold, White, Purple, Red, Pink, Green, Yellow, Cyan, BrightGreen, then falls through Portal → Vendor → Creature → Admin → PK → PKLite → Fellowship | **PARITY-OK (1–9) + TASK UI-09** | Switch re-read at acclient.c:262716-262770: `case 10:` → BrightGreen. Our table matches 1–9 exactly and keys BrightGreen at **`0x10`** (`plugins/radar.js:54-65`) — which is right for **ACE** (`ACE.Entity/Enum/RadarColor.cs:15` declares `BrightGreen = 0x10`) and wrong for retail. Fix accepts both. The fall-through chain (portal/vendor/creature/admin/PK/PKLite/fellowship) is **absent** on our side. |
| §9 | Blips are raw `SurfaceWindow::FillArea` pixel runs, not sprites, scaled by an altitude intensity factor, suppressed by `m_bRadarBlank` | **N/A-WEB** | CSS shapes are the browser-native equivalent. Altitude intensity: ours has none (folded into UI-08 as a sub-item). |
| §9 | `gmMapUI` has **no DAT map imagery lookup and no zoom**; it reads four attributes `0x1000004E`-`0x10000051` as the marker rect and instantiates **53 hardcoded rollover regions** from `s_rgLocations[53]` | **TASK UI-10** | Verified: `gmMapUI::LocationRolloverInfo s_rgLocations[53]` at acclient.c:39939-39995, `{x, y, w, h, L"name"}` in the marker-rect pixel space. Our map has pan+zoom (a deliberate improvement, `plugins/map-panel.js:406-416`) but **zero rollovers**. Full 53-row table transcribed in UI-10. |
| §9 | `PlaceMarkerOnMap` = `m_x0 + GetWidth/-2 − (int64)((m_x1 − m_x0 + 1) * (x*10 + 1024) * −0.00048828125)`, with **Y inverted** via `2047.0 − (y*10 + 1024)` | **TASK UI-11** | Formula re-verified verbatim at acclient.c:218164-218172. Ours normalises game units over `WORLD_SPAN` (`plugins/map-panel.js:208-215`) with Y inverted — same centre (world 24384 → 0.5 both ways) but retail's span is 2048 map units = **49152** game units vs our 48768, a 0.79 % radial scale error, and we do not subtract half the marker size. |
| §9 | Persistence is `ShortCutManager { ShortCutData* shortCuts_[18] }` (18 item slots) with spell shortcuts held **separately** as `favorite_spells_[8]` | **PARITY-OK (18) + TASK UI-24 (spells)** | 18 slots: `SLOTS_PER_ROW 9 × ROW_COUNT 2` (`plugins/hotbar.js:74-76`), server-hydrated from `PlayerDescription.shortcuts` (`apps/holtburger-web/src/lib.rs:30089-30093`, `:34182` `add_shortcut`, `:34206` `remove_shortcut`, `:34223` `player_shortcuts`). Spell bindings, however, live only in localStorage (`plugins/hotbar.js:248-254`, key `holtburger_hotbar_v1`) because the spell-bar opcodes are **commented out** (`crates/holtburger-protocol/src/opcodes.rs:537-542`). |
| §9 | Each toolbar slot is a one-item `UIElement_ItemList`, which is why drag-to-toolbar needs no special case | **REF-ONLY** | Elegant, but our MIME-based drop validator achieves the same generality (`plugins/drop_item_flags.js:60+`). |
| §9 | `UseShortcut` branches three ways: target-mode → `ExecuteTargetModeForItem` + clear; else `ItemHolder::UseObject`; else `SetSelectedObject` | **VERIFY-LIVE** | Ours dispatches on the bound kind (`plugins/hotbar.js:512`, `:645`, `:673`). Retail's *target-mode* arm (a pending "click a target" state) is the piece I could not confirm exists on our side. Check: bind a targeted-use item, click the slot, observe whether a target cursor arms. |
| §9 | Container model is an explicit doubly-linked chain (`parentContainerID`, `childList`, `parentList`) — a backpack in a backpack is a second `UIElement_ItemList` | **PARITY-OK** | `plugins/container-panel.js` + `world-objects/container.js` model the same nesting. |
| §9 | Four exclusive mode booleans (`containerList`, `vendorItemList`, `shortcutList`, `salvageList`); the three non-container modes skip `SetWaitingState`; `SendNotice_BeginDrag` is told `vendor \|\| salvage \|\| shortcut` so downstream knows the drag is **virtual** | **PARITY-OK + gap** | `DropItemFlags` in `plugins/drop_item_flags.js:33-41` matches retail bit-for-bit (NONE 0, CONTAINER 1, VENDOR 2, SHORTCUT 4, SALVAGE 8 — verified against `acclient.h:6765-6774`). We add `TRADE 0x10` (retail routes trade as a container drop) and we **lack `IS_ALIAS = 0xE`**, retail's "this drag is virtual" composite. Folded into UI-24 as a sub-item. |
| §9 | Drop protocol is the one-method `ItemListDragHandler`; returning **true means "handled, stop"**; three visual states — reject `0x10000041`, accept `0x10000040`, container-with-empty-slots `0x10000046` | **PARITY-OK** | Our `validateDragMimeForTarget` returns `{ok, reason, matchedMime}` and callers drive the highlight (`plugins/drop_item_flags.js:60-75`) — same contract, three states available. |
| §9 | Implementors list; `gmPaperDollUI` registers exactly **24** equipment slots individually | **REF-ONLY** | Useful as a completeness checklist for our paperdoll. |
| §10 | Every `UIOption_*` carries `m_default`/`m_saved`/`m_current` and **three mutually exclusive persistence targets**: `m_propName` (BaseProperty) → `m_playerOption` (PlayerOption enum) → `m_prefName` (client-local), dispatched in that order | **PARITY-OK (shape) + TASK CORE-03** | All three targets exist in our options panel: server CharacterOptions over the wire, and localStorage for client-local keys (`plugins/options-panel.js:26-47`). Apply/OK/Cancel semantics match (`options-panel.js:52-56`). Gap is the *registry* (CORE-03), not the shape. |
| §10 | `UIOption_CheckboxBitfield64` is a listbox of `{llMask, siLabel, siTooltip}` rows editing one 64-bit word — how the chat filter is authored | **TASK UI-15** | Ours has 4 hardcoded tabs (All/Local/Tells/Channels) instead of a 64-bit mask editor (`plugins/chat-panel.js:30-41`, `:653-681`). |
| §11 | `Font : DBObj` is a **bitmap atlas** (fg surface + separate bg/shadow surface, `maxCharHeight/Width`, `m_BaselineOffset`, border pixel counts) | **PARITY-OK** | `ui/ac_font.js:595-604` carries exactly those fields plus fg/bg atlas canvases; shadow rendered at `oy=1` (`ac_font.js:737-742`). |
| §11 | **There is no pair kerning**; advance is the three-term per-glyph sum `m_Width + m_HorizontalOffsetBefore + m_HorizontalOffsetAfter`; `tagKERNINGPAIR` is unused | **PARITY-OK** | Identical arithmetic: `penX += g.h_off_before; … penX += g.width + g.h_off_after` (`ui/ac_font.js:679-682` measure, `:731-757` draw). |
| §11 | Unicode lookup is a dense `characterMap[chr − minUnicodeChar]` with a range guard; **on a miss it retries once with `'?'` (63)** | **ANTI-TASK AT-5** | Ours falls back through a CJK runtime and then to the system font via `measureText`/`fillText` with a cached advance (`ui/ac_font.js:613-627`, `:712-726`). Strictly better than a `?`. |
| §11 | `Font` carries **border pixel counts** | **TASK UI-18** | Our own code flags the gap twice: "`num_horizontal/vertical_border` aren't surfaced from the wasm side yet" (`ui/ac_font.js:686-693`) and "the atlas inset isn't wired (defer-wasm)" (`:743-750`). |
| §11 | `GlyphList`: each `Glyph` carries its own `Font*`, `RGBAColor` and `TextTag*` so colour/font/hyperlink change mid-run without markup; `Recalculate` memoises on `m_cxLastRecalcWidth`/`m_bOneLine`, `m_nFirstInvalidPosition` bounds relayout, `m_bTrimFromTop` is the chat scrollback ring | **N/A-WEB (layout) + TASK UI-20 (TextTag)** | Per-run colour/font is what a DOM span gives us for free; incremental rewrap is the browser's job. The `TextTag` half is a real feature gap — see UI-20. |
| §12 | `UIElement_Browser` loads `Trowser.dll`, is a real child HWND DC-redirected into the UI surface, refcounts fullscreen suppression, and navigates via attribute 173 | **N/A-WEB** | We *are* the browser. |
| §13 | `StringInfo` references a `StringTable` by DID + string id, with **variables and a literal override**; `StringTableMetaLanguage` supports escapes, gendered meta letters, singular/plural, capitalization, variable substitution | **TASK UI-19** | `resolveStringInfo` reads only `string_id` + `table_id` and drops variables and the literal override (`ui/ac_layout.js:416-433`). `ui/ac_strings.js` has no metalanguage renderer (exports at `:36,80,97,131,153,203,219`). Retail's letter tables are `CLanguageInfoInterface::GetMale/Female/TreasureMetaLetters` (08 §13, 0x422230-0x4222D0). |
| §13 | `ChatInterface::ProcessCommand` keeps a **100-entry** history, resets `m_LastInputHistoryPos = −1`, trims from the front while `m_num > 0x64` | **TASK UI-12** | Re-verified at acclient.c:288776-288790 (`AddToEnd`, then `while (m_InputHistory.m_num > 0x64) RemoveOrderedByIndex(0)`; no dedupe). Ours: 64-entry ring **with** consecutive-dedupe, and an in-code comment that misstates retail's size as 32 (`plugins/chat-panel.js:906-922`, `:965-966`). |
| §13 | `OnChatCommand` normalisation: `/` → rewrite index 0 to `'@'` → `DoCommand`; `@` → `DoCommand`; **`:` or `;` → replace the leading char with a space and *prepend* `"@emote"`** | **TASK UI-13** | `routeSlashCommand` handles `@` (pass-through) and `/` (local table, else forward as `@cmd`) at `index.html:5987-6275`, but there is **no `:`/`;` → emote rewrite anywhere** (grep of `index.html` chat block). |
| §13 | Plain text becomes speech; inbound display goes through `ClientSystem::AddTextToScroll` — **offered to the plugin with an "eat" flag**, then profanity-filtered (`TabooTableAdaptor::CheckCensorsW`), optionally timestamped, logged, then broadcast as `SendNotice_DisplayFinalStringInfo` | **TASK CORE-10** | Our inbound path is `appendChatLine(text, category)` → DOM (`index.html:4732-4744`) with no plugin hook and no eat. Outbound has no plugin hook either (the router is host-private). This is the single most-used Decal capability and we lack both directions. |
| §13 | Each `ChatInterface` filters on a **64-bit** `m_llTextTypeFilter`; default init sets all 64 bits then clears **bit 26** | **TASK UI-15** | See §10 row. The "all bits minus 26" default is the concrete starting value. |
| §13 | Clickable content is `TextTag`s attached to glyphs — `TextTag_DID`, `TextTag_IID`, `TextTag_IIDEnum`, `TextTag_IIDString` | **TASK UI-20** | Zero hits for `TextTag` anywhere in `apps/holtburger-web/**` (js + html). Click notices are 100018-100021 (§14). |
| §14 | `NoticeRegistrar` holds a lazily-built table of *pointers to lists*; **`CWeenieObject : LongHashData, NoticeRegistrar` — every game object is itself a notice registrar** | **REF-ONLY** | Our equivalent is the single `EventTarget` bus in `plugins/api.js:387-404` plus per-plugin subscriptions. Per-object registrars would be a regression in a GC'd language. |
| §14 | Each `SendNotice_X` is generated boilerplate: constant notice ID + **fixed vtable slot**; `gmNoticeHandler` is an empty subclass whose content is a ~160-entry vtable | **REF-ONLY** | Recorded; nothing to port. |
| §14 | Notice IDs fall in two bands: **100000-100023** engine `ECM_*` (100015 = `ECM_Physics::SendNotice_BeingDeleted`, 100012 unused, 100023 max) and **5100001-5100164** gameplay `CM_*` (5100016 PlayerDescReceived, 5100027 SetCombatMode, 5100046 OpenVendor, 5100114 ClearChatBuffer, 5100118 ItemListBeginDrag, 5100163/4 Save/LoadUI …) | **REF-ONLY (naming oracle)** | This is the best available *vocabulary* for our `ClientEvent` kinds. Our 30-odd kinds are numbered ad-hoc (`plugins/api.js:16-47`); the retail bands say what the canonical event set is. Cross-ref: UI-16 uses 5100163/5100164, UI-20 uses 100018-100021, CORE-10 uses 100022 `DisplayFinalStringInfo`. |
| §14 | The 5100xxx constants are **address-encoded** in the decompilation (`(char*)&loc_4DD250 + 2`), so grepping the decimal finds nothing | **REF-ONLY (trap)** | Confirmed relevant to anyone re-deriving the list. |
| §15 | `ClientUISystem::OnStartup` just flags `APIManager::SetUIReady(1)`; `DialogBoxGateway : CPluginPrototype` brackets native dialogs; `ClientUISystem` is thin glue | **REF-ONLY** | See §3 (plugin API) for the substance. |

### 1B. `08-client-core.md`

| § | Claim | Disposition | Evidence |
|---|---|---|---|
| §1 | `WinMain` order: `Debug::Init("ac",…,0xE08)` → `AddDataErrorHandlers` → cmdline → `ConfigureFPU` → `s_eProgramType = 0x40000001` → `APIManager::Init` → `Version::Init` → `ACCFactory::Init` → construct `gmClient` | **REF-ONLY** | Note the ordering fact that matters: **`APIManager::Init` (plugin load) runs before UI, net and DAT init**. Ours loads plugins after wasm init and before `mountBar` (`index.html:1714-1755`, `:1982`). |
| §1 | Nine `Client` switches (`account`, `debug`, `host`, `language`, `outport`, `port`, `prefs`, `rodat`, `usemem`) + seven `gmClient` switches; **`-logfile` is registered nowhere** (string-compared into an empty branch); `-debug <n>` is a **replace**, not an OR | **REF-ONLY + CORE-05 analogy** | Our analogue is the URL-flag surface: **532 documented rows** (`docs/url-flags.md`), 442 `params.get(...)` sites, of which **78 use `!== "off"`** = default-ON. Retail's tiny, typed switch set is the counter-example that motivates CORE-05. |
| §1 | `Client::Init` order: new-handler → single-instance semaphore → Win9x check → `Timer::Init`/`Random::Seed` → GlobalEventHandler/QualityRegistrar → `InitPreferences` → `InitNet` → `InitDatabase` (DAT mount) → language → `InitUI` (device, sound, SmartBox, UIElementManager, UIFlow) | **VERIFY-LIVE** | Load-bearing ordering claim: **preferences before net before DAT before UI**. Ours interleaves (wasm init → resource source → plugins → bar → scene). Expected live symptom of the difference: plugins that mount before `init_resource_source` resolves see `fetch_layout` return null — and our code already carries an 8×2 s retry loop for exactly that (`ui/ac_layout.js:71-80`). Check: count `[ac-layout]` null-returns during a cold boot with `?nosw=1`. |
| §2 | `Client::Run` = `while (UseTime())` gated on `NetError::None`; **two functions defeat Hex-Rays and they are the two frame pumps** | **REF-ONLY** | Provenance, not behaviour. |
| §2 | **(2015-recovered)** frame order: `Timer::update_time` → `Device::DoEventLoop` → `ClientNet::UseTime` → `ProcessLogonEventQueue` → `PacketController::UseTime` → `CLCache::UseTime` → `UIElementManager::UseTime` → `SmartBox::UseTime` (world) → `PrepareGraphicsDevice`/`StartFrame` → `SmartBox::Draw` → `EndFrame` → `DoFrameSleep` | **VERIFY-LIVE (weakened by the 2015 caveat)** | Ours: net/input pump at frame *top* under `?singleDriver` (`scene3d/loop.js:1652-1692`, which documents the deliberate top-vs-bottom choice), then cell visibility → cull → PVS → clocks → … → render. The retail ordering invariant we do **not** hold is "resource-cache drain before UI and world tick" → CORE-04. |
| §2 | `Client::KeepUIAlive` is the same pump minus `ProcessLogonEventQueue`/`PacketController`, and **still runs the full world tick and render** — which is why the 3D scene animates behind the connecting screen | **PARITY-OK (behaviourally)** | Our rAF loop runs continuously through login; the login form is a DOM overlay. Same outcome. |
| §2 | The indirect call resolves to `CLCache` slot 18 = `UseTime` via the `AsyncCache` sub-vptr at +4; per-frame chain `Client::UseTime → CLCache::UseTime → ThreadedCache::UseTime → DBCache::UseTime`, where the **25 ms reply-queue drain** lives (`while (GetTickCount() - v2 < 0x19)`) | **TASK CORE-04** | Ours has a frame budget but only for three *deferrable* groups (PVS, SKY, NAME): `?frameBudget` default **9 ms**, `?deferHz`, `RP3_MAX_DEFER_FRAMES` staleness ceiling (`scene3d/loop.js:1551-1590`, `:1599-1601`, `_rp3ShouldRun` at `:1628-1640`). The resource/decode path is **not** in that budget: `src/decode_admission.rs` is job/byte-shaped and installed **neutral** — `new(usize::MAX, usize::MAX, 0)`, an unbounded gate that can never enqueue (`decode_admission.rs:33-37`). |
| §2 | `SceneTool::StartFrame` is a 5-byte tail-call thunk; `BeginScene` is almost certainly its target; `DBCache::PreFetchStatic` is unreferenced; `UIFlow::Update`'s caller is unresolvable | **REF-ONLY** | Archaeology. |
| §2 | `Device::DoFrameSleep` always `Sleep(0)`; applies a ~99 ms budget when `m_bIsActiveApp` is false (~10 fps inactive); **no frame cap when active** | **N/A-WEB + ANTI-TASK AT-6** | Browsers throttle rAF in hidden tabs already, and we deliberately route the *session heartbeat* off the main thread so throttling cannot kill the session (`scene3d/keepalive_worker_client.js:1-33`). Our blur handling clears keystate so a held key cannot walk forever (`index.html:6970-6984`) — the real hazard retail's model doesn't have. |
| §2 | `MIN_QUANTUM = 1/30` has **100 duplicate initializers**; only `_93` (physics) and `_97` (animation) are live | **PARITY-OK (cross-ref wave1-A)** | `MIN_QUANTUM` with the sub-quantum **carry** is implemented (`crates/holtburger-core/src/client/movement/system.rs:1174`, `:1213`, `:4117-4143`). Physics ownership is Agent A's; recorded here only to close the ledger row. |
| §3 | COM lookalike: `Turbine_GUID` layout-identical to `_GUID`, 6-slot root `Interface` vtable (3 stdcall IUnknown + 3 thiscall), `InterfaceSystem` GUID→factory registry, `TResult` = HRESULT-alike | **N/A-WEB** | ES modules + `Object.freeze` facades. The one durable lesson is in §3 below: binary-compatible IUnknown heads are *what made the plugin API possible* — our analogue is a stable, versioned JS facade. |
| §4 | UI-mode state machine owned by `UIFlow`/`gmUIFlow`; **eight** registered modes; `0x10000003` `gmDataPatchUI` is the **initial** mode; transitions are `UIFramework::QueueUIMode` **consumed on the next `UIFlow::Update`** | **TASK CORE-02** | Ours is a single string scalar with a documented race: `setBootState` (`index.html:5356-5372`) drives `init → form-shown → connecting → kicking → reconnecting → char-list-ready → spawning → in-world` (+ `error`, + `ready`), and `'ready'` and `'in-world'` "can arrive in EITHER order", forcing a `__sceneReadyEverFired` latch — "live-reproduced 2026-07-18" (`index.html:5360-5364`). Retail's design avoids this by construction: separate axes + queued single-consumer transitions. |
| §4 | `0x10000004/5/6` are **not** UI modes — they are input-map IDs / DAT enum IDs / element-class IDs reusing the same well-known-ID space | **PARITY-OK (era-checked)** | Directly confirmed from shipped `client_portal.dat`: `gmDefaultMap` input maps include `0x10000004`, `0x10000005`, `0x10000006`; ActionMap `0x26000000` carries 27 categories including all of `0x10000002`…`0x1000000D`. |
| §4 | `CharGenState` submitted via `Proto_UI::SendCharGenResult`, verdict via `RecvNotice_CharGenVerificationResponse` | **PARITY-OK** | `client.characters.createCharacter(build)` → `sessionHandle.sendCharGenResult(build)` with the CharGen DAT catalog (`plugins/api.js:614-649`). |
| §5 | Two different things are called "CommandInterpreter": the class of that name is the **movement/keyboard** interpreter; chat/slash commands live in `ClientCommunicationSystem::OnChatCommand → DoCommand` over a case-insensitive `IntrusiveHashTable` built in `InitializeCommands` | **REF-ONLY (trap)** | Worth knowing: our `scene3d/input.js` header already calls itself "the `ACCmdInterp` analog" (`input.js:8-17`), i.e. the movement interpreter — correct usage. |
| §5 | **116 command tokens** registered | **PARITY-OK (verified exactly) + TASK UI-14** | I mechanically extracted the registrations from acclient.c:426430-430260: **exactly 116** tokens, in registration order. Ours implements ~25 (`index.html:5968-6275`): tell/t/send/whisper/w, reply/r/rp, retell/rt, say/s, me, a/f/p/m/v/co/cv/h, cg/ct/clfg/crp/society/olthoi, plus ~303 soul-emote tokens. |
| §5 | "`bug` does not exist"; the prose list omits `all`, `co-vassals`, `fellows` | **PARITY-OK (confirmed) + DOC-CORR-2/3** | My extraction contains no `bug`, and does contain `all`, `co-vassals`, `fellows`. Two further corrections below. |
| §5 | Nothing GM-only ships; developer leftovers are `loc`, `render`, `framerate` + `DebugConsole`/`ProfilerUI` | **PARITY-OK** | Handler map confirms `loc → DoLoc`, `render → DoRenderOption`, `framerate → DoFrameRate`. |
| §5 | A separate `GlobalRegistry::RegisterCommand` console registry exists, exposing `LoadPreferences`/`SavePreferences` | **REF-ONLY** | Our analogue is the `window.__*` debug surface + `__diag`. |
| §6 | `APIManager::Init` reads HKLM `…\Asheron's Call\1.00\ACPlugin`, `LoadLibraryA`, `GetProcAddress("CreateACPlugin")`, hands over an `IAsheronsCall` and receives an `IACPlugin` — the sanctioned Decal injection point | **REF-ONLY → §3** | `pfCreateACPlugin` typedef confirmed at acclient.h:62492. |
| §6 | **52 methods**, of which **16 are `return E_FAIL` stubs**, and worse: `GetCombatMode`/`GetVendorID` are COMDAT-folded into one body that returns `S_OK` **without writing the out-param**, so `UseObjectOn` always takes its failure path | **REF-ONLY → §3 (this is the single most important lesson for our API)** | I enumerated the 36 `IAsheronsCallImpl::*` symbols still visible in the decomp; the doc's 52 comes from the vtable extent + PDB publics, which I could not independently recount, so I take the count as given and use the *method list* rather than the number. |
| §7 | Preferences are **`UserPreferences.ini`** next to the exe (plain `WritePrivateProfileStringA`, section `"Default"`), saved on exit; `-prefs` overrides the path | **N/A-WEB** | localStorage. |
| §7 | Registration is **two-tier**: `UserPreferences::RegisterPreference` (44 sites) binds a C++ address to a name; `UIPreferences::AttachPreference(name, dataType, stringTableID, displayToken, tooltipToken)` (36 sites) additionally exposes it in the options UI, with `SetPreferenceRange` for floats (3 = float, 4 = bool) | **TASK CORE-03** | Verified live at acclient.c:155717-155737 (`RegisterPreference` for tooltip delay/enable) and acclient.c:63093-63096 (`AttachPreference` + `SetPreferenceRange(0,10)`). Ours has **no registry**: ~20 distinct localStorage keys in three naming conventions (`holtburger_graphics_v1`, `holtburger_camera_v1`, `holtburger_keybindings_v1`, `holtburger_character_options_v1`, `holtburger_hotbar_v1`, `holtburger_combat_bar_v1`, `holtburger_ui_bar_v1`, `holtburger_ai_key_v1`, `hb.options.audio.v1`, `hb.options.autoReconnect`, `hb.lore.discovered.v1`, `hb-inv.slots-view.checked.v1`, `hb.window.<id>` (`ui/ac_window_position.js:31`), `hb_chat_panel_*`, `hb.fellowship.opts`, `rynth.atlas.v1`, …). |
| §7 | Recovered preference groups: `Net_*`, `Render_*` (16), `Sound_*` (8), `Input_*` (InvertMouseLookYAxis, MouseLookSensitivity, MouseLookSmoothingAmount, UseMouseTurning), `Display_*` (FullScreen, Resolution, SyncToRefresh, RefreshRate), `Camera_*` (AdjustmentSpeed, AlignToSlope, Stiffness), `Misc_Tooltip{Delay,Enable}`, `UI_ChatFont{Face,Size}`, `International_UseIME` | **PARITY-OK (checklist) + TASK UI-22** | This is the canonical settings taxonomy and we should adopt the names. Direct hits already present: mouse sensitivity/invert/smoothing (`scene3d/camera.js:544-551`), camera stiffness (`:541-543`), audio gains (`plugins/options-panel.js:29-32`). Missing as *settings*: `Camera_AdjustmentSpeed` (hardcoded 40.0, `camera_math.js:18`), `Camera_AlignToSlope`, `Misc_Tooltip*` (UI-07), `UI_ChatFont*`. |
| §7 | Complete registry inventory: exactly 3 Turbine-owned accesses (+1 dead `LookFile` read); `RegEdit` has **no SetValue** | **N/A-WEB** | No registry in a browser. |
| §8 | `TimeSource_QueryPerformanceCounter` is the sole clock; it cross-checks QPC against `timeGetTime` and, on a >0.5 s divergence, **permanently latches** a `timeGetTime` fallback; rebases its reference every 10 s; clamps monotonically | **N/A-WEB (the QPC workaround) + TASK CORE-01 (the model)** | `performance.now()` needs no cross-check. The part that *does* transfer is the model in the next row. |
| §8 | `Timer::update_time` publishes `local_time` (raw elapsed) and **`cur_time` = elapsed + `m_rExternalOffset`** (the server-time sync offset) — both doubles in seconds since `Timer::Init`; `cur_time` has 337 references | **TASK CORE-01 (top pick)** | Ours switches **clock domains** instead of applying an offset: `WorldState::current_server_time()` returns `sync.server_time + sync.local_time.elapsed()` once synced, but **UNIX-epoch wall-clock** before the first TimeSync (`crates/holtburger-world/src/state/types.rs:926-947`). ACE's TimeSync payload is `Timers.PortalYearTicks` (`ace-server/…/NetworkSession.cs:938`), seeded from `DerethDateTime.UtcNowToEMUTime` = seconds since **2017-01-31** (`ACE.Common/DerethDateTime.cs:33`, `:1062`; `Entity/Timers.cs:47`) ≈ 3.0e8, versus epoch ≈ 1.78e9 — a **~1.5e9 s (≈47 year) step down** at the first sync. Consumers that stamp deadlines across it: `set_entity_prune_deadline` / eviction sweep (`state/liveness.rs:381`, `state/mutations.rs:664`, `:1951`), i.e. any entity whose prune deadline was stamped pre-sync becomes un-prunable. Our own code documents that the pre-sync window is reachable ("an entity spawn during the login → in-world window", `types.rs:937-939`). |
| §9 | **No crash handling is installed**: the 100 MB emergency pool, `TurbineExceptionFilter` and Watson are all gated on `DebugFlags & 0x200`, which `Debug::Init` clears via `&= ~0xE08`; all four `SetUnhandledExceptionFilter` sites are dead | **ANTI-TASK AT-7** | We are strictly ahead: `scene3d/webgl_context_recovery.js` (197 lines) recovers device loss, and the plugin loader isolates faults per-plugin (`plugins/loader.js:664-673` swallows+logs hook throws; `:607-618` skips a failed import without breaking the rest). Nothing to port. |
| §9 | `Logger`/`LogController` fan out to console / OutputDebugString (only when `IsDebuggerPresent`) / text files; `g_strEmailAssertions` is **empty** in this build | **N/A-WEB** | `console` + `__diag` rings (`scene3d/diag/*`). |
| §9 | No local anti-debug/anti-tamper/memory-integrity code, **but** a cooperative server-driven audit: `Handle_Admin__Recv_QueryPluginList` / `Handle_Admin__Recv_QueryPlugin` answer with the loaded plugin's name/author/e-mail/webpage, or `L"3rd party API not in use."` | **TASK CORE-06** | Opcodes agree across three sources: `Admin_QueryPluginList 0x02AE` / `QueryPluginListResponse 0x02AF` / `Admin_QueryPlugin 0x02B1` / `QueryPluginResponse 0x02B2` / `Admin_QueryPluginResponse 0x02B3` (chorizite `GameEventType.generated.cs:170-174`, `GameActionType.generated.cs:308-310`; ACE `GameEventType.cs:85-87`, `GameActionType.cs:150-151`). **Both** ends are unimplemented: ours commented out (`crates/holtburger-protocol/src/opcodes.rs:510-512`, `:1024-1028`), ACE has the enum only (no handler files). |
| §10 | `PStringBase` metadata at negative offsets: `+0 vfptr, +4 refcount, +8 capacity, +12 cached hash (init −1), +16 length, +20 data`; growth powers of two to 0x10000 then 64 KB; COW with `break_reference` | **N/A-WEB** | JS strings. |
| §10 | `SmartArray`/`IntrusiveHashTable`/`NIList`; `_STL` is STLport with 8-byte size classes to 0x80 | **N/A-WEB** | — |
| §10 | `PSUtils` path/parsing toolbox | **N/A-WEB** | — |
| §11 | **The process creates one thread** (`ThreadedCache`); `CreateAndRunDebugWorkerThread` can never run; `WinInetAsyncHttpClient` was dead-stripped | **REF-ONLY** | Ours runs up to four workers: net (`scene3d/net_worker.js`), bake (`bake_worker.js`), keepalive (`keepalive_worker.js`), plus the wasm threads experiment. Retail's single-worker design is a *lower* bound, not a target. |
| §11 | Locks: `SharedCriticalSection`, `CSpinLock<512,0>` in the time source, four raw `InitializeCriticalSection` all in linked-in DirectShow code, `CSpinLock<1048576,0>` on `GrowBuffer::m_pFreeListLock` | **N/A-WEB** | — |
| §12 | `KeyStone` is a third-party AC2-derived XML/HTML UI runtime hosting the in-game Help browser and Plugin Manager; it hooks `TranslateAcceleratorA`/`DispatchMessageA` to steal keyboard focus | **N/A-WEB + REF-ONLY** | One transferable idea: retail shipped a **Plugin Manager window** (`OpenPluginManager` 0x556ED0, `IsPluginManagerOpen` 0x557140). We have no in-client plugin manager UI — folded into CORE-08 as a sub-item. |
| §13 | `Client::Cleanup` order: CleanupUI → CCommunicationSystem → CleanupNet → language → CleanupDatabase → CleanupPreferences (saves the INI) → QualityRegistrar → GlobalEventHandler → InterfaceSystem → SoundManager | **PARITY-OK (shape)** | Ours frees the wasm session on `pagehide` so the WS closes deliberately (`index.html:5381-5390`). No multi-stage teardown needed; note that **nothing persists pending UI state on unload** — folded into UI-16. |
| §13 | `CLanguageInfoInterface` is grammar/formatting, not string tables: numerals, separators, grouping, neg-format, leading zero, base, singular test, and `GetMale/Female/TreasureMetaLetters` driving AC's procedural item-name metalanguage | **TASK UI-19** | Same task as §13 of 05-ui; this row supplies the letter-table entry points. |
| §13 | `ProgramTypeSystem::s_eProgramType = 0x40000001`; the comparisons against `0x80000001/2` are dead in the client (server/tool roles) | **REF-ONLY** | Explains dead branches in shared code. |
| §14 | The PDB yields 16,232 `S_GPROC32` + 23,716 `S_LPROC32` symbols, 1,091 modules, **line info** (1.83 MB C11 records, 1,460 source paths), and reveals the four-layer `PORTAL`/`ENGINE`/`GAME`/`AC` library split | **REF-ONLY (high value)** | `game_ui_misc` is the largest single module group (103 objs) — i.e. **the UI is the biggest single body of code in the client**, which is a useful prior for how much of our remaining parity work is UI-shaped. |
| §15 | IDA's `Client` struct field names are offset-shifted and wrong (`-account` writes the field IDA calls `m_fReadOnlyDatFiles`, etc.) | **REF-ONLY (trap)** | — |
| §15 | 100 `MIN_QUANTUM` copies; check the address you cite | **REF-ONLY (trap)** | — |
| §15 | "Do not treat any published main-loop ordering — including the one in these documents — as observed fact" | **REF-ONLY (honoured)** | This is why every §2-derived row above is VERIFY-LIVE, never PARITY-OK. |

---

## 2. TASKS

Ranked list first (top-10 by payoff ÷ effort × confidence):
**CORE-01, UI-01, CORE-07, CORE-02, CORE-08, CORE-10, UI-14, UI-05, CORE-03, UI-08.**

---

### CORE-01 — One clock, one domain: `cur_time = elapsed + offset`
**Source:** 08 §8.
**Retail:** `TimeSource_QueryPerformanceCounter` is the *sole* clock. `Timer::update_time`
(acclient.c:75413) publishes two doubles, both seconds since `Timer::Init`:
`Timer::local_time` = raw elapsed, and `Timer::cur_time` = `local_time +
m_rExternalOffset`, where the offset is the server-time sync delta.
`ComputeElapsedTime` clamps monotonically and rebases its reference pair every
10 s. There is exactly one domain; a sync moves the *offset*, never the base.
**Holtburger today:** `WorldState::current_server_time()`
(`crates/holtburger-world/src/state/types.rs:926-947`) has two branches in two
different domains:
* synced → `sync.server_time + sync.local_time.elapsed()`, where
  `sync.server_time` is ACE's `Timers.PortalYearTicks`
  (`ace-server/Source/ACE.Server/Network/NetworkSession.cs:938`), seeded from
  `DerethDateTime.UtcNowToEMUTime` = seconds since 2017-01-31
  (`ACE.Common/DerethDateTime.cs:33`, `:1062`; `Entity/Timers.cs:47`) ≈ **3.0e8**;
* pre-sync → `web_time::SystemTime::now().duration_since(UNIX_EPOCH)` ≈ **1.78e9**.

The step at the first TimeSync is therefore ≈ **−1.5e9 s (≈47 years)**. Deadlines
stamped from this clock and swept against it: `state/liveness.rs:381`
(`tick` → `sweep_eviction_queue` / `maintain_visibility_prune_deadlines`),
`state/mutations.rs:664`, `:1951`. A prune deadline stamped pre-sync is
~47 years in the future once the sync lands, so **those entities never evict**.
The pre-sync window is real and documented in our own code
(`types.rs:937-939`: "e.g. an entity spawn during the login → in-world window").
**Proposed change:** make the function domain-stable — keep a session-start
`Instant`, return `session_elapsed + offset`, where `offset` starts at 0 and is
*set* (not switched) by `set_server_time_sync` to `server_time − session_elapsed`.
Pre-sync callers then get a small monotonic number, and every previously stamped
deadline stays valid because only the offset moved. Add the monotonic clamp
retail has.
**Payoff:** removes a whole class of impossible-timestamp bugs from the entity
retention path — the same symptom family as "entities linger / world feels
stale". Also makes `serverTime()` (`apps/holtburger-web/src/lib.rs:31179`) safe
for plugins and rynth to difference.
**Effort:** S (one function + one setter + tests).
**Validation:** unit test in `holtburger-world` asserting (a) monotonicity and
(b) continuity across `set_server_time_sync` (|Δ| < 1 ms), plus an assertion
that a deadline stamped before the sync still expires at the intended wall time.

---

### UI-01 — Input-map priority stack and map-scoped bindings
**Source:** 05 §7 (+ §5 focus row).
**Retail:** bindings are **per input-map**, and maps form a **priority stack**:
`RegisterInputMap(mapID, callback, priority)` inserts into a sorted list
(acclient.c:111176) with `enum InputMapPriority` (acclient.h:5769) =
`impri_Lowest 0`, `impri_Gameplay 1000`, `impri_UnfocusedUI 2000`,
`impri_FocusedUI 3000`, `impri_DebugConsole 4000`. Focus changes push the
focused element's maps to 3000 (`SetFocusElement`, acclient.c:152152). The same
physical key can therefore mean different actions in different modes with no
conflict — which is exactly how retail binds Digit1-9 to both quickslots and
magic spell slots. The DAT even ships the conflict graph: `ActionMap`'s
`m_hashConflictingMaps` (acclient.h:27626).
**Holtburger today:** one flat table, no map dimension: `LOCAL_ACTIONS`, 42 rows
`0xFF000001`…`0xFF00002A` (`ui/keymap.js:35-117`). `__diag.input.conflicts()`
(`scene3d/diag/input.js:109-135`) reports **10** real collisions: Digit1-9 bound
to both `Hotbar Slot N` (`:36-44`) and `Magic: Use Spell Slot N` (`:97-105`),
plus `Delete` bound to both `Delete Selected Spell` (`:58`) and
`Magic: Previous Spell` (`:84`). Today they are disambiguated only by ad-hoc
stance checks inside handlers, and `findConflictingBindings` scans **only** the
user-override cache (admitted at `ui/keymap.js:232-234`).
**Data is already reachable** (verified against shipped `client_portal.dat`):
`ActionMap 0x26000000` → 27 input-map categories, **389 actions**,
`stringTableId 0x23000005`, and a populated `conflictingMaps` graph;
`KeyMap 0x14000000` (`gmDefaultMap`) → 14 categories, 133 mappings. Both are
already fetched (`ui/ac_strings.js:153`, `ui/keymap.js:492`) and `input_map` is
already emitted per mapping (`apps/holtburger-web/src/lib.rs:11593-11596`).
**Proposed change:** (1) add `inputMap` to `LOCAL_ACTIONS` rows and to the
override key (`"<map>:<labelHash>"`); (2) a small `InputMapStack` with retail's
five priorities, where the top-most map claiming a keypress wins; (3) resolve
conflicts *within* a map only, using the DAT's `conflictingMaps` to decide which
map pairs can actually collide; (4) drive the magic-mode digits off the
MagicCombat map instead of a stance check.
**Payoff:** eliminates all 10 conflicts structurally, unlocks the 389-action
retail vocabulary for the Controls tab, and is the prerequisite for UI-02.
**Effort:** L.
**Validation:** `__diag.input.conflicts()` returns `[]` with defaults; a headless
test asserting Digit1 dispatches to hotbar in peace mode and to spell-slot 1 in
magic stance; the existing rebind-history ring shows map-scoped writes.

---

### CORE-07 — Collapse the three host facades into one capability-probed client API
**Source:** 08 §6 (+ 05 §15). Full argument in §3 below.
**Retail:** exactly **one** host interface (`IAsheronsCall`, a COM object with a
binary-stable IUnknown head), handed to the plugin at load
(`APIManager::Init`, acclient.c:393464-393509). Its failure mode is instructive:
16 methods are `E_FAIL` stubs and two (`GetCombatMode`, `GetVendorID`) are
COMDAT-folded into a body that returns `S_OK` **without writing the
out-parameter**, so `APIManager::UseObjectOn` (acclient.c:393120-393124) always
takes its failure path and **no caller can detect why**.
**Holtburger today:** three surfaces.
1. `plugins/api.js::createClient(sessionHandle)` — 14 namespaces
   (`player/movement/chat/characters/world/scene/collision/sky/ui/events` + enums),
   frozen, but `ui` is three **no-op stubs** (`plugins/api.js:724-728`) with
   **zero call sites** for `registerBarSlot` anywhere in the tree.
2. `rynth/webhost.js::RynthWebHost` — ~70 members with a **capability probe**
   (`CAPABILITY_CANDIDATES`, `webhost.js:25-120`) and a **frozen per-tick
   snapshot** (`webhost.js:8-18`), and member names that are literally retail's
   (`WriteToChat` `:806`, `InvokeChatParser` `:809`, `TurnToHeading` `:770`,
   `StopCompletely` `:800`, `SetAutoRun` `:803`, `ChangeCombatMode` `:738`,
   `GetGroundContainerId` `:429`, `GetBusyState` `:410`).
3. The raw 188-method wasm `SessionHandle`, which `rynth/bot.js` takes
   **directly** (`createGrindBot(sessionHandle, …)`, `bot.js:29`) — bypassing
   both facades.
**Proposed change:** promote RynthWebHost's two good ideas into the one `client`
facade — the capability probe (so a stale `pkg/` degrades a named capability
instead of throwing, and callers can *ask*) and the frozen tick snapshot — then
express both `plugins/*` and `rynth/*` against it, with the raw handle reachable
only as `client._unsafeHandle` behind a documented escape hatch. Version the
facade (`client.apiVersion`) so an out-of-tree plugin can refuse to load.
**Payoff:** one surface to document for rynthsuite/rynth-ai; retail's silent-stub
disaster becomes structurally impossible (a missing capability is *observable*);
the 70-member vocabulary rynth already validated becomes the plugin vocabulary.
**Effort:** L.
**Validation:** `client.has('CastSpell') === true` in-world; rynth's smoke
harnesses (`rynth_*_smoke.cjs`) pass unchanged after re-pointing at `client`;
a deliberate `delete sessionHandle.attack` degrades `has('MeleeAttack')` to false
instead of throwing.

---

### CORE-02 — Queued UI-mode machine + `stateChanged` bus event
**Source:** 08 §4.
**Retail:** mode transitions are **queued** (`UIFramework::QueueUIMode`) and
consumed on the next `UIFlow::Update`, with eight registered modes
(`0x10000001` gmIntroUI … `0x1000000B` gmCharGenMainUI, acclient.c:183759-183766)
and `0x10000003` gmDataPatchUI as the initial mode. UI mode and scene/engine
readiness are separate concerns.
**Holtburger today:** one string scalar, `window.__bootState`, with ~10 values
and an admitted ordering race: "'ready' and 'in-world' share this one scalar and
can arrive in EITHER order … live-reproduced 2026-07-18", patched with a
`__sceneReadyEverFired` latch (`index.html:5356-5372`). Meanwhile we *already*
ported Chorizite's 8-value `ClientState` enum (`plugins/api.js:189-198`) and it
has **zero consumers outside `api.js`** (grep across all `.js`/`.html`), and the
bus event is missing — the coverage table itself files it as PARTIAL row 6, "no
single stateChanged with old→new" (`plugins/api.js:23`, TODO at `:411`).
**Proposed change:** a tiny queued mode machine over the existing `ClientState`
values; `setBootState` becomes a thin adapter that enqueues; scene readiness
moves to its own boolean axis; emit `stateChanged {oldState,newState}` on the
plugin bus and retire the latch.
**Payoff:** closes api.js coverage row 6, gives plugins/rynth a typed lifecycle
instead of string sniffing (`plugins/rejection_feedback.js` and
`scene3d/terrain.js` both read the scalar today), and removes a known race.
**Effort:** M.
**Validation:** headless boot asserting the emitted `(old,new)` sequence is
monotone through `Initial → GameStarted → CharacterSelect → EnteringGame →
InGame`; assert `__sceneReadyEverFired` is deletable with no behaviour change.

---

### CORE-08 — Make `client.ui` real (slots, panels, HUD layers, plugin manager)
**Source:** 05 §15 + 08 §12.
**Retail:** windows self-register into two registries and paint into a z-sorted
tree with `BringToFront`; KeyStone even hosted a **Plugin Manager** window
(`OpenPluginManager` 0x556ED0, `IsPluginManagerOpen` 0x557140).
**Holtburger today:** `client.ui.registerBarSlot/openPanel/closePanel` are
**empty functions** (`plugins/api.js:724-728`) and nothing calls them. Bar
composition is host-private: `index.html` statically imports plugin modules into
a `PLUGIN_MODULES` map and orders them by a hardcoded `BAR_SLOT_ORDER` with
`BAR_SLOT_SUPPRESS`/`BAR_SLOT_EXPORT_OVERRIDES` (`index.html:1779-1817`), then
hands the array to `mountBar({client, root, slots})` (`ui/bar.js:554`,
called at `index.html:1982`). Manifests *do* carry declarative `slots` and
`hotkeys` (`plugins/schemas/plugin-manifest.json`), and hotkeys are already wired
through (`index.html:1758-1776` → `ui/keymap.js:779-818`) — slots are not.
**Proposed change:** implement `client.ui` as the real registration path
(`registerBarSlot(manifestSlot)`, `openPanel/closePanel(id)`,
`registerHudLayer(id, {layer})` feeding UI-04's z-order manager), have
`mountBar` consume the registry instead of a host array, and add a minimal
plugin-manager panel listing loaded/skipped plugins with their manifest
metadata (which CORE-06 then reports to the server).
**Payoff:** an out-of-tree plugin can contribute UI without editing
`index.html`; this is the concrete blocker for third-party/rynthsuite panels.
**Effort:** M.
**Validation:** drop a plugin folder + manifest, regenerate `plugins/index.json`
via `plugins/gen-index.mjs`, and see its bar icon and panel with **no**
`index.html` edit.

---

### CORE-10 — Plugin chat hooks, both directions, eatable
**Source:** 05 §13.
**Retail:** the chat path is the plugin path. Outbound: `OnChatCommand`
**offers the line to the plugin first** (`APIManager::GetACPlugin()` →
IACPlugin slot 8, acclient.c:426170-426173, receiving a `BSTR` and a
`PStringBase<unsigned short>**` out-param — i.e. the plugin may **rewrite** the
line). Inbound: `ClientSystem::AddTextToScroll` offers the text with an
**eat flag** (IACPlugin slot 7, acclient.c:401145-401148,
`(wchar*, u32 type, int* eaten)`) before profanity filtering, timestamping,
logging and `SendNotice_DisplayFinalStringInfo` (notice 100022).
**Holtburger today:** inbound goes straight to the DOM — `appendChatLine(text,
category)` (`index.html:4732-4744`) with no hook and no eat. Outbound routing is
host-private (`routeSlashCommand`, `index.html:5987`; exposed only as
`window.__routeSlashCommand` at `:6277`). We *have* the right primitive already:
`createEatableBus()` with break-on-`eat()` (`plugins/loader.js:426-470`).
**Proposed change:** two eatable bus events — `chatOutgoing {text}` (handler may
set `text` and/or `eat()`, running before `routeSlashCommand`) and
`chatIncoming {text, category}` (handler may rewrite/eat before
`appendChatLine`). Route both through the existing eatable bus.
**Payoff:** unlocks the single most common Decal plugin shape (chat triggers,
loggers, filters, command extensions) for plugins **and** for rynth's control
channel, which today has to own its own tell-parsing path
(`rynth/control_channel.js`).
**Effort:** M.
**Validation:** a test plugin that eats every line containing a magic token —
assert it never reaches the DOM; a second that rewrites `/x` to `/say x`.

---

### UI-14 — Slash-command table: 116 retail tokens vs our ~25
**Source:** 08 §5 (+ 05 §13 normalisation).
**Retail:** exactly **116** tokens in a case-insensitive hash built by
`InitializeCommands` (acclient.c:426432-430247). Full ordered list, mechanically
extracted and verified this session:
`? help commands allegiances allegiance all ab alh ah motd speaker channels a
co-vassals covassals covassal c fellowship fellows fellow f group g party
monarch m patron p vassals vassal v join leave chatting chat notell reply r rp
mr pr retell rt say s tell t send whisper w afk death consent corpse cor die
lifestone lif ls marketplace mar mp permit pkarena pka pklarena pla e em emote
me emotes fillcomps loadfile friends friends_add friends_remove house hou hslist
hor hr hom hoa squelch unsquelch messagetypes message_types msgtypes msg_types
status age birth day endurance framerate loc pklite pkl render version saveui
loadui saveautoui loadautoui lockui text clear filter unfilter log title index
clist on off`.
Handler groups verified: `reply|r|rp → DoReply`, `notell → DoNoTell`,
`retell|rt → DoReTell`, `loc → DoLoc`, `render → DoRenderOption`,
`framerate → DoFrameRate`, `age → DoAge`, `clear → DoClear`,
`filter → DoFilter`, `log → DoSetOutput`, `title → DoTitle`,
`index → DoChannelIndex`, `on → DoChannelOn`, `off → DoChannelOff`; and
`mr`, `pr`, `status`, `text` have **no** command handler at all (see DOC-CORR-4).
**Holtburger today:** `routeSlashCommand` (`index.html:5987-6275`) implements
tell/t/send/whisper/w, reply/r/rp, retell/rt, say/s, me, the 8 allegiance/fellow
channels (a/f/p/m/v/co/cv/h), 6 Turbine channels (cg/ct/clfg/crp/society/olthoi),
and ~303 DAT-derived soul-emote tokens; everything else falls through to
`sendChat("@" + cmd)`. That fallback does **not** cover the retail set: ACE
exposes only ~14 player-accessible `@`-commands
(`ace-server/…/Command/Handlers/*.cs` with `AccessLevel.Player`:
`acehelp acecommands passwd pop myquests house-select debugcast fixcast
castmeter config objsend aceversion reportbug fixbusy`), so `/loc`, `/age`,
`/status`, `/title`, `/squelch`, `/filter`, `/framerate`, `/allegiance`, `/house`
etc. currently do nothing useful.
**Proposed change:** implement in three buckets — (a) **client-local** (no wire):
`? help commands clist`, `loc`, `framerate`, `render`, `clear`, `filter/unfilter`,
`messagetypes`, `text`, `index`, `on/off`, `saveui/loadui/lockui` (→ UI-16),
`version`; (b) **existing wire path**: `squelch/unsquelch`, `friends*`,
`allegiance` family, `house` family, `fellow` family, `title`, `age/birth/day`,
`afk`, `consent/permit`, `corpse`, `lifestone`, `marketplace`, `pklite`,
`death/die`, `fillcomps` — each maps to a GameAction we mostly already send from
UI buttons; (c) **needs new opcodes**: enumerate and defer.
**Payoff:** AC veterans type these constantly; also every one implemented is a
rynth/AI-reachable verb.
**Effort:** L overall; each bucket-(a) command is XS.
**Validation:** a table-driven test asserting each token routes to the expected
dispatcher; live smoke of `/loc`, `/title`, `/squelch <name>` against ACE.

---

### UI-05 — MediaMachine interpreter
**Source:** 05 §3.
**Retail:** a per-element bytecode interpreter over `SmartArray<MediaDesc*>` with
a program counter. `Update` (acclient.c:162444) executes `m_array[m_curIndex]`;
each handler returns advance/block; on block the loop breaks **without
advancing** and the machine registers for global message 3 (the per-frame tick),
re-entering via `ListenToGlobalMessage` (acclient.c:162534-162537). Semantics:
**Pause** rolls a duration in `[m_minDuration, m_maxDuration]` on first execution,
stamps `m_endTime`, blocks until `Timer::compute_time()` passes it (:162006);
**Jump** is a probabilistic branch, `Random::RollDice(0,1) <= m_probability` then
`m_curIndex = m_jumpItemIndex − 1`, and *always* advances so loops are Jump-to-0
(:162033); **Message** broadcasts `m_messageID` with probability `m_probability`
but only if owner flag bit 17 is set (:162057); **State** probabilistically calls
`SetState(m_stateID)` and **always returns false**, halting the playlist —
this is the state-transition primitive (:162082). `Reset` (:162572) deep-copies
each descriptor, which is why per-instance timing (`m_endTime`, `m_StartTime`,
`m_displayedFrameNum`) can live inside the descriptor.
**Holtburger today:** the data is fully parsed — all 11 payload variants in
`crates/holtburger-dat/src/file_type/media_desc.rs:60+` with the exact opcode
numbers (`:23-37`) — but there is **no executor**: the only consumer is a
declarative single lookup, `getStateMediaByType(stateDesc, variantName)`
(`ui/ac_layout.js:457-470`), used to pull a static sprite DID.
**Proposed change:** a ~200-line JS interpreter (`ui/ac_media_machine.js`) with
the four control-flow semantics above, driven from the existing rAF tick, owning
`setState` on a DOM element. Start with the indicator strip (portal-storm pulse,
link-status blink) which is hand-animated today
(`plugins/status-indicators.js:33` `PORTAL_STORM_PULSE_ID`).
**Payoff:** authentic UI motion straight from the DAT, and deletes hand-written
CSS animation that can never match. Also the missing half of UI-06 (states
without a machine to sequence them are inert).
**Effort:** L (interpreter M; per-window adoption incremental).
**Validation:** table-test the four control-flow opcodes headlessly (Pause blocks
until t≥end; Jump-to-0 loops; State halts and transitions; Message respects the
probability with a seeded RNG), then an eye-test on one indicator.

---

### CORE-03 — Central preference registry
**Source:** 08 §7.
**Retail:** two-tier and typed. `UserPreferences::RegisterPreference(description,
&storage, nameKey, …, callback, …)` binds a C++ address to a dotted name
(44 sites; e.g. tooltip delay/enable at acclient.c:155717-155737);
`UIPreferences::AttachPreference(name, dataType, stringTableID, displayToken,
tooltipToken)` additionally exposes it in the options UI (36 sites), with
`SetPreferenceRange(min,max)` for floats — `AttachPreference(&Misc_TooltipDelay,
3u, 0x10000003u, hash("ID_Misc_TooltipDelay"), hash("ID_Misc_TooltipDelay_Help"))`
+ `SetPreferenceRange(0.0, 10.0)` at acclient.c:63093-63096 (`dataType` 3 = float,
4 = bool). One INI, one options UI that can render **any** registered preference
from its metadata. Group names: `Net_*`, `Render_*` (16), `Sound_*` (8),
`Input_*` (4), `Display_*` (4), `Camera_*` (3), `Misc_Tooltip{Delay,Enable}`,
`UI_ChatFont{Face,Size}`, `International_UseIME`.
**Holtburger today:** no registry. ~20 distinct localStorage keys in three
naming conventions, each with bespoke read/write/TTL code — e.g.
`holtburger_keybindings_v1` (`ui/keymap.js:24`),
`holtburger_character_options_v1` (`scene3d/input.js:90`, with its own 500 ms TTL
cache at `:126`), `holtburger_camera_v1`, `holtburger_graphics_v1`,
`holtburger_hotbar_v1`, `hb.options.audio.v1`, `hb.window.<id>`
(`ui/ac_window_position.js:31`), `hb_chat_panel_{width,height,fade,saved_height}`,
`hb.fellowship.opts`, `hb.lore.discovered.v1`, `rynth.atlas.v1`, …
**Proposed change:** `ui/preferences.js` with
`registerPreference(name, {type, default, min, max, label, tooltip, onChange})`,
one persisted blob, retail's dotted group names, and an options tab that renders
from the registry. Migrate existing keys with one-shot readers (the pattern
`ui/ac_window_position.js` already uses for `legacyKey`).
**Payoff:** kills per-module persistence code; new settings appear in the UI for
free; gives rynthsuite one documented read/write surface for client config.
**Effort:** M.
**Validation:** an assertion that every registered preference round-trips
through the blob and appears in the options tab; a migration test from each
legacy key.

---

### UI-08 — Radar blip shape priority chain
**Source:** 05 §9.
**Retail:** `GetBlipShape` (acclient.c:262864) resolves in priority order —
fellowship leader → fellow → allegiance member → PK/PKL threat → default — over
`enum RadarBlipShape` (verified acclient.h:6575-6591): `Default = Plus (4)`,
`AllegianceMember = Box (2)`, `FellowshipLeader = Triangle (5)`,
`Fellowship = InvertedTriangle (6)`, `Threat = X (3)`,
`ThreatAllegiance = XBox (7)`. Colour has a matching fall-through chain
(Portal → Vendor → Creature → Admin → PlayerKiller → PKLite → Fellowship,
acclient.c:262776-262830).
**Holtburger today:** no chain. `resolveRadarShape` (`plugins/radar.js:349-357`)
takes the server property else `DEFAULT_SHAPE_BY_KIND`
(`:80-85`) = player→triangle, creature→circle, npc/vendor→box — so a plain
player renders with retail's *FellowshipLeader* glyph and creatures get Circle
where retail's default is Plus. Colour has no fall-through either
(`getRadarColorHex`, `:67-70`).
**Proposed change:** implement both chains from the live fellowship roster
(already available — `TryGetFellowship`, `rynth/webhost.js:534`; roster markers
in `plugins/map-panel.js:231-247`), allegiance membership and the PK flags in
`objDescFlags` (ours already reads `ODF_PLAYER 0x08`/`ODF_VENDOR 0x10`,
`plugins/radar.js:37-38`). Also add retail's altitude intensity scale.
**Payoff:** the radar is a primary situational-awareness surface; wrong glyphs
actively mislead (a stranger currently looks like your fellowship leader).
**Effort:** M.
**Validation:** headless: inject a fellow, an allegiance member and a PK and
assert Triangle/InvTriangle/Box/X per the priority; eye-test in a town.

---

### UI-02 — Per-action toggle semantics and AutoRepeat
**Source:** 05 §7.
**Retail:** `ActionMap::GetToggleType(action, mapID)` is consulted **per event**
in `CInputManager::FireActionEvent` (acclient.c:112031-112070). A missing entry
forces type 3. Release (`InputExtent == 0`) deactivates for types 1, 4, 5 only.
Press dispatch: 2 → `ToggleActionKey`, 3 → `StartAction`, 1 → `ActivateActionKey`
then immediately `Deactivate` **unless** `m_activation & 0xA9`, default (4/5) →
`ActivateActionKey`. Only type 4 enters the repeat block
(`if (v9->m_toggle == 4)`, acclient.c:111278) driven from
`CInputManager::UseTime` (:111194) with `sm_timeKeyRepeatDelay = 0.25 s` and
`sm_timeKeyRepeatSpeed = 0.025 s` (:44762-44763). Actions 41/42/43 break run-lock
(:112017). Shipped ActionMap `0x26000000` histogram (measured this session):
**Impulse 318, Momentary 53, Toggle 2, AutoRepeat 16**.
**Holtburger today:** `isToggleAction(actionHash)` exists and reads the DAT
`toggle` field (`ui/keymap.js:604-608`) but **nothing consumes it**; there is no
activation handling at all (`qualifiedControlToBinding` reads only `key` and
`modifier`, `ui/keymap.js:416-445`) even though wasm already emits `activation`
per mapping (`apps/holtburger-web/src/lib.rs:11593-11596`); and there is no
repeat machinery — we inherit the OS key-repeat rate.
**Proposed change:** a small activation/toggle layer on top of UI-01: honour the
five toggle types, implement type-4 repeat with retail's 0.25/0.025 constants,
and mask (never compare) the activation word (see DOC-CORR-1).
**Payoff:** correct hold-vs-tap-vs-toggle feel for the 16 AutoRepeat and 53
Momentary retail actions; deterministic repeat rate instead of a per-OS one.
**Effort:** M (after UI-01).
**Validation:** headless press/hold/release traces asserting one event for
Impulse, N events at 40 Hz after 250 ms for AutoRepeat, latch/unlatch for Toggle.

---

### UI-04 — Central window/z-order manager
**Source:** 05 §1, §4.
**Retail:** z-order is maintained **at insert time** by `CompareZLevel` inside
`UIRegion::AddChild` (acclient.c:696988) over the children `HashList`, with
`BringToFront` on activation; each element carries `m_zlevel` from its
`StateDesc`, `m_bBlockClicks` and `m_bDrawAfterChildren`;
`RenderUI::ComputeGameViewport` (acclient.c:132983) shrinks the 3D viewport
around edge-clamped panels.
**Holtburger today:** ~20 hardcoded `z-index` literals across plugins — 50, 60,
65, 70, 80, 81, 90, 200, 1000, 12000, **2147483000**
(`plugins/vitals-hud.js:79`, `plugins/status-indicators.js:129`/`:256`,
`plugins/target-bar.js:110`, `plugins/trade-panel.js:69`,
`plugins/house-panel.js:82`, `plugins/radial-menu.js:24`/`:169`,
`plugins/spellbook.js:753`, `plugins/social-panel.js:45`,
`plugins/loading-screen.js:58`, `plugins/rejection_feedback.js:187`, …).
`ui/ac_window_position.js` owns position/size/lock only (exports at
`:69,316,433,591,633,658`) — no layer, no focus, no click-to-front.
**Proposed change:** named layer bands (`world < hud < panel < popover < modal <
toast`) with an allocator, a `bringToFront(windowId)` that reorders within a
band, and a click-to-front handler on registered windows. Expose via
`client.ui.registerHudLayer` (CORE-08). Retail's `m_zlevel` from the layout can
seed a window's intra-band order.
**Payoff:** ends the z-index arms race (a `2147483000` literal is a symptom);
makes overlapping panels behave; a prerequisite for third-party panels.
**Effort:** M.
**Validation:** open every panel, assert no two registered windows share a
computed z-index; click-to-front test; a lint rule banning raw `z-index` in
`plugins/`.

---

### UI-06 — Emit and flatten layout inheritance (`InqFullDesc`)
**Source:** 05 §2.
**Retail:** each `ElementDesc` names a base layout DID; `LayoutDesc::InqFullDesc`
**flattens** the inheritance so an element's effective geometry/state/media is
base ⊕ override. `CreateChildElementByEnum` resolves via
`DBObj::GetByEnum(_layoutEnum, 5, 0x23u)` (acclient.c:155094).
**Holtburger today:** `crates/holtburger-dat/src/file_type/layout.rs:72-73`
parses `base_element` and `base_layout_id`, but `fetch_layout`
(`apps/holtburger-web/src/lib.rs:11402-11431`) never emits either, so JS sees a
bare element and consumers hardcode geometry the DAT could supply (see the long
hand-transcribed element tables in `plugins/radar.js:88-104`,
`plugins/map-panel.js:22-36`, `plugins/status-indicators.js:35-40`).
**Proposed change:** emit both fields, then either flatten in Rust (preferred —
one place, memoised, matches retail) or add a JS resolver that recursively
merges. WorldBuilder.Terminal already does inheritance-aware layout rendering
(`WorldBuilder.Terminal/CommandEngine.UiWorkspace.cs`, `ui-layout-render`), so it
is the differential oracle.
**Payoff:** removes hand-transcribed geometry tables; unlocks the ~101 layouts
WBT can already enumerate; prerequisite for faithful chrome on new windows.
**Effort:** M.
**Validation:** for a layout with a base, compare our flattened element rects
against `ui-layout-render`'s output for the same DID.

---

### UI-24 — Server-side spell-bar persistence (+ `IS_ALIAS`)
**Source:** 05 §9.
**Retail:** item shortcuts and spell shortcuts are **separate** stores —
`ShortCutManager { ShortCutData* shortCuts_[18] }` and `favorite_spells_[8]`
inside `PlayerModule`. `RecvNotice_FullMergingItem` (acclient.c:241250)
re-points a shortcut when a stack merges; `RecvNotice_ItemListBeginDrag`
(:240399) removes it when the drag leaves the slot.
**Holtburger today:** item shortcuts are server-round-tripped
(`add_shortcut`/`remove_shortcut`/`player_shortcuts`,
`apps/holtburger-web/src/lib.rs:34182`, `:34206`, `:34223`, hydrated from
`PlayerDescription.shortcuts` at `:30089-30093`), but **spell** bindings live
only in `localStorage['holtburger_hotbar_v1']` (`plugins/hotbar.js:248-254`,
`:877-879`) because the opcodes are commented out:
`// AddSpellFavorite = 0x01E3`, `// RemoveSpellFavorite = 0x01E4`,
`// SpellbookFilter = 0x0286` (`crates/holtburger-protocol/src/opcodes.rs:537-542`).
ACE **implements all three**: `GameActionAddSpellFavorite.cs:6-13`
(`HandleActionAddSpellFavorite(spellId, spellBarPositionId, spellBarId)`),
`GameActionRemoveSpellFavorite.cs`, `GameActionSpellbookFilter.cs`, with
`ACE.Entity/SpellBarPositions.cs` as the persisted model, and opcode values
`0x01E3/0x01E4/0x0286` agreeing across ACE (`GameActionType.cs:87-88,137`) and
chorizite (`GameActionType.generated.cs:182,184,282`).
**Proposed change:** uncomment the three opcodes, send Add/Remove on spell
bind/unbind, hydrate from the server on login, keep localStorage as a cache
only. Separately add retail's `DROPITEM_IS_ALIAS = 0xE` composite
(`acclient.h:6772`) to `plugins/drop_item_flags.js:33-41` so downstream code can
tell a *virtual* drag (vendor/salvage/shortcut) from a real item move, as retail
does at acclient.c:273362-273367.
**Payoff:** spell hotbar survives relog and follows the character across devices
— currently it silently does not.
**Effort:** M.
**Validation:** bind a spell, `/quit`, relog, assert the slot is populated from
the server with localStorage cleared.

---

### UI-15 — 64-bit chat message-type filter
**Source:** 05 §13, §10.
**Retail:** each `ChatInterface` filters on a **64-bit** `m_llTextTypeFilter`
(acclient.h:54907); `TypeIsActive` tests `1i64 << i_ltt` against both halves
(acclient.c:287014); the default sets **all 64 bits then clears bit 26**
(acclient.c:288224-288233). Authoring is `UIOption_CheckboxBitfield64` — a
listbox of `{__int64 llMask, StringInfo siLabel, StringInfo siTooltip}` rows
(acclient.h:55766) — surfaced as `/messagetypes`.
**Holtburger today:** four hardcoded tabs (All/Local/Tells/Channels) with a
channel→tab follow map (`plugins/chat-panel.js:30-41`, `:653-681`); the code
itself notes retail bound the four left-edge buttons to the 64-bit mask.
**Proposed change:** a real 64-bit mask with the retail default, a bitfield
editor in the Chat options tab, and `/messagetypes` (UI-14 bucket a) to print
and toggle. Keep the 4 tabs as presets over the mask.
**Payoff:** real chat filtering (the current tabs cannot express "everything
except deaths"); closes a visible options gap.
**Effort:** M.
**Validation:** unit test on mask ↔ preset mapping; assert the default equals
`~(1<<26)` over 64 bits.

---

### UI-19 — StringInfo variables, literal override, and the metalanguage
**Source:** 05 §13 + 08 §13.
**Retail:** `StringInfo` (acclient.h:30308) = table DID + string id **plus
variables and a literal override**. `StringTableMetaLanguage`
(acclient.c:13204-13235) is a mini parser/renderer for escapes, gendered "meta
letters", singular/plural, capitalisation and variable substitution, backed by
`CLanguageInfoInterface::GetMaleMetaLetters` / `GetFemaleMetaLetters` /
`GetTreasureMetaLetters` (0x422230-0x4222D0) — this is what generates AC's
procedural item names.
**Holtburger today:** `resolveStringInfo` reads only `string_id` and `table_id`
and drops variables and the literal (`ui/ac_layout.js:416-433`);
`ui/ac_strings.js` has no renderer (exports at `:36,80,97,131,153,203,219`).
**Proposed change:** extend `resolveStringInfo` to honour the literal override
and substitute variables, then port the metalanguage renderer for gender/plural
tokens. Grammar helpers (`GetGroupingSeperator`, `IsNumberSingular`, …) can come
later.
**Payoff:** UI labels stop rendering raw tokens; a prerequisite for anything
that formats item names client-side.
**Effort:** M.
**Validation:** golden tests against a handful of shipped `0x23…` strings that
carry variables and gendered forms, cross-checked with WBT's `ui-layout-render`.

---

### UI-20 — Chat `TextTag` item links
**Source:** 05 §13, §14.
**Retail:** clickable content is `TextTag`s attached to individual glyphs —
`TextTag_DID`, `TextTag_IID`, `TextTag_IIDEnum`, `TextTag_IIDString`
(acclient.h:45330 for the glyph's `TextTag*`) — with clicks reported as engine
notices **100018-100021**.
**Holtburger today:** zero occurrences of `TextTag` anywhere under
`apps/holtburger-web/**`; chat lines are plain `textContent`
(`index.html:4743`).
**Proposed change:** parse inbound chat for tag markers, render them as `<a>`
spans, and emit `textTagClick {kind, id}` on the plugin bus mapped to retail's
four notice ids. Depends on CORE-10's inbound hook for the rewrite point.
**Payoff:** item/spell links in chat — a signature AC social feature and a
natural plugin extension point.
**Effort:** M. **Open question:** whether ACE emits tag markers at all (OQ-6).
**Validation:** a synthetic tagged line renders a clickable span and emits the
event.

---

### UI-21 — Window-roster gap
**Source:** 05 §6. Ledger row above lists the 8 genuinely-absent classes.
**Proposed change:** in priority order — **gmSlumlordUI `0x13`** (housing rent
is a live gameplay blocker), **gmBarberUI `0x4A`** (appearance editing, and we
already have paperdoll + dye viewports to build on), **gmAbuseUI `0x18`** and
**gmUrgentAssistanceUI `0x1F`** (support paths; ACE has `reportbug`),
**gmPageListUI `0x49`** (paginated lists reusable by journal/contracts),
**gmSpewBoxUI `0x16`** (a real in-client debug console beats `__diag` from the
devtools console for eye-tests). Defer `gmEnvPanelUI 0x33` and
`gmAdminQualitiesUI 0x3F`.
**Payoff:** closes the visible feature roster.
**Effort:** M each. **Validation:** per-window layout-render diff vs WBT.

---

### UI-16 — `/saveui /loadui /saveautoui /loadautoui /lockui`
**Source:** 05 §9/§10 + 08 §5 + notices 5100163/5100164 (Save/LoadUI).
**Retail:** five registered tokens (`saveui loadui saveautoui loadautoui lockui`,
verified in the 116-token extraction) plus `loadfile`, and the notice pair
5100163/5100164 for Save/LoadUI.
**Holtburger today:** per-window position/size/lock persist individually
(`ui/ac_window_position.js:69`, `:316`) with a global lock event
(`onAnyLockChange`, `:591`), but there is no snapshot/restore of the whole
layout and no command surface. Nothing persists on unload (`index.html:5381-5390`
only frees the session).
**Proposed change:** serialise/deserialise the `hb.window.*` set as one named
profile; wire the five commands (needs no server).
**Payoff:** cheap, high-visibility retail parity; makes eye-test setups
reproducible.
**Effort:** S.
**Validation:** move three windows, `/saveui`, reset, `/loadui`, assert
positions.

---

### UI-17 — Window position/size/lock server round-trip
**Source:** 05 §10 (the three persistence targets) + 05 §9 (`m_eWindowID`).
**Retail:** each floaty window carries an `unsigned int m_eWindowID`
(acclient.h:54547-55124) and persists through `PlayerModule::InqChatWindowOption`
/ `SetChatWindowOption` — i.e. **server-side, per character**, not a local file.
The per-window property IDs are `0x10000086` X, `0x10000087` Y, `0x10000088`
width, `0x10000089` height, `0x1000008A` locked.
**Holtburger today:** localStorage only, keyed `hb.window.<windowId>` where the
id is the layout root element id as a surrogate for `m_eWindowID`
(`ui/ac_window_position.js:31`, `:69`, `:658-673` for the `WINDOW_ID` table —
8 real ids plus one synthetic `0xFFFF0001` for gmEffectsUI). The file documents
the retail property ids and the intended swap at `:19-29`: "When ACE exposes
these as generic per-window props, swap the localStorage path here for the wire
round-trip without changing callers".
**Proposed change:** keep the API surface; add a wire backend behind a
capability probe so window layout follows the character across devices. Blocked
on ACE exposing the five properties for non-chat windows — and `MEMORY.md`'s
*keep-ACE-vanilla* rule means that is a separate, explicitly-sanctioned decision.
Land the client half against UI-16's profile snapshot in the meantime.
**Payoff:** layout follows the character, not the browser profile.
**Effort:** M (client S; server-side is the gate).
**Validation:** with the probe forced off, behaviour is byte-identical to today;
with a stub backend, a second browser profile restores the same layout.

---

### UI-07 — Retail tooltip timing + preferences
**Source:** 05 §5, 08 §7. Constants recovered fresh this session.
**Retail:** ctor defaults `m_tooltipEnable = 1`, `m_tooltipDelay = 0.25 s`
(`LODWORD = 1048576000 = 0x3E800000f`), `m_tooltipDuration = 10 s`
(`1092616192 = 0x41200000f`) — acclient.c:156170-156173; registered as
`Misc.TooltipDelay` / `Misc.TooltipEnable` (acclient.c:155717-155737) and
exposed with `SetPreferenceRange(0.0, 10.0)` (acclient.c:63095-63096).
`CheckTooltip` fires after that much *stillness* (acclient.c:152043).
**Holtburger today:** `HOVER_DELAY_MS = 400` hardcoded, no duration cap, no
preference, no enable toggle (`plugins/hover-tooltip.js:28`, `:117`).
**Proposed change:** 250 ms, auto-hide at 10 s, both registered in CORE-03's
registry under the retail names.
**Payoff:** snappier and configurable; three lines plus registry rows.
**Effort:** S.
**Validation:** timing test on the rest timer; options row appears.

---

### UI-12 — Chat input history: 100 entries, no dedupe
**Source:** 05 §13.
**Retail:** `ProcessCommand` (acclient.c:288749) appends unconditionally, sets
`m_LastInputHistoryPos = −1`, and trims from the front `while (m_num > 0x64)`
(acclient.c:288776-288790) — cap **100**, no dedupe.
**Holtburger today:** 64-entry ring **with** consecutive-dedupe, and an in-code
comment that misstates retail's size as 32
(`plugins/chat-panel.js:906-922`; recall at `:924-941`, keys at `:965-966`).
**Proposed change:** `HISTORY_MAX = 100`; drop the dedupe (or keep it and mark
it an explicit deviation); fix the comment.
**Effort:** S. **Validation:** submit 120 lines, assert 100 retained and that
two identical consecutive submits both appear.

---

### UI-13 — `:` / `;` → `@emote` normalisation
**Source:** 05 §13.
**Retail:** in `OnChatCommand`, `case 58`/`case 59` replace the **leading char
with a space (32)** and *prepend* the literal `"@emote"` before `DoCommand` —
so `:waves` becomes `@emote  waves`.
**Holtburger today:** absent; `routeSlashCommand` handles only `@` and `/`
(`index.html:5987-5990`). A leading `:` is spoken aloud.
**Proposed change:** three lines at the top of `routeSlashCommand`.
**Effort:** S (XS). **Validation:** `:waves` produces the emote, not speech.

---

### UI-09 — Radar BrightGreen: accept both `0x0A` and `0x10`
**Source:** 05 §9 + era check.
**Retail:** `GetBlipColor`'s switch handles **`case 10:`** → BrightGreen
(acclient.c:262770-262773); `_blipColor` is a plain `int` (acclient.h:37191), so
16 would fall to `default` → RadarDefault.
**ACE:** `ACE.Entity/Enum/RadarColor.cs:15` declares `BrightGreen = 0x10`.
**Holtburger today:** keys only `0x10` (`plugins/radar.js:54-65`, with a comment
asserting "intentional gap in 0x0A..0x0F").
**Proposed change:** map both `0x0A` and `0x10` to BrightGreen and note the
source divergence in the comment.
**Effort:** S (XS). **Validation:** unit test both codes.

---

### UI-10 — Port the 53 map rollover regions
**Source:** 05 §9. Table transcribed from `gmMapUI::LocationRolloverInfo
s_rgLocations[53]`, acclient.c:39939-39995, as `{x, y, w, h, name}` in the
`m_pMap` element's pixel space:
`(178,20,11,12) Aerlinthe Island · (18,74,5,5) Ahurenga · (141,166,7,6) Al-Arqas ·
(129,121,7,6) Al-Jalima · (190,88,9,8) Arwic · (19,201,7,6) Ayan Baqur ·
(200,190,7,6) Baishi · (184,53,5,5) Bandit Castle · (34,84,5,5) Bluespire ·
(44,235,5,5) Candeth Keep · (180,97,9,8) Cragstone · (91,102,5,5) Danby's Outpost ·
(211,138,9,8) Dryreach · (199,106,9,8) Eastham · (56,13,5,5) Fiun Outpost ·
(37,127,9,8) Fort Tethana · (156,94,9,8) Glenden Wood · (43,79,5,5) Greenspire ·
(224,177,7,6) Hebian-to · (164,77,9,8) Holtburg · (182,230,7,6) Kara ·
(155,185,7,6) Khayyaban · (224,218,7,6) Kryst · (212,195,7,6) Lin ·
(159,224,5,5) Linvak Tukal · (185,126,9,8) Lytelthorpe ·
(235,220,7,6) MacNiall's Freehold · (223,203,7,6) Mayoi ·
(141,53,5,5) Mt Esper-Crater Village · (224,191,7,6) Nanto · (142,46,5,5) Neydisa ·
(240,128,5,5) Oolutanga's Refuge · (74,79,5,5) Plateau Village ·
(148,218,7,6) Qalaba'r · (26,83,5,5) Redspire · (193,114,9,8) Rithwic ·
(146,133,7,6) Samsur · (50,42,5,5) Sanamar · (195,163,7,6) Sawato ·
(213,171,7,6) Shoushi · (41,25,5,5) Silyun · (6,239,15,16) Singularity Caul Island ·
(100,48,5,5) Stonehold · (32,76,5,5) Timaru · (239,163,7,6) Tou-Tou ·
(131,148,7,6) Tufa · (112,244,5,5) Ulgrim's Island · (159,160,7,6) Uziz ·
(63,203,7,6) Wai Jhou · (144,181,7,6) Xarabydun · (175,145,7,6) Yanshi ·
(121,156,7,6) Yaraq · (123,112,7,6) Zaikhal`.
**Holtburger today:** no rollovers; our map viewport is 257×267 matching retail's
`m_pMap` (`plugins/map-panel.js:31`, `:53`), so the coordinates drop straight in
(scaled by our pan/zoom transform).
**Proposed change:** a data module + hover tooltips inside the map viewport.
Bonus: the same table is a town-name → map-position index usable by
`rynth/ai/tools/towns.js`.
**Effort:** S. **Validation:** hover Holtburg at zoom 1 and at zoom 2 and get
the label both times.

---

### UI-11 — Map marker normalisation
**Source:** 05 §9. Retail arithmetic (acclient.c:218164-218172):
`x = m_x0 + GetWidth()/-2 − (int64)((m_x1 − m_x0 + 1) * (coord*10 + 1024) * −0.00048828125)`,
`y = m_y0 + GetHeight()/-2 − (int64)((2047.0 − (coord*10 + 1024)) * (m_y1 − m_y0 + 1) * −0.00048828125)`.
So the normalised span is **2048 map units = 49152 game units**, Y is flipped
about 2047, and the marker is centred by half its own size.
**Holtburger today:** `worldToMapPct` divides by `WORLD_SPAN` = 254×192 =
**48768** (`plugins/map-panel.js:208-215`) — same centre, 0.79 % scale error
(≈2 px at the edge of a 257 px map) — and does not subtract half the marker.
**Proposed change:** use 49152 and centre the marker.
**Effort:** S (XS). **Validation:** assert Holtburg's marker lands inside
UI-10's `(164,77,9,8)` rect.

---

### UI-18 — Wire font border-pixel inset
**Source:** 05 §11 (`Font` carries border pixel counts).
**Holtburger today:** our own code flags it twice as deferred —
"`num_horizontal/vertical_border` aren't surfaced from the wasm side yet …
we conservatively assume zero" (`ui/ac_font.js:686-693`) and "the atlas inset
isn't wired (defer-wasm)" (`:743-750`).
**Proposed change:** surface the two counts from `FontData` and inset the atlas
sample rect (subtract from `offset_x/y`, `width/height`).
**Payoff:** removes shadow bleed and sub-pixel fringing on DAT text.
**Effort:** S. **Validation:** pixel-diff a rendered string against WBT's
`ui-layout-render` text output.

---

### UI-22 — Camera preferences under retail names
**Source:** 08 §7 `Camera_*` group + 05 §8.
**Retail:** `Camera_AdjustmentSpeed`, `Camera_AlignToSlope`, `Camera_Stiffness`
are registered, user-visible preferences; `Input_*` covers
`InvertMouseLookYAxis`, `MouseLookSensitivity`, `MouseLookSmoothingAmount`,
`UseMouseTurning`.
**Holtburger today:** `RETAIL_CAM_ADJUST_SPEED = 40.0` is a hardcoded const
(`scene3d/camera_math.js:18`); `m_bAlignCameraToSlope` has no analogue;
stiffness/smoothing/sensitivity/invert exist only as URL flags plus a live
setter (`scene3d/camera.js:541-551`, `:649-702`).
**Proposed change:** register all seven in CORE-03's registry with the retail
names and ranges; keep the URL flags as overrides.
**Effort:** S (after CORE-03). **Validation:** each appears in the Camera tab
and round-trips.

---

### UI-23 — Camera collision sphere radius 0.3
**Source:** 05 §8. Retail's `viewer_sphere` radius is **0.3** — the dword after
the zeroed origin is `1050253722 = 0x3E99999A = 0.3f` (acclient.c:145543) — used
through `init_sphere(1, &viewer_sphere, 1.0)` inside a real `CTransition`
`find_valid_position` sweep (acclient.c:145082-145092), falling back to
`CPhysicsObj::AdjustPosition` then to snapping onto the player.
**Holtburger today:** `CAM_RADIUS = 0.5` plus `BACKOFF = 0.2 m`
(`scene3d/camera.js:1241-1242`) across four sweeps (`:1303-1330`) — ~0.7 m of
standoff versus retail's 0.3, so our camera pulls in from walls much earlier.
**Proposed change:** set 0.3 and re-tune (or drop) the backoff.
**Effort:** S. **Validation:** 1070 eye-test walking a corridor; measure the
camera-to-wall distance at contact.

---

### UI-03 — Derive metamode bits from `KeyMap.meta_keys`
**Source:** 05 §7. Retail resolves modifier bits **from the DAT** via
`CMasterInputMap::MetaModeFromKey` — a `HashList<ControlSpecification, unsigned
long>` whose *value* is the bit (acclient.c:676538-676560).
**Holtburger today:** hardcoded table (`ui/keymap.js:348-355`, applied at
`:421-426`). **Verified correct today** against shipped
`client_portal.dat 0x14000000`: LShift `0x2A`→`0x80000000`; LCtrl `0x1D` /
RCtrl `0x9D`→`0x40000000`; LAlt `0x38` / RAlt `0xB8`→`0x20000000`;
LWin `0xDB` / RWin `0xDC`→`0x10000000`; plus two further slots
`0x08000000` and `0x04000000` that our parser ignores by comment
(`ui/keymap.js:353-355`).
**Proposed change:** read the masks from `raw.meta_keys` (already emitted,
`apps/holtburger-web/src/lib.rs:11580-11586`) instead of hardcoding; the two
extra meta slots then work for free.
**Payoff:** robustness against a re-authored keymap; unlocks two extra modifiers.
This is a **hardening** task, not a bug fix.
**Effort:** S. **Validation:** assert the derived table equals the current
constants for `gmDefaultMap`.

---

### CORE-04 — A frame-budgeted resource-drain phase
**Source:** 08 §2 **(2015-recovered ordering — weaker)**.
**Retail:** the per-frame chain `Client::UseTime → CLCache::UseTime →
ThreadedCache::UseTime → DBCache::UseTime` drains the async DAT reply queue under
a wall-clock budget — `while (GetTickCount() - v2 < 0x19)` = **25 ms**
(acclient.c:654301) — and it runs **before** the UI tick and the world tick, so
the frame's geometry is resident before anything reads it.
**Holtburger today:** the frame budget exists but covers only three *deferrable*
groups: `?frameBudget` default **9 ms**, `?deferHz`, staleness ceiling
`RP3_MAX_DEFER_FRAMES` (`scene3d/loop.js:1551-1590`, `_rp3ShouldRun` at
`:1628-1640`, groups PVS/SKY/NAME at `:1599-1601`). Resource decode is
*unbounded*: the global admission gate is installed neutral,
`new(usize::MAX, usize::MAX, 0)` — "an unbounded gate can never enqueue a
waiter, so no call site can ever block" (`src/decode_admission.rs:33-37`), with
the real bound deferred to "S4".
**Proposed change:** add a fourth budgeted phase — a decode/upload drain — placed
before the visibility and entity phases, with retail's wall-clock shape (drain
while `now - frameStart < budget`), and install a real `set_decode_admission`
bound. Cross-ref `wave2-D` (DAT cache) and `memory/holtburger-perf.md`
(residency roadmap); the retail citation is the argument for *where in the
frame* the drain belongs.
**Payoff:** turns per-LB decode spikes into bounded per-frame work — the
documented jank mechanism.
**Effort:** M.
**Validation:** with `renderer.info.autoReset = false`, measure the p99 frame
time crossing a landblock boundary before/after; assert the drain never exceeds
the budget by more than one job.

---

### CORE-05 — Flag-default audit and a single `readFlag()` helper
**Source:** not retail — our own divergence, motivated by 08 §1's tiny typed
switch set. Also already recorded in `MEMORY.md` for 6 cast flags; this extends
it to the UI/input/camera area with a measured scope.
**Evidence (three fresh instances where the in-code comment contradicts the
reader):**
* `scene3d/input.js:21` — "The flag `?inputFunnel=on` (default OFF)" vs
  `readInputFunnelFlag` returning `get("inputFunnel")?.toLowerCase() !== "off"`
  (`:202-203`) → **default ON**. The whole single-owner input funnel is live by
  default while the header promises "byte-identical default behavior".
* `scene3d/camera.js:526-528` — "retail camera flags, **all default-OFF**" vs
  `this._retailZoomOn = params?.get("retailCamZoom")?.toLowerCase() !== "off"`
  (`:539-540`) → **default ON** (the retail zoom continuum, in-head and
  near-fade all run in production).
* `ui/keymap.js:113` — target cycling "gated by `?targetCycle` (off)" vs
  `entities.js:3050-3059` which ships it **enabled** with `?targetCycle=off` as
  the escape.
  (`scene3d/input.js:54,95-103` `retailRunKeys` is a fourth, behaviourally
  benign because the option defaults true.)
**Scope:** `docs/url-flags.md` has 532 rows; there are 442 `params.get(...)`
sites and **78** `!== "off"` readers (default-ON) across `.js`/`.html`.
**Proposed change:** one `readFlag(name, {default: true|false})` helper that
derives the reader from the declared default, a generated flag table (so
`url-flags.md` cannot drift), and a `__diag.flags.effective()` surface listing
every flag's *effective* value at boot.
**Payoff:** kills the class of bug where a reader and its own comment disagree —
which has already produced false conclusions in this mining programme.
**Effort:** S for the helper + diag; M to migrate all 442 sites incrementally.
**Validation:** `__diag.flags.effective()` compared against the generated table
in CI; assert the three instances above.

---

### CORE-06 — Answer the server's plugin-manifest query
**Source:** 08 §9.
**Retail:** `ClientAdminSystem::Handle_Admin__Recv_QueryPluginList` (0x6B5EE0,
acclient.c:719765) and `Handle_Admin__Recv_QueryPlugin` (0x6B5F80, :719792)
interrogate the loaded `IACPlugin` (client→plugin slot 3, `vfptr[1]` with a
`BSTR*` out-param at acclient.c:719776-719779) and report the plugin list — per
plugin: name, author, e-mail, webpage — via
`CM_Admin::Event_QueryPluginListResponse`. With no plugin loaded the client
answers `L"3rd party API not in use."`. This is the client's *only* anti-cheat
surface, and it is cooperative.
**Holtburger today:** we have exactly the data retail reports — 49 validated
manifests with `name`/`author`/`repo` (`plugins/index.json`,
`plugins/schemas/plugin-manifest.json`) plus the loader's `loaded`/`skipped`
maps (`plugins/loader.js:632-635`) — and none of the opcodes: ours are
commented out (`crates/holtburger-protocol/src/opcodes.rs:510-512`,
`:1024-1028`) and ACE ships the enum values only
(`GameEventType.cs:85-87`, `GameActionType.cs:150-151`; no handler files).
**Proposed change:** implement the client half — parse `Admin_QueryPluginList`
(0x02AE) / `Admin_QueryPlugin` (0x02B1) and reply
`QueryPluginListResponse` (0x02AF) / `QueryPluginResponse` (0x02B2) from the
loader's manifest set. **Constraint:** the server half needs an ACE change and
`memory/MEMORY.md` says *keep ACE vanilla* — so land the client half with a
recorded-packet test, and treat the ACE handler as a separate, explicitly
sanctioned decision.
**Payoff:** an attestation channel for what a client is running — directly
relevant to rynthsuite (a server operator can see which automation is active)
and to support triage.
**Effort:** M (client half S-M).
**Validation:** synthetic inbound packet → assert the response payload lists our
manifest set; assert the no-plugins case returns the retail sentinel string.

---

### CORE-09 — `setCombatMode(mode)` on the plugin API
**Source:** 08 §6 (`IAsheronsCall::ChangeCombatMode`).
**Holtburger today:** `client.player` exposes only `toggleCombatMode()`
(`plugins/api.js:443-445`), while the wasm export for the absolute form already
exists and rynth uses it — `ChangeCombatMode: ["setCombatMode"]`
(`rynth/webhost.js:77`, method at `:738`).
**Proposed change:** add `client.player.setCombatMode(mode)` using the existing
`CombatMode` enum (`plugins/api.js:578-584`).
**Payoff:** a plugin/bot can request a *specific* stance instead of toggling and
hoping; removes a state-machine race.
**Effort:** S (XS). **Validation:** call with MAGIC from peace and assert one
transition, not two.

---

## 3. PLUGIN-API SECTION (strategic deliverable)

### 3.1 What retail actually exposed

Two directions, one COM object each way, loaded at
`APIManager::Init` (acclient.c:393464): read `HKLM …\Asheron's Call\1.00\ACPlugin`
→ `LoadLibraryA` → `GetProcAddress("CreateACPlugin")` →
`pfCreateACPlugin(IAsheronsCall**, IACPlugin**)` (typedef at acclient.h:62492).

**Host → plugin (`IAsheronsCall`, the command surface).** The doc puts the vtable
at 52 slots, 16 of them `E_FAIL`. The methods still named in the decomp
(36 symbols under `APIManager::IAsheronsCallImpl::`) group as:

| Group | Methods |
|---|---|
| session | `BeginCharacterSession`, `EndCharacterSession` |
| identity/env | `GetPlayerID`, `GetCurCoords`, `GetCurLoc`, `GetScreenDimensions`, `GetIsOutdoors`* |
| selection | `GetSelectedItemID`, `SetSelectedObjectID`, `SelectItem`, `GetPreviousSelectedItemID`, `SetPreviousSelectedItemID`, `GetSelectedStackCount`†, `SetSelectedStackCount`† |
| objects | `GetItemName`, `ItemIsKnown`, `ExamineObject`, `GetGroundContainerID` |
| inventory | `MoveItemInternal`, `MoveItemExternal`, `UseObject`, `UseObjectOn`, `UseEquippedItem` |
| combat/magic | `CastSpell`, `ChangeCombatMode`, `GetCombatMode`† |
| movement | `TurnToHeading`, `SetAutoRun`, `StopCompletely`, `IsStandingStill` |
| chat | `WriteToChat`, `IssueChatBarCommand`, `GetChatState`† |
| vendor/trade/salvage | `GetVendorID`†, `TradeWindow_Clear` (real), `TradeWindow_*`† (IsOpen/GetPartnerID/AddItem/Accept/Close), `SalvagePanel_*`† (all six) |
| busy | `GetBusyCount`†, `IncrementBusyCount`†, `DecrementBusyCount`† |

† = `E_FAIL` stub or a silently-lying fold. The doc's two worst cases are the
lesson: `GetCombatMode` and `GetVendorID` are COMDAT-folded into one body at
0x55A050 that returns **`S_OK` without writing the out-parameter**, and
`GetSelectedStackCount` is a 5-byte `return 0` folded with 16 unrelated
functions — so `APIManager::UseObjectOn` (acclient.c:393120-393124) always takes
its failure path and **no caller can tell why**. A capability surface that
cannot report its own holes is worse than a smaller honest one.

**Plugin ← host (`IACPlugin`, the event surface).** I enumerated the call sites
(`APIManager::GetACPlugin()` → indirect vtable call) and resolved each enclosing
function. Slot index = `3N + {QueryInterface:0, AddRef:1, Release:2}` for
`vfptr[N]`:

| Slot | Fired from | Payload / semantics |
|---|---|---|
| 3 | `CPlayerSystem::SendQueryPluginData` (398759) and `ClientAdminSystem::Handle_Admin__Recv_QueryPluginList` (719776) | `BSTR*` out — the plugin manifest (→ CORE-06) |
| 6 | `CPlayerSystem::SendLoginCompleteNotification` (400399) | login complete, no args |
| 7 | `ClientSystem::AddTextToScroll` (401145) | `(wchar* text, u32 type, int* eaten)` — **inbound chat, eatable** |
| 8 | `ClientCommunicationSystem::OnChatCommand` (426170) | `(BSTR, PStringBase<u16>**)` — **outbound chat, rewritable** |
| 9 | `ACCObjectMaint::DeleteObject` (390932) | `(object_id)` — object released |
| 10 | `ACCWeenieObject::SetSelectedObject` (436834), `ACCWeenieObject::Remove` (438613) | `(u32 id, …)` — selection changed / object removed |
| 11 | `ClientCombatSystem::SetCombatMode` (408906) | `(COMBAT_MODE new, COMBAT_MODE old, …)` — combat-mode changed **with old value** |
| 16 | `Handle_Trade__Recv_CloseTrade` (410528) | trade closed |
| 17 | `Handle_Trade__Recv_AcceptTrade` (410383) / `DeclineTrade` (410417) | `(int which)` — 1 = accept, 2 = decline |
| 19 | `Handle_Trade__Recv_ResetTrade` (410147), `Recv_RegisterTrade`/`AddToTrade` (410628/410699) | trade reset / register / add |
| 20 | `ClientCommunicationSystem::HandleFailureEvent` (414898) | failure/error event |

So retail's *event* surface was **~12 callbacks, two of them eatable**, and both
eatable ones are chat. Everything else a Decal plugin knew, it polled.

### 3.2 What our plugins and rynth can reach today

Three parallel surfaces, none of them canonical:

| Surface | Shape | Reach | Problem |
|---|---|---|---|
| `plugins/api.js::createClient()` | 14 frozen namespaces + an `EventTarget` bus with ~20 named events (`api.js:49-65`) | in-tree plugins | `client.ui` is 3 **no-op stubs** (`:724-728`) with zero callers; no capability introspection; no chat hooks; `ClientState` is exported but dead |
| `rynth/webhost.js::RynthWebHost` | ~70 members, retail-named, **capability-probed** (`CAPABILITY_CANDIDATES`, `:25-120`), **frozen per-tick snapshot** (`:8-18`), web-worker heartbeat (`:19-21`) | rynth only | duplicates `client`; invisible to plugins |
| raw wasm `SessionHandle` | 188 methods | anyone, including `rynth/bot.js` directly (`bot.js:29`) | unversioned, no capability story, no stability contract |

The bus is genuinely ahead of retail (30+ event kinds vs ~12 callbacks, with a
maintained coverage audit at `plugins/api.js:16-70`: 6 IMPLEMENTED / 6 PARTIAL /
3 MISSING / 3 N-A across the Chorizite taxonomy). The loader is also ahead: JSON-
Schema manifest validation, `?`-optional dependency resolution with cycle
guarding, a 5-stage lifecycle, dev-sidecar overrides, and an **eatable bus**
(`plugins/loader.js:101-209`, `:321-387`, `:426-470`, `:517-636`).

What is *behind*: the command surface (retail had one place to look), UI
contribution (host-private: static `PLUGIN_MODULES` + hardcoded `BAR_SLOT_ORDER`
in `index.html:1779-1817`), and chat hooks (retail's two eatable callbacks are
the single most-used Decal capability and we have neither direction).

### 3.3 What a rynthsuite-facing plugin API should offer

Concretely, in dependency order:

1. **One facade, versioned and capability-probed** (CORE-07). `client.apiVersion`,
   `client.has(capability)`, and a `client._unsafeHandle` escape hatch. Adopt
   RynthWebHost's probe verbatim — it is the direct antidote to retail's
   silent-`E_FAIL` failure mode, and it already tolerates a stale `pkg/`.
2. **A frozen per-tick snapshot for polled reads** (from `webhost.js:8-18`).
   Retail's plugins polled everything; a bot that polls a live `RefCell` mid-tick
   sees a half-stepped world. One synchronous compose per tick fixes it for both
   plugins and rynth.
3. **The full command vocabulary**, retail-named where a name exists. Missing on
   `client` today and needed by any automation: `writeToChat`,
   `issueChatBarCommand`, `turnToHeading`, `setAutoRun`, `stopCompletely`,
   `isStandingStill`, `setCombatMode` (CORE-09), `getCombatMode`,
   `getGroundContainerId`, `examineObject`, `getItemName`, `selectObject` /
   `getSelectedItemId`, `moveItemToContainer` / `splitStack` / `mergeStacks`,
   `wield`/`unwield`/`drop`, `buyFromVendor`/`sellToVendor`,
   `sendConfirmationResponse`, `getBusyState`/`forceResetBusyCount`,
   `raiseAttribute`/`raiseVital`. **Every one of these already exists on
   `RynthWebHost`** (lines 398-938) — this is a re-export, not new work.
4. **Real UI contribution** (CORE-08): `registerBarSlot`, `openPanel`,
   `closePanel`, `registerHudLayer` over a genuine z-order manager (UI-04), so a
   rynthsuite panel needs no `index.html` edit.
5. **Both chat hooks, eatable** (CORE-10) — retail slots 7 and 8. This is the
   highest-leverage single addition: chat triggers, filters, loggers and command
   extensions all fall out of it, and rynth's control channel stops needing its
   own tell-parsing path.
6. **A typed lifecycle** (CORE-02): `stateChanged {oldState, newState}` over the
   already-ported `ClientState`, replacing `window.__bootState` string sniffing.
   Retail's `ChangeCombatMode` callback carrying the **old** value is the pattern
   — deltas, not levels.
7. **Permissions and attestation.** Retail had none locally but *did* answer a
   server-side plugin-manifest query (CORE-06). For rynthsuite the manifest is
   the natural place to declare intent (`capabilities: ["chat", "movement",
   "inventory", "network"]`), gate the facade on it, and report it both to a
   local plugin-manager panel and, when the server asks, over 0x02AF.
8. **A stable out-of-process seam.** `rynth/control_channel.js` (in-game tells)
   and `rynth/webhost.js` (in-page) are two transports for one API. Once (1)-(3)
   land, the same vocabulary can be exposed over a documented postMessage/WS
   bridge for rynth-ai without a third facade appearing.

**Headline:** *holtburger has three host facades where retail had one, and the
most complete one is the bot's.* `rynth/webhost.js` is an independent
re-derivation of `IAsheronsCall` — retail method names and all — with two
patterns retail lacked and needed (capability probing, frozen tick snapshots).
The consolidation is therefore not a rewrite but a **promotion**: make
RynthWebHost's contract the one `client` facade, keep the loader's eatable bus,
add retail's two chat hooks, and make `client.ui` real.

---

## 4. ANTI-TASKS (do not port)

* **AT-1 — the widget class tower and dirty-rect compositor** (05 §1, §4).
  `UIRegion`/`UIElement`/`UIObject` + per-window `UISurface` textures + dirty-rect
  invalidation exist because 1999 D3D had no compositor. The DOM is a retained-mode
  tree with a hardware compositor. Take the *vocabulary* (z-level, block-clicks,
  draw-after-children) for UI-04; leave the machinery.
* **AT-2 — `UIElement_Browser` / `Trowser.dll` / KeyStone** (05 §12, 08 §12).
  A child HWND DC-redirected into a UI surface, with a refcount that disables
  exclusive fullscreen. We are the browser.
* **AT-3 — the per-control first-writer-wins binding merge** (05 §7). Retail's
  `push_tail` never overwrites and the key is the *control*, so rebinding an
  action leaves it on both keys. That is a bug. Our `labelHash`-keyed override
  (`ui/keymap.js:206-219`) is the right model.
* **AT-4 — DirectInput polling, the 4-px drag threshold, IME lead-byte state
  machine** (05 §5, §7). Pointer events, native HTML5 DnD thresholds and browser
  IME are all better and already ours.
* **AT-5 — the `'?'` missing-glyph fallback** (05 §11). Retail retries once with
  `'?'`. Ours chains to a CJK atlas and then to the system font with a cached
  advance (`ui/ac_font.js:613-627`, `:712-726`). Keep ours.
* **AT-6 — `DoFrameSleep`'s ~99 ms inactive budget and `Sleep(0)`** (08 §2).
  Browsers throttle hidden tabs already, and our answer to the *consequence*
  (session timeout) is better: the heartbeat lives in a dedicated worker whose
  timers are not throttled (`scene3d/keepalive_worker_client.js:1-33`).
* **AT-7 — retail's crash-handling design** (08 §9). Not because ours is
  similar, but because retail's is **absent**: the 100 MB emergency pool,
  `TurbineExceptionFilter` and Watson are all gated on a `DebugFlags` bit that
  `Debug::Init` clears. Do not treat "retail didn't" as licence — we already do
  better with WebGL context recovery and per-plugin fault isolation.

---

## 5. DOC CORRECTIONS

**DOC-CORR-1 — 05 §7's activation bitfield is incomplete (three missing bits).**
The doc lists 1 press, 2 release, 4 tap, 8 dbl-click, `0x20`
dbl-click-in-place, `0x80` axis. `CInputManager_WIN32::FireInputEvent` also sets:
* **`0x80000000` on every fired event** — `v14 = v11 | 0x80000000; cat = v11 | 0x80000000;`
  (acclient.c:672464-672465);
* **`0x10`** when the release follows a double-click —
  `v14 = v11 | 0x80000010;` (acclient.c:672477-672478);
* **`0x40`** when that double-click was also in-place —
  `v14 |= 0x40u;` (acclient.c:672486).

Consequence for anyone consuming the field (us, in UI-02): activation must be
**masked**, never compared for equality — a plain press arrives as `0x80000001`,
not `1`. The doc's `0xA9` composite claim is correct as a *mask*
(`m_InputKey.m_activation & 0xA9`, acclient.c:112064).

**DOC-CORR-2 — 08 §5 mis-groups three distinct reply commands as aliases.**
The doc writes "`notell` / `retell` / `reply` / `r` / `rt`", which reads as one
alias group. The registrations show **three** handlers:
`notell → ClientCommunicationSystem::DoNoTell`; `reply`, `r`, `rp` → `DoReply`;
`retell`, `rt` → `DoReTell` (extracted from acclient.c:426430-430260;
`rp → DoReply` visible at acclient.c:427961-427966). Practical effect: `notell`
is its own command, not a reply alias. (Our client already gets this right —
`REPLY_ALIASES = {reply, r, rp}`, `RETELL_ALIASES = {retell, rt}` at
`index.html:5969-5970` — but it lacks `notell`.)

**DOC-CORR-3 — 08 §5: four of the 116 tokens have no command handler.**
`mr`, `pr`, `status` and `text` are registered with a **null** do-function where
every other token passes a `DoX`: `mr` at acclient.c:427992-428000 and `pr` at
acclient.c:428023-428031 pass `0, 0, HelpReply, 0`; `status` and `text` pass
`0, 0, HelpStatusGroup / HelpTextGroup, 0`. They parse and print help but do
nothing (`status`/`text` are help *category* headers). Anyone porting the table
should not expect behaviour from these four — the effective command count is
**112**.

**DOC-CORR-4 (refinement, not an error) — 05 §3's "eleven `MD_Data_*`
subclasses" is right about the client but not about the format.** There are
exactly 11 subclasses (`rg -o 'struct __cppobj[^:]*MD_Data_[A-Za-z]+' acclient.h`
→ 11 distinct), and the doc's opcode numbers match the dispatch at
acclient.c:162472-162516 exactly. But the on-disk `MediaType` enum has **13**
values — `Undef = 0` and `Stretch = 0xC` have no client subclass
(`crates/holtburger-dat/src/file_type/media_desc.rs:23-37`, whose header notes
"DRW handles 11/13 MediaType values (no Undef, no Stretch)"). A parser author
reading §3 alone would not know two tags exist that must be rejected.

**Not corrections, recorded as cross-source hazards:**
* ACE's `RadarColor.BrightGreen = 0x10` (`ACE.Entity/Enum/RadarColor.cs:15`) is
  unreachable by retail's `GetBlipColor`, whose switch ends at `case 10:`
  (acclient.c:262770). Neither source is "wrong"; a client talking to ACE must
  accept both (UI-09).
* The in-memory `QualifiedControl` (acclient.h:27511-27516) has **no**
  `action_hash` — the action is the `HashList` *value* keyed by the control —
  while the on-disk KeyMap record stores the pair
  (`crates/holtburger-dat/src/file_type/keymap.rs:78-84`). Both are right; the
  doc describes the in-memory form only.

---

## 6. OPEN QUESTIONS

* **OQ-1 — Does the pre-TimeSync window actually stamp prune deadlines in
  practice?** CORE-01's domain mismatch is reading-provable; whether a *live*
  boot reaches `current_server_time()` before the first sync is not. ACE sends
  TimeSync inside the ConnectRequest handshake, so the window may be sub-frame —
  but `types.rs:937-939` says otherwise. Cheapest test: instrument the fallback
  branch with a counter and boot headless with `?nullRender=1`.
* **OQ-2 — What is retail's effective mouse-look sensitivity in rad/pixel?**
  §8 gives `m_MouseLookSensitivity * 0.06666667`, but I could not recover the
  preference's default value, so our `0.0025` rad/px cannot be compared. Needs
  the `Input_MouseLookSensitivity` default (probably in the ctor near
  acclient.c:147921 where `m_rCameraAdjustmentSpeed = 40.0` lives).
* **OQ-3 — Which `AddKeyMap` enum resolves to `gmDefaultMap 0x14000000`?**
  Boot merges `AddKeyMap(0x10000001)` then `AddKeyMap(1)` through
  `GetByEnum(_actID, 10, 0x1Du)`. `gmDefaultMap` has 14 input-map categories
  while `ActionMap 0x26000000` has 27 — so a second KeyMap record supplies the
  rest. Finding it matters for UI-01's default-binding coverage.
* **OQ-4 — Do the two extra meta slots (`0x08000000`, `0x04000000`) correspond
  to keyboard Tab/Q?** The shipped `gmDefaultMap.metaKeys` entries are
  `0x000F0001` and `0x00100001` — `ofsKey` `0x0F`/`0x10` = DIK_TAB/DIK_Q, but
  the device index byte is `1`, which is the *Mouse* in `devices[]`. Either the
  encoding differs for these slots or `keymap.js:353-355`'s "TAB / Q" note is a
  coincidence. Blocks UI-03's "two extra modifiers for free" claim.
* **OQ-5 — Is retail's toggle-type numbering exactly
  `{1 Momentary, 2 Toggle, 3 Impulse, 4 AutoRepeat, 5 Held}`?** The decomp pins
  the *behaviour* of 1-5 (acclient.c:112031-112070) and the shipped ActionMap's
  Chorizite-decoded histogram (Impulse 318 / Momentary 53 / Toggle 2 /
  AutoRepeat 16) is consistent with Impulse = 3 = the forced default, but I found
  no enum declaration in `acclient.h` to confirm the name↔value mapping. UI-02
  should assert on the numbers, not the names.
* **OQ-6 — Does ACE ever emit `TextTag` markers in chat?** UI-20 is pointless if
  the server never sends them. Check ACE's `GameMessageSystemChat` /
  `GameMessageHearSpeech` payloads for tag escapes before building the renderer.
* **OQ-7 — Does our shortcut path have retail's target-mode arm?**
  `UseShortcut` (acclient.c:239995-240033) branches on
  `ClientUISystem::targetMode` before falling back to `UseObject` /
  `SetSelectedObject`. I could not find an equivalent pending-target state in
  `plugins/hotbar.js`. Needs a live check with a targeted-use item.
* **OQ-8 — How much of the `game_ui_misc` module (103 objs, the largest single
  group in the PDB, 08 §14) do our 49 plugins actually cover?** The 84-class
  roster gives a *count*, not a mass. A per-class PDB byte-size histogram would
  tell us how much UI work remains and where it is concentrated — worth doing
  before committing to UI-21's ordering.
