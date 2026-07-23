// netbrain.js — loader + shadow harness for the .NET-wasm RynthBrain slices
// (apps/holtburger-web/netbrain/AppBundle, built by netbrain/build.sh from the
// C# slices in docs/rynth-integration/netwasm-spike/). This is the production
// half of the D1 path-A′ incremental lift: the debugged C# scoring/scheduling
// runs in-page behind the same RynthWebHost seam as the JS brain.
//
// Modes (URL ?netBrain=... or createGrindBot config.netBrain):
//   on      (DEFAULT, 2026-07-16 soak-validated) — the C# output drives the
//             decision where a slice's live input coverage is trusted (combat
//             target selection); everything else still shadows.
//   shadow  — JS decides; the C# slice is ALSO called at each decision point
//             and divergences are counted/logged on window.__diag.netbrain.
//   off     — nothing loads; zero cost. `?netBrain=off` is the escape hatch.
// A missing/stale AppBundle degrades to the JS brain (version gate + warn),
// so bare-default still boots clean on a fresh clone. Outside a page (node
// harnesses, no `location`) the default stays off — loops under unit tests
// must not fetch bundles unless the test attaches one explicitly.
//
// The AppBundle is ~4.3 MB raw (InvariantGlobalization; verified 2026-07-23
// via `du -sh netbrain/AppBundle` — aligned with url-flags.md `netBrain` and
// STATUS.md, which previously disagreed with this file's stale ~3.9 MB),
// loads once, lazily,
// off the critical boot path. Exports are synchronous string->string JSON
// boundaries (see netbrain/BrainExports.cs); replay_fixtures.mjs is the
// byte-for-byte gate proving the bundle matches native C#.

export function netBrainModeFromUrl(search) {
  try {
    const src = search ?? (typeof location !== "undefined" ? location.search : null);
    if (src == null) return "off"; // no page URL (node harness) — stay off
    const v = new URLSearchParams(src).get("netBrain");
    if (v === "off") return "off";
    if (v === "shadow") return "shadow";
    return "on"; // DEFAULT-ON; matches the repo idiom (explicit "off" escapes)
  } catch {
    return "off";
  }
}

// The bundle version this loader was written against. AppBundle/ is
// gitignored (rebuild-after-pull trap), so JS and bundle WILL skew — a
// mismatched bundle degrades to the JS brain instead of feeding mode-"on"
// outputs whose DTO shape this file no longer understands.
export const EXPECTED_VERSION = "rynth-netbrain-2";

// Loads the mono-wasm AppBundle and returns the brain handle, or null on
// failure (shadow/on must NEVER take the bot down — the JS brain is always
// the fallback). Idempotent while in flight / after success: concurrent and
// repeat calls share one runtime. A FAILED load clears the cache so a later
// bot (supervisor restart) can retry once the bundle is back.
let _loading = null;
export function loadNetBrain(opts = {}) {
  if (_loading) return _loading;
  _loading = (async () => {
    // Normalize a caller-supplied bundle URL: resolve relative/root-relative
    // forms against this module, and force the trailing slash URL-join
    // semantics require (".../AppBundle" would silently drop the segment).
    const raw = opts.bundleUrl ?? new URL("../netbrain/AppBundle/", import.meta.url).href;
    const base = new URL(raw.endsWith("/") ? raw : raw + "/", import.meta.url).href;
    const t0 = Date.now();
    try {
      const { dotnet } = await import(
        /* webpackIgnore: true */ new URL("_framework/dotnet.js", base).href
      );
      const { getAssemblyExports, getConfig } = await dotnet.create();
      const ex = await getAssemblyExports(getConfig().mainAssemblyName);
      const E = ex.RynthBrainExports;
      const v = E.Version();
      if (v !== EXPECTED_VERSION) {
        diag().loadError = `bundle version ${v} != expected ${EXPECTED_VERSION} — rebuild netbrain/build.sh (or pull); staying on JS brain`;
        console.warn(`[netbrain] ${diag().loadError}`);
        _loading = null;
        return null;
      }
      const brain = {
        version: v,
        loadMs: Date.now() - t0,
        // obj->obj wrappers over the JSON boundaries; throws propagate to the
        // shadow callers which catch + count them (never to the bot loop).
        scoreTargets: (input) => JSON.parse(E.ScoreTargets(JSON.stringify(input))),
        scheduleBuffs: (input) => JSON.parse(E.ScheduleBuffs(JSON.stringify(input))),
        evaluateLoot:
          typeof E.EvaluateLoot === "function"
            ? (input) => JSON.parse(E.EvaluateLoot(JSON.stringify(input)))
            : null,
      };
      diag().loaded = { version: brain.version, loadMs: brain.loadMs };
      return brain;
    } catch (e) {
      diag().loadError = String(e?.message || e);
      console.warn("[netbrain] AppBundle load failed — staying on JS brain:", e);
      _loading = null; // transient failure must not poison the page for good
      return null;
    }
  })();
  return _loading;
}

// ---- divergence accounting (window.__diag.netbrain) ----
const MAX_SAMPLES = 40;
let _diag = null;
export function diag() {
  if (_diag) return _diag;
  _diag = {
    mode: "off",
    loaded: null,
    loadError: null,
    calls: { combat: 0, buff: 0, loot: 0 },
    agrees: { combat: 0, buff: 0, loot: 0 },
    diverges: { combat: 0, buff: 0, loot: 0 },
    errors: { combat: 0, buff: 0, loot: 0 },
    // The first call per kind pays the mono-wasm warmup (~270 ms measured;
    // steady state ~1.4 ms) — tracked separately so ms/call reads true.
    firstCallMs: { combat: -1, buff: -1, loot: -1 },
    callMsTotal: { combat: 0, buff: 0, loot: 0 },
    samples: [],
    truncated: 0, // combat shadow inputs that hit the entity cap
    // Counters are page-lifetime (one bot per tab in the fleet pattern);
    // call reset() when re-using a tab across bot generations so agreement
    // rates aren't contaminated by a predecessor's counts.
    reset() {
      for (const k of ["combat", "buff", "loot"]) {
        this.calls[k] = this.agrees[k] = this.diverges[k] = this.errors[k] = 0;
        this.callMsTotal[k] = 0;
        this.firstCallMs[k] = -1;
      }
      this.samples.length = 0;
      this.truncated = 0;
    },
    steadyMs(k) {
      const n = this.calls[k] - (this.firstCallMs[k] >= 0 ? 1 : 0);
      return n > 0 ? this.callMsTotal[k] / n : 0;
    },
    summary() {
      const line = (k) =>
        `${k}: ${this.agrees[k]}/${this.calls[k]} agree, ` +
        `${this.diverges[k]} diverge, ${this.errors[k]} err, ` +
        `${this.steadyMs(k).toFixed(2)} ms/call (first ${this.firstCallMs[k] < 0 ? "-" : this.firstCallMs[k].toFixed(0) + " ms"})`;
      return [
        `netbrain mode=${this.mode} ${this.loaded ? this.loaded.version : "(not loaded)"}`,
        line("combat"),
        line("buff"),
        line("loot"),
      ].join("\n");
    },
  };
  if (typeof window !== "undefined") {
    window.__diag = window.__diag || {};
    window.__diag.netbrain = _diag;
  }
  return _diag;
}

// Run one shadow comparison. kind: combat|buff|loot. buildInput() -> DTO or
// null (skip — state not mappable this tick). callBrain(input) -> C# output.
// compare(csOut) -> { agree: bool, jsVal, csVal } judged by the CALLER's
// semantics (only decision-bearing fields; cadence fields excluded).
// Returns the C# output (for mode "on" callers) or null.
export function shadowTick(brain, kind, buildInput, compare) {
  const d = diag();
  let input;
  try {
    input = buildInput();
  } catch (e) {
    d.errors[kind]++;
    return null;
  }
  if (!brain || !input) return null;
  const t0 = performance.now();
  let out;
  try {
    if (kind === "combat") out = brain.scoreTargets(input);
    else if (kind === "buff") out = brain.scheduleBuffs(input);
    else out = brain.evaluateLoot?.(input);
  } catch (e) {
    d.errors[kind]++;
    return null;
  }
  const callMs = performance.now() - t0;
  d.calls[kind]++;
  if (d.firstCallMs[kind] < 0) d.firstCallMs[kind] = callMs;
  else d.callMsTotal[kind] += callMs;
  if (!out) return null;
  try {
    const { agree, jsVal, csVal } = compare(out);
    if (agree) d.agrees[kind]++;
    else {
      d.diverges[kind]++;
      if (d.samples.length < MAX_SAMPLES)
        d.samples.push({ kind, at: Date.now(), jsVal, csVal, input });
    }
  } catch {
    d.errors[kind]++;
  }
  return out;
}
