# PREP — 4.P3 env-variant re-cut: the pre-envgeo portal lineage (2026-08-20)

Resolves the "single highest-risk staging question" the geometry-lanes research
flagged for 4.P3 (`research/geometry-lanes-research.md` §2b step 1): **does a
usable PRE-envgeo portal exist on disk, or must the shipped variants be
re-derived?** This is a FINDING + a turnkey staging recipe. **No re-cut was run.**

Method: census the 0x0D (Environment) record set of every candidate portal with
`datlib.Dat` (env-geo mints variant clones as NEW 0x0D records, so the 0x0D count
is a reliable env-geo fingerprint). Read-only; base dats untouched.

---

## 1. Finding: NO current-content pre-envgeo portal exists on disk

| portal | total recs | env0D | variant clones (≥0x0D000640) | env-geo? |
|---|---|---|---|---|
| retail base (`~/ac_base_dats`) | 79,694 | **772** | 0 | NO — but also no statics/scenery/textures |
| `dat-patch-creatures/export/client_portal.dat.pre-envgeo` (r4-era, 1.6 GB, Aug-16) | — | — (datlib can't parse the un-compacted 1.6 GB btree) | — | NO (by provenance — it was the r5 clone source) but **r4-era content** |
| `dat-patch-scenery/export` (r6) | 83,618 | **4,696** | 3,980 | YES |
| `dat-patch-r9/ace-r9-dats` (shipped) | 81,206 | **4,696** | 3,980 | YES |

- `env0D 4,696 = 772 retail + 3,924 variant clones` (r5 minted 3,928, built 3,924).
- **A named `client_portal.dat.pre-envgeo` snapshot DOES exist** — the exact file
  `variant_release.sh` references — but it is **r4/r5-era**: it predates the r6
  scenery lane and the r8 HIFI split + statics work. Cloning variants from it would
  ship env-geo on stale geometry, and datlib cannot even parse it un-compacted.
- **Every current shipped portal (r6 scenery through r9) already carries the 3,924
  env-geo clones.** So the research's YELLOW blocker resolves to: there is no portal
  with r8/r9 statics+scenery+HIFI *without* env-geo. A re-cut on current content must
  **reconstruct** the pre-envgeo portal. (`gfx01` is 15,318 in base AND r9 — statics/
  scenery patches OVERWRITE GfxObjs in place, so record counts can't distinguish
  "has statics"; only the 0x0D count reveals env-geo.)

## 2. The reconstruction is cheap — env-geo is a pure ADD to the portal

`env_geo.variant_apply` does **clone → append-geometry-to-the-clone → retarget the
EnvCells** (`env_geo.py:566-580`). It **never modifies a source Environment record**
— the displaced shell is appended to the *clone*, not the source. Verified structural
consequences:

- The **772 retail source envs in the r9 portal are byte-identical to base** (nothing
  in the lane writes them). *Verify one sample source env base-vs-r9 byte-for-byte
  before trusting this at scale.*
- The only env-geo residue in the portal is the **3,928 clone records**, id range
  **`0x0D000640`–`0x0D001597`** (retail envs are all ≤ `0x0D000627`; clean, gap-free
  separation — the exact clone id list is enumerable from `variants.json`
  `newEnvIdHex`).
- The EnvCell retargets live in the **cell dat**, not the portal, and `variant_apply`
  re-does them fresh from `variants.json`, so the re-cut can start from a **base
  retail cell copy** (no cell inversion needed — research §2b step 2 already stages
  `client_cell_1.dat = base cell copy`).

**⇒ Reconstructed pre-envgeo portal = shipped r9 portal MINUS the 3,928 clone 0x0D
records, then DatCompact.** All r8/r9 statics/scenery/HIFI survive (id-stable
overwrites); the result has retail-original Environments and cannot double-shell.

## 3. Turnkey re-cut staging recipe

```
# --- stage a pre-envgeo portal (Recipe B, recommended: invert r9 in place) ---
# 0. copies only; never write base dats
cp <r9 portal> <export>/client_portal.dat
cp ~/ac_base_dats/client_cell_1.dat <export>/client_cell_1.dat
# 1. enumerate the 3,928 clone ids from the shipped variants.json
python3 -c 'import json;print("\n".join(v["newEnvIdHex"] for v in
    json.load(open("<r5 variants.json>"))["variants"]))' > clone_ids.txt
# 2. DELETE those 0x0D clone records from <export>/client_portal.dat
#    (use the existing delete tool: tools/dat-patch/DatDeleteRepro or the
#     DRW b-tree delete path; NEW small driver over clone_ids.txt — NOT a
#     core-lane edit).  Then DatCompact the portal (delete frees blocks; the
#     size win lands at compact).
# 3. SANITY: census env0D == 772 and a sampled source env is byte-identical base.

# --- the re-cut itself (unchanged existing lane; research §2d) ---
# (optional widen) edit WALL_CLASSES in pilot.py to add "Shingle" first
env_geo.py cluster       --root <root> --top <N> --min-cells <M>   # -> variants.json
env_geo.py variant-build --root <root>                            # -> obj/, retargets.jsonl
WBT=<...> variant_release.sh <root> <export> <tag>   # prep arena -> variant-apply
                                                     # -> fixup -> variant_verify
                                                     # -> cell-portal-graph-sweep(==base)
audit_carve_orientation.py <patched> <retail_portal> <retail_cell> \
    <root>/variants.json --out report.json           # expect up-facing shell ~0
# mandatory 1070 in-client gate: feet-sink gone, no relief seams at cell edges
```

**Recipe C (fallback, bigger):** re-derive from base — replay the statics + scenery
+ HIFI lanes onto a base portal copy, then re-cut. Use only if a sampled r9 source
env turns out NOT byte-identical to base (i.e. some lane did touch source envs).

## 4. Coverage lever this unblocks (from `coverage.json`)
Once the pre-envgeo portal is staged, the un-built dungeon coverage is a re-run with
looser `cluster` params — **6,236 surviving wall-slot clusters were left unbuilt by
the `--top=1000` cap** (7,236 survived, 1,000 minted); 856 LBs are touched-but-partial
(all-or-none shipped nothing), 360 dungeon LBs untouched; 24.7 % of indoor cells were
never displaced. Raising `--top`/lowering `--min-cells` (+ optional `Shingle`, small
yield under the veto) is the coverage expansion, bounded by the env-id space
(`0x0D00FFFF`) and the portal byte runway. Same `variant_release.sh` path, same
pre-envgeo staging.

## 5. Left as a proposal (no core-lane edit made)
A small **clone-delete driver** over `clone_ids.txt` (step 2) is the only new code the
staging needs — it reuses the existing DRW b-tree delete + DatCompact tooling; it does
NOT edit `env_geo.py`/`variant_release.sh`/any core lane. Recommend writing it as a
new file `tools/dat-patch/strip_envgeo_clones.py`.
