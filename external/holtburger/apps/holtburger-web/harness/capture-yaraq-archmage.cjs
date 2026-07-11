// Yaraq Archmage building A/B capture — local (SwiftShader) structural check.
//
// Goal: stand OUTSIDE the Archmage Inyamkaya bint Ruz building's open door in
// Yaraq (LB 0x7D64; NPC in env cell 0x7D64012E at local 87,91.9,15.2) and see
// whether the interior renders through the door — issue 1 — and whether terrain
// intrudes — issues 2/3/4. Captures with ?portalStencil OFF (default client)
// then ON (my fix), for A/B. SwiftShader judges STRUCTURE (does interior
// geometry show / is terrain covering it), not lighting fidelity (the 1070
// confirms the "darker inside" look).
//
// Run from apps/holtburger-web/:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_yaraq_archmage.cjs
const path = require("node:path");
const fs = require("node:fs");
const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";
let chromium;
try { ({ chromium } = require("playwright")); }
catch (_) { ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright"))); }

const ACCT = process.env.WB_ACCT || "tailnet1"; // account=password test convention; override via WB_ACCT
const OUT = "/mnt/wbterminal1/holtburger-captures";
const LB = 0x7d64;                 // Yaraq Archmage building landblock
const ENV_CELL = 0x7d64012e >>> 0; // Inyamkaya's env cell
const NPC_LOCAL = { x: 86.98, y: 91.88, z: 15.2 };
const LBX = ((LB >>> 8) & 0xff) * 192, LBY = (LB & 0xff) * 192; // world origin of the LB

function urlFor(portalStencil) {
  const q = new URLSearchParams({
    renderer: "3d", quality: "low", agentic: "low", hud: "none", plugins: "none",
    diag: "1", nosw: "1", renderOnDemand: "1", netDrainHz: "30",
    autoLogin: "1", autoSpawn: "first",
    server_host: "127.0.0.1", server_port: "9000", bridge_url: "ws://127.0.0.1:8080/",
    account: ACCT, password: ACCT,
  });
  if (portalStencil) q.set("portalStencil", "on");
  return "http://127.0.0.1:8765/apps/holtburger-web/index.html?" + q.toString();
}

const sleep = (p, ms) => p.waitForTimeout(ms);
async function chat(p, line) { await p.evaluate((l) => window.__sessionHandle?.sendChat?.(l), line).catch(() => {}); }
async function renderN(p, n) { for (let i = 0; i < n; i++) { await p.evaluate(() => { try { window.__renderOnce?.(); } catch (_) {} }); await sleep(p, 120); } }

// Wait for the env-cell bake to settle for LB (mirrors capture_academy_envcells).
async function waitBake(p, lbHigh, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = -1, stableSince = 0;
  while (Date.now() < deadline) {
    const n = await p.evaluate((hi) => {
      const ls = window.liveScene3d;
      if (!(ls?.cellContainers3d instanceof Map)) return 0;
      let c = 0; for (const cid of ls.cellContainers3d.keys()) if (((cid >>> 16) & 0xffff) === hi) c++;
      return c;
    }, lbHigh);
    if (n !== last) { last = n; stableSince = Date.now(); }
    else if (n > 0 && Date.now() - stableSince >= 2500) return n;
    await renderN(p, 1);
    await sleep(p, 400);
  }
  return last;
}

async function capture(portalStencil, outsideTeleloc) {
  const tag = portalStencil ? "on" : "off";
  const browser = await chromium.launch({
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-dev-shm-usage"],
  });
  const errs = [];
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const p = await ctx.newPage();
    p.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
    p.on("pageerror", (e) => errs.push("PAGEERR " + String(e).slice(0, 160)));
    await p.goto(urlFor(portalStencil), { waitUntil: "domcontentloaded", timeout: 45000 });
    const dl = Date.now() + 130000;
    while (Date.now() < dl) { const s = await p.evaluate(() => window.__bootState).catch(() => null); if (s === "in-world" || s === "ready") break; await sleep(p, 400); }
    await sleep(p, 5000);
    await chat(p, "@god"); await sleep(p, 1200);

    // Step INTO the env cell so the building + door apertures load.
    await chat(p, `@teleloc 0x${ENV_CELL.toString(16)} ${NPC_LOCAL.x} ${NPC_LOCAL.y} ${NPC_LOCAL.z}`);
    await sleep(p, 4000);
    const nIn = await waitBake(p, (ENV_CELL >>> 16) & 0xffff, 90000);
    await renderN(p, 4);
    const insideShot = path.join(OUT, `yaraq-archmage-inside-${tag}.png`);
    await (await p.$("#scene, canvas") || p).screenshot({ path: insideShot, type: "png" }).catch(() => p.screenshot({ path: insideShot }));

    // Compute an OUTSIDE-the-door teleloc from the door aperture (once; reuse for run 2).
    let outside = outsideTeleloc;
    if (!outside) {
      outside = await p.evaluate(({ lbx, lby }) => {
        const sh = window.__sessionHandle;
        const mvpCam = () => {
          const ls = window.liveScene3d, cam = ls.cameraSwitcher?.activeCamera ?? ls.camera, wr = ls.worldRoot;
          const M4 = cam.projectionMatrix.constructor, m = new M4();
          m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse); m.multiply(wr.matrixWorld);
          return new Float32Array(m.elements);
        };
        let arr; try { arr = sh.getVisiblePortalApertures(mvpCam(), 0); } catch { return null; }
        // parse; pick the aperture with the largest area as "the big open door".
        let k = 0; const count = arr[k++] | 0; let best = null, bestArea = -1;
        for (let a = 0; a < count; a++) {
          const nv = arr[k++] | 0; const vs = [];
          for (let v = 0; v < nv; v++) vs.push([arr[k++], arr[k++], arr[k++]]);
          if (nv < 3) continue;
          // area proxy + center + normal
          const c = [0, 0, 0]; for (const q of vs) { c[0] += q[0]; c[1] += q[1]; c[2] += q[2]; }
          c[0] /= nv; c[1] /= nv; c[2] /= nv;
          const e1 = [vs[1][0] - vs[0][0], vs[1][1] - vs[0][1], vs[1][2] - vs[0][2]];
          const e2 = [vs[2][0] - vs[0][0], vs[2][1] - vs[0][1], vs[2][2] - vs[0][2]];
          const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
          const area = Math.hypot(nrm[0], nrm[1], nrm[2]);
          // Prefer a VERTICAL door (horizontal normal), not a floor/ceiling
          // portal (vertical normal). horiz≈1 → wall/door; ≈0 → floor.
          const horiz = Math.hypot(nrm[0], nrm[1]) / (area || 1);
          if (horiz < 0.6) continue; // skip near-horizontal portals
          const score = area * horiz;
          if (score > bestArea) { bestArea = score; best = { c, nrm }; }
        }
        if (!best) return null;
        // horizontal outward normal
        let hx = best.nrm[0], hy = best.nrm[1]; const hl = Math.hypot(hx, hy) || 1; hx /= hl; hy /= hl;
        return { cx: best.c[0], cy: best.c[1], cz: best.c[2], hx, hy };
      }, { lbx: LBX, lby: LBY });
    }

    let outsideShot = path.join(OUT, `yaraq-archmage-outside-${tag}.png`);
    if (outside) {
      // Try +normal then -normal; pick the side that is OUTDOOR. Face the door.
      const D = 7;
      for (const sgn of [1, -1]) {
        const wx = outside.cx + sgn * outside.hx * D;
        const wy = outside.cy + sgn * outside.hy * D;
        const lx = wx - LBX, ly = wy - LBY;
        const cellX = Math.max(0, Math.min(7, Math.floor(lx / 24)));
        const cellY = Math.max(0, Math.min(7, Math.floor(ly / 24)));
        const outCell = (LB << 16 | (cellX * 8 + cellY + 1)) >>> 0;
        // heading toward the door (yaw about Z): dir = (cx-wx, cy-wy)
        const th = Math.atan2(outside.cy - wy, outside.cx - wx);
        const qw = Math.cos(th / 2), qz = Math.sin(th / 2);
        await chat(p, `@teleloc 0x${outCell.toString(16)} ${lx.toFixed(2)} ${ly.toFixed(2)} ${(outside.cz + 1).toFixed(2)} ${qw.toFixed(4)} 0 0 ${qz.toFixed(4)}`);
        await sleep(p, 3500);
        const indoor = await p.evaluate(() => !!window.__sessionHandle?.isCurrentCellIndoor?.());
        if (!indoor) break; // found the outdoor side
      }
      await waitBake(p, LB & 0xffff, 30000);
      await renderN(p, 6);
      await (await p.$("#scene, canvas") || p).screenshot({ path: outsideShot, type: "png" }).catch(() => p.screenshot({ path: outsideShot }));
    } else {
      outsideShot = null;
    }

    const cur = await p.evaluate(() => (window.__sessionHandle?.getCurrentCellId?.() >>> 0)?.toString(16));
    const pass = await p.evaluate(() => { const ps = window.liveScene3d?._portalStencilPass; return ps ? { ap: ps._apertureCount, cells: ps._cells?.length, work: ps.hasWork } : null; });
    console.log(JSON.stringify({ tag, insideBakeCells: nIn, currentCell: cur, pass, insideShot, outsideShot, outside, errs: errs.length }, null, 2));
    return outside;
  } finally { await browser.close().catch(() => {}); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const only = process.env.CAP_ONLY; // 'on' | 'off' | undefined (both)
  let outside = null;
  if (only !== "on") {
    console.log("=== capture OFF (default client — issue 1) ===");
    outside = await capture(false, null);
  }
  if (only !== "off") {
    if (only !== "on") {
      // ACE single-login needs the OFF session to release (~25s) before ON.
      console.log("waiting 60s for ACE to release the account...");
      await new Promise((r) => setTimeout(r, 60000));
    }
    console.log("=== capture ON (?portalStencil — issues 2/3/4) ===");
    await capture(true, outside);
  }
  console.log("done. shots in " + OUT);
  process.exit(0);
})().catch((e) => { console.error("capture threw:", e?.message ?? e); process.exit(1); });
