// Audit test for `plugins/world-objects/world_object.js` typed property-dict
// accessors. Mirrors the 8 typed dicts + `Value<T>` overloads from
// ACPlugin/API/WorldObject.cs (lines 78-113 for the dicts, 237-341 for the
// typed value getters).
//
// For each of the 8 dicts (Int / Int64 / Bool / Float / String / Instance /
// Data / Position) we cover:
//   - hit  : value present, correct type + correct value returned
//   - miss : key absent, correct default returned (matches C# overload default)
//
// Run from apps/holtburger-web/:  node tests/world_object_property_dict.test.cjs
// Exits 0 on full pass, 1 on any assertion failure.

const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');

const WO_URL = pathToFileURL(
  path.join(__dirname, '..', 'plugins', 'world-objects', 'world_object.js')
).href;

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

(async () => {
  const { WorldObject } = await import(WO_URL);

  function makeObj() {
    return new WorldObject(0x12345678, 0xa9b4, null, null, null);
  }

  // --------------- 1. IntValues  (WorldObject.cs:78,237) ---------------
  // Dict: Dictionary<PropertyInt, int>
  // Getter: int Value(PropertyInt key, int @default = 0)
  console.log('\n[1] IntValues  (PropertyInt -> int)');
  {
    const wo = makeObj();
    // PropertyInt.ItemType == 1; PropertyInt.EncumbranceVal == 5 (per ACE enum)
    wo.intValues.set(1, 256);
    wo.intValues.set(5, 800);
    check('intValue hit: ItemType=256', () => {
      const v = wo.intValue(1);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 256);
    });
    check('intValue miss: returns 0 default (matches WorldObject.cs:237)', () => {
      const v = wo.intValue(99);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 0);
    });
    check('intValue miss: explicit fallback honoured', () => {
      assert.strictEqual(wo.intValue(99, -1), -1);
    });
  }

  // --------------- 2. Int64Values  (WorldObject.cs:83,251) ---------------
  // Dict: Dictionary<PropertyInt64, long>
  // Getter: long Value(PropertyInt64 key, long @default = 0)
  // We use BigInt JS-side to preserve full int64 range.
  console.log('\n[2] Int64Values  (PropertyInt64 -> long)');
  {
    const wo = makeObj();
    // PropertyInt64.TotalExperience == 1 in ACE enum.
    const bigVal = 9007199254740993n; // > Number.MAX_SAFE_INTEGER, proves bigint path
    wo.int64Values.set(1, bigVal);
    check('int64Value hit: bigint preserves > MAX_SAFE_INTEGER', () => {
      const v = wo.int64Value(1);
      assert.strictEqual(typeof v, 'bigint');
      assert.strictEqual(v, bigVal);
    });
    check('int64Value miss: returns 0n default (matches WorldObject.cs:251)', () => {
      const v = wo.int64Value(99);
      assert.strictEqual(typeof v, 'bigint');
      assert.strictEqual(v, 0n);
    });
  }

  // --------------- 3. BoolValues  (WorldObject.cs:93,279) ---------------
  // Dict: Dictionary<PropertyBool, bool>
  // Getter: bool Value(PropertyBool key, bool @default = false)
  console.log('\n[3] BoolValues  (PropertyBool -> bool)');
  {
    const wo = makeObj();
    // PropertyBool.IsSellable / Stuck / etc.
    wo.boolValues.set(7, true);
    wo.boolValues.set(8, false);
    check('boolValue hit true', () => {
      const v = wo.boolValue(7);
      assert.strictEqual(typeof v, 'boolean');
      assert.strictEqual(v, true);
    });
    check('boolValue hit false', () => {
      const v = wo.boolValue(8);
      assert.strictEqual(typeof v, 'boolean');
      assert.strictEqual(v, false);
    });
    check('boolValue miss: returns false default (matches WorldObject.cs:279)', () => {
      const v = wo.boolValue(99);
      assert.strictEqual(typeof v, 'boolean');
      assert.strictEqual(v, false);
    });
  }

  // --------------- 4. FloatValues  (WorldObject.cs:98,293) ---------------
  // Dict: Dictionary<PropertyFloat, float>
  // Getter: float Value(PropertyFloat key, float @default = 0f)
  console.log('\n[4] FloatValues  (PropertyFloat -> float)');
  {
    const wo = makeObj();
    // PropertyFloat.CooldownDuration / UseRadius / etc.
    wo.floatValues.set(13, 1.5);
    check('floatValue hit: 1.5', () => {
      const v = wo.floatValue(13);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 1.5);
    });
    check('floatValue miss: returns 0.0 default (matches WorldObject.cs:293)', () => {
      const v = wo.floatValue(99);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 0.0);
    });
  }

  // --------------- 5. StringValues  (WorldObject.cs:88,265) ---------------
  // Dict: Dictionary<PropertyString, string>
  // Getter: string Value(PropertyString key, string @default = "")
  console.log('\n[5] StringValues  (PropertyString -> string)');
  {
    const wo = makeObj();
    // PropertyString.Name == 1; .PluralName == 2
    wo.stringValues.set(1, 'Drudge Skulker');
    check('stringValue hit: Drudge Skulker', () => {
      const v = wo.stringValue(1);
      assert.strictEqual(typeof v, 'string');
      assert.strictEqual(v, 'Drudge Skulker');
    });
    check('stringValue miss: returns "" default (matches WorldObject.cs:265)', () => {
      const v = wo.stringValue(99);
      assert.strictEqual(typeof v, 'string');
      assert.strictEqual(v, '');
    });
    check('stringValue convenience getter `.name` reads PropertyString.Name', () => {
      assert.strictEqual(wo.name, 'Drudge Skulker');
    });
  }

  // --------------- 6. InstanceValues  (WorldObject.cs:103,307) ---------------
  // Dict: Dictionary<PropertyInstanceId, uint>
  // Getter: uint Value(PropertyInstanceId key, uint @default = 0)
  console.log('\n[6] InstanceValues  (PropertyInstanceId -> uint)');
  {
    const wo = makeObj();
    // PropertyInstanceId.Wielder / Container / Owner
    wo.instanceValues.set(2, 0xC0FFEE);
    check('instanceValue hit: uint guid', () => {
      const v = wo.instanceValue(2);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 0xC0FFEE);
    });
    check('instanceValue miss: returns 0 default (matches WorldObject.cs:307)', () => {
      const v = wo.instanceValue(99);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 0);
    });
  }

  // --------------- 7. DataValues  (WorldObject.cs:108,321) ---------------
  // Dict: Dictionary<PropertyDataId, uint>
  // Getter: uint Value(PropertyDataId key, uint @default = 0)
  console.log('\n[7] DataValues  (PropertyDataId -> uint)');
  {
    const wo = makeObj();
    // PropertyDataId.Icon == 22 (referencing DAT entries)
    wo.dataValues.set(22, 0x06001234);
    check('dataValue hit: DAT id', () => {
      const v = wo.dataValue(22);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 0x06001234);
    });
    check('dataValue miss: returns 0 default (matches WorldObject.cs:321)', () => {
      const v = wo.dataValue(99);
      assert.strictEqual(typeof v, 'number');
      assert.strictEqual(v, 0);
    });
  }

  // --------------- 8. PositionValues  (WorldObject.cs:113,335) ---------------
  // Dict: Dictionary<PropertyPosition, Position>
  // Getter: Position Value(PropertyPosition key, Position? position = null)
  // C# returns null when absent + no default supplied.
  console.log('\n[8] PositionValues  (PropertyPosition -> Position)');
  {
    const wo = makeObj();
    // PropertyPosition.Location == 1
    const pos = {
      objCellId: 0x8602001F,
      origin: { x: 12.5, y: 20.0, z: 5.0 },
      angles: { w: 1.0, x: 0.0, y: 0.0, z: 0.0 },
    };
    wo.positionValues.set(1, pos);
    check('positionValue hit: full Position object', () => {
      const v = wo.positionValue(1);
      assert.strictEqual(typeof v, 'object');
      assert.notStrictEqual(v, null);
      assert.strictEqual(v.objCellId, 0x8602001F);
      assert.strictEqual(v.origin.y, 20.0);
    });
    check('positionValue miss: returns null default (matches WorldObject.cs:335)', () => {
      const v = wo.positionValue(99);
      assert.strictEqual(v, null);
    });
    check('positionValue miss: explicit fallback object honoured', () => {
      const fb = { objCellId: 0 };
      assert.strictEqual(wo.positionValue(99, fb), fb);
    });
  }

  // --------------- 9. Naked .value() dispatch  (WorldObject.cs:237-341) ---------------
  // Ensures the typed-dispatch fallback still routes to the correct dict
  // when callers don't know the type up-front.
  console.log('\n[9] value() typed dispatch');
  {
    const wo = makeObj();
    wo.intValues.set(11, 42);
    wo.stringValues.set(12, 'hi');
    wo.boolValues.set(13, true);
    check('value() routes to intValues', () => assert.strictEqual(wo.value(11), 42));
    check('value() routes to stringValues', () => assert.strictEqual(wo.value(12), 'hi'));
    check('value() routes to boolValues', () => assert.strictEqual(wo.value(13), true));
    check('value() returns fallback when no dict has key', () => {
      assert.strictEqual(wo.value(999, 'fb'), 'fb');
    });
  }

  console.log(
    `\n========\n${passed} passed, ${failed} failed (total ${passed + failed} assertions)\n========`
  );

  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) {
      console.error(`  - ${f.name}`);
      console.error(`    ${f.err.stack || f.err.message}`);
    }
    process.exit(1);
  }
  process.exit(0);
})().catch((err) => {
  console.error('FATAL test harness error:', err);
  process.exit(2);
});
