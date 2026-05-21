() => {
  const rec = window.__perfRec;
  if (!rec) return { error: "no-recorder" };
  return {
    ok: true,
    frames: rec.frames,
    rendererSnaps: rec.rendererSnaps,
    poseSnaps: rec.poseSnaps,
    longTaskEntries: rec.longTaskEntries,
    consoleLog: rec.consoleLog || [],
  };
}
