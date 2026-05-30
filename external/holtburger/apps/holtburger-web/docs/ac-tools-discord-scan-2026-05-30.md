# AC tooling landscape — what we have, what discord chatter mentions

**Scanned:** 2026-05-30 — synthesis of: 4-surface survey of our vendored RE assets
(melt / chorizite / DatReaderWriter / acclient artifacts) plus a 16,800-line grep
over the ~77 MB AC discord archive at `/home/wbterminal/ac-discord-research/`.
Mostly research notes; **none of the discord-discovered tools are vendored yet**
and most aren't even URL-confirmed — entries are leads, not validated facts.

## What we already have

| Surface | Path | Nature (one-line) |
|---|---|---|
| **melt** (bdekaru @ 336e18c4, 2024-11-29) | `external/melt/` | C# DAT-RE library. GfxObj / SetupModel / Surface / Animation / PhysicsScript parsers + texture conversion. Offline scratchpad; no rendering or networking. ~155k LOC across 571 files. Read-only research; mixed AGPL-derived + no-license, must not redistribute. |
| **chorizite** (7 vendored repos) | `external/chorizite/` | In-process C# plugin framework for retail `acclient.exe`. We vendor ACPlugin (event API), ACBindings (1,899 acclient offsets), Chorizite Core (plugin host), Chorizite.Common (59 enums), Chorizite.ACProtocol (XML→C# packet parser), DatReaderWriter.Extensions (DAT helpers), RmlUiPlugin. Skipped: Injector, LuaPlugin, RmlUi.Net, LauncherPlugin, PluginManagerUIPlugin, TaffySharp, ida-scripts, WorldBuilder, MSBuildTasks, plugin-index, github-workflows. |
| **DatReaderWriter** (Chorizite NuGet 2.1.2) | `external/DatReaderWriter/` | C# library, MIT licensed. Full read+write across all 4 DAT files (`portal`, `cell`, `local`, `highres`). 205 type definitions schema-driven from `dats.xml`. Hand-rolled types + source-generated parsers. Comparison oracle for our Rust parser; known mislabels documented in our feedback memories. |
| **acclient retail decomp** | `external/acclient.{c,h,txt}` + `acclient_2013.bndb_pseudo_c.txt` | Four-way RE corpus from the September 2013 retail `acclient.exe` PDB build. IDA Hex-Rays (`.c`, 938k lines, ~36.6k functions), IDA types (`.h`, 70.7k lines, ~7k structs / 348 enums), CVDUMP PDB (`.txt`, 1.48M lines, authoritative symbol table), Binary Ninja pseudo-C (`.bndb_pseudo_c.txt`, 1.43M lines). |

**Common thread:** AC-client-side reverse-engineering and DAT introspection. Parse
retail binary formats and behaviors so we can re-render them in
holtburger-web.

**Adjacent already-known:** ACE (server emulator), acpedia + AC fandom wiki,
WorldBuilder.Terminal (our internal), RynthSuite/RynthCore (bot client/API),
Vitaeum, Decal, UtilityBelt, Virindi, ThwargLauncher.

## Discord-discovered tools NOT in our surfaces

Channels swept: `tool-dev`, `alt-clients`, `decalinfo`, `worldbuilder`, `general`,
`chorizite`, `utilitybelt`, `thwarg`, `sourcecode`, `acme-worldbuilder`,
`vitaeum-client`, `openai-gpt-3`, DMs. Excluded from this list: our own work
(notan's diagnostic toolset, merklejerk holtburger), launchers, unrelated
calculators/bots. Entries with no URL are leads, not confirmed repos.

### Client implementations (highest 3D-renderer relevance)

| Tool | Author | Channel | Description | Fit |
|---|---|---|---|---|
| Rust + wgpu + egui client | Crimson / Zan | `alt-clients:1482-1509` | Rust-native AC client; wgpu rendering pipeline, DAT-driven texture / skybox / lighting. **Closest peer to our stack.** | HIGH |
| Vermino Rust dungeon renderer | Vermino | `worldbuilder` | Rust + `datrw`-based EnvCell renderer. | HIGH — directly informs our academy / PView work |
| Godot client | Vanquish420 | `alt-clients:130` | Godot Engine + Rust GDExtension + hybrid physics. | HIGH — alternative engine; physics + coordinate-convention reference |

### DAT / UI tools

| Tool | Author | Channel | Description | Fit |
|---|---|---|---|---|
| **Accult** | (Vermino working with it) | `general:1137, 1194` | WPF LayoutDesc loader/renderer (DAT UI parser, WIP). | HIGH — feeds our retail-UI fidelity work |
| **DatHammer** | trevis | `general:2732` | WPF DAT debugger with LayoutDesc + ElementDesc inspection. | MED-HIGH — UI-extraction cross-validation |
| **ACViewer** | (unknown) | `general:2439, 2543, 2628` | DAT viewer with texture-surface chain inspection. | MED — texture pipeline sanity check |
| **DATRusterWriter** | CrimsonMage | `alt-clients:2030-2034` | Rust port of DatReaderWriter (github.com/CrimsonMage/DATRusterWriter). | MED — independent Rust oracle vs our parser |
| Lingrad's Custom Texture Importer v2 | Lingrad | `worldbuilder` | DRW-based AC texture format converter (improved on Shin's baseline). | MED — Surface render-state pivot work |
| DHC-Release Texture Tool | (unknown) | `worldbuilder` | Standalone DAT texture editor (ZIP). | MED |
| Shin's texture importer | Shin | `worldbuilder` | Predecessor pattern to Lingrad's. | MED |
| ac.yotes.fan / `21-UILayout` | OptimShi (yotes) | `general:2761` | Online AC UI Layout explorer with ElementDesc + 0x06 image links. | MED — quick UI element lookup, layout reference |

### RE / packet tools

| Tool | Author | Channel | Description | Fit |
|---|---|---|---|---|
| trevis' decompiled client | trevis | `general:177, 1860` | Third-party decomp of retail acclient. | MED — tiebreaker when our IDA Hex-Rays and Binary Ninja disagree |
| ACEWire | Vermino | `tool-dev:12` | DLL-inject packet logger; C2S/S2C traffic. | LOW — wire validation only |
| yonneh's pl.dll | yonneh | `general:1860` | Client-side packet logger (proof-of-concept). | LOW |
| RL Dashboard | (unknown) | `tool-dev:14` | Packet log dashboard + headless client control (WIP). | LOW |

### Plugins / launchers (low relevance)

| Tool | Channel | Description |
|---|---|---|
| CameraDolly (trevis) | `general:3356` | Camera plugin; known indoor-transition bug. |
| pegasus-linux (sdrawkcab3) | `general:2790` | Virindi Integrator on Orange Pi / aarch64. |
| Aircorian's AC Linux Lutris setup | (worldbuilder) | Non-Windows game launch reference. |
| ACCPP Archive-Viewer (immortalbob) | `openai-gpt-3:328-332` | Web browser of ACCPP archive tree (stale). |

## Top 5 candidates worth investigating first

1. **Crimson / Zan wgpu+egui Rust client** — Closest peer to our Rust+wasm+Three.js stack. If a public repo URL surfaces, comparative reference for DAT→render pipeline, atmosphere, materials.
2. **Vermino Rust dungeon renderer** — Same Rust + DAT route; directly informs EnvCell PView and academy work.
3. **Accult** — Active WPF LayoutDesc renderer; pairs with our `chorizite-dump-layout-tree` work and the [retail UI fidelity push](./).
4. **DATRusterWriter (CrimsonMage)** — A second independent Rust DRW port; defends against shared-C# parser bugs leaking into both melt and DRW.
5. **trevis' decompiled client** — Third decomp source for arbitration when IDA Hex-Rays and Binary Ninja decomps disagree.

## Suggested next moves

- For top 3: grep discord for accompanying GitHub / Gitlab URLs so we can pull
  the repos locally and characterize them (none had a clean URL attached in our
  initial sweep).
- Once Accult is located, compare its LayoutDesc rendering against our
  `chorizite-dump-layout-tree resolveSymbols=true` output (now yotes-fan-parity
  accurate) and decide whether to port any of its rendering decisions or stop
  at using it as a reference.
- The ac.yotes.fan UI explorer is the lowest-effort win — it's a hosted web page
  we can compare against without pulling any code; useful for cross-checking
  our LayoutDesc dumps against retail.
