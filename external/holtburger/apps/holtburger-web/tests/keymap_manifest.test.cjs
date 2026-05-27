// =============================================================================
// Polish B (Chorizite-absorption, 2026-05-27) — ui/keymap.js manifest-bindings
// =============================================================================
//
// Validates the manifest-aggregation path added in Polish B:
//   [A] parseHotkeyString — modifier+key parser, canonical-form normalisation
//   [B] buildManifestBindings — aggregate {id, hotkeys[]} → key→action map
//                               and surface duplicates
//   [C] setManifestBindings / matchHotkeyEvent — KeyboardEvent dispatch lookup
//   [D] listManifestBindings — snapshot for settings UI / tests
//   [E] Real-manifest coverage — every bundled manifest's `hotkeys[]`
//                                normalises cleanly
//
// Run from apps/holtburger-web/:
//   node tests/keymap_manifest.test.cjs
// =============================================================================

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const KEYMAP_URL = pathToFileURL(
  path.join(__dirname, '..', 'ui', 'keymap.js')
).href;
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    const out = fn();
    if (out instanceof Promise) throw new Error('use checkAsync for async');
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

// keymap.js touches `window.__diag?` defensively inside functions only —
// no top-level DOM access — so a minimal `window` stub keeps the optional
// chain happy without dragging in jsdom.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis;
}

(async () => {
  const {
    parseHotkeyString,
    buildManifestBindings,
    setManifestBindings,
    getManifestBinding,
    matchHotkeyEvent,
    listManifestBindings,
    clearManifestBindings,
  } = await import(KEYMAP_URL);

  // ─── [A] parseHotkeyString ───
  console.log('\n[A] parseHotkeyString');

  check('bare key parses', () => {
    const r = parseHotkeyString('F4');
    assert.deepEqual(r, {
      key: 'F4', shift: false, ctrl: false, alt: false, meta: false,
      canonical: 'F4',
    });
  });

  check('Shift+F2 parses', () => {
    const r = parseHotkeyString('Shift+F2');
    assert.equal(r.key, 'F2');
    assert.equal(r.shift, true);
    assert.equal(r.canonical, 'Shift+F2');
  });

  check('Ctrl+Shift+F5 normalises in Ctrl→Alt→Shift→Meta order', () => {
    const r = parseHotkeyString('Shift+Ctrl+F5'); // out-of-order input
    assert.equal(r.ctrl, true);
    assert.equal(r.shift, true);
    assert.equal(r.canonical, 'Ctrl+Shift+F5');
  });

  check('all modifiers parse', () => {
    const r = parseHotkeyString('Ctrl+Alt+Shift+Meta+I');
    assert.equal(r.canonical, 'Ctrl+Alt+Shift+Meta+I');
    assert.equal(r.ctrl, true);
    assert.equal(r.alt, true);
    assert.equal(r.shift, true);
    assert.equal(r.meta, true);
    assert.equal(r.key, 'I');
  });

  check('letter key parses', () => {
    assert.equal(parseHotkeyString('I').canonical, 'I');
    assert.equal(parseHotkeyString('Escape').canonical, 'Escape');
  });

  check('empty / nullish / non-string → null', () => {
    assert.equal(parseHotkeyString(''), null);
    assert.equal(parseHotkeyString(null), null);
    assert.equal(parseHotkeyString(undefined), null);
    assert.equal(parseHotkeyString(42), null);
  });

  check('unknown modifier → null (no silent acceptance)', () => {
    assert.equal(parseHotkeyString('Super+F4'), null);
    assert.equal(parseHotkeyString('ctrl+F4'), null); // case-sensitive
  });

  // ─── [B] buildManifestBindings ───
  console.log('\n[B] buildManifestBindings — aggregate manifests');

  check('three manifests with distinct hotkeys aggregate cleanly', () => {
    const r = buildManifestBindings([
      { id: 'combat-bar', hotkeys: [{ id: 'toggle', default: 'F4', label: 'Combat' }] },
      { id: 'spellbook', hotkeys: [{ id: 'toggle', default: 'F5', label: 'Spells' }] },
      { id: 'emote-panel', hotkeys: [{ id: 'toggle', default: 'Shift+F2', label: 'Emotes' }] },
    ]);
    assert.equal(r.map.F4, 'combat-bar::toggle');
    assert.equal(r.map.F5, 'spellbook::toggle');
    assert.equal(r.map['Shift+F2'], 'emote-panel::toggle');
    assert.equal(r.labels.F4, 'Combat');
    assert.deepEqual(r.duplicates, []);
  });

  check('out-of-order modifiers normalise to canonical', () => {
    const r = buildManifestBindings([
      { id: 'p', hotkeys: [{ id: 'a', default: 'Shift+Ctrl+F5' }] },
    ]);
    assert.equal(r.map['Ctrl+Shift+F5'], 'p::a');
    assert.equal(r.map['Shift+Ctrl+F5'], undefined,
      'raw input form is not present — only the canonical form');
  });

  check('plugin without hotkeys is silently ignored', () => {
    const r = buildManifestBindings([
      { id: 'a', hotkeys: [{ id: 't', default: 'F1' }] },
      { id: 'b' }, // no hotkeys
      { id: 'c', hotkeys: [] }, // empty
    ]);
    assert.equal(Object.keys(r.map).length, 1);
    assert.equal(r.map.F1, 'a::t');
  });

  check('malformed default string skipped', () => {
    const r = buildManifestBindings([
      { id: 'a', hotkeys: [{ id: 't', default: 'F4' }] },
      { id: 'bad', hotkeys: [{ id: 't', default: 'Super+F4' }] },
    ]);
    assert.equal(r.map.F4, 'a::t');
    assert.equal(Object.keys(r.map).length, 1);
  });

  check('duplicate key → recorded in duplicates[]', () => {
    const r = buildManifestBindings([
      { id: 'combat-bar', hotkeys: [{ id: 'toggle', default: 'F4' }] },
      { id: 'inventory', hotkeys: [{ id: 'toggle', default: 'F4' }] },
    ]);
    // Last-wins for the map (mirrors legacy `FKEY_VIEWS` last-assigned).
    assert.equal(r.map.F4, 'inventory::toggle');
    assert.equal(r.duplicates.length, 1);
    assert.equal(r.duplicates[0].keyString, 'F4');
    assert.deepEqual(r.duplicates[0].conflicts.sort(),
      ['combat-bar::toggle', 'inventory::toggle'].sort());
  });

  check('non-array input → empty map (no throw)', () => {
    const r = buildManifestBindings(null);
    assert.deepEqual(r.map, {});
    assert.deepEqual(r.duplicates, []);
  });

  check('hotkey without label → labels[] entry omitted', () => {
    const r = buildManifestBindings([
      { id: 'a', hotkeys: [{ id: 't', default: 'F1' }] }, // no label
      { id: 'b', hotkeys: [{ id: 't', default: 'F2', label: 'Bar' }] },
    ]);
    assert.equal(r.labels.F1, undefined);
    assert.equal(r.labels.F2, 'Bar');
  });

  // ─── [C] setManifestBindings / matchHotkeyEvent ───
  console.log('\n[C] setManifestBindings / matchHotkeyEvent');

  check('setManifestBindings registers cleanly', () => {
    clearManifestBindings();
    const r = setManifestBindings({
      F4: 'combat-bar::toggle',
      F5: 'spellbook::toggle',
      'Shift+F2': 'emote-panel::toggle',
    });
    assert.equal(r.registered, 3);
    assert.equal(r.skipped.length, 0);
  });

  check('matchHotkeyEvent finds F4 by KeyboardEvent shape', () => {
    const action = matchHotkeyEvent({
      key: 'F4', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    });
    assert.equal(action.pluginId, 'combat-bar');
    assert.equal(action.hotkeyId, 'toggle');
    assert.equal(action.keyString, 'F4');
  });

  check('matchHotkeyEvent finds Shift+F2 only when shiftKey set', () => {
    const noShift = matchHotkeyEvent({
      key: 'F2', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    });
    assert.equal(noShift, null, 'plain F2 should not match Shift+F2');
    const withShift = matchHotkeyEvent({
      key: 'F2', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false,
    });
    assert.equal(withShift.pluginId, 'emote-panel');
  });

  check('matchHotkeyEvent rejects when extra modifiers present', () => {
    const ev = {
      key: 'F4', shiftKey: false, ctrlKey: true, altKey: false, metaKey: false,
    };
    assert.equal(matchHotkeyEvent(ev), null,
      'Ctrl+F4 should not match bare F4 binding');
  });

  check('matchHotkeyEvent returns null on no-match key', () => {
    const ev = {
      key: 'F11', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    };
    assert.equal(matchHotkeyEvent(ev), null);
  });

  check('matchHotkeyEvent returns null on missing-key event', () => {
    assert.equal(matchHotkeyEvent({}), null);
    assert.equal(matchHotkeyEvent(null), null);
  });

  check('getManifestBinding mirrors matchHotkeyEvent for set keys', () => {
    const b = getManifestBinding('F4');
    assert.equal(b.pluginId, 'combat-bar');
    const m = matchHotkeyEvent({
      key: 'F4', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
    });
    assert.equal(b.pluginId, m.pluginId);
    assert.equal(b.hotkeyId, m.hotkeyId);
  });

  check('getManifestBinding accepts out-of-order modifier strings', () => {
    clearManifestBindings();
    setManifestBindings({ 'Ctrl+Shift+F5': 'foo::bar' });
    const b = getManifestBinding('Shift+Ctrl+F5'); // user-typed
    assert.equal(b.pluginId, 'foo');
  });

  check('listManifestBindings returns sorted snapshot', () => {
    clearManifestBindings();
    setManifestBindings({
      F7: 'contracts-panel::toggle',
      F3: 'map-panel::toggle',
      'Shift+F6': 'house-panel::toggle',
    });
    const list = listManifestBindings();
    assert.equal(list.length, 3);
    // Sorted by keyString (localeCompare). 'F3' < 'F7' < 'Shift+F6'.
    assert.equal(list[0].keyString, 'F3');
    assert.equal(list[1].keyString, 'F7');
    assert.equal(list[2].keyString, 'Shift+F6');
  });

  check('setManifestBindings invalid input → skipped, others continue', () => {
    clearManifestBindings();
    const r = setManifestBindings({
      F1: 'valid::action',
      'Bogus+Key': 'also::valid',  // malformed key
      F2: '',                       // empty value
      F3: 'no-separator-here',      // missing ::
      F4: '::just-hotkey-no-plugin', // empty plugin id
    });
    assert.equal(r.registered, 1);
    assert.equal(r.skipped.length, 4);
    assert.equal(matchHotkeyEvent({ key: 'F1', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }).pluginId, 'valid');
    assert.equal(matchHotkeyEvent({ key: 'F2', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), null);
  });

  check('setManifestBindings replaces (not merges) prior bindings', () => {
    clearManifestBindings();
    setManifestBindings({ F1: 'old::a' });
    setManifestBindings({ F2: 'new::b' });
    assert.equal(matchHotkeyEvent({ key: 'F1', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false }), null);
    const m = matchHotkeyEvent({ key: 'F2', shiftKey: false, ctrlKey: false, altKey: false, metaKey: false });
    assert.equal(m.pluginId, 'new');
  });

  check('setManifestBindings(null) clears the table', () => {
    setManifestBindings({ F1: 'x::y' });
    setManifestBindings(null);
    assert.equal(listManifestBindings().length, 0);
  });

  // ─── [D] Real-manifest coverage ───
  console.log('\n[D] real-manifest coverage — every bundled hotkey normalises');

  const manifestFiles = fs.readdirSync(PLUGINS_DIR)
    .filter((f) => f.endsWith('.manifest.json'))
    .sort();

  const manifestsWithHotkeys = [];
  for (const f of manifestFiles) {
    const obj = JSON.parse(fs.readFileSync(path.join(PLUGINS_DIR, f), 'utf8'));
    if (Array.isArray(obj.hotkeys) && obj.hotkeys.length > 0) {
      manifestsWithHotkeys.push(obj);
    }
  }

  check(`at least 6 manifests declare hotkeys (PR 8 baseline)`, () => {
    assert.ok(manifestsWithHotkeys.length >= 6,
      `expected >=6 manifests with hotkeys, got ${manifestsWithHotkeys.length}: ${manifestsWithHotkeys.map((m) => m.id).join(', ')}`);
  });

  for (const m of manifestsWithHotkeys) {
    for (const hk of m.hotkeys) {
      check(`${m.id} hotkey "${hk.default}" parses to canonical form`, () => {
        const parsed = parseHotkeyString(hk.default);
        assert.ok(parsed, `manifest ${m.id} declares unparseable hotkey ${JSON.stringify(hk.default)}`);
      });
    }
  }

  check('aggregate of all real manifests produces expected core bindings', () => {
    const r = buildManifestBindings(manifestsWithHotkeys);
    // Per Polish B + Wave J1.A + Wave J1.B (2026-05-27 orphan cleanup +
    // legacy FKEY consolidation):
    //   F1=character-info, F2=spellbook (alt), F3=map, F4=inventory,
    //   F5=spellbook, F6=journal, F7=contracts, F8=allegiance,
    //   F9=fellowship, F10=options-panel, Shift+F2=emote,
    //   Shift+F4=spell-research-panel, Shift+F6=house.
    // Wave J1.A removed `combat-bar`'s aspirational F4 hotkey (no JS
    // listener; F4 is the de-facto open-inventory binding) and moved
    // F4 onto `inventory.manifest.json` where it now reflects the actual
    // dispatch. Inventory's prior "I" hotkey was orphaned (no handler
    // anywhere) so it was retired alongside the combat-bar F4 claim.
    // Wave J1.B (this commit) added F1 / F10 / Shift+F4 manifests for
    // the previously-unmanifested character-info / options-panel /
    // spell-research-panel plugins and folded F2 into spellbook as a
    // multi-hotkey (matches the retail dual-binding F2+F5 → Spellbook).
    // Source-of-truth for these names is the FKEY_VIEWS table that the
    // same commit deletes from index.html.
    const expected = {
      'F1': 'character-info::toggle',
      'F2': 'spellbook::toggle-alt',
      'F3': 'map-panel::toggle',
      'F4': 'inventory::toggle',
      'F5': 'spellbook::toggle',
      'F6': 'journal-panel::toggle',
      'F7': 'contracts-panel::toggle',
      'F8': 'allegiance-panel::toggle',
      'F9': 'fellowship-panel::toggle',
      'F10': 'options-panel::toggle',
      'Shift+F2': 'emote-panel::toggle',
      'Shift+F4': 'spell-research-panel::toggle',
      'Shift+F6': 'house-panel::toggle',
    };
    for (const [k, v] of Object.entries(expected)) {
      assert.equal(r.map[k], v, `expected ${k} → ${v}, got ${r.map[k]}`);
    }
    // The orphaned "I" hotkey must not reappear.
    assert.equal(r.map.I, undefined,
      'inventory should no longer claim "I" (Wave J1.A orphan removal)');
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
