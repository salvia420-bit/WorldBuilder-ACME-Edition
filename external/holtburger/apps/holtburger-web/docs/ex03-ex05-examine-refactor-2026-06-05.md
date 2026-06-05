# EX-03 / EX-05 Examine refactor — design + deferral plan (P1-33 / P1-34)

The cross-find audit's top examine findings are:

- **EX-03** — Promote examine from a main-panel view (sharing the 300×362
  brass-frame container) to a **standalone gmFloatyExaminationUI** floaty
  at 310×400 with its own FloatyFrame chrome + window-position
  adapter + 14×14 close button at (284, 8).
- **EX-05** — Wire the **AppraisalProfile** round-trip: send
  `awaiting_appraisal_ID = guid` when the popup opens, then on
  `AppraisalInfoEvent` (opcode 0x00C9) render the
  `AttributeInfoRegion` / `SkillInfoRegion` / `EffectInfoRegion`
  sections. Gate Type/Class/Wcid/X/Y/Z/Landblock behind `?debug=1`.

Both close 7+ downstream findings (EX-01/02/06/08, SB-01, VN-04). Big
leverage but each is a real refactor.

## Current state (2026-06-05)

- `examine-target.js` is registered as `mainPanelPlugin.registerView("examine", ...)`
  — it mounts INTO the main-panel container.
- `populateFromInventory` / `populateFromEntity` already branch by
  source (inventory item vs world entity).
- `iconEl` is now resolved via the shared `resolveBindingIcon` helper
  (P2-44).
- Inscription set-button dropped (P2-44 / EX-06).

## EX-03 migration path

1. Add a new floaty overlay `#hb-examine-floaty` (310×400) with
   FloatyFrame chrome (resolve via `resolveFrameSpritesFromLayout` on
   layout `0x2100006B` — gmFloatyExaminationUI).
2. Move examine-target.js's `view` export to also work as a
   `mount(ctx)` standalone overlay. Same DOM-build code; different
   parent.
3. Wire `target-bar.js`'s examine button to open the floaty (not the
   main-panel view) when `?examineFloaty=1` is set; keep the view as
   fallback.
4. Add `WINDOW_ID.EXAMINE = 0x100005FF` (gmFloatyExaminationUI root —
   needs DAT verification) + attachWindowPosition.

Risk: examine-target.js carries scroll containment + close-on-Esc
that depend on main-panel's host. The floaty version needs its own
focus management.

## EX-05 wire plan

Per `acclient.h:36603-36629` the AppraisalProfile struct ships:
- `success_flag: i32`
- `creature_profile`, `hook_profile`, `weapon_profile`, `armor_profile`
  (each optional)
- 6 PackableHashTables (int/int64/bool/float/str/DID stats)
- `armor_ench_bitfield`, `weapon_ench_bitfield`, `resist_ench_bitfield`
- 9 armor regions (`base_armor_head`..`base_armor_foot`)

ACE wire flow:
- C2S: `GameAction::IdentifyObject` (sub-opcode 0x00C8) — already
  exists in protocol (game_action.rs:86)
- S2C: `GameEvent::IdentifyObjectResponse` (event ~0x00C9) — needs to
  be wired through `messages/player/events.rs` if not already there.

Wasm-side:
1. Add `awaiting_appraisal_ID: Option<Guid>` to PlayerState (or a
   side cache in lib.rs `LatestStats`).
2. Add `SessionCommand::RequestAppraisal { guid }` that fires
   `GameAction::IdentifyObject`. JS calls
   `sessionHandle.requestAppraisal(guid)`.
3. Add S2C handler for `GameEventOpcode::IdentifyObjectResponse` that
   stores the `AppraisalProfile` in a `latest_appraisal:
   Option<AppraisalProfile>` ref + publishes a `ClientEvent` so the
   JS examine plugin can re-render.
4. JS examine: on mount, call `requestAppraisal(guid)`; on event
   `appraisalReady`, read the cached profile and render the three
   region sections.

## Why deferred this turn

Both EX-03 and EX-05 are individual >half-day refactors that would
churn:
- 870 lines of examine-target.js (EX-03)
- holtburger-protocol AppraisalProfile S2C parser + recv-loop +
  LatestStats field + a new SessionCommand (EX-05)
- New wasm rebuild (~3 min) for EX-05 alone

In the current context window I can't safely land both with
end-to-end validation. Tracked as concrete plans here; pickup as the
next session's focused work.

## Next steps

Owner: pick this up in a fresh session with:
1. Read `examine-target.js` end-to-end (start with `populateFrom*`).
2. Add the floaty container + window adapter + FloatyFrame in a new
   `plugins/examine-floaty.js` that wraps the existing view module.
3. Separately, wire the AppraisalProfile request/response chain in
   `holtburger-protocol` + `lib.rs` + the examine plugin.
