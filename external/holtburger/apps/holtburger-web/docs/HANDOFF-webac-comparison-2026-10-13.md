# HANDOFF — WebAC comparison: 151 findings, ~135 items shipped, whole-diff review, gate (2026-10-13)

One session compared WebAC (a TypeScript + three.js browser AC client, AGPL-3.0, read-only mirror at
`/mnt/wbterminal1/ac-refs/webac`) with holtburger-web area by area, using the retail decomp (`~/ac-headers/acclient.c`)
as the authority, then implemented what survived adversarial verification, reviewed the whole diff and ran the gate.
**There was no live/visual testing in this session.** Everything that changes how the world is drawn is either
opt-in (default byte-identical) or a default-on fix to a clearly wrong visual with an `=off` escape; all of them are in
the 1070 eye-test queue in §5.

- Ledger (every finding, verdict, status, notes): `docs/webac-comparison-2026-10-13/FINDINGS.md`
- Evidence (citations, verifier reasoning, implementation reports): `docs/webac-comparison-2026-10-13/findings.json`
- Per-item eye-test notes written by the implementers: `docs/webac-comparison-2026-10-13/eye-tests.md`
- Whole-diff review findings and outcomes: `docs/webac-comparison-2026-10-13/REVIEW.md`
- Flags: `docs/url-flags.md` §"2026-10-13 — WebAC comparison" (every new flag, its default, eye-test and pass criteria)

---

## 1. The owner's prompt (verbatim)

The session goal, set with `/goal`:

> we are working on holtburger-web. we have already worked heavily with the decomp and did a full comparison with openac in the past. now we have webac to compare with. it is vital to not cause detriment to holtburger-web's visuals, only improvements if anything, as it tends to be visually superior to the other projects out there. however we do now want to do a comparison of holtburger-web with webac, which is an interesting project because it operates through a browser. now it is important to set some boundaries here because we don't necessarily desire some of the features they have, we will let them have their own niche so to speak. for example they are compatabile with classic/dark majesty, AC1999 etc, we aren't interested in that. nor are we interested in the GDLE compatiblity. so we are sticking with our EoR ace. as for their stack and our stack, we arent necessarily interested in a complete overhaul of our stack unless it is merited, and check with me in that case. we are looking for efficiencies, code optimizations, bug fixes, unthought insights, etc, across a broad spectrum of categories. and there may be visual bugs in holtburger-web, or visual upgrades possible, which we shall entertain. its important to note that we have just done a lot of work on rynthsuite (virinditank) which can break easily with the nature of these changes so that code should be maintained throughout this process. the goal is met when we have completed this process.

Later in the session:

> so for my understanding, we aren't "overwriting" holtburger with these changes, rather just improving it based on our analysis of webac right?

> for the eyetests and everything else beyond the series of work you are doing currently, make a handoff, commit and push to origin/master after you are finished

> and that will count as completion of the goal

## 2. How it was run

1. **Compare → verify (read-only workflows).** 25 areas (render perf, lighting/materials, terrain/scenery, sky/fog/time,
   particles/scripts, cells/portals, streaming/residency, physics/collision, motion/remote, models/camera, app loop,
   transport, messages/objects, audio, examine text, HUD, chat/errors, combat/magic, inventory/session, two RynthSuite
   areas, DAT parsers, input/options, maps/chargen/barber, test tooling). One comparer per area (WebAC vs holtburger
   vs acclient.c/ACE, duplicate check against the OpenAC ledgers, PARITY-STATUS and git log), then one adversarial
   verifier per area. **151 findings: 108 confirmed, 37 partial, 5 duplicate, 1 refuted.** Out of scope by the owner's
   boundaries and skipped throughout: AC1999/classic/Dark Majesty/era variants and GDLE.
2. **Implement in file-disjoint lanes** (4 waves, ~135 items, one agent per item, targeted node tests only; Rust
   written blind and compiled by the orchestrator under `capped-build`, one heavy job at a time).
3. **Whole-diff review**: one reviewer per lane (18 lanes) + skeptic verification; 47 review findings, 43 fixed, the
   other 4 were the modulepreload regeneration done by the orchestrator (`REVIEW.md`). The review caught, among others:
   a spell-bar data-loss path (a stale combat-bar save would have sent RemoveSpellFavorite for every server favourite),
   an HTML-injection path (server boot reason into innerHTML), a dropped parked combat-mode toggle (Proxy identity), a
   buff-tier mis-confirm, and several existing tests broken by intended changes (re-pinned only where they pinned a bug,
   listed in §8).
4. **Gate once at the end** (§7), release wasm built.

**Stack:** no stack change was merited or made. WebAC's TS/Vite/vitest stack solves problems holtburger's
JS + Rust/wasm split already solves (often better — e.g. statics batching, light-count stability, asyncLink guard);
the useful WebAC ideas were ported as small, decomp-checked changes inside the existing architecture. Code taken
substantively from WebAC carries an AGPL attribution comment (both projects are AGPL-3.0).

**RynthSuite:** rynth/** was touched only by the dedicated RynthSuite lane (bug fixes + default-off features) and
three narrow fixes (webhost selectionChanged `.detail`, shared modules kept byte-identical for rynth windows, kind=48
payload shape kept). After every rynth change `tests/rynth_vt_parity.test.mjs` (T-P1) and the buff GOLDEN digest stayed
identical; no existing rynth test was edited.

## 3. What shipped (themes; full list in FINDINGS.md)

| Theme | Highlights | Default |
|---|---|---|
| **Scenery placement (retail)** | `holtburger-scenery-bake` gains `BakeMode::Retail` (acclient.c `CLandBlock::get_land_scenes`): per-object frequency gate `cellMat*(23399+j)`, 4-corner 5 m road band, strict `<192`, building-origin cell, walkable-triangle slope check, `obj_within_block`, no box rejections, retail `Frame::set_heading` orientation, `2^-32` noise scale. The shipped dist is ACE's dead `Scenery.cs` port (ace-compat) — re-bake proven byte-identical to the shipped files. This likely explains the owner's COL-29 report ("rocks in paths … trees not exactly where they should be around holtburg"). A full-world Retail bake (65,025 LBs, 3.79 M placements, +17.9% in the Holtburg ring) is served for an A/B. | **opt-in** `?sceneryBake=retail` |
| **Transport / bridge** | Multi-fragment C2S send (messages > 448 B were silently dropped: long book pages, long-name chargen); RejectRetransmit no longer stalls ordering; ConnectResponse resend + same-cookie guard; retail link-status packet loss + RTT pairing; bridge sends ACE a Disconnect on WS close (no 60 s relogin block) and gains admission control (loopback target allowlist, origin check, caps). | on (bridge needs rebuild + restart, §6) |
| **Inventory / session** | Retail pending-request text for failed item moves; UpdateObject pack ordering; auto-wield legality; 3D drop on a vendor sells (was a give); AccountBoot reason shown (escaped); `@corpse`; per-character hotbar; Log Off button; slumlord 9 m close; spell bars + spellbook filter saved to the server per character. | on, escapes |
| **HUD / examine / chat** | Wield requirements, buff labels, workmanship/bonded/attuned, EoR weapon/caster/armor/set/ratings/properties lines, player examine misc, Character Information tab; retail icon composite in vendor/trade/salvage/tinker/house/buffs; house panel 30/90-day period; trade pack contents; spell-bar endowment cell; full generated retail failure-text table; silent codes silent; ranged-speech range; buff expiry lines; `/age` `/birth`; popup dialog; spew-box stack; retail combat hit lines; portal-storm notices; barber (was a dead end that ate the MMD note); chargen error texts, attribute lock/auto-balance, colour wheel with gear-valid keys. | on, escapes |
| **Input** | HUD widgets no longer re-fire on Space/Enter; Ctrl/Alt quickslots; context menu suppression; live Options rows; global LockUI; selection actions (Previous/Self/Last Attacker/cycles); movement keys by physical code (AZERTY/QWERTZ); follow-drag blur; hidden-tab movement pump; Escape action; combat-mode park; retail UI sounds + Options sound prefs. Emote keys: Rust emote hash complete, keys **opt-in** (§9: the send path drops non-locomotion motions). | on / emote opt-in |
| **Render perf (invisible)** | Program retention (no relinks; one lit-shader link was measured at 2.9 s on the 1070), static LOD duplicate-geometry collapse, dynLod memo (no per-entity re-parse twice a second), particle slot carriers (proven identical render), sky wrapper frees, decode-miss / negative-cache fixes, SW content verification + reload healing, shard budget mechanism (default unbounded). | on, escapes |
| **Visual bug fixes (default on, eye-test queued)** | Fading clip-map parts fade instead of vanishing; authored blend restored after fades; luminous clones keep the night scale; luminous surfaces keep their own glow; hook ramps no longer wash textures white; additive objects not fogged; first-person fade covers held items / survives re-dress; particles no longer flash one frame at the origin; PhysicsDesc default script not played at spawn (retail: hooks/collision only — Setup default scripts like portals/lifestones untouched); single retail light tick reset on Always Daylight; AdminEnvirons fog table/fade. | on, `=off` escapes |
| **Visual candidates (opt-in)** | `stormScan=retail` (every DayGroup currently reads as a storm), `radialFog`, `retailDegrade`, `envDetailTex`, `selectionFlash`, `defaultScriptPartChild`, `particleCellGate`, `rigCellGate`, `indoorLandscapeGate`, `portalFovFade`, `retailFov`, `negFace=retail`, `missileImpactScript`, `combatFxBus`, `surfaceAnim`. | **off** |
| **Remote motion / physics** | Remote root motion scaled by object scale (~45% of creatures rubber-banded); remote rest heading adopted (likely the vendor snaps); ConstraintManager leash; local player body from its Setup; missiles collide with creatures/scenery and stop at the true terrain crossing. | on, escapes |
| **Tooling** | Machine-wide heavy-job lock + free-memory gate + child heap cap (the one-heavy-job rule is now mechanical); event-consumer lint (found 5 dead bus handlers); suite-hygiene ratchet; link-probe program ledger; perf-history ratchet + ci-smoke dev-wasm detection; CI runs protocol integration tests; wire-integrity counters; pcap decode counters + opt-in bridge capture. | — |
| **RynthSuite** | Loot loop handles ACE corpse-permission refusals; vitals valve judges by restored points (no healing park under damage); buff tier lock fixed (own-row confirm); skill-based tier cap (default off, wired); LF-only `.met`; comma `.utl`; `.af` EmbedNav transforms; VTank `.usd` import (new profile only); selectionChanged `.detail`; portal avoidance + indoor doorways (default off). | Default profile byte-identical |

## 4. Flag policy

- `=off` escape (default **ON**): behaviour/HUD fixes and fixes to clearly wrong visuals.
- exact `=on` / named value (default **OFF**): render changes and new looks; the default path is byte-identical.
- Every flag has a row in `docs/url-flags.md` §2026-10-13; `lint-url-flags --strict` reports 0 undocumented readers and
  `audit-flag-defaults` 0 polarity mismatches.

## 5. 1070 eye-test queue (batched, off-screen, `?nosw=1`, fresh profile per arm)

Run after a fresh page load on the release pkg. Detailed per-item checks are in `eye-tests.md` and the url-flags rows.

**A. Default-ON changes — confirm no regression (A/B each with its `=off`):**
1. Fades: portal in/out, ethereal, first-person zoom — clip-map parts (hair, leaves) fade with the body; nothing turns
   opaque after toggling first person (`fadeAlphaParity`). Held weapon/torch fades in first person and stays faded
   after re-equipping (`camFadeHier`).
2. Luminous/glow: night glow on per-entity clones (`lumCloneAdopt`); luminous surfaces keep their glow under hook
   ramps (`surfaceLumWins`); hook-ramped textured surfaces are fullbright texels, not flat white (`lumHookTexel`);
   additive glows not greyed by fog (`additiveObjFog`).
3. Spawns: breath creatures (Olthoi Soldier, Rynthid Minion…) and Create/Breathe weapons no longer puff on appear;
   portals, lifestones, chimneys and other Setup scripts unchanged (`defaultScriptAtSpawn=on` restores old).
4. Particles: no one-frame flash at the world origin when emitters start (`particleInitFrameAce=on` restores old);
   instanced particles look identical (`particleSlotCarrier=off`).
5. Sky: toggle Always Daylight at night — ground and sky relight together (`lightTickReset`).
6. Static LODs look the same at 10/25/60 m (`lodCollapseDup`); no new hitches on first turn (`programRetain`).
7. Icons in vendor/trade/salvage/tinker/house/buffs show the retail background/overlay composite (`iconBlitRetail`).
8. Remote creatures: scaled creatures (giants, small critters) no longer rubber-band; vendors used from four sides
   keep facing (`remoteRestHeading`); a remote whose updates stop does not run forever (`remoteLeash`).
9. Missiles: bolts/arrows hit creatures and stop at trees, rocks and hills (`missileObjSweep`, `projectileScenerySweep`,
   `projectileTerrainCrossing`); watch for false stops when casting next to scenery.
10. Audio: no UI error buzz/slider sounds, chime on press (`retailUiSounds`); portal-space drone audible (`portalDrone`).

**B. Opt-in candidates — the owner decides whether to flip:**
1. **Scenery**: Holtburg, its outpost, the roads out of town, a forest, a hillside with `&sceneryBake=retail` vs
   without. Expect no rocks/trees on roads, none on steep slopes, denser forests, different facings; check fps of the
   +18% instances and that nothing clips buildings (1,963 retail placements touch a building box world-wide, listed in
   `/mnt/wbterminal2/hb-scenery-ab-2026-10-13/retail-full-v2/retail-building-overlaps.jsonl`).
2. **Weather**: `&stormScan=retail` — today every DayGroup is classified as a storm (the always-visible moon setup has a
   PES); retail weather is rarer, so clouds/wetness/pollen/fireflies change. The owner tuned cloud looks under today's
   behaviour, so judge carefully.
3. Fog/LOD/FOV/detail: `radialFog`, `retailDegrade`, `retailFov` (+ Field of View slider), `envDetailTex`.
4. Feedback/effects: `selectionFlash`, `defaultScriptPartChild` (weapon swing effects), `missileImpactScript`,
   `combatFxBus` (**carnage + blood decals have never fired from real combat** — a handler bug; this flag makes them
   fire: limb severs, finishers, splatter decals), `negFace=retail`, `surfaceAnim=on` (old 4 Hz detail-pair cycling).
5. Indoor/portal: `rigCellGate`, `indoorLandscapeGate`, `particleCellGate`, `portalFovFade`.
6. Other: `aceObjMaint` (ghost-entity removal; needs a live combat soak), `emoteKeys` (blocked, §9), `wavePrefetch`
   (cold-boot A/B), `audioRetailPan`, `indoorDoorways` + `botPortalAvoid` (RynthSuite egress runs).

**C. Behaviour checks (live ACE):** save a ~900-character book page and reopen it; create a character with a 50-char
account + long name; relog right after closing a tab (after the bridge restart); spell bars on two characters and on
another browser; hotbar per character; LockUI from radar, Options and `/lockui`; Ctrl+1..9 in magic stance, Alt+1..9;
`'`/`P`/`Home` selection keys; right-drag release over HUD (no browser menu); Space after clicking a hotbar potion;
barber via `@barbershop`; chargen colours/shades and attribute lock; house panel as owner; drop an item on a vendor;
Log Off button; wrong-password login (boot text); `/age`, `/birth`, `@corpse`; first-login welcome popup; buff expiry
lines; a long fight with RynthSuite (loot refusals, heals under damage, buff tiers).

## 6. Ops notes

- **wasm**: release pkg rebuilt (7.54 MB); previous pkg kept at `apps/holtburger-web/pkg-prev-20261013/`. Every checkout
  needs a release wasm build — pkg/ is gitignored.
- **Bridge** (not restarted — would drop live sessions): `cargo build --release -p holtburger-wsbridge` (under
  `capped-build`), then `kill <pid of target/release/holtburger-wsbridge>`; `scripts/wsbridge-supervise.sh` relaunches
  it in 5 s. New defaults: targets 127.0.0.1/localhost/::1 ports 9000/9001, missing Origin and same-origin allowed
  (covers the tunnel); `--allow-target`, `--allow-any-target`, `--allow-origin`, `--max-conns`, `--max-conns-per-ip`.
- **Scenery A/B**: `~/hb-serve/dist/holtburger-dist-hires-bc7m-xu7t2/scenery-retail` is a symlink to
  `/mnt/wbterminal2/hb-scenery-ab-2026-10-13/retail-full-v2` (HDD; first fetches may seek). Remove the symlink to retire
  the A/B. Re-bake: `target/release/scenery-bake --dat-dir ~/ac_base_dats --landblocks 0x0000..0xFFFF --out <dir>
  --mode retail` (85 s, 52 MB RSS). Promoting Retail to default also needs: dist swap via `scripts/dist_ssd.py stage
  --activate`, pack_bake regeneration, rynthnav GeomExtract nav geometry, gate1's scenery leg re-pointed.
- **Service worker** changed (content-addressed verification): use `?nosw=1` + reload when testing.
- `plugins/index.json` regenerated (barber-panel); modulepreload regenerated (423 modules); `harness/test_build_shell.mjs`
  NON_APP_PRELOADS 376 → 402.
- The heavy-job lock (`harness/lib/heavy_lock.mjs`) now guards run-js-headless, cargo-tests, moving-bench, perf-walk,
  lib/boot and the 8 `test_*_gpu.cjs` runners (a 2-line preamble was added to those runners). Plain `node test.mjs`
  never takes it. Optional: a re-entrant `flock` in `/usr/local/bin/capped-build` (snippet in the test-tooling-2 report).

## 7. Gate

All run once, alone, under `capped-build` (and the new heavy-job lock), after the last fix:
- **JS gate** (`node harness/run-js-headless.mjs`): **695 passed / 0 failed** of 695 (563 before this session + 132 new
  suites). NEEDS-TOOLCHAIN (5) and NEEDS-BROWSER (9) suites are listed, not run, as before.
- **RynthSuite node suite** (`node rynth_test_all_node.cjs`): **68 passed / 0 failed / 32 skipped** — identical to the
  pre-session baseline. `tests/rynth_vt_parity.test.mjs` (T-P1) passes and the buff GOLDEN digest is unchanged.
- **Rust** (`cargo test --lib`, per crate, capped): common 73, content 7, core 657 (+1 ignored), dat 723 (+2 ignored),
  protocol 421 + generated_parity 72/72 + opcode_parity 2 (+1 ignored), resource-http 45, session 70 (was 43),
  holtburger-web 489 (+6 ignored; was 304), world 1085 (was 876), wsbridge 63 (was 24), tools 78 + bins,
  scenery-bake 66 + 7 integration suites. `#[test]` counts only grew versus HEAD in every crate.
- **wasm32** `cargo check -p holtburger-web --target wasm32-unknown-unknown`: clean (the same 17 warnings as before).
- **Release wasm**: built 2026-10-13 15:22, 7.54 MB; new exports present (barberInit/finishBarber, addSpellFavorite,
  playerSpellBars, queryAge, fetchRegionDetailSurfaces, wire_integrity_json, takePortalDoorways, entity_degrade_chain_id …).
- **Lints**: `lint-url-flags --strict` 0 undocumented (990 documented); `audit-flag-defaults` 0 polarity mismatches;
  `lint-event-consumers` 0 findings; `gen-client-event-kinds --check` up to date (58); `gen-modulepreload --check` up to
  date (423); `plugins/gen-index.mjs --check` up to date (51).
- **Scenery bake**: ace-compat re-bake byte-identical to the shipped `dist/scenery/` on a 25-LB Holtburg block (twice:
  before and after the 2^-32 fix); Retail full-world bake 65,025 LBs in 85 s.
- Not run: `cargo fmt --check` (rustfmt on lib.rs needs ~4 GB), the browser smokes, and any live session.

## 8. Existing tests edited (each pinned a bug this session fixed; orchestrator-authorised, none are rynth tests)

- `tests/commerce_logic.test.mjs:229-231`, `tests/commerce_windows_smoke.test.mjs:741` — pinned the 7-day house period.
- `tests/buffs_hud.test.cjs:186-191` — statKey 14 is Arcane Lore, not Run (now 24 → Run).
- `test_f7_8_surface_bitfield.mjs` (one line) — the legacy-fog check now runs under `?additiveObjFog=off`.
- `tests/additive_fog.test.mjs` F5 — asserts fog on the rendered instanced material (render proven identical, 18-case A/B).
- Rust: two `iteration.rs` tests pinned an invented layout; two `holtburger-session` tests pinned the >448 B drop.
- `harness/source-pin-baseline.json`: 8 new Rust-source pin suites accepted as reviewed exceptions.
- The 8 `test_*_gpu.cjs` browser runners got the heavy-lock preamble (no assertion changed).
- `tests/plugin_loader.test.cjs` — the bundled-plugin count pin 50 → 51 (barber-panel added; the pin is bumped with a dated note for every plugin, as for server-confirm and rynth-hud).
- `harness/test_build_shell.mjs` — NON_APP_PRELOADS 376 → 402 (26 new statically imported modules; dated comment).

## 9. Owner decisions and deferred work

**Decisions for the owner:**
1. Flip `sceneryBake=retail` to the default (then the dist/pack/nav steps in §6).
2. Flip `stormScan=retail`.
3. Enable `combatFxBus` (carnage + blood decals actually firing).
4. RynthSuite: `.utl` SalvageCombine length/value-mode fix needs `tests/rynth_vt_formats_utl.test.mjs:355/:364` amended
   (rynth-formats-expr-3); expression number text RynthAi vs VTank 15-digit G (rynth-formats-expr-7, edits
   `tests/rynth_vt_expr.test.mjs:194`); the "VTank defaults" preset values (relabelled only, rynth-formats-expr-6).
5. Retype retail Magic-type failure lines into the Magic category (rynth's AI CHAT_KEEP drops category 7).
6. Silence every non-retail ACE failure code (reverses the round-2 decision to keep them visible).
7. Whether the invisible first-person body should still cast its shadow.
8. A default shard-cache budget (needs an ABAB on the six-town route).
9. Restart the bridge (§6).

**Deferred / future work** (details in FINDINGS.md notes and follow-ups):
- Emote keys: the movement send path drops non-locomotion DoMotion (`system.rs` apply_axis / RawState serialisation);
  fix it, then flip `?emoteKeys` default-on (ACE grants regen for Crouch/Sit/Sleep).
- 3D chargen preview (gmCG3DView) and a dungeon map (UtilityBelt feature) — large features.
- lighting-materials-8 (Setup light key census), render-perf-2 phase B, streaming-residency-5 (h2 concurrency ABAB),
  spellcast-5 personalised formulas (golden vectors from the live ACE console), hud-ui-6(b) retail off-screen arrow
  art, examine-text-6 phases 2-3, audio-2(d) click-selector narrowing, test-tooling-4 replay corpus (needs a live
  capture through the bridge's `--capture`), the census tests (`#[ignore]`) for cells-portals-6/7 and models-camera-3
  to be run once, RynthSuite follow-ups (loot done-set / LootOwnership, same-name corpse refusal).

## 10. Resume prompt

```
/goal Continue the WebAC-comparison follow-ups from apps/holtburger-web/docs/HANDOFF-webac-comparison-2026-10-13.md
(read it, then FINDINGS.md and REVIEW.md in docs/webac-comparison-2026-10-13/). First run the §5 1070 eye-test batch
off-screen (owner-authorised capture run, watch1070 presence gate, ?nosw=1, fresh profile per arm) and record
pass/fail per flag in the handoff; flip only what the owner approves. Then take the §9 deferred items in order (emote
send path first), each verified against acclient.c, with RynthSuite parity (tests/rynth_vt_parity.test.mjs) unchanged
and existing tests unedited. Follow ~/CLAUDE.md resource rules (one heavy job at a time, capped-build, agents run
targeted tests only); finish with one full gate, a release wasm build, an updated handoff, commit and push.
```
