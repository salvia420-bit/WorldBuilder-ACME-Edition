// ui/attack_power_bar.js — retail hold-to-charge attack power bar (2026-10-07).
//
// Retail `ClientCombatSystem` (acclient.c), basic (non-"advanced") combat UI:
//
//   PRESS a High / Medium / Low attack — `HandleCombatAction` →
//     `SetRequestedAttackHeight` (:409431) → `StartAttackRequest` (:408917):
//     `requestedAttackPower = 1.0`, `MaybeStopCompletely`, and
//     `AttemptStartBuildingAttack` (:408597) starts the bar:
//     `buildStartTime = now`.
//   BUILD — `GetPowerBarLevel` (:407919): (now − buildStartTime) / 1.0 s,
//     or / 0.8 s in DualWieldCombat, clamped to [0, 1].
//   RELEASE — `EndAttackRequest(height, USE_POWER_BAR_LEVEL)` (:408952):
//     `requestedAttackPower = max(m_rUIRequestedPower, bar)` (the slider is
//     `m_rUIRequestedPower`). The attack fires NOW when the bar has reached
//     the slider; if the bar went PAST it, a second request follows at the
//     slider's power. Otherwise the bar keeps building and `UseTime`
//     (:409015) fires once it reaches the slider.
//
// So a quick click / key tap attacks at whatever the selector (the slider
// thumb) is set to — after the bar has filled up to it — while holding the
// button charges the swing past the selector; release fires at the charged
// level. The trade-off is retail's: a lower power is a faster attack.
//
// The second request maps onto ACE's `AttackQueue` (Entity/AttackQueue.cs):
// every TargetedMelee/MissileAttack enqueues its power and each auto-repeat
// swing `Fetch()`es the newest, so the charged swing goes out at the charged
// power and the repeats fall back to the selector — exactly retail.
//
// Pure helpers + a small controller; the DOM (plugins/combat-hud.js,
// plugins/combat-bar.js) only forwards press / release and paints `level`.

export const POWER_BAR_FULL_SECONDS = 1.0;
export const POWER_BAR_FULL_SECONDS_DUAL_WIELD = 0.8;
// `fabs(a - b) > 0.0099999998` — the retail power-difference test
// (`HandleAttackDoneEvent`, acclient.c:409225).
export const POWER_EPSILON = 0.0099999998;
// DualWieldCombat style 0x80000046 (acclient.c:407919) — low word.
const STANCE_DUAL_WIELD_LOW = 0x46;

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** `GetPowerBarLevel` — the build level after `elapsedMs` of holding. */
export function powerBarLevel(elapsedMs, fullSeconds = POWER_BAR_FULL_SECONDS) {
  const ms = Number(elapsedMs);
  if (!(ms > 0)) return 0;
  const full = Number(fullSeconds) > 0 ? Number(fullSeconds) : POWER_BAR_FULL_SECONDS;
  return clamp01(ms / (full * 1000));
}

/**
 * `EndAttackRequest(height, USE_POWER_BAR_LEVEL)` on the basic UI.
 * @returns {{fireNow: boolean, power: number, followUpPower: number|null}}
 *   `fireNow` false = keep building until the bar reaches `power` (the slider).
 */
export function decideRelease(bar, slider) {
  const b = clamp01(bar);
  const s = clamp01(slider);
  if (b + 1e-9 >= s) {
    return { fireNow: true, power: b, followUpPower: b - s > POWER_EPSILON ? s : null };
  }
  return { fireNow: false, power: s, followUpPower: null };
}

/**
 * The press → build → release state machine.
 *
 * @param {object} deps
 * @param {() => number} deps.now                     ms clock
 * @param {(height:number, power:number, opts?:{followUp?:boolean}) => void} deps.fire
 * @param {() => number} deps.getSlider               the selector, 0..1
 * @param {() => boolean} [deps.isDualWield]
 * @param {() => boolean} [deps.isReady]              still in a melee/missile stance
 * @param {(s:{building:boolean, level:number, released:boolean, height:number}) => void} [deps.publish]
 * @param {(cb:Function) => any} [deps.raf]           frame scheduler (rAF)
 */
export function createAttackCharge(deps) {
  const now = deps.now;
  const isDualWield = deps.isDualWield || (() => false);
  const isReady = deps.isReady || (() => true);
  const publish = deps.publish || (() => {});
  const raf = deps.raf || null;
  let st = null; // { height, startMs, released }
  let frameQueued = false;

  const fullSeconds = () => (isDualWield() ? POWER_BAR_FULL_SECONDS_DUAL_WIELD : POWER_BAR_FULL_SECONDS);
  const level = () => (st ? powerBarLevel(now() - st.startMs, fullSeconds()) : 0);
  const snapshot = () => ({
    building: !!st,
    level: level(),
    released: !!st?.released,
    height: st ? st.height : 0,
  });
  const schedule = () => {
    if (!raf || frameQueued || !st) return;
    frameQueued = true;
    raf(() => {
      frameQueued = false;
      api.tick();
    });
  };
  const finish = () => {
    st = null;
    publish(snapshot());
  };

  const api = {
    /** Key / button DOWN for `height` (1 High, 2 Medium, 3 Low). */
    press(height) {
      if (st) {
        // Retail SetRequestedAttackHeight while a request is open: the
        // height changes, the build carries on.
        st.height = height;
        publish(snapshot());
        return;
      }
      st = { height, startMs: now(), released: false };
      publish(snapshot());
      schedule();
    },
    /** Key / button UP. A release for a different height than the one
     *  building (two keys held) is ignored. */
    release(height) {
      if (!st || st.released) return;
      if (height != null && height !== st.height) return;
      const slider = clamp01(deps.getSlider());
      const d = decideRelease(level(), slider);
      if (!d.fireNow) {
        st.released = true;
        publish(snapshot());
        schedule();
        return;
      }
      const h = st.height;
      finish();
      deps.fire(h, d.power);
      if (d.followUpPower != null) deps.fire(h, d.followUpPower, { followUp: true });
    },
    /** Per-frame `UseTime`: repaint; a released build fires on reaching the slider. */
    tick() {
      if (!st) return;
      if (!isReady()) {
        // Retail cancels the request once the player leaves the ready
        // position (stance change, death).
        finish();
        return;
      }
      const slider = clamp01(deps.getSlider());
      if (st.released && level() + 1e-9 >= slider) {
        const h = st.height;
        finish();
        deps.fire(h, slider);
        return;
      }
      publish(snapshot());
      schedule();
    },
    cancel() {
      if (st) finish();
    },
    get building() { return !!st; },
    get level() { return level(); },
    get height() { return st ? st.height : 0; },
  };
  return api;
}

let _shared = null;

/** The page's one controller, wired to picking.js `__fireAttackOnTarget`. */
export function getAttackCharge() {
  if (_shared) return _shared;
  const listeners = new Set();
  const stanceLow = () => {
    try { return (window.__getCurrentStanceLow?.() ?? 0) & 0xffff; } catch (_) { return 0; }
  };
  _shared = createAttackCharge({
    now: () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now()),
    fire: (height, power, opts) => {
      try { window.__fireAttackOnTarget?.(height, power, opts); } catch (e) {
        console.warn(`[attack-power-bar] fire failed: ${e?.message ?? e}`);
      }
    },
    getSlider: () => {
      const v = Number(window.__combatBarState?.powerLevel);
      return Number.isFinite(v) ? v : 1.0;
    },
    isDualWield: () => stanceLow() === STANCE_DUAL_WIELD_LOW,
    isReady: () => {
      const low = stanceLow();
      // Peace 0x3D / Magic 0x49 / no stance — not an attack stance.
      return low !== 0 && low !== 0x3d && low !== 0x49;
    },
    publish: (s) => {
      try { window.__attackCharge = s; } catch (_) { /* diag only */ }
      for (const fn of listeners) { try { fn(s); } catch (_) { /* a painter must not wedge */ } }
    },
    raf: (cb) => (typeof requestAnimationFrame === "function" ? requestAnimationFrame(cb) : setTimeout(cb, 16)),
  });
  _shared.onChange = (fn) => {
    listeners.add(fn);
    return () => listeners.delete(fn);
  };
  return _shared;
}
