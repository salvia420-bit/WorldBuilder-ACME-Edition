# Handoff — audit the "prefetch-walk resolver-mirroring trap"

**Date:** 2026-06-19 · **Origin:** combat-anim debugging session (swings fired but didn't animate).
**Status of the seed bug:** FIXED + pushed (`a0e0a0c1`, origin/master = salvia420-bit). This handoff is for the *systemic* follow-up: how many other fetch sites / URL flags share the same trap?

---

## The trap (precise definition)

Many wasm fetch functions follow this shape:
1. an **async prefetch walk** — `prefetch::ensure_walk_prefetched[_keyed](&source, &initial, |s| { …closure… })` — that discovers + fetches DAT records by *touching* them inside the closure;
2. then a **synchronous bake** (`build_*_inner` / `try_resolve_*`) that reads records via **`get_file_by_key`**.

`get_file_by_key` is **SYNC cache-only** — records are loaded ONLY by the async walk (holtburger-resource-http `manifest_source.rs:4-5`). **If the walk's closure does not follow EVERY resolver the sync bake uses, the un-walked records miss → the bake silently drops them (0 frames / empty result).** The failure is silent + misleading (e.g. logged "no MotionTable link … swing will not play" even though the link + its anims are all correctly served).

## The instance found + fixed (the template)

`fetch_entity_animation_keyframes` (`apps/holtburger-web/src/lib.rs`, walk closure ~16329):
- Walk followed `try_resolve_cycle_frames` **only**.
- Bake (`build_entity_animation_data_inner_v2` → `try_resolve_link_frames` when `from_motion_command != 0`) ALSO uses the **link** resolver.
- ⇒ attack/cast/eat/emote/death **link** anims (`0x1000005x` → Animation chain) were never prefetched → swing baked **0 frames**.
- **FIX (`a0e0a0c1`):** walk now also calls `try_resolve_link_frames` when `from_motion_command != 0`.
- **Verified live (1070):** link `0x10000053` bake `0 → 138 frames`; player + monster swings animate. Needed a wasm rebuild.

**Known remaining (low priority):** the 0x01 **GfxObj** anim path (`lib.rs ~16277` closure) only calls `triangulate_model_per_part_buckets` — no cycle/link warm. MOOT today: 0x01-as-setup entities have no `SetupModel.default_motion_table` → no MotionTable → nothing to bake. Add the same warm only if a 0x01 entity ever needs animations.

---

## The audit task

There are **56** `ensure_walk_prefetched[_keyed]` sites in `apps/holtburger-web/src/lib.rs`. For EACH:
1. Find the sync bake/build it precedes (the `*_inner` / `build_*` / `try_resolve_*` after `.await?`).
2. Enumerate every **resolver / record-discovering call** that bake makes.
3. Check the walk closure follows **all** of them. (Empty closures `|_| {}` only need the `initial` key list to already cover the bake's record-needs — verify that.)
4. Verdict: **MIRRORS** (safe) / **GAP** (trap — name the un-walked resolver/records) / **N/A**.

Then audit **flags** (apps/holtburger-web/docs/url-flags.md + the default-on/off set): which flags enable a NEW record-need on a bake path whose walk doesn't cover it. Categorize each hit as **default-on / default-off / url-flag**. Session candidates to start from (route through anim/record fetch): `unifiedMotion`, `getLink`, `placementId`, `entityLights`, `dynLod`, `wieldedSpawn`, `forceDetail`, `forcePom`, `surfaceUnified`, `rigModule`, `skipContainedSpawn`. (Note: `unifiedMotion` + `getLink` go through the *same* anim fetcher → already covered by `a0e0a0c1`; confirm, don't assume.)

**Deliverable:** a table `{ site (file:line) | bake fn | bake resolvers | walk mirrors? | gap detail }`, plus a count of GAPs broken down by **{default-on, default-off, url-flag, always-on}** and ranked by user-visibility.

## Facts + tooling (so nothing is re-derived)

- Resolvers (lib.rs): `try_resolve_cycle_frames` (5356), `try_resolve_link_frames` (5889), `build_concatenated_motion_frames` (6071, the shared anim baker — `continue`s past any anim whose record isn't cached). `try_resolve_idle_anim_frame` is **DEAD** (unused).
- **Rule out "data not served" before blaming a walk:** content-addressed shard filenames are the **TRUNCATED 16-byte sha256 = first 32 hex** — `shards/<2hex>/<first-32-hex-of-sha256(record_bytes)>.bin`, **NOT** the full 64-hex (catalog stores first 16 bytes; resource-http `catalog.rs`). Checking the 64-hex path falsely reads "missing" → a stale-bake rabbit hole (the May-24 portal bake is CORRECT, byte-identical to base dat). Extract a base-dat record: prebuilt `target/release/examples/dump_raw_record <dat> <id_hex>` (added to holtburger-dat; rebuild with `capped-build ~/.cargo/bin/cargo build --release -p holtburger-dat --example dump_raw_record`). Base DATs: `~/ac_base_dats/{client_portal,client_cell_1,client_local_English}.dat`. Live dist: `/mnt/wbterminal2/holtburger-dist`.
- **Live "does this bake return frames" test:** the 1070 Chrome runs with `--remote-debugging-port=9333` (desktop launcher). On the box: `chromium.connectOverCDP("http://127.0.0.1:9333")`, find the holtburger page, then `window.liveScene3d.entityManager.wasmExports.fetchEntityAnimationKeyframes(setupId,[],[],0,[],mtableId,cmd,stance,fromMotion,0)` → `numFrames`. `0` with served data == trap. (Poll for `wasmExports.fetchEntityAnimationKeyframes` to be a function first — it wires a few s after in-world; the access races otherwise.) App reached on the 1070 via reverse tunnel `-R 18765:127.0.0.1:8765`; bridge `ws://100.116.47.66:8080/`; account tailnet1.
- **Wasm rebuild + deploy:** from `apps/holtburger-web`, `capped-build bash -lc 'export PATH=$HOME/.cargo/bin:$PATH; wasm-pack build --target web --out-dir pkg-rebuild --release'` (~4 min incremental; release wasm ≈4.25 MB — a 17.5 MB deployed wasm just means debug-info/no-opt). Back up `pkg`, then `rsync -a --delete pkg-rebuild/ pkg/`. Clear SW + reload to load it. RAM is tight (8 GB) — kill rust-analyzer first (`capped-build` cgroup gates the build). Cross-ref [[reference_oom_protection_stack_2026-06-01]].

## Suggested workflow shape

- **phase Audit** — fan out ~8-10 agents, each owns ~5-8 of the 56 walk sites; each returns `{site, bake, resolvers, mirrors?, gap}` (schema-validated). Read the closure + the `*_inner` it precedes; non-empty closures are the only real candidates.
- **phase FlagAudit** — one agent per flag family (anim / surface / mesh / lights / inventory-spawn); does the flag add an un-walked record-need on a sync-bake path?
- **phase Verify** — for each GAP, adversarially confirm it actually 0-frames (the live CDP bake test or a resolver-vs-walk diff), so the count is real not theoretical.
- **phase Synthesize** — dedup, count GAPs by flag category, rank by visibility, propose the per-site one-line warm fix (mirror the `a0e0a0c1` pattern).

Related memory: `project_animation_root_cause_2026-06-18` (addendum 2026-06-19 has the full root cause + the truncated-sha gotcha).
