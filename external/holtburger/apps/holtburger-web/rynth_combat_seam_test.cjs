#!/usr/bin/env node
// rynth_combat_seam_test.cjs — combat targeting across a landblock seam
// (2026-10-12). Live on the 1070: an admin-spawned Drudge 4.7 m south of the
// player but across Holtburg's A9B3/A9B4 seam was invisible to the bot — the
// scan kept a July "same landblock only" distance gate. Outdoors the
// landblocks tile the world (global frame = LB index * 192 + local); indoor
// EnvCell landblocks are not world-contiguous and keep the same-LB rule. The
// P3 face gate also turned by raw local deltas (y 190.6 vs 3.3 read as 187 m
// north for a mob 4.7 m south).   Run: node rynth_combat_seam_test.cjs
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");

async function importCopy(rel) {
  const src = fs.readFileSync(path.join(__dirname, rel), "utf8");
  const tmp = path.join(os.tmpdir(), `${path.basename(rel, ".js")}_seam_${process.pid}.mjs`);
  fs.writeFileSync(tmp, src);
  try {
    return await import("file://" + tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

const ME_CELL = 0xa9b40020 >>> 0; // outdoor cell, landblock A9B4
const SOUTH_CELL = 0xa9b30020 >>> 0; // outdoor cell, landblock A9B3 (one LB south)

function makeHost(me, ents) {
  const byId = new Map(ents.map((e) => [e.id, e]));
  const turns = [];
  return {
    turns,
    IsPlayerReady: () => true,
    TryGetPlayerPose: () => me,
    NearbyGuids: () => ents.map((e) => e.id),
    ObjectIsPlayer: () => false,
    TryGetObjectIntProperty: (g, stype) => (stype === 1 ? 16 : undefined),
    ObjectIsAttackable: () => true,
    TryGetTargetHealthFraction: () => 1,
    TryGetObjectPosition: (g) => {
      const e = byId.get(g);
      return e ? { objCellId: e.cell, x: e.x, y: e.y, z: 0 } : null;
    },
    TryGetObjectName: (g) => byId.get(g)?.name ?? null,
    GetCurrentCombatMode: () => 2,
    TurnToHeading: (h) => { turns.push(h); return true; },
    has: (cap) => cap === "TurnToHeading",
    onEvent: () => {},
    s: {},
  };
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok: !!ok, detail: detail || "" });

async function main() {
  const { RynthCombatLoop, globalDist, globalDelta } = await importCopy("rynth/combat_loop.js");
  const quiet = () => {};
  const me = { objCellId: ME_CELL, x: 78.1, y: 3.3, z: 0, heading: Math.PI }; // facing south

  // S1: an outdoor mob across the seam is a target at its true range.
  {
    const drudge = { id: 0x80000bdb, name: "Drudge Skulker", cell: SOUTH_CELL, x: 77.6, y: 190.6 };
    const loop = new RynthCombatLoop(makeHost(me, [drudge]), { log: quiet });
    const out = loop._scanTargets();
    check("S1 cross-seam outdoor mob is scanned", out.length === 1 && out[0].guid === drudge.id, JSON.stringify(out));
    check("S1 at its global range (~4.7 m, not 187 m)", out[0] && Math.abs(out[0].dist - 4.73) < 0.1, String(out[0]?.dist));
    const d = globalDelta(me, { objCellId: SOUTH_CELL, x: 77.6, y: 190.6 });
    check("S1 globalDelta points south (dy < 0)", d.dy < 0 && Math.abs(d.dy + 4.7) < 0.01, JSON.stringify(d));
    check("S1 globalDist agrees", Math.abs(globalDist(me, { objCellId: SOUTH_CELL, x: 77.6, y: 190.6, z: 0 }) - 4.73) < 0.1);
  }

  // S2: indoor (EnvCell) landblocks are not world-contiguous — no cross-LB pick.
  {
    const meIndoor = { objCellId: 0xa9b40105 >>> 0, x: 10, y: 10, z: 0, heading: 0 };
    const mob = { id: 0x80000c01, name: "Skeleton", cell: 0xa9b30105 >>> 0, x: 10, y: 12 };
    const loop = new RynthCombatLoop(makeHost(meIndoor, [mob]), { log: quiet });
    check("S2 dungeon cell across landblocks is NOT scanned", loop._scanTargets().length === 0);
    const sameLb = { id: 0x80000c02, name: "Skeleton", cell: 0xa9b40106 >>> 0, x: 10, y: 14 };
    const loop2 = new RynthCombatLoop(makeHost(meIndoor, [sameLb]), { log: quiet });
    check("S2 same-landblock indoor mob still scanned", loop2._scanTargets().length === 1);
  }

  // S3: the P3 face gate turns toward the true (global) bearing.
  {
    const drudge = { id: 0x80000bdc, name: "Drudge Skulker", cell: SOUTH_CELL, x: 78.1, y: 190.6 }; // due south
    const host = makeHost({ ...me, heading: 0 }, [drudge]); // facing NORTH, mob behind us
    const loop = new RynthCombatLoop(host, { log: quiet });
    const r = loop._faceGate(drudge.id);
    const turnTo = host.turns[0];
    const err = Math.abs(Math.atan2(Math.sin(turnTo - Math.PI), Math.cos(turnTo - Math.PI)));
    check("S3 facing north with the mob south across the seam: turn toward south", r === "turn" && err < 0.05,
      `r=${r} turn=${turnTo}`);
    const host2 = makeHost({ ...me, heading: Math.PI }, [drudge]); // already facing south
    const loop2 = new RynthCombatLoop(host2, { log: quiet });
    loop2._faceGate(drudge.id);
    check("S3 already facing it: no turn issued", host2.turns.length === 0, JSON.stringify(host2.turns));
  }

  let fail = 0;
  for (const r of results) {
    if (!r.ok) fail++;
    console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok || !r.detail ? "" : " — " + r.detail}`);
  }
  console.log(`\ncombat-seam: ${results.length - fail}/${results.length} passed`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
