# Dungeon Editor — Bug Report Response & Guidance (2026-06-22)

Thanks for the report — this is exactly the kind of detail that makes things
fixable. Below is where each item stands, what's already been corrected, and
practical guidance you can use **today** while the remaining GUI-side work is
done.

> **Important context up front.** WorldBuilder ships as two things that share a
> lot of code: the **GUI program** you click in, and a headless **command-line
> tool** (`WorldBuilder.Terminal`) used by scripts and automation. A round-to-tip
> fidelity audit on 2026-06-10 found and the 2026-06-11 fixes corrected the
> root causes behind your two bugs — **but those fixes landed in the command-line
> tool and the shared export code, not in the GUI's own dungeon-editing code
> paths.** So depending on exactly which button you press, you may still hit them
> in the program. The guidance below tells you how to stay safe in the meantime.

---

## Bug 1 — Connecting dungeon segments auto-rotates them "one way"

**What's going on.** There are two separate places orientation gets decided:

1. **In the GUI**, when you connect/place a piece, the editor computes the new
   segment's orientation from the stored portal transforms of the prefab
   (`DungeonEditingContext.BuildPrefabEnvCells`). This is the editor's own logic
   and is what you're seeing as the automatic turn.
2. **On export** (writing placements out to ACE / DATs), there was a separate
   bug where the *default* orientation was stored as a **180° turn about the
   vertical (Z) axis instead of "no rotation"** — so anything placed without an
   explicit angle came out **facing backwards** in-game. That one is **fixed**
   (audit finding F166, fixed 2026-06-11) in the command-line + export layer.

**Status:** the backwards-in-ACE default (#2) is corrected. The in-editor
auto-turn when chaining pieces (#1) is GUI-side and is still on the list.

**Workaround you can use now (verified):** after a segment connects facing the
wrong way, re-orient it directly. Select the room/cell and use the **Cell
Properties** panel's rotate buttons — there are **−90 / +90 controls for the X,
Y, and Z axes**. It's undoable (Ctrl+Z) via the editor's command history, so you
can spin it to the correct facing without re-placing the piece. Static objects
inside a cell have their own rotate control as well.

---

## Bug 2 — Saving a dungeon (even without edits) removes LOTS of objects

This is the dangerous one, so read the safety steps below before your next save.

**First, two different "saves" — they are not the same:**

| Action | What it does | Where the known bugs live |
|---|---|---|
| **Save** (in the dungeon editor) | Writes the dungeon into your **project** (`.wbproj`), not the game files | GUI path — still being hardened |
| **File → Export** | Writes the actual **DAT files** ACE/the client read | Shared export code — **hardened 2026-06-11** |

**Root causes we found and fixed (2026-06-11, command-line + shared export):**

- **F58 — silent partial saves.** The export routine could fail to write
  individual cells / the dungeon and *still report success*. From the outside it
  looked like a clean save while objects had quietly dropped. Now failures are
  surfaced instead of swallowed.
- **F57 — building-delete corrupted cell numbering.** Deleting a building shrank
  the landblock's cell count without compacting the cells, which pushed
  *surviving* interiors out of the loadable range — they'd stop showing up
  (looked like objects/rooms vanished). Now corrected, with a regression test.
- **F163 — dungeon placement edits weren't being persisted** at all in the
  command-line path. Fixed there.

**Honest status for the GUI:** the fixes above are in the **export / shared**
code and the command-line tool — confirmed, **zero GUI files were changed**. So:

- If your object loss happens on **File → Export**, the 2026-06-11 fixes should
  now help (that path runs the hardened shared export code).
- If it happens on the **Save** button in the editor itself, that's the GUI's
  own document-save path (`SaveDungeon` → validate + `ForceSave`), which we still
  need to harden — treat it as **not yet fixed**.

**Stay-safe guidance until the GUI path is done (all verified):**

1. **Back up before every save/export.** Copy your `.wbproj` (and any exported
   DAT) first. This alone protects you from all three failure modes above.
2. **Run WorldBuilder from a console/terminal.** The editor already validates on
   save and prints the results — you'll see lines like
   `[DungeonSave] Warning: …` and `[DungeonSave] Saved … N cells`. Those warnings
   are currently **only printed to the console** (the GUI doesn't pop them up
   yet), and the cell count `N` lets you spot a drop immediately. If you see
   warnings or `N` shrink, **don't overwrite your backup.**
3. **Cross-check counts with the command-line tool.** `get-dungeon-info` and
   `validate-dungeon` in `WorldBuilder.Terminal` report cells / portals / static
   objects and were hardened in this same pass — run them before and after a
   save/export to confirm nothing was lost.
4. **Be cautious deleting buildings.** Deleting a building that isn't the most
   recently added one is the F57 scenario — verify on a backup before trusting
   the result.

---

## Idea 1 — Attach dungeons to the landscape (tunnels) — *thanks, Zan!*

Logged as a **feature request** (not a bug). Quick note on what it involves so
expectations are set: dungeons are stored as interior cells (EnvCells) in
`cell.dat`, while the outdoor world is terrain. Connecting them as a walkable
tunnel needs a **portal/transition stitching the outdoor terrain to the
dungeon's entry cell** — the same kind of indoor↔outdoor handoff the game uses
when you walk out of a house. It's a real, doable feature but not a one-click
action today; it's on the design list.

---

## Reference (for maintainers)

- **Audit doc:** `docs/terminal_command_fidelity_audit_2026-06-10.md` (commit `751bf9fc`)
- **Fix commits (2026-06-11):** `98dc8361` (CRITICAL+HIGH, incl. F57/F58/F166/F163),
  `2db8a23c` (MED+LOW). Both touched **only** `WorldBuilder.Terminal/*` and
  `WorldBuilder.Shared/*` — no GUI files.
- **GUI code paths that still own these bugs:**
  - Connect / auto-rotate: `WorldBuilder/Editors/Dungeon/DungeonEditingContext.cs` → `BuildPrefabEnvCells`
  - Editor Save: `WorldBuilder/Editors/Dungeon/DungeonEditorViewModel.cs` → `SaveDungeon` → `DungeonDocument.Validate` / `ForceSave`
  - Rotate workaround (already wired): `WorldBuilder/Editors/Dungeon/Views/CellPropertiesView.axaml` (±90 X/Y/Z) → `RotateCellCommand`
- **Export path (hardened 2026-06-11):** `WorldBuilder.Shared/Models/Project.cs` → `ExportDats`
- **Next GUI work:** surface `Validate()` warnings in the UI (not just console);
  decide whether the in-editor Save should run the same integrity checks the
  export path now does; revisit the connect-time default orientation.
