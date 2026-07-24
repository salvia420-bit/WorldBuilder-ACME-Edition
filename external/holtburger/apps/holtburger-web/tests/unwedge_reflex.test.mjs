// unwedge_reflex.test.mjs — general wedge self-recovery (rynth/unwedge.js).
//
// Simulates a wedge with a mock host (pose static while movement is
// commanded) and asserts, with a fake clock:
//   1. a legitimately IDLE bot (no movement commanded) NEVER triggers;
//   2. the detector fires after ~T of commanded-but-not-translating, cancels
//      the router, and issues a retreat MoveToPosition toward the most recent
//      usable breadcrumb (a known-free pose);
//   3. reaching the breadcrumb (pose translates back to open ground) frees
//      the recovery, records the wedge into the explore-memory avoid set, and
//      nudges the director;
//   4. two router FAILs at effectively the same position also trigger;
//   5. a retreat that never translates escalates through the trail and then
//      to RECALL: the known recall spell is cast (goto_compose.
//      attemptRecallCast), the resulting teleport frees the bot, and the
//      kernel run-state is restored;
//   6. with NO recall spell known, the honest recall-unavailable fact is
//      journaled and the @teleloc last resort fires at the OLDEST breadcrumb;
//   7. kernel.js yields the tick to "Unwedge" below Vitals and above a
//      pinned Combat;
//   8. ExploreMemory.markWedge makes frontier() stop offering tiles at the
//      wedge position.
//
// Standalone node script (repo test convention): run with
//   cd apps/holtburger-web && node tests/unwedge_reflex.test.mjs

const here = new URL(".", import.meta.url);
const { UnwedgeReflex } = await import(new URL("../rynth/unwedge.js", here));
const { RynthBotKernel } = await import(new URL("../rynth/kernel.js", here));
const { ExploreMemory } = await import(new URL("../rynth/ai/explore_memory.js", here));
const { worldX, worldY } = await import(new URL("../rynth/nav_frame.js", here));

let pass = 0;
let fail = 0;
function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail !== undefined ? ` — ${detail}` : ""}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arbitrary EnvCell-style id — the module must never care which one.
const CELL = 0x5a5b0134;

function makeRig(opts = {}) {
  const state = {
    pose: { objCellId: CELL, x: 10, y: 10, z: 0, cellResolved: true },
    knownSpells: opts.knownSpells ?? [],
    onCast: opts.onCast ?? null,
    onChat: opts.onChat ?? null,
  };
  const host = {
    moves: [],
    stops: 0,
    casts: [],
    chats: [],
    TryGetPlayerPose: () => state.pose,
    MoveToPosition(cell, x, y, z, run) {
      this.moves.push({ cell: cell >>> 0, x, y, z, run });
      return true;
    },
    StopCompletely() {
      this.stops += 1;
      return true;
    },
    GetCastBusyState: () => 0,
    CastSpell(target, id) {
      this.casts.push(id);
      if (state.onCast) state.onCast(id);
      return true;
    },
    InvokeChatParser(text) {
      this.chats.push(text);
      if (state.onChat) state.onChat(text);
      return true;
    },
    s: { playerKnownSpells: () => state.knownSpells },
  };
  const clock = { t: 1_000_000 };
  const em = { calls: [], markWedge(wx, wy, r) { this.calls.push({ wx, wy, r }); } };
  const journal = { notes: [], add(kind, text) { this.notes.push(text); } };
  const director = { early: [], requestEarlyCheck(reason) { this.early.push(reason); } };
  const bot = {
    router: {
      cancelled: 0,
      status: { state: "IDLE" },
      cancel() {
        this.cancelled += 1;
        this.status.state = "IDLE";
      },
    },
    loot: null,
    mission: null,
    kernel: {
      running: true,
      stopped: 0,
      started: 0,
      stop() { this.running = false; this.stopped += 1; },
      start() { this.running = true; this.started += 1; return true; },
    },
    ai: { journal, director, extensions: { exploreMemory: em } },
  };
  const reflex = new UnwedgeReflex(host, { now: () => clock.t, log: () => {}, ...(opts.reflex || {}) });
  reflex.bot = bot;
  // step(seconds): advance the fake clock and tick once per 500ms slice.
  const step = (seconds) => {
    const slices = Math.max(1, Math.round((seconds * 1000) / 500));
    for (let i = 0; i < slices; i++) {
      clock.t += 500;
      reflex.tick();
    }
  };
  return { state, host, clock, em, journal, director, bot, reflex, step };
}

// Walk the pose in +y at ~1 m/s for `seconds` with the router WALKing —
// builds a genuine breadcrumb trail of free poses.
function walkPhase(rig, seconds) {
  rig.bot.router.status.state = "WALK";
  for (let i = 0; i < seconds * 2; i++) {
    rig.state.pose = { ...rig.state.pose, y: rig.state.pose.y + 0.5 };
    rig.step(0.5);
  }
}

// ── 1. idle bot never triggers ──────────────────────────────────────────────
{
  const rig = makeRig();
  rig.bot.router.status.state = "IDLE"; // nothing commands movement
  rig.step(60); // a full minute of static pose
  check("idle: stays MONITOR", rig.reflex.state === "MONITOR", rig.reflex.state);
  check("idle: no recovery moves issued", rig.host.moves.length === 0, `${rig.host.moves.length} moves`);
  check("idle: zero wedges counted", rig.reflex.wedges === 0);
}

// ── 2+3. commanded wedge -> retreat to breadcrumb -> freed ─────────────────
{
  const rig = makeRig();
  walkPhase(rig, 10); // lay a ~10m trail of crumbs
  check("wedge: crumbs recorded while walking", rig.reflex.status.crumbs >= 8, `${rig.reflex.status.crumbs} crumbs`);
  const wedgeY = rig.state.pose.y;
  // Now WEDGE: router keeps WALKing, pose only oscillates ±0.2m.
  let flip = 1;
  for (let i = 0; i < 30 && rig.reflex.state === "MONITOR"; i++) {
    rig.state.pose = { ...rig.state.pose, y: wedgeY + 0.2 * flip };
    flip = -flip;
    rig.step(1);
  }
  check("wedge: detector fired into RETREAT", rig.reflex.state === "RETREAT", rig.reflex.state);
  check("wedge: fired within ~15s of stall", rig.reflex.wedges === 1);
  check("wedge: router walk cancelled", rig.bot.router.cancelled >= 1);
  const retreatMove = rig.host.moves[rig.host.moves.length - 1];
  check("wedge: retreat MoveToPosition issued", !!retreatMove);
  check(
    "wedge: retreat targets a breadcrumb behind the wedge (>=1.5m back)",
    retreatMove && retreatMove.y <= wedgeY - 1.5,
    retreatMove && `target y=${retreatMove.y}, wedge y=${wedgeY}`,
  );
  check("wedge: avoid set recorded in explore memory", rig.em.calls.length === 1);
  check(
    "wedge: journal notes the wedge",
    rig.journal.notes.some((n) => n.includes("[unwedge] WEDGED")),
  );
  check("wedge: movement claimed while recovering", rig.reflex.active() === true);
  // Retreat WORKS: pose walks back toward the target ~1m per 500ms tick.
  for (let i = 0; i < 40 && rig.reflex.state === "RETREAT"; i++) {
    const dy = retreatMove.y - rig.state.pose.y;
    const stepM = Math.sign(dy) * Math.min(Math.abs(dy), 0.5);
    rig.state.pose = { ...rig.state.pose, y: rig.state.pose.y + stepM };
    rig.step(0.5);
  }
  check("freed: back to MONITOR after reaching the crumb", rig.reflex.state === "MONITOR", rig.reflex.state);
  check("freed: recovery recorded ok", rig.reflex.lastResult?.ok === true, JSON.stringify(rig.reflex.lastResult));
  check("freed: director nudged", rig.director.early.some((r) => r.startsWith("unwedged")));
  check("freed: freed counter bumped", rig.reflex.freedCount === 1);
}

// ── 4. double-FAILED at the same position triggers ─────────────────────────
{
  const rig = makeRig();
  walkPhase(rig, 8);
  // Two FAILED edges at the (now static) pose, with WALK gaps between — the
  // goto-retry-FAIL loop. Pose never moves during the fails.
  rig.bot.router.status.state = "FAILED";
  rig.step(1);
  rig.bot.router.status.state = "WALK";
  rig.step(1);
  rig.bot.router.status.state = "FAILED";
  rig.step(1);
  check("double-FAILED: detector fired", rig.reflex.state === "RETREAT", rig.reflex.state);
  check(
    "double-FAILED: reason names the FAILs",
    rig.journal.notes.some((n) => n.includes("FAILED twice")),
  );
}

// ── 5. retreat exhaustion escalates to RECALL (spell known) ────────────────
{
  const rig = makeRig({
    knownSpells: [1635],
    reflex: {
      retreatLegMs: 1000,
      reissueMs: 300,
      maxRetreatCrumbs: 2,
      recallTune: { poseTimeoutMs: 300, posePollMs: 10, recallTeleportMs: 500, teleportPollMs: 10, portalJumpM: 30, adminTeleWaitMs: 300 },
    },
  });
  rig.state.onCast = () => {
    // The recall lands: teleport the pose 5 landblocks away.
    rig.state.pose = { objCellId: 0x0102015a, x: 20, y: 20, z: 0, cellResolved: true };
  };
  walkPhase(rig, 10);
  const wedgeY = rig.state.pose.y;
  let flip = 1;
  for (let i = 0; i < 30 && rig.reflex.state === "MONITOR"; i++) {
    rig.state.pose = { ...rig.state.pose, y: wedgeY + 0.2 * flip };
    flip = -flip;
    rig.step(1);
  }
  check("recall: wedge detected", rig.reflex.state === "RETREAT", rig.reflex.state);
  // Pose NEVER translates during retreat — walk the fake clock until the
  // trail is exhausted and the reflex escalates.
  for (let i = 0; i < 30 && rig.reflex.state === "RETREAT"; i++) rig.step(1);
  check("recall: escalated to RECALL after bounded retreat", rig.reflex.state === "RECALL", rig.reflex.state);
  // The recall path runs on real timers — wait for it.
  const t0 = Date.now();
  while (rig.reflex.state === "RECALL" && Date.now() - t0 < 5000) await sleep(20);
  check("recall: Lifestone Recall was cast", rig.host.casts.includes(1635), JSON.stringify(rig.host.casts));
  check("recall: recovery finished ok", rig.reflex.state === "MONITOR" && rig.reflex.lastResult?.ok === true, JSON.stringify(rig.reflex.lastResult));
  check("recall: recall counter bumped", rig.reflex.recalls === 1);
  check("recall: kernel paused during recall", rig.bot.kernel.stopped >= 1);
  check("recall: kernel run-state restored", rig.bot.kernel.started >= 1 && rig.bot.kernel.running === true);
}

// ── 6. recall-unavailable -> honest fact + @teleloc last resort ────────────
{
  const rig = makeRig({
    knownSpells: [], // character cannot recall
    reflex: {
      retreatLegMs: 1000,
      reissueMs: 300,
      maxRetreatCrumbs: 2,
      recallTune: { poseTimeoutMs: 200, posePollMs: 10, recallTeleportMs: 200, teleportPollMs: 10, portalJumpM: 30, adminTeleWaitMs: 500 },
    },
  });
  rig.state.onChat = () => {
    // The admin teleport lands on the OLDEST breadcrumb.
    const c = rig.reflex._crumbs[0];
    rig.state.pose = { objCellId: c.cell, x: c.x, y: c.y, z: c.z, cellResolved: true };
  };
  walkPhase(rig, 10);
  const wedgeY = rig.state.pose.y;
  let flip = 1;
  for (let i = 0; i < 30 && rig.reflex.state === "MONITOR"; i++) {
    rig.state.pose = { ...rig.state.pose, y: wedgeY + 0.2 * flip };
    flip = -flip;
    rig.step(1);
  }
  for (let i = 0; i < 30 && rig.reflex.state === "RETREAT"; i++) rig.step(1);
  check("teleloc: escalated to RECALL", rig.reflex.state === "RECALL", rig.reflex.state);
  const t0 = Date.now();
  while (rig.reflex.state === "RECALL" && Date.now() - t0 < 5000) await sleep(20);
  check("teleloc: no spell cast (none known)", rig.host.casts.length === 0);
  check(
    "teleloc: recall-unavailable journaled honestly",
    rig.journal.notes.some((n) => n.includes("recall-unavailable")),
  );
  check(
    "teleloc: @teleloc issued to a breadcrumb",
    rig.host.chats.length === 1 && rig.host.chats[0].startsWith("@teleloc 0x"),
    JSON.stringify(rig.host.chats),
  );
  check("teleloc: recovery finished ok", rig.reflex.lastResult?.ok === true, JSON.stringify(rig.reflex.lastResult));
}

// ── 7. kernel priority: Unwedge preempts a pinned Combat, yields to Vitals ─
{
  const mkHost = () => ({ IsPlayerReady: () => true, StopStick() { this.stopped = true; } });
  const combat = { locked: 1, kills: 0, ticked: 0, tick() { this.ticked += 1; }, _scanTargets: () => [{}] };
  const host = mkHost();
  const active = { on: true };
  const kernel = new RynthBotKernel(host, {
    combat,
    buff: null,
    loot: null,
    vitals: null,
    unwedge: { active: () => active.on },
  });
  kernel.log = () => {};
  kernel.tick();
  check("kernel: yields the tick to Unwedge over a pinned Combat", kernel.action === "Unwedge", kernel.action);
  check("kernel: combat loop not ticked while unwedging", combat.ticked === 0);
  active.on = false;
  kernel.tick();
  check("kernel: combat resumes once recovery ends", kernel.action === "Combat" && combat.ticked === 1, kernel.action);
  // Vitals still beats Unwedge (hard survival first).
  const host2 = mkHost();
  const vitals = { stepped: 0, step() { this.stepped += 1; return true; }, status: {} };
  const kernel2 = new RynthBotKernel(host2, {
    combat: null,
    buff: null,
    loot: null,
    vitals,
    unwedge: { active: () => true },
  });
  kernel2.log = () => {};
  kernel2.tick();
  check("kernel: Vitals still preempts Unwedge", kernel2.action === "Vitals" && vitals.stepped === 1, kernel2.action);
}

// ── 8. ExploreMemory avoid set steers the frontier away from the wedge ─────
{
  let t = 2_000_000;
  const em = new ExploreMemory({ now: () => (t += 2000) });
  // Outdoor cell (low16 < 0x0100), arbitrary landblock.
  const cell = 0x12340019;
  em.observe({ objCellId: cell, x: 50, y: 50, z: 0 });
  const fr1 = em.frontier();
  check("avoid: frontier exists before the wedge", !!fr1);
  em.markWedge(fr1.worldX, fr1.worldY); // the frontier tile IS the wedge spot
  const fr2 = em.frontier();
  check("avoid: frontier still exists after the wedge", !!fr2);
  const moved = fr2 && Math.hypot(fr2.worldX - fr1.worldX, fr2.worldY - fr1.worldY) > 0.01;
  check("avoid: frontier no longer offers the wedge tile", moved, fr2 && `fr2=(${fr2.worldX},${fr2.worldY})`);
  const clear = fr2 && Math.hypot(fr2.worldX - fr1.worldX, fr2.worldY - fr1.worldY) > 8;
  check("avoid: new frontier sits outside the avoid radius", clear, fr2 && `${Math.hypot(fr2.worldX - fr1.worldX, fr2.worldY - fr1.worldY).toFixed(1)}m`);
  check("avoid: wedgeAvoids snapshot reports the entry", em.wedgeAvoids().length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
