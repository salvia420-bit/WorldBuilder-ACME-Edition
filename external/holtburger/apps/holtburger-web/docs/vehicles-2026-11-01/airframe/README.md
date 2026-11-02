# The Hellcat airframe, built from Asheron's Call items (2026-11-02)

The capable client draws the vehicle from the profile's `Parts` + `PartRoles` (HBV1 v2; `scene3d/vehicle/airframe.js`).
The retail stand-in (the Drudge Balloon, Setup 0x020016F1) is what retail clients see; capable clients hide it.

Every part is a retail Setup from `client_portal.dat`, placed in the vehicle frame (x right, y forward, z up; origin =
the ground under the main wheels, level). Uniform scale only (the wire's `VehiclePartDef.Scale`).

| Hellcat part | AC item (wcid → Setup) | Role |
|---|---|---|
| fuselage (5 segments, tapering) | Barrel (72602 → 0x02001888), on its side | static |
| cockpit tub | Bucket (36715 → 0x0200043C), open top: the pilot's head and shoulders clear its rim | static |
| forward fuselage | Barrel | static |
| engine cowling (R-2800) | Keg (72599 → 0x0200188D), steel | static |
| spinner | Round Shield (93 → 0x02000162), dome forward | propeller |
| three-bladed propeller | Spadone (29978 → 0x0200130B) ×3, 20° pitch | propeller |
| wings (inner + outer panels, 7° dihedral outboard) | Tower Shield (95 → 0x02000161) | static |
| wing tips, tailplanes, fin | Kite Shield (91 → 0x02000164) | static |
| (no windscreen) | removed: an open cockpit, the pilot's head over the bucket rim (the blue figure in the 1070 stills is the bench pilot under `@cloak`) | — |
| radio mast | Lightning Spear (47753 → 0x0200054D) | static |
| six wing guns | Composite Crossbow with Handle (7013 → 0x02000874) | static (weapons 0-5) |
| six rocket rails | Wand (2472 → 0x0200017C), purple crystal forward | ordnance (weapons 6-11) |
| 2,000 lb bomb (centreline) | steel Keg + 4 Kite Shield fins | ordnance (weapon 12) |
| 1,000 lb bombs (wings) | steel Keg + 4 Kite Shield fins each | ordnance (weapons 13, 14) |
| main wheels / tail wheel | Round Shield | gear |
| struts | Academy Staff (45548 → 0x0200013D) | gear |

The gear is authored for the taildragger's parked stance: capable clients tip the parked aircraft 11° tail-down about
the main wheels' contact line (the most forward Gear part), so the tail wheel touches the ground and the propeller
clears it (hub 2.57 m when parked). In flight it is level and the gear is up.

Span 11.5 m, length 9.8 m (F6F-5: 13.1 m, 10.2 m). Seat (0, -0.92, 2.18) in the tub; the cockpit eye 1.25 m above it.
Quarrels in flight: Deadly Armor Piercing Quarrel (15440 → 0x0200012A), drawn ×1.8.

## Files
- `hellcat.py` — the generator (`python3 hellcat.py hellcat.json`): part list, roles, weapon muzzles, seat. The C# profile
  (`~/ace-server/.../Vehicles/VehicleProfile.cs HellcatDemo`) carries the same numbers (generated `Part(...)` lines).
- `acmodel.py` — an offline DAT model tool (Setup / GfxObj → triangles with each surface's average texture colour,
  bounding boxes, a flat-shaded z-buffer render): `python3 acmodel.py bbox 0x02001888 …`, `python3 acmodel.py one <dir> <did> …`.
  Reads `~/ac_base_dats/client_portal.dat` read-only through `tools/dat-patch/datlib.py`.
- `preview.py hellcat.json out.png [--pilot]` — iso / side / top / front; `preview_parked.py` — the tail-down stance.
- `hellcat-views.png`, `hellcat-parked.png` — the previews (the red figure is the human Setup at the seat, for scale;
  the seated pose sits lower).

The look in the game (textures, light, the spinning propeller) is an eye-test item (EYETEST.md).

## On the 1070 (2026-11-02, real GPU, `bench/vehicle-look-1070.mjs`)
`1070-parked-above.jpg` (parked, from above: the blue figure in the bucket is the bench pilot under `@cloak`),
`1070-flight-quarter.jpg` (in flight), `1070-cockpit-guns.jpg` (cockpit, the six crossbows firing: quarrel models + streaks).
