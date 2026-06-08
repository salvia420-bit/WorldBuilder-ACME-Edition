# `plugins/index.json` — generated manifest index (E11)

`index.json` is the manifest index that `loader.js#fetchManifestIndex()` fetches
to discover plugins. Browsers cannot directory-walk, so this index is how the
loader learns which `*.manifest.json` files exist. Each descriptor is
`{ manifestPath, devPath? }` (see `loader.js:680-762`).

**`index.json` is GENERATED — do not hand-edit it.** It used to be hand-maintained
(~37 descriptors), which drifted: its old `$comment` claimed "25 plugins" while the
list held 36, and two entries were mis-ordered (`examine-target` before
`examine-floaty`, `spellbook` before `spell-research-panel`).

## Regenerating

Run from `apps/holtburger-web/` with Node 20+:

```sh
node plugins/gen-index.mjs            # rewrite plugins/index.json
node plugins/gen-index.mjs --check    # exit 1 if index.json is stale
node plugins/gen-index.mjs --stdout   # print to stdout, don't write
```

> **On `--check` and CI:** `--check` is a ready-made staleness gate, but nothing
> invokes it automatically yet — `apps/holtburger-web` has no `package.json` and no
> JS test job globs the sibling `test_*.mjs`. Run `--check` (and
> `node test_plugin_index_gen.mjs`) manually before committing, or wire both into a
> CI step once a JS test job exists. This matches the existing
> `scripts/gen-modulepreload.mjs`, which ships the same un-wired `--check` mode.

The generator (`gen-index.mjs`):

1. Scans `plugins/*.manifest.json`.
2. **Validates each** against `plugins/schemas/plugin-manifest.json`. The web app
   vendors no JSON-Schema library (it has no `package.json`), so the generator
   ships a small **structural validator** — a deliberate subset of JSON-Schema
   draft 2020-12 covering `type / required / properties / items / enum / pattern /
   minLength / uniqueItems / additionalProperties:false`. Zero new dependencies.
   If any manifest fails, the index is **not** written and the script exits 1.
3. Emits `index.json` **deterministically**: descriptors stable-sorted by manifest
   `id` (tie-broken by `name`, then filename), one compact descriptor per line,
   2-space indent, trailing newline. Re-running is byte-for-byte idempotent.

A manifest whose `id` differs from its filename stem (e.g.
`examine-target.manifest.json` carries id `examine-target-watcher`) is **allowed** —
the loader resolves by `manifestPath`, not `id` — but the generator prints a
navigability **warning** for it (it does not block indexing).

### Descriptor shape & `entry`

Each emitted descriptor is `{ manifestPath, devPath }`. The generator intentionally
does **not** emit a descriptor-level `entry` override. `loader.js` consults
`desc.entry` first and falls back to `manifest.entry` (`loader.js:755-757`); every
on-disk manifest declares its own `entry`, and the previous hand-written index
carried zero descriptor-level `entry` fields — so dropping it loses no addressing
information. If a future plugin ever needs an entry distinct from its
`manifest.entry`, set it in the manifest, not the index.

## Adding a plugin

Drop `{id}.manifest.json` next to its `{id}.js` entry, then run
`node plugins/gen-index.mjs`. Do not append to `index.json` by hand.

## Tests

`../test_plugin_index_gen.mjs` (run with `node test_plugin_index_gen.mjs` from
`apps/holtburger-web/`) covers the validator, `build()`, the serializer's
determinism, and asserts the committed `index.json` matches fresh generator output
(the same invariant as `--check`).
