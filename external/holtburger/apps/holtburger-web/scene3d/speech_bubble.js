// scene3d/speech_bubble.js — F17-5: overhead speech bubbles.
//
// Floats a fading text sprite over the 3D speaker when ACE broadcasts a
// near-field chat line (HearSpeech / HearRangedSpeech) or an emote
// (EmoteText / SoulEmote). The wasm recv loop surfaces the SPEAKER guid +
// text on a kind=55 `CLIENT_EVENT_KIND_OVERHEAD_SPEECH` ClientEvent (the
// guid was previously dropped at the wasm→JS boundary, so all speech only
// reached the DOM chat panel — you couldn't tell who in a crowd was
// talking). `EntityManager.showSpeechBubble` resolves the guid to a live
// rig and calls `showSpeechBubbleOnEntity` here.
//
// Anchor + bake mirror `nameplate_sprite.js`: a CanvasTexture →
// SpriteMaterial → THREE.Sprite parented to `inst.root` at a local +Z
// offset (AC Z is up; the worldRoot −π/2 X-rotation puts it above the rig).
// Unlike nameplates these are EPHEMERAL and unique per utterance, so there
// is NO per-text cache — each bubble bakes its own texture/material and
// disposes them when the fade completes (or the speaker re-speaks /
// despawns). One bubble per entity at a time; a new utterance replaces the
// old one.
//
// Entirely opt-in: nothing here runs unless `?speechBubbles=on` gates the
// kind=55 handler (index.html). Render is byte-identical when off.

import * as THREE from "three";

// Sits just above the nameplate (`NAMEPLATE_AC_Z_OFFSET = 2.2`) so the
// two don't overlap when both are present.
const BUBBLE_AC_Z_OFFSET = 3.05;
// Same px/m density as the nameplate bake so text reads at a consistent
// size relative to names.
const BUBBLE_PX_PER_METRE = 128;
const BUBBLE_FONT_PX = 30;
const BUBBLE_LINE_HEIGHT_PX = 38;
const BUBBLE_PAD_X = 18;
const BUBBLE_PAD_Y = 12;
const BUBBLE_MAX_CANVAS_W = 512;
const BUBBLE_MAX_LINES = 5;
// Hold fully opaque, then fade. Long lines linger a touch longer so there
// is time to read them.
const BUBBLE_HOLD_MS = 4500;
const BUBBLE_FADE_MS = 1200;
// Say in white; emotes in a soft violet so "/wave" reads differently from
// spoken words (matches the chat-panel emote colouring intent).
const SPEECH_COLOR = "#ffffff";
const EMOTE_COLOR = "#c7b3ff";

// performance.now() with a Date.now() fallback for the no-perf harness.
function nowMs() {
  try {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now();
    }
  } catch (_) {}
  return 0;
}

// Greedy word-wrap against a measured pixel width. Returns up to
// BUBBLE_MAX_LINES lines; the last is ellipsised if the text overflows.
function wrapLines(ctx, text, maxTextW) {
  const words = String(text).split(/\s+/).filter((w) => w.length > 0);
  const lines = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxTextW || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
      if (lines.length === BUBBLE_MAX_LINES - 1) break;
    }
  }
  if (line && lines.length < BUBBLE_MAX_LINES) lines.push(line);
  // If we broke out early there may be unrendered words — mark the overflow.
  const renderedWords = lines.join(" ").split(/\s+/).filter(Boolean).length;
  if (renderedWords < words.length && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 1 && ctx.measureText(`${last}…`).width > maxTextW) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines.length > 0 ? lines : [""];
}

// Bake the (possibly multi-line) text into a CanvasTexture + SpriteMaterial.
// Returns null in a no-DOM harness. Material is UNIQUE (not cached) so the
// fade loop can mutate its opacity freely and dispose it when done.
function bakeBubble(text, colorHex) {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  ctx.font = `bold ${BUBBLE_FONT_PX}px monospace`;
  const maxTextW = BUBBLE_MAX_CANVAS_W - BUBBLE_PAD_X * 2;
  const lines = wrapLines(ctx, text, maxTextW);

  let widest = 0;
  for (const l of lines) widest = Math.max(widest, ctx.measureText(l).width);
  const canvasWidth = Math.ceil(Math.min(BUBBLE_MAX_CANVAS_W, widest + BUBBLE_PAD_X * 2));
  const canvasHeight = Math.ceil(lines.length * BUBBLE_LINE_HEIGHT_PX + BUBBLE_PAD_Y * 2);
  canvas.width = canvasWidth;
  canvas.height = canvasHeight;

  // Rounded translucent backdrop (matches the nameplate's 0.55 black).
  const pad = 4;
  ctx.fillStyle = "rgba(0, 0, 0, 0.6)";
  if (typeof ctx.roundRect === "function") {
    ctx.beginPath();
    ctx.roundRect(pad, pad, canvasWidth - pad * 2, canvasHeight - pad * 2, 10);
    ctx.fill();
  } else {
    ctx.fillRect(pad, pad, canvasWidth - pad * 2, canvasHeight - pad * 2);
  }

  // Canvas2d state resets on width/height assignment — re-set the font.
  ctx.font = `bold ${BUBBLE_FONT_PX}px monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineWidth = Math.max(2, Math.round(BUBBLE_FONT_PX / 8));
  ctx.strokeStyle = "#000000";
  ctx.lineJoin = "round";
  for (let i = 0; i < lines.length; i++) {
    const cy = BUBBLE_PAD_Y + i * BUBBLE_LINE_HEIGHT_PX + BUBBLE_LINE_HEIGHT_PX / 2;
    ctx.strokeText(lines[i], canvasWidth / 2, cy);
    ctx.fillStyle = colorHex;
    ctx.fillText(lines[i], canvasWidth / 2, cy);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    // Match the nameplate "X-ray" choice: depthTest off so the bubble
    // isn't clipped by the speaker's own torso geometry; depthWrite off so
    // overlapping bubbles don't z-fight.
    depthTest: false,
    depthWrite: false,
    toneMapped: false,
  });
  material.name = "speech-bubble";
  return { texture, material, canvasWidth, canvasHeight };
}

// Detach + dispose a bubble sprite's GPU resources. Idempotent.
function disposeBubble(sprite) {
  if (!sprite) return;
  try { sprite.parent && sprite.parent.remove(sprite); } catch (_) {}
  try { sprite.material && sprite.material.map && sprite.material.map.dispose(); } catch (_) {}
  try { sprite.material && sprite.material.dispose(); } catch (_) {}
}

/**
 * Float a fading speech/emote bubble over an entity's rig. Replaces any
 * bubble already showing on the same entity. Self-disposes after the
 * hold+fade window, or early if the entity re-speaks or despawns (the fade
 * loop bails once `inst._speechBubble` no longer points at this sprite).
 *
 * @param {object} inst — EntityInstance with `.root` (THREE.Group).
 * @param {string} text — the spoken words / emote text (no channel prefix).
 * @param {boolean} isEmote — colour + styling hint (emote vs say).
 * @returns {THREE.Sprite | null}
 */
export function showSpeechBubbleOnEntity(inst, text, isEmote) {
  if (!inst || !inst.root || !text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Replace an in-flight bubble on the same entity.
  if (inst._speechBubble) {
    disposeBubble(inst._speechBubble);
    inst._speechBubble = null;
  }

  const baked = bakeBubble(trimmed, isEmote ? EMOTE_COLOR : SPEECH_COLOR);
  if (!baked) return null;

  const sprite = new THREE.Sprite(baked.material);
  sprite.name = "speech_bubble";
  sprite.scale.set(
    baked.canvasWidth / BUBBLE_PX_PER_METRE,
    baked.canvasHeight / BUBBLE_PX_PER_METRE,
    1,
  );
  // Local +Z (AC up) above the nameplate; nudge up for taller multi-line
  // bubbles so the lowest line clears the name band.
  const extraZ = (baked.canvasHeight / BUBBLE_PX_PER_METRE) * 0.5;
  sprite.position.set(0, 0, BUBBLE_AC_Z_OFFSET + extraZ);
  // Above the nameplate (renderOrder 10) so a bubble wins the alpha sort.
  sprite.renderOrder = 11;
  sprite.userData = { speechText: trimmed, isEmote: !!isEmote };

  inst.root.add(sprite);
  inst._speechBubble = sprite;

  // Hold-then-fade via rAF. Guards: if the slot no longer points at this
  // sprite (re-spoke), or the sprite was detached (despawn), bail + dispose.
  const start = nowMs();
  const raf =
    (typeof window !== "undefined" && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : null;
  if (raf) {
    const step = (now) => {
      if (inst._speechBubble !== sprite || !sprite.parent) {
        disposeBubble(sprite);
        return;
      }
      const elapsed = (now || nowMs()) - start;
      if (elapsed >= BUBBLE_HOLD_MS + BUBBLE_FADE_MS) {
        disposeBubble(sprite);
        if (inst._speechBubble === sprite) inst._speechBubble = null;
        return;
      }
      if (elapsed > BUBBLE_HOLD_MS) {
        const f = (elapsed - BUBBLE_HOLD_MS) / BUBBLE_FADE_MS;
        sprite.material.opacity = Math.max(0, 1 - f);
      }
      raf(step);
    };
    raf(step);
  }
  return sprite;
}

/**
 * Tear down an entity's bubble (called from EntityManager.remove so a
 * despawn while a bubble is fading doesn't leak the texture/material).
 */
export function removeSpeechBubbleFromEntity(inst) {
  if (!inst || !inst._speechBubble) return;
  disposeBubble(inst._speechBubble);
  inst._speechBubble = null;
}
