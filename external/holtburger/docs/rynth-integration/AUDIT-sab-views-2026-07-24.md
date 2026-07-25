# AUDIT — SAB-backed views handed to Web APIs (2026-07-24)

Scope: every place bytes that live in (or could be views into) wasm linear memory reach a Web
API, across the wasm crates and the app JS. Prompted by HANDOFF-wasm-threads-SAB-2026-07-24
finding 3 (`transport.rs` `send_to`). Anchored by symbol; every row was read, not inferred.

## Ground truth established first

1. **The whole audit rests on one invariant:** wasm-bindgen copies owned `Vec<T>` returns OUT of
   linear memory before JS sees them. Verified in the checked-in glue:
   `pkg/holtburger_web.js` `getArrayU8FromWasm0` returns a `subarray` VIEW, but every one of the
   25 owned-vec return sites reads `var v1 = getArrayU8FromWasm0(ret[0], ret[1]).slice();`
   (`.slice()` on a typed array always allocates a fresh, NON-shared `ArrayBuffer`). Same for
   `getArrayF32FromWasm0` / `getArrayU32FromWasm0` — zero unsliced return sites.
   `Uint8Array::from(&[u8])` (js-sys `new_from_slice`) lands as
   `const ret = new Uint8Array(getArrayU8FromWasm0(arg0, arg1));` — the TypedArray constructor
   also copies into a non-shared buffer. **So no wasm-memory view is currently exported to JS.**
2. **The checked-in `pkg/` is FRESH but NON-THREADED.** `pkg/holtburger_web.js` +
   `holtburger_web_bg.wasm` are dated 2026-07-24 23:20 (src/lib.rs 23:16), and
   `scripts/wasm-memcheck.py` reports `shared=False, min=141 pages`. Every glue citation here is
   therefore from the single-threaded arm; the threaded-arm deltas are flagged as ASSUMPTIONS.
3. **Rust side is nearly empty.** A workspace-wide grep for `Uint8Array::view` / `view_mut_raw` /
   `send_with_u8_array` / `post_message` / `tex_image` / `put_image_data` / `create_image_bitmap` /
   `Blob::new` / `indexed_db` finds exactly ONE hit outside tests: `transport.rs`, already fixed.
4. **Only one `inline_js` block exists** (`lib.rs:61`, `js_location_search`) and it handles no
   bytes — the "cargo check cannot see inline_js" hazard does not apply to this class.
5. **Shard sha256 verification is Rust-side**, not Web Crypto: `holtburger-manifest`
   `sha256_hex` uses the `sha2` crate; `manifest_source.rs` calls it under the `__hbVerifyShards`
   gate. No `crypto.subtle` on that path — nothing to break.
6. **No IndexedDB anywhere** in the shipped app (grep over `scene3d/`, `index.html`, `plugins/`,
   `service-worker.js`, and all Rust). The only `OffscreenCanvas` is a 1x256 sky gradient with no
   wasm bytes and no transfer.

## Classification key

- **break** — API rejects SAB-backed views; would throw today if reached with one.
- **invariant** — safe ONLY because the wasm-bindgen copy-out invariant (ground truth 1) holds.
  These are the silent-regression surface: one getter changed to a view and they throw.
- **semantic** — no throw, but structured-clone/aliasing meaning changes under shared memory.
- **safe** — safe regardless of sharedness (spec allows shared, or the bytes never touch wasm memory).
- **conditional** — safe only if a compile-time gate fires; verify per build.

## Table

### Rust (wasm crates)

| file | symbol | API | class | fix pattern | when |
|---|---|---|---|---|---|
| crates/holtburger-transport-ws/src/transport.rs | `WsTransport::send_to` | `WebSocket.send(ArrayBufferView)` | break — **ALREADY FIXED** | `Uint8Array::new_with_length` + `copy_from` before `send_with_array_buffer_view` | landed |
| crates/holtburger-transport-ws/src/transport.rs | `on_message` closure (`Uint8Array::new(&array_buf).to_vec()`) | reads a JS-owned `ArrayBuffer` INTO wasm | safe | N/A — direction is JS→wasm; `TypedArray.set` into a shared target is a plain JS builtin | never |
| crates/holtburger-resource-http/src/http.rs | `fetch_bytes_with_priority` | `fetch()` (GET, **no body**) + `Response.arrayBuffer()` | safe | N/A. **Tripwire:** the day a POST body is added, it must be a JS-heap `Uint8Array` | never (until a body appears) |
| dep: getrandom `backends/wasm_js.rs` (0.3.4 / 0.4.2) | `get_random_values` | `crypto.getRandomValues(view)` | conditional | upstream already handles it: `#[cfg(target_feature="atomics")]` switches to a JS-heap `Uint8Array` + `copy_to_uninit`. getrandom 0.2.17's web path always uses a JS-heap buffer | verify per threaded build |
| apps/holtburger-web/src/net_worker.rs | `RemoteSessionProxy` outbound (`outbound_sink.call2`, ~:137) | `Function.call2` with `Uint8Array::from(bytes)` | safe | N/A — `from` copies into a non-shared buffer; this is what makes the JS-side transfer legal | never |
| apps/holtburger-web/src/net_worker.rs | `worker_post` (~:303) | same | safe | N/A | never |
| apps/holtburger-web/src/lib.rs | `js_location_search` (`inline_js`, :61) | none (string only) | safe | N/A | never |
| (workspace) | — | Blob / XHR / IndexedDB / ImageData / texImage / createImageBitmap / postMessage from Rust | safe | none exist | never |

### wasm-bindgen glue (`apps/holtburger-web/pkg/holtburger_web.js`)

| file | symbol | API | class | fix pattern | when |
|---|---|---|---|---|---|
| pkg/holtburger_web.js | `getArrayU8FromWasm0` + the 25 `.slice()` return sites | source of every typed array JS sees | safe (**the invariant**) | N/A — but gate it: grep the regenerated glue for unsliced `getArray*FromWasm0(ret[0], ret[1])` | verify per build |
| pkg/holtburger_web.js | `getStringFromWasm0` → `cachedTextDecoder.decode(subarray)` | `TextDecoder.decode` | safe | Encoding spec marks `decode`'s input `[AllowShared]`. ASSUMPTION: wasm-bindgen 0.2.108 additionally emits `.slice()` here when the memory is shared — re-read the threaded glue to confirm | verify per build |
| pkg/holtburger_web.js | `passStringToWasm0` → `encodeInto(view)` | `TextEncoder.encodeInto` | safe | destination is `[AllowShared]` per spec | never |
| pkg/holtburger_web.js | `new Uint8Array(getArrayU8FromWasm0(...))` shim (js-sys `new_from_slice`) | TypedArray constructor | safe | copies into a non-shared `ArrayBuffer` by construction | never |
| pkg/holtburger_web.js | `arg0.set(getArrayU8FromWasm0(...))` / `Uint8Array.prototype.set.call(view, arg)` (`copy_from` / `copy_to`) | `TypedArray.prototype.set` | safe | plain JS builtin; shared operands legal | never |
| pkg/holtburger_web.js | `getUint8ArrayMemory0` / `getFloat32ArrayMemory0` cache-invalidation (`byteLength === 0`) | — | semantic | growable SAB never detaches and length-tracking views auto-grow, so the check simply never fires. Note it; do not "fix" it | note only |

### JS (app)

| file | symbol | API | class | fix pattern | when |
|---|---|---|---|---|---|
| scene3d/bake_transfer.js | `pushBuffer` | `postMessage` **transfer list** | invariant (**highest value guard point**) | one chokepoint for all four serializers: if `typeof SharedArrayBuffer !== "undefined" && buf instanceof SharedArrayBuffer`, copy the view into a fresh array and transfer THAT | **before §2.1c pool** |
| scene3d/bake_transfer.js | `serializeModelMesh` / `serializeModelMeshes` | transfer of `positions/uvs/normals/surfaceIndices/sidesTypes/surfaces/bbox` buffers | invariant | via `pushBuffer` | before pool |
| scene3d/bake_transfer.js | `serializeSurfacePixels` / `serializeSurfacePixelsBatch` | transfer of `pixels/normalPixels/heightPixels` | invariant | via `pushBuffer` | before pool |
| scene3d/bake_transfer.js | `serializeEntitySurfacesBatch` | transfer, batched over `payloadAt(i)` | invariant | via `pushBuffer` | before pool |
| scene3d/bake_worker.js | `handleModelMeshes` | `self.postMessage(..., transfer)` | invariant | covered by the `pushBuffer` guard | before pool |
| scene3d/bake_worker.js | `handleSurfaces` | same | invariant | same | before pool |
| scene3d/bake_worker.js | `handleEntitySurfaces` | same | invariant | same | before pool |
| scene3d/bake_worker.js | `handleEntitySurfacesBatch` | same | invariant | same | before pool |
| scene3d/net_worker.js | `postToMain` (`self.postMessage({t:"rx", bytes}, [bytes.buffer])`) | transfer list | invariant | `bytes` comes from `Uint8Array::from` (copy). Transferring a SAB is ALWAYS illegal, so add the same guard if the marshalling ever changes | before threaded build ships |
| scene3d/net_worker_client.js | `outboundSink` (`worker.postMessage({t:"tx"...}, [bytes.buffer])`) | transfer list | invariant | same | before threaded build ships |
| scene3d/adapter.js | `buildTerrainAtlasArrayBytes` slow path (`new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength)` → `new ImageData(...)`, 2 sites incl. the code-32 road tile) | `ImageData` constructor | invariant (**would be a hard throw**) | `ImageData` rejects shared `Uint8ClampedArray`. Build the clamped array by COPY (`new Uint8ClampedArray(px)`) instead of aliasing `px.buffer` | before threaded build ships |
| scene3d/adapter.js | `buildTerrainDetailArrayBytes` slow path | `ImageData` | invariant | same | before threaded build ships |
| scene3d/adapter.js | `buildAlphaMaskArrayBytes` slow path | `ImageData` | invariant | same | before threaded build ships |
| scene3d/adapter.js | `surfacePixelsToTexture` / `surfacePixelsToNormalTexture` / `surfacePixelsToHeightTexture` | `THREE.DataTexture` → `texImage2D` | safe | already copies explicitly ("Always copy…"); WebGL upload accepts `[AllowShared]` views per spec anyway | never |
| scene3d/materials.js | paletted animated-frame builder (`buf.set(all.subarray(...))`) | `DataTexture` | safe | already copies each frame into a fresh `Uint8Array` | never |
| scene3d/audio/audio_manager.js | `fetchWave` → `bytes.buffer.slice(...)` → `decodeAudioData(ab)` | `AudioContext.decodeAudioData` | invariant + **stale comment** | `SharedArrayBuffer.prototype.slice` returns another SAB, and `decodeAudioData` needs a detachable non-shared buffer, so the existing "private copy" is NOT a SAB escape hatch. Copy via `new Uint8Array(bytes).buffer`. Also fix the comment: `takeRiffBytes()` returns an owned `Vec<u8>` (glue `.slice()`), never a view | before threaded build ships |
| scene3d/suite_assets.js | `windclip` / `texchan` decoders (`new DataView(bytes.buffer, ...)`, `new Uint8Array(bytes.buffer, base+p, n)`) | DataView / typed-array views | safe | DataView and typed arrays over a SAB are legal; the outputs go to `DataTexture`/geometry, which accept shared views | never |
| scene3d/diag/integrity.js | `digestUrl` | `crypto.subtle.digest` | safe | input is `Response.arrayBuffer()`, never wasm memory. (`digest` DOES reject shared — keep it that way) | never |
| service-worker.js | install precache (`cache.put(req, res.clone())`) and the fetch handler's `cache.put(event.request, network.clone())` | Cache API | safe | only network `Response`s reach the SW; nothing wasm-derived is ever handed to it | never |
| index.html | `?sharedWasm=on` block (`WebAssembly.compileStreaming` → `init({module_or_path})` → `window.__hbSharedWasm`) and its relay through `bake_worker_client.js` → `bake_worker.js` `handleInit` `initSync({module, memory})` | structured clone of `WebAssembly.Module` + `Memory` | semantic | intended sharing (that is the experiment). Note it is a CLONE-shares, not a transfer — never add `memory` to a transfer list | note only |
| index.html | `?nosw=1` `caches.keys()` / `caches.delete()` | Cache API | safe | no bytes | never |
| scene3d/index.js | sky-gradient `new OffscreenCanvas(1, 256)` | OffscreenCanvas | safe | not transferred, no wasm bytes | never |
| (app-wide) | — | IndexedDB | safe | none exists | never |
| harness/*, capture_*.cjs, diag/* | — | various | safe | dev/CI only, off the shipping path | never |

## Must-fix-before-pool

1. **`bake_transfer.js` `pushBuffer` — add the SAB guard.** One function protects all eight
   transfer-list rows above. Transferring a SAB-backed buffer is illegal unconditionally, so this
   is the row most likely to become finding 3's second bite. **Before §2.1c.**
2. **Make the copy-out invariant a gate, not an assumption.** After every threaded build, verify
   (a) `scripts/wasm-memcheck.py` says `shared=True`, (b) no unsliced
   `getArray*FromWasm0(ret[0], ret[1])` return sites in `pkg/holtburger_web.js`, (c) the
   `getRandomValues` shim no longer passes a raw `getArrayU8FromWasm0(...)` view (it should hand a
   JS-heap `Uint8Array` once getrandom sees `target_feature="atomics"`). The current pkg fails (a)
   — it is a single-threaded build, so nothing here has been observed under real shared memory yet.
3. **`adapter.js` three `ImageData` slow paths — copy instead of aliasing `px.buffer`.** Cheap, and
   `ImageData` is a hard rejector. These paths are defensive (retail emits 512x512), so a break
   here would surface only on unusual content — the worst failure profile.
4. **`audio_manager.js` `fetchWave` — replace `bytes.buffer.slice()` with a real copy and correct
   the comment.** The current comment asserts a view that does not exist, which is exactly the kind
   of stale premise defect 8 in the handoff calls out.
5. **Write the rule down:** any new Rust code handing `&[u8]` to a web-sys API must first copy into
   a JS-heap `Uint8Array` (`new_with_length` + `copy_from`), per `transport.rs` `send_to`. Any new
   JS transfer list must go through a SAB-guarded helper.

## Status (2026-07-24, follow-up commit)

Must-fix 1, 3, 4 are **LANDED**; 5 is written down below. Must-fix 2 (the build gate) is still
open — it is a per-build check, not a code change; its checklist is item C of the house rules.

- **1** — `bake_transfer.js` `pushBuffer` now copies a SAB-backed view into a fresh non-shared
  buffer via `TypedArray.prototype.slice()` and transfers THAT; the SAB never enters the transfer
  list. Because the copy is per view, `pushBuffer` now RETURNS the array to put in the payload and
  `serializeModelMesh` / `serializeSurfacePixels` read each wasm getter exactly once THROUGH it.
  Dedup-by-buffer-identity is unchanged (distinct views get distinct fresh buffers).
- **3** — the three `adapter.js` `ImageData` slow paths (terrain atlas ×2 incl. the code-32 road
  tile, terrain detail, alpha mask) build the `Uint8ClampedArray` by copy (`new Uint8ClampedArray(px)`)
  instead of aliasing `px.buffer`. Fast paths and `DataTexture` paths untouched. This ADDS a copy on
  the slow path only — acceptable: those paths are defensive (retail emits 512x512) and already
  round-trip through a canvas resample.
- **4** — `audio_manager.js` `fetchWave` uses `bytes.slice().buffer`; the stale "would invalidate
  the wasm-side Uint8Array view" comment is corrected (`takeRiffBytes()` returns an owned copy; the
  copy exists only because `decodeAudioData` detaches its input).

## House rules (SAB hygiene)

**A. New Rust `&[u8]` → web-sys must copy.** Never hand a `Uint8Array::view` / raw slice view of
wasm linear memory to a web-sys API. Allocate a JS-heap array and copy in first — the
`transport.rs` `send_to` pattern:

```rust
let buf = js_sys::Uint8Array::new_with_length(bytes.len() as u32);
buf.copy_from(bytes);
ws.send_with_array_buffer_view(&buf)?;
```

This is mandatory even when the API is spec'd `[AllowShared]`, so the call site does not silently
become a break the day the memory turns shared.

**B. New JS transfer lists go through `pushBuffer`.** Any new `postMessage(payload, transfer)` must
collect its buffers via `scene3d/bake_transfer.js` `pushBuffer` (import it) or replicate its guard
verbatim: if `typeof SharedArrayBuffer !== "undefined" && ta.buffer instanceof SharedArrayBuffer`,
`ta = ta.slice()` and transfer the copy's buffer. Use the RETURNED array in the payload — posting
the original view while transferring a copy silently ships a wasm-memory alias. Transferring a SAB
is illegal unconditionally, so this is a throw, not a degradation. Currently un-guarded (they take
their bytes from `Uint8Array::from`, which copies): `net_worker.js` `postToMain` and
`net_worker_client.js` `outboundSink` — convert them if their marshalling ever changes.

**C. After EVERY threaded build, run the must-fix-2 gate checks** before trusting any measurement:
(a) `scripts/wasm-memcheck.py` reports `shared=True`; (b) `pkg/holtburger_web.js` has ZERO unsliced
`getArray*FromWasm0(ret[0], ret[1])` return sites (grep it — every owned-vec return must end in
`.slice()`); (c) the `getRandomValues` shim hands a JS-heap `Uint8Array`, not a raw
`getArrayU8FromWasm0(...)` view; (d) `getStringFromWasm0`'s `TextDecoder.decode` input is sliced
under shared memory. A failure in (b) means the copy-out invariant — which every "invariant"-class
row in the table above rests on — is broken, and the whole table must be re-walked.
