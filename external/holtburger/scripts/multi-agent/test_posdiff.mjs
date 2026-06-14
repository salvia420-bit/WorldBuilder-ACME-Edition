import { diffObjects } from "./posdiff.mjs";
let pass = 0, fail = 0;
const eq = (name, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); console.log(`${ok ? "PASS" : "FAIL"} ${name}` + (ok ? "" : `  got=${JSON.stringify(got)} want=${JSON.stringify(want)}`)); ok ? pass++ : fail++; };
const M = 0x2000111;

// 1) Stacked same-model (the v1 false-MISPLACED signature: identical XY, two floors).
//    XY-only nearest would mis-pair across floors; 3D 1:1 must match both cleanly.
eq("stacked-2-floors",
  diffObjects([[M, 100, 100, 0], [M, 100, 100, 4]], [{ m: M, p: [100, 100, 4] }, { m: M, p: [100, 100, 0] }]),
  { matched: 2, nr: 0, roof: [], moved: [] });

// 2) Four stacked identical (the 344f case: 4× same model, dz~-6 false positives).
eq("stacked-4",
  diffObjects(
    [[M, 50, 50, 0], [M, 50, 50, 3], [M, 50, 50, 6], [M, 50, 50, 9]],
    [{ m: M, p: [50, 50, 9] }, { m: M, p: [50, 50, 0] }, { m: M, p: [50, 50, 6] }, { m: M, p: [50, 50, 3] }]),
  { matched: 4, nr: 0, roof: [], moved: [] });

// 3) Genuine roof: one instance lifted >4m -> ROOF (must still be caught).
eq("real-roof",
  diffObjects([[M, 10, 10, 5]], [{ m: M, p: [10, 10, 60] }]),
  { matched: 0, nr: 0, roof: [["0x2000111", 5, 60]], moved: [] });

// 4) Genuine horizontal misplacement: xy off, z same -> MISPLACED.
eq("real-misplaced",
  diffObjects([[M, 0, 0, 0]], [{ m: M, p: [10, 0, 0] }]),
  { matched: 0, nr: 0, roof: [], moved: [["0x2000111", 10, 0]] });

// 5) Not rendered: expected with no rendered partner.
eq("not-rendered",
  diffObjects([[M, 0, 0, 0]], []),
  { matched: 0, nr: 1, roof: [], moved: [] });

// 6) Extra rendered of same model must NOT create a phantom match/roof, and the
//    real one still matches (1:1 leaves the extra unconsumed, exp side is satisfied).
eq("extra-rendered-ignored",
  diffObjects([[M, 0, 0, 0]], [{ m: M, p: [0, 0, 0] }, { m: M, p: [0, 0, 50] }]),
  { matched: 1, nr: 0, roof: [], moved: [] });

// 7) Within-2m tolerance counts as matched (small render jitter).
eq("tolerance",
  diffObjects([[M, 0, 0, 0]], [{ m: M, p: [1, 1, 1] }]),
  { matched: 1, nr: 0, roof: [], moved: [] });

// 8) Two instances, one perfect + one roofed -> exactly one matched, one roof
//    (3D 1:1 must assign the ground rendered to the ground expected first).
eq("mixed-match-and-roof",
  diffObjects([[M, 0, 0, 0], [M, 0, 0, 2]], [{ m: M, p: [0, 0, 0] }, { m: M, p: [0, 0, 90] }]),
  { matched: 1, nr: 0, roof: [["0x2000111", 2, 90]], moved: [] });

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
