# bc7cli — PNG → HBC7 v2 (BC7 + full mip chain)

Reconstruction of the scratchpad tool that produced the shipped
`tex-bc7` payloads (the original was session-scoped and lost; see
`docs/HANDOFF-bc7-texture-unification-2026-07-30.md` §2). Structurally
verified: same source PNG ⇒ byte-length-identical container to the
shipped `blocks-mip` blobs, passing `validate_hbc7`.

Build: `./build.sh` (== `g++ -O2 -o bc7cli bc7cli.cpp bc7enc.cpp lodepng.cpp`)

The **binary is gitignored**; only the sources here are committed. Run
`build.sh` before a `tex-bc7` / `terrain-bc7` bake — the encoder's default
path has already died twice by pointing at a session scratchpad
(`docs/HANDOFF-texture-pipeline-2026-08-04.md`), and an untracked,
unignored ELF (its state 2026-07-31 -> 08-05) gave a fresh clone no binary
and no signal that one was needed.

`bc7enc.{cpp,h}` and `lodepng.{cpp,h}` are vendored verbatim from
richgel999/bc7enc_rdo (public domain / MIT).
