# WorldBuilder.Terminal — Integration Tests

## Overview

These tests validate the `--stdin` JSON-line protocol used for agent ↔ terminal communication. They spawn the WorldBuilder.Terminal process, pipe JSON commands through stdin, and verify the structured JSON responses on stdout.

## Test Suites

### Python (`test_agent_protocol.py`)

Full integration test suite with **55+ tests** organized in 4 groups:

| Suite | Tests | Requires Project | Description |
|-------|-------|------------------|-------------|
| `TestProtocol` | 19 | ❌ | Protocol mechanics: startup, errors, malformed input, sessions |
| `TestProjectCommands` | 25 | ✅ | Terrain, objects, validation, spatial queries |
| `TestStartupWithProject` | 1 | ✅ | `--stdin --project` preloading |
| `TestSerializationContract` | 3 | ❌ | camelCase, no nulls, single-line JSON |

```powershell
# Run all tests
python tests/test_agent_protocol.py -v

# Run specific test group
python tests/test_agent_protocol.py -v -k TestProtocol

# Run with prebuilt binary (skip dotnet run)
python tests/test_agent_protocol.py --binary "bin\WorldBuilder.Terminal.exe"

# Via env var
$env:WORLDBUILDER_BINARY = "bin\WorldBuilder.Terminal.exe"
python tests/test_agent_protocol.py -v
```

### PowerShell (`Test-AgentProtocol.ps1`)

Quick smoke test (~25 checks) with colored output. Good for fast feedback:

```powershell
# Run with default settings
.\tests\Test-AgentProtocol.ps1

# Verbose (show all JSON payloads)
.\tests\Test-AgentProtocol.ps1 -ShowResponses

# With prebuilt binary
.\tests\Test-AgentProtocol.ps1 -Binary "bin\WorldBuilder.Terminal.exe"

# Custom project path
.\tests\Test-AgentProtocol.ps1 -ProjectPath "C:\MyWorld\project.wbproj"
```

## Prerequisites

1. **.NET SDK** — Must be installed to build and run WorldBuilder.Terminal
2. **TestProject** — `TestProject/TestProject.wbproj` with DAT files at `TestProject/dats/base/`
3. **Python 3.8+** — For the Python test suite (only stdlib, no pip dependencies)

## What These Tests Catch

- ✅ Startup handshake (ready message, version)
- ✅ JSON parsing errors (malformed input, missing fields)
- ✅ Unknown command handling
- ✅ Case sensitivity issues
- ✅ Session lifecycle (quit, exit, EOF)
- ✅ Blank line handling
- ✅ Extra field tolerance
- ✅ Response envelope shape (success/command/error)
- ✅ Serialization rules (camelCase, no nulls, single-line)
- ✅ Project load/info cycle
- ✅ Terrain read commands (get-height, heightmap, terrain-data)
- ✅ Terrain write commands (smooth, raise, lower, set-height, paint, fill, road)
- ✅ Object CRUD (add, list, move, rotate by quaternion/yaw, remove)
- ✅ Spatial queries (query-radius)
- ✅ All 5 validators (dungeon, landblock, terrain, building-portals, all)
- ✅ Validation diagnostic shape (severity, code, message)
- ✅ World observation (list-landblocks, get-world-info, get-region)
- ✅ Dungeon info queries
- ✅ Commands before project load → proper error
- ✅ Rapid-fire command handling (20 commands in sequence)

## Design Notes

- **No external dependencies** — Both tests use only stdlib (Python) or built-in cmdlets (PowerShell)
- **Process isolation** — Each test suite spawns its own process
- **Thread-based timeout** — Python tests use a reader thread to prevent hanging on broken output
- **Cleanup** — Object tests clean up after themselves (add then remove)
- **Graceful skip** — Project-dependent tests are auto-skipped if TestProject is missing
