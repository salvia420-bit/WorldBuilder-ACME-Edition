// tools/metrics.js — hourly "is it working" numbers (SPEC-navatlas §3-W3.5):
// per hour, journal one line with distance covered, unique landblocks, atlas
// routes recorded/reused, kills, deaths, LLM calls and token spend — so
// drawing-board discussions get numbers instead of vibes.
//
// Survival invariant: every tap is try/caught; a broken metrics module can
// never take down the bot or the director. Journal kind is "note" (the
// journal KINDS set is frozen; unknown kinds normalize to note anyway).

const WALK_JUMP_CUTOFF_M = 50; // per-sample deltas beyond this are portals/teleports, not walking

const worldXY = (p) => ({
  x: (((p.objCellId >>> 24) & 0xff) * 192) + p.x,
  y: (((p.objCellId >>> 16) & 0xff) * 192) + p.y,
});

export function createAiMetrics(bot, { journal, intervalMs = 3_600_000, sampleMs = 5_000 } = {}) {
  // Live counters other modules bump (routes tool: routesReused; the
  // auto-record wiring: routesRecorded).
  const live = { distanceM: 0, lbs: new Set(), deaths: 0, routesRecorded: 0, routesReused: 0 };
  try { bot._metrics = live; } catch { /* frozen bot object -> counters stay local */ }

  let lastPose = null;
  let lastSampleT = 0;
  const sample = () => {
    const now = Date.now();
    if (now - lastSampleT < sampleMs) return;
    lastSampleT = now;
    try {
      const p = bot?.host?.TryGetPlayerPose?.();
      if (!p) { lastPose = null; return; }
      live.lbs.add((p.objCellId >>> 16) & 0xffff);
      if (lastPose) {
        const a = worldXY(lastPose), z = worldXY(p);
        const d = Math.hypot(z.x - a.x, z.y - a.y);
        if (d > 0 && d < WALK_JUMP_CUTOFF_M) live.distanceM += d;
      }
      lastPose = p;
    } catch { lastPose = null; }
  };
  try { bot?.host?.onTick?.(sample); } catch { /* no tick plane -> distance stays 0 */ }

  try {
    bot?.host?.onEvent?.((e) => {
      try {
        // kind 29 = death broadcast; u32 = victim guid (bot.js early-check wiring).
        if (e?.kind === 29 && (e.u32 >>> 0) === (bot.host.GetPlayerId() >>> 0)) live.deaths++;
      } catch { /* tap must never reach the pump */ }
    });
  } catch { /* no event plane -> deaths stay 0 */ }

  // Cumulative externals are snapshot-diffed per flush window.
  const externals = () => {
    const s = { kills: null, calls: null, prompt: null, completion: null };
    try { s.kills = bot?.kernel?.status?.kills ?? null; } catch { /* n/a */ }
    try { s.calls = bot?.ai?.director?.status?.calls ?? null; } catch { /* n/a */ }
    try {
      const sp = bot?.ai?.client?.spend;
      if (sp) { s.prompt = sp.promptTokens ?? null; s.completion = sp.completionTokens ?? null; }
    } catch { /* n/a */ }
    return s;
  };

  let winStart = Date.now();
  let prevExt = externals();
  const flush = () => {
    try {
      const ext = externals();
      const d = (k) =>
        typeof ext[k] === "number" && typeof prevExt[k] === "number" ? ext[k] - prevExt[k] : "?";
      const mins = Math.max(1, Math.round((Date.now() - winStart) / 60_000));
      journal?.add?.(
        "note",
        `metrics (${mins}m): moved ${Math.round(live.distanceM)}m | landblocks ${live.lbs.size} | ` +
          `routes recorded ${live.routesRecorded} reused ${live.routesReused} | kills ${d("kills")} | ` +
          `deaths ${live.deaths} | llm calls ${d("calls")} tokens ${d("prompt")}p/${d("completion")}c`,
      );
      prevExt = ext;
      winStart = Date.now();
      live.distanceM = 0;
      live.lbs.clear();
      live.deaths = 0;
      live.routesRecorded = 0;
      live.routesReused = 0;
    } catch { /* a metrics line must never cost anything else */ }
  };

  const timer = setInterval(flush, intervalMs);
  if (typeof timer?.unref === "function") timer.unref();

  return {
    live,
    flush,
    stop() { try { clearInterval(timer); } catch { /* already gone */ } },
  };
}
