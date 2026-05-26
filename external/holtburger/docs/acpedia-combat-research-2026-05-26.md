# Acpedia combat-skill research (2026-05-26)

Source: `external/acpedia/acpediaorg-20210615-wikidump/acpediaorg-20210615-history.xml` (53,964 pages, 1.4 GB), extracted via `lxml.etree.iterparse` streaming. Raw page wiki-source is at `/mnt/wbterminal1/tmp/claude-scratch/acpedia-research/<title>.txt`. Cross-referenced pages (`Combat`, `Damage Rating`, `Master of Arms`) extracted as `_ref_*.txt`.

The 10 individual skill pages are surprisingly thin — they are largely statblock cards (formula, train/spec cost, starting equipment, buff/debuff list). The substance lives in the omnibus `Combat` page and the `Damage Rating` rollup page; this doc folds those in. Where they disagree with the individual skill pages, both numbers are flagged.

**Era convention used below.** "Pre-MoA" = pre-February-2012 (10 retired weapon skills: Axe, Bow, Crossbow, Dagger, Mace, Spear, Staff, Sword, Unarmed, Thrown Weapons). "MoA-era" = Feb 2012 onward (Heavy / Light / Finesse / Missile / Two Handed Combat). "LoTL" = Lords of the Dead (2014, separate). The wiki pages here are all MoA-era unless noted; Thrown Weapons is the lone retired-skill page in this set.

## Heavy Weapons

- **Mechanic role.** MoA-era weapon skill for heavy one-handed melee (mace, battle axe, trident, cestus per starting-kit, plus 2H mappings via Two-Handed Combat which is a separate skill). Formula `(Strength + Coordination) / 3`; cost 6 to train, 6 to specialize; starts Untrained. Damage notes line: "Damage is calculated based on Strength."
- **Damage math.** No explicit multipliers on the page. The page bumps damage off Strength (i.e. Strength contributes to weapon damage modifier; the actual percent is on `Strength`/`Damage Rating`, not here). Sneak Attack / Recklessness / Dirty Fighting / Damage Rating numbers are documented elsewhere; this skill page doesn't override them.
- **Animation / motion impact.** *None directly attributable to the skill itself.* The skill gates whether you can wield a Heavy weapon at all (and the bonus-to-hit ramp), but the actual swing motions come from `Combat`'s power-bar maneuvers table, which the wiki keys to **weapon-class** (One-Handed vs One-Handed (Shield) vs One-Handed (Dual Wield) vs Two-Handed vs Unarmed), **not** to Heavy/Light/Finesse. The MoA division is purely a *skill* slice across the existing motion buckets.
- **Slider semantics.** No skill-specific effects on the power bar. The bar's Low / Medium / Full breakpoints are the same as Light / Finesse: 50% / 100% / 150% damage.
- **Cross-system interactions.** Recklessness's proportional-reduction clause keys on "your attack skill (as determined by your equipped weapon)" — wielding a Heavy weapon makes Heavy the reference skill for Recklessness's reduction. Same for Sneak Attack.
- **Era + retirement.** Patch Introduced = Master of Arms (Feb 2012). Subsumed pre-MoA Mace, Axe, and the Heavy half of Sword. No NF-Live mentions on the page.

## Light Weapons

- **Mechanic role.** MoA-era weapon skill for *light* one-handed melee **and unarmed strikes** ("Also helps you punch and kick" — explicitly conflates Unarmed). Formula `(Strength + Coordination) / 3`; cost 4 to train, 4 to specialize; starts Untrained. Same formula as Heavy but cheaper.
- **Damage math.** "Damage is calculated based on Strength" — identical to Heavy. No page-side multipliers.
- **Animation / motion impact.** Indirectly via wielded weapon-class. Critically, the "punch and kick" inclusion means that **Unarmed motions (Kick / Punch / Jab in the Combat page's maneuver table) are gated by Light Weapons skill**, not by a separate Unarmed skill. The Combat page maps Unarmed stance → Kick (Full PB) / Punch (Medium PB) / Jab (Low PB).
- **Slider semantics.** Same 50/100/150 ladder. Cheaper-to-train than Heavy is the distinguishing feature.
- **Cross-system interactions.** Same Recklessness/Sneak proportional-reduction clause. Note that handwraps and knuckles ("Training Knuckles", "Training Cestus" for Sho/Umbraen/Penumbraen) are weapons, not literal unarmed — so the *unarmed* motion variants apply only when no weapon is equipped at all.
- **Era + retirement.** MoA Feb 2012. Subsumed pre-MoA Dagger, Staff, light end of Sword, and Unarmed.

## Finesse Weapons

- **Mechanic role.** MoA-era weapon skill for finesse one-handed melee. Formula is the only one that's **not** Strength-flavored: `(Coordination + Quickness) / 3`. Cost 4/4. Damage off Coordination ("Damage is calculated based on Coordination") — this is the page's only mechanically-distinctive line, and it's the *only* melee skill where Strength is not the damage attribute.
- **Damage math.** Coordination-based; same 50/100/150 PB ladder; no separate multiplier on page.
- **Animation / motion impact.** None at the skill layer. *However:* the `Combat`-page maneuver table lists a "ThrustSlash" weapon class that gets the 0.66 picker subdivision (port of `Player_Melee.cs:440–475` already in our picker). The wiki doesn't tie ThrustSlash to a specific skill, but starting Finesse kits include "Training Short Sword" / "Training Knife" / "Training Tungi" — and those are mostly Slash+Thrust weapons in the data. So Finesse is empirically over-represented in ThrustSlash, but the gating is on the **weapon's `WeaponSkill` and `DamageType`**, not on the skill itself.
- **Slider semantics.** Identical to Heavy/Light. No Finesse-specific bar behavior.
- **Cross-system interactions.** The Sneak Attack page's formula is also `(Coordination + Quickness) / 3` — Finesse and Sneak Attack share an attribute base, suggesting they're designed to be co-trained. Recklessness shares Quickness but uses Strength on the other side, so it pulls in a different direction than Finesse.
- **Era + retirement.** MoA Feb 2012. Subsumed pre-MoA Spear and the finesse end of Sword/Staff.

## Recklessness

- **Mechanic role.** MoA-era combat-augment skill. Formula `(Strength + Quickness) / 3`; cost 4 to train, **2 to specialize** (specializing is half-price relative to train — only Recklessness and Sneak Attack do this); starts Untrained. Affects melee and missile (not magic).
- **Damage math.** +10 Damage Rating trained, +20 specialized — applied as **non-critical** outgoing damage only. **Crucially, also adds the same amount to incoming non-critical damage from all sources** (every source — including magic — even though the buff is melee+missile only). Damage Rating is a flat additive into the `(100 + DR) / 100` multiplier per the Damage Rating page.
- **Animation / motion impact.** No motion-level effect. The Combat page does say *"the combat bar will highlight the area where recklessness is active"* — UI overlay only, no new swing.
- **Slider semantics.** **This is the big one.** Two divergent numbers in the wiki itself:
  - The `Recklessness` skill page (line 49): "Activates when attack bar is between 20% and 80%."
  - The `Combat` omnibus page (line 169): "between 10-90% power."
  - Take the Combat-page number as canonical (it's the more recent edit). The user's 0.8 power-cap memory from RynthSuite is partially confirmed — there IS a power cap; whether it's exactly 0.8 or 0.9 depends on which page you trust. Resolution: **0.8** matches the skill page's max (the "80%" upper bound), so the RynthSuite cap likely keys on the skill-page edition.
  - The cap is *not* wire-enforced server-side that we can tell from the wiki: it's a UI overlay/region. The damage rating applies if your power lands inside the active band. **Below 10–20% or above 80–90% = no Recklessness bonus AND no Recklessness incoming-damage penalty**. So players can opt out by going to extremes.
- **Cross-system interactions.** "If Recklessness skill is lower than your attack skill (equipped weapon), damage rating is reduced proportionately" — exactly the same skill-floor clause as Sneak Attack. Both Recklessness and Sneak Attack stack with each other on Damage Rating (the `Damage Rating` page lists them as separate +10/+20 temporary lines under "Temporary Bonuses", and both can be active simultaneously on the same hit if you're attacking from behind in the active power band).
- **Era + retirement.** MoA Feb 2012 (new skill at introduction). No retirement.

## Sneak Attack

- **Mechanic role.** MoA-era combat-augment skill. Formula `(Coordination + Quickness) / 3`; cost 4 to train, 2 to specialize. Affects melee, missile, **AND magic** (only augment skill that touches all three).
- **Damage math.** +10 Damage Rating trained, +20 specialized — flat additive, same DR rollup as Recklessness. The wiki is precise about Deception interaction: 100% chance from behind (always); from the front, 10% chance with trained Deception, 15% with specialized Deception. Both chances scale linearly to zero as Deception drops from 306 to 0. Assess Person on the defender reduces frontal-Sneak damage up to 100% (capped at 306 Assess Person; not applied to rear attacks).
- **Animation / motion impact.** **No new animation.** Sneak Attack is purely a positional damage-rating bonus. There is no "backstab pose," no "stab from shadow" motion, no separate MotionCommand. The implementation reuses whatever swing the equipped weapon + power-bar would normally produce. The "Sneak" framing is purely facing-based gating (attacker behind defender = bonus).
- **Slider semantics.** None. Activates on hit regardless of where the power bar is.
- **Cross-system interactions.** Works with magic — including War Magic and Void Magic — which is interesting because magic doesn't have "behind" the same way melee does. The wiki implies the server checks attacker-position-vs-defender-facing on every hit (including spell hits). For our renderer, **we need facing data on the wire for both attacker and defender** to predict the bonus client-side; if we don't already have defender heading sampled at swing-resolution time, we can't preview Sneak Attack activation.
- **Era + retirement.** MoA Feb 2012 (new skill). No retirement.

## Missile Weapons

- **Mechanic role.** MoA-era weapon skill for bows, crossbows, atlatls. Formula `Coordination / 2` (lowest-attribute formula in the set); cost 6/6; starts Untrained.
- **Damage math.** The notes are the key surprise: **"Damage is calculated based on Coordination for bows and crossbows, but Strength for Throwing Weapons."** Same skill, different damage attribute depending on the wielded weapon. Atlatls aren't called out; they probably go with Coordination (since atlatls were introduced in *The First Strike* alongside the consolidation, and the Combat page treats them as bow-class).
- **Animation / motion impact.** Aim motions are picked by `Creature_Missile.cs::GetAimLevel` (we've already ported this — 13 aim motions at 15° z-angle intervals between AimHigh15 and AimLow90). The CMT has zero rows for ranged stances (confirmed in `combat-melee-cross-reference-2026-05-17.md`), so the wiki's silence on motion-per-skill is consistent with our model. The skill governs hit/damage, not which AimLevelN plays.
- **Slider semantics.** The Combat page (line 16) confirms: **"a slider for changing the speed versus power when wielding a melee weapon or speed vs accuracy when holding a missile weapon."** So the missile bar's left/right axis is *accuracy*, not power. Damage from a missile weapon is on the weapon's intrinsic damage modifier (which is visible on the weapon — distinct from melee per Combat line 63). The "Power" combat-bar label in our `combat-bar` plugin already toggles to "Accuracy" in ranged stance per Phase E (memory entry confirms); the wiki backs this design.
- **Cross-system interactions.** Recklessness applies. Sneak Attack applies. Dirty Fighting applies (works for both melee and missile per Combat line 184). Shield does NOT block ranged… see Shield section below — actually the wiki says shields *do* protect from the front, with rear attacks bypassing them; whether that includes missile attacks is implied (a frontal arrow would be partially blocked by a shield-bearer) but not stated explicitly. **The First Strike** event introduced the ability to throw weapons while wearing a shield — implying that, pre-First-Strike, **shields and thrown weapons were mutually exclusive**. This is a wire/state interaction we should validate against ACE.
- **Era + retirement.** MoA Feb 2012. Subsumed pre-MoA Bow, Crossbow, Thrown Weapons.

## War Magic (Skill)

- **Mechanic role.** Original-release magic skill (Patch Introduced = Release, not MoA). Formula `(Focus + Self) / 4`; cost 16 to train, 12 to specialize (most expensive in the set); **starts "Unusable"** — different status from melee skills, which start "Untrained." Page calls it "The School of the Arm."
- **Damage math.** No formula on the skill page itself. The Update History block is rich though:
  - `Atonement`: skill-based damage bonus + critical strike bonuses introduced (so pre-Atonement, War Magic damage was flat per-spell).
  - `The Iron Coast`: base crit chance 2% → 5%.
  - `The Slumbering Giant`: streak rate-of-fire + blast/volley damage tuned.
  - `Treaties in Stone`: crits became `max_damage * mult` instead of `min_damage * mult` (PvM only). Critical Strike imbue scaling 5–50% (not 25%). Crippling Blow scaling 50–500% (not 100%). Imbue/slayer cap at 360 skill (not 400).
  - `A Small Victory`: bolt/arc damage improved at levels 1–6, streaks at all 7 levels.
  - `Recollections`: streak damage updated all 7 levels.
- **Animation / motion impact.** Page lists six spell shapes: **arc, ring, wall, bolt, volley, blast.** That's a different vocabulary from the melee maneuver names, and each almost certainly maps to its own MotionCommand + projectile-spawn pattern. (Volley = multiple projectiles fan; streak = rapid-fire same projectile per Slumbering Giant; bolt = one; arc = parabolic; ring = AoE around target; wall = AoE plane.) We should expect the cast animation to be the same regardless of shape — the **projectile pattern** is the differentiator, not the wind-up. The CMT does have magic-stance rows but no per-spell-shape variation that we've seen; the spell shape is driven by `SpellId`-on-wire, not by stance.
- **Slider semantics.** No power/accuracy slider in magic stance (per Phase F memory — magic stance transforms the combat bar into a spell-picker grid). Cast time is per-spell, not slider-modulated.
- **Cross-system interactions.** Sneak Attack applies to magic (per the Sneak page) — so attacker-vs-defender facing matters even for magic. Recklessness does NOT apply to magic. Magic Defense (defender side) resists.
- **Era + retirement.** Original Release. Critical mechanics evolved across `Atonement` → `Treaties in Stone` — if our renderer needs to be retail-faithful, **the post-Treaties crit math is canonical for the era we usually target** (post-2009ish), and the wiki shows PvM/PvP split there.

## Void Magic (Skill)

- **Mechanic role.** Patch Introduced = From Darkness, Light (December 2009, the *11th Anniversary*). Same formula as War Magic — `(Focus + Self) / 4` — same costs (16/12), same "Unusable" base status. Effectively the dark-mirror of War Magic.
- **Damage math.** No formula on page. Listed spells: Nether Bolt, Nether Arc, Nether Streak, Nether Blast, Nether Ring (no Wall, no Volley — five shapes vs War Magic's six). Plus DoT spells (Destructive Curse, Corrosion, Corruption) and weakening spells (Weakening Curse, Festering Curse) — these are **mechanically novel vs War Magic**, which has no native DoTs or stat-debuffs in its core kit.
- **Animation / motion impact.** Same caster-class wand → same cast wind-up motion as War Magic (the page doesn't differentiate, and starting equipment is identical except for the Foci: "Foci of Strife" for War, "Foci of Shadow" for Void). Spell projectile visuals differ (nether/purple-black vs elemental), but that's a *particle/material* choice keyed on `SpellId`, not a different MotionCommand. **Probably no new animation work needed for Void specifically.**
- **Slider semantics.** None. Same as War Magic.
- **Cross-system interactions.** Sneak Attack applies (same as War Magic). DoT spells imply server-side tick handlers we'd need wire visibility for if we want to render tick damage on remote players. Festering Curse / Weakening Curse are stat-debuffs — visual on player nameplate / debuff bar.
- **Era + retirement.** Post-release (FDL Dec 2009). Pre-MoA. No retirement.

## Thrown Weapons

- **Mechanic role.** **Retired skill.** Patch Introduced = Release. Updated = Master of Arms (which retired it). Formula `Coordination / 2` (same as Missile Weapons). Cost 6/6. Starts Untrained.
- **Damage math.** "Although TW is govern[ed] by Coordination, it has a damage modifier based off of Strength." — same hybrid as MoA-era Missile Weapons for thrown sub-class, but in pre-MoA the skill was its own thing. Notable trivia: *Twilight's Gleaming* event added wieldable household items (pots, bowls, cups) as throwing weapons. *The First Strike* added the Atlatl and the ability to throw while wearing a shield.
- **Animation / motion impact.** Pre-MoA, thrown-weapon motions were a separate set (AimLevel-equivalent for throw arcs). Post-MoA, thrown weapons (atlatl darts, javelins) use the same Missile-stance + AimLevel dispatch as bows/crossbows.
- **Slider semantics.** Pre-MoA: same speed/accuracy slider as missile. Post-MoA: rolled into Missile Weapons.
- **Cross-system interactions.** Pre-First-Strike, shield + thrown was banned; post-First-Strike (still pre-MoA), permitted. Sneak Attack and Recklessness both applied (per the rear-attack rules being weapon-agnostic).
- **Era + retirement.** Released at game launch (1999). Retired in `Master of Arms` (Feb 2012) — folded into Missile Weapons. **If our renderer targets post-MoA retail, Thrown Weapons doesn't exist as a skill — only as a weapon-mask sub-class within Missile.** ACE servers we connect to are post-MoA, so we read its weapon-equipped events through Missile.

## Shield

- **Mechanic role.** MoA-era defensive skill. Formula `(Coordination + Strength) / 2` (the only `/2` skill in the set besides Missile — meaning the "raw" attribute contribution is high). Cost 2/2 — cheapest skill in the set. Starts Untrained. Description: "Use the Shield skill to make full use of shields and magic reducing properties of shields."
- **Damage math.** Two distinct caps:
  - **Armor level cap.** A shield's effective armor level is capped at your buffed Shield skill if specialized, OR at *half* your buffed Shield skill if trained/untrained. So pre-spec, your shield's AL is halved at the wall.
  - **Magic damage reduction.** Uses Shield skill (not Magic Defense) for the formula `RED = 100% * ((CAP * ST * SKILL * 0.0030) - (CAP * ST * 0.3))`, where `ST = 1.0 for spec, 0.8 for trained`, `SKILL` ranges 100–433. **Magic-damage-reduction maxes out at 433 base shield skill** — a hard cap that's worth surfacing in our UI.
  - Magic reduction × 0.8 if not specialized — a second multiplier on top of the `ST` baseline, so trained players take both penalties.
- **Animation / motion impact.** No new animation gated by the *skill*. The shield-equip itself does change motion behavior: the Combat-page maneuver table has a separate "One-Handed (Shield)" stance column, distinct from "One-Handed" and "One-Handed (Dual Wield)." Shield stance suppresses Backhand (no entry under that row) and constrains Slash/Stab/Double Slash/Double Stab to specific PB windows. So **equipping a shield changes which CMT rows are visited, but the skill itself doesn't alter motion**.
- **Slider semantics.** None — Shield is purely defensive. The shield's *armor benefit* applies passively while equipped.
- **Cross-system interactions.**
  - **"Shields only protect the front"** (Combat page line 181). Rear attacks bypass shield AL. This is a **facing check** — same calculation as Sneak Attack's positional gate. We can stack these: rear attacker who is also a Sneak Attack user gets both Sneak DR and zero shield AL.
  - Pre-First-Strike, shield + thrown was banned; post-First-Strike permitted.
  - Magic resistance bypasses Magic Defense's formula entirely — Shield owns its own magic-reduction curve. A high-Magic-Defense / low-Shield character will see less magic damage than expected if they assumed Magic Defense covers shield-blocked spells. Worth a UI hint if we show damage previews.
  - No passive "block animation" documented — shields appear to absorb damage entirely via AL math, with no per-block motion. There's no "active block" button.
- **Era + retirement.** MoA Feb 2012 (skill was new; before that, shields worked off Melee Defense / Magic Defense). No retirement.

## Implications for combat renderer

The wiki research mostly confirms that our motion-dispatch model is right: **skills don't pick MotionCommands; weapon-class + stance + AttackHeight do**. The MoA Heavy/Light/Finesse split is a damage/hit-chance layer that sits *above* the motion table. That's a relief — we don't need per-skill animation packs.

Things that *should* drive the wire / UI / renderer beyond what we have today:

1. **Surface attacker-and-defender facing at swing-resolution.** Sneak Attack (always melee/missile/magic) and Shield (rear-bypasses-AL) both gate on facing. Right now we have local-player heading and remote-player heading from MotionUpdate; we don't always have *defender* heading at the moment of swing-impact. To predict Sneak Attack activation client-side (and to render a "bypassing shield from behind" hit-flash), we need defender yaw at impact tick.

2. **Recklessness power-band overlay is wire-independent — surface the skill values and let the UI draw the band.** The 10–90% (or 20–80%, see source-disagreement note) active window is a UI overlay. We already pull skill values from wasm Entity; surface Recklessness's trained/specialized state as a flag and draw the band on the combat bar. **Don't enforce the cap server-side from the client** — the wiki implies the cap is UI-side only and the wire would still send the swing.

3. **Magic stance has six War Magic spell shapes (arc/ring/wall/bolt/volley/blast) and five for Void (no wall/volley but adds DoT + debuff). Wind-up animation is one motion; projectile pattern is the differentiator.** Our spell-picker doesn't need per-shape MotionCommands, but we *will* need different projectile spawners per shape: a `volley` is multi-projectile fan, `streak` is rapid same-spawn, `wall` is AoE plane spawn, `ring` is target-centered AoE. The `SpellId` already on the wire is the key — we map it to (school, shape, level) client-side.

4. **Shield blocks the front only, suppresses Backhand from the maneuver table, and uses its own magic-damage-reduction formula maxing at 433 base.** Three independent things our renderer should reflect:
   - When the player equips a shield, drop "Backhand" from the maneuver picker outputs (we currently rely on CMT rows; verify the "One-Handed (Shield)" CMT rows omit backhand).
   - Hit-direction flash should be facing-aware (frontal hits on shield-bearer = partial absorb VFX, rear hits = none).
   - Damage-preview math (if we ever show it) should branch magic damage through Shield, not Magic Defense.

5. **Missile bar = "Accuracy" not "Power"; the slider sweet-spot semantics differ.** Phase E already swapped the label, which is correct. The wiki implies missile damage is on weapon-intrinsic modifier (not slider-modulated), so the bar fill-rate affects *time-to-fire and accuracy distribution*, not damage. Verify our predicted swing time scales with bar fill, but predicted damage does not.

6. **Era is post-Master of Arms (Feb 2012).** Thrown Weapons as a standalone skill doesn't exist on our servers; we read those weapons through Missile. Two-Handed Combat is a separate skill we didn't research — flag for follow-on. The crit-math era for War Magic is post-`Treaties in Stone` (max-damage-based, PvM-only crit-strike scaling 5–50%).

What I confidently rule *out* as renderer work:
- No "backstab" / "sneak" motion variant. Sneak Attack reuses base swing.
- No active block animation for shields.
- No per-skill animation differences between Heavy/Light/Finesse (it's all weapon-class driven).
- No different cast pose for Void vs War Magic.
