# D4b — terrain-2x diagnostic arm at LandscapeTextureDetail=High (2026-08-18)

The Phase-0.1 diagnostic from PLAN-2026-08-18-hedonic-allocation.md: same arm
portal as D4 (37 bases @1024 imported, Region baseTexSize 1024→2048, sha-verified
r7 source), same box-decompress exe, same 6-stop smoke, but the INI at
LandscapeTextureDetail=**High** instead of VeryHigh (halves composite footprint).
Purpose: survival would have proven the D4 VeryHigh OOM was pure composite-size
scaling and terrain-2x could ship as a High-detail-supported feature.

## VERDICT: HARD FAIL — same address-space wall, and it bound EARLIER.

Timeline (marks from /tmp/terr-timeline.txt; VmSize in KB):

```
portal=1632323584 (arm)
spawn        alive=1 faults=1 vmKB=2391356
holtburg-60s alive=1 faults=1 vmKB=2391356
yaraq        alive=1 faults=1 vmKB=2391356
rithwic      alive=1 faults=1 vmKB=2391356
holtburg2    alive=1 faults=1 vmKB=2391356
soak-180     alive=1 faults=1 vmKB=2391356
end          alive=1 faults=1 vmKB=2391356
0024:trace:seh:dispatch_exception code=c0000005 flags=0 addr=00525E7E
wine: Unhandled page fault on READ access to B8D30000 at address 00525E7E
```

- faults=1 and VmSize byte-identical from the FIRST mark (45 s after character
  select): the client crashed during initial spawn load, before the first mark —
  earlier than D4's VeryHigh arm, which survived indoors 60+ s and died on the
  first outdoor telepoi. (Frozen VmSize + alive=1 = the winedbg-attach freeze
  signature; liveness marks after the first are the frozen corpse.)
- VmSize pegged at 2.39 GB — the same ~2.4 GB 32-bit wall D4 hit (2.42 GB).
  Read-AV at client code 0x00525E7E on a wild high pointer (0xB8D30000) is the
  downstream-of-failed-allocation class again, this time on a read.
- High-vs-VeryHigh made no difference to the outcome. This kills the "pure
  composite-size scaling, halve it and survive" hypothesis: the 2048-base arm
  exhausts the address space even with composites halved.

## Consequence (pre-agreed plan fork §4, D4: FAIL branch)
- **Terrain-2x in its current form (Region baseTexSize 2048) is DEAD.**
- Phase 4 terrain scope collapses to: **(a)** 1024 sources WITHOUT the Region
  patch (detail-texture-class wins only) and **(b)** D5 detail-texture upscale
  (composite-safe). Plan ranks these #6; both stay queued as 4.H2/4.H3-reduced.
- r7.1 ships NO terrain fold (plan 1.4 shelve branch). The 8 blend-ST collapse
  (entry[0] = highres ids) remains MANDATORY for the highres ship regardless,
  via fix_degrade_chains.
- The arm portal (~/terrain-arm/portal-arm.dat) and the 1024/2x PNG sets under
  /mnt/wbterminal2/terrain-2x/ stay archived; no further GPU spend on this lane.

## Session notes
- Box state was restored right after the run (r7 portal moved back, VeryHigh INI
  redeployed) but a SPOT preempt hit mid-verification — RE-VERIFY at next boot:
  ~/ac_client/client_portal.dat sha must be 0d2df11f…, INI LandscapeTextureDetail
  =VeryHigh. /tmp smoke shots were likely lost to the preempt (tmpfs); the
  timeline above was pulled before the preempt and is the evidence of record.
