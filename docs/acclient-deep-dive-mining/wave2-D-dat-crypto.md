# Wave 2 — Agent D: `07-dat-resources.md` + `10-crypto-obfuscation.md` mined against holtburger-web

Sources mined line-by-line:
`2013-09-11.4186-v3/07-dat-resources.md` (§1–§12) and
`2013-09-11.4186-v3/10-crypto-obfuscation.md` (§0–§7).
Context skim: `README.md`, `00-architecture.md` §5/§6/§9.

Every holtburger citation below was opened with Read (or `sed -n`) — not grep output
alone. Where no site exists the disposition says **ABSENT**.

**Empirical grounding.** Several doc claims were resolved against the real shipped
DATs (`~/ac_base_dats/client_portal.dat`, `client_cell_1.dat`,
`client_local_English.dat`) with a throwaway BTree walker, per the
`ground-in-real-wire-data` rule. Those measurements are in §APPENDIX-B and they
**correct three claims in the deep dives** and **answer one of the deep dive's own
open questions**.

## Disposition counts

197 dispositioned ledger rows across both documents (every H2 and every
distinct-claim H3, plus the family sub-tables of `10` §4.3 and §4.6).

| Disposition | Rows | Notes |
|---|---|---|
| PARITY-OK | 76 | includes 6 "PARITY-OK-with-note" and 3 where holtburger is *ahead* of retail |
| REF-ONLY | 58 | includes 1 row that **answers** an open question the deep dive poses (`07` §10) |
| TASK | 31 | → **31 task IDs**: DAT-01..DAT-21 (21) + CRY-01..CRY-03, CRY-05..CRY-11 (10). No CRY-04 by design |
| N/A-WEB | 22 | pre-baked HTTP shards / immutable content replace runtime BTree IO, DDD writes, journaling, node caching |
| VERIFY-LIVE | 5 | source reads correct, runtime behaviour unobserved → **VL-1..VL-7** register in PART 6 |
| ANTI-TASK | 2 | flagged in-ledger; **AT-1..AT-9** in PART 4 |
| pointer | 2 | rows that forward to another section rather than dispositioning |

Also: **3 corrections back to the deep dives** (Family A's two mis-transcribed
constants and its incomplete `K`; the LandBlock record size; the send-side checksum
composition order), **1 answered open question** (`game_pack_vnum == 0`), and
**wave0's PAL-04 closed** as already-implemented.

**Headline (answers the coordinator's mid-flight item).** The outdoor static
collision feed *is* wired in production (`apps/holtburger-web/src/lib.rs:15282`
→ `SpatialScene::insert_static_physics_bsp`, overlap-baked at `:48985`), and it
covers **both** raw `GfxObj` (0x01) and multi-part `SetupModel` (0x02) statics.
But it is fed **only** from `CLandBlockInfo.objects` / `.buildings` — the
hand-placed cell-DAT statics. **Procedural scenery (trees, rocks, bushes) never
enters it.** Scenery has its own, entirely separate data path
(`holtburger-scenery-bake` → `/dist/scenery/<lb>.scenery.jsonl` →
`fetch_landblock_scenery`, `lib.rs:3289`/`:4199`) that is render-only: there is no
`populate_scenery_aabbs_for_landblock`, no scenery `STATIC_BSP_PENDING` push, and
no scenery entry in any physics table. Retail makes every scenery object a real
`CPhysicsObj` in its cell (`CLandBlock::get_land_scenery` → `CPhysicsObj::makeObject`
→ `add_obj_to_cell` → `CLandBlock::add_static_object`, acclient.c:352708–352718),
which is exactly why trees block you in retail and not here. That is **DAT-01**.

---

# PART 1 — COVERAGE LEDGER

## `07-dat-resources.md`

### §1 On-disk container format

| Claim | Disposition |
|---|---|
| `DiskHeaderBlock_t`: `acVersionStr_[256]`@0, `acTransactionRecord[64]`@0x100, `DiskFileInfo_t`@**0x140**; total 400 = 0x190 | PARITY-OK — `crates/holtburger-dat/src/lib.rs:39` `DAT_HEADER_OFFSET = 0x140` |
| `magic_ == 21570 (0x5442 "BT")`, else −102 | PARITY-OK on the value (`lib.rs:41` `DAT_MAGIC = 0x0000_5442`); TASK(DAT-05) on the *rejection* — `DatDatabase::new` (`lib.rs:290-306`) never compares it; magic only steers `dat_kind()` (`:244-251`) |
| `DiskFileInfo_t` field table +0x00..+0x3C, arithmetic closes at 0x50 | PARITY-OK — `lib.rs:208-228` `DatHeader` is field-for-field identical: magic/block_size/file_size/dataset/subset/free_head(=`firstFree_`)/free_tail(=`finalFree_`)/free_count(=`iFreeBlocks_`)/root_offset(=`btreeRoot_`)/new_lru/old_lru/use_lru/master_map_id/engine_version(=`eng_pack_vnum`)/game_version(=`game_pack_vnum`)/version_string[16](=the GUID half of `DatIDStamp`)/version_minor(=its uint). Ends at 0x50 |
| `DATFILE_TYPE` 1 PORTAL / 2 CELL / 3 LOCAL | PARITY-OK — `lib.rs:244-251`; measured dataset values 1/2/3 (APPENDIX-B) |
| Block chain: first dword = next offset, payload = `iBlockSize_ − 4`, 4 clobbered bytes saved/restored | PARITY-OK — `lib.rs:368-399` `read_file_data` walks exactly this, reading payload at `current_offset + 4`, `block_size - 4` per hop |
| **Next-pointer bit 31 set = free block; hitting one mid-read aborts** | TASK(DAT-05) — ABSENT; `read_file_data` treats `0x8xxxxxxx` as a valid offset and seeks there |
| Data area starts at file offset **1024**, not 400 | N/A-WEB — write-side only (`CreateDataFile`); holtburger never creates a retail DAT |
| `acVersionStr_` decorative, `[255] = 0x1A` DOS EOF | REF-ONLY |
| Transaction journal at offset **256**, `0x40` max, `SplitNodeTrans`/`InsertEntryTrans`/`MergeNodesTrans`/`RotateEntryTrans`; `BTree::RecoverTransaction` is **redo-forward**; types 8/9 fall through to −103 | TASK(DAT-16) — ABSENT; `DatDatabase::new` never reads offset 256. Low risk (bake source is pristine + sha256'd) but a torn DAT reads as a silently-wrong BTree |

### §2 The BTree directory

| Claim | Disposition |
|---|---|
| `BTEntry` = 24 B `{comp_:1, resv_:15, ver_:16 \| GID_ \| Offset_ \| size_ \| date_ \| iter_}` | PARITY-OK on width/order — `lib.rs:256-263` `DatFileEntry{bit_flags, id, offset, size, timestamp, version}` = 24 B; **TASK(DAT-03)** on the *names*: holtburger's `version` is retail's `iter_`, and the real record version (`ver_`, bits 16–31 of `bit_flags`) is never extracted. ACE names it correctly (`ACE.DatLoader/DatFile.cs:23` `Iteration`) |
| `BTNode` = 1716 B (`62×4 + 4 + 61×24`), order-62, `NextNode_[0] == 0` marks leaf, key = raw 32-bit DID | PARITY-OK — `lib.rs:40` `DIRECTORY_NODE_SIZE = 1716`; `:314-345` `read_node` reads 62 branches, then `entry_count`, then the entries, then recurses into `entry_count+1` children gated on `branches[0] != 0` |
| `ver_` really is bits 16–31, `comp_` bit 0 (corroborated by `WorkerExecuteSaveRequest`) | PARITY-OK for `comp_` (`lib.rs:283-285` `is_compressed()` = `bit_flags & 0x01`); TASK(DAT-03) for `ver_` |
| In-memory root pinned + **100-slot node cache**, `BTMemNode` = 1736 B, `LoadTree` allocates `0x2A624` | N/A-WEB — holtburger reads the whole directory eagerly into a `HashMap<u32, DatFileEntry>` (`lib.rs:288-306`); a node cache is meaningless once the index is fully resident |
| Insertion preemptive-split (`DescendToAdd` body @649679), deletion merge+rotate | N/A-WEB — `holtburger-dat-write` writes HBA, never a retail BTree |
| `iter_` = patch-iteration; the dat's iteration set lives in-band under reserved DID **`0xFFFF0001`**, version must be exactly 1 | PARITY-OK on the DID (`file_type/mod.rs:225-227`, `DatFileType::Iteration`); **empirically confirmed**: exactly one `0xFFFF0001` record per DAT and it is the *only* record with `ver_ == 1` (APPENDIX-B) |
| Compression: decompress happens inside `LoadDataEx` (647426); `LoadData` (647412) is a 10-line vtable forwarder | REF-ONLY (decomp navigation) |
| `DiskController::Decompress` = plain zlib `uncompress` with a **4-byte uncompressed-size prefix**; guard `record ≥ 0x10` ⇒ payload ≥ 0x0C. Write side `compress2` level **9**, guard `> 0x10` (strict) | TASK(DAT-04) — holtburger runs `utils::decompress_lrs` (`lib.rs:352`, an LZSS bit-control decompressor) on `comp_` records, not zlib. **Latent, not live**: measured 0 compressed entries across all three shipped DATs (APPENDIX-B) |
| **No encryption in the DAT container path** (`SyncRead`/`SyncWrite` raw, `Load_Data`/`Store_Data` touch only the link, zlib is pure); ISAAC is provably network-only | PARITY-OK by construction — holtburger's container path is also cipher-free |
| **But obfuscation exists one layer up on record content**: `SpellFormula::Decrypt` + nibble-swapped spell strings | See CRY ledger (`10-crypto…` §3) |

### §3 The DID namespace

| Claim | Disposition |
|---|---|
| `CLCache::Init` grows a 4-slot array: 0 portal, 1 local, 2 cell, 3 highres; `client_cell_<rid>.dat` / `client_local_<lang>.dat` / `client_highres.dat` | N/A-WEB — replaced by HBA namespaces (`EOR_PORTAL_NAMESPACE` / `EOR_CELL_NAMESPACE`, `lib.rs:233-239` `retail_namespace_hint`). Note `client_highres.dat` is **absent** from `~/ac_base_dats/` (APPENDIX-B) |
| `CThreadsafeDiskController` = 1928 B, `SharedCriticalSection` @+1872, so `DiskController` is 0x750 | N/A-WEB (layout of a thread wrapper) |
| The 27-row DID→DB_TYPE range table (`0x01`→6 GfxObj … `0x78`→49 DBProperties), with the many `…00FFFF` upper bounds | PARITY-OK on the prefixes — `file_type/mod.rs:286-331` `classify_portal_prefix` covers every one. **N/A-WEB for the sub-16-bit upper bounds**: holtburger dispatches on the high byte only and never validates the low 16 bits |
| **`0x23000000`–`0x24FFFFFF` → 37 StringTable owns the 0x24 high byte too** | TASK(DAT-19) — holtburger splits `0x23 → StringTable`, `0x24 → StringTableString` (`mod.rs:313-314`). `StringTableString` is a *sub-struct* of StringTable in retail (`Serialize` 109419), not a dbtype. Harmless today: measured **zero** 0x24 records (APPENDIX-B) |
| **The six ranges earlier drafts omitted**: `0x15`→30 RenderTexture, `0x16`→31 RenderMaterial, `0x17`→32 MaterialModifier, `0x18`→33 MaterialInstance, `0x22`→36 EnumMapper, `0x25`→38 DIDMapper | PARITY-OK — all six present at `mod.rs:305-315`. holtburger was already ahead of the doc's first draft |
| `0x19……` → 67 RenderMesh | PARITY-OK (`mod.rs:309`). Measured: zero 0x19 records shipped |
| `0x0D000000`–`0x0D00FFFF` → **16 Environment** | **TASK(DAT-02)** — holtburger names this prefix `DatFileType::EnvCell` (`mod.rs:154`, `:297`) and routes it into `EnvCell::unpack` in the pruning bake (`apps/holtburger-tools/src/dat2hba.rs:604`). 772 real Environment records are affected |
| `0x0E020000`–`0x0E02FFFF` → 23 MonitoredProperties, registered `m_bIsClientType = 0` (server-only) | REF-ONLY — holtburger lumps all of `0x0E` into `DatFileType::Table` (`mod.rs:298`), which is correct-by-accident for the client subset |
| Singletons `0x0E000007` ChatPoseTable, `0x0E00000D` ObjectHierarchy, `0x0E00001A` BadData, `0x0E00001E` TabooTable, `0x0E00001F` File2IDTable, `0x0E000020` NameFilterTable | PARITY-OK for ChatPoseTable / BadData / TabooTable / NameFilterTable (`file_type/{chat_pose_table,bad_data,taboo_table,name_filter_table}.rs`); TASK(DAT-18) for **File2IDTable** and ObjectHierarchy — both ABSENT |
| Cell-dat forms: LandBlock `(((y>>3) \| 32*(x & ~7)) << 16) \| 0xFFFF`; LandBlockInfo `id & 0xFFFFFFFE \| 0xFFFE`; EnvCell `id & 0xFFFF0100 \| 0x100` + index; `QualifiedDataID` types 1/2/3 | PARITY-OK — `mod.rs:266-280` `from_id_in_dat` dispatches `suffix == 0xFFFF` → Landblock, `0xFFFE` → LandblockInfo, `1..0xFFFD` → IndoorCell, with the documented DAT-context requirement (`:252-260`) |
| `MasterDBMap::IsCellType` takes a **dbtype**, not a DID form | REF-ONLY (decomp trap) |

### §4 The game layer: `gmMasterDBMap` and enum indirection

| Claim | Disposition |
|---|---|
| The client installs `gmMasterDBMap`, not `MasterDBMap`; `gmCLCache::Init` swaps the vftable before `CLCache::Init` | REF-ONLY |
| The 15-row game DB_TYPE table (`0x00000001`–`0x0000FFFF`→WEENIE_DEF, `0x0E000002`→CHAR_GEN, `0x0E00000E`→SPELL_TABLE, `0x30……`→COMBAT_TABLE, `0x38……`→MUTATE_FILTER, …) | PARITY-OK — every game type holtburger needs has a parser keyed on the same DID: `weenie.rs` (wcid), `char_gen.rs` `0x0E000002`, `skill_table.rs`, `spell_table.rs` `0x0E00000E` (`spell_table.rs:110`), `spell_components_table.rs` `0x0E00000F`, `xp_table.rs`, `combat_maneuver_table.rs` `0x30`, `quality_filter.rs` `0x0E01……`, `mod.rs:323` MutateFilter `0x38` |
| `gmMasterDBMap` has its **own** `InitDBTypeDef_Internal` (514905) registering the 15 game types with their own freelist budgets / `m_bIsClientType` | REF-ONLY |
| `DBCache::Init` contains a second `MasterDBMap::Init` that is harmless only via `\|\|` short-circuit ordering | REF-ONLY (decomp trap) |
| **Two-level enum→DID indirection**: `master_map_id_m` (+0x30) → load as type `0x26` DID_MAPPER → `EnumToDID(group)` → load *that* as `0x26` → `EnumToDID(id)` → real DID. "This is why almost nothing hardcodes DIDs." Fonts `GetDIDByEnum(23, 9)`, cursors `(1,6)`, MasterProperty `(15,2)`, StringTables group 4, StringState `(1,4)` | **TASK(DAT-12)** — `master_map_id` is parsed (`lib.rs:223`) and read by exactly one tool (`apps/holtburger-tools/src/dat_shard.rs:254/264/274`); nothing resolves through it. `crates/holtburger-dat/src/well_known_ids.rs:26-66` instead **hardcodes the second-level DIDs** (`ENUM_MAPPER = 0x25000001` … `WEENIE_CLASS_ID = 0x25000015`), i.e. it assumes `EnumToDID(group) == 0x25000000 + group`. Measured `master_map_id = 0x25000000` in the shipped portal DAT, so the assumption currently holds — it is a correctness shortcut, not a live bug |
| `EnumMapper` maps enum→case-insensitive name; only `m_id_to_string_map` on disk, reverse rebuilt at load; `m_base_emp_did` chains to a parent every lookup falls through to | PARITY-OK on the wire format (`file_type/enum_mapper.rs`); TASK(DAT-12) for the **parent chain** — no `m_base_emp_did` fall-through walker |
| `EnumIDMap::Serialize` writes four hash tables in order: `m_EnumToID`, `m_EnumToName`, `m_EnumToIDInternal`, `m_EnumToNameInternal` ("Internal" = second tier consulted on miss) | PARITY-OK — `file_type/did_mapper.rs:15-31` reads exactly four tables in that order (client id, client name, server id, server name), each `u8 numbering_type` + `CompressedUInt count` + pairs. The "Internal"/server pair is the same slot |
| `DualEnumIDMap` adds no serialized state; `InitLoad` inverts `m_EnumToID` and warns `"DataID 0x%08X used multiple times."`; reverse used by `HouseSystem::IsTradeNote` and `SpellComponentTable::WCIDtoSCID` | PARITY-OK on format (`file_type/dual_did_mapper.rs`); TASK(DAT-12) for the collision diagnostic + the inverse map |
| `EnumeratedBitfield` maps **bit positions**, not masks | REF-ONLY — ABSENT in holtburger; see also `10-crypto…` §4.4 |

### §5 Schema and index singletons

| Claim | Disposition |
|---|---|
| `DBFile2IDTable` is a bidirectional filename↔DID registry bucketed per DB type (`TDBTypeEntry` name/game+engine roots/`HighestDIDAssigned`/DID→`TFileEntry`; `TFileEntry` path/filename/DID/dbtype/`m_tFileWriteTime`) — **the asset-build index, shipped inside the dat** | TASK(DAT-18) — ABSENT. This is free provenance for the bake tools (original authoring filenames for every DID) and nothing reads it |
| `MasterProperty` = global property schema: embedded `EnumMapper` + `HashTable<enum, BasePropertyDesc*>`; `BasePropertyDesc` carries type/group/provider/default/min/max/inheritance/propagation/caching/`m_ePatchFlags`/element-count bounds/help text/prediction timeout; fetched via `GetByEnum(15, 2, 45)` | PARITY-OK on the record (`file_type/master_property.rs`); the `GetByEnum(15,2)` route is TASK(DAT-12) |
| `DBPropertyCollection` is a serialized property bag; `.pmat` ⇒ material-property container | TASK(DAT-18) — ABSENT. Measured 2 records at `0x78……` (APPENDIX-B), classified `DatabaseProperties` (`mod.rs:328`) with no parser |

### §6 Class factories and serialization

| Claim | Disposition |
|---|---|
| Each `DBOCache` built with a `DBObj *(*)()` allocator + dbtype, registered in a global hash keyed by dbtype | N/A-WEB — holtburger's equivalent is static dispatch on the prefix (`mod.rs:286`) plus per-type `binrw` parsers; no runtime factory registry |
| Unpacking is virtual `DBObj::Serialize(Archive&)` over a plain `Archive` wrapping `SmartBuffer::MakeWindow(…, 4)` | PARITY-OK in effect — every `file_type/*.rs` `unpack` starts by consuming the `u32 id` (DBObj HasId), e.g. `region.rs:1040-1041`, `landblock.rs:54-55` |
| `Archive` layout + flag bit 0 = packing, bit 2 = error, callers test `~(m_flags >> 2) & 1` | REF-ONLY |
| **Version tolerance is token-based, not field-count-based**: `GetVersionRowForDBObjPackVersion(m_iVersion)` builds three FOURCCs — `'Core' = 2 − (v < 2)`, `'DObj' = ver_`, `'UIL ' = (v >= 3)` — pushed on an `InArchiveVersionStack`; bodies ask `Archive::GetVersionByToken`. RenderMaterial gates on `'RMVT'`, UI code on `'UIL '`. `SerializeFromCachePack` refuses `m_iVersion == 0` | **TASK(DAT-03)** — ABSENT end to end. holtburger never reads `ver_`, so no parser can gate a field on it. **This is not hypothetical**: measured `ver_ ∈ {2, 3}` mixed *within almost every type* in the shipped DATs — e.g. 0x01 GfxObj 10,395 v2 / 4,923 v3; 0x21 UILayout 101/101 v3; 0x23 StringTable 6 v2 / 9 v3 (APPENDIX-B). Any type whose retail `Serialize` is token-gated is being parsed with one fixed assumption |

### §7 The async pipeline

| Claim | Disposition |
|---|---|
| Chain `AsyncCache` → `DBCache` → `ThreadedCache : DBCache, PortalThread` → `CLCache` | N/A-WEB — the browser stack is `ManifestResourceSource` / `HttpResourceSource` → `prefetch` → `shards`; the layering is not portable |
| **Two 1024-slot ring queues** + a Win32 auto-reset event; the worker is a real `CreateThread` | N/A-WEB — one bake Worker (`scene3d/bake_worker.js`) with `postMessage`; ring queues are an artifact of no-allocator-on-IO-thread |
| **Correction: `LFQueue<T>` is SPSC, not MPSC** — plain producer/consumer index compares, **no CAS**, overflow spills to a `List` under a `SharedCriticalSection` | N/A-WEB (REF value only: the doc's own correction) |
| `AsyncGetInternal`: try `GetIfInMemory` → if type can load from disk and `IsOnDisk`, push job + signal → else DDD network fetch → else fail | PARITY-OK in shape — `apps/holtburger-web/src/lib.rs:9717-9731`: memo probe (`surface_memo_get` / `..._composed`) → decode → insert. The negative-cache arm (`MISSING_SURFACES`, `lib.rs:9000-9004`, `:9869`) is holtburger's own addition and has no retail analogue |
| Worker loop: drain, execute, push reply, `WaitForSignal(INFINITE)` | N/A-WEB |
| `WorkerExecuteRequest` dispatches **three** ops via vtable slots (get/purge/save inferred from slot order); `CLCache` adds op 3 BeginDDD. **Saving happens off-thread**, construction never does | N/A-WEB — no writes to the asset store at runtime |
| `WorkerExecuteGetRequest` only does `LoadData` into `pReq->Buf` | REF-ONLY |
| **Main-thread completion time-boxed to 25 ms/frame** — `ThreadedCache::UseTime` `while (GetTickCount() - v2 < 0x19)` (loop @654312) and `AsyncCache::CallPendingCallbacks` identically (@84441) | PARITY-OK-with-note + VERIFY-LIVE — holtburger has the same idea, tighter: `apps/holtburger-web/scene3d/loop.js:1542` `RP3_DEFAULT_BUDGET_MS = 9`, `?frameBudget=<ms>` clamped to `[2, 33]` at `:1566`, `?frameBudget=off` disables (`:1538`). 9 ms is right for a 60 Hz rAF where retail ran ~30 Hz. **VERIFY-LIVE(VL-1)**: the guard covers JS "deferrables" (`:1631` `overBudget`); no equivalent box exists around the *wasm* decode batch, so a single oversized `fetch_terrain_textures` can still blow a frame |
| `OnGetRequestFinished` allocates via `GetFreeObj`/factory, deserializes, and if not fully loaded asks for **sub-DataIDs** (`GetSubDataIDs`/`FilterSubDataIDs`) and issues child gets; `nGetsRemaining` + `RequestsWaitingForMe` = dependency fan-in, so a Setup completes only after its GfxObjs and palettes arrive | PARITY-OK-by-different-means — `apps/holtburger-web/src/prefetch.rs:1-25` implements **iterative discovery via `RecordingSource`**: run the sync walk against a recorder that captures every `get_file_by_key` Err, prefetch the miss set, re-run, terminate on no-new-misses. Same guarantee (no partially-hydrated parse), different mechanism (N+1 re-walks, typical N=2–4) |
| Duplicate concurrent requests deduplicated | PARITY-OK — two layers: `inflight::InflightMap` dedups URL fetches (F.35) and `WalkDedupMap` dedups whole prefetch loops on a caller-supplied `cache_key` (`prefetch.rs:36-80`) |
| **There is no priority field — ordering is FIFO**; `AsyncGetImmediate` / `BlockingGet` for sync needs | **ANTI-TASK(AT-1)** — holtburger deliberately has priority: `src/decode_admission.rs:23-30` documents an **urgent lane** added *because* "FIFO queuing starved interior loads for *minutes*". Porting retail's FIFO would be a regression |
| `CAsyncStateMachine` per-context state machine scripts multi-step flows (e.g. `CClientsideLoginStateHandler`) | N/A-WEB — async/await + `Shared` futures |
| — (not in retail) | REF-ONLY: holtburger's admission gate is *ahead* of retail — two keys (`max_jobs` hard, `max_bytes` shaping), `DecodeLease::revise` because pre-decode byte estimates are off by up to 250× (`decode_admission.rs:17-22`), a documented deadlock-freedom argument (`:39-46`), and a deliberately neutral default `new(usize::MAX, usize::MAX, 0)` (`:33-37`). **VERIFY-LIVE(VL-2)**: since the shipped gate is unbounded, none of the shaping logic is exercised in production today |

### §8 Caching and eviction

| Claim | Disposition |
|---|---|
| `DBObj` carries `m_numLinks`, freelist links, `m_timeStamp`, `m_pMaintainer`; `GetIfUsing` returns only when `m_numLinks > 1` | PARITY-OK in spirit — holtburger's refcount is `Arc::strong_count`, and eviction requires `== 1` (`apps/holtburger-web/src/lib.rs:9542`, `:9611`, `:8428`) |
| `DBOCache::Release` decrements (body @83517); `FreelistAdd` gates on `m_AllowedInFreeList && m_fKeepFreeObjs`, **not** on link count | REF-ONLY (the doc's own first-pass correction) |
| **`DBOCache::UseTime` destroys the oldest free object once the list exceeds ideal size AND `m_timeStamp + 30.0 < Timer::cur_time`** — the 30-second idle rule | **TASK(DAT-06)** — ABSENT. `ByteBudgetLru` (`lib.rs:9135-9234`) evicts **only** from inside `insert` (`:9200` `while self.total_bytes > self.budget`). There is no periodic sweep and no timestamp: after a town load the 96 MiB stays resident forever, even fully idle in an empty field |
| Freelist budgets: GfxObj 100/200, Setup 25/100, Animation 20/80, Palette 60/100 — **per-type object counts** | TASK(DAT-08) — holtburger has **one** shared byte budget (`lib.rs:9240` `SURFACE_CACHE_BUDGET_BYTES = 96 MiB`, `:9242` `SURFACE_CACHE_ENTRY_CAP_BYTES = 16 MiB`) covering both the palette-free and palette-composed surface classes, and `MODEL_TRI_CACHE` uses the same `ByteBudgetLru` type. No per-class reserve, so a texture storm can evict every cached triangulation |
| **The recycle path is dead code**: `GetFreeObj`'s three-way condition needs `m_bRecycle`, which is assigned **0 at all 65 registration sites** with zero nonzero assignments; sibling `m_bShrink` is 1 at 63 sites, so the 0 is deliberate | REF-ONLY — a strong argument *against* porting object recycling |
| **There is no global byte budget — limits are per-type object counts** | REF-ONLY + ANTI-TASK(AT-2) — holtburger's global byte budget is the correct browser-era inversion (a browser cares about bytes, not instances). Do not port count budgets |
| Writable cell dats additionally keep an **on-disk LRU** (`LRU_List`, `LRUB_Mem_t`), `BTree::Restamp_Entry` from `LoadDataEx`, `Try_Delete_Oldest` from `CheckRoom` | N/A-WEB — the on-disk LRU exists to make room for DDD writes; holtburger never writes into a DAT |
| — (not in retail) | TASK(DAT-07) — `ByteBudgetLru`'s victim selection is a full `map.iter().filter().min_by_key()` scan **per victim**, inside the over-budget loop (`lib.rs:9201-9206`) → O(n·k) per insert burst. Retail used an intrusive doubly-linked LRU (O(1)) |
| — (not in retail) | PARITY-OK-with-note: holtburger's `insert` refuses `bytes > entry_cap` outright (`:9183`) — "one pathological texture must not flush the whole cache" (`:9126`). Retail had no analogue; keep it |
| — (not in retail) | VERIFY-LIVE(VL-3) — the `None => break` arm at `:9216` ("run over budget rather than break holders") makes a pinned-handle leak and healthy over-budget operation indistinguishable. Already written up as **PAL-01/PAL-02** in `wave0-palette-leak-patch.md`; not re-raised here |

### §9 DDD writes into the dats

| Claim | Disposition |
|---|---|
| `CAsyncSaveRequest` built in two places; `dwDiskControllerSaveFlags = m_bCompressed ? 12 : 1`; 4 = `dcsfUncompress`, 8 = `dcsfModifyCachePack`; `idIteration` stamped from the server | N/A-WEB — pre-baked HTTP shards replace runtime DAT writes |
| `SaveDataEx` switches on `dwFlags & 7` and applies a **staleness guard** @647775: `if (v12 && v11->iter_ > v12) { win }` — an on-disk entry with a newer iteration silently wins, so replayed/out-of-order `DDD_DataMessage`s cannot downgrade a record | N/A-WEB (no writes) — REF value: this is the only place `iter_` is *semantically* load-bearing, which is why holtburger can get away with mislabelling it (DAT-03) |
| `CheckRoom` needs blocks + **51 slack**, then `ExpandFile(0x100000)` (1 MiB) or `Try_Delete_Oldest` | N/A-WEB |
| `Store_Data` commits `firstFree_`/`iFreeBlocks_` + a 0x50-byte header rewrite at 320 only on the last block; `DeleteBlocks` re-tags with bit 31 and splices onto `finalFree_` | N/A-WEB (the bit-31 *read-side* guard is TASK(DAT-05)) |
| A failed DDD write is fatal: `Turbine::Debug::Abort()` | N/A-WEB |
| Iteration handshake: `CMostlyConsecutiveIntSet` sorted+deduped (`Sort` 646607) with run-length `Serialize` (646696); client loads each dat's set from `0xFFFF0001` into `CAllIterationList` and ships it; **the server computes the delta**; iteration `Add`ed + saved only after the last byte lands | TASK(DAT-15) — `crates/holtburger-protocol/src/messages/misc/types.rs:63-107` `MostlyConsecutiveIntSet` reads the count then accumulates **raw encoded words** without expanding runs, without reading the run-start word after a negative marker, without the bit-30→bit-31 sign restore, and without the 100,000 cap. Its *iteration accounting* happens to come out right (`current_iters += x.abs() - 1` for the marker, `+1` for the start word it then mis-treats as an element), so it round-trips as an opaque blob. Bound to wave1-B **NET-22** (holtburger deliberately never answers `DDD_InterrogationMessage`), so this is latent |
| Protocol side documented in `02-networking.md` §9 | REF-ONLY (wave1-B lane) |

### §10 Startup validation is three-layered and mostly permissive

| Claim | Disposition |
|---|---|
| **(1) Pack version.** `InitFile` compares `eng_pack_vnum`/`game_pack_vnum` vs `DBCache::s_EngDataPackVer`/`s_GameDataPackVer`; mismatch → −6, and with `open_flags & 0x10` the dat is **recreated empty**. Statics default `0xFFFFFFFF`; negative short-circuits | REF-ONLY — holtburger performs no pack-version check at all (`lib.rs:290-306`); it also never recreates a DAT, so the dangerous arm is unreachable |
| **Correction:** `gmCLCache::Init` sets `s_GameDataPackVer = 0` before `CLCache::Init`, and 0 is not negative, so **the game half of the check is live**; only the engine half is short-circuited | REF-ONLY |
| Cell dats use a *different* static pair, `s_EngCellPackVer`/`s_GameCellPackVer` | REF-ONLY |
| **"Whether the shipped `client_portal.dat` actually carries `game_pack_vnum == 0` … cannot be answered from the decompilation; it needs a real dat file."** | **ANSWERED — see APPENDIX-B.** `game_pack_vnum == 0` in all three shipped DATs (portal, cell_1, local_English). `eng_pack_vnum` = 110 / 22 / 110. So the live game-half gate **passes**, and the engine half is short-circuited by `s_EngDataPackVer == −1` as the doc says. Feed this back into `07-dat-resources.md` §10 |
| **(2) Journal replay** — `BTree::RecoverTransaction` | TASK(DAT-16) (see §1) |
| **(3) Per-record versioning is the strongest gate**: `CRegionDesc::UnPack` requires `version == 3` exactly, else one of two `PopupError` dialogs and refusal | TASK(DAT-14) — `crates/holtburger-dat/src/file_type/region.rs:1043` reads `version` into a field and never compares it. A future custom Region at v2/v4 would be parsed as if it were v3 |

### §11 Resource formats

| Claim | Disposition |
|---|---|
| **`DBWave` is NOT a RIFF file**: `u32 headerSize`, `u32 dataSize`, a bare `WAVEFORMATEX` blob, then raw codec bytes | PARITY-OK — `file_type/wave.rs:8-33` documents and reads exactly `id / header_size / data_size / header bytes / data bytes`, with the 18-byte `WAVEFORMATEX` field list spelled out and a `to_riff_wav()` helper (`:38-42`) added purely because `decodeAudioData` needs a container. Verified against `0x0A000002` (header 18, data 7046) |
| **`CSoundTable` is a *recursive* `SoundTableData` tree** keyed by `SoundType`; each node = N × 16-byte `SoundData{sound_id, priority, probability, volume}` **and N children** | TASK(DAT-13) — `file_type/sound_table.rs:23-48` flattens to exactly **one** level: `hash_key`, `num_hashes`, 16-byte entries, `num_sounds`, then per-child `{key, num_entries, entries, [i32 unknown]}`. That trailing "unknown" is the **grandchild count**. I re-read `SoundTableData::Pack` (acclient.c:384970–385120) and confirmed the recursion (child count written at `LABEL_17`, then a virtual `Pack` per child). **Empirically the flattening is safe today**: max nesting depth measured = 1 across all 190 shipped SoundTable records, every record consumed exactly (APPENDIX-B) |
| **`GfxObjDegradeInfo`** = `u32 count` + count × 20-byte `GfxObjInfo{gfxobj_id, degrade_mode, min_dist, ideal_dist, max_dist}` | PARITY-OK — `file_type/degrade_info.rs:15-27` documents the identical layout and cross-checks `0x11000001` = 88 B = 4 + 4 + 4×20 |
| **`ClothingTable`** = two `PackableHashTable`s (setup DID → `ClothingBase`; palette-template key → `CloPaletteTemplate`); **`CloSubpalEffect` is `u32 numRanges`, then `numRanges × {start, length}`, THEN `palSet` last** | PARITY-OK — `file_type/clothing.rs:34-47`: `CloSubPalette { u32 num_clo_sub_palettes …, [CloSubPaletteRange], u32 palette_set }` with `palette_set` **last** and `CloSubPaletteRange {offset, num_colors}`. `PackableHashTable` header noted as `u16 count + u16 bucket_size` (`:17-18`) |
| `BuildObjDesc` turns a shade in [0,1] into one palette DID via `PalSet::GetPaletteID` = `palette_IDs[(u64)((num_pals − 0.000001) * shade)]`; then `CPartArray::SetPalette` → `Palette::makeModifiedPalette` copies the 2048-entry base and overwrites only the named ranges | **PARITY-OK — closes wave0 `PAL-04`.** The epsilon formula is implemented verbatim at `apps/holtburger-web/ui/ac_palette_set.js:94-102` (`Math.floor((set.palettes.length - 0.000001) * s)`, clamped), with the retail citation and the off-by-one history in the doc comment at `:79-86`. `PaletteSet` itself: `file_type/palette_set.rs:26-32` (id, count, DIDs), cross-checked against `0x0F000001` = 24 B. Range splice: `file_type/palette.rs:63-64` documents `Subpalette::UnPack`'s `offset = byte*8`, `numColors = (byte==0?256:byte)*8` and notes ClothingTable ranges are already absolute |
| **LandBlock records are exactly 248 bytes** = `u32 DID` + `pack_size() == 244` = 81×u16 (162) + 81×u8 (81) + 1 pad | **DOC IS WRONG for the shipped DATs — holtburger is right.** Measured: **all 65,025** LandBlock records in `client_cell_1.dat` are **252 bytes** (APPENDIX-B). holtburger's `landblock.rs:52-63` reads `id(4) + has_objects(4) + 81×u16 + 81×u8 + pad(1)` = 252 — PARITY-OK-with-real-bytes. `CLandBlockStruct::pack_size()`'s 244 evidently excludes the `has_objects` dword that the record carries |
| **`LandDefs`** is an empty namespace class; `get_vars` hardcodes height/width 255, cell size 24.0, 8 cells/block, max object height 200.0, sky 1000.0, road 5.0; the only real datum is the 256-float `Land_Height_Table` clamped to [0, 800] | PARITY-OK on the constants that matter — `WorldBuilder.Shared/Lib/Terrain/TerrainAlgorithms.cs` `CellSize = 24`, `LandblockLength = 192`, `VerticesPerLandblock = 81`; holtburger side `crates/holtburger-scenery-bake/src/lib.rs` `CELL_SIZE` / `LANDBLOCK_SIZE` / `VERTEX_DIM`. Height table parsed by `file_type/region.rs` (`LandDefs::unpack`, `:1046`). REF-ONLY for the 200.0/1000.0/5.0 triple (no site reads them) |
| **`CRegionDesc`** `parts_mask` (0x01 sound, 0x02 scene, 0x04 terrain, 0x10 sky, 0x200 misc) + height table + `GameTime` + `SkyDesc` + `AmbientSTBDesc` + scene/terrain tables + `LandSurf`; `LandSurf::UnPack` reads one selector word choosing legacy `PalShift` vs modern `TexMerge`. `CEncounterDesc` has only a `Destroy` — **encounters are server-side** | PARITY-OK on the mask and the field order — `file_type/region.rs:1020-1075`, with the load-bearing note at `:1049-1055` that `dats.xml` emits the optional blocks in **maskmap declaration order** `[SkyInfo, SoundInfo, SceneInfo]`, *not* bit order (SkyInfo's 0x10 comes first despite the higher bit), corroborated against PhatSDK `RegionDesc.cpp:268-306`. The `PalShift` legacy arm is CRY-06 |
| **`CLandBlockInfo`** serializes `num_objects × {DID, Frame(28 B)}`, then `(num_buildings & 0xFFFF) \| (has_restriction << 16)`, each `BuildInfo` with its `CBldPortal` list, optional restriction hash; **`num_cells` *is* stored**; `pack_size` = `32*num_objects + 12` (three fixed dwords) and `Pack` writes that leading dword before `num_objects` | PARITY-OK, exactly — `landblock.rs:163-178`: `id`, **`num_cells`**, `num_objects`, `objects: Vec<Stab>` (`Stab` = `u32 id` + 28-byte `Frame` = 32 B, `:14-18`), `num_buildings: u16` + `pack_mask: u16` (the packed dword), `buildings`, then `restriction_tables` gated on `pack_mask & 1` (`:176`). **Empirically confirmed**: the minimum shipped LandBlockInfo record is 16 B = 4+4+4+2+2 (APPENDIX-B), which pins the field order. Note `BuildInfo.num_portals` is `u32` not `u16` (`:31-33`) — a desync bug fixed against ACE's `List<T>.Unpack` |
| **`CEnvCell`** writes a flag word (bit 0 seen-outside, bit 1 has statics, bit 3 has restriction obj), cell id, `u8 num_surfaces`, `u8 num_portals`, `u16 num_visible_cells`, surface IDs as 16-bit indices promoted `\| 0x08000000`, environment `\| 0x0D000000`, a cell-struct index, a 28-byte `Frame`, portals, visible-cell list (`block_mask \| u16`), static-object list | PARITY-OK — `file_type/env_cell.rs:94-137` reads `id`, `flags`, `cell_id`, `u8 num_surfaces`, `u8 num_portals`, `u16 num_visible_cells`, `num_surfaces × u16`, `u16 environment_id`, `u16 cell_structure`, `Frame`, portals, `num_visible_cells × u16`, statics gated on flag `0x02`, restriction gated on `0x08`. The `\| 0x08000000` / `\| 0x0D000000` promotion is applied at use sites |

### §12 Traps for the unwary

| Claim | Disposition |
|---|---|
| `PFileNode`/`PFileParser` believed unrelated to DATs (Turbine's loose-file text property format for RenderMaterial, UI `StateDesc`, keymaps, dev data); the exhaustive sweep was **not** completed, and `EnumeratedBitfield::FromFileNode` sits next to `InitByDataID` which *does* use DIDs — "treat the separation as likely but unproven" | REF-ONLY — holtburger reads `state_desc.rs` / `layout.rs` / `keymap.rs` straight from the DAT records, so it never touches the loose-file path either way |
| **Type tags look like DIDs** — `0x10000004` & friends are DB_TYPE constants passed to `GetByEnum`, not data IDs | REF-ONLY (decomp trap; heeded — no `0x1000000X` constant appears in `well_known_ids.rs`) |
| **`QualifiedDataIDArray` is not an array** — it is `IntrusiveHashTable<QualifiedDataID, DBObjSaveInfo*>` | REF-ONLY |
| `DiskConBase::GetDatFileID` returns a 64-bit value with `data_set_lm` high, `data_subset_lm` low | REF-ONLY |
| Trampolines and forwarders abound; check function length before concluding | REF-ONLY (heeded throughout — I read `LoadDataEx`-class bodies, not the forwarders) |

## `10-crypto-obfuscation.md`

### §0 Summary

| Claim | Disposition |
|---|---|
| **Exactly two concealment systems**: ISAAC-keyed checksum XOR (effective key space **32 bits**) and spell-formula obfuscation (three stacked layers, per-account) | REF-ONLY — the framing itself; both are covered below |
| Everything else is ordinary: arithmetic checksums, zlib, varint packing, presence masks, PJW hashes, an L'Ecuyer PRNG | REF-ONLY |
| **Nothing protects confidentiality**; credentials cleartext; both ISAAC seeds in the clear; DH **not implemented**; no payload ever encrypted | PARITY-OK — holtburger is identically cleartext by construction (WebSocket transport; `holtburger-transport-ws`) |

### §1 Checksums

| Claim | Disposition |
|---|---|
| `PortalChecksum::CalcChecksum32` — seed `size << 16`, wrapping dword adds, tail bytes `<< (8*j)` with **j descending 3,2,1**, **zero-extended** (`movzx`, resolved across three decompilations) | **PARITY-OK, verbatim** — `crates/holtburger-protocol/src/crypto.rs:8-27`: `checksum = (len as u32) << 16`; dword loop; `shift = 3` then `data[i] as u32) << (8*shift)` with `shift -= 1`. `as u32` on a `u8` **is** zero-extension, so holtburger is on the correct side of the doc's hardest-won finding. Golden vectors pin it: `Hash32::compute(b"ABCDE") == 0x89484241`, `b"A") == 0x41010000` (`:245-250`) |
| `SharedNet::ChecksumHeader` — 20-byte `ProtoHeader{seqID_, header_, checksum_, recID_, interval_, datalen_, iteration_}`, stack copy with `checksum_ = 0xBADD70DD`, closed form `0xBAF170DD + seqID + header + (recID \| interval<<16) + (datalen \| iteration<<16)` | **PARITY-OK, verbatim** — `crates/holtburger-protocol/src/messages/transport.rs:19` `CHECKSUM_SEED = 0xBADD70DD`; `:149-158` clones the header, substitutes the seed, packs, and calls `Hash32::compute`. Field order/widths match at `:93-102` and `:137-147` |
| **Why the substitution exists**: makes the result independent of the field's current value, so one routine is additive on send and subtractive on receive | REF-ONLY |
| Send @369247 `checksum_ += ChecksumHeader(hdr)`; receive @369987 `checksum_ -= ChecksumHeader(hdr)`; residual is the body-only checksum, compared @370677 | **PARITY-OK — and the doc's phrasing is a trap I resolved against the decomp.** Read naively (§2.4's table says `EncryptData`'s data is "local copy of `checksum_`") one concludes the wire value is `(body + header) ^ key`. It is not. `FlowQueue::EncryptChecksum` (acclient.c:374446) and the transmit loop (`:375157-375169`) encrypt **`NetPacket::checksum_` — the body-only sum** — and only then `newHeader.checksum_ = v5->checksum_`, after which `SharedNet::SendPacket` (`:369221`, add at `:369247`) adds `ChecksumHeader`. Wire = **`header_checksum + (body_checksum ^ key)`**. Receive confirms the same order: the `-= ChecksumHeader` at `:369987` runs immediately after `recvfrom`, *before* `ProcessNewSeqNum` decrypts in place (`:372100`). holtburger does exactly this: `crates/holtburger-session/src/session/send.rs:108` `header.checksum = header_hash.wrapping_add(payload_hash ^ key)`. **No change needed; recommend correcting the doc.** |
| `NetPacket::ComputeChecksum` — clears `checksum_` and `npfChecksumEncrypted`, sums each optional header via `CalcChecksum32(oh.m_pData, oh.m_cbData)`, then per fragment `CalcChecksum32(hdrRead_, 0x10)` + `CalcChecksum32(dat_, blobFragSize - 16)`. Optional headers contribute on equal footing; `m_dwMask`/`m_Flags` are **not** checksummed (the mask reaches the wire OR'd into `header_`, which *is* covered) | PARITY-OK — `session/send.rs:24-64` `calculate_payload_hash`: optional-header bytes from `OptionalHeaderCursor::hash_bytes()` (`:28-33`), then per fragment the 16-byte header (`:44`) plus `frag_header.size - FRAGMENT_HEADER_SIZE` data bytes (`:47-58`), all wrapping-added |
| On receive `ComputeChecksum` is never called — the sum is built incrementally by `AddOptionalHeader`/`AddFrag` with identical formulas, so both directions are symmetric by construction | PARITY-OK — holtburger uses the *same* `calculate_payload_hash` on both sides (`session/receive.rs:167`), which is strictly simpler and equally symmetric |
| **This is error detection, not a MAC** | REF-ONLY |
| — (not in retail) | PARITY-OK-with-note: retail caches the body sum (`if (!v5->checksum_) ComputeChecksum(v5)` @375156) so a body sum that happens to be 0 is recomputed every send. holtburger recomputes unconditionally — no bug, tiny cost |

### §2 Network cryptography

| Claim | Disposition |
|---|---|
| §2.1 **One 32-bit word per packet: the header checksum field. Nothing else** | PARITY-OK (see §1 above) |
| §2.2 `QTIsaac<8, unsigned long>` = Bob Jenkins' ISAAC, `RANDSIZL=8`, `RANDSIZ=256`, `randrsl`/`randmem` each 256 words | PARITY-OK — `crypto.rs:35-36` `mm: [u32; 256]`, `rand_rsl: [u32; 256]` |
| §2.2 `shuffle` (= reference `mix()`), the 8-line ladder | **PARITY-OK, verbatim** — `crypto.rs:138-163`, line for line, all `wrapping_add` |
| §2.2 `randinit` — `a..h = 0x9E3779B9`, 4× mix, then pass 1 adding `randrsl[i+0..7]` and pass 2 adding `randmem[i+0..7]`, each followed by `mix()` and a store; then `isaac()`; `randcnt = 256` | **PARITY-OK** — `crypto.rs:107-136`: golden ratio at `:108`, 4× shuffle at `:110-112`, the two-pass loop at `:114-128` (`if i < 1` selects `rand_rsl` else `mm`), then `scramble()` at `:135` |
| §2.2 `isaac` — standard, unrolled 4×, barrel-shift cycle `a<<13, a>>6, a<<2, a>>16`, `ind(x) = randmem[(x & 0x3FC)/4]`. No altered constants, no extra XOR | **PARITY-OK** — `crypto.rs:165-186`: `match i & 3` gives exactly `<<13, >>6, <<2, >>16` (`:172-175`); `mm[(i+128) & 0xFF]` at `:178`; `mm[((x >> 2) & 0xFF)]` at `:179` — which is precisely `ind` (`(x & 0x3FC) >> 2`); `b = mm[((y >> 10) & 0xFF)] + x` at `:183` |
| §2.3 **The seeding collapses the key space to 32 bits** — `CryptoSystem(seed)` builds `QTIsaac(seed, seed, seed)`; the ctor **zeroes `randrsl[]`** then sets `randa=randb=randc=seed` and calls `randinit(bUseSeed=1)`. So `randmem[]` is a fixed universal table and the seed enters only via the final `isaac()`, which begins `a = seed`, `c = seed + 1`, `b = 2*seed + 1` | **PARITY-OK, including the derived triple** — `crypto.rs:50-51` zero-initialises both arrays; `:131-133` sets `a = b = c = seed` **after** the two-pass loop and before `scramble()`, which is equivalent because `randinit(true)` never touches `randa/b/c`. `scramble()` opens `c += 1; b += c` (`:166-167`) = `b + (++c)`, giving exactly `a = seed`, `c = seed+1`, `b = 2*seed+1`. The comment at `:130` even calls it out ("ACE specific"). Pinned by five golden seeds at `:252-284` (e.g. `Isaac::new(0)` ⇒ `0x182600F3`, `0x300B4A8D`) |
| §2.3 `QTIsaac::srand` would have seeded properly but is **dead** (vtable slot 2 only) | REF-ONLY |
| §2.4 `GetNextCryptoSeed` — `iteration` never read; `lastIter_` written never read; draws **downward** from `randrsl[255]` to `[0]`, then `isaac()` refills; exactly 256 words per run, no duplication or skipping across the boundary | **PARITY-OK** — `crypto.rs:96-105` `next()`: `val = rand_rsl[offset]` starting at `offset = 255` (`:46`), decrementing, and on `offset == 0` it returns `rand_rsl[0]` then `scramble()` + `offset = 255`. I traced retail's `randcnt` from 256 down through the refill: both yield indices 255→0 per pool, 256 words per `isaac()`, no boundary duplication |
| §2.4 `EncryptData` — one key word, **the SAME word XORed over every dword**, trailing `size % 4` bytes left cleartext, encryption == decryption; all three call sites pass length **4**, so the loop never iterates more than once | PARITY-OK-in-effect — holtburger XORs the single 32-bit checksum directly (`send.rs:108`, `receive.rs`), i.e. it hard-codes the only case retail exercises. The general "same word over N dwords" primitive is ABSENT and unnecessary |
| §2.4 The `pEncryptSeed` replay path: `ReceiverData::AddNakked` pre-draws and stores the key word for each missing seqID in the `m_SeqIDsWeNAKed` AVL, handing it back when the retransmit arrives — that is what keeps both endpoints' pools aligned across loss | **TASK(CRY-10)** (extends wave1-B **NET-17**, do not double-count) — holtburger resyncs by a **256-key forward search** (`crypto.rs:73-93` `Isaac::search`, `consume_key_value` at `:65-71`). Two details wave1-B does not record, which I verified in the decomp: (a) `SharedNet::ProcessNewSeqNum` (acclient.c:372085-372097) **drops** an encrypted packet outright (`return 0`) when it is not newer than `highestIDReceived_` *and* its seqID is absent from the NAK AVL — retail never guesses; (b) the outbound retransmit path *cannot* re-draw: the encrypt block is gated on `!(flags_ & 1)` and `flags_ \|= 1` is set on first encryption (`:375157-375162`), so a resend ships the already-encrypted value with the original key. holtburger's send side matches (b) exactly by algebraic key recovery — `crates/holtburger-session/src/session/reliability.rs:122-134` `isaac_key = payload_hash ^ (header.checksum − original_header_hash)`, then re-adds with the new header hash. **Only the receive side diverges** |
| §2.4 Wire gating is `header_ & 0x2`; internally `npfChecksumEncrypted = 0x1` in `NetPacket::flags_` | PARITY-OK — `send.rs:92-100` sets `packet_flags::ENCRYPTED_CHECKSUM` when an ISAAC context exists and the packet is not a handshake (`LOGIN_REQUEST`/`CONNECT_REQUEST`/`CONNECT_RESPONSE`) |
| §2.5 DH: parameters real, hardcoded, 256-bit (`shared_base` / `shared_prime`, identical in their first 56 nibbles); **no exchange is ever computed** — `PortalDH::Init` is the only member and just stores two `vlong`s; the private exponent is the literal `10`; `vlong` has **no division/modulo/monty/modular inverse** so modexp is arithmetically impossible; `NetKeyExch` is inert | N/A-WEB / REF-ONLY — nothing to port; holtburger has no DH and correctly should not |
| §2.6 `NetAuthenticator::StreamPack` field order; `m_CryptoData` **always empty**; auth types `0x1` none / `0x2` VG password / `0x40000002` GLS ticket; `SetToAuthType` plain `qmemcpy`; `AUTHFLAGS_ENABLECRYPTO = 0x1` declared but dead (`m_dwAuthFlags` written once, to 0) | PARITY-OK for the fields holtburger sends — `crates/holtburger-protocol/src/messages/C2S/Login_SendEnterWorld*`/`transport.rs`; the always-empty crypto blob and the dead flag are REF-ONLY |
| §2.6 `CConnectHeader` (mask `0x40000`) = `{double ServerTime; uint64 qwCookie; uint32 NetID; uint32 OutgoingSeed; uint32 IncomingSeed}`, cross-assigned into two `CryptoSystem(seed)`s; an observer who sees the connect header reproduces the whole keystream | PARITY-OK — `transport.rs:76-90` unpacks `{server_time, cookie, client_id, server_seed, client_seed}` in that order and feeds two `Isaac::new(seed)` contexts |
| §2.7 `ohfEncrypted = 0x20000000` / `ohfSigned = 0x40000000` are **set but never verified**; every read of `m_Flags` tests only `0x1..0x40`; both dispatchers key on `m_dwMask`; the referral cookie is an **unauthenticated bearer token** replayed verbatim | REF-ONLY — bears on wave1-B's referral/reconnect items (NET-10), not on this lane |
| §2.8 `NetBlobIDUtils` bit layout (0..31 seq, 32..47 ordering stamp, 48..55 server ID, 56..60 ordering type, 63 ephemeral); masks `0x1F00000000000000` / `0x00FF0000FFFFFFFF`; `LHSNewerOrderingStamp` wrapping 16-bit compare with threshold `0x7FFF`. **Plain bit-packing, no scrambling.** Two caveats: the `stamp << 32` term is invisible (IDA drops `edx`), and `MakeInitialSequenceID` decompiles as return-0 on every path | REF-ONLY here — this is wave1-B **NET-15**'s territory (the 64-bit blobID modelled as two opaque u32s). Recorded so the bit layout is not lost: no crypto is involved, so NET-15 is a pure packing fix |

### §3 Spell-data obfuscation

| Claim | Disposition |
|---|---|
| §3.1 **Layer 1 nibble swap** — self-inverse, byte-wise, on a private copy; `p = m_buffer + 20`, `end = m_buffer + m_len + 19`, so it covers `strlen` bytes and **excludes the NUL**; `break_reference` always invalidates the cached hash, so every downstream hash is over the *deobfuscated* text | **PARITY-OK, with the bounds verified against retail's writer.** `crates/holtburger-dat/src/utils.rs:192-204` `read_obfuscated_string` reads `u16 length`, then `byte.rotate_left(4)` over exactly `length` bytes. I read `AC1Legacy::PStringBase<char>::Pack` (acclient.c:296374-296400): it writes `m_len - 1` as the length and copies `m_len - 1` bytes — so the on-disk length **is** `strlen`, and swapping all of it is exactly retail's range. Downstream hashing is over the decoded text (`utils.rs:318-319`) ✓ |
| §3.1 All five swap sites (`InqDescription` 448856, `InqSpellFormula` 448899 + 448912, `SpellComponentBase::InqName` 487046, **`QuestDef::QuestDef` 510828 — non-spell**) | PARITY-OK for the four spell sites — `file_type/spell_table.rs:117-124` swaps `name` **and** `description` (each followed by `parse_align`, `:120`/`:124`), `file_type/spell_components_table.rs:86-105` swaps component `name` **and** `text`. **TASK(CRY-05)** for `QuestDef`: holtburger has no QuestDef (`0x0E00001B`) parser at all, and `contract_table.rs:68`/`:82-99` (a *different* record, `0x0E00001D`) correctly uses plain `read_pstring_char`. Recorded as a forward-looking trap: when a QuestDef parser lands, its `_fullname` **is** nibble-swapped |
| §3.1 There is no `CSpellBase::InqName`; `GetSpellName` casts `CSpellBase*` → `SpellComponentBase*` because both place `PStringBase _name` at offset 4 (same hack at 10 more sites) | REF-ONLY (decomp trap) |
| §3.1 **`SpellComponentBase::_text` is stored obfuscated with no deobfuscating accessor** — retail never displays it; anyone dumping it must swap it themselves | **holtburger is AHEAD** — `spell_components_table.rs:104-105` swaps `text` (the spell-words chant fragment) and `apps/holtburger-web/ui/ac_spell_cast_sequence.js` renders it. PARITY-OK+ |
| §3.2 The PJW/ELF hash with the `>> 24` fold, identical across all three symbols; **signed `char`**; `if r == 0xFFFFFFFF: r = 0xFFFFFFFE` sentinel | **PARITY-OK, verbatim** — `utils.rs:268-279` `spellbase_string_hash`: Windows-1252 encode, `let c = b as i8`, `result = c + (result << 4)`, fold `(result ^ ((result & 0xF0000000) >> 24)) & 0x0FFFFFFF`. I confirmed the decomp bodies at acclient.c:69999 and :78974 are byte-identical to each other and to this. The i64 accumulator is safe: any round that could exceed 28 bits triggers the fold-and-mask, and a negative `result` always has bits 28–31 set so it always folds — arithmetic is identical to retail's uint32. **The `-1` sentinel is unreachable in both** (the result is always `< 0x10000000`), so its absence in holtburger is harmless — worth noting in the doc as dead code |
| §3.2 Key formation `key = (hash(nibble_swap(name)) % 0x12107680) + (hash(nibble_swap(desc)) % 0xBEADCF45)`, wrapping add | **PARITY-OK, verbatim** — `utils.rs:288-289` `SPELLBASE_NAME_HASH_KEY = 0x12107680`, `SPELLBASE_DESC_HASH_KEY = 0xBEADCF45`; `:322-323` `(name_hash % NAME) .wrapping_add(desc_hash % DESC)` |
| §3.2 **Both moduli are no-ops** — the `& 0x0FFFFFFF` fold caps the hash at 268,435,455 while the moduli are 303,068,800 and 3,199,061,829. "The key is simply `hash(name) + hash(desc)` mod 2³²." Verified numerically | PARITY-OK — holtburger applies them anyway, which is faithful and free. REF value: nobody should "optimise" them away and then wonder why nothing changed |
| §3.2 `SpellFormula::Decrypt` — `for i in 0..7: if _comps[i] != 0: _comps[i] -= key`; zero is the empty-slot sentinel; fully unrolled; **there is no `SpellFormula::Encrypt`** | **TASK(CRY-03)** — `utils.rs:326-337` matches (skip 0, wrapping sub) **but adds a non-retail fixup**: `if comp > 198 { comp &= 0xFF }` (`:331-333`). I read the retail body (acclient.c:487851-487886): eight unrolled `if (v) comps[i] = v - key;` and **nothing else** — no ceiling, no mask. The fixup is a DatReaderWriter workaround; if it ever fires, our hash or our string decode is wrong for that spell, and the mask silently produces a plausible-looking wrong component |
| §3.2 The constants are stable across versions (identical in the 6.95 and 2015 decompilations) | REF-ONLY |
| §3.3 **Layer 3 — per-account taper scrambling.** `RandomizeForName` dispatches on `_formula_version`; unrecognised version leaves plain `Decrypt` output. `TAPER = MagicSystem::GetLowestTaperID() = 63` (bare `return 63`). Every rewritten slot is `expr % 0xC + 63`, i.e. tapers **63–74**; **only accent slots change** — scarabs and the power component are never touched, so the formula stays castable-looking but does not transfer between accounts | **TASK(CRY-01)** — ABSENT. `crates/holtburger-world/src/spell.rs:96-99` exposes `decrypted_components` (Layer-2 output only) and the JS spellbook renders it (`apps/holtburger-web/plugins/spellbook.js:864-867`); `utils.rs:266-267` explicitly says taper rotation is "not yet ported". So **holtburger displays the wrong formula for every spell with `formula_version ∈ {1,2,3}`** — slots 1/3/6 show whatever taper the DAT happened to hold rather than the account's. ACE already implements all three versions (`~/ace-server/Source/ACE.DatLoader/FileTypes/SpellTable.cs:58-171`) and I cross-checked its algebra against the doc term by term — they agree exactly, so the port is a transcription |
| §3.3 Version 1 (@487980) — dynamic slot selection driven by the count of non-zero comps; `n ≤ 5` ⇒ **no-op**, `n = 6` ⇒ slot 1, `n = 7` ⇒ slots 1+3, `n = 8` ⇒ slots 1+3+6; all reads before any write; the `accent1` block has a div-by-zero guard but **no division**; `seed / (A+S)` is unsigned so it yields 0 whenever the divisor exceeds `seed`, frequently making `_comps[3]`/`_comps[6]` come out exactly 63 | TASK(CRY-01). REF note: ACE's `RandomizeVersion1` **omits the three `if (X+Y)==0: A=1` guards**, so an all-zero divisor throws `DivideByZeroException` there. Port the guards from the doc, not from ACE |
| §3.3 Version 2 (@488093) — unconditional, always rewrites slots 3 and 6; same `0x13D573` modulus; **no div-by-zero guard**; `2*c4*c5` and `c0*c2` can overflow (32-bit wrapping) | TASK(CRY-01) — ACE's V2 algebra reduces to the doc's exactly (I expanded both) |
| §3.3 Version 3 (@488138) — seven moduli (`0x13D573`, `0x4AEFD`, `0x96A7F`, `0x100A03`, `0xEB2EF`, `0x121E7D` paired with slots 0/1/2/4/5/7, plus `0x65039` applied to **raw** `h` for slot 6 only); all `a*` already in [0,11] so nothing overflows | TASK(CRY-01) — ACE matches; ACE additionally handles `comps.Count < 8` by substituting 0 for `comps[7]` (spell 2697 "Aerfalle's Touch"), which the doc does not mention. Keep that guard |
| §3.4 **The bypass** — `GetAppropriateSpellFormula` picks by `_school` → prop 297/296/295/294/328; `InqInt(prop) > 0` **or** `MagicPackIsOwned(essenceWCID)` ⇒ `InqScarabOnlyFormula` (**not** scrambled), else `InqCustomizedSpellFormula` (scrambled). `InqScarabOnlyFormula` keeps only components in `{1..6, 0x6E, 0x6F, 0x70, 0xC0, 0xC1}`, stops at the first empty slot, then appends `k` copies of component `0xBC` (188, prismatic taper) where `k` derives from the power level. **The decrypt layer is never bypassed** | **TASK(CRY-02)** — ABSENT. ACE has it (`ACE.Server/Entity/SpellFormula.cs:339-379` `GetFociFormula`: scarab whitelist `IsScarab(c) \|\| c == 111`, then `numTapers` by `Power` 1⇒1, 2⇒2, {3,4,7}⇒3, {5,6,8,9,10}⇒4, appending **188**), plus `GetCurrentFormula` selecting on `player.HasFoci(school)` (`:383-386`). holtburger renders one formula unconditionally |
| §3.4 `0x6F` (111, chorizite) is accepted by `InqScarabOnlyFormula` but is **absent from `DeterminePowerLevelOfComponent`** (488433), so such a scarab scores 0 — a genuine client bug | REF-ONLY — ACE's comment at `SpellFormula.cs:347` (`// added: chorizite, as per client`) shows it already knows. Do not "fix" it |
| §3.5 Python reimplementation reference | REF-ONLY — transcribed into the FORMULA APPENDIX |

### §4 Hashes and pseudo-random generators

| Claim | Disposition |
|---|---|
| §4.1 PJW/ELF hash used for spell keys, **`NetError` string IDs** (every wire `NetError` is `{stringID, tableID}` with `stringID = compute_str_hash("ID_ConnectionError_BadCryptoKey")`-style), and `PStringBase`'s cached hash at buffer +12 | PARITY-OK for the spell use (`utils.rs:268`). **TASK(CRY-09)** for `NetError`: no `NetError` type exists in `holtburger-protocol`/`holtburger-session`, so a server-side disconnect reason is unrenderable. The hash needed is already in-tree — reuse `spellbase_string_hash` |
| §4.1 — **plus a finding the doc does not have**: holtburger has a *second*, unrelated `string_hash` (`utils.rs:513-525`) — `h = ((h << 4) \| (h >> 28)) ^ (b as i8)`, masked once at the end — used for StringTable/EnumMapper/DBObj name lookups | REF-ONLY, **with a warning**: I searched the decomp for that rotate form (`rg -n '>> 28' acclient.c` → 4 hits, none a hash) and it **does not exist in acclient.exe**. It is a DatReaderWriter/Chorizite-lineage hash. The two are genuinely different (`string_hash("WalkForward") == 0x0085473E` vs ELF's `0x0D345A74`, hand-computed). `utils.rs:248-262` already documents "Don't merge them" — that warning is correct but its claim that "this split is real in retail acclient.exe" is **unsupported**: only the ELF family is in the binary. Harmless (the rotate hash is used only where it round-trips against WB.Terminal), but the comment overstates its provenance |
| §4.2 `Random::rand` = Numerical Recipes `ran2` verbatim — L'Ecuyer combined MRG + Bays–Durham shuffle; state globals `_seed`=1, `_idum2`=123456789, `_iv[32]`, `_iy`; the full constant block; 40 warm-up iterations of which only the last 32 fill the table; exact range **[AM, RNMX] = [4.66e-10, 0.99999988]** — never 0, never ≥ 1; period ≈ 2.3e18; seeded once per process from `time(0)` | **TASK(CRY-07)** — ABSENT (zero hits for `RNMX`, `2147483563`, `40014`, `ran2`, `Ecuyer` across all crates + `apps/holtburger-web`). Roughly 35 retail call sites, all cosmetic: particle emitters, ambient sound selection, weather descriptors, scene/animation choice, idle chatter. holtburger's ambient/idle variety therefore cannot be bit-identical to retail |
| §4.2 `RollDice(int lo, int hi)` = `lo + trunc(rand() * (hi - lo + 1))`, uniform over `[lo, hi]` — the `RNMX` clamp is what stops it overshooting. `RollDice(float lo, float hi)` = `rand() * (hi - lo) + lo`, **half-open, never reaches `hi`** | TASK(CRY-07) |
| §4.2b Other PRNGs: CRT `rand()`/`srand()` thunks; `RandDouble(min,max)` = `rand() * (1/32767) * (max-min) + min`; `RandInt(range)` = `range * rand() / 0x8000`; `RandInt(range, exclude)` rejection loop; `srand` seeded at three sites — `ClientNet` ctor, `SoundManager::Init`, and `PerlinNoise::Init` with **`srand(0)`** (deliberately deterministic), the last two fighting each other so `RandInt`/`RandDouble` streams are **not** reproducible across runs | REF-ONLY — the non-reproducibility is itself the reason not to chase bit-parity on these |
| §4.2b **The half-open range has a real consequence**: sound variant selection computes `(N-1) * roll`, which can never reach `N-1`, so **the last variant in every multi-variant sound table node is unreachable** | REF-ONLY here (owner: the `09-audio.md` agent) — but recorded because it is a DAT-shaped fact: holtburger's `sound_table.rs` exposes all N variants, so uniform selection would play sounds retail never played. Cross-reference when the audio lane picks a variant |
| §4.3 **Coordinate hashes — deterministic procedural placement**, a family normalised by `2.3283064e-10` = 1/2³², effectively part of the protocol because client and server must agree | See the five family rows below |
| §4.3 Landcell triangulation: `v = y*(214614067*x + 1813693831) − 1109124029*x − 1369149221`; `SWtoNEcut = (double)(uint32)v * 2.3283064e-10 >= 0.5`; hex `0x0CCAC033`, `0x6C1AC587`, `0x421BE3BD`, `0x519B8F25`; `x`/`y` are **global** cell coords (`block_x = ((id>>24)&0xFF)*8`); the float compare is exactly a test of `H & 0x80000000` | PARITY-OK — `crates/holtburger-scenery-bake/src/height.rs:50` and `:148` carry the expression verbatim (`x*y*0x0CCAC033 - x*0x421BE3BD + y*0x6C1AC587 - 0x519B8F25`) with the decimal cross-check at `:168`; `WorldBuilder.Shared/Lib/Terrain/TerrainAlgorithms.cs` `IsSWtoNEcut` and `crates/holtburger-dat/src/transition/terrain_collision.rs:11` cite `1813693831`. Pinned in `crates/holtburger-scenery-bake/tests/golden_decomp.rs:28-29` |
| §4.3 **Family A** — `0x6C1AC587*y − K*(0x511E5B6F*y*x + 0x708F5CB7) − 0x421BE3BD*x` with `K` = `23399` (get_land_scenery), `k + 32593` (ScaleObj), `iq + 45773` (Place X), `iq + 72719` (Place Y), `k + 63127` (GetObjFrame heading) | **TASK(DAT-09)** + **DOC CORRECTION.** (a) The two inner hex constants in the doc are **mis-transcribed**. I read `ObjectDesc::Place` (acclient.c:462619-462628) and `GetObjFrame` (:462670) directly: they are `1360117743` = **`0x5111BFEF`** (doc says `0x511E5B6F`) and `1888038839` = **`0x70892FB7`** (doc says `0x708F5CB7`). holtburger/ACE have the right decimals (`crates/holtburger-scenery-bake/src/noise.rs:123-126`), so holtburger is correct and the doc must be fixed — this is the same class of error the doc itself confesses for the `SWtoNEcut` constants. (b) **`K` for `get_land_scenery` is `kq + 23399`, not `23399`.** I read the loop (acclient.c:352655-352735): `v17 = 23399 * v38` before the loop, and at the bottom `v17 = v38 + scene_id; scene_id += v38` — strength-reduced `(kq + 23399) * v38`, matching the `(index + magic)` shape of all four sibling uses. ACE (`Scenery.cs:59`) and therefore holtburger (`crates/holtburger-scenery-bake/src/lib.rs:458`) compute the noise **loop-invariantly**, so every scenery object at scene index ≥ 1 is frequency-culled with the wrong noise. PARITY-OK for the four sibling `K`s (`noise.rs:148`, `:156`, `:183`, `:205`) |
| §4.3 **Family B** — `0x6C1AC587*y − x*(M*y + 0x421BE3BD) + C`: `ObjectDesc::Place` 4-way rotation quadrant (`M = 0x6F7BD965`, `C = −0x17FCEDFD`); `PalShift::SelectRot` land-texture index (`M = 0x622DBEDF`, `C = −0x791C2B27`); `PalShift::GetBeginRotIx` (`M = 0x1DE6BF23`, `C = +0x490893B5`) | PARITY-OK for the quadrant — `noise.rs:99-112` uses `1870387557` (= `0x6F7BD965`) and `402451965` (= `0x17FCEDFD`), both of which I verified digit by digit; the four-way branch at `:160-170` (`q >= 0.75` ⇒ `(y, -x)` …) matches acclient.c:462630-462655 exactly. **TASK(CRY-06)** for the two `PalShift` members — ABSENT (zero hits for `0x622DBEDF`/`1647165151` or `0x1DE6BF23`/`501661475`, and no `PalShift`/`SelectRot`/`GetBeginRotIx` symbol anywhere). This is the **legacy** land-surface path that `LandSurf::UnPack`'s selector word chooses instead of `TexMerge`; the shipped Dereth Region takes the `TexMerge` arm, so it is dormant, not broken |
| §4.3 **Family C** — `y*(M*x + 0x6C1AC587) − 0x421BE3BD*x + C`: `ConstructPolygons` `SWtoNEcut` (`M = 0x0CCAC033`, `C = −0x519B8F25`); `get_land_scenery` scene-of-`SceneCount` (`M = 0x2A7F2B89`, `C = +0x7F8CDA01`) | PARITY-OK — `noise.rs:47-59` `cell_mat_scene`: `712977289` (= `0x2A7F2B89`) and `2139937281` (= `0x7F8CDA01`), both verified digit by digit; pinned bit-exact at `tests/golden_decomp.rs` (`cell_mat_scene(42, 314) == 0x7F0E8239`, `(1000,1000) == 2_168_064_849`) |
| §4.3 **Family D** — 1-D on the terrain pcode: `0x523AA99E*pcode − 0x51C9E74A`, then `floor(H * 2⁻³² * count)`; `TexMerge::FindRoadAlpha` (304712) and `FindTerrainAlpha` (304781 side, 304804 corner) | **PARITY-OK, and holtburger already chose the decomp over ACE** — `crates/holtburger-dat/src/terrain_merge.rs:144-155` `texmerge_prng`: `1379576222u32.wrapping_mul(pcode).wrapping_sub(1372186442)` then `(v as f64) * 2.3283064e-10 * num`, floored and range-checked. `1379576222 == 0x523AA99E` and `1372186442 == 0x51C9E74A` (verified digit by digit). The module header at `:19-27` documents the deliberate correction: **ACE computes it in 64-bit `long` and does not wrap; acclient wraps mod 2³², and the wrapping form is what makes the index well-distributed** — exactly the kind of decision this mining exercise wants |
| §4.3 **Family E** — 1-D on the absolute game day: `t = current_day + days_per_year * current_year`; `H = (0x6A42FDB2*t − 0x7541E9AE) mod 2³²`; `g = floor(H * 2⁻³² * day_groups.m_num)`; `SkyDesc::CalcPresentDayGroup` (301664, expression @301686) | **PARITY-OK** — `crates/holtburger-world/src/sky.rs:576-585` is a verbatim port with the constants `1782775218` and `1967253934`, which I verified are exactly `0x6A42FDB2` and `0x7541E9AE`; `wrapping_mul`/`wrapping_sub` for the C++ unsigned semantics; the `if dayGroup < num_used else 0` clamp; wrapped by a `(day, year)`-keyed cache at `:548-559`. **VERIFY-LIVE(VL-4)**: `game_time_dpy` (`:572-574`) hard-returns **360** as a `days_per_year` fallback, with a comment claiming "both real callers DO pass GameTime through `evaluate`" — the cached path at `:556` passes this fallback, so a Region whose `GameTime.days_per_year ≠ 360` would silently pick the wrong day group. Check `__diag` weather state against `@time`/server day |
| §4.3 "Together these generate scenery placement, texture selection, terrain triangulation, object scale and heading, and the weather day-group — **all with zero replication traffic**, which is why they must match the server bit for bit" | REF-ONLY — the single most important framing sentence for DAT-09: a wrong coordinate hash is not a cosmetic difference, it is a desync from the server's own view of the world |
| §4.4 `EnumeratedBitfield` — enum value `N` maps to bit `N−1`; enum 0 is reserved and round-trips to 0 (unrepresentable); width 32 or 64 by instantiation, so larger enum values silently overflow | TASK(DAT-15, folded) — ABSENT. Low value: no holtburger site consumes an `EnumeratedBitfield`-encoded field today. Recorded so nobody reinvents the off-by-one |
| §4.5 `PerlinNoise` — `Init` does `srand(0)` (deliberately fixed), `p[i] = i`, `g1[i] = (rand() % 512 − 256)/256` → `[-1, 1)`, a Fisher–Yates with a **biased** index (`j = rand() % 256` for all `i`), then wrap-tail copies of `g1[0..257]`/`p[0..257]`; `Noise(x)` = `t = x + 10000.0`, `i = (uint8)(int)t`, `f = t − (int)t`, classic **cubic** smoothstep `f*f*(3 − 2f)`, not the quintic | **TASK(CRY-08)** — ABSENT (zero hits for `perlin` anywhere in `crates`/`apps/holtburger-web` outside `node_modules`). Fully deterministic (`srand(0)`), so it is exactly reproducible — the cheapest possible parity win if anything visual depends on it |
| §4.6 Hash-table bucket derivation, four families: `IntrusiveHashTable` = true modulo with per-key-type `HashOf` (identity for `unsigned long`; **`m_data1` only** for `Turbine_GUID`; memoised ELF for `PStringBase`; case-folded for `CaseInsensitiveStringBase`), auto-grow at load factor 2, **23-entry prime-ish size table**, in-place `m_aInplaceBuckets[23]`; `LongHash`/`HashBase<unsigned long>` = `table_mask & (key ^ (key >> 8))` with `table_mask = 2^ceil(log2(size)) − 1` (**the classic AC object-ID hash**); `UI64Hash` = same with shift 16 but the high dword of the fold is **discarded**, so it is effectively 32-bit; `PackableHashTable` = `hash(key) % _table_size` with `_table_size` from the data; `OldHashTable` = identity + modulo, default 32 buckets | N/A-WEB for the bucket math (Rust `HashMap`/`BTreeMap` own it; retail's bucket choice is not observable on the wire) — **except** `PackableHashTable`'s serialized header, which IS on the wire: PARITY-OK, `clothing.rs:17-18` documents `u16 count + u16 bucket_size` with entries inline and no per-bucket framing, and `crates/holtburger-protocol/src/messages/ui_events/events.rs:268` spells out the same. REF-ONLY for the `Turbine_GUID`-hashes-only-`m_data1` trap |
| §4.6 `PackableHashTable` packs its header as `count \| (table_size << 16)` — **count in the LOW 16 bits** (§5.4 repeats this) | PARITY-OK — matches holtburger's `u16 count` then `u16 bucket_size` byte order. Note `00-architecture.md` §8 states the **opposite** ("bucket count in the high 16 bits and element count in the low 16") — same claim, and both agree count is low; the doc-10 phrasing is the clearer one |
| §4.7 `__security_cookie` — stock MSVC `__security_init_cookie`, default `0xBB40E64E` | N/A-WEB |

### §5 Compression and encodings

| Claim | Disposition |
|---|---|
| §5.1 zlib on DAT records, level hardcoded **9**; on-disk layout `[0..3] u32 uncompressedSize`, `[4..] raw deflate`; guards asymmetric by one byte (decompress `>= 0x10`, compress `> 0x10`); `destLen = payload − 4` so a record can never grow (`Z_BUF_ERROR` ⇒ store raw); the flag is `BTEntry.comp_`, bit 0 | TASK(DAT-04) — see §2 above. PARITY-OK on the flag bit (`lib.rs:283-285`) |
| §5.2 `Pack_AsWClassIDCompressed`: `id <= 0x7FFF` ⇒ `u16 = id`; else `u16 = (id >> 16) \| 0x8000` then `u16 = id & 0xFFFF` | REF-ONLY — no holtburger site reads this encoding (wcids arrive as plain u32 on the wire path holtburger uses) |
| §5.2 `Pack_AsDataIDOfKnownType`: delta against a class base, 14-bit high field — `d <= 0x3FFF` ⇒ `u16 = d`; `d <= 0x3FFFFFFF` ⇒ `(d >> 16) \| 0x8000`, `d & 0xFFFF`; else fail | REF-ONLY — same |
| §5.2 `SB_As32Bit_Compressed::Serialize` (the Archive varint, **mixed endianness**): `v <= 0x7F` ⇒ 1 byte; `v <= 0x3FFF` ⇒ `(v>>8)\|0x80`, `v&0xFF`; `v <= 0x3FFFFFFF` ⇒ `(v>>24)\|0xC0`, `(v>>16)&0xFF`, then **u16 LE** `v & 0xFFFF` | **PARITY-OK, verbatim including the endianness kink** — `crates/holtburger-dat/src/utils.rs:5-18` `read_compressed_u32`: 1-byte when `!(b0 & 0x80)`; 2-byte `((b0 & 0x7F) << 8) \| b1` when `!(b0 & 0x40)`; else `((((b0 & 0x3F) << 8) \| b1) << 16) \| u16::read_le`. Writer at `:20-44` mirrors it and **rejects `> 0x3FFF_FFFF`** exactly like retail's `else: fail`. Round-tripped over `{0, 1, 0x7F, 0x80, 0x3FFF, 0x4000, 0x3FFF_FFFF}` at `:571-586`, overflow tested at `:588-594` |
| §5.2 `PStringBase::Pack`: `u16 len` — or `0xFFFF` escape then `u32 len` — then raw bytes, then zero-pad to a 4-byte boundary | **Split.** PARITY-OK for the general primitive: `utils.rs:167-190` `read_pstring_char` implements the `0xFFFF` → `u32` escape (`:169-173`), the trailing-NUL trim (retail's `m_len` decrement quirk, cited at `:145-152`), and the 4-byte align-pad (`:182-187`), with the retail citation `acclient.c:296509-296568`. I independently confirmed against `Pack` at acclient.c:296374-296400 (writes `m_len - 1`, escapes at `>= 0xFFFF`, `ALIGN_PTR`). **TASK(DAT-17)** for the obfuscated variant: `read_obfuscated_string` (`:192-204`) reads a bare `u16` with **no `0xFFFF` escape**, and leaves alignment to the caller — `spell_table.rs:120`/`:124` and `spell_components_table.rs` do call `parse_align` (`:357-368`), so alignment is handled, but the escape is missing. Unreachable for spell strings (none approach 65,534 bytes) and therefore low priority |
| §5.3 `CMostlyConsecutiveIntSet::Serialize` run-length: write `u32 count`, then per run `runLen <= 2` ⇒ `u32 = value & 0x7FFFFFFF` (sign bit **cleared**), `runLen > 2` ⇒ `u32 = −runLen` then `u32 = runStart` (**unmasked**). Read: `v >= 0` ⇒ `if (v & 0x40000000) v \|= 0x80000000` (sign-restore hack); `v < 0` ⇒ expand `runLen = −v` from `start`. Read side caps count at `0x186A0` (100,000) | TASK(DAT-15) — see §9 above. Both documented defects (values in `0x40000000..0x7FFFFFFF` cannot round-trip; a run starting at a bit-31 value is misread as a negative marker) are REF-ONLY reasons **not** to invent our own writer |
| §5.4 **Presence-mask serialization — the dominant idiom**: `u32 presenceMask`, optional secondary mask gated by a bit in the first, mandatory fields, `ALIGN_PTR(4)`, then optional fields in **fixed order** at natural width, `ALIGN_PTR(4)`, verify `consumed <= declaredSize` else rewind+fail. Bit assignments are non-contiguous and **stream order does not match bit order** | PARITY-OK in the DAT lane — `region.rs:1049-1055` is the exemplar and its comment is exactly this warning ("`dats.xml` emits the optional fields in *maskmap declaration order*, NOT bit-value order … PhatSDK `RegionDesc.cpp:268-306` confirms this layout against real bytes"). `env_cell.rs:123-136` and `landblock.rs:176` follow the same discipline. The wire-message instances (`PublicWeenieDesc`, `PhysicsDesc`, `CACQualities`) are wave1-A/B's lane |
| §5.4 The `consumed <= declaredSize` rewind-and-fail check | TASK(DAT-20) — ABSENT in the DAT parsers: `binrw` will happily over-read into the next record's bytes when a count is corrupt. Retail's declared-size guard is the cheap containment. Relevant because `holtburger-dat-write` now emits records too |

### §6 Negative findings

| Claim | Disposition |
|---|---|
| No MD5/SHA-1/SHA-256/RC4/Blowfish/AES/3DES/TEA/HMAC (none of `0x67452301`, `0x5A827999`, `0x6A09E667`, `0xC6EF3720`); no Windows CryptoAPI (only `RegQueryValueExW`/`RegOpenKeyExW` from advapi32) | REF-ONLY — matches holtburger, which has no cryptographic primitive beyond ISAAC |
| **No CRC anywhere** — zero case-insensitive hits over 938k lines, no `0xEDB88320`, no `0x04C11DB7`; zlib is present in **raw-deflate form only** (no gzip wrapper), which is precisely why `crc32.obj` was never linked. What exists instead is `d3dx_adler32` (stock zlib, `BASE = 65521`, `NMAX = 5552`, 16-way unrolled) and deflate's rolling `ins_h = ((ins_h << hash_shift) ^ next_byte) & hash_mask` | REF-ONLY — **directly relevant to DAT-04**: retail's records are raw deflate with no checksum of their own, so a wrong decompressor produces silent garbage rather than an error. That is the argument for making DAT-04's mismatch a hard failure rather than a best-effort |
| **No XOR-with-constant expressions anywhere**; all 33 `^=` sites are the Hex-Rays bitfield-setter idiom, equality tests, hash mixing, or `abs()`. The only XOR-over-buffer loop in the binary is `CryptoSystem::EncryptData` | REF-ONLY (this is the load-bearing negative behind "the container path is cipher-free") |
| No rotate intrinsics — zero hits for `__ROL`/`__ROR`/`_rotl`/`_rotr` | REF-ONLY — **this is the corroboration for my §4.1 warning**: holtburger's rotate-based `string_hash` has no counterpart in the binary |
| No base64 or armour encoding; the uppercase-hex helpers are ordinary | REF-ONLY |
| **No obfuscation of any DAT record type other than spell data**, verified three ways (absence of XOR constants; every record reaching `UnPack` straight from block-chain + optional zlib with no post-decompress hook; spot checks) | PARITY-OK — holtburger applies the nibble swap only to spell/component strings, nowhere else. Correct |
| **The taboo/profanity list is plaintext** — `TabooTable` is a `DBObj` whose only member is `HashTable<audience, HashTable<rejection_type, List<PStringBase<char>>>>`; `CheckCensors` lowercases with `_strlwr`, filters via `CreateCheckString` (`chkType == 2` keeps only `iswalpha`, `chkType == 3` drops `iswspace`), then `StringMatchesFilter` — a hand-written backtracking glob matcher whose **only** wildcard is `*`; patterns must be stored lowercase; no hashing | PARITY-OK on the record (`file_type/taboo_table.rs`); REF-ONLY for the matcher (holtburger does no client-side censoring — the server owns it) |
| **`NameFilterTable` holds no word list at all** — just per-language phonotactic rules (max same chars in a row, max vowels in a row, first-N-must-contain-a-vowel, allowed extra characters, compound letter groups) | PARITY-OK on the record (`file_type/name_filter_table.rs`); REF-ONLY for the rules |
| **String tables are plaintext UTF-16LE** (`StringTableString::Serialize` → `Serializer::SerializeBytes`, a bare `qmemcpy`) | PARITY-OK — `file_type/string_table.rs` / `language_string.rs` read plaintext |
| **No compression on the network path** — zlib's only call sites are the two DAT functions; the `pfnUncompressedSendLogger`/`pfnUncompressedRecvLogger` hooks are 0 at both init sites and dead | PARITY-OK — holtburger's WS transport adds no application-layer compression either (permessage-deflate at the WS layer is orthogonal) |
| **No credential protection of any kind** — no `CryptProtectData`, no hashing, no salting; credentials are ordinary refcounted `PStringBase<char>` with no zeroing on release; the GLS ticket sits in `HKCU\Software\Turbine\ac1\GLSTicket` as plaintext `REG_SZ` until the client reads and deletes it | N/A-WEB — the browser has no registry; holtburger's account/password come from `?account=`/`?password=` (`autoLogin`, per `docs/url-flags.md`), which is *equally* cleartext and equally by design for a private shard |
| No hardware fingerprint, machine ID, or licence check | REF-ONLY |
| No anti-debug, no packing, no self-modifying code; `VirtualProtect` zero occurrences; the single `IsDebuggerPresent` gates a logging sink | REF-ONLY |

### §7 Provenance

| Claim | Disposition |
|---|---|
| The list of items read directly and cross-checked in ≥2 decompilations (nibble swap + bounds, ELF hash identity, `0x12107680`/`0xBEADCF45`, `SpellFormula::Decrypt`, all three `Randomize` versions, all seven V3 moduli, ISAAC `mix`/`randinit`/`isaac`, `EncryptData` + call sites, DH parameters) | REF-ONLY — I re-verified the ELF hash bodies, `SpellFormula::Decrypt`, `PStringBase::Pack`, `SoundTableData::Pack`, `ObjectDesc::Place`/`GetObjFrame`, `get_land_scenery`, `FlowQueue::EncryptChecksum`, `SharedNet::SendPacket`/`ProcessNewSeqNum` against `~/ac-headers/acclient.c` in this pass |
| Items the author verified independently (moduli are no-ops; `vlong` has no division; `randrsl[]` zeroed; the `SWtoNEcut` constants after an intermediate draft mis-transcribed two) | REF-ONLY — and note the mis-transcription failure mode **recurred** in Family A (see §4.3), which I caught the same way |
| **Whether `CalcChecksum32`'s tail bytes are sign- or zero-extended** — two sweeps disagreed; resolved by reading all three decompilations; **zero-extended (`movzx`)**; a reproduction using signed bytes diverges on any packet whose length is not a multiple of 4 and whose tail contains a byte ≥ 0x80 | PARITY-OK — holtburger is zero-extended (`crypto.rs:21`). Since all three retail call sites pass length 4 and holtburger's own header is 20 bytes, the tail path only runs for fragment payloads, where it matters |
| Inferred-not-read items (the DAT authoring tool did the forward spell transforms; the launcher writes the GLS ticket; the `stamp << 32` term; the school→name pairing) | REF-ONLY |
| **Unresolved**: `randinit`'s `bUseSeed == false` branch performs one `mix()` and writes only `randmem[4..11]`, which is not the reference loop; the branch is dead (every call site passes 1) | REF-ONLY — holtburger has no `bUseSeed == false` path at all (`Isaac::new` always seeds), so the ambiguity cannot bite us |

## `README.md` + `00-architecture.md` §9 (skim)

| Claim | Disposition |
|---|---|
| Hex-Rays substitutes string literals for large immediates (`0x800000` renders as a format-string pointer and means `SLEDDING_PS` / `Vitae_EnchantmentType` / `MISSILE_AMMO_LOC` depending on subsystem) | REF-ONLY — heeded; no such immediate appears in this lane |
| Not every strange constant is decompiler damage (`PhysicsGlobals::floor_z = cos(3437.746770784939)` is a real degrees-for-radians bug ⇒ ≈48.38°) | REF-ONLY (wave1-A, already PARITY-OK there) |
| Duplicate static constants across TUs (`MIN_QUANTUM` ×100, only `_93`/`_97` live) | REF-ONLY |
| Type tags look like DIDs; IDA mislabels struct fields (trust `SetPackHeader` and `operator new` sizes over decompiled names); trampolines abound; `__usercall` register args signal a failed caller; prefer header enums to inferred bits; notice IDs are address-encoded | REF-ONLY — the "trust sizes over names" rule is what caught DAT-03 (`version` vs `iter_`) and DAT-02 (`EnvCell` vs `Environment`) |
| **"Absence of evidence is not evidence of absence"** — every strong negative was reached by grep over *one* decompilation, and two such claims turned out false | REF-ONLY — and applied: I treated my own "Family B PalShift is absent" and "no rotate hash in the binary" negatives as grep-derived and re-checked each with a second search form |
| 99.59% of functions are byte-identical between 11.4186 and 11.6096; crypto and the DAT container/cache layer have **zero** changed functions | REF-ONLY — everything in this report applies unchanged to the EoR client, which is what our DATs came from |

---

# PART 2 — TASKS

## DAT — container, classification, residency

### DAT-01 — Procedural scenery has no collision feed: the data path simply does not exist
- **Source §:** `07` §11 (`CLandBlockInfo` / cell records), `10` §4.3 Family A (`get_land_scenery` is the *placement* half of the same loop that registers physics).
- **Retail:** `CLandBlock::get_land_scenery` (acclient.c:352600-352735) does not merely compute a position. For every accepted placement it calls `CPhysicsObj::makeObject(obj_id, 0, 0)` → `set_initial_frame` → `obj_within_block` → **`CPhysicsObj::add_obj_to_cell(cell, frame)`** → `ObjectDesc::ScaleObj` → `SetScaleStatic` → **`CLandBlock::add_static_object`** (acclient.c:352700-352718). A tree is therefore a first-class physics resident of its land cell, indistinguishable from a building for collision purposes, and it carries its per-placement scale.
- **holtburger today:** the outdoor static feed exists and works, but is fed from one source only.
  - Feeders: all four `STATIC_BSP_PENDING` pushes live in the `CLandBlockInfo` walk — `apps/holtburger-web/src/lib.rs:15569` and `:15648` (buildings, 0x01 inline and 0x02 per-part), `:15922` and `:15994` (loose statics, 0x01 inline and 0x02 per-part). All four iterate `info.objects` / `info.buildings`.
  - Drain: `lib.rs:15278-15282` → `SpatialScene::insert_static_physics_bsp` (`crates/holtburger-world/src/spatial/scene.rs:2731`).
  - Projection into land cells: `lib.rs:48985-48996` → `bake_outdoor_static_overlap_for_landblock` (`scene.rs:1628`), which converts each static's world AABB to global land-cell coords and registers it into `cell_static_physics_bsp` — the table the faithful outdoor driver actually reads (`scene.rs:1602-1607`).
  - **Scenery is on a disjoint path.** `crates/holtburger-scenery-bake` writes per-LB JSONL to `/dist/scenery/<lb_hex>.scenery.jsonl` (`lib.rs:2505-2521`); the client reads it via `fetch_landblock_scenery` (`lib.rs:3289`) / `fetch_landblock_scenery_soa` (`:4199`) and hands it to the renderer. There is **no** `populate_scenery_aabbs_for_landblock` (the only two such functions are `populate_building_aabbs_for_landblock` `:15767` and `populate_statics_aabbs_for_landblock` `:16063`), no scenery `STATIC_BSP_PENDING` push, and no scenery row in `statics_physics_bsp` / `cell_static_physics_bsp` / `cell_physics_bsp`.
  - Secondary defect on the same path: every staged outdoor static hard-codes `scale: 1.0` (`lib.rs:15931`, `:15964`-region, `:16000`) with the standing TODO "plumb the real scenery scale here when the feed carries it". So even once scenery is fed, its collision volume would be unscaled while its mesh is scaled by `scale_obj`.
- **Proposed change:** give the scenery bake a physics lane. The bake already resolves each placement's `ObjectDesc`, world frame and scale (`crates/holtburger-scenery-bake/src/lib.rs:454-534`), so emit per-placement `{model_id, world_origin, world_orientation, scale}` alongside the render record, and in the client stage those through the **existing** `STATIC_BSP_PENDING` → `insert_static_physics_bsp` → `bake_outdoor_static_overlap_for_landblock` pipeline (reusing the 0x01/0x02 BSP-resolution helpers already written at `lib.rs:15873-15937` / `:15975-16005`). Plumb `scale` end to end at the same time. Gate default-OFF behind `?sceneryCollision` until the census below is clean.
- **Payoff:** the single biggest fidelity gap the live report surfaced — trees and rocks stop being ghosts. It also removes a whole class of "why did the server correct my position" desyncs, since ACE's own landblock mesh *does* include scenery.
- **Effort:** L (bake format + client staging + budget work; the physics side is already built).
- **Validation:** (1) a census — `__diag` should report `static_physics_bsp_count` rising by roughly the scenery placement count for a forested LB, and near-zero change for a bare plain; (2) a headless walk test: `?nullRender=1&autoLogin=1`, `@teleloc` to a known tree, drive `setMovementInput` forward for 3 s, assert the pose stops short of the trunk (today it passes through); (3) an A/B on frame time with `?sceneryCollision=on|off` on the 1070 — 4,096 animated placements per LB is exactly the regime where a naive per-placement BSP will cost, so measure before defaulting ON.

### DAT-02 — `DatFileType::EnvCell = 0x0D` is a mislabel, and the pruning bake runs `EnvCell::unpack` on Environment records
- **Source §:** `07` §3 (`0x0D000000`–`0x0D00FFFF` → DB_TYPE **16 Environment**) and §11 (`CEnvCell` records are cell-DAT `0xLLLL0100+i`, and an EnvCell's `environment` field is a 16-bit index promoted with `| 0x0D000000`).
- **Retail:** two distinct types. `Environment` (dbtype 16, portal DAT, prefix `0x0D`) is the dungeon-room geometry container — `u32 id`, `u32 num_cell_structs`, then the `CellStruct` list. `CEnvCell` (cell DAT, `0xLLLL0100+i`, `QualifiedDataID` type 3) is a room *instance* that references an Environment by that promoted index.
- **holtburger today:** `crates/holtburger-dat/src/file_type/mod.rs:154` declares `EnvCell = 0x0D` and `:297` maps prefix `0x0D → DatFileType::EnvCell`, while the real EnvCell records are classified `IndoorCell` (`:275-276`). A correct `Environment` parser exists and is exported (`mod.rs:69` `pub use environment::{CellStruct, Environment}`) but no classification reaches it. The consequence is live in the bake: `apps/holtburger-tools/src/dat2hba.rs:555` classifies with `from_id_in_dat(id, db.dat_kind())`, so a portal-DAT `0x0D` record becomes `DatFileType::EnvCell`, and `:604` matches `DatFileType::EnvCell | DatFileType::IndoorCell` and runs `EnvCell::unpack` → `prune()` → `pack()`, **replacing the record bytes** when it succeeds. `should_prune_records` is on for every profile except `Full` (`dat2hba.rs:135`), and `StripperManifest::logic_only` explicitly keeps `DatFileType::EnvCell` (`crates/holtburger-dat/src/manifest.rs:31`). `EnvCell::unpack` (`file_type/env_cell.rs:94-137`) has no magic and no id check, so it is permissive: simulating it over all 772 real `0x0D` records, ~73% parse to completion rather than erroring (APPENDIX-B).
- **Proposed change:** rename the enum variant to `Environment = 0x0D` and add a separate marker for the cell-DAT room instances (or simply drop `EnvCell` and rely on `IndoorCell`, which is what already carries them). Narrow `dat2hba.rs:604` to `IndoorCell` only, and add an `Environment` arm if/when an `Environment::prune` exists. Keep `manifest.rs:31` keeping the prefix under its new name.
- **Payoff:** removes a live data-corruption path aimed at the 772 records dungeon geometry depends on, and deletes a permanent reader trap.
- **Effort:** M (mechanical rename with wide blast radius: `mod.rs`, `manifest.rs`, `dat2hba.rs`, `crates/holtburger-dat-write/src/pack/env_cell.rs:39`/`:48` which uses `DatFileType::EnvCell as u32` **as its HBA `type_id`** — that value is baked into existing archives, so the rename must not silently change `type_id`).
- **Validation:** a unit test asserting `from_id_in_dat(0x0D000002, DatKind::Portal) == DatFileType::Environment` and that `Environment::unpack` succeeds on the real `0x0D000002` bytes while `EnvCell::unpack` is never invoked on them; then a byte-diff of a freshly baked non-`Full` HBA against the source DAT restricted to `0x0D……` — every record must be identical (or pruned by a deliberate `Environment::prune`, not by `EnvCell`'s).

### DAT-03 — `DatFileEntry.version` is really `iter_`; the record version is never read, so token-gated fields cannot be honoured
- **Source §:** `07` §2 (`BTEntry` bitfield: `comp_:1, resv_:15, ver_:16`, then `GID_ Offset_ size_ date_ iter_`; `ver_` becomes `Cache_Pack_t::m_iVersion`; `iter_` is the patch-iteration number) and §6 (version tolerance is token-based).
- **Retail:** the record's schema version lives in **bits 16–31 of the entry's first dword**, and is turned into three FOURCC tokens by `GetVersionRowForDBObjPackVersion` (acclient.c:87589): `'Core' = 2 − (v < 2)`, `'DObj' = v`, `'UIL ' = (v >= 3)`. A `Serialize` body then asks `Archive::GetVersionByToken` (69987) whether a field is present — RenderMaterial gates on `'RMVT'` (129851), UI code on `'UIL '` (691996, 692624). `SerializeFromCachePack` refuses `m_iVersion == 0`. The trailing dword `iter_` is a *different* number entirely: the DDD patch iteration, load-bearing only for the staleness guard (§9).
- **holtburger today:** `crates/holtburger-dat/src/lib.rs:256-263` names the six fields `bit_flags, id, offset, size, timestamp, version` — so `version` holds retail's `iter_`, `timestamp` holds `date_`, and the real `ver_` is unextracted inside `bit_flags`. Only bit 0 is ever read (`:283-285`). ACE gets the naming right (`~/ace-server/Source/ACE.DatLoader/DatFile.cs:23` `Iteration`). No parser anywhere takes a version parameter.
- **Proposed change:** two steps, separable. (a) Rename `version` → `iteration` and add `fn record_version(&self) -> u16 { (self.bit_flags >> 16) as u16 }`, plumbing it through `FileMetadata` and the HBA entry (there is a spare `reserved: [u8; 2]` at `crates/holtburger-dat/src/archive.rs:69`) so the pre-baked path does not lose it. (b) Where a parser is known to be version-sensitive — `layout.rs`, `state_desc.rs` (`'UIL '`) and any future RenderMaterial (`'RMVT'`) — take the version as a `binrw` arg and gate accordingly.
- **Payoff:** (a) alone stops a reader from confidently using the wrong number, which is the cheap half. (b) closes a real correctness hole: measured `ver_` is **mixed within nearly every type** in the shipped DATs (0x01 GfxObj 10,395 v2 / 4,923 v3; 0x06 Texture 15,355 / 5,329; 0x10 Clothing 576 / 1,341; 0x23 StringTable 6 / 9 — APPENDIX-B), so no parser can be right for both halves by luck alone.
- **Effort:** S for (a), M for (b).
- **Validation:** for (a), assert `record_version(0xFFFF0001) == 1` — measured to be the unique `ver_ == 1` record in every DAT. For (b), take the 101 UILayout records (all v3) and the mixed 0x23 StringTable set and round-trip parse→pack→compare bytes; any type where both versions round-trip byte-identically is provably version-insensitive and can be marked so.

### DAT-04 — Compressed DAT records are handed to `decompress_lrs`, not zlib
- **Source §:** `07` §2 "Compression" + `10` §5.1.
- **Retail:** `DiskController::Decompress` (acclient.c:647367) is plain zlib `uncompress` (call at 647393) over a payload preceded by a 4-byte uncompressed-size prefix; the guard at 647382 is `record_len − 4 >= 0x10`, so the deflate stream is `record_len − 8` bytes. The write side `AttemptToCompress` (647114) calls `compress2` at **level 9** (647154) and stores the prefix at 647164, with a strict `> 0x10` guard. On-disk layout is exactly `[0..3] u32 uncompressedSize` then a **raw deflate stream with no gzip wrapper and no checksum** (`10` §6 explains why: `crc32.obj` was never linked).
- **holtburger today:** `crates/holtburger-dat/src/lib.rs:347-357` `get_file` routes `entry.is_compressed()` to `utils::decompress_lrs` (`utils.rs:341+`), which reads the 4-byte size prefix correctly and then runs an **LZSS-style control-bit decompressor** — a different algorithm. Because raw deflate carries no integrity field, a mismatch yields plausible-looking garbage rather than an error.
- **Empirically latent:** I walked all three shipped DATs and **zero** entries have `comp_` set (79,694 portal + 805,348 cell + 118 local; APPENDIX-B). Retail only ever set `comp_` on the DDD write path, so a pristine install has none. The bug is unreachable today and will stay unreachable unless someone ingests a DAT that was live-patched.
- **Proposed change:** replace the call with `flate2::inflate` over `data[4..]`, sized by the prefix; and make a size mismatch a hard `DatError::Corruption` rather than a truncated `Vec`. If adding a dependency is unwanted, at minimum turn the branch into an explicit `unimplemented!`/error so it fails loudly.
- **Payoff:** eliminates a silent-garbage path on the one input class we cannot self-check.
- **Effort:** S.
- **Validation:** synthesise a record with `compress2(level 9)` + prefix, assert byte-exact round-trip; and assert the current `decompress_lrs` path *fails* that vector (proving the two are genuinely different and the fix is load-bearing).

### DAT-05 — `read_file_data` ignores the bit-31 free-block marker, and the magic is never rejected
- **Source §:** `07` §1.
- **Retail:** `CLBlockAllocator::Load_Data` (acclient.c:650711-650776) aborts the read when a next-pointer has **bit 31 set** — that bit marks a free block, pre-tagged by `CreateDataFile` with `| 0x80000000` (650985) and re-tagged by `DeleteBlocks` (650406). Separately, `OpenDataFile` (651004) rejects the file outright with **−102** unless `magic_ == 21570` (650035-650038).
- **holtburger today:** `crates/holtburger-dat/src/lib.rs:368-399` `read_file_data` treats `next_address` as a plain offset with no bit-31 test, so a freed link sends `read_exact_at_compat` to `0x8xxxxxxx` — a wild positional read that either errors with an unhelpful IO message or silently returns adjacent-file bytes. `DatDatabase::new` (`:290-306`) reads the header and proceeds regardless of `magic`; `DAT_MAGIC` (`:41`) is used only for `dat_kind()` classification (`:244-251`), which falls through to `DatKind::Unknown` rather than failing.
- **Proposed change:** in `read_file_data`, `if next_address & 0x8000_0000 != 0 { return Err(DatError::Corruption("free block in data chain")) }`; in `DatDatabase::new`, reject `header.magic != DAT_MAGIC` before `read_directory`.
- **Payoff:** turns two classes of "mysterious garbage" into named errors. Cheap insurance for a tool chain that reads user-supplied DAT copies (the `ui-*` WRITE commands already operate on copies).
- **Effort:** S.
- **Validation:** hand-build a 2-block record whose second link is `0x80000005`, assert `Corruption`; feed a non-DAT file, assert `InvalidMagic`.

### DAT-06 — `ByteBudgetLru` never releases on idle; retail's 30-second rule has no analogue
- **Source §:** `07` §8.
- **Retail:** `DBOCache::UseTime` (acclient.c:83131) destroys the oldest free object once the free list exceeds its ideal size **and** `m_timeStamp + 30.0 < Timer::cur_time`. Residency is therefore bounded in *time* as well as in count — a cache that stops being touched drains.
- **holtburger today:** eviction is triggered exclusively from `insert`: `apps/holtburger-web/src/lib.rs:9200` `while self.total_bytes > self.budget`. `ByteBudgetLru` (`:9135-9145`) stores a monotonic use-*tick* (`:9140`, bumped at `:9163` and `:9186`), not a timestamp, and has no sweep entry point at all. So after a dense town load the surface cache sits at its full 96 MiB (`:9240`) indefinitely — walking into an empty field and standing still frees nothing.
- **Proposed change:** carry `last_used_ms` alongside the tick, add `fn sweep(&mut self, now_ms: f64, idle_ms: f64, evictable: …)` that drops evictable entries idle longer than `idle_ms` (start at retail's 30 s, make it `?surfaceIdleSec=`), and call it from the existing per-frame deferrable group in `scene3d/loop.js` (the `?frameBudget` guard at `:1631` already exists to host exactly this kind of work). Report swept bytes in `dat_decode_diag`.
- **Payoff:** returns up to ~96 MiB on a 8 GB laptop that currently OOMs (`capped-builds`, earlyoom), and makes long sessions' memory curve flat instead of monotonic. Note this is *not* a frame-rate change — it is a headroom change.
- **Effort:** M.
- **Validation:** `?nullRender=1&autoLogin=1`, `@telepoi` to a dense town, wait for `surfaceCacheBytes` to plateau near budget, `@telepoi` to an empty area, idle 60 s, assert `surfaceCacheBytes` falls and `surfacePinnedEntries` (PAL-01) stays ~0. A heap snapshot before/after is the corroborating measurement.

### DAT-07 — `ByteBudgetLru` victim selection is an O(n) scan per victim
- **Source §:** `07` §8 (retail's freelist is an intrusive linked list; `FreelistRemoveOldest` is O(1)).
- **Retail:** `DBObj` carries freelist links inline (`07` §8), so the oldest free object is at a known end. `FreelistAdd`/`FreelistRemoveOldest` are pointer splices.
- **holtburger today:** `apps/holtburger-web/src/lib.rs:9201-9206` selects each victim with `self.map.iter().filter(|…| **k != just_inserted && evictable(v)).min_by_key(|…| *last_use)`, **inside** the `while total_bytes > budget` loop. Evicting `k` entries after a large insert is O(n·k) over a map that at 96 MiB / a few hundred KB per surface holds hundreds to low thousands of entries. Worse, the `evictable` predicate is `Arc::strong_count(v) == 1` (`:9542`, `:9611`), so every scan touches every value's atomic refcount.
- **Proposed change:** keep an auxiliary `BTreeMap<(u64 /*tick*/, K), ()>` (or a bucketed generation list) so the LRU end is O(log n); on `get`, move the key's entry. Alternatively collect victims in a single sorted pass when the overshoot is known, instead of re-scanning per victim.
- **Payoff:** removes a per-insert cost that scales with cache size — i.e. one that gets *worse* exactly when the cache is doing its job. Pairs naturally with DAT-06 (a sweep wants the same ordered index).
- **Effort:** M.
- **Validation:** a native micro-benchmark in the crate's test target: insert 5,000 × 64 KB entries into a 96 MiB budget and compare wall time before/after; then confirm the LRU *order* is unchanged by asserting the same eviction sequence on a scripted access pattern (this must be a behaviour-preserving refactor).

### DAT-08 — One shared byte budget: a texture storm can evict every cached triangulation
- **Source §:** `07` §8 (freelist budgets are **per type**: GfxObj 100/200, Setup 25/100, Animation 20/80, Palette 60/100).
- **Retail:** each `DBOCache` has its own ideal/max object count, so pressure in one type cannot starve another. There is no global budget at all.
- **holtburger today:** `SURFACE_CACHE_BUDGET_BYTES = 96 MiB` (`apps/holtburger-web/src/lib.rs:9240`) is shared by the palette-free **and** palette-composed surface classes (`:9019-9027`), and `MODEL_TRI_CACHE` uses the same `ByteBudgetLru` machinery (`:9008-9009`). The per-class split is *observational only* — `surfaceCachePal*` vs `surfaceCache*` diag fields — with no reserve. Given MEMORY.md's `retail-residency-is-the-target` note that the landed triangulation memo is the current decode-once win, letting a surface burst evict it is directly counter-productive.
- **Proposed change:** give each class a floor (e.g. `min_bytes` per class, honoured by making `evictable` return false for a class already at or below its floor) rather than porting retail's count budgets, which are the wrong unit for a browser. Expose the floors via the existing `?surfaceBudgetMB=N[:M]` syntax (`:9244-9249`) so they are tunable without a rebuild.
- **Payoff:** protects the one cache whose miss cost is a full re-triangulation from the cache whose miss cost is a re-decode.
- **Effort:** M.
- **Validation:** instrument per-class eviction counts, then run the 1070 forest→town→forest loop and assert `modelTriEvictions` stays ~0 while `surfaceEvictions` absorbs the pressure. Compare `?frameBudget` overruns across the transition before/after.

## DAT — deterministic placement (the coordinate-hash family)

### DAT-09 — Scenery frequency-cull noise is loop-invariant; retail advances it by object index
- **Source §:** `10` §4.3 Family A. **The doc's own `K` value for this member is incomplete — see below.**
- **Retail:** in `CLandBlock::get_land_scenery` the per-object frequency test is
  `noise = (uint32)(0x6C1AC587*y − (kq + 23399)*(1360117743*y*x + 1888038839) − 0x421BE3BD*x) * 2.3283064e-10`,
  compared `noise < ObjectDesc::freq`. I read the loop at acclient.c:352655-352735: `v38 = 1360117743*v9*v10 + 1888038839` and `v17 = 23399 * v38` are computed **before** the loop, and at the bottom of each iteration `v17 = v38 + scene_id; scene_id += v38`, so iteration `kq` uses `(23399 + kq) * v38`. That is the standard strength-reduced form of `(kq + 23399)`, and it matches the `(index + magic)` shape of every sibling member — `ScaleObj` `k + 32593` (351370), `Place` X `iq + 45773` and Y `iq + 72719` (462619/462626, read directly), `GetObjFrame` `k + 63127` (462670, read directly).
- **holtburger today:** `crates/holtburger-scenery-bake/src/lib.rs:454-463` calls `object_noise(cell_x_mat, cell_y_mat, cell_mat)` inside `for (j, obj) in scene.objects.iter().enumerate()`, and `object_noise` (`crates/holtburger-scenery-bake/src/noise.rs:88-93`) takes no index — it computes `cell_x_mat + cell_y_mat − cell_mat.wrapping_mul(23_399)`. The value is therefore **identical for every object in the cell**. This is inherited faithfully from ACE (`~/ace-server/Source/ACE.Server/Entity/Scenery.cs:59`), which the module header explicitly declares as its source of truth (`noise.rs:1-5` "Every magic constant comes from the C# source — do not rename, deduplicate, or 'simplify' them"). The four displacement/scale/rotation channels **do** pass the index and are correct (`noise.rs:118-132` `displace_noise(ix, iy, iq, magic)` with `iq + magic`, used at `:148`, `:156`, `:183`, `:205`).
- **Proposed change:** thread the object index into the frequency test — `object_noise(cell_x_mat, cell_y_mat, cell_mat, j)` computing `cell_x_mat + cell_y_mat − cell_mat.wrapping_mul(23_399u32.wrapping_add(j))`, i.e. reuse the exact shape `displace_noise` already has. Keep the ACE-verbatim variant behind `BakeMode::AceCompat` (the enum already exists — `lib.rs:500`, `:511-519` use it to switch slope rejection and Z-snap), and make `BakeMode::Strict` the decomp-faithful arm. **This changes baked output**, so it needs a rebake and a look pass.
- **Payoff:** this is the *which objects exist* decision for all procedural scenery. Today object 0 of each scene is culled correctly and objects 1..N−1 are culled against a value they should not be using — so forests, rock fields and foliage differ from retail (and from ACE's own physics mesh, which shares the bug, meaning we are at least *consistently* wrong with the server today; fixing only the client would introduce a client/server disagreement, which is why the flag matters). `10` §4.3's closing sentence is the reason to care: these hashes carry **zero replication traffic** and must match bit for bit.
- **Effort:** M (one-line math change; the cost is the rebake, the golden-test update, and deciding the ACE-consistency question).
- **Validation:** (1) add a golden vector to `crates/holtburger-scenery-bake/tests/golden_decomp.rs` derived by hand from acclient.c:352668-352730 for `j = 0, 1, 2` and assert `j = 0` is unchanged (the existing pins must still pass) while `j >= 1` differs; (2) run `apps/holtburger-tools/src/bin/scenery-cross-check.rs` — note it currently cross-checks against **ACE**, so it will *fail* after the fix; that failure is the expected signal and the tool needs a decomp-mode arm; (3) placement census per LB before/after (`scene3d/diag/placements.js`) to size the visual delta; (4) decide and document whether ACE should be patched to match, since scenery participates in server-side collision.

### DAT-10 — `ObjectDesc.align` is parsed and never read; retail branches to `ObjAlign`
- **Source §:** `10` §4.3 Family A (the `GetObjFrame` heading member is only reached on the `else` arm).
- **Retail:** `get_land_scenery` chooses per placement (acclient.c:352697-352706): `if (ObjectDesc.align) ObjAlign(desc, &walkable->plane, &obj_vector, &obj_frame); else GetObjFrame(desc, x, y, kq, &obj_vector, &obj_frame)`. `ObjAlign` orients the object to the **terrain plane normal**; only the non-aligned arm applies the `k + 63127` heading hash. So an aligned object gets a full orientation from the ground, not a yaw.
- **holtburger today:** `crates/holtburger-dat/src/file_type/object_desc.rs` parses `align` (the only reference in the crate is a test assertion at `:198`), and `crates/holtburger-scenery-bake/src/lib.rs:522-531` unconditionally builds a **yaw-only** quaternion from `rotate_obj`. ACE ignores `align` too. `orient` is likewise unread.
- **Proposed change:** in the bake, when `align != 0`, compute the terrain plane at the placement (the module already has `height::normal_z_at`, used for slope rejection at `:501`) and emit the aligned orientation instead of the yaw-only one.
- **Payoff:** objects meant to lie flat on slopes (fallen logs, flat rocks, road furniture) currently stand upright on hillsides. Visible, and cheap given the normal is already computed for the slope test.
- **Effort:** M (needs the full plane normal, not just its Z; and `ObjAlign`'s exact basis construction should be read from acclient.c before porting).
- **Validation:** bake one LB with a known aligned object, render it on a slope, eye-test on the 1070 in the same batched session as DAT-09's look pass.

### DAT-11 — Outdoor static physics BSPs are staged with a hard-coded `scale: 1.0`
- **Source §:** `07` §11 / `10` §4.3 (retail applies `ObjectDesc::ScaleObj` and then `CPhysicsObj::SetScaleStatic` before `add_static_object`).
- **Retail:** acclient.c:352716-352718 — `v23 = ObjectDesc::ScaleObj(desc, x, y, kq); CPhysicsObj::SetScaleStatic(obj, v23);` — so the collision volume is scaled by the same per-placement factor as the mesh.
- **holtburger today:** every `STATIC_BSP_PENDING` push passes `scale: 1.0` — `apps/holtburger-web/src/lib.rs:15931` (with the standing comment "E3.4: outdoor static — plumb the real scenery scale here when the feed carries it"), and the same literal at the other three feeders (`:15569`-region, `:15648`-region, `:16000`-region). `CellPhysicsBsp` has a real `scale` field, so the plumbing exists and is simply not fed.
- **Proposed change:** carry the placement scale in the staging tuple. For `CLandBlockInfo` statics this is 1.0 by definition (hand-placed statics carry no `ObjectDesc`), so the fix is really a **prerequisite of DAT-01**: the scenery feed must supply `scale_obj`'s result or every tree's collision hull will be the wrong size.
- **Payoff:** prevents DAT-01 from landing with wrong-sized hulls, which would be worse than no hulls (invisible walls / passable trunks).
- **Effort:** S once DAT-01's feed exists.
- **Validation:** assert `CellPhysicsBsp::world_aabb` for a scaled placement equals the render mesh's world AABB within epsilon.

### DAT-12 — `master_map_id_m` enum indirection is bypassed by hardcoded second-level DIDs
- **Source §:** `07` §4 ("This is why almost nothing in the client hardcodes DIDs"), `00-architecture.md` §5.
- **Retail:** `DBCache::GetDIDFromEnum` (acclient.c:79580) is a two-hop resolve: load `m_MasterMapID` (from the DAT header's `master_map_id_m` at +0x30, installed by `SetMasterMapDID` at 293563/79532) as type `0x26` → `EnumIDMap::EnumToDID(enum_group)` → load *that* DID as `0x26` → `EnumToDID(enum_id)` → the real resource DID. Callers ask for `GetDIDByEnum(23, 9)` (fonts), `(1, 6)` (cursors), `(15, 2)` (MasterProperty), group 4 (StringTables), `(1, 4)` (StringState). `EnumMapper`'s `m_base_emp_did` additionally chains to a parent that every lookup falls through to (`GetString` 88051, `GetEnum` 88640), and `DualEnumIDMap::InitLoad` (82466) inverts `m_EnumToID` and reports `"DataID 0x%08X used multiple times."` on collision.
- **holtburger today:** `crates/holtburger-dat/src/lib.rs:223` parses `master_map_id`; the only readers are `apps/holtburger-tools/src/dat_shard.rs:254`/`:264`/`:274`. Resolution is replaced by a hardcoded constant table: `crates/holtburger-dat/src/well_known_ids.rs:26-66` pins `ENUM_MAPPER = 0x25000001` through `WEENIE_CLASS_ID = 0x25000015`, plus a second block of `0x22……` EnumMapper DIDs (`:86-108`) and `0x23……` StringTable DIDs (`:124-136`). That is equivalent to assuming `EnumToDID(group) == 0x25000000 + group`. `did_mapper.rs` and `enum_mapper.rs` parse the records correctly but nothing walks them; `m_base_emp_did` parent chaining and the collision diagnostic are both ABSENT.
- **Measured:** `master_map_id == 0x25000000` in `client_portal.dat` (and `0x00000000` in `client_local_English.dat`, which has no root), and the shipped DIDMapper records are exactly `0x25000000`–`0x25000015` (22 of them). **So the assumption holds for EoR** — this is brittleness, not a live bug.
- **Proposed change:** add `fn did_from_enum(&self, group: u32, id: u32) -> Option<u32>` doing the real two-hop resolve from `header.master_map_id`, implement the `m_base_emp_did` fall-through in `EnumMapper`, add the duplicate-DID warning in the inverse build, and make `well_known_ids.rs` a *fallback* consulted only when resolution fails (keeping its constants as the documented EoR answer).
- **Payoff:** the difference between reading the DATs and reading *these* DATs. Any custom-content shard that re-roots its mappers is currently unreadable, and the failure mode is a wrong asset rather than an error.
- **Effort:** M.
- **Validation:** a test asserting `did_from_enum(23, 9)` resolves to the same font DID that `well_known_ids::FONT` names, and `did_from_enum(15, 2)` to the MasterProperty singleton — i.e. the resolver must reproduce every hardcoded constant from the real DAT. Then add a synthetic DAT with a relocated master map and assert the resolver follows it while the constant table would not.

## DAT — record formats and parser robustness

### DAT-13 — `SoundTable` recursion is flattened at depth 1 and the grandchild count is mislabelled "unknown"
- **Source §:** `07` §11 (`CSoundTable` is a *recursive* `SoundTableData` tree keyed by `SoundType`; each node holds N × 16-byte `SoundData` **and N children**; `Pack` 384970).
- **Retail:** I read `SoundTableData::Pack` (acclient.c:384970-385120). Each node writes `m_hashKey`, `num_stdatas_`, then `num_stdatas_ × {u32 sound_id, f32 priority, f32 probability, f32 volume}` (16 B), then the **child count** (computed by walking `sound_hash_`'s buckets, written at `LABEL_17`), then a virtual `Pack` per child — which repeats the whole shape.
- **holtburger today:** `crates/holtburger-dat/src/file_type/sound_table.rs:23-48` documents and reads a two-level flattening: `[u32 id][i32 hash_key][i32 num_hashes] Hash×n [i32 num_sounds] Sound×n { u32 key, u32 num_entries, entries×16B, i32 unknown }`. Mapping onto retail: `hash_key`/`num_hashes`/`Hash×n` is the root node; `num_sounds` is the root's **child count**; each `Sound` is a depth-1 child; and the schema's `[i32 unknown]` ("purpose unclear") is that child's **own child count**. Any grandchild desyncs the parse.
- **Measured:** across all **190** SoundTable records in `client_portal.dat`, max nesting depth is **1**, no node has grandchildren, and every record is consumed exactly by the recursive model (APPENDIX-B). So the flattening is correct for shipped data.
- **Proposed change:** low-risk documentation-plus-guard rather than a rewrite. Rename `unknown` → `num_children` and hard-assert it is 0 (or parse recursively — the recursion is ~15 lines). Update the module doc to name the true shape and cite acclient.c:384970, replacing the DRW `dats.xml` derivation.
- **Payoff:** removes a "purpose unclear" field from a parser, and turns a silent desync into an assertion for any non-retail SoundTable.
- **Effort:** S.
- **Validation:** the measurement above becomes a test: parse all 190 records, assert every `num_children == 0` and every record fully consumed.

### DAT-14 — `CRegionDesc` version is parsed but never gated at `== 3`
- **Source §:** `07` §10 (3).
- **Retail:** `CRegionDesc::UnPack` requires `version == 3` **exactly**, and otherwise raises one of two `PopupError` dialogs ("The data files have a more recent verion than the executable…" (sic) or its inverse) and refuses to load (acclient.c:299874-299885). The doc calls per-record versioning "the strongest gate" of the three startup layers.
- **holtburger today:** `crates/holtburger-dat/src/file_type/region.rs:1043` reads `version` into a struct field and never compares it. A v2 or v4 Region would be parsed with the v3 field layout.
- **Proposed change:** `if version != 3 { return Err(DatError::UnsupportedVersion(version)) }`, with the retail citation in the message.
- **Payoff:** the Region record roots terrain, sky, scenery selection and the height table — a mis-parse here is a whole-world failure, and it should fail at parse rather than downstream.
- **Effort:** S.
- **Validation:** assert the shipped `0x13000000` still parses (version 3), and that a byte-patched v4 copy errors.

### DAT-15 — `MostlyConsecutiveIntSet` is an opaque blob: no run expansion, no sign-restore, no cap
- **Source §:** `07` §9 (iteration handshake) + `10` §5.3.
- **Retail:** write side: `u32 count`, then per run either `u32 = value & 0x7FFFFFFF` (single, sign bit **cleared**) or `u32 = −runLen` followed by `u32 = runStart` (**unmasked**). Read side: `v = (int32)word`; if `v >= 0` then `if (v & 0x40000000) v |= 0x80000000` (a lossy sign-restore hack); if `v < 0` then expand `−v` consecutive values from the next word. Count is capped at `0x186A0` (100,000).
- **holtburger today:** `crates/holtburger-protocol/src/messages/misc/types.rs:69-97` reads the count, then accumulates **raw encoded words** into `values`, incrementing `current_iters` by `x.abs() - 1` for a negative marker and `1` otherwise. The arithmetic happens to total correctly (the marker's `abs−1` plus the following run-start word's `+1` equals `abs`), so the blob round-trips through `pack` (`:100-107`) byte-for-byte — but `values` is not the *set*, the bit-30 sign restore is absent, and there is no 100,000 cap.
- **Bound to wave1-B NET-22:** holtburger deliberately does not answer `DDD_InterrogationMessage`, so nothing ever needs the expanded set. This is latent.
- **Proposed change:** either (a) rename to make the pass-through explicit (`raw_words`) and document that it is not a set, or (b) if DDD is ever wired, implement `fn values(&self) -> Vec<i32>` with the expansion, the bit-30 restore and the cap, and add the two documented defects as `#[should_panic]`-style regression notes so nobody "fixes" the round-trip. Fold in `EnumeratedBitfield`'s `bit = N − 1` / enum-0-unrepresentable rule (`10` §4.4) as a doc note in the same commit — it is ABSENT and the off-by-one is the whole content.
- **Payoff:** removes a type whose name promises a set and delivers an encoding.
- **Effort:** S.
- **Validation:** encode a mixed single/run sequence per the retail writer, assert `values()` expands correctly, assert values in `0x40000000..0x7FFFFFFF` are rejected rather than silently mangled.

### DAT-16 — `DatDatabase::new` never checks the transaction journal at offset 256
- **Source §:** `07` §1 "The transaction journal", §10 (2).
- **Retail:** `SaveTransaction` (650815) serialises a `DiskTransactInfo` into offset **256**, refusing > `0x40` bytes; `ReadTransaction` (650860) reads `0x40` from 256; `ClearTransaction` (650849) writes a `NO_TRANS` record. On open, `BTree::RecoverTransaction` (649449) replays **redo-forward** — it re-executes the journalled `*Exec` and then clears the record. Journalled ops are `SplitNodeTrans` (649602), `InsertEntryTrans` (649627), `MergeNodesTrans` (649780), `RotateEntryTrans` (649849); types 8/9 (`LRU_EXPAND_TRANS`, `LRU_DELETE_TRANS`) fall through to `default` and return −103.
- **holtburger today:** `crates/holtburger-dat/src/lib.rs:290-306` seeks straight to `0x140`, reads the header, and walks the tree. Offset 256 is never touched.
- **Proposed change:** do **not** implement replay (that is a writer's job — see AT-3). Instead read the 0x40-byte record and **refuse to open** a DAT with a non-`NO_TRANS` journal, naming the pending op. That converts "silently reads a half-split BTree" into "this DAT was interrupted mid-write; restore from a clean copy".
- **Payoff:** small but real given `bake-base-dats-only` + `bake-source.sha256`: the guard is a second, structural check that the bake source is intact, independent of the hash.
- **Effort:** S.
- **Validation:** assert all three shipped DATs open (their journals must be clear — worth measuring as part of this); byte-patch a journal to a `SplitNodeTrans` record and assert refusal.

### DAT-17 — `read_obfuscated_string` lacks the `0xFFFF` length escape
- **Source §:** `10` §3.1 + §5.2 (`PStringBase::Pack`).
- **Retail:** `AC1Legacy::PStringBase<char>::Pack` (acclient.c:296374-296400) writes `m_len − 1` as a `u16`, or `0xFFFF` followed by a `u32` length when `m_len − 1 >= 0xFFFF`, then the bytes, then `ALIGN_PTR(4)`. Every obfuscated string is a `PStringBase` underneath.
- **holtburger today:** the general primitive is complete — `crates/holtburger-dat/src/utils.rs:167-190` `read_pstring_char` handles the escape (`:169-173`), the trailing-NUL trim (`:176-181`) and the align-pad (`:182-187`). But `read_obfuscated_string` (`:192-204`) reads a bare `u16` and does no alignment. Callers supply the alignment (`spell_table.rs:120`/`:124` via `parse_align`, `spell_components_table.rs:76`), so only the escape is genuinely missing.
- **Proposed change:** refactor `read_obfuscated_string` to call `read_pstring_char` and then nibble-swap, inheriting the escape, the NUL trim and the pad; audit the two call sites so the alignment is not applied twice.
- **Payoff:** one primitive instead of two, and one less latent divergence. Unreachable today (no spell name or description is 65 KB), hence low priority.
- **Effort:** S.
- **Validation:** the existing `spell_table.rs:453-466` `test_obfuscated_decode` plus `crates/holtburger-dat/tests/spell_components_table_parity.rs` must stay green; add a synthetic 70,000-byte obfuscated string round-trip.

### DAT-18 — `DBFile2IDTable`, `ObjectHierarchy` and `DBPropertyCollection` are unparsed
- **Source §:** `07` §3 (singletons) + §5.
- **Retail:** `DBFile2IDTable` (`0x0E00001F`, `Serialize` 658197) is a bidirectional filename↔DID registry bucketed per DB type: `TDBTypeEntry` carries the type name, **game and engine root paths**, `HighestDIDAssigned`, and a DID→`TFileEntry` map; `TFileEntry` carries path, filename, DID, dbtype and `m_tFileWriteTime`. The doc's summary is the point: "**This is the asset-build index, shipped inside the dat.**" `ObjectHierarchy` is `0x0E00000D`. `DBPropertyCollection` (`Serialize` 664553) is a serialised property bag whose `.pmat` extension marks it as the material-property container.
- **holtburger today:** all three ABSENT. `0x0E……` is classified `DatFileType::Table` (`file_type/mod.rs:298`) with parsers only for the tables holtburger uses; `0x78……` is classified `DatabaseProperties` (`:328`) with no parser (measured: 2 records).
- **Proposed change:** parse `DBFile2IDTable` in `holtburger-dat` and expose it through WorldBuilder.Terminal (there is already an `asset-used-by` / `asset-refs` graph pair — this adds the *authoring name* for every DID). Treat `ObjectHierarchy` and `DBPropertyCollection` as follow-ons.
- **Payoff:** pure leverage for the bake and diagnostic tooling: every DID gains its original Turbine filename and source path, which makes `boot_reachability` misses, `surface_classify` decisions and manifest audits legible instead of hex. Nothing on the render path needs it, so the risk is zero.
- **Effort:** M.
- **Validation:** dump the table and spot-check a handful of well-known DIDs against `well_known_ids.rs` names; assert `HighestDIDAssigned` per type is `>=` the max DID actually present in the DAT (a free consistency check on our own BTree walk).

### DAT-19 — `StringTableString = 0x24` is not a retail dbtype and has no records
- **Source §:** `07` §3 ("`0x23000000`–`0x24FFFFFF` → 37 StringTable — **owns the 0x24 high byte too**") + §6 (`StringTableString::Serialize` 109419 is a *sub-struct*).
- **Retail:** one dbtype (37) spans both high bytes with one factory. `StringTableString` is a member serialiser inside a StringTable, not a separately-cached DBObj.
- **holtburger today:** `file_type/mod.rs:313-314` maps `0x23 → StringTable` and `0x24 → StringTableString`, and `:361` repeats the split in `from_type_id`. Measured: **zero** `0x24……` records in any shipped DAT.
- **Proposed change:** fold `0x24` into `StringTable` and delete the `StringTableString` variant (or keep it as an explicit alias with a comment citing §3). Check `from_type_id` consumers first — HBA `type_id` values are persisted in existing archives.
- **Payoff:** removes a phantom type that will mislead the next reader into thinking there are two record formats.
- **Effort:** S.
- **Validation:** assert `from_id_in_dat(0x24000001, DatKind::Local) == DatFileType::StringTable`; confirm no HBA in `dist/` carries `type_id == 0x24`.

### DAT-20 — No declared-size containment on DAT record parses
- **Source §:** `10` §5.4 ("verify consumed <= declaredSize, else rewind and fail").
- **Retail:** the presence-mask idiom ends with a bounds check against the record's declared size and rewinds+fails on overrun, so a corrupt count cannot walk into unrelated bytes.
- **holtburger today:** ABSENT. Every `file_type/*.rs` `unpack` takes a `Read + Seek` over the whole record buffer, and `binrw` `count = n` will read `n` items and only fail when the *buffer* runs out — which for a DAT record is the record boundary only because `get_file` returns exactly `entry.size` bytes. That is accidental containment, and it disappears the moment a parser is handed a larger buffer (which `HbaReader` and the in-memory wasm path both do for batched reads).
- **Proposed change:** a small `Bounded<R>` wrapper (or an explicit `assert_consumed_within(record_len)` at the end of each `unpack`) so an overrun is a named `Corruption` rather than a plausible parse of neighbouring bytes.
- **Payoff:** matters most for `holtburger-dat-write`'s round-trip tests and for the `ui-*` write commands that operate on DAT copies. Also the cheapest possible guard against DAT-02-class routing mistakes: a wrong parser on the right bytes would fail instead of succeeding.
- **Effort:** M (touches every parser, but mechanically).
- **Validation:** for each type with real records, assert parse consumes exactly `entry.size` (the SoundTable measurement in APPENDIX-B is this test, generalised); then feed each parser a truncated and an over-long buffer and assert errors.

### DAT-21 — No time-box around the wasm decode batch
- **Source §:** `07` §7 (the 25 ms per-frame completion budget, enforced identically in `ThreadedCache::UseTime` @654312 and `AsyncCache::CallPendingCallbacks` @84441).
- **Retail:** the main thread drains completed loads under `while (GetTickCount() - start < 0x19)` — a hard 25 ms box, "so a burst of loads degrades smoothly instead of hitching".
- **holtburger today:** the JS side has the equivalent and tighter: `apps/holtburger-web/scene3d/loop.js:1542` `RP3_DEFAULT_BUDGET_MS = 9`, overrun test at `:1631`, `?frameBudget=<ms>` clamped `[2, 33]` at `:1566`, `?frameBudget=off` to disable (`:1538`). But that guard schedules *JS deferrables*; a single wasm export (`fetch_terrain_textures`, `populate_statics_aabbs_for_landblock`) runs to completion once entered. The decode admission gate exists (`src/decode_admission.rs`) but ships neutral — `new(usize::MAX, usize::MAX, 0)` (`:33-37`) — so it applies no bound today.
- **Proposed change:** this is the natural consumer of the already-built gate: supply a real `set_decode_admission` bound (the module's own "slice S4"), and have the JS deferrable scheduler pass its remaining frame budget so a decode batch yields at the boundary instead of overrunning.
- **Payoff:** converts load hitches into spread-out frames — retail's exact rationale. Directly relevant to the standing jank work.
- **Effort:** M.
- **Validation:** `?renderDiag=on` long-task census during a `@telepoi` town entry, before/after; assert the 99th-percentile frame time falls without the total load time regressing more than the budget implies. Note MEMORY.md's measurement traps: fresh `--user-data-dir` per arm, `renderer.info.autoReset = false`, and wait for `terrainBakedLbs.size` to plateau.

## CRY — obfuscation, hashes, PRNGs

### CRY-01 — Spell-formula Layer 3 is absent: holtburger shows an uncastable formula for every versioned spell
- **Source §:** `10` §3.3.
- **Retail:** after `Decrypt`, `SpellFormula::RandomizeForName` (488270) dispatches on `CSpellBase::_formula_version` and rewrites **accent slots only** to one of the twelve tapers (IDs **63–74**, `expr % 0xC + 63`, where `TAPER = MagicSystem::GetLowestTaperID()` is a bare `return 63` at 488479). Scarabs and the power component are never touched — the formula stays castable-looking, but a screenshotted component list does not transfer between accounts. V1 (487980) is *dynamic*: with `n` = the count of non-zero comps, `n ≤ 5` rewrites nothing, `n = 6` rewrites slot 1, `n = 7` slots 1+3, `n = 8` slots 1+3+6. V2 (488093) unconditionally rewrites slots 3 and 6. V3 (488138) uses seven moduli. An unrecognised version leaves plain `Decrypt` output. All formulas are transcribed verbatim in the FORMULA APPENDIX.
- **holtburger today:** ABSENT. `crates/holtburger-dat/src/utils.rs:313-339` `decrypt_spell_components` stops after Layer 2, and its own doc comment says so (`:266-267`: "Taper rotation in player spell research … not yet ported"). `crates/holtburger-world/src/spell.rs:96-99` exposes exactly that Layer-2 output as `decrypted_components`, and the UI renders it — `apps/holtburger-web/plugins/spellbook.js:864-867` maps the ids through `data/spell-components.json`, and `apps/holtburger-web/ui/ac_spell_cast_sequence.js` builds the cast-gesture chain from the same list.
- **Reference implementation available:** ACE has all three versions at `~/ace-server/Source/ACE.DatLoader/FileTypes/SpellTable.cs:58-171`, plus the identical ELF hash as `ComputeHash` (`:31-50`). I expanded ACE's V2 and V3 algebra term by term against the doc and they agree exactly. Two deltas to carry from the doc rather than ACE: ACE's `RandomizeVersion1` **omits the three `if (X+Y) == 0: A = 1` div-by-zero guards** (it would throw), and ACE's V3 adds a `comps.Count < 8` guard substituting 0 for `comps[7]` (spell 2697 "Aerfalle's Touch") that the doc does not mention — keep both.
- **Proposed change:** port `randomize_for_name(comps, account_hash, formula_version)` into `crates/holtburger-dat/src/utils.rs` next to `decrypt_spell_components`, reusing `spellbase_string_hash` for the account hash. Thread the logged-in account name from the session into `SpellInfo` construction and expose `player_components` alongside `decrypted_components` (keep both — the raw Layer-2 output is the right thing for a DAT-inspection tool, the scrambled one for the spellbook).
- **Payoff:** the spellbook currently tells the player to use the wrong tapers. This is a user-visible correctness bug on a system that already renders component icons and spell-words, and the fix is a transcription of formulas that are fully specified.
- **Effort:** M (the math is small; the work is plumbing the account name to the DAT layer and deciding the API split).
- **Validation:** unit-test each version against ACE by running both implementations over the whole shipped SpellTable for a fixed account name and asserting identical output (excluding the V1 div-guard cases, which must be asserted separately against the doc). Then a live check: log in, open the spellbook, and compare a tier-6+ spell's tapers against ACE's own `GetPlayerFormula` for the same account via a server-side probe.

### CRY-02 — The scarab-only / foci formula path is absent
- **Source §:** `10` §3.4.
- **Retail:** `ClientMagicSystem::GetAppropriateSpellFormula` (404513) chooses between two accessors. It maps `_school` → property (1→297, 2→296, 3→295, 4→294, 5→328) and if `InqInt(prop) > 0` **or** `MagicPackIsOwned(essenceWCID)` (404583) it returns `InqScarabOnlyFormula` (**not** scrambled); otherwise `InqCustomizedSpellFormula` (scrambled — CRY-01). `InqScarabOnlyFormula` (448964) keeps only components in `{1..6, 0x6E, 0x6F, 0x70, 0xC0, 0xC1}`, stops at the first empty slot, then appends `k` copies of component `0xBC` (188, prismatic taper), `k` derived from the power level. **The decrypt layer is never bypassed** — both paths go through `InqSpellFormula`.
- **holtburger today:** ABSENT — one formula is rendered unconditionally (`plugins/spellbook.js:864`). No foci/magic-pack state is modelled on the client.
- **Reference implementation available:** ACE's `SpellFormula.GetFociFormula` (`~/ace-server/Source/ACE.Server/Entity/SpellFormula.cs:339-379`): scarab whitelist `IsScarab(component) || component == 111` (chorizite, with the comment "as per client"), then `numTapers` by `Power` — 1⇒1, 2⇒2, {3,4,7}⇒3, {5,6,8,9,10}⇒4 — appending component **188** that many times. Selection is `GetCurrentFormula`: `player.HasFoci(school) ? FociFormula : PlayerFormula` (`:383-386`).
- **Proposed change:** implement `foci_formula(comps, power)` beside CRY-01's `randomize_for_name`, and pick between them using the player's foci state (the school→property mapping is the client's own signal; ACE's `HasFoci` is the server's). Land it in the same change as CRY-01 so the spellbook has exactly one "which formula do I show" decision point.
- **Payoff:** a player with foci is shown a formula they cannot use, and vice versa. Same user-visible class as CRY-01.
- **Effort:** M.
- **Validation:** assert `foci_formula` reproduces ACE's `GetFociFormula` over the whole SpellTable; live-check with and without foci equipped.

### CRY-03 — The `comp > 198 → &= 0xFF` fixup is not in retail and should be instrumented
- **Source §:** `10` §3.2 (`SpellFormula::Decrypt` is a bare subtraction).
- **Retail:** I read the body (acclient.c:487851-487886). It is eight unrolled `if (comps[i]) comps[i] = comps[i] - key;` and a `return 1`. **No ceiling, no mask, no clamp.** The doc's §6 negative ("no obfuscation of any DAT record type other than spell data") and §7 provenance both treat `Decrypt` as fully read, so this is not a gap in the doc.
- **holtburger today:** `crates/holtburger-dat/src/utils.rs:330-333` adds `let mut comp = enc.wrapping_sub(key); if comp > 198 { comp &= 0xFF }`, documented at `:302-307` as an "accent-char fixup" with 198 as "the highest valid component ID in retail". It is inherited from DatReaderWriter's `SpellBase.DecryptComponents`.
- **Why it matters:** if the key is right, every non-zero slot lands in `1..=198` unaided. So the fixup can only fire when the key is *wrong* — i.e. when our name/description decode or our ELF hash diverges for that spell (the obvious candidate being Windows-1252 high bytes in an accented name, where retail's signed `char` is load-bearing). Masking turns "wrong key, obviously broken" into "wrong key, plausible-looking component", which is exactly the failure mode you cannot see in a UI.
- **Proposed change:** do not remove the fixup blind. Add a counter and log the `(spell_id, slot, pre-mask value)` whenever it fires, run it across the whole shipped SpellTable, and then: if the count is **0**, delete the branch and the 198 constant; if non-zero, the affected spells' name/description bytes are the bug — fix the hash/decode instead.
- **Payoff:** either deletes a non-retail special case or uncovers a real hash divergence. Both outcomes are wins, and the measurement is a single test run.
- **Effort:** S.
- **Validation:** the census itself. Note holtburger's `spellbase_string_hash` already does the `b as i8` sign extension correctly (`utils.rs:272`) and round-trips Windows-1252 losslessly through `encoding_rs`, so my prior is that the count is 0 — but that is a prediction, not a measurement.

### CRY-05 — `QuestDef`'s full name is nibble-swapped, and there is no QuestDef parser yet
- **Source §:** `10` §3.1 (the fifth swap site, **510828 `QuestDef::QuestDef`** — "Quest names use the same obfuscation, applied in the constructor right after `set(&_fullname, &name)`"). This is the **only non-spell** record with the swap.
- **Retail:** `QuestDef` is the `QUEST_DEF_DB` singleton `0x0E00001B` (`07` §4), and its `_fullname` is stored obfuscated.
- **holtburger today:** ABSENT — no QuestDef parser (`crates/holtburger-dat/src/file_type/` has no quest module; the only `quest` hits are in `contract_table.rs`, a different record). Importantly, `ContractTable` (`0x0E00001D`) strings are **not** obfuscated and holtburger correctly reads them with plain `read_pstring_char` (`contract_table.rs:68`, fields at `:82-99`) — so there is nothing to fix today.
- **Proposed change:** none now. Record the trap: when a `QuestDef` parser lands, its `_fullname` must go through `read_obfuscated_string`, not `read_pstring_char`. Add that as a comment in `file_type/mod.rs` next to the `0x0E` classification so the next author sees it.
- **Payoff:** prevents a future parser from shipping mojibake quest names — a mistake that looks like a text-encoding bug and will be debugged as one.
- **Effort:** S (a comment now; part of the parser later).
- **Validation:** when written, assert the decoded name of a known quest is readable ASCII.

### CRY-06 — `PalShift::SelectRot` / `GetBeginRotIx` (the legacy land-surface path) are absent
- **Source §:** `10` §4.3 Family B; `07` §11 (`LandSurf::UnPack` at 303985 "reads one selector word choosing the legacy `PalShift` path or the modern `TexMerge` path").
- **Retail:** two Family-B members select land-texture rotation deterministically: `PalShift::SelectRot` (300893/300896/300899) with `M = 0x622DBEDF`, `C = −0x791C2B27`, and `PalShift::GetBeginRotIx` (300276) with `M = 0x1DE6BF23`, `C = +0x490893B5`, both over `H = 0x6C1AC587*y − x*(M*y + 0x421BE3BD) + C` scaled by `2.3283064e-10`.
- **holtburger today:** ABSENT — no `PalShift`/`SelectRot`/`GetBeginRotIx` symbol, and neither constant appears (I checked both hex and decimal forms). Only the `TexMerge` arm is implemented, correctly and well (`crates/holtburger-dat/src/terrain_merge.rs` — see the Family D row, which holtburger gets *more* right than ACE does).
- **Proposed change:** none, unless a Region is encountered whose `LandSurf` selector chooses `PalShift`. Add the selector check to `region.rs`'s `LandSurf` handling so an unexpected legacy Region fails loudly instead of being silently mis-rendered, and record the two constant pairs here so a future implementer does not have to re-derive them (they are in the FORMULA APPENDIX).
- **Payoff:** documents a dormant branch and turns "wrong terrain textures" into an error. The shipped Dereth Region takes `TexMerge`, so there is no live impact.
- **Effort:** S for the guard.
- **Validation:** assert the shipped `0x13000000` `LandSurf` selector is the `TexMerge` value; assert a patched selector errors.

### CRY-07 — `Random::rand` (L'Ecuyer `ran2`) and `RollDice` are absent
- **Source §:** `10` §4.2, §4.2b.
- **Retail:** `Random::rand` (105458) is Numerical Recipes `ran2` verbatim — an L'Ecuyer combined MRG with a Bays–Durham shuffle, `NTAB = 32`, seeded once per process from `time(0)` right after `Timer::Init()` (78040). Exact output range is **`[AM, RNMX]` = `[4.656613e-10, 0.99999988]`** — never 0, never ≥ 1 — with period ≈ 2.3e18. `RollDice(int lo, int hi)` = `lo + trunc(rand() * (hi − lo + 1))`, uniform over `[lo, hi]`, and the `RNMX` clamp is *what stops it overshooting*. `RollDice(float lo, float hi)` = `rand() * (hi − lo) + lo`, **half-open — it never reaches `hi`**. Full constant block in the FORMULA APPENDIX. Roughly 35 call sites, all cosmetic: particle emitters, ambient sound selection, weather descriptors, scene and animation choice, idle chatter.
- **holtburger today:** ABSENT (no `RNMX`, `2147483563`, `40014`, `ran2` or `Ecuyer` anywhere in `crates` or `apps/holtburger-web` outside `node_modules`).
- **Proposed change:** implement `Random::{seed, rand, roll_dice_int, roll_dice_float}` in `holtburger-common` and use it wherever retail used it. Be deliberate about the seed: retail's `time(0)` makes each session different, so bit-parity with a *particular* retail session is impossible and not the goal — the goal is the right *distribution shape*, which includes the two clamp quirks.
- **Payoff:** the correct distribution for ambient/idle/particle variety. Low urgency (all call sites cosmetic), but it is the substrate for the audio-variant bug below, and it is a self-contained ~40-line port with an exactly specified range.
- **Effort:** S.
- **Validation:** 10⁷ samples: assert `min > 0`, `max <= 0.99999988`, mean ≈ 0.5; assert `roll_dice_int(1, 6)` hits all six faces and never 0 or 7; assert `roll_dice_float(0.0, 1.0)` never returns exactly 1.0.
- **Rider (cross-lane, `10` §4.2b / `09-audio.md`):** because the range is half-open, retail's sound-variant selection `(N−1) * roll` can never reach `N−1`, so **the last variant in every multi-variant SoundTable node is unreachable**. holtburger's `sound_table.rs` exposes all N. Whoever wires variant selection must decide whether to reproduce that (parity) or fix it (better audio) — it must be a decision, not an accident.

### CRY-08 — `PerlinNoise` is absent
- **Source §:** `10` §4.5.
- **Retail:** `PerlinNoise::Init` (477221) does `srand(0)` — **deliberately fixed**, so the table is identical in every session and every install — then `p[i] = i`, `g1[i] = (rand() % 512 − 256) * (1/256)` giving `[-1, 1)`, then a Fisher–Yates with a **biased** index (`j = rand() % 256` for every `i`, not `rand() % (i+1)`), then wrap-tail copies of `g1[0..257]` → `g1[256..]` and `p[0..257]` → `p[256..]`. `Noise(x)` (477246) lazily one-shot-inits, then `t = x + 10000.0`, `i = (uint8)(int)t`, `f = t − (int)t`, and returns `(b − a) * (f*f * (3 − 2f)) + a` with `a = f * g1[p[i]]`, `b = (f − 1) * g1[p[(uint8)(i+1)]]` — Perlin's **original cubic** smoothstep, not the quintic.
- **holtburger today:** ABSENT (zero `perlin` hits outside `node_modules`).
- **Proposed change:** port it. Because `srand(0)` fixes the table, the *only* variable is the CRT LCG's constants — which live in MSVCRT, not the decompilation (`10` §4.2b). So a bit-exact port needs the MSVC LCG (`seed = seed*214013 + 2531011; return (seed >> 16) & 0x7FFF`), which is well known and worth stating explicitly in the port so nobody substitutes a different generator and quietly changes every noise value.
- **Payoff:** fully deterministic and therefore exactly verifiable — the cheapest parity win in this document if anything visual (water, sky, terrain detail) is meant to consume it.
- **Effort:** S.
- **Validation:** golden-vector `Noise(x)` for a spread of `x` (including negative and > 256 to exercise the `+10000.0` bias and the `uint8` wrap) hand-computed from the MSVC LCG; assert the table is stable across runs.

### CRY-09 — `NetError` `{stringID, tableID}` pairs are not modelled, so server disconnect reasons are unrenderable
- **Source §:** `10` §4.1.
- **Retail:** every wire `NetError` is a `{stringID, tableID}` pair whose `stringID` is the PJW/ELF hash of a literal — e.g. `compute_str_hash("ID_ConnectionError_BadCryptoKey")` at acclient.c:800711. The client resolves the pair through the StringTable to display a reason.
- **holtburger today:** ABSENT — no `NetError` type in `holtburger-protocol` or `holtburger-session`. A server-side rejection therefore surfaces as a silent stall.
- **Proposed change:** model the pair, and build the reverse table by hashing the known `ID_ConnectionError_*` / `ID_*` literal set with the hash we **already have** (`crates/holtburger-dat/src/utils.rs:268` `spellbase_string_hash` *is* `compute_str_hash`; give it a neutral alias like `elf_hash` and re-export it from `holtburger-common` so the protocol crate can use it without depending on `holtburger-dat`). Surface the resolved string in `__diag.wire`.
- **Payoff:** directly addresses the diagnostic hole wave1-B raised as NET-19 (no net-health surface) at its most useful point: "the server told you why". Cheap because the hash is in-tree and the literals are enumerable from the decomp.
- **Effort:** S.
- **Validation:** assert `elf_hash("ID_ConnectionError_BadCryptoKey")` equals the constant at acclient.c:800711; then force a bad-credentials login and assert the reason renders.

### CRY-10 — Receive-side ISAAC resync should key on seqID (extends wave1-B NET-17)
- **Source §:** `10` §2.4.
- **Retail:** the key for a retransmitted packet is **stored, not searched**. `ReceiverData::AddNakked` (376642) pre-draws the keystream word for each missing seqID and stores it in the `m_SeqIDsWeNAKed` AVL; `SharedNet::ProcessNewSeqNum` (372085-372097) `Remove`s it by seqID and passes it as `pDecryptionKey`. Two details I verified in the decomp that the NET-17 writeup does not carry: (a) when a packet is encrypted (`header_ & 2`) and **not** newer than `highestIDReceived_`, retail requires the AVL entry and **drops the packet outright (`return 0`) if it is missing** — it never guesses forward; (b) the send side cannot re-draw either: the encrypt block is gated on `!(flags_ & 1)` and sets `flags_ |= 1` on first encryption (375157-375162), so a resend ships the already-encrypted checksum with its original key.
- **holtburger today:** the **send** side already matches (b) exactly, by algebra rather than storage — `crates/holtburger-session/src/session/reliability.rs:120-134` recovers `isaac_key = payload_hash ^ (header.checksum − original_header_hash)` from the cached packet and re-adds it under the new (RETRANSMISSION-flagged) header hash. Correct and elegant. The **receive** side is the divergence: `crates/holtburger-protocol/src/crypto.rs:73-93` `Isaac::search` consumes forward up to `256 − xors.len()` keys into a `HashSet`, and `consume_key_value` (`:65-71`) either advances or removes from the set.
- **Proposed change:** as NET-17 states — a bounded `BTreeMap<u32 /*seq*/, u32 /*key*/>` of accepted s2c keys, consulted before `search`, bounded exactly like `cached_packets`. Add from this analysis: mirror retail's *ordering rule* too — for a non-newest encrypted packet, prefer the stored key and treat a miss as a drop-and-NAK rather than a forward search, since a forward search on a duplicate silently burns keystream that a later legitimate packet needs.
- **Payoff:** removes an unrecoverable-desync failure mode (every subsequent packet fails checksum → 140 s silent death) on a lossy WS path. Cheap.
- **Effort:** S. **Owned by wave1-B NET-17** — recorded here only for the two extra retail details and the send-side confirmation. Do not schedule twice.
- **Validation:** as NET-17 (accept 1..10, re-deliver 4 after 12, assert it validates) plus a duplicate-injection soak asserting `search` is never entered.

### CRY-11 — Note: `Hash32` is `#[allow(dead_code)]` but is the live packet checksum
- **Source §:** `10` §1.1.
- **holtburger today:** `crates/holtburger-protocol/src/crypto.rs:3-7` marks `Hash32` `#[allow(dead_code)]`, yet it is the checksum for every packet in both directions (`transport.rs:156`, `session/send.rs:31/44/54`, `session/receive.rs:167`, `session/reliability.rs:120/129`).
- **Proposed change:** drop the attribute (and the one on `impl Hash32`). One line.
- **Payoff:** a stale `dead_code` allowance on load-bearing crypto is exactly the annotation that makes a reader assume they can delete it. Zero risk.
- **Effort:** S.
- **Validation:** it compiles without the attribute (proving it is used), and the golden vectors at `crypto.rs:241-285` stay green.

> **Numbering note.** There is deliberately no CRY-04. `SpellComponentBase::_text` (`10` §3.1's "stored obfuscated with no deobfuscating accessor") was the candidate, and holtburger is **ahead of retail** there — it swaps and renders it (`crates/holtburger-dat/src/file_type/spell_components_table.rs:104-105`, consumed by `apps/holtburger-web/ui/ac_spell_cast_sequence.js`). Kept as a gap so IDs stay stable if it ever needs one.

---

# PART 3 — FORMULA APPENDIX

Every reproducible transform from `10-crypto-obfuscation.md` (plus the DAT-side
formulas from `07`), transcribed so it is usable without re-reading either doc.
Each is marked **(a) implemented — cite**, **(b) needed**, or **(c) N/A**.

## A1. `PortalChecksum::CalcChecksum32` — acclient.c:629839 — **(a) implemented**

```
CalcChecksum32(data, size) -> uint32:
    if data == NULL: return 0
    sum  = size << 16                       # SEED — note the shift
    for k in 0 .. (size >> 2) - 1:
        sum += LE32(data + 4*k)             # wrapping add mod 2^32
    tail = 0
    j = 3                                   # descending
    for p in 4*(size >> 2) .. size-1:
        tail += ZEXT8(data[p]) << (8 * j)   # 24, then 16, then 8
        j -= 1
    return (sum + tail) mod 2^32
```
Bytes are **zero-extended** (`movzx`), not sign-extended — resolved across three
decompilations; a signed reproduction diverges on any packet whose length is not a
multiple of 4 and whose tail contains a byte ≥ 0x80.
→ `crates/holtburger-protocol/src/crypto.rs:8-27`. Golden vectors at `:243-250`.

## A2. `SharedNet::ChecksumHeader` — acclient.c:369083, magic @369101 — **(a) implemented**

`ProtoHeader` is 20 B (acclient.h:34520): `seqID_, header_, checksum_, recID_, interval_, datalen_, iteration_`.
```
ChecksumHeader(H):
    tmp = copy of H                     # 20-byte stack copy
    tmp.checksum_ = 0xBADD70DD          # -1159892771
    return CalcChecksum32(&tmp, 0x14)
```
Closed form (20 is a multiple of 4, so no tail):
```
ChecksumHeader(H) = 0xBAF170DD                              # 0x00140000 + 0xBADD70DD
                  + H.seqID_ + H.header_
                  + (H.recID_   | (H.interval_  << 16))
                  + (H.datalen_ | (H.iteration_ << 16))     mod 2^32
```
→ `crates/holtburger-protocol/src/messages/transport.rs:19` + `:149-158`.

## A3. Wire checksum composition — **(a) implemented; corrects a doc ambiguity**

```
wire.checksum_ = ChecksumHeader(header) + (body_checksum ^ isaac_key)   mod 2^32
```
where `body_checksum` = `NetPacket::ComputeChecksum` (A4). Order verified directly:
`FlowQueue::EncryptChecksum` (acclient.c:374446) and the transmit loop (:375157-375169)
XOR **`NetPacket::checksum_` — the body-only sum**; then `newHeader.checksum_ = v5->checksum_`;
then `SharedNet::SendPacket` (:369221) does `pheader->checksum_ += ChecksumHeader(pheader)` (:369247).
Receive mirrors it: `checksum_ -= ChecksumHeader` immediately after `recvfrom` (:369987),
then in-place decrypt in `ProcessNewSeqNum` (:372100), then compare (:370677).
→ `crates/holtburger-session/src/session/send.rs:108`.

## A4. `NetPacket::ComputeChecksum` — acclient.c:376684 — **(a) implemented**

```
ComputeChecksum(pkt):
    pkt.checksum_ = 0
    pkt.flags_ &= ~0x1                                  # clear npfChecksumEncrypted
    for oh in pkt.specialFragList_[0 .. numSpecialFrags_-1]:
        pkt.checksum_ += CalcChecksum32(oh.m_pData, oh.m_cbData)
    for f in pkt.fragList_[0 .. numFrags_-1]:
        pkt.checksum_ += CalcChecksum32(f.hdrRead_, 0x10)
        pkt.checksum_ += CalcChecksum32(f.dat_, f.hdrRead_.blobFragSize - 16)
```
`m_dwMask` and `m_Flags` are **not** checksummed; the mask reaches the wire OR'd into
`header_`, which *is* covered by A2.
→ `crates/holtburger-session/src/session/send.rs:24-64`.

## A5. ISAAC-32 `mix` / `shuffle` — acclient.c:630089 — **(a) implemented**

```
a ^= b << 11;   d += a;   b += c
b ^= c >>  2;   e += b;   c += d
c ^= d <<  8;   f += c;   d += e
d ^= e >> 16;   g += d;   e += f
e ^= f << 10;   h += e;   f += g
f ^= g >>  4;   a += f;   g += h
g ^= h <<  8;   b += g;   h += a
h ^= a >>  9;   c += h;   a += b
```
→ `crates/holtburger-protocol/src/crypto.rs:138-163`.

## A6. `randinit` — acclient.c:629964, golden ratio @629989 — **(a) implemented**

```
randinit(ctx, bUseSeed):
    a..h = 0x9E3779B9
    if not bUseSeed: randa = randb = randc = 0
    repeat 4: mix(a..h)
    if bUseSeed:
        for i in 0,8,..,248: a+=randrsl[i+0] .. h+=randrsl[i+7]; mix(); randmem[i+0..7]=a..h
        for i in 0,8,..,248: a+=randmem[i+0] .. h+=randmem[i+7]; mix(); randmem[i+0..7]=a..h
    isaac(ctx)
    randcnt = 256
```
→ `crates/holtburger-protocol/src/crypto.rs:107-136`.

## A7. `isaac` core — acclient.c:630184 — **(a) implemented**

Unrolled 4× with barrel-shift cycle `a<<13` (630236), `a>>6` (630245), `a<<2` (630255),
`a>>16` (630266); `ind(x) = *(uint32*)((uint8*)randmem + (x & 0x3FC))`. No altered
constants, no extra XOR.
```
c += 1;  b += c
for i in 0..255:
    x = mm[i]
    a ^= (i&3 == 0) ? a<<13 : (i&3 == 1) ? a>>6 : (i&3 == 2) ? a<<2 : a>>16
    a += mm[(i + 128) & 0xFF]
    y = mm[(x >> 2) & 0xFF] + a + b
    mm[i] = y
    b = mm[(y >> 10) & 0xFF] + x
    randrsl[i] = b
```
→ `crates/holtburger-protocol/src/crypto.rs:165-186`.

## A8. `CryptoSystem` seeding — the 32-bit key-space collapse — acclient.c:630161, ctor 629933, read 629945-629960 — **(a) implemented**

```
QTIsaac(seed, seed, seed):
    randrsl = new uint32[256]; randmem = new uint32[256]
    for i in 0..255: randrsl[i] = 0          # <-- SEED ARRAY ZEROED
    randa = randb = randc = seed
    randinit(&m_rc, bUseSeed=1)              # never reads randa/b/c
```
Because `randrsl[]` is all zeros, `randmem[]` after `randinit` is a **fixed universal
table**, identical for every connection. The seed enters only through the terminating
`isaac()`, which therefore begins:
```
a = seed        c = seed + 1        b = 2*seed + 1
```
**Effective key space = 32 bits, not ISAAC's 8192.** Two connections sharing a seed
produce identical keystreams. `QTIsaac::srand` (629881) would have seeded properly but
is dead.
→ `crates/holtburger-protocol/src/crypto.rs:50-51` + `:131-135`; pinned by five golden
seeds at `:252-284` (e.g. seed `0x0` ⇒ `0x182600F3`, `0x300B4A8D`).

## A9. `GetNextCryptoSeed` — acclient.c:630355 — **(a) implemented**

```
GetNextCryptoSeed(iteration):        # `iteration` is never read
    lastIter_ += 1                   # written, never read
    v = randcnt; randcnt = v - 1
    if v != 0: return randrsl[v - 1]
    else: isaac(); randcnt = 255; return randrsl[255]
```
One word per call, drawn **downward** from `randrsl[255]` to `[0]`; exactly 256 words
per `isaac()` run, no duplication or skipping across the boundary.
→ `crates/holtburger-protocol/src/crypto.rs:96-105` (`offset` 255→0, then `scramble()`).

## A10. `CryptoSystem::EncryptData` — acclient.c:630381 — **(a) implemented for the only live case**

```
EncryptData(iteration, data, size, pEncryptSeed) -> uint32:
    key = pEncryptSeed ? *pEncryptSeed          # replay a saved word
                       : GetNextCryptoSeed()    # draw and consume
    for k in 0 .. (size >> 2) - 1:
        ((uint32*)data)[k] ^= key               # SAME word for every dword
    return key
```
Trailing `size % 4` bytes are left cleartext. Encrypt == decrypt. **All three call sites
pass length 4** — 372100 (`ProcessNewSeqNum`, recv), 374455 (`FlowQueue::EncryptChecksum`,
send), 375159 (transmit loop, send) — so the loop never iterates more than once.
→ holtburger XORs the single u32 directly (`session/send.rs:108`); the general
multi-dword primitive is (c) N/A.

## A11. Diffie-Hellman parameters — `ClientNet::Init`, acclient.c:373513-373534 — **(c) N/A**

```
shared_base  = 0xdd80c2e508b630998076a9f7319c930d954f2866f53932baa2938467f25ed069
shared_prime = 0xdd80c2e508b630998076a9f7319c930d954f2866f53932baa2938467f2602bfb
```
Identical in their first 56 nibbles; the naming is inverted from convention. **No
exchange is ever computed** — `PortalDH::Init` (474887) only stores them, the private
exponent is the literal `10` (373283), and `vlong` has no division/modulo/`monty`/modular
inverse, so modexp is arithmetically impossible. Transcribed for completeness only.

## A12. PJW/ELF string hash (`compute_str_hash`) — acclient.c:69999 / 78974 / 297666, all byte-identical — **(a) implemented**

```
hash(s) -> uint32:
    r = 0
    for c in s:                              # c is a SIGNED char
        r = (c + 16*r) & 0xFFFFFFFF
        if r & 0xF0000000:
            r = (r ^ ((r & 0xF0000000) >> 24)) & 0x0FFFFFFF
    if r == 0xFFFFFFFF: r = 0xFFFFFFFE       # -1 sentinel — UNREACHABLE (r is always < 2^28)
    return r
```
The signed `char` matters for bytes ≥ 0x80, which do occur in descriptions.
→ `crates/holtburger-dat/src/utils.rs:268-279` (`spellbase_string_hash`), ACE's
`SpellTable.ComputeHash` (`~/ace-server/Source/ACE.DatLoader/FileTypes/SpellTable.cs:31-50`).
**Not** the same as holtburger's other `string_hash` (`utils.rs:513-525`, a rotate-4
variant with no counterpart in acclient.exe — see ledger §4.1).

## A13. Spell nibble swap (Layer 1) — acclient.c:448856 / 448899 / 448912 / 487046 / **510828** — **(a) implemented**

```
deobfuscate(PStringBase s):          # == obfuscate; involution
    s.break_reference()              # private copy; sets m_hash = -1
    p   = s.m_buffer + 20            # &m_data[0]
    end = s.m_buffer + s.m_len + 19  # &m_data[m_len - 1]  -> excludes the NUL
    while p != end:
        *p = ((*p << 4) | ((uint8)*p >> 4)) & 0xFF
        p++
```
`m_len` includes the terminator, so the loop covers `strlen` bytes. On disk the packed
length is `m_len - 1` (`PStringBase::Pack`, acclient.c:296374-296400) — i.e. already
`strlen` — so swapping the whole packed run is exactly right.
→ `crates/holtburger-dat/src/utils.rs:192-204` (`byte.rotate_left(4)`).
Site 510828 (`QuestDef::_fullname`) is **(b) needed when a QuestDef parser lands** — CRY-05.

## A14. Spell-formula key (Layer 2) — `CSpellBase::InqSpellFormula` body @448869, add @448932 — **(a) implemented**

```
n   = nibble_swap(copy of _name)                          # 448887-448903
d   = nibble_swap(copy of _desc)                          # 448890-448916
key = (hash(n) % 0x12107680) + (hash(d) % 0xBEADCF45)     # wrapping add
```
**Both moduli are no-ops**: the `& 0x0FFFFFFF` fold caps the hash at `0x0FFFFFFF`
(268,435,455) while the moduli are 303,068,800 and 3,199,061,829 — both larger.
**The key is simply `hash(name) + hash(desc)` mod 2³².** Constants are stable across
versions (identical at `acclient 6.95.16808.c:444146` and the 2015 build's `:446510`).
→ `crates/holtburger-dat/src/utils.rs:288-289` + `:318-323`.

## A15. `SpellFormula::Decrypt` — acclient.c:487851 — **(a) implemented, with a non-retail addition**

```
Decrypt(formula, key):
    for i in 0..7:
        if formula._comps[i] != 0:
            formula._comps[i] = (formula._comps[i] - key) & 0xFFFFFFFF
```
Zero slots untouched (zero is the empty-slot sentinel). Fully unrolled in the binary.
**There is no `SpellFormula::Encrypt`** — the client is read-only; the forward transforms
are `swap` and `+key`. **Retail has no `> 198` clamp and no `& 0xFF`.**
→ `crates/holtburger-dat/src/utils.rs:326-337`; the extra `if comp > 198 { comp &= 0xFF }`
at `:331-333` is CRY-03.

## A16. `SpellFormula::RandomizeForName` (Layer 3) — acclient.c:488270 — **(b) NEEDED (CRY-01)**

Dispatches on `CSpellBase::_formula_version`; an unrecognised version leaves plain
`Decrypt` output. Throughout, `TAPER = MagicSystem::GetLowestTaperID() = 63` (a bare
`return 63` at 488479, called only from these three functions). Every rewritten slot is
`expr % 0xC + 63`, i.e. one of the twelve tapers, IDs **63–74**. **Only accent slots ever
change** — scarabs and the power component are never touched.

### Version 1 — acclient.c:487980 (slot selection is DYNAMIC)

```
n = count of nonzero _comps[0..7]
h = hash(account_name); seed = h % 0x13D573

i1 = 1;  if n > 5: { i1 = 2; accent1 = 1 }
i2 = i1 + 1;  if n > 6: { i2 += 1; accent2 = 1 }
i3 = i2 + 1
i4 = i3 + 1;  if n > 7: { i4 += 1; accent3 = 1 }

A = _comps[0]; B = _comps[i1]
C = _comps[i2] if 0<=i2<8 else 0
D = _comps[i3] if 0<=i3<8 else 0
E = _comps[i4] if 0<=i4<8 else 0          # ALL reads happen before ANY write

if accent1:  if (A+B)==0: A=1
             _comps[1] = (C + 2*B + D + E + A) % 0xC + TAPER
if accent2:  S = C+D; if (A+S)==0: A=1
             _comps[3] = ((A + B + E + 2*S) * (seed / (A+S))) % 0xC + TAPER
if accent3:  if (E+A)==0: A=1
             _comps[6] = ((C + 2*E + D + B + A) * (seed / (E+A))) % 0xC + TAPER
```
| n | slots rewritten |
|---|---|
| ≤ 5 | **none — version 1 is a no-op** |
| 6 | `_comps[1]` |
| 7 | `_comps[1]`, `_comps[3]` |
| 8 | `_comps[1]`, `_comps[3]`, `_comps[6]` |

Two quirks: the `accent1` block has a div-by-zero guard but **no division** — `_comps[1]`
does not use `seed` at all (independently confirmed at `acclient 6.95.16808.c:482372`, so
not a folding artifact). And `seed / (A+S)` is **unsigned integer division**, yielding 0
whenever the divisor exceeds `seed`, which zeroes the whole product — so `_comps[3]` and
`_comps[6]` frequently come out as exactly **63**.
⚠ ACE's `RandomizeVersion1` omits all three div-by-zero guards. Port them from here.

### Version 2 — acclient.c:488093 (unconditional; always slots 3 and 6)

```
h = hash(account_name)
_comps[3] = (3*c0 + c1 + c2 + 2*c4*c5 + c7) % 0xC + TAPER
_comps[6] = ((3*c0*c2 + c4 + 2*c5 + c7)
             * ((h % 0x13D573) / (c1*c7 + 2*c4))) % 0xC + TAPER
```
Same `0x13D573` modulus as V1. **No div-by-zero guard** — `c1*c7 + 2*c4` is assumed
nonzero. All arithmetic is 32-bit wrapping; `2*c4*c5` and `c0*c2` can overflow.
(ACE's V2 expands to exactly this; verified term by term.)

### Version 3 — acclient.c:488138 (seven moduli, all confirmed)

| Local | Line | Modulus | Paired slot |
|---|---|---|---|
| `a0` | 488189 | `0x13D573` | `_comps[0]` |
| `a1` | 488198 | `0x4AEFD` | `_comps[1]` |
| `a2` | 488207 | `0x96A7F` | `_comps[2]` |
| `a4` | 488216 | `0x100A03` | `_comps[4]` |
| `a5` | 488225 | `0xEB2EF` | `_comps[5]` |
| `a7` | 488234 | `0x121E7D` | `_comps[7]` |
| — | 488258 | `0x65039` | applied to **raw** `h`, slot 6 only |

```
h = hash(account_name)
a0 = (h % 0x13D573 + _comps[0]) % 0xC
a1 = (h % 0x4AEFD  + _comps[1]) % 0xC
a2 = (h % 0x96A7F  + _comps[2]) % 0xC
a4 = (h % 0x100A03 + _comps[4]) % 0xC
a5 = (h % 0xEB2EF  + _comps[5]) % 0xC
a7 = (h % 0x121E7D + _comps[7]) % 0xC

_comps[3] = (a0 + a1 + a2 + a4 + a5
             + a2*a5 + a0*a1 + a7*(a4 + 1)) % 0xC + TAPER

_comps[6] = (a0 + a1 + a2 + a4 + a5
             + (h % 0x65039) % 0xC
             + a7 * (a4 * (a0*a1*a2*a5 + 7) + 1)
             + 5*a0*a1
             + 11*a2*a5) % 0xC + TAPER
```
All `a*` are already in [0,11], so nothing overflows here.
⚠ ACE adds a `comps.Count < 8` guard substituting 0 for `_comps[7]` (spell 2697
"Aerfalle's Touch"). Keep it.

## A17. `InqScarabOnlyFormula` (the foci bypass) — acclient.c:448964, selector 404513 — **(b) NEEDED (CRY-02)**

```
switch (_school):                       # 404557-404575
    1 -> prop 297;  2 -> prop 296;  3 -> prop 295;  4 -> prop 294;  5 -> prop 328
if InqInt(prop) > 0:                   goto SCARAB_ONLY
elif MagicPackIsOwned(essenceWCID):    goto SCARAB_ONLY     # 404583
else: return InqCustomizedSpellFormula(sBase, account_name) # scrambled (A16)
SCARAB_ONLY: return InqScarabOnlyFormula(sBase)             # NOT scrambled
```
`InqScarabOnlyFormula` keeps only components in `{1..6, 0x6E, 0x6F, 0x70, 0xC0, 0xC1}`
(= 1–6, 110, 111, 112, 192, 193), **stops at the first empty slot**, then appends `k`
copies of component `0xBC` (**188**, prismatic taper) where `k` derives from the power
level. ACE's tally (`SpellFormula.cs:352-377`): `Power` 1⇒1, 2⇒2, {3,4,7}⇒3,
{5,6,8,9,10}⇒4. **The decrypt layer is never bypassed** — both paths go through
`InqSpellFormula`.
Known retail bug: `0x6F` (111, chorizite) is accepted here but is **absent from
`DeterminePowerLevelOfComponent`** (488433), so such a scarab scores 0.

## A18. Full reimplementation reference (`10` §3.5) — **(b) partially needed**

```python
def spell_formula(spell, account_name, scarab_only):
    name = nibble_swap(spell.raw_name)      # strlen bytes, terminator excluded
    desc = nibble_swap(spell.raw_desc)
    key  = (elf_hash(name) + elf_hash(desc)) & 0xFFFFFFFF
    comps = [(c - key) & 0xFFFFFFFF if c else 0 for c in spell.raw_comps]
    if scarab_only:
        return scarabs_plus_placeholder(comps)
    return randomize(comps, elf_hash(account_name), spell.formula_version)
```
holtburger implements through the `comps` line; both branches after it are CRY-01/CRY-02.

## A19. Landcell triangulation direction — `CLandBlockStruct::ConstructPolygons`, acclient.c:354046, compare @354050 — **(a) implemented**

```
v = y*(214614067*x + 1813693831) - 1109124029*x - 1369149221
SWtoNEcut = ((double)(uint32)v * 2.3283064e-10) >= 0.5
```
Hex: `0x0CCAC033`, `0x6C1AC587`, `0x421BE3BD`, `0x519B8F25`. `x`/`y` are **global** cell
coordinates (`block_x = ((id>>24)&0xFF)*8`, `block_y = ((id>>16)&0xFF)*8`), so every
landcell's diagonal is a pure function of world position with no state. The float compare
is exactly a test of `H & 0x80000000`.
→ `crates/holtburger-scenery-bake/src/height.rs:50` / `:148`;
`WorldBuilder.Shared/Lib/Terrain/TerrainAlgorithms.cs` `IsSWtoNEcut`;
`crates/holtburger-dat/src/transition/terrain_collision.rs:11`.

## A20. Coordinate-hash **Family A** — **(a) implemented for four of five; (b) needed for the fifth (DAT-09)**

Shape: `0x6C1AC587*y − K*(M*y*x + C0) − 0x421BE3BD*x`, then `× 2.3283064e-10`.
**CORRECTED CONSTANTS** — read directly from acclient.c:462619/462626/462670 and
352668, because `10` §4.3 mis-transcribes both inner values:

| symbol | decimal | hex | doc says |
|---|---|---|---|
| `0x6C1AC587` | 1813693831 | `0x6C1AC587` | ✓ |
| `0x421BE3BD` | 1109124029 | `0x421BE3BD` | ✓ |
| `M` | **1360117743** | **`0x5111BFEF`** | ✗ `0x511E5B6F` |
| `C0` | **1888038839** | **`0x70892FB7`** | ✗ `0x708F5CB7` |

| Use | Line | `K` |
|---|---|---|
| `CLandBlock::get_land_scenery` — object cull vs. `freq` | 352668 (strength-reduced at 352728-352730) | **`kq + 23399`** — the doc's bare `23399` is the *initial* value only |
| `ObjectDesc::ScaleObj` — via `pow(max/min, H) * min` | 351370 | `k + 32593` |
| `ObjectDesc::Place` — X displacement | 462619 | `iq + 45773` |
| `ObjectDesc::Place` — Y displacement | 462626 | `iq + 72719` |
| `ObjectDesc::GetObjFrame` — heading (DEGREES, into `Frame::set_heading`) | 462670 | `k + 63127` |

→ `crates/holtburger-scenery-bake/src/noise.rs:118-132` (`displace_noise`, correct shape
with the index), used at `:148` / `:156` / `:183` / `:205`. The cull at `:88-93`
(`object_noise`) is the loop-invariant one — **DAT-09**.

## A21. Coordinate-hash **Family B** — **(a) implemented for the quadrant; (b) needed for PalShift (CRY-06)**

Shape: `0x6C1AC587*y − x*(M*y + 0x421BE3BD) + C`, then `× 2.3283064e-10`.

| Use | Line | `M` | `C` |
|---|---|---|---|
| `ObjectDesc::Place` — 4-way rotation quadrant | 462630 | `0x6F7BD965` (1870387557) | `−0x17FCEDFD` (−402451965) |
| `PalShift::SelectRot` — land texture index | 300893/896/899 | `0x622DBEDF` | `−0x791C2B27` |
| `PalShift::GetBeginRotIx` — start rotation index | 300276 | `0x1DE6BF23` | `+0x490893B5` |

Quadrant branch (acclient.c:462630-462655): `H >= 0.75` ⇒ `(y, −x)`; `>= 0.5` ⇒ `(−x, −y)`;
`>= 0.25` ⇒ `(−y, x)`; else `(x, y)`.
→ quadrant at `crates/holtburger-scenery-bake/src/noise.rs:99-112` + branch `:160-170`.
The two `PalShift` members are the dormant legacy land-surface path.

## A22. Coordinate-hash **Family C** — **(a) implemented**

Shape: `y*(M*x + 0x6C1AC587) − 0x421BE3BD*x + C`, then `× 2.3283064e-10`.

| Use | Line | `M` | `C` |
|---|---|---|---|
| `ConstructPolygons` — `SWtoNEcut` (A19) | 354046 | `0x0CCAC033` (214614067) | `−0x519B8F25` (−1369149221) |
| `get_land_scenery` — which scene of `SceneCount` | 352640 | `0x2A7F2B89` (712977289) | `+0x7F8CDA01` (2139937281) |

→ `crates/holtburger-scenery-bake/src/noise.rs:47-59` (`cell_mat_scene`); pinned bit-exact
in `crates/holtburger-scenery-bake/tests/golden_decomp.rs` (`(42,314) == 0x7F0E8239`,
`(1000,1000) == 2_168_064_849`).

## A23. Coordinate-hash **Family D** — terrain alpha-mask selection — **(a) implemented, better than ACE**

```
H   = (0x523AA99E * pcode - 0x51C9E74A) mod 2^32      # 1379576222, 1372186442
idx = floor(H * 2.3283064e-10 * count)
```
`TexMerge::FindRoadAlpha` (304712), `FindTerrainAlpha` (304781 side maps, 304804 corner maps).
**The wrapping matters**: ACE computes this in 64-bit `long` and does not wrap, which
destroys the distribution. holtburger follows acclient.
→ `crates/holtburger-dat/src/terrain_merge.rs:144-155`, with the divergence documented at
`:19-27`. Mask rotation: `while alpha_code != tcode { alpha_code *= 2; if alpha_code >= 16 { alpha_code -= 15 } }`
(`:273-283`), corner masks at base index 0 and side masks at base index 4 (`:262-268`).

## A24. Coordinate-hash **Family E** — weather day-group — `SkyDesc::CalcPresentDayGroup`, acclient.c:301664, expression @301686 — **(a) implemented**

```
t = current_day + days_per_year * current_year
H = (0x6A42FDB2 * t - 0x7541E9AE) mod 2^32            # 1782775218, 1967253934
g = floor(H * 2^-32 * day_groups.m_num)
if g >= m_num: g = 0
```
→ `crates/holtburger-world/src/sky.rs:576-585` (verbatim, `wrapping_mul`/`wrapping_sub`),
cached by `(day, year)` at `:548-559`. ⚠ `days_per_year` falls back to a hardcoded **360**
at `:572-574` — VL-4.

**Why Families A–E must be exact (`10` §4.3):** together they generate scenery placement,
texture selection, terrain triangulation, object scale and heading, and the weather
day-group — **all with zero replication traffic**. Client and server must agree bit for bit.

## A25. `Random::rand` — L'Ecuyer combined MRG + Bays–Durham shuffle (NR `ran2`) — acclient.c:105458, `Seed` 105431 — **(b) NEEDED (CRY-07)**

```
IM1 = 2147483563 = 0x7FFFFFAB     IM2 = 2147483399 = 0x7FFFFF07
IA1 =      40014 = 0x9C4E         IA2 =      40692 = 0x9EF4
IQ1 =      53668 = 0xD1A4         IQ2 =      52774 = 0xCE26
IR1 =      12211 = 0x2FB3         IR2 =       3791 = 0x0ECF
IMM1 = IM1 - 1   = 0x7FFFFFAA
NTAB = 32        NDIV = 1 + (IM1-1)/NTAB = 67108862 = 0x03FFFFFE
AM   = 1/IM1 = 4.656613057391769e-10
RNMX = 0.99999988                 # = 1 - 1.2e-7
```
State globals: `_seed` (`idum`) init 1 @44760; `_idum2` init `123456789` = `0x075BCD15`
@44761; `_iv[32]` @47272; `_iy` @47273 (`_iv` spans 0x836EA0–0x836F20 = 32 dwords,
confirming NTAB = 32).
```
Seed(seed):
    if seed == 0: seed = 1
    idum = _idum2 = seed
    for j in 39 down to 0:                  # NTAB+8 = 40 warm-up iterations
        k = idum / IQ1
        idum = IA1*idum - IM1*k;  if idum < 0: idum += IM1
        if j < 32: _iv[j] = idum            # only the last 32 fill the table
    _iy = _iv[0];  _seed = idum

rand():
    k  = _seed  / IQ1;  _seed  = IA1*_seed  - IM1*k;   if _seed  < 0: _seed  += IM1
    k2 = _idum2 / IQ2;  _idum2 = IA2*_idum2 - IM2*k2;  if _idum2 < 0: _idum2 += IM2
    j  = _iy / NDIV                          # 0..31
    _iy = _iv[j] - _idum2;  _iv[j] = _seed
    if _iy < 1: _iy += IMM1
    r = _iy * AM
    return (r > RNMX) ? RNMX : r
```
**Exact range `[AM, RNMX]` = `[4.66e-10, 0.99999988]` — never 0, never ≥ 1.** Period
≈ 2.3e18. Seeded once per process from `time(0)` @78040, right after `Timer::Init()`.
The decompiler folded `IA*(x − IQ*(x/IQ)) − IR*(x/IQ)` into `IA*x − IM*(x/IQ)`; both are
identical because `IA*IQ + IR == IM` for both generators.
```
RollDice(int lo, int hi)     = lo + trunc(rand() * (hi - lo + 1))   # 105510, uniform over [lo, hi]
RollDice(float lo, float hi) = rand() * (hi - lo) + lo              # 105532, HALF-OPEN, never reaches hi
```

## A26. Other PRNGs — **(c) N/A / (b) low priority**

| Generator | Where | Formula |
|---|---|---|
| CRT `rand()`/`srand()` | thunks @38792 | MSVCRT LCG; constants live in the CRT (`seed = seed*214013 + 2531011; return (seed >> 16) & 0x7FFF`) |
| `RandDouble(min,max)` | 667645 | `rand() * (1/32767) * (max-min) + min` |
| `RandInt(range)` | 667651 | `range * rand() / 0x8000` |
| `RandInt(range, exclude)` | 667657 | rejection loop over the above |

`srand` seeding sites: 373691 (`ClientNet` ctor, from `Timer::get_real_time()`), 383423
(`SoundManager::Init`, from `time(0)`), 477223 (`PerlinNoise::Init`, **`srand(0)`** —
deliberately deterministic). The last two fight each other, so `RandInt`/`RandDouble`
streams are **not reproducible across runs** — which is itself the argument against
chasing bit-parity on them.

## A27. `PerlinNoise` — acclient.c:477221 (`Init`) / 477246 (`Noise`) — **(b) NEEDED (CRY-08)**

```
Init():
    srand(0)                                  # deliberately fixed
    for i in 0..255:
        p[i]  = i
        g1[i] = (rand() % 512 - 256) * (1/256)      # -> [-1, 1)
    for i in 255 down to 1:                   # Fisher-Yates with a BIASED index
        j = rand() % 256; swap(p[i], p[j])
    copy g1[0..257] -> g1[256..], p[0..257] -> p[256..]   # wrap tails

Noise(x):
    if start: start = 0; Init()               # lazy one-shot
    t = x + 10000.0;  i = (uint8)(int)t;  f = t - (int)t
    a = f * g1[p[i]]
    b = (f - 1.0) * g1[p[(uint8)(i+1)]]
    return (b - a) * (f*f * (3.0 - 2.0*f)) + a          # ORIGINAL cubic smoothstep
```
Fully deterministic (`srand(0)`), so exactly reproducible **provided** the MSVC LCG above
is used verbatim.

## A28. `EnumeratedBitfield` — acclient.c:653554 (decode) / 653738 (encode) — **(b) low priority**

Enum value `N` maps to **bit `N−1`**; enum value 0 is reserved and round-trips to 0, i.e.
is unrepresentable. Width is 32 or 64 by template instantiation, so larger enum values
silently overflow. Maps **bit positions, not masks** (`07` §4).

## A29. Hash-table bucket derivation — **(c) N/A except the serialized header**

```
IntrusiveHashTable<K, V*, bAutoGrow>:  bucket = HashOf(key) % m_numBuckets
    HashOf: identity for unsigned long
            m_data1 ONLY (first dword) for Turbine_GUID          # acclient.c:65183
            memoised ELF hash for PStringBase<char>
            recomputed case-folded hash for CaseInsensitiveStringBase
    grow when 2*m_numBuckets < m_numElements+1                   # 88354
    sizes from a 23-entry table g_bucketSizesBegin (44365); lower_bound (65388); grow steps up (65410)
    in-place m_aInplaceBuckets[23]; heap only above 23 buckets   # 65395

LongHash<T> / HashBase<unsigned long>:   # THE classic AC object-ID hash
    bucket     = table_mask & (key ^ (key >> key_shift))    # key_shift = 8 everywhere
    table_mask = 2^ceil(log2(table_size)) - 1               # InternalInit, 290596

UI64Hash<T>:  same on a 64-bit key with key_shift = 16; the high dword of the fold is
              computed then DISCARDED -> effectively a 32-bit hash.
              Indicator::waitingBlobs_ uses table_size 128    # 377783

PackableHashTable: bucket = hash(key) % _table_size, _table_size from the serialized data
OldHashTable:      identity hash + modulo, default 32 buckets  # 472752
```
**On the wire (this part IS needed and IS implemented):** `PackableHashTable` packs its
header as `count | (table_size << 16)` — **count in the LOW 16 bits**
(acclient.c:297870/297935).
→ `crates/holtburger-dat/src/file_type/clothing.rs:17-18`;
`crates/holtburger-protocol/src/messages/ui_events/events.rs:268`.

## A30. Variable-length integer encodings (`10` §5.2) — **(a) implemented for the Archive varint; (c) N/A for the two DID/WCID forms**

```
Pack_AsWClassIDCompressed (667758):        # (c) N/A — no holtburger reader
    id <= 0x7FFF : u16 = id
    else         : u16 = (id >> 16) | 0x8000 ; u16 = id & 0xFFFF

Pack_AsDataIDOfKnownType (667689):         # (c) N/A — delta-coded against a class base
    d = id - firstID
    d <= 0x3FFF     : u16 = d
    d <= 0x3FFFFFFF : u16 = (d >> 16) | 0x8000 ; u16 = d & 0xFFFF
    else            : fail

SB_As32Bit_Compressed::Serialize (489676):  # (a) IMPLEMENTED — note the mixed endianness
    v <= 0x7F       : 1 byte  v
    v <= 0x3FFF     : 2 bytes (v>>8)|0x80, v&0xFF
    v <= 0x3FFFFFFF : 4 bytes (v>>24)|0xC0, (v>>16)&0xFF, then u16 LE = v & 0xFFFF

PStringBase::Pack (296374):                 # (a) IMPLEMENTED
    u16 len  — or 0xFFFF escape then u32 len — then raw bytes, then zero-pad to 4-byte boundary
    (the packed length is m_len - 1, i.e. strlen; the NUL is not written)
```
→ varint: `crates/holtburger-dat/src/utils.rs:5-18` (read) / `:20-44` (write, rejecting
`> 0x3FFF_FFFF`), round-tripped at `:571-586`. PString: `utils.rs:167-190`.

## A31. Run-length: `CMostlyConsecutiveIntSet::Serialize` — acclient.c:646696 (`Sort` 646607) — **(b) NEEDED (DAT-15)**

```
write: u32 count; then per run:
    runLen <= 2 : u32 = value & 0x7FFFFFFF          # single, sign bit CLEARED
    runLen >  2 : u32 = -(runLen); u32 = runStart   # start written UNMASKED
read:  v = (int32)word
    v >= 0 : if (v & 0x40000000) v |= 0x80000000    # sign-restore hack
    v <  0 : runLen = -v; start = next word; emit start, start+1, ...
       count capped at 0x186A0 (100,000)
```
Two genuine defects: the bit-30-implies-bit-31 restore is **lossy**, so values in
`0x40000000..0x7FFFFFFF` cannot round-trip; and run starts are written unmasked, so a run
beginning at a value with bit 31 set is misread as a negative run-length marker.

## A32. Presence-mask serialization — the dominant idiom (`10` §5.4) — **(a) implemented in the DAT lane**

```
u32 presenceMask            # bit N set => field N present
[u32 secondaryMask]         # its own presence gated by a bit in the first
<mandatory fields>
ALIGN_PTR(4)
for each optional field in FIXED order:
    if (mask & FIELD_BIT) read field at its natural width
ALIGN_PTR(4)
verify consumed <= declaredSize, else rewind and fail
```
Bit assignments are non-contiguous and **stream order does not match bit order**.
→ exemplar `crates/holtburger-dat/src/file_type/region.rs:1049-1055` (which documents the
maskmap-declaration-order trap and cites PhatSDK `RegionDesc.cpp:268-306`);
`env_cell.rs:123-136`; `landblock.rs:176`. The `consumed <= declaredSize` guard is
**(b) needed** — DAT-20.

## A33. zlib on DAT records (`10` §5.1) — **(b) NEEDED (DAT-04)**

```
[0..3]  uint32 uncompressedSize
[4..]   raw zlib deflate stream        # NO gzip wrapper, NO checksum
```
Level hardcoded **9** (acclient.c:647154). Guards asymmetric by one byte: decompress
requires payload `>= 0x10`, compress requires `> 0x10`. `destLen = payload - 4`, so a
record can never grow — `compress2` returning `Z_BUF_ERROR` simply means "store raw". The
compression flag is `BTEntry.comp_`, **bit 0** of the entry's first dword (acclient.h:28566).
`10` §6 explains the absence of any per-record checksum: zlib is linked in raw-deflate
form only, which is precisely why `crc32.obj` was never linked. **So a wrong
decompressor cannot be detected by the data itself.**
→ holtburger currently calls `decompress_lrs` (`crates/holtburger-dat/src/lib.rs:352`).

## A34. `PalSet::GetPaletteID` shade→index — acclient.c:470484/470493 — **(a) implemented**

```
idx = (u64)((num_pals - 0.000001) * shade)      # shade in [0, 1]
return palette_IDs[idx]
```
The `−0.000001` epsilon biases exact fractional boundaries to the **lower** bucket —
e.g. `count = 4`, `shade = 0.25` ⇒ idx 0, not 1. A plain `floor(shade * count)` picks the
higher bucket and is an off-by-one wrong-colour bug.
→ `apps/holtburger-web/ui/ac_palette_set.js:94-102`, with the retail citation and the
regression history at `:79-86`. **This closes wave0's PAL-04.**

## A35. `__security_cookie` — acclient.c:721590 — **(c) N/A**

```
c = FILETIME.low ^ FILETIME.high
c ^= GetCurrentProcessId() ^ GetCurrentThreadId() ^ GetTickCount()
QueryPerformanceCounter(&pc); c ^= pc.LowPart ^ pc.HighPart
__security_cookie = c ? c : 0xBB40E64E          # MSVC DEFAULT_SECURITY_COOKIE
```
Stock MSVC, unmodified. No web analogue.

---

# PART 3b — APPENDIX-B: measurements against the real shipped DATs

Method: a throwaway Python BTree walker over `~/ac_base_dats/*.dat` reading the header at
`0x140`, walking from `btreeRoot_` through 1716-byte nodes, following the 4-byte block
chain for every record. No holtburger code involved, so these numbers are independent of
the parsers they are used to judge. The `bake-base-dats-only` rule was respected —
read-only, no writes, nothing copied.

| Measurement | portal | cell_1 | local_English |
|---|---|---|---|
| `magic_` | `0x5442` | `0x5442` | `0x5442` |
| `iBlockSize_` | 1024 | 256 | 1024 |
| `data_set_lm` | 1 (PORTAL) | 2 (CELL) | 3 (LOCAL) |
| total BTree entries | 79,694 | 805,348 | 118 |
| entries with `comp_` set | **0** | **0** | **0** |
| `eng_pack_vnum` | 110 | 22 | 110 |
| **`game_pack_vnum`** | **0** | **0** | **0** |
| `master_map_id_m` | **`0x25000000`** | — | `0x00000000` |
| `ver_` histogram | 1×1, 2×57,422, 3×22,271 | 1×1, 2×572,482, 3×232,865 | 1×1, 2×7, 3×110 |

`client_highres.dat` is **not present** in `~/ac_base_dats/`.

**Findings these support**

1. **`07` §10's open question is answered.** `game_pack_vnum == 0` in every shipped DAT, so
   the live half of retail's pack-version gate (`gmCLCache::Init` sets
   `s_GameDataPackVer = 0`, acclient.c:435273-435275) **passes**, and the engine half is
   short-circuited by `s_EngDataPackVer == −1` exactly as the doc reasons. Feed back into
   the deep dive.
2. **DAT-04 is latent, not live.** Zero compressed entries anywhere, so the
   `decompress_lrs`-vs-zlib mismatch is unreachable on a pristine install.
3. **The `0xFFFF0001` iteration record is the unique `ver_ == 1` entry** in each DAT —
   independent confirmation of `07` §2's "that record's version must be exactly 1".
4. **DAT-12's shortcut currently holds**: `master_map_id_m` really is `0x25000000`, and the
   22 shipped DIDMapper records are exactly `0x25000000`–`0x25000015`.
5. **DAT-03 matters.** `ver_` is mixed *within* nearly every type, so no parser can be
   correct for both halves by luck:

| prefix | type | v2 | v3 |
|---|---|---|---|
| 0x01 | GfxObj | 10,395 | 4,923 |
| 0x02 | Setup | 3,791 | 2,144 |
| 0x03 | Animation | 1,036 | 1,030 |
| 0x04 | Palette | 3,823 | 698 |
| 0x05 | SurfaceTexture | 5,258 | 1,963 |
| 0x06 | RenderSurface | 15,355 | 5,329 |
| 0x08 | Surface | 4,513 | 1,639 |
| 0x09 | MotionTable | 244 | 192 |
| 0x0A | Wave | 720 | 66 |
| 0x0D | **Environment** | 702 | 70 |
| 0x0F | PalSet | 2,351 | 330 |
| 0x10 | ClothingTable | 576 | 1,341 |
| 0x11 | GfxObjDegradeInfo | 3,564 | 567 |
| 0x12 | Scene | 124 | 55 |
| 0x20 | SoundTable | 37 | 153 |
| 0x32 | ParticleEmitter | 1,494 | 557 |
| 0x33 | PhysicsScript | 3,257 | 991 |
| 0x34 | PhysicsScriptTable | 15 | 149 |
| 0x21 | UILayout (local) | 0 | 101 |
| 0x23 | StringTable (local) | 6 | 9 |

Singletons and low-count types: `0x13` Region 1, `0x14` Keymap 2, `0x15` RenderTexture 2,
`0x16`/`0x17`/`0x18` 1 each, `0x22` EnumMapper 40, `0x25` DIDMapper 22, `0x26` ActionMap 1,
`0x27` DualDIDMapper 5, `0x30` CombatTable 71, `0x31` String 28, `0x39` MasterProperty 1,
`0x40` Font 49, `0x41` StringState 1 (local), `0x78` DBProperties 2, `0x0E` tables 14.
**Absent entirely:** `0x19` RenderMesh, `0x24`, `0x38` MutateFilter, `0x42`.
→ `0x24` absence is why DAT-19 is safe; `0x0D`'s 772 records are DAT-02's blast radius.

6. **`07` §11's "LandBlock records are exactly 248 bytes" is wrong for the shipped DATs.**
   All **65,025** `0xLLLLFFFF` records measure **252 bytes**. Sample `0x1FF8FFFF`:
   dword0 = `0x1FF8FFFF` (the DID), dword1 = `0x00000000` (`has_objects`), trailing pad
   `00000000`. `4 + 4 + 81×2 + 81 + 1 = 252`. holtburger's `landblock.rs:52-63` is right;
   `CLandBlockStruct::pack_size()`'s 244 evidently excludes the `has_objects` dword.
   Feed back into the deep dive.
7. **`CLandBlockInfo` field order is pinned by the minimum record size.** The smallest
   `0xLLLLFFFE` record is **16 bytes** (2,084 of them) = `id(4) + num_cells(4) +
   num_objects(4) + num_buildings(2) + pack_mask(2)`, which is exactly
   `crates/holtburger-dat/src/landblock.rs:163-178`. Consistent with `07` §11's
   `pack_size = 32*num_objects + 12` (three fixed dwords) plus the packed
   buildings/restriction dword. Next sizes 28 (649), 48 (189), 80 (140), 112 (99) —
   i.e. +32 per `Stab`, confirming `Stab` = `u32 id` + 28-byte `Frame`.
8. **`SoundTable` nesting is depth 1 in practice.** Parsing all **190** `0x20……` records
   with the *recursive* model from `SoundTableData::Pack`: max depth **1**, zero nodes with
   grandchildren, and every record consumed **exactly**. So `sound_table.rs`'s flattening
   is correct for shipped data and DAT-13 is a hardening/naming task, not a bug.
9. **DAT-02's blast radius is real.** Simulating `EnvCell::unpack`'s field sequence over all
   772 `0x0D……` Environment records: ~**564 would parse to completion** and ~208 would
   error. (My `CellPortal` and `Stab` sizes are approximations, so treat the split as
   indicative — the point is that failure is *not* reliable, so `if let Ok(...)` does not
   protect the prune path.) The true header of `0x0D000002` is
   `id = 0x0D000002, num_cell_structs = 1` — nothing like an `EnvCell`.

---

# PART 4 — ANTI-TASKS

Retail behaviours a browser/HTTP stack already does better, or that the decomp itself
shows to be dead. **Do not port these.**

### AT-1 — FIFO request ordering
`07` §7: "There is no priority field — ordering is FIFO." holtburger deliberately has an
**urgent lane** (`apps/holtburger-web/src/decode_admission.rs:23-30`), added because
"FIFO queuing starved interior loads for *minutes*". Retail could afford FIFO because a
local disk seek is ~10 ms and the whole working set was on that disk; over HTTP with
hundreds of ms of latency and a cold CDN, FIFO is a starvation machine. Keep the lane.

### AT-2 — Per-type object-count freelist budgets
`07` §8: GfxObj 100/200, Setup 25/100, Animation 20/80, Palette 60/100, and "there is no
global byte budget". That is the right unit for a 32-bit process with a 2 GB ceiling and
fixed-size DBObjs; it is the wrong unit for a browser, where the constraint is bytes in a
`WebAssembly.Memory` and entry sizes vary by 250× (a 4 KB DXT record decodes to 1 MiB —
`decode_admission.rs:17-22`). Keep the byte budget; DAT-08 asks only for **per-class
floors within it**, not for count limits.

### AT-3 — The transactional BTree, block allocator, and on-disk LRU
`07` §1 (journal at offset 256, redo-forward `RecoverTransaction`), §9
(`CheckRoom` + 51-block slack + 1 MiB `ExpandFile`, `Store_Data`/`DeleteBlocks` free-chain
splicing, `Try_Delete_Oldest`). All of this exists for exactly one reason: **live
server-push patching (DDD) writes into the same files the client is reading.** holtburger
never writes to its asset store at runtime; content ships as immutable, content-addressed
HTTP shards, and updates are a redeploy. Implementing a write-ahead log for a read-only
store would be pure liability. DAT-16 deliberately asks only for a **read-side refusal**,
not replay.

### AT-4 — The 100-slot BTree node cache
`07` §2: root pinned plus a 100-slot `BTMemNode` cache (`LoadTree` allocating
`0x2A624` = 4 + 100×1736). This is a working-set optimisation for a directory too large to
hold resident on a 1999 machine. holtburger reads the entire directory into a
`HashMap<u32, DatFileEntry>` at open (`crates/holtburger-dat/src/lib.rs:288-306`) — 805k
cell entries × 24 B is ~19 MB on a native bake box, and the wasm path does not read DATs
at all. A node cache in front of a fully-resident index is strictly overhead.

### AT-5 — Object recycling (`GetFreeObj` / `m_bRecycle`)
`07` §8 proves this is **dead code in the shipped client**: `m_bRecycle` is assigned 0 at
all 65 registration sites (50 in `MasterDBMap::InitDBTypeDef_Internal` 92064-93422, 15 in
`gmMasterDBMap::InitDBTypeDef_Internal` 514938-515316) plus two constructors and two bulk
copies, with **zero** nonzero assignments anywhere; the alternate decompilation agrees; and
the sibling `m_bShrink` is set to 1 at 63 sites, so the 0 is deliberate. Turbine turned it
off. Do not resurrect a pooling scheme on that authority.

### AT-6 — Diffie-Hellman
`10` §2.5 establishes on four independent grounds that no exchange is ever computed
(`PortalDH` has one member; the private exponent is the literal 10; `vlong` has no
division/modulo so modexp is impossible; `NetKeyExch` is constructed and only ever
destroyed). The parameters are vestigial. Porting them would add ceremony with no
cryptographic effect — and ACE, our actual peer, does not implement it either.

### AT-7 — The 32-bit-key-space ISAAC seeding, treated as a security property
`10` §2.3: `randrsl[]` is zeroed before `randinit(true)`, so `randmem[]` is a fixed
universal table and the seed enters through `randa/randb/randc` only — 32 bits of
effective key, with both seeds transmitted in the clear (§2.6). We **must** reproduce it
bit-for-bit for interoperability (and do — A8), but nobody should be tempted to "fix" it,
nor to treat the encrypted checksum as authentication. `10` §1.2 is explicit: "This is
error detection, not a MAC."

### AT-8 — `EnumeratedBitfield`'s width and the `CMostlyConsecutiveIntSet` encoding defects
`10` §4.4: enum 0 is unrepresentable and values beyond the 32/64-bit instantiation
silently overflow. `10` §5.3: values in `0x40000000..0x7FFFFFFF` cannot round-trip, and a
run starting at a bit-31 value is misread as a run-length marker. If holtburger ever needs
to **write** either encoding, do not reproduce the defects — reproduce only the *reader*
(for interop) and pick a lossless writer, documenting the divergence.

### AT-9 — The unreachable-last-sound-variant bug (decide, don't inherit)
`10` §4.2b: because `Random::rand` is half-open, `(N−1) * roll` never reaches `N−1`, so the
last variant in every multi-variant SoundTable node is unreachable. Listed here because it
would be easy to port CRY-07 and inherit the bug silently. Reproduce it only as a
deliberate parity choice, with a comment.

---

# PART 5 — OPEN QUESTIONS

1. **DAT-09's client/server consistency question is the blocker, not the math.** ACE's
   `Scenery.cs:59` shares the loop-invariant noise, and ACE's scenery participates in
   *server-side* collision. Fixing only the client would make our tree positions disagree
   with the server's. Does the fix land in both (patching `~/ace-server` violates
   `keep-ACE-vanilla`), only in the bake behind `BakeMode::Strict` with a documented
   divergence, or upstream in ACE first? **This needs a decision before the code.**
2. **Is anything actually version-sensitive in our parser set (DAT-03b)?** The measurement
   proves `ver_` is mixed per type, but not that any *field* we read is gated on it. The
   cheap experiment: for each type, parse→pack→byte-compare every record and see whether
   v2 and v3 records both round-trip under the single current layout. Types that do are
   provably insensitive and can be marked so; types that fail identify exactly where a
   version arg is needed. I did not run it (needs a build).
3. **Which types other than RenderMaterial and UI gate on a token?** The doc names only
   `'RMVT'` (129851) and `'UIL '` (691996, 692624). A sweep of `GetVersionByToken` call
   sites in acclient.c would give the complete list and bound DAT-03b's scope. Not done.
4. **Are the three shipped DATs' transaction journals clear?** DAT-16 assumes yes. I read
   the header at `0x140` but did not dump offset 256. One 64-byte read answers it, and if
   any journal is non-empty that is a much more urgent finding than the task implies.
5. **Does `EnvCell::unpack` actually succeed on Environment records at runtime (DAT-02)?**
   My ~564/772 figure comes from a Python simulation with guessed `CellPortal`/`Stab`
   widths. A one-line Rust test would replace an estimate with a fact, and determines
   whether the shipped HBAs already carry corrupted `0x0D` records — i.e. whether this is
   a latent bug or a live one. **Highest-value cheap experiment in this report.**
6. **Have the shipped HBAs been baked with a pruning profile?** DAT-02's severity depends
   on it. `dist` is a symlink to `/mnt/wbterminal2/holtburger-dist`; `dist/_health.json`
   and the `bake-source.sha256` sidecar should record the profile. I did not check
   (the mount's state is a live-environment question, not a source-reading one).
7. **Does `spellbase_string_hash` ever produce a key that trips the `> 198` fixup
   (CRY-03)?** My prior is no — the sign extension and the Windows-1252 round-trip are both
   correct — but that is a prediction. One test run over the shipped SpellTable settles it
   and either deletes the branch or exposes a hash divergence.
8. **What is `days_per_year` in the shipped Region (VL-4)?** `sky.rs:572-574` hardcodes 360
   as a fallback that the *cached* path actually uses. If the real `GameTime.days_per_year`
   is 360 this is harmless; if not, every cached day-group lookup is wrong. One field read
   from `0x13000000` answers it.
9. **Does anything consume `EnumeratedBitfield`-encoded DAT fields?** If some record we
   parse stores a bitfield produced by `EnumeratedBitfield::ToFileNode`, our reader is
   off by one *and* silently drops enum 0. I found no such consumer, but the sweep was
   name-based (`10` §Provenance's "absence of evidence" warning applies).
10. **Was the rotate-4 `string_hash` ever a retail hash, in any build?** It has no
    counterpart in the 2013 decompilation (`>> 28` yields 4 hits, none a hash) and none of
    the rotate intrinsics appear. Its provenance is DatReaderWriter/Chorizite. The
    `utils.rs:248-262` comment claiming "this split is real in retail acclient.exe" should
    either be substantiated from the 2015 build / the PDB or softened. Harmless either
    way — it round-trips against WB.Terminal — but the comment currently misleads.
11. **Should the wasm decode path get its own time-box, or should the JS scheduler simply
    not call oversized exports (DAT-21)?** Retail solved it with one 25 ms drain because
    completion was its own step. holtburger's decode *is* the call. Whether the answer is
    an admission bound, chunked exports, or moving more work into the bake worker is a
    design question the measurement in VL-1 should decide.
12. **`SetupModel` static BSP staging is default-ON via `?buildingBsp02`, gated because a
    multi-part setup may include a swinging door leaf that "a static BSP can't open"
    (`apps/holtburger-web/src/lib.rs:15630-15636`).** Retail's answer was that the door
    leaf is a *separately placed object*, not a part — so the part-level skip may be
    unnecessary. Worth confirming against `CLandBlockInfo`'s `BuildInfo`/`CBldPortal`
    structure, because the live report mentions running through **doors** as well as trees,
    and that is a different mechanism from DAT-01.

---

# PART 6 — VERIFY-LIVE register

Claims where holtburger's source reads correct but the behaviour is unobserved. Each names
the check that would settle it.

| ID | Claim | Source cited | Expected live | Check |
|---|---|---|---|---|
| VL-1 | The per-frame budget actually bounds decode work | `scene3d/loop.js:1542` `RP3_DEFAULT_BUDGET_MS = 9`, overrun test `:1631` | 99th-percentile frame time near budget during a town stream-in | `?renderDiag=on` long-task census across a `@telepoi` town entry; fresh `--user-data-dir`, `renderer.info.autoReset = false`, wait for `terrainBakedLbs.size` plateau |
| VL-2 | The decode admission gate shapes anything | `src/decode_admission.rs:33-37` ships `new(usize::MAX, usize::MAX, 0)` | With the default gate, **zero** waiters ever enqueue — i.e. none of the shaping logic runs | `dat_decode_diag` admission counters (`lib.rs:10060`, `:10071` read `adm.max_bytes` / `effective_max_bytes`); assert `queued == 0` today, then re-check after a real `set_decode_admission` |
| VL-3 | Surface-cache entries drain rather than pin | `lib.rs:9200-9218`, `None => break` at `:9216` | pinned count → ~0 when idle | wave0 PAL-01/PAL-02 (`surfacePinnedEntries` + a soak assertion in `__diag.runAll`) |
| VL-4 | `calc_present_day_group` gets the real `days_per_year` | `crates/holtburger-world/src/sky.rs:572-574` hardcodes 360 on the cached path | day group matches the server's for the current game day | read `GameTime.days_per_year` from `0x13000000`; compare `__diag` weather/`dayGroupIndex` against ACE's own day across a date boundary (the crate already has a boundary test at `sky.rs:2072-2119`) |
| VL-5 | Outdoor statics are actually collidable in the live client | feed `lib.rs:15282`, overlap bake `:48985-48996`, reader `scene.rs:1602-1607` | walking into a building wall stops the player | headless `?nullRender=1&autoLogin=1`, `@teleloc` beside a known building, drive forward, assert the pose stops; then the same test at a tree — which should **fail**, confirming DAT-01's scope |
| VL-6 | The eviction path fires at all under real churn | `lib.rs:9200` (evict only inside `insert`) | `surfaceEvictions` > 0 after crossing several dense landblocks | `dat_decode_diag` before/after a multi-LB `@teleloc` sweep; if evictions stay 0 while `surfaceCacheBytes` is at budget, something upstream is refusing inserts instead |
| VL-7 | Scenery placement matches the server's view | Families A/C (`noise.rs`), DAT-09 | our baked scenery positions equal ACE's `Scenery.BuildScenery` output for the same LB | `apps/holtburger-tools/src/bin/scenery-cross-check.rs` against ACE for a spread of LBs — and note it will start **failing by design** once DAT-09 lands, which is the signal, not a regression |

---

## Cross-references to sibling mining reports

- **`wave0-palette-leak-patch.md`** — PAL-01/PAL-02/PAL-03 own the pinned-entry
  instrumentation on `ByteBudgetLru`; not duplicated here. **PAL-04 is now closed**: the
  `PalSet::GetPaletteID` shade→index formula *is* implemented, at
  `apps/holtburger-web/ui/ac_palette_set.js:94-102`, epsilon and all (A34).
- **`wave1-B-networking-combat.md`** — NET-17 owns the ISAAC seqID-keyed key store;
  CRY-10 adds only two verified retail details and confirms the send side is already
  correct. NET-22 owns the DDD interrogation response, which is why DAT-15 is latent.
  NET-15 owns the 64-bit blobID; `10` §2.8's bit layout is transcribed in the ledger so
  that fix needs no crypto work.
- **`wave1-A-physics-objectmodel.md`** — the `CTransition` port's cell/BSP machinery is the
  *consumer* of DAT-01's missing feed. DAT-01 is deliberately filed as a **data-path**
  task, not a physics task: the resolver is built and correct; nothing hands it trees.
