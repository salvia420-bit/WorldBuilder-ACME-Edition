# data/chorizite/ — Vendored Chorizite oracle dumps

Three JSON files baked from the vendored Chorizite C# stack
(`external/chorizite/`) by WorldBuilder.Terminal commands. The browser
plugins (`plugins/world-objects/`, `plugins/combat-bar/`, etc.) consume
these directly via `fetch()`; the Rust crates' parity tests
(`crates/holtburger-protocol/tests/opcode_parity.rs` etc.) read them at
test time. Re-generate after touching either Chorizite vendoring or the
WB.Terminal dump commands.

## Files

| File | Bake command | Source |
|---|---|---|
| `chorizite-acprotocol-opcodes.json` | `chorizite-dump-opcodes` | `Chorizite.ACProtocol/Enums/*.generated.cs` |
| `chorizite-common-enums.json` | `chorizite-dump-enum-values` | `Chorizite.Common.Enums.*` (all 65) + `ObjectDescriptionFlag` from ACProtocol |
| `world-object-taxonomy.json` | `chorizite-dump-world-object-taxonomy` | `ACPlugin/API/WorldObjects/*.cs` |

## Regenerating `chorizite-common-enums.json`

WB.Terminal emits an array-shaped envelope; the consumer
(`plugins/world-objects/enums.js`) expects an object keyed by enum name. A
small Python shim transforms the response. Recipe:

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition

# 1. Ensure WB.Terminal is built.
dotnet build WorldBuilder.Terminal -c Release

# 2. Dump + transform.
(echo '{"command":"chorizite-dump-enum-values"}'; sleep 0.3) \
  | dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin \
  | tail -1 \
  | python3 -c "
import sys, json
from datetime import datetime, timezone
data = json.loads(sys.stdin.read())
out = {
    'generatedBy': 'WorldBuilder.Terminal chorizite-dump-enum-values (Wave 2.C — all 65 Chorizite.Common enums + ObjectDescriptionFlag)',
    'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
    'source': 'Chorizite.Common assembly (vendored at external/chorizite/Chorizite.Common/) + Chorizite.ACProtocol/Enums/ObjectDescriptionFlag.generated.cs',
    'enums': { e['name']: { 'name': e['name'], 'underlyingType': e['underlyingType'], 'isFlags': e['isFlags'], 'memberCount': e['memberCount'], 'members': e['members'] } for e in data['enums'] }
}
print(json.dumps(out, indent=2, ensure_ascii=False))
" > external/holtburger/apps/holtburger-web/data/chorizite/chorizite-common-enums.json

# 3. Sanity-check.
python3 -c "import json; d=json.load(open('external/holtburger/apps/holtburger-web/data/chorizite/chorizite-common-enums.json')); print('enums:', len(d['enums']))"
# expect 66 (65 Chorizite.Common + 1 ACProtocol ObjectDescriptionFlag)
```

## Regenerating `chorizite-acprotocol-opcodes.json`

The opcode dump writes directly via WB.Terminal:

```bash
echo '{"command":"chorizite-dump-opcodes"}' \
  | dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin
# Writes to external/holtburger/apps/holtburger-web/data/chorizite/chorizite-acprotocol-opcodes.json
```

## Regenerating `world-object-taxonomy.json`

```bash
echo '{"command":"chorizite-dump-world-object-taxonomy"}' \
  | dotnet WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll --stdin \
  | tail -1 \
  | jq '{vendoredHead, classes}' \
  > external/holtburger/apps/holtburger-web/data/chorizite/world-object-taxonomy.json
```

(`jq` strips the `success`/`command`/`count` envelope keys; the consumer
expects the bare `vendoredHead` + `classes` fields.)

## When to regenerate

Any time the upstream Chorizite vendoring is bumped, OR when the
WB.Terminal absorption layer is extended:

- `chorizite-acprotocol-opcodes.json` → after Chorizite.ACProtocol bumps,
  or when the `CommandEngine.ChoriziteDumpOpcodes` target enum list grows.
- `chorizite-common-enums.json` → after Chorizite.Common bumps,
  or when `CommandEngine.Chorizite.CuratedEnumAllowlist` changes.
- `world-object-taxonomy.json` → after Chorizite.ACPlugin bumps, or when
  the `ACPlugin/API/WorldObjects/*.cs` set changes (new class added).

## Source of truth

All three files are baked from the vendored manifest at
`external/chorizite/VENDORED.md`. If you change vendored versions, update
both the manifest sha + re-bake these JSON files in the same commit.
