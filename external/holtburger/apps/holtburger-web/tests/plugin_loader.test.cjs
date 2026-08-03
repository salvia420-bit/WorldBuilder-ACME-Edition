// =============================================================================
// PR 8 (Chorizite-absorption, 2026-05-27) — plugins/loader.js tests
// =============================================================================
//
// Validates the loader's six absorbed behaviours per Chorizite READING_GUIDE
// summary §5.5 items 1-6:
//   [A] validateManifest — non-throwing, returns {valid, errors[]}
//   [B] parseDependency / satisfiesRange / compareVersions
//   [C] resolveDependencies — `?` optional suffix + ordering + cycle guard
//   [D] matchesEnvironment
//   [E] applyDevManifest — manifest.dev.json sidecar
//   [F] createEatableBus — .eat() stops propagation
//   [G] loadPlugins — full orchestration with 5-stage lifecycle hooks
//   [H] Per-plugin manifest.json files — all 50 bundled manifests
//       parse + validate
//
// Run from apps/holtburger-web/:
//   node tests/plugin_loader.test.cjs
// =============================================================================

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const LOADER_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'loader.js')
).href;
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const SCHEMA_PATH = path.join(PLUGINS_DIR, 'schemas', 'plugin-manifest.json');
const INDEX_PATH = path.join(PLUGINS_DIR, 'index.json');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) {
      throw new Error('use checkAsync for async tests');
    }
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

(async () => {
  const {
    validateManifest, parseDependency, satisfiesRange, compareVersions,
    resolveDependencies, matchesEnvironment, applyDevManifest,
    createEatableBus, loadPlugins, unloadPlugin, callHook, LIFECYCLE_HOOKS,
  } = await import(LOADER_URL);

  // ─── [A] validateManifest — schema gate ───
  console.log('\n[A] validateManifest');

  check('valid minimal manifest accepted', () => {
    const r = validateManifest({ id: 'foo', name: 'Foo', version: '1.0.0' });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  check('full manifest with all optional fields accepted', () => {
    const r = validateManifest({
      $schema: 'https://holtburger.local/schemas/plugin-manifest.json',
      id: 'com.holtburger.combat',
      name: 'Combat',
      author: 'holtburger',
      version: '1.0.0',
      description: 'Melee/missile/magic combat bar.',
      icon: 'icon.svg',
      iconHidden: false,
      dependencies: ['com.holtburger.world-objects@^1.0.0', 'optional-thing@1?'],
      environments: ['browser'],
      entry: './index.js',
      slots: ['bar', 'hud'],
      hotkeys: [{ id: 'toggle', default: 'F4' }],
    });
    assert.equal(r.valid, true);
    assert.deepEqual(r.errors, []);
  });

  check('missing id rejected', () => {
    const r = validateManifest({ name: 'Foo', version: '1.0.0' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /^id:/.test(e)));
  });

  check('missing name rejected', () => {
    const r = validateManifest({ id: 'foo', version: '1.0.0' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /^name:/.test(e)));
  });

  check('missing version rejected', () => {
    const r = validateManifest({ id: 'foo', name: 'Foo' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /^version:/.test(e)));
  });

  check('malformed version rejected', () => {
    const r = validateManifest({ id: 'foo', name: 'Foo', version: 'not-a-version' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /semver-shape/.test(e)));
  });

  check('non-object rejected', () => {
    assert.equal(validateManifest(null).valid, false);
    assert.equal(validateManifest('hi').valid, false);
    assert.equal(validateManifest([]).valid, false);
  });

  check('bad id pattern rejected', () => {
    const r = validateManifest({ id: 'foo bar!', name: 'Foo', version: '1.0.0' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /must match/.test(e)));
  });

  check('bad environment value rejected (collects all errors)', () => {
    const r = validateManifest({
      id: 'foo', name: 'Foo', version: '1.0.0',
      environments: ['mars', 42, 'browser'],
    });
    assert.equal(r.valid, false);
    // Should report BOTH bad entries (Chorizite Validate(out errors) pattern).
    assert.equal(r.errors.filter((e) => /environments\[/.test(e)).length, 2);
  });

  check('bad slot value rejected', () => {
    const r = validateManifest({
      id: 'foo', name: 'Foo', version: '1.0.0',
      slots: ['bar', 'sidebar', 'hud'],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /^slots\[1\]:/.test(e)));
  });

  check('hotkeys missing required default rejected', () => {
    const r = validateManifest({
      id: 'foo', name: 'Foo', version: '1.0.0',
      hotkeys: [{ id: 'a' }],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /hotkeys\[0\]\.default/.test(e)));
  });

  check('iconHidden non-boolean rejected', () => {
    const r = validateManifest({
      id: 'foo', name: 'Foo', version: '1.0.0', iconHidden: 'yes',
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /iconHidden/.test(e)));
  });

  check('malformed dependency string rejected', () => {
    const r = validateManifest({
      id: 'foo', name: 'Foo', version: '1.0.0',
      dependencies: ['ok@1.0.0', 'has spaces@1.0.0'],
    });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => /dependencies\[1\]:/.test(e)));
  });

  check('returns ALL errors (does not short-circuit)', () => {
    const r = validateManifest({
      id: '',
      // missing name
      version: 'oops',
      environments: ['nope'],
    });
    assert.equal(r.valid, false);
    // id + name + version + environments[0]  → at least 4 errors
    assert.ok(r.errors.length >= 4, `expected >=4 errors, got ${r.errors.length}: ${r.errors.join(' | ')}`);
  });

  // ─── [B] parseDependency, compareVersions, satisfiesRange ───
  console.log('\n[B] parseDependency / compareVersions / satisfiesRange');

  check('parseDependency: bare id', () => {
    assert.deepEqual(parseDependency('foo'), { id: 'foo', range: null, optional: false });
  });

  check('parseDependency: id@version', () => {
    assert.deepEqual(parseDependency('foo@1.2.3'), { id: 'foo', range: '1.2.3', optional: false });
  });

  check('parseDependency: id@version? (optional)', () => {
    assert.deepEqual(parseDependency('foo@^1.0.0?'), { id: 'foo', range: '^1.0.0', optional: true });
  });

  check('parseDependency: invalid input → null', () => {
    assert.equal(parseDependency(123), null);
    assert.equal(parseDependency('!@#$%'), null);
  });

  check('compareVersions', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.0.0', '2.0.0'), -1);
    assert.equal(compareVersions('2.0.0', '1.0.0'), 1);
    assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
    assert.equal(compareVersions('1.0.0-rc.1', '1.0.0'), -1);
    assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  });

  check('satisfiesRange: exact match', () => {
    assert.equal(satisfiesRange('1.2.3', '1.2.3'), true);
    assert.equal(satisfiesRange('1.2.3', '1.2.4'), false);
  });

  check('satisfiesRange: caret (same major)', () => {
    assert.equal(satisfiesRange('1.5.0', '^1.0.0'), true);
    assert.equal(satisfiesRange('2.0.0', '^1.0.0'), false);
    assert.equal(satisfiesRange('1.0.0', '^1.5.0'), false);
  });

  check('satisfiesRange: tilde (same minor)', () => {
    assert.equal(satisfiesRange('1.2.5', '~1.2.0'), true);
    assert.equal(satisfiesRange('1.3.0', '~1.2.0'), false);
  });

  check('satisfiesRange: gte/gt/lte/lt/eq', () => {
    assert.equal(satisfiesRange('1.0.0', '>=1.0.0'), true);
    assert.equal(satisfiesRange('0.9.0', '>=1.0.0'), false);
    assert.equal(satisfiesRange('1.0.1', '>1.0.0'), true);
    assert.equal(satisfiesRange('1.0.0', '>1.0.0'), false);
    assert.equal(satisfiesRange('1.0.0', '<=1.0.0'), true);
    assert.equal(satisfiesRange('1.0.0', '<1.0.0'), false);
    assert.equal(satisfiesRange('1.0.0', '=1.0.0'), true);
  });

  check('satisfiesRange: wildcard / null', () => {
    assert.equal(satisfiesRange('999.0.0', '*'), true);
    assert.equal(satisfiesRange('1.0.0', null), true);
    assert.equal(satisfiesRange('1.0.0', ''), true);
  });

  // ─── [C] resolveDependencies — Chorizite §5 item 2 ───
  console.log('\n[C] resolveDependencies');

  check('no deps → started in input order', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0' },
      { id: 'b', version: '1.0.0' },
    ]);
    assert.deepEqual(r.started, ['a', 'b']);
    assert.deepEqual(r.skipped, []);
  });

  check('A depends on B → B started first', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['b@^1.0.0'] },
      { id: 'b', version: '1.0.0' },
    ]);
    assert.deepEqual(r.started, ['b', 'a']);
    assert.deepEqual(r.skipped, []);
  });

  check('transitive A→B→C → C, B, A', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['b@1.0.0'] },
      { id: 'b', version: '1.0.0', dependencies: ['c@1.0.0'] },
      { id: 'c', version: '1.0.0' },
    ]);
    assert.deepEqual(r.started, ['c', 'b', 'a']);
  });

  check('missing required dep → skipped, others continue', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['missing@1.0.0'] },
      { id: 'b', version: '1.0.0' },
    ]);
    assert.deepEqual(r.started, ['b']);
    assert.equal(r.skipped.length, 1);
    assert.equal(r.skipped[0].id, 'a');
    assert.match(r.skipped[0].reason, /not found/);
  });

  check('missing OPTIONAL dep @x.y.z? → continues', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['absent@1.0.0?'] },
    ]);
    assert.deepEqual(r.started, ['a']);
    assert.deepEqual(r.skipped, []);
  });

  check('dep present but version mismatch (required) → skipped', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['b@^2.0.0'] },
      { id: 'b', version: '1.0.0' },
    ]);
    assert.ok(r.skipped.some((s) => s.id === 'a' && /version mismatch/.test(s.reason)));
    assert.deepEqual(r.started, ['b']);
  });

  check('dep present but version mismatch (optional) → continues silently', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['b@^2.0.0?'] },
      { id: 'b', version: '1.0.0' },
    ]);
    assert.deepEqual(r.started.sort(), ['a', 'b']);
    assert.deepEqual(r.skipped, []);
  });

  check('cycle A→B→A → both skipped with reason', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['b@1.0.0'] },
      { id: 'b', version: '1.0.0', dependencies: ['a@1.0.0'] },
    ]);
    assert.ok(r.skipped.some((s) => /cycle/.test(s.reason)));
  });

  check('malformed dependency string skips the plugin', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['!!bad!!'] },
    ]);
    assert.ok(r.skipped.some((s) => s.id === 'a' && /malformed/.test(s.reason)));
  });

  check('cascade: required-dep failed → dependent also skipped', () => {
    const r = resolveDependencies([
      { id: 'a', version: '1.0.0', dependencies: ['b@1.0.0'] },
      { id: 'b', version: '1.0.0', dependencies: ['missing@1.0.0'] },
    ]);
    // b skipped (missing dep); a skipped (b failed)
    assert.equal(r.started.length, 0);
    assert.ok(r.skipped.some((s) => s.id === 'b'));
    assert.ok(r.skipped.some((s) => s.id === 'a'));
  });

  // ─── [D] matchesEnvironment ───
  console.log('\n[D] matchesEnvironment');

  check('no environments field → match everything', () => {
    assert.equal(matchesEnvironment({ id: 'x', name: 'x', version: '1.0.0' }, 'browser'), true);
    assert.equal(matchesEnvironment({ id: 'x', name: 'x', version: '1.0.0' }, 'tui'), true);
  });

  check('environments: ["browser"] matches browser only', () => {
    const m = { id: 'x', name: 'x', version: '1.0.0', environments: ['browser'] };
    assert.equal(matchesEnvironment(m, 'browser'), true);
    assert.equal(matchesEnvironment(m, 'tui'), false);
  });

  check('environments: ["all"] matches anything', () => {
    const m = { id: 'x', name: 'x', version: '1.0.0', environments: ['all'] };
    assert.equal(matchesEnvironment(m, 'browser'), true);
    assert.equal(matchesEnvironment(m, 'tui'), true);
    assert.equal(matchesEnvironment(m, 'cli'), true);
  });

  // ─── [E] applyDevManifest — sidecar override ───
  console.log('\n[E] applyDevManifest');

  check('no dev → unchanged', () => {
    const m = { id: 'a', name: 'A', version: '1.0.0', entry: './a.js' };
    assert.equal(applyDevManifest(m, null).entry, './a.js');
    assert.equal(applyDevManifest(m, undefined).entry, './a.js');
    assert.equal(applyDevManifest(m, {}).entry, './a.js');
  });

  check('dev.source overrides entry', () => {
    const m = { id: 'a', name: 'A', version: '1.0.0', entry: './bin/a.js' };
    const out = applyDevManifest(m, { source: './packages/a/src/index.js' });
    assert.equal(out.entry, './packages/a/src/index.js');
    // Original manifest not mutated
    assert.equal(m.entry, './bin/a.js');
  });

  check('dev.bin overrides entry when source absent', () => {
    const m = { id: 'a', name: 'A', version: '1.0.0', entry: './a.js' };
    const out = applyDevManifest(m, { bin: './dist/a.bundle.js' });
    assert.equal(out.entry, './dist/a.bundle.js');
  });

  // ─── [F] createEatableBus — Chorizite §5 item 6 ───
  console.log('\n[F] createEatableBus — Eat() semantics');

  check('emit fires all handlers in registration order', () => {
    const bus = createEatableBus();
    const calls = [];
    bus.on('hit', () => calls.push('h1'));
    bus.on('hit', () => calls.push('h2'));
    bus.emit('hit', { x: 1 });
    assert.deepEqual(calls, ['h1', 'h2']);
  });

  check('handler returning event.eat() stops propagation', () => {
    const bus = createEatableBus();
    const calls = [];
    bus.on('click', (ev) => { calls.push('first'); ev.eat(); });
    bus.on('click', () => calls.push('second'));
    const ev = bus.emit('click', { btn: 0 });
    assert.deepEqual(calls, ['first']);
    assert.equal(ev.eaten, true);
  });

  check('setting event.eaten = true also stops propagation', () => {
    const bus = createEatableBus();
    const calls = [];
    bus.on('key', (ev) => { calls.push('a'); ev.eaten = true; });
    bus.on('key', () => calls.push('b'));
    bus.emit('key', { key: 'F4' });
    assert.deepEqual(calls, ['a']);
  });

  check('payload merged into the event', () => {
    const bus = createEatableBus();
    let captured = null;
    bus.on('hit', (ev) => { captured = ev; });
    bus.emit('hit', { x: 10, y: 20 });
    assert.equal(captured.x, 10);
    assert.equal(captured.y, 20);
    assert.equal(captured.type, 'hit');
    assert.equal(captured.eaten, false);
  });

  check('throwing handler does not break the bus', () => {
    const bus = createEatableBus();
    const calls = [];
    bus.on('boom', () => { throw new Error('expected'); });
    bus.on('boom', () => calls.push('after'));
    bus.emit('boom', {});
    assert.deepEqual(calls, ['after']);
  });

  check('off() removes a handler', () => {
    const bus = createEatableBus();
    const calls = [];
    const h = () => calls.push('h');
    bus.on('e', h);
    bus.off('e', h);
    bus.emit('e', {});
    assert.deepEqual(calls, []);
  });

  check('on() return value also unsubscribes', () => {
    const bus = createEatableBus();
    const calls = [];
    const dispose = bus.on('e', () => calls.push('x'));
    dispose();
    bus.emit('e', {});
    assert.deepEqual(calls, []);
  });

  // ─── [G] loadPlugins — full orchestration + lifecycle ───
  console.log('\n[G] loadPlugins — 5-stage lifecycle hooks fire in order');

  await checkAsync('5 hooks fire in order across one plugin', async () => {
    const calls = [];
    const fakeModule = {
      onBeforeLoad: (ctx) => calls.push(['onBeforeLoad', ctx.manifest.id]),
      onLoad: (ctx) => calls.push(['onLoad', ctx.manifest.id]),
      onBeforeUnload: (ctx) => calls.push(['onBeforeUnload', ctx.manifest.id]),
      onUnload: (ctx) => calls.push(['onUnload', ctx.manifest.id]),
      onRequestReload: (ctx) => calls.push(['onRequestReload', ctx.manifest.id]),
    };
    const r = await loadPlugins({
      entries: [
        { manifest: { id: 'p1', name: 'P1', version: '1.0.0' }, module: fakeModule },
      ],
      environment: 'browser',
      log: () => {},
    });
    assert.equal(r.skipped.length, 0);
    assert.equal(r.loaded.size, 1);
    assert.deepEqual(calls, [
      ['onBeforeLoad', 'p1'],
      ['onLoad', 'p1'],
    ]);
    // Unload path
    unloadPlugin(r.loaded.get('p1'));
    assert.deepEqual(calls.slice(2), [
      ['onBeforeUnload', 'p1'],
      ['onUnload', 'p1'],
    ]);
  });

  await checkAsync('loaded order respects dependency edge (A depends on B)', async () => {
    const calls = [];
    const mod = (id) => ({
      onLoad: () => calls.push(id),
    });
    const r = await loadPlugins({
      entries: [
        { manifest: { id: 'a', name: 'A', version: '1.0.0', dependencies: ['b@^1.0.0'] }, module: mod('a') },
        { manifest: { id: 'b', name: 'B', version: '1.0.0' }, module: mod('b') },
      ],
      log: () => {},
    });
    assert.deepEqual(calls, ['b', 'a']);
    assert.deepEqual([...r.loaded.keys()], ['b', 'a']);
  });

  await checkAsync('onBeforeLoad returning false skips that plugin (only)', async () => {
    const calls = [];
    const r = await loadPlugins({
      entries: [
        {
          manifest: { id: 'broken', name: 'Broken', version: '1.0.0' },
          module: {
            onBeforeLoad: () => false,
            onLoad: () => calls.push('broken-onload'),
          },
        },
        {
          manifest: { id: 'ok', name: 'Ok', version: '1.0.0' },
          module: { onLoad: () => calls.push('ok-onload') },
        },
      ],
      log: () => {},
    });
    assert.deepEqual(calls, ['ok-onload']);
    assert.equal(r.loaded.has('broken'), false);
    assert.equal(r.loaded.has('ok'), true);
    assert.ok(r.skipped.some((s) => s.id === 'broken'));
  });

  await checkAsync('invalid manifest → skipped (does not break sibling)', async () => {
    const calls = [];
    const r = await loadPlugins({
      entries: [
        { manifest: { /* no id */ name: 'NoId', version: '1.0.0' }, module: { onLoad: () => calls.push('noid') } },
        { manifest: { id: 'good', name: 'Good', version: '1.0.0' }, module: { onLoad: () => calls.push('good') } },
      ],
      log: () => {},
    });
    assert.deepEqual(calls, ['good']);
    assert.equal(r.loaded.size, 1);
    assert.ok(r.skipped.some((s) => s.reason === 'manifest invalid'));
  });

  await checkAsync('environment mismatch → skipped', async () => {
    const calls = [];
    const r = await loadPlugins({
      entries: [
        { manifest: { id: 'tui-only', name: 'T', version: '1.0.0', environments: ['tui'] }, module: { onLoad: () => calls.push('x') } },
      ],
      environment: 'browser',
      log: () => {},
    });
    assert.equal(r.loaded.size, 0);
    assert.equal(calls.length, 0);
    assert.ok(r.skipped.some((s) => /environment mismatch/.test(s.reason)));
  });

  await checkAsync('dev sidecar overrides entry (in-loader)', async () => {
    const r = await loadPlugins({
      entries: [
        {
          manifest: { id: 'a', name: 'A', version: '1.0.0', entry: './bin/a.js' },
          dev: { source: './src/a.js' },
          module: { onLoad: () => {} },
        },
      ],
      log: () => {},
    });
    assert.equal(r.loaded.get('a').manifest.entry, './src/a.js');
  });

  await checkAsync('LIFECYCLE_HOOKS export is frozen + has all 5', () => {
    assert.deepEqual([...LIFECYCLE_HOOKS], [
      'onBeforeLoad', 'onLoad', 'onBeforeUnload', 'onUnload', 'onRequestReload',
    ]);
    assert.equal(Object.isFrozen(LIFECYCLE_HOOKS), true);
  });

  await checkAsync('callHook swallows throw, returns undefined', () => {
    const out = callHook({ onLoad: () => { throw new Error('boom'); } }, 'onLoad', {});
    assert.equal(out, undefined);
  });

  await checkAsync('callHook returns the hook return value when no throw', () => {
    const out = callHook({ onBeforeLoad: () => 'ok' }, 'onBeforeLoad', {});
    assert.equal(out, 'ok');
  });

  // ─── [H] Per-plugin manifest.json files — schema parse for all 50 ───
  console.log('\n[H] all bundled manifests parse + validate');

  check('schemas/plugin-manifest.json is well-formed JSON', () => {
    const txt = fs.readFileSync(SCHEMA_PATH, 'utf8');
    const j = JSON.parse(txt);
    assert.equal(j.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(j.type, 'object');
    assert.deepEqual(j.required, ['id', 'name', 'version']);
  });

  check('index.json is well-formed and lists 50 plugins', () => {
    const txt = fs.readFileSync(INDEX_PATH, 'utf8');
    const j = JSON.parse(txt);
    assert.ok(Array.isArray(j.plugins), 'plugins must be array');
    assert.equal(j.plugins.length, 50, `expected 50, got ${j.plugins.length}`);
  });

  const manifestFiles = fs.readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith('.manifest.json'))
    .sort();

  check(`found ${manifestFiles.length} manifest files (expected 50)`, () => {
    assert.equal(manifestFiles.length, 50);
  });

  const seenIds = new Set();
  for (const f of manifestFiles) {
    check(`${f}: parses + validates + id is unique`, () => {
      const text = fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8');
      const obj = JSON.parse(text);
      const { valid, errors } = validateManifest(obj);
      assert.equal(valid, true, `validation errors: ${errors.join(' | ')}`);
      assert.equal(seenIds.has(obj.id), false, `duplicate id: ${obj.id}`);
      seenIds.add(obj.id);
      // entry path lines up with the .js file
      assert.match(obj.entry || '', /\.\/[a-zA-Z0-9_\-]+\.js$/);
      const jsName = obj.entry.replace(/^\.\//, '');
      assert.ok(fs.existsSync(path.join(PLUGINS_DIR, jsName)),
        `entry file ${jsName} not found`);
    });
  }

  check('all 50 manifests resolve as a single dependency graph (cycle-free)', () => {
    const manifests = manifestFiles.map((f) =>
      JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8'))
    );
    const { started, skipped } = resolveDependencies(manifests);
    assert.equal(started.length, 50, `expected 50 started, got ${started.length}: ${started}`);
    assert.equal(skipped.length, 0,
      `expected 0 skipped, got ${skipped.length}: ${JSON.stringify(skipped)}`);
  });

  // ─── Summary ───
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\nFailures:');
    for (const f of failures) {
      console.log(`  - ${f.name}: ${f.err.message}`);
      if (f.err.stack) console.log(f.err.stack.split('\n').slice(1, 4).join('\n'));
    }
    process.exit(1);
  }
})();
