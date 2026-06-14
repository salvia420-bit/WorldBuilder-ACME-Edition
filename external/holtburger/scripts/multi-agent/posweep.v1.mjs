import { chromium } from "playwright";
import { readFileSync, existsSync, mkdirSync, writeFileSync, readdirSync } from "fs";
// FINAL positional world-verify: per landblock, compare RENDERED vs the DAT/DB
// ground truth. Objects: DAT LandblockInfo positions vs placements.walk -> flags
// roof-placed (rendered Z >4m above expected) + misplaced + not-rendered.
// Interior: cellContainers3d vs DAT EnvCell count. Resumable + shardable.
const A=process.argv.slice(2), arg=(k,d)=>{const m=A.find(a=>a.startsWith(`--${k}=`));return m?m.split("=")[1]:d;};
const [si,sn]=arg("shard","0/1").split("/").map(Number);
const limit=parseInt(arg("limit","0"))||0, label=arg("label","posweep"), account=arg("account","smoketest1");
const EXP_DIR="/home/wbterminal/out/expected";
const CELLS=JSON.parse(readFileSync("/home/wbterminal/out/lb_expected.json","utf8"));
const STATE=`/home/wbterminal/out/sweep-state-${label}`; if(!existsSync(STATE)) mkdirSync(STATE,{recursive:true});
const done=new Set(readdirSync(STATE).filter(f=>f.endsWith(".json")).map(f=>f.replace(/\.json$/,"")));
const all=readFileSync("/home/wbterminal/out/sweep_queue.txt","utf8").split("\n").map(s=>s.trim()).filter(Boolean);
let queue=all.filter((_,i)=>i%sn===si).filter(base=>!done.has(((parseInt(base,16)>>>16)&0xffff).toString(16)));
if(limit) queue=queue.slice(0,limit);
const PRESET="renderer=3d&wireframe=1&quality=low&agentic=low&eagerDungeons=on&hud=none&plugins=none&diag=1&nosw=1&renderOnDemand=1&autoLogin=1&autoSpawn=first&kickDance=1&server_host=127.0.0.1&server_port=9000&bridge_url=ws://127.0.0.1:8080/";
const U=`http://127.0.0.1:8765/apps/holtburger-web/index.html?${PRESET}&account=${account}&password=${account}`;
const b=await chromium.launch({headless:true,args:["--use-gl=swiftshader","--enable-unsafe-swiftshader","--no-sandbox","--disable-dev-shm-usage"]});
process.on("SIGTERM",async()=>{try{await b.close()}catch{};process.exit(143)});
const p=await b.newPage(); await p.goto(U,{waitUntil:"domcontentloaded",timeout:60000});
let dl=Date.now()+150000;
while(Date.now()<dl){const s=await p.evaluate(()=>window.__bootState).catch(()=>null);
  if(["ready","in-world"].includes(s)&&(await p.evaluate(()=>(window.liveScene3d?.entitiesGroup?.children?.length||0)>0)))break;
  if(s==="error"||s==="ready"){await p.evaluate((nm)=>{try{window.__sessionHandle.createTestCharacter(nm);}catch(e){}},"P"+account.slice(-3)+Date.now().toString().slice(-5));
    await p.waitForTimeout(8000); await p.evaluate(()=>{try{window.__runAutonomousLogin({autoSpawn:"first",kickDance:0});}catch(e){}});} await p.waitForTimeout(2500);}
await p.evaluate(()=>{try{window.__sessionHandle.sendChat("@god");}catch(e){}}); await p.waitForTimeout(2000);
const readScene=(lbId)=>p.evaluate((lbId)=>{const L=window.liveScene3d||{};
  let walk=[]; try{const w=window.__diag?.placements?.walk?.(lbId); walk=Array.isArray(w)?w.map(o=>({m:o.modelId>>>0,p:o.position})):[];}catch(e){}
  let cells=0; const m=L.cellContainers3d; if(m instanceof Map){const hi=lbId>>>16; for(const cid of m.keys()) if(((cid>>>0)>>>16)===hi)cells++;}
  return {walk,cells};},lbId);
const R={OK:0,ROOF:0,MISPLACED:0,NOT_RENDERED:0,INT_DRIFT:0,MISS:0}; const flagged=[]; const t0=Date.now();
for(const base of queue){
  const lbId=parseInt(base,16)>>>0, lbX=(lbId>>>24)&0xff, lbY=(lbId>>>16)&0xff, lbHex=(lbId>>>16).toString(16);
  let exp=[]; try{exp=JSON.parse(readFileSync(`${EXP_DIR}/${lbHex.padStart(4,"0")}.json`,"utf8"));}catch(e){}
  const expCells=(CELLS[lbHex.padStart(4,"0")]||{}).cells||0;
  const cap=expCells>200?32000:(expCells>0?22000:15000);
  let arrived=false, scene={walk:[],cells:0};
  for(let att=1;att<=2&&!arrived;att++){
    await p.evaluate((c)=>{try{window.__sessionHandle.sendChat(`@teleloc ${c} 96.0 96.0 500.0`);}catch(e){}}, base);
    let prev=-9,stable=0; const deadline=Date.now()+cap;
    while(Date.now()<deadline){ await p.waitForTimeout(1700); await p.evaluate(()=>{try{window.__renderOnce?.();}catch(e){}});
      scene=await readScene(lbId); const tot=scene.walk.length+scene.cells; if(tot>0)arrived=true;
      if(tot===prev){stable++; if(stable>=2&&arrived)break;}else stable=0; prev=tot; }
  }
  if(!arrived){R.MISS++; writeFileSync(`${STATE}/${lbHex}.json`,JSON.stringify({lb:lbHex,verdict:"MISS"})); continue;}
  // OBJECT positional diff
  const rend=scene.walk; let matched=0,roof=[],moved=[],nr=0;
  for(const e of exp){ const [mid,ex,ey,ez]=e; const m=mid>>>0;
    const c=rend.filter(r=>r.m===m&&Array.isArray(r.p));
    if(!c.length){nr++; continue;}
    let best=null,bd=Infinity; for(const r of c){const dd=(r.p[0]-ex)**2+(r.p[1]-ey)**2; if(dd<bd){bd=dd;best=r;}}
    const xy=Math.sqrt(bd), dz=best.p[2]-ez, dist=Math.sqrt(bd+dz*dz);
    if(dist<=2) matched++;
    else { if(dz>4) roof.push(["0x"+m.toString(16),+ez.toFixed(1),+best.p[2].toFixed(1)]); else moved.push(["0x"+m.toString(16),+xy.toFixed(1),+dz.toFixed(1)]); }
  }
  const intDrift = expCells>0 && scene.cells < Math.ceil(expCells*0.9);
  // verdict priority
  let verdict="OK";
  if(roof.length) verdict="ROOF"; else if(moved.length) verdict="MISPLACED"; else if(intDrift) verdict="INT_DRIFT"; else if(nr>0 && nr===exp.length) verdict="NOT_RENDERED";
  R[verdict]++;
  const rec={lb:lbHex,verdict,expObj:exp.length,rendObj:rend.length,matched,roof:roof.length,misplaced:moved.length,notRendered:nr,cells:scene.cells,expCells,roofItems:roof.slice(0,8),movedItems:moved.slice(0,6)};
  if(verdict!=="OK") flagged.push(`${lbHex}:${verdict}(roof${roof.length} moved${moved.length} nr${nr} cells${scene.cells}/${expCells})`);
  writeFileSync(`${STATE}/${lbHex}.json`, JSON.stringify(rec));
}
const secs=Math.round((Date.now()-t0)/1000);
console.log(`POSWEEP ${arg("shard","0/1")} acct=${account}: ${queue.length} LBs ${secs}s (${(secs/Math.max(1,queue.length)).toFixed(1)}s/LB) | OK=${R.OK} ROOF=${R.ROOF} MISPLACED=${R.MISPLACED} INT_DRIFT=${R.INT_DRIFT} NOT_RENDERED=${R.NOT_RENDERED} MISS=${R.MISS}`);
if(flagged.length) console.log("FLAGGED:", flagged.slice(0,30).join("  "));
await b.close();
