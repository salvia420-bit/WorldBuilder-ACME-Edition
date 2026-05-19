# Vendored Chorizite repos

Manifest of github.com/chorizite repos vendored locally for offline reference + skeleton ports. Per the porting plan ([`external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md`](../holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md)) Tier 1-4 + 5 (architectural inspiration).

Vendored 2026-05-19 via `git clone --depth 1`. `.git` dirs kept for provenance (`git remote -v` + `git rev-parse HEAD` resolve the upstream).

| Repo | Path | Tier | HEAD | Date | .cs files | Size |
|---|---|---|---|---|---|---|
| ACBindings | external/chorizite/ACBindings | 3 — symbol navigator | `68016d2` | 2026-01-16 | 1838 | 18M |
| ACPlugin | external/chorizite/ACPlugin | 1 — direct port target | `1341660` | 2025-03-05 | 63 | 784K |
| Chorizite.ACProtocol | external/chorizite/Chorizite.ACProtocol | 4 — parity | `ff7dffd` | 2025-10-04 | 606 | 4.4M |
| Chorizite.Common | external/chorizite/Chorizite.Common | 4 — parity | `e3b3bd2` | 2025-03-07 | 67 | 652K |
| Chorizite | external/chorizite/Chorizite | 5 — plugin model | `5446277` | 2026-02-27 | 231 | 12M |
| DatReaderWriter.Extensions | external/chorizite/DatReaderWriter.Extensions | 4 — parity | `ecd759c` | 2026-02-03 | 20 | 440K |
| RmlUiPlugin | external/chorizite/RmlUiPlugin | 5 — VDom inspiration | `4b68a85` | 2025-03-05 | 34 | 1.1M |
| DatReaderWriter | external/DatReaderWriter (already vendored at top level) | 4 — parity + fixtures | `c535987` | 2026-04-15 | 102 | 1.7M |

## Re-vendor / update

To refresh a single repo to upstream HEAD:

    cd external/chorizite/<repo> && git pull --depth=1 --rebase

To re-vendor from scratch (drop + re-clone):

    cd external/chorizite && rm -rf <repo> && git clone --depth 1 https://github.com/Chorizite/<repo>.git

## Not vendored (intentional per porting plan §2)

- **Chorizite.Injector** — C++ DLL injection. Inapplicable (we are the client).
- **LuaPlugin / Chorizite.VSCode** — Lua scripting tooling. We use Deno via holtburger-scripting.
- **RmlUi.Net / LauncherPlugin / PluginManagerUIPlugin** — native UI bindings. We have DOM.
- **TaffySharp** — flex/grid layout in C#. Browser CSS handles this.
- **WorldBuilder / Chorizite.Plugins.MSBuildTasks** — peer consumers, not dependencies.
- **plugin-index / CoreTestPlugin / chorizite.github.io / .github / github-workflows** — meta/CI.
- **ida-scripts** — Python IDA tooling. Tier 7 future-use only; documented separately.

## Cross-references

- Porting plan: `external/holtburger/apps/holtburger-web/CHORIZITE_PORTING_PLAN.md`
- Motion-table audit: `external/holtburger/docs/motion-table-acclient-audit-2026-05-19.md`
- Swing-pose spec: `external/holtburger/docs/swing-classification-spec-2026-05-19.md`
- Retail decomp (primary behavioral reference, NOT vendored): `/home/wbterminal/ac-headers/` (`acclient.c` 938k lines, `acclient.h` 6936 structs)
