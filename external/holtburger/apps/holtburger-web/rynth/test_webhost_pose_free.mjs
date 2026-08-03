// test_webhost_pose_free.mjs — the per-tick wasm pose box must be freed
// (2026-08-03 review F6, task #150).
//
// `GetPlayerPose` resolves to the wasm `getLocalPlayerPose`, which returns a
// wasm-bindgen `LocalPlayerPose` box (`pkg/holtburger_web.d.ts` declares
// `free(): void`). `_tick` copies its scalars into a frozen snapshot and then
// dropped the box. `start(hz = 15)` drives `_tick` from a WORKER interval
// specifically so a backgrounded tab keeps ticking, so the orphans accrue for
// the whole session — in the module every pose read in bot.js and
// goto_compose.js goes through. `free()` is NOT idempotent, so the tick must
// free exactly once.
//
// Run: node rynth/test_webhost_pose_free.mjs

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const { RynthWebHost } = await import("./webhost.js");

// A wasm-bindgen-shaped pose box: reading a field after free() throws, exactly
// as a freed wasm-bindgen object does ("null pointer passed to rust").
function makePoseBox({ landblockId = 0xa9b40021, x = 10, y = 20, z = 30 } = {}) {
  let freed = 0;
  const box = {
    get landblockId() { if (freed) throw new Error("null pointer passed to rust"); return landblockId; },
    get x() { if (freed) throw new Error("null pointer passed to rust"); return x; },
    get y() { if (freed) throw new Error("null pointer passed to rust"); return y; },
    get z() { if (freed) throw new Error("null pointer passed to rust"); return z; },
    get heading() { if (freed) throw new Error("null pointer passed to rust"); return 1.25; },
    free() { freed += 1; },
  };
  Object.defineProperty(box, "freedCount", { get: () => freed });
  return box;
}

function makeHost(boxes) {
  let i = 0;
  const handle = {
    getLocalPlayerPose: () => boxes[Math.min(i++, boxes.length - 1)],
    getCurrentCellId: () => 0xa9b40021,
    getPlayerId: () => 0x50000001,
    isPlayerReady: () => true,
  };
  return new RynthWebHost(handle, { entityMap: new Map(), noEventTap: true });
}

// ── one tick frees exactly one box ─────────────────────────────────────────
{
  const boxes = [makePoseBox()];
  const host = makeHost(boxes);
  host._tick();
  check("the pose box is freed after the tick", boxes[0].freedCount === 1,
    `freedCount=${boxes[0].freedCount}`);
  check("…exactly once (free() is not idempotent)", boxes[0].freedCount === 1);
  check("the snapshot still carries the copied scalars",
    host.snap.pose && host.snap.pose.x === 10 && host.snap.pose.y === 20 &&
    host.snap.pose.z === 30 && host.snap.pose.objCellId === 0xa9b40021,
    JSON.stringify(host.snap.pose));
  check("the snapshot survives the free (values were copied, not aliased)",
    Object.isFrozen(host.snap.pose) && Number.isFinite(host.snap.pose.heading));
}

// ── every tick frees its own box: no accumulation ──────────────────────────
{
  const boxes = Array.from({ length: 40 }, () => makePoseBox());
  const host = makeHost(boxes);
  for (let n = 0; n < 40; n += 1) host._tick();
  const leaked = boxes.filter((b) => b.freedCount === 0).length;
  const doubleFreed = boxes.filter((b) => b.freedCount > 1).length;
  check("40 ticks leak zero boxes", leaked === 0, `leaked=${leaked}`);
  check("40 ticks double-free zero boxes", doubleFreed === 0, `doubleFreed=${doubleFreed}`);
  check("the free counter tracks the ticks", host._posesFreed === 40,
    `_posesFreed=${host._posesFreed}`);
}

// ── the indoor-spawn heal path (landblockId 0) still frees ─────────────────
{
  const boxes = [makePoseBox({ landblockId: 0 })];
  const host = makeHost(boxes);
  host._tick();
  check("the landblockId=0 heal path frees too", boxes[0].freedCount === 1);
  check("…and the heal still substituted the live cell",
    host.snap.pose.objCellId === 0xa9b40021, JSON.stringify(host.snap.pose));
}

// ── a host whose capability is absent must not throw ───────────────────────
{
  const host = new RynthWebHost({ getPlayerId: () => 1 }, { entityMap: new Map(), noEventTap: true });
  let threw = false;
  try { host._tick(); } catch (_) { threw = true; }
  check("a pose-less host ticks without throwing", !threw);
  check("…and reports a null pose", host.snap.pose === null);
}

console.log("");
console.log(`webhost pose free: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
