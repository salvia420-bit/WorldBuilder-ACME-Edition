// harness/e2e_semi/tier4_scenarios.mjs — Tier 4 Real-World End-to-End Scenarios (5 scenarios).
// Executed fully in `--mode live` against ACE + wsbridge + serve.py + headless EGL Chromium.
// Reports `PENDING` cleanly in `--mode offline` (unless `--strict`).

import { angleDiff, assert } from "./common.mjs";

export const TIER4_METADATA = [
  { id: "T4.S01", tier: 4, feature: "Scenario:Rig40HC_Preset_STurn_Articulation_Shot", mode: "live" },
  { id: "T4.S02", tier: 4, feature: "Scenario:Rig20_Alternate_Livery_SideBySide_Shot", mode: "live" },
  { id: "T4.S03", tier: 4, feature: "Scenario:KeyG_Unhitch_GearExtend_Reverse_Rehitch", mode: "live" },
  { id: "T4.S04", tier: 4, feature: "Scenario:Container_Mount_DoorLock_Moving_vs_Parked", mode: "live" },
  { id: "T4.S05", tier: 4, feature: "Scenario:CameraCycle_DespawnAutoUnhitch_ConsoleZero", mode: "live" },
];

async function waitUntil(fn, timeoutMs = 10000, intervalMs = 200, label = "condition") {
  const t0 = Date.now();
  let lastErr = null;
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fn();
      if (r) return r;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? `: ${lastErr.message}` : ""}`);
}

const DISPATCH_KEY_G_JS = `
  if (document.activeElement && document.activeElement !== document.body && typeof document.activeElement.blur === "function") {
    document.activeElement.blur();
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true, cancelable: true }));
  window.dispatchEvent(new KeyboardEvent("keyup", { key: "g", code: "KeyG", bubbles: true, cancelable: true }));
  return true;
`;

export async function runTier4(collector) {
  // Scenario 1: @trailer preset rig40hc, board semi-379, S-turn driving + articulation + wheels + HUD-hidden shot
  await collector.checkLive("T4.S01", 4, "Scenario:Rig40HC_Preset_STurn_Articulation_Shot", async (live) => {
    await live.cleanupWorld();
    await live.evalInPage(`window.__sessionHandle?.setSkyTimeOverride?.(0.5); return true;`);
    await live.sendChatAndWait("@tele 41.35N 33.33E", /teleport|41\.35/i, 10000).catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));

    await live.sendChatAndWait("@trailer preset rig40hc", /rig40hc|Ironhorse|trailer|spawned/i, 10000);
    const rig = await waitUntil(async () => {
      return await live.evalInPage(`
        const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = (window.__vehicles?.trailers?.list?.() || [])[0];
        const c = (window.__vehicles?.containers?.list?.() || [])[0];
        if (!v || !t || !c) return null;
        return {
          v: {
            guid: v.guid,
            profileKey: v.profileKey ?? v.profile?.profileKey ?? null,
            liveryId: v.liveryId ?? v.profile?.liveryId ?? 0,
            hitchedTrailerGuid: v.hitchedTrailerGuid ?? v.last?.hitchedTrailerGuid ?? 0,
          },
          t: {
            guid: t.guid,
            coupledTractorGuid: t.coupledTractorGuid ?? t.last?.coupledTractorGuid ?? 0,
          },
        };
      `);
    }, 10000, 250, "rig40hc entities");

    assert(rig.t.coupledTractorGuid === rig.v.guid || rig.v.hitchedTrailerGuid === rig.t.guid, "rig40hc tractor & trailer must be coupled");

    // Board driver seat and drive S-turn
    await live.evalInPage(`window.__vehicles.board(${rig.v.guid}, 0); return true;`);
    await waitUntil(async () => await live.evalInPage(`return !!window.__vehicles?.piloting`), 6000, 150, "piloting semi-379");

    // Steer left then right while accelerating
    await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.75, yaw: -0.7 }, 1800); return true;`);
    await new Promise((r) => setTimeout(r, 1900));
    await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.75, yaw: 0.7 }, 1800); return true;`);
    await new Promise((r) => setTimeout(r, 1900));
    await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);

    const st = await live.evalInPage(`
      const s = window.__vehicles.status();
      const t = window.__vehicles.trailers.get(${rig.t.guid});
      const m = window.__vehicles.groundModels.get(${rig.v.guid});
      const vSt = s?.vehicles?.find((x) => x.guid === ${rig.v.guid}) ?? s?.vehicles?.[0];
      const pState = (s?.pilot?.vehicle === undefined || s?.pilot?.vehicle === ${rig.v.guid}) ? s?.pilot?.state : null;
      return {
        s: s ? {
          speed: pState?.speed ?? vSt?.speed ?? 0,
          heading: pState?.heading ?? vSt?.pos?.heading ?? 0,
        } : null,
        t: t ? {
          guid: t.guid,
          coupledTractorGuid: t.coupledTractorGuid ?? t.last?.coupledTractorGuid ?? 0,
          landingGearRetracted: t.model?.landingGearRetracted ?? t.landingGearRetracted ?? (((t.last?.trailerFlags ?? 0) & 0x04) !== 0),
        } : null,
        wheelRoll: m?.wheelRollAngle || 0,
      };
    `);
    assert(Math.abs(st.wheelRoll) > 0.5, `semi wheels must have rolled, got ${st.wheelRoll}`);
    assert(st.t?.landingGearRetracted === true, `trailer landing gear must be retracted (true) while coupled, got ${st.t?.landingGearRetracted}`);

    await live.hideHud();
    await new Promise((r) => setTimeout(r, 250));
    const shot = await live.captureAndVerifyShot("t4_s01_rig40hc_sturn");
    await live.showHud();
    assert(shot.bytes > 10 * 1024, "t4_s01 shot verified");
    await live.evalInPage(`window.__vehicles.exit(0); return true;`).catch(() => {});
  });

  // Scenario 2: @trailer preset rig20 + alternate livery @vehicle spawn semi 1 side-by-side + HUD-hidden shot
  await collector.checkLive("T4.S02", 4, "Scenario:Rig20_Alternate_Livery_SideBySide_Shot", async (live) => {
    await live.sendChatAndWait("@trailer preset rig20", /rig20|Ironhorse|trailer|spawned/i, 10000);
    await live.sendChatAndWait("@vehicle spawn semi 1", /Ironhorse 379|spawned/i, 10000);
    const rigs = await waitUntil(async () => {
      return await live.evalInPage(`
        const vs = (window.__vehicles?.vehicles?.() || []).filter((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const ts = window.__vehicles?.trailers?.list?.() || [];
        if (vs.length < 2 || ts.length < 2) return null;
        return {
          vs: vs.map((v) => ({ guid: v.guid, liveryId: v.liveryId ?? v.profile?.liveryId ?? 0 })),
          ts: ts.map((t) => ({ guid: t.guid })),
        };
      `);
    }, 10000, 250, "side-by-side rig20 + semi livery 1");

    const hasLiv1 = rigs.vs.some((v) => v.liveryId === 1);
    assert(hasLiv1, "alternate liveryId=1 semi-379 must be present");

    await live.hideHud();
    await new Promise((r) => setTimeout(r, 250));
    await live.captureAndVerifyShot("t4_s02_rig20_livery");
    await live.showHud();
    await live.cleanupWorld();
  });

  // Scenario 3: KeyG unhitch -> landing gear extends -> drive forward -> reverse <= 3.5m -> KeyG re-hitch
  await collector.checkLive("T4.S03", 4, "Scenario:KeyG_Unhitch_GearExtend_Reverse_Rehitch", async (live) => {
    await live.cleanupWorld();
    await live.sendChatAndWait("@trailer preset rig40hc", /rig40hc|Ironhorse|spawned/i, 10000);
    const rig = await waitUntil(async () => {
      return await live.evalInPage(`
        const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = (window.__vehicles?.trailers?.list?.() || [])[0];
        return v && t ? { v: { guid: v.guid }, t: { guid: t.guid } } : null;
      `);
    }, 10000, 250, "rig40hc for unhitch/rehitch");

    await live.evalInPage(`window.__vehicles.board(${rig.v.guid}, 0); return true;`);
    await waitUntil(async () => await live.evalInPage(`return !!window.__vehicles?.piloting`), 6000, 150, "piloting");

    // Unhitch via real KeyG KeyboardEvent
    await live.evalInPage(DISPATCH_KEY_G_JS);
    const unhitched = await waitUntil(async () => {
      return await live.evalInPage(`
        const t = window.__vehicles.trailers.get(${rig.t.guid});
        if (!t) return null;
        const coupled = t.coupledTractorGuid ?? t.last?.coupledTractorGuid ?? 0;
        const gearRet = t.model?.landingGearRetracted ?? t.landingGearRetracted ?? (((t.last?.trailerFlags ?? 0) & 0x04) !== 0);
        return (coupled === 0 && gearRet === false) ? { coupled, landingGearRetracted: gearRet } : null;
      `);
    }, 8000, 200, "trailer unhitched with landing gear extended");
    assert(unhitched.landingGearRetracted === false, "landing gear must extend (false) when unhitched");

    // Drive forward past hitch range, brake cleanly to a stop, then closed-loop reverse within 2.5 m of kingpin
    await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.6 }, 1600); return true;`);
    await new Promise((r) => setTimeout(r, 1650));
    await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0, handbrake: true }, 900); return true;`);
    await waitUntil(async () => {
      return await live.evalInPage(`
        const s = window.__vehicles?.status?.();
        const spd = s?.pilot?.state?.speed ?? s?.vehicles?.find((x) => x.guid === ${rig.v.guid})?.speed ?? s?.vehicles?.[0]?.speed;
        return Number.isFinite(spd) && Math.abs(spd) < 0.25;
      `);
    }, 4000, 100, "tractor stopped before reverse");
    await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);

    const tRev0 = Date.now();
    let aligned = false;
    while (Date.now() - tRev0 < 8000) {
      const snap = await live.evalInPage(`
        const v = (window.__vehicles?.vehicles?.() || []).find((x) => x.guid === ${rig.v.guid});
        const t = window.__vehicles?.trailers?.get(${rig.t.guid});
        const st = window.__vehicles?.status?.();
        if (!v || !t) return null;
        const vSt = st?.vehicles?.find((x) => x.guid === ${rig.v.guid});
        const gmPos = window.__vehicles?.groundModels?.get?.(${rig.v.guid})?.root?.position;
        const pState = (st?.pilot?.vehicle === undefined || st?.pilot?.vehicle === ${rig.v.guid}) ? st?.pilot?.state : null;
        const vx = pState?.x ?? vSt?.pos?.x ?? gmPos?.x;
        const vy = pState?.y ?? vSt?.pos?.y ?? gmPos?.y;
        const vh = pState?.heading ?? vSt?.pos?.heading ?? v.last?.heading;
        if (!Number.isFinite(vx) || !Number.isFinite(vy) || !Number.isFinite(vh)) return null;
        const fwX = vx + Math.sin(vh) * (-2.01);
        const fwY = vy + Math.cos(vh) * (-2.01);
        const mPos = t.model?.root?.position;
        let tPos = Array.isArray(t.worldPos) && t.worldPos.length >= 2
          ? t.worldPos
          : (mPos && Number.isFinite(mPos.x) && Number.isFinite(mPos.y) ? [mPos.x, mPos.y, mPos.z ?? 0] : null);
        if (!tPos && t.last && Number.isFinite(t.last.cell) && Array.isArray(t.last.position)) {
          const c = t.last.cell >>> 0;
          const isDericost = ((c >>> 15) & 1) === 1;
          tPos = [((c >>> 24) & 0xff) * 192 + t.last.position[0], (isDericost ? 68928 : 0) + ((c >>> 16) & 0xff) * 192 + t.last.position[1], t.last.position[2] ?? 0];
        }
        if (!tPos || !Number.isFinite(tPos[0]) || !Number.isFinite(tPos[1])) return null;
        const th = t.last?.heading ?? t.heading ?? 0;
        const kpX = tPos[0] + Math.sin(th) * 5.35;
        const kpY = tPos[1] + Math.cos(th) * 5.35;
        const along = (fwX - kpX) * Math.sin(th) + (fwY - kpY) * Math.cos(th);
        return { fwDist: Math.hypot(fwX - kpX, fwY - kpY), along, vh, th };
      `);
      if (snap && snap.fwDist <= 2.5) {
        aligned = true;
        break;
      }
      const err = snap ? angleDiff(snap.th, snap.vh) : 0;
      const yaw = Math.max(-0.5, Math.min(0.5, -err));
      const thr = snap && snap.along < -0.5 ? 0.35 : -0.45;
      await live.evalInPage(`window.__vehicles.setSticks({ throttle: ${thr}, yaw: ${yaw} }, 300); return true;`);
      await new Promise((r) => setTimeout(r, 150));
    }
    await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0, handbrake: true }, 400); return true;`);
    await new Promise((r) => setTimeout(r, 450));
    await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);
    assert(aligned, "closed-loop reverse failed to bring fifth wheel within 2.5 m of kingpin");

    // Re-hitch via real KeyG KeyboardEvent
    await live.evalInPage(DISPATCH_KEY_G_JS);
    const rehitched = await waitUntil(async () => {
      return await live.evalInPage(`
        const t = window.__vehicles.trailers.get(${rig.t.guid});
        if (!t) return null;
        const coupled = t.coupledTractorGuid ?? t.last?.coupledTractorGuid ?? 0;
        const gearRet = t.model?.landingGearRetracted ?? t.landingGearRetracted ?? (((t.last?.trailerFlags ?? 0) & 0x04) !== 0);
        return (coupled === ${rig.v.guid} && gearRet === true) ? { coupled, landingGearRetracted: gearRet } : null;
      `);
    }, 8000, 200, "trailer re-hitched with landing gear retracted");
    assert(rehitched.landingGearRetracted === true, "landing gear must retract (true) after KeyG re-hitch");

    await live.evalInPage(`window.__vehicles.exit(0); return true;`).catch(() => {});
    await live.cleanupWorld();
  });

  // Scenario 4: @trailer spawn 40 + @container spawn 40hc + @trailer mount + door lock moving vs parked
  await collector.checkLive("T4.S04", 4, "Scenario:Container_Mount_DoorLock_Moving_vs_Parked", async (live) => {
    await live.cleanupWorld();
    await live.sendChatAndWait("@vehicle spawn semi", /Ironhorse 379|spawned/i, 10000);
    await live.sendChatAndWait("@trailer spawn 40", /trailer|4000031|spawned/i, 10000);
    await live.sendChatAndWait("@container spawn 40hc", /container|4000022|spawned/i, 10000);

    const ids = await waitUntil(async () => {
      return await live.evalInPage(`
        const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = (window.__vehicles?.trailers?.list?.() || [])[0];
        const c = (window.__vehicles?.containers?.list?.() || [])[0];
        return v && t && c ? { vGuid: v.guid, tGuid: t.guid, cGuid: c.guid } : null;
      `);
    }, 10000, 250, "semi + trailer + 40hc");

    await live.sendChatAndWait(`@trailer mount 0x${ids.cGuid.toString(16)}`, /mount|twistlock/i, 8000);
    await live.sendChatAndWait("@trailer hitch", /hitch|coupled/i, 8000);

    await live.evalInPage(`window.__vehicles.board(${ids.vGuid}, 0); return true;`);
    await waitUntil(async () => await live.evalInPage(`return !!window.__vehicles?.piloting`), 6000, 150, "piloting");
    await live.evalInPage(`window.__vehicles.setSticks({ throttle: 0.7 }, 2600); return true;`);
    await waitUntil(async () => {
      return await live.evalInPage(`
        const s = window.__vehicles?.status?.();
        const srvSpd = s?.pilot?.server?.speed ?? 0;
        return Math.abs(srvSpd) > 0.5;
      `);
    }, 4000, 100, "tractor moving on server before door check");
    await live.sendChat(`@container doors 0x${ids.cGuid.toString(16)} open`);
    await new Promise((r) => setTimeout(r, 900));
    await live.evalInPage(`window.__vehicles.clearSticks(); return true;`);

    const doorMoving = await live.evalInPage(`
      const c = window.__vehicles.containers.get(${ids.cGuid});
      return c ? { doorState: c.last?.doorState ?? c.doorState ?? 0, doorProgress: c.currentDoorProgress ?? 0 } : null;
    `);
    assert(doorMoving && doorMoving.doorState === 0 && doorMoving.doorProgress < 0.05, `mounted container doors must stay closed while moving, got ${JSON.stringify(doorMoving)}`);

    // Stop, unmount, and verify container doors CAN open after parking & unmounting
    await waitUntil(async () => {
      return await live.evalInPage(`
        const s = window.__vehicles?.status?.();
        const spd = s?.pilot?.state?.speed ?? s?.vehicles?.find((x) => x.guid === ${ids.vGuid})?.speed ?? s?.vehicles?.[0]?.speed;
        return Number.isFinite(spd) && Math.abs(spd) < 0.2;
      `);
    }, 5000, 150, "tractor parked before unmount");
    await live.sendChatAndWait("@trailer unmount", /unmount/i, 8000);
    await live.sendChatAndWait(`@container doors 0x${ids.cGuid.toString(16)} open`, /door|open/i, 8000).catch(() => {});
    const doorOpened = await waitUntil(async () => {
      return await live.evalInPage(`
        const c = window.__vehicles.containers.get(${ids.cGuid});
        if (!c) return null;
        const st = c.last?.doorState ?? c.doorState ?? 0;
        const prog = c.currentDoorProgress ?? 0;
        return (st !== 0 || prog > 0.1) ? { doorState: st, doorProgress: prog } : null;
      `);
    }, 8000, 200, "container doors opening after unmount");
    assert(doorOpened.doorState !== 0 || doorOpened.doorProgress > 0.1, `container doors should open after unmount, got ${JSON.stringify(doorOpened)}`);

    await live.evalInPage(`window.__vehicles.exit(0); return true;`).catch(() => {});
    await live.cleanupWorld();
  });

  // Scenario 5: Camera cycling (chase / cockpit / hood), despawn auto-unhitch, HUD-hidden shot, console 0 errors
  await collector.checkLive("T4.S05", 4, "Scenario:CameraCycle_DespawnAutoUnhitch_ConsoleZero", async (live) => {
    await live.cleanupWorld();
    await live.sendChatAndWait("@trailer preset rig40hc", /rig40hc|Ironhorse|spawned/i, 10000);
    const rig = await waitUntil(async () => {
      return await live.evalInPage(`
        const v = (window.__vehicles?.vehicles?.() || []).find((x) => (x.profileKey ?? x.profile?.profileKey) === "semi-379");
        const t = (window.__vehicles?.trailers?.list?.() || [])[0];
        return v && t ? { v: { guid: v.guid }, t: { guid: t.guid } } : null;
      `);
    }, 10000, 250, "rig40hc for camera/despawn check");

    await live.evalInPage(`window.__vehicles.board(${rig.v.guid}, 0); return true;`);
    await waitUntil(async () => await live.evalInPage(`return !!window.__vehicles?.piloting`), 6000, 150, "piloting");

    for (const view of ["chase", "hood", "cockpit"]) {
      await live.evalInPage(`window.__vehicles.setView(${JSON.stringify(view)}); return true;`);
      await new Promise((r) => setTimeout(r, 350));
    }

    await live.hideHud();
    await new Promise((r) => setTimeout(r, 250));
    await live.captureAndVerifyShot("t4_s05_cab_view");
    await live.showHud();

    // Despawn tractor while coupled -> trailer remains safely unhitched on terrain
    await live.sendChat("@vehicle despawn");
    await waitUntil(async () => {
      return await live.evalInPage(`
        const t = window.__vehicles.trailers.get(${rig.t.guid});
        return t && ((t.coupledTractorGuid ?? t.last?.coupledTractorGuid ?? 0) === 0);
      `);
    }, 8000, 250, "trailer auto-unhitched after tractor despawn");

    await live.cleanupWorld();

    const { failing } = await live.checkConsoleErrors();
    assert(failing.length === 0, `Non-allowlisted console/page errors detected (${failing.length}): ${failing.slice(0, 5).join(" | ")}`);
  });
}
