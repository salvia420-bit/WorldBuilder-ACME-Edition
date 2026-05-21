() => {
  if (window.__moveLoop && !window.__moveLoop.done) {
    return { error: "already-running" };
  }
  try {
    const el = document.activeElement;
    if (el && el !== document.body && typeof el.blur === "function") el.blur();
  } catch (e) {}

  const fireKey = (key, type) => {
    document.dispatchEvent(new KeyboardEvent(type, {
      key, bubbles: true, cancelable: true,
    }));
  };

  const PATTERN_VERSION = "movement-pattern-v1";
  const pattern = [
    { keys: ["w"],         dur: 6000, label: "fwd"         },
    { keys: ["w", "d"],    dur: 6000, label: "fwd-right"   },
    { keys: ["d"],         dur: 6000, label: "right"       },
    { keys: ["s", "d"],    dur: 6000, label: "back-right"  },
    { keys: ["s"],         dur: 6000, label: "back"        },
    { keys: ["s", "a"],    dur: 6000, label: "back-left"   },
    { keys: ["a"],         dur: 6000, label: "left"        },
    { keys: ["w", "a"],    dur: 6000, label: "fwd-left"    },
    { keys: ["w", "Shift"],dur: 6000, label: "sprint-fwd"  },
    { keys: [],            dur: 6000, label: "idle"        },
  ];
  const totalMs = pattern.reduce((a, b) => a + b.dur, 0);

  const held = new Set();
  const setHeld = (next) => {
    for (const k of Array.from(held)) {
      if (!next.has(k)) { fireKey(k, "keyup"); held.delete(k); }
    }
    for (const k of next) {
      if (!held.has(k)) { fireKey(k, "keydown"); held.add(k); }
    }
  };
  const releaseAll = () => {
    for (const k of Array.from(held)) {
      fireKey(k, "keyup");
      held.delete(k);
    }
  };

  const loop = {
    started: performance.now(),
    patternVersion: PATTERN_VERSION,
    totalMs,
    events: [],
    held,
    done: false,
    abort: false,
    releaseAll,
  };
  window.__moveLoop = loop;

  let idx = 0;
  const step = () => {
    if (loop.abort) { releaseAll(); loop.done = true; return; }
    if (idx >= pattern.length) {
      releaseAll();
      loop.done = true;
      loop.finishedAt = performance.now();
      console.log("[move-loop] done");
      return;
    }
    const seg = pattern[idx++];
    setHeld(new Set(seg.keys));
    loop.events.push({
      t: +(performance.now() - loop.started).toFixed(2),
      label: seg.label,
      keys: seg.keys.slice(),
    });
    setTimeout(step, seg.dur);
  };
  loop.kicker = setTimeout(step, 0);

  console.log("[move-loop] started: " + pattern.length + " segs, " + totalMs + " ms");
  return { ok: true, totalMs, patternVersion: PATTERN_VERSION, segments: pattern.length };
}
