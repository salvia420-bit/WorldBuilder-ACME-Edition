// test_webhost_seam_update.mjs — RynthWebHost changes of the 2026-10-12
// RynthSuite update (client drift since 2026-07-24):
//
//   A  TryGetPendingConfirmations is non-destructive: the wasm read is a DRAIN,
//      so the AI observation used to eat the dialog before the director's
//      `confirm` action could answer it. Retired by an answer, by kind=71
//      ConfirmationDone, or by the TTL.
//   B  one page-wide event tap (window.__rynthEventHosts): every host gets each
//      event once, dispose() leaves the tap, a pre-existing non-host tap is
//      still called, a later host never re-wraps the dispatcher.
//   C  TryGetFreeSlots / TryGetPackRoom per container (the old formula
//      subtracted the PACKS from a capacity that included every pack).
//   D  wasm boxes freed after copy: InventoryItem, VendorStateJs + VendorItemJs,
//      PlayerStatsSnapshot, LocalPlayerPose (TryGetPlayerPoseLive).
//   E  attribute/vital nextCost from the training-3 stride-5 arrays.
//   F  HasObjectDescFlags is honest: the wasm answers 0 for an UNKNOWN guid.
//   G  SendTell: direct tell, router fallback, never a plain say.
//   H  start()/stop() revoke the worker Blob URL.
//   I  attach() drops per-session state (confirmations, cast claim).
//   J  IsPortalSpaceActive environment capability.
//   K  normalized events carry f32.
//   L  the bot heartbeat drives a stale page net pump (magic slice B1) —
//      hidden page at 200 ms, visible page only once stalled ~1 s (review #16).
//   M  the shared cast token outlives a long windup — 12 s (magic slice B2).
//   N  CancelAttack + TryGetLocalStickyTarget (combat slice).
//   O  GetPlayerId reads the live guid before the first heartbeat.
//
// Run: node rynth/test_webhost_seam_update.mjs

let pass = 0, fail = 0;
const check = (name, ok, extra = "") => {
  if (ok) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ""}`); }
};

const { RynthWebHost } = await import("./webhost.js");
const mk = (session) => new RynthWebHost(session, { entityMap: new Map(), noEventTap: true });

// A wasm-bindgen-shaped box: getters throw after free(), free() is counted.
function box(fields) {
  let freed = 0;
  const b = { free() { freed += 1; } };
  for (const [k, v] of Object.entries(fields)) {
    Object.defineProperty(b, k, {
      get() { if (freed) throw new Error("null pointer passed to rust"); return typeof v === "function" ? v() : v; },
      enumerable: true,
    });
  }
  Object.defineProperty(b, "freedCount", { get: () => freed });
  return b;
}

// ── A  confirmations ───────────────────────────────────────────────────
{
  let queue = [{ confirmType: 5, context: 77, text: "Craft it?" }];
  const sent = [];
  const h = mk({
    pendingConfirmations: () => { const q = queue; queue = []; return q; },
    sendConfirmationResponse: (t, c, a) => sent.push([t, c, a]),
  });
  const first = h.TryGetPendingConfirmations();
  const second = h.TryGetPendingConfirmations();
  check("A1 a drained dialog stays readable (observation no longer eats it)",
    first.length === 1 && second.length === 1 && second[0].context === 77 && second[0].text === "Craft it?",
    JSON.stringify({ first, second }));
  queue = [{ confirmType: 5, context: 77, text: "Craft it? (again)" }];
  check("A2 a re-sent (type, context) replaces, never doubles", h.TryGetPendingConfirmations().length === 1);
  check("A3 answering sends + retires it", h.SendConfirmationResponse(5, 77, true) === true
    && sent.length === 1 && sent[0][0] === 5 && sent[0][1] === 77 && sent[0][2] === true
    && h.TryGetPendingConfirmations().length === 0);
  queue = [{ confirmType: 7, context: 9, text: "Yes or no?" }];
  h.TryGetPendingConfirmations();
  h._dispatchEvent({ kind: 71, u32Payload: 7, u32Payload2: 9 });
  check("A4 kind=71 ConfirmationDone retires it", h.TryGetPendingConfirmations().length === 0);
  queue = [{ confirm_type: 4, context: 1, text: "Join?" }];
  check("A5 snake_case rows normalize", h.TryGetPendingConfirmations()[0]?.confirmType === 4);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 36_000;
    check("A6 retained dialogs expire after the ACE timeout", h.TryGetPendingConfirmations().length === 0);
  } finally {
    Date.now = realNow;
  }
}

// ── B  event tap registry ──────────────────────────────────────────────
{
  const legacy = [];
  const hadWindow = "window" in globalThis;
  globalThis.window = globalThis;
  delete globalThis.__rynthEventHosts;
  globalThis.__rynthOnEvent = (evt) => legacy.push(evt.kind);
  try {
    const h1 = new RynthWebHost({}, { entityMap: new Map() });
    const tap = globalThis.__rynthOnEvent;
    const h2 = new RynthWebHost({}, { entityMap: new Map() });
    const got1 = [], got2 = [];
    h1.onEvent((e) => got1.push(e.kind));
    h2.onEvent((e) => got2.push(e.kind));
    globalThis.__rynthOnEvent({ kind: 2, stringPayload: "x" });
    check("B1 both hosts and the pre-existing tap get the event once",
      got1.join() === "2" && got2.join() === "2" && legacy.join() === "2", JSON.stringify({ got1, got2, legacy }));
    check("B2 a second host does not re-wrap the dispatcher", globalThis.__rynthOnEvent === tap);
    h1.dispose();
    globalThis.__rynthOnEvent({ kind: 13, u32Payload: 0x1d });
    check("B3 a disposed host leaves the tap", got1.join() === "2" && got2.join() === "2,13" && legacy.join() === "2,13",
      JSON.stringify({ got1, got2, legacy }));
    h1.dispose();
    check("B4 dispose is idempotent", globalThis.__rynthEventHosts.size === 1);
  } finally {
    delete globalThis.__rynthEventHosts;
    delete globalThis.__rynthOnEvent;
    if (!hadWindow) delete globalThis.window;
  }
}

// ── C + D  pack room, freed inventory rows ─────────────────────────────
{
  const rows = [];
  const add = (f) => rows.push(f);
  add({ guid: 1, name: "Sword", equipMask: 0x100000, containerId: 0, requiresBackpackSlot: false, itemsCapacity: 0 });
  for (let i = 0; i < 100; i++) add({ guid: 100 + i, name: `junk${i}`, equipMask: 0, containerId: 0, requiresBackpackSlot: false, itemsCapacity: 0 });
  add({ guid: 900, name: "Pack A", equipMask: 0, containerId: 0, requiresBackpackSlot: true, itemsCapacity: 24 });
  add({ guid: 901, name: "Pack B", equipMask: 0, containerId: 0, requiresBackpackSlot: true, itemsCapacity: 24 });
  for (let i = 0; i < 24; i++) add({ guid: 2000 + i, name: `a${i}`, equipMask: 0, containerId: 900, requiresBackpackSlot: false, itemsCapacity: 0 });
  for (let i = 0; i < 3; i++) add({ guid: 3000 + i, name: `b${i}`, equipMask: 0, containerId: 901, requiresBackpackSlot: false, itemsCapacity: 0 });
  const boxes = [];
  const session = {
    playerInventory: () => rows.map((r) => { const b = box(r); boxes.push(b); return b; }),
    playerItemsCapacity: 102,
    playerContainersCapacity: 7,
  };
  const h = mk(session);
  const room = h.TryGetPackRoom();
  check("C1 main pack: 100 items of 102", room.main.used === 100 && room.main.free === 2, JSON.stringify(room.main));
  check("C2 container slots: 2 packs of 7", room.containers.used === 2 && room.containers.free === 5, JSON.stringify(room.containers));
  const a = room.packs.find((p) => p.guid === 900);
  const b = room.packs.find((p) => p.guid === 901);
  check("C3 side packs counted per pack", a && a.free === 0 && b && b.free === 21, JSON.stringify(room.packs));
  check("C4 TryGetFreeSlots = 2 + 0 + 21 (the old formula said 148)", h.TryGetFreeSlots() === 23, String(h.TryGetFreeSlots()));
  check("D1 every InventoryItem box freed exactly once", boxes.length > 0 && boxes.every((x) => x.freedCount === 1),
    `boxes=${boxes.length} bad=${boxes.filter((x) => x.freedCount !== 1).length}`);
  const inv = h.TryGetPlayerInventory();
  check("D2 rows are plain copies (readable after the free)", inv.length === rows.length && inv[0].name === "Sword" && inv[105].containerId === 900);
  check("C5 unknown inventory -> null room", mk({ playerInventory: () => [] }).TryGetFreeSlots() === null);
}

// ── D  vendor state boxes ──────────────────────────────────────────────
{
  const itemBoxes = [];
  let stateBox = null;
  const h = mk({
    getVendorState: (g) => {
      stateBox = box({
        vendorGuid: g, vendorName: "Vendor", buyMultiplier: 0.9, sellMultiplier: 1.5,
        items: () => [1, 2].map((n) => { const b = box({ itemGuid: 0x70 + n, name: `w${n}`, wcid: n, value: 10 * n, stackSize: 1, maxStackSize: 1, itemType: 1, supply: n === 2 ? 3 : -1, packSlot: false }); itemBoxes.push(b); return b; }),
      });
      return stateBox;
    },
  });
  const vs = h.TryGetVendorState(0x2001);
  check("D3 vendor state copied", vs && vs.vendorGuid === 0x2001 && vs.items.length === 2 && vs.items[1].supply === 3 && vs.items[0].maxStackSize === 1,
    JSON.stringify(vs));
  check("D4 VendorStateJs + every VendorItemJs freed", stateBox.freedCount === 1 && itemBoxes.length === 2 && itemBoxes.every((x) => x.freedCount === 1));
}

// ── D + E  player stats ────────────────────────────────────────────────
{
  let statsBox = null;
  const h = mk({
    playerStats: () => (statsBox = box({
      attributes: [2, 60, 50, 10, 6, 40, 40, 0],
      attributeXp: [2, 10, 10, 1234, 567, 6, 0, 10, 0, 0], // self(6) at max -> nextCost 0
      skills: [33, 28, 28, 0, 2, 90],
      vitals: [1, 30, 30, 30],
      vitalXp: [1, 4, 0, 400, 88],
      levelInfo: [7, 0, 0, 1000, 0, 0, 0],
    })),
  });
  const st = h.TryGetPlayerStats();
  check("E1 attribute nextCost/spentXp from attributeXp", st.attributes[2].nextCost === 567 && st.attributes[2].spentXp === 1234 && st.attributes[6].nextCost === 0,
    JSON.stringify(st.attributes));
  check("E2 vital nextCost from vitalXp", st.vitals[1].nextCost === 88, JSON.stringify(st.vitals));
  check("E3 skills + level unchanged", st.skills[33].nextCost === 90 && st.level === 7 && st.unspentXp === 1000);
  check("D5 PlayerStatsSnapshot box freed once", statsBox.freedCount === 1);
  const old = mk({ playerStats: () => ({ attributes: [2, 60, 50, 10], skills: [], vitals: [1, 30, 30, 30], levelInfo: [1, 0, 0, 0, 0] }) }).TryGetPlayerStats();
  check("E4 an older pkg/ (no attributeXp) leaves nextCost undefined", old.attributes[2].nextCost === undefined && old.vitals[1].nextCost === undefined);
}

// ── D  live pose copy ──────────────────────────────────────────────────
{
  let poseBox = null;
  const h = mk({ getLocalPlayerPose: () => (poseBox = box({ landblockId: 0xa9b40021, x: 1, y: 2, z: 3, heading: 0.5, isOnGround: true })) });
  const p = h.TryGetPlayerPoseLive();
  check("D6 TryGetPlayerPoseLive returns a plain copy and frees the box",
    p && p.landblockId === 0xa9b40021 && p.isOnGround === true && poseBox.freedCount === 1, JSON.stringify(p));
}

// ── F  desc flags honesty ──────────────────────────────────────────────
{
  const flags = { 1: 0, 2: 0x10 };
  const h = mk({
    objectDescFlags: (g) => flags[g] ?? 0, // the real wasm: 0 for an unknown guid
    objectName: (g) => (g in flags ? `obj${g}` : undefined),
  });
  check("F1 tracked object, flags 0: has flags, not attackable", h.HasObjectDescFlags(1) === true && h.ObjectIsAttackable(1) === false);
  check("F2 tracked attackable", h.HasObjectDescFlags(2) === true && h.ObjectIsAttackable(2) === true);
  check("F3 unknown guid (wasm 0): no flags -> fail-open", h.HasObjectDescFlags(99) === false && h.ObjectIsAttackable(99) === true);
}

// ── G  SendTell ────────────────────────────────────────────────────────
{
  const tells = [], says = [];
  const direct = mk({ sendTell: (n, m) => tells.push([n, m]), sendChat: (m) => says.push(m) });
  check("G1 direct tell when the capability exists", direct.SendTell("Bob", "hi") === true && tells.length === 1 && tells[0][0] === "Bob" && says.length === 0);
  const routed = [];
  globalThis.__routeSlashCommand = (_s, line) => { routed.push(line); return { dispatched: true, echo: null }; };
  try {
    const viaRouter = mk({ sendChat: (m) => says.push(m) });
    check("G2 no sendTell: routed /t through the chat-bar router", viaRouter.SendTell("Bob", "hi") === true && routed[0] === "/t Bob, hi" && says.length === 0);
  } finally {
    delete globalThis.__routeSlashCommand;
  }
  const bare = mk({ sendChat: (m) => says.push(m) });
  check("G3 no sendTell and no router: refuses, never says it aloud", bare.SendTell("Bob", "hi") === false && says.length === 0);
  check("G4 empty name/text refused", direct.SendTell("", "x") === false && direct.SendTell("Bob", "") === false);
}

// ── H  worker Blob URL ─────────────────────────────────────────────────
{
  const realCreate = URL.createObjectURL, realRevoke = URL.revokeObjectURL, hadWorker = "Worker" in globalThis;
  const created = [], revoked = [];
  URL.createObjectURL = () => { const u = `blob:test/${created.length}`; created.push(u); return u; };
  URL.revokeObjectURL = (u) => revoked.push(u);
  globalThis.Worker = class { constructor(u) { this.u = u; } postMessage() {} terminate() { this.dead = true; } };
  try {
    const h = mk({});
    h.start(10);
    check("H1 running after start", h.running === true && created.length === 1);
    h.start(10); // restart revokes the first URL
    h.stop();
    check("H2 every Blob URL revoked (restart + stop)", revoked.length === 2 && revoked[0] === created[0] && revoked[1] === created[1] && h.running === false,
      JSON.stringify({ created, revoked }));
    // A stopped bot host hears nothing; a host that never ran a heartbeat
    // (the plugin facade's) keeps dispatching.
    const seen = [];
    const bot = mk({});
    bot.onEvent((e) => seen.push(e.kind));
    bot._dispatchEvent({ kind: 1 });
    bot.start(10);
    bot._dispatchEvent({ kind: 2 });
    bot.stop();
    bot._dispatchEvent({ kind: 3 });
    bot.start(10);
    bot._dispatchEvent({ kind: 4 });
    bot.stop();
    const facade = mk({});
    const fseen = [];
    facade.onEvent((e) => fseen.push(e.kind));
    facade.stop();
    facade._dispatchEvent({ kind: 5 });
    check("H3 a stopped bot host ignores events; restart resumes; a never-started host still hears",
      seen.join() === "1,2,4" && fseen.join() === "5", JSON.stringify({ seen, fseen }));
  } finally {
    URL.createObjectURL = realCreate;
    URL.revokeObjectURL = realRevoke;
    if (!hadWorker) delete globalThis.Worker;
  }
}

// ── I  attach() resets per-session state ───────────────────────────────
{
  let queue = [{ confirmType: 5, context: 1, text: "old session" }];
  const h = mk({ pendingConfirmations: () => { const q = queue; queue = []; return q; }, getUseDoneSeq: () => 4 });
  h.TryGetPendingConfirmations();
  h.tryClaimCast("buff");
  h.attach({ pendingConfirmations: () => [] });
  check("I1 a reconnect drops the old session's dialogs and cast claim", h.TryGetPendingConfirmations().length === 0 && h.castToken === null);
}

// ── J  portal space ────────────────────────────────────────────────────
{
  const h = mk({});
  check("J1 absent page seam -> capability off, reads false", h.has("IsPortalSpaceActive") === false && h.IsPortalSpaceActive() === false);
  globalThis.__isPortalSpaceActive = () => true;
  try {
    check("J2 page seam -> capability live, reads true", h.has("IsPortalSpaceActive") === true && h.IsPortalSpaceActive() === true);
    globalThis.__isPortalSpaceActive = () => { throw new Error("x"); };
    check("J3 a throwing seam reads false", h.IsPortalSpaceActive() === false);
  } finally {
    delete globalThis.__isPortalSpaceActive;
  }
}

// ── L  the bot heartbeat keeps the page net pump alive (magic slice B1) ──
{
  const hadWindow = "window" in globalThis;
  const hadDocument = "document" in globalThis;
  globalThis.window = globalThis;
  globalThis.document = { hidden: true }; // hidden tab: rAF stopped
  const pumps = [];
  let ticks = 0;
  try {
    globalThis.__netFramePump = () => { pumps.push(1); globalThis.__lastPumpMs = performance.now(); };
    const h = mk({ tickMovement: () => { ticks += 1; } });
    globalThis.__lastPumpMs = performance.now() - 500;
    h._tick();
    check("L1 a stale page pump is driven from the bot heartbeat", pumps.length === 1 && ticks === 0);
    h._tick();
    check("L2 a fresh pump is left alone", pumps.length === 1);
    delete globalThis.__netFramePump;
    globalThis.__lastPumpMs = performance.now() - 500;
    h._tick();
    check("L3 no page pump exposed: falls back to tickMovement", ticks === 1);
    globalThis.__lastPumpMs = performance.now();
    h._tick();
    check("L4 fresh stamp, no pump exposed: nothing", ticks === 1);
    globalThis.__netFramePump = () => { throw new Error("pump died"); };
    globalThis.__lastPumpMs = performance.now() - 500;
    let threw = false;
    try { h._tick(); } catch (_) { threw = true; }
    check("L5 a throwing pump never breaks the tick", threw === false && h.snap !== null);
    // Review #16: a VISIBLE page keeps its own (maybe slow) frame cadence — it
    // is pumped from the heartbeat only once its rAF pump has stalled ~1 s.
    globalThis.document = { hidden: false };
    let vis = 0;
    globalThis.__netFramePump = () => { vis += 1; globalThis.__lastPumpMs = performance.now(); };
    globalThis.__lastPumpMs = performance.now() - 500; // a 2-fps visible page
    h._tick();
    check("L7 visible page, pump 500 ms old (slow but live): no extra pump", vis === 0);
    globalThis.__lastPumpMs = performance.now() - 1500; // rAF stalled
    h._tick();
    check("L8 visible page, pump stalled 1.5 s: pumped", vis === 1);
  } finally {
    delete globalThis.__netFramePump;
    delete globalThis.__lastPumpMs;
    if (!hadWindow) delete globalThis.window;
    if (!hadDocument) delete globalThis.document;
  }
  if (!("window" in globalThis)) {
    const h = mk({ tickMovement: () => { ticks += 1; } });
    h._tick();
    check("L6 not a page (node harness): no pumping at all", ticks === 1);
  }
}

// ── M  shared cast token outlives a long windup (magic slice B2) ───────
{
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const h = mk({});
    check("M1 buff claims the token", h.tryClaimCast("buff") === true);
    t += 3000; // a level-6 war windup is still in flight
    check("M2 at 3 s another module is still refused (was freed at 2.5 s)", h.tryClaimCast("combat") === false);
    t += 9500;
    check("M3 past 12 s the backstop frees it", h.tryClaimCast("combat") === true);
  } finally {
    Date.now = realNow;
  }
}

// ── K  f32 rides normalized events ─────────────────────────────────────
{
  const h = mk({});
  let seen = null;
  h.onEvent((e) => { seen = e; });
  h._dispatchEvent({ kind: 42, u32Payload: 5, u32Payload2: 6, f32Payload: 0.25 });
  check("K1 normalized event carries f32", seen && seen.f32 === 0.25 && seen.u32 === 5 && seen.u32b === 6);
  h._dispatchEvent({ kind: 2, stringPayload: "x" });
  check("K2 absent f32 -> null", seen.f32 === null);
}

// ── N  combat: CancelAttack + TryGetLocalStickyTarget (combat slice) ───
{
  let cancels = 0, sticky = 0x80001234;
  const h = mk({ cancelAttack: () => { cancels += 1; }, localStickyTarget: () => sticky });
  check("N1 CancelAttack is a capability and calls cancelAttack", h.has("CancelAttack") && h.CancelAttack() === true && cancels === 1);
  check("N2 TryGetLocalStickyTarget returns the live guid as u32", h.TryGetLocalStickyTarget() === 0x80001234);
  sticky = 0;
  check("N3 no sticky target reads 0", h.TryGetLocalStickyTarget() === 0);
  const bare = mk({});
  check("N4 absent exports degrade: CancelAttack false, sticky null",
    bare.has("CancelAttack") === false && bare.CancelAttack() === false && bare.TryGetLocalStickyTarget() === null);
}

// ── O  GetPlayerId before the first heartbeat reads the guid live ──────
{
  const h = mk({ playerGuid: () => 0x50000007 });
  check("O1 no snapshot yet: GetPlayerId reads the live guid (casters gate on it)", h.GetPlayerId() === 0x50000007, String(h.GetPlayerId()));
  const bare = mk({});
  check("O2 no snapshot and no export: 0", bare.GetPlayerId() === 0);
}

console.log(`\nwebhost seam update: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
