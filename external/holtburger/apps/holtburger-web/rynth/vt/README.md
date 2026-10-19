# rynth/vt/ — the VTank layer of the RynthSuite bot

The VTank feature set (options, settings profiles, monster list with expressions, items,
consumables, buffs, navigation routes, metas, loot profiles, `/rs` commands) added to the web
RynthSuite bot **without changing what the bot already does**. Design and contracts:
`/mnt/wbterminal1/rynth-vtank-2026-10-12/design/PLAN.md` (D1-D39, §3 APIs, §8 invariants);
per-package reports in `…/impl/`, the whole-diff review and its fixes in `…/review/`.
Delivery status, the decisions taken after the plan, known gaps and the live checklist:
`../../../../docs/rynth-integration/STATUS.md` (2026-10-13 update). Gate green; the live
checklist on the 1070 is still pending.

## Defaults and the escape hatch

- **The layer loads with every bot** (`createGrindBot`, unless `config.vt === false`).
  `?botVt=off` (exact string) boots the bot without it: no `bot.vt`, no kernel `aux` slots,
  the literal grind ladder — byte-for-byte the pre-VTank bot (`docs/url-flags.md`). It holds
  for `?bot=1` and for a HUD START on that page (the HUD then boots with its own saved
  settings, as before the layer).
- **At the Default profile it changes nothing.** Every new option defaults to today's
  behaviour (D3); the parity oracle `tests/rynth_vt_parity.test.mjs` (T-P1) runs one
  scripted world with and without the layer and compares every kernel action and every host
  action call. The VTank/RynthAi defaults are one click away: **⋯ (profile drawer) → Apply
  VTank/RynthAi defaults** (or `/rs settings preset vtank`) writes Autostack, Autocram, Peace
  Mode When Idle, Follow/Nav Min 1.5 m, VTank war spells and pet refill into the active (user)
  profile. These are RynthAi's values (`LegacyUiSettings.cs`, PLAN D3), not read from a
  VTank-written `defaultsettings.usd`; WebAC (`vtankOptions.ts`) reports that file ships
  Autocram and Peace Mode When Idle off and Nav close-stop ≈ 2 m — unverified here, so the
  preset keeps the RynthAi values until a real VTank file is checked.

## How you reach it

| Way in | What it does |
|---|---|
| `/rs …` `/vt …` (chat bar, meta Chat actions, nav Chat points, `host.InvokeChatParser`) | `app/slash_commands.js` hands the line to `window.__rynthVt.route` (`rs_entry.js`) — **never to ACE**. `/ra` `/mt` `/ub` are the RynthAi / Mag-Tools / UtilityBelt compat tables. `@rs …` still goes to the server as typed. |
| `!bot rs …` / `!bot vt …` tells | `control_channel.js` → the bot's dispatcher (owner allowlist + rate limit unchanged); the first 3 result lines are the reply. |
| RynthSuite HUD → **VT** button (selectors row), `/rs ui [tab]` | Opens the VTank panel (`plugins/rynth-vt/panel.js`, lazy). A command bar (RUN · COMBAT BUFF NAV LOOT META · profile ▾ · ⋯ Save As / Delete / presets) over one row of 8 tabs: Main (Options + Vitals) · Monsters · Items (+ Consumables) · Buffs · Route · Loot · Meta · Advanced. The v1 tab names still open (`/rs ui vitals` → Main, `consumables` → Items, `profiles` → Main). `rynth_vt_preview.html` shows the panel on a scripted world, without a client. |
| RynthSuite HUD **Nav** toggle | With a VTank route loaded it is that route's navigation (EnableNavigation + resume); otherwise the old atlas follow / cancel. HUD "Stop moving" pauses a VTank route until Nav is clicked again. |

`/rs help` lists every verb; `/ra help`, `/mt help`, `/ub help` the compat ones. Settings and
profiles work **without a bot** (the page session). Without the layer (no bot yet, or
`?botVt=off`) route / meta / `/rs loot` / jump / follow verbs answer "start the bot first";
item, cast and face verbs run through the bot's host whenever a bot is running (so also on a
`?botVt=off` page); and the verbs that queue work — `/ub delay`, a multi-stack `/ra give…`, a
`/mt loot` retry — answer "… needs the VTank layer: nothing runs this page's command queue"
(`rs_entry.js` builds that dispatcher with `canQueue: false`). `!bot rs …` to a bot without
the layer runs on that page dispatcher once the page has one (after a `/rs` line, or the HUD
loaded it), else replies "rs unavailable — the VTank layer is not loaded". An unknown verb is a local error line
(`[RynthSuite] unknown /rs command 'x'`), never `@x`.

### Commands

`/rs` and `/vt` are the same table (`cmd/rs_commands.js`):

| Verbs | What they do |
|---|---|
| `start` · `stop` · `toggle` | Run Macro: pause / resume the bot — through the HUD when it is mounted (its START also boots a bot), else `bot.control` |
| `forcebuff` · `cancelforcebuff` (`cancelbuff`) | Force Buff / Cancel Force Buff (G:10-11) |
| `opt list [filter]` · `opt get <name>` · `opt set <name> <value>` · `opt remember\|restore <name>` | Every option, VTank names accepted (`RouteReversed` is read-only) |
| `settings list` · `load <name>` · `saveas <name> [mine]` · `preset vtank` · `importhud` · `loadchar <name>` · `savechar <name>` | Profiles |
| `nav save\|load <name>` · `nav clear\|start\|stop\|status\|list` · `nav type <circular\|linear\|follow\|once>` · `nav setcurrent <n>` · `nav next\|prev` · `nav delete <n>` | Routes (G:216-217) |
| `addnavpt [coords]` · `addnavcheckpoint` · `addnavjump [heading] [true\|false] [charge] [strafeleft\|straferight\|forward]` | Add waypoints (G:218-222); `addnavpt` takes `12.3N 41.5E` or `ns ew [z]`, none = here |
| `jump [heading] [true\|false] [ms]` · `jump[swzxc] [heading] [holdMs]` | Jump now (G:220). A bare `/rs jump 90` or `/vt jump 90` is heading 90; `/rs jump 90 500` adds a 500 ms charge |
| `reverseroute [true\|false]` · `reverseroutequery` | Reverse the route (no argument toggles) / print the flag (G:223-224) |
| `follow <name>\|leader\|off\|status` | Follow route target |
| `meta load <name>` · `meta list\|state\|enable\|disable` · `meta debug on\|off` · `meta setstate <state>` · `setmetastate <state>` · `mexec <expression>` | Metas |
| `loot load <name>` · `loot none` · `loot list` | Loot profiles |
| `listmonstervariables` · `setattackbar <0..1>` · `echo <text>` · `ui [tab]` · `refresh` · `help` | Misc (`refresh` is a no-op on web) |

Compat tables (`cmd/compat_commands.js`): `/ra` — `use… select… give…` (`givea…` give-all
variants also take `stop`, which cancels the queued gives), `cast <spellId>`, `power`,
`forcebuff` / `cancelforcebuff`, `follow`, `mexec`, `myquests`, `clearbusy`, `panic`,
`addnavpt`, `navdebug`, `jump[swzxc]`; `/mt` — `opt`, `combatstate`, `face <degrees>`,
`cast[p] <id|name> [on <target>]`, `use…` (incl. `closestnpc|closestvendor|closestportal`),
`select`, `give`, `loot`, `drop`, `equip` / `dequip`, `fellow`, `logoff`, `send`; `/ub` —
`mexec`, `delay <ms> <command>`, `myquests`, `follow`, `opt`, `clearbugged`, `jump[swzxc]`,
and every other `/mt` verb. `/ra ig` / `igp` and `/ub ig` / `igp` (give by loot profile)
answer "… is not supported on web". `/ra jump 90` and `/ub jump 90` keep UtilityBelt's
reading (a single integer is the hold time). Motion verbs (jump, `nav start`,
`follow <target>`, `/mt face`) are refused while the bot is STOPPED or in portal space.

## Layout

| Path | Role | Package |
|---|---|---|
| `expr/` | The one expression language (monster expressions + metas): lexer, parser, values, evaluator, .NET→JS regex, vars (session / persistent / global), pure function library | W1-1 EXPR |
| `settings/` | `VtOptions` — the single settings authority (schema rows, live cells over the loop fields, profiles, named stores, the page-level `VtSession`) | W1-2 SET |
| `formats/` | `.met` / metaf `.af` / view XML / VT `.utl` loot profiles (parse + write, round-trip stable); VTank `.usd` settings profiles (import only) | W1-3 FMT |
| `meta/` | The meta engine (states, rules, conditions, actions, watchdog, views) | W1-4 META |
| `cmd/` | `/rs` dispatcher, compat verbs, world/inventory action helpers, meta host functions, quest tracker | W1-5 CMD |
| `nav/` | Routes (Circular / Linear / Follow / Once), `.nav` profiles, `ActiveNav` + one tick-driven executor per waypoint type | W1-6 NAV |
| `combat/` | Monster list (P −1..4 tiers, columns, expressions), monster variables, spell tables, debuff ledger, attack planner, Items, creature profiles | W1-7 CMB |
| `host_signals.js` | ONE `host.onEvent` subscription → typed signals (chat, tell, castLine, death, portal, vendor, inventory, equip, …) | W1-8 SEAM |
| `support/` | Consumables, kits/potions (Supplies), dispel, mana stones, autostack / autocram / peas, pets, fellowship, doors, buff items, idle (peace mode, idle rebuff) | W1-9 SUP |
| `bridge/` + `../../plugins/rynth-vt/` | The panel's pure view-model + commands, and the panel DOM | W1-10 UI |
| `index.js`, `rs_entry.js`, `glue/` | Composition root (`createVtLayer`), the page entry (`window.__rynthVt`), MetaContext / HostFnContext / `.utl` item context | INT-2 |
| `data/`, `tools/` | Spell / species / pet-essence / dispel / harmful-family tables, and the species and pet-essence generators (`tools/gen_creature_species.cjs`, `tools/gen_pet_essences.cjs`) | CMB, SUP |

Edits outside this directory (all additive; the absent-layer path is unchanged except for the
three changes and the HUD label named at the end of this paragraph): `kernel.js`
(`aux` slots), `combat_loop.js` / `buff_loop.js` / `loot_loop.js` (hooks, all inert at
defaults), `router.js` (per-leg `arriveM`), `goto_compose.js` (exports), `webhost.js`
(new members), `bot.js`, `ai/operator_stop.js`, `unwedge.js`, `control_channel.js`,
`hud_bridge.js`, `boot.js`, `../app/slash_commands.js`, `../app/client_events.js` (reads
`botVt`), `../plugins/rynth-hud.js`, and the page seams `../plugins/api.js`
(`API_VERSION` 1.2.0), `../plugins/inventory.js` (selection event), `../plugins/vendor-ui.js`
(vendor-closed event). Three changes in shared files apply with or without the layer:
`webhost.js`'s legacy `CastSpell(0, id)` refuses a spell that is not SelfTargeted when spell
records are available (D12, the crash class; the existing untargeted casts, e.g. recall, are
SelfTargeted); `control_channel.js` reads a tell only from a TELL-category chat line (2, or 0
from a host that does not report the category — an emote can print `You think, "…"`); and
`kernel.js` installs its tick closure on a held boot too (`_installTick`, inert while held),
so the kernel keeps its place in the heartbeat order after RESUME. The HUD's grind | explorer
selector is now labelled "Persona" instead of "Profile".

## Runtime

- `bot.js` imports `vt/index.js` **dynamically** (`.catch` → no layer) and attaches the layer
  after the bot is built, bounded to 3 s (a slow or failing layer never blocks the boot; a late
  layer is attached, or disposed if the bot stopped meanwhile).
- Everything runs off the host's **Worker heartbeat** (10 Hz, keeps going in a hidden tab): a
  pre-tick before the kernel (signals, meta pass, the `/ub delay` / give / loot-retry queues,
  autosave) and a 2 Hz post-tick (inventory / mana-stone reflexes, fellowship). No
  `setTimeout` / `setInterval` in bot-side logic (the Jump waypoint wraps the existing async
  jump primitive; the 3 s boot race).
- **Hidden tab after a teleport** (pre-existing, not fixed here): portal space ends only on the
  page's frame loop (`scene3d/portal_space.js`, rAF or the opt-in `?netDrainHz` interval), so
  on a hidden tab VT nav and the base combat / loot / buff / vitals loops hold after a teleport
  until the tab is shown (only the base router has its own 90 s cap). `host_signals.js`
  synthesizes ONE `portalOut` 90 s after the arrival while the flag stays up
  (`PORTAL_OUT_STUCK_MS`), so metas see the exit; movers keep holding.
- **Kernel slots** (`aux`, priority order inside each rank): `Supplies` (after Vitals, keeps the
  combat loop), `JumpNow` (after Unwedge), `Pets`, `Doors`, `Navigate`, `BuffItems`,
  `IdleRebuff`; idle hook `PeaceMode`. By default Navigate ranks just above Idle (it walks
  when nothing else wants the tick).
- **Boost Nav Priority** lifts Navigate above unlocked threats. Gentle (default) never drops a
  locked target; under attack it steps aside only when there is a fight (or the after-kill
  corpse) to run, and keeps walking otherwise. `BoostNavStrict` = VTank-literal (above pinned
  Combat too). Boosted, gentle or strict, it still yields to buffing (D39) and to a loot
  already in flight (approach / open / pickup) — boost outranks only a corpse not yet
  started. Boosted or not, Navigate also yields while a Consumables buff item (beer / food) is
  due. A door being opened (`Doors`) yields to the same things and is dropped, not failed;
  its 5 s cooldown never holds the tick. **Boost Loot Priority** loots before engaging the next
  unlocked threat unless under attack.
- A VT-nav step that cannot be interrupted (recall cast, portal / NPC use, a jump waypoint or
  a stuck-point jump, an earlier jump still in the air) keeps the tick ahead of Combat
  (`aux.policy.pinnedFirst`, below only Vitals / Unwedge); none of the yields above apply to
  it. A `/rs jump` is refused while a nav jump is in the air.
- **Session state lives on the page** (`window.__rynthVtSessions`, one per character): the nav
  route + index, meta state, the Default overlay, session variables, the bound loot profile
  and a SwitchWandsToDebuff weapon swap still owed (the next bot puts the weapon back) survive
  a bot rebind (takeover, HUD Restart); a page reload starts fresh (VTank login semantics).

## Hard rules (every file here)

- **Casts only** through `host.CastSpellAt(guid, id)`, `host.CastSelf(id)` or
  `host.CastUntargetedSafe(id, {allowRing})` — untargeted only for SelfTargeted spells, or a
  gated War/Void ring. An untargeted cast of anything else crashes vanilla ACE (see
  `../README.md`). The strings `CastSpell(`, `CastUntargetedSpell(`, `castTargetedSpell`,
  `castUntargetedSpell`, `WriteToChat(` must not appear in `rynth/vt/**` or
  `plugins/rynth-vt/**` (grep test T-S1 in `tests/rynth_vt_layer.test.mjs`).
- **Chat**: local output only via `host.WriteToChatWindow` / the injected `print`; nothing in
  the `/rs` family is ever sent to the server.
- **Item actions** claim the item token (`host.tryClaimItemAction`); casts claim the cast token.
  Autostack / autocram / mana stones act only while the kernel is Idle or Navigating, loot is
  scanning, nothing is busy and no container is open.
- **Operator hold wins**: while the bot is STOPPED nothing here acts (meta passes, the
  delayexec, `/ub delay`, give-all and `/mt loot` queues wait for RESUME) — except Mana
  Charges When Off refills. A meta `setmotion[]` cannot press a movement key while held, and
  STOP releases every key one pressed (one `SetMovementInput(0,0,0,false)`); so does
  `bot.stop()`. VT code never calls `kernel.start/stop`; Run Macro is `bot.control`.
- **Portal space holds** every mover, caster and item action; the meta watchdog pauses;
  `setmotion[]` keys are released on entering portal space and cannot be pressed in it.
  They are also released when EnableMeta goes off and on a meta load / unload (RYNTH-1).
- **Imports**: a Wave-1 package never imports another vt package (dependencies are injected);
  only `index.js`, `rs_entry.js` and `glue/` compose them. Nothing here is statically imported by
  `bot.js`, `boot.js`, `app/*`, `index.html` or the HUD (`gen-modulepreload --check`);
  `webhost.js` keeps zero imports.

## Settings and profiles

- **One authority** (`settings/options.js`): `/rs opt`, the panel, meta `GetOpt`/`SetOpt`,
  `vtgetsetting[]` and friends, monster `setting_X`. Keys that already exist in a loop (vitals
  thresholds, loot floor, enable flags, attack power/height, blacklist) are **live cells** —
  the loop field is the storage, so HUD / director / `!bot` writes are seen without hooks.
- VTank names are accepted case-insensitively; landblock-fraction names convert ×240 only at
  that boundary (`/vt opt get AttackDistance` = MonsterRange ÷ 240; canonical keys are metres).
  Unknown names are an error for `/rs opt` and a meta-only bag for `SetOpt`/`GetOpt`.
- **Profiles**: `Default` is read-only — edits on it live in a per-page overlay and are lost on
  reload (the panel says so). Switching to a user profile and back to Default starts a fresh
  overlay: Default means the schema defaults again (G:48); re-selecting the profile you are
  on changes nothing. **Save As** creates a shared profile, or a per-character one with
  *Mine Only*; `[By char]` is created from the live values on first selection. A user profile
  saves immediately on every edit (and every 2 s for drift written by the HUD / director).
  Names: letters, digits, `_ ' -`, ≤ 40 characters, **no spaces** (G:54) — so the corpus line
  `/vt settings loadchar Quest Profile` answers `no char profile named "Quest Profile"` (owner
  decision).
- **With the HUD** (`hud_bridge.js`): while a user profile is active, HUD START / Restart boot
  with the profile's legacy values (`hudBootOverrides()`) plus the HUD persona (on a
  `?botVt=off` page they always use the HUD blob, as before the layer); the HUD's own
  edits (monster priorities, loot floor, vitals, buff list) still write `rynth.hud.settings.v1`
  and are also noted into the active profile (Default ⇒ the overlay). **Import HUD settings**
  (the panel's ⋯ profile drawer, `/rs settings importhud`) copies the HUD blob into a user profile.
- Selecting a profile pushes all of its values (legacy ones included) and loads its nav
  profile, meta and loot profile — except a meta that is already running under the same
  name, which keeps its state, call stack and timers (a meta can switch profiles from its own
  Chat action). On a `?bot=1` page the first bot attach pushes the active
  user profile except keys the URL pins (`?botBuffs` → buffs, `?botPersona=explorer` →
  EnableCombat / EnableLooting).
- **Ranges**: MonsterRange (default 40 m) and ApproachRange (default 4 m) widen the client's
  entity scan (`host.nearbyRangeM`) only when set above those defaults, to that range + 5 m,
  and never below the configured base; at Default the scan radius is untouched.
- **Rebuff When Idle** (`RebuffWhenIdle`; `IdleRebuffWindowSec` 600 s on top of
  `RebuffSecondsRemaining` 300 s) recasts a buff while idle once less than threshold + window
  is left, but never while more than half of its landed duration is left (the window is
  capped at `duration/2 − RebuffSecondsRemaining` per buff), so large settings cannot recast
  fresh buffs in a loop. At the defaults a buff of 30 min or more is recast when < 15 min
  remain. When it fires, the buff loop's existing batch rule (B11) recasts every desired buff
  to align timers.
- **Buff tier by skill** (`BuffTierSkillCap`, default off; thresholds
  `BuffMinSkillLevelTier1`..`8`, RynthAi defaults 35..435): self buffs and vital spells use
  the highest known tier the buffed skill of their school reaches, instead of the highest
  known tier (RynthAi GetHighestBuffSpellTier). `index.js` projects the option onto the
  buff and vitals loops' `setSkillCap` (one `rynth/skill_cap.js` `createHostSkillCap` over
  the host, rebuilt when a threshold changes, re-applied to a loop `bot.setBuffs` replaced);
  off — the default — never touches a loop, and turning it off hands both loops `null`.
- **The scroll ladder** (2026-10-19): `rynth/spell_ladders.json` marks every buff family's
  scroll spells, tiers I–VIII (`rynth/buff_families.js`; checked against the ACE world
  DB's scroll items). The Buffs tab and Auto only ever show and cast those — a developer who
  knows every spell no longer gets Zongo's Fist for Strength or Combat Medication (60 s) for
  Regeneration. The Buffs tab writes family selections only (`toLadderSpec`), and `index.js`
  rewrites a list saved before the ladder flags onto the ladder once the table is loaded
  (the bot casts an off-ladder id in an explicit `?botBuffs` / HUD spec exactly as named).

Storage (all `localStorage`, try/catch everywhere):

| Key | Contents |
|---|---|
| `rynth.vt.v1.profile.shared.<Name>`, `rynth.vt.v1.profile.char.<guid>.<Name>`, `….__bychar__` | profiles (`{settings, lists, refs}` — settings as a diff from the defaults) |
| `rynth.vt.v1.active.<guid>` | the selected profile |
| `rynth.vt.v1.nav.<name>`, `rynth.vt.v1.meta.<name>`, `rynth.vt.v1.loot.<name>` | nav routes, metas, loot profiles (overwrite on save) |
| `rynth.vt.v1.pvars.<guid>`, `rynth.vt.v1.gvars` | persistent / global meta variables (scalars); global ones written by another tab are re-read, and a flush merges only this tab's own changes |
| `rynth.vt.v1.creatures` | learned creature profiles (LRU 2000) |
| `rynth.vt.ui.v1` | panel prefs (open, tab, opacity, Route tab "Show path" and add kind); its position is `hb.window.ffff0141` |

## Expressions (monster list and metas)

One dialect for both (PLAN §3.4). Things that differ from what you might expect:

- Precedence, low → high: `;` < `=` < `||` < `&&` < `|` < `^` < `&` < comparisons < `#` (regex
  match) < `<< >>` < `+ -` < `* / %` < unary. So `10-2+3` is 11 and `2+3#5` is true.
- **Bitwise binds below comparisons** (as in C#): `mask&$s>0` means `mask&($s>0)` — write
  `(mask&$s)>0`. **`&&` / `||` yield a Bool** (the guide), not UtilityBelt's operand value.
  `=` binds below `&&`.
- **Regex after `#`**: `| ^ $ * + ( )` are operators outside backticks. Escape or backtick
  them: `name#\^Drudge`, ``name#`drudge|mosswart` `` (`name#drudge|mosswart` would mean
  `(name#drudge) | mosswart`).
- Whitespace is insignificant around comparison / logical operators, parentheses and argument
  separators, kept elsewhere: `range>5 && species==drudge && name!=drudge ravener` works, and
  `chatbox[\/t +getcharstringprop[1]+\, Press]` keeps its `"/t "`.
- `$x` / `getvar[x]` of an unset variable is `0`. A world object compares as 0 numerically —
  test it with `!= 0` or `wobjectgetid[…]`. Bitwise operators use 64-bit integers.
- `delayexec[]` works in metas only; in a monster expression it is an error value.
- Monster mode: a bare word that names a monster variable (`/rs listmonstervariables`) is that
  value, anything else is a literal string; `setting_X` reads an option (exact case first).
  Metas read the meta state with `vtgetmetastate[]`.
- A parse or evaluation error is an error value (`/rs mexec` shows it, the Monsters editor
  marks the row), never a silent empty string.

## Metas, routes, loot profiles

- Metas import from VTank `.met` (byte-stable round trip), metaf `.af` and JSON; the panel
  edits rules live without leaving the current state. Views (`CreateView`) are rendered by
  `plugins/rynth-vt/meta_views.js`; they are destroyed when the bot stops or is rebound, and an
  already-fired `CreateView` rule re-creates its window only when its state is re-entered.
  An `.af` `EmbedNav tag {name} {a b c d e f g}` point transform (metaf, for duplicated
  dungeons) is baked into a derived route under a new tag, as metaf does in the `.met`.
- Routes import uTank2 `.nav` text (incl. Follow files) and metaf NAV sections; the web-only
  jump strafe direction is dropped on export with a warning. Insert above / below, the active
  row and the ten waypoint types (Point, Portal, Recall, Pause, Chat, Open Vendor, Portal/NPC,
  NPC Talk, Checkpoint, Jump) follow §2.8 of the plan. Stuck points retry, jump, skip, then
  pause with a chat alert; unwedge's recall / `@teleloc` rungs are suppressed while a VT route
  is active.
- The route is drawn in the 3D world (2026-10-19, `scene3d/route_overlay.js`, as VTank drew it
  in the retail client): a ring at every walked waypoint (at the arrival radius), the path
  between them with direction chevrons (a dashed closing leg on Circular routes; teleport legs
  hidden), the in-place waypoints (Recall, Pause, Chat, Checkpoint, Jump) as small gems at the
  waypoint they run at, the current waypoint pulsing green with a line from your feet. It
  shows while the panel's Route tab is open, or always with the tab's **Show path** pinned
  (also after a reload, without opening the panel); `NavLineThickness` / `NavRingThickness`
  (Advanced › Navigation) set its widths. Six draw calls while shown, none when hidden.
- `/rs reverseroute` reverses the points and moves the index to the same waypoint, so the walk
  turns around on Circular and Linear routes (it does not also flip a Linear route's
  direction, as C# `MetaManager`; the plan's "flip" was dropped). `true` / `false` are
  idempotent, no argument toggles. `nav load` clears the flag; `nav save` stores the
  on-screen order and clears it too.
- Metas see the route through session variables: `getvar[navreversed]` (1 / 0, kept in step
  with `reverseroutequery`), `getvar[navlastresult]` (`DONE:<type>`, `WARN:<type>:…`,
  `SKIPPED:0:stuck`, `FAILED:<type>:<reason>` — a FAILED step also pauses navigation) and
  `getvar[navlasttell]` (the NPC Talk answer). `vtgetsetting[RouteReversed]` reads the flag
  too (read-only).
- Loot profiles: VT Classic Looter `.utl` (31 node types) plus a minimal rule editor. Rules
  needing appraisal data hold the item until it arrives. Decal "synthetic" property keys are
  only partly mapped (`glue/loot_ctx.js`); unknown ones read as unknown (logged once).
- VTank settings profiles (`.usd`, `formats/usd.js`; format after WebAC `vtankUsd.ts` /
  `docs/vtank-formats.md` §6, AGPL-3.0) import with `bot.vt.library.importUsd(name, data,
  { mineOnly })` into a NEW user profile only: Save As (refused for Default, `[By char]` and a
  name that already exists), then the Settings rows by VTank name (landblock fractions ×240,
  clamps and unknown names reported, as `/rs opt`) and the Monsters tab through the
  MonsterList validator (`<DEFAULT>` → DEFAULT; WeaponToUse / SecondaryEquip object ids are
  server-specific and kept with a warning). Items, Consumables and Buffs tables (object /
  spell ids) are parsed and reported, not applied; there is no export and no panel control
  yet. Checked against WebAC's own `hunter.usd` and a synthetic fixture only — no
  VTank-written `.usd` is in this tree.

## Not the same as VTank (by design or not yet verified live)

- **Ring spells are off** (`AllowUntargetedRings=false`): an untargeted ring is a crash-class
  cast on ACE until the live check L-R1 proves it safe; the R column falls back to bolts / streaks.
- The heading convention (`webhost.js` `HEADING_CONVENTION`, used by `/mt face`) is pinned by
  live check L-H1. Jumps (`/rs jump`, Jump waypoints) turn through `goto_compose.js`
  `attemptJumpLeg`, which uses the raw `TurnToHeading` — the same result while the convention
  is the identity; if L-H1 changes the constant, `attemptJumpLeg` must switch to
  `TurnToCompassHeading` too (review guide-7). The recall waypoint casts untargeted
  (SelfTargeted), the same wire the existing bot's recall (`goto_compose.js`
  `attemptRecallCast`) already uses live (D23); L-N2 checks it inside a VT route.
- Damage Type **Auto** and `creaturegetweakest[]` pick the element with the HIGHEST ACE damage
  multiplier the creature's appraisal shows (an element it does not list counts as 1.0) —
  deliberately not C# GetWeakest, which picks the most resisted one. Vanilla ACE appraisals
  carry no resistances, so Auto then falls back to the weapon's element, else Fire.
- At the default `WarSpellMode` (`legacy`) the bot's own war-spell pick runs while the DEFAULT
  monster row's S, arc and Damage Type are unedited; once one is edited the row is honoured.
  With `WarSpellMode vtank` (part of the VTank preset) the monster list always picks the
  attack spell.
- With combat off the vitals loop keeps its idle (top-off) thresholds (D18).
- Two monster editors exist: the HUD's Monsters tab (name → priority 0-20, a bias inside one
  tier) and the VTank Monsters list (P −1..4 tiers, ×1000). "Import HUD priorities" converts.
- The VendorOpen level is not kept across a bot rebind; Alinco3 loot profiles are not supported;
  `/ub opt set VTank.PatchExpressionEngine true` (seen in corpus metas) is an unknown option here.
- Re-clicking the same inventory item after a world click does not count as a newer selection
  (`/mt cast` without "on" targets the most recent selection otherwise).

## Tests

Gate rows (`harness/run-js-headless.mjs`, TIER 5): `rynthVtExpr`, `rynthVtExprStdlib`,
`rynthVtSettings`, `rynthVtProfiles`, `rynthVtFormatsMeta`, `rynthVtFormatsUtl`,
`rynthVtMetaEngine`, `rynthVtMetaConditions`, `rynthVtMetaViews`, `rynthVtRsCommands`,
`rynthVtHostFns`, `rynthVtNavModel`, `rynthVtActiveNav`, `rynthVtMonsters`, `rynthVtPlanner`,
`rynthVtSpellTables`, `rynthWebhostVtSeam`, `rynthVtHostSignals`, `rynthVtPageSeams`,
`rynthVtSupportVitals`, `rynthVtSupportInventory`, `rynthVtSupportMisc`, `rynthVtBridge`,
`rynthVtPanelDom`, `rynthVtKernelAux`, `rynthVtLoopHooks`, `rynthVtLayer`, `rynthVtWiring`,
`rynthVtParity`, `rynthVtSlash`, `rynthVtHudIntegration` (files `tests/rynth_vt_*.test.mjs`,
`rynth/test_webhost_vt_seam.mjs`). Root node-runner tests: `rynth_vt_corpus_test.cjs`
(corpus round trips; passes with 0 checks when the corpus is absent),
`rynth_vt_spell_tables_test.cjs`. Each runs alone: `node tests/rynth_vt_<x>.test.mjs`.

Last full gate (2026-10-13, after the whole-diff review): JS gate 563 passed / 0 failed (532
before the layer + these 31 rows); node runner 68 passed / 0 failed / 32 skipped (66 + the two
root tests). No test file that existed before the layer was edited. The tests drive the real
modules with fake hosts; what only the live client can show is the PLAN §7.4 checklist
(STATUS.md, pending).
