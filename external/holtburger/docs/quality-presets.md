# Quality preset system

**Phase X.1** of the visual-fidelity push plan. Source of truth for the
flag bag consumed by every later phase (POM, SSAO, CSM, terrain
subdivision, hero assets, etc.).

Implementation: `apps/holtburger-web/scene3d/quality.js`.
Consumed at init by: `apps/holtburger-web/scene3d/index.js` (stored on
`liveScene3d.quality` and `window.__quality`).

## URL grammar

```
?quality=<preset>[&<flag>=<value>]...
```

- `<preset>` — one of `low`, `mid`, `high`, `ultra`. Default is `mid`
  (or `low` on mobile UAs, see below). Unknown values fall through to
  the default.
- Per-feature override — any flag listed in the preset table can be
  passed as a URL param to flip it on top of the preset. Boolean flags
  accept `on|off|true|false|1|0|yes|no`. Integer flags accept any
  parseable integer.

### Examples

| URL | Resolved |
|---|---|
| `?renderer=3d` | `mid` (desktop default) |
| `?renderer=3d&quality=low` | `low` |
| `?renderer=3d&quality=ultra` | `ultra` |
| `?renderer=3d&quality=mid&pom=on` | `mid` with POM overridden on |
| `?renderer=3d&quality=high&csm=off&subdivLevel=2` | `high` with CSM off + subdiv lowered to 2 |
| `?renderer=3d` (mobile UA) | `low` (mobile-default downgrade) |
| `?renderer=3d&quality=high` (mobile UA) | `high` (user opt-in overrides mobile default) |

## Mobile auto-detection

If `navigator.userAgent` matches the mobile UA regex
(`/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i`),
the default tier downgrades from `mid` to `low`. Passing `?quality=...`
explicitly always wins — mobile users can opt into `high`/`ultra` if
they accept the perf cost.

## Preset table

| Flag | low | mid | high | ultra | Source phase |
|---|---|---|---|---|---|
| `antialias` | off | on | on | on | A1 (FPS plan) |
| `shadows` | off | on | on | on | 0.1 |
| `normalMaps` | on | on | on | on | 1.1 |
| `detailFlag` | off | on | on | on | 0.2 |
| `terrainDetailNormal` | off | on | on | on | 1.2 |
| `triplanar` | off | on | on | on | 1.3 |
| `subdivLevel` | 1 | 2 | 4 | 8 | 2.1 |
| `hero` | off | off | on | on | 2.3 |
| `pom` | off | off | on | on | 3.1 |
| `ssao` | off | off | on | on | 3.2 |
| `csm` | off | off | on | on | 3.3 |

### Flag glossary

- **`antialias`** — FPS plan A1 (2026-05-18). Passed to
  `WebGLRenderer({ antialias })` at construction. Off at `low`
  saves ~25 % frametime on weaker GPUs (MSAA 4× cost). Toggling
  this flag requires a page reload — the renderer's antialias state
  is fixed at construction.
- **`shadows`** — Phase 0.1. Enable three.js shadow maps (sun-cast
  building shadows). Free win, costs ~3–5 ms / frame.
- **`normalMaps`** — Phase 1.1. Procedural normal maps derived from
  diffuse luminance. Already on by default at every tier (cheap).
- **`detailFlag`** — Phase 0.2. Honour the surface `Detail (0x20000)`
  flag bit when wiring detail-map sampling.
- **`terrainDetailNormal`** — Phase 1.2. Detail normal-map layer on
  the terrain shader (sub-meter rock/dirt detail).
- **`triplanar`** — Phase 1.3. Triplanar texture projection on
  terrain slopes (kills UV stretching on cliffs).
- **`subdivLevel`** — Phase 2.1. Terrain mesh subdivision factor.
  1 = 9×9 (raw heightfield); 2 = 17×17; 4 = 33×33; 8 = 65×65.
  Bicubic interpolation + clamped procedural noise between control
  points. Collision math stays on the 9×9 grid per §4 constraints.
- **`hero`** — Phase 2.3. Authored normal/roughness/AO maps for
  hero surfaces (forge, lifestone, hero buildings).
- **`pom`** — Phase 3.1. Parallax occlusion mapping on stone
  surfaces.
- **`ssao`** — Phase 3.2. Screen-space ambient occlusion post pass.
- **`csm`** — Phase 3.3. Cascaded shadow maps.

## Devtools inspection

```js
> window.__quality
{
  preset: "mid",
  flags: { shadows: true, normalMaps: true, ..., subdivLevel: 2, ... },
  source: "default"
}
```

`source` is `"url"` (preset explicitly requested), `"localstorage"`
(set from the Graphics tab in the bar), `"mobile-default"`
(downgraded from mid), or `"default"` (desktop default).

## Graphics settings tab

The bar's gear icon (⚙) now has a **Graphics** tab that persists a
`holtburger_graphics_v1` localStorage payload:

```js
{
  preset: "mid",                 // optional explicit preset
  flags: { antialias: false },   // per-flag overrides (sanitized at read)
  extras: { renderScale: 1.0 }   // UI controls not yet consumed by quality.flags
}
```

`getQuality()` merges in this order (highest wins): URL params →
localStorage overrides → mobile-UA default → desktop default. Most
flag changes take effect on reload because consumers cache flag
values at init.

## How later phases consume this

Each phase that gates on quality reads `liveScene3d.quality.flags.<flag>`
at the appropriate init / gate point. Example shape (illustrative,
each phase will add its own gate):

```js
// scene3d/terrain.js, Phase 1.3 triplanar gate
if (scene3d.quality?.flags?.triplanar) {
    material.defines.USE_TRIPLANAR = "";
}
```

Per the plan-doc §4 constraint 6, new features default **off** at every
tier and graduate to mid/low only after live-ACE perf validation. The
preset table above is the current as-built state; phases that haven't
shipped yet have their flag pinned to `off` across the board until
their phase lands.

## Non-goals (deferred)

- **`?quality=auto`** — self-tuning preset that boots, measures FPS,
  then picks dynamically. Deferred per the plan-doc.
- **Per-quality LOD bias** — fold into `subdivLevel` for now;
  separate LOD flag if/when it earns its keep.
- **Backwards-compat shims** — `?quality=` is a fresh knob. No
  legacy params to honour.
