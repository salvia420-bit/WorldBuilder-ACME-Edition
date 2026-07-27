# Mining the acclient deep dives → holtburger-web work plan

Goal, in the user's words: an end product such that *"I can truly say that I
fully mined out those two 7zip files for everything they can offer in regards to
improvements for holtburger-web."*

The test of "fully mined" is the **coverage ledger** in each findings file: every
H2 section, and every H3 making a distinct claim, of every source document is
dispositioned. Nothing is allowed to be silently skipped. This file tracks that
coverage across the whole corpus.

## Where the source documents live

The two deep-dive packs this analysis mines are **not tracked in this repo** —
`.gitignore:630` ignores `external/*` (only `external/holtburger/` is excepted),
and they are third-party reference material. On this machine they are at:

```
external/acclient-deep-dives/2013-09-11.4186-v3/   (12 chapters + INDEX.md, class/func/struct indices)
external/acclient-deep-dives/2015-10-11.6096-v3/   (memory-leak-2015 + client-differences)
external/ac-eor-palette-leak-fix/                  (github.com/eriknihlen/ac-eor-palette-leak-fix)
```

Citations of the form `external/acclient-deep-dives/…` in these findings resolve
against that untracked working copy. The analysis files here are self-contained
enough to act on without them: each task inlines the retail constants and
algorithms it depends on.

## Source corpus

Downloaded 2026-07-26 and extracted to `external/acclient-deep-dives/2013-09-11.4186-v3/` and
`external/acclient-deep-dives/2015-10-11.6096-v3/`. Both packs are Hex-Rays decompilations made **with the
original Turbine PDB present**, so class and function names are the real internal
names. All findings in them went through three passes including an adversarial
one; the reports name their own earlier errors where a draft was wrong.

The 2013 pack describes the 2015 client too: of 11,127 functions, **11,081 are
byte-for-byte identical** between 11.4186 and 11.6096 (99.59%); only 46 changed.

## Document coverage

| Source document | Subsystem | Mined by | Status |
|---|---|---|---|
| `00-architecture.md` | Tie-together: main loop, two-object model, ordering layers, authority boundary, trap list | wave3-F | running |
| `01-physics.md` | Physics, collision, movement, animation, world geometry | wave1-A | done |
| `02-networking.md` | UDP transport, protocol, dispatch, DDD, login, chat | wave1-B | done |
| `03-object-model.md` | Objects, properties, inventory, appearance, social | wave1-A | done |
| `04-combat-magic.md` | Attacks, stances, enchantments, spells, skills | wave1-B | done |
| `05-ui.md` | UI framework, windows, input, keybinding, camera, radar | wave3-E | running |
| `06-rendering.md` | Graphics pipeline, terrain, portals, sky, textures | wave2-C | done |
| `07-dat-resources.md` | DAT container, BTree, async cache, resource formats | wave2-D | done |
| `08-client-core.md` | Startup, main loop, commands, plugin API, infrastructure | wave3-E | running |
| `09-audio.md` | DirectSound backend, sound tables, ambient beds | wave2-C | done |
| `10-crypto-obfuscation.md` | All encryption, obfuscation, hashes, PRNG, checksums | wave2-D | done |
| `11-memory-leak-investigation.md` | Three confirmed leaks (2013 addresses) | wave3-G | running |
| `12-memory-leak-2015.md` | Same three leaks, 11.6096 addresses + patch mechanics | wave3-G | running |
| `13-client-differences-2013-vs-2015.md` | All 46 changed functions, address translation, the +3 command shift | wave3-F | running |
| `INDEX.md`, `class_index.tsv`, `func_index.tsv`, `struct_index.txt` | Queryable index over a 938,010-line decompilation | wave3-G (job 2) | running |
| both `README.md` files | Decompiler traps, source provenance, caveats | context for all agents | done |

Nothing in either archive is unassigned.

## Findings files

| File | Scope | Tasks |
|---|---|---|
| `wave0-palette-leak-patch.md` | The externally-referenced `Palette::makeModifiedPalette` refcount leak, the adopted 6-byte patch, and holtburger's analogue | PAL-01..04 (PAL-04 since closed by wave2-D) |
| `wave1-A-physics-objectmodel.md` | 01 + 03 | 66 (PHY, OBJ) |
| `wave1-B-networking-combat.md` | 02 + 04 | 52 (NET, CMB) |
| `wave2-C-rendering-audio.md` | 06 + 09 | 48 (RND, AUD) |
| `wave2-D-dat-crypto.md` | 07 + 10 | 31 (DAT, CRY) + 35-entry formula appendix |
| `wave3-E-ui-clientcore.md` | 05 + 08, plus a plugin-API deliverable for rynthsuite | running |
| `wave3-F-architecture-2015diff.md` | 00 + 13, plus the ERA-CHECK REGISTER | running |
| `wave3-G-leaks-indextooling.md` | 11 + 12, plus index/PDB tooling spec | running |
| `VERIFICATION-LOG.md` | Orchestrator spot-checks of promoted leads, including the ones that failed | — |
| `PHY-07-LIVE-RUN-2026-07-26.md` | Headless live collision run: harness, measurements, three new defects | LIVE-01..03 |

**201 tasks filed** across the completed waves (an earlier verbal count of "181"
was wrong; the correct figure is 66+52+48+31 = 197 subsystem tasks plus PAL-01..04).

## Dispositions

| Disposition | Meaning |
|---|---|
| **TASK** | A concrete change to make, with effort and a validation method |
| **PARITY-OK** | holtburger already matches retail, provable **by reading alone** — constants, formulas, wire field order, enum values, data layout |
| **VERIFY-LIVE** | Source appears to match, but the claim is about runtime *behaviour* and has not been observed in a running client. Added mid-operation (see below) |
| **N/A-WEB** | Genuinely inapplicable to a web client — with the reason named, not assumed |
| **REF-ONLY** | Pure reference value, with a note on where it should be recorded |
| **ANTI-TASK** | A retail behaviour that must **not** be ported |

### Why VERIFY-LIVE exists

A wave-1 agent dispositioned a large block of physics rows PARITY-OK on the
strength of a decomp-faithful port whose compile-time const was `true`. The user
then reported that in the live client you can run straight through doors, trees
and rocks. Both were accurate statements about different things: the code was
default-on, and the behaviour was still broken. Source reading establishes what
the code *says* and nothing more.

Consequence: **55 of that file's 89 PARITY-OK rows mention transition/faithful
and are re-dispositioned VERIFY-LIVE**, excluded from the plan's "already at
parity" column until a live test covers them.

The root cause was then found by wave2-D and independently verified: **DAT-01** —
procedural scenery has no collision feed at all. The outdoor static path is wired
(`lib.rs:15282` → `insert_static_physics_bsp`) but every feeder reads
`CLandBlockInfo.objects`/`.buildings`; scenery is a disjoint render-only path
whose payload (`LandblockScenerySoa`, `lib.rs:4128`) carries no physics field, and
no `populate_scenery_aabbs_*` exists. The one scenery AABB file in the tree
(`holtburger-scenery-bake/src/aabb.rs`) is a **bake-time placement-reject** pass,
not runtime collision. Retail makes each tree a real `CPhysicsObj`
(acclient.c:352708-352718).

## Standing rules for anyone extending this work

Each of these caught a real false conclusion during the operation:

1. **Open the file.** Every holtburger claim needs a `file:line` actually read,
   not a grep hit. One agent dropped leading digits from 5-digit `lib.rs` line
   numbers; another cited a `#[wasm_bindgen]` *test* function as a production
   default.
2. **Two carriers.** A feature often has a compile-time const **and** a runtime
   URL-flag carrier, OR'd into an `*_enabled()` predicate. A `false` const is not
   evidence a feature is off; a `true` const is not evidence it works.
3. **Flag-default footgun.** A flag read as `!== "off"` is default-**ON** whatever
   its comment or `docs/url-flags.md` says. Only `=== "on"` is a real opt-in.
4. **Era-check constants.** Three commands inserted at ordinal `0x10F` shifted 136
   of 407 command IDs by +3. Worked example: `AtlatlCombat` is `0x8000013b` in
   shipped data though the 2013 doc says `0x138` — holtburger is right and
   "fixing" it would break every atlatl animation.
5. **Never `rg -rn`.** `-r` is `--replace`; it silently substitutes matches with
   your pattern text. This bit the orchestrator too, printing
   `const n: bool = false` for `const USE_FAITHFUL_ENTITY_COLLISION: bool = false`.
6. **Gate behavioural tests on movement.** A live harness reported
   `BLOCKED (plateau)` when the player simply never moved. Any collision or
   movement assertion must first prove displacement occurred and heading changed.
7. **Correcting the source docs is welcome output.** Verified doc errors found so
   far: two mis-transcribed Family A hash constants, the "LandBlock records are
   248 bytes" claim (all 65,025 measure 252), the send-side checksum order, and
   the §7 "cull distance" rows that are really `min_2D_degrade_distance_sq`.
