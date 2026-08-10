# QUEUED TASK — RELIEF-IN-BAKE (owner-requested 2026-08-10; launch when an agent slot frees)

Charge: bake gfxRelief's material-identity relief (subdivision + outward
displacement, crates/holtburger-dat/src/gfx_subdiv.rs) INTO the HBG1 GEOM
sections at bake time, so the pack/bundles pipeline ships pre-displaced
positions instead of force-disabling relief (T13 D3: HBG1 bakes relief-free;
explicit ?gfxRelief=on currently disarms bundles).

Why now (owner context): the relief project is the owner's "more triangles from
flat walls" ambition (stones/timber protrude 5-10 cm). Its history: per-texel
(texture-driven) height RETIRED 2026-07-30 by measurement (polarity backwards on
Tudor, row-integration banding on planks) → material-identity rails ship at
subdivLevel 0 on presets; the triangle-multiplying levels (1..5, up to 1024x)
exist behind ?gfxSubdivLevel gated by the SHADOW-pass vertex bill (shadows
re-draw the same buffer; ~half of GPU cost at high). On the migration arm
(?packSource+?geomBundles) relief is absent entirely — this task closes that gap.

Design constraints for the brief:
- Bake-side: emit relief VARIANT GEOM sections (or a bake profile) rather than
  overwriting the relief-free default — the relief-free bake is the byte-exact
  differ baseline (differ_real_dats_envcells / BAKE-CI HBG1 legs must keep a
  clean target). Variant selection keyed by the resolved gfxRelief config that
  index.html already stashes (__hbGfxRelief) and hands the pack controller.
- The runtime differ story must be preserved: fresh-encode-vs-pack byte differs
  need to know WHICH variant to encode (thread the relief config into
  encode_env_directory/encode_gfx_part variants, mirroring set_gfx_relief's
  decode-side plumbing).
- Client-side: bundles arm consumes the relief variant when relief resolves ON
  (instead of disarming); ?gfxRelief=off keeps today's relief-free packs.
  Flag lifecycle I7: the new consumption path DEFAULT-OFF behind its own spelling
  (?reliefBundles or SPEC-preferred name) until an eye pair passes.
- Shadow policy unchanged (presets keep subdivLevel 0 for now); the bake carries
  whatever level the bake profile sets — a t-level ladder of GEOM variants is the
  natural shape but ONE level (the preset rails level) is an acceptable first land.
- Measured inputs available: P-ASSEMBLE 28 µs/model p50 (assembly headroom),
  P-88MIB/P-INITTEX staging numbers, E1 CLEAN baseline pairs to eye against.
- Scope: holtburger-tools bake emitter + hbg1 codec variants + geom_bundles
  consumer + gfx_relief.js arming interplay; fence away from terrain_bc7.js and
  pool_registry.js if those agents' work is still in flight or just landed.

Prereqs at launch time: T22 + T15R-TERRAIN landed & verified (their scopes
overlap this one's consumer side); re-read T13 report D3 + gfx_subdiv.rs module
docs + url-flags gfxRelief/gfxSubdivLevel rows (the retirement rationale lives
there and must not be re-litigated — material identity stays; this task moves
WHERE it runs, not HOW heights are decided).
