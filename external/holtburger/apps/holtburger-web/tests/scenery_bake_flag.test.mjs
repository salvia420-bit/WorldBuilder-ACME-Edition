// ?sceneryBake — the scenery bake switch in scene3d/statics.js
// (sceneryBaseUrlFor). DEFAULT RETAIL since 2026-10-17 (owner): absent, "retail"
// and any unrecognised value serve the retail bake (the placement live ACE uses);
// only the escapes ace-compat / off / 0 / false / no (case-insensitive) keep the
// old shipped ace-compat dir.
import { sceneryBaseUrlFor } from "../scene3d/statics.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

const ACE_COMPAT = "../../dist/scenery/";
const RETAIL = "../../dist/scenery-retail/";
check("absent", sceneryBaseUrlFor(""), RETAIL);
check("retail", sceneryBaseUrlFor("?sceneryBake=retail"), RETAIL);
check("retail among others", sceneryBaseUrlFor("?nosw=1&sceneryBake=retail&wireframe=1"), RETAIL);
check("on", sceneryBaseUrlFor("?sceneryBake=on"), RETAIL);
check("garbage", sceneryBaseUrlFor("?sceneryBake=banana"), RETAIL);
check("empty value", sceneryBaseUrlFor("?sceneryBake="), RETAIL);
check("ace-compat", sceneryBaseUrlFor("?sceneryBake=ace-compat"), ACE_COMPAT);
check("ace-compat among others", sceneryBaseUrlFor("?nosw=1&sceneryBake=ace-compat&wireframe=1"), ACE_COMPAT);
check("off", sceneryBaseUrlFor("?sceneryBake=off"), ACE_COMPAT);
check("OFF case-insensitive", sceneryBaseUrlFor("?sceneryBake=OFF"), ACE_COMPAT);
check("0", sceneryBaseUrlFor("?sceneryBake=0"), ACE_COMPAT);
check("false", sceneryBaseUrlFor("?sceneryBake=false"), ACE_COMPAT);
check("no", sceneryBaseUrlFor("?sceneryBake=no"), ACE_COMPAT);
check("no location in node", sceneryBaseUrlFor(undefined), RETAIL);

console.log(`scenery_bake_flag: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
