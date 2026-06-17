# HUD Fix Implementation Specs — synthesis (2026-06-17)

Synthesis lead: Opus-4.8 (1M). Web root:
`/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web`

These are loop-applyable, regression-safe implementation specs for the holtburger-web HUD,
grounded in actual code + retail (acclient/chorizite) and re-verified in this pass. Every
adversarial HARDEN `requiredCorrection` from the component reviews has been folded in. The
headline is the **skills-pane consolidation** per the owner's AUTHORITATIVE tabbed-pane
architecture (one shared content-swapper, NOT a separate Train-Skills panel).

> APPLY DISCIPLINE: every Edit must Read the file first and match exact text. For the Rust
> 6-tuple + the four JS stride consumers, land **all five edits + the wasm rebuild in ONE
> commit** — a half-migrated tree silently reads garbage. Use the ORDERED LOOP RUNBOOK.md
> sequence; do not reorder.

---

## FORKS (owner decisions)

- **FORK-A (S1 / R1 cost math) — RESOLVED, NOT open.** `next_rank_xp` is **CUMULATIVE**
  (xp_table.rs:54-62 `get_next_skill_rank_xp` indexes `trained/specialized_skill_xp_list[ranks+1]`
  directly, no subtraction; the lists are cumulative). The marginal raise cost =
  `next_rank_xp − spent_xp`, proven by the authoritative CLI consumer
  `apps/holtburger-cli/.../character/render.rs:425/464/529` (`next_rank_xp.saturating_sub(spent_xp)`)
  and by `test_train_skill.mjs:124-158` (expects `computeNextRaiseCost({xp:5000})===5000`, i.e.
  `snap.xp` is already MARGINAL). **Push the subtracted value Rust-side (6-tuple).** Do NOT push
  raw `next_rank_xp`. Retail confirms marginal: gmSkillUI::GetCostToRaise @0x0049b680 returns
  `ExperienceToSkillLevel(s, level+1) − invested`. *(This reverses the skills-pane-consolidation
  spec's "push directly, no subtraction" text, which was wrong.)*

- **FORK-B (S1 path) — RECOMMENDED: Rust 6-tuple.** Alt JS-only xp-tables.json regeneration is
  rejected: `data/xp-tables.json` carries only attributes/vitals curves (no skills), and the
  5-tuple carries neither `spent_xp` nor invested xp, so the "no wasm" claim is false. Rust path
  wins (server already holds both fields).

- **FORK-C (S3 F11 route) — RECOMMENDED: `showView('character',{tab:'skills'})`, NOT
  `toggleView`.** Verified `toggleView` (main-panel.js:324-330) CLOSES the pane when the stack-top
  id is already `character` (any tab). So F11 while the character pane is open would CLOSE it, not
  switch to Skills. Use a non-toggling open-at-skills (`showView` resets the stack and re-mounts,
  honoring `ctx.tab` at character-info.js:1087).

- **FORK-D (S2 Attributes per-row buttons) — RECOMMENDED: KEEP existing per-row raise buttons AND
  add the default-state credits/XP footer (additive).** Option B (remove per-row buttons, route
  through the shared footer) is more retail-faithful but regresses a working shipped path; defer.

- **FORK-E (R13 reach panels) — RECOMMENDED: FULL-FINISH salvage** (route inventory `useObject` of
  a TinkeringTool to `window.__openSalvagePanel`) + leave tinker global-only. GATE-OFF (mark
  manifests `environments:["cli"]`) is the conservative alt. **CRITICAL CONSTANT:**
  `IT_TINKERING_TOOL = 0x20000000` (canonical_classify.js:56 / chorizite enum), NOT `0x00020000`
  (that is IT_LOCKABLE).

- **FORK-F (R5 stance tint, Cause-3) — RECOMMENDED: add `iconSprite:"0x06004D1C"` to
  combat-bar.manifest.json** so an `<img>` exists for the img-scoped CSS. Alt: retarget CSS off the
  `img` descendant (tints the emoji glyph; less faithful).

- **FORK-G (S5 Improve-x10) — RECOMMENDED: DEFER.** No skills XP curve in xp-tables.json to compute
  an accurate x10 cost; the +1 Improve button (retail RaiseSelection) is the core. Revisit with a
  skills curve or a Rust batch export.

- **FORK-H (R3 social toggle) — RECOMMENDED: add `__toggleSocialPanel`** (symmetric open/close on
  one key, matches house-panel/spell-research). Alt: open-only `__openSocialPanel` + Escape-close.

---

## PROTECT (do NOT regress)

- `combat-bar.js:509` Recklessness reader — returns `skills[i+4]` (training); migrate STRIDE to 6
  in lockstep, value index stays `i+4`. Never leave at stride 5.
- `character-info.js` read-only Skills tiering (`renderSkills` :798-810 buckets + order
  Specialized→Trained→Untrained→Unusable) — the retail-faithful base layer; selection/footer are
  additive only.
- `computeNextRaiseCost(snap)` **1-arg** signature — `test_train_skill.mjs:124-158` depends on it;
  `snap.xp` is MARGINAL.
- `raiseSkill`/`trainSkill`/`raiseAttribute`/`raiseVital` wasm dispatch (d.ts:4443/5057/4434/4450).
- `renderAttributes` per-row `raiseAttribute`/`raiseVital` wiring (character-info.js:707-766).
- `options-panel.js setCharacterOption` round-trip (:827-839, the reference — not edited).
- `main-panel.js:346 setTitle` (panel-header text helper) — unrelated to R6; must NOT be touched.
- `examine-floaty.mount()` + the `examine` registerView (index.html:1712) + `__showExamineFor`
  install/override (examine-target.js:1271 / examine-floaty.js:367).
- `persistWindowSize.persist()` (ac_window_position.js:324-333) — the correct merge template, NOT
  the bug; do NOT make `writePersisted` self-merge.
- `pushView`/`closeView` semantics (main-panel.js:305-320) — R10 only touches `showView`.
- `salvage-confirm.js` bus + `tradeskill.js requireConfirm` flow — built/correct.
- `vitae-detail` self-wired click handler (no second listener), buffs-hud wasm path, hotbar
  cooldown wiring, StateDesc emission.
- LANDED F11-stance-revert fix: `inventory_helpers.js:217-226` + `inventory.js:1337-1338`.
- `SalvageItemsWithActionData` pack order + opcode `0x027D` + `test_salvage_items_with_parity`
  fixture — retail byte shape locked.
- `UseWithTarget` export/recv arm (salvage per-item fallback + tradeskill depend on it).
- Do NOT delete `train-skills.js` — its pure exports (`computeNextRaiseCost`, `decideTrainAction`,
  `TRAINING`, `mergeSkillRows`) are imported by S2's character-info.js and by test_train_skill.mjs.
- Do NOT preserve train-skills as a separate panel (owner directive).

---

# GROUP 1 — SKILLS-PANE CONSOLIDATION (HEADLINE)

Implement the retail `gmStatManagementUI` improve-footer INSIDE the existing character pane's
Skills + Attributes tabs; move the interactive raise/train dispatch out of the standalone
`train-skills.js` view; retire that view; repoint F11 to open the character pane at the Skills tab.
The character pane (`character-info.js`) already shares the single content-swapper
(`main-panel.js registerView("character")`, index.html:1713), already has the
Attributes|Skills|Titles tab strip (character-info.js:1082-1098), and Attributes already has
working per-row raise buttons. This is additive placement, not a from-scratch build.

Order: **S1 → S2 → S4 → S3 → S5(deferred)**. S1 gates the raise-cost preview; without it the Skills
raise button shows "Max" for everything.

## S1 — Rust 6-tuple: append MARGINAL next-rank cost; migrate FOUR stride-5 JS consumers (needsRust) — R1

**Cost math is RESOLVED to MARGINAL (FORK-A). Push `next_rank_xp − spent_xp`, NOT raw next_rank_xp.**

### Rust (apps/holtburger-web/src/lib.rs)
At the skills builder (`publish_player_stats_snapshot`, lib.rs:30714-30721):

```rust
// was: Vec::with_capacity(world.player.skills.len() * 5);
let mut skills: Vec<u32> =
    Vec::with_capacity(world.player.skills.len() * 6);
for skill in world.player.skill_snapshot() {
    skills.push(skill.skill_type as u32);
    skills.push(skill.current);
    skills.push(skill.base);
    skills.push(skill.ranks);
    skills.push(skill.training as u32);
    // 6th field: MARGINAL xp to next rank. next_rank_xp is the CUMULATIVE
    // xp to reach rank+1 (xp_table.rs get_next_skill_rank_xp indexes the
    // list directly); subtract spent_xp for the per-rank cost, matching
    // CLI render.rs:529-530 (saturating_sub) and retail gmSkillUI::
    // GetCostToRaise (acclient_2013 @0x0049b680 = ExperienceToSkillLevel
    // (s, level+1) - invested). 0 == max rank / unraisable; JS reads 0 as
    // 'no raise' (computeNextRaiseCost xp<=0 => null). Do NOT push raw
    // next_rank_xp.
    let next_cost = match skill.next_rank_xp {
        Some(cumulative) => cumulative.saturating_sub(skill.spent_xp),
        None => 0,
    };
    skills.push(next_cost);
}
```

`skill_snapshot()` returns `Vec<Skill>` by value (types.rs:1892), so `skill.spent_xp` (stats.rs:32)
and `skill.next_rank_xp` (stats.rs:33) are both in scope at the push site. New tuple layout:
`[type, current, base, ranks, training, next_rank_cost]`.

**Doc-comment updates (ALL of them — incomplete coverage was a HARDEN finding):**
- `lib.rs:30688` builder doc-comment `[type, current, base, ranks, training] × N` →
  `[type, current, base, ranks, training, next_rank_cost] × N`.
- `lib.rs:19400-19404` ("quintuples" → "sextuples"; append `next_rank_cost_u32` = MARGINAL xp to
  advance one rank, 0=max/unraisable).
- `lib.rs:19447` flat layout doc-comment → 6-tuple.

No `PlayerStatsSnapshot`/`LatestStats` struct change (skills is a pass-through `Vec<u32>`); `d.ts`
`readonly skills: Uint32Array` regenerates unchanged (only the doc/stride semantics change).

### JS — FOUR stride-5 consumers migrate to stride 6 in LOCKSTEP

There are **FOUR** (not three): the HARDEN review found a fourth, `ui/ac_damage_rating.js`. In each,
the value at `i+4` (training) is unchanged; only the loop stride moves; `next_rank_cost` is appended
at `i+5`.

1. **train-skills.js** (`mergeSkillRows`, :230, :247-251):
   - `for (let i = 0; i + 4 < len; i += 5)` → `for (let i = 0; i + 5 < len; i += 6)`.
   - `entry.xp = 0;` (:251) → `entry.xp = tupleArrayAt(playerSkills, i + 5) ?? 0;`.
   - Remove/rewrite the stale comment at :247-250 ("xp is not in the per-skill 5-tuple; spendable
     XP comes from levelInfo.unspent_xp") — both claims now false. Fix the layout doc at :48-49 and
     :95-104 to the 6-tuple; state index-5 is the MARGINAL next-rank cost.

2. **character-info.js** (`renderSkills`, :788):
   - `for (let i = 0; i + 4 < len; i += 5)` → `for (let i = 0; i + 5 < len; i += 6)`.
   - This loop reads `i, i+1, i+2, i+4`. ADD `const xp = tupleArrayAt(playerSkills, i + 5);` and
     stash in a new `xpByLine` Map (`xpByLine.set(id, xp ?? 0)`) for S2's footer. Update the
     :777-782 doc-comment and the stale inline `skills[i*5+3]` at :413 to the 6-tuple.

3. **combat-bar.js** (Recklessness reader, :509 — PROTECTED):
   - `for (let i = 0; i + 4 < len; i += 5)` → `for (let i = 0; i + 5 < len; i += 6)`.
   - Value stays `skills[i + 4]`. Update the :508 comment to the 6-tuple form. DO NOT change which
     index is returned.

4. **ui/ac_damage_rating.js** (`readTrainingLevel`, :105 — FOURTH consumer, HARDEN-added):
   - `for (let i = 0; i + 4 < len; i += 5)` → `for (let i = 0; i + 5 < len; i += 6)`.
   - Value stays `skills[i + 4]` (:107). Update the 5-tuple doc-comment (~:85-87) to the 6-tuple.
   - **Also update its test** `test_ac_damage_rating.mjs`: `stubSessionHandle` (:66-80) must push a
     SIXTH element per skill (e.g. `0,` for next_rank_cost) so the existing 5 assertions exercise a
     real 6-tuple and FAIL on any stride skew. Without this stub update the `--js` harness gate is
     FALSE-GREEN for this reader.

`computeNextRaiseCost(snap)` stays 1-arg, unmodified (PROTECT). The export name `raiseSkill` is at
lib.rs:**48680** (`pub fn`; :48679 is its doc-comment).

**Build (laptop, OOM-jailed):**
`export PATH="$HOME/.cargo/bin:$PATH" && capped-build wasm-pack build --target web --out-dir pkg --dev`
(reserve `--release` for the uncapped buildbox). Bump the `?v=` cache-bust on the wasm import in
index.html (grep for `holtburger_web.js?v=` rather than trusting line numbers).

**Verify:** `cargo test -p holtburger-protocol --lib` + `cargo test -p holtburger-world --lib` green;
`node test_train_skill.mjs` green; `node test_ac_damage_rating.mjs` green (with the updated 6-tuple
stub); in a session `playerStats().skills.length % 6 === 0`; a freshly-leveled Trained skill
(spent_xp just below next_rank_xp) shows a SMALL positive Raise cost (NOT the cumulative value);
max-rank stays "Max"; combat-bar Recklessness band + ac_damage_rating DR rollup unchanged for a
Trained/Specialized Recklessness. Harness probe: `playwright/drive.mjs`, assert
`skills.length % 6 === 0` and footer "Cost to Raise" === `(next_rank_xp − spent_xp)`, NOT
`next_rank_xp`.

> **forward-coordination:** when S2/S3 relocate train-skills logic into the character pane, the
> relocated `mergeSkillRows` must carry the stride-6 loop too (so character-info hosts two stride-6
> loops). Do not reintroduce a stride-5 reader.

## S2 — gmStatManagementUI improve-footer + selection model inside Skills + Attributes tabs

Files: character-info.js `renderSkills` :771-821, `renderAttributes` :673-769, `row()` :995-1063,
`.hb-ci-footer` CSS :376-391, `mount()` :1074-1235, `view.nameFor` :1067. Import
`{ TRAINING, computeNextRaiseCost, decideTrainAction }` from `./train-skills.js` (pure helpers
survive S3). Retail ref: `chorizite/.../gmStatManagementUI.cs` footer accessors (~207-262) +
`gmSkillUI.cs` (DisplayDefaultFooter ~193 / _Untrained ~201 / _Trained ~223).

Retail footer element-id provenance (decompiled, comments only — geometry hand-pitched):
`StatManagement_Footer_Default 0x10000240`, `_Text 0x10000241`, `_LineOneLabel/Value 0x10000242/3`,
`_LineTwoLabel/Value 0x10000244/5`, `_RaiseButton 0x10000246`, `_Meter 0x10000247`,
`_Raise10Button 0x100005EB`. LineOne default = AvailableSkillCredits (IntStat 0x18), LineTwo =
AvailableExperience (Int64Stat 0x02). Tag DOM with `data-el="0x10000242"` etc. so
`test_ac_layout_strings.mjs` can assert id presence.

(A) **Selection state** in `mount()`: `let selectedStatId = null; let selectedStatKind = null;`
(kind `'skill'|'attribute'|'vital'`). Add a `.hb-ci-improve` footer band ABOVE the existing 18px
`.hb-ci-footer` (which stays as the XP/Next status line): three lines (title, two value lines,
Improve button), `position:absolute; bottom:18px; height:~64px`. Shift `.hb-ci-body` bottom from
18px to ~82px **only when activeTab ∈ {skills, attributes}** (leave Titles tab at bottom:18px — its
structured layout assumes the full body). Stash refs `improveTitle/improveLine1/improveLine2/improveBtn`.
Reset `selectedStatId=null` on tab switch (in `setTab` :1141).

(B) **Skills rows selectable** (renderSkills, PRESERVE tiering): wrap each produced row el —
`el.dataset.skillId = String(skill.skillIdInt);`
`el.classList.toggle('selected', selectedStatId===skill.skillIdInt && selectedStatKind==='skill');`
and a click listener that sets `selectedStatId/Kind`, calls `renderImproveFooter()` +
`reapplySelectedClass()`. Build the footer snap from S1's `xpByLine` + `stateByLine` + skillTable
`trainedCost`. **Do NOT add per-row buttons to Skills** — retail puts the action in the footer.

(C) **renderImproveFooter** — three retail states:
- No selection → DisplayDefaultFooter: title `Select a Skill to Improve`;
  line1 `Skill Credits Available: ${credits}`; line2 `Unassigned Experience:
  ${availableXp.toLocaleString()}`; Improve disabled.
- Untrained selected → title `${name}`; line1 `Cost to Train: ${trainedCost} credits`; line2
  `Skill Credits Available: ${credits}`; button label `Train`, enabled iff
  `trainedCost>0 && trainedCost<=credits`.
- Trained/Specialized selected → build
  **`snap = { training: stateByLine.get(id), xp: xpByLine.get(id) }`** (xpByLine is the S1 MARGINAL
  value, so `computeNextRaiseCost(snap)` returns the marginal cost with NO further JS subtraction);
  `const cost = computeNextRaiseCost(snap);` title `${name}`; line1 `Cost to Raise:
  ${cost==null?'Max':cost.toLocaleString()} XP`; line2 `Unassigned Experience: ...`; button label
  `Improve`, enabled iff `cost!=null && cost<=availableXp`.

(D) **Improve dispatch** — lift `decideTrainAction` (train-skills.js:125-145) + the `dispatch()`
body (:574-585) verbatim: build `action = {kind: snap.training===TRAINING.UNTRAINED?'train':'raise',
skillId, cost, availableXp, availableCredits:credits}`, then
`const d = decideTrainAction(action, window.__pluginClient);` →
`client.player.trainSkill(...)` / `client.player.raiseSkill(...)`. Optimistic-disable the Improve
button after click (copy rec#141 at :1047-1058); the `playerStatsUpdated` subscription (:1188-1192)
re-renders on ack.

(E) **Attributes tab** (FORK-D = A): KEEP existing per-row `raiseAttribute`/`raiseVital` buttons
(PROTECTED, shipped) AND add the same footer band showing the selected attribute's cost. Clicking
an attribute row sets `selectedStatKind='attribute'`. Attribute cost already computes correctly
(nextRankCost = `table[ranks+1]-table[ranks]` from the cumulative xp-tables.json).

(F) Re-render the footer inside the existing `rerender()` after renderSkills/renderAttributes; re-apply
`.selected` after each rerender (`reapplySelectedClass`).

**Verify:** Skills tab footer shows credits + unassigned XP, Improve disabled with no selection;
click a Trained skill → footer title = skill name, numeric Cost to Raise (requires S1), Improve fires
`raiseSkill`; Untrained → Cost to Train in credits, Improve labeled `Train`, fires `trainSkill`;
max-rank → "Max", disabled; tiering + Attributes per-row raise unchanged; `node test_train_skill.mjs`
green. Harness: select a seeded Trained skill, assert footer cost === `snap.xp` (marginal) and
Improve dispatch calls `raiseSkill` with `[skillId, cost]`.

## S4 — Verify Skills tier order (R15)

The AUTHORITATIVE Skills display is `character-info.js:804-810`, whose `tierOrder` is ALREADY correct
(Specialized→Trained→Untrained→Unusable). Net action: confirm S2's selection wiring does NOT reorder
tiers. The inverted array R15 flagged is `train-skills.js:507` — dead after S3 retires the view, but
if S3 keeps `renderBody` alive for any reason, also fix :507 to
`[TRAINING.SPECIALIZED, TRAINING.TRAINED, TRAINING.UNTRAINED, TRAINING.UNUSABLE]`. Retail
`gmSkillUI::RebuildSkillList` ("specialized, trained, and untrained categories", ~:258) confirms.

## S3 — Retire standalone train-skills view; repoint F11 to character pane Skills tab (FORK-C = showView)

(1) **Remove** `mainPanelPlugin.registerView('train-skills', trainSkillsPlugin.view);` at
index.html:1735 and its Wave-4.A comment block (:1729-1735). After this no `train-skills` view
exists; couple with R10's warn-and-return guard (G3 below).

(2) **KEEP** `import * as trainSkillsPlugin` (index.html:1311), the plugin-map entry (:1472), and
the modulepreload (:968) — train-skills.js still exports the pure helpers S2 + the test import. Do
NOT delete train-skills.js. (Its DOM-building view/render functions become dead; the SAFE minimal
change is to leave them. The view export is at :650-654; the comment block is :642-649.)

(3) **F11 route via `showView`, NOT `toggleView`** (FORK-C, HARDEN-corrected). `toggleView`
(main-panel.js:324-330) CLOSES the pane when stack-top id is already `character`. Add a non-toggling
open-at-skills:
- Add `window.__mainPanel.showView('character', { tab: 'skills' })` capability (showView resets the
  stack and re-mounts so character-info.js:1087 `ctx.tab='skills'` is honored even when the pane is
  already open on Attributes).
- Add the F11 dispatch override in PLUGIN_HOTKEY_DISPATCH (index.html:1772-1785), keyed on manifest
  id `train-skills`:
  `'train-skills': () => window.__mainPanel?.showView?.('character', { tab: 'skills' }),`
- Keep train-skills.manifest.json's F11 declaration (matchManifestHotkeyEvent still yields pluginId
  `train-skills`); the dispatch entry intercepts it.

**Verify:** F11 opens/swaps the SHARED character pane to the Skills tab (title `<name> — Skills`),
NOT a separate panel; works even when the character pane is already open on Attributes (does NOT
close it); no `no view registered: train-skills` warn (route targets `character`, which is
registered); `node test_train_skill.mjs` green; grep confirms exactly ONE main-panel view renders
Skills. Harness: dispatch the F11 manifest action, assert `__mainPanel.currentViewId()==='character'`
and the skills tab is active.

## S5 — Improve-x10 (DEFERRED, FORK-G)

Retail footer has Improve (RaiseSelection +1) and Improve x10 (Raise10Selection +10,
GetCostToRaise10). Holtburger wasm exports only single-spend `raiseSkill(skill_id, xp_spent)`.
DEFER: no skills XP curve in xp-tables.json to compute an accurate x10 cost; the +1 Improve button
(S2) is the retail core. Document x10 as out-of-scope; gate any future x10 button on real cost data
(skills curve or a Rust batch export).

---

# GROUP 2 — Q1-RUST (covered by S1 above)

R1/Q1 is fully specified in **S1** (the gating prerequisite of the skills-pane consolidation). It is
the only Rust change in this wave. The standalone R1-S1..S5 component spec's "push directly, no
subtraction" was HARDEN-rejected and is superseded by S1 (marginal subtraction Rust-side, FOUR
consumers, OOM-jailed build).

---

# GROUP 3 — REGISTRY-DISPATCH (R2-R5)

All JS/HTML-only (needsRust=false). Verification uses the **Playwright browser driver**
`harness/playwright/drive.mjs` for keystroke/DOM observation (`run-js-headless.mjs` is a unit-test
aggregator and cannot send keystrokes); keep `run-js-headless.mjs` for pure-unit keymap assertions.

## R2 — emote-panel Shift+F2: static import + registerView('emote') + reshape view + declare cachedTaxonomy

FOUR edits (HARDEN added EDIT D — the latent ReferenceError):

- **EDIT A** index.html (after the trainSkills import at :1311):
  `import * as emotePanelPlugin from "./plugins/emote-panel.js";`
  (emote-panel is NOT in PLUGIN_MODULES and the loader's `loaded` Map is local, so a new static
  import is genuinely required. Keep emote-panel in BAR_SLOT_SUPPRESS — the import is for its view
  only.)
- **EDIT B** index.html:1735 (after the train-skills registerView line, still inside
  `if (!pluginsDisabled)`):
  `mainPanelPlugin.registerView("emote", emotePanelPlugin.view);`
  (No PLUGIN_HOTKEY_DISPATCH entry: the generic strip rule maps pluginId `emote-panel` →
  view `emote` → toggleView. Manifest already declares Shift+F2.)
- **EDIT C** emote-panel.js: reshape the bare `export function view(ctx){…}` (:411-466) into
  `export const view = { name:"Emote Palette", nameFor:()=>"Emote Palette", mount(parentEl, ctx){
  …existing :412-465 body verbatim…; parentEl.appendChild(container); return ()=>container.remove();
  } };` (mirror lore-panel.js:132-135). main-panel passes (bodyEl, ctx) and clears innerHTML in
  `_runCleanup` (:256), so explicit append + remover is safe. Do NOT re-add `__toggleEmotePanel`;
  leave `__test`.
- **EDIT D (BLOCKER, HARDEN)** emote-panel.js: declare the missing module-scope var. After :42
  (`let stylesInjected = false;`) add `let cachedTaxonomy = null;`. `cachedTaxonomy` is read at
  :414/:417/:422 but never declared (strict-mode ReferenceError on first mount). Without D, EDIT C's
  mount throws and main-panel swallows it as `view mount error (emote)` → BLANK pane.

**Verify (drive.mjs):** Shift+F2 opens main-panel titled "Emote Palette"; taxonomy sections render;
NO `no view registered: emote` warn, NO `view.mount is not a function` TypeError, NO
`[main-panel] view mount error (emote)`. Second Shift+F2 toggles closed. Open F4 first, then Shift+F2
→ swaps the same pane.

## R3 — social-panel Shift+F3: manifest hotkey + dispatch + __toggleSocialPanel (FORK-H = toggle)

- **EDIT A** social-panel.manifest.json:12 — append after `"slots":["panel"]`:
  ```json
  "hotkeys": [ { "id": "toggle", "default": "Shift+F3", "label": "Toggle Social" } ]
  ```
  (Shift+F3 verified FREE; keydown guard index.html:1787 allows shift.)
- **EDIT B** index.html:1784 (after the spell-research-panel dispatch line):
  `"social-panel": () => window.__toggleSocialPanel?.(),`
- **EDIT C** social-panel.js — add INSIDE the `if (typeof window !== "undefined")` block (between
  :973 and the closing brace at :974):
  ```js
  window.__toggleSocialPanel = () => {
    if (overlay?.classList.contains("open")) close(); else open();
  };
  ```
  (`overlay` is module-scoped :298; `.open` is the marker :954/:961. Mirrors house-panel.js:771-774.)

**Verify (drive.mjs):** Shift+F3 toggles #social (Friends/Squelch/Title); Escape still closes; no
duplicate-binding warn; F3 (Map) and Shift+F3 distinct.

## R4 — house-panel Shift+F6: one dispatch line

- **EDIT** index.html:1784 (after the spell-research-panel and R3 social-panel lines):
  `"house-panel": () => window.__toggleHousePanel?.(),`
  (Manifest already declares Shift+F6; `window.__toggleHousePanel` already exists
  house-panel.js:771-774. house-panel is a standalone overlay — do NOT register a `house` view.)

**Verify (drive.mjs):** Shift+F6 toggles #hb-house-panel; no `no view registered: house` placeholder.

## R5 — stance-toggle bar tint: THREE-part fix (FORK-F = iconSprite)

- **CAUSE 1 — mount never fires.** stance-toggle is in BAR_SLOT_SUPPRESS (index.html:1485), skipped
  at :1656. Add a static import near :1311
  (`import * as stanceTogglePlugin from "./plugins/stance-toggle.js";`) and invoke mount at the
  POST-LOGIN site, right after `window.__pluginClient = pluginClient;` (index.html:8257, inside the
  single-fire `if (!pluginClient){…}` block):
  ```js
  if (!pluginsDisabled && !window.__stanceBarMounted) {
    window.__stanceBarMounted = true;
    try { stanceTogglePlugin.mount({ client: pluginClient }); }
    catch (e) { console.warn("[stance-toggle] bar mount", e); }
  }
  ```
  (Mount post-login so the real client drives `playerStatsUpdated` live re-tint; index.html:2723-2724
  emits playerStatsUpdated on stance change. Keep stance-toggle BAR_SLOT_SUPPRESS-ed. Keep the
  `__stanceBarMounted` guard even though the block is single-fire — load-bearing if the mount is ever
  moved.)
- **CAUSE 2 — wrong selector.** stance-toggle.js:160 → `'.hb-bar-icon[data-plugin-id="combat-bar"]'`
  (bar.js:406 sets `dataset.pluginId = slot.id`; combat-bar's id is `combat-bar`).
- **CAUSE 3 — img-scoped CSS but emoji icon (the missed part).** The bar reads the per-plugin
  .manifest.JSON; combat-bar.manifest.json has NO iconSprite → bar.js:430 emoji `⚔`, no `<img>`, so
  the img-scoped filter (stance-toggle.js:48-51) matches nothing. Add to combat-bar.manifest.json:11:
  ```json
  "slots": ["bar", "panel"],
  "iconSprite": "0x06004D1C"
  ```
  (Sprite verified present: `data/ui-sprites/0x06004D1C.png`, 2185 bytes. bar.js:420-427 gracefully
  falls back to emoji if the PNG 404s, in which case the tint silently no-ops.)

**Verify (drive.mjs):** after login, toggle combat mode → the combat-bar icon renders as the
0x06004D1C `<img>` and visibly warms (melee/ranged) / cools (peace) as `data-stance` flips on
`.hb-bar-icon[data-plugin-id="combat-bar"]`; live update across two toggles; no double-mount on
relog.

---

# GROUP 4 — PARITY-WIRING (R6-R7)

All JS-only; `setTitle`/`setCharacterOption`/`isCharacterOptionEnabled` are shipped exports.

## R6 — Set Display Title: rename `sendDisplayTitle` → `setTitle`

**Token replace** every `sendDisplayTitle` → `setTitle` in character-info.js (5 occurrences: code at
:959/:960/:962/:965, comment at :948). Leave surrounding braces/indentation untouched (do NOT reflow
using a reproduced block — actual nesting is if/else inside try at :957-963, catch at :964). The
handle accessor (:958) and arity (1 numeric arg) are unchanged. Shipped export: `set_title` at
lib.rs:28985 → SessionCommand::TitleSet 0x002C; proof social-panel.js:924-925. Do NOT use the stale
ROADMAP `setDisplayTitle→0x0044`. Do NOT touch main-panel.js:346 setTitle (text helper).

**Verify:** `grep -c sendDisplayTitle character-info.js` → 0; Titles tab → select → Set Display Title
→ no "wasm export missing" warn; kind=28 titleUpdated drain re-renders renderTitles (:1157, .current
moves). jsdom unit: stub `window.__sessionHandle={setTitle:(id)=>{captured=id;}}`, drive the click,
assert `captured===selectedId`.

## R7a — allegiance Ignore toggle → setCharacterOption(0x01) + seed (FORK = server-only seed)

allegiance-panel.js around :841-855:
```js
const ALLEG_IGNORE_OPT = 0x01; // CharacterOption::IgnoreAllegianceRequests (character.rs:119)
let ignore = false;
try {
  const h = window.__sessionHandle;
  if (typeof h?.isCharacterOptionEnabled === "function") ignore = !!h.isCharacterOptionEnabled(ALLEG_IGNORE_OPT);
} catch (_) {}
// ...build toggle...
toggle.classList.toggle("on", ignore);
toggle.addEventListener("click", () => {
  ignore = !ignore;
  toggle.classList.toggle("on", ignore);
  saWithSession("setCharacterOption", (h) => {
    h.setCharacterOption(ALLEG_IGNORE_OPT, ignore);
    emit(`[allegiance] Ignore allegiance requests = ${ignore ? "on" : "off"}`);
  });
});
```
Pass the **ORDINAL** 0x01 (set_character_option lib.rs:27964 calls `CharacterOption::from_repr`),
NOT a bitmask (4). Seed via a bare try/catch (NOT saWithSession) to avoid emit noise. Remove the
`(client-side only)` emit. saWithSession is at :1211-1222.

**Verify:** grep shows both exports near the toggle; `client-side only` count → 0; toggle reflects
seeded state on mount; click fires `setCharacterOption` with ordinal exactly 1; re-opening
options-panel reflects the same bit (NOT a stale already-open panel — ACE does not echo options;
options-panel reads at render time). jsdom: seed `{1:true}` → toggle has `on`; click → calls
`[[1,false]]`.

## R7b — fellowship option toggles → setCharacterOption ordinal map + mutual-exclusion + seed

fellowship-panel.js:
- Near OPT_DEFS (:714): `const FELLOW_OPT_IDX = { ignore: 0x02, autoAccept: 0x12, shareXp: 0x0F, shareLoot: 0x11 };`
  (character.rs:120/136/133/135; matches options-panel.js:693-699.)
- **Seed** `opts` from server — insert immediately AFTER the localStorage parse `catch (_) {}` at
  :954 and BEFORE `let fellowshipName = "";` (:955), inside the render closure where `opts` is in
  scope (covers both branches; feeds fellowshipCreate's `opts.shareXp` read at :1014):
  ```js
  try {
    const h = window.__sessionHandle;
    if (typeof h?.isCharacterOptionEnabled === "function") {
      for (const k of Object.keys(FELLOW_OPT_IDX)) opts[k] = !!h.isCharacterOptionEnabled(FELLOW_OPT_IDX[k]);
    }
  } catch (_) {}
  ```
- **Click handler** (replace :737-746 body) — round-trip + retail Ignore↔AutoAccept mutual exclusion
  (acclient_2013 ~423501-423528):
  ```js
  row.addEventListener("click", () => {
    const next = !opts[o.id];
    opts[o.id] = next;
    row.classList.toggle("on", next);
    let pairClear = null;
    if (next && o.id === "ignore" && opts.autoAccept) pairClear = "autoAccept";
    else if (next && o.id === "autoAccept" && opts.ignore) pairClear = "ignore";
    if (pairClear) {
      opts[pairClear] = false;
      const pi = OPT_DEFS.findIndex((d) => d.id === pairClear);
      optEls[pi]?.classList.remove("on");
      withSession("setCharacterOption", (h) => h.setCharacterOption(FELLOW_OPT_IDX[pairClear], false));
    }
    try { window.localStorage?.setItem?.("hb.fellowship.opts", JSON.stringify(opts)); } catch (_) {}
    withSession("setCharacterOption", (h) => {
      h.setCharacterOption(FELLOW_OPT_IDX[o.id], next);
      emit(`[fellowship] ${o.label} = ${next ? "on" : "off"}`);
    });
  });
  ```
- Update the stale comment at :940-942. KEEP the localStorage write (pre-login fallback). The toggle
  rows render only in `buildAloneState` (:1003) — the seed at :954 covers both branches; the jsdom
  test must mount the ALONE state.

**Verify:** map + both exports present; enable AutoAccept then Ignore → AutoAccept loses `on` AND
`setCharacterOption(0x12,false)` fires before `setCharacterOption(0x02,true)`; re-open options-panel
reflects the shared bit; relog persists; `local-only` count → 0; jsdom asserts ordered calls
`[[0x12,false],[0x02,true]]` and literal hex ordinals (no `<<`).

---

# GROUP 5 — EXAMINE-STATE (R8-R9-R10) + STATE-MGMT (R11)

All JS-only.

## R8 — #selected-item-examine button → window.__showExamineFor

index.html:7666-7673, replace the console.log stub:
```js
selectedItemExamineBtn.addEventListener("click", () => {
  if (!selectedItemGuid) return;
  const name = selectedItemName?.textContent || `Item 0x${selectedItemGuid.toString(16)}`;
  if (typeof window.__showExamineFor === "function") {
    window.__showExamineFor(selectedItemGuid, { name, fromInventory: true });
  } else {
    window.__mainPanel?.pushView?.("examine", { guid: selectedItemGuid, name, fromInventory: true });
  }
});
```
`fromInventory:true` mirrors inventory.js:1884 (the inventory examine contract); target-bar.js:502
uses `fromEntity:true` for world targets — the selected-item box is inventory, so `fromInventory:true`
is correct. (`selectedItemName` is declared at index.html:7634.) Do NOT touch the Use button
(:7657-7665) or setSelectedItem (:7640-7655); do NOT re-fire requestAppraisal.

**Verify:** select item → Examine → floaty (default) / main-panel view (`?examineFloaty=0`) opens
populated; no console.log stub remains.

## R9 — examine-floaty close-before-open guard (id-scoped)

examine-floaty.js:302-304, in `openFloaty`:
```js
export function openFloaty(ctx = {}) {
  if (window.__mainPanel?.currentViewId?.() === "examine") {
    window.__mainPanel.closeView?.();
  }
  if (!state.overlay) buildOverlay();
  runCleanup();
```
Guard on `=== "examine"` ONLY (never close inventory/options/map — shared pane). No-op on the
disabled-floaty path. `currentViewId`/`closeView` on main-panel.js:588.

**Verify:** push main-panel examine, then trigger floaty examine → only the floaty; closing leaves no
stale examine view; opening inventory then examine does NOT close inventory.

## R10 — main-panel.showView(): warn-and-return for unregistered view

main-panel.js:292-302, replace the clobber branch:
```js
export function showView(id, ctx = {}) {
  if (!views.has(id)) {
    console.warn(`[main-panel] showView: no view "${id}"; keeping current`);
    return;
  }
  stack = [{ id, ctx }];
  _mountCurrent();
}
```
**ORDERING (critical):** `toggleView` calls showView for unregistered ids; the live unregistered-id
blast radius is exactly {emote, social, house} (confirmed; spellbook's F2 toggle-alt resolves to the
registered `spellbook`). R3/R4 route via PLUGIN_HOTKEY_DISPATCH (the dispatch branch
index.html:1807-1808), which BYPASSES showView entirely; only R2 makes `emote` a registered view.
So land R10 **WITH/AFTER R2 (and R3/R4)** — before them, those hotkeys degrade from placeholder to
silent no-op. Leave the `_mountCurrent` unregistered branch (:266-276) untouched (defensive).

**Verify:** open inventory, `showView('definitely-not-registered')` → inventory stays, single warn,
no "View not built yet" placeholder; after R2/R3/R4, Shift+F2/F3/F6 open emote/social/house; a
registered id still swaps.

## R11 — ac_window_position scheduleSave/lock/reset: read-modify-merge (dual CHAT writer)

Root cause (precise): attachWindowPosition's local `state` lacks width/height on the fresh-user
(:92) and legacy-migration (:87) init paths → `writePersisted` emits width:null/height:null,
clobbering what `persistWindowSize` wrote under the same key (WINDOW_ID.CHAT 0x10000600). For a
RETURNING user, readPersisted (:246-260) seeds width/height at mount (:83), but that value goes
STALE once `persistWindowSize.commit()` resizes post-mount, so a later position write reverts to the
stale value. The read-modify-merge helper fixes both.

After `storageKey` is computed (~:81) add:
```js
function persistPosition() {
  const cur = readPersisted(storageKey) || {};
  writePersisted(storageKey, {
    x: state.x, y: state.y, locked: state.locked,
    width: cur.width ?? null, height: cur.height ?? null,
  });
}
```
Replace `writePersisted(storageKey, state)` with `persistPosition()` at: scheduleSave (:101),
lockButton click (:176), setLocked (:194), resetPosition (:200). Leave the legacy-migration write
(:88) and `writePersisted` (:262-272) UNCHANGED. Do NOT change `persistWindowSize.persist()`
(:324-333, the correct template) or the chat-panel dual-writer split (:732/:757).

**Verify (NEW test `test_ac_window_position_merge.mjs`, placed in the harness TIER4 array
lines :90-93 of run-js-headless.mjs, using the hand-rolled jsdom-lite DOM shim + localStorage stub
pattern — NOT the npm jsdom package):** seed key `hb.window.10000600` `{x:10,y:20,locked:false,
width:400,height:300}`; attach on a stub element (style + getBoundingClientRect shim) windowId=CHAT;
simulate drag-end + advance the 120ms timer; assert `readPersisted().width===400 && height===300 &&
x===<dragged>`; assert `setLocked(true)` preserves width/height. Manual: resize chat, drag it,
reload → both retained.

---

# GROUP 6 — SCAFFOLDS (R12-R13-R14)

## R12 — gate salvage-panel destructive batch behind the salvage-confirm bus (no Rust)

salvage-panel.js. Split fireSalvage into request + commit.

- **STEP 1** — rename the existing fireSalvage send-ladder BODY at :452-489 into
  `commitSalvage(tool, itemGuids)` taking explicit args. **REMOVE the guard + derivations at
  :449-451** (replaced by params); keep only the send-ladder body verbatim (incl. the
  `const client = state.client ?? window.__pluginClient` derivation at :452 and the
  warnedMissingSend warn). Do NOT keep :449-451 inside commitSalvage (it would ignore the params and
  re-read stale state).
- **STEP 2** — new fireSalvage emits the request:
  ```js
  function fireSalvage() {
    if (state.items.length === 0 || !state.toolGuid) return;
    const tool = state.toolGuid >>> 0;
    const items = state.items.map((it) => ({ guid: it.guid >>> 0, label: it.label }));
    state.awaitingConfirm = true;
    try {
      window.dispatchEvent(new CustomEvent("hb:salvage-confirm-request", {
        detail: { toolGuid: tool, toolLabel: `0x${tool.toString(16).toUpperCase().padStart(8,"0")}`, items },
      }));
    } catch (_) { state.awaitingConfirm = false; commitSalvage(tool, items.map((i)=>i.guid)); }
  }
  ```
- **STEP 3** — in mount(), add a result listener guarded by `state.awaitingConfirm`:
  ```js
  function onConfirmResult(ev) {
    const d = ev?.detail ?? {};
    if (!state.awaitingConfirm) return;
    state.awaitingConfirm = false;
    if (d.kind !== "confirm") return;
    const items = (Array.isArray(d.items) ? d.items : []).map((it) => (it.guid >>> 0)).filter(Boolean);
    if (!items.length || !(d.toolGuid >>> 0)) return;
    commitSalvage(d.toolGuid >>> 0, items);
  }
  window.addEventListener("hb:salvage-confirm-result", onConfirmResult);
  ```
  Add `awaitingConfirm:false` to state (:82-97); reset in openPanel (:491-524) + closePanel
  (:526-542); removeEventListener in mount teardown (:582-590).

Do NOT modify salvage-confirm.js or tradeskill.js. Preserve the send-ladder bytes (R14's surface).
Retail support: TargetedUsageConfirmation_Salvage@ClientUISystem (acclient.txt:1967) confirms retail
gates salvage behind a confirmation.

**Verify (jsdom, `run-all.mjs --js`):** mount salvage-panel + salvage-confirm; addItem(0x50000100);
openPanel(0x50000201); click `.hb-sv-fire` → `#hb-salvage-confirm[data-open]==='1'` and ZERO sends;
Cancel (`[data-action=cancel]`) → 0 sends, panel still open; re-fire + Salvage
(`[data-action=confirm]`) → exactly ONE send `(0x50000201,[0x50000100])`.

## R13 — reach tinker/salvage panels (FORK-E = FULL-FINISH; CRITICAL constant 0x20000000)

**RECOMMENDED FULL-FINISH (salvage):** inventory.js, insert a guarded pre-return BEFORE
`handle.useObject(guid)` (:1845), AFTER the container (:1801) and setWielded (:1827) returns:
```js
if (isSalvageTool(item) && typeof window.__openSalvagePanel === "function") {
  try { window.__openSalvagePanel(guid); return; } catch (_) {}
}
```
**`isSalvageTool`: `((item?.itemType >>> 0) & 0x20000000) !== 0`** — `IT_TINKERING_TOOL = 0x20000000`
(canonical_classify.js:56; chorizite enum). **NOT `0x00020000` (that is IT_LOCKABLE)** — using the
wrong value would never detect a tool AND mis-open on lockables. Reuse the in-tree `IT_TINKERING_TOOL`
or hardcode `0x20000000`; no external lookup needed. `itemType` is the only exposed wasm getter
(lib.rs:19172; materialType is NOT exposed). A miss falls through to useObject (no regression). No
F-key; tinker stays global-only via `window.__openTinkerPanel`. Retail: UsingItem →
SendNotice_OpenSalvagePanel is an in-process gmNoticeHandler vtable walk (gmSalvageUI::Register
acclient_2013 0x47a4fb) — open locally on use is faithful.

**ALT GATE-OFF:** set both manifests `"environments": ["cli"]` (loader skips mount under host
`browser`; globals never publish; do NOT delete the files).

**Verify (jsdom):** snapshot with a tinkering tool `itemType=0x20000000` + a melee item `0x00000001`;
spy `__openSalvagePanel` + `useObject`; dblclick each → tool opens panel once, useObject zero;
melee → existing path, panel zero.

## R14 — expose 0x027D SalvageItemsWith batch SEND (wasm bridge only; needsRust)

The protocol + core pipeline ALREADY EXIST as `SalvageItemsWith` (opcode 0x027D opcodes.rs:428;
GameAction game_action.rs:82/303/707; `SalvageItemsWithActionData{tool_guid, items:Vec<Guid>}`
inventory/actions.rs:247-277 with green `test_salvage_items_with_parity` vs fixture
ACTION_CREATE_TINKERING_TOOL; ClientCommand + dispatch core types.rs:584/commands.rs:449). The ONLY
gap is the web wasm bridge (lib.rs uses SessionCommand, a separate enum). Three edits, all in
apps/holtburger-web/src/lib.rs:

(1) SessionCommand variant (after UseWithTarget @17789):
`SalvageItemsWith { tool_guid: u32, items: Vec<u32> },`

(2) wasm export — name `createTinkeringTool` to match salvage-panel.js:463's feature-detect (ZERO JS
change). Mirror useWithTarget (@27402) channel-send + populate_terrain (@27522) Vec arg:
```rust
#[wasm_bindgen(js_name = createTinkeringTool)]
pub fn create_tinkering_tool(&self, tool_guid: u32, items: Vec<u32>) -> Result<(), JsValue> {
    use futures::channel::mpsc::TrySendError;
    if items.is_empty() { return Err(JsValue::from_str("create_tinkering_tool: items empty")); }
    self.cmd_tx
        .unbounded_send(SessionCommand::SalvageItemsWith { tool_guid, items })
        .map_err(|e: TrySendError<_>| JsValue::from_str(&format!("create_tinkering_tool: cmd channel closed ({e})")))
}
```

(3) recv_loop arm (mirror UseWithTarget arm @38638-38677; items u32 → Guid). `SalvageItemsWithActionData`
re-exports through `holtburger_protocol::messages::*` (confirmed: game_action.rs:7 + messages/mod.rs:31;
lib.rs:38661 already uses the `messages::UseWithTargetActionData` path), so the pseudo-code path
compiles as-is:
```rust
Some(SessionCommand::SalvageItemsWith { tool_guid, items }) => {
    let action = holtburger_protocol::messages::GameAction::SalvageItemsWith(Box::new(
        holtburger_protocol::messages::SalvageItemsWithActionData {
            tool_guid: holtburger_common::Guid::from(tool_guid),
            items: items.into_iter().map(holtburger_common::Guid::from).collect(),
        },
    ));
    if let Err(e) = session.send_action(action).await {
        log::warn!("recv_loop: send_action(SalvageItemsWith): {e}");
        queued_events.borrow_mut().push(ClientEvent {
            kind: CLIENT_EVENT_KIND_DISCONNECTED,
            string_payload: Some(format!("salvage_items_with: {e}")),
            u32_payload: None, u32_payload_2: None, f32_payload: None,
        });
        return;
    }
}
```

Do NOT alter the actiondata pack order / 0x027D opcode (parity-locked). Do NOT touch UseWithTarget.
Once shipped, salvage-panel's existing ladder (:463) picks `createTinkeringTool` as the preferred
batch send — NO JS edit.

**Build:** OOM-jailed `capped-build wasm-pack build --target web --out-dir pkg --dev`; bump the wasm
`?v=` cache-bust (grep `holtburger_web.js?v=`).

**Verify:** `cargo test -p holtburger-protocol --lib test_salvage_items_with_parity` green; after
rebuild d.ts lists `createTinkeringTool(tool_guid, items)`; Tier-3 in-world: queue 2+ items, confirm
(R12) → exactly ONE outbound 0x027D + ONE SalvageOperationsResult (kind 52, decode index.html:10474).

---

# RETAIL GROUND-TRUTH (read-only, informs S1/S2)

- gmStatManagementUI footer ids 0x10000240-0x10000247 + Raise10 0x100005EB (UIElementId.cs:1452-1466).
  Shared by gmSkillUI + gmAttributeUI — exactly the owner's "bind INTO the tabs" model.
- Cost = MARGINAL = `ExperienceToSkillLevel(s, level+1) − invested_xp` (gmSkillUI::GetCostToRaise
  @0x0049b680; gmAttributeUI @0x0049cb80). Untrained cost is in CREDITS (trained_cost), trained/spec
  cost is in XP. Holtburger `next_rank_xp` = cumulative `ExperienceToSkillLevel(level+1)`, `spent_xp`
  = invested → cost = `next_rank_xp − spent_xp` (S1).
- List order Specialized→Trained→Untrained→Unusable (RebuildSkillList; matches character-info
  tierOrder).
