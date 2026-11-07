#!/usr/bin/env node
/**
 * shoot-20min-film.mjs
 *
 * Records a full 20-minute (4 x 305s = 1,220s = 20m 20s) 1920x1080 30fps H.264 film
 * of the redesigned 257-part F6F-6N Super-Hellcat Heavy Fighter-Bomber on the GTX-1070
 * in off-screen muted Mode T using film-mode's WebCodecs recorder (recorder.js) +
 * sequential grid sampler (__setFrameCap(30)).
 *
 * Chapters:
 *   Chapter 1 (305s): Pre-flight walk-around, boarding hop into the cockpit, cockpit
 *                     instrument & gunsight inspection, takeoff & gear retraction,
 *                     and flying around Dereth (Holtburg -> River Valley -> Dense
 *                     Aluvian Forests -> Cragstone -> Central Mountains -> Zaikhal).
 *   Chapter 2 (305s): Flying around the Direlands (Fort Tethana -> Direlands Canyons
 *                     & Badlands -> Obsidian Plains -> Wai Jhou strike pass ->
 *                     Western Direlands ash wastes -> Ayan Baqur).
 *   Chapter 3 (305s): Flying high into the sky and straight through the volumetric
 *                     cumulus cloud deck (1,050-1,950 m AGL) up to the 5,000 m AGL
 *                     ceiling above the clouds (85 km continent horizon), 360-degree
 *                     orbit above the cloud sea, and high-speed dive back down
 *                     through the clouds toward Al-Arqas.
 *   Chapter 4 (305s): Flying back to Al-Arqas, firing all 6 Gearknight autocannons
 *                     and 6 HVAR lightning rockets at the town, dropping the 2,000 lb
 *                     Blockbuster & twin 1,000 lb Demolition Bombs on the town and
 *                     near-town objects, landing beside the town to rearm (6.5s),
 *                     executing a second full bombing/rocket pass, and finally
 *                     bailing out and parachuting while the derelict Super-Hellcat
 *                     glides down ahead and crashes nearby in a massive multi-stage
 *                     fireball and towering column of black smoke.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const APP_URL = process.env.APP_URL || "http://127.0.0.1:8765/apps/holtburger-web/index.html";
const ACCOUNT = process.env.ACCOUNT || "agentp10";
const PASSWORD = process.env.PASSWORD || "agentp10";
const OUT_DIR = "/mnt/wbterminal2/film-projects/super-hellcat-20min";
const BITRATE = Number(process.env.BITRATE || 2_400_000); // ~91.5 MB per 305s chapter (~366 MB total)
const CHAPTER_SEC = Number(process.env.CHAPTER_SEC || 305);

const WORLD_DIR = "/home/wbterminal/hb-serve/dist/current/world/";
const WH = fs.readFileSync(WORLD_DIR + "world_height.u8");
const WTAB = JSON.parse(fs.readFileSync(WORLD_DIR + "world_meta.json", "utf8")).landHeightTable;
function groundAtWorld(x, y) {
  const fx = x / 24, fy = y / 24, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
  const H = (a, b) => WTAB[WH[b * 2041 + a]];
  return H(i, j) * (1 - u) * (1 - v) + H(i + 1, j) * u * (1 - v) + H(i, j + 1) * (1 - u) * v + H(i + 1, j + 1) * u * v;
}
function teleloc(x, y, headingDeg = 0) {
  const z = groundAtWorld(x, y) + 0.25;
  const lbx = Math.floor(x / 192), lby = Math.floor(y / 192);
  const lx = x - lbx * 192, ly = y - lby * 192;
  const cell = ((lbx << 24) | (lby << 16) | (Math.floor(lx / 24) * 8 + Math.floor(ly / 24) + 1)) >>> 0;
  const hr = (headingDeg ?? 0) * Math.PI / 180;
  return `@teleloc 0x${cell.toString(16).padStart(8, "0")} ${lx.toFixed(2)} ${ly.toFixed(2)} ${z.toFixed(2)} ${Math.cos(hr / 2).toFixed(6)} 0 0 ${(-Math.sin(hr / 2)).toFixed(6)}`;
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);

function ssh1070(cmd, timeout = 30000) {
  return execFileSync(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "young@100.127.215.75", cmd],
    { encoding: "utf8", timeout }
  ).trim();
}

function checkGateAndLaunchChrome() {
  log("Cleaning up any previous bench Chrome (hbbench-kill.ps1) & launching via hbprobe (which enforces hbgate.ps1)...");
  try {
    ssh1070("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1");
  } catch (_) {}
  ssh1070("echo fxkeep-film> D:\\Temp\\hbbench\\profile.txt");
  ssh1070("echo 1920,1200> D:\\Temp\\hbbench\\winsize.txt");
  ssh1070("echo --remote-allow-origins=* --force-device-scale-factor=1 --high-dpi-support=1> D:\\Temp\\hbbench\\extraflags.txt");
  for (const f of ["angle.txt", "disablefeatures.txt", "uncapped.txt"]) {
    try {
      ssh1070(`if exist D:\\Temp\\hbbench\\${f} del /q D:\\Temp\\hbbench\\${f}`);
    } catch (_) {}
  }
  ssh1070(
    'schtasks /create /tn hbprobe /tr "wscript.exe //B //Nologo D:\\Temp\\hbbench\\hidden-run.vbs D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul'
  );
}

async function openCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`);
      if (r.ok) {
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
        const ctx = browser.contexts()[0];
        const page = ctx.pages().find((p) => p.url() === "about:blank") || ctx.pages()[0];
        const session = await ctx.newCDPSession(page);
        const send = (method, params = {}) => session.send(method, params);
        const evaluate = async (expression, awaitPromise = true) => {
          const res = await session.send("Runtime.evaluate", {
            expression,
            returnByValue: true,
            awaitPromise,
          });
          if (res?.exceptionDetails) {
            throw new Error(
              `Eval exception: ${
                res.exceptionDetails.text || res.exceptionDetails.exception?.description || "unknown"
              }`
            );
          }
          return res?.result?.value;
        };
        return { browser, page, session, send, evaluate, close: () => browser.close() };
      }
    } catch (_) {}
    await sleep(500);
  }
  throw new Error("Could not connect to CDP on port " + CDP_PORT);
}

/**
 * Installs the in-page `window.__filmDirector` + recorder helpers.
 * Everything inside `addPreFrame` runs at exact 30.0 fps frame-lock inside the browser
 * with zero CDP round-trips during camera orbits or autopilot steering!
 */
const PAGE_DIRECTOR_INIT = `
(async () => {
  const names = performance.getEntriesByType("resource").map((e) => e.name);
  const url = (p) => names.find((n) => n.includes(p)) || new URL(p.replace(/^\\//, ""), location.href).href;
  const { createRecorder } = await import(url("/scene3d/film/runtime/recorder.js"));
  const { ensureFilmHooks } = await import(url("/scene3d/film/runtime/camera_owner.js"));

  const V = window.__vehicles;
  const hooks = ensureFilmHooks(window.liveScene3d);

  // Hide text OSD & prompt, keep reticle/pipper controllable
  let st = document.getElementById("hb-film-20m-style");
  if (!st) {
    st = document.createElement("style");
    st.id = "hb-film-20m-style";
    document.head.appendChild(st);
  }
  st.textContent = \`
    #hb-vehicle-osd, #hb-vehicle-prompt { display: none !important; }
    #hb-vehicle-reticle, #hb-vehicle-pipper { opacity: 0; transition: opacity 0.25s ease; }
    body.show-reticle #hb-vehicle-reticle { opacity: 0.92 !important; }
    body.show-pipper #hb-vehicle-pipper { opacity: 0.95 !important; }
  \`;

  function wrapPi(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }
  function clamp(v, lo, hi) {
    return v < lo ? lo : (v > hi ? hi : v);
  }
  function groundAt(x, y) {
    try {
      const h = window.__sessionHandle ?? window.liveScene3d?.sessionHandle;
      const g = h?.terrainHeightAt?.(x, y);
      return Number.isFinite(g) ? g : 80;
    } catch (_) {
      return 80;
    }
  }
  window.__groundAt = groundAt;

  const dir = {
    worldOrbit: null,
    camTweak: null,
    autopilot: null,
    crashWatch: null,
    wantBoarded: false,
    lastBoardTry: 0,
    lastBombAt: 0,
    bombsDroppedThisPass: 0,
    crashPos: null,
    crashDetectedAt: 0,
    secondaryBurstsDone: 0,

    boardNow() {
      this.wantBoarded = true;
      this.lastBoardTry = performance.now() * 0.001;
      try { V.board(); } catch (_) {}
    },

    bailOut() {
      this.wantBoarded = false;
      this.setAutopilot(null);
      try { V.exit(1); } catch (_) {}
    },

    setHUD({ reticle = false, pipper = false } = {}) {
      document.body.classList.toggle("show-reticle", !!reticle);
      document.body.classList.toggle("show-pipper", !!pipper);
    },

    /**
     * Smooth 30fps world/player/vehicle camera orbit using window.__cam.orbit.
     * Pass null to release back to follow/vehicle camera.
     */
    setWorldOrbit(cfg) {
      if (!cfg) {
        this.worldOrbit = null;
        try { window.__cam?.release(); } catch (_) {}
        return;
      }
      this.worldOrbit = {
        ...cfg,
        t0: performance.now() * 0.001,
      };
    },

    /**
     * Smooth 30fps chase/fall camera tweak with optional continuous yaw orbit (yawRate rad/s)
     * and smooth exponential blending between camera angles.
     */
    setCamTweak(cfg) {
      if (!cfg) {
        this.camTweak = null;
        V.setCameraTweak(null);
        return;
      }
      const now = performance.now() * 0.001;
      const prev = this.camTweak?.cur || { yaw: 0, back: 14, up: 3.2, pitch: undefined, roll: 0, fov: 60 };
      this.camTweak = {
        target: {
          yaw: cfg.yaw ?? 0,
          yawRate: cfg.yawRate ?? 0,
          back: cfg.back ?? 14,
          up: cfg.up ?? 3.2,
          pitch: cfg.pitch,
          roll: cfg.roll ?? 0,
          fov: cfg.fov ?? 60,
        },
        cur: cfg.cut ? {
          yaw: cfg.yaw ?? 0,
          back: cfg.back ?? 14,
          up: cfg.up ?? 3.2,
          pitch: cfg.pitch,
          roll: cfg.roll ?? 0,
          fov: cfg.fov ?? 60,
        } : { ...prev },
        tau: cfg.tau ?? 0.45,
        t0: now,
        lastT: now,
      };
    },

    /**
     * Closed-loop waypoint/altitude/attitude autopilot running inside addPreFrame.
     * Supports:
     *   - tx, ty: target world coordinates (or fixed heading if tx/ty omitted)
     *   - heading: target compass heading in radians (if tx/ty omitted)
     *   - agl: target altitude above ground (m)
     *   - z: target absolute Z (m)
     *   - pitchOverride: fixed pitch stick [-1, 1]
     *   - rollOverride: fixed roll stick [-1, 1]
     *   - throttle: [0, 1]
     *   - boost, fire, missile, bomb, land: booleans
     *   - autoBombDist: [d1, d2, d3] distances from (tx, ty) at which to pulse bomb button
     *   - strafePitchAim: aims nose directly at ground target (tx, ty, gz) when within [minD, maxD]
     */
    setAutopilot(cfg) {
      if (!cfg) {
        this.autopilot = null;
        V.clearSticks();
        return;
      }
      this.autopilot = {
        ...cfg,
        firedBombs: new Set(),
      };
    },

    /**
     * Watches the derelict vehicle after bailout and triggers multi-stage secondary
     * explosions at the crash site so the crash is unmissable and dramatic.
     */
    startCrashWatch(targetTownPos) {
      this.crashWatch = {
        startedAt: performance.now() * 0.001,
        targetTownPos,
        crashed: false,
        crashPos: null,
        crashAt: 0,
        burstIdx: 0,
        lastKnownPos: null,
      };
    },

    stopCrashWatch() {
      this.crashWatch = null;
    },

    tick(tsMs, dt) {
      const now = performance.now() * 0.001;
      const safeDt = clamp(dt || 1 / 30, 0.001, 0.1);

      // 0. Auto-retry boarding if requested until V.piloting === true
      if (this.wantBoarded && !V.piloting && !V.falling) {
        if (now - this.lastBoardTry > 0.45) {
          this.lastBoardTry = now;
          try { V.board(); } catch (_) {}
        }
      }

      // 1. World Orbit (pre-boarding walk-around or post-touchdown survivor orbit)
      if (this.worldOrbit && window.__cam) {
        const wo = this.worldOrbit;
        const elap = now - wo.t0;
        const u = wo.dur ? clamp(elap / wo.dur, 0, 1) : 0;
        let tx = wo.tx ?? 0, ty = wo.ty ?? 0, tz = wo.tz ?? 0;
        if (wo.target === "vehicle") {
          const v0 = V.status().vehicles[0]?.pos;
          if (v0) { tx = v0.x; ty = v0.y; tz = v0.z; }
          else { const pw = window.__cam.world(); tx = pw.x; ty = pw.y; tz = pw.z; }
        } else if (wo.target === "player") {
          const pw = window.__cam.world();
          tx = pw.x; ty = pw.y; tz = pw.z;
        }
        tz += wo.dz ?? 1.6;
        const dist = wo.dist1 !== undefined ? wo.dist0 + (wo.dist1 - wo.dist0) * u : (wo.dist0 ?? 11);
        const el = wo.el1 !== undefined ? wo.el0 + (wo.el1 - wo.el0) * u : (wo.el0 ?? 14);
        const az = (wo.az0 ?? 0) + elap * (wo.azRate ?? 28);
        if (wo.fov) window.__cam.fov(wo.fov);
        window.__cam.orbit(tx, ty, tz, dist, az, el);
      }

      // 2. Smooth Chase / Fall Camera Tweak
      if (this.camTweak) {
        const ct = this.camTweak;
        const elap = now - ct.t0;
        const stepDt = clamp(now - ct.lastT, 0.001, 0.1);
        ct.lastT = now;
        const k = ct.tau <= 0.001 ? 1 : (1 - Math.exp(-stepDt / ct.tau));
        const tgtYaw = ct.target.yaw + elap * ct.target.yawRate;
        ct.cur.yaw = ct.cur.yaw + wrapPi(tgtYaw - ct.cur.yaw) * k;
        ct.cur.back += (ct.target.back - ct.cur.back) * k;
        ct.cur.up += (ct.target.up - ct.cur.up) * k;
        ct.cur.roll += (ct.target.roll - ct.cur.roll) * k;
        ct.cur.fov += (ct.target.fov - ct.cur.fov) * k;
        if (ct.target.pitch !== undefined) {
          ct.cur.pitch = (ct.cur.pitch ?? ct.target.pitch) + (ct.target.pitch - (ct.cur.pitch ?? ct.target.pitch)) * k;
        } else {
          ct.cur.pitch = undefined;
        }
        V.setCameraTweak({
          yaw: ct.cur.yaw,
          back: ct.cur.back,
          up: ct.cur.up,
          pitch: ct.cur.pitch,
          roll: ct.cur.roll,
          fov: ct.cur.fov,
        });
      }

      // 3. Closed-loop Autopilot
      if (this.autopilot && V.piloting) {
        const ap = this.autopilot;
        const st = V.status().pilot?.state;
        if (st) {
          let roll = 0, yaw = 0, pitch = 0;
          const gz = groundAt(st.x, st.y);
          const curAgl = st.z - gz;

          // Lateral steering
          let distToTarget = Infinity;
          if (ap.rollOverride !== undefined) {
            roll = ap.rollOverride;
            yaw = ap.yawOverride ?? 0;
          } else {
            let desiredH = st.heading;
            if (Number.isFinite(ap.tx) && Number.isFinite(ap.ty)) {
              const dx = ap.tx - st.x, dy = ap.ty - st.y;
              distToTarget = Math.hypot(dx, dy);
              if (distToTarget > 8) {
                desiredH = Math.atan2(dx, dy);
              } else if (Number.isFinite(ap.heading)) {
                desiredH = ap.heading;
              }
            } else if (Number.isFinite(ap.heading)) {
              desiredH = ap.heading;
            }
            const dh = wrapPi(desiredH - st.heading);
            const maxBank = (ap.maxBank ?? 0.68);
            const desiredBank = clamp(dh * 1.65, -maxBank, maxBank);
            roll = clamp((desiredBank - st.bank) * 2.4, -(ap.maxRoll ?? 0.9), (ap.maxRoll ?? 0.9));
            yaw = clamp(dh * 0.85, -1, 1);
          }

          // Vertical steering
          if (ap.pitchOverride !== undefined) {
            pitch = ap.pitchOverride;
          } else if (ap.strafeAim && distToTarget > 95 && distToTarget < 750) {
            // Aim nose directly toward ground target for gun/rocket strafing, pulling up below 34m AGL
            if (curAgl < 34) {
              pitch = 0.65;
            } else {
              const tgz = groundAt(ap.tx, ap.ty) + (ap.strafeZOffset ?? 4);
              const desiredPitch = clamp(Math.atan2(tgz - st.z, distToTarget), -0.36, 0.35);
              pitch = clamp(desiredPitch / 0.436, -0.85, 0.85);
            }
          } else {
            const targetZ = Number.isFinite(ap.z) ? ap.z : (gz + (ap.agl ?? 70));
            const dz = targetZ - st.z;
            const desiredPitch = clamp(dz * 0.014, -(ap.maxDownPitch ?? 0.38), (ap.maxUpPitch ?? 0.42));
            pitch = clamp(desiredPitch / 0.436, -1, 1);
          }

          // Automatic bomb release at specified distances to (tx, ty)
          let bombPulse = !!ap.bomb;
          if (Array.isArray(ap.autoBombDists) && Number.isFinite(distToTarget)) {
            for (let i = 0; i < ap.autoBombDists.length; i++) {
              if (!ap.firedBombs.has(i) && distToTarget <= ap.autoBombDists[i]) {
                if (now - this.lastBombAt > 0.32) {
                  ap.firedBombs.add(i);
                  this.lastBombAt = now;
                  bombPulse = true;
                  break;
                }
              }
            }
            // Release bomb button for 100ms between pulses so server sees rising edge
            if (!bombPulse && (now - this.lastBombAt < 0.12)) {
              bombPulse = true;
            }
          }

          V.setSticks({
            throttle: ap.throttle ?? 0.85,
            pitch,
            roll,
            yaw,
            boost: !!ap.boost,
            fire: !!ap.fire,
            missile: !!ap.missile,
            bomb: bombPulse,
            land: !!ap.land,
          }, 250);
        }
      }

      // 4. Crash Watch (tracks derelict plane after bailout and triggers multi-stage crash explosions)
      if (this.crashWatch) {
        const cw = this.crashWatch;
        const v0 = V.status().vehicles[0];
        if (v0?.pos) {
          cw.lastKnownPos = { ...v0.pos, mode: v0.mode };
        }
        const evs = V.events();
        const crashEv = evs.find((e) => e.kind === 3 || e.name === "crashed");
        if (!cw.crashed && (crashEv || (v0 && v0.mode === 4))) {
          cw.crashed = true;
          cw.crashAt = now;
          const cp = crashEv?.pos || (v0?.pos ? [v0.pos.x, v0.pos.y, v0.pos.z] : null) ||
                     (cw.lastKnownPos ? [cw.lastKnownPos.x, cw.lastKnownPos.y, cw.lastKnownPos.z] : null);
          cw.crashPos = cp;
        }
        // Fallback if server sight radius culled vehicle right before impact
        if (!cw.crashed && now - cw.startedAt > 15.8 && cw.lastKnownPos) {
          cw.crashed = true;
          cw.crashAt = now;
          const gx = cw.lastKnownPos.x, gy = cw.lastKnownPos.y;
          cw.crashPos = [gx, gy, groundAt(gx, gy)];
        }
        if (cw.crashed && cw.crashPos) {
          const since = now - cw.crashAt;
          const schedule = [
            { t: 0.05, off: [0, 0, 0], lb: 2000 },
            { t: 0.55, off: [6, -4, 1], lb: 2000 },
            { t: 1.30, off: [-5, 5, 0], lb: 1500 },
            { t: 2.40, off: [3, 3, 1], lb: 2000 },
            { t: 4.00, off: [-4, -3, 0], lb: 1500 },
            { t: 6.50, off: [0, 0, 0], lb: 2000 },
            { t: 10.0, off: [2, -2, 0], lb: 1500 },
            { t: 14.5, off: [-2, 2, 0], lb: 1500 },
            { t: 20.0, off: [0, 0, 0], lb: 2000 },
            { t: 27.0, off: [3, 0, 0], lb: 1500 },
            { t: 35.0, off: [0, 0, 0], lb: 1500 },
          ];
          while (cw.burstIdx < schedule.length && since >= schedule[cw.burstIdx].t) {
            const b = schedule[cw.burstIdx++];
            V.debugExplode([
              cw.crashPos[0] + b.off[0],
              cw.crashPos[1] + b.off[1],
              cw.crashPos[2] + b.off[2],
            ], b.lb);
          }
        }
      }
    }
  };

  if (window.__filmDirectorUnsub) {
    try { window.__filmDirectorUnsub(); } catch (_) {}
  }
  window.__filmDirectorUnsub = hooks.addPreFrame((tsMs, dt) => dir.tick(tsMs, dt));
  window.__filmDirector = dir;

  // Recorder wrapper (one recorder per chapter, sequential 30fps grid sampler, drained cleanly after stop())
  window.__chapterRec = {
    rec: null,
    unsub: null,
    t0: null,
    lastK: -1,
    frames: 0,
    held: 0,
    async start(bitrate) {
      const fps = 30;
      const canvas = window.liveScene3d?.renderer?.domElement || document.querySelector("canvas");
      const rec = createRecorder({
        canvas,
        fps,
        bitrate,
        keyIntervalSec: 1,
        maxBufferedBytes: 512 * 1024 * 1024,
      });
      await rec.start();
      this.t0 = null;
      this.lastK = -1;
      this.frames = 0;
      this.held = 0;
      const unsub = hooks.addPostRender(() => {
        try {
          if (!rec.hasCapacity()) return;
          const now = performance.now();
          if (this.t0 === null) this.t0 = now;
          const ideal = ((now - this.t0) * fps) / 1000;
          let k = this.lastK + 1;
          const d = ideal - k;
          if (d < -0.5) return;
          if (d >= 1.5) k = Math.round(ideal);
          const times = [];
          const first = Math.max(this.lastK + 1, k - 1);
          for (let i = first; i <= k; i++) times.push(i / fps);
          this.held += times.length - 1;
          this.lastK = k;
          this.frames += times.length;
          rec.grab(times.length === 1 ? times[0] : times);
        } catch (_) {}
      });
      this.rec = rec;
      this.unsub = unsub;
      return rec.stats();
    },
    async stop() {
      if (this.unsub) {
        try { this.unsub(); } catch (_) {}
        this.unsub = null;
      }
      if (!this.rec) return null;
      return await this.rec.stop();
    },
    drain(maxBytes = 6 * 1024 * 1024) {
      if (!this.rec) return null;
      return this.rec.drain({ maxBytes });
    },
    dispose() {
      if (this.unsub) { try { this.unsub(); } catch (_) {} this.unsub = null; }
      if (this.rec) { try { this.rec.dispose?.(); } catch (_) {} this.rec = null; }
    }
  };

  return { ok: true };
})()
`;

async function drainChapterToMp4(cdp, chapterNum, durSec) {
  log(`Stopping Chapter ${chapterNum} recorder...`);
  const stopStats = await cdp.evaluate(`window.__chapterRec.stop()`, true);
  log(`Chapter ${chapterNum} stopped: ${JSON.stringify(stopStats)}`);

  const h264Path = path.join(OUT_DIR, `chapter-${chapterNum}.h264`);
  const mp4Path = path.join(OUT_DIR, `chapter-${chapterNum}.mp4`);
  const fd = fs.openSync(h264Path, "w");
  let totalBytes = 0;
  while (true) {
    const res = await cdp.evaluate(`window.__chapterRec.drain(6 * 1024 * 1024)`, false);
    if (!res || !res.chunks || res.chunks.length === 0) break;
    for (const c of res.chunks) {
      const buf = Buffer.from(c.b64, "base64");
      fs.writeSync(fd, buf);
      totalBytes += buf.length;
    }
    if (res.done) break;
  }
  fs.closeSync(fd);
  await cdp.evaluate(`window.__chapterRec.dispose()`, false);
  log(`Drained Chapter ${chapterNum}: ${(totalBytes / (1024 * 1024)).toFixed(2)} MB -> ${h264Path}`);

  // Mux Annex-B .h264 into .mp4 at 30fps with +genpts and zero re-encoding (-c copy)
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-fflags",
      "+genpts",
      "-r",
      "30",
      "-i",
      h264Path,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    { stdio: "inherit" }
  );
  log(`Muxed Chapter ${chapterNum} -> ${mp4Path}`);
  return { h264Path, mp4Path, stopStats, totalBytes };
}

async function teleportAndSettle(cdp, teleCmd, settleSec = 18) {
  log(`Teleporting: ${teleCmd} (settling ${settleSec}s)...`);
  await cdp.evaluate(
    `(() => {
      if (window.__filmDirector) {
        window.__filmDirector.wantBoarded = false;
        window.__filmDirector.setAutopilot(null);
        window.__filmDirector.setCamTweak(null);
        window.__filmDirector.setWorldOrbit(null);
        window.__filmDirector.stopCrashWatch();
        window.__filmDirector.setHUD({ reticle: false, pipper: false });
      }
      const V = window.__vehicles;
      V?.despawn(true);
    })()`,
    false
  );
  await sleep(1200);
  await cdp.evaluate(`try { (window.__sessionHandle ?? window.liveScene3d?.sessionHandle).sendChat(${JSON.stringify(teleCmd)}); } catch (_) {}`, false);
  await sleep(settleSec * 1000);
}

async function spawnPlane(cdp) {
  log("Spawning F6F-6N Super-Hellcat...");
  await cdp.evaluate(`window.__vehicles.despawn(true)`, false);
  await sleep(1000);
  await cdp.evaluate(`window.__vehicles.spawn()`, false);
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    const ready = await cdp.evaluate(
      `(() => {
        const vs = window.__vehicles.status().vehicles;
        return vs.length > 0 && vs[0].mode === 0 && vs[0].key !== null;
      })()`,
      false
    );
    if (ready) break;
  }
  await sleep(1500);
}

async function runTimeline(cdp, chapterNum, durationSec, events) {
  log(`=== Starting Chapter ${chapterNum} (${durationSec}s = ${(durationSec / 60).toFixed(2)} min) ===`);
  await cdp.evaluate(`window.__setFrameCap(30)`, false);
  await cdp.evaluate(`window.__chapterRec.start(${BITRATE})`, true);

  const t0 = Date.now();
  let nextIdx = 0;
  let lastLogSec = -10;

  while (true) {
    const elap = (Date.now() - t0) / 1000;
    if (elap >= durationSec) break;

    while (nextIdx < events.length && elap >= events[nextIdx].at) {
      const ev = events[nextIdx++];
      log(`[Ch${chapterNum} t=${elap.toFixed(1)}s] ${ev.label}`);
      try {
        await ev.run(cdp);
      } catch (err) {
        log(`[Ch${chapterNum} WARN] event '${ev.label}' error: ${err.message}`);
      }
    }

    if (elap - lastLogSec >= 15) {
      lastLogSec = elap;
      try {
        const st = await cdp.evaluate(
          `(() => {
            const V = window.__vehicles.status();
            const ps = V.pilot?.state;
            const fl = V.fall;
            const rec = window.__chapterRec.rec?.stats();
            const gz = ps ? (window.__groundAt?.(ps.x, ps.y) ?? 0) : 0;
            return {
              piloting: !!V.pilot,
              falling: !!fl,
              mode: ps?.mode ?? V.vehicles[0]?.mode ?? -1,
              x: Math.round(ps?.x ?? fl?.x ?? V.vehicles[0]?.pos?.x ?? 0),
              y: Math.round(ps?.y ?? fl?.y ?? V.vehicles[0]?.pos?.y ?? 0),
              z: Math.round(ps?.z ?? fl?.z ?? V.vehicles[0]?.pos?.z ?? 0),
              agl: Math.round(ps ? ps.z - gz : (fl?.agl ?? 0)),
              spd: Math.round(ps?.speed ?? 0),
              frames: window.__chapterRec.frames ?? 0,
              mb: +((rec?.bufferedBytes ?? 0) / (1024 * 1024)).toFixed(1),
            };
          })()`,
          false
        );
        log(
          `[Ch${chapterNum} ${elap.toFixed(0)}/${durationSec}s] pos=(${st.x},${st.y},z=${st.z},agl=${st.agl}m) spd=${st.spd}m/s mode=${st.mode} frames=${st.frames} buf=${st.mb}MB`
        );
      } catch (_) {}
    }

    await sleep(150);
  }

  return await drainChapterToMp4(cdp, chapterNum, durationSec);
}

async function main() {
  checkGateAndLaunchChrome();
  const cdp = await openCdp();

  try {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: 1920,
      height: 1080,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const sep = APP_URL.includes("?") ? "&" : "?";
    const url =
      `${APP_URL}${sep}autoLogin=1&account=${ACCOUNT}&password=${PASSWORD}&autoSpawn=first` +
      `&nosw=1&portalSpace=off&camDebug=on&quality=high&csm=off&renderScale=1&adaptiveRes=off` +
      `&objRadius=4&vehicles=on&vehicleAudio=off&flightView=on&flightResidency=on&farForest=on` +
      `&worldTier=on&targetFps=0&skytime=15.6&cloudCoverage=0.42&hud=none`;

    log(`Navigating to ${url}`);
    await cdp.send("Page.navigate", { url });

    log("Waiting for in-world spawn & vehicle capabilities...");
    let isReady = false;
    for (let i = 0; i < 120; i++) {
      await sleep(1000);
      isReady = await cdp.evaluate(
        `Boolean(window.liveScene3d && (window.__sessionHandle ?? window.liveScene3d?.sessionHandle) && window.__vehicles && window.__vehicles.status().caps.granted !== null && window.__cam)`,
        false
      ).catch(() => false);
      if (isReady) break;
    }
    if (!isReady) {
      throw new Error("Timed out waiting for in-world spawn & vehicle capabilities");
    }
    log("In-world spawn & vehicle capabilities ready!");

    log("Configuring ACE server vehicle properties (5,000m ceiling, 111 m/s speed cap, 600m observer sight radius, infinite ammo)...");
    const cmds = [
      "@godmode on",
      "@modifydouble vehicle_speed_cap 111",
      "@modifybool vehicle_infinite_ammo true",
      "@modifydouble vehicle_ceiling_agl 5000",
      "@modifydouble vehicle_climb_max 45",
      "@modifydouble vehicle_sink_max 45",
      "@modifydouble vehicle_high_band_agl 600",
      "@modifydouble vehicle_observer_sight_radius 600",
      "@modifydouble vehicle_sight_radius 350",
      "@modifybool vehicle_preload true",
      "@modifybool vehicle_preload_offthread true",
      "@modifybool vehicle_landblock_budget true",
    ];
    for (const c of cmds) {
      await cdp.evaluate(`(window.__sessionHandle ?? window.liveScene3d?.sessionHandle).sendChat(${JSON.stringify(c)})`, false);
      await sleep(250);
    }

    log("Installing in-page __filmDirector & recorder hooks...");
    await cdp.evaluate(PAGE_DIRECTOR_INIT, true);

    const skipToCh4 = process.env.SKIP_TO_CH4 === "1";
    const chapters = [];

    if (skipToCh4) {
      log("SKIP_TO_CH4=1: Reusing already recorded Chapter 1, Chapter 2, and Chapter 3 (.h264/.mp4)!");
      for (const n of [1, 2, 3]) {
        chapters.push({
          h264Path: path.join(OUT_DIR, `chapter-${n}.h264`),
          mp4Path: path.join(OUT_DIR, `chapter-${n}.mp4`),
        });
      }
      // Pre-warm directly at Chapter 4's starting point (West of Al-Arqas)
      await teleportAndSettle(cdp, teleloc(25800, 16956, 90), 18);
      await spawnPlane(cdp);
      await cdp.evaluate(
        `(() => {
          const p = window.__cam.world();
          window.__vehicles.debugExplode([p.x + 80, p.y + 80, p.z], 2000);
        })()`,
        false
      );
      await sleep(3000);
    } else {
      // =========================================================================
      // PRE-WARM (Teleport to Holtburg ridge, spawn plane, warm shaders & bakes)
      // =========================================================================
      await teleportAndSettle(cdp, teleloc(32588, 34620, 130), 18);
      await spawnPlane(cdp);

      log("Pre-warming altitude shader variants (dz=400, 1600, 3500) and weapon explosion FX...");
      for (const dz of [400, 1600, 3500, 0]) {
        await cdp.evaluate(
          `(() => {
            const p = window.__cam.world();
            if (${dz} > 0) window.__cam.orbit(p.x, p.y, p.z + ${dz}, 20, 45, -25);
            else window.__cam.release();
          })()`,
          false
        );
        await sleep(1200);
      }
      await cdp.evaluate(
        `(() => {
          const p = window.__cam.world();
          window.__vehicles.debugExplode([p.x + 80, p.y + 80, p.z], 2000);
        })()`,
        false
      );
      await sleep(3000);
    }

    if (!skipToCh4) {
    // =========================================================================
    // CHAPTER 1 (305s):
    // Walk-Around & Boarding the Super-Hellcat + Flying Around Dereth
    // (Holtburg -> River Valley -> Dense Aluvian Forests -> Cragstone ->
    //  Central Mountains -> Zaikhal)
    // =========================================================================
    const ch1Events = [
      {
        at: 0.0,
        label: "Pre-flight 360-degree exterior walk-around orbit of parked 257-part Super-Hellcat",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setWorldOrbit({
              target: "vehicle",
              dz: 1.5,
              dist0: 13.5,
              dist1: 9.2,
              az0: 195,
              azRate: 14,
              el0: 11,
              el1: 18,
              dur: 27,
              fov: 48,
            })`,
            false
          ),
      },
      {
        at: 27.5,
        label: "Frame pilot beside starboard wing root before boarding hop",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setWorldOrbit({
              target: "vehicle",
              dz: 1.7,
              dist0: 9.5,
              dist1: 10.5,
              az0: 130,
              azRate: -8,
              el0: 15,
              el1: 14,
              dur: 5,
              fov: 52,
            })`,
            false
          ),
      },
      {
        at: 31.5,
        label: "Release world orbit and BOARD the Super-Hellcat (0.55s parabolic boarding hop into cockpit seat!)",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setWorldOrbit(null);
              window.__filmDirector.setCamTweak({ yaw: 0.45, back: 11.5, up: 2.6, fov: 52, cut: true });
              window.__filmDirector.boardNow();
            })()`,
            false
          ),
      },
      {
        at: 36.0,
        label: "Switch to Cockpit View — inspect GEAR_SHIELD instrument console, reflector sight & spinning prop",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
              window.__filmDirector.setAutopilot({ throttle: 0.18, yawOverride: 0.25 });
            })()`,
            false
          ),
      },
      {
        at: 43.0,
        label: "Cockpit check pan left/right with rudder + test burst of 6 wing autocannons",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setAutopilot({ throttle: 0.20, yawOverride: -0.25, fire: true })`,
            false
          ),
      },
      {
        at: 46.5,
        label: "Switch to Chase View & throttle up for takeoff roll & landing gear retraction over Holtburg",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 0.22, back: 13.5, up: 2.8, fov: 56, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 33200,
                ty: 33900,
                agl: 68,
                throttle: 1.0,
                boost: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 58.0,
        label: "Low scenic pass over Holtburg town & river valley heading SE toward Cragstone",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: -0.28, back: 15.0, up: 3.4, fov: 54, tau: 0.8 });
              window.__filmDirector.setAutopilot({
                tx: 36073,
                ty: 30696,
                agl: 65,
                throttle: 0.90,
                boost: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 78.0,
        label: "Continuous 360-degree chase orbit while skimming the Aluvian river valley & dense forest canopy",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setCamTweak({
              yaw: -0.28,
              yawRate: 0.22,
              back: 15.5,
              up: 3.5,
              fov: 52,
              tau: 0.5,
            })`,
            false
          ),
      },
      {
        at: 108.0,
        label: "Dramatic front-quarter look-back camera showing R-2800 radial engine & 6 wing guns over forest",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setCamTweak({
              yaw: 2.58,
              yawRate: 0,
              back: 13.5,
              up: 1.9,
              fov: 48,
              tau: 0.6,
            })`,
            false
          ),
      },
      {
        at: 126.0,
        label: "Cockpit view approaching Cragstone across the forested valley",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
            })()`,
            false
          ),
      },
      {
        at: 142.0,
        label: "Arrive over Cragstone (x=36073, y=30696) — low banking chase pass over Cragstone buildings & waterfall",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 0.35, yawRate: 0.14, back: 16.0, up: 4.2, fov: 56, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 36250,
                ty: 30450,
                agl: 55,
                throttle: 0.78,
              });
            })()`,
            false
          ),
      },
      {
        at: 162.0,
        label: "Bank west over Cragstone town center and engage 400 km/h boost toward the Central Mountains & Zaikhal",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: -0.32, yawRate: 0, back: 14.5, up: 3.0, fov: 58, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 24641,
                ty: 27704,
                agl: 95,
                throttle: 1.0,
                boost: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 188.0,
        label: "Starboard wingtip camera crossing the central Dereth mountain ridges",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setCamTweak({ yaw: 1.38, yawRate: 0, back: 10.8, up: 0.9, fov: 52, tau: 0.5 })`,
            false
          ),
      },
      {
        at: 212.0,
        label: "High dorsal cinema chase + live 6-gun & HVAR lightning rocket burst over mountain pass",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.12, yawRate: 0, back: 17.5, up: 5.2, fov: 56, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 24641,
                ty: 27704,
                agl: 85,
                throttle: 1.0,
                boost: true,
                fire: true,
                missile: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 222.0,
        label: "Cease fire, smooth 360-degree orbit descending into the Zaikhal valley",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.12, yawRate: -0.20, back: 15.0, up: 3.2, fov: 54, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 24641,
                ty: 27704,
                agl: 65,
                throttle: 1.0,
                boost: true,
                fire: false,
                missile: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 258.0,
        label: "Cockpit view approaching Zaikhal citadel walls (x=24641, y=27704)",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
              window.__filmDirector.setAutopilot({
                tx: 24641,
                ty: 27704,
                agl: 58,
                throttle: 0.85,
                boost: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 275.0,
        label: "Chase view victory pass & 6-gun + rocket salute over Zaikhal",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 0.25, yawRate: 0.18, back: 15.5, up: 3.6, fov: 55, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 23900,
                ty: 27400,
                agl: 60,
                throttle: 0.85,
                fire: true,
                missile: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 290.0,
        label: "Cease fire and bank smoothly over the western Zaikhal hills to close Chapter 1",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setAutopilot({
              tx: 24641,
              ty: 27704,
              agl: 75,
              throttle: 0.85,
              fire: false,
              missile: false,
            })`,
            false
          ),
      },
    ];

    chapters.push(await runTimeline(cdp, 1, CHAPTER_SEC, ch1Events));

    // =========================================================================
    // CHAPTER 2 (305s):
    // The Direlands Expedition
    // (Fort Tethana -> Direlands Canyons & Badlands -> Obsidian Plains ->
    //  Wai Jhou strike pass -> Western Direlands -> Ayan Baqur)
    // =========================================================================
    await teleportAndSettle(cdp, teleloc(7374, 24876, 160), 18);
    await spawnPlane(cdp);

    const ch2Events = [
      {
        at: 0.0,
        label: "Exterior orbit on Fort Tethana plateau in the Northern Direlands",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setWorldOrbit({
              target: "vehicle",
              dz: 1.6,
              dist0: 12.0,
              dist1: 9.5,
              az0: 140,
              azRate: 18,
              el0: 14,
              el1: 16,
              dur: 9,
              fov: 50,
            })`,
            false
          ),
      },
      {
        at: 9.0,
        label: "Board Super-Hellcat at Fort Tethana & throttle up for takeoff",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setWorldOrbit(null);
              window.__vehicles.setView("chase");
              window.__filmDirector.setCamTweak({ yaw: -0.22, back: 14.0, up: 3.0, fov: 56, cut: true });
              window.__filmDirector.boardNow();
            })()`,
            false
          ),
      },
      {
        at: 13.0,
        label: "Takeoff over Fort Tethana walls and bank SSE into the Direlands canyons toward Wai Jhou",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setAutopilot({
              tx: 9700,
              ty: 17200,
              agl: 75,
              throttle: 1.0,
              boost: true,
            })`,
            false
          ),
      },
      {
        at: 35.0,
        label: "Low canyon-skimming chase view across the Direlands badlands & dead forests",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.18, yawRate: 0.16, back: 15.0, up: 2.8, fov: 55, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 9700,
                ty: 17200,
                agl: 58,
                throttle: 1.0,
                boost: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 68.0,
        label: "Cockpit view skimming the Direlands ridges with live 6-gun autocannon strafing bursts",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
              window.__filmDirector.setAutopilot({
                tx: 12119,
                ty: 9558,
                agl: 55,
                throttle: 1.0,
                boost: true,
                fire: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 86.0,
        label: "Front-quarter radial engine look-back over the Southern Direlands swamps & obsidian ridges",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: -2.55, yawRate: 0, back: 13.8, up: 2.0, fov: 49, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 12119,
                ty: 9558,
                agl: 68,
                throttle: 1.0,
                boost: true,
                fire: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 118.0,
        label: "Port-side profile wing camera approaching the Obsidian Plains & Wai Jhou (x=12119, y=9558)",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setCamTweak({ yaw: -1.42, yawRate: 0, back: 11.2, up: 1.1, fov: 52, tau: 0.5 })`,
            false
          ),
      },
      {
        at: 148.0,
        label: "Wai Jhou attack run! Enable bomb pipper & reticle, fire 6-gun salvos + HVAR rockets & drop 1,000 lb bomb",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: true, pipper: true });
              window.__filmDirector.setCamTweak({ yaw: 0.14, yawRate: 0, back: 19.5, up: 6.5, fov: 58, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 12119,
                ty: 9558,
                agl: 62,
                throttle: 0.85,
                boost: false,
                fire: true,
                missile: true,
                autoBombDists: [240, 110],
              });
            })()`,
            false
          ),
      },
      {
        at: 175.0,
        label: "Rear look-back camera over Wai Jhou watching the 2,000 lb & 1,000 lb bomb fireballs erupt behind the tail!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 2.98, yawRate: 0, back: 18.0, up: 4.5, fov: 56, tau: 0.35 });
              window.__vehicles.debugExplode([12119, 9558, window.__groundAt?.(12119, 9558) ?? 60], 2000);
            })()`,
            false
          ),
      },
      {
        at: 192.0,
        label: "Turn West across the Southern Direlands ash wastes toward Ayan Baqur (x=3352, y=9958)",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: -0.25, yawRate: 0.18, back: 15.0, up: 3.4, fov: 55, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 3352,
                ty: 9958,
                agl: 72,
                throttle: 1.0,
                boost: true,
                fire: false,
                missile: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 235.0,
        label: "Cockpit view racing west toward Ayan Baqur at 400 km/h",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
            })()`,
            false
          ),
      },
      {
        at: 258.0,
        label: "Arrive at Ayan Baqur (x=3352, y=9958) — low banking chase orbit over the Western Direlands stronghold",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 0.32, yawRate: 0.22, back: 15.5, up: 3.8, fov: 54, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 3352,
                ty: 9958,
                agl: 58,
                throttle: 0.80,
                boost: false,
                fire: true,
                missile: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 282.0,
        label: "Cease fire and climb out over Ayan Baqur toward the western Direlands sea",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setAutopilot({
              tx: 2600,
              ty: 10200,
              agl: 120,
              throttle: 0.90,
              fire: false,
              missile: false,
            })`,
            false
          ),
      },
    ];

    chapters.push(await runTimeline(cdp, 2, CHAPTER_SEC, ch2Events));

    // =========================================================================
    // CHAPTER 3 (305s):
    // Flying High Into the Sky, Piercing the Volumetric Cumulus Cloud Deck
    // (1,050-1,950 m AGL) up to the 5,000 m AGL Ceiling & Diving Back Down
    // =========================================================================
    await teleportAndSettle(cdp, teleloc(29618, 21752, 238), 18);
    await spawnPlane(cdp);

    const ch3Events = [
      {
        at: 0.0,
        label: "Board Super-Hellcat in Gharu'ndim highlands & prepare for high-altitude cloud climb",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setCamTweak({ yaw: 0.25, back: 13.5, up: 2.8, fov: 56, cut: true });
              window.__filmDirector.boardNow();
            })()`,
            false
          ),
      },
      {
        at: 5.0,
        label: "Full-power takeoff heading SW toward the central desert",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setAutopilot({
              heading: 4.15,
              agl: 90,
              throttle: 1.0,
              boost: true,
            })`,
            false
          ),
      },
      {
        at: 20.0,
        label: "Pitch up into a steep full-power climb (45 m/s vertical climb rate) straight toward the cumulus cloud deck!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.35, yawRate: 0.14, back: 14.5, up: 2.2, fov: 56, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                heading: 4.15,
                pitchOverride: 0.95,
                throttle: 1.0,
                boost: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 44.0,
        label: "Entering the lower volumetric cumulus cloud base (~1,050 m AGL) — close chase view as cloud wisps envelop wings",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setCamTweak({ yaw: -0.18, yawRate: 0, back: 12.8, up: 2.0, fov: 58, tau: 0.5 })`,
            false
          ),
      },
      {
        at: 58.0,
        label: "Cockpit view flying directly INSIDE and THROUGH the billowing 3D cumulus cloud deck (1,200 - 1,850 m AGL)!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
            })()`,
            false
          ),
      },
      {
        at: 76.0,
        label: "Bursting out above the sunlit cumulus cloud tops (~2,000 -> 3,200 m AGL) — dramatic front-quarter look-back!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 2.42, yawRate: 0.12, back: 14.8, up: 2.8, fov: 54, tau: 0.5 });
            })()`,
            false
          ),
      },
      {
        at: 112.0,
        label: "Reaching the 5,000 m AGL high-altitude ceiling! Level off above the vast sea of clouds & 85 km Dereth horizon",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.0, yawRate: 0.20, back: 17.5, up: 4.5, fov: 55, tau: 0.6 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 4650,
                throttle: 1.0,
                boost: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 155.0,
        label: "High-altitude weapons test above the clouds at ~4,800 m AGL — firing all 6 autocannons & HVAR lightning rockets",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: -0.35, yawRate: 0, back: 14.0, up: 2.6, fov: 54, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 4650,
                throttle: 1.0,
                boost: true,
                fire: true,
                missile: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 172.0,
        label: "Cockpit view high above the clouds looking out over the 85 km continent horizon",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 4600,
                throttle: 1.0,
                boost: true,
                fire: false,
                missile: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 195.0,
        label: "Begin high-speed power dive from ~4,700 m AGL straight back down toward the cumulus cloud deck & Al-Arqas!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 0.22, yawRate: 0.15, back: 15.0, up: 3.4, fov: 58, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                pitchOverride: -0.95,
                throttle: 1.0,
                boost: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 235.0,
        label: "Cockpit view diving straight back through the volumetric cumulus cloud layer (1,950 -> 1,050 m AGL)!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
            })()`,
            false
          ),
      },
      {
        at: 262.0,
        label: "Breaking out below the cloud base over the desert — pull out of dive & level off at 90 m AGL toward Al-Arqas",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: -0.24, yawRate: 0, back: 14.5, up: 3.2, fov: 56, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 85,
                throttle: 0.90,
                boost: false,
              });
            })()`,
            false
          ),
      },
    ];

    chapters.push(await runTimeline(cdp, 3, CHAPTER_SEC, ch3Events));

    // Teleport 1.85 km West of Al-Arqas (x=25800, y=16956)
    await teleportAndSettle(cdp, teleloc(25800, 16956, 90), 18);
    await spawnPlane(cdp);
    } // end if (!skipToCh4)

    // =========================================================================
    // CHAPTER 4 (305s):
    // Town Assault on Al-Arqas (x=27640, y=16956):
    //   - Pass 1 (0-58s): Strafing & HVAR lightning-rocket attack on the town
    //   - Pass 2 (58-125s): Dropping 2,000 lb & twin 1,000 lb bombs on the town
    //                       and near-town oasis/outskirts objects
    //   - Landing, Rearming & Pass 3 (125-205s): Touch down beside town (6.5s rearm),
    //                       take off & execute full saturation strike Pass 3
    //   - Bailout, Parachuting & Plane "Crashing" Nearby (205-305s):
    //                       Line up on a steady 90° East run-in at 106 m AGL,
    //                       bail out at t=240s, open the olive-drab parachute canopy,
    //                       and watch the derelict Super-Hellcat slam into the terrain
    //                       ~240 m ahead near the town in a massive multi-stage fireball
    //                       and black smoke column while floating down and landing nearby!
    // =========================================================================
    const ch4Events = [
      {
        at: 0.0,
        label: "Board Super-Hellcat 1.85 km West of Al-Arqas & launch immediately on Combat Pass 1",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setCamTweak({ yaw: 0.18, back: 13.5, up: 2.8, fov: 56, cut: true });
              window.__filmDirector.boardNow();
            })()`,
            false
          ),
      },
      {
        at: 4.0,
        label: "Takeoff heading East (90 deg) directly toward Al-Arqas town center (x=27640, y=16956)",
        run: (c) =>
          c.evaluate(
            `window.__filmDirector.setAutopilot({
              tx: 27640,
              ty: 16956,
              agl: 58,
              throttle: 0.82,
              boost: false,
            })`,
            false
          ),
      },
      {
        at: 18.0,
        label: "PASS 1 (Strafing & Rockets): Switch to Cockpit Gunsight View, aim nose at Al-Arqas & open fire with all 6 autocannons + HVAR rockets!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("cockpit");
              window.__filmDirector.setHUD({ reticle: true, pipper: false });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 46,
                strafeAim: true,
                strafeZOffset: 3,
                throttle: 0.78,
                fire: true,
                missile: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 29.0,
        label: "PASS 1 Over Town Rooftops: Switch to close chase camera roaring right over Al-Arqas buildings while firing!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.setView("chase");
              window.__filmDirector.setCamTweak({ yaw: 0.24, yawRate: 0, back: 14.5, up: 3.6, fov: 58, tau: 0.35 });
            })()`,
            false
          ),
      },
      {
        at: 39.0,
        label: "Loop back East of Al-Arqas to set up Heavy Bombing Pass 2",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: -0.30, yawRate: 0, back: 15.0, up: 3.5, fov: 56, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 28850,
                ty: 17350,
                agl: 75,
                throttle: 0.85,
                fire: false,
                missile: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 56.0,
        label: "PASS 2 (Heavy Bombing Run on Town & Near-Town Objects): Turn straight onto Al-Arqas with CCIP Bomb Pipper active!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: true, pipper: true });
              window.__filmDirector.setCamTweak({ yaw: 0.12, yawRate: 0, back: 21.0, up: 7.5, fov: 58, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 64,
                throttle: 0.75,
                fire: true,
                missile: true,
                autoBombDists: [340, 175, 75],
              });
            })()`,
            false
          ),
      },
      {
        at: 78.0,
        label: "PASS 2 Impact Framing: Look back over tail as 2,000 lb Blockbuster & twin 1,000 lb bombs obliterate Al-Arqas & near-town oasis!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: 2.96, yawRate: 0, back: 22.0, up: 6.5, fov: 58, tau: 0.3 });
              const gz = window.__groundAt?.(27640, 16956) ?? 48;
              window.__vehicles.debugExplode([27720, 17010, gz], 1500);
              window.__vehicles.debugExplode([27640, 16956, gz], 2000);
              window.__vehicles.debugExplode([27570, 16920, gz], 1500);
            })()`,
            false
          ),
      },
      {
        at: 92.0,
        label: "Circle low around the smoking town of Al-Arqas inspecting the bomb craters & smoke columns",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.45, yawRate: 0.16, back: 16.5, up: 4.5, fov: 56, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27100,
                ty: 16650,
                agl: 52,
                throttle: 0.55,
                fire: false,
                missile: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 112.0,
        label: "Extend landing gear and touch down on the desert flats beside Al-Arqas to rearm all bombs & rockets!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.65, yawRate: 0.12, back: 14.0, up: 3.0, fov: 52, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 26600,
                ty: 16850,
                agl: 15,
                throttle: 0.0,
                land: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 142.0,
        label: "Rearm complete (all 3 bombs & 6 HVAR rocket wands restored on pylons)! Full throttle takeoff for Pass 3!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: true, pipper: true });
              window.__filmDirector.setCamTweak({ yaw: -0.18, yawRate: 0, back: 19.0, up: 6.5, fov: 58, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 60,
                throttle: 0.85,
                land: false,
                fire: true,
                missile: true,
                autoBombDists: [310, 160, 65],
              });
            })()`,
            false
          ),
      },
      {
        at: 166.0,
        label: "PASS 3 Saturation Strike over Al-Arqas: Look back as second wave of bombs & rockets detonate across the town!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setHUD({ reticle: false, pipper: false });
              window.__filmDirector.setCamTweak({ yaw: -2.92, yawRate: 0, back: 21.0, up: 6.0, fov: 58, tau: 0.3 });
              const gz = window.__groundAt?.(27640, 16956) ?? 48;
              window.__vehicles.debugExplode([27660, 16970, gz], 2000);
              window.__vehicles.debugExplode([27610, 16940, gz], 1500);
            })()`,
            false
          ),
      },
      {
        at: 180.0,
        label: "Fly 1.1 km West of Al-Arqas to set up the final Eastward bailout & crash run-in",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.25, yawRate: 0, back: 15.0, up: 3.4, fov: 56, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 26350,
                ty: 16956,
                agl: 118,
                throttle: 0.85,
                fire: false,
                missile: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 210.0,
        label: "Turn East (90 deg) onto final run-in toward Al-Arqas at ~112 m AGL, slowing to 36 m/s for bailout",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.18, yawRate: 0, back: 14.5, up: 3.2, fov: 56, tau: 0.5 });
              window.__filmDirector.setAutopilot({
                tx: 27640,
                ty: 16956,
                agl: 112,
                throttle: 0.12,
                fire: true,
              });
            })()`,
            false
          ),
      },
      {
        at: 234.0,
        label: "Stabilize wings level (bank=0) and nose slightly down (pitch=-0.22) pointed right at Al-Arqas outskirts",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak({ yaw: 0.0, yawRate: 0, back: 15.5, up: 4.2, fov: 60, tau: 0.3 });
              window.__filmDirector.setAutopilot({
                rollOverride: 0,
                yawOverride: 0,
                pitchOverride: -0.45,
                throttle: 0.0,
                fire: false,
              });
            })()`,
            false
          ),
      },
      {
        at: 237.0,
        label: "BAIL OUT! (V.exit(1)) — Pilot leaps from the cockpit while the derelict Super-Hellcat glides down ahead toward the town!",
        run: (c) =>
          c.evaluate(
            `(() => {
              // Frame forward & slightly elevated behind the parachutist so both the olive-drab canopy AND the crashing plane ahead are in frame!
              window.__filmDirector.setCamTweak({ yaw: 0.05, yawRate: 0, back: 14.5, up: 4.8, pitch: -0.22, fov: 62, cut: true });
              window.__filmDirector.startCrashWatch([27640, 16956]);
              window.__filmDirector.bailOut();
            })()`,
            false
          ),
      },
      {
        at: 239.0,
        label: "Deploy olive-drab 24-gore parachute canopy (V.openChute()) while tracking the derelict plane gliding down ahead!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__vehicles.openChute();
              window.__filmDirector.setCamTweak({ yaw: 0.04, yawRate: 0.02, back: 15.5, up: 5.0, pitch: -0.20, fov: 62, tau: 0.6 });
            })()`,
            false
          ),
      },
      {
        at: 263.0,
        label: "Post-touchdown survivor orbit — circle the landed pilot on foot with the burning Super-Hellcat crash site & smoke column behind!",
        run: (c) =>
          c.evaluate(
            `(() => {
              window.__filmDirector.setCamTweak(null);
              window.__filmDirector.setWorldOrbit({
                target: "player",
                dz: 1.5,
                dist0: 9.5,
                dist1: 14.5,
                az0: 255,
                azRate: 12,
                el0: 10,
                el1: 18,
                dur: 40,
                fov: 54,
              });
            })()`,
            false
          ),
      },
    ];

    chapters.push(await runTimeline(cdp, 4, CHAPTER_SEC, ch4Events));

    // =========================================================================
    // CONCATENATE ALL 4 ANNEX-B .H264 STREAMS INTO THE FINAL 20-MINUTE MP4
    // =========================================================================
    const fullH264Path = path.join(OUT_DIR, "full-20min.h264");
    const finalMp4Path = path.join(OUT_DIR, "super-hellcat-20min-film.mp4");
    log(`Concatenating ${chapters.length} Annex-B .h264 streams into ${fullH264Path}...`);
    const outFd = fs.openSync(fullH264Path, "w");
    for (const ch of chapters) {
      const buf = fs.readFileSync(ch.h264Path);
      fs.writeSync(outFd, buf);
    }
    fs.closeSync(outFd);

    log(`Muxing ${fullH264Path} into ${finalMp4Path}...`);
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-fflags",
        "+genpts",
        "-r",
        "30",
        "-i",
        fullH264Path,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        finalMp4Path,
      ],
      { stdio: "inherit" }
    );

    const probeOut = execFileSync(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,bit_rate:stream=width,height,r_frame_rate,codec_name",
        "-of",
        "json",
        finalMp4Path,
      ],
      { encoding: "utf8" }
    );
    log(`Final 20-min film ffprobe: ${probeOut}`);
  } finally {
    try {
      cdp.close();
    } catch (_) {}
    log("Cleaning up GTX-1070 Chrome (hbbench-kill.ps1)...");
    try {
      ssh1070("powershell -NoProfile -ExecutionPolicy Bypass -File D:\\Temp\\hbbench\\hbbench-kill.ps1");
    } catch (_) {}
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
