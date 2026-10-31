// tests/helpers/gpu_particles_f32.mjs — the f32 twin of the `?gpuParticles`
// vertex shader (scene3d/particles/gpu_particles.js GP_GLSL_HEADER, `hbGpEval`):
// the same statements in source order, `Math.fround` after every GLSL
// operation, the same sin / cos (`hbGpSinCos`: Cody-Waite quadrant reduction +
// the cephes polynomials, no driver transcendental). It reads
// the record and row tables exactly as texelFetch does (record r, texel k at
// floats (r * 8 + k) * 4 of the 2048-wide RGBA32F table).
//
// Used by tests/gpu_particles.test.mjs (twin vs particle.js, per-instance parity
// vs the flag-off buckets) and harness/glsl_smoke/gpu_particles_glsl.mjs.

const f = Math.fround;
const K_2OVERPI = f(0.63661977);
const K_HI = f(1.5703125);
const K_LO = f(0.00048382679);
const K_S0 = f(-1.9515295891e-4), K_S1 = f(8.3321608736e-3), K_S2 = f(1.6666654611e-1);
const K_C0 = f(2.443315711809948e-5), K_C1 = f(1.388731625493765e-3), K_C2 = f(4.166664568298827e-2);
const K_SPIN_MIN = f(0.0002);
const K_EPS = f(1e-10);
const K_UV_EPS = f(1e-8);

/**
 * GLSL `hbGpSinCos`: [sin x, cos x] from + - * floor only (the shader never
 * calls the driver's sin / cos, whose precision GLSL ES 3.00 leaves open).
 * Quadrant k = floor(x 2/pi + 0.5), r = (x - k 1.5703125) - k 0.00048382679
 * (Cody-Waite: k * 1.5703125 exact for |k| < 2^16), the cephes sinf / cosf
 * polynomials in z = r r on [-pi/4, pi/4], then the quadrant's signs / swap.
 * Same operation order as the GLSL, one rounding per operation.
 */
export function sinCosF32(x) {
  x = f(x);
  const k = f(Math.floor(f(f(x * K_2OVERPI) + 0.5)));
  const r = f(f(x - f(k * K_HI)) - f(k * K_LO));
  const z = f(r * r);
  // ( ( -S0 z + S1 ) z - S2 ) z r + r
  const s = f(f(f(f(f(f(f(K_S0 * z) + K_S1) * z) - K_S2) * z) * r) + r);
  // ( ( C0 z - C1 ) z + C2 ) z z - 0.5 z + 1
  const c = f(f(f(f(f(f(f(f(K_C0 * z) - K_C1) * z) + K_C2) * z) * z) - f(0.5 * z)) + 1);
  const q = f(k - f(4 * f(Math.floor(f(k * 0.25)))));
  if (q === 1) return [c, f(-s)];
  if (q === 2) return [f(-s), f(-c)];
  if (q === 3) return [f(-c), s];
  return [s, c];
}
const sin = (x) => sinCosF32(x)[0];
const cos = (x) => sinCosF32(x)[1];
const v3 = (x, y, z) => [f(x), f(y), f(z)];
const add = (a, b) => [f(a[0] + b[0]), f(a[1] + b[1]), f(a[2] + b[2])];
const sub = (a, b) => [f(a[0] - b[0]), f(a[1] - b[1]), f(a[2] - b[2])];
const mul = (a, s) => [f(a[0] * s), f(a[1] * s), f(a[2] * s)];
const dot = (a, b) => f(f(f(a[0] * b[0]) + f(a[1] * b[1])) + f(a[2] * b[2]));
const cross = (a, b) => [f(f(a[1] * b[2]) - f(a[2] * b[1])), f(f(a[2] * b[0]) - f(a[0] * b[2])), f(f(a[0] * b[1]) - f(a[1] * b[0]))];
const norm = (a) => { const l = f(Math.sqrt(dot(a, a))); return [f(a[0] / l), f(a[1] / l), f(a[2] / l)]; };
const norm4 = (q) => {
  const l = f(Math.sqrt(f(f(f(f(q[0] * q[0]) + f(q[1] * q[1])) + f(q[2] * q[2])) + f(q[3] * q[3]))));
  return [f(q[0] / l), f(q[1] / l), f(q[2] / l), f(q[3] / l)];
};
function qmul(a, b) {
  return [
    f(f(f(f(a[0] * b[3]) + f(a[3] * b[0])) + f(a[1] * b[2])) - f(a[2] * b[1])),
    f(f(f(f(a[1] * b[3]) + f(a[3] * b[1])) + f(a[2] * b[0])) - f(a[0] * b[2])),
    f(f(f(f(a[2] * b[3]) + f(a[3] * b[2])) + f(a[0] * b[1])) - f(a[1] * b[0])),
    f(f(f(f(a[3] * b[3]) - f(a[0] * b[0])) - f(a[1] * b[1])) - f(a[2] * b[2])),
  ];
}
/** GLSL `hbGpQMat`: three's compose rotation, columns. */
function qmat(q) {
  const x2 = f(q[0] + q[0]), y2 = f(q[1] + q[1]), z2 = f(q[2] + q[2]);
  const xx = f(q[0] * x2), xy = f(q[0] * y2), xz = f(q[0] * z2);
  const yy = f(q[1] * y2), yz = f(q[1] * z2), zz = f(q[2] * z2);
  const wx = f(q[3] * x2), wy = f(q[3] * y2), wz = f(q[3] * z2);
  return [
    [f(1 - f(yy + zz)), f(xy + wz), f(xz - wy)],
    [f(xy - wz), f(1 - f(xx + zz)), f(yz + wx)],
    [f(xz + wy), f(yz - wx), f(1 - f(xx + yy))],
  ];
}
function unitVectors(fr, to) {
  const r = f(dot(fr, to) + 1);
  let q;
  if (r < K_UV_EPS) q = Math.abs(fr[0]) > Math.abs(fr[2]) ? [f(-fr[1]), fr[0], 0, 0] : [0, f(-fr[2]), fr[1], 0];
  else { const c = cross(fr, to); q = [c[0], c[1], c[2], r]; }
  return norm4(q);
}

function fetch(data, i, k) {
  const o = (i * 8 + k) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

/**
 * Evaluate one instance. `opts.fxColor` = the program carries HB_GP_FXCOLOR,
 * `opts.fxMotion` = HB_FX_MOTION. Returns { m: 16 floats, column-major like
 * three's instanceMatrix, c: 3 floats, v: the velocity row, collapsed }.
 * `opts.singleFloatTime` (T3 negative control): age = Chi + Clo - Thi with the
 * hi/lo split thrown away (one f32 clock, one f32 birth).
 */
export function evalGpF32(recData, rowData, recIndex, opts = {}) {
  const out = { m: new Float32Array(16), c: new Float32Array(3), v: [0, 0, 0], collapsed: true, t: NaN };
  const rec = Math.floor(f(recIndex + 0.5));
  if (rec <= 0) return out;
  const r0 = fetch(recData, rec, 0), r1 = fetch(recData, rec, 1), r2 = fetch(recData, rec, 2);
  const r3 = fetch(recData, rec, 3), r5 = fetch(recData, rec, 5), r6 = fetch(recData, rec, 6);
  const er = Math.floor(f(r6[0] + 0.5));
  const e0 = fetch(rowData, er, 0), e2 = fetch(rowData, er, 2), e3 = fetch(rowData, er, 3);
  const mr = Math.floor(f(e0[3] + 0.5));
  const m0 = fetch(rowData, mr, 0);
  let t;
  if (opts.singleFloatTime) t = f(f(f(m0[0] + m0[1])) - f(r0[3] + r2[3]));
  else t = f(f(m0[0] - r0[3]) + f(m0[1] - r2[3]));
  out.t = t;
  const ls = r1[3];
  const iv = ls > 0 ? Math.min(f(t / ls), 1) : 1;
  const sc = f(r5[0] + f(f(r5[1] - r5[0]) * iv));
  const tr = f(r5[2] + f(f(r5[3] - r5[2]) * iv));
  if (!(tr < 1) || sc === 0) return out;
  const op = Math.min(Math.max(f(1 - tr), 0), 1);
  const ty = Math.floor(f(e3[0] + 0.5));
  const pl = e3[1] > 0.5;
  const A = [r1[0], r1[1], r1[2]];
  const B = [r2[0], r2[1], r2[2]];
  const C = [r3[0], r3[1], r3[2]];
  let P = pl ? add([e0[0], e0[1], e0[2]], [r0[0], r0[1], r0[2]]) : [r0[0], r0[1], r0[2]];
  const tv = Math.max(f(t - f(1.5 * m0[2])), 0);
  let V = [0, 0, 0];
  if (ty === 2 || ty === 12) {
    P = add(P, mul(A, t));
    V = A;
  } else if (ty === 3 || ty === 8 || ty === 10 || ty === 4 || ty === 9 || ty === 11) {
    P = add(P, add(mul(A, t), mul(B, f(f(t * t) * 0.5))));
    V = add(A, mul(B, tv));
  } else if (ty === 5) {
    const w = v3(f(cos(f(t * B[0])) * C[0]), f(sin(f(t * B[1])) * C[1]), f(cos(f(t * B[2])) * C[2]));
    P = add(P, add(w, mul(A, t)));
    V = add(A, v3(
      f(f(f(-B[0]) * sin(f(tv * B[0]))) * C[0]),
      f(f(B[1] * cos(f(tv * B[1]))) * C[1]),
      f(f(f(-B[2]) * sin(f(tv * B[2]))) * C[2])));
  } else if (ty === 6) {
    const inner = add(add(mul(B, t), mul(C, A[0])), [0, 0, A[2]]);
    P = add(P, mul(inner, t));
    V = add(add(mul(B, f(2 * tv)), mul(C, A[0])), [0, 0, A[2]]);
  } else if (ty === 7) {
    P = add(P, add(mul(C, cos(f(A[0] * t))), mul(B, f(t * t))));
    V = add(mul(C, f(f(-A[0]) * sin(f(A[0] * tv)))), mul(B, f(2 * tv)));
  }
  let R = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (ty === 4 || ty === 9 || ty === 11) {
    const qf = pl ? fetch(rowData, er, 1) : fetch(recData, rec, 4);
    const r7 = fetch(recData, rec, 7);
    const th = f(r7[3] * t);
    let sp = [0, 0, 0, 1];
    if (th >= K_SPIN_MIN) {
      const h = sinCosF32(f(0.5 * th));
      sp = [f(r7[0] * h[0]), f(r7[1] * h[0]), f(r7[2] * h[0]), h[1]];
    }
    R = qmat(norm4(qmul(qf, sp)));
  }
  const bb = Math.floor(f(e3[2] + 0.5));
  if (bb !== 0 && m0[3] > 0.5) {
    if (bb === 6) {
      const cw = fetch(rowData, mr, 2);
      const d6 = sub([cw[0], cw[1], cw[2]], P);
      if (dot(d6, d6) >= K_EPS) {
        const nn = fetch(rowData, er, 4);
        R = qmat(unitVectors([nn[0], nn[1], nn[2]], norm(d6)));
      }
    } else {
      const cl = fetch(rowData, mr, 1);
      let d = sub(P, [cl[0], cl[1], cl[2]]);
      if (dot(d, d) >= K_EPS) {
        d = norm(d);
        if (bb === 2) {
          let z = sub([0, 0, 1], mul(d, d[2]));
          if (dot(z, z) >= K_EPS) {
            z = norm(z);
            R = [cross(d, z), d, z];
          }
        } else {
          const keep = norm(bb === 5 ? R[2] : bb === 4 ? R[1] : R[0]);
          let aim = sub(d, mul(keep, dot(d, keep)));
          if (dot(aim, aim) >= K_EPS) {
            aim = norm(aim);
            const third = cross(aim, keep);
            if (bb === 5) R = [third, aim, keep];
            else if (bb === 4) R = [aim, keep, third];
            else R = [keep, third, aim];
          }
        }
      }
    }
  }
  const m = out.m;
  for (let c = 0; c < 3; c++) { m[c * 4] = f(R[c][0] * sc); m[c * 4 + 1] = f(R[c][1] * sc); m[c * 4 + 2] = f(R[c][2] * sc); m[c * 4 + 3] = 0; }
  m[12] = P[0]; m[13] = P[1]; m[14] = P[2]; m[15] = 1;
  if (opts.fxMotion) {
    if (pl) V = add(V, [e2[0], e2[1], e2[2]]);
    if (t < f(0.5 * m0[2]) || dot(V, V) > e3[3]) V = [0, 0, 0];
    m[3] = V[0]; m[7] = V[1]; m[11] = V[2];
  }
  out.v = [V[0], V[1], V[2]];
  if (opts.fxColor) {
    const fa = ls > 0 ? Math.min(Math.max(f(t / ls), 0), 1) : 0;
    const g = fetch(rowData, 0, 0);
    out.c[0] = op; out.c[1] = fa; out.c[2] = f((g[0] > 0.5 ? e2[3] : 0) + r3[3]);
  } else {
    out.c[0] = op; out.c[1] = op; out.c[2] = op;
  }
  out.collapsed = false;
  return out;
}
