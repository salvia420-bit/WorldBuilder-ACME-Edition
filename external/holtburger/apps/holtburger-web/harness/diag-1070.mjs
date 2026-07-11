// quick login diagnostic: goto all-flags URL on the 1070 FF, poll bootState,
// dump console tail to see why autoLogin doesn't reach in-world.
const DRIVER = "http://127.0.0.1:9224";
const FLAGS = [
  "renderer=3d","autoLogin=1","account=tailnet1","password=tailnet1","autoSpawn=first",
  "server_host=127.0.0.1","server_port=9000","bridge_url=ws://100.116.47.66:8080/",
  "renderDiag=on","unifiedTick=on","surfaceUnified=on",
];
const URL = "http://127.0.0.1:18765/apps/holtburger-web/index.html?" + FLAGS.join("&");
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function ff(fn){ const b=Buffer.from(fn).toString("base64"); const r=await fetch(`${DRIVER}/eval?fn=${encodeURIComponent(b)}`,{signal:AbortSignal.timeout(12000)}); return (await r.json()).result; }
async function consoleTail(){ try{ const r=await fetch(`${DRIVER}/console`,{signal:AbortSignal.timeout(12000)}); return await r.text(); }catch(e){ return "console-err:"+e.message; } }

(async () => {
  console.log("goto…", (await (await fetch(`${DRIVER}/goto?`+new URLSearchParams({url:URL}),{signal:AbortSignal.timeout(45000)})).json()).ok);
  for (let t=0; t<=45; t+=5){
    await sleep(5000);
    const s = await ff(`()=>{const h=window.__sessionHandle;let pose=null;try{pose=h&&h.getLocalPlayerPose?!!h.getLocalPlayerPose():false}catch(e){}return {boot:window.__bootState||'none',hist:(window.__bootStateHistory||[]).map(e=>e&&e.state).slice(-6),pose}}`).catch(e=>({err:String(e.message)}));
    console.log(`t=${t+5}s`, JSON.stringify(s));
    if (s && s.boot === "in-world") { console.log("REACHED IN-WORLD"); break; }
  }
  const c = await consoleTail();
  console.log("\n=== console tail (last 2500 chars) ===\n" + c.slice(-2500));
})();
