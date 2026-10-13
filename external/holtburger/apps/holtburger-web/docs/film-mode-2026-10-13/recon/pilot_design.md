# JEV pilot (System One) — design notes from the Doom/drone prior art (2026-10-13 research)

Prior art distilled:
- Code does geometry; Jev does judgment. Bucket numbers into WORDS in code (jaggedness: "Jev is not a calculator",
  can't compare raw numbers). Put boundary cases in criteria. One judgment per question; several independent
  questions per request (parallel, ~free). Choice has first-option bias → put the conservative default first.
  Score: threshold the expectation, never interpolate a magnitude.
- Layering (jev-drone): 500 Hz stabilize/safety (code) · 15 Hz perception (code) · ≤3 Hz Jev advisory · LLM on demand.
  A 50 Hz reflex ALWAYS owns safety and overrides Jev. Jev only consulted when needed (obstacle < consult range,
  sector blocked, target unseen ≥ 1 s) + scene fingerprint (bucketed) → unchanged scene reuses last answer.
  ~110 calls / 65 s flight. Stale: age from SCENE time; ignore if > 1.5 s (tunnel: 0.3 s). Commit window ~1.1 s
  unless risk ≥ override. Climb only when "free above" ≫ "free level" (state MUST include vertical info + ceiling).
  Noul 'target_truly_lost' (uses unseen_for_s) beats the choice for lost-vs-occluded.
- Pipelining (jev-drone tunnel / mikespins): N workers, min dispatch 45–120 ms, seq numbers, only newer-scene
  answers replace current; ~21 decisions/s possible; 0.11–0.21 s median latency.
- jevs-fly (three.js!): state from scene geometry (not pixels): line_of_sight "blocked by <what> <d> m away",
  trunks within 1.5 m of flight line {distance_m, side, gap_m}, climb_needed_deg computed in code.
  Setpoints relative to the SNAPSHOT pose (heading at capture + delta) so repeated answers aim at the same spot.
  STALE_MS 400 ⇒ stale answer cannot carry the craft downward; FAILSAFE 1.5 s ⇒ level hover.
  Sticks move at limited rates. Mock mode = code comparisons with ~180–260 ms delay (our fallback + test mock).
- Rate limits: 80 req/s, 100K tok/s (docs). 32k state+longest question. Choice ≤255 options, Score 2–10 levels.
- Cost: $0.042/M input; ~500 tok × 5 Hz ≈ 9M tok/h ≈ $0.38/h.

## Film pilot = residual policy on top of the planned shot
- Planner (code) produces the NOMINAL trajectory per shot (technique library).
- Pilot perception (in page, ~15 Hz): sensors from the CAMERA pose:
  * 5 forward range sectors across ±40° (far_left,left,center,right,far_right) — min range per sector (rays/spheres)
  * vertical bands ahead within ±12°: free_ahead_level / above / below (m)
  * side clearance left/right/up/down/back (m)
  * nearest obstacle: {kind: tree|wall|building|rock|terrain|creature|player|prop|particles, distance, side}
  * path_ahead: time-to-contact along the PLANNED path (s) + the blocker kind
  * subject: visible_frac, unseen_for_s, bearing (words), elevation (words), screen offset (words), size vs target framing
  * line_of_sight: "clear" | "blocked by <kind> <d> m from camera"
  * particle hazard: none | "smoke 3 m ahead" | "fire at lens" ...
  * ALL bucketed to words in code; raw numbers only where criteria name a number boundary.
- Questions (one request): maneuver (choice), risk (score 3), subject_lost (noul), occluder_action (choice), framing (choice).
- Mapping: maneuver → bounded offsets in the path frame (lateral, vertical), progress-rate scale (slow/stop/back_off),
  subject-distance scale (push_in/pull_back); commit window; blend with neutral by confidence; critically-damped
  smoothing + rate limits ⇒ smooth footage. Shot-declared bounds (maxLateral, maxRise, minSpeedScale).
- Safety reflex (every frame, code): never inside geometry (min clearance sphere), push-out along free direction,
  terrain floor, cell bounds indoors; near-lens particle cull. Overrides pilot.
- Bridge: CLI installs CDP Runtime.addBinding('__filmJev'); page calls window.__filmJev(JSON) → CLI → OpenRouter
  Decisions API (key Node-side) → Runtime.evaluate('__film.pilot.onAnswer(...)'). No bridge ⇒ code policy (mock).
- Standing order per shot (Claude writes): one sentence read every tick.

## Production model (teleport ≈ 10 s)
- SHOOTING SCHEDULE ≠ EDIT ORDER. Group shots by site; order sites to minimize teleports; Claude teleports
  (film go <site>), waits for readiness, shoots all that site's shots as separate takes; assembly reorders to the timeline.
- Never record across a teleport. Each take = one continuous camera move inside the streamed area.
