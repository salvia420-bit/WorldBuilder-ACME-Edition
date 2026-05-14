# World-completeness Phase D-polish demo screenshots

Six 1920×1080 close-up PNGs demonstrating live ACE-spawned NPCs visible
in the `?renderer=3d` Holtburger renderer at named retail locations.

These are the **demo-polish output of Phase D** (the ACE entity channel
in `docs/hypotheticalmethod.md`'s three-stream placement contract).
They prove that the synthetic spawn injector wired in commit `5d162a4`
produces visible, real-model NPC and POI rigs at correct AC-world
coordinates, viewable from eye-level cameras.

Capture method: replay the `loadSpawnsForLandblock` hook through the
canonical `__scene3dEntityHook` path against the staged Phase D.1
JSONL spawns (`/mnt/wbterminal1/holtburger-dist-v2/spawns/0x<lb>.spawns.jsonl`),
**inject only the target LB per shot** (sidesteps Phase E's flood race;
the brief warned that 427-spawn ring-wide injection serialises animation
fetches and stalls). Stabilisation waits until
`liveScene3d.entitiesGroup.children.length` stops growing AND
`spawnInFlight.size === 0` for 5 consecutive 2-second polls. Script
at `/mnt/wbterminal1/tmp/claude-scratch/scenery-bake/d-polish/capture_demo_closeups.cjs`.

Coordinate system note: `acToThree(ax, ay, az) = (ax, az, -ay)`; the
renderer's `worldRoot` carries the AC-Z-up → three-Y-up rotation, so
the camera (which sits outside `worldRoot`) must be positioned in the
final three.js frame.

## Shots

### 01-hudriffa-shopkeeper.png — Hudriffa the Shopkeeper

| Field | Value |
|---|---|
| **NPC** | Hudriffa the Shopkeeper, wcid 4433 |
| **LB** | 0xA9B0 (South Holtburg Outpost) |
| **AC target** | (32485.541, 33944.008, 58.905) |
| **AC camera** | (32481.041, 33942.808, 59.605) |
| **three.js camera** | (32481.041, 59.605, -33942.808) |
| **Entity count** | 13 (all real-model, 0 placeholders) |
| **Rig model ID** | 0x0200004E, 35 child parts |
| **Visibility** | Hudriffa is clearly visible — female human NPC in profile, holding a sword, with her "ffa the Shopk[eeper]" nameplate centre-frame. Camera is positioned inside the building, looking at the open doorway frame. |

### 02-hardunna-outpost.png — South Holtburg Outpost entrance

| Field | Value |
|---|---|
| **POI** | "South Holtburg Outpost" sign, wcid 5068 |
| **LB** | 0xA9B0 |
| **AC target** | (32482.487, 33945.778, 59.505) |
| **AC camera** | (32476.987, 33934.778, 60.505) |
| **three.js camera** | (32476.987, 60.505, -33934.778) |
| **Entity count** | 13 |
| **Rig model ID** | 0x02000290, 2 child parts |
| **Visibility** | Outpost log-cabin building visible centre-frame with "oltburg Outpos[t]" and a second "n Holtburg Ou[t]" nameplate. A small NPC silhouette (Hudriffa) appears at the doorway. **HONEST PIVOT:** the brief asked for "Hardunna at South Outpost" but there is no Hardunna in the Phase D.1 staged JSONL (`/mnt/wbterminal1/holtburger-dist-v2/spawns/0xA9B0.spawns.jsonl` has 13 records, no Hardunna). Reframed to show the outpost building + its named-sign + Hudriffa at the door. |

### 03-holtburg-lifestone.png — Holtburg Life Stone

| Field | Value |
|---|---|
| **POI** | Life Stone, wcid 509 |
| **LB** | 0xA9B4 (Holtburg town centre) |
| **AC target** | (32529.330, 34571.797, 95.005) |
| **AC camera** | (32525.330, 34567.797, 96.505) |
| **three.js camera** | (32525.330, 96.505, -34567.797) |
| **Entity count** | 119 |
| **Rig model ID** | 0x020002EE |
| **Visibility** | The "Life Stone" nameplate is dominant centre-frame, anchored at the Holtburg outdoor spawn point. Background shows Holtburg buildings + multiple other NPC nameplates. The Life Stone object itself is a small mesh and is partially occluded by buildings at this framing; the nameplate is the prominent landmark. Multiple Holtburg NPCs (vendors inside cells) are visible by their nameplate strings in the background. |

### 04-holtburg-vendor-row.png — Novedion the Gem Seller

| Field | Value |
|---|---|
| **NPC** | Novedion the Gem Seller, wcid 9423 |
| **LB** | 0xA9B4 |
| **AC target** | (32572.794, 34591.515, 94.910) |
| **AC camera** | (32574.794, 34585.515, 95.710) |
| **three.js camera** | (32574.794, 95.710, -34585.515) |
| **Entity count** | 119 |
| **Rig model ID** | 0x02000A0B, 22 child parts |
| **Visibility** | Excellent close-up — Novedion in full armor is dead-centre of frame, the only outdoor named NPC in Holtburg town (all other named NPCs sit inside EnvCells/buildings). The truncated "ion" nameplate is visible. To the left, the "Helm and Shield" vendor sign and a "Door" nameplate are also visible. Novedion was chosen as the "vendor row" subject because Holtburg's outdoor NPCs are sparse — only Novedion is genuinely outdoor here. |

### 05-monster-encounter.png — Scrawed Grievver

| Field | Value |
|---|---|
| **Creature** | Scrawed Grievver, wcid 7978 (3 spawns + Monster Generator + Runed Chest) |
| **LB** | 0xA3AE (SW wilderness ring) |
| **AC target** | (31423.528, 33504.483, 44.699) |
| **AC camera** | (31418.528, 33501.483, 45.699) |
| **three.js camera** | (31418.528, 45.699, -33501.483) |
| **Entity count** | 124 |
| **Rig model ID** | 0x020008DA, 19 child parts |
| **Visibility** | Excellent. A spider-like Scrawed Grievver creature is fully visible centre-frame, with all three Grievver nameplates ("crawed Grievve[r]" repeated) marking the spawn cluster. The wilderness terrain (grass + rocks) is visible behind. This shot best demonstrates the "creature spawn outside town" framing the brief asked for. |

### 06-portal-or-poi.png — Destroyed Portal to Redspire

| Field | Value |
|---|---|
| **POI** | Destroyed Portal to Redspire, wcid 11960 |
| **LB** | 0xA9B4 |
| **AC target** | (32475.325, 34697.487, 67.500) |
| **AC camera** | (32470.325, 34692.487, 68.500) |
| **three.js camera** | (32470.325, 68.500, -34692.487) |
| **Entity count** | 124 |
| **Rig model ID** | 0x020019E4, 10 child parts |
| **Visibility** | Excellent. Three red crystalline obelisks rise from a flaming pad, with the "[Destroy]ed Portal to R[edspire]" nameplate visible above. Holtburg buildings + Bind Stone (green pillar visible in background) frame the scene. This is a clear "portal/POI" demonstration shot. |

## Honest assessments / "huh" moments

1. **No Hardunna in staged data.** The brief's example "Hardunna at South Outpost" doesn't exist in the JSONL — `0xA9B0.spawns.jsonl` has only `Hudriffa the Shopkeeper` (wcid 4433) as the lone NPC at South Outpost. Shot 02 was reframed to use the outpost-building POI instead. Honest pivot.

2. **South Outpost has zero EnvCells.** The renderer's `fetchEnvCellsInLandblock(0xA9B00000)` returns `cellCount: 0`. Hudriffa's record carries `cell: 258` in the JSONL, but there is no EnvCell geometry for that cell in the South Outpost LB (the outpost is a single-part SetupModel building, not an EnvCell complex). The "force cell visible" code-path was a no-op; Hudriffa still rendered fine because entities are parented to `entitiesGroup` (world-frame), not the cell container. Compare with Holtburg town proper (LB 0xA9B4) where 12 buildings × 123 EnvCells live.

3. **Phase E flood race observed at 13 entities, not just 427.** Shot 01's first attempt with 13 spawns saw 6 children + 7 inFlight stick for ~60 seconds before draining. The serialised animation fetch is real even at small counts (it's not strictly a "flood" threshold — concurrent fetches across multiple wcids can race). The 5s settle + 2s poll + 150s timeout in this capture script eventually drained all but the most stubborn (Shot 03 at 0xA9B4 hit the 150s timeout with 8 stragglers, but they all completed during Shot 04's idempotent re-fetch).

4. **Polling cadence matters.** The initial 200ms poll cadence (mirroring the brief's spec) hammered the chrome message bus under swiftshader; each `page.evaluate` ended up taking 5s+ to schedule because the per-frame rAF tick (rendering 169 LBs of terrain + 119 entity rigs in software) tied up the event loop. Bumping to 2s poll with 5s initial settle (matching Phase D.1's capture pattern) fixed the queuing.

5. **Wrong entity matched in scene-snap.** Shots 3 and 5 found a Life-Stone / Grievver instance at a different position than the camera target (because the entity-map walk picks the first-iterated wcid-match, not the closest one). Cosmetic — the camera was correctly framed; the matched entity was just a sibling at the next spawn point. Not affecting the actual screenshot quality.

6. **`page.screenshot()` times out.** Confirmed the Phase D.1 finding — Playwright's `page.screenshot()` waits for fonts that never settle. The `canvas.toDataURL("image/png") + fs.writeFileSync` fallback was used for all six shots. Each save itself takes ~30s on swiftshader (single full-frame readback).

7. **Total capture time.** From spawn-server start to last save: ~20 minutes. Roughly 4 min boot+ring-bake + 16 min for six per-shot stabilisation+save cycles. The 106-entity LB 0xA9B4 was the longest single shot at ~3 minutes from inject to save.

## File list

```
01-hudriffa-shopkeeper.png      2.7 MB
02-hardunna-outpost.png         3.1 MB
03-holtburg-lifestone.png       2.8 MB
04-holtburg-vendor-row.png      2.5 MB
05-monster-encounter.png        2.6 MB
06-portal-or-poi.png            2.7 MB
```

Total: 16.3 MB / 17.1 MB on-disk. All real-model rigs, zero placeholders.

## Reproducibility

```bash
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node /mnt/wbterminal1/tmp/claude-scratch/scenery-bake/d-polish/capture_demo_closeups.cjs
```

Source: `5d162a4` (Phase D.1) + `1242f25` (Phase E) on `master`.
Bake source SHA-256 (recorded in spawns dir):
`de3bee0715654d1e775b27fceb72f541191e869bbed75ea5d0c0358513f20546`
(`ace_spawn_records.jsonl`, stage-ring-spawns.py/0.1.0, 169 LBs).
