#!/usr/bin/env python3
"""
WorldBuilder.Terminal — Agent Protocol Integration Tests
=========================================================

Tests the --stdin JSON-line protocol by spawning the WorldBuilder.Terminal
process and piping JSON commands through stdin, then validating the JSON
responses on stdout.

Prerequisites:
  - .NET SDK installed
  - WorldBuilder.Terminal builds successfully
  - projects/TestProject/TestProject.wbproj present with DAT files

Usage:
  python tests/test_agent_protocol.py                   # Run all tests
  python tests/test_agent_protocol.py -v                # Verbose output
  python tests/test_agent_protocol.py -k test_load      # Run specific test
  python tests/test_agent_protocol.py --binary <path>   # Use prebuilt binary

The test runner discovers all test_* methods and runs them in dependency
order. Tests that require a loaded project are grouped separately from
protocol-level tests.
"""

import json
import os
import subprocess
import sys
import time
import unittest
from pathlib import Path
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────

# Resolve paths relative to this script
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
TERMINAL_PROJECT = REPO_ROOT / "WorldBuilder.Terminal"
TEST_PROJECT = REPO_ROOT / "projects" / "TestProject" / "TestProject.wbproj"

# Allow overriding the binary path via env var or CLI arg
BINARY_PATH = os.environ.get("WORLDBUILDER_BINARY", None)

# Timeout for process operations (seconds)
STARTUP_TIMEOUT = 30
COMMAND_TIMEOUT = 15


# ─────────────────────────────────────────────────────────────
# Terminal Process Wrapper
# ─────────────────────────────────────────────────────────────

class TerminalSession:
    """
    Manages a WorldBuilder.Terminal process in --stdin mode.
    Provides send/receive helpers for the JSON-line protocol.
    """

    def __init__(self, project_path: Optional[str] = None, extra_args: list[str] = None):
        self.project_path = project_path
        self.extra_args = extra_args or []
        self.proc: Optional[subprocess.Popen] = None
        self._startup_response: Optional[dict] = None

    def start(self) -> dict:
        """Start the terminal process and return the 'ready' message."""
        cmd = self._build_command()
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,  # Line-buffered
        )

        # Read the initial "ready" response
        self._startup_response = self._read_response(timeout=STARTUP_TIMEOUT)
        return self._startup_response

    def send(self, command: dict) -> dict:
        """Send a JSON command and return the parsed response."""
        if self.proc is None or self.proc.poll() is not None:
            raise RuntimeError("Terminal process is not running")

        line = json.dumps(command, separators=(",", ":"))
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()
        return self._read_response(timeout=COMMAND_TIMEOUT)

    def send_raw(self, raw_line: str) -> dict:
        """Send a raw string line (for testing malformed input)."""
        if self.proc is None or self.proc.poll() is not None:
            raise RuntimeError("Terminal process is not running")

        self.proc.stdin.write(raw_line + "\n")
        self.proc.stdin.flush()
        return self._read_response(timeout=COMMAND_TIMEOUT)

    def send_blank(self):
        """Send a blank line (should be silently consumed)."""
        if self.proc is None:
            raise RuntimeError("Terminal process is not running")
        self.proc.stdin.write("\n")
        self.proc.stdin.flush()

    def close(self):
        """Close stdin (triggers EOF exit) and wait for process to end."""
        if self.proc:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            try:
                self.proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()

    def quit(self) -> dict:
        """Send the quit command and return its response."""
        response = self.send({"command": "quit"})
        if self.proc:
            self.proc.wait(timeout=5)
        return response

    @property
    def startup_response(self) -> dict:
        return self._startup_response or {}

    def _build_command(self) -> list[str]:
        if BINARY_PATH:
            cmd = [BINARY_PATH, "--stdin"]
        else:
            cmd = ["dotnet", "run", "--project", str(TERMINAL_PROJECT), "--", "--stdin"]

        if self.project_path:
            cmd.extend(["--project", str(self.project_path)])

        cmd.extend(self.extra_args)
        return cmd

    def _read_response(self, timeout: float = COMMAND_TIMEOUT) -> dict:
        """Read one JSON line from stdout with timeout."""
        import select
        import threading

        result: dict = {}
        error: Optional[Exception] = None

        def reader():
            nonlocal result, error
            try:
                line = self.proc.stdout.readline()
                if not line:
                    error = RuntimeError(
                        f"Process exited unexpectedly (code {self.proc.poll()}). "
                        f"stderr: {self.proc.stderr.read()}"
                    )
                    return
                line = line.strip()
                if not line:
                    error = RuntimeError("Received empty line from stdout")
                    return
                result = json.loads(line)
            except json.JSONDecodeError as e:
                error = RuntimeError(f"Invalid JSON from stdout: {line!r} — {e}")
            except Exception as e:
                error = e

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        t.join(timeout=timeout)

        if t.is_alive():
            # Timeout — kill the process
            self.proc.kill()
            raise TimeoutError(f"No response within {timeout}s")

        if error:
            raise error

        return result


# ─────────────────────────────────────────────────────────────
# Test Helpers
# ─────────────────────────────────────────────────────────────

def assert_success(response: dict, expected_command: str):
    """Assert that a response indicates success with the expected command name."""
    assert response.get("success") is True, \
        f"Expected success=true, got: {json.dumps(response, indent=2)}"
    assert response.get("command") == expected_command, \
        f"Expected command='{expected_command}', got: '{response.get('command')}'"


def assert_failure(response: dict, expected_command: Optional[str] = None):
    """Assert that a response indicates failure."""
    assert response.get("success") is False, \
        f"Expected success=false, got: {json.dumps(response, indent=2)}"
    assert "error" in response, \
        f"Expected 'error' field in failure response: {json.dumps(response, indent=2)}"
    if expected_command:
        assert response.get("command") == expected_command, \
            f"Expected command='{expected_command}', got: '{response.get('command')}'"


def assert_has_fields(response: dict, *fields: str):
    """Assert that a response contains all specified fields."""
    for field in fields:
        assert field in response, \
            f"Missing field '{field}' in response: {json.dumps(response, indent=2)}"


# ─────────────────────────────────────────────────────────────
# Test Suite 1: Protocol-Level Tests (No project required)
# ─────────────────────────────────────────────────────────────

class TestProtocol(unittest.TestCase):
    """Tests for the JSON-line protocol mechanics — startup, error handling,
    malformed input, unknown commands, and session lifecycle."""

    def setUp(self):
        self.session = TerminalSession()

    def tearDown(self):
        if self.session:
            self.session.close()

    def test_01_startup_ready_message(self):
        """The first line on stdout must be a 'ready' message."""
        ready = self.session.start()
        assert_success(ready, "ready")
        assert_has_fields(ready, "version", "message")
        self.assertIn("ready", ready["message"].lower())

    def test_02_startup_version_format(self):
        """The version field should be a dotted version string."""
        ready = self.session.start()
        version = ready.get("version", "")
        parts = version.split(".")
        self.assertGreaterEqual(len(parts), 2, f"Version '{version}' should have at least 2 parts")
        for part in parts:
            self.assertTrue(part.isdigit(), f"Version part '{part}' should be numeric")

    def test_03_unknown_command(self):
        """An unknown command should return success=false with an error message."""
        self.session.start()
        resp = self.session.send({"command": "nonexistent_command_xyz"})
        assert_failure(resp, "nonexistent_command_xyz")
        self.assertIn("unknown", resp["error"].lower())

    def test_04_missing_command_field(self):
        """A JSON object without a 'command' field should return parse_error."""
        self.session.start()
        resp = self.session.send({"action": "load", "path": "test.wbproj"})
        assert_failure(resp, "parse_error")
        self.assertIn("command", resp["error"].lower())

    def test_05_invalid_json(self):
        """Malformed JSON should return parse_error."""
        self.session.start()
        resp = self.session.send_raw("{this is not valid json}")
        assert_failure(resp, "parse_error")

    def test_06_empty_json_object(self):
        """An empty JSON object {} should return parse_error (no command)."""
        self.session.start()
        resp = self.session.send({})
        assert_failure(resp, "parse_error")

    def test_07_blank_lines_skipped(self):
        """Blank lines should be silently consumed, not produce responses."""
        self.session.start()

        # Send blank lines then a real command
        self.session.send_blank()
        self.session.send_blank()
        self.session.send_blank()

        # The next command should work — the blanks didn't queue error responses
        resp = self.session.send({"command": "info"})
        assert_success(resp, "info")

    def test_08_case_insensitive_commands(self):
        """Command names should be case-insensitive."""
        self.session.start()
        resp = self.session.send({"command": "INFO"})
        assert_success(resp, "info")

    def test_09_quit_command(self):
        """The 'quit' command should return success and terminate the session."""
        self.session.start()
        resp = self.session.quit()
        assert_success(resp, "quit")

        # Process should be terminated
        self.session.proc.wait(timeout=5)
        self.assertIsNotNone(self.session.proc.returncode)

    def test_10_exit_command(self):
        """The 'exit' command should work identically to 'quit'."""
        self.session.start()
        resp = self.session.send({"command": "exit"})
        assert_success(resp, "exit")

    def test_11_help_command(self):
        """The 'help' command should return a list of available commands."""
        self.session.start()
        resp = self.session.send({"command": "help"})
        assert_success(resp, "help")
        assert_has_fields(resp, "commands")
        self.assertIsInstance(resp["commands"], list)
        self.assertGreater(len(resp["commands"]), 10,
                           "Help should list at least 10 commands")

    def test_12_info_no_project(self):
        """'info' with no project loaded should return loaded=false."""
        self.session.start()
        resp = self.session.send({"command": "info"})
        assert_success(resp, "info")
        self.assertFalse(resp.get("loaded", True))

    def test_13_command_before_load_fails(self):
        """Terrain/object commands should fail if no project is loaded."""
        self.session.start()
        commands_requiring_project = [
            {"command": "get-height", "x": 0, "y": 0},
            {"command": "terrain-info", "lbX": 0, "lbY": 0},
            {"command": "list-objects", "lbX": 0, "lbY": 0},
            {"command": "smooth", "x": 0, "y": 0, "radius": 24},
            {"command": "get-world-info"},
            {"command": "get-region"},
        ]
        for cmd in commands_requiring_project:
            resp = self.session.send(cmd)
            assert_failure(resp, cmd["command"]),
            f"Command '{cmd['command']}' should fail without a loaded project"

    def test_14_load_nonexistent_path(self):
        """Loading a nonexistent project should return an error."""
        self.session.start()
        resp = self.session.send({
            "command": "load",
            "path": "C:\\nonexistent\\fake\\project.wbproj"
        })
        assert_failure(resp, "load")

    def test_15_load_missing_path_param(self):
        """'load' without a 'path' parameter should return an error."""
        self.session.start()
        resp = self.session.send({"command": "load"})
        assert_failure(resp, "load")

    def test_16_response_is_single_line(self):
        """Every response should be exactly one line (no embedded newlines)."""
        self.session.start()

        # Send multiple commands and verify each response is a single line
        commands = [
            {"command": "info"},
            {"command": "help"},
            {"command": "nonexistent"},
        ]
        for cmd in commands:
            line = json.dumps(cmd, separators=(",", ":"))
            self.session.proc.stdin.write(line + "\n")
            self.session.proc.stdin.flush()
            raw_line = self.session.proc.stdout.readline().strip()
            self.assertFalse("\n" in raw_line,
                             f"Response contains newline: {raw_line[:200]}...")

    def test_17_eof_terminates_process(self):
        """Closing stdin (EOF) should terminate the process."""
        self.session.start()
        self.session.proc.stdin.close()
        self.session.proc.wait(timeout=5)
        self.assertIsNotNone(self.session.proc.returncode)

    def test_18_rapid_fire_commands(self):
        """Multiple commands sent in rapid succession should all get responses."""
        self.session.start()
        count = 20
        for i in range(count):
            resp = self.session.send({"command": "info"})
            assert_success(resp, "info")

    def test_19_extra_fields_ignored(self):
        """Extra fields in the command JSON should be silently ignored."""
        self.session.start()
        resp = self.session.send({
            "command": "info",
            "extra_field_1": "hello",
            "extra_field_2": 42,
            "nested": {"a": 1}
        })
        assert_success(resp, "info")


# ─────────────────────────────────────────────────────────────
# Test Suite 2: Project Commands (Require TestProject)
# ─────────────────────────────────────────────────────────────

@unittest.skipUnless(TEST_PROJECT.exists(),
                     f"TestProject not found at {TEST_PROJECT}")
class TestProjectCommands(unittest.TestCase):
    """Tests that require a loaded project. Skipped if TestProject is missing."""

    @classmethod
    def setUpClass(cls):
        """Start a session and load the test project for all tests."""
        cls.session = TerminalSession()
        cls.session.start()
        cls.load_response = cls.session.send({
            "command": "load",
            "path": str(TEST_PROJECT)
        })

    @classmethod
    def tearDownClass(cls):
        if cls.session:
            try:
                cls.session.quit()
            except Exception:
                cls.session.close()

    def test_01_load_success(self):
        """Loading TestProject should succeed and return project metadata."""
        assert_success(self.load_response, "load")
        assert_has_fields(self.load_response,
                          "projectName", "projectFile", "projectDir", "datDirectory")

    def test_02_info_after_load(self):
        """'info' after load should return loaded=true with project details."""
        resp = self.session.send({"command": "info"})
        assert_success(resp, "info")
        self.assertTrue(resp.get("loaded"))
        assert_has_fields(resp, "projectName", "projectFile", "datDirectory")

    def test_03_get_world_info(self):
        """'get-world-info' should return world dimensions and metadata."""
        resp = self.session.send({"command": "get-world-info"})
        assert_success(resp, "get-world-info")
        # Should have world dimension info
        assert_has_fields(resp, "landblockSize")
        self.assertEqual(resp["landblockSize"], 192,
                         "Landblock size should always be 192")

    def test_04_get_region(self):
        """'get-region' should return height table and terrain type names."""
        resp = self.session.send({"command": "get-region"})
        assert_success(resp, "get-region")
        assert_has_fields(resp, "heightTable", "terrainTypes")
        self.assertIsInstance(resp["heightTable"], list)
        self.assertGreater(len(resp["heightTable"]), 0)
        self.assertIsInstance(resp["terrainTypes"], list)

    def test_05_list_landblocks(self):
        """'list-landblocks' should return an array of landblock summaries."""
        resp = self.session.send({
            "command": "list-landblocks",
            "limit": 5
        })
        assert_success(resp, "list-landblocks")
        assert_has_fields(resp, "landblocks")
        self.assertIsInstance(resp["landblocks"], list)
        # Should return at most 'limit' items
        self.assertLessEqual(len(resp["landblocks"]), 5)

    def test_06_list_landblocks_with_range(self):
        """'list-landblocks' with a range should filter results."""
        resp = self.session.send({
            "command": "list-landblocks",
            "minX": 0, "minY": 0, "maxX": 10, "maxY": 10,
            "limit": 100
        })
        assert_success(resp, "list-landblocks")
        assert_has_fields(resp, "landblocks")

    def test_10_terrain_info(self):
        """'terrain-info' should return stats or found=false for a valid landblock."""
        resp = self.session.send({"command": "terrain-info", "lbX": 100, "lbY": 100})
        assert_success(resp, "terrain-info")
        assert_has_fields(resp, "found", "landblock")

    def test_11_get_heightmap(self):
        """'get-heightmap' should return 9x9 grids."""
        resp = self.session.send({"command": "get-heightmap", "lbX": 100, "lbY": 100})
        assert_success(resp, "get-heightmap")
        assert_has_fields(resp, "found", "landblock")

        if resp.get("found"):
            assert_has_fields(resp, "gridSize", "cellSize", "heightsWorld", "heightIndices")
            self.assertEqual(resp["gridSize"], 9)
            self.assertEqual(resp["cellSize"], 24)
            self.assertEqual(len(resp["heightsWorld"]), 9)
            self.assertEqual(len(resp["heightIndices"]), 9)
            for row in resp["heightsWorld"]:
                self.assertEqual(len(row), 9, "Each height row should have 9 columns")

    def test_12_get_terrain_data(self):
        """'get-terrain-data' should return 81 vertex records."""
        resp = self.session.send({"command": "get-terrain-data", "lbX": 100, "lbY": 100})
        assert_success(resp, "get-terrain-data")
        assert_has_fields(resp, "found", "landblock")

        if resp.get("found"):
            assert_has_fields(resp, "vertexCount", "vertices")
            self.assertEqual(resp["vertexCount"], 81)
            self.assertEqual(len(resp["vertices"]), 81)

            # Validate vertex shape
            v = resp["vertices"][0]
            assert_has_fields(v, "index", "gridX", "gridY",
                              "heightIndex", "heightWorld", "terrainType", "road")

    def test_13_get_height(self):
        """'get-height' should return height data at a world position."""
        resp = self.session.send({"command": "get-height", "x": 19200.0, "y": 19200.0})
        assert_success(resp, "get-height")
        assert_has_fields(resp, "x", "y", "height", "heightIndex",
                          "terrainType", "landblock")

    def test_14_get_height_invalid_coords(self):
        """'get-height' with out-of-bounds coordinates should fail gracefully."""
        resp = self.session.send({"command": "get-height", "x": -1.0, "y": -1.0})
        # Could be error or success with boundary clamping — just verify valid JSON
        self.assertIn("success", resp)

    def test_20_list_objects(self):
        """'list-objects' should return an objects array."""
        resp = self.session.send({"command": "list-objects", "lbX": 100, "lbY": 100})
        assert_success(resp, "list-objects")
        assert_has_fields(resp, "landblock", "count", "objects")
        self.assertIsInstance(resp["objects"], list)

        if resp["count"] > 0:
            obj = resp["objects"][0]
            assert_has_fields(obj, "index", "modelId", "type", "x", "y", "z")
            # modelId should be hex formatted
            self.assertTrue(obj["modelId"].startswith("0x"),
                            f"modelId should be hex: {obj['modelId']}")

    def test_21_add_remove_object_roundtrip(self):
        """Add an object, verify it appears in list, then remove it."""
        LBX, LBY = 100, 100

        # Get initial count
        list_before = self.session.send({"command": "list-objects", "lbX": LBX, "lbY": LBY})
        assert_success(list_before, "list-objects")
        count_before = list_before["count"]

        # Add an object
        add_resp = self.session.send({
            "command": "add-object",
            "lbX": LBX, "lbY": LBY,
            "modelId": "0x02000001",
            "x": LBX * 192 + 96.0,
            "y": LBY * 192 + 96.0,
            "z": 0.0
        })
        assert_success(add_resp, "add-object")
        assert_has_fields(add_resp, "index", "modelId", "landblock")
        new_index = add_resp["index"]

        # Verify count increased
        list_after = self.session.send({"command": "list-objects", "lbX": LBX, "lbY": LBY})
        assert_success(list_after, "list-objects")
        self.assertEqual(list_after["count"], count_before + 1)

        # Remove the object we just added
        remove_resp = self.session.send({
            "command": "remove-object",
            "lbX": LBX, "lbY": LBY,
            "index": new_index
        })
        assert_success(remove_resp, "remove-object")
        assert_has_fields(remove_resp, "removedModelId")

        # Verify count is back to original
        list_final = self.session.send({"command": "list-objects", "lbX": LBX, "lbY": LBY})
        assert_success(list_final, "list-objects")
        self.assertEqual(list_final["count"], count_before)

    def test_22_move_object(self):
        """Add an object, move it, verify new position, then clean up."""
        LBX, LBY = 100, 100
        origin_x = LBX * 192 + 50.0
        origin_y = LBY * 192 + 50.0
        new_x = LBX * 192 + 100.0
        new_y = LBY * 192 + 100.0

        # Add
        add_resp = self.session.send({
            "command": "add-object",
            "lbX": LBX, "lbY": LBY,
            "modelId": "0x02000001",
            "x": origin_x, "y": origin_y, "z": 0.0
        })
        assert_success(add_resp, "add-object")
        idx = add_resp["index"]

        # Move
        move_resp = self.session.send({
            "command": "move-object",
            "lbX": LBX, "lbY": LBY,
            "index": idx,
            "x": new_x, "y": new_y, "z": 10.0
        })
        assert_success(move_resp, "move-object")
        assert_has_fields(move_resp, "from", "to")
        self.assertAlmostEqual(move_resp["to"]["x"], new_x, places=1)
        self.assertAlmostEqual(move_resp["to"]["y"], new_y, places=1)

        # Clean up
        self.session.send({"command": "remove-object", "lbX": LBX, "lbY": LBY, "index": idx})

    def test_23_rotate_object_quaternion(self):
        """Rotate an object using quaternion values."""
        LBX, LBY = 100, 100
        add_resp = self.session.send({
            "command": "add-object",
            "lbX": LBX, "lbY": LBY,
            "modelId": "0x02000001",
            "x": LBX * 192 + 50.0, "y": LBY * 192 + 50.0, "z": 0.0
        })
        assert_success(add_resp, "add-object")
        idx = add_resp["index"]

        # Rotate 90° around Z
        rot_resp = self.session.send({
            "command": "rotate-object",
            "lbX": LBX, "lbY": LBY,
            "index": idx,
            "qw": 0.707107, "qx": 0.0, "qy": 0.0, "qz": 0.707107
        })
        assert_success(rot_resp, "rotate-object")
        assert_has_fields(rot_resp, "oldOrientation", "newOrientation")
        new_q = rot_resp["newOrientation"]
        self.assertAlmostEqual(new_q["w"], 0.707107, places=3)
        self.assertAlmostEqual(new_q["z"], 0.707107, places=3)

        # Clean up
        self.session.send({"command": "remove-object", "lbX": LBX, "lbY": LBY, "index": idx})

    def test_24_rotate_object_yaw(self):
        """Rotate an object using the yaw shorthand."""
        LBX, LBY = 100, 100
        add_resp = self.session.send({
            "command": "add-object",
            "lbX": LBX, "lbY": LBY,
            "modelId": "0x02000001",
            "x": LBX * 192 + 50.0, "y": LBY * 192 + 50.0, "z": 0.0
        })
        assert_success(add_resp, "add-object")
        idx = add_resp["index"]

        rot_resp = self.session.send({
            "command": "rotate-object",
            "lbX": LBX, "lbY": LBY,
            "index": idx,
            "yaw": 180.0
        })
        assert_success(rot_resp, "rotate-object")
        assert_has_fields(rot_resp, "newOrientation")

        # Clean up
        self.session.send({"command": "remove-object", "lbX": LBX, "lbY": LBY, "index": idx})

    def test_25_query_radius(self):
        """'query-radius' should return objects within the search area."""
        resp = self.session.send({
            "command": "query-radius",
            "x": 19200.0, "y": 19200.0,
            "radius": 500.0
        })
        assert_success(resp, "query-radius")
        assert_has_fields(resp, "totalFound", "objects", "center", "radius")
        self.assertIsInstance(resp["objects"], list)

    def test_30_terrain_smooth(self):
        """'smooth' should modify vertices and report which landblocks changed."""
        resp = self.session.send({
            "command": "smooth",
            "x": 19200.0, "y": 19200.0,
            "radius": 48.0,
            "strength": 0.5
        })
        assert_success(resp, "smooth")
        assert_has_fields(resp, "verticesModified", "landblocks")
        self.assertIsInstance(resp["landblocks"], list)

    def test_31_terrain_raise(self):
        """'raise' should increase terrain height within radius."""
        resp = self.session.send({
            "command": "raise",
            "x": 19200.0, "y": 19200.0,
            "radius": 24.0,
            "delta": 5
        })
        assert_success(resp, "raise")
        assert_has_fields(resp, "verticesModified", "delta", "landblocks")

    def test_32_terrain_lower(self):
        """'lower' should decrease terrain height."""
        resp = self.session.send({
            "command": "lower",
            "x": 19200.0, "y": 19200.0,
            "radius": 24.0,
            "delta": 5
        })
        assert_success(resp, "lower")
        assert_has_fields(resp, "verticesModified", "delta", "landblocks")

    def test_33_terrain_set_height(self):
        """'set-height' should set all vertices in radius to exact height."""
        resp = self.session.send({
            "command": "set-height",
            "x": 19200.0, "y": 19200.0,
            "radius": 24.0,
            "height": 128
        })
        assert_success(resp, "set-height")
        assert_has_fields(resp, "verticesModified", "targetHeight", "landblocks")
        self.assertEqual(resp["targetHeight"], 128)

    def test_34_terrain_paint(self):
        """'paint' should change terrain type within radius."""
        resp = self.session.send({
            "command": "paint",
            "x": 19200.0, "y": 19200.0,
            "radius": 24.0,
            "type": 3
        })
        assert_success(resp, "paint")
        assert_has_fields(resp, "verticesModified", "terrainType", "landblocks")

    def test_35_terrain_fill(self):
        """'fill' should flood-fill terrain type."""
        resp = self.session.send({
            "command": "fill",
            "x": 19200.0, "y": 19200.0,
            "type": 2
        })
        assert_success(resp, "fill")
        assert_has_fields(resp, "verticesModified", "terrainType", "landblocks")

    def test_36_road(self):
        """'road' should draw a road between two points."""
        resp = self.session.send({
            "command": "road",
            "x1": 19200.0, "y1": 19200.0,
            "x2": 19392.0, "y2": 19392.0,
            "value": 1
        })
        assert_success(resp, "road")
        assert_has_fields(resp, "waypoints", "verticesModified", "roadValue", "landblocks")

    def test_40_validate_landblock(self):
        """'validate-landblock' should return a ValidationReport."""
        resp = self.session.send({"command": "validate-landblock", "lbX": 100, "lbY": 100})
        assert_success(resp, "validate-landblock")
        assert_has_fields(resp, "isValid", "errorCount", "warningCount",
                          "infoCount", "diagnostics")
        self.assertIsInstance(resp["diagnostics"], list)

    def test_41_validate_terrain(self):
        """'validate-terrain' should return a ValidationReport."""
        resp = self.session.send({"command": "validate-terrain", "lbX": 100, "lbY": 100})
        assert_success(resp, "validate-terrain")
        assert_has_fields(resp, "isValid", "diagnostics")

    def test_42_validate_dungeon(self):
        """'validate-dungeon' should return a ValidationReport."""
        resp = self.session.send({"command": "validate-dungeon", "lbX": 100, "lbY": 100})
        assert_success(resp, "validate-dungeon")
        assert_has_fields(resp, "isValid", "diagnostics")

    def test_43_validate_building_portals(self):
        """'validate-building-portals' should return a ValidationReport."""
        resp = self.session.send({
            "command": "validate-building-portals",
            "lbX": 100, "lbY": 100
        })
        assert_success(resp, "validate-building-portals")
        assert_has_fields(resp, "isValid", "diagnostics")

    def test_44_validate_all(self):
        """'validate-all' should run all validators and return combined report."""
        resp = self.session.send({"command": "validate-all", "lbX": 100, "lbY": 100})
        assert_success(resp, "validate-all")
        assert_has_fields(resp, "isValid", "errorCount", "warningCount",
                          "infoCount", "diagnostics")

    def test_45_validation_diagnostic_shape(self):
        """Each diagnostic in a validation report should have severity, code, message."""
        resp = self.session.send({"command": "validate-all", "lbX": 100, "lbY": 100})
        assert_success(resp, "validate-all")

        for diag in resp.get("diagnostics", []):
            assert_has_fields(diag, "severity", "code", "message")
            self.assertIn(diag["severity"], ("error", "warning", "info"),
                          f"Invalid severity: {diag['severity']}")
            # Diagnostic codes follow XXXNNN pattern
            self.assertGreaterEqual(len(diag["code"]), 4,
                                    f"Invalid code: {diag['code']}")

    def test_50_dungeon_info(self):
        """'get-dungeon-info' should return dungeon cell data or hasDungeon=false."""
        resp = self.session.send({"command": "get-dungeon-info", "lbX": 100, "lbY": 100})
        assert_success(resp, "get-dungeon-info")
        assert_has_fields(resp, "landblock", "hasDungeon")

        if resp.get("hasDungeon"):
            assert_has_fields(resp, "cellCount", "cells")
            self.assertIsInstance(resp["cells"], list)


# ─────────────────────────────────────────────────────────────
# Test Suite 3: Startup with --project flag
# ─────────────────────────────────────────────────────────────

@unittest.skipUnless(TEST_PROJECT.exists(),
                     f"TestProject not found at {TEST_PROJECT}")
class TestStartupWithProject(unittest.TestCase):
    """Tests for spawning with --project to preload."""

    def test_01_preload_project_on_startup(self):
        """--stdin --project X should auto-load the project before 'ready'."""
        session = TerminalSession(project_path=str(TEST_PROJECT))
        try:
            ready = session.start()
            assert_success(ready, "ready")

            # Project should already be loaded — verify with 'info'
            resp = session.send({"command": "info"})
            assert_success(resp, "info")
            self.assertTrue(resp.get("loaded"))
            assert_has_fields(resp, "projectName")
        finally:
            session.close()


# ─────────────────────────────────────────────────────────────
# Test Suite 4: Serialization Contract
# ─────────────────────────────────────────────────────────────

class TestSerializationContract(unittest.TestCase):
    """Tests that verify the JSON serialization rules documented in the API spec."""

    def setUp(self):
        self.session = TerminalSession()
        self.session.start()

    def tearDown(self):
        self.session.close()

    def test_01_camelcase_properties(self):
        """Response fields should use camelCase naming."""
        resp = self.session.send({"command": "help"})
        # All top-level keys should be camelCase (no underscores, no PascalCase)
        for key in resp.keys():
            self.assertFalse(key[0].isupper(),
                             f"Key '{key}' should be camelCase, not PascalCase")

    def test_02_no_null_fields(self):
        """Null fields should be omitted entirely, not serialized as null."""
        resp = self.session.send({"command": "info"})
        raw_line = json.dumps(resp)
        # There shouldn't be literal null values
        self.assertNotIn(': null', raw_line)
        for key, value in resp.items():
            self.assertIsNotNone(value,
                                 f"Field '{key}' should be omitted if null, not present as None")

    def test_03_single_line_json(self):
        """Responses should not be indented (single-line JSON)."""
        # This is verified at the raw stdout level — one line per response
        cmd = json.dumps({"command": "info"}, separators=(",", ":"))
        self.session.proc.stdin.write(cmd + "\n")
        self.session.proc.stdin.flush()
        raw = self.session.proc.stdout.readline()
        self.assertEqual(raw.count("\n"), 1,
                         "Response should be exactly one line")


# ─────────────────────────────────────────────────────────────
# CLI entrypoint
# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Support --binary <path> argument
    if "--binary" in sys.argv:
        idx = sys.argv.index("--binary")
        if idx + 1 < len(sys.argv):
            BINARY_PATH = sys.argv[idx + 1]
            sys.argv.pop(idx)  # Remove --binary
            sys.argv.pop(idx)  # Remove <path>

    # Run the tests
    unittest.main(verbosity=2)
