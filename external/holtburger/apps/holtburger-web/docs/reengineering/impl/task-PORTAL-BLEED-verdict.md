# task-PORTAL-BLEED — `punchSidedness` verdict

**VERDICT: SAFE.** The sidedness gate does not break the converse case. Both residual
risks recorded when the flag was flipped ON (`421cdf0a`) and then reverted (`e8a94405`)
are closed by live measurement on a real GPU.

**The default nevertheless stays `off`.** That is a deployment decision, not a doubt about
the verdict — see [Why the default does not move](#why-the-default-does-not-move).

Verdict commit: `26c7cd63` on `orch/s12-portal`.
Instruments: `impl/portal-bleed-harness/{mkprobe,mkaudit}.mjs` (landed `c49bc47e`).
Raw evidence: `impl/portal-bleed-harness/verdict-{adv,audit}-on.txt`.

---

## The question

Prior work PROVED the gate correctly **stops** a punch that must not happen (a window drawn
through a roof). It never proved the gate still **allows** a punch that **must** happen.
Two specific reasons to doubt it were on the table:

1. **The `n-low` row read 8 offered / 0 kept / 8 BACKFACE** — a ground-level camera where
   the gate culled *every* aperture — and nothing adjudicated whether those 8 were
   legitimately far-side or a regression.
2. **The parity claim is in the wrong space.** `portal_side` agrees with the retail
   baseline on 15,186/15,186 outdoor-facing portals, but that is measured in **DAT space**.
   The live gate applies the plane in **AC WORLD space**, after the wasm→world transform.
   A reflection anywhere in that link silently **inverts** the gate while DAT-space parity
   still reads perfect. That link had no test.

## What actually happened this session

The adversarial run had **already completed** (`rc=0`) before the fifth SPOT preemption
killed the previous session. What was missing was the *adjudication*, not the data. No new
frames were needed and none were taken.

**Freshness was checked, not assumed** — the immediately preceding session had already been
burned once by reading a fossil (`5ae4efd6`):

| check | result |
|---|---|
| `mkprobe.mjs` mtime → its run | 01:16:25 → 01:16:35–01:18:22 ✅ instrument predates run |
| `mkaudit.mjs` mtime → its run | 01:29:15 → 01:29:22–01:32:18 ✅ instrument predates run |
| chrome profile epochs | `1786497404668`, `1786498165741` — both tonight ✅ |
| instruments vs. the copies committed in `c49bc47e` | `cmp` → **byte-identical** ✅ |
| renderer asserted from inside the page | `ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2)` ✅ |
| gate arm on every row | `sidednessSource: "flag"`, `sidednessMode: "on"`, `sidednessExportPresent: true` ✅ |

## 1. There is no reflection in the wasm→world link

`mkprobe.mjs`'s CENSUS tests that link directly, on live wasm-decoded geometry, by asking
the **shipped** gate (`apertureFacesAwayWithSide`) for its verdict at two points per
aperture:

- the owning cell's own AABB centre — a camera there is **inside** the room, so the gate
  **must drop**;
- that point's **mirror image through the aperture plane** — which is **outside**, so the
  gate **must allow**.

`ok = dropAtCentre && !dropOutside`. This is a **two-sided** test: a sign inversion anywhere
in the transform chain fails *every* case, and it exercises the "must allow" direction that
the flip was never checked against.

| run | parsed | strong ok/bad | weak ok/bad | degenerate | offenders |
|---|---|---|---|---|---|
| A (`adv-on`) | 43 | **6 / 0** | 37 / 0 | 0 | `[]` |
| B (`audit-on`) | 84 | **12 / 0** | 72 / 0 | 0 | `[]` |
| **total** | **127** | **18 / 0** | **109 / 0** | **0** | `[]` |

`strong` = owning centre ≥ 2.0 m off the plane, i.e. 18 unambiguous-geometry cases correct
in **both** directions. **127/127, zero bad.** Concern (2) is closed.

## 2. The `n-low` row is not a regression

`mkaudit.mjs` re-runs that exact camera and classifies every **dropped** aperture by which
side of the plane the camera is on relative to the owning cell centre:

- same side → `correctDrop` (the camera really is inside the room; dropping is right)
- far side → `suspicious` (**the regression signature** — culled while the viewer is outside)
- owning centre within 2.0 m of the plane → `weakWitness` (no verdict either way)

```
n-low:  total 8   gateDropped 8   correctDrop 1   suspicious 0   weakWitness 7   offenders []
```

The 8/0/8 row is a **thin 8-aperture candidate set with zero far-side drops**, not a cull of
everything a player can see. Across all eight probe cameras (`n/e/s/w-low`, `wall1-4`),
**`suspicious` is 0 and `offenders` is empty everywhere.** Concern (1) is closed.

## 3. The punch still happens at ground level

Cameras derived at **runtime** from geometry, not from the gate, square-on from outside:

| camera | offered / kept | | camera | offered / kept |
|---|---|---|---|---|
| `door1` | 5 / 3 | | `wall1｜2｜4` | 46 / 26 |
| `door2` | 4 / 3 | | `wall3` | 58 / 13 |
| `door3` | 4 / 3 | | `e-low` | 6 / 2 |
| `door4` | 24 / 13 | | `s-low` | 86 / 10 |
| | | | `w-low` | 32 / 7 |

Eye-confirmed on the readPixels captures (`page.screenshot()` photographs a black world and
was not used): `s12b-audit-on-wall3-gl.png` shows a ground-level shop window seen square-on
from outside with the interior fully revealed — wooden walls, a hanging lantern, a rack of
shields. `s12b-adv-on-door4-gl.png` shows a doorway with the interior floor visible through
the aperture. Both frames taildropped to `redmi-note-13-5g`.

## Honest limits

- **7 of the 8 `n-low` drops are `weakWitness`**, so the *audit* alone returns no verdict on
  them. They are adjudicated instead by the *census*, whose `weak` bucket (109 cases — the
  same near-plane geometry) reads 0 bad. The claim is **not** "8 independently proven-correct
  drops"; it is **0 proven-wrong out of 8, 1 proven-right, and 127/127 two-sided agreement on
  the underlying sign.**
- The census exercises the gate function directly at synthetic camera points; the door/window
  probes exercise the full render path. They agree, which is what makes the pair convincing —
  but neither alone is a whole-system proof.
- Coverage is one locale (Holtburg, `lb 0xa9b40019`), 127 apertures, 8 cameras. Broad enough
  to falsify an inverted sign — that would have failed everywhere — but it is not a
  world-wide sweep.

## Why the default does not move

The task brief said *"if SAFE, leave the default ON."* By the time this session started,
`e8a94405` had **already reverted the default to `off`** — roughly twenty minutes earlier.
Honouring that instruction literally would therefore mean **re-arming** the flag, which is a
different and riskier act than leaving it armed.

Reverting a risky default unattended is risk-*reducing*, and I had explicit authority for it.
Re-arming one at 02:00 with the owner asleep, against a written decision the orchestrator had
made minutes before, is the opposite — and the value of flipping tonight rather than at
breakfast is close to zero, while the downside of being wrong runs unattended for hours.

**So: the question is settled, the state is not.** The evidence supports `on`. The next
daylight session should flip it, with `26c7cd63` as the warrant. `?punchSidedness=on`
reproduces the fix instantly in the meantime.

## Scope

No product code was touched. The verdict commit changes `docs/url-flags.md` (retires the
RESIDUAL RISK note, replaces it with the VERDICT and its numbers; corrects the stale
"converse case unmeasured" parenthetical in the `portalPunch` row) and adds the two raw
instrument logs as checkable evidence.
