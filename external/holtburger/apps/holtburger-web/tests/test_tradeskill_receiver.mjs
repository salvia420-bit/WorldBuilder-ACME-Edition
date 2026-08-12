// Guard for the 2026-08-12 tradeskill receiver bug (the THIRD "comment
// describes behaviour the code does not implement" instance of that day).
// `decideTradeskillCall`'s comment claimed a fallback chain covering both the
// facade form and the raw sessionHandle form; the check was facade-only, and
// the dispatch site hardcoded `client.player.useWithTarget`. A caller passing
// the wasm handle direct (it exposes `useWithTarget` at top level,
// pkg/holtburger_web.d.ts:6151) got a silent dead feature.
// Complements test_tradeskill.mjs (app root, tier5), whose [3] block pins the
// EXACT return shape of decideTradeskillCall — which is why the receiver is a
// separate exported helper rather than a new field on that object.
import { decideTradeskillCall, resolveUseWithTargetReceiver } from "../plugins/tradeskill.js";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass += 1; console.log(`  [OK] ${name}`); }
  else { fail += 1; console.log(`  [FAIL] ${name} ${extra}`); }
};
const fire = { kind: "fire", sourceGuid: 0x80001234, targetGuid: 0x80005678 };

// 1. facade form (api.js exposes player.useWithTarget)
let d = decideTradeskillCall(fire, { player: { useWithTarget() {} } });
ok("facade form resolves", d.called === "useWithTarget" && resolveUseWithTargetReceiver({ player: { useWithTarget() {} } }) === "facade", JSON.stringify(d));
ok("facade args are the two guids", d.args.length === 2 && d.args[0] === 0x80001234 && d.args[1] === 0x80005678);
ok("facade warns nothing", d.warn === null);

// 2. RAW sessionHandle form — this is the case that was broken
d = decideTradeskillCall(fire, { useWithTarget() {} });
ok("RAW handle form resolves (the bug)", d.called === "useWithTarget" && resolveUseWithTargetReceiver({ useWithTarget() {} }) === "raw", JSON.stringify(d));
ok("RAW form warns nothing", d.warn === null);

// 3. genuinely absent -> still warns, still no call
d = decideTradeskillCall(fire, { player: {} });
ok("absent export still warns", d.called === null && typeof d.warn === "string");
d = decideTradeskillCall(fire, null);
ok("null client still warns", d.called === null && typeof d.warn === "string");

// 4. non-fire actions are untouched
d = decideTradeskillCall({ kind: "hover" }, { player: { useWithTarget() {} } });
ok("non-fire action is a no-op", d.called === null && d.warn === null);

// 5. facade wins when BOTH are present (facade is the documented primary)
d = decideTradeskillCall(fire, { useWithTarget() {}, player: { useWithTarget() {} } });
ok("facade takes precedence over raw", resolveUseWithTargetReceiver({ useWithTarget() {}, player: { useWithTarget() {} } }) === "facade");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
