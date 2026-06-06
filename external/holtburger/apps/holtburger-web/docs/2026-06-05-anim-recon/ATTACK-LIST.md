# Attack list — ranked GO targets (2026-06-05 anim-recon)

## DIM5-2 — root-motion ORIENTATION accumulator

**Verdict:** GO (gate on a one-MotionTable DAT sweep confirming a reachable cycle has non-identity pos_frame.orientation; if all-identity, downgrade to NEEDS-EVIDENCE)

**Loci:**
- `apps/holtburger-web/src/lib.rs:5003 (add quat_accum next to pos_accum)`
- `apps/holtburger-web/src/lib.rs:5057-5067 (rotate each origin delta by quat_accum before sum; accumulate quat_accum *= orientation, normalize; reverse = conjugate+subtract)`
- `scene3d/animation.js:136-172 (apply accumulated quat to rig root, currently translation-only)`
- `external/melt/Source/ACE.DatLoader/FileTypes/MotionTable.cs:225-231 (authoritative reference: origin += Vector3.Transform(posFrame.Origin, orientation); orientation *= posFrame.Orientation; Normalize)`
- `crates/holtburger-dat/src/graphics.rs:11-14 (Frame.orientation field already parsed)`
- `crates/holtburger-dat/examples/probe_anim_dist.rs (gate sweep)`

**Rationale:** Highest-leverage GO: exact bit-for-bit retail reference exists (melt MotionTable.cs:225-231, verified by direct read), holtburger provably lacks both the rotate-delta and quat-accumulator steps (verified at lib.rs:5057-5067), and the change is ~15 lines, no-op for identity cycles (idle/walk/run). Two chorizite reports claiming it's already correct were verified WRONG against the melt source. Fixes curved/spin/turn-in-place/knockback root motion and improves GetAnimDist for curved cycles.

---

## W5.1 — per-part LOD (remove single-part-only guard)

**Verdict:** GO (small, isolated, no external blocker)

**Loci:**
- `apps/holtburger-web/src/lib.rs:5606 (the `if setup.parts.len() != 1 { skip LOD }` guard — the defect)`
- `apps/holtburger-web/src/lib.rs:5572-5625 (resolve_did_degrade fn to refactor per-part)`
- `apps/holtburger-web/src/lib.rs:3745-3801 (did_degrade field + getter)`
- `apps/holtburger-web/src/lib.rs:7238-7267 (GfxObjDegradeInfo composition at spawn)`

**Rationale:** Confirmed defect with an explicit code locus: multi-part rigs return did_degrade=0 (no degrade) and collapse to base mesh at distance because resolve_did_degrade short-circuits at parts.len()!=1. Retail degrades per-part. Self-contained client-side change; guard removal is the load-bearing edit, then walk each part's did_degrade chain.

---

## H-3 — multi-action queue drain (parsed-but-not-consumed)

**Verdict:** GO (wire layer already parses the full Vec<MotionItem>; add a client-side FIFO consumer)

**Loci:**
- `crates/holtburger-protocol/src/messages/movement/types.rs:316-322 (outer unpack loop over num_commands — already parses all)`
- `crates/holtburger-protocol/src/messages/movement/types.rs:525-526 (InterpretedMotionState inner command-list loop)`
- `crates/holtburger-protocol/src/messages/movement/types.rs:387-445 (MotionItem: command u16, packed_sequence u16 bit15=autonomous, speed f32)`
- `(NO consumer found via grep of holtburger-world/core/web for .commands iteration — only [0] effectively used; THIS is the gap)`
- `external/ACE/Source/ACE.Server/Physics/Animation/MotionTable.cs:189-233 (6-action FIFO drain-on-MotionDone reference)`
- `scene3d/entities.js (AnimationDone hook type 4 must advance the queue)`

**Rationale:** Verified: protocol fully unpacks the chained MotionItem queue (types.rs:316-322, 525-526) but NO consumer in world/core/web crates iterates beyond the first command, so chained actions (combo swings, move-then-turn) silently drop. Fix = client FIFO mirroring ACE's 6-deep MotionState.Actions, drained on AnimationDone(4). Reference drain exists in ACE. Requires also firing hook type 4 (currently decoded-not-fired).

---

## DIM3-4 — '-2' direction hook

**Verdict:** NO-GO (documentation + defensive clamp only; not a behavioral gap)

**Loci:**
- `ac-headers/acclient.h:7311-7318 (AnimHookDir UNKNOWN=0xFFFFFFFE constructor sentinel)`
- `ac-headers/acclient.c:339695 (gate), :342006/:342087/:342105/:342181 (ctors set -2), bndb UnPackHook:304241-304285 (overwrites from wire)`
- `external/melt/Source/Ace.Entity/Enum/AnimationHookDir.cs:5 (Unknown=-2, unused in 927MB portal.dat survey)`
- `apps/holtburger-web/src/lib.rs:5088 (negation hazard: -2 -> +2; add clamp)`
- `crates/holtburger-dat/src/file_type/setup_model.rs:70 (add comment)`

**Rationale:** Resolved across all 5 sources: -2 is a constructor default immediately overwritten by the wire-read direction before any fire; never serialized; absent from the full portal.dat survey. Only work is a defensive clamp at lib.rs:5088 (so the reverse-segment negation can't produce out-of-enum +2) plus a doc comment. Close the open item.

---

