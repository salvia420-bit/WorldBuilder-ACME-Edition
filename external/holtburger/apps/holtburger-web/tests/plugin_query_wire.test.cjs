// =============================================================================
// P6.1 (2026-07-27) — plugin-manifest wire answer: GameEvent 0x02AE ->
// GameAction 0x02AF (`Admin_QueryPluginList` / `Admin_QueryPluginListResponse`)
// =============================================================================
//
// Covers the JS half of the pair — `plugins/loader.js::formatPluginList`, the
// only producer of the `PluginList` string the wasm session sends — plus a
// byte-exact cross-check against the Rust fixture in
// `crates/holtburger-protocol/src/messages/admin/actions.rs`, so the two
// halves cannot drift.
//
//   [A] formatPluginList — `id@version`, comma-joined, sorted, from the
//       loader's own `loaded` Map
//   [B] empty / missing input -> retail's "3rd party API not in use." verbatim
//   [C] every bundled manifest renders (id + version are validateManifest-
//       guaranteed non-empty strings)
//   [D] wire layout parity with the Rust ProtocolPack fixture:
//       u32 sequence | u32 0x02AF | u32 context | u16 len | cp1252 | pad-to-4
//
// Run from apps/holtburger-web/:
//   node tests/plugin_query_wire.test.cjs
// =============================================================================

const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const LOADER_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'loader.js')
).href;
const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    failed += 1;
    failures.push({ name, err });
    console.log(`  [FAIL] ${name}: ${err.message}`);
  }
}

// PStringBase<char>::Pack — u16 length (0xFFFF escape + u32 for >=64K),
// WINDOWS-1252 bytes, zero-pad the whole buffer to a DWORD boundary.
// Mirrors holtburger-protocol `messages::utils::write_string16`.
function packString16(buf, s) {
  const bytes = Buffer.from(s, 'latin1'); // cp1252 == latin1 for ASCII
  const len = Buffer.alloc(2);
  len.writeUInt16LE(bytes.length, 0);
  let out = Buffer.concat([buf, len, bytes]);
  const pad = (4 - (out.length % 4)) % 4;
  if (pad) out = Buffer.concat([out, Buffer.alloc(pad)]);
  return out;
}

// CM_Admin::Event_QueryPluginListResponse (acclient.c 0x6ADAE0):
// opcode, context, DWORD-align, string. `sequence` is the GameAction
// OrderHdr stamp the session layer prepends.
function packQueryPluginListResponse(sequence, context, pluginList) {
  const head = Buffer.alloc(12);
  head.writeUInt32LE(sequence >>> 0, 0);
  head.writeUInt32LE(0x02af, 4);
  head.writeUInt32LE(context >>> 0, 8);
  return packString16(head, pluginList);
}

(async () => {
  const loader = await import(LOADER_URL);
  const { formatPluginList, NO_PLUGIN_API_PLUGIN_LIST } = loader;

  console.log('\n[A] formatPluginList — id@version from the loaded Map');

  check('renders id@version, comma-joined, sorted by id', () => {
    const loaded = new Map([
      ['rynth-bar', { manifest: { id: 'rynth-bar', name: 'Bar', version: '1.2.0' }, module: {} }],
      ['chat-panel', { manifest: { id: 'chat-panel', name: 'Chat', version: '0.4.1' }, module: {} }],
    ]);
    assert.equal(formatPluginList(loaded), 'chat-panel@0.4.1,rynth-bar@1.2.0');
  });

  check('sort is stable regardless of insertion order', () => {
    const a = new Map([
      ['b', { manifest: { id: 'b', version: '1.0.0' } }],
      ['a', { manifest: { id: 'a', version: '1.0.0' } }],
    ]);
    const b = new Map([
      ['a', { manifest: { id: 'a', version: '1.0.0' } }],
      ['b', { manifest: { id: 'b', version: '1.0.0' } }],
    ]);
    assert.equal(formatPluginList(a), formatPluginList(b));
    assert.equal(formatPluginList(a), 'a@1.0.0,b@1.0.0');
  });

  check('accepts a plain iterable of entries', () => {
    assert.equal(
      formatPluginList([{ manifest: { id: 'solo', version: '2.0.0' } }]),
      'solo@2.0.0'
    );
  });

  check('accepts bare manifests (no {manifest} wrapper)', () => {
    assert.equal(formatPluginList([{ id: 'bare', version: '3.1.4' }]), 'bare@3.1.4');
  });

  console.log('\n[B] retail default — "3rd party API not in use."');

  check('the constant is retail-verbatim, trailing period included', () => {
    assert.equal(NO_PLUGIN_API_PLUGIN_LIST, '3rd party API not in use.');
    assert.equal(NO_PLUGIN_API_PLUGIN_LIST.length, 25);
  });

  check('empty Map -> retail default (never "")', () => {
    assert.equal(formatPluginList(new Map()), NO_PLUGIN_API_PLUGIN_LIST);
  });

  check('null / undefined -> retail default', () => {
    assert.equal(formatPluginList(null), NO_PLUGIN_API_PLUGIN_LIST);
    assert.equal(formatPluginList(undefined), NO_PLUGIN_API_PLUGIN_LIST);
  });

  check('entries without a usable id are dropped, not rendered as "undefined@"', () => {
    assert.equal(
      formatPluginList([{ manifest: { version: '1.0.0' } }, { manifest: { id: 'ok', version: '1.0.0' } }]),
      'ok@1.0.0'
    );
    assert.equal(formatPluginList([{ manifest: { id: '' } }]), NO_PLUGIN_API_PLUGIN_LIST);
  });

  console.log('\n[C] bundled manifests all render');

  check('every plugins/*/manifest.json produces an id@version token', () => {
    const manifests = [];
    for (const dirent of fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })) {
      if (!dirent.isDirectory()) continue;
      const mp = path.join(PLUGINS_DIR, dirent.name, 'manifest.json');
      if (!fs.existsSync(mp)) continue;
      manifests.push(JSON.parse(fs.readFileSync(mp, 'utf8')));
    }
    if (manifests.length === 0) return; // flat layout; [A] already covers rendering
    const out = formatPluginList(manifests);
    assert.notEqual(out, NO_PLUGIN_API_PLUGIN_LIST);
    const tokens = out.split(',');
    assert.equal(tokens.length, manifests.length);
    for (const t of tokens) {
      assert.match(t, /^[^@]+@[^@]+$/, `malformed token ${JSON.stringify(t)}`);
    }
  });

  check('rendered roster is WINDOWS-1252 representable (PStringBase<char>)', () => {
    const out = formatPluginList([
      { manifest: { id: 'rynth-bar', version: '1.2.0' } },
    ]);
    for (const ch of out) {
      assert.ok(ch.codePointAt(0) <= 0xff, `non-cp1252 char ${JSON.stringify(ch)}`);
    }
  });

  console.log('\n[D] wire layout parity with the Rust fixtures');

  check('default reply matches admin/actions.rs test_..._default_parity', () => {
    const got = packQueryPluginListResponse(0x11223344, 0xdeadbeef, NO_PLUGIN_API_PLUGIN_LIST);
    assert.equal(
      got.toString('hex').toUpperCase(),
      '44332211AF020000EFBEADDE190033726420706172747920415049206E6F7420696E207573652E00'
    );
    assert.equal(got.length, 40);
  });

  check('manifest reply matches admin/actions.rs test_..._manifest_parity', () => {
    const roster = formatPluginList(
      new Map([
        ['rynth-bar', { manifest: { id: 'rynth-bar', version: '1.2.0' } }],
        ['chat-panel', { manifest: { id: 'chat-panel', version: '0.4.1' } }],
      ])
    );
    // formatPluginList sorts; the Rust fixture string is the unsorted pair,
    // so assert the layout on the fixture's own string and the sort separately.
    assert.equal(roster, 'chat-panel@0.4.1,rynth-bar@1.2.0');
    const got = packQueryPluginListResponse(
      0x55667788,
      0x00c0ffee,
      'rynth-bar@1.2.0,chat-panel@0.4.1'
    );
    assert.equal(
      got.toString('hex').toUpperCase(),
      '88776655AF020000EEFFC000200072796E74682D62617240312E322E302C636861742D70616E656C40302E342E310000'
    );
    assert.equal(got.length, 48);
  });

  check('every reply is DWORD-aligned for any roster length', () => {
    for (let n = 0; n < 40; n += 1) {
      const s = 'x'.repeat(n) || NO_PLUGIN_API_PLUGIN_LIST;
      const got = packQueryPluginListResponse(1, 1, s);
      assert.equal(got.length % 4, 0, `len ${got.length} for roster of ${n} chars`);
    }
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of failures) console.error(`\n${f.name}:\n${f.err.stack}`);
    process.exit(1);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
