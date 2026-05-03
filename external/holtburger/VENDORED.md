# Vendored holtburger

This directory is a hard-fork copy of [merklejerk/holtburger](https://github.com/merklejerk/holtburger). It is not a git submodule; the upstream `.git` was dropped at copy time so this tree can be patched in place by the WorldBuilder-ACME-Edition project.

## Provenance

| Field | Value |
|---|---|
| Upstream | `https://github.com/merklejerk/holtburger` |
| Commit | `629695a2e526cd8be3d022f02791b5085f9ed86a` |
| Author date | `2026-04-23T17:16:56Z` |
| Commit subject | `chore: clean sync from dev [skip ci]` |
| Vendored on | `2026-05-03` |
| License | AGPL v3 (see [`LICENSE.md`](LICENSE.md)) |

## Why hard-fork instead of submodule

`emit-dynamic-site` (see [`/docs/emit-dynamic-site.md`](../../docs/emit-dynamic-site.md)) needs to add a `Transport` builder seam, an HTTP-backed `ResourceSource` impl, and a WASM target — none of which can live cleanly upstream while the design is still settling. Owning the source in-tree keeps those patches reviewable in the same PRs that consume them.

## Re-syncing from upstream

When upstream lands a feature we want to absorb, replay it manually:

```bash
# from a working clone of upstream:
git format-patch <last-vendored-commit>..HEAD --stdout > /tmp/upstream.patch

# in this repo:
cd external/holtburger
git apply /tmp/upstream.patch    # resolve conflicts; never blindly accept
# update Commit/Author date in this file, commit the result
```

## License obligations

Holtburger is AGPL v3. Anything that links it (statically or as a runtime dependency) — including the future emit-dynamic-site browser client — inherits AGPL v3 obligations under §13 (network use). The project's top-level [`LICENSE.md`](../../LICENSE.md) reflects this.
