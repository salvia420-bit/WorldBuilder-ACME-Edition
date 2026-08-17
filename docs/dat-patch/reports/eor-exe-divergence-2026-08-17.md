# EOR-vs-box acclient divergence hunt (H8) — 2026-08-17

Static analysis only. No exe was executed. Scratch: `/mnt/wbterminal2/eor-divergence-scratch/`
(helper scripts `dis.sh`, `find.py`, `sym.py`, `cmp.py`, `bulk2.py`; normalized disassembly
`box.n2`/`eor.n2` + `bulk2.diff` + `hunks.txt`).

Conventions used throughout: **file_offset = VA − 0x400000** for both builds.
Map (`yonneh-acclient.map`) segment `0001:xxxxxxxx` → **VA = 0x401000 + xxxxxxxx**, and the
map matches the **box** build (4,837,376). Regional EOR↔box drift is *not* constant — it is
+0xC00 in the Motion/Anim region, +0xFA0 in the DiskController region, +0x300 in the
SmartBuffer region, 0x000 in the AsyncCache/Archive region. **Never carry a delta across
regions** (this is exactly what produced the mis-naming corrected in §1).

---

## 0. Headline

1. **The crash path was mis-named.** It is **`MotionData::UnPack` → `AnimData::UnPack`**,
   not `CAnimHook::UnPackHook` → `SoundTweakedHook::UnPack`. Byte-proven (§1).
   Both functions are **instruction-identical between the two builds** (AnimData::UnPack is
   byte-identical).
2. **The size-underflow mechanism is now named and verified**: `Archive::GetSizeLeft()` is an
   **unsigned `bufferSize − usedOffset` with no floor** (box `0x40A590`), and
   `SerializeUsingPackDBObj::Serialize` (box `0x4F7490`) feeds its result straight into
   `PackObj::UnPack(cursor, size)`. Once `used > size`, every downstream `size >= N` guard
   passes and the whole record tree parses off the end of the buffer. `0xFC59BCE8` = −61,613,336.
   **No clamp exists anywhere in the chain** (§2).
3. **Everything I could reach in the compressed-record chain is instruction-identical across
   the two builds**: `DiskController::Decompress`, `DiskController::LoadDataEx`,
   `SmartBuffer::ReconfigureAllocation`, `GrowBuffer::GetGoodSize`, `GrowBuffer::GrowExact`,
   `MotionData::UnPack`, `AnimData::UnPack` — plus the previously-verified
   `SerializeFromCachePack` and both version-context callees. **No size-class / grow-threshold
   constant differs.** (§3, §4)
4. **The two exes are genuinely different compiles**, not the same build ±43 bytes: a whole-
   `.text` normalized-instruction diff yields **1,249 divergent hunks** (§5). "The identical
   logical patch in identical code" is therefore only true for the functions explicitly
   verified above; it is *not* a safe global premise.
5. **A better patch exists and is specified** (§6): a 9-byte in-place patch in
   `DiskController::LoadDataEx` that restores the real BTEntry version word into
   `buf_out->m_iVersion` *after* `Decompress` zeroes it — so `SerializeFromCachePack`'s
   `m_iVersion != 0` guard is satisfied **legitimately** and the shipped `dat-decompress`
   NOP can be dropped entirely. Unique signature verified in **both** builds; the space it
   uses is a provably-idempotent duplicate `SmartBuffer::ReleaseMasterBuffer` call. UNTESTED.

---

## 1. The crash path, correctly named (HIGH confidence — byte evidence)

Reported fault EIP **EOR 0x00526A7E**, inside a function starting at **EOR 0x00526A50**:

```
526a50: 83 7c 24 08 10   cmp  DWORD PTR [esp+0x8],0x10     ; size guard >= 0x10
526a55: 73 05            jae  0x526a5c
526a57: 33 c0            xor  eax,eax
526a59: c2 08 00         ret  0x8
526a5c: 8b 44 24 04      mov  eax,DWORD PTR [esp+0x4]      ; void** cursor
...
526a7e: 8b 12            mov  edx,DWORD PTR [edx]          ; <-- FAULT (3rd dword)
526a80: 89 51 0c         mov  DWORD PTR [ecx+0xc],edx
526a92: b8 01 00 00 00   mov  eax,0x1
526a98: c2 08 00         ret  0x8
```

The first 0x30 bytes of that function
(`837c240810730533c0c208008b4424048b1083c204568b72fc891089710...`) occur **exactly once in
each exe**: EOR `0x526A50`, box `0x525E50`. Map lookup of the box address:

> `0x525e50 → AnimData::UnPack(void*&, uint) +0x0`

Its caller: the reported return address **EOR 0x00527229** sits in a 20-byte-stride loop whose
48-byte signature (`895f148a471033ed84c0762033db8b57148b04138d0c138b542424 5256 ff5010 …`) is
likewise unique per exe: EOR `0x527209`, box `0x526609`. Map lookup:

> `0x526609 → MotionData::UnPack(void*&, uint) +0x99`

Corroborating structure (box `0x5265D7`–`0x526633`): count byte at `[this+0x10]`, one
allocation of `count*0x14 + 4`, `vector constructor iterator(array, 0x14, count, 0x5268e0)`
(the `0x401000` callee **is** `` `vector constructor iterator' `` in the map), array pointer
stored at `[this+0x14]`, then `call [vptr+0x10]` per element — `PackObj::UnPack` slot. That
is `MotionData { …, byte numAnims@+0x10, AnimData* anims@+0x14 }` with
`sizeof(AnimData) == 0x14` (vptr + 4 dwords, matching AnimData::UnPack writing `this+0x4`,
`+0x8`, `+0xC`, `+0x10`).

**Why the brief said CAnimHook::UnPackHook:** box `0x5271D0` really *is*
`CAnimHook::UnPackHook`, and box `0x527229` really is a `call [eax+0x18]` return site inside
it — but that is the **box** address space. In the EOR build the same VA lands 0xC00 later in
the image, inside `MotionData::UnPack`. Coincidence, not identity.

### Cross-build verification of the chain
| function | box VA | EOR VA | result |
|---|---|---|---|
| `AnimData::UnPack` | 0x525E50 | 0x526A50 | **byte-identical** (0x50 bytes) |
| `MotionData::UnPack` | 0x526570 | 0x527170 | **instruction-identical** (162 instrs, 0 diffs; only relocated operands differ) |

So **the crash-site code is not the divergence.**

### Where the size is threaded (and where it is *not* clamped)
`MotionData::UnPack` reads its `size` parameter once (`mov edx,[esp+0x24]`) and passes the
**same, undecremented value** to every `AnimData::UnPack` (box `0x526620`–`0x526633`).
`AnimData::UnPack` only checks `size >= 0x10`. `MotionData::UnPack`'s own optional 3-dword
block is guarded by `cmp [esp+0x24],0xC / jb` (box `0x526643`). **There is no running
remaining-size counter in this family at all** — so a poisoned `size` cannot be caught here;
it must be poisoned before `PackObj::UnPack` is entered.

---

## 2. Where the underflow is manufactured (HIGH confidence)

`SerializeFromCachePack` → `DBObj::Serialize` → `SerializeUsingPackDBObj::Serialize(Archive&)`
(box `0x4F7490`, map-named). Unpack branch, box `0x4F74E6`:

```
4f74e6: 55                push ebp
4f74e9: e8 .. call 0x40a590   ; Archive::GetSizeLeft()   -> edi   == the `size` argument
4f74f3: e8 .. call 0x40a570   ; Archive::GetSizeUsed()
4f74fb: e8 .. call 0x40a910   ; Archive::PeekBytes(used, ...)      -> ebp == the cursor
4f7512: ff 52 10          call DWORD PTR [edx+0x10]  ; PackObj::UnPack(&cursor, size=edi)
4f7519: 8b 4c 24 18       mov  ecx,DWORD PTR [esp+0x18]   ; cursor after
4f751d: 2b cd             sub  ecx,ebp                    ; bytes consumed
4f7522: e8 .. call 0x40a990   ; Archive::GetBytes(consumed)  -> used += consumed
```

and the size source itself, box `0x40A590` (`Archive::GetSizeLeft`):

```
40a590: 56             push esi
40a591: 8b f1          mov  esi,ecx
40a593: 8d 4e 0c       lea  ecx,[esi+0xc]
40a596: e8 15 c5 ff ff call 0x406ab0        ; SmartBuffer::GetSize()
40a59b: 2b 46 18       sub  eax,DWORD PTR [esi+0x18]   ; - used   <-- UNSIGNED, NO FLOOR
40a59e: 5e             pop  esi
40a59f: c3             ret
```

`Archive::GetSizeUsed` is literally `mov eax,[ecx+0x18]; ret` (box `0x40A570`).
`Archive::GetBytes` (box `0x40A990`) does `add [esi+0x18], edi` with **no bound check** against
the buffer size — it only propagates `PeekBytes`'s success/failure.

**Consequence:** the observed `size = 0xFC59BCE8` means `used − bufferSize = 61,613,336` at the
moment `PackObj::UnPack` was entered. Two ways to get there, both consistent with the evidence:
(a) the `Cache_Pack_t`'s `SmartBuffer` reports a size much smaller than what the record's own
length fields claim (a short/failed inflate, or a buffer whose master was released/reallocated
under it), or (b) an earlier nested unpack in the same Archive consumed a bogus 61 MB.
`Archive::GetBytes` can absorb (b) silently because `PeekBytes` failing does **not** stop the
caller from advancing on the next call.

This is the single most valuable structural finding here for any future defence: a **one-
instruction hardening** (clamp `GetSizeLeft` to 0 when `used > size`) would convert every
future instance of this bug class from a wild heap walk into a clean parse failure. Not
proposed as a shipping patch (it changes engine-wide semantics), but it is the cheapest
possible crash-to-graceful-failure conversion if one is ever wanted.

---

## 3. Version-0 semantics (MEDIUM confidence — mechanism named, impact not closed)

`AsyncCache::SerializeFromCachePack`, box `0x417810` (the patch site is `0x417878`, `74 71`):

```
417855: 8b 73 04          mov  esi,DWORD PTR [ebx+0x4]   ; pack.m_iVersion
41786e: e8 .. call 0x41a2b0     ; version class: cmp [esp+4],2 / sbb eax,eax / add eax,2
417876: 3b f7             cmp  esi,edi                    ; edi == 0
417878: 74 71             je   reject                     ; <-- SHIPPED PATCH NOPs THIS
41787a: 3b c7             cmp  eax,edi
41787c: 74 6d             je   reject
41787f: c7 44 24 10 5c 53 79 00   mov [esp+0x10],0x79535c ; ArchiveInitializer field
417887: e8 .. call 0x41a4d0     ; version-context find-or-create, key = raw version
41789d: 89 44 24 18       mov  DWORD PTR [esp+0x18],eax   ; ctx -> ArchiveInitializer
4178a1: e8 .. call 0x40acc0     ; Archive::InitForUnpacking(ArchiveInitializer&, SmartBuffer&)
4178bf: ff 50 1c          call DWORD PTR [eax+0x1c]       ; DBObj::Serialize(Archive&)
```

The version-class callee is exactly `size < 2 ? 1 : 2`:
`83 7c 24 04 02 / 1b c0 / 83 c0 02 / c3` (box `0x41A2B0`). **So version 0 yields class 1, while
a normal dat record (version 2 or 3) yields class 2** — a real semantic difference that the
NOP-the-guard patch silently introduces.

The lookup at box `0x41A4D0` is a `HashTable<ulong,ArchiveVersionRow,0>` **find-or-create**:
`div ds:0x81779C` (modulus), bucket base `ds:0x817794`, and on miss it allocates and inserts
(helper `0x41A430`, table `0x817730`, row size `8`), re-probes (box `0x41A55E`–`0x41A587`),
then calls `0x410240` with `('Core' = 0x436F7265, class)` — i.e. a fresh
`ArchiveVersionRow` keyed on version **0** with class **1** is minted on first use and cached
for the process lifetime. Box mirror addresses of the EOR sites given in the brief:
EOR `0x41A824/0x41A8A9` → box `0x41A4E4/0x41A569`; EOR `ds:0x818794/0x81879C` →
box `ds:0x817794/0x81779C` (image-wide +0x1000 data drift, 0x000 code drift in this region).

**What I could NOT close in the time box:** whether the class-1 context makes any *dat* DBObj
parse a different field layout. The evidence points to "no, for pack-based records":
`SerializeUsingPackDBObj::Serialize` hands `PackObj::UnPack` a raw `(cursor, size)` and never
consults the version context — 0x06 RenderSurface, 0x33 PhysicsScript and 0x03 Animation all
travel that path. That is consistent with r6/r7 rendering correctly for a whole tour on the box
build. It is **not** consistent-or-inconsistent with the EOR crash, because I found no code
difference in that path either. Treat "version-0 changes a parsed layout" as **not disproven,
not demonstrated**; §6 removes the question entirely by making the version correct.

---

## 4. Size-scaled paths (per the mid-task redirect) — all identical (HIGH confidence)

Arms 3+4 (compressed retail, ±compaction) being stable narrows the r7-side factor to
**large** decompressed records. Every size-scaled function on that path was compared
instruction-by-instruction with `cmp.py` (address operands normalized):

| function | box VA | EOR VA | delta | result |
|---|---|---|---|---|
| `DiskController::Decompress` | 0x670A80 | 0x671A20 | +0xFA0 | **identical** |
| `DiskController::LoadDataEx` | 0x670BC0 | 0x671B60 | +0xFA0 | **identical** (122 instrs, 0 diffs) |
| `SmartBuffer::ReconfigureAllocation` | 0x4071B0 | 0x4074B0 | +0x300 | **identical** (0x9E bytes) |
| `GrowBuffer::GetGoodSize` | 0x406B20 | 0x406E20 | +0x300 | **identical** (43 instrs) |
| `GrowBuffer::GrowExact` | 0x406F50 | 0x407250 | +0x300 | **identical** (94 instrs) |

`GrowBuffer::GetGoodSize` is the size-class oracle, and its constants are **the same in both
builds** (box `0x406B20`):

```
cmp esi,0x40000 ; jbe .small           ; > 256 KiB: round up to a 256 KiB multiple
lea eax,[esi+0x3ffff] ; and ecx,0x3ffff ; sub eax,ecx
.small: cmp esi,0x10 ; jb -> 0x10       ; floor 16 B
bsr eax,size ; edx = 1<<bsr             ; else power-of-two bucket
cmp edx,0x1800 ; jbe keep ; lea eax,[edx+0xc00]   ; >6 KiB: +50% (1.5x buckets)
cmp eax,esi ; jae done ; add eax,edx
```

So **the "differing size-class boundary" hypothesis is refuted for the SmartBuffer/GrowBuffer
allocator**. A 4× texture (r7 inflates up to ~8.5 MB, retail's own maximum) takes the same
`0x40000`-granular path in both exes.

Two facts worth carrying forward from the `Decompress` read (both builds):
- `Decompress` *reuses the incoming `in` argument home slot* (`[esp+0x2c]` at box `0x670AF4`,
  i.e. `R+4`) as zlib's `destLen` in/out variable. **`in` is dead after that point** — this
  kills the "just copy `in->m_iVersion` in the tail of Decompress" idea (§6 alternative B).
- `Decompress` sizes the destination as `ReconfigureAllocation(uncompressedSize + 4, 1)` where
  `uncompressedSize` is the dword at payload offset +4, then hands zlib `dest = GetBuffer()+4`
  and `srcLen = storedSize − 8`. Bounded and correct, as H3 already concluded.

---

## 5. Whole-`.text` divergence census (context, not a lead)

`bulk2.py` disassembles `.text` of both exes, normalizes every operand in the image range
`[0x400000,0x900000)` to `A` (leaving all small immediates and thresholds visible), and diffs
the instruction streams: **box 1,467,174 vs EOR 1,468,465 instructions, 1,249 hunks**
(`bulk2.diff`, symbolized in `hunks.txt`).

Spot-checking hunks shows whole small functions **present in one build and absent in the other**
(e.g. box lines 32374 / 36185: an identical 29-instruction `PStringBase`-ish ctor thunk emitted
twice in box, once in EOR; EOR line 440648: a 24-instruction helper EOR has and box does not) —
i.e. different inlining and different COMDAT folding. **These are two separate compiles of
(near-)identical source, not one build with 43 bytes changed.** That is the correct mental model
going forward, and it means the H8 premise "identical patched code misbehaves" is only
established for the specific functions verified in §1/§4 and in the earlier session.

I did **not** find a divergence inside the compressed-record chain. Given the time box I did not
extend the census to `.rdata`/`.data` static tables (§7).

---

## 6. Candidate patch: `dat-decompress-version` (UNTESTED, `enabled=False`)

### Rationale
`DiskController::LoadDataEx` (box `0x670BC0`) already puts the **correct** version into the
destination pack before calling Decompress:

```
670c0c: 0f b7 4d 02   movzx ecx,WORD PTR [ebp+0x2]   ; BTEntry version word (offset 2)
670c29: 89 4e 04      mov   DWORD PTR [esi+0x4],ecx  ; buf_out->m_iVersion = version
```
(`ebp` = the local copy of the BTEntry, filled by `rep movsd` of 6 dwords at `0x670C04`;
`esi` = `buf_out`, loaded at `0x670C10`.)

The compressed branch then does:

```
670c95: f6 45 00 01   test BYTE PTR [ebp+0x0],0x1     ; FLAG_COMPRESSED = bit 0
670caa: e8 ..         call 0x417350                   ; Cache_Pack_t ctor (temp @ esp+0x1c)
670cb9: ff 90 88 00 00 00  call DWORD PTR [eax+0x88]  ; virtual Decompress(in=buf_out, out=temp)
670cca: e8 ..         call 0x4173f0                   ; Cache_Pack_t::operator=(temp) -> buf_out
```

and `Decompress`'s success tail unconditionally writes zeros:

```
670b24: 8b 44 24 24   mov eax,DWORD PTR [esp+0x24]    ; out
670b28: 8b 54 24 08   mov edx,DWORD PTR [esp+0x8]     ; local = 0
670b2c: 8b 4c 24 0c   mov ecx,DWORD PTR [esp+0xc]     ; local = 0
670b30: 89 10         mov DWORD PTR [eax],edx         ; out->m_dwOffset = 0
670b36: 89 48 04      mov DWORD PTR [eax+0x4],ecx     ; out->m_iVersion = 0   <-- THE BUG
```

so `operator=` copies the zero back over the correct version. **The fix is to re-apply the
BTEntry version after the copy-back**, in `LoadDataEx`, where both `ebp` (BTEntry) and `esi`
(`buf_out`) are live and callee-saved across the intervening calls.

### The space
Immediately after the copy-back, `LoadDataEx` calls `SmartBuffer::ReleaseMasterBuffer` on the
**same address twice**:

```
670ccf: 8d 4c 24 24   lea  ecx,[esp+0x24]
670cd3: e8 b8 5f d9 ff call 0x406c90
670cd8: 8d 4c 24 24   lea  ecx,[esp+0x24]       <-- 9 bytes, provably redundant
670cdc: e8 af 5f d9 ff call 0x406c90
```

`SmartBuffer::ReleaseMasterBuffer` (box `0x406C90`) is **idempotent by construction**: it reads
`[this+8]`, and if zero jumps straight to the tail which only re-zeros `[this]`, `[this+4]`,
`[this+8]`; the non-zero path ends with `mov DWORD PTR [esi+0x8],0`. The second call is therefore
a guaranteed no-op on an object the first call just cleared. **This gives 9 free bytes at the
exact point needed.** (The same doubled-release idiom appears in `Decompress` at `0x670B42`/
`0x670B4B` — same compiler artifact, same reasoning.)

### The patch (EOR build, `acclient.eor.orig.exe`, 4,841,472 B)

| key | file offset | VA | before | after |
|---|---|---|---|---|
| `dat-decompress-version` | `0x00271C78` | `0x00671C78` | `8d 4c 24 24 e8 0f 53 d9 ff` | `0f b7 45 02 89 46 04 90 90` |

Disassembly, before → after:

```
before: 671c78: 8d 4c 24 24     lea   ecx,[esp+0x24]
        671c7c: e8 0f 53 d9 ff  call  0x406f90            ; SmartBuffer::ReleaseMasterBuffer (2nd, no-op)

after:  671c78: 0f b7 45 02     movzx eax,WORD PTR [ebp+0x2]  ; BTEntry version word
        671c7c: 89 46 04        mov   DWORD PTR [esi+0x4],eax ; buf_out->m_iVersion = version
        671c7f: 90              nop
        671c80: 90              nop
```

(Replacement encoding verified with `objdump -D -b binary -m i386 -M intel`; exactly 9 bytes.)

**Signature** (prefix 12 B + masked 9-byte slice + suffix 3 B) — occurrences counted over the
whole pristine EOR file: **1**, both for the masked form and the full window:

```
prefix : 5a da ff 8d 4c 24 24 e8 18 53 d9 ff
slice  : [8d 4c 24 24 e8 0f 53 d9 ff]
suffix : 5f 5e 5d
```

**Box-build equivalent** (for the 5-minute A/B, `acclient.box-4837376.exe`), same reasoning,
signature also unique (1 occurrence):

| key | file offset | VA | before | after |
|---|---|---|---|---|
| `dat-decompress-version` (box) | `0x00270CD8` | `0x00670CD8` | `8d 4c 24 24 e8 af 5f d9 ff` | `0f b7 45 02 89 46 04 90 90` |
```
prefix : 67 da ff 8d 4c 24 24 e8 b8 5f d9 ff
slice  : [8d 4c 24 24 e8 af 5f d9 ff]
suffix : 5f 5e 5d
```

### Register/liveness proof
- `ebp` is loaded at `0x670BEF` (`mov ebp,[esp+0x34]`) as the BTEntry out-param, filled by the
  `rep movsd` at `0x670C04`, and is **never reassigned** in the compressed branch
  (`0x670C95`–`0x670CDC`). It is callee-saved across `Decompress` and `operator=`.
- `esi` is loaded at `0x670C10` (`mov esi,[esp+0x38]` = `buf_out`) and likewise never
  reassigned. `[esi+0x4]` is the same expression the function itself uses at `0x670C29`.
- `eax` is clobbered by the patch, but the only consumer downstream is `mov al,0x1` at
  `0x670CE4` (the `bool` return); the function returns in AL only. Safe.
- Flags: `movzx`/`mov` set none that the following `pop`/`ret` sequence consumes.

### Registry entry (proposed — do NOT apply; `PATCHES` in `patch_client.py`)
```python
"dat-decompress-version": Patch(
    key="dat-decompress-version",
    offset=0x00271C78,
    before=bytes.fromhex("8d4c2424e80f53d9ff"),
    after=bytes.fromhex("0fb745028946049090"),
    sig_prefix=bytes.fromhex("5adaff8d4c2424e81853d9ff"),
    sig_suffix=bytes.fromhex("5f5e5d"),
    enabled=False,   # UNTESTED — needs an in-client gate before graduating
    note="DiskController::LoadDataEx: restore BTEntry version word into "
         "buf_out->m_iVersion after Decompress zeroes it (repurposes a "
         "provably-idempotent duplicate SmartBuffer::ReleaseMasterBuffer call). "
         "Supersedes `dat-decompress`: with this applied, SerializeFromCachePack's "
         "m_iVersion!=0 guard passes legitimately and the guard NOP is unnecessary.",
),
```

### Why not patch `Decompress` itself (alternative B — rejected)
Copying `in->m_iVersion` in `Decompress`'s tail is **not possible in place**: the compiler
reuses the incoming `in` argument slot (`R+4`) as zlib's `destLen` variable at box `0x670AF4`
(`mov [esp+0x2c],edi`), so by the time the success tail runs, `[esp+0x20]` no longer holds `in`.
Stashing the version earlier needs 11 bytes where only 8 exist (`0x670AC7`–`0x670ACE`), and
`ebp` — the only free callee-saved register — is not saved by this frame, so using it would
require reshaping the prologue/epilogue. A jmp-to-cave variant is possible but strictly worse
than the LoadDataEx patch above.

### Why not "just NOP the `mov [eax+0x4],ecx`" (alternative C — rejected)
It would leave `out->m_iVersion` at whatever the temp `Cache_Pack_t` ctor (box `0x417350`)
left, which is then copied over `buf_out`. That value is not established as the real version
(it is a fresh temp), so this trades a deterministic 0 for an unaudited value. Not endorsed.

---

## 7. What a 5-minute box test looks like

1. Build `acclient.box-VERSIONFIX-TEST.exe` = box build + `dat-decompress-version` **only**
   (`0x00270CD8`, box bytes above) — **without** the `dat-decompress` guard NOP.
   If the version word is now non-zero for compressed records, the client boots and renders
   r7's compressed 0x06 textures with the *stock, unpatched* `SerializeFromCachePack` guard.
   **This is the whole test**: boot to the login UI (UI textures are compressed in r7, so a
   failure is immediate and unmissable — per the standing note, an unpatched exe cannot even
   boot r7). ~60 s.
2. If it boots: 240 s Holtburg soak (the existing arm-2 protocol, `gate-d.sh EXE=…`),
   `alive/faults` marks. Confirms nothing regressed.
3. Then the arm that actually answers H8: `acclient.eor.VERSIONFIX-TEST.exe`
   (EOR build + `0x00271C78` only, no guard NOP) + r7. If the EOR crash disappears, the root
   cause was the version-0 archive context after all (and §3's open question is answered
   empirically without further RE). If it still crashes at ~30–45 s in the
   `MotionData::UnPack`/`AnimData::UnPack` family, the version story is exonerated and the
   remaining suspects are §7-next below.
4. Standing box hygiene from the handoff: 130 s inter-launch guard, bracket `"[a]cclient"`,
   redeploy the VeryHigh INI, consider adding `-rodat`.

## 8. Ranked shortlist of what is still open

1. **(highest value, cheapest)** Run step 3 above. It converts §3 from "not disproven" to a
   fact in one launch, and it may simply fix the EOR build.
2. **`.rdata`/`.data` static-table diff** in the DBObj-dispatch neighbourhood — the one
   category the §5 census deliberately did not cover. Specifically the pack-type dispatch
   table(s) reached from `SerializeFromCachePack`'s `call [eax+0x1c]` and the
   `ArchiveInitializer` blob at box `ds:0x79535C` / EOR's counterpart. A table entry difference
   would be invisible to an instruction-level diff. ~1 h.
3. **Heap/CRT divergence.** `operator new`/`new[]`/`delete[]` live at box `0x5DDFC0/0x5DDFC5/
   0x5DE034` and EOR `0x5DF0F0/…`; §5 shows the builds link different CRT-inlining. Since the
   failure needs *large* allocations sustained over ~30 s and manifests as heap-resident
   fn-pointer stomping, a differing small/large-block boundary in the *CRT* (not in
   GrowBuffer, which is identical) remains a live hypothesis. Compare
   `operator new` → `_heap_alloc`/`_nh_malloc` chains across builds. ~1 h.
4. **Clamp `Archive::GetSizeLeft`** (EOR `0x40A590`+drift; `sub eax,[esi+0x18]` → clamp to 0).
   Not a root-cause fix, but it turns this entire bug class from a wild heap walk into a
   parse failure, and would let the EOR arm survive long enough to log *which* record is
   over-consuming. Consider as a **diagnostic-only** build, never shipped.
5. **A Windows run of the EOR exe** (per the prior handoff) still decouples Wine from the EOR
   question and is cheaper than any of the above if the 1070 frees up.

---

## Appendix — every address asserted in this report

| symbol (map = box build) | box VA | EOR VA | how established |
|---|---|---|---|
| `AnimData::UnPack` | 0x525E50 | 0x526A50 | 0x30-byte signature, unique in each exe |
| `MotionData::UnPack` | 0x526570 | 0x527170 | 0x30-byte signature at +0x99, unique |
| `CAnimHook::UnPackHook` | 0x5271D0 | (n/a) | map; **not** on the crash path |
| `SerializeUsingPackDBObj::Serialize` | 0x4F7490 | — | map |
| `Archive::GetSizeLeft` | 0x40A590 | — | map |
| `Archive::GetSizeUsed` | 0x40A570 | — | map |
| `Archive::PeekBytes` | 0x40A910 | — | map |
| `Archive::GetBytes` | 0x40A990 | — | map |
| `Archive::InitForUnpacking` | 0x40ACC0 | 0x40B020 | map + brief |
| `Archive::RaiseError` | 0x40A6F0 | — | map |
| `DBObj::Serialize` | 0x4152F0 | — | map |
| `AsyncCache::SerializeFromCachePack` | 0x417810 | 0x417AC0¹ | map + patch site |
| version-class helper | 0x41A2B0 | 0x41A5F0 | brief, re-verified |
| version-context find-or-create | 0x41A4D0 | 0x41A810 | brief, re-verified |
| version hash table / modulus | ds:0x817794 / 0x81779C | ds:0x818794 / 0x81879C | brief |
| `SmartBuffer::SmartBuffer` | 0x406A60 | 0x406D60 | map + call-site match |
| `SmartBuffer::GetBuffer` | 0x406A80 | 0x406D80 | map |
| `SmartBuffer::GetSize` | 0x406AB0 | 0x406DB0 | map |
| `SmartBuffer::ReleaseMasterBuffer` | 0x406C90 | 0x406F90 | map + call-site match |
| `SmartBuffer::operator=` | 0x406DD0 | — | map |
| `SmartBuffer::ReconfigureAllocation` | 0x4071B0 | 0x4074B0 | map + cmp.py |
| `GrowBuffer::GetGoodSize` | 0x406B20 | 0x406E20 | map + cmp.py |
| `GrowBuffer::GrowExact` | 0x406F50 | 0x407250 | map + cmp.py |
| `DiskController::Decompress` | 0x670A80 | 0x671A20 | map + 0x16-byte tail signature |
| `DiskController::LoadDataEx` | 0x670BC0 | 0x671B60 | map + 0x40-byte signature |
| `Cache_Pack_t` ctor / `operator=` | 0x417350 / 0x4173F0 | 0x417600 / 0x4176A0 | call sites |
| **patch site (this report)** | **0x670CD8** | **0x671C78** | unique 9-byte signature |

¹ Derived, not map-read: the guard sits at `fn+0x68` in both builds (box `0x417878 = 0x417810 +
0x68`), and the EOR guard is at `0x417B28`, so the EOR function starts at `0x417AC0` — a +0x2B0
drift, matching the same +0x2B0 between the version-class callees (box `0x41A2B0` / EOR
`0x41A5F0`) and the version-context lookups (box `0x41A4D0` / EOR `0x41A810` — +0x340; the
drift creeps across this region rather than being constant).
