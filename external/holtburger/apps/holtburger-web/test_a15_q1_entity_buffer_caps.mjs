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
// SPAWN-PRESERVING eviction (2026-06-17 ultra-spawn fix). Mirrors the
// shipped __pushBacklog body in index.html: KIND_SPAWN (kind===1) is an
// early finite burst that is drained-once wasm-side (never re-emitted), so
// it must NEVER be evicted; the steady KIND_POSITION/KIND_MOTION flood
// (100s/sec) is the filler that gets trimmed oldest-first. Single-pass
// O(n) compaction keeps all spawns + the newest non-spawns that fit.
{
  const backlog = [];
  let warned = 0;
  function pushBacklog(cloned) {
    if (!cloned) return;
    const b = backlog;
    b.push(cloned);
    if (b.length > ENTITY_BUFFER_CAP) {
      let spawnCount = 0;
      for (let i = 0; i < b.length; i += 1) if ((b[i].kind | 0) === 1) spawnCount += 1;
      const nonSpawnBudget = Math.max(0, ENTITY_BUFFER_CAP - spawnCount);
      const keep = new Set();
      let nonSpawnKept = 0;
      for (let i = b.length - 1; i >= 0; i -= 1) {
        const e = b[i];
        if ((e.kind | 0) === 1) keep.add(e);
        else if (nonSpawnKept < nonSpawnBudget) { keep.add(e); nonSpawnKept += 1; }
      }
      const compacted = [];
      for (let i = 0; i < b.length; i += 1) if (keep.has(b[i])) compacted.push(b[i]);
      const overEvicted = compacted.length < b.length;
      b.length = 0;
      for (let i = 0; i < compacted.length; i += 1) b.push(compacted[i]);
      if (overEvicted && !warned) warned = 1;
    }
  }
  // Drive far past the cap with a pure NON-spawn flood (KIND_POSITION),
  // as in a populated 2D zone (100s/sec). With no spawns to preserve,
  // behavior collapses to the legacy keep-latest-N.
  const N = ENTITY_BUFFER_CAP * 50;
  for (let i = 0; i < N; i += 1) pushBacklog({ kind: 0, guid: i });
  check(
    `backlog bounded at ENTITY_BUFFER_CAP after ${N} non-spawn pushes`,
    backlog.length === ENTITY_BUFFER_CAP,
    `len=${backlog.length}`,
  );
  check(
    "pure non-spawn flood keeps the LATEST N (oldest dropped)",
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

// ---- (b2) spawn-preserving regression (the ultra-spawn fix) ---------
// The exact failing shape at quality=ultra: an EARLY spawn burst (the
// ~58 ObjectCreate spawns + the one-shot local-player spawn) followed by
// a long KIND_POSITION/KIND_MOTION flood that, while init3D is slow to
// install the live drain hook, would overflow the 512 ring. The OLD
// oldest-first splice dropped every (oldest) spawn → spawnAttempted:0.
// The fix must keep ALL spawns and the rig's spawn after any flood.
{
  const backlog = [];
  let warned = 0;
  function pushBacklog(cloned) {
    if (!cloned) return;
    const b = backlog;
    b.push(cloned);
    if (b.length > ENTITY_BUFFER_CAP) {
      let spawnCount = 0;
      for (let i = 0; i < b.length; i += 1) if ((b[i].kind | 0) === 1) spawnCount += 1;
      const nonSpawnBudget = Math.max(0, ENTITY_BUFFER_CAP - spawnCount);
      const keep = new Set();
      let nonSpawnKept = 0;
      for (let i = b.length - 1; i >= 0; i -= 1) {
        const e = b[i];
        if ((e.kind | 0) === 1) keep.add(e);
        else if (nonSpawnKept < nonSpawnBudget) { keep.add(e); nonSpawnKept += 1; }
      }
      const compacted = [];
      for (let i = 0; i < b.length; i += 1) if (keep.has(b[i])) compacted.push(b[i]);
      const overEvicted = compacted.length < b.length;
      b.length = 0;
      for (let i = 0; i < compacted.length; i += 1) b.push(compacted[i]);
      if (overEvicted && !warned) warned = 1;
    }
  }
  const LOCAL_RIG_GUID = 0x50000008;
  const SPAWN_BURST = 58; // matches the observed low-quality attempted:58
  // 1) early spawn burst: NPCs/items first, then the local-player rig.
  for (let i = 0; i < SPAWN_BURST; i += 1) pushBacklog({ kind: 1, guid: 0x10000 + i });
  pushBacklog({ kind: 1, guid: LOCAL_RIG_GUID });
  // 2) long position/motion flood, far exceeding the 512 ring.
  const FLOOD = ENTITY_BUFFER_CAP * 20;
  for (let i = 0; i < FLOOD; i += 1) {
    pushBacklog({ kind: i % 2 === 0 ? 0 : 5, guid: 0x10000 + (i % (SPAWN_BURST + 1)) });
  }
  const spawnsLeft = backlog.filter((e) => (e.kind | 0) === 1);
  check(
    "ALL spawns survive a post-burst position/motion flood",
    spawnsLeft.length === SPAWN_BURST + 1,
    `spawns kept=${spawnsLeft.length}/${SPAWN_BURST + 1}`,
  );
  check(
    "the one-shot local-player rig spawn (0x50000008) is preserved",
    backlog.some((e) => (e.kind | 0) === 1 && (e.guid >>> 0) === LOCAL_RIG_GUID),
    "rig spawn present in surviving backlog",
  );
  check(
    "backlog stays bounded (spawns + newest filler ≤ cap once spawns ≤ cap)",
    backlog.length === ENTITY_BUFFER_CAP,
    `len=${backlog.length}`,
  );
  check("spawn-preserving overflow warned exactly once (latched)", warned === 1);
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
