// 2026-10-06 — scene3d/entity_backlog.js: the pre-3D entity backlog keeps every state event
// (SPAWN / REMOVE / META_REFRESH / APPEARANCE / ATTACH) and coalesces superseded updates
// (POSITION / VELOCITY / MOTION / MOTION_ACTION / TURN, newest per guid) instead of dropping the
// oldest non-spawns.
//
// Run:
//   cd apps/holtburger-web/
//   node test_entity_backlog.mjs

import { compactEntityBacklog, COALESCE_KINDS, BACKLOG_HARD_CAP } from "./scene3d/entity_backlog.js";
import { KIND } from "./scene3d/entity_dispatch.js";

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

let seq = 0;
const ev = (kind, guid, extra = {}) => ({ kind, guid, seq: seq++, ...extra });
const kindsOf = (b) => b.map((e) => e.kind);

console.log("what is kept");
{
  check("coalescible kinds are exactly the superseded-state ones",
    [KIND.POSITION, KIND.VELOCITY, KIND.MOTION, KIND.MOTION_ACTION, KIND.TURN].every((k) => COALESCE_KINDS.has(k)) &&
    ![KIND.SPAWN, KIND.REMOVE, KIND.META_REFRESH, KIND.APPEARANCE, KIND.ATTACH].some((k) => COALESCE_KINDS.has(k)));
  const b = [
    ev(KIND.SPAWN, 1), ev(KIND.POSITION, 1, { x: 1 }), ev(KIND.MOTION, 1, { m: "a" }), ev(KIND.APPEARANCE, 1, { a: 1 }),
    ev(KIND.POSITION, 1, { x: 2 }), ev(KIND.ATTACH, 2), ev(KIND.MOTION, 1, { m: "b" }), ev(KIND.APPEARANCE, 1, { a: 2 }),
    ev(KIND.VELOCITY, 1), ev(KIND.VELOCITY, 1), ev(KIND.TURN, 1), ev(KIND.TURN, 1), ev(KIND.MOTION_ACTION, 1), ev(KIND.MOTION_ACTION, 1),
    ev(KIND.META_REFRESH, 1), ev(KIND.META_REFRESH, 1), ev(KIND.REMOVE, 3), ev(KIND.POSITION, 1, { x: 3 }),
  ];
  const ref = b;
  const r = compactEntityBacklog(b);
  check("same array (the replay splices this one)", b === ref);
  check("every state event kept, including repeats", b.filter((e) => e.kind === KIND.APPEARANCE).length === 2 &&
    b.filter((e) => e.kind === KIND.META_REFRESH).length === 2 && b.some((e) => e.kind === KIND.ATTACH) &&
    b.some((e) => e.kind === KIND.REMOVE) && b.some((e) => e.kind === KIND.SPAWN));
  check("one newest POSITION / MOTION / VELOCITY / TURN / MOTION_ACTION per guid",
    b.filter((e) => e.kind === KIND.POSITION).map((e) => e.x).join() === "3" &&
    b.filter((e) => e.kind === KIND.MOTION).map((e) => e.m).join() === "b" &&
    [KIND.VELOCITY, KIND.TURN, KIND.MOTION_ACTION].every((k) => b.filter((e) => e.kind === k).length === 1));
  check("arrival order preserved", b.every((e, i) => i === 0 || b[i - 1].seq < e.seq), b.map((e) => e.seq).join(","));
  check("counts: 18 in, 6 superseded duplicates out", r.before === 18 && r.coalesced === 6 && r.after === 12 && r.hardDropped === 0, JSON.stringify(r));
}
{
  const b = [ev(KIND.POSITION, 7, { x: 1 }), ev(KIND.POSITION, 8, { x: 2 }), ev(KIND.POSITION, 0x80000007, { x: 3 })];
  compactEntityBacklog(b);
  check("different guids never coalesce (incl. high guids)", b.length === 3);
}

console.log("\nthe slow-boot case (2026-10-06 remote console)");
{
  // a zone-entry burst: spawns with their wield/appearance events, an early removal,
  // then a long position/motion flood from 20 movers while init3D is still loading
  const b = [];
  for (let g = 1; g <= 60; g++) b.push(ev(KIND.SPAWN, g));
  for (let g = 61; g <= 70; g++) { b.push(ev(KIND.SPAWN, g)); b.push(ev(KIND.ATTACH, g)); }
  b.push(ev(KIND.APPEARANCE, 5)); b.push(ev(KIND.REMOVE, 9));
  for (let i = 0; i < 2000; i++) b.push(ev(i % 3 ? KIND.POSITION : KIND.MOTION, 1 + (i % 20)));
  // the OLD policy: keep spawns + the newest (512 - spawns) non-spawns
  const old = (() => {
    const spawns = b.filter((e) => e.kind === KIND.SPAWN).length, budget = Math.max(0, 512 - spawns);
    const keep = new Set(); let n = 0;
    for (let i = b.length - 1; i >= 0; i--) { if (b[i].kind === KIND.SPAWN) keep.add(b[i]); else if (n < budget) { keep.add(b[i]); n++; } }
    return b.filter((e) => keep.has(e));
  })();
  check("(old policy dropped the attaches, the appearance change and the removal)",
    !old.some((e) => e.kind === KIND.ATTACH) && !old.some((e) => e.kind === KIND.APPEARANCE) && !old.some((e) => e.kind === KIND.REMOVE));
  const r = compactEntityBacklog(b);
  check("new: all 70 spawns, 10 attaches, the appearance change and the removal survive",
    b.filter((e) => e.kind === KIND.SPAWN).length === 70 && b.filter((e) => e.kind === KIND.ATTACH).length === 10 &&
    b.some((e) => e.kind === KIND.APPEARANCE) && b.some((e) => e.kind === KIND.REMOVE));
  check("the flood collapses to one POSITION + one MOTION per mover", b.filter((e) => e.kind === KIND.POSITION).length === 20 &&
    b.filter((e) => e.kind === KIND.MOTION).length === 20, `${r.before} -> ${r.after}`);
  check("and stays small enough to replay", r.after === 70 + 10 + 2 + 40);
  const again = compactEntityBacklog(b);
  check("compacting again changes nothing", again.coalesced === 0 && again.after === r.after);
}

console.log("\nhard cap (a backlog nobody drains)");
{
  const b = [ev(KIND.SPAWN, 1), ev(KIND.APPEARANCE, 1), ev(KIND.SPAWN, 2), ev(KIND.REMOVE, 1), ev(KIND.ATTACH, 3), ev(KIND.SPAWN, 4)];
  const r = compactEntityBacklog(b, { hardCap: 4 });
  check("oldest non-spawns go first", kindsOf(b).join() === [KIND.SPAWN, KIND.SPAWN, KIND.ATTACH, KIND.SPAWN].join() && r.hardDropped === 2 && r.spawnsDropped === 0, kindsOf(b).join());
  const c = [ev(KIND.SPAWN, 1), ev(KIND.SPAWN, 2), ev(KIND.SPAWN, 3), ev(KIND.REMOVE, 4)];
  const r2 = compactEntityBacklog(c, { hardCap: 2 });
  check("spawns go last, oldest first", c.map((e) => `${e.kind}:${e.guid}`).join() === `${KIND.SPAWN}:2,${KIND.SPAWN}:3` && r2.spawnsDropped === 1,
    c.map((e) => `${e.kind}:${e.guid}`).join());
  check("default hard cap is generous", BACKLOG_HARD_CAP >= 4096);
  const empty = [];
  check("empty backlog", compactEntityBacklog(empty).after === 0);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
