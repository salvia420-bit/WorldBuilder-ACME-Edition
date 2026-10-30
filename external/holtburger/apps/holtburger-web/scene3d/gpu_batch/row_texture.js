// scene3d/gpu_batch/row_texture.js — R3-3 K2: row textures, the instance-
// matrix redirect, normal-matrix rows and per-entity / per-landblock origins
// (docs/2026-10-29-round3-gpu-driven.md §R3-3 items 3 and 5).
//
// ROWS. A row is `texelsPerRow` consecutive vec4s — 16 bytes each, the std430
// layout of a `vec4[]` (stride 16, no padding), so the same Float32Array
// could later back a WebGPU storage buffer unchanged. The rows live in one
// RGBA32F DataTexture, `texelsPerRow` texels wide and one texture row per
// kit row, filled from ONE flat Float32Array and uploaded with ONE
// texSubImage2D per frame when anything changed (the anim_scenery_gpu.js
// method: `needsUpdate` on an immutable, already-allocated texture is a
// single full-size texSubImage2D in three r184). Row 0 is reserved and stays
// all-zero: a vertex or instance whose row index is missing (attribute
// default 0) reads a ZERO matrix and collapses — the same "zeroed row =
// collapsed" rule a consumer uses on purpose to hide a part, a cell or a
// culled object.
//
// GROWTH. `ensureRows` doubles the capacity. A grown texture is a new GL
// allocation plus a full upload, so it is charged to the kit's upload budget
// (`UPLOAD_KIND.ROW_GROW`); when the budget refuses, the rows are not
// allocated and the consumer keeps its previous state. three uploads the new
// texture at its next render that samples it, so the charge is a DEFERRED
// spend (upload_budget.js "THE CAP HOLDS PER UPLOAD FRAME"): a ticket landed
// by the texture's `onUpdate` (three calls it after the upload), dropped if
// the texture is replaced or disposed before it ever uploaded. The growth's
// CPU work is timed (`budget.addMs("rowGrow", ...)`, S1).
//
// LIFECYCLE (K3). `opts.onTexture(tex)` sees every texture this table
// allocates and `opts.disposeTexture(tex)` retires it (default: dispose()).
// The kit's state table passes array_pages.js trackContextGenerations /
// disposeOnLiveContext, so a texture three uploaded before a context restore
// is never deleted on the restored context.
//
// THE REDIRECT. `instanceRedirectChunk` builds a vertex-shader header that
// declares a global `mat4 hbBatchInstanceMatrix`, fills it from the row
// texture at the top of main(), and `#define`s `instanceMatrix` to it, so
// every downstream use — three's project / worldpos / normal chunks and every
// onBeforeCompile patch in the chain (light clamp, fog, POM, VFX, the CSM
// receiver, lightUbo's lights) — reads the row matrix exactly as it read the
// attribute (anim_scenery_gpu.js proved the trick live). `compose: true`
// keeps the attribute and right-multiplies: attribute * row.
//
// ORIGINS. f32 has a 3.9 mm ulp at x = 32.4 km. A row may carry its matrix
// LOCAL to an origin (an entity, a landblock) plus the index of an origin row
// whose texel 0 holds (origin - camera) — computed in f64 on the CPU each
// frame (`OriginTable.writeCameraRelative`) and stored once as f32. The mesh
// is anchored at the camera (`anchorAtCamera`: matrixWorld = T(camera), so
// three's modelViewMatrix = V * T(camera) is formed in f64 and uploaded with
// a near-zero translation). Every f32 quantity the GPU then sees is small.
//
// GLSL text: no backticks, quotes or apostrophes (GLSL ES character set).

import * as THREE from "three";
import { UPLOAD_KIND, uploadNowMs } from "./upload_budget.js";

export const ROW_TEXEL_BYTES = 16;

/** Float offset of (row, texel) in the flat std430 vec4 array. */
export function std430Offset(row, texel, texelsPerRow) {
  return (row * texelsPerRow + texel) * 4;
}

/**
 * The normal matrix of a 4x4 (column-major `elements`), as three's
 * Matrix3.getNormalMatrix computes it (inverse transpose of the upper 3x3),
 * written as three vec4 columns (w = 0) at `out[off..off+11]`. A singular
 * matrix (a collapsed row) writes zeros.
 */
export function writeNormalMatrixColumns(e, out, off) {
  // Matrix3.setFromMatrix4 + invert, operation for operation (three r184
  // Matrix3.invert), so the f64 results are bit-identical to getNormalMatrix.
  const n11 = e[0], n21 = e[1], n31 = e[2];
  const n12 = e[4], n22 = e[5], n32 = e[6];
  const n13 = e[8], n23 = e[9], n33 = e[10];
  const t11 = n33 * n22 - n32 * n23;
  const t12 = n32 * n13 - n33 * n12;
  const t13 = n23 * n12 - n22 * n13;
  const det = n11 * t11 + n21 * t12 + n31 * t13;
  if (det === 0) {
    for (let i = 0; i < 12; i += 1) out[off + i] = 0;
    return false;
  }
  const detInv = 1 / det;
  const i0 = t11 * detInv;
  const i1 = (n31 * n23 - n33 * n21) * detInv;
  const i2 = (n32 * n21 - n31 * n22) * detInv;
  const i3 = t12 * detInv;
  const i4 = (n33 * n11 - n31 * n13) * detInv;
  const i5 = (n31 * n12 - n32 * n11) * detInv;
  const i6 = t13 * detInv;
  const i7 = (n21 * n13 - n23 * n11) * detInv;
  const i8 = (n22 * n11 - n21 * n12) * detInv;
  // transpose: normal-matrix columns are (i0,i3,i6), (i1,i4,i7), (i2,i5,i8)
  out[off + 0] = i0; out[off + 1] = i3; out[off + 2] = i6; out[off + 3] = 0;
  out[off + 4] = i1; out[off + 5] = i4; out[off + 6] = i7; out[off + 7] = 0;
  out[off + 8] = i2; out[off + 9] = i5; out[off + 10] = i8; out[off + 11] = 0;
  return true;
}

export class RowTexture {
  /**
   * @param {object} opts
   * @param {number} opts.texelsPerRow  vec4s per row
   * @param {number} [opts.rows=32]     initial capacity (row 0 reserved)
   * @param {string} [opts.name]
   */
  constructor(opts) {
    this.texelsPerRow = Math.max(1, opts.texelsPerRow | 0);
    this.floatsPerRow = this.texelsPerRow * 4;
    this.name = opts.name || "gpu-batch-rows";
    this.capacity = 0;
    this.data = null;
    this.texture = null;
    /** Shared BY REFERENCE into every shader that samples this table. */
    this.uniform = { value: null };
    this._free = [];
    this._next = 1; // row 0 reserved (zero)
    this._dirty = false;
    this._onTexture = typeof opts.onTexture === "function" ? opts.onTexture : null;
    this._disposeTexture = typeof opts.disposeTexture === "function" ? opts.disposeTexture : null;
    this._growTicket = null; // { budget, ticket, texture }: the growth upload still to land
    this.stats = { uploads: 0, uploadBytes: 0, grows: 0, growBytes: 0, growRefused: 0 };
    this._allocate(Math.max(2, opts.rows | 0 || 32));
  }

  _retire(tex) {
    if (!tex) return;
    try {
      if (this._disposeTexture) this._disposeTexture(tex);
      else tex.dispose();
    } catch (_) { /* fail-soft */ }
  }

  /** The growth upload of `tex` will never happen (replaced / disposed first). */
  _dropGrowTicket() {
    const g = this._growTicket;
    if (!g) return;
    this._growTicket = null;
    if (g.texture) g.texture.onUpdate = null;
    try { g.budget.drop(g.ticket); } catch (_) { /* fail-soft */ }
  }

  _allocate(rows, grow) {
    const data = new Float32Array(rows * this.floatsPerRow);
    if (this.data) data.set(this.data);
    const tex = new THREE.DataTexture(data, this.texelsPerRow, rows, THREE.RGBAFormat, THREE.FloatType);
    tex.name = this.name;
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.flipY = false;
    tex.needsUpdate = true;
    if (this._onTexture) { try { this._onTexture(tex); } catch (_) { /* fail-soft */ } }
    this._dropGrowTicket();
    if (grow && grow.ticket && grow.budget && typeof grow.budget.land === "function") {
      // three calls onUpdate after it uploaded the texture: the growth landed.
      const g = { budget: grow.budget, ticket: grow.ticket, texture: tex };
      this._growTicket = g;
      tex.onUpdate = () => {
        tex.onUpdate = null;
        if (this._growTicket === g) this._growTicket = null;
        g.budget.land(g.ticket);
      };
    }
    const old = this.texture;
    this.data = data;
    this.texture = tex;
    this.capacity = rows;
    this.uniform.value = tex;
    this._dirty = false; // the new texture uploads in full on first use
    this._retire(old);
  }

  /** Bytes a texture of `rows` rows uploads. */
  bytesFor(rows) {
    return rows * this.texelsPerRow * ROW_TEXEL_BYTES;
  }

  /**
   * Make room for `rows` rows (indices 0..rows-1). Growth doubles and is
   * charged to `budget` (optional): returns false, changing nothing, when the
   * budget refuses this frame.
   */
  ensureRows(rows, budget) {
    if (rows <= this.capacity) return true;
    let cap = this.capacity;
    while (cap < rows) cap *= 2;
    const bytes = this.bytesFor(cap);
    let grow = null;
    if (budget) {
      if (typeof budget.spendDeferred === "function") {
        const ticket = budget.spendDeferred(bytes, UPLOAD_KIND.ROW_GROW);
        if (!ticket) { this.stats.growRefused += 1; return false; }
        grow = { budget, ticket };
      } else if (!budget.trySpend(bytes, UPLOAD_KIND.ROW_GROW)) { this.stats.growRefused += 1; return false; }
    }
    const t0 = uploadNowMs();
    this._allocate(cap, grow);
    this.stats.grows += 1;
    this.stats.growBytes += bytes;
    if (budget && typeof budget.addMs === "function") budget.addMs(UPLOAD_KIND.ROW_GROW, uploadNowMs() - t0);
    return true;
  }

  /** A fresh zeroed row index, or -1 when growth was refused. */
  alloc(budget) {
    if (this._free.length > 0) return this._free.pop();
    const row = this._next;
    if (!this.ensureRows(row + 1, budget)) return -1;
    this._next += 1;
    return row;
  }

  /** Return a row: zeroed (collapsed) and reusable. */
  free(row) {
    if (row <= 0 || row >= this._next) return;
    this.zeroRow(row);
    this._free.push(row);
  }

  /** Rows handed out so far (high-water mark, row 0 included). */
  get rowsUsed() { return this._next; }

  zeroRow(row) {
    const b = row * this.floatsPerRow;
    this.data.fill(0, b, b + this.floatsPerRow);
    this._dirty = true;
  }

  writeVec4(row, texel, x, y, z, w) {
    const o = std430Offset(row, texel, this.texelsPerRow);
    const d = this.data;
    d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = w;
    this._dirty = true;
  }

  /** 4 texels: the matrix columns (`elements` column-major, f64 -> f32). */
  writeMat4(row, texel, elements) {
    const o = std430Offset(row, texel, this.texelsPerRow);
    const d = this.data;
    for (let i = 0; i < 16; i += 1) d[o + i] = elements[i];
    this._dirty = true;
  }

  /** 3 texels: the normal matrix of `elements` (see writeNormalMatrixColumns). */
  writeNormalMatrix(row, texel, elements) {
    writeNormalMatrixColumns(elements, this.data, std430Offset(row, texel, this.texelsPerRow));
    this._dirty = true;
  }

  /** Copy `n` floats from `src[srcOff]` into the row (a Rust producer's output). */
  copyRow(row, src, srcOff) {
    const b = row * this.floatsPerRow;
    const d = this.data;
    for (let i = 0; i < this.floatsPerRow; i += 1) d[b + i] = src[srcOff + i];
    this._dirty = true;
  }

  markDirty() { this._dirty = true; }

  /** Once per frame: schedule the one texSubImage2D. Returns bytes scheduled. */
  flush() {
    if (!this._dirty || !this.texture) return 0;
    this.texture.needsUpdate = true;
    this._dirty = false;
    const bytes = this.bytesFor(this.capacity);
    this.stats.uploads += 1;
    this.stats.uploadBytes += bytes;
    return bytes;
  }

  dispose() {
    this._dropGrowTicket();
    this._retire(this.texture);
    this.texture = null;
    this.data = null;
    this.uniform.value = null;
    this.capacity = 0;
    this._free.length = 0;
    this._next = 1;
  }
}

// ===========================================================================
// The instanceMatrix redirect.
// ===========================================================================
export const ROW_REDIRECT_MARKER = "HB_GPU_BATCH_ROWS";

/**
 * Vertex-shader header for the redirect. Row layout read: texels
 * `matrixTexel..+3` = the matrix columns; with `origins`, texel
 * `originTexel`.x = the index of an origin row whose texel 0 .xyz is
 * (origin - camera), added to the translation.
 *
 * @param {object} o
 * @param {string} o.sampler    uniform name of the row texture
 * @param {string} o.rowAttr    float attribute holding the row index
 * @param {number} [o.matrixTexel=0]
 * @param {boolean} [o.compose=false]  attribute instanceMatrix * row matrix
 * @param {number} [o.originTexel=-1]  >= 0 enables the origin offset
 */
export function instanceRedirectChunk(o) {
  const t = o.matrixTexel | 0;
  const lines = [
    "#ifdef USE_INSTANCING",
    "// ---- " + ROW_REDIRECT_MARKER + " (scene3d/gpu_batch/row_texture.js) ----",
    "uniform highp sampler2D " + o.sampler + ";",
    "attribute float " + o.rowAttr + ";",
    "mat4 hbBatchInstanceMatrix;",
    "void hbBatchRowSetup() {",
    "  int hbR = int(" + o.rowAttr + " + 0.5);",
    "  mat4 hbM = mat4(texelFetch(" + o.sampler + ", ivec2(" + t + ", hbR), 0), texelFetch(" + o.sampler + ", ivec2(" + (t + 1) + ", hbR), 0),",
    "                  texelFetch(" + o.sampler + ", ivec2(" + (t + 2) + ", hbR), 0), texelFetch(" + o.sampler + ", ivec2(" + (t + 3) + ", hbR), 0));",
  ];
  if ((o.originTexel ?? -1) >= 0) {
    lines.push(
      "  int hbO = int(texelFetch(" + o.sampler + ", ivec2(" + (o.originTexel | 0) + ", hbR), 0).x + 0.5);",
      "  hbM[3].xyz += texelFetch(" + o.sampler + ", ivec2(0, hbO), 0).xyz;",
    );
  }
  lines.push(
    o.compose ? "  hbBatchInstanceMatrix = instanceMatrix * hbM;" : "  hbBatchInstanceMatrix = hbM;",
    "}",
    "#define instanceMatrix hbBatchInstanceMatrix",
    "// ---- end " + ROW_REDIRECT_MARKER + " ----",
    "#endif",
    "",
  );
  return lines.join("\n");
}

/**
 * Put `chunk` at the very top of the vertex shader and call `setupFn` as
 * main()'s first statement (same seam as anim_scenery_gpu.js
 * injectAnimInstPose). Idempotent on `marker`; without a `void main() {`
 * nothing changes (returns false), so a shader never gets the define
 * without the call that fills it.
 */
export function injectVertexHeader(shader, chunk, marker, setupFn, guard = "USE_INSTANCING") {
  const vs = shader && shader.vertexShader;
  if (typeof vs !== "string") return false;
  if (vs.indexOf(marker) !== -1) return true;
  const at = vs.indexOf("void main() {");
  if (at === -1) return false;
  const call = guard ? "\n#ifdef " + guard + "\n  " + setupFn + "();\n#endif" : "\n  " + setupFn + "();";
  shader.vertexShader = chunk + vs.slice(0, at) + "void main() {" + call + vs.slice(at + "void main() {".length);
  return true;
}

// ===========================================================================
// Origins: f64 on the CPU, camera-relative f32 on the GPU.
// ===========================================================================
export const METERS_PER_LANDBLOCK = 192.0;

/** World-space origin (AC frame, metres) of a landblock id (0xXXYY....). */
export function landblockOrigin(lbId, out) {
  const o = out || [0, 0, 0];
  o[0] = ((lbId >>> 24) & 0xff) * METERS_PER_LANDBLOCK;
  o[1] = ((lbId >>> 16) & 0xff) * METERS_PER_LANDBLOCK;
  o[2] = 0;
  return o;
}

export class OriginTable {
  /**
   * @param {RowTexture} rows the table the origin rows live in (texel 0 used)
   */
  constructor(rows) {
    this.rows = rows;
    this._x = new Float64Array(16);
    this._y = new Float64Array(16);
    this._z = new Float64Array(16);
    this._row = new Int32Array(16);
    this._live = new Uint8Array(16);
    this._count = 0;
    this._byKey = new Map();
    this._freeSlots = [];
  }

  /** Slot for `key` at f64 world origin (x, y, z); the row is allocated now. */
  acquire(key, x, y, z, budget) {
    let s = this._byKey.get(key);
    if (s !== undefined) return s;
    const row = this.rows.alloc(budget);
    if (row < 0) return -1;
    s = this._freeSlots.length ? this._freeSlots.pop() : this._count++;
    if (s >= this._x.length) {
      const grow = (A, C) => { const n = new C(A.length * 2); n.set(A); return n; };
      this._x = grow(this._x, Float64Array); this._y = grow(this._y, Float64Array); this._z = grow(this._z, Float64Array);
      this._row = grow(this._row, Int32Array); this._live = grow(this._live, Uint8Array);
    }
    this._x[s] = x; this._y[s] = y; this._z[s] = z;
    this._row[s] = row;
    this._live[s] = 1;
    this._byKey.set(key, s);
    return s;
  }

  rowOf(slot) { return this._row[slot]; }

  release(key) {
    const s = this._byKey.get(key);
    if (s === undefined) return;
    this._byKey.delete(key);
    this.rows.free(this._row[s]);
    this._live[s] = 0;
    this._freeSlots.push(s);
  }

  /**
   * Once per frame, before the row flush: every live origin row's texel 0 =
   * (origin - camera) computed in f64, stored as f32.
   */
  writeCameraRelative(cx, cy, cz) {
    for (let s = 0; s < this._count; s += 1) {
      if (!this._live[s]) continue;
      this.rows.writeVec4(this._row[s], 0, this._x[s] - cx, this._y[s] - cy, this._z[s] - cz, 0);
    }
  }
}

/**
 * Anchor a batch mesh at the camera: matrixWorld = parentWorld * T(c) where
 * `c` is the camera position in the PARENT's frame, so three's
 * modelViewMatrix (formed in f64 in JS) carries a near-zero translation.
 * Call once per frame before the render, after the camera moved.
 */
export function anchorAtCamera(mesh, cx, cy, cz) {
  mesh.matrixAutoUpdate = false;
  mesh.position.set(cx, cy, cz);
  mesh.matrix.makeTranslation(cx, cy, cz);
  mesh.matrixWorldNeedsUpdate = true;
}
