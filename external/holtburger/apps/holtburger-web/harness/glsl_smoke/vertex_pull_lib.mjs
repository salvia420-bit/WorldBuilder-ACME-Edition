// harness/glsl_smoke/vertex_pull_lib.mjs — handoff P4 SPIKE (GPU-resident statics,
// §6 L3 "one draw per bucket via vertex pulling"), 2026-10-22. HARNESS ONLY: nothing
// under scene3d/ imports this, no flag, no runtime wiring. Shared by
// vertex_pull_page.html (the GPU half, headless Chromium) and
// tests/vertex_pull_spike.test.mjs (the CPU half, node). Findings:
// docs/vertex-pull-spike-2026-10-22.md.
//
// WHAT L3 SPECIFIES (handoff §6), and how this file realises it:
//   * A global geometry ARENA in a data texture: every model's vertices once.
//     Here: RGBA32F, two texels per vertex — (pos.xyz, uv.x), (nrm.xyz, uv.y) —
//     32 B/vertex, the same f32 values BatchedMesh uploads as attributes, so the
//     two arms' vertex inputs are bit-identical (the pixel proof needs that; the
//     HBG1 24 B layout is discussed in the doc, not built).
//   * A per-bucket PULL STREAM: one u32 entry per triangle corner = (arena vertex,
//     instance slot), drawn with ONE drawArrays per bucket and read at gl_VertexID.
//     Three encodings, so the doc can price them against each other:
//       STREAM_PACKED (1): R32UI texture, (slot << vbits) | vertex  — 4 B/corner;
//       STREAM_PAIR   (2): RG32UI texture, (vertex, slot)           — 8 B/corner;
//       STREAM_ATTR   (0): the packed u32 as an integer VERTEX ATTRIBUTE instead of
//                          a texture — 4 B/corner, one vertex sampler fewer, no
//                          stream texel fetch (beyond the spec: L3 says "texture").
//     Plus an INDEXED form (beyond the spec): the packed stream holds one entry per
//     (instance, model vertex) and an index buffer of corners points into it, so
//     the GPU's post-transform vertex cache works again (a non-indexed pull shades
//     EVERY corner — see the doc's cost section). Same shader as STREAM_PACKED.
//   * The instance matrices (and per-instance colours) in BatchedMesh's OWN
//     texture layouts (BatchedMesh._initMatricesTexture / _initColorsTexture,
//     three r184), read by a verbatim copy of three's getBatchingMatrix /
//     getBatchingColor under our own sampler names.
//   * three's lighting chunks stay: the vertex body (onBeforeCompile, i.e. AFTER
//     three's prefix, which declares `in vec3 position; in vec3 normal; in vec2
//     uv;`) `#define`s position / normal / uv to globals filled by hbPull() at the
//     top of main(); the prefix attributes go unused, so they are inactive and
//     three binds nothing for them. USE_BATCHING / USE_BATCHING_COLOR are defined
//     in the body, so three's own project / defaultnormal / worldpos / color
//     chunks (and every app patch keyed on `batchingMatrix` under USE_BATCHING:
//     the CSM receiver, vfx/per_instance.js) run unchanged; only the three
//     chunks that read gl_DrawID are replaced (batching_pars_vertex,
//     batching_vertex, and the getBatchingColor call inside color_vertex).
//
// Evidence tags as the handoff: [M] measured, [D] derived from a code read,
// [A] assumed. Everything in this file is [D] until the orchestrator runs
// harness/glsl_smoke/vertex_pull_smoke.mjs.

export const STREAM_ATTR = 0;
export const STREAM_PACKED = 1;
export const STREAM_PAIR = 2;

// ---------------------------------------------------------------------------
// The scene both halves draw (deterministic; the page and the node test share it).
// ---------------------------------------------------------------------------
export const SPIKE_MAX_INSTANCES = 64;
export const SPIKE_INSTANCES = 30;

/**
 * Four distinct INDEXED models (three's primitives) and 30 placements with
 * distinct T·R·S matrices and per-instance colours, laid out so no two
 * placements meet in depth. The geometry pattern interleaves the models, so
 * batched_runs.js's grouping has real work to do (runs != canonical order).
 */
export function buildSpikeScene(THREE) {
  const geoms = [
    new THREE.BoxGeometry(0.8, 0.8, 0.8),
    new THREE.SphereGeometry(0.45, 12, 8),
    new THREE.CylinderGeometry(0.3, 0.42, 0.9, 10),
    new THREE.TorusGeometry(0.33, 0.12, 8, 16),
  ];
  const instances = [];
  const p = new THREE.Vector3(), s = new THREE.Vector3(), q = new THREE.Quaternion(), e = new THREE.Euler();
  for (let k = 0; k < SPIKE_INSTANCES; k++) {
    const col = k % 6, row = Math.floor(k / 6);
    const geom = (k * 7 + (k >> 2)) % geoms.length;
    p.set((col - 2.5) * 1.75, (row - 2) * 1.6, (k % 2) ? -0.6 : 0);
    q.setFromEuler(e.set(0.37 * k, 0.23 * k, 0.11 * k));
    s.set(1 + 0.1 * (k % 3), 1 - 0.07 * (k % 2), 1 + 0.05 * (k % 4));
    const matrix = new THREE.Matrix4().compose(p, q, s);
    const color = new THREE.Color().setHSL((k * 0.13) % 1, 0.75, 0.55);
    instances.push({ geom, matrix, color });
  }
  return { geoms, instances };
}

// ---------------------------------------------------------------------------
// Texture layouts (pure).
// ---------------------------------------------------------------------------

/** BatchedMesh._initMatricesTexture (three r184): square side, multiple of 4, >= 4; 4 RGBA32F texels per matrix. */
export function batchingMatricesSide(maxInstanceCount) {
  let size = Math.sqrt(maxInstanceCount * 4);
  size = Math.ceil(size / 4) * 4;
  return Math.max(size, 4);
}

/** BatchedMesh._initColorsTexture (three r184): square side, one RGBA32F texel per instance, filled with 1. */
export function batchingColorsSide(maxInstanceCount) {
  return Math.ceil(Math.sqrt(maxInstanceCount));
}

/** Bits to hold the values 0 .. n-1 (at least 1). */
export function bitsFor(n) {
  let b = 1;
  while (2 ** b < n) b++;
  return b;
}

/**
 * The packed entry's bit split: `vbits` for the arena vertex, the rest for the
 * slot. `fits` false = the bucket needs STREAM_PAIR (8 B/corner) instead.
 */
export function packBits(arenaVertices, slots) {
  const vbits = bitsFor(Math.max(1, arenaVertices));
  const sbits = bitsFor(Math.max(1, slots));
  return { vbits, sbits, fits: vbits + sbits <= 32 };
}

/** A near-square texture for `texels` one-texel entries. */
function squareDims(texels) {
  const width = Math.max(1, Math.ceil(Math.sqrt(texels)));
  return { width, height: Math.max(1, Math.ceil(texels / width)) };
}

function readGeom(g) {
  const pos = g && g.attributes && g.attributes.position;
  const nrm = g && g.attributes && g.attributes.normal;
  const uv = g && g.attributes && g.attributes.uv;
  if (!pos || !nrm || !uv || !g.index) throw new Error("vertex_pull: indexed geometry with position/normal/uv required");
  if (pos.isInterleavedBufferAttribute || nrm.isInterleavedBufferAttribute || uv.isInterleavedBufferAttribute) {
    throw new Error("vertex_pull: interleaved attributes are not handled by the spike");
  }
  if (pos.itemSize !== 3 || nrm.itemSize !== 3 || uv.itemSize !== 2) throw new Error("vertex_pull: unexpected item sizes");
  return { pos: pos.array, nrm: nrm.array, uv: uv.array, count: pos.count, index: g.index.array, corners: g.index.count };
}

/**
 * The geometry ARENA: every model once, 2 RGBA32F texels per vertex,
 * (px, py, pz, u) then (nx, ny, nz, v). The width is even, so a vertex's two
 * texels share a row (the shader reads p and p + (1, 0)). `base[g]` = model g's
 * first arena vertex.
 */
export function buildArena(geoms) {
  const base = new Int32Array(geoms.length);
  let vertices = 0;
  const parts = geoms.map((g, i) => { const r = readGeom(g); base[i] = vertices; vertices += r.count; return r; });
  const texels = 2 * vertices;
  let width = Math.max(2, Math.ceil(Math.sqrt(texels)));
  if (width & 1) width++;
  const height = Math.max(1, Math.ceil(texels / width));
  const data = new Float32Array(width * height * 4);
  parts.forEach((r, i) => {
    for (let v = 0; v < r.count; v++) {
      const o = (base[i] + v) * 8;
      data[o] = r.pos[v * 3]; data[o + 1] = r.pos[v * 3 + 1]; data[o + 2] = r.pos[v * 3 + 2]; data[o + 3] = r.uv[v * 2];
      data[o + 4] = r.nrm[v * 3]; data[o + 5] = r.nrm[v * 3 + 1]; data[o + 6] = r.nrm[v * 3 + 2]; data[o + 7] = r.uv[v * 2 + 1];
    }
  });
  return {
    data, width, height, base, vertices, bytesPerVertex: 32,
    payloadBytes: vertices * 32, textureBytes: width * height * 16,
  };
}

/**
 * The draw ORDER of a bucket whose instances are all visible: geometry runs in
 * first-seen order over ascending slots, slots ascending within a run. This is
 * what batched_runs.js `buildRuns` derives from three's unsorted canonical list
 * (ascending instance id), so the pulled draw emits the SAME primitive sequence
 * as the run draw (GL ES 3.0.6 §2.9.3: DrawElementsInstanced = for each
 * instance, the whole range) — ties in depth resolve the same way too.
 */
export function groupedOrder(instanceGeom) {
  const runOf = new Map();
  const runs = [];
  for (let s = 0; s < instanceGeom.length; s++) {
    const g = instanceGeom[s];
    let r = runOf.get(g);
    if (r === undefined) { r = runs.length; runOf.set(g, r); runs.push({ geom: g, slots: [] }); }
    runs[r].slots.push(s);
  }
  const order = new Int32Array(instanceGeom.length);
  let k = 0;
  const out = runs.map((r) => {
    const first = k;
    for (const s of r.slots) order[k++] = s;
    return { geom: r.geom, first, count: r.slots.length };
  });
  return { order, runs: out };
}

function packEntry(vertex, slot, vbits) {
  return ((slot << vbits) | vertex) >>> 0;
}

/**
 * A NON-INDEXED pull stream: one entry per triangle corner, in `order`.
 * format "packed" (R32UI, 4 B) or "pair" (RG32UI, 8 B). The packed `data` doubles
 * as the STREAM_ATTR vertex attribute (`data.subarray(0, corners)`).
 */
export function buildCornerStream(geoms, arena, instanceGeom, order, format = "packed") {
  const parts = geoms.map(readGeom);
  let corners = 0;
  let maxSlot = 0;
  for (let k = 0; k < order.length; k++) {
    corners += parts[instanceGeom[order[k]]].corners;
    if (order[k] > maxSlot) maxSlot = order[k];
  }
  const bits = packBits(arena.vertices, maxSlot + 1);
  const comps = format === "pair" ? 2 : 1;
  if (comps === 1 && !bits.fits) {
    throw new RangeError(`vertex_pull: ${bits.vbits} vertex + ${bits.sbits} slot bits exceed a packed u32 — use "pair"`);
  }
  const { width, height } = squareDims(corners);
  const data = new Uint32Array(width * height * comps);
  let c = 0;
  for (let k = 0; k < order.length; k++) {
    const slot = order[k];
    const g = instanceGeom[slot];
    const r = parts[g];
    const b = arena.base[g];
    for (let i = 0; i < r.corners; i++, c++) {
      const v = b + r.index[i];
      if (comps === 1) data[c] = packEntry(v, slot, bits.vbits);
      else { data[c * 2] = v; data[c * 2 + 1] = slot; }
    }
  }
  return {
    format, data, comps, width, height, corners, vbits: bits.vbits, sbits: bits.sbits,
    bytesPerCorner: 4 * comps, payloadBytes: corners * 4 * comps, textureBytes: width * height * 4 * comps,
  };
}

/**
 * The INDEXED pull (beyond the spec): a packed stream with one entry per
 * (instance, model vertex) in `order`, and an index buffer of corners into it.
 * gl_VertexID of an indexed draw is the index value (GL ES 3.0.6 §2.9.3 / §11.1.3.9
 * [D]), so the shader is STREAM_PACKED's, unchanged.
 */
export function buildIndexedStream(geoms, arena, instanceGeom, order) {
  const parts = geoms.map(readGeom);
  let entries = 0, corners = 0, maxSlot = 0;
  for (let k = 0; k < order.length; k++) {
    const r = parts[instanceGeom[order[k]]];
    entries += r.count;
    corners += r.corners;
    if (order[k] > maxSlot) maxSlot = order[k];
  }
  const bits = packBits(arena.vertices, maxSlot + 1);
  if (!bits.fits) throw new RangeError("vertex_pull: indexed stream needs a packed u32 (bit budget exceeded)");
  const { width, height } = squareDims(entries);
  const data = new Uint32Array(width * height);
  const Index = entries <= 65535 ? Uint16Array : Uint32Array;
  const index = new Index(corners);
  let e = 0, c = 0;
  for (let k = 0; k < order.length; k++) {
    const slot = order[k];
    const g = instanceGeom[slot];
    const r = parts[g];
    const b = arena.base[g];
    for (let v = 0; v < r.count; v++) data[e + v] = packEntry(b + v, slot, bits.vbits);
    for (let i = 0; i < r.corners; i++) index[c++] = e + r.index[i];
    e += r.count;
  }
  return {
    format: "indexed", data, comps: 1, width, height, entries, corners, index, vbits: bits.vbits, sbits: bits.sbits,
    bytesPerEntry: 4, bytesPerIndex: Index.BYTES_PER_ELEMENT,
    payloadBytes: entries * 4 + corners * Index.BYTES_PER_ELEMENT,
    textureBytes: width * height * 4,
  };
}

// ---------------------------------------------------------------------------
// CPU mirrors of the GLSL addressing (the node test's emulation).
// ---------------------------------------------------------------------------

/** hbPull()'s stream read: entry `i` (gl_VertexID) -> { vertex, slot }. */
export function decodeStreamEntry(stream, i) {
  const x = i % stream.width, y = Math.floor(i / stream.width);
  const off = (y * stream.width + x) * stream.comps;
  if (stream.comps === 2) return { vertex: stream.data[off], slot: stream.data[off + 1] };
  const e = stream.data[off];
  const mask = stream.vbits >= 32 ? 0xffffffff : 2 ** stream.vbits - 1;
  return { vertex: (e & mask) >>> 0, slot: stream.vbits >= 32 ? 0 : e >>> stream.vbits };
}

/** STREAM_ATTR: the attribute value of corner `i` is the packed entry itself. */
export function decodePackedValue(e, vbits) {
  return { vertex: (e & (2 ** vbits - 1)) >>> 0, slot: e >>> vbits };
}

/** hbPull()'s arena read: texels 2v and 2v + 1 (same row, the width is even). */
export function fetchArenaVertex(arena, v) {
  const k = 2 * v;
  const x = k % arena.width, y = Math.floor(k / arena.width);
  const off = (y * arena.width + x) * 4;
  const d = arena.data;
  return { pos: [d[off], d[off + 1], d[off + 2]], nrm: [d[off + 4], d[off + 5], d[off + 6]], uv: [d[off + 3], d[off + 7]] };
}

// ---------------------------------------------------------------------------
// The shader half.
// ---------------------------------------------------------------------------

// Sampler declarations copy three r184's batching_pars_vertex precision exactly
// (matrices: explicit highp; colours: the prefix default, which three sets to
// highp) and getBatchingMatrix / getBatchingColor verbatim, so the matrix and
// colour arithmetic is the same instruction sequence as the BatchedMesh arm.
export const PULL_VERTEX_PARS = `
// vertex_pull (P4 spike, harness/glsl_smoke/vertex_pull_lib.mjs): instance data in
// BatchedMesh's texture layouts, vertex data pulled from the arena by the stream.
#ifndef HB_PULL_STREAM
	#define HB_PULL_STREAM 1
#endif
#ifndef HB_PULL_VBITS
	#define HB_PULL_VBITS 16
#endif
uniform highp sampler2D hbMatrices;
mat4 getBatchingMatrix( const in float i ) {

	int size = textureSize( hbMatrices, 0 ).x;
	int j = int( i ) * 4;
	int x = j % size;
	int y = j / size;
	vec4 v1 = texelFetch( hbMatrices, ivec2( x, y ), 0 );
	vec4 v2 = texelFetch( hbMatrices, ivec2( x + 1, y ), 0 );
	vec4 v3 = texelFetch( hbMatrices, ivec2( x + 2, y ), 0 );
	vec4 v4 = texelFetch( hbMatrices, ivec2( x + 3, y ), 0 );
	return mat4( v1, v2, v3, v4 );

}
#ifdef USE_BATCHING_COLOR
	uniform sampler2D hbColors;
	vec4 getBatchingColor( const in float i ) {

		int size = textureSize( hbColors, 0 ).x;
		int j = int( i );
		int x = j % size;
		int y = j / size;
		return texelFetch( hbColors, ivec2( x, y ), 0 );

	}
#endif
uniform highp sampler2D hbArena;
#if HB_PULL_STREAM == 0
	in highp uint hbPullCorner;
#else
	uniform highp usampler2D hbPullStream;
#endif
vec3 hbPos;
vec3 hbNrm;
vec2 hbUv;
float hbSlot;
void hbPull() {
#if HB_PULL_STREAM == 0
	uint e = hbPullCorner;
	uint v = e & ( ( 1u << HB_PULL_VBITS ) - 1u );
	uint s = e >> HB_PULL_VBITS;
#else
	int sw = textureSize( hbPullStream, 0 ).x;
	uvec4 t = texelFetch( hbPullStream, ivec2( gl_VertexID % sw, gl_VertexID / sw ), 0 );
	#if HB_PULL_STREAM == 2
		uint v = t.r;
		uint s = t.g;
	#else
		uint v = t.r & ( ( 1u << HB_PULL_VBITS ) - 1u );
		uint s = t.r >> HB_PULL_VBITS;
	#endif
#endif
	int aw = textureSize( hbArena, 0 ).x;
	int k = int( v ) * 2;
	ivec2 p = ivec2( k % aw, k / aw );
	vec4 a = texelFetch( hbArena, p, 0 );
	vec4 b = texelFetch( hbArena, p + ivec2( 1, 0 ), 0 );
	hbPos = a.xyz;
	hbNrm = b.xyz;
	hbUv = vec2( a.w, b.w );
	// uint -> float, as three's getIndirectIndex returns it (exact below 2^24).
	hbSlot = float( s );
}
// The redirect: every later use of the prefix attributes reads the pulled values
// (begin_vertex, beginnormal_vertex, uv_vertex via MAP_UV -> uv, app patches).
#define position hbPos
#define normal hbNrm
#define uv hbUv
`;

const INC_PARS = "#include <batching_pars_vertex>";
const INC_VERT = "#include <batching_vertex>";
const INC_COLOR = "#include <color_vertex>";
const MAIN = "void main() {";
// three's colour fetch, stock (gl_DrawID) or under batched_runs.js (hbBatchSlot()).
const COLOR_CALL = /getBatchingColor\(\s*getIndirectIndex\(\s*(?:gl_DrawID|hbBatchSlot\(\s*\))\s*\)\s*\)/g;

function countOf(hay, needle) {
  let n = 0, at = hay.indexOf(needle);
  while (at >= 0) { n++; at = hay.indexOf(needle, at + needle.length); }
  return n;
}

/**
 * Patch a built-in material's vertex BODY (onBeforeCompile's shader.vertexShader)
 * for pulling. `chunks` = THREE.ShaderChunk (patched by batched_runs.js or not —
 * the result is the same). Pure; returns null on any anchor drift.
 */
export function patchPullVertex(vertexShader, chunks, { colors = true } = {}) {
  if (typeof vertexShader !== "string" || !chunks || typeof chunks.color_vertex !== "string") return null;
  for (const a of [INC_PARS, INC_VERT, INC_COLOR, MAIN]) if (countOf(vertexShader, a) !== 1) return null;
  const colorChunk = chunks.color_vertex.replace(COLOR_CALL, "getBatchingColor( hbSlot )");
  if (colorChunk === chunks.color_vertex || /gl_DrawID|getIndirectIndex|hbBatchSlot/.test(colorChunk)) return null;
  const head = "#define USE_BATCHING\n" + (colors ? "#define USE_BATCHING_COLOR\n" : "");
  // Function replacers: a `$` in chunk text must never be read as a pattern.
  return head + vertexShader
    .replace(INC_PARS, () => PULL_VERTEX_PARS)
    .replace(INC_VERT, () => "#ifdef USE_BATCHING\n\tmat4 batchingMatrix = getBatchingMatrix( hbSlot );\n#endif")
    .replace(INC_COLOR, () => colorChunk)
    .replace(MAIN, () => MAIN + "\n\thbPull();");
}

/**
 * The fragment side: three's FRAGMENT prefix defines USE_COLOR_ALPHA for a
 * BatchedMesh with colours (`parameters.vertexAlphas || parameters.batchingColor`),
 * which is what declares and applies vColor there. A plain Mesh gets it here.
 */
export function patchPullFragment(fragmentShader, { colors = true } = {}) {
  if (typeof fragmentShader !== "string") return null;
  if (!colors) return fragmentShader;
  return "#ifndef USE_COLOR_ALPHA\n#define USE_COLOR_ALPHA\n#endif\n" + fragmentShader;
}

/**
 * Turn a fresh built-in material (MeshStandardMaterial here) into a pulled one.
 * `uniforms` = { hbMatrices, hbColors, hbArena, hbPullStream? } textures.
 * customProgramCacheKey is OVERRIDDEN: three's default is
 * `onBeforeCompile.toString()`, identical for every material this factory makes,
 * so two stream encodings would otherwise share one program. The key varies by
 * the compile-time switches only (never per instance or per bucket).
 */
export function makePullMaterial(material, chunks, { stream = STREAM_PACKED, vbits = 16, colors = true, uniforms = {} } = {}) {
  material.defines = Object.assign({}, material.defines, { HB_PULL_STREAM: String(stream), HB_PULL_VBITS: String(vbits) });
  material.onBeforeCompile = (shader) => {
    const vs = patchPullVertex(shader.vertexShader, chunks, { colors });
    const fs = patchPullFragment(shader.fragmentShader, { colors });
    if (vs === null || fs === null) throw new Error("vertex_pull: three's chunk anchors drifted — nothing patched");
    shader.vertexShader = vs;
    shader.fragmentShader = fs;
    for (const k of Object.keys(uniforms)) shader.uniforms[k] = { value: uniforms[k] };
  };
  material.customProgramCacheKey = () => `vertexPull:${stream}:${vbits}:${colors ? 1 : 0}`;
  return material;
}

/**
 * The bucket's geometry: NO position attribute. three r184 renderBufferDirect
 * clamps the draw range by the index, else by `position.count`, else not at all,
 * and returns early on `drawCount === Infinity` — so a non-indexed pulled
 * geometry needs `setDrawRange(0, corners)` and nothing else (no dummy
 * attribute). An indexed one is clamped by its index. The bounding sphere is
 * manual (computeBoundingSphere has no position to read).
 *
 * One marker attribute IS needed: a 1-vertex `normal`. three r184 WebGLPrograms
 * sets `flatShading` for Lambert / Phong / Standard / Physical whenever
 * `geometry.attributes.normal === undefined` (and `vertexNormals` from the same
 * test), so without it the program compiles with FLAT_SHADED instead of
 * HAS_NORMAL and lights with derivative normals — the first smoke run's lit-only
 * diff (unlit and ambient-only arms were identical). The program never reads it
 * (`normal` is #defined to the pulled value), so it stays inactive and unbound;
 * it does not clamp the draw range (only `position` and the index do).
 */
export function makePullGeometry(THREE, { corners, sphere, attr = null, index = null }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(3), 3));
  if (attr) g.setAttribute("hbPullCorner", new THREE.BufferAttribute(attr, 1));
  if (index) g.setIndex(new THREE.BufferAttribute(index, 1));
  else g.setDrawRange(0, corners);
  g.boundingSphere = sphere.clone();
  return g;
}
