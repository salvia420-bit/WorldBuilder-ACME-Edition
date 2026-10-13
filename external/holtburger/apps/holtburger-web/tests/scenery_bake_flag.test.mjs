// ?sceneryBake=retail — the scenery A/B switch in scene3d/statics.js
// (sceneryBaseUrlFor). Exact opt-in: only "retail" selects the parallel
// retail bake; every other value (and no value) keeps the shipped dir.
import { sceneryBaseUrlFor } from "../scene3d/statics.js";

let pass = 0, fail = 0;
function check(name, got, want) {
  if (got === want) { pass++; }
  else { fail++; console.error(`FAIL ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
}

const SHIPPED = "../../dist/scenery/";
const RETAIL = "../../dist/scenery-retail/";
check("absent", sceneryBaseUrlFor(""), SHIPPED);
check("retail", sceneryBaseUrlFor("?sceneryBake=retail"), RETAIL);
check("retail among others", sceneryBaseUrlFor("?nosw=1&sceneryBake=retail&wireframe=1"), RETAIL);
check("on is not retail", sceneryBaseUrlFor("?sceneryBake=on"), SHIPPED);
check("case-sensitive", sceneryBaseUrlFor("?sceneryBake=Retail"), SHIPPED);
check("ace-compat", sceneryBaseUrlFor("?sceneryBake=ace-compat"), SHIPPED);
check("no location in node", sceneryBaseUrlFor(undefined), SHIPPED);

console.log(`scenery_bake_flag: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
