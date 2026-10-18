// scene3d/film/runtime/clean_frame.js — HUD-free, input-locked film frame (SPEC §3.3).
//
// WHY: film footage is the canvas and nothing else, and nothing a person (or a
// stray synthetic event) does may move the camera or the hidden player during
// a take. The boot URL already carries `agent=1&hud=none&plugins=none` (canvas
// sizing latches at boot), but recon_hud found what survives it:
//   * DOM: the canvas keeps `border:1px solid #ccc; image-rendering:pixelated;
//     cursor:grab` (compositor screenshots show the border; supersampled
//     buffers are downscaled nearest-neighbour), every `hb-*` HUD is only
//     hidden by CSS, the selection brackets are re-shown by agent mode;
//   * in-canvas: speech/emote bubbles are THREE.Sprites with no flag at all,
//     nameplate sprites (opt-in), the selection, the 2 m "hello cube";
//   * input: the keyboard funnel (movement, C mode cycle, hotbar …) and — NOT
//     through it — right-drag mouselook, wheel zoom, OrbitControls, picking
//     clicks (a double-click can Use a portal), the hover tooltip, F-keys.
// So apply(): film CSS in `<style id="film-clean-css">` (+ `html.film-clean`),
// deselect + brackets off, bubbles suppressed for the take (the kind=55 handler
// looks `entityManager.showSpeechBubble` up on every event, so an own-property
// no-op wrapper suppresses new ones; live ones are disposed), nameplate sprites
// and the hello cube hidden, and the input lock: `__inputFunnel.releaseHeld
// ("film")` then `poison("gate")`, window CAPTURE-phase blockers (the earliest
// dispatch point; `wheel` with passive:false so preventDefault works) for
// key*/pointer*/mouse*/click/dblclick/auxclick/contextmenu/wheel/touch*/
// dragstart/drop, `cameraSwitcher._endFollowDrag?.()` and zeroed
// `cameraSwitcher.keys`. restore() undoes every step from saved originals.
// Both are idempotent.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: dependencies injected
// ({document, window, liveScene3d, log}); never imports a stateful scene3d module.

/** id of the injected film stylesheet. */
export const FILM_CLEAN_STYLE_ID = "film-clean-css";
/** Class added to `<html>` while the clean frame is on. */
export const FILM_CLEAN_CLASS = "film-clean";

/**
 * Events blocked at window capture while the frame is clean.
 * @type {ReadonlyArray<string>}
 */
export const FILM_BLOCKED_EVENTS = Object.freeze([
  "keydown", "keyup", "keypress",
  "pointerdown", "pointerup", "pointermove", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointercancel",
  "gotpointercapture", "lostpointercapture",
  "mousedown", "mouseup", "mousemove", "mouseover", "mouseout", "mouseenter", "mouseleave",
  "click", "dblclick", "auxclick", "contextmenu", "wheel",
  "touchstart", "touchmove", "touchend", "touchcancel",
  "dragstart", "drop",
]);

/**
 * The film stylesheet (scoped to `html.film-clean`): no cursor anywhere, a
 * borderless, smoothly scaled canvas, and every overlay / HUD layer hidden.
 */
export const FILM_CLEAN_CSS = [
  "html.film-clean, html.film-clean * { cursor: none !important; }",
  "html.film-clean #canvas, html.film-clean #stage canvas {",
  "  border: 0 !important; outline: none !important; image-rendering: auto !important; cursor: none !important;",
  "}",
  "html.film-clean #selection-brackets-3d, html.film-clean #nameplate-layer-3d,",
  "html.film-clean body > [id^=\"hb-\"], html.film-clean .hb-bar, html.film-clean .hb-pill, html.film-clean .hb-panel,",
  "html.film-clean #stage > *:not(#canvas-column), html.film-clean #canvas-column > *:not(#canvas) {",
  "  display: none !important;",
  "}",
].join("\n");

/**
 * Create the clean-frame controller (SPEC §3.3).
 *
 * - `apply({bubbles=false})` → `{ok, already, steps}`: everything above;
 *   `bubbles: true` keeps speech bubbles (dialogue shots). Idempotent.
 * - `restore()` → `{ok, wasActive}`: removes the stylesheet / class / blockers,
 *   restores the funnel's previous poison state (unpoison when it was open),
 *   the showSpeechBubble method, the selection, the bracket display state, the
 *   nameplate sprites and the hello cube. Idempotent.
 * - `active` (getter), `state()` → JSON-safe status (blocked event count, …).
 *
 * @param {{document?:object|null, window?:object|null, liveScene3d?:object|null,
 *   log?:(entry:object)=>void}} deps
 * @returns {{apply:Function, restore:Function, active:boolean, state:Function}}
 */
export function createCleanFrame(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const doc = d.document !== undefined ? d.document : (typeof document !== "undefined" ? document : null);
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const liveOf = () => {
    if (d.liveScene3d && typeof d.liveScene3d === "object") return d.liveScene3d;
    const l = win && win.liveScene3d;
    return l && typeof l === "object" ? l : null;
  };
  const emit = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-clean-frame", ...entry });
    } catch (_) {
      /* never break the frame on a logger */
    }
  };

  let active = false;
  /** @type {null|object} */
  let saved = null;
  let blockedCount = 0;
  let suppressedBubbles = 0;

  /** The capture-phase blocker shared by every event type. */
  const blocker = (ev) => {
    blockedCount += 1;
    try {
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
      else if (typeof ev.stopPropagation === "function") ev.stopPropagation();
    } catch (_) {
      /* a frozen event */
    }
    try {
      if (ev.cancelable !== false && typeof ev.preventDefault === "function") ev.preventDefault();
    } catch (_) {
      /* passive listener */
    }
  };
  const listenerOpts = (type) => (type === "wheel" || type.startsWith("touch")
    ? { capture: true, passive: false }
    : { capture: true });

  /** Run one step, recording failures without aborting the rest. */
  function attempt(steps, name, fn) {
    try {
      const r = fn();
      steps[name] = r === undefined ? true : r;
    } catch (e) {
      steps[name] = { ok: false, error: String(e && e.message ? e.message : e) };
      emit({ level: "warn", step: name, message: steps[name].error });
    }
  }

  function apply(opts = {}) {
    if (active) return { ok: true, already: true, steps: {} };
    const o = opts && typeof opts === "object" ? opts : {};
    const live = liveOf();
    const em = live && live.entityManager && typeof live.entityManager === "object" ? live.entityManager : null;
    const cs = live && live.cameraSwitcher && typeof live.cameraSwitcher === "object" ? live.cameraSwitcher : null;
    saved = {
      style: null,
      htmlClassAdded: false,
      funnel: null,
      blockers: false,
      bubble: null,
      selection: null,
      brackets: null,
      nameplates: [],
      helloCube: null,
    };
    const steps = {};

    // 1. Film CSS + html class.
    attempt(steps, "css", () => {
      if (!doc) return { ok: false, skipped: "no document" };
      let style = typeof doc.getElementById === "function" ? doc.getElementById(FILM_CLEAN_STYLE_ID) : null;
      if (!style && typeof doc.createElement === "function") {
        style = doc.createElement("style");
        style.id = FILM_CLEAN_STYLE_ID;
        style.textContent = FILM_CLEAN_CSS;
        const parent = doc.head || doc.documentElement || doc.body;
        if (parent && typeof parent.appendChild === "function") parent.appendChild(style);
        saved.style = style;
      }
      const cl = doc.documentElement && doc.documentElement.classList;
      if (cl && typeof cl.add === "function" && !(typeof cl.contains === "function" && cl.contains(FILM_CLEAN_CLASS))) {
        cl.add(FILM_CLEAN_CLASS);
        saved.htmlClassAdded = true;
      }
      return true;
    });

    // 2. Input lock: funnel release + poison.
    attempt(steps, "funnel", () => {
      const f = win && win.__inputFunnel;
      if (!f || typeof f !== "object") return { ok: false, skipped: "no window.__inputFunnel" };
      let prevFault = null;
      try {
        if (typeof f.snapshot === "function") prevFault = f.snapshot().fault ?? null;
        else if ("_fault" in f) prevFault = f._fault ?? null;
      } catch (_) {
        prevFault = null;
      }
      let released = [];
      if (typeof f.releaseHeld === "function") released = f.releaseHeld("film") || [];
      if (typeof f.poison === "function") f.poison("gate");
      saved.funnel = { ref: f, prevFault };
      return { ok: true, released: Array.isArray(released) ? released.length : 0 };
    });

    // 3. Window capture-phase blockers.
    attempt(steps, "blockers", () => {
      if (!win || typeof win.addEventListener !== "function") return { ok: false, skipped: "no window" };
      for (const type of FILM_BLOCKED_EVENTS) win.addEventListener(type, blocker, listenerOpts(type));
      saved.blockers = true;
      return { ok: true, events: FILM_BLOCKED_EVENTS.length };
    });

    // 4. Camera input state: end a held right-drag, zero the keystate.
    attempt(steps, "cameraInput", () => {
      if (!cs) return { ok: false, skipped: "no cameraSwitcher" };
      if (typeof cs._endFollowDrag === "function") cs._endFollowDrag();
      if (cs.keys && typeof cs.keys === "object") for (const k of Object.keys(cs.keys)) cs.keys[k] = false;
      return true;
    });

    // 5. Selection + brackets.
    attempt(steps, "selection", () => {
      if (!em || typeof em.setSelectedTarget !== "function") return { ok: false, skipped: "no entityManager.setSelectedTarget" };
      const prev = typeof em.getSelectedTarget === "function" ? (em.getSelectedTarget() >>> 0) : 0;
      em.setSelectedTarget(0);
      saved.selection = { prev };
      return true;
    });
    attempt(steps, "brackets", () => {
      const layer = live && live.selectionBracketLayer;
      if (!layer || typeof layer.setDisplayOn !== "function") return { ok: false, skipped: "no selectionBracketLayer" };
      saved.brackets = { layer, prev: layer._displayOn !== false };
      layer.setDisplayOn(false);
      return true;
    });

    // 6. Speech bubbles: suppress new ones, dispose live ones.
    if (o.bubbles !== true) {
      attempt(steps, "bubbles", () => {
        if (!em) return { ok: false, skipped: "no entityManager" };
        const hadOwn = Object.prototype.hasOwnProperty.call(em, "showSpeechBubble");
        const prev = em.showSpeechBubble;
        const wrapper = function filmSuppressedSpeechBubble() {
          suppressedBubbles += 1;
        };
        em.showSpeechBubble = wrapper;
        saved.bubble = { em, hadOwn, prev, wrapper };
        let removed = 0;
        const map = em.entityMap;
        if (map && typeof map.values === "function") {
          for (const inst of map.values()) if (disposeBubble(inst)) removed += 1;
        }
        return { ok: true, removed };
      });
    }

    // 7. Nameplate sprites + the hello cube. With ?nameplates=on, nameplate_sprite.js's own
    // rAF LOD rewrites `.visible` of the nearest sprites every frame, so each sprite is also
    // taken off every camera layer (layers.mask 0): the renderer skips it whatever the LOD sets.
    attempt(steps, "nameplates", () => {
      const map = em && em.entityMap;
      if (!map || typeof map.values !== "function") return { ok: false, skipped: "no entityMap" };
      let n = 0;
      for (const inst of map.values()) {
        if (!inst || typeof inst !== "object") continue;
        for (const key of ["_nameplateSprite", "_buffBadgeSprite"]) {
          const s = inst[key];
          if (!s || typeof s !== "object") continue;
          const entry = { obj: s };
          if (s.layers && Number.isInteger(s.layers.mask) && s.layers.mask !== 0) {
            entry.mask = s.layers.mask;
            s.layers.mask = 0;
          }
          if (s.visible !== false) {
            entry.visible = s.visible;
            s.visible = false;
          }
          if (entry.mask === undefined && entry.visible === undefined) continue;
          saved.nameplates.push(entry);
          n += 1;
        }
      }
      return { ok: true, hidden: n };
    });
    attempt(steps, "helloCube", () => {
      const cube = live && live.helloCube;
      if (!cube || typeof cube !== "object") return { ok: false, skipped: "no helloCube" };
      saved.helloCube = { obj: cube, visible: cube.visible };
      cube.visible = false;
      return true;
    });

    active = true;
    emit({ message: "applied" });
    return { ok: true, already: false, steps };
  }

  function restore() {
    if (!active || !saved) return { ok: true, wasActive: false };
    const s = saved;
    const steps = {};
    attempt(steps, "blockers", () => {
      if (s.blockers && win && typeof win.removeEventListener === "function") {
        for (const type of FILM_BLOCKED_EVENTS) win.removeEventListener(type, blocker, listenerOpts(type));
      }
      return true;
    });
    attempt(steps, "funnel", () => {
      if (!s.funnel) return true;
      const f = s.funnel.ref;
      if (s.funnel.prevFault === null || s.funnel.prevFault === undefined) {
        if (typeof f.unpoison === "function") f.unpoison();
      } else if (typeof f.poison === "function") {
        f.poison(s.funnel.prevFault);
      }
      return true;
    });
    attempt(steps, "css", () => {
      if (s.style && s.style.parentNode && typeof s.style.parentNode.removeChild === "function") s.style.parentNode.removeChild(s.style);
      else if (s.style && typeof s.style.remove === "function") s.style.remove();
      if (s.htmlClassAdded && doc && doc.documentElement && doc.documentElement.classList) doc.documentElement.classList.remove(FILM_CLEAN_CLASS);
      return true;
    });
    attempt(steps, "bubbles", () => {
      const b = s.bubble;
      if (!b) return true;
      if (b.em.showSpeechBubble === b.wrapper) {
        if (b.hadOwn) b.em.showSpeechBubble = b.prev;
        else delete b.em.showSpeechBubble;
      }
      return true;
    });
    attempt(steps, "brackets", () => {
      if (s.brackets) s.brackets.layer.setDisplayOn(s.brackets.prev);
      return true;
    });
    attempt(steps, "selection", () => {
      const live = liveOf();
      const em = live && live.entityManager;
      if (s.selection && s.selection.prev && em && typeof em.setSelectedTarget === "function") em.setSelectedTarget(s.selection.prev);
      return true;
    });
    attempt(steps, "nameplates", () => {
      for (const n of s.nameplates) {
        if (n.mask !== undefined) n.obj.layers.mask = n.mask;
        if (n.visible !== undefined) n.obj.visible = n.visible;
      }
      return true;
    });
    attempt(steps, "helloCube", () => {
      if (s.helloCube) s.helloCube.obj.visible = s.helloCube.visible;
      return true;
    });
    active = false;
    saved = null;
    emit({ message: "restored" });
    return { ok: true, wasActive: true, steps };
  }

  return {
    apply,
    restore,
    get active() {
      return active;
    },
    state: () => ({
      active,
      blockedEvents: blockedCount,
      suppressedBubbles,
      funnelPoisoned: !!(saved && saved.funnel),
      blockers: !!(saved && saved.blockers),
      bubblesSuppressed: !!(saved && saved.bubble),
    }),
  };
}

/**
 * Dispose an entity's live speech bubble exactly like speech_bubble.js
 * `removeSpeechBubbleFromEntity` (detach, dispose texture + material, clear the slot).
 * @param {object} inst
 * @returns {boolean} true when a bubble was removed
 */
function disposeBubble(inst) {
  if (!inst || typeof inst !== "object" || !inst._speechBubble) return false;
  const sprite = inst._speechBubble;
  try {
    if (sprite.parent && typeof sprite.parent.remove === "function") sprite.parent.remove(sprite);
  } catch (_) {
    /* already detached */
  }
  try {
    if (sprite.material && sprite.material.map && typeof sprite.material.map.dispose === "function") sprite.material.map.dispose();
  } catch (_) {
    /* already disposed */
  }
  try {
    if (sprite.material && typeof sprite.material.dispose === "function") sprite.material.dispose();
  } catch (_) {
    /* already disposed */
  }
  inst._speechBubble = null;
  return true;
}
