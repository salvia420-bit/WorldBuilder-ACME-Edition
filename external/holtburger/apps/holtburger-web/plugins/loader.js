// =============================================================================
// Plugin loader — PR 8 (Chorizite-absorption, 2026-05-27)
// =============================================================================
//
// Validates plugin manifests, resolves dependencies (with Chorizite's `?`
// optional suffix), runs the 5-stage lifecycle, and exposes an `Eat()`-style
// bus that any handler can use to stop propagation. ESM module; works in both
// browsers (dynamic import) and Node (test).
//
// Adapted from Chorizite's PluginManager (external/chorizite/Chorizite/
// Chorizite.Core/Plugins/PluginManager.cs) per the Chorizite READING_GUIDE
// summary §5.5 items 1-6:
//   1. Manifest schema (validated against schemas/plugin-manifest.json)
//   2. Dependency resolver with `?` optional-suffix syntax
//   3. Validate(out errors) — non-throwing, returns {valid, errors}
//   4. 5-stage lifecycle hooks
//      (onBeforeLoad / onLoad / onBeforeUnload / onUnload / onRequestReload)
//   5. manifest.dev.json sidecar — overrides entry path
//   6. Eat() semantics on bus events
//
// Departures from Chorizite (per READING_GUIDE §4.1):
//   - `entry` instead of `entryFile`
//   - browser/tui/cli environments
//   - semver-range dependencies (npm-style), not exact-equal
//   - new declarative `slots` and `hotkeys` fields
//
// **Not in scope this PR**: live-reload. The 5-stage lifecycle is wired but
// `unloadPlugin` and `requestReload` are only invoked when the host calls
// them explicitly — the loader does not file-watch (per Chorizite §7 aside
// — JS modules cannot be unloaded in browsers, so the right play is full-
// page reload, with the hooks just letting plugins clean up on `beforeunload`).
//
// =============================================================================

/**
 * @typedef {Object} PluginManifest
 * @property {string} id                       Unique plugin id.
 * @property {string} name                     Display name.
 * @property {string} [author]                 Author.
 * @property {string} version                  Semver (`1.2.3` or `1.2.3-rc.1`).
 * @property {string} [description]            One-line description.
 * @property {string} [repo]                   Repo URL.
 * @property {string} [icon]                   Glyph or path.
 * @property {boolean} [iconHidden]            If true, no bar icon. Holtburger ext.
 * @property {string[]} [dependencies]         `id@semver` or `id@semver?` (optional).
 * @property {string[]} [environments]         browser / tui / cli / all.
 * @property {string} [entry]                  Relative module path to ESM entry.
 * @property {string[]} [slots]                bar / hud / panel / overlay / watcher.
 * @property {{id:string,default:string,label?:string}[]} [hotkeys]
 * @property {string} [$schema]                JSON-Schema self-ref; ignored.
 */

/**
 * @typedef {Object} PluginDevManifest
 * Per Chorizite PluginDevManifest.cs:10-58 — when a sidecar `<id>.manifest.dev.json`
 * is supplied, the loader overrides `entry` with `source` so the dev points at
 * a source tree instead of the installed `bin/`.
 * @property {string} [source]                 Override for `entry` — source-tree path.
 * @property {string} [bin]                    Override for `entry` — installed-bin path.
 */

/**
 * Plugin lifecycle hook names. Per Chorizite PluginInstance.cs:46-275 + READING_GUIDE
 * §3.1. Order on load: onBeforeLoad → entry-module-init → onLoad. Order on unload:
 * onBeforeUnload → cleanup → onUnload. `onRequestReload` is plugin-initiated.
 *
 * Plugins may export any subset of these as named exports (e.g.
 * `export function onBeforeLoad(ctx) { … }`). Backwards-compat: the existing
 * `mount(ctx)` export still fires inside onLoad; the existing `activate(bodyEl, ctx)`
 * remains owned by the bar (called on panel open, not by the loader).
 *
 * @typedef {'onBeforeLoad'|'onLoad'|'onBeforeUnload'|'onUnload'|'onRequestReload'} LifecycleHook
 */
export const LIFECYCLE_HOOKS = Object.freeze([
  'onBeforeLoad', 'onLoad', 'onBeforeUnload', 'onUnload', 'onRequestReload',
]);

const ALLOWED_ENVIRONMENTS = new Set(['browser', 'tui', 'cli', 'all']);
const ALLOWED_SLOTS = new Set(['bar', 'hud', 'panel', 'overlay', 'watcher']);
const ID_PATTERN = /^[a-zA-Z0-9_.\-]+$/;
// PluginManifest.cs:138 validates with `new Version(Version)`, which is
// MAJOR.MINOR[.BUILD[.REVISION]]. We accept npm-style semver superset.
const VERSION_PATTERN = /^[0-9]+\.[0-9]+(\.[0-9]+)?(\.[0-9]+)?(-[0-9A-Za-z.\-]+)?(\+[0-9A-Za-z.\-]+)?$/;
const DEP_PATTERN = /^([a-zA-Z0-9_.\-]+)(?:@([^?]+))?(\?)?$/;

// =============================================================================
// [1] Validate — non-throwing manifest check (Chorizite §5 item 3)
// =============================================================================

/**
 * Validate a manifest object against the JSON-Schema. Returns
 * `{ valid: boolean, errors: string[] }`. Never throws.
 *
 * Mirrors `PluginManifest.Validate(out List<string> errors)`
 * (PluginManifest.cs:130-147) — collect every problem, return all at once,
 * never let one broken manifest break the rest.
 *
 * @param {unknown} manifest
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateManifest(manifest) {
  const errors = [];

  if (manifest == null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('manifest must be an object');
    return { valid: false, errors };
  }
  /** @type {PluginManifest} */
  const m = /** @type {any} */ (manifest);

  // Required: id (string, non-empty, pattern).
  if (typeof m.id !== 'string' || m.id.length === 0) {
    errors.push('id: required string');
  } else if (!ID_PATTERN.test(m.id)) {
    errors.push(`id: must match ${ID_PATTERN} (got ${JSON.stringify(m.id)})`);
  }

  // Required: name (string, non-empty). Mirrors PluginManifest.cs:133-135.
  if (typeof m.name !== 'string' || m.name.length === 0) {
    errors.push('name: required non-empty string');
  }

  // Required: version (semver shape). Mirrors PluginManifest.cs:137-144 +
  // bug-comment §2: Chorizite's code-path inverts the IsNullOrWhiteSpace
  // check; we do not propagate the bug.
  if (typeof m.version !== 'string' || m.version.length === 0) {
    errors.push('version: required string');
  } else if (!VERSION_PATTERN.test(m.version)) {
    errors.push(`version: must be semver-shape (got ${JSON.stringify(m.version)})`);
  }

  // Optional: dependencies — each must parse as `<id>[@<semver>][?]`.
  if (m.dependencies != null) {
    if (!Array.isArray(m.dependencies)) {
      errors.push('dependencies: must be an array of strings');
    } else {
      m.dependencies.forEach((dep, i) => {
        if (typeof dep !== 'string') {
          errors.push(`dependencies[${i}]: must be a string`);
        } else if (!DEP_PATTERN.test(dep)) {
          errors.push(`dependencies[${i}]: malformed (got ${JSON.stringify(dep)})`);
        }
      });
    }
  }

  // Optional: environments — must be from the allowed set.
  if (m.environments != null) {
    if (!Array.isArray(m.environments)) {
      errors.push('environments: must be an array of strings');
    } else {
      m.environments.forEach((env, i) => {
        if (typeof env !== 'string' || !ALLOWED_ENVIRONMENTS.has(env)) {
          errors.push(`environments[${i}]: must be one of ${[...ALLOWED_ENVIRONMENTS].join(',')} (got ${JSON.stringify(env)})`);
        }
      });
    }
  }

  // Optional: slots — must be from the allowed set.
  if (m.slots != null) {
    if (!Array.isArray(m.slots)) {
      errors.push('slots: must be an array of strings');
    } else {
      m.slots.forEach((slot, i) => {
        if (typeof slot !== 'string' || !ALLOWED_SLOTS.has(slot)) {
          errors.push(`slots[${i}]: must be one of ${[...ALLOWED_SLOTS].join(',')} (got ${JSON.stringify(slot)})`);
        }
      });
    }
  }

  // Optional: hotkeys — array of {id,default,label?}.
  if (m.hotkeys != null) {
    if (!Array.isArray(m.hotkeys)) {
      errors.push('hotkeys: must be an array of objects');
    } else {
      m.hotkeys.forEach((hk, i) => {
        if (hk == null || typeof hk !== 'object' || Array.isArray(hk)) {
          errors.push(`hotkeys[${i}]: must be {id, default} object`);
        } else {
          if (typeof hk.id !== 'string' || hk.id.length === 0) {
            errors.push(`hotkeys[${i}].id: required string`);
          }
          if (typeof hk.default !== 'string' || hk.default.length === 0) {
            errors.push(`hotkeys[${i}].default: required string`);
          }
        }
      });
    }
  }

  // Optional: entry — when present must be a string.
  if (m.entry != null && typeof m.entry !== 'string') {
    errors.push('entry: must be a string when present');
  }

  // Optional scalars.
  for (const key of ['author', 'description', 'repo', 'icon']) {
    if (m[key] != null && typeof m[key] !== 'string') {
      errors.push(`${key}: must be a string when present`);
    }
  }
  if (m.iconHidden != null && typeof m.iconHidden !== 'boolean') {
    errors.push('iconHidden: must be a boolean when present');
  }

  return { valid: errors.length === 0, errors };
}

// =============================================================================
// [2] Dependency resolution — Chorizite's `?` optional suffix
// =============================================================================

/**
 * Parse a dependency string. Mirrors Chorizite PluginManager.cs:191-195:
 *   `var parts = dep.Split('@');
 *    var depId = parts[0];
 *    var depVersion = parts.Length > 1 ? new Version(parts[1].TrimEnd('?')) : new Version(0,0,0);
 *    var isOptional = parts.Length > 1 ? parts[1].EndsWith("?") : false;`
 *
 * Plus our extension: bare `id?` (no version) is also optional.
 *
 * @param {string} dep
 * @returns {{ id: string, range: string|null, optional: boolean } | null}
 */
export function parseDependency(dep) {
  if (typeof dep !== 'string') return null;
  const m = DEP_PATTERN.exec(dep);
  if (!m) return null;
  const [, id, range, opt] = m;
  return {
    id,
    range: range != null && range.length > 0 ? range : null,
    optional: opt === '?',
  };
}

/**
 * Compare two version strings (MAJOR.MINOR[.BUILD[.REVISION]] / semver).
 * Pre-release suffix is treated as lower than the corresponding non-pre-release
 * per semver §11. Returns -1 / 0 / +1.
 *
 * @param {string} a
 * @param {string} b
 * @returns {-1|0|1}
 */
export function compareVersions(a, b) {
  const splitVer = (v) => {
    const [main, pre] = String(v).split('-', 2);
    const parts = main.split('.').map((p) => Number(p) || 0);
    while (parts.length < 4) parts.push(0);
    return { parts, pre: pre || '' };
  };
  const av = splitVer(a);
  const bv = splitVer(b);
  for (let i = 0; i < 4; i++) {
    if (av.parts[i] !== bv.parts[i]) return av.parts[i] < bv.parts[i] ? -1 : 1;
  }
  // Pre-release: present < absent.
  if (av.pre && !bv.pre) return -1;
  if (!av.pre && bv.pre) return 1;
  if (av.pre < bv.pre) return -1;
  if (av.pre > bv.pre) return 1;
  return 0;
}

/**
 * Match `version` against a range. Supports:
 *   - exact (`1.2.3`)
 *   - caret (`^1.2.3` — same major, ≥)
 *   - tilde (`~1.2.3` — same minor, ≥)
 *   - `>=`, `>`, `<=`, `<`, `=` prefixes
 *   - `*` / empty / null → always match
 *
 * Chorizite uses exact-equal only (`new Version(parts[1])`). We extend to
 * npm-style ranges per READING_GUIDE §4.1 departures table.
 *
 * @param {string} version
 * @param {string|null|undefined} range
 * @returns {boolean}
 */
export function satisfiesRange(version, range) {
  if (range == null || range === '' || range === '*') return true;
  const r = String(range).trim();
  if (r.startsWith('^')) {
    const base = r.slice(1);
    const [baseMajor] = base.split('.');
    const [verMajor] = version.split('.');
    return baseMajor === verMajor && compareVersions(version, base) >= 0;
  }
  if (r.startsWith('~')) {
    const base = r.slice(1);
    const parts = base.split('.');
    const verParts = version.split('.');
    if (parts[0] !== verParts[0]) return false;
    if (parts.length >= 2 && parts[1] !== verParts[1]) return false;
    return compareVersions(version, base) >= 0;
  }
  if (r.startsWith('>=')) return compareVersions(version, r.slice(2).trim()) >= 0;
  if (r.startsWith('<=')) return compareVersions(version, r.slice(2).trim()) <= 0;
  if (r.startsWith('>')) return compareVersions(version, r.slice(1).trim()) > 0;
  if (r.startsWith('<')) return compareVersions(version, r.slice(1).trim()) < 0;
  if (r.startsWith('=')) return compareVersions(version, r.slice(1).trim()) === 0;
  return compareVersions(version, r) === 0;
}

/**
 * Resolve the load order for a set of manifests, recursively starting deps
 * first (Chorizite `PluginManager.StartPlugin` line 178-245 pattern).
 * Optional `?` deps that are missing are skipped without error; missing
 * required deps fail the affected plugin (but not the rest).
 *
 * Returns:
 *   - `started`: ordered list of plugin ids that resolved
 *   - `skipped`: { id, reason } for each plugin that failed to resolve
 *
 * @param {PluginManifest[]} manifests
 * @returns {{ started: string[], skipped: {id:string,reason:string}[] }}
 */
export function resolveDependencies(manifests) {
  const byId = new Map();
  for (const m of manifests) byId.set(m.id, m);
  const started = [];
  const skipped = [];
  const visiting = new Set();
  const visited = new Set();

  function start(manifest, chain) {
    if (visited.has(manifest.id)) return true;
    if (visiting.has(manifest.id)) {
      // Cycle. Chorizite's recursion does not guard against this, but a
      // browser stack overflow is worse than a graceful skip.
      const cyclePath = [...chain, manifest.id].join(' → ');
      skipped.push({ id: manifest.id, reason: `dependency cycle: ${cyclePath}` });
      return false;
    }
    visiting.add(manifest.id);

    const deps = Array.isArray(manifest.dependencies) ? manifest.dependencies : [];
    for (const depStr of deps) {
      const parsed = parseDependency(depStr);
      if (!parsed) {
        visiting.delete(manifest.id);
        skipped.push({ id: manifest.id, reason: `malformed dependency: ${depStr}` });
        return false;
      }
      const depManifest = byId.get(parsed.id);
      if (depManifest == null) {
        if (parsed.optional) continue;
        visiting.delete(manifest.id);
        skipped.push({
          id: manifest.id,
          reason: `required dependency not found: ${parsed.id}${parsed.range ? '@' + parsed.range : ''}`,
        });
        return false;
      }
      if (parsed.range != null && !satisfiesRange(depManifest.version, parsed.range)) {
        if (parsed.optional) continue;
        visiting.delete(manifest.id);
        skipped.push({
          id: manifest.id,
          reason: `dependency version mismatch: ${parsed.id}@${parsed.range} required, ${depManifest.version} loaded`,
        });
        return false;
      }
      const ok = start(depManifest, [...chain, manifest.id]);
      if (!ok && !parsed.optional) {
        visiting.delete(manifest.id);
        skipped.push({
          id: manifest.id,
          reason: `dependency failed to load: ${parsed.id}`,
        });
        return false;
      }
    }

    visiting.delete(manifest.id);
    visited.add(manifest.id);
    started.push(manifest.id);
    return true;
  }

  for (const m of manifests) start(m, []);

  return { started, skipped };
}

// =============================================================================
// [3] Environment filter
// =============================================================================

/**
 * Return true if `manifest.environments` includes `environment` (or 'all',
 * or the field is absent — match-all default).
 *
 * @param {PluginManifest} manifest
 * @param {string} environment
 * @returns {boolean}
 */
export function matchesEnvironment(manifest, environment) {
  const envs = manifest.environments;
  if (!Array.isArray(envs) || envs.length === 0) return true;
  return envs.includes(environment) || envs.includes('all');
}

// =============================================================================
// [4] EatableBus — Chorizite EatableEventArgs (READING_GUIDE §3.3 + §5 item 6)
// =============================================================================

/**
 * A pub-sub bus where any handler can call `event.eat()` (or set
 * `event.eaten = true`) to stop further handlers on the same event from
 * running. Mirrors Chorizite's EatableEventArgs (referenced from
 * Chorizite.Core/Input/*EventArgs.cs); the porting plan §5 item 6 notes this
 * is *the* missing piece — without it, the combat bar can't swallow LMB
 * before the world-pick handler sees it.
 *
 * Usage:
 *   const bus = createEatableBus();
 *   bus.on('attack-click', (ev) => { if (cond) ev.eat(); });
 *   bus.emit('attack-click', { x, y });   // payload spread into the event
 *
 * Returns an unsubscribe function from `.on()`.
 */
export function createEatableBus() {
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();

  function on(name, handler) {
    if (typeof handler !== 'function') return () => {};
    let set = handlers.get(name);
    if (!set) {
      set = new Set();
      handlers.set(name, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  function off(name, handler) {
    const set = handlers.get(name);
    if (set) set.delete(handler);
  }

  function emit(name, payload) {
    const set = handlers.get(name);
    if (!set || set.size === 0) return { eaten: false, payload };
    const event = Object.assign(
      {
        type: name,
        eaten: false,
        eat() { this.eaten = true; },
      },
      payload || {},
    );
    for (const h of [...set]) {
      try {
        h(event);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[bus] handler for "${name}" threw:`, e);
      }
      if (event.eaten) break;
    }
    return event;
  }

  return { on, off, emit };
}

// =============================================================================
// [5] manifest.dev.json sidecar resolution (Chorizite §5 item 5)
// =============================================================================

/**
 * Apply a dev-sidecar manifest. When `dev.source` is set, the loader rewrites
 * `manifest.entry` to point at the source tree; `dev.bin` overrides the
 * installed-bin path. Mirrors PluginDevManifest.cs:10-58.
 *
 * @param {PluginManifest} manifest
 * @param {PluginDevManifest|null|undefined} dev
 * @returns {PluginManifest}
 */
export function applyDevManifest(manifest, dev) {
  if (dev == null || typeof dev !== 'object') return manifest;
  if (typeof dev.source === 'string' && dev.source.length > 0) {
    return { ...manifest, entry: dev.source };
  }
  if (typeof dev.bin === 'string' && dev.bin.length > 0) {
    return { ...manifest, entry: dev.bin };
  }
  return manifest;
}

// =============================================================================
// [6] loadPlugins — top-level orchestrator
// =============================================================================

/**
 * Load a set of plugins. Validates each manifest; computes a load order from
 * dependencies; runs the 5-stage lifecycle hooks; never lets one broken
 * plugin break the rest.
 *
 * @param {Object} opts
 * @param {Array<{manifest:unknown, dev?:PluginDevManifest, module?:any, modulePath?:string}>} opts.entries
 *     Pre-imported modules (`.module`) OR module paths to dynamic-import
 *     (`.modulePath` — only used in environments where `await import()` works
 *     on the given path; tests prefer `.module`). Each entry MUST carry the
 *     raw `manifest` object even if the module re-exports it — keeps the
 *     loader pure relative to module loading.
 * @param {string} [opts.environment='browser']   browser / tui / cli.
 * @param {Object} [opts.context]                 Passed to lifecycle hooks.
 * @param {(level:'info'|'warn'|'error', msg:string)=>void} [opts.log]
 * @returns {Promise<{ loaded: Map<string, {manifest:PluginManifest, module:any}>, skipped: {id?:string,reason:string,errors?:string[]}[] }>}
 */
export async function loadPlugins(opts) {
  const log = opts?.log || ((level, msg) => {
    // eslint-disable-next-line no-console
    if (typeof console !== 'undefined' && console[level]) console[level](`[loader] ${msg}`);
  });
  const entries = Array.isArray(opts?.entries) ? opts.entries : [];
  const environment = opts?.environment || 'browser';
  const context = opts?.context || {};

  // [a] Validate every manifest. Apply dev-sidecar overrides up front so
  // downstream resolves see the corrected `entry`.
  const validated = [];
  const skipped = [];
  for (const entry of entries) {
    const finalManifest = applyDevManifest(entry.manifest, entry.dev);
    const { valid, errors } = validateManifest(finalManifest);
    if (!valid) {
      const id = (finalManifest && finalManifest.id) || '<unknown>';
      log('warn', `manifest invalid for ${id}: ${errors.join('; ')}`);
      skipped.push({ id, reason: 'manifest invalid', errors });
      continue;
    }
    if (!matchesEnvironment(/** @type {PluginManifest} */ (finalManifest), environment)) {
      skipped.push({
        id: finalManifest.id,
        reason: `environment mismatch: plugin wants ${(finalManifest.environments || []).join(',')} but host is ${environment}`,
      });
      continue;
    }
    validated.push({ ...entry, manifest: finalManifest });
  }

  // [b] Resolve dependency order.
  const manifests = validated.map((e) => /** @type {PluginManifest} */ (e.manifest));
  const { started, skipped: depSkipped } = resolveDependencies(manifests);
  for (const s of depSkipped) {
    log('warn', `${s.id}: ${s.reason}`);
    skipped.push(s);
  }

  // [c] Load each in resolved order — fetch/import + run lifecycle hooks.
  const loaded = new Map();
  const entryById = new Map(validated.map((e) => [e.manifest.id, e]));
  const lifecycleCtx = { ...context, environment, requestReload };

  function requestReload(id) {
    const e = loaded.get(id);
    if (!e) return false;
    callHook(e.module, 'onRequestReload', { ...lifecycleCtx, manifest: e.manifest });
    return true;
  }

  // [c.1] PRE-IMPORT all plugin modules CONCURRENTLY. This used to be a serial
  // `for (id of started) { module = await import(modulePath) }` — so N plugins
  // (81 in the live build) paid N module round-trips back-to-back, the single
  // biggest contributor to the cold-boot JS request waterfall. Firing the
  // dynamic imports together overlaps their fetch+parse. It is behaviourally
  // safe: ES modules evaluate exactly once with their own dependencies first
  // regardless of *when* the import is initiated, and the dependency-ordered
  // lifecycle ([c.2] below) is unchanged — only the body downloads overlap.
  // Per-id errors are captured so one bad import still can't break the rest.
  const moduleById = new Map();
  const importErrors = new Map();
  await Promise.all(
    started.map(async (id) => {
      const entry = entryById.get(id);
      if (!entry) return;
      if (entry.module != null) {
        moduleById.set(id, entry.module);
        return;
      }
      if (entry.modulePath) {
        try {
          // eslint-disable-next-line no-undef
          moduleById.set(id, await import(entry.modulePath));
        } catch (e) {
          importErrors.set(id, e);
        }
      }
    })
  );

  // [c.2] Run the 5-stage lifecycle in resolved dependency order. This loop is
  // intentionally still SEQUENTIAL — load order is a correctness contract (a
  // plugin's onLoad may rely on a dependency's onLoad having already run).
  for (const id of started) {
    const entry = entryById.get(id);
    if (!entry) continue;
    const manifest = /** @type {PluginManifest} */ (entry.manifest);

    if (importErrors.has(id)) {
      const e = importErrors.get(id);
      log('error', `${id}: failed to import ${entry.modulePath} — ${e.message}`);
      skipped.push({ id, reason: `import failed: ${e.message}` });
      continue;
    }
    const module = moduleById.get(id);
    if (module == null) {
      log('warn', `${id}: no module supplied (set entry.module or entry.modulePath)`);
      skipped.push({ id, reason: 'no module supplied' });
      continue;
    }

    const hookCtx = { ...lifecycleCtx, manifest };

    // 5-stage lifecycle (load side):
    //   onBeforeLoad → (module init already happened on import) → onLoad
    let okBefore = callHook(module, 'onBeforeLoad', hookCtx);
    if (okBefore === false) {
      log('warn', `${id}: onBeforeLoad returned false — skipping`);
      skipped.push({ id, reason: 'onBeforeLoad returned false' });
      continue;
    }
    callHook(module, 'onLoad', hookCtx);

    loaded.set(id, { manifest, module });
  }

  return { loaded, skipped };
}

/**
 * Retail's verbatim reply when no third-party plugin API is loaded.
 * `ClientAdminSystem::Handle_Admin__Recv_QueryPluginList` (acclient.c
 * 0x6B5EE0) seeds its response with this literal and only overwrites it
 * under `APIManager::APIIsReady()`. The trailing period is part of the
 * string; an empty plugin set MUST send this, never "".
 */
export const NO_PLUGIN_API_PLUGIN_LIST = '3rd party API not in use.';

/**
 * P6.1 — render the loaded-plugin roster for the admin plugin-manifest
 * query (GameEvent 0x02AE -> GameAction 0x02AF, `PluginList` field).
 *
 * Retail imposes NO format on this string (it forwards whatever
 * `IACPlugin::QueryPluginList` hands back as a BSTR), so `id@version`
 * comma-joined is our convention. `id` and `version` are the two manifest
 * fields `validateManifest` guarantees are non-empty strings, so every
 * loaded entry can be rendered; entries are sorted by id for a stable
 * answer across reloads.
 *
 * Wire constraint: the field is a `PStringBase<char>` — 8-bit, WINDOWS-1252
 * on the wire. Non-representable characters would be lossily transcoded
 * wasm-side, and `id` is already restricted to `[a-z0-9-]` by the loader's
 * ID_PATTERN, so only `version` could in principle carry one.
 *
 * @param {Map<string, {manifest: {id: string, version: string}}>|Iterable<{manifest: {id: string, version: string}}>} loaded
 *   the `loaded` map returned by `loadPlugins`, or any iterable of its values.
 * @returns {string} comma-joined `id@version`, or NO_PLUGIN_API_PLUGIN_LIST
 *   when the set is empty.
 */
export function formatPluginList(loaded) {
  if (!loaded) return NO_PLUGIN_API_PLUGIN_LIST;
  const values = typeof loaded.values === 'function' ? [...loaded.values()] : [...loaded];
  const parts = [];
  for (const entry of values) {
    const m = entry && entry.manifest ? entry.manifest : entry;
    if (!m || typeof m.id !== 'string' || !m.id) continue;
    const version = typeof m.version === 'string' && m.version ? m.version : '0.0.0';
    parts.push(`${m.id}@${version}`);
  }
  if (parts.length === 0) return NO_PLUGIN_API_PLUGIN_LIST;
  parts.sort();
  return parts.join(',');
}

/**
 * Unload a previously-loaded plugin. Fires onBeforeUnload then onUnload.
 *
 * @param {{ manifest: PluginManifest, module: any }} entry
 * @param {Object} [context]
 */
export function unloadPlugin(entry, context) {
  if (!entry || !entry.module) return;
  const hookCtx = { ...(context || {}), manifest: entry.manifest };
  callHook(entry.module, 'onBeforeUnload', hookCtx);
  callHook(entry.module, 'onUnload', hookCtx);
}

/**
 * Invoke a named lifecycle hook on a plugin module. Returns the hook's return
 * value (or `undefined` if missing); swallows + logs any exception so one
 * broken hook does not break the rest of the load.
 *
 * Exported for test/inspection. Production callers go through `loadPlugins` +
 * `unloadPlugin`.
 *
 * @param {any} module
 * @param {LifecycleHook} hook
 * @param {Object} ctx
 * @returns {unknown}
 */
export function callHook(module, hook, ctx) {
  if (module == null || typeof module[hook] !== 'function') return undefined;
  try {
    return module[hook](ctx);
  } catch (e) {
    // eslint-disable-next-line no-console
    if (typeof console !== 'undefined') console.warn(`[loader] ${hook} threw:`, e);
    return undefined;
  }
}

// =============================================================================
// [7] Manifest-index loader (browser-friendly)
// =============================================================================

/**
 * Fetch a manifest-index JSON (an array of `{ entry, manifestPath, devPath? }`
 * descriptors) plus each referenced `<id>.manifest.json` + optional
 * `<id>.manifest.dev.json`, returning the entry list ready to feed into
 * `loadPlugins`. Browsers cannot directory-walk; the index file is how the
 * loader discovers the plugins it should consider.
 *
 * Each descriptor's `manifestPath` is fetched relative to the index URL.
 * `devPath` (optional, dev-override sidecar) is fetched the same way; 404 is
 * treated as "no dev sidecar" (silently skipped). The probe is GATED: it only
 * runs when dev mode is on (`?dev` in the URL, or `opts.probeDev === true`).
 * In a normal/production load no sidecars exist, so probing every descriptor
 * just spams the console with 404s (a network 404 is logged by the browser and
 * can't be suppressed from JS) — gating keeps the console clean while a dev who
 * wants the override opts in with `?dev=1`.
 *
 * @param {Object} opts
 * @param {string} opts.indexUrl                 URL of the manifest index JSON.
 * @param {typeof fetch} [opts.fetch]            Defaults to globalThis.fetch.
 * @param {boolean} [opts.probeDev]              Fetch `devPath` sidecars. Defaults
 *     to whether `?dev` is present in the page URL (false outside a browser).
 * @returns {Promise<{ entries: Array<{manifest:any, dev?:any, modulePath:string}>, skipped: {id?:string,reason:string}[] }>}
 */
export async function fetchManifestIndex(opts) {
  // eslint-disable-next-line no-undef
  const fetchImpl = opts?.fetch || (typeof fetch !== 'undefined' ? fetch : null);
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetchManifestIndex: no fetch available');
  }
  const indexUrl = opts.indexUrl;
  // Dev-sidecar probing is opt-in: explicit `opts.probeDev`, else `?dev` in the
  // page URL. Off by default so a normal load doesn't 404 on every (absent)
  // `<id>.manifest.dev.json`.
  const probeDev = opts.probeDev != null
    ? !!opts.probeDev
    : (() => {
        try {
          // eslint-disable-next-line no-undef
          return new URLSearchParams(globalThis.location?.search || '').has('dev');
        } catch {
          return false;
        }
      })();
  const indexRes = await fetchImpl(indexUrl);
  if (!indexRes.ok) throw new Error(`fetchManifestIndex: ${indexUrl} → ${indexRes.status}`);
  const indexJson = await indexRes.json();
  const descriptors = Array.isArray(indexJson) ? indexJson : (indexJson.plugins || []);
  const base = new URL(indexUrl, /** @type {any} */ (globalThis).location?.href || 'http://localhost/');
  const entries = [];
  const skipped = [];

  for (const desc of descriptors) {
    if (typeof desc?.manifestPath !== 'string') {
      skipped.push({ reason: `index descriptor missing manifestPath: ${JSON.stringify(desc)}` });
      continue;
    }
    const manifestUrl = new URL(desc.manifestPath, base).href;
    let manifest;
    try {
      const res = await fetchImpl(manifestUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      manifest = await res.json();
    } catch (e) {
      skipped.push({ reason: `failed to fetch ${manifestUrl}: ${e.message}` });
      continue;
    }
    let dev = null;
    if (probeDev && typeof desc.devPath === 'string') {
      const devUrl = new URL(desc.devPath, base).href;
      try {
        const res = await fetchImpl(devUrl);
        if (res.ok) dev = await res.json();
      } catch {
        // 404 / network fail = no dev sidecar; intentional.
      }
    }
    const modulePath = desc.entry
      ? new URL(desc.entry, base).href
      : (manifest.entry ? new URL(manifest.entry, new URL(manifestUrl)).href : '');
    entries.push({ manifest, dev, modulePath });
  }

  return { entries, skipped };
}
