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
//   PART 1 — behavioral: reimplement the EXACT ring-cap + 3D-defer-gate
//            semantics, drive them with >cap synthetic updates, assert
//            the length bound holds and the gate skips in 3D mode.
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

// ---- (b) __scene3dEntityBacklog ring-cap ----------------------------
{
  const backlog = [];
  let warned = 0;
  function pushBacklog(cloned) {
    if (!cloned) return;
    backlog.push(cloned);
    if (backlog.length > ENTITY_BUFFER_CAP) {
      backlog.splice(0, backlog.length - ENTITY_BUFFER_CAP);
      if (!warned) warned = 1;
    }
  }
  // Drive far past the cap, as in a populated 2D zone (100s/sec).
  const N = ENTITY_BUFFER_CAP * 50;
  for (let i = 0; i < N; i += 1) pushBacklog({ kind: 0, guid: i });
  check(
    `backlog bounded at ENTITY_BUFFER_CAP after ${N} pushes`,
    backlog.length === ENTITY_BUFFER_CAP,
    `len=${backlog.length}`,
  );
  check(
    "backlog keeps the LATEST N (oldest dropped)",
    backlog[backlog.length - 1].guid === N - 1 &&
      backlog[0].guid === N - ENTITY_BUFFER_CAP,
    `first=${backlog[0].guid} last=${backlog[backlog.length - 1].guid}`,
  );
  check("backlog overflow warned exactly once (latched)", warned === 1);
  // null clones (freed wasm handle) must not grow the buffer.
  const before = backlog.length;
  pushBacklog(null);
  check("null clone is a no-op (freed-handle path)", backlog.length === before);
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
const src = readFileSync(joinPath(__dirname, "index.html"), "utf8");

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
  "backlog push is ring-capped against ENTITY_BUFFER_CAP",
  /__scene3dEntityBacklog/.test(src) &&
    /b\.length\s*>\s*ENTITY_BUFFER_CAP/.test(src),
);
check(
  "deferredSpawns push is ring-capped against ENTITY_BUFFER_CAP",
  /deferredSpawns\.length\s*>\s*ENTITY_BUFFER_CAP/.test(src),
);
check(
  "deferredSpawns push is gated on (__SPAWN_DEFER_2D_ONLY && __USE_RENDERER_3D)",
  /__SPAWN_DEFER_2D_ONLY\s*&&\s*__USE_RENDERER_3D/.test(src),
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
