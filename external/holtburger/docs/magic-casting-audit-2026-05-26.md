# Magic-casting end-to-end audit (2026-05-26)

Wave 13 / Phase 40 (CMT fixes plan §51). Read-only audit of the magic-casting vertical to scope Wave 14+ work. Sister phases: 41 (spell data inventory), 42 (vibe-cast-pose placeholder).

Key wiki framing: per `external/holtburger/docs/acpedia-combat-research-2026-05-26.md` §War Magic and §Void Magic, **the cast wind-up animation is uniform — projectile pattern is the differentiator, not the gesture**. Six shapes for War (Arc/Ring/Wall/Bolt/Volley/Blast + Streak post-Slumbering Giant), five for Void (no Wall, no Volley; adds DoT/debuff that have no projectile). This shapes the ACE wire side: motion-broadcast doesn't carry shape information — `SpellId` does.

## §1 — Client today

The client's local-player cast path:

- `scene3d/picking.js:338-405` — magic-stance left-click fires `sessionHandle.castTargetedSpell(targetGuid, spellId)` once `cb.armedSpellId > 0`. Side-effects in order: (a) Sneak-Attack prediction at `:357-379` (Wave 6 Phase 16, scope `local-magic`, `attackType: null`); (b) `spellCastInitiated` event at `:386-404` with `{ spellId, targetGuid, attackerGuid, school, shape, level }` from `classifySpell` (Wave 9 Phase 27); (c) wire packet at `:405`.
- `ui/ac_spell_shape.js:1-282` — Classifier loads `data/spell-shapes.json`. Returns `{ school: 0-5, shape: "Bolt|Arc|Streak|Volley|Wall|Ring|Blast|Self", level: 1-8 }` or null. Header `:32-46` documents the cast-motion-uniformity finding.
- `scene3d/spell_shape_preview.js:438-560` — Self-registering Three.js listener; on `spellCastInitiated` it spawns a shape-specific overlay (Bolt=line, Arc=parabola, Volley=7-line fan, Streak=4-line cluster, Wall=plane, Ring=torus, Blast=sphere, Self=ground-ring). 500ms hard cap, school-tinted color (Wave 12 Phase 38).
- `scene3d/entities.js:176-183 CAST_COMMANDS` — Low-16 set covering MagicBlast (0x2B-0x32), PowerUp01..10 (0x6F-0x78), CastSpell (0xD3).
- `scene3d/entities.js:317-331 classifyMotionCommand` — Returns `"cast"` for those codes; `:365-423 classifyMotionCommandTyped` routes through wasm `lookupMotionLinkForSwing` for typed anim spec.
- `scene3d/entities.js:2253-2275 setSwingPose` — Vibe-coded triangle-wave on `armIdx=13` (right upper arm), human-only, 300ms duration. **There is no `setCastPose` / magic-specific local-player pose.** Phase 42 will add one.
- `index.html:8693-8768 dispatchRemoteSwing` — When `damageTaken`/`evadedAttacker` arrives, looks up attacker GUID by name, classifies via CMT for melee or `getAimLevelForVelocity` for ranged. The comment at `:8740` confirms: *"magic uses CastTargeted/CastUntargeted not CMT"*. **Remote magic attackers fall through the `setSwingPose` else-branch at `:8757-8758`** which is the human-only triangle tween.
- `scene3d/play_effect_vfx.js:1-80` — Listens for `playEffect` event (kind=30 from wire opcode 0xF755) and renders Launch (0x04, blue) / Explode (0x05, yellow) / Fizzle (0x51, gray puff) bursts at the target/projectile position. 50/174 IDs covered with placeholders.

Summary: client predicts shape locally (via `classifySpell` + overlay), wires the cast action up, and renders ACE-broadcast `PlayScript` bursts — but **no actual cast-gesture animation plays on either the local or remote rig**. The casting visual today is the predictive overlay + the ACE-broadcast `PlayScript.Launch` / `PlayScript.Explode` from the projectile entities. The caster themself doesn't move.

## §2 — ACE authoritative wire sequence

For a player-targeted cast `Player → ACE`:

1. **Inbound:** `GameActionMagicCastTargetedSpell.cs` (`HandleActionCastTargetedSpell` at `Player_Magic.cs:80`) reads `targetGuid + spellId` from the GameAction payload (opcode `0x004A` per `holtburger-protocol/src/opcodes.rs:417`).
2. **`HandleActionCastTargetedSpell`** at `Player_Magic.cs:80-190`: gates on `CombatMode.Magic`, `MotionStance.Magic`, jumping, PK timer, busy flag. Calls `CreatePlayerSpell` after optional `Rotate(target)` delay.
3. **`CreatePlayerSpell`** at `Player_Magic.cs:1000-1052` is the action-chain assembler. Inside the spell-chain it calls (in order):
   - **`DoSpellWords`** at `:592-601` → broadcasts `GameMessageHearSpeech` (Tholgar Bricam … etc) to `LocalBroadcastRange` for nearby clients.
   - **`DoWindupGestures`** at `:605-646` — For each scarab in `spell.Formula.WindupGestures` (one MotionCommand per scarab, looked up via `SpellComponentBase.Gesture` in `~/ace-server/Source/ACE.DatLoader/Entity/SpellComponentBase.cs:11`), calls `EnqueueMotionMagic` which broadcasts a `Motion(MotionStance.Magic, windupGesture, speed=2.0)` to everyone in PVS via `EnqueueBroadcastMotion` (`WorldObject_Networking.cs:1078-1093`). Each scarab contributes one `UpdateMotion` packet.
   - **`DoCastGesture`** at `:648-689` — Last-component talisman defines the `CastGesture` (`SpellFormula.cs:271-287`). One more `UpdateMotion` broadcast at the same `MotionStance.Magic`. `castGesture` overridable by `casterItem.UseUserAnimation` (`Player_Magic.cs:655-656`) for weapon-built-in spells.
   - **`DoCastSpell` → `DoCastSpell_Inner` → `CreatePlayerSpell(target, spell, isWeaponSpell)`** at `:746` / `:835-933` / `:1062+`. School-dispatched. For projectile spells, `CreateSpellProjectiles` → `LaunchSpellProjectiles` at `WorldObject_Magic.cs:1509-1845`. Each projectile creates a `SpellProjectile` WO via `LandblockManager.AddObject` (this is an `ObjectCreate` packet on the wire) then broadcasts `GameMessageScript(sp.Guid, PlayScript.Launch, intensity)` (opcode `0xF755`, `:1833`). For enchantments, `DoSpellEffects` at `:356-367` broadcasts `CasterEffect` (script on caster) + `TargetEffect` (script on target).
   - **`FinishCast`** at `:935-993` — broadcasts a final `UpdateMotion(MotionStance.Magic, MotionCommand.Ready)` to return to ready stance + sends `UseDone` to the casting client.
4. **Wire packets to every client in PVS** (in order, per cast):
   - N × `UpdateMotion` (one per windup-scarab motion, e.g. 4 scarabs → 4 packets). Same stance, different `forward_command`.
   - 1 × `UpdateMotion` for the cast-gesture (talisman).
   - 0 × or 1 × `GameMessageHearSpeech` (skipped for `isWeaponSpell`).
   - 0 × or N × `GameMessageScript` for `CasterEffect` and `TargetEffect` (PlayScript IDs from `Spell.CasterEffect` / `Spell.TargetEffect`).
   - 0 × or N × `ObjectCreate` for spell projectiles.
   - 0 × or N × `GameMessageScript(projectile_guid, PlayScript.Launch, intensity)` per projectile.
   - 1 × `UpdateMotion` back to Ready stance.
   - On collision: `GameMessageScript(target_guid, PlayScript.Explode, ...)` from `SpellProjectile.OnCollideObject`.
   - On miss: `GameMessageScript(caster.Guid, PlayScript.Fizzle, 0.5f)` (`Player_Magic.cs:879`, `:917`).

For NPC casters, `Monster_Magic.cs:226-265 PreCastMotion_Human` is the same scarab-windup + talisman-cast pattern when `AiUseHumanMagicAnimations=true`; `PreCastMotion` at `:220-224` uses a single `MotionCommand.CastSpell` (0x400000d3) for monsters without the flag.

## §3 — Spell data: have vs need

**Have:**
- `crates/holtburger-dat/src/file_type/spell_table.rs:10-66` — `SpellTable` (file `0x0E00000E`) parses fully: name/desc/school/icon/category/bitfield/baseMana/range/power/economyMod/formulaVersion/componentLoss/metaSpellType/metaSpellId + 8 × u32 raw_components + caster/target/fizzle effects + recovery + display + non-component-target-type + manaMod. Spell-sets via `parse_spell_set_hash_table`.
- `apps/holtburger-web/data/spells-catalog.json` + `data/spell-shapes.json` (Wave 5 Phase 12 generated from LSD-Partial via `scripts/build_spells_catalog.py` + `scripts/gen-spell-shapes.cjs`).

**Missing (load-bearing for Wave 14 cast-pose):**
- **`SpellComponentsTable.cs`** (file `0x0E00000F`) — NOT parsed in Rust. ACE's `SpellComponentBase` (`~/ace-server/Source/ACE.DatLoader/Entity/SpellComponentBase.cs`) carries `Name, Category, Icon, Type (Scarab/Herb/Powder/Potion/Talisman/Taper), Gesture (MotionCommand u32), Time, Text, CDM`. We need the `Gesture` field for every component to mirror ACE's windup chain client-side.
- `raw_components` is parsed but we don't have the **`SpellFormula.cs:194-232 GetPlayerFormula`** algorithm that resolves the per-player-name-hash 8-component permutation (XOR through hash table + name-modulus rotation). Without this, scarab ordering can't be replicated client-side. (ACE's `SpellTable.cs:62-77` switches on `FormulaVersion` and re-permutes components 1-7 per player name.)
- **Spell scale** per first-scarab (`SpellFormula.cs:293-313 ScarabScale`) — 0.05 (Lead) through 1.0 (Pyreal/Diamond/Platinum/Dark/Mana). Used for `GameMessageScript(scale)` rendering of cast effect (Wave 14 would consume this for shape-preview overlay sizing).

**Already have on wire:** `spell.CasterEffect` (PlayScript on caster, e.g. blue glow ramp during windup), `spell.TargetEffect` (PlayScript on target on hit), `spell.FizzleEffect` (fizzle puff on failure). These come through the existing `PlayEffect (0xF755)` path. Rendering them is `play_effect_vfx.js`'s scope.

## §4 — Per-school / per-shape animation differentiation

Retail differentiates **only by SpellId, not stance or shape**. Evidence:
- `Player_Magic.cs:680-685` enqueues exactly one `MagicState.CastGesture` regardless of school. School is determined by `spell.School` (1=War / 2=Life / 3=Item / 4=Creature / 5=Void); cast-gesture is determined by the talisman component (final element of `Spell.Formula`, mapped via `SpellComponentsTable[componentId].Gesture`).
- Scarab → windup gesture is the per-component motion sequence — `Iron`, `Copper`, `Silver`, `Gold`, `Pyreal`, etc., each map to one of the `PowerUp01..PowerUp10` MotionCommands (`MotionCommand.cs:218 CastSpell`, plus the 10 `0x006F-0x0078` PowerUp ladder used at `entities.js:180`). So a higher-tier spell has more scarabs in formula → longer wind-up animation chain.
- Talisman → cast-gesture is `MotionCommand.CastSpell` (`0x400000d3`) for vanilla spells; weapon-built-in spells substitute `casterItem.UseUserAnimation` (e.g. Wand-of-X with custom animation).
- Shape is rendered entirely on the `ObjectCreate + PlayScript.Launch` side — server creates N projectiles in a shape-specific spawn pattern, the client just renders whatever projectiles land. The caster's body doesn't know about shape.
- **There is no cast-stance-row in `CombatManeuverTable`.** CMT is melee+missile only (the magic-stance side uses `MotionCommand.CastSpell` + `PowerUp01..10`, not the stance/height/type triplet). Confirmed by `combat-melee-cross-reference-2026-05-17.md` and the absence of magic rows in any of the 4 maneuver-table sources cross-checked.

So **one cast-motion pipeline covers all 5 schools and all 8 shapes**. The differentiation work for Wave 14 is purely (a) plumbing the SpellComponentsTable into the client so we can play the right scarab→PowerUp + talisman→CastSpell sequence, (b) the projectile-spawner rendering authored projectiles on the right pattern (which `spell_shape_preview.js` already approximates predictively).

## §5 — Gaps + recommended Wave 14 plan

Gaps (prioritized):

1. **No cast-pose on local player** — `setSwingPose` (`entities.js:2253`) is melee-only and isn't called from the magic branch in `picking.js`. Phase 42 (sibling task) will mirror it.
2. **No cast-pose on remote player** — `dispatchRemoteSwing` doesn't have a magic branch. Magic-stance attackers (NPCs and PCs) play nothing when they hit us.
3. **No SpellComponentsTable parser in Rust** — can't resolve `windupGesture` per scarab from DAT today. Hardcoded scarab→Gesture map at `plugins/combat-bar.js` (Phase J memory) is partial.
4. **No `UpdateMotion` listener for magic-cast commands** — the wasm-side dispatch in `crates/holtburger-world/src/handlers/movement.rs:56-108` accepts UpdateMotion for any cmd, but the client-side `setMotion` path doesn't have a magic-specific clip cache or duration tweak. Today the renderer would treat `MagicBlast` like any other one-shot and fall through to `setSwingPose` (human-only triangle wave).
5. **Player_Magic.cs `MagicState.CastGesture` not surfaced on wire shape-agnostically** — ACE broadcasts `UpdateMotion(MotionStance.Magic, gesture)` per scarab. We need the client to detect "this is a magic cast, the entity isn't holding a weapon, play the AnimationCache link clip for this (stance, ready, gesture)." `setSwingMotion` (`entities.js:2277-2380`) almost does this — it routes through `classifyMotionCommandTyped` → wasm `lookupMotionLinkForSwing`. Should already work for magic; needs validation.

**Recommended Wave 14 phases** (4 agents, 2 waves of 2):

- **Phase 43 (Wave 14.A) — SpellComponentsTable parser.** Add `crates/holtburger-dat/src/file_type/spell_components_table.rs` mirroring ACE's `SpellComponentBase`. Generate `apps/holtburger-web/data/spell-components.json` from DAT. Export wasm `fetch_spell_components()`. Owner: Agent AN. Independent of Phase 44.
- **Phase 44 (Wave 14.A) — `setCastPose` placeholder.** Mirror of Phase 42 but for non-human rigs (creature mtables have `MotionCommand.CastSpell` link entries). Hook into `entities.js setSwingMotion` so the existing wasm `lookupMotionLinkForSwing` path is exercised for magic. Validate on Holtburg Banderling Sorcerer + Mosswart Glyph-keeper. Owner: Agent AO.
- **Phase 45 (Wave 14.B) — Remote-player cast in `dispatchRemoteSwing`.** When the attacker's stance is `Magic (0x80000049)`, look up `inst.lastSpellCastInitiated` (cached from `spellCastInitiated` events broadcast to nearby PCs — needs a new world event) and call `em.setSwingMotion(g, MotionCommand.CastSpell)`. Falls back to `setSwingPose` for human rigs without spell data. Owner: Agent AP. Blocked on Phase 44.
- **Phase 46 (Wave 14.B) — Windup gesture chain on local player.** When `castTargetedSpell` fires, replay the **scarab→PowerUp sequence** locally as Three.js animations using the new `spell-components.json`. ACE's broadcast windups already arrive via `UpdateMotion`, but local-player prediction (we already do this for melee/missile via `setSwingPose`) hides perceived latency. Owner: Agent AQ. Blocked on Phase 43.

**Out of scope for Wave 14** (parked):
- `SpellFormula.GetPlayerFormula` permutation (the per-name-hash component shuffle). Player can't see the shuffle results — only ACE uses them to decide if components are spent. Not needed for animation.
- `casterItem.UseUserAnimation` override (weapon-built-in spells with custom animations). Defer until we have a custom-wand-with-anim test fixture.
- `SpellFlags.FastCast` (no windup). Phase 46 must check this flag and skip the windup chain — but the catalog already exposes `bitfield`; trivial check.

## §6 — Open questions

1. **Does the wasm `lookupMotionLinkForSwing` already return a result for `(MagicStance, Ready, PowerUp01)`?** If yes, Phase 44 is wiring-only; if no, we need to extend the wasm classifier. Easy to validate with the 0x09000020 retail mtable.
2. **Does ACE's `EnqueueBroadcastMotion` broadcast every scarab motion within the windupChain ActionChain delay budget**, or does the recipient see a single coalesced `UpdateMotion` per cast? The action-chain delays at `Player_Magic.cs:636` + `WorldObject_Networking.cs:1090 AddDelaySeconds(animLength)` suggest one packet per scarab, spaced by anim length — but we should verify with a wire capture.
3. **What does the `Spell.Formula` `raw_components` ordering mean for cast animations on the wire we receive?** ACE clients reading `Spell` from DAT see the same raw 8 components — but the *played-back* windup is per-scarab (`SpellFormula.WindupGestures` iterates `Scarabs` only, not all 8 components). So for animation purposes only the scarab subset matters. Confirm by reading `Player_Magic.cs:623 foreach (var windupGesture in spell.Formula.WindupGestures)`.
4. **Per-spell `Scale` modulates the size of the cast effect.** Is that currently consumed by `play_effect_vfx.js`? Reading the wire-side, `GameMessageScript.scale` is the third field; `effects/types.rs:39 PlayEffectData` parses it; `play_effect_vfx.js _spawnBurst` uses `data.speed` (which maps to scale). Look correct but worth visual-validating against retail.
5. **Should `spell_shape_preview.js` early-dismiss when the real `ObjectCreate` projectile arrives?** Mentioned as parked at `cmt-fixes-plan-2026-05-26.md:2119`. Not load-bearing for Wave 14.
