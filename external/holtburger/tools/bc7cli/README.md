# bc7cli — PNG → HBC7 v2 (BC7 + full mip chain)

Reconstruction of the scratchpad tool that produced the shipped
`tex-bc7` payloads (the original was session-scoped and lost; see
`docs/HANDOFF-bc7-texture-unification-2026-07-30.md` §2). Structurally
verified: same source PNG ⇒ byte-length-identical container to the
shipped `blocks-mip` blobs, passing `validate_hbc7`.

Build: `g++ -O2 -o bc7cli bc7cli.cpp bc7enc.cpp lodepng.cpp`

`bc7enc.{cpp,h}` and `lodepng.{cpp,h}` are vendored verbatim from
richgel999/bc7enc_rdo (public domain / MIT).
