// lib/bench-url.mjs — the last step of every bench / probe driver's index.html
// URL (2026-10-20, improvement hunt recent-rynth-diff-1).
//
// The page's runtime frame cap (the VTank options EnableFPSLimit /
// TargetFPSFocused / TargetFPSBackground — 60 fps focused, 30 in the
// background — plugins/rynth-vt/display.js → apps/holtburger-web/scene3d/
// frame_cap.js) is ON page-wide for every player, by owner decision. Its two
// measurement exemptions do not hold for these drivers:
//   - "automation" is navigator.webdriver, and the 1070's test Chrome is started
//     with only --remote-debugging-port (box/hbbench-launch.bat,
//     hbprobe-launch.bat), so it reads false;
//   - "a window nobody ever focused" is document.hasFocus(), and Playwright's
//     connectOverCDP sends Emulation.setFocusEmulationEnabled {enabled: true}
//     for every page it attaches to (playwright-core 1.59.1
//     lib/server/chromium/crPage.js:418), so it reads true from the first frame.
// So every arm would run held at 60 fps (about 73 under hbbench's uncapped
// vsync-off launch). `?targetFps=0` is the page's explicit uncapped pin: the
// policy never applies on that page (frame_cap.js urlNamesFrameCap) and the
// loop stays bare rAF. Every driver passes its URL through here; a caller that
// already names targetFps (an arm that benches a cap on purpose) keeps its own.

/** `url` with `targetFps=0` appended unless its query already names targetFps.
 *  The rest of the URL is kept byte for byte (no re-encoding). */
export function uncappedBenchUrl(url) {
  const s = String(url);
  const hashAt = s.indexOf("#");
  const head = hashAt < 0 ? s : s.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : s.slice(hashAt);
  const q = head.indexOf("?");
  if (q >= 0 && new URLSearchParams(head.slice(q + 1)).has("targetFps")) return s;
  const sep = q < 0 ? "?" : /[?&]$/.test(head) ? "" : "&";
  return `${head}${sep}targetFps=0${hash}`;
}
