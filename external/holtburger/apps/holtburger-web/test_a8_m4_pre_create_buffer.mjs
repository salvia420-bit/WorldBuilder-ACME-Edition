// A8-M4 (2026-06-11 unification survey) — generic pre-create event buffer
// (retail null-object analog), behind `?preCreateBuffer=on`.
//
// Standalone node ESM test (no live ACE session, no browser). Two parts:
//   PART 1 — behavioral: import scene3d/pre_create_buffer.js directly
//            (pure / dependency-free by construction) and exercise the
//            buffer contract, the retail 25 s refresh-on-enqueue expiry,
//            and the ROADMAP acceptance test — replay a SHUFFLED event
//            order through a mini entity-manager honoring the entities.js
//            drain semantics and assert convergence.
//   PART 2 — static: read scene3d/entities.js + docs/url-flags.md as text
//            and assert the flag gate, the enqueue/drain/purge/sweep
//            wiring, and the flag doc are actually in the shipped source.
//
// Run:
//   cd apps/holtburger-web/
//   node test_a8_m4_pre_create_buffer.mjs

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
// PART 1 — behavioral: the buffer contract.
// =====================================================================
console.log("PART 1 — behavioral buffer contract");

// (1) importing the module must have NO module-scope side effects.
const hadWindowBefore = typeof globalThis.window !== "undefined";
const mod = await import("./scene3d/pre_create_buffer.js");
const { createPreCreateBuffer, PRE_CREATE_EXPIRY_MS } = mod;
check(
  "import has no module-scope side effects (no window.* defined)",
  (typeof globalThis.window !== "undefined") === hadWindowBefore,
);
check("PRE_CREATE_EXPIRY_MS is the retail 25 s (acclient.c:310666)", PRE_CREATE_EXPIRY_MS === 25000);

// (2) FIFO replay order within a guid (retail queue_netblob replay).
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(7, "visibility", { visible: false });
  b.enqueue(7, "visibility", { visible: true });
  b.enqueue(7, "other", { x: 1 });
  const evs = b.takeFor(7);
  check(
    "takeFor returns events FIFO (arrival order)",
    evs.length === 3 && evs[0].data.visible === false && evs[1].data.visible === true && evs[2].kind === "other",
  );
  check("takeFor consumes (second take empty, size 0)", b.takeFor(7).length === 0 && b.size() === 0);
}

// (3) dedupeKind keeps last-write-wins for attach but appends at the tail
// (cross-kind arrival order preserved).
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(9, "attach", { parentGuid: 1 }, { dedupeKind: true });
  b.enqueue(9, "visibility", { visible: true });
  b.enqueue(9, "attach", { parentGuid: 2 }, { dedupeKind: true });
  const evs = b.takeFor(9);
  check(
    "dedupeKind drops the earlier attach, fresh one appends at tail",
    evs.length === 2 && evs[0].kind === "visibility" && evs[1].kind === "attach" && evs[1].data.parentGuid === 2,
  );
}

// (4) hasFor with and without a kind filter.
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(3, "visibility", { visible: false });
  check(
    "hasFor: any-kind true, matching kind true, other kind false, other guid false",
    b.hasFor(3) && b.hasFor(3, "visibility") && !b.hasFor(3, "attach") && !b.hasFor(4),
  );
}

// (5) takeMatching pulls cross-guid (the wielder-side attach scan) and
// leaves non-matching events in place.
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(10, "attach", { parentGuid: 99 });
  b.enqueue(10, "visibility", { visible: true });
  b.enqueue(11, "attach", { parentGuid: 99 });
  b.enqueue(12, "attach", { parentGuid: 50 });
  const got = b.takeMatching((g, ev) => ev.kind === "attach" && ev.data.parentGuid === 99);
  check(
    "takeMatching returns matches with owning guids",
    got.length === 2 && got[0].guid === 10 && got[1].guid === 11,
  );
  check(
    "takeMatching leaves non-matches (visibility@10, attach@12)",
    b.hasFor(10, "visibility") && !b.hasFor(10, "attach") && b.hasFor(12, "attach") && b.size() === 2,
  );
}

// (6) removeMatching drops without returning; visibility survives an
// attach-only purge (the _detachChild contract).
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(5, "attach", { parentGuid: 1 });
  b.enqueue(5, "visibility", { visible: false });
  b.removeMatching((g, ev) => g === 5 && ev.kind === "attach");
  check(
    "removeMatching(attach) keeps the parked visibility",
    !b.hasFor(5, "attach") && b.hasFor(5, "visibility") && b.size() === 1,
  );
}

// (7) purgeGuid drops the whole bucket (the remove() despawn contract).
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(6, "attach", { parentGuid: 1 });
  b.enqueue(6, "visibility", { visible: true });
  b.enqueue(8, "visibility", { visible: true });
  b.purgeGuid(6);
  check("purgeGuid drops the bucket, others untouched", !b.hasFor(6) && b.hasFor(8) && b.size() === 1);
}

// (8) expiry: strictly-older-than 25 s from the LAST enqueue; the stamp is
// refreshed on every enqueue (retail AddObjectToBeDestroyed remove+re-add).
{
  let t = 0;
  const b = createPreCreateBuffer({ now: () => t });
  t = 0;
  b.enqueue(20, "visibility", { visible: true });
  check("at exactly 25 000 ms the bucket survives (> not >=)", b.expire(25000) === 0 && b.hasFor(20));
  check("at 25 001 ms the bucket expires", b.expire(25001) === 1 && !b.hasFor(20) && b.size() === 0);
  // refresh: second enqueue at t=20 000 restarts the window
  t = 0;
  b.enqueue(21, "visibility", { visible: true });
  t = 20000;
  b.enqueue(21, "attach", { parentGuid: 1 });
  check("refresh-on-enqueue: alive at 26 000 (6 s after last enqueue)", b.expire(26000) === 0 && b.hasFor(21));
  check(
    "whole bucket (both events) expires together at 45 001",
    b.expire(45001) === 1 && !b.hasFor(21) && b.size() === 0,
  );
}

// (9) ROADMAP acceptance — shuffled-replay convergence. A mini manager
// honoring the entities.js drain semantics: visibility for an unspawned
// guid buffers; attach with either rig missing buffers (dedupeKind, keyed
// by child); spawn drains takeFor(guid) in order then the wielder-side
// takeMatching scan; an attach replay whose counterpart is STILL missing
// re-parks (the legacy _flushPendingAttach retry).
console.log("PART 1b — shuffled-replay convergence");
{
  const CHILD = 100;
  const PARENT = 200;

  function makeMiniManager() {
    const buf = createPreCreateBuffer({ now: () => 0 });
    const spawned = new Set();
    const visible = new Map();
    const attached = new Map(); // child -> parent
    const m = {
      buf, spawned, visible, attached,
      setVisibility(g, v) {
        if (!spawned.has(g)) { buf.enqueue(g, "visibility", { visible: v }); return; }
        visible.set(g, v);
      },
      attach(c, p) {
        if (!spawned.has(c) || !spawned.has(p)) {
          buf.enqueue(c, "attach", { parentGuid: p }, { dedupeKind: true });
          return;
        }
        attached.set(c, p);
        buf.removeMatching((g, ev) => g === c && ev.kind === "attach");
      },
      spawn(g) {
        spawned.add(g);
        for (const ev of buf.takeFor(g)) {
          if (ev.kind === "attach") m.attach(g, ev.data.parentGuid);
          else if (ev.kind === "visibility") m.setVisibility(g, ev.data.visible);
        }
        for (const ev of buf.takeMatching((cg, e) => e.kind === "attach" && e.data.parentGuid === g)) {
          m.attach(ev.guid, ev.data.parentGuid);
        }
      },
    };
    return m;
  }

  // Event stream: wire events keep their relative order (the wire is
  // ordered); the two spawn COMMITS land at every possible interleaving
  // (the async rig build is what races in production).
  const wire = [
    ["vis", CHILD, false],
    ["attach", CHILD, PARENT],
    ["vis", CHILD, true],
  ];
  function interleavings(streamA, streamB) {
    if (streamA.length === 0) return [streamB];
    if (streamB.length === 0) return [streamA];
    const out = [];
    for (const rest of interleavings(streamA.slice(1), streamB)) out.push([streamA[0], ...rest]);
    for (const rest of interleavings(streamA, streamB.slice(1))) out.push([streamB[0], ...rest]);
    return out;
  }
  const spawnOrders = [
    [["spawn", CHILD], ["spawn", PARENT]],
    [["spawn", PARENT], ["spawn", CHILD]],
  ];
  let orders = 0;
  let converged = 0;
  for (const spawns of spawnOrders) {
    for (const seq of interleavings(wire, spawns)) {
      orders += 1;
      const m = makeMiniManager();
      for (const op of seq) {
        if (op[0] === "vis") m.setVisibility(op[1], op[2]);
        else if (op[0] === "attach") m.attach(op[1], op[2]);
        else m.spawn(op[1]);
      }
      const ok =
        m.visible.get(CHILD) === true &&
        m.attached.get(CHILD) === PARENT &&
        m.buf.size() === 0;
      if (ok) converged += 1;
    }
  }
  check(
    `all ${orders} shuffled orders converge (visible=true, attached, buffer drained)`,
    orders === 20 && converged === orders,
    `${converged}/${orders}`,
  );

  // (10) drop-the-spawn case: no spawn ever arrives → the bucket expires
  // and nothing leaks (retail destroys the placeholder + queued blobs).
  let t = 0;
  const b = createPreCreateBuffer({ now: () => t });
  b.enqueue(CHILD, "visibility", { visible: true });
  b.enqueue(CHILD, "attach", { parentGuid: PARENT }, { dedupeKind: true });
  t = 30000;
  check("never-spawned guid fully expires (no leak)", b.expire(t) === 1 && b.size() === 0 && b.guidCount() === 0);
}

// =====================================================================
// PART 2 — static wiring in the shipped source.
// =====================================================================
console.log("PART 2 — static wiring");

const entitiesSrc = readFileSync(joinPath(__dirname, "scene3d", "entities.js"), "utf8");
const flagsDoc = readFileSync(joinPath(__dirname, "docs", "url-flags.md"), "utf8");

check(
  "entities.js imports the pure module",
  entitiesSrc.includes('import { createPreCreateBuffer } from "./pre_create_buffer.js"'),
);
check(
  "flag reader reads ?preCreateBuffer (default off)",
  entitiesSrc.includes('.get("preCreateBuffer")') && entitiesSrc.includes("function readPreCreateBufferFlag()"),
);
check(
  "constructor reads the flag once + builds the buffer",
  entitiesSrc.includes("this._preCreateBufferOn = readPreCreateBufferFlag()") &&
    entitiesSrc.includes("this._preCreate = createPreCreateBuffer()"),
);
check(
  "setVisibility no-inst branch enqueues kind visibility under the flag",
  entitiesSrc.includes('this._preCreate.enqueue(g, "visibility", { visible: !!visible })'),
);
check(
  "attach park enqueues kind attach with dedupeKind under the flag",
  entitiesSrc.includes('this._preCreate.enqueue(cGuid, "attach"') &&
    entitiesSrc.includes("{ dedupeKind: true }"),
);
check(
  "spawn-commit drains via _drainPreCreate (flag on) and keeps the legacy flushes (flag off)",
  entitiesSrc.includes("this._drainPreCreate(guid);") &&
    entitiesSrc.includes("_drainPreCreate(guid) {") &&
    entitiesSrc.includes("this._flushPendingAttach(guid);") &&
    entitiesSrc.includes("this._pendingVisibility.has(guid)"),
);
check(
  "wieldedSpawn pending-attach probe consults whichever map owns the park",
  entitiesSrc.includes('this._preCreate.hasFor(guid, "attach")') &&
    entitiesSrc.includes("this._pendingAttach.has(guid)"),
);
check(
  "drain covers the wielder-side attach scan",
  entitiesSrc.includes("ev.data.parentGuid === g"),
);
check(
  "remove() purges the despawned guid's bucket",
  entitiesSrc.includes("this._preCreate.purgeGuid(g);"),
);
check(
  "_detachChild + direct mount cancel ONLY parked attaches",
  (entitiesSrc.match(/this\._preCreate\.removeMatching\(\(g, ev\) => g === cGuid && ev\.kind === "attach"\)/g) || []).length === 2,
);
check(
  "tick(dt) runs the once-per-second 25 s expiry sweep",
  entitiesSrc.includes("this._preCreate.expire(sweepNow)") &&
    entitiesSrc.includes("this._preCreateLastSweepMs = sweepNow"),
);
check(
  "ForceObjdesc nag documented as NOT implemented (ACE support unresolved)",
  /SendForceObjdesc[\s\S]{0,400}NOT implemented/.test(entitiesSrc) ||
    /NOT implemented[\s\S]{0,400}SendForceObjdesc/.test(entitiesSrc),
);
check(
  "docs/url-flags.md documents ?preCreateBuffer=on",
  flagsDoc.includes("?preCreateBuffer=on") && flagsDoc.includes("A8-M4"),
);

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
