# JEV research notes (2026-10-13) — API contract + real-time prior art

Owner clarifications that shaped this (verbatim intent):
- "jev is a new ai on openrouter"
- "it wouldnt be using the claude API, it would be interacting through a claude subscription, e.g. no api usage.
  jev would have api usage though" → Claude = the Claude Code session (director); only JEV is metered.
- "for jev it more like, has some idea how close it is to trees, the side of a wall etc, research jev playing
  doom to get an idea of what im looking for here" → JEV = the camera's real-time *reflexes* (System One).
- "we can't instantly teleport between locations. claude would teleport between locations, would take like
  10 seconds" → shoot by location; never record across a teleport.

## 1. What JEV is
TypeSafe AI's first "System One" model (launched 2026-09-15; on OpenRouter in beta since ~2026-09-18). Not an
LLM: it takes state + typed questions and returns typed decisions with probabilities, no reasoning text.
70–500 ms end to end (measured medians in the wild: 110–310 ms). $0.042 per 1M input tokens, output free.

## 2. API contract (verified against OpenRouter docs + OpenAPI, 2026-10-13)
- `POST https://openrouter.ai/api/alpha/decisions` (NOT under /v1). Headers: `Authorization: Bearer $OPENROUTER_API_KEY`,
  `Content-Type: application/json`. No beta header. Optional `x-session-id`.
  (TypeSafe SDK surface: `POST https://openrouter.ai/api/v1/systemone`, bare ids `jev-1.13`; direct TypeSafe:
  `https://api.typesafe.ai/v1/systemone`.)
- Models: `typesafe/jev-1.13` (pin when thresholds are tuned), `~typesafe/jev-latest`. Response `model` names the
  dated snapshot (e.g. `typesafe/jev-1.13-20260917`).
- Request: `{model, state: string|object|array, questions: {id: Q}, session_id?, trace?, user?, provider?}`.
  - choice: `{type:'choice', instructions, criteria:{optionKey: description}}` (≤255 options per TypeSafe API docs)
  - noul: `{type:'noul', instructions, criteria?:{true: text, false: text}}` (both keys when present)
  - score: `{type:'score', instructions, criteria:[level texts low→high]}` (2–10 levels)
  - Question ids are NOT sent to the model — all meaning must be in the text. Questions are answered in
    parallel and cannot see each other's answers; adding questions barely changes latency.
- Response: `{id?, model, provider?, answers:{id: A}, usage:{input_tokens, output_tokens, cost?}}`.
  - noul `{type:'noul', noul: P(yes)}` (≈0.5 = unsure, not "medium")
  - choice `{type:'choice', choice, confidence?, probabilities?:{key:p}}`
  - score `{type:'score', score (expectation over 0..n−1, can land between levels), confidence?,
    probabilities?:{"0":p,…}, legend?}` — threshold the expectation, never interpolate magnitudes.
  - Probability key order varies; look up by name. Same input can vary slightly run to run.
- Errors: `{error:{code, message, metadata?}}`; 400/401/402/403/404/413/429/500/502/503/524/529. Retry 429/529 (and
  5xx/524) with exponential backoff (+ Retry-After). Limits per TypeSafe docs: 64k tokens/request, 32k for
  state + longest question; 80 req/s, 100K tok/s (OpenRouter limits may differ).
- Logging guidance: log request id, question names, probabilities, the threshold applied — NOT the state.
- Known weaknesses (docs.typesafe.ai jaggedness, jev-1.13): not a calculator — do numeric conversion in code and
  pass named buckets; first-option bias in choice (put the conservative default first; reorder to check
  stability); literal reading (put boundary cases in criteria); one judgment per question; large state rots.
- Calibration: probabilities hold in aggregate, not per answer; use three bands (act / confirm / escalate).
  In film mode the "escalate" band goes to the Claude director (System Two).

## 3. Real-time prior art (Jev plays DOOM, jev-drone, jevs-fly) — what transfers to a film camera
Sources: learnjev.com/tutorials/real-time-loops, jev-ai.org/blog/why-can-jev-play-doom, github.com/tirukovelamanoj/jev-plays-doom,
github.com/mikespins/doom-jev, github.com/AmoghCreator/doom-jev, github.com/RomanSlack/jev-drone,
github.com/webdevcody/jevs-fly, docs.typesafe.ai/models, docs.typesafe.ai/model-jaggedness/jev-1.13.
- Jev never sees pixels: code turns the world into a compact symbolic scene (DOOM: health/enemies/bearings;
  drone: 5 forward range sectors across ±40°, free space level/above/below ahead, target bearing + unseen_for_s).
- Code does geometry, Jev does judgment. Bucket numbers into words (mikespins: "Jev cannot do math, so every
  number … is computed here and bucketed into words").
- Criteria with explicit numeric boundaries won decisively (tirukovelamanoj: rule criteria 6.20 kills vs intent
  criteria −0.60; confidence fell 0.88 → 0.41 as wording got vaguer).
- Several independent questions per request (DOOM dashboard: firing / goal / dodge; drone: maneuver choice +
  risk score + target_truly_lost noul) combined in code.
- Layering (jev-drone): ~500 Hz stabilisation/safety (code), ~15 Hz perception (code), ≤3 Hz Jev advisory,
  mission planning by an LLM/person. A 50 Hz reflex ALWAYS owns safety and overrides Jev.
- Ask only when needed (obstacle within 4 m, a sector blocked, target unseen ≥ 1 s) and fingerprint the bucketed
  scene to reuse answers → ~110 calls per 65 s flight. Jev-drone results vs greedy baseline: course 17.7 m → 77.5 m,
  target in view 19% → 82%, time pinned in reflex 65–71% → 9%, 0 collisions (single run; variance large).
- Climb was never chosen until the state carried vertical info + the climb ceiling ("a state-design bug, not a
  model failure").
- Answers tagged with the scene sequence; only newer-scene answers replace the current one; stale answers dropped
  (jev-drone 1.5 s; tunnel 0.3 s; jevs-fly 400 ms and a stale answer may never carry the craft downward;
  1.5 s failsafe hover). Commit window ~1.1 s unless risk ≥ override. Pipelined requests (mikespins every 120 ms,
  ≤5 in flight, ~8 decisions/s, 120 ms median; jev-drone tunnel 21 decisions/s pipelined).
- Noul beat choice for "lost vs briefly occluded" (0.6 s occlusion: muddy choice p=0.24, clean noul lost=0.12).
- Setpoints relative to the snapshot pose (jevs-fly) so repeated answers aim at the same spot; sticks/rates limited.
- Cost: ~$0.30–0.60/h for a camera pilot at ~5 Hz with ~500-token states (DOOM demo ~$7/h at 10 Hz, ~5k tokens).

## 4. How film mode uses it (see scene3d/film/SPEC.md §0, §2.14, §3.2 and recon/pilot_design.md)
Per-frame code: trajectory → drone dynamics → pilot residual → **safety clamp** → camera. Perception (≤16
sweeps/frame) → SensorFrame → words. Pilot questions: maneuver (hold_path first), risk (3-level score),
subject_lost (noul), occluder_action (ignore/fade/reroute/wait), framing (keep/recenter/widen/tighten). The
director's one-sentence **standing order** per shot is part of the state every tick. Key stays in Node: the CLI
exposes `window.__filmJev` via Playwright `exposeFunction`; no bridge → deterministic `codePolicy` (same rules,
same answer shape; also the test mock and a shadow-agreement metric). Stepped capture awaits decisions in film
time (deterministic); realtime mode pipelines.
