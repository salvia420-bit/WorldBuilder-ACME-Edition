# HANDOFF — end of 2026-07-28 session

Everything below is committed and pushed through `30dc2fea` (`origin/master`).
Working tree clean. No agents, rigs, or test browsers left running. Every item
has a full ledger entry in VERIFICATION-LOG.md (this file is the map, not the
territory). Orchestration: one main loop + 15 Opus/Fable agents across the day,
each read-verified and integrated individually.

## ⚠ FIRST OPEN ITEM — mobile resolution churn, reported at close of session

The user logged into the client ON MOBILE after `d9a4fd63` landed and the
resolution-switching regression WAS ACTIVE there. Sharpened symptom: the BOX
(the canvas/element itself, not just backing-store resolution) literally
shrinks to a certain resolution and keeps doing it — every few seconds, or
MULTIPLE TIMES A SECOND. That cadence is faster than adaptiveRes's ~3 s
`setPixelRatio` steps and "the box shrinks" is element-size, not pixel-ratio —
so this is likely a DIFFERENT (or additional) mechanism on mobile than the
desktop State A that agent O fixed: candidates are the visualViewport/URL-bar
dance, a dpr-fractional element-resize feedback loop (refuted on EMULATED
desktop, but mobile viewports are dynamic), or `adaptiveResSettle`
floor-hunting on a weak GPU. First steps: confirm the mobile session actually
carried `d9a4fd63` (nosw reload), then capture a resize timeline on the real
device (`__diag.bootInput()` exists; may need a mobile-friendly capture
surface). Filed as an open task.

## LANDED TODAY (14 fix/feat commits + ledgers; chronological)

Movement/physics:
- `f5b2eabe` — COL-17 + COL-16 + isOnGround flicker were ONE bug (terrain
  contact planes stored landblock-local, consumed world-frame). 3 flags
  default-ON. Tier 3 closed client-side.
- `592fcdf2` — COL-10 anim half (dual local-rig dispatchers; backstep gait
  −1.199 → −0.779).
- `0f9e08f0` — meeting-hall stairs: envcell statics now collide from every
  cell they REACH (cross-cell overlap bake; world-wide fix). `f5b2eabe`
  exonerated by bisection.
- `26b66fc5` — combat standoffs radius-aware (CPartArray::GetRadius = raw
  CSetup.radius × scale; player real radius 0.6788 not 0.4; TWO dead paths
  repaired — setup cache never staged on live path, `Entity::gfx_id` never
  assigned). Tusker standoff 2.388 measured vs 2.387 predicted.
- `3b22938d` — creature separation, remote half: dead-reckon extrapolation was
  an ACCUMULATOR + hardcoded 1.3 standoff; ACE exonerated (wire 1.318 m vs
  rendered 0.300 m). Retail contact envelope; blocking radius (primitive,
  1.476) vs standoff radius (setup, 2.388) DISTINCT.

Rendering/UI:
- `b79a59b2` — camera coarse-AABB over-clip on rotated buildings, default OFF.
- `3f50e896` — interior lamps dark: RND-04 bake shader never reached the GPU
  (missing program-cache key bit); second missing bit (`__staticBiased`) fixed
  since 2026-07-06; dead guard test revived.
- `4693258e` — four HUD defects from the design-card audit (hotbar row-2
  overflow, buffs display:contents, target-bar name squeeze, radar badge).
- `48236510` — particle billboarding: "retail does NOT billboard" claim
  REFUTED; per-GfxObj degrade_mode facing (mode 2 full billboard, 3/4/5 axis
  constrained). Waterfall sheets/golem spray fixed. JS-only.
- `837145fc` + `cc5e3f92` — terrain_batch slot leak (warm-park ghosts held all
  256 slots) + the park storm (geom-pressure feed parks from a trigger park
  cannot relieve; bounded 8/tick, backlog gate, resident floor, hysteresis).
  Sealed-dungeon purge (the literal 32→1) exonerated as intentional. purgeKey
  handoff item closed as repro artifact.
- `d9a4fd63` — 4K login bistability: dead keybinds = unguarded poll_events
  drain + WASD gate 300 lines late (evtGuard, per-event isolation); resolution
  churn = adaptiveRes oscillation (settle latch). The anticorrelation is
  CAUSAL (dead keys → static frame times → no churn). NOTE: desktop fix; see
  the mobile item above.
- `83fbc9cb` — unified input funnel: ONE capture listener → keymap →
  registered actions behind ONE gate; shared fate PROVEN by poison/unpoison.
  Delete-dead root cause: Delete has NO binding outside magic stance (designed
  no-op, not breakage); double-dispatch + silent-swallow fixed.

Vitals orbs (the day's feature arc):
- `6bf82b16` v1 (accepted "Empyrean Relief" concept live, opt-in
  `?vitalsOrbs=on`) → `551f0b35` v2: three independent transparent draggable
  panes, hit-area follows the art (34% of rect clickable, 66% passes through),
  numerals stroke-treated, −41% render pipeline (trace-verified; the SVG-data-
  URL-is-not-a-bake trap recorded). USER VERDICT: "vitalsOrbs=on looks great."
  Default flip NOT yet decided.

## CLAUDE DESIGN (claude.ai/design project "Holtburger HUD", id 298d1bbd-a354-4a33-9b30-1c99633a3140)

Groups: Tokens (32 `--hb-*`), HUD (7 component cards incl. old bars), Retail
reference (WBT ui-layout-render of gmFloatyVitalsUI), Concepts (3 orb cards;
B revised twice per user direction — real DAT model sprites: Asheron
0x020009C8, Bael'Zharon statue 0x0200166A yaw 325 SE, slithis 0x02001855,
Atlan Sword 0x02000726, Composite Bow 0x02000878, Weeping Wand 0x02000F1C).
DRIFT: the live orbs v2 is ahead of the concept card — an "as shipped" card
push was offered, not yet done. Sync loop: user edits in pane → orchestrator
pulls via DesignSync get_file → patches plugin. Card generator + sprite
pipeline (OBJ software rasterizer): session scratchpad `build_cards.py`
(EPHEMERAL — regenerate from plugins if lost).

## OPEN QUEUE (priority order)

1. **Mobile resolution churn** (top of file) — user-visible, live.
2. **"Attack Selected Target" action** — USER DECISION PENDING: no Attack
   keybinding exists anywhere (attacking is mouse-driven); user wants
   Delete=attack; small follow-on on the new `client.input.bindAction`
   registry.
3. **Rust remote sticky lane radius-blind** (agent N residual) — JS envelope
   corrects the outcome; thread real radii in Rust. ⚠ blocking vs standoff
   radii are DIFFERENT quantities (primitive vs CSetup) — don't conflate.
4. **`entity_physics_bsp` reads dead `gfx_id`** (agent L residual) — the
   COL-03 entity-BSP door arm has likely NEVER engaged live; re-validate the
   ±0.45 m off-axis door block after fixing via `entity_setup_did`.
5. **Design sync-back**: push the "orbs as shipped" card; decide vitalsOrbs
   default flip after more play.
6. Tier-2 leftovers: stars/skyObjReplace (scoped — driving field is
   `transparent` NOT the design doc's `luminosity`); RND-05/03 live probe
   (`probeL.cjs` ready, venue expectations: dungeon dynamics-only BY DESIGN).
7. Scenery BSP rung (0.5% placements, blocked on CellPhysicsBsp.scale).
8. P6.1 v1.1 tail (raw-handle plugin migration; server half of 0x02AE
   conflicts keep-ACE-vanilla).
9. Stale-test debt: `test_a14_i3_run_keys.mjs` 5 stale retailRunKeys
   baseline failures (pre-existing, noted by agent P).

## ENVIRONMENT FACTS (save re-derivation)

- Remote play rig: cloudflared quick tunnels — http
  `particular-constitutional-image-include.trycloudflare.com` → :8765,
  ws `volunteers-gonna-query-rogers.trycloudflare.com` → :8080 (wsbridge).
  QUICK tunnels: URLs die with the processes; mint new ones next session and
  re-issue the play URL (index.html + `bridge_url=wss://…` + autoLogin +
  weather-off flags). 1070 was OFFLINE all day; user vistested on their R9 290
  and later mobile. User plays account `phase4demo` (+WasmDemou8wvi3, PK'd via
  `@pk pk`); `tailnet1` also theirs. Agents must use throwaway accounts (ACE
  auto-creates on first login).
- pkg/ holds a RELEASE wasm (~4.99 MB, through `3b22938d`). Multiple `pkg-X/`
  scratch out-dirs are gitignored leftovers; safe to delete.
- Box thrash DID kill the user's session once (earlyoom at SIGKILL limits
  during an unthrottled agent build) → standing agent rules: flock
  `/tmp/claude-1000/wasm-build.lock`, `CARGO_BUILD_JOBS=2`, ONE chromium,
  close browsers before builds.
- MEASUREMENT TRAPS confirmed today: `?nullRender=1` blinds the geom governor
  (liveGeom 0 — residency work needs real render); chromium
  `--virtual-time-budget` can't verify rAF anims; SVG-data-URL "bakes" replay
  as PaintRecords (bake = vector→canvas→PNG); LSD setupDid values are DECIMAL;
  `*/` inside CSS comments; sessions booting `recoveries > 0` are unreliable
  ~60 s; `__bootStateHistory` entries are objects; same-account relog < 60 s
  stalls the handshake; per-60Hz-normalized perf metrics penalize
  faster-rendering arms (use ms per RENDERED frame).
- Agent reports live in the SESSION scratchpad (`agentA..P-report.md`) —
  ephemeral; all durable findings are in VERIFICATION-LOG.md.
- Design access: user authorized via /design-login this session.

## METHOD NOTES RE-PROVEN

- The diagnostic FORK before the fix (wire vs rendered; flag-bisect before
  commit-bisect) paid off three times — ACE was exonerated twice, f5b2eabe
  once, each time redirecting the fix to the real site.
- Unconditional reachability counters caught THREE dead paths today (setup
  cache, gfx_id, entity-BSP arm suspicion) — "flag off" and "dead code" are
  indistinguishable without them. Now house style.
- Fault injection as acceptance (evtGuard, input funnel poison/unpoison) is
  the right bar for "shared fate" claims.
- Agent citations still ~1/3 wrong (4 of 8 anchors in one brief); every
  landing was read-verified against its own claims before integration.
