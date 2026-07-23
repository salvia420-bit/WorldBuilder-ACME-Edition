#!/usr/bin/env node
/*
 * Comprehension monitor v2 for the stream-rig bot.
 *
 * Everything v1 did (FROZEN detect + auto-recover, NOT-MOVING, DIRECTOR-STALL,
 * DISCONNECTED, STREAM-DOWN, crash-safe CDP connect loop, selective emits,
 * 5-min OK heartbeat) PLUS deep plan comprehension: tracks the director's
 * plan -> execution -> outcome lifecycle from the REAL journal/mission/router
 * surfaces and classifies every finished plan (completed / partial / failed /
 * abandoned / superseded) with WHEN / WHY / HOW / WHERE.
 *
 * Ground-truth surfaces (discovered live 2026-07-23, field names verified):
 *   window.__bot.ai.journal.entries      [{t, kind: plan|result|note|error|budget, text}]
 *       plan   text: "<analysis> | actions: goto, use_object | next: 2m"
 *       result text: "goto:ok use_object:FAIL <error...>"  (space-joined)
 *       error  text: "llm: ..." | "reply: ..." | "observe: ..." | "internal: ..."
 *       note   text: 'goto ARRIVED after N leg(s) — you are now at 0x.. (x,y)...'
 *                    'route FAILED: "label" (STATE)' | 'route arrived: "label"'
 *                    '[pressure] idle — frontier hop toward 0x.. (~12m, 0°)'
 *                    'use_object Door (0x..) — walk:route-failed(7/8)+door(..)+settled, used'
 *   window.__bot.ai.director             _lastCheckAt/_nextCheckAt/_calls/
 *                                        _consecutiveErrors/enabled/_running/_holdSince/_lastSummary
 *   window.__bot.mission / lastMission   {kind, label, to?, startedAt, interrupts,
 *                                         endedAt, result:{ok, state, coverage}}
 *                                        state: DONE|FAILED|CANCELLED|TIMEOUT|STALLED|UNKNOWN
 *   window.__bot.router.status           {state: IDLE|WALK|PORTAL|DONE|FAILED,
 *                                         leg, legs, walked, stitchBlocked, portalBlocked}
 *   window.__bot._metrics                {distanceM, deaths, routesRecorded, routesReused}
 *   window.__hbWasm.arrivalPlacementDiag()  packed u32: lo16 engaged / hi16 failed
 *
 * IMPORTANT semantics: the director AWAITS plan execution (bot.goto resolves on
 * arrival/failure) and journals the plan AND result entries together at
 * check-in END. So a (plan, result) pair is the atomic outcome record; the
 * execution duration is planEntry.t - director._lastCheckAt (the check-in
 * start). "goto:ok" means ARRIVED (bot.goto resolved ok), not merely "sent";
 * "use_object:ok" means the use was SENT — its walk evidence lives in the
 * preceding "use_object ... — walk:..." note.
 */
const { chromium } = require('playwright');
const { execSync } = require('child_process');

const CDP = 'http://127.0.0.1:9223';
const SAMPLE_MS       = 30000;   // base poll interval
const EVAL_TIMEOUT_MS = 8000;    // per-sample page.evaluate deadline
const FROZEN_SAMPLES  = 2;       // consecutive eval timeouts => FROZEN
const STALL_MS        = 180000;  // 3 min no movement => NOT-MOVING
const DIR_STALL_MS    = 420000;  // 7 min no new director check-in => stall
const OK_HEARTBEAT_MS = 300000;  // 5 min positive liveness beat
const REALERT_MS      = 300000;  // re-emit a still-active alert at most this often
const MOVE_EPS        = 1.0;     // yards; below this (and same lb) = "not moved"
const RECOVER_COOLDOWN_MS = 300000; // >=5 min between auto-recovers
const MAX_RECOVERS    = 6;       // session safety cap

// plan-comprehension tuning (director cadence floor is ~51-78s; journal writes
// land at check-in end, we sample every 30s => detection lag <= 1 sample)
const PLAN_RING_MAX      = 60;    // rolling per-plan outcome window
const LLM_ERR_STREAK     = 2;     // consecutive llm/reply errors => alert
const FRONTIER_HOP_MIN   = 5;     // same-target pressure hops w/o closing => stuck
const FRONTIER_SPAN_MS   = 120000; // ...spanning at least this long
const EXEC_MS_SANE_MAX   = 12 * 60000; // discard exec-duration outliers
const STUCK_WINDOW       = 40;    // samples (~20 min) for the %-stuck metric

const now = () => Date.now();
const iso = () => new Date().toISOString();
const emit = (m) => console.log(`${iso()} ${m}`);
const mins = (ms) => (ms / 60000).toFixed(1);
const secs = (ms) => `${Math.round(ms / 1000)}s`;

let lastPos = null, lastMoveTs = now();
let lastDirCalls = null, lastDirChangeTs = now();
let frozenCount = 0, wasFrozen = false;
let lastOkTs = 0;
let lastAlert = {};           // type -> ts (for re-alert throttling)
let recoverCount = 0, lastRecoverTs = 0;
let disconnectedSince = null;
let connectWarned = false;

// ---- plan-comprehension state ----
// Process entries from shortly before start (journal persists in localStorage;
// V2_BACKFILL_MS extends the window for offline replay/validation runs).
let lastJournalT = now() - (Number(process.env.V2_BACKFILL_MS) || 120000);
let planRing = [];                 // [{t, dirCall, outcome, why, execMs, actions}]
let llmErrStreak = 0;
let lastLlmErrText = '';           // last LLM error detail (kept for future dedup)
let pressureHops = [];             // recent [{t, target, dist}] same-target run
let lastMissionStartedAt = null;
let lastApd = null;                // arrivalPlacementDiag baseline {engaged, failed}
let lastDeaths = null;
let lastPlanEntry = null;          // most recent journal plan entry {t, text}
let lastPlanDirCall = null;        // dir-call index of the last processed plan
let missionFailNotes = new Map();  // label -> {state, t} from 'route FAILED' notes
let stuckFlags = [];               // rolling booleans, one per sample (for % stuck)
let dirCadence = [];               // recent lastCheckAt values (cadence estimate)

function alertThrottled(type, msg) {
  const t = now();
  if (lastAlert[type] && (t - lastAlert[type]) < REALERT_MS) return;
  lastAlert[type] = t;
  emit(msg);
}
function clearAlert(type) { delete lastAlert[type]; }

function ffmpegAlive() {
  try { execSync('pgrep -x ffmpeg', { stdio: 'ignore' }); return true; }
  catch { return false; }
}

async function evalState(page) {
  // Race the evaluate against a hard deadline so a blocked main thread is
  // detected as a timeout rather than hanging the monitor. Every field read
  // is individually guarded — missing globals across boots must not throw.
  return await Promise.race([
    page.evaluate((sinceT) => {
      const o = { now: Date.now() };
      try { o.boot = window.__bootState; } catch (e) { o.boot = null; }
      try {
        const p = window.__sessionHandle && window.__sessionHandle.getLocalPlayerPose
          ? window.__sessionHandle.getLocalPlayerPose() : null;
        o.pose = p ? { x: p.x, y: p.y, z: p.z, lb: (p.landblockId >>> 0) } : null;
        if (p && p.free) p.free();
      } catch (e) { o.pose = null; }
      try {
        const d = window.__bot && window.__bot.ai && window.__bot.ai.director;
        o.dir = d ? {
          calls: (d._callTimes || []).length,
          totalCalls: d._calls || 0,
          plan: (d._lastSummary || '').replace(/\s+/g, ' ').slice(0, 90),
          lastCheckAt: d._lastCheckAt || null,
          nextCheckAt: d._nextCheckAt || null,
          consecutiveErrors: d._consecutiveErrors || 0,
          enabled: !!d.enabled,
          running: !!d._running,
          holdSince: d._holdSince || null,
        } : null;
      } catch (e) { o.dir = null; }
      try {
        const j = window.__bot && window.__bot.ai && window.__bot.ai.journal;
        o.journal = j && Array.isArray(j.entries)
          ? j.entries.filter(e => e && e.t > sinceT).slice(-120)
              .map(e => ({ t: e.t, kind: e.kind, text: String(e.text || '').slice(0, 400) }))
          : null;
      } catch (e) { o.journal = null; }
      try {
        const m = window.__bot && window.__bot.mission;
        o.mission = m ? { kind: m.kind, label: String(m.label || '').slice(0, 60),
                          startedAt: m.startedAt, interrupts: m.interrupts || 0 } : null;
      } catch (e) { o.mission = null; }
      try {
        const m = window.__bot && window.__bot.lastMission;
        o.lastMission = m ? { kind: m.kind, label: String(m.label || '').slice(0, 60),
                              startedAt: m.startedAt, endedAt: m.endedAt,
                              result: m.result ? { ok: m.result.ok === true,
                                                   state: m.result.state || null,
                                                   coverage: m.result.coverage || null } : null } : null;
      } catch (e) { o.lastMission = null; }
      try {
        const r = window.__bot && window.__bot.router;
        o.router = r ? { state: r.state, leg: r.leg, legs: (r.route || []).length,
                         walked: r.walked, stitchBlocked: !!r.failedLegStitch,
                         portalBlocked: !!r.failedLegPortal,
                         legAgeMs: r.legStartAt ? (Date.now() - r.legStartAt) : null } : null;
      } catch (e) { o.router = null; }
      try {
        const m = window.__bot && window.__bot._metrics;
        o.metrics = m ? { distanceM: m.distanceM || 0, deaths: m.deaths || 0,
                          routesRecorded: m.routesRecorded || 0, routesReused: m.routesReused || 0 } : null;
      } catch (e) { o.metrics = null; }
      try {
        const v = window.__hbWasm && window.__hbWasm.arrivalPlacementDiag
          ? (window.__hbWasm.arrivalPlacementDiag() >>> 0) : null;
        o.apd = v == null ? null : { engaged: v & 0xffff, failed: (v >>> 16) & 0xffff };
      } catch (e) { o.apd = null; }
      try { o.kernelRunning = !!(window.__bot && window.__bot.kernel && window.__bot.kernel.running); } catch (e) { o.kernelRunning = null; }
      try { o.moveClaimed = window.__bot && typeof window.__bot.movementClaimed === 'function'
              ? !!window.__bot.movementClaimed() : null; } catch (e) { o.moveClaimed = null; }
      try { o.bot = !!window.__bot; } catch (e) { o.bot = false; }
      return o;
    }, lastJournalT),
    new Promise((_, rej) => setTimeout(() => rej(new Error('eval-timeout')), EVAL_TIMEOUT_MS)),
  ]);
}

async function maybeRecover(reason) {
  const t = now();
  if (recoverCount >= MAX_RECOVERS) {
    alertThrottled('recover-cap', `⛔ RECOVER CAP hit (${MAX_RECOVERS}) — NOT auto-recovering; needs a human. (${reason})`);
    return;
  }
  if ((t - lastRecoverTs) < RECOVER_COOLDOWN_MS) return; // cooldown
  recoverCount++; lastRecoverTs = t;
  emit(`🛠️  AUTO-RECOVER #${recoverCount} (${reason}) — SIGKILL game chromium + relaunch...`);
  try { execSync('bash /mnt/wbterminal2/stream/recover-stream-game.sh', { timeout: 60000, stdio: 'ignore' }); }
  catch (e) { emit(`   recover script error: ${e.message}`); }
  // reset motion/dir baselines so the fresh boot isn't instantly re-flagged
  lastPos = null; lastMoveTs = now(); lastDirCalls = null; lastDirChangeTs = now();
  frozenCount = 0; disconnectedSince = null;
  // journal persists in localStorage across a relaunch; lastJournalT stands so
  // reloaded entries are not re-processed. Mission/apd baselines reset.
  lastMissionStartedAt = null; lastApd = null; pressureHops = [];
}

// ---------------------------------------------------------------------------
// plan comprehension
// ---------------------------------------------------------------------------

/** WHERE string from a pose sample. Indoor = (objCellId & 0xFFFF) >= 0x100. */
function whereStr(pose) {
  if (!pose) return 'WHERE=unknown';
  const indoor = (pose.lb & 0xffff) >= 0x100 ? 'indoor' : 'outdoor';
  return `WHERE=0x${pose.lb.toString(16)} (${pose.x.toFixed(0)},${pose.y.toFixed(0)}) ${indoor}`;
}

/** Map an action-result error string to a root cause. Only asserts a cause the
 *  string actually evidences; falls through to unknown(<seen>). Patterns are
 *  the EXACT error texts produced by actions.js / goto_compose.js /
 *  global_router.js / extensions.js (verified against source 2026-07-23). */
function classifyError(err) {
  const e = String(err || '');
  const rules = [
    [/goto already active|goto active/i, 'movement-claimed(another goto/route owns the mover)'],
    [/indoor dungeon cell|you are indoors|outdoor goto cannot route/i, 'indoor-cell-refusal(outdoor goto from/into a dungeon cell)'],
    [/position unresolved|cell 0 — respawn/i, 'pose-unresolved(cell 0 streaming gap)'],
    [/looks like a bare landblock word/i, 'llm-bad-args(bare landblock word)'],
    [/sidecar unreachable|bad JSON from sidecar|^HTTP \d+|empty route/i, 'route-plan-failed(nav sidecar)'],
    [/blocked stitch leg/i, 'wall-blocked-stitch(straight-line leg hit geometry)'],
    [/portal transit failed/i, 'portal-transit-failed'],
    [/portal touch failed/i, 'portal-touch-failed(no hop after USE)'],
    [/recall-unavailable/i, 'recall-unavailable'],
    [/jump-unavailable/i, 'jump-unavailable'],
    [/indoor graph unavailable/i, 'indoor-graph-unavailable(cell not resident/baked)'],
    [/no reachable exit|no outdoor exit reachable|unreachable/i, 'unreachable(no path in walkable graph)'],
    [/walk stalled \(host stopped ticking/i, 'host-tick-stalled'],
    [/no player pose/i, 'pose-lost'],
    [/route cancelled|CANCELLED/i, 'superseded(cancelled by newer command)'],
    [/TIMEOUT|timed out/i, 'route-timeout(leg watchdog)'],
    [/exit walk failed|indoor walk failed|indoor entry walk failed|outdoor walk failed|outdoor approach .* failed|route failed|FAILED/i, 'route-failed'],
    [/unknown action type/i, 'llm-bad-action(nonexistent action type)'],
    [/skipped: if/i, 'guard-skipped(if-condition unmet)'],
    [/operator hold|operator stop|operator-stop/i, 'operator-hold'],
    [/unavailable$/i, 'subsystem-unavailable'],
    [/must be|non-empty|not allowed|refused/i, 'llm-bad-args'],
    [/not found|no such|no .* named|nothing nearby|unknown/i, 'bad-target(id/name not found nearby)'],
  ];
  for (const [re, cause] of rules) if (re.test(e)) return cause;
  return `unknown(${e.slice(0, 70) || 'no error text'})`;
}

/** Parse a journal `result` entry: "goto:ok use_object:FAIL err text talk:ok"
 *  -> [{type, ok, error}] (error text runs until the next `type:(ok|FAIL)`). */
function parseResults(text) {
  const t = String(text || '');
  if (t === 'no actions') return [];
  const re = /([A-Za-z_?][\w?]*)\s*:\s*(ok\b|FAIL)/g;
  const marks = [];
  let m;
  while ((m = re.exec(t)) !== null) marks.push({ type: m[1], ok: m[2] === 'ok', end: re.lastIndex, start: m.index });
  return marks.map((mk, i) => {
    let error = null;
    if (!mk.ok) {
      const stop = i + 1 < marks.length ? marks[i + 1].start : t.length;
      error = t.slice(mk.end, stop).trim() || null;
    }
    return { type: mk.type, ok: mk.ok, error };
  });
}

/** Parse a journal `plan` entry: "<analysis> | actions: a, b | next: 2m". */
function parsePlan(text) {
  const t = String(text || '');
  // Long analyses can push "| next:" past the journal slice — fall back to an
  // end-anchored match so a truncated plan line still yields its action list.
  const am = t.match(/\| actions:\s*([^|]*)\|/) || t.match(/\| actions:\s*(.*)$/);
  const actions = am ? am[1].split(',').map(s => s.trim()).filter(s => s && s !== 'none') : [];
  const intent = t.split(' | actions:')[0].replace(/\s+/g, ' ').trim().slice(0, 80);
  return { intent, actions };
}

const MOVE_ACTIONS = new Set(['goto', 'goto_lb', 'follow_route', 'exit_building', 'goto_object', 'use_object']);

function recordPlanOutcome(rec) {
  planRing.push(rec);
  if (planRing.length > PLAN_RING_MAX) planRing.shift();
}

function planStats() {
  const done = planRing.filter(p => p.outcome === 'completed').length;
  const fail = planRing.filter(p => p.outcome === 'failed').length;
  const part = planRing.filter(p => p.outcome === 'partial').length;
  const other = planRing.length - done - fail - part;
  const graded = done + fail + part;
  const rate = graded ? Math.round(100 * done / graded) : null;
  const execs = planRing.map(p => p.execMs).filter(v => Number.isFinite(v));
  const mean = execs.length ? Math.round(execs.reduce((a, b) => a + b, 0) / execs.length) : null;
  return { total: planRing.length, done, fail, part, other, rate, mean };
}

/** Process journal entries that arrived since the last sample. This is the
 *  core plan-lifecycle tracker: (plan, result) pairs are the atomic outcome
 *  record (director journals both at check-in END after awaited execution). */
function processJournal(s) {
  const entries = (s.journal || []).slice().sort((a, b) => a.t - b.t);
  for (const e of entries) {
    if (e.t <= lastJournalT) continue;
    lastJournalT = e.t;
    try { handleEntry(e, s); } catch (err) { /* never let one entry kill the loop */ }
  }
}

function handleEntry(e, s) {
  const dirCall = s.dir ? s.dir.totalCalls : null;
  if (e.kind === 'plan') {
    lastPlanEntry = { t: e.t, ...parsePlan(e.text), raw: e.text };
    lastPlanDirCall = dirCall;
    // exec duration: check-in start (_lastCheckAt) -> plan journal write.
    // _lastCheckAt only advances on real (non-skipped) check-ins, so within
    // one sample of the write it is still THIS plan's start stamp.
    const lca = s.dir && s.dir.lastCheckAt;
    lastPlanEntry.execMs = (lca && lca <= e.t && (e.t - lca) < EXEC_MS_SANE_MAX) ? (e.t - lca) : null;
    return;
  }
  if (e.kind === 'result') {
    const plan = (lastPlanEntry && (e.t - lastPlanEntry.t) < 30000) ? lastPlanEntry : null;
    const results = parseResults(e.text);
    const fails = results.filter(r => !r.ok);
    const oks = results.filter(r => r.ok);
    const intent = plan ? `"${plan.intent}"` : '(plan text unseen)';
    const acts = plan && plan.actions.length ? plan.actions.join(',') : (results.map(r => r.type).join(',') || 'none');
    const execMs = plan ? plan.execMs : null;
    const execStr = Number.isFinite(execMs) ? ` (exec ${secs(execMs)})` : '';
    const dirStr = dirCall != null ? ` | dir#${dirCall}` : '';
    let outcome, why = null;
    if (!results.length) { outcome = 'completed'; } // "no actions" observation-only check-in
    else if (fails.length && oks.length) {
      outcome = 'partial';
      why = fails.map(f => `${f.type}=${classifyError(f.error)}`).join(' ');
      emit(`⚠️ PLAN-PARTIAL${execStr} ${intent} ok=${oks.map(r => r.type).join(',')} WHY=${why} ${whereStr(s.pose)}${dirStr}`);
    } else if (fails.length) {
      outcome = 'failed';
      why = fails.map(f => `${f.type}=${classifyError(f.error)}`).join(' ');
      emit(`❌ PLAN-FAIL${execStr} ${intent} HOW=${acts} WHY=${why} ${whereStr(s.pose)}${dirStr}`);
    } else {
      outcome = 'completed';
      // brief — success-rate visibility without spamming the feed
      emit(`✅ PLAN-DONE${execStr} ${acts}${dirStr}${plan && plan.actions.some(a => MOVE_ACTIONS.has(a)) ? ` ${whereStr(s.pose)}` : ''}`);
    }
    recordPlanOutcome({ t: e.t, dirCall, outcome, why, execMs, actions: acts });
    llmErrStreak = 0; // a parsed reply ended any llm-error streak
    return;
  }
  if (e.kind === 'error') {
    const m = e.text.match(/^(llm|reply|observe|internal):\s*(.*)$/s);
    const stage = m ? m[1] : 'director';
    const detail = (m ? m[2] : e.text).slice(0, 90);
    if (stage === 'llm' || stage === 'reply') {
      llmErrStreak++;
      lastLlmErrText = detail;
      if (llmErrStreak >= LLM_ERR_STREAK)
        alertThrottled('llmerr', `🧠 DIRECTOR-ERRORS ${llmErrStreak}x consecutive ${stage}-stage failures — "${detail}" (check-ins burning with no plan; ${s.dir ? s.dir.consecutiveErrors : '?'} toward auto-disable)`);
      recordPlanOutcome({ t: e.t, dirCall, outcome: 'no-plan', why: `${stage}-error(${detail.slice(0, 50)})`, execMs: null, actions: null });
    } else {
      alertThrottled('direrr', `🧠 DIRECTOR-ERROR (${stage}) "${detail}"`);
    }
    if (/disabled after \d+ consecutive errors/.test(e.text))
      emit(`⛔ DIRECTOR-DISABLED — ${e.text.slice(0, 120)}`);
    return;
  }
  if (e.kind === 'note') {
    const txt = e.text;
    // route completion notes (the early-check reasons + doGoto's own notes)
    // Fast route-failure evidence: this note is written the moment a walk
    // fails (incl. pressure-controller hops whose lastMission we may not see
    // flip). Emit now; processMission dedupes against it.
    let m = txt.match(/^route FAILED: "([^"]*)" \((\w+)\)/);
    if (m) {
      missionFailNotes.set(m[1], { state: m[2], t: e.t });
      const rt = s.router || {};
      let why = rt.stitchBlocked ? 'wall-blocked-stitch(router.failedLegStitch)'
        : rt.portalBlocked ? 'portal-no-hop(router.failedLegPortal)'
        : m[2] === 'TIMEOUT' ? 'route-timeout(leg watchdog)'
        : m[2] === 'STALLED' ? 'host-tick-stalled'
        : 'route-failed(leg failed — timeout/wedge/no-pose)';
      emit(`🚶 ROUTE-FAIL "${m[1]}" (${m[2]}) legs ${rt.walked ?? '?'}/${rt.legs ?? '?'} WHY=${why} ${whereStr(s.pose)}`);
      return;
    }
    m = txt.match(/^route "([^"]*)" blocked at leg (\S+): (.*)$/);
    if (m) {
      emit(`🚧 ROUTE-BLOCKED "${m[1]}" at leg ${m[2]} WHY=${classifyError(m[3])} ${whereStr(s.pose)}`);
      return;
    }
    // pressure-controller frontier hops: same-target run with no distance
    // progress = the harness bouncing off an unreachable frontier.
    m = txt.match(/^\[pressure\].*?(?:toward|to)\s+(0x[0-9a-f]+)\s*\((?:~(\d+)m)?/i);
    if (m) {
      const hop = { t: e.t, target: m[1].toLowerCase(), dist: m[2] ? parseInt(m[2], 10) : null };
      if (pressureHops.length && pressureHops[pressureHops.length - 1].target !== hop.target) pressureHops = [];
      pressureHops.push(hop);
      if (pressureHops.length > 12) pressureHops.shift();
      if (pressureHops.length >= FRONTIER_HOP_MIN && (hop.t - pressureHops[0].t) >= FRONTIER_SPAN_MS) {
        const d0 = pressureHops[0].dist, dn = hop.dist;
        const closing = (d0 != null && dn != null) ? (d0 - dn) : null;
        if (closing == null || closing < 3) {
          const span = mins(hop.t - pressureHops[0].t);
          alertThrottled('frontier',
            `🌀 STUCK-FRONTIER ${pressureHops.length} hops toward ${hop.target} over ${span}m, distance ${d0 ?? '?'}m→${dn ?? '?'}m (not closing) — WHY=frontier-unreachable(pressure oscillation) ${whereStr(s.pose)}`);
        } else { clearAlert('frontier'); }
      }
      return;
    }
    if (/^goto ARRIVED/.test(txt)) { clearAlert('frontier'); pressureHops = []; return; }
    return;
  }
  // kind === 'budget': holds / spacing floor — normal cadence control, not failure.
}

/** Mission lifecycle (independent evidence stream: covers director gotos AND
 *  pressure-controller hops AND control-channel walks). lastMission flips
 *  exactly once per completed mission — startedAt is its identity. */
function processMission(s) {
  const lm = s.lastMission;
  if (!lm || !lm.startedAt) return;
  if (lastMissionStartedAt === null) { lastMissionStartedAt = lm.startedAt; return; } // baseline, don't re-report old
  if (lm.startedAt === lastMissionStartedAt) return;
  lastMissionStartedAt = lm.startedAt;
  const r = lm.result || {};
  const dur = (lm.endedAt && lm.startedAt) ? (lm.endedAt - lm.startedAt) : null;
  const durStr = Number.isFinite(dur) ? mins(dur) + 'm' : '?';
  if (r.ok) return; // successful walks show up as PLAN-DONE / arrivals; keep quiet
  // dedupe: the 'route FAILED: "label"' journal note already reported this one
  const noted = missionFailNotes.get(lm.label);
  if (noted && lm.endedAt && Math.abs(noted.t - lm.endedAt) < 30000) return;
  // WHY from router flags first (hard evidence), then state
  let why;
  const rt = s.router || {};
  if (r.state === 'CANCELLED') why = 'superseded(cancelled — last command wins)';
  else if (rt.stitchBlocked) why = 'wall-blocked-stitch(router.failedLegStitch)';
  else if (rt.portalBlocked) why = 'portal-no-hop(router.failedLegPortal — arrived at portal, no teleport)';
  else if (r.state === 'TIMEOUT') why = 'route-timeout(leg watchdog expired)';
  else if (r.state === 'STALLED') why = 'host-tick-stalled';
  else if (r.state === 'FAILED') why = 'route-failed(leg failed — timeout/no-pose)';
  else why = `unknown(state=${r.state})`;
  const legStr = rt.legs ? ` legs ${rt.walked ?? '?'}/${rt.legs}` : '';
  const cov = r.coverage ? ` cov=${r.coverage}` : '';
  emit(`🚶 MISSION-${r.state === 'CANCELLED' ? 'CANCELLED' : 'FAIL'} ${lm.kind} "${lm.label}" after ${durStr}${legStr}${cov} WHY=${why} ${whereStr(s.pose)}`);
}

/** Placement + death deltas: cheap high-signal counters. */
function processCounters(s) {
  if (s.apd) {
    if (lastApd && s.apd.failed > lastApd.failed)
      emit(`🛬 ARRIVAL-PLACEMENT-FAIL +${s.apd.failed - lastApd.failed} (now ${s.apd.failed} failed / ${s.apd.engaged} engaged) — arrival placement could not settle the bot`);
    lastApd = s.apd;
  }
  if (s.metrics) {
    if (lastDeaths != null && s.metrics.deaths > lastDeaths)
      emit(`💀 DEATH +${s.metrics.deaths - lastDeaths} (total ${s.metrics.deaths}) — combat interrupted whatever was planned ${whereStr(s.pose)}`);
    lastDeaths = s.metrics.deaths;
  }
}

// ---------------------------------------------------------------------------

async function loop() {
  emit('🟢 comprehension-monitor v2 online — pose/director/freeze/stream + plan-lifecycle comprehension (WHEN/WHY/HOW/WHERE)');
  let browser = null, page = null;

  while (true) {
    // (re)connect
    if (!browser || !page || page.isClosed()) {
      try {
        if (browser) { try { await browser.close(); } catch {} }
        browser = await chromium.connectOverCDP(CDP);
        const ctx = browser.contexts()[0];
        page = ctx.pages().find(p => p.url().includes('holtburger-web/index.html')) || ctx.pages()[0];
        if (!page) throw new Error('no game page');
        connectWarned = false;
        emit('🔗 connected to game page over CDP');
      } catch (e) {
        if (!connectWarned) { emit(`… waiting for game page (${e.message}) — likely booting/relaunch`); connectWarned = true; }
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
    }

    // stream-health (cheap, independent of page responsiveness)
    if (!ffmpegAlive()) alertThrottled('stream', '📴 STREAM-DOWN — ffmpeg push not running (YouTube feed dropped)');
    else clearAlert('stream');

    // sample page state (freeze-detecting)
    let s;
    try {
      s = await evalState(page);
      frozenCount = 0;
      if (wasFrozen) { wasFrozen = false; emit('🔥→OK main thread responsive again'); clearAlert('frozen'); }
    } catch (e) {
      frozenCount++;
      if (frozenCount >= FROZEN_SAMPLES) {
        wasFrozen = true;
        alertThrottled('frozen', `🧊 FROZEN — main thread unresponsive ${frozenCount} samples (~${(frozenCount*EVAL_TIMEOUT_MS/1000)|0}s+ blocked, hot-loop). Recovering.`);
        await maybeRecover('main-thread freeze');
        page = null; // force reconnect after relaunch
      }
      await new Promise(r => setTimeout(r, SAMPLE_MS));
      continue;
    }

    const t = now();
    let sampleStuck = false;

    // plan comprehension runs whenever the page answered (even out-of-world,
    // the journal persists) — each processor is individually guarded.
    try { processJournal(s); } catch (e) {}
    try { processMission(s); } catch (e) {}
    try { processCounters(s); } catch (e) {}

    // disconnect / session loss
    if (s.boot !== 'in-world' || !s.pose) {
      if (!disconnectedSince) disconnectedSince = t;
      if ((t - disconnectedSince) > 90000) // >90s not in-world (past a normal boot dance)
        alertThrottled('disc', `🔌 DISCONNECTED ${mins(t-disconnectedSince)}m — bootState=${s.boot} pose=${!!s.pose} (watchdog should be reloading)`);
    } else {
      if (disconnectedSince) { emit(`🔌→OK back in-world after ${mins(t-disconnectedSince)}m`); disconnectedSince = null; clearAlert('disc'); }

      // motion tracking
      const p = s.pose;
      if (lastPos) {
        const moved = (p.lb !== lastPos.lb) ||
          Math.hypot(p.x - lastPos.x, p.y - lastPos.y) > MOVE_EPS ||
          Math.abs(p.z - lastPos.z) > MOVE_EPS;
        if (moved) { lastMoveTs = t; clearAlert('stuck'); }
      }
      lastPos = p;
      const staticMs = t - lastMoveTs;

      // director cadence tracking
      const calls = s.dir ? s.dir.calls : null;
      if (calls != null) {
        if (lastDirCalls == null || calls !== lastDirCalls) { lastDirChangeTs = t; lastDirCalls = calls; clearAlert('dir'); }
      }
      if (s.dir && s.dir.lastCheckAt && (!dirCadence.length || dirCadence[dirCadence.length - 1] !== s.dir.lastCheckAt)) {
        dirCadence.push(s.dir.lastCheckAt);
        if (dirCadence.length > 10) dirCadence.shift();
      }
      const dirStaticMs = t - lastDirChangeTs;

      // NOT-MOVING: static past threshold while alive. Now enriched with the
      // router/mission view so a wedge is attributed, not just noticed.
      if (staticMs > STALL_MS && s.bot) {
        sampleStuck = true;
        const dirActive = dirStaticMs < staticMs - 30000; // director advanced within the static window
        const rt = s.router || {};
        let how = '';
        if (rt.state === 'WALK') how = ` — router mid-WALK leg ${rt.leg + 1}/${rt.legs} (leg age ${secs(rt.legAgeMs || 0)}): mover active but pose frozen = WALL-WEDGE or settle-land freeze`;
        else if (rt.state === 'PORTAL') how = ' — router in PORTAL settle (far side not streaming in?)';
        else if (s.mission) how = ` — mission "${s.mission.label}" claims movement but router ${rt.state || '?'}`;
        else if (dirActive) how = ' — director ACTIVE but body not moving (wedge/frozen-slide)';
        else how = ' — director also idle';
        alertThrottled('stuck',
          `🚧 NOT-MOVING ${mins(staticMs)}m at (${p.x.toFixed(1)},${p.y.toFixed(1)}) z=${p.z.toFixed(1)} lb=0x${p.lb.toString(16)}${how}`
          + (s.dir ? ` | plan: ${s.dir.plan}` : ''));
      }

      // DIRECTOR-STALL — with hold context (a travel-hold is legitimate; say so)
      if (dirStaticMs > DIR_STALL_MS) {
        const held = s.dir && s.dir.holdSince ? ` (travel-hold ${mins(t - s.dir.holdSince)}m${s.mission ? ` for "${s.mission.label}"` : ''} — legitimate if a route is in flight)` : '';
        alertThrottled('dir', `🧠 DIRECTOR-STALL ${mins(dirStaticMs)}m — no new check-in (calls=${calls})${held}${s.dir && !s.dir.enabled ? ' — DIRECTOR DISABLED' : ''}. AI loop may be dead.`);
      }
      if (s.dir && s.dir.enabled === false && s.bot)
        alertThrottled('dirdis', `⛔ DIRECTOR-DISABLED (enabled=false, consecutiveErrors=${s.dir.consecutiveErrors}) — bot grinds on without an AI`);

      // frontier-oscillation counts as stuck for the % metric
      if (lastAlert['frontier'] && (t - lastAlert['frontier']) < REALERT_MS) sampleStuck = true;

      // periodic OK heartbeat (progress + rolling comprehension metrics)
      if ((t - lastOkTs) > OK_HEARTBEAT_MS) {
        lastOkTs = t;
        const st = planStats();
        const stuckPct = stuckFlags.length ? Math.round(100 * stuckFlags.filter(Boolean).length / stuckFlags.length) : 0;
        let cad = '';
        if (dirCadence.length >= 2) {
          const gaps = dirCadence.slice(1).map((v, i) => v - dirCadence[i]);
          cad = ` every ~${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length / 1000)}s`;
        }
        const plansStr = st.total
          ? ` | plans ${st.done}✓/${st.part}◐/${st.fail}✗${st.other ? `/${st.other}∅` : ''}${st.rate != null ? ` (${st.rate}% ok)` : ''}${st.mean != null ? ` μexec ${secs(st.mean)}` : ''}`
          : '';
        const missionStr = s.mission ? ` | mission: ${s.mission.kind} "${s.mission.label}" ${mins(t - s.mission.startedAt)}m` : '';
        emit(`✅ OK — in-world (${p.x.toFixed(0)},${p.y.toFixed(0)}) lb=0x${p.lb.toString(16)} | moved ${mins(staticMs)}m ago | dir#${s.dir ? s.dir.totalCalls : '?'}${cad}${plansStr} | stuck ${stuckPct}%${missionStr} | plan: ${s.dir ? s.dir.plan : '—'}`);
      }
    }

    stuckFlags.push(sampleStuck);
    if (stuckFlags.length > STUCK_WINDOW) stuckFlags.shift();

    await new Promise(r => setTimeout(r, SAMPLE_MS));
  }
}

loop().catch(e => { emit(`💥 monitor crashed: ${e.stack || e.message}`); process.exit(1); });
