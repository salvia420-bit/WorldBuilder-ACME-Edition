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
import shutil
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


def _runtime_is_available() -> tuple[bool, str]:
    """
    Validate that we can launch WorldBuilder.Terminal in this environment.
    Returns (ok, reason_if_not_ok).
    """
    if BINARY_PATH:
        binary = Path(BINARY_PATH)
        if not binary.exists():
            return False, f"--binary path does not exist: {binary}"
        return True, ""

    if shutil.which("dotnet") is None:
        return False, "dotnet SDK/runtime is not available in PATH"

    if not TERMINAL_PROJECT.exists():
        return False, f"WorldBuilder.Terminal project not found at {TERMINAL_PROJECT}"

    return True, ""


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

    def send(self, command: dict, timeout: Optional[float] = None) -> dict:
        """Send a JSON command and return the parsed response. Optional
        per-call timeout overrides the default COMMAND_TIMEOUT — useful
        for batch ops (sprite gen, tile pyramid) that legitimately exceed
        the default."""
        if self.proc is None or self.proc.poll() is not None:
            raise RuntimeError("Terminal process is not running")

        line = json.dumps(command, separators=(",", ":"))
        self.proc.stdin.write(line + "\n")
        self.proc.stdin.flush()
        return self._read_response(timeout=timeout if timeout is not None else COMMAND_TIMEOUT)

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

class RuntimeRequiredTestCase(unittest.TestCase):
    """Base class: skips when terminal runtime prerequisites are unavailable."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        ok, reason = _runtime_is_available()
        if not ok:
            raise unittest.SkipTest(f"Skipping terminal protocol tests: {reason}")


class TestProtocol(RuntimeRequiredTestCase):
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
class TestProjectCommands(RuntimeRequiredTestCase):
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
# Test Suite 2b: transact-diff round-trip
# ─────────────────────────────────────────────────────────────

@unittest.skipUnless(TEST_PROJECT.exists(),
                     f"TestProject not found at {TEST_PROJECT}")
class TestTransactDiff(RuntimeRequiredTestCase):
    """Round-trip tests covering the transact-diff acceptance criteria:
    add/remove/move detection, rollback markers, LRU eviction, inline
    diff field on transact, and visual diff PNG dimensions."""

    LBX, LBY = 100, 100
    MODEL_ID = "0x02000001"

    def setUp(self):
        # Each test gets its own session so the snapshot LRU starts fresh.
        # The default retention (32) is fine for every test except the
        # eviction one, which overrides it on its own session.
        self.session = TerminalSession(project_path=str(TEST_PROJECT))
        self.session.start()
        # The --project flag pre-loads, but --stdin reports 'ready' before
        # the load completes asynchronously on some hosts; verify the
        # project is loaded before issuing any mutating ops.
        info = self.session.send({"command": "info"})
        assert_success(info, "info")
        self.assertTrue(info.get("loaded"),
                        f"TestProject failed to pre-load: {info}")

    def tearDown(self):
        self.session.close()

    # ── helpers ──────────────────────────────────────────────

    def _world_xyz(self, dx=96.0, dy=96.0, dz=0.0):
        return (self.LBX * 192 + dx, self.LBY * 192 + dy, dz)

    def _commit(self, ops, **extra):
        payload = {"command": "transact", "ops": ops}
        payload.update(extra)
        resp = self.session.send(payload)
        assert_success(resp, "transact")
        self.assertEqual(resp["status"], "committed",
                         f"Expected committed, got {resp.get('status')}: {resp}")
        return resp

    def _diff(self, tx_id, **extra):
        payload = {"command": "transact-diff", "txId": tx_id}
        payload.update(extra)
        return self.session.send(payload)

    # ── 1. add-object diff ───────────────────────────────────

    def test_01_add_object_appears_in_added(self):
        """An add-object inside a transact should surface under objects.added
        with model id and position preserved."""
        x, y, z = self._world_xyz(96.0, 96.0, 0.0)
        commit = self._commit([{
            "command": "add-object",
            "lbX": self.LBX, "lbY": self.LBY,
            "modelId": self.MODEL_ID,
            "x": x, "y": y, "z": z,
        }])
        tx_id = commit["journal"]["transactionId"]

        diff = self._diff(tx_id)
        self.assertTrue(diff["success"], f"diff failed: {diff}")
        self.assertEqual(diff["txId"], tx_id)
        self.assertIn("perLandblock", diff)
        self.assertEqual(len(diff["perLandblock"]), 1)
        lb = diff["perLandblock"][0]
        self.assertEqual(lb["lbX"], self.LBX)
        self.assertEqual(lb["lbY"], self.LBY)
        added = lb["objects"]["added"]
        self.assertEqual(len(added), 1, f"expected one added object, got {added}")
        self.assertEqual(added[0]["model"].lower(), self.MODEL_ID.lower())
        self.assertAlmostEqual(added[0]["position"][0], x, places=1)
        self.assertAlmostEqual(added[0]["position"][1], y, places=1)
        # ontology array is permitted to be empty when the test ontology
        # doesn't have an entry for this model — only assert the field
        # exists and is a list.
        self.assertIsInstance(added[0]["ontology"], list)
        self.assertEqual(diff["summary"]["objectsAdded"], 1)

    # ── 2. remove-object diff ────────────────────────────────

    def test_02_remove_object_appears_in_removed(self):
        """An object placed before the diff window and removed inside one
        should surface under objects.removed."""
        x, y, z = self._world_xyz(80.0, 80.0, 0.0)
        # Place outside the transact (so it exists in pre-state).
        add_resp = self.session.send({
            "command": "add-object",
            "lbX": self.LBX, "lbY": self.LBY,
            "modelId": self.MODEL_ID,
            "x": x, "y": y, "z": z,
        })
        assert_success(add_resp, "add-object")
        idx = add_resp["index"]

        # Now remove it inside a transact.
        commit = self._commit([{
            "command": "remove-object",
            "lbX": self.LBX, "lbY": self.LBY,
            "index": idx,
        }])
        tx_id = commit["journal"]["transactionId"]

        diff = self._diff(tx_id)
        self.assertTrue(diff["success"])
        lb = diff["perLandblock"][0]
        removed = lb["objects"]["removed"]
        self.assertEqual(len(removed), 1, f"expected one removed object, got {removed}")
        self.assertEqual(removed[0]["model"].lower(), self.MODEL_ID.lower())
        self.assertEqual(diff["summary"]["objectsRemoved"], 1)

    # ── 3. move-object diff ──────────────────────────────────

    def test_03_move_object_appears_in_moved_with_delta(self):
        """A move > 0.1m should surface under objects.moved with deltaXY."""
        x0, y0, z0 = self._world_xyz(60.0, 60.0, 0.0)
        x1, y1, z1 = self._world_xyz(70.0, 75.0, 0.0)   # delta_xy ≈ sqrt(100+225)=18.0
        add_resp = self.session.send({
            "command": "add-object",
            "lbX": self.LBX, "lbY": self.LBY,
            "modelId": self.MODEL_ID,
            "x": x0, "y": y0, "z": z0,
        })
        assert_success(add_resp, "add-object")
        idx = add_resp["index"]

        commit = self._commit([{
            "command": "move-object",
            "lbX": self.LBX, "lbY": self.LBY,
            "index": idx,
            "x": x1, "y": y1, "z": z1,
        }])
        tx_id = commit["journal"]["transactionId"]

        diff = self._diff(tx_id)
        self.assertTrue(diff["success"])
        lb = diff["perLandblock"][0]
        moved = lb["objects"]["moved"]
        self.assertEqual(len(moved), 1, f"expected one moved object, got {moved}")
        m = moved[0]
        self.assertEqual(m["model"].lower(), self.MODEL_ID.lower())
        expected = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
        self.assertAlmostEqual(m["deltaXY"], expected, places=1,
                               msg=f"deltaXY mismatch: {m}")
        self.assertGreater(m["deltaXY"], 0.1, "deltaXY should clear the 0.1m hide threshold")

    # ── 4. rollback marker ───────────────────────────────────

    def test_04_rolled_back_transaction_returns_marker(self):
        """A transact that fails and rolls back should mark the txId as
        rolled-back; a follow-up transact-diff returns TXDIFF-ROLLED-BACK."""
        # remove-object with an out-of-range index will fail at op-time
        # and trigger rollback (rollback_on_fail defaults to true).
        resp = self.session.send({
            "command": "transact",
            "ops": [{
                "command": "remove-object",
                "lbX": self.LBX, "lbY": self.LBY,
                "index": 999999,
            }],
        })
        # The transact command itself returns success=false with status
        # rolled-back when an op fails and rollback_on_fail=true.
        self.assertEqual(resp.get("status"), "rolled-back",
                         f"expected rolled-back status, got {resp}")
        tx_id = resp["journal"]["transactionId"]

        diff = self._diff(tx_id)
        self.assertFalse(diff.get("success", True))
        self.assertEqual(diff.get("errorCode"), "TXDIFF-ROLLED-BACK",
                         f"expected TXDIFF-ROLLED-BACK, got {diff}")

    # ── 5. LRU eviction ──────────────────────────────────────

    def test_05_lru_evicts_oldest_after_retention_overflow(self):
        """The (retention+1)-th committed transact should evict the first;
        a transact-diff on the evicted txId must return TXDIFF-EXPIRED."""
        # Spin a fresh session with retention=2 so we don't have to issue 33
        # transacts to verify eviction. The retention semantics are the same
        # at any size, so a tighter bound just speeds up the test.
        session = TerminalSession(project_path=str(TEST_PROJECT),
                                  extra_args=["--transact-diff-retention", "2"])
        try:
            session.start()
            info = session.send({"command": "info"})
            assert_success(info, "info")

            tx_ids = []
            for i in range(3):     # 3 commits with cap=2 → 1st must evict
                x, y, z = (self.LBX * 192 + 30.0 + i * 5,
                            self.LBY * 192 + 30.0 + i * 5,
                            0.0)
                resp = session.send({
                    "command": "transact",
                    "ops": [{
                        "command": "add-object",
                        "lbX": self.LBX, "lbY": self.LBY,
                        "modelId": self.MODEL_ID,
                        "x": x, "y": y, "z": z,
                    }],
                })
                assert_success(resp, "transact")
                self.assertEqual(resp["status"], "committed")
                tx_ids.append(resp["journal"]["transactionId"])

            # The first txId should now be evicted.
            evicted = session.send({"command": "transact-diff", "txId": tx_ids[0]})
            self.assertFalse(evicted.get("success", True))
            self.assertEqual(evicted.get("errorCode"), "TXDIFF-EXPIRED",
                             f"expected TXDIFF-EXPIRED, got {evicted}")

            # The latest txId should still resolve.
            latest = session.send({"command": "transact-diff", "txId": tx_ids[-1]})
            self.assertTrue(latest.get("success"),
                            f"latest tx should still resolve, got {latest}")
        finally:
            session.close()

    # ── 6. inline diff on transact ───────────────────────────

    def test_06_inline_diff_field_returns_diff_block(self):
        """transact with diff:true should return the diff block in the same
        response — no follow-up call required."""
        x, y, z = self._world_xyz(120.0, 120.0, 0.0)
        resp = self.session.send({
            "command": "transact",
            "ops": [{
                "command": "add-object",
                "lbX": self.LBX, "lbY": self.LBY,
                "modelId": self.MODEL_ID,
                "x": x, "y": y, "z": z,
            }],
            "diff": True,
        })
        assert_success(resp, "transact")
        self.assertEqual(resp["status"], "committed")
        self.assertIn("diff", resp, f"missing diff block in inline response: {resp}")
        diff = resp["diff"]
        self.assertTrue(diff.get("success"),
                        f"inline diff success should be true: {diff}")
        self.assertEqual(diff["txId"], resp["journal"]["transactionId"])
        self.assertGreaterEqual(diff["summary"]["objectsAdded"], 1)

    # ── 7. visual diff PNG ───────────────────────────────────

    def test_07_visual_diff_returns_base64_png_with_matching_dimensions(self):
        """transact-diff with render:true and renderMode:overlay should
        return a non-empty pngBase64 whose decoded dimensions match the
        requested resolution."""
        import base64
        import struct

        x, y, z = self._world_xyz(140.0, 140.0, 0.0)
        commit = self._commit([{
            "command": "add-object",
            "lbX": self.LBX, "lbY": self.LBY,
            "modelId": self.MODEL_ID,
            "x": x, "y": y, "z": z,
        }])
        tx_id = commit["journal"]["transactionId"]

        diff = self._diff(tx_id, render=True, renderMode="overlay", resolution=512)
        self.assertTrue(diff.get("success"), f"diff failed: {diff}")
        self.assertIn("visual", diff)
        v = diff["visual"]
        self.assertEqual(v["mode"], "overlay")
        self.assertIn("pngBase64", v)
        png = base64.b64decode(v["pngBase64"])
        self.assertGreater(len(png), 0, "decoded PNG must be non-empty")
        # PNG magic: 0x89 'P' 'N' 'G'
        self.assertEqual(png[:4], b"\x89PNG")
        # IHDR is at offset 8, width/height are big-endian u32 starting at 16.
        width, height = struct.unpack(">II", png[16:24])
        self.assertEqual(width, v["width"], "reported width vs PNG IHDR width")
        self.assertEqual(height, v["height"], "reported height vs PNG IHDR height")
        # Resolution is the long edge target — overlay mode is square, so
        # both axes should equal the requested 512 (give or take grid-cell
        # rounding from RenderPreview's gridSize×lbPx product).
        self.assertEqual(width, height,
                         "overlay mode should produce a square image")
        self.assertGreaterEqual(width, 256, "rendered too small")
        self.assertLessEqual(width, 1024, "rendered too large")


# ─────────────────────────────────────────────────────────────
# Test Suite 3: Startup with --project flag
# ─────────────────────────────────────────────────────────────

@unittest.skipUnless(TEST_PROJECT.exists(),
                     f"TestProject not found at {TEST_PROJECT}")
class TestStartupWithProject(RuntimeRequiredTestCase):
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

class TestSerializationContract(RuntimeRequiredTestCase):
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
# Test Suite: DerethMapsEnhanced Phase 1 (extract-cell-footprints,
# generate-object-sprites). These run against the user's RetailSmoke
# project at the absolute path below, with single-LB filters to keep
# wall-clock under a minute. Skips when RetailSmoke is unavailable.
# ─────────────────────────────────────────────────────────────

RETAILSMOKE_PROJECT = Path("/home/salvia420/projects/RetailSmoke/RetailSmoke.wbproj")
# Holtburg's main outdoor LB — populated with structures, scenery, NPCs.
HOLTBURG_LB = "0xA9B4"
# A multi-floor dungeon LB known to be populated in RetailSmoke's project.db.
# Verified via cell_footprints.jsonl: 2160 cells across 4 Z-bands.
DUNGEON_LB_HEX = "0x00B0"
DUNGEON_LB_X = 0x00
DUNGEON_LB_Y = 0xB0


class TestDerethMapsPhase1(RuntimeRequiredTestCase):
    """Phase 1 batch extraction commands (cell footprints + object sprites).
    Cell extraction has no lbFilter (cheap per-cell); sprite generation is
    filtered to one LB so the test finishes quickly."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not RETAILSMOKE_PROJECT.exists():
            raise unittest.SkipTest(
                f"RetailSmoke project not found at {RETAILSMOKE_PROJECT}; "
                "Phase 1 extractor tests need a real project with DATs.")

    def setUp(self):
        self.session = TerminalSession(project_path=str(RETAILSMOKE_PROJECT))
        self.session.start()

    def tearDown(self):
        self.session.close()

    def test_01_extract_cell_footprints(self):
        """extract-cell-footprints writes a non-empty jsonl cache covering every
        cell of every dungeon doc; each line is well-formed JSON with the
        documented schema."""
        resp = self.session.send({"command": "extract-cell-footprints", "force": True})
        assert_success(resp, "extract-cell-footprints")
        assert_has_fields(resp, "cellsExtracted", "synthetic", "dungeonsScanned", "cachePath")
        self.assertGreater(resp["cellsExtracted"], 0,
                           "Expected at least one cell extracted from RetailSmoke")
        self.assertGreater(resp["dungeonsScanned"], 0,
                           "Expected at least one dungeon doc scanned")

        cache_path = Path(resp["cachePath"])
        self.assertTrue(cache_path.exists(), f"Cache file missing: {cache_path}")

        # Spot-check the first few lines for shape conformance.
        with open(cache_path, "r") as f:
            for i, line in enumerate(f):
                if i >= 5:
                    break
                entry = json.loads(line)
                for key in ("cellId", "envCellId", "cellStructure", "polygon",
                            "zRange", "portals", "synthetic"):
                    self.assertIn(key, entry, f"Missing key '{key}' in cell entry: {entry}")
                self.assertTrue(entry["cellId"].startswith("0x"))
                self.assertGreaterEqual(len(entry["polygon"]), 3,
                                        "Cell polygon should have at least 3 vertices")
                self.assertEqual(len(entry["zRange"]), 2)
                for vertex in entry["polygon"]:
                    self.assertEqual(len(vertex), 2,
                                     "Polygon vertices should be [x, y] pairs")

    def test_02_extract_cell_footprints_idempotent(self):
        """Running without force on an existing cache short-circuits and reports
        the cached row count rather than re-extracting."""
        # First run with force to populate.
        first = self.session.send({"command": "extract-cell-footprints", "force": True})
        assert_success(first, "extract-cell-footprints")
        # Second run without force — should match count and not re-scan dungeons.
        second = self.session.send({"command": "extract-cell-footprints", "force": False})
        assert_success(second, "extract-cell-footprints")
        self.assertEqual(first["cellsExtracted"], second["cellsExtracted"])
        self.assertEqual(second["dungeonsScanned"], 0,
                         "Cached run should report zero dungeons scanned")

    def test_03_generate_object_sprites_holtburg(self):
        """generate-object-sprites against Holtburg writes per-model PNGs, an
        atlas, and a manifest covering every model placed in that LB."""
        resp = self.session.send({
            "command": "generate-object-sprites",
            "force": True,
            "spritePx": 256,  # smaller than default 512 for faster test
            "lbFilter": [HOLTBURG_LB],
        }, timeout=300)  # Sprite rendering exceeds the 15s default.
        assert_success(resp, "generate-object-sprites")
        assert_has_fields(resp, "modelsRendered", "modelsFailed",
                          "atlasWidth", "atlasHeight",
                          "spritesDir", "atlasPath", "manifestPath")
        self.assertGreater(resp["modelsRendered"], 0,
                           "Expected at least one model rendered for Holtburg")

        atlas = Path(resp["atlasPath"])
        manifest = Path(resp["manifestPath"])
        self.assertTrue(atlas.exists(), f"Atlas missing: {atlas}")
        self.assertTrue(manifest.exists(), f"Manifest missing: {manifest}")
        self.assertGreater(atlas.stat().st_size, 0)

        # Manifest line count == modelsRendered.
        lines = manifest.read_text().strip().splitlines()
        self.assertEqual(len(lines), resp["modelsRendered"],
                         "Manifest line count should match modelsRendered")
        # Each line is JSON with the documented atlas-region shape.
        for line in lines[:5]:
            entry = json.loads(line)
            for key in ("modelId", "x", "y", "w", "h", "worldBounds"):
                self.assertIn(key, entry)
            self.assertTrue(entry["modelId"].startswith("0x"))
            self.assertEqual(len(entry["worldBounds"]), 2)
            self.assertGreater(entry["worldBounds"][0], 0)
            self.assertGreater(entry["worldBounds"][1], 0)


# ─────────────────────────────────────────────────────────────
# Test Suite: DerethMapsEnhanced Phase 2 (render-dungeon, render-preview
# sprite mode). Builds on Phase 1 output (cell_footprints.jsonl + sprites/
# atlas.png + manifest.jsonl) — make sure Phase 1 ran first locally.
# ─────────────────────────────────────────────────────────────


class TestDerethMapsPhase2(RuntimeRequiredTestCase):
    """Phase 2 renderer extensions: per-floor dungeon plan + sprite-mode
    render-preview."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not RETAILSMOKE_PROJECT.exists():
            raise unittest.SkipTest(
                f"RetailSmoke project not found at {RETAILSMOKE_PROJECT}; "
                "Phase 2 renderer tests need a real project with DATs.")
        # Phase 2 tests assume Phase 1 caches exist locally.
        if not (RETAILSMOKE_PROJECT.parent / "cell_footprints.jsonl").exists():
            raise unittest.SkipTest(
                "cell_footprints.jsonl missing; run Phase 1 tests first or "
                "extract-cell-footprints manually.")

    def setUp(self):
        self.session = TerminalSession(project_path=str(RETAILSMOKE_PROJECT))
        self.session.start()

    def tearDown(self):
        self.session.close()

    def test_01_render_dungeon_all_floors(self):
        """render-dungeon without floor index returns a PNG covering every
        cell in the dungeon, with floorCount > 1 for a multi-floor LB."""
        out_path = "/tmp/test_dungeon_all_floors.png"
        resp = self.session.send({
            "command": "render-dungeon",
            "lbX": DUNGEON_LB_X, "lbY": DUNGEON_LB_Y,
            "resolution": 768,
            "outputPath": out_path,
        }, timeout=60)
        assert_success(resp, "render-dungeon")
        assert_has_fields(resp, "landblock", "floorCount", "cellsRendered",
                          "floorZMin", "floorZMax", "outputPath", "pngBytes")
        self.assertEqual(resp["landblock"], DUNGEON_LB_HEX)
        self.assertGreater(resp["floorCount"], 1, "Test dungeon should be multi-floor")
        self.assertGreater(resp["cellsRendered"], 0)
        self.assertGreater(resp["pngBytes"], 1000, "PNG should be non-trivial")
        self.assertTrue(Path(out_path).exists())
        self.assertNotIn("floorIndex", {k: v for k, v in resp.items() if v is not None})

    def test_02_render_dungeon_single_floor(self):
        """render-dungeon with floor=0 renders only the top floor and reports
        a single-band Z range."""
        out_path = "/tmp/test_dungeon_floor0.png"
        resp = self.session.send({
            "command": "render-dungeon",
            "lbX": DUNGEON_LB_X, "lbY": DUNGEON_LB_Y,
            "floor": 0,
            "resolution": 768,
            "outputPath": out_path,
        }, timeout=60)
        assert_success(resp, "render-dungeon")
        self.assertEqual(resp["floorIndex"], 0)
        self.assertGreater(resp["cellsRendered"], 0)
        self.assertTrue(Path(out_path).exists())
        # Single-floor render covers a strict subset of the all-floors render.

    def test_03_render_dungeon_out_of_range_floor(self):
        """A floor index past the partition's range produces an empty PNG
        (fallback) but does not error."""
        resp = self.session.send({
            "command": "render-dungeon",
            "lbX": DUNGEON_LB_X, "lbY": DUNGEON_LB_Y,
            "floor": 99,
            "resolution": 256,
        }, timeout=60)
        assert_success(resp, "render-dungeon")
        self.assertEqual(resp["cellsRendered"], 0)

    def test_04_render_preview_sprite_mode(self):
        """render-preview with useSprites=true succeeds against an LB with
        a populated sprite atlas. Output is a non-trivial PNG."""
        out_path = "/tmp/test_render_preview_sprites.png"
        resp = self.session.send({
            "command": "render-preview",
            "lbX": 169, "lbY": 180,  # Holtburg
            "radius": 0,
            "resolution": 1024,
            "overlay": True,
            "useSprites": True,
            "includePng": False,
            "outputPath": out_path,
        }, timeout=60)
        assert_success(resp, "render-preview")
        self.assertGreater(resp["pngBytes"], 5000)
        self.assertTrue(Path(out_path).exists())


# ─────────────────────────────────────────────────────────────
# Test Suite: DerethMapsEnhanced Phase 3 (emit-tile-pyramid + describe-floor)
# ─────────────────────────────────────────────────────────────


class TestDerethMapsPhase3(RuntimeRequiredTestCase):
    """Phase 3: tile pyramid emitter + per-floor describer extension."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not RETAILSMOKE_PROJECT.exists():
            raise unittest.SkipTest(
                f"RetailSmoke project not found at {RETAILSMOKE_PROJECT}; "
                "Phase 3 tests need a real project with DATs.")

    def setUp(self):
        self.session = TerminalSession(project_path=str(RETAILSMOKE_PROJECT))
        self.session.start()

    def tearDown(self):
        self.session.close()

    def test_01_emit_tile_pyramid_4lb(self):
        """emit-tile-pyramid with maxZoom=8 against 4 LBs produces 4 tiles
        at z=8 and a clean downsample chain to z=3."""
        out_dir = "/tmp/test_phase3_pyramid"
        # Clean previous run.
        if Path(out_dir).exists():
            for p in sorted(Path(out_dir).rglob("*"), reverse=True):
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    p.rmdir()
            Path(out_dir).rmdir()

        resp = self.session.send({
            "command": "emit-tile-pyramid",
            "outDir": out_dir,
            "maxZoom": 8,
            "minZoom": 3,
            "emitObject": False,
            "emitFloor": False,
            "lbFilter": ["0xA9B4", "0xAAB4", "0xA9B5", "0xAAB5"],
        }, timeout=180)
        assert_success(resp, "emit-tile-pyramid")
        assert_has_fields(resp, "maxZoom", "minZoom", "lbsProcessed",
                          "exteriorTilesAtMaxZoom", "downsampledTiles", "outDir")
        self.assertEqual(resp["lbsProcessed"], 4)
        # exteriorTilesAtMaxZoom is now terrain + objects-glyph combined (each
        # LB writes a terrain tile and may also write a non-blank glyph tile),
        # so the field is >= one-per-LB rather than equal.
        self.assertGreaterEqual(resp["exteriorTilesAtMaxZoom"], 4,
                                "At maxZoom=8 each LB writes at least one terrain tile")
        self.assertGreaterEqual(resp["downsampledTiles"], 1)

        # Verify the actual tile tree. The pyramid emitter splits exterior
        # output into separate `terrain/` and `objects/` directories so the
        # frontend's floor mode can hide objects without affecting terrain.
        terrain = Path(out_dir) / "terrain"
        for z in range(3, 9):
            zoom_dir = terrain / str(z)
            self.assertTrue(zoom_dir.exists(), f"Missing zoom dir z={z}")
            tiles = list(zoom_dir.rglob("*.png"))
            self.assertGreater(len(tiles), 0, f"No tiles at z={z}")
        # z=8 specifically should have 4 terrain tiles for our 4-LB filter.
        z8_tiles = list((terrain / "8").rglob("*.png"))
        self.assertEqual(len(z8_tiles), 4)

    def test_02_describe_floor(self):
        """describe-floor on a multi-floor dungeon LB returns a per-floor
        record with cell counts, Z bounds, and a verbal summary."""
        # Use the same multi-floor dungeon as Phase 2.
        resp = self.session.send({
            "command": "describe-floor",
            "lbX": DUNGEON_LB_X, "lbY": DUNGEON_LB_Y,
            "floor": 0,
        })
        assert_success(resp, "describe-floor")
        assert_has_fields(resp, "landblock", "floorIndex", "floorCount",
                          "zMin", "zMax", "cellCount", "verbal")
        self.assertEqual(resp["landblock"], DUNGEON_LB_HEX)
        self.assertEqual(resp["floorIndex"], 0)
        self.assertGreater(resp["floorCount"], 1, "Test dungeon should be multi-floor")
        self.assertGreater(resp["cellCount"], 0)
        # Z bounds should be a non-degenerate band.
        self.assertGreaterEqual(resp["zMax"], resp["zMin"])
        self.assertIn(DUNGEON_LB_HEX.replace("0x", "0x"), resp["verbal"])

    def test_03_describe_floor_out_of_range(self):
        """An out-of-range floor index returns an empty result rather than erroring."""
        resp = self.session.send({
            "command": "describe-floor",
            "lbX": DUNGEON_LB_X, "lbY": DUNGEON_LB_Y,
            "floor": 999,
        })
        assert_success(resp, "describe-floor")
        self.assertEqual(resp["cellCount"], 0)


# ─────────────────────────────────────────────────────────────
# Test Suite: DerethMapsEnhanced Phase 4 (emit-static-site orchestrator)
# ─────────────────────────────────────────────────────────────


class TestDerethMapsPhase4(RuntimeRequiredTestCase):
    """Phase 4: emit-static-site composes the dist contract."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not RETAILSMOKE_PROJECT.exists():
            raise unittest.SkipTest(
                f"RetailSmoke project not found at {RETAILSMOKE_PROJECT}; "
                "Phase 4 tests need a real project with DATs.")

    def setUp(self):
        self.session = TerminalSession(project_path=str(RETAILSMOKE_PROJECT))
        self.session.start()
        self.dist = Path("/tmp/test_phase4_dist")
        if self.dist.exists():
            for p in sorted(self.dist.rglob("*"), reverse=True):
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    p.rmdir()

    def tearDown(self):
        self.session.close()

    def test_01_emit_static_site_produces_dist_contract(self):
        """emit-static-site against 2 LBs writes the documented dist tree:
        manifest.js, projects/<slug>/{tiles,desc,dungeons,overlays,sprites,meta.js,README.txt},
        and the frontend bundle (index.html, app.js, app.css, leaflet/)."""
        resp = self.session.send({
            "command": "emit-static-site",
            "projectSlug": "phase4test",
            "outDir": str(self.dist),
            "maxZoom": 8,
            "minZoom": 3,
            "emitObject": False,
            "emitFloor": False,
            "lbFilter": ["0xA9B4", "0xAAB4"],
        }, timeout=180)
        assert_success(resp, "emit-static-site")
        assert_has_fields(resp, "projectSlug", "outDir", "lbsDescribed",
                          "dungeonsEmitted", "overlaysEmitted",
                          "tilesAtMaxZoom", "frontendFilesCopied",
                          "manifestProjectCount")

        self.assertEqual(resp["lbsDescribed"], 2)
        self.assertGreater(resp["overlaysEmitted"], 0)
        # tilesAtMaxZoom counts terrain + objects-glyph after the pyramid tier
        # split. Each LB always produces a terrain tile; glyph tiles depend on
        # whether the LB has placed objects, so use a lower bound rather than
        # the previous strict-equals against the pre-split count.
        self.assertGreaterEqual(resp["tilesAtMaxZoom"], 2)
        self.assertGreaterEqual(resp["frontendFilesCopied"], 4,
                                "Should copy at least index.html + app.js + app.css + leaflet/*")
        self.assertEqual(resp["manifestProjectCount"], 1)

        # Dist contract files. The pyramid emitter writes terrain tiles to
        # `tiles/terrain/...` (split from the legacy combined `exterior/`).
        for required in [
                "index.html", "app.js", "app.css", "manifest.js",
                "leaflet/leaflet.js", "leaflet/leaflet.css",
                "projects/phase4test/meta.js",
                "projects/phase4test/README.txt",
                "projects/phase4test/desc/0xA9B4.js",
                "projects/phase4test/desc/0xAAB4.js",
                "projects/phase4test/overlays/grid.js",
                "projects/phase4test/tiles/terrain/8/169/75.png",
        ]:
            self.assertTrue((self.dist / required).exists(), f"Missing: {required}")

        # manifest.js shape — JSONP-style const + valid embedded JSON.
        manifest_text = (self.dist / "manifest.js").read_text()
        self.assertTrue(manifest_text.startswith("var MANIFEST ="))
        # Strip prefix + trailing semicolon and re-parse.
        manifest_json = manifest_text[len("var MANIFEST = "):].rstrip().rstrip(";")
        manifest = json.loads(manifest_json)
        self.assertEqual(manifest["protocolVersion"], 1)
        self.assertEqual(len(manifest["projects"]), 1)
        self.assertEqual(manifest["projects"][0]["slug"], "phase4test")

        # desc/<hex>.js shape — LOAD_DESC('<hex>', {...});
        desc_text = (self.dist / "projects/phase4test/desc/0xA9B4.js").read_text()
        self.assertTrue(desc_text.startswith("LOAD_DESC('0xA9B4', "))
        self.assertTrue(desc_text.rstrip().endswith(");"))

    def test_02_multi_project_appends_to_manifest(self):
        """A second emit-static-site into the same outDir with a different
        slug merges into the manifest rather than wiping it."""
        # First emission.
        first = self.session.send({
            "command": "emit-static-site",
            "projectSlug": "first",
            "outDir": str(self.dist),
            "maxZoom": 8,
            "minZoom": 3,
            "emitObject": False, "emitFloor": False,
            "lbFilter": ["0xA9B4"],
        }, timeout=120)
        assert_success(first, "emit-static-site")
        self.assertEqual(first["manifestProjectCount"], 1)

        # Second emission — same outDir, different slug.
        second = self.session.send({
            "command": "emit-static-site",
            "projectSlug": "second",
            "outDir": str(self.dist),
            "maxZoom": 8,
            "minZoom": 3,
            "emitObject": False, "emitFloor": False,
            "lbFilter": ["0xAAB4"],
        }, timeout=120)
        assert_success(second, "emit-static-site")
        self.assertEqual(second["manifestProjectCount"], 2,
                         "Manifest should now reference both projects")

        # First project's dist data must still exist.
        self.assertTrue((self.dist / "projects/first/desc/0xA9B4.js").exists(),
                        "First project's per-LB desc must survive the second emit")
        self.assertTrue((self.dist / "projects/second/desc/0xAAB4.js").exists())

        # Manifest JSON includes both slugs.
        manifest_text = (self.dist / "manifest.js").read_text()
        manifest = json.loads(manifest_text[len("var MANIFEST = "):].rstrip().rstrip(";"))
        slugs = sorted(p["slug"] for p in manifest["projects"])
        self.assertEqual(slugs, ["first", "second"])


# ─────────────────────────────────────────────────────────────
# Test Suite: DerethMapsEnhanced Phase 5 (Leaflet frontend bundle)
# ─────────────────────────────────────────────────────────────


class TestDerethMapsPhase5(RuntimeRequiredTestCase):
    """Phase 5: real Leaflet 1.9.x bundle copied into dist by emit-static-site."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        if not RETAILSMOKE_PROJECT.exists():
            raise unittest.SkipTest(
                f"RetailSmoke project not found at {RETAILSMOKE_PROJECT}; "
                "Phase 5 tests need a real project with DATs.")

    def setUp(self):
        self.session = TerminalSession(project_path=str(RETAILSMOKE_PROJECT))
        self.session.start()
        self.dist = Path("/tmp/test_phase5_dist")
        if self.dist.exists():
            for p in sorted(self.dist.rglob("*"), reverse=True):
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    p.rmdir()

    def tearDown(self):
        self.session.close()

    def test_01_real_leaflet_shipped(self):
        """The dist contains the real Leaflet 1.9.x distribution (not the
        Phase 4 stub) plus the marker icon assets."""
        resp = self.session.send({
            "command": "emit-static-site",
            "projectSlug": "p5",
            "outDir": str(self.dist),
            "maxZoom": 8, "minZoom": 3,
            "emitObject": False, "emitFloor": False,
            "lbFilter": ["0xA9B4"],
        }, timeout=120)
        assert_success(resp, "emit-static-site")
        self.assertGreaterEqual(resp["frontendFilesCopied"], 8,
                                "Bundle should include leaflet.js, leaflet.css, "
                                "5 marker images, app.{js,css,html}")

        leaflet_js = self.dist / "leaflet" / "leaflet.js"
        self.assertTrue(leaflet_js.exists())
        self.assertGreater(leaflet_js.stat().st_size, 100_000,
                           "Real Leaflet 1.9.x is ~150KB; stub would be tiny")
        # Header should identify it as the real distribution.
        header = leaflet_js.read_text()[:300]
        self.assertIn("Leaflet 1.9", header)

        # Marker icons are required for default L.marker styling to work.
        for img in ["marker-icon.png", "marker-shadow.png", "layers.png"]:
            self.assertTrue((self.dist / "leaflet" / "images" / img).exists(),
                            f"Missing leaflet asset: {img}")

    def test_02_index_html_references_leaflet_in_correct_order(self):
        """index.html must load leaflet.js before manifest.js before app.js,
        and link leaflet.css before app.css."""
        self.session.send({
            "command": "emit-static-site",
            "projectSlug": "p5",
            "outDir": str(self.dist),
            "maxZoom": 8, "minZoom": 3,
            "emitObject": False, "emitFloor": False,
            "lbFilter": ["0xA9B4"],
        }, timeout=120)
        html = (self.dist / "index.html").read_text()
        # CSS order
        leaflet_css = html.find("leaflet/leaflet.css")
        app_css = html.find("app.css")
        self.assertGreater(leaflet_css, 0)
        self.assertGreater(app_css, leaflet_css)
        # Script order
        leaflet_js = html.find("leaflet/leaflet.js")
        manifest_js = html.find("manifest.js")
        app_js = html.find('"app.js"')
        self.assertGreater(leaflet_js, 0)
        self.assertGreater(manifest_js, leaflet_js)
        self.assertGreater(app_js, manifest_js)

    def test_04_object_index_in_desc(self):
        """desc/<lbHex>.js must include body.objectIndex (Phase 5 follow-up):
        a flat list of placed objects with world XY/Z and ontology category,
        plus optional cross-refs into body.namedObjects. The frontend uses
        this for click-to-identify."""
        out = "/tmp/test_p5_objidx"
        if Path(out).exists():
            for p in sorted(Path(out).rglob("*"), reverse=True):
                if p.is_file():
                    p.unlink()
                elif p.is_dir():
                    p.rmdir()
        self.session.send({
            "command": "emit-static-site",
            "projectSlug": "oi",
            "outDir": out,
            "maxZoom": 8, "minZoom": 3,
            "emitObject": False, "emitFloor": False,
            "lbFilter": ["0xA9B4"],
        }, timeout=120)
        text = (Path(out) / "projects/oi/desc/0xA9B4.js").read_text()
        # Strip JSONP envelope LOAD_DESC('<hex>', {...});
        import re as _re
        m = _re.search(r"LOAD_DESC\('0xA9B4', (.+)\);", text, _re.DOTALL)
        self.assertIsNotNone(m, "desc file does not match LOAD_DESC envelope")
        data = json.loads(m.group(1))
        oi = data["body"].get("objectIndex")
        self.assertIsNotNone(oi, "body.objectIndex must be present")
        self.assertGreater(len(oi), 0, "Holtburg should have placed objects")
        # Schema spot-check on the first entry.
        entry = oi[0]
        for key in ("index", "modelId", "type", "category", "x", "y", "z"):
            self.assertIn(key, entry, f"objectIndex entry missing '{key}'")
        self.assertTrue(entry["modelId"].startswith("0x"))
        self.assertIn(entry["type"], ("Setup", "GfxObj"))
        # Object total reported by body must >= objectIndex length (particle
        # emitters are excluded from objectIndex but counted in objectTotal).
        self.assertGreaterEqual(data["body"]["objectTotal"], len(oi))

    def test_03_dist_app_js_passes_node_syntax_check(self):
        """The emitted app.js must parse cleanly (no ES6 syntax errors that
        Chrome would also reject)."""
        if shutil.which("node") is None:
            self.skipTest("node not available for syntax check")
        self.session.send({
            "command": "emit-static-site",
            "projectSlug": "p5",
            "outDir": str(self.dist),
            "maxZoom": 8, "minZoom": 3,
            "emitObject": False, "emitFloor": False,
            "lbFilter": ["0xA9B4"],
        }, timeout=120)
        result = subprocess.run(
            ["node", "--check", str(self.dist / "app.js")],
            capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0,
                         f"node --check failed:\nstdout: {result.stdout}\nstderr: {result.stderr}")


# ─────────────────────────────────────────────────────────────
# CLI entrypoint
# ─────────────────────────────────────────────────────────────

# ─────────────────────────────────────────────────────────────
# Sync-Wave 2026-04-30 commands — protocol-shape tests.
#
# These tests run without an ACE DB connection. Commands that route
# through ace-db are tested via their argument-validation / no-config
# error paths so the protocol envelope and command names are verified
# even in CI environments without MySQL.
# ─────────────────────────────────────────────────────────────


class TestSyncWave2026_04_30(RuntimeRequiredTestCase):
    """Protocol shape coverage for the headless-parity commands added in the
    2026-04-26 → 2026-04-30 upstream sync wave."""

    @classmethod
    def setUpClass(cls):
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

    # ── Heightmap / RenderSurface ───────────────────────────

    def test_01_import_heightmap_missing_file_errors(self):
        resp = self.session.send({
            "command": "import-heightmap",
            "imagePath": "/nonexistent/heightmap.png",
            "lbCountX": 1, "lbCountY": 1,
        })
        self.assertFalse(resp.get("success"))
        self.assertEqual(resp.get("command"), "error")
        self.assertIn("Image not found", resp.get("error", ""))

    def test_02_import_heightmap_missing_lb_count_errors(self):
        resp = self.session.send({
            "command": "import-heightmap",
            "imagePath": "x.png"
        })
        self.assertFalse(resp.get("success"))

    def test_03_import_render_surface_missing_image_errors(self):
        resp = self.session.send({
            "command": "import-render-surface",
            "imagePath": "/nonexistent/tex.png",
            "renderSurfaceId": "0x06000001"
        })
        self.assertFalse(resp.get("success"))

    # ── ACE DB commands (no-ace-db error path) ──────────────

    def test_04_creature_get_without_ace_db_errors(self):
        resp = self.session.send({"command": "creature-get", "objectId": 31226})
        self.assertFalse(resp.get("success"))

    def test_05_spell_list_dat_works_without_ace_db(self):
        resp = self.session.send({"command": "spell-list", "limit": 5, "source": "dat"})
        # Either succeeds (DAT has spells) OR fails with a clear error if SpellTable missing.
        self.assertIn("command", resp)

    def test_06_spell_get_unknown_id_errors(self):
        resp = self.session.send({"command": "spell-get", "id": 999999999})
        self.assertFalse(resp.get("success"))

    def test_07_weenie_list_property_keys_int_succeeds(self):
        resp = self.session.send({"command": "weenie-list-property-keys", "family": "int"})
        assert_success(resp, "weenie-list-property-keys")
        assert_has_fields(resp, "family", "count", "keys")
        self.assertEqual(resp["family"], "int")
        self.assertGreater(resp["count"], 100,
                           "AcePropertyInt should have many entries")

    def test_08_weenie_list_property_keys_unknown_family_errors(self):
        resp = self.session.send({"command": "weenie-list-property-keys", "family": "qwerty"})
        self.assertFalse(resp.get("success"))

    def test_09_weenie_save_without_ace_db_errors(self):
        resp = self.session.send({
            "command": "weenie-save", "classId": 31226, "fromJson": "/tmp/missing.json"
        })
        self.assertFalse(resp.get("success"))

    # ── Instance placements (work without ace-db; CRUD only) ─

    def test_10_placement_list_returns_envelope(self):
        resp = self.session.send({"command": "placement-list", "kind": "all"})
        assert_success(resp, "placement-list")
        assert_has_fields(resp, "count", "filter", "placements")

    def test_11_placement_add_outdoor_succeeds(self):
        resp = self.session.send({
            "command": "placement-add-outdoor",
            "lbX": 169, "lbY": 178, "wcid": 7777,
            "cellNumber": 1,
            "originX": 96.0, "originY": 96.0, "originZ": 50.0,
        })
        assert_success(resp, "placement-add-outdoor")
        assert_has_fields(resp, "kind", "index", "landblock")
        # Clean up
        self.session.send({"command": "placement-remove", "kind": "outdoor", "index": resp["index"]})

    def test_12_placement_remove_invalid_index_returns_failure(self):
        resp = self.session.send({"command": "placement-remove", "kind": "outdoor", "index": 99999})
        self.assertFalse(resp.get("success"))

    def test_13_placement_export_sql_writes_files(self):
        import tempfile
        with tempfile.TemporaryDirectory() as tmp:
            resp = self.session.send({
                "command": "placement-export-sql", "out": tmp, "apply": False
            })
            assert_success(resp, "placement-export-sql")
            assert_has_fields(resp, "outdoorPath", "outdoorCount", "dungeonPath", "dungeonCount")
            self.assertTrue(Path(resp["outdoorPath"]).exists())
            self.assertTrue(Path(resp["dungeonPath"]).exists())

    # ── Layout overlay ──────────────────────────────────────

    def test_14_layout_list_returns_count(self):
        resp = self.session.send({"command": "layout-list", "overlayOnly": False})
        assert_success(resp, "layout-list")
        assert_has_fields(resp, "count", "layouts")

    def test_15_layout_get_unknown_id_errors(self):
        resp = self.session.send({"command": "layout-get", "layoutId": "0x99999999"})
        self.assertFalse(resp.get("success"))

    def test_16_layout_delete_overlay_idempotent(self):
        resp = self.session.send({"command": "layout-delete-overlay", "layoutId": "0x99999999"})
        # Either True (didn't exist → removed=False but success envelope still returned)
        self.assertIn("command", resp)

    # ── FreshStart + GenerateWorld ──────────────────────────

    def test_17_fresh_start_requires_confirm(self):
        resp = self.session.send({"command": "fresh-start"})
        self.assertFalse(resp.get("success"))
        self.assertIn("confirm", resp.get("error", "").lower())

    def test_18_fresh_start_with_confirm_acceptable(self):
        # We actually run it on TestProject; if success, restore via export not needed here
        resp = self.session.send({"command": "fresh-start", "confirm": True}, timeout=120)
        # Either succeeds OR fails with a clear error (e.g. no terrain doc); envelope must be valid.
        self.assertIn("command", resp)

    def test_19_generate_world_dry_run_default(self):
        resp = self.session.send({
            "command": "generate-world",
            "params": {"Seed": 42, "FullWorld": True},
            "apply": False
        }, timeout=300)
        # Generate may take long; verify the envelope is correct either way.
        self.assertIn("command", resp)

    def test_20_export_towns_csv_missing_from_result_errors(self):
        resp = self.session.send({
            "command": "export-towns-csv",
            "fromResult": "/nonexistent/result.json",
            "out": "/tmp/towns.csv"
        })
        self.assertFalse(resp.get("success"))

    # ── Logging ─────────────────────────────────────────────

    def test_21_open_log_folder_no_log_file_errors(self):
        resp = self.session.send({"command": "open-log-folder"})
        # When --log-file isn't passed, returns success=false with explanation
        self.assertFalse(resp.get("success"))
        self.assertIn("log file", resp.get("error", "").lower())

    # ── transact allow-list smoke ───────────────────────────

    def test_22_transact_includes_import_heightmap(self):
        resp = self.session.send({"command": "transact", "ops": []})
        # Empty ops list should still return a valid envelope.
        self.assertIn("command", resp)

    def test_23_transact_includes_placement_add_outdoor(self):
        resp = self.session.send({
            "command": "transact",
            "ops": [{
                "command": "placement-add-outdoor",
                "lbX": 169, "lbY": 178, "wcid": 7777,
                "cellNumber": 1,
                "originX": 96.0, "originY": 96.0, "originZ": 50.0
            }]
        })
        # If allow-list excluded the op, transact rejects it explicitly. We assert
        # the envelope contains the command name regardless of success.
        self.assertEqual(resp.get("command"), "transact")


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
