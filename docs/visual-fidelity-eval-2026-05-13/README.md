# Visual-fidelity push — browser eval screenshots (2026-05-13)

Captures taken after waves 1-5 of the visual-fidelity push landed
(11 of 14 phases shipped). Renderer state: master `7b18cfb`.

Method: fresh `wasm-pack build --target web --dev`; threaded Python
`http.server` on port 8090; Playwright/chromium-headless `mockSession`
init3D against real Holtburg LB 0xA9B4. Screenshots taken by the
laptop-safe capture scripts (`capture_visfid_p21_subdiv.cjs`,
`capture_visfid_p13_triplanar.cjs`).

## Files

| Screenshot | Source | What it shows |
|---|---|---|
| `holtburg_hillside_subdiv_1.png` | Phase 2.1 capture | Top-down hilltop view, subdiv=1 (81-vert 9×9 baseline) |
| `holtburg_hillside_subdiv_2.png` | Phase 2.1 capture | Same view, subdiv=2 (289-vert 17×17) |
| `holtburg_hillside_subdiv_4.png` | Phase 2.1 capture | Same view, subdiv=4 (1089-vert 33×33). **Visible road-overlay z-fight on cliff face** (bright blue lines) — known cosmetic issue, Phase 2.2 follow-on. |
| `holtburg_flat_low.png` | Phase 1.3 capture | Top-down plaza, quality=low (triplanar OFF, detail-normal OFF) |
| `holtburg_flat_mid.png` | Phase 1.3 capture | Same view, quality=mid (both ON) |
| `holtburg_flat_high.png` | Phase 1.3 capture | Same view, quality=high (everything on except POM) |
| `holtburg_slope_low.png` | Phase 1.3 capture | Cliff-face close-up, quality=low |
| `holtburg_slope_mid.png` | Phase 1.3 capture | Cliff-face close-up, quality=mid |
| `holtburg_slope_high.png` | Phase 1.3 capture | Cliff-face close-up, quality=high |
| `water_displacement_mid-subdiv2_t0.png` | Phase 2.2 capture | **Synthetic**-water terrain (Holtburg has none); centre LB code forced to 17 (WaterStandingFresh). Frame at t=35.22s, wave amplitude −0.183m. |
| `water_displacement_mid-subdiv2_t2s.png` | Phase 2.2 capture | Same, t=37.46s, wave amplitude −0.012m. 0.17m vertical motion over 2s confirms displacement runs. |
| `water_displacement_low-subdiv1_t0.png` | Phase 2.2 capture | Quality=low (subdivLevel=1) — displacement gate OFF |
| `water_displacement_low-subdiv1_t2s.png` | Phase 2.2 capture | Same, t=2s — byte-identical to t=0 (quality gate confirmed working) |

## Honest evaluation

**Mechanically:** every capture-probe assertion passes. Quality
preset gating correct, uniforms wired on all 9 terrain meshes, LOD
ramp confirmed (centre subdiv full, outer 8 halved), vertex counts
match spec. cargo workspace 1352/0/1.

**Visually, the win is muted on Holtburg.** Three observations:

1. **subdiv=1 vs subdiv=4 hilltop silhouette: nearly identical.**
   Holtburg's hilltop ridge is too flat for Catmull-Rom to add visible
   smoothing from this angle. The contour improvement is at the
   *lower cliff edge*, not the hilltop.

2. **subdiv=4 has visible road-overlay z-fight** — bright blue lines
   through the cliff face. Road built from 9×9 control positions at
   +0.1m gets overrun where subdivided terrain rises ≥0.1m. Collision
   unaffected. Phase 2.2 (or a 2.1.1 follow-on) needs to route the
   road through subdivided heights.

3. **slope_low vs slope_high** shows marginal additional detail at
   high (Phase 1.2 detail-normal + Phase 1.3 triplanar contributing),
   but Holtburg's steepest face is 46.9° (slope=0.316), which only
   hits **33% triplanar contribution** at the smoothstep ramp. The
   wins from these phases will be more visible on steep cliffsides in
   Yanshi / Arwic / Asheron's Castle than in Holtburg.

**Not validated from these captures:**

- CSM shadows on buildings (mockSession frames camera top-down,
  shadows fall behind buildings out of view)
- POM on stone walls (Holtburg has only 2 Stone-classified surfaces;
  capture doesn't aim at them — need `?forcePom=on` + oblique angle)
- SSAO darkening at corners (capture doesn't frame any corner
  geometry — need a building-corner angle)
- Phone FPS (laptop OOM rule, deferred to PK on live-ACE)

**Bottom line.** Waves 1-5 are mechanically correct (11 of 14 phases
shipped). The visual delta on Holtburg is real but subtle for the
reasons above. Real "AAA-adjacent stylized realism" eye-tests need PK
on live-ACE in steeper / stonier landblocks, with the freshly-built
wasm bundle deployed to `<server-ip>`. The road z-fight at
subdiv=4 is the one *visible regression* worth treating as a
near-term fix candidate.

See `docs/visual-fidelity-push-prompt-2026-05-13.md` for the full
14-phase plan and `~/.claude/projects/-home-wbterminal/memory/project_visual_fidelity_wave{1,2,3,4,5}_done_2026-05-13.md`
for per-wave shipping notes.
