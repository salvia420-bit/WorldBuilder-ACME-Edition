#!/usr/bin/env node
// mock_wbt.cjs — stand-in for `WorldBuilder.Terminal --stdin` used by
// wbt_sidecar_test.cjs (via WBT_SPAWN). Speaks the same JSON-line protocol:
// one ready banner, then exactly one JSON response line per command line.
// "slow-cmd" sleeps 3s (drives the sidecar's timeout+respawn path).

"use strict";
const readline = require("node:readline");

process.stdout.write(JSON.stringify({ success: true, command: "ready", version: "mock-1", message: "mock ready" }) + "\n");

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  let cmd;
  try {
    cmd = JSON.parse(line);
  } catch {
    return; // real WBT never sees non-JSON from the sidecar; ignore
  }
  const name = cmd.command;
  if (name === "help") {
    process.stdout.write(
      JSON.stringify({
        success: true,
        command: "help",
        commands: [
          { name: "info", args: "", description: "Show project info" },
          { name: "describe-landblock", args: "lbX, lbY", description: "Living Atlas description" },
          { name: "paint", args: "x, y, radius, type", description: "Paint terrain texture" },
          { name: "quit", args: "", description: "Exit terminal" },
        ],
      }) + "\n"
    );
    return;
  }
  if (name === "slow-cmd") {
    await new Promise((r) => setTimeout(r, 3000));
    process.stdout.write(JSON.stringify({ success: true, command: name, late: true }) + "\n");
    return;
  }
  process.stdout.write(JSON.stringify({ success: true, command: name, echo: cmd }) + "\n");
});
