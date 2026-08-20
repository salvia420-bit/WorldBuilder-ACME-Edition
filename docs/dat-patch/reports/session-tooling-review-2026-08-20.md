# AcmeRedline session-tooling code review — 2026-08-20

READ-ONLY review. No tool was run against a dat; no file under review was modified.
Scope: `tools/dat-patch/redline/*`, the new lane drivers under `tools/dat-patch/`
(`creature_enum.py`, `creature_tranche.py`, `dungeon_coverage.py`,
`detail_texture_lane.py` [not read — see note], `texel_survey.py`), and the C#
under `AcmeRedline/` (queue-writing / schema-emit / selection paths).

Confidence is called out per finding: **CONFIRMED** = verified against the code
here; **PLAUSIBLE** = reasoned but depends on a premise I could not execute.

---

## Findings, most severe first

### F1 — executor writes large texture records through the `prep_dat`-then-import flow that is documented AND reproduced in-repo to silently corrupt records >65 blocks (BLOCKER for `--apply`, CONFIRMED)
`tools/dat-patch/redline/executor.py:167-171,189-210` (`disp_texture_rebake`).

The apply path prepares the scratch dat with `texture_lane.py prep` (= `prep_dat`,
`texture_lane.py:143-173` — appends a **zeroed** free arena and repoints the header
free list) and then drives `texture_lane.py run` (a render-surface-import) into
that prepped dat. It never uses the safe `cp → DatCompress → import` sequence, and
it never runs a post-import fixup / free-list reset / walk_check.

The corruption this triggers is not hypothetical — a sibling lane in this very tree
documents and freshly reproduces it. `detail_texture_lane.py:271-276`:

> flow="prep": texture_lane.prep_dat appends a ZEROED arena. DRW's contiguous
> allocator chains SMALL records (<=~65 blocks) through it, but **corrupts
> MULTI-HUNDRED-block records** — the arena's next-pointers are all zero, so a
> >~65-block record's chain terminates after ~1 block and **reads back 0x0**.
> Reproduced this run on both 512² (258 blk) and 1024² (1029 blk) DXT5.

I confirmed the block math against the live base header (`client_portal.dat`,
blockSize = 1024 → 1020 payload bytes/block). The rebake's whole purpose is a 4×
upscale to a DXT record up to 2048²:

| record | payload | blocks |
|---|---|---|
| 2048² DXT5 (+mips) | ~5.6 MB | ~5,482 |
| 2048² DXT5 (no mips) | 4.0 MB | ~4,113 |
| 1024² DXT1 | 0.5 MB | ~515 |
| 512² A8R8G8B8 | 1.0 MB | ~1,029 |

Every record this lane writes is 500–5,500 blocks — far past the ~65-block cliff
the sibling lane reproduced at 258 and 1029 blocks. So the executor's `--apply`
path silently writes a texture record that reads back as zeros, then renders a
"verified/fixed" A/B board and appends a `fixed` status event over the corrupt
result. The A/B verify does **not** catch it: `run_verify`/`make_board` reads the
AFTER texture back through WBT/DRW, but nothing in the executor runs `walk_check`
or checks the header `freeCount==0` allocator-bug state that
`detail_texture_lane.py:314-323` explicitly repairs.

Recommendation: `disp_texture_rebake` must land through the same sequence
`detail_texture_lane.land()` uses (default `flow="compress"` = cp → DatCompress →
import, then `fixup_dat`, then the `freeCount != 0` → `reset_free_list` repair,
then `walk_check`), or delegate to that function outright. Until then `--apply`
should be treated as unsafe for any real (>64²) texture.

Note the other lane drivers do **not** hit this: `creature_tranche.py` and the
`geometry-displace` path only emit `imports.jsonl` and stop at the artifact, and
`detail_texture_lane.py` defaults to the safe compress flow (see the verified
list). The executor is the only in-scope tool that prep+imports a dat itself.

Related gap: `texture_lane.fixup_dat` (`texture_lane.py:176-193`, "run AFTER all
imports, BEFORE shipping" — zeroes DRW's `0xCDCDCDCD` leaf-branch sentinels and
compacts the appended arena) is **never invoked** by the executor. Even setting
the >65-block corruption aside, the scratch dat the executor leaves behind is not
client-conformant.

---

### F2 — a successful fix with no `--release` silently fails to write its `fixed` status event (HIGH, CONFIRMED)
`tools/dat-patch/redline/executor.py:503-512` (`_emit_status`), default at `:531`,
call at `:486`.

For a `fixed` event the executor sets:
```python
ev["release"] = release or "acme-unreleased"
```
`--release` defaults to `None` (`:531`), so when the operator omits it the release
becomes the literal string `"acme-unreleased"`. `_emit_status` then calls
`status_writer.append_event`, which validates against
`schema_v1.json#/definitions/statusEvent`. The `release` field there is
`anyOf[{pattern "^acme-r[0-9]+(\\.[0-9]+)?$"}, {null}]` — `"acme-unreleased"`
matches neither, so `append_event` raises `ValueError`, which `_emit_status`
swallows in its `except Exception` and downgrades to a `WARN` on stderr (`:510-512`).

Net effect in `--apply` without `--release`: the `in-progress` "picked up" event
was written earlier (`:463`, valid — no release), the record is actually baked,
but the terminal `fixed` event is **dropped**. The entry is stranded at
`in-progress` forever, and the only signal is a stderr warning. Since closing the
loop is the entire point of the status log, this is a silent correctness hole in
the primary happy path.

Recommendation: make `--release` required for `--apply`, or fall back to a
schema-valid sentinel (e.g. reuse the item's `clientRelease.kitTag`, which is
already `acme-r…`-shaped) instead of `"acme-unreleased"`. `status_writer.py`'s own
CLI already enforces this (`--state fixed needs --release`, `status_writer.py:101-104`);
the executor bypasses that guard by calling `append_event` directly with a bad value.

---

### F3 — `texel_survey.py` measures no Environment (0x0D) surfaces despite advertising it (MEDIUM, CONFIRMED)
`tools/dat-patch/texel_survey.py:170-182`, docstring `:69-73`, `:291`.

`collect()`'s docstring and the module header both claim it walks "every GfxObj
(0x01) **and** Environment (0x0D) drawing polygon". The env loop, however, is:
```python
for eid in env_ids:
    try: cells = portal.env(eid)
    except Exception: continue
    for ck, c in cells.items():
        pass          # <- accumulates nothing
    ne += 1
```
No surface is resolved and no `acc` entry is written for any 0x0D record — only
`ne` is incremented. Indoor/dungeon wall surfaces reached through EnvCell →
Environment polygons therefore contribute **zero** measurements, so the
texel-starvation short list is silent about the entire indoor corpus. The output
JSON's `surfaces_measured` count and every ranking under-represent the world by
however many surfaces only appear on 0x0D geometry.

This may be an intentional POC limitation (the inline comment concedes "handled
via GfxObj coverage"), but the docstring, the header, and the output field names
present it as complete. At minimum the claim should be corrected; better, the
0x0D→EnvCell surface walk should be implemented or the lane should state the gap
in its emitted JSON. The `portal.env(eid)` call is also pure wasted work today
(parse then discard).

---

### F4 — executor's `_prepped` guard is dead code; prep re-runs for every executed record (MEDIUM→LOW, CONFIRMED)
`tools/dat-patch/redline/executor.py:187-197`, dispatch at `:447` and `:466`.

Each item is dispatched with a **fresh** dict: `DISPATCH[dispatcher](item, {**ctx, "dry": False})`.
Inside `disp_texture_rebake`, `ctx.get("_prepped")` is read from — and
`ctx["_prepped"] = True` written to — that throwaway copy, never the real `ctx`.
So the "prep the scratch dat's free arena ONCE" comment is not honoured: with
`--max-records > 1`, `prep_dat` runs again for every executed texture record,
appending another 8,192-block zeroed arena and repointing the free head each time.
The file grows unboundedly (~8 MB/record) and each prep orphans the previous
arena's free blocks (header `freeBlockCount` is reset to `blocks`, not accumulated).

Not corruption on its own (prep is additive and self-consistent), and harmless at
the default `--max-records 1`. But it defeats the stated invariant and compounds
F1. Fix: hoist the prep to the copy-scratch step in `main` (run it once when the
scratch is created), or set `_prepped` on the real `ctx`, not the per-call copy.

---

### F5 — `creature_tranche.build` assumes a part has at least one surface (LOW, CONFIRMED)
`tools/dat-patch/creature_tranche.py:83`.

```python
sdid = rec["surfaces"][0]
```
A GfxObj part with an empty surface list raises `IndexError` and aborts the build
with a bare traceback rather than a diagnostic. Creature parts are usually
textured, so this is an edge case, but a guard (skip / clear message) would be
cheap. Separately, using only `surfaces[0]` as the single `surfaceDid` for the
obj-import means a multi-surface part is imported against one surface; whether
that matches the shipped `tranche.py` obj-import contract was not verified here —
worth a cross-check before this POC ships anything.

---

### F6 — C# fan-stream ordering: two sibling implementations disagree on tie-breaking (LOW, PLAUSIBLE)
`AcmeRedline/Services/SelectionService.cs:775-803` vs
`AcmeRedline/samples/emit_sample/Program.cs:229-238`.

`BuildFanStreamStatic` (the shipped emit) enumerates `gfx.Polygons` in natural
dictionary order and uses enumeration **position** as `pi`. The self-test's
`PipelineTriStream` instead uses `.OrderBy(k => k.Key)` (ascending key). For the
dense `0..n-1` keys retail portal.dat is asserted to always have, these coincide,
and the `nonDense` branch (`:794-801`) logs if that assumption ever breaks. But
the parity self-test is therefore validating against a *different* ordering rule
than the one it ships; on a hypothetical non-dense record the plugin (positional)
and the sample's "pipeline" model (key-sorted) would diverge while the real
`queue_worker._tri_stream` follows gfxlib's parse order (a third rule). All three
agree on retail data, so this is latent, not live — but the self-test does not
actually exercise the ordering guarantee it claims to prove. Worth a comment or a
non-dense fixture.

Minor related note (`SelectionService.cs:863-872`): when a triangle's vertex
fails `TryVertex`, the emit skips that index, so the emitted index set can be a
proper subset of `queue_worker`'s stream positions for the same polygons. The
footprint stays aligned with the emitted indices (both skip together), so it is
self-consistent; flagging only because the sample's parity check
(`Program.cs:79-82`) assumes no such skip and would report a false PARITY FAIL if
one ever occurred on the chosen fixture.

---

## Checked and found solid

- **`schema_v1.json`** — internally consistent; `entry` and `statusEvent` are
  `additionalProperties:false` throughout, hex/id patterns are correct widths, and
  the nullable scalars use `anyOf[…, null]`. The frozen triangle-index convention
  is documented identically in the schema, `queue_worker._tri_stream`, and
  `SelectionService.BuildFanStreamStatic`.
- **`queue_worker.py`** — the built-in draft-07 subset validator is guarded by
  `_schema_selfcheck` (refuses to run against unsupported keywords, so it cannot
  silently under-validate), correctly special-cases Python's bool/int/float
  distinctions (`:179-186`), and prefers real `jsonschema` when present. Resolve →
  guard → classify → aggregate is careful: stale-selection hash check with
  nearest-centroid footprint fallback (`:496-549`), OOB index handling
  (`:516-519`), terrain-protected / palette-route / band0-not-self guards all cite
  and mirror the shipped lanes, and attachment paths are sanitised against absolute
  and `..` escapes (`:998-1008`). Atomic `os.replace` write of `work-items.json`.
- **`status_writer.py`** — append is a single `O_APPEND` write under `flock(LOCK_EX)`
  with `fsync`; validates every event against the schema before writing; the CLI
  enforces `--release` for `fixed` (the guard the executor sidesteps — see F2).
- **`gen_kit_meta.py`** — reads only the 24-byte RS header (no pixel inflate); the
  highres-supersedes-portal palette merge (`:107-121`) correctly *removes* an id
  that is palettized in portal but absent/DXT in highres; atomic `os.replace`.
- **`verify_fix.py`** — read-only on both dats; `DATPATCH_PORTAL` is set before
  `texture_lane` import; degraded (no-`--wbt`) mode is handled; only writes the
  board PNG and (optionally, with both `--entry` and `--release`) one status line.
- **`QueueWriter.cs`** — append-only `FileMode.Append` + `FileShare.ReadWrite`,
  process lock, strips stray CR/LF so one entry can't split across JSONL lines,
  UTF-8 without BOM, id minted with a CSPRNG suffix. Read-back tolerates partial
  trailing lines.
- **`RedlineJson.cs`** — source-generated (avoids pinning the collectible plugin
  ALC), `WhenWritingNull` so absent optionals are omitted rather than emitted as
  schema-invalid `null`s — the reasoning in the header comment checks out against
  `additionalProperties:false`.
- **`creature_enum.py`** — BOM-safe (`utf-8-sig`) reads, exposure summed over
  *distinct* wcids (no double count across slots), degrade band0-not-self guard
  mirrored, non-0x01 parts routed to skip. `dungeon_coverage.py` — EnvCell id
  range `0x0100..0xFFFD` and dungeon-LB derivation are correct; divide-by-zero
  guarded (`wc or 1`, `max(...,1)`).
- **`detail_texture_lane.py`** — the reference-correct dat-write pattern and the
  direct counter-example to F1. Defaults to `flow="compress"` (cp → DatCompress →
  import), documents/reproduces the prep-arena >65-block corruption
  (`:271-276`), and after import runs `fixup_dat`, a `freeCount != 0 →
  reset_free_list` repair (`:314-323`), optional DatCompress `--verify`, and
  `walk_check` as an integrity tripwire that `_die`s on failure. `~/ac_base_dats`
  is guarded (`_guard_not_base`) and output lands only under `/mnt/wbterminal2`.
- **`emit_sample/Program.cs`** — genuinely exercises the shipped
  `SelectionService.BuildFanTrianglePayload` and validates every emitted line with
  NJsonSchema against `#/definitions/entry`; the projection self-test pins the
  viewport y-flip.

## Not reviewed
- `build_kit_with_meta.sh`, `redline/fixtures/*`, and the D3D-hook internals
  (`DeviceHooks.cs`, `OverlayRenderer.cs`, `CaptureService.cs`) — out of the
  "what it writes" focus and not exercised here.
</content>
</invoke>
