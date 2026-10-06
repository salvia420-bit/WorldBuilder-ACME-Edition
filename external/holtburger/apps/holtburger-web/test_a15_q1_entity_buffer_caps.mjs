// A15-Q1 (2026-06-11 unification survey, Stage Q1) — bound the two
// untracked unbounded-buffer leaks at the dual-renderer seam:
//
//   (a) 3D mode: the 2D `deferredSpawns` queue clones every KIND_SPAWN
//       while `liveScene` is PERMANENTLY null (under ?renderer=3d the 2D
//       PIXI bring-up is skipped), and nothing ever drains it.
//   (b) 2D mode: `__scene3dEntityBacklog`'s buffering stub deep-clones
//       every entity update at module scope unconditionally and is only
//       ever drained/replaced by the 3D-only installSharedDrainHook.
//
// Standalone node ESM test (no live ACE session, no browser, §2.8). Two
// parts:
//   PART 1 — behavioral: drive a verbatim mirror of index.html's
//            __pushBacklog (which calls the SHIPPED scene3d/entity_backlog.js)
//            with >cap synthetic updates, assert the bounds, that state
//            events survive, and that the 3D defer gate skips.
//   PART 2 — static: read index.html as text and assert the caps + the
//            `?spawnDefer2dOnly` gate + the corrected stale comment are
//            actually wired into the shipped source.
//
// Run:
//   cd apps/holtburger-web/
//   node test_a15_q1_entity_buffer_caps.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
// index.html's inline script was split into app/*.js (2026-10-05); text pins
// read the whole boot orchestrator (index.html + app/*.js).
import appSource from "./harness/app_source.cjs";
import { compactEntityBacklog, BACKLOG_HARD_CAP } from "./scene3d/entity_backlog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

// =====================================================================
// PART 1 — behavioral: the ring-cap + 3D-defer-gate, in isolation.
// Mirrors index.html's bufferingHook (__pushBacklog) and the kind=1
// drain-loop arm. Must match the shipped ENTITY_BUFFER_CAP.
// =====================================================================
const ENTITY_BUFFER_CAP = 512;

console.log("PART 1 — behavioral ring-cap + defer gate");

// ---- (b) __scene3dEntityBacklog: bounded, state-safe compaction ------
// 2026-10-06: the shipped __pushBacklog (index.html) compacts through the
// SHIPPED scene3d/entity_backlog.js once the backlog passes ENTITY_BUFFER_CAP
// (then again each time it doubles): POSITION / VELOCITY / MOTION /
// MOTION_ACTION / TURN coalesce to the newest per guid; SPAWN / REMOVE /
// META_REFRESH / APPEARANCE / ATTACH are never dropped; BACKLOG_HARD_CAP
// bounds a backlog the 3D hook never drains. The mirror below is the
// index.html body verbatim minus the console text.
function makePushBacklog() {
  const backlog = [];
  const st = { info: 0, warn: 0 };
  let compactAt = ENTITY_BUFFER_CAP;
  function pushBacklog(cloned) {
    if (!cloned) return;
    const b = backlog;
    b.push(cloned);
    if (b.length < compactAt >>> 1) compactAt = ENTITY_BUFFER_CAP; // drained since
    if (b.length > compactAt) {
      const r = compactEntityBacklog(b, { hardCap: BACKLOG_HARD_CAP });
      compactAt = Math.max(ENTITY_BUFFER_CAP, r.after * 2);
      if (r.hardDropped > 0) { if (!st.warn) st.warn = 1; }
      else if (!st.info) st.info = 1;
    }
  }
  return { backlog, pushBacklog, st };
}
{
  // A populated zone's flood: 200 movers x (position, motion), far past the cap.
  const { backlog, pushBacklog, st } = makePushBacklog();
  const N = ENTITY_BUFFER_CAP * 50;
  // each round of 200 alternates position / motion, so every mover gets both kinds
  for (let i = 0; i < N; i += 1) pushBacklog({ kind: Math.floor(i / 200) % 2 ? 5 : 0, guid: 0x80000000 + (i % 200), seq: i });
  check(
    `a ${N}-update flood from 200 movers stays bounded (one newest position + motion each, plus the tail since the last compaction)`,
    backlog.length <= 2 * ENTITY_BUFFER_CAP,
    `len=${backlog.length}`,
  );
  const newest = new Map();
  for (const e of backlog) newest.set(`${e.guid}:${e.kind}`, Math.max(newest.get(`${e.guid}:${e.kind}`) ?? -1, e.seq));
  check("every mover's NEWEST position and motion survive", newest.size === 400 && [...newest.values()].every((q) => q >= N - 400));
  check("coalescing is reported once (info, latched), never as a loss", st.info === 1 && st.warn === 0);
  const before = backlog.length;
  pushBacklog(null);
  check("null clone is a no-op (freed-handle path)", backlog.length === before);
}
{
  // A backlog nobody drains (distinct guids, nothing to coalesce): the hard cap bounds it.
  const { backlog, pushBacklog, st } = makePushBacklog();
  const N = BACKLOG_HARD_CAP * 3;
  for (let i = 0; i < N; i += 1) pushBacklog({ kind: 0, guid: i });
  check(`never-drained backlog bounded by 2 x BACKLOG_HARD_CAP after ${N} distinct pushes`, backlog.length <= 2 * BACKLOG_HARD_CAP, `len=${backlog.length}`);
  check("the newest survive, the oldest go", backlog[backlog.length - 1].guid === N - 1 && backlog[0].guid > 0, `first=${backlog[0].guid}`);
  check("the hard-cap loss is warned (latched)", st.warn === 1);
}

// ---- (b2) spawn-preserving regression (the ultra-spawn fix) ---------
// The exact failing shape at quality=ultra: an EARLY spawn burst (the
// ~58 ObjectCreate spawns + the one-shot local-player spawn) followed by
// a long KIND_POSITION/KIND_MOTION flood while init3D is slow to install
// the live drain hook. ALL spawns and the rig's spawn must survive — and
// (2026-10-06) so must the burst's wield / appearance / removal events,
// which the 2026-06-17 policy dropped with the filler.
{
  const { backlog, pushBacklog } = makePushBacklog();
  const LOCAL_RIG_GUID = 0x50000008;
  const SPAWN_BURST = 58; // matches the observed low-quality attempted:58
  for (let i = 0; i < SPAWN_BURST; i += 1) pushBacklog({ kind: 1, guid: 0x10000 + i });
  pushBacklog({ kind: 1, guid: LOCAL_RIG_GUID });
  for (let i = 0; i < 10; i += 1) pushBacklog({ kind: 7, guid: 0x20000 + i }); // ATTACH: wielded items
  pushBacklog({ kind: 6, guid: 0x10003 }); // APPEARANCE
  pushBacklog({ kind: 2, guid: 0x10009 }); // REMOVE
  const FLOOD = ENTITY_BUFFER_CAP * 20;
  for (let i = 0; i < FLOOD; i += 1) {
    pushBacklog({ kind: i % 2 === 0 ? 0 : 5, guid: 0x10000 + (i % (SPAWN_BURST + 1)) });
  }
  const spawnsLeft = backlog.filter((e) => (e.kind | 0) === 1);
  check("ALL spawns survive a post-burst position/motion flood", spawnsLeft.length === SPAWN_BURST + 1, `spawns kept=${spawnsLeft.length}/${SPAWN_BURST + 1}`);
  check("the one-shot local-player rig spawn (0x50000008) is preserved", backlog.some((e) => (e.kind | 0) === 1 && (e.guid >>> 0) === LOCAL_RIG_GUID));
  check("the wield (ATTACH), appearance and removal events survive too",
    backlog.filter((e) => e.kind === 7).length === 10 && backlog.some((e) => e.kind === 6) && backlog.some((e) => e.kind === 2));
  check("backlog stays small (state events + one position/motion per guid + the tail)", backlog.length <= 2 * ENTITY_BUFFER_CAP, `len=${backlog.length}`);
}

// ---- (a) deferredSpawns: 3D-defer gate + ring-cap -------------------
function drainArm({ useRenderer3d, spawnDefer2dOnly, liveScene, spawnCount }) {
  const deferredSpawns = [];
  let warned = 0;
  for (let i = 0; i < spawnCount; i += 1) {
    if (liveScene) {
      // handleEntitySpawn(upd) — not exercised here
    } else if (spawnDefer2dOnly && useRenderer3d) {
      // A15-Q1: skip — 3D path already handled the spawn via em.spawn.
    } else {
      deferredSpawns.push({ kind: 1, guid: i });
      if (deferredSpawns.length > ENTITY_BUFFER_CAP) {
        deferredSpawns.splice(0, deferredSpawns.length - ENTITY_BUFFER_CAP);
        if (!warned) warned = 1;
      }
    }
  }
  return { len: deferredSpawns.length, warned };
}

{
  // 3D mode + flag on: deferredSpawns must stay EMPTY (gate skips push).
  const r = drainArm({
    useRenderer3d: true,
    spawnDefer2dOnly: true,
    liveScene: null,
    spawnCount: ENTITY_BUFFER_CAP * 10,
  });
  check(
    "3D mode + ?spawnDefer2dOnly=on → deferredSpawns never grows",
    r.len === 0 && r.warned === 0,
    `len=${r.len}`,
  );
}
{
  // 3D mode, flag OFF (legacy): push happens but is ring-capped.
  const r = drainArm({
    useRenderer3d: true,
    spawnDefer2dOnly: false,
    liveScene: null,
    spawnCount: ENTITY_BUFFER_CAP * 10,
  });
  check(
    "3D mode, flag off → legacy push but bounded at cap",
    r.len === ENTITY_BUFFER_CAP && r.warned === 1,
    `len=${r.len}`,
  );
}
{
  // 2D mode (the flag is irrelevant; liveScene is null pre-boot): bounded.
  const r = drainArm({
    useRenderer3d: false,
    spawnDefer2dOnly: true,
    liveScene: null,
    spawnCount: ENTITY_BUFFER_CAP * 10,
  });
  check(
    "2D mode → defer still active (2D consumes it) but bounded at cap",
    r.len === ENTITY_BUFFER_CAP,
    `len=${r.len}`,
  );
}

// =====================================================================
// PART 2 — static: the caps/gate/comment are wired into index.html.
// =====================================================================
console.log("PART 2 — static source wiring");
const src = appSource.readAppSource();

check(
  "index.html declares ENTITY_BUFFER_CAP = 512",
  /const\s+ENTITY_BUFFER_CAP\s*=\s*512\b/.test(src),
);
check(
  "index.html declares __USE_RENDERER_3D module constant",
  /const\s+__USE_RENDERER_3D\s*=/.test(src),
);
check(
  "index.html parses the ?spawnDefer2dOnly flag",
  src.includes('get("spawnDefer2dOnly")'),
);
check(
  "backlog push compacts through scene3d/entity_backlog.js past ENTITY_BUFFER_CAP",
  /__scene3dEntityBacklog/.test(src) &&
    /import\s*\{[^}]*compactEntityBacklog[^}]*\}\s*from\s*"\.\/scene3d\/entity_backlog\.js"/.test(src) &&
    /let\s+__backlogCompactAt\s*=\s*ENTITY_BUFFER_CAP/.test(src) &&
    /compactEntityBacklog\(b,\s*\{\s*hardCap:\s*BACKLOG_HARD_CAP\s*\}\)/.test(src),
);
// 2026-10-05: the 2D `deferredSpawns` ring these two checks pinned was
// RETIRED with the 2D PIXI spawn handler (index.html dispatch2dSpawn, "RETIRED
// 2026-06-18 (item 7b)"; the buffer itself removed in item 8). The unbounded-
// growth hazard A15-Q1 capped is therefore gone by deletion — pin that it
// stays gone (a re-introduced 2D buffer must come back WITH its cap).
check(
  "retired 2D deferredSpawns buffer stays deleted (no push / no declaration)",
  !/deferredSpawns\.push\(/.test(src) && !/(?:let|const|var)\s+deferredSpawns\b/.test(src),
);
check(
  "the stale 'hook is undefined ... 2D' comment is gone",
  !src.includes("the hook is undefined when ?renderer=3d isn't"),
);
check(
  "the corrected comment notes the hook is ALWAYS defined",
  src.includes("the hook is ALWAYS defined"),
);

// =====================================================================
console.log(`\nA15-Q1 entity-buffer-caps: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
