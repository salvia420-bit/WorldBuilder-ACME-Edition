# HANDOFF — 2026-08-22: per-body ragdoll individualization (693/693 DONE, plugin wired)

The "~25 variants per monster class" deferred item from `HANDOFF-2026-08-21-EOD` is superseded
and delivered as **one authored death-ragdoll profile per distinct creature body**: all **693
setupDids** in the LSD dump, produced by a director + Opus-agent loop (29 batches, every batch
validator-PASS, merged and QA'd), and loaded by the plugin at runtime. NOT yet eye-validated
in a live client — that is the single remaining gate (1070 session).

## The 33/33/34 contract (what a profile IS)

Per parameter: `final = 0.33*legA + 0.33*default + 0.34*legC`, clamped to hard envelopes.
- **Leg A — the original death animation** (extracted from the retail DATs): per motion table,
  the Dead (0x…11) animation's duration, root drop, ground travel + direction, slump speed,
  rotation sweep → mechanical parameter targets via a fixed mapping (RUNBOOK). 133 of 171
  distinct motion tables had a Dead anim; the rest use a declared same-class fallback.
- **Leg B — the shipped sim defaults** (the anchor; `RagdollParams.Default` is bit-identical
  to the old constants — a body with no profile falls exactly as before).
- **Leg C — authored character**, grounded per body in acpedia lore (creature pages, death
  texts, family lore) — the "vibe" leg, hard-bounded by envelopes.
Anti-fly guarantees: `maxSpeed`/`maxUpSpeed` can never exceed the old defaults; `fallFrames`
∈ [45,150]; the validator recomputes every blend and rejects out-of-envelope or near-clone
profiles. Final QA over all 693: 0 envelope violations, 0 near-clone pairs (min normalized
pairwise distance ≥ 0.02 globally), impulse 1.86–2.54, twist 1.33–2.60, fallFrames 60–130.

## What changed in the plugin (AcmeRagdoll/, working tree — NOT committed)

- `Sim/RagdollParams.cs` (new): immutable per-body parameter set + `Default`.
- `Sim/RagdollSim.cs`: tunable constants → instance params; direction-bias pull
  (`dirBiasDeg` convention: degrees from +Y toward +X = `atan2(dx,dy)`, matching the
  anim extractor; conversion `θ = π/2 − radians(deg)` — a sign error here mirrors
  side-falls, already caught and fixed in review). Default path verified **bit-identical**
  to the pre-change sim (6 skeletons × 4 seeds × 120 frames).
- `Lib/RagdollProfiles.cs` (new): loads `ragdoll_profiles.json` from the plugin dir on the
  managed thread (0x80131509-safe; logs "N profiles loaded"); `For(setupDid)` → Default on miss.
- `Services/RagdollRegistry.cs`: Seed looks up by SetupDid, corpse handoff carries the params
  (identical constraints on rebuild); throttled `SweepStale` also runs from the non-Dead
  MotionDone path (closes the "hot hook armed forever after despawn" gap).
- `AcmeRagdoll.csproj`: `ragdoll_profiles.json` ships beside the DLL (PreserveNewest).
- Build: `DOTNET_ROLL_FORWARD=LatestMajor dotnet build AcmeRagdoll -c Release` → 0 warnings.
  Deploy set is now DLL + manifest.json + **ragdoll_profiles.json**.

## Where everything lives

`/mnt/wbterminal2/ragdoll-individualize/`:
- `RUNBOOK.md` — the full contract (schema, envelopes, Leg A mapping, agent rules).
- `ragdoll.db` — bodies (693, all status=done) / body_weenies / anim_metrics (the DAT
  death-anim measurements). `acpedia.db` — 36,816 wiki pages, 2,963 creature pages with
  Class, FTS title search (built this run from the XML dump; there was no pre-existing SQL).
- `out/batch-B001..B029.json` — per-batch authored profiles with legA/legC provenance.
- `out/profiles_merged.json` — merged authored set (provenance kept).
- `out/ragdoll_profiles.json` — the plugin-consumed file (copied into `AcmeRagdoll/`).
- `validate_profiles.py` / `finalize.py` / `merge_batch.py` / `gen_brief.py` /
  `extract_anim_metrics.py` / `build_acpedia_db.py` — the pipeline; state.json — run log.

## Notable per-batch judgment calls (agents flagged, director accepted)

Mixed-setup bodies profiled for the dominant visual (e.g. 0x02000041 Virindi vs 17 human-NPC
shells); base human bodies 0x02000001/0x0200004E kept deliberately conservative (widest reach);
"Object"-class pseudo-creatures (doors/barrels/mastery stands/presents — ~146 bodies) in a
quiet near-default register, with genuinely living mislabels caught and re-registered
(Virindi Portal, T'thuun Tentacles, Bloodroot Vine); Drudge Balloon's fly-away retail anim
deliberately NOT propagated (anti-fly rule); Knathtead authored to real wiki lore (mana-jelly)
over the genre guess.

## Next steps (the only open gates)

1. **1070 eye-test session**: deploy the new build + JSON, kill a Drudge (baseline feel),
   an Olthoi (stiff chitin register), a Wisp/Virindi (float register), a Golem (dead-weight),
   and something with a directional Leg A (plinth statue: backward topple) — confirm the log
   line `ragdoll: 693 profiles loaded` and per-arm `setupDid=` lookups; tune per-class from
   the arm logs if anything reads wrong (profiles are data — edit JSON, no rebuild needed).
2. dirBias visual sanity: one side-falling body (fall_dir ≈ ±90°) to confirm the convention
   fix lands falls on the correct side.
3. Owner verdict on holding corpse pose past 15 min for player corpses (HoldMillis raise) —
   unchanged from yesterday's handoff, cosmetic only.
