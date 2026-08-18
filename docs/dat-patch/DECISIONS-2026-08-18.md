# OWNER DECISIONS — 2026-08-18 (signed off in-session; do not re-litigate)

Context: PLAN-2026-08-18-hedonic-allocation.md §4 forks + standing owner items.
Owner sign-off received 2026-08-18 (verbatim: "1. client side force mount.
2. yes 4k patch it. drop with the rest").

1. **Mount mechanism (Phase 2.1 / HIFI split precondition): CLIENT-SIDE FORCE-MOUNT
   PATCH.** The CLCache::LoadHighResDat guard patch (acclient.c:293792) is the
   sanctioned ship-form — keeps ACE vanilla, keeps the 9-byte-patch release model.
   ACE product-bit-4 remains a documented alternative for server operators, NOT our
   ship path. Patch goes into the external patch registry; ships enabled once
   boot-mount verification on the real eor2013 highres passes (staged on buildbox
   ~/highres-verify/, sha 503e0828… verified).

2. **F3 4K-res patch: ENABLE IT** — with our one-byte fix for the defect in Pea's
   original site-1 bytes (esp re-base miss → stack scribble), i.e. the corrected
   variant, not Pea's verbatim bytes. Still subject to the standard gate (boot +
   smoke on the box virtual display) before release inclusion.

3. **The 11 unnamed retail highres ids + 22 lane passthroughs: DROP WITH THE REST**
   at the HIFI split (plan default confirmed).

---

4. **P1 DECIDED — OPTION B** (owner sign-off 2026-08-18, verbatim: "b"): the
   advertise-cap companion byte patch ships alongside the force-mount. Build it
   into the patch registry (enabled=False until the box gate incl. arm D
   passes). Option A rejected; EnableDATPatching hazard note stands.

---

# resolved detail (was PENDING P1)

P1. **DDD mitigation companion to the force-mount patch.** The 2026-08-18 DDD
research (persisted in /mnt/wbterminal2/ac-eor-patch/PATCHES.md "DDD iteration
semantics") proved the force-mount ALONE is UNSAFE vs vanilla ACE: highres
carries dataSet=1 (same as portal), so the client's interrogation response
overwrites the portal iteration set server-side; ACE compares highres iteration
497 vs live portal 2073 → session TERMINATED at char select. Applies to the
RETAIL highres as well as ours. Options:
  - **B (recommended): second client-side byte patch** capping the advertised
    dat list at 3 slots (2 disassembly-verified 6-byte sites, length-preserving
    `mov eax,3; nop`). Client stops telling the server about highres entirely;
    mount/registration/read-precedence untouched. Works for retail AND custom
    highres; keeps ACE vanilla; same release model as everything else.
  - A (data-side): set our custom highres header dataSet outside {1,2,3}.
    No exe change, but retail highres still boots you out, and our file
    becomes non-standard.
  - Hazard either way (documented, no action): NEVER set ACE
    EnableDATPatching=true as a "fix" — with the corrupted portal set the
    server would stream portal iterations INTO client_portal.dat.
