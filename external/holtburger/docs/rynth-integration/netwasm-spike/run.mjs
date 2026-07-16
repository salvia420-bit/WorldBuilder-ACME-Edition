import { dotnet } from "./_framework/dotnet.js";
const { getAssemblyExports, getConfig } = await dotnet.create();
const exports = await getAssemblyExports(getConfig().mainAssemblyName);
const B = exports.BrainSlice;
const out = { v: B.Version(), s1: B.ScoreTarget(5,1,100), s2: B.ScoreTarget(5,10,40), settle: B.ShouldSettleBeforeCast(20,15) };
console.log(JSON.stringify(out));
const ok = out.v==="brain-slice-netwasm-1" && out.s1===95 && out.s2===143 && out.settle===true;
console.log(ok ? "NETWASM EXEC: PASS" : "NETWASM EXEC: FAIL");
process.exit(ok?0:1);
