// Emote palette contract — plugins/emote-panel.js (HUD overhaul 2026-10-05).
//
// The pre-overhaul palette rendered `getEmoteTaxonomy()` (server-side
// EmoteType script opcodes, delivered as a JS Map so `tax.types` was
// undefined → "0 of 0 actions visible"). It now lists the player soul
// emotes from the DAT ChatPoseTable (0x0E000007) and dispatches through
// the chat slash-command router. This suite imports the REAL module and
// pins:
//   1. every palette token is a real ChatPoseTable key (snapshot below,
//      dumped 2026-10-05 via WB.Terminal chorizite-parse-dat-record) and
//      tokens are unique;
//   2. filterEmotes matches label OR token, case-insensitively, and drops
//      empty categories;
//   3. performEmote: no handle → error; unknown token → error and NOTHING
//      is routed (routeSlashCommand would send `@token` to the server);
//      single-word token → the slash router; multi-word token → the
//      direct resolve/sendSoulEmote/broadcastEmoteMotion path, and the
//      wasm resolution object is freed.
//
// Run:  node tests/emote_table.test.cjs

'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
    console.log(`  [FAIL] ${name} — ${err.message}`);
  }
}

// ChatPoseTable 0x0E000007 tokens → pose, for every token the palette
// uses (subset of the 309-entry table).
const CHAT_POSE = {
  wave: 'Wave', wavehigh: 'WaveHigh', wavelow: 'WaveLow', waving: 'WAVESTATE', beckon: 'Beckon',
  beseeingyou: 'BeSeeingYou', bow: 'BowDeepState', curtsey: 'CurtseyState', salute: 'SaluteState',
  blowkiss: 'BlowKiss', nod: 'Nod', no: 'ShakeHead', helper: 'Helper', haveaseat: 'HaveASeatState',
  cheer: 'Cheer', laugh: 'Laugh', heartylaugh: 'HeartyLaugh', mock: 'Mock', clap: 'ClapHands',
  clapping: 'CLAPHANDSSTATE', cry: 'Cry', cringe: 'Cringe', shrug: 'Shrug', 'huh?': 'ScratchHead',
  hmm: 'SCRATCHHEADSTATE', doh: 'SmackHead', shakefist: 'ShakeFist', shakingfist: 'SHAKEFISTSTATE',
  shiver: 'Shiver', 'warm hands': 'WARMHANDS', yawn: 'YawnStretch', spit: 'Spit', plead: 'PleadState',
  surrender: 'SurrenderState', tapfoot: 'TapFootState', winded: 'WindedState', whoa: 'WoahState',
  talktothehand: 'TalktotheHandState', shoo: 'Shoo', point: 'PointState', pointleft: 'PointLeft',
  pointright: 'PointRight', pointdown: 'PointDown', nudgeleft: 'NudgeLeft', nudgeright: 'NudgeRight',
  scan: 'ScanHorizon', knock: 'Knock', sit: 'SitState', sitback: 'SitBackState',
  sitcrosslegged: 'SitCrossleggedState', kneel: 'KneelState', pray: 'PrayState',
  meditate: 'MeditateState', think: 'ThinkerState', read: 'ReadState', lean: 'LeanState',
  akimbo: 'AkimboState', atease: 'AtEaseState', crossarms: 'CrossArmsState', slouch: 'SlouchState',
  playdead: 'PossumState', snowangel: 'SNOWANGELSTATE', away: 'AFKState', dance: 'DrudgeDanceState',
  dancestep: 'DrudgeDance', ymca: 'YMCA', teapot: 'Teapot', drink: 'MimeDrink', eat: 'MimeEat',
  musicalchair: 'HaveASeat', atoyot: 'ATOYOT',
};

function fakeHandle(log) {
  return {
    resolveSoulEmote(token) {
      log.push(['resolve', token]);
      if (!(token in CHAT_POSE)) return undefined;
      return {
        otherEmote: `waves (${token}).`, myEmote: `wave (${token}).`, motionFull: 0x430000EC, held: false,
        free() { log.push(['free', token]); },
      };
    },
    sendSoulEmote(text) { log.push(['send', text]); },
    broadcastEmoteMotion(m) { log.push(['motion', m >>> 0]); },
  };
}

(async () => {
  globalThis.window = globalThis.window || globalThis;
  if (typeof window.addEventListener !== 'function') window.addEventListener = () => {};
  if (typeof window.removeEventListener !== 'function') window.removeEventListener = () => {};
  globalThis.document = globalThis.document || {
    createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
    getElementById: () => null, head: { appendChild() {} }, body: { appendChild() {} },
    addEventListener() {}, removeEventListener() {},
  };
  const url = pathToFileURL(path.join(__dirname, '..', 'plugins', 'emote-panel.js')).href;
  const { EMOTE_CATALOG, filterEmotes, performEmote, view, manifest } = await import(url);

  const all = EMOTE_CATALOG.flatMap((c) => c.items);

  check('catalog: every token is a real ChatPoseTable key', () => {
    for (const e of all) assert.ok(e.token in CHAT_POSE, `unknown token "${e.token}"`);
  });
  check('catalog: tokens unique, labels non-empty, categories non-empty', () => {
    const seen = new Set();
    for (const e of all) {
      assert.ok(!seen.has(e.token), `duplicate ${e.token}`);
      seen.add(e.token);
      assert.ok(e.label && e.label.trim(), 'label');
    }
    for (const c of EMOTE_CATALOG) assert.ok(c.items.length > 0, c.category);
    assert.ok(all.length >= 60, `expected the full retail set, got ${all.length}`);
  });
  check('catalog: held flag matches *State poses', () => {
    for (const e of all) {
      const pose = CHAT_POSE[e.token];
      const isState = /state$/i.test(pose);
      assert.equal(!!e.held, isState, `${e.token} (${pose})`);
    }
  });

  check('filterEmotes: matches label or token, case-insensitive', () => {
    const byLabel = filterEmotes(EMOTE_CATALOG, 'HEARTY');
    assert.deepEqual(byLabel.flatMap((g) => g.items.map((e) => e.token)), ['heartylaugh']);
    const byToken = filterEmotes(EMOTE_CATALOG, 'ymca');
    assert.deepEqual(byToken.map((g) => g.category), ['Fun']);
    assert.equal(filterEmotes(EMOTE_CATALOG, 'zzzz').length, 0, 'no empty categories');
    assert.equal(filterEmotes(EMOTE_CATALOG, '').length, EMOTE_CATALOG.length);
  });

  check('performEmote: no handle → error, nothing routed', () => {
    let routed = 0;
    const r = performEmote(all[0], null, () => { routed += 1; });
    assert.equal(r.ok, false);
    assert.equal(routed, 0);
  });
  check('performEmote: unknown token never reaches the slash router', () => {
    const log = [];
    let routed = 0;
    const r = performEmote({ label: 'Nope', token: 'notanemote' }, fakeHandle(log), () => { routed += 1; return { dispatched: true }; });
    assert.equal(r.ok, false);
    assert.equal(routed, 0, 'routeSlashCommand would forward @notanemote to the server');
  });
  check('performEmote: single-word token → chat slash router (same path as typing it)', () => {
    const log = [];
    const calls = [];
    const r = performEmote({ label: 'Wave', token: 'wave' }, fakeHandle(log), (h, msg) => { calls.push(msg); return { dispatched: true, echo: 'You wave.' }; });
    assert.equal(r.ok, true);
    assert.equal(r.echo, 'You wave.');
    assert.deepEqual(calls, ['/wave']);
    assert.ok(log.some(([k, t]) => k === 'free' && t === 'wave'), 'probe resolution freed');
  });
  check('performEmote: multi-word token → direct resolve/send/motion, resolution freed', () => {
    const log = [];
    let predicted = null;
    const r = performEmote({ label: 'Warm Hands', token: 'warm hands' }, fakeHandle(log),
      () => { throw new Error('must not route a spaced token'); }, (m, held) => { predicted = [m, held]; });
    assert.equal(r.ok, true);
    assert.equal(r.echo, 'You wave (warm hands).');
    assert.deepEqual(log.filter(([k]) => k === 'send' || k === 'motion'),
      [['send', 'waves (warm hands).'], ['motion', 0x430000EC]]);
    assert.deepEqual(predicted, [0x430000EC, false]);
    assert.equal(log.filter(([k]) => k === 'free').length, 2, 'probe + dispatch resolutions both freed');
  });

  check('view + manifest surface', () => {
    assert.equal(typeof view.mount, 'function');
    assert.equal(view.nameFor(), 'Emotes');
    assert.equal(manifest.id, 'emote-panel');
  });

  console.log(`\n## Summary: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    for (const { name, err } of failures) console.log(`  - ${name}: ${err.stack || err.message}`);
    process.exit(1);
  }
  process.exit(0);
})();
