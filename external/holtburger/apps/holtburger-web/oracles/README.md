# oracles/

Pre-baked landblock expectation files for the wire-agent's `window.__diag`
client-side diagnostic layer.

## Format

Per-landblock JSON, named `0xLLLL0000.json` where LLLL is the landblock
key (high 16 bits packed `(lbX << 8) | lbY`). Schema is the output of
WB.Terminal's `dump-lb-expectations` command:

```json
{
  "landblockId": "0xA9B40000",
  "lbX": 169, "lbY": 180,
  "npcs": [ { "wcid": 44895, "name": "Alcott", "x": 83.3, "y": 14.04, "z": 94, "cell": 25 } ],
  "buildings": [ { "modelId": "0x01000C1E", "origin": { "x": 32532.09, "y": 34691.54, "z": 66 } } ],
  "sceneryCount": 64,
  "interior": { "cellCount": 123 },
  "counts": { "npcs": 106, "buildings": 12, "scenery": 64, "envCells": 123 }
}
```

## How they're produced

```bash
echo '{"command":"dump-lb-expectations","lbX":169,"lbY":180,
       "out":"/.../apps/holtburger-web/oracles/0xA9B40000.json"}' \
  | dotnet WorldBuilder.Terminal/.../WorldBuilder.Terminal.dll \
      --stdin --project /path/to/RetailSmoke.wbproj
```

The `out` field is the absolute path WB.Terminal writes the oracle to.
The wire-agent then loads it via:

```js
await window.__diag.loadExpected("./oracles/0xA9B40000.json")
window.__diag.runAll(0xA9B40000)
```

## Caveats

The current oracle's `sceneryCount` and the npcs list come from
`LandblockInfo` + ACE spawn records — they do NOT include the
**procedurally-baked scenery** that the renderer ALSO places via the
Rust Scenery.Load port. Expect `placements.diff()` to report a
`scenery-count-mismatch` of ~150-200 in any populated LB. Resolving
that is Wave 2.B2 (extend `dump-lb-expectations` with the baked-scenery
manifest from `holtburger-scenery-bake`).

## What's committed vs generated

`0xA9B40000.json` (Holtburg) is checked in as a reference sample.
Additional LB oracles you generate locally should NOT be committed by
default — they're regenerable from the same DAT inputs via WB.Terminal.
