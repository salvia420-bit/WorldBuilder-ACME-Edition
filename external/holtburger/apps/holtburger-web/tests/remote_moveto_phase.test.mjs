// tests/remote_moveto_phase.test.mjs — R3 moveto-4 (2026-10-08 follow-ups).
//
// Retail plays a MoveTo on the mover's own CMotionInterp: every node is a
// `MoveToManager::_DoMotion` (acclient.c:344753) — TurnRight/TurnLeft while a
// TurnToHeading node turns in place (`BeginTurnToHeading` :345489-345507),
// Walk/WalkBackwards/Run while a MoveToPosition node walks (`BeginMoveForward`
// :345371-345425), Ready on arrival (`BeginNextNode` → StopCompletely,
// :345521-345545). holtburger-core runs that node machine for remotes; the
// wasm now emits a ClientEvent (REMOTE_MOVETO_PHASE) on every node-motion
// change and JS plays it, instead of guessing the phase from the COL-20
// heading error (which the D5 heading rows zero).
//
// Pins scene3d/remote_moveto_phase.js (pure mapping + staleness rule + flag
// reader), the EntityManager wiring spliced from scene3d/entities.js
// (noteRemoteMoveToHint / applyRemoteMoveToPhase / reapplyRemoteMoveToPhase /
// _playRemoteMoveToPhase) against a stub manager, and the cross-layer
// plumbing (wasm kind 67, client_events.js arm, loop.js `_armMotion` hook).
//
// Run: node tests/remote_moveto_phase.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MOTION_TURN_RIGHT,
  MOTION_TURN_LEFT,
  MOTION_WALK_FORWARD,
  MOTION_WALK_BACKWARDS,
  MOTION_RUN_FORWARD,
  MOTION_READY,
  remoteMoveToPhaseEnabled,
  remoteMoveToPhaseCommand,
  planRemoteMoveToPhase,
  remoteMoveToHintReapply,
} from "../scene3d/remote_moveto_phase.js";

const src = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

test("phase motions are the retail MotionCommand ids", () => {
  assert.equal(MOTION_TURN_RIGHT, 0x6500000d);
  assert.equal(MOTION_TURN_LEFT, 0x6500000e);
  assert.equal(MOTION_WALK_FORWARD, 0x45000005);
  assert.equal(MOTION_WALK_BACKWARDS, 0x45000006);
  assert.equal(MOTION_RUN_FORWARD, 0x44000007);
  assert.equal(MOTION_READY, 0x41000003);
  for (const m of [MOTION_TURN_RIGHT, MOTION_TURN_LEFT, MOTION_WALK_FORWARD, MOTION_WALK_BACKWARDS, MOTION_RUN_FORWARD]) {
    assert.equal(remoteMoveToPhaseCommand(m), m);
  }
  assert.equal(remoteMoveToPhaseCommand(0), 0);
  // A value this table does not know is ignored, never read as a stop.
  assert.equal(remoteMoveToPhaseCommand(0x41000003), -1);
  assert.equal(remoteMoveToPhaseCommand(0x10000051), -1);
});

test("?remoteMoveToPhase: default on, off / 0 / false (any case) disable", () => {
  assert.equal(remoteMoveToPhaseEnabled(""), true);
  assert.equal(remoteMoveToPhaseEnabled("?nosw=1"), true);
  assert.equal(remoteMoveToPhaseEnabled("?remoteMoveToPhase=on"), true);
  for (const v of ["off", "0", "false", "OFF", "False"]) {
    assert.equal(remoteMoveToPhaseEnabled(`?remoteMoveToPhase=${v}`), false, v);
  }
  assert.equal(remoteMoveToPhaseEnabled("?nosw=1&remoteMoveToPhase=off"), false);
  // No location (Node) → default on.
  assert.equal(remoteMoveToPhaseEnabled(undefined), true);
});

test("plan: a node that starts always plays its motion", () => {
  const idle = { phase: 0, seq: 0 };
  assert.deepEqual(planRemoteMoveToPhase(idle, MOTION_TURN_RIGHT, 3), { play: MOTION_TURN_RIGHT, phase: MOTION_TURN_RIGHT, seq: 3 });
  assert.deepEqual(planRemoteMoveToPhase(idle, MOTION_WALK_FORWARD, 3), { play: MOTION_WALK_FORWARD, phase: MOTION_WALK_FORWARD, seq: 3 });
  assert.deepEqual(planRemoteMoveToPhase(idle, MOTION_RUN_FORWARD, 3), { play: MOTION_RUN_FORWARD, phase: MOTION_RUN_FORWARD, seq: 3 });
  // turn → run: the next node starts.
  const turning = { phase: MOTION_TURN_RIGHT, seq: 3 };
  assert.equal(planRemoteMoveToPhase(turning, MOTION_RUN_FORWARD, 3).play, MOTION_RUN_FORWARD);
  // Even after a newer KIND_MOTION — a node that starts IS the clip.
  assert.equal(planRemoteMoveToPhase(turning, MOTION_RUN_FORWARD, 4).play, MOTION_RUN_FORWARD);
  assert.equal(planRemoteMoveToPhase(idle, 0xdeadbeef, 3), null);
});

test("plan: a stop after a live phase plays Ready unless a newer server motion owns the clip", () => {
  const running = { phase: MOTION_RUN_FORWARD, seq: 5 };
  assert.deepEqual(planRemoteMoveToPhase(running, 0, 5), { play: MOTION_READY, phase: 0, seq: 5 });
  // An attack / interpreted state / another MoveTo arrived since: its unpack
  // cancelled the node; that cancel is what this stop reports.
  assert.deepEqual(planRemoteMoveToPhase(running, 0, 6), { play: 0, phase: 0, seq: 6 });
  // A stop with no live phase plays nothing.
  assert.equal(planRemoteMoveToPhase({ phase: 0, seq: 5 }, 0, 5).play, 0);
});

test("hint reapply: a re-sent MoveTo hint never replaces the node motion", () => {
  assert.equal(remoteMoveToHintReapply(MOTION_TURN_RIGHT, 0x0007), MOTION_TURN_RIGHT);
  assert.equal(remoteMoveToHintReapply(MOTION_TURN_LEFT, 0x44000007), MOTION_TURN_LEFT);
  assert.equal(remoteMoveToHintReapply(MOTION_WALK_FORWARD, 0x0007), MOTION_WALK_FORWARD);
  // Same motion: the hint already plays it.
  assert.equal(remoteMoveToHintReapply(MOTION_RUN_FORWARD, 0x0007), 0);
  assert.equal(remoteMoveToHintReapply(MOTION_RUN_FORWARD, 0x44000007), 0);
  // No live phase: leave the hint.
  assert.equal(remoteMoveToHintReapply(0, 0x0007), 0);
});

// ── EntityManager wiring, spliced from entities.js against a stub ───────────
const ENT = src("scene3d/entities.js");
function makeManager({ on = true } = {}) {
  const start = ENT.indexOf("  noteRemoteMoveToHint(guid, isMoveTo) {");
  const end = ENT.indexOf("  setPose(guid, x, y, z, qw, qx, qy, qz) {", start);
  assert.ok(start > 0 && end > start, "noteRemoteMoveToHint … setPose block not found in entities.js");
  const body = ENT.slice(start, end);
  for (const fn of ["applyRemoteMoveToPhase(guid, motion) {", "reapplyRemoteMoveToPhase(guid, hintCmd) {", "_playRemoteMoveToPhase(inst, g, cmd) {"]) {
    assert.ok(body.includes(fn), `${fn} must sit between noteRemoteMoveToHint and setPose`);
  }
  const Cls = new Function(
    "REMOTE_MOVETO_PHASE_ON",
    "planRemoteMoveToPhase",
    "remoteMoveToHintReapply",
    `return class StubEntityManager {
      constructor() { this.entityMap = new Map(); this.played = []; this.localGuid = 0x50000001; }
      _isLocalPlayerGuid(g) { return (g >>> 0) === this.localGuid; }
      setMotion(g, cmd, stance, speed) {
        const inst = this.entityMap.get(g >>> 0);
        this.played.push({ g: g >>> 0, cmd: cmd >>> 0, stance, speed, gateArmable: inst ? inst._motionFromMoveTo === true : false });
        if (inst) inst.lastMotionCommand = cmd >>> 0;
      }
      ${body}
    };`,
  )(on, planRemoteMoveToPhase, remoteMoveToHintReapply);
  return new Cls();
}
const MOB = 0x80001234;
// loop.js `_armMotion` for a remote: mark → setMotion → reapply.
function kindMotion(em, cmd, { moveTo }) {
  em.noteRemoteMoveToHint(MOB, moveTo);
  em.setMotion(MOB, cmd, 0x3d, 1.0);
  em.reapplyRemoteMoveToPhase(MOB, cmd);
}
const last = (em) => em.played[em.played.length - 1]?.cmd;

test("a chase plays the node: turn in place → run → Ready on arrival", () => {
  const em = makeManager();
  em.entityMap.set(MOB, {});
  kindMotion(em, 0x0007, { moveTo: true }); // the MoveTo envelope's run hint
  assert.equal(em.played.length, 1);
  // The first hint still arms the COL-20 fallback — no phase seen yet.
  assert.equal(em.played[0].gateArmable, true);
  em.applyRemoteMoveToPhase(MOB, MOTION_TURN_RIGHT);
  assert.equal(last(em), MOTION_TURN_RIGHT, "the turn node plays TurnRight 0x6500000D");
  assert.equal(em.played.at(-1).stance, 0, "stance 0 keeps the rig's stance");
  assert.equal(em.played.at(-1).speed, 1.0);
  em.applyRemoteMoveToPhase(MOB, MOTION_RUN_FORWARD);
  assert.equal(last(em), MOTION_RUN_FORWARD);
  assert.equal(em.played.at(-1).gateArmable, false, "the phase play never arms the COL-20 gate");
  em.applyRemoteMoveToPhase(MOB, 0);
  assert.equal(last(em), MOTION_READY, "arrival → Ready");
});

test("once the channel spoke, MoveTo hints no longer arm the COL-20 gate", () => {
  const em = makeManager();
  const inst = {};
  em.entityMap.set(MOB, inst);
  em.applyRemoteMoveToPhase(MOB, MOTION_RUN_FORWARD);
  inst._turnGateCmd = 0x0007; // a gate armed by an earlier hint …
  em.applyRemoteMoveToPhase(MOB, MOTION_TURN_LEFT);
  assert.equal(inst._turnGateCmd, 0, "… is dropped by the phase");
  em.noteRemoteMoveToHint(MOB, true);
  assert.equal(inst._motionFromMoveTo, false);
});

test("a re-sent MoveTo hint during a turn node keeps the turn; the later stop still plays Ready", () => {
  const em = makeManager();
  em.entityMap.set(MOB, {});
  kindMotion(em, 0x0007, { moveTo: true });
  em.applyRemoteMoveToPhase(MOB, MOTION_TURN_RIGHT);
  kindMotion(em, 0x0007, { moveTo: true }); // re-sent MoveTo: hint run …
  assert.equal(last(em), MOTION_TURN_RIGHT, "… then the node's turn is put back");
  em.applyRemoteMoveToPhase(MOB, MOTION_RUN_FORWARD);
  kindMotion(em, 0x0007, { moveTo: true }); // same motion: nothing re-played
  assert.equal(em.played.filter((p) => p.cmd === MOTION_RUN_FORWARD).length, 1);
  em.applyRemoteMoveToPhase(MOB, 0);
  assert.equal(last(em), MOTION_READY, "the phase re-stamped by the hint still ends in Ready");
});

test("a newer non-MoveTo server motion owns the clip: the stop edge is stale", () => {
  const em = makeManager();
  em.entityMap.set(MOB, {});
  kindMotion(em, 0x0007, { moveTo: true });
  em.applyRemoteMoveToPhase(MOB, MOTION_RUN_FORWARD);
  kindMotion(em, 0x0003, { moveTo: false }); // e.g. ACE's Ready before an attack
  const n = em.played.length;
  em.applyRemoteMoveToPhase(MOB, 0);
  assert.equal(em.played.length, n, "no Ready over the newer motion");
});

test("local player, dead rigs, unknown rigs and ?remoteMoveToPhase=off are ignored", () => {
  const em = makeManager();
  em.entityMap.set(em.localGuid, {});
  em.applyRemoteMoveToPhase(em.localGuid, MOTION_RUN_FORWARD);
  em.applyRemoteMoveToPhase(0x80009999, MOTION_RUN_FORWARD);
  em.entityMap.set(MOB, { _deathAt: 1234 });
  em.applyRemoteMoveToPhase(MOB, MOTION_RUN_FORWARD);
  em.applyRemoteMoveToPhase(MOB, 0);
  assert.equal(em.played.length, 0);
  const off = makeManager({ on: false });
  const inst = {};
  off.entityMap.set(MOB, inst);
  off.applyRemoteMoveToPhase(MOB, MOTION_TURN_RIGHT);
  assert.equal(off.played.length, 0);
  off.noteRemoteMoveToHint(MOB, true);
  assert.equal(inst._motionFromMoveTo, true, "flag off keeps the COL-20 gate");
});

test("plumbing: wasm kind 67 → client_events.js → applyRemoteMoveToPhase; loop.js re-asserts after the hint", async () => {
  const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");
  assert.equal(ClientEventKind.REMOTE_MOVETO_PHASE, 67);
  assert.match(src("src/lib.rs"), /const CLIENT_EVENT_KIND_REMOTE_MOVETO_PHASE: u32 = 67;/);
  const mv = src("src/session/commands/movement.rs");
  const i = mv.indexOf("take_remote_moveto_phase_changes()");
  assert.ok(i > 0, "TickMovement drains the scene's phase edges");
  assert.match(mv.slice(i, i + 500), /kind: CLIENT_EVENT_KIND_REMOTE_MOVETO_PHASE/);
  assert.ok(mv.indexOf("take_remote_airborne_changes()") < i, "drained next to the D7 airborne edges");
  const ce = src("app/client_events.js");
  const j = ce.indexOf("evt.kind === ClientEventKind.REMOTE_MOVETO_PHASE");
  assert.ok(j > 0, "client_events.js has the arm");
  assert.match(ce.slice(j, j + 900), /em\.applyRemoteMoveToPhase\(evt\.u32Payload >>> 0, evt\.u32Payload2 >>> 0\)/);
  const loop = src("scene3d/loop.js");
  const arm = loop.indexOf("function _armMotion(");
  const body = loop.slice(arm, arm + 7000);
  const set = body.indexOf("em.setMotion(");
  const re = body.indexOf("em.reapplyRemoteMoveToPhase?.(motionGuid, motionCmd)");
  assert.ok(set > 0 && re > set, "the re-assert runs AFTER the hint's setMotion");
});
