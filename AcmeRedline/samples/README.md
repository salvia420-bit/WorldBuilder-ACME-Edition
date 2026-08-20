# AcmeRedline samples / self-test

`redline.jsonl` here is **generated, not hand-written**, by the harness in `emit_sample/`. It is the
end-to-end proof that the plugin's emit path produces entries the pipeline accepts.

## What the harness does

`emit_sample/Program.cs` (a standalone console app — **not** part of the shipped plugin; the plugin
csproj excludes `samples/**`):

1. Reads real ids and geometry out of `/home/wbterminal/ac_base_dats/client_portal.dat`
   (sha256 `dc6e500b…`, the same dat the pipeline fixtures use).
2. Builds three schema-v1 entries — one per selection kind — using the plugin's **own** emit code
   (`RedlineJson`, the `Model` types, and `SelectionService.BuildFanTrianglePayload`):
   * **triangles** on `0x01000827`: picks source polygons `{8, 40, 136}` and lets the plugin
     fan-expand them into draw-stream triangle indices `[16, 85, 241]` with a per-triangle footprint
     and the real record sha256.
   * **texture**: a real `Surface 0x08 → SurfaceTexture 0x05 → RenderSurface 0x06` chain off the
     same GfxObj.
   * **object**: a bare architecture GfxObj with `setupId: null` (omitted), per the schema's note
     that retail static architecture has no Setup.
3. **Proves the triangle-index convention** by re-deriving the stream with a faithful C# port of
   `tools/dat-patch/redline/queue_worker.py:_tri_stream` and asserting the plugin's indices match
   exactly (`parity = True`), and that the max index (241) exceeds `triDrawn` (226) — which is only
   possible under the all-polygons convention, not drawn-only.
4. **Validates every emitted line** against `tools/dat-patch/redline/schema_v1.json`
   `#/definitions/entry` with NJsonSchema, and only writes `redline.jsonl` if all pass.

## Run it

```bash
cd AcmeRedline/samples/emit_sample
DOTNET_ROLL_FORWARD=LatestMajor dotnet run -c Release
```

Expected tail:

```
0x01000827: triAll=242 triDrawn=226 picked=8,40,136
  emitted indices = [16,85,241]
  pipeline stream parity = True
  max index 241 vs triDrawn 226 (> triDrawn proves all-polys) : True
VALID   rl-20260820-141500-a1b2  (triangles)
VALID   rl-20260820-141530-c7d9  (texture)
VALID   rl-20260820-141600-4e0f  (object)
ALL ENTRIES VALID against schema_v1.json #/definitions/entry
```

The generated `redline.jsonl` is one entry per line, exactly as the plugin's `QueueWriter` appends
them.
