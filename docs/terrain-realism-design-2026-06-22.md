# Terrain realism design — "Fortnite-rolly / geologically-real" within cross-client compatibility (2026-06-22)

Multi-agent workflow result (11 agents: 5 investigators → adversarial envelope-verify →
4 thread-verifies → synthesis). Goal (user): escape AC's "late-90s 3-line bluff /
White-Cliffs-of-Dover" look toward Takram-tier natural realism, leaning Tier 3
(*invent* rolling terrain), **while staying playable on a shared ACE server with
legacy clients** — "there couldn't be that level of deviation" (no walk-through /
float between clients).

> Status: **research complete, nothing implemented.** Start with Stage A (free
> shading stack), batched on the 1070. Stage F (shared-DAT erosion) is research-gated.

---

## The decisive finding (read first)

The whole question turns on one piece of netcode, now **code-verified in the retail
decomp + ACE**:

1. **The shared ground truth** is the per-vertex 8-bit height grid in `cell.dat` →
   256-entry `Land_Height_Table` → per-cell **triangle** plane (the retail split
   hash). ACE (`Landblock.cs:125 GetZ` / `LandCell.cs:258 find_terrain_poly`),
   legacy (`acclient.c` Land_Height_Table), and Holtburger (`types.rs:746-772`,
   `USE_TRIANGLE_TERRAIN_Z`) all compute the **same** walkable Z from it.
2. **Legacy clients draw remote avatars at the EXACT wire Z** — they do **not**
   re-ground peers to local terrain (`acclient.c` `CPhysicsObj::MoveOrTeleport
   ~323449` → `InterpolateTo`/`SetPositionSimple` on the wire Frame origin, **no**
   `LandDefs::get_z`).
3. **ACE does no Z backstop** — `PhysicsObj.cs:4262 update_object_server` does
   `set_current_pos(RequestPos)`, accepting the client's reported Z verbatim. The
   only Z policing is a >10 m single-block upward anti-cheat + a 50 m/s speed cap.

**Therefore:** a Holtburger-only **walkable** hill is architecturally **impossible** —
the Holtburger player would report off-grid Z that legacy renders floating/sunk and
that nothing corrects. The walkable surface (the Z each client emits) **must** stay
the shared triangle grid. Only **two** ways to change macro shape exist:
- make it **purely visual** and keep it within the per-vertex budget of the walkable
  Z (small — see envelope), or
- change the **shared `.dat` heights** so *both* clients + ACE move identically
  (compatible, but not Holtburger-only, and policy-gated — Stage F).

The good news: **~90% of the "late-90s → immersive" jump is reachable shading-only,
at zero cross-client cost.** The silhouette and the walkable macro-shape are the only
things the compatibility contract actually locks.

---

## The compatibility envelope (verified)

| | |
|---|---|
| **Hard rule** | The local player's emitted/walkable Z = the shared 9×9 height-byte **per-cell triangle** surface. Non-negotiable. |
| **Visual budget** | A Holtburger-only visual mesh may deviate from that walkable surface by the per-vertex clamp `VISUAL_VS_COLLISION_MAX_M` = **0.3 m** (`terrain_subdiv.rs:92`). |
| **⚠ caveat** | The 0.3 m clamp is measured against the **bilinear** surface, but the walkable Z is the **triangle** surface → true worst-case cross-observer float is **~1.4 m** on twisted cells until the clamp is re-anchored on the triangle (Stage D). |
| **Free zones (unbounded)** | (a) **Non-walkable faces** (normal.z < FloorZ 0.66417, ~48.4°) — cliffs! — are never sampled for any avatar's Z, so their drawn geometry is cosmetic. (b) **Distant/background cells** are visible-only; collision is a tight 3×3 around the player (`cells.js:1046-1047`) → no peer ever stands there → reshape freely. |
| **Macro walkable rounding** | ONLY via baking rounded heights into the **shared `.dat`** (both clients read it) — Stage F, policy-gated. |

---

## The layered design (immersion-per-cost order; almost all free)

Maximize free shading-only layers; spend the scarce geometry budget only where it
buys the most. Every layer below is `movesVerts=false` / zero collision **except L8–L10**.

| # | Layer | Cost | Moves verts | Role |
|---|---|---|---|---|
| L0 | **Takram aerial perspective** (already ~90% shipped, `atmosphere_pipeline.js:237`) — add an AC-scale strength knob | live-shader | no | **THE skyline fix** — melts flat grey triangle mountains into sky |
| L1 | **Slope N·L** (already default-on, `terrain.js:2424`) — verify, don't re-ship | live-shader | no | Sun *models* each facet instead of airbrushing it grey |
| L2 | **World-Z stratification banding** (`fract(vAcPos.z/band)` + noise) | live-shader | no | **Biggest single cliff win** — "White Cliffs of Dover → real geology" |
| L3 | **Triplanar diffuse on cliffs + lithology color** by slope/altitude | live-shader | no | Kills vertical-smear grey cardboard; basalt/sandstone/limestone variety |
| L4 | **Talus/scree apron + crevice AO + weathering streaks** | live-shader | no | Grounds cliff bases (debris fans), dirt-in-cracks |
| L5 | **Analytic/hydraulic erosion → detail NORMAL + AO map** | bake | no | The eroded *look* on all viewed slopes (unlimited intensity, legal) |
| L6 | **POM / relief mapping on cliff rock** (already gated high/ultra) | bake | no | Fakes crevices/ledges/caprock — biggest per-face "3-line" kill |
| L7 | **Distant-LOD impostor reshaping** of background ranges (non-collision cells) | bake | yes* | **Free metre-scale skyline drama** — *requires a proven non-walkable mask* |
| L8 | **Re-anchor the ±0.3 m clamp on the triangle** (not bilinear) | wasm-rebuild | yes | Safety-critical: sole no-float guarantor (no ACE backstop); closes the ~1.4 m gap |
| L9 | **Curvature-selective in-budget ridge rounding** (≤0.3 m, pin control/edge verts) | wasm-rebuild | yes | Subtle weathering of mid-curvature creases — polish only |
| F | **Bake eroded heights into the SHARED `.dat`** | bake (data) | yes (both clients) | The ONLY genuine rounded *walkable* terrain — policy/research-gated |

\* L7 moves verts only in cells that are never collision-populated.

---

## Cliff strategy (the "White Cliffs of Dover" answer)

**Do not move the cliff silhouette** — it's the shared collision/legacy contract.
Make cliffs read as real geology **entirely through shading** (cliffs are non-walkable
→ the unbounded free zone), in ship order: world-Z **stratification banding** (L2) →
**triplanar diffuse + lithology** color so rock types differ instead of uniform grey
(L3) → **talus/scree** apron + band-locked **crevice AO** + weathering streaks (L4) →
**POM** for crevices/ledges/caprock relief (L6). This is high-immersion and
**zero cross-client cost**.

---

## Staged roadmap

- **Stage A — free shading wins (live-shader).** Tune aerial perspective (L0, add AC-scale strength uniform), verify the already-default-on slope N·L as a lighting stack (L1), cliff stratification banding (L2). Develop flagged-off → ONE batched 1070 eye-test. **Risk: low** (zero collision/cross-client).
- **Stage B — bake-class shading.** Erosion detail-normal+AO map (L5); pack a rock height channel + enable POM on cliffs (L6); triplanar+lithology+talus (L3/L4). **Risk: low-medium** (still zero collision).
- **Stage C — distant background reshape (L7).** Find the exact visible-vs-collision boundary, build a *robust non-walkable mask*, reshape far ranges. **Risk: medium** (compat-free only if the mask provably holds).
- **Stage D — correctness wasm rebuild (L8).** Re-anchor the clamp on `triangle_height_in_cell` (vs `eval_bilinear_at`), closing the ~1.4 m twisted-cell gap. **Risk: medium, safety-critical.**
- **Stage E — in-budget curvature rounding (L9).** After D. Subtle polish only. **Risk: medium.**
- **Stage F — shared-`.dat` erosion bake (RESEARCH-GATED, not green-lit).** The only path to genuine metre-scale rounded *walkable* hills identical on both clients. **Risk: high** — collides with keep-ACE-vanilla + bake-base-DATs-only, and needs proof the vanilla legacy client accepts a derived region/height DAT. **Two gates: (a) does legacy acclient load modified `.dat` heights without client-side rejection? (b) does it stay within project DAT policy?**

---

## What's possible vs not

**Possible**
- Background mountains read as far/massive/atmospheric (L0, ~90% shipped).
- Every facet relit by the sun (L1).
- Cliffs → stratified, lithologically varied, talus-skirted, relief-shaded geology — shading-only, unlimited intensity, zero cost.
- Fake crevices/ledges/overhangs via POM + erosion normals (no verts).
- Reshape **distant** (non-collision) silhouettes freely.
- Subtle ≤0.3 m ridge/crease weathering (after Stage D).
- Genuine rounded **walkable** rolling terrain on **both** clients — **only** via the shared-`.dat` bake (Stage F), if the gates pass.

**Not possible**
- A rounded **walkable** hill in Holtburger where legacy stays flat — peers float/sink, no ACE backstop corrects it. Prohibited.
- Rounding a 24 m-cell "3-line bluff" on the **skyline** via the 0.3 m vertex path — budget far too small; skyline needs L0 (dissolve) or L7 (distant reshape) or Stage F.
- Raising the clamp to metre scale client-side — re-opens the sink bug, uncorrected (no backstop). Dropped.
- Shading fixing a **silhouette against the sky** — normals/POM can't extend past a triangle edge.

---

## Open decisions

1. **Stage F fork (your Tier-3 lean):** do we pursue the shared-`.dat` erosion bake for genuine rounded walkable hills? Blocked on (a) legacy-client `.dat` acceptance research, (b) keep-ACE-vanilla / bake-base-DATs-only policy.
2. Stratification: align bands to true world-Z (stair-steps on diagonal faces) or to cliff-face up? Global vs per-region band params.
3. Aerial perspective: just a strength multiplier, or wire the normal buffer + sun/sky probe for true facet relighting (the in-code "K.3" upgrade)?
4. The exact visible-vs-collision distance boundary + a provable non-walkable mask for L7.

## Top recommendation

**Prototype the free shading stack first** as one batched 1070 eye-test, led by
**aerial-perspective tuning (L0) + verifying slope N·L (L1) + cliff stratification
banding (L2)** — highest immersion-per-cost, zero cross-client risk, and they directly
attack the Mount-Esper "flat grey triangle mountains / 3-line bluff" tell. Defer all
vertex-moving work behind the Stage D clamp re-anchor. Treat Stage F as a separate
go/no-go gated on the legacy-DAT-acceptance research.
