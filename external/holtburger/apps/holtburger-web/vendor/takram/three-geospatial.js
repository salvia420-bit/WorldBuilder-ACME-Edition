// node_modules/@takram/three-geospatial/build/index.js
import { Loader as K, FileLoader as ze, BufferGeometry as He, BufferAttribute as Ht, Box3 as We, Vector3 as U2, Sphere as Ve, WebGLRenderer as Ye, LinearFilter as Wt, RGBAFormat as Xe, ByteType as qe, UnsignedByteType as Vt, ShortType as ke, UnsignedShortType as Je, IntType as $e, UnsignedIntType as Qe, HalfFloatType as Ze, FloatType as Yt, MathUtils as _2, Material as pt, Data3DTexture as Ke, DataTexture as tn, Quaternion as en, Matrix4 as nn, Ray as rn, Vector2 as ue } from "three";

// node_modules/@takram/three-geospatial/build/shared.js
var a = true;
var n = "Invariant failed";
function c(i2, r2) {
  if (!i2) {
    if (a)
      throw new Error(n);
    var o = typeof r2 == "function" ? r2() : r2, t = o ? "".concat(n, ": ").concat(o) : n;
    throw new Error(t);
  }
}

// node_modules/@takram/three-geospatial/build/shared2.js
import { BufferGeometry as h, Sphere as u, Vector3 as m, Float32BufferAttribute as r, Loader as T, Data3DTexture as g, FileLoader as f, UnsignedByteType as l, RedFormat as w, NearestFilter as i, RepeatWrapping as a2 } from "three";
var S = 128;
var y = 128;
var E = 64;
var R = "9627216cc50057994c98a2118f3c4a23765d43b9";
var _ = `https://media.githubusercontent.com/media/takram-design-engineering/three-geospatial/${R}/packages/core/assets/stbn.bin`;
var F = class extends h {
  constructor() {
    super(), this.boundingSphere = new u(), this.boundingSphere.set(new m(), 1 / 0), this.setAttribute(
      "position",
      new r([-1, 3, 0, -1, -1, 0, 3, -1, 0], 3)
    ), this.setAttribute("uv", new r([0, -1, 0, 1, 2, 1], 2));
  }
};
var A = class extends T {
  load(o, d, p2, c2) {
    const e = new g(), t = new f(this.manager);
    return t.setPath(this.path), t.setRequestHeader(this.requestHeader), t.setWithCredentials(this.withCredentials), t.setResponseType("arraybuffer"), t.load(
      o,
      (s) => {
        c(s instanceof ArrayBuffer), e.image.data = new Uint8Array(s), e.image.width = S, e.image.height = y, e.image.depth = E, e.type = l, e.format = w, e.minFilter = i, e.magFilter = i, e.wrapS = a2, e.wrapT = a2, e.wrapR = a2, e.needsUpdate = true, d?.(e);
      },
      p2,
      c2
    ), e;
  }
};

// node_modules/@takram/three-geospatial/build/shared3.js
import { Vector3 as a3, Matrix4 as T2, BufferGeometry as W, BufferAttribute as S2 } from "three";
var $ = /* @__PURE__ */ new a3();
function D(q2, t, i2 = new a3(), s) {
  const { x: r2, y: e, z: n2 } = q2, o = t.x, h2 = t.y, u3 = t.z, d = r2 * r2 * o, m3 = e * e * h2, c2 = n2 * n2 * u3, l3 = d + m3 + c2, p2 = Math.sqrt(1 / l3);
  if (!Number.isFinite(p2))
    return;
  const w3 = $.copy(q2).multiplyScalar(p2);
  if (l3 < (s?.centerTolerance ?? 0.1))
    return i2.copy(w3);
  const f2 = w3.multiply(t).multiplyScalar(2);
  let y3 = (1 - p2) * q2.length() / (f2.length() / 2), I2 = 0, x2, M2, g3, v2;
  do {
    y3 -= I2, x2 = 1 / (1 + y3 * o), M2 = 1 / (1 + y3 * h2), g3 = 1 / (1 + y3 * u3);
    const V = x2 * x2, F2 = M2 * M2, L2 = g3 * g3, G2 = V * x2, j2 = F2 * M2, B2 = L2 * g3;
    v2 = d * V + m3 * F2 + c2 * L2 - 1, I2 = v2 / ((d * G2 * o + m3 * j2 * h2 + c2 * B2 * u3) * -2);
  } while (Math.abs(v2) > 1e-12);
  return i2.set(r2 * x2, e * M2, n2 * g3);
}
var E2 = /* @__PURE__ */ new a3();
var R2 = /* @__PURE__ */ new a3();
var U = /* @__PURE__ */ new a3();
var b = class b2 {
  constructor(t, i2, s) {
    this.radii = new a3(t, i2, s);
  }
  // TODO: Rename to semiMinorAxis
  get minimumRadius() {
    return Math.min(this.radii.x, this.radii.y, this.radii.z);
  }
  // TODO: Rename to semiMajorAxis
  get maximumRadius() {
    return Math.max(this.radii.x, this.radii.y, this.radii.z);
  }
  get flattening() {
    return 1 - this.minimumRadius / this.maximumRadius;
  }
  get eccentricity() {
    return Math.sqrt(this.eccentricitySquared);
  }
  get eccentricitySquared() {
    const t = this.maximumRadius ** 2, i2 = this.minimumRadius ** 2;
    return (t - i2) / t;
  }
  reciprocalRadii(t = new a3()) {
    const { x: i2, y: s, z: r2 } = this.radii;
    return t.set(1 / i2, 1 / s, 1 / r2);
  }
  reciprocalRadiiSquared(t = new a3()) {
    const { x: i2, y: s, z: r2 } = this.radii;
    return t.set(1 / i2 ** 2, 1 / s ** 2, 1 / r2 ** 2);
  }
  projectOnSurface(t, i2 = new a3(), s) {
    return D(
      t,
      this.reciprocalRadiiSquared(),
      i2,
      s
    );
  }
  getSurfaceNormal(t, i2 = new a3()) {
    return i2.multiplyVectors(this.reciprocalRadiiSquared(E2), t).normalize();
  }
  getEastNorthUpVectors(t, i2 = new a3(), s = new a3(), r2 = new a3()) {
    this.getSurfaceNormal(t, r2), i2.set(-t.y, t.x, 0).normalize(), s.crossVectors(r2, i2).normalize();
  }
  getEastNorthUpFrame(t, i2 = new T2()) {
    const s = E2, r2 = R2, e = U;
    return this.getEastNorthUpVectors(t, s, r2, e), i2.makeBasis(s, r2, e).setPosition(t);
  }
  getNorthUpEastFrame(t, i2 = new T2()) {
    const s = E2, r2 = R2, e = U;
    return this.getEastNorthUpVectors(t, s, r2, e), i2.makeBasis(r2, e, s).setPosition(t);
  }
  getIntersection(t, i2 = new a3()) {
    const s = this.reciprocalRadii(E2), r2 = R2.copy(s).multiply(t.origin), e = U.copy(s).multiply(t.direction), n2 = r2.lengthSq(), o = e.lengthSq(), h2 = r2.dot(e), u3 = h2 ** 2 - o * (n2 - 1);
    if (n2 === 1)
      return i2.copy(t.origin);
    if (n2 > 1) {
      if (h2 >= 0 || u3 < 0)
        return;
      const d = Math.sqrt(u3), m3 = (-h2 - d) / o, c2 = (-h2 + d) / o;
      return t.at(Math.min(m3, c2), i2);
    }
    if (n2 < 1) {
      const d = h2 ** 2 - o * (n2 - 1), m3 = Math.sqrt(d), c2 = (-h2 + m3) / o;
      return t.at(c2, i2);
    }
    if (h2 < 0)
      return t.at(-h2 / o, i2);
  }
  getOsculatingSphereCenter(t, i2, s = new a3()) {
    c(this.radii.x === this.radii.y);
    const r2 = this.radii.x ** 2, e = this.radii.z ** 2, n2 = E2.set(
      t.x / r2,
      t.y / r2,
      t.z / e
    ).normalize();
    return s.copy(n2.multiplyScalar(-i2).add(t));
  }
  getNormalAtHorizon(t, i2, s = new a3()) {
    c(this.radii.x === this.radii.y);
    const r2 = this.radii.x ** 2, e = this.radii.z ** 2, n2 = t, o = i2;
    let h2 = (n2.x * o.x + n2.y * o.y) / r2 + n2.z * o.z / e;
    h2 /= (n2.x ** 2 + n2.y ** 2) / r2 + n2.z ** 2 / e;
    const u3 = E2.copy(o).multiplyScalar(-h2).add(t);
    return s.set(u3.x / r2, u3.y / r2, u3.z / e).normalize();
  }
};
b.WGS84 = /* @__PURE__ */ new b(
  6378137,
  6378137,
  6356752314245179e-9
);
var N = b;
var Q = class extends W {
  constructor(t = new a3(1, 1, 1), i2 = 32, s = 16) {
    super(), this.type = "EllipsoidGeometry", this.parameters = {
      radii: t,
      longitudeSegments: i2,
      latitudeSegments: s
    }, i2 = Math.max(3, Math.floor(i2)), s = Math.max(2, Math.floor(s));
    const r2 = (i2 + 1) * (s + 1), e = new a3(), n2 = new a3(), o = new Float32Array(r2 * 3), h2 = new Float32Array(r2 * 3), u3 = new Float32Array(r2 * 2), d = [], m3 = [];
    for (let c2 = 0, l3 = 0, p2 = 0, w3 = 0; c2 <= s; ++c2) {
      const f2 = [], y3 = c2 / s, I2 = y3 * Math.PI;
      let x2 = 0;
      c2 === 0 ? x2 = 0.5 / i2 : c2 === s && (x2 = -0.5 / i2);
      for (let M2 = 0; M2 <= i2; ++M2, l3 += 3, p2 += 2, ++w3) {
        const g3 = M2 / i2, v2 = (g3 - 0.5) * Math.PI * 2;
        e.x = t.x * Math.cos(v2) * Math.sin(I2), e.y = t.y * Math.sin(v2) * Math.sin(I2), e.z = t.z * Math.cos(I2), o[l3] = e.x, o[l3 + 1] = e.y, o[l3 + 2] = e.z, n2.copy(e).normalize(), h2[l3] = n2.x, h2[l3 + 1] = n2.y, h2[l3 + 2] = n2.z, u3[p2] = g3 + x2, u3[p2 + 1] = 1 - y3, f2.push(w3);
      }
      d.push(f2);
    }
    for (let c2 = 0; c2 < s; ++c2)
      for (let l3 = 0; l3 < i2; ++l3) {
        const p2 = d[c2][l3 + 1], w3 = d[c2][l3], f2 = d[c2 + 1][l3], y3 = d[c2 + 1][l3 + 1];
        c2 !== 0 && m3.push(p2, w3, y3), c2 !== s - 1 && m3.push(w3, f2, y3);
      }
    this.setIndex(m3), this.setAttribute("position", new S2(o, 3)), this.setAttribute("normal", new S2(h2, 3)), this.setAttribute("uv", new S2(u3, 2));
  }
  copy(t) {
    return super.copy(t), this.parameters = { ...t.parameters }, this;
  }
};
var A2 = /* @__PURE__ */ new a3();
var P = /* @__PURE__ */ new a3();
var z = class z2 {
  constructor(t = 0, i2 = 0, s = 0) {
    this.longitude = t, this.latitude = i2, this.height = s;
  }
  set(t, i2, s) {
    return this.longitude = t, this.latitude = i2, s != null && (this.height = s), this;
  }
  clone() {
    return new z2(this.longitude, this.latitude, this.height);
  }
  copy(t) {
    return this.longitude = t.longitude, this.latitude = t.latitude, this.height = t.height, this;
  }
  equals(t) {
    return t.longitude === this.longitude && t.latitude === this.latitude && t.height === this.height;
  }
  setLongitude(t) {
    return this.longitude = t, this;
  }
  setLatitude(t) {
    return this.latitude = t, this;
  }
  setHeight(t) {
    return this.height = t, this;
  }
  normalize() {
    return this.longitude < z2.MIN_LONGITUDE && (this.longitude += Math.PI * 2), this;
  }
  // See: https://en.wikipedia.org/wiki/Geographic_coordinate_conversion
  // Reference: https://github.com/CesiumGS/cesium/blob/1.122/packages/engine/Source/Core/Geodetic.js#L119
  setFromECEF(t, i2) {
    const r2 = (i2?.ellipsoid ?? N.WGS84).reciprocalRadiiSquared(A2), e = D(
      t,
      r2,
      P,
      i2
    );
    if (e == null)
      throw new Error(
        `Could not project position to ellipsoid surface: ${t.toArray()}`
      );
    const n2 = A2.multiplyVectors(e, r2).normalize();
    this.longitude = Math.atan2(n2.y, n2.x), this.latitude = Math.asin(n2.z);
    const o = A2.subVectors(t, e);
    return this.height = Math.sign(o.dot(t)) * o.length(), this;
  }
  // See: https://en.wikipedia.org/wiki/Geographic_coordinate_conversion
  // Reference: https://github.com/CesiumGS/cesium/blob/1.122/packages/engine/Source/Core/Cartesian3.js#L916
  toECEF(t = new a3(), i2) {
    const s = i2?.ellipsoid ?? N.WGS84, r2 = A2.multiplyVectors(
      s.radii,
      s.radii
    ), e = Math.cos(this.latitude), n2 = P.set(
      e * Math.cos(this.longitude),
      e * Math.sin(this.longitude),
      Math.sin(this.latitude)
    ).normalize();
    return t.multiplyVectors(r2, n2), t.divideScalar(Math.sqrt(n2.dot(t))).add(n2.multiplyScalar(this.height));
  }
  fromArray(t, i2 = 0) {
    return this.longitude = t[i2], this.latitude = t[i2 + 1], this.height = t[i2 + 2], this;
  }
  toArray(t = [], i2 = 0) {
    return t[i2] = this.longitude, t[i2 + 1] = this.latitude, t[i2 + 2] = this.height, t;
  }
  *[Symbol.iterator]() {
    yield this.longitude, yield this.latitude, yield this.height;
  }
};
z.MIN_LONGITUDE = -Math.PI, z.MAX_LONGITUDE = Math.PI, z.MIN_LATITUDE = -Math.PI / 2, z.MAX_LATITUDE = Math.PI / 2;
var C = z;

// node_modules/@takram/three-geospatial/build/index.js
import { EXRLoader as de } from "three/addons/loaders/EXRLoader.js";
var sn = class extends K {
  load(t, n2, r2, o) {
    const s = new ze(this.manager);
    s.setResponseType("arraybuffer"), s.setRequestHeader(this.requestHeader), s.setPath(this.path), s.setWithCredentials(this.withCredentials), s.load(
      t,
      (i2) => {
        c(i2 instanceof ArrayBuffer);
        try {
          n2(i2);
        } catch (c2) {
          o != null ? o(c2) : console.error(c2), this.manager.itemError(t);
        }
      },
      r2,
      o
    );
  }
};
function Ar(e) {
  const { attributes: t, index: n2, boundingBox: r2, boundingSphere: o } = e;
  return [
    { attributes: t, index: n2, boundingBox: r2, boundingSphere: o },
    [
      ...Object.values(e.attributes).map(
        (s) => s.array.buffer
      ),
      e.index?.array.buffer
    ].filter((s) => s != null)
  ];
}
function gr(e, t = new He()) {
  for (const [n2, r2] of Object.entries(e.attributes))
    t.setAttribute(
      n2,
      new Ht(
        r2.array,
        r2.itemSize,
        r2.normalized
      )
    );
  if (t.index = e.index != null ? new Ht(
    e.index.array,
    e.index.itemSize,
    e.index.normalized
  ) : null, e.boundingBox != null) {
    const { min: n2, max: r2 } = e.boundingBox;
    t.boundingBox = new We(
      new U2(n2.x, n2.y, n2.z),
      new U2(r2.x, r2.y, r2.z)
    );
  }
  if (e.boundingSphere != null) {
    const { center: n2, radius: r2 } = e.boundingSphere;
    t.boundingSphere = new Ve(
      new U2(n2.x, n2.y, n2.z),
      r2
    );
  }
  return t;
}
function wr(e) {
  return e instanceof Ye ? e.getContext().getExtension("OES_texture_float_linear") != null : e.backend.hasFeature?.("float32-filterable") ?? false;
}
var on = "This is not an object";
var cn = "This is not a Float16Array object";
var qt = "This constructor is not a subclass of Float16Array";
var pe = "The constructor property value is not an object";
var an = "Species constructor didn't return TypedArray object";
var hn = "Derived constructor created TypedArray object which was too small length";
var J = "Attempting to access detached ArrayBuffer";
var Pt = "Cannot convert undefined or null to object";
var xt = "Cannot mix BigInt and other types, use explicit conversions";
var kt = "@@iterator property is not callable";
var Jt = "Reduce of empty array with no initial value";
var fn = "The comparison function must be either a function or undefined";
var St = "Offset is out of bounds";
function g2(e) {
  return (t, ...n2) => S3(e, t, n2);
}
function H(e, t) {
  return g2(
    v(
      e,
      t
    ).get
  );
}
var {
  apply: S3,
  construct: q,
  defineProperty: $t,
  get: mt,
  getOwnPropertyDescriptor: v,
  getPrototypeOf: tt,
  has: Nt,
  ownKeys: Ae,
  set: Qt,
  setPrototypeOf: ge
} = Reflect;
var ln = Proxy;
var {
  EPSILON: un,
  MAX_SAFE_INTEGER: Zt,
  isFinite: we,
  isNaN: G
} = Number;
var {
  iterator: x,
  species: yn,
  toStringTag: Mt,
  for: dn
} = Symbol;
var j = Object;
var {
  create: At,
  defineProperty: et,
  freeze: pn,
  is: Kt
} = j;
var Lt = j.prototype;
var An = (
  /** @type {any} */
  Lt.__lookupGetter__ ? g2(
    /** @type {any} */
    Lt.__lookupGetter__
  ) : (e, t) => {
    if (e == null)
      throw w2(
        Pt
      );
    let n2 = j(e);
    do {
      const r2 = v(n2, t);
      if (r2 !== void 0)
        return R3(r2, "get") ? r2.get : void 0;
    } while ((n2 = tt(n2)) !== null);
  }
);
var R3 = (
  /** @type {any} */
  j.hasOwn || g2(Lt.hasOwnProperty)
);
var Te = Array;
var be = Te.isArray;
var gt = Te.prototype;
var gn = g2(gt.join);
var wn = g2(gt.push);
var Tn = g2(
  gt.toLocaleString
);
var Bt = gt[x];
var bn = g2(Bt);
var {
  abs: Sn,
  trunc: Se
} = Math;
var wt = ArrayBuffer;
var mn = wt.isView;
var me = wt.prototype;
var _n = g2(me.slice);
var En = H(me, "byteLength");
var Rt = typeof SharedArrayBuffer < "u" ? SharedArrayBuffer : null;
var In = Rt && H(Rt.prototype, "byteLength");
var Ft = tt(Uint8Array);
var On = Ft.from;
var b3 = Ft.prototype;
var Pn = b3[x];
var xn = g2(b3.keys);
var Nn = g2(
  b3.values
);
var Ln = g2(
  b3.entries
);
var Rn = g2(b3.set);
var te = g2(
  b3.reverse
);
var Un = g2(b3.fill);
var Cn = g2(
  b3.copyWithin
);
var ee = g2(b3.sort);
var Y = g2(b3.slice);
var Mn = g2(
  b3.subarray
);
var T3 = H(
  b3,
  "buffer"
);
var C2 = H(
  b3,
  "byteOffset"
);
var y2 = H(
  b3,
  "length"
);
var _e = H(
  b3,
  Mt
);
var Bn = Uint8Array;
var m2 = Uint16Array;
var ne = (...e) => S3(On, m2, e);
var Dt = Uint32Array;
var Fn = Float32Array;
var M = tt([][x]());
var Tt = g2(M.next);
var Dn = g2((function* () {
})().next);
var vn = tt(M);
var Gn = DataView.prototype;
var jn = g2(
  Gn.getUint16
);
var w2 = TypeError;
var _t = RangeError;
var Ee = WeakSet;
var Ie = Ee.prototype;
var zn = g2(Ie.add);
var Hn = g2(Ie.has);
var bt = WeakMap;
var vt = bt.prototype;
var at = g2(vt.get);
var Wn = g2(vt.has);
var Gt = g2(vt.set);
var Oe = new bt();
var Vn = At(null, {
  next: {
    value: function() {
      const t = at(Oe, this);
      return Tt(t);
    }
  },
  [x]: {
    value: function() {
      return this;
    }
  }
});
function k(e) {
  if (e[x] === Bt && M.next === Tt)
    return e;
  const t = At(Vn);
  return Gt(Oe, t, bn(e)), t;
}
var Pe = new bt();
var xe = At(vn, {
  next: {
    value: function() {
      const t = at(Pe, this);
      return Dn(t);
    },
    writable: true,
    configurable: true
  }
});
for (const e of Ae(M))
  e !== "next" && et(xe, e, v(M, e));
function re(e) {
  const t = At(xe);
  return Gt(Pe, t, e), t;
}
function ht(e) {
  return e !== null && typeof e == "object" || typeof e == "function";
}
function se(e) {
  return e !== null && typeof e == "object";
}
function ft(e) {
  return _e(e) !== void 0;
}
function Ut(e) {
  const t = _e(e);
  return t === "BigInt64Array" || t === "BigUint64Array";
}
function Yn(e) {
  try {
    return be(e) ? false : (En(
      /** @type {any} */
      e
    ), true);
  } catch {
    return false;
  }
}
function Ne(e) {
  if (Rt === null)
    return false;
  try {
    return In(
      /** @type {any} */
      e
    ), true;
  } catch {
    return false;
  }
}
function Xn(e) {
  return Yn(e) || Ne(e);
}
function oe(e) {
  return be(e) ? e[x] === Bt && M.next === Tt : false;
}
function qn(e) {
  return ft(e) ? e[x] === Pn && M.next === Tt : false;
}
function nt(e) {
  if (typeof e != "string")
    return false;
  const t = +e;
  return e !== t + "" || !we(t) ? false : t === Se(t);
}
var lt = dn("__Float16Array__");
function kn(e) {
  if (!se(e))
    return false;
  const t = tt(e);
  if (!se(t))
    return false;
  const n2 = t.constructor;
  if (n2 === void 0)
    return false;
  if (!ht(n2))
    throw w2(pe);
  return Nt(n2, lt);
}
var Ct = 1 / un;
function Jn(e) {
  return e + Ct - Ct;
}
var Le = 6103515625e-14;
var $n = 65504;
var Re = 9765625e-10;
var ie = Re * Le;
var Qn = Re * Ct;
function Zn(e) {
  const t = +e;
  if (!we(t) || t === 0)
    return t;
  const n2 = t > 0 ? 1 : -1, r2 = Sn(t);
  if (r2 < Le)
    return n2 * Jn(r2 / ie) * ie;
  const o = (1 + Qn) * r2, s = o - (o - r2);
  return s > $n || G(s) ? n2 * (1 / 0) : n2 * s;
}
var Ue = new wt(4);
var Ce = new Fn(Ue);
var Me = new Dt(Ue);
var E3 = new m2(512);
var I = new Bn(512);
for (let e = 0; e < 256; ++e) {
  const t = e - 127;
  t < -24 ? (E3[e] = 0, E3[e | 256] = 32768, I[e] = 24, I[e | 256] = 24) : t < -14 ? (E3[e] = 1024 >> -t - 14, E3[e | 256] = 1024 >> -t - 14 | 32768, I[e] = -t - 1, I[e | 256] = -t - 1) : t <= 15 ? (E3[e] = t + 15 << 10, E3[e | 256] = t + 15 << 10 | 32768, I[e] = 13, I[e | 256] = 13) : t < 128 ? (E3[e] = 31744, E3[e | 256] = 64512, I[e] = 24, I[e | 256] = 24) : (E3[e] = 31744, E3[e | 256] = 64512, I[e] = 13, I[e | 256] = 13);
}
function P2(e) {
  Ce[0] = Zn(e);
  const t = Me[0], n2 = t >> 23 & 511;
  return E3[n2] + ((t & 8388607) >> I[n2]);
}
var jt = new Dt(2048);
for (let e = 1; e < 1024; ++e) {
  let t = e << 13, n2 = 0;
  for (; (t & 8388608) === 0; )
    t <<= 1, n2 -= 8388608;
  t &= -8388609, n2 += 947912704, jt[e] = t | n2;
}
for (let e = 1024; e < 2048; ++e)
  jt[e] = 939524096 + (e - 1024 << 13);
var W2 = new Dt(64);
for (let e = 1; e < 31; ++e)
  W2[e] = e << 23;
W2[31] = 1199570944;
W2[32] = 2147483648;
for (let e = 33; e < 63; ++e)
  W2[e] = 2147483648 + (e - 32 << 23);
W2[63] = 3347054592;
var Be = new m2(64);
for (let e = 1; e < 64; ++e)
  e !== 32 && (Be[e] = 1024);
function p(e) {
  const t = e >> 10;
  return Me[0] = jt[Be[t] + (e & 1023)] + W2[t], Ce[0];
}
function L(e) {
  const t = +e;
  return G(t) || t === 0 ? 0 : Se(t);
}
function Et(e) {
  const t = L(e);
  return t < 0 ? 0 : t < Zt ? t : Zt;
}
function rt(e, t) {
  if (!ht(e))
    throw w2(on);
  const n2 = e.constructor;
  if (n2 === void 0)
    return t;
  if (!ht(n2))
    throw w2(pe);
  const r2 = n2[yn];
  return r2 ?? t;
}
function $2(e) {
  if (Ne(e))
    return false;
  try {
    return _n(e, 0, 0), false;
  } catch {
  }
  return true;
}
function ce(e, t) {
  const n2 = G(e), r2 = G(t);
  if (n2 && r2)
    return 0;
  if (n2)
    return 1;
  if (r2 || e < t)
    return -1;
  if (e > t)
    return 1;
  if (e === 0 && t === 0) {
    const o = Kt(e, 0), s = Kt(t, 0);
    if (!o && s)
      return -1;
    if (o && !s)
      return 1;
  }
  return 0;
}
var zt = 2;
var ut = new bt();
function D2(e) {
  return Wn(ut, e) || !mn(e) && kn(e);
}
function u2(e) {
  if (!D2(e))
    throw w2(cn);
}
function st(e, t) {
  const n2 = D2(e), r2 = ft(e);
  if (!n2 && !r2)
    throw w2(an);
  if (typeof t == "number") {
    let o;
    if (n2) {
      const s = l2(e);
      o = y2(s);
    } else
      o = y2(e);
    if (o < t)
      throw w2(
        hn
      );
  }
  if (Ut(e))
    throw w2(xt);
}
function l2(e) {
  const t = at(ut, e);
  if (t !== void 0) {
    const o = T3(t);
    if ($2(o))
      throw w2(J);
    return t;
  }
  const n2 = (
    /** @type {any} */
    e.buffer
  );
  if ($2(n2))
    throw w2(J);
  const r2 = q(A3, [
    n2,
    /** @type {any} */
    e.byteOffset,
    /** @type {any} */
    e.length
  ], e.constructor);
  return at(ut, r2);
}
function ae(e) {
  const t = y2(e), n2 = [];
  for (let r2 = 0; r2 < t; ++r2)
    n2[r2] = p(e[r2]);
  return n2;
}
var Fe = new Ee();
for (const e of Ae(b3)) {
  if (e === Mt)
    continue;
  const t = v(b3, e);
  R3(t, "get") && typeof t.get == "function" && zn(Fe, t.get);
}
var Kn = pn(
  /** @type {ProxyHandler<Float16BitsArray>} */
  {
    get(e, t, n2) {
      return nt(t) && R3(e, t) ? p(mt(e, t)) : Hn(Fe, An(e, t)) ? mt(e, t) : mt(e, t, n2);
    },
    set(e, t, n2, r2) {
      return nt(t) && R3(e, t) ? Qt(e, t, P2(n2)) : Qt(e, t, n2, r2);
    },
    getOwnPropertyDescriptor(e, t) {
      if (nt(t) && R3(e, t)) {
        const n2 = v(e, t);
        return n2.value = p(n2.value), n2;
      }
      return v(e, t);
    },
    defineProperty(e, t, n2) {
      return nt(t) && R3(e, t) && R3(n2, "value") && (n2.value = P2(n2.value)), $t(e, t, n2);
    }
  }
);
var A3 = class _A {
  /** @see https://tc39.es/ecma262/#sec-typedarray */
  constructor(t, n2, r2) {
    let o;
    if (D2(t))
      o = q(m2, [l2(t)], new.target);
    else if (ht(t) && !Xn(t)) {
      let i2, c2;
      if (ft(t)) {
        i2 = t, c2 = y2(t);
        const a4 = T3(t);
        if ($2(a4))
          throw w2(J);
        if (Ut(t))
          throw w2(xt);
        const h2 = new wt(
          c2 * zt
        );
        o = q(m2, [h2], new.target);
      } else {
        const a4 = t[x];
        if (a4 != null && typeof a4 != "function")
          throw w2(kt);
        a4 != null ? oe(t) ? (i2 = t, c2 = t.length) : (i2 = [.../** @type {Iterable<unknown>} */
        t], c2 = i2.length) : (i2 = /** @type {ArrayLike<unknown>} */
        t, c2 = Et(i2.length)), o = q(m2, [c2], new.target);
      }
      for (let a4 = 0; a4 < c2; ++a4)
        o[a4] = P2(i2[a4]);
    } else
      o = q(m2, arguments, new.target);
    const s = (
      /** @type {any} */
      new ln(o, Kn)
    );
    return Gt(ut, s, o), s;
  }
  /**
   * limitation: `Object.getOwnPropertyNames(Float16Array)` or `Reflect.ownKeys(Float16Array)` include this key
   * @see https://tc39.es/ecma262/#sec-%typedarray%.from
   */
  static from(t, ...n2) {
    const r2 = this;
    if (!Nt(r2, lt))
      throw w2(
        qt
      );
    if (r2 === _A) {
      if (D2(t) && n2.length === 0) {
        const f2 = l2(t), d = new m2(
          T3(f2),
          C2(f2),
          y2(f2)
        );
        return new _A(
          T3(Y(d))
        );
      }
      if (n2.length === 0)
        return new _A(
          T3(
            ne(t, P2)
          )
        );
      const a4 = n2[0], h2 = n2[1];
      return new _A(
        T3(
          ne(t, function(f2, ...d) {
            return P2(
              S3(a4, this, [f2, ...k(d)])
            );
          }, h2)
        )
      );
    }
    let o, s;
    const i2 = t[x];
    if (i2 != null && typeof i2 != "function")
      throw w2(kt);
    if (i2 != null)
      oe(t) ? (o = t, s = t.length) : qn(t) ? (o = t, s = y2(t)) : (o = [...t], s = o.length);
    else {
      if (t == null)
        throw w2(
          Pt
        );
      o = j(t), s = Et(o.length);
    }
    const c2 = new r2(s);
    if (n2.length === 0)
      for (let a4 = 0; a4 < s; ++a4)
        c2[a4] = /** @type {number} */
        o[a4];
    else {
      const a4 = n2[0], h2 = n2[1];
      for (let f2 = 0; f2 < s; ++f2)
        c2[f2] = S3(a4, h2, [o[f2], f2]);
    }
    return c2;
  }
  /**
   * limitation: `Object.getOwnPropertyNames(Float16Array)` or `Reflect.ownKeys(Float16Array)` include this key
   * @see https://tc39.es/ecma262/#sec-%typedarray%.of
   */
  static of(...t) {
    const n2 = this;
    if (!Nt(n2, lt))
      throw w2(
        qt
      );
    const r2 = t.length;
    if (n2 === _A) {
      const s = new _A(r2), i2 = l2(s);
      for (let c2 = 0; c2 < r2; ++c2)
        i2[c2] = P2(t[c2]);
      return s;
    }
    const o = new n2(r2);
    for (let s = 0; s < r2; ++s)
      o[s] = t[s];
    return o;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.keys */
  keys() {
    u2(this);
    const t = l2(this);
    return xn(t);
  }
  /**
   * limitation: returns a object whose prototype is not `%ArrayIteratorPrototype%`
   * @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.values
   */
  values() {
    u2(this);
    const t = l2(this);
    return re((function* () {
      for (const n2 of Nn(t))
        yield p(n2);
    })());
  }
  /**
   * limitation: returns a object whose prototype is not `%ArrayIteratorPrototype%`
   * @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.entries
   */
  entries() {
    u2(this);
    const t = l2(this);
    return re((function* () {
      for (const [n2, r2] of Ln(t))
        yield (
          /** @type {[number, number]} */
          [n2, p(r2)]
        );
    })());
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.at */
  at(t) {
    u2(this);
    const n2 = l2(this), r2 = y2(n2), o = L(t), s = o >= 0 ? o : r2 + o;
    if (!(s < 0 || s >= r2))
      return p(n2[s]);
  }
  /** @see https://tc39.es/proposal-change-array-by-copy/#sec-%typedarray%.prototype.with */
  with(t, n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = L(t), i2 = s >= 0 ? s : o + s, c2 = +n2;
    if (i2 < 0 || i2 >= o)
      throw _t(St);
    const a4 = new m2(
      T3(r2),
      C2(r2),
      y2(r2)
    ), h2 = new _A(
      T3(
        Y(a4)
      )
    ), f2 = l2(h2);
    return f2[i2] = P2(c2), h2;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.map */
  map(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0], i2 = rt(r2, _A);
    if (i2 === _A) {
      const a4 = new _A(o), h2 = l2(a4);
      for (let f2 = 0; f2 < o; ++f2) {
        const d = p(r2[f2]);
        h2[f2] = P2(
          S3(t, s, [d, f2, this])
        );
      }
      return a4;
    }
    const c2 = new i2(o);
    st(c2, o);
    for (let a4 = 0; a4 < o; ++a4) {
      const h2 = p(r2[a4]);
      c2[a4] = S3(t, s, [h2, a4, this]);
    }
    return (
      /** @type {any} */
      c2
    );
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.filter */
  filter(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0], i2 = [];
    for (let h2 = 0; h2 < o; ++h2) {
      const f2 = p(r2[h2]);
      S3(t, s, [f2, h2, this]) && wn(i2, f2);
    }
    const c2 = rt(r2, _A), a4 = new c2(i2);
    return st(a4), /** @type {any} */
    a4;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.reduce */
  reduce(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2);
    if (o === 0 && n2.length === 0)
      throw w2(Jt);
    let s, i2;
    n2.length === 0 ? (s = p(r2[0]), i2 = 1) : (s = n2[0], i2 = 0);
    for (let c2 = i2; c2 < o; ++c2)
      s = t(
        s,
        p(r2[c2]),
        c2,
        this
      );
    return s;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.reduceright */
  reduceRight(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2);
    if (o === 0 && n2.length === 0)
      throw w2(Jt);
    let s, i2;
    n2.length === 0 ? (s = p(r2[o - 1]), i2 = o - 2) : (s = n2[0], i2 = o - 1);
    for (let c2 = i2; c2 >= 0; --c2)
      s = t(
        s,
        p(r2[c2]),
        c2,
        this
      );
    return s;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.foreach */
  forEach(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = 0; i2 < o; ++i2)
      S3(t, s, [
        p(r2[i2]),
        i2,
        this
      ]);
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.find */
  find(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = 0; i2 < o; ++i2) {
      const c2 = p(r2[i2]);
      if (S3(t, s, [c2, i2, this]))
        return c2;
    }
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.findindex */
  findIndex(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = 0; i2 < o; ++i2) {
      const c2 = p(r2[i2]);
      if (S3(t, s, [c2, i2, this]))
        return i2;
    }
    return -1;
  }
  /** @see https://tc39.es/proposal-array-find-from-last/index.html#sec-%typedarray%.prototype.findlast */
  findLast(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = o - 1; i2 >= 0; --i2) {
      const c2 = p(r2[i2]);
      if (S3(t, s, [c2, i2, this]))
        return c2;
    }
  }
  /** @see https://tc39.es/proposal-array-find-from-last/index.html#sec-%typedarray%.prototype.findlastindex */
  findLastIndex(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = o - 1; i2 >= 0; --i2) {
      const c2 = p(r2[i2]);
      if (S3(t, s, [c2, i2, this]))
        return i2;
    }
    return -1;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.every */
  every(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = 0; i2 < o; ++i2)
      if (!S3(t, s, [
        p(r2[i2]),
        i2,
        this
      ]))
        return false;
    return true;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.some */
  some(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2), s = n2[0];
    for (let i2 = 0; i2 < o; ++i2)
      if (S3(t, s, [
        p(r2[i2]),
        i2,
        this
      ]))
        return true;
    return false;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.set */
  set(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = L(n2[0]);
    if (o < 0)
      throw _t(St);
    if (t == null)
      throw w2(
        Pt
      );
    if (Ut(t))
      throw w2(
        xt
      );
    if (D2(t))
      return Rn(
        l2(this),
        l2(t),
        o
      );
    if (ft(t)) {
      const a4 = T3(t);
      if ($2(a4))
        throw w2(J);
    }
    const s = y2(r2), i2 = j(t), c2 = Et(i2.length);
    if (o === 1 / 0 || c2 + o > s)
      throw _t(St);
    for (let a4 = 0; a4 < c2; ++a4)
      r2[a4 + o] = P2(i2[a4]);
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.reverse */
  reverse() {
    u2(this);
    const t = l2(this);
    return te(t), this;
  }
  /** @see https://tc39.es/proposal-change-array-by-copy/#sec-%typedarray%.prototype.toReversed */
  toReversed() {
    u2(this);
    const t = l2(this), n2 = new m2(
      T3(t),
      C2(t),
      y2(t)
    ), r2 = new _A(
      T3(
        Y(n2)
      )
    ), o = l2(r2);
    return te(o), r2;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.fill */
  fill(t, ...n2) {
    u2(this);
    const r2 = l2(this);
    return Un(
      r2,
      P2(t),
      ...k(n2)
    ), this;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.copywithin */
  copyWithin(t, n2, ...r2) {
    u2(this);
    const o = l2(this);
    return Cn(o, t, n2, ...k(r2)), this;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.sort */
  sort(t) {
    u2(this);
    const n2 = l2(this), r2 = t !== void 0 ? t : ce;
    return ee(n2, (o, s) => r2(p(o), p(s))), this;
  }
  /** @see https://tc39.es/proposal-change-array-by-copy/#sec-%typedarray%.prototype.toSorted */
  toSorted(t) {
    u2(this);
    const n2 = l2(this);
    if (t !== void 0 && typeof t != "function")
      throw new w2(fn);
    const r2 = t !== void 0 ? t : ce, o = new m2(
      T3(n2),
      C2(n2),
      y2(n2)
    ), s = new _A(
      T3(
        Y(o)
      )
    ), i2 = l2(s);
    return ee(i2, (c2, a4) => r2(p(c2), p(a4))), s;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.slice */
  slice(t, n2) {
    u2(this);
    const r2 = l2(this), o = rt(r2, _A);
    if (o === _A) {
      const je = new m2(
        T3(r2),
        C2(r2),
        y2(r2)
      );
      return new _A(
        T3(
          Y(je, t, n2)
        )
      );
    }
    const s = y2(r2), i2 = L(t), c2 = n2 === void 0 ? s : L(n2);
    let a4;
    i2 === -1 / 0 ? a4 = 0 : i2 < 0 ? a4 = s + i2 > 0 ? s + i2 : 0 : a4 = s < i2 ? s : i2;
    let h2;
    c2 === -1 / 0 ? h2 = 0 : c2 < 0 ? h2 = s + c2 > 0 ? s + c2 : 0 : h2 = s < c2 ? s : c2;
    const f2 = h2 - a4 > 0 ? h2 - a4 : 0, d = new o(f2);
    if (st(d, f2), f2 === 0)
      return d;
    const O = T3(r2);
    if ($2(O))
      throw w2(J);
    let F2 = 0;
    for (; a4 < h2; )
      d[F2] = p(r2[a4]), ++a4, ++F2;
    return (
      /** @type {any} */
      d
    );
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.subarray */
  subarray(t, n2) {
    u2(this);
    const r2 = l2(this), o = rt(r2, _A), s = new m2(
      T3(r2),
      C2(r2),
      y2(r2)
    ), i2 = Mn(s, t, n2), c2 = new o(
      T3(i2),
      C2(i2),
      y2(i2)
    );
    return st(c2), /** @type {any} */
    c2;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.indexof */
  indexOf(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2);
    let s = L(n2[0]);
    if (s === 1 / 0)
      return -1;
    s < 0 && (s += o, s < 0 && (s = 0));
    for (let i2 = s; i2 < o; ++i2)
      if (R3(r2, i2) && p(r2[i2]) === t)
        return i2;
    return -1;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.lastindexof */
  lastIndexOf(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2);
    let s = n2.length >= 1 ? L(n2[0]) : o - 1;
    if (s === -1 / 0)
      return -1;
    s >= 0 ? s = s < o - 1 ? s : o - 1 : s += o;
    for (let i2 = s; i2 >= 0; --i2)
      if (R3(r2, i2) && p(r2[i2]) === t)
        return i2;
    return -1;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.includes */
  includes(t, ...n2) {
    u2(this);
    const r2 = l2(this), o = y2(r2);
    let s = L(n2[0]);
    if (s === 1 / 0)
      return false;
    s < 0 && (s += o, s < 0 && (s = 0));
    const i2 = G(t);
    for (let c2 = s; c2 < o; ++c2) {
      const a4 = p(r2[c2]);
      if (i2 && G(a4) || a4 === t)
        return true;
    }
    return false;
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.join */
  join(t) {
    u2(this);
    const n2 = l2(this), r2 = ae(n2);
    return gn(r2, t);
  }
  /** @see https://tc39.es/ecma262/#sec-%typedarray%.prototype.tolocalestring */
  toLocaleString(...t) {
    u2(this);
    const n2 = l2(this), r2 = ae(n2);
    return Tn(r2, ...k(t));
  }
  /** @see https://tc39.es/ecma262/#sec-get-%typedarray%.prototype-@@tostringtag */
  get [Mt]() {
    if (D2(this))
      return (
        /** @type {any} */
        "Float16Array"
      );
  }
};
et(A3, "BYTES_PER_ELEMENT", {
  value: zt
});
et(A3, lt, {});
ge(A3, Ft);
var yt = A3.prototype;
et(yt, "BYTES_PER_ELEMENT", {
  value: zt
});
et(yt, x, {
  value: yt.values,
  writable: true,
  configurable: true
});
ge(yt, b3);
function tr(e, t, ...n2) {
  return p(
    jn(e, t, ...k(n2))
  );
}
function Tr(e) {
  return e instanceof Int8Array || e instanceof Uint8Array || e instanceof Uint8ClampedArray || e instanceof Int16Array || e instanceof Uint16Array || e instanceof Int32Array || e instanceof Uint32Array || e instanceof A3 || e instanceof Float32Array || e instanceof Float64Array;
}
var er = class extends K {
  constructor(t, n2) {
    super(n2), this.parser = t;
  }
  load(t, n2, r2, o) {
    const s = new sn(this.manager);
    s.setRequestHeader(this.requestHeader), s.setPath(this.path), s.setWithCredentials(this.withCredentials), s.load(
      t,
      (i2) => {
        try {
          n2(this.parser(i2));
        } catch (c2) {
          o != null ? o(c2) : console.error(c2), this.manager.itemError(t);
        }
      },
      r2,
      o
    );
  }
};
function nr(e) {
  const t = e instanceof Int8Array ? qe : e instanceof Uint8Array ? Vt : e instanceof Uint8ClampedArray ? Vt : e instanceof Int16Array ? ke : e instanceof Uint16Array ? Je : e instanceof Int32Array ? $e : e instanceof Uint32Array ? Qe : e instanceof A3 ? Ze : e instanceof Float32Array ? Yt : e instanceof Float64Array ? Yt : null;
  return c(t != null), t;
}
var br = class extends K {
  constructor(t, n2, r2 = {}, o) {
    super(o), this.textureClass = t, this.parser = n2, this.options = {
      format: Xe,
      minFilter: Wt,
      magFilter: Wt,
      ...r2
    };
  }
  load(t, n2, r2, o) {
    const s = new this.textureClass(), i2 = new er(this.parser, this.manager);
    return i2.setRequestHeader(this.requestHeader), i2.setPath(this.path), i2.setWithCredentials(this.withCredentials), i2.load(
      t,
      (c2) => {
        s.image.data = c2 instanceof A3 ? new Uint16Array(c2.buffer) : c2;
        const { width: a4, height: h2, depth: f2, ...d } = this.options;
        a4 != null && (s.image.width = a4), h2 != null && (s.image.height = h2), "depth" in s.image && f2 != null && (s.image.depth = f2), s.type = nr(c2), Object.assign(s, d), s.needsUpdate = true, n2?.(s);
      },
      r2,
      o
    ), s;
  }
};
var z3 = _2.clamp;
var Sr = _2.euclideanModulo;
var mr = _2.inverseLerp;
var _r = _2.lerp;
var Er = _2.degToRad;
var Ir = _2.radToDeg;
var Or = _2.isPowerOfTwo;
var Pr = _2.ceilPowerOfTwo;
var xr = _2.floorPowerOfTwo;
var Nr = _2.normalize;
function Lr(e, t, n2, r2 = 0, o = 1) {
  return _2.mapLinear(e, t, n2, r2, o);
}
function Rr(e, t, n2, r2 = 0, o = 1) {
  return z3(_2.mapLinear(e, t, n2, r2, o), r2, o);
}
function Ur(e, t, n2) {
  return n2 <= e ? 0 : n2 >= t ? 1 : (n2 = (n2 - e) / (t - e), n2 * n2 * (3 - 2 * n2));
}
function Cr(e) {
  return Math.min(Math.max(e, 0), 1);
}
function Mr(e, t, n2, r2 = n2) {
  const o = Math.abs(e - t);
  return o <= r2 || o <= n2 * Math.max(Math.abs(e), Math.abs(t));
}
function Br(e) {
  return (t, n2) => {
    t instanceof pt ? Object.defineProperty(t, n2, {
      enumerable: true,
      get() {
        return this.defines?.[e] != null;
      },
      set(r2) {
        r2 !== this[n2] && (r2 ? (this.defines ??= {}, this.defines[e] = "1") : delete this.defines?.[e], this.needsUpdate = true);
      }
    }) : Object.defineProperty(t, n2, {
      enumerable: true,
      get() {
        return this.defines.has(e);
      },
      set(r2) {
        r2 !== this[n2] && (r2 ? this.defines.set(e, "1") : this.defines.delete(e), this.setChanged());
      }
    });
  };
}
function he(e) {
  return typeof e == "number" ? Math.floor(e) : typeof e == "string" ? parseInt(e, 10) : typeof e == "boolean" ? +e : 0;
}
function Fr(e, {
  min: t = Number.MIN_SAFE_INTEGER,
  max: n2 = Number.MAX_SAFE_INTEGER
} = {}) {
  return (r2, o) => {
    r2 instanceof pt ? Object.defineProperty(r2, o, {
      enumerable: true,
      get() {
        const s = this.defines?.[e];
        return s != null ? he(s) : 0;
      },
      set(s) {
        const i2 = this[o];
        s !== i2 && (this.defines ??= {}, this.defines[e] = z3(s, t, n2).toFixed(0), this.needsUpdate = true);
      }
    }) : Object.defineProperty(r2, o, {
      enumerable: true,
      get() {
        const s = this.defines.get(e);
        return s != null ? he(s) : 0;
      },
      set(s) {
        const i2 = this[o];
        s !== i2 && (this.defines.set(e, z3(s, t, n2).toFixed(0)), this.setChanged());
      }
    });
  };
}
function fe(e) {
  return typeof e == "number" ? e : typeof e == "string" ? parseFloat(e) : typeof e == "boolean" ? +e : 0;
}
function Dr(e, {
  min: t = -1 / 0,
  max: n2 = 1 / 0,
  precision: r2 = 7
} = {}) {
  return (o, s) => {
    o instanceof pt ? Object.defineProperty(o, s, {
      enumerable: true,
      get() {
        const i2 = this.defines?.[e];
        return i2 != null ? fe(i2) : 0;
      },
      set(i2) {
        const c2 = this[s];
        i2 !== c2 && (this.defines ??= {}, this.defines[e] = z3(i2, t, n2).toFixed(r2), this.needsUpdate = true);
      }
    }) : Object.defineProperty(o, s, {
      enumerable: true,
      get() {
        const i2 = this.defines.get(e);
        return i2 != null ? fe(i2) : 0;
      },
      set(i2) {
        const c2 = this[s];
        i2 !== c2 && (this.defines.set(e, z3(i2, t, n2).toFixed(r2)), this.setChanged());
      }
    });
  };
}
function vr(e, { validate: t } = {}) {
  return (n2, r2) => {
    n2 instanceof pt ? Object.defineProperty(n2, r2, {
      enumerable: true,
      get() {
        return this.defines?.[e];
      },
      set(o) {
        if (o !== this[r2]) {
          if (t?.(o) === false) {
            console.error(`Expression validation failed: ${o}`);
            return;
          }
          this.defines ??= {}, this.defines[e] = o, this.needsUpdate = true;
        }
      }
    }) : Object.defineProperty(n2, r2, {
      enumerable: true,
      get() {
        return this.defines.get(e);
      },
      set(o) {
        if (o !== this[r2]) {
          if (t?.(o) === false) {
            console.error(`Expression validation failed: ${o}`);
            return;
          }
          this.defines.set(e, o), this.setChanged();
        }
      }
    });
  };
}
function Gr(e, ...t) {
  const n2 = {};
  for (let r2 = 0; r2 < t.length; r2 += 2) {
    const o = t[r2], s = t[r2 + 1];
    for (const i2 of s)
      n2[i2] = {
        enumerable: true,
        get: () => o[i2],
        set: (c2) => {
          o[i2] = c2;
        }
      };
  }
  return Object.defineProperties(e, n2), e;
}
function jr(e, t, n2) {
  const r2 = {};
  for (const o of n2)
    r2[o] = {
      enumerable: true,
      get: () => t.uniforms[o].value,
      set: (s) => {
        t.uniforms[o].value = s;
      }
    };
  return Object.defineProperties(e, r2), e;
}
var zr = class extends K {
  constructor(t = {}, n2) {
    super(n2), this.options = t;
  }
  load(t, n2, r2, o) {
    const { width: s, height: i2, depth: c2 } = this.options, a4 = new Ke(null, s, i2, c2), h2 = new de(this.manager);
    return h2.setRequestHeader(this.requestHeader), h2.setPath(this.path), h2.setWithCredentials(this.withCredentials), h2.load(
      t,
      (f2) => {
        const { image: d } = f2;
        a4.image = {
          data: d.data,
          width: s ?? d.width,
          height: i2 ?? d.height,
          depth: c2 ?? Math.sqrt(d.height)
        }, a4.type = f2.type, a4.format = f2.format, a4.colorSpace = f2.colorSpace, a4.needsUpdate = true;
        try {
          n2?.(a4);
        } catch (O) {
          o != null ? o(O) : console.error(O), this.manager.itemError(t);
        }
      },
      r2,
      o
    ), a4;
  }
};
var Hr = class extends K {
  constructor(t = {}, n2) {
    super(n2), this.options = t;
  }
  load(t, n2, r2, o) {
    const { width: s, height: i2 } = this.options, c2 = new tn(null, s, i2), a4 = new de(this.manager);
    return a4.setRequestHeader(this.requestHeader), a4.setPath(this.path), a4.setWithCredentials(this.withCredentials), a4.load(
      t,
      (h2) => {
        const { image: f2 } = h2;
        c2.image = {
          data: f2.data,
          width: s ?? f2.width,
          height: i2 ?? f2.height
        }, c2.type = h2.type, c2.format = h2.format, c2.colorSpace = h2.colorSpace, c2.needsUpdate = true;
        try {
          n2?.(c2);
        } catch (d) {
          o != null ? o(d) : console.error(d), this.manager.itemError(t);
        }
      },
      r2,
      o
    ), c2;
  }
};
var It = 1e-6;
var ot = /* @__PURE__ */ new U2();
var it = /* @__PURE__ */ new U2();
var N2 = /* @__PURE__ */ new U2();
var X = /* @__PURE__ */ new U2();
var Ot = /* @__PURE__ */ new U2();
var rr = /* @__PURE__ */ new U2();
var sr = /* @__PURE__ */ new nn();
var or = /* @__PURE__ */ new en();
var ir = /* @__PURE__ */ new rn();
var De = class _De {
  constructor(t = 0, n2 = 0, r2 = 0, o = 0) {
    this.distance = t, this.heading = n2, this.pitch = r2, this.roll = o;
  }
  get distance() {
    return this._distance;
  }
  set distance(t) {
    this._distance = Math.max(t, It);
  }
  get pitch() {
    return this._pitch;
  }
  set pitch(t) {
    this._pitch = z3(t, -Math.PI / 2 + It, Math.PI / 2 - It);
  }
  set(t, n2, r2, o) {
    return this.distance = t, this.heading = n2, this.pitch = r2, o != null && (this.roll = o), this;
  }
  clone() {
    return new _De(this.distance, this.heading, this.pitch, this.roll);
  }
  copy(t) {
    return this.distance = t.distance, this.heading = t.heading, this.pitch = t.pitch, this.roll = t.roll, this;
  }
  equals(t) {
    return t.distance === this.distance && t.heading === this.heading && t.pitch === this.pitch && t.roll === this.roll;
  }
  decompose(t, n2, r2, o, s = N.WGS84) {
    s.getEastNorthUpVectors(
      t,
      ot,
      it,
      N2
    ), o?.copy(N2);
    const i2 = X.copy(ot).multiplyScalar(Math.cos(this.heading)).add(
      Ot.copy(it).multiplyScalar(Math.sin(this.heading))
    ).multiplyScalar(Math.cos(this.pitch)).add(Ot.copy(N2).multiplyScalar(Math.sin(this.pitch))).normalize().multiplyScalar(this.distance);
    if (n2.copy(t).sub(i2), this.roll !== 0) {
      const c2 = X.copy(t).sub(n2).normalize();
      N2.applyQuaternion(
        or.setFromAxisAngle(c2, this.roll)
      );
    }
    r2.setFromRotationMatrix(
      sr.lookAt(n2, t, N2)
    );
  }
  setFromCamera(t, n2 = N.WGS84, r2) {
    const o = X.setFromMatrixPosition(t.matrixWorld), s = Ot.set(0, 0, 0.5).unproject(t).sub(o).normalize(), i2 = n2.getIntersection(
      ir.set(o, s)
    );
    if (i2 == null)
      return;
    r2?.copy(i2), this.distance = o.distanceTo(i2), n2.getEastNorthUpVectors(
      i2,
      ot,
      it,
      N2
    ), this.heading = Math.atan2(
      it.dot(s),
      ot.dot(s)
    ), this.pitch = Math.asin(N2.dot(s));
    const c2 = X.copy(t.up).applyQuaternion(t.quaternion), a4 = rr.copy(s).multiplyScalar(-c2.dot(s)).add(c2).normalize(), h2 = X.copy(s).multiplyScalar(-N2.dot(s)).add(N2).normalize(), f2 = h2.dot(a4), d = s.dot(h2.cross(a4));
    return this.roll = Math.atan2(d, f2), this;
  }
};
var Q2 = class Q3 {
  constructor(t = 0, n2 = 0, r2 = 0, o = 0) {
    this.west = t, this.south = n2, this.east = r2, this.north = o;
  }
  get width() {
    let t = this.east;
    return t < this.west && (t += Math.PI * 2), t - this.west;
  }
  get height() {
    return this.north - this.south;
  }
  set(t, n2, r2, o) {
    return this.west = t, this.south = n2, this.east = r2, this.north = o, this;
  }
  clone() {
    return new Q3(this.west, this.south, this.east, this.north);
  }
  copy(t) {
    return this.west = t.west, this.south = t.south, this.east = t.east, this.north = t.north, this;
  }
  equals(t) {
    return t.west === this.west && t.south === this.south && t.east === this.east && t.north === this.north;
  }
  at(t, n2, r2 = new C()) {
    return r2.set(
      this.west + (this.east - this.west) * t,
      this.north + (this.south - this.north) * n2
    );
  }
  fromArray(t, n2 = 0) {
    return this.west = t[n2], this.south = t[n2 + 1], this.east = t[n2 + 2], this.north = t[n2 + 3], this;
  }
  toArray(t = [], n2 = 0) {
    return t[n2] = this.west, t[n2 + 1] = this.south, t[n2 + 2] = this.east, t[n2 + 3] = this.north, t;
  }
  *[Symbol.iterator]() {
    yield this.west, yield this.south, yield this.east, yield this.north;
  }
};
Q2.MAX = /* @__PURE__ */ new Q2(
  C.MIN_LONGITUDE,
  C.MIN_LATITUDE,
  C.MAX_LONGITUDE,
  C.MAX_LATITUDE
);
var dt = Q2;
var cr = /^[ \t]*#include +"([\w\d./]+)"/gm;
function ar(e, t) {
  return e.replace(cr, (n2, r2) => {
    const s = r2.split("/").reduce(
      (i2, c2) => typeof i2 != "string" && i2 != null ? i2[c2] : void 0,
      t
    );
    if (typeof s != "string")
      throw new Error(`Could not find include for ${r2}.`);
    return ar(s, t);
  });
}
function* ve(e, t, n2, r2, o) {
  if (n2 >= r2)
    return;
  const s = 2 ** n2, i2 = n2 + 1, c2 = 2 ** i2, a4 = Math.floor(e / s * c2), h2 = Math.floor(t / s * c2), f2 = [
    [a4, h2, i2],
    [a4 + 1, h2, i2],
    [a4, h2 + 1, i2],
    [a4 + 1, h2 + 1, i2]
  ];
  if (i2 < r2)
    for (const d of f2)
      for (const O of ve(...d, r2, o))
        yield O;
  else
    for (const d of f2)
      yield (o ?? new Z()).set(...d);
}
var Z = class _Z {
  constructor(t = 0, n2 = 0, r2 = 0) {
    this.x = t, this.y = n2, this.z = r2;
  }
  set(t, n2, r2) {
    return this.x = t, this.y = n2, r2 != null && (this.z = r2), this;
  }
  clone() {
    return new _Z(this.x, this.y, this.z);
  }
  copy(t) {
    return this.x = t.x, this.y = t.y, this.z = t.z, this;
  }
  equals(t) {
    return t.x === this.x && t.y === this.y && t.z === this.z;
  }
  getParent(t = new _Z()) {
    const n2 = 2 ** this.z, r2 = this.x / n2, o = this.y / n2, s = this.z - 1, i2 = 2 ** s;
    return t.set(Math.floor(r2 * i2), Math.floor(o * i2), s);
  }
  *traverseChildren(t, n2) {
    const { x: r2, y: o, z: s } = this;
    for (const i2 of ve(r2, o, s, s + t, n2))
      yield i2;
  }
  fromArray(t, n2 = 0) {
    return this.x = t[n2], this.y = t[n2 + 1], this.z = t[n2 + 2], this;
  }
  toArray(t = [], n2 = 0) {
    return t[n2] = this.x, t[n2 + 1] = this.y, t[n2 + 2] = this.z, t;
  }
  *[Symbol.iterator]() {
    yield this.x, yield this.y, yield this.z;
  }
};
var le = /* @__PURE__ */ new ue();
var Ge = class _Ge {
  constructor(t = 2, n2 = 1, r2 = dt.MAX) {
    this.width = t, this.height = n2, this.rectangle = r2;
  }
  clone() {
    return new _Ge(this.width, this.height, this.rectangle.clone());
  }
  copy(t) {
    return this.width = t.width, this.height = t.height, this.rectangle.copy(t.rectangle), this;
  }
  getSize(t, n2 = new ue()) {
    return n2.set(this.width << t, this.height << t);
  }
  // Reference: https://github.com/CesiumGS/cesium/blob/1.122/packages/engine/Source/Core/GeographicTilingScheme.js#L210
  getTile(t, n2, r2 = new Z()) {
    const o = this.getSize(n2, le), { rectangle: s } = this, i2 = s.width / o.x, c2 = s.height / o.y, { west: a4, south: h2, east: f2 } = s;
    let d = t.longitude;
    f2 < a4 && (d += Math.PI * 2);
    let O = Math.floor((d - a4) / i2);
    O >= o.x && (O = o.x - 1);
    let F2 = Math.floor((t.latitude - h2) / c2);
    return F2 >= o.y && (F2 = o.y - 1), r2.x = O, r2.y = F2, r2.z = n2, r2;
  }
  // Reference: https://github.com/CesiumGS/cesium/blob/1.122/packages/engine/Source/Core/GeographicTilingScheme.js#L169
  getRectangle(t, n2 = new dt()) {
    const r2 = this.getSize(t.z, le), { rectangle: o } = this, s = o.width / r2.x, i2 = o.height / r2.y, { west: c2, north: a4 } = o;
    return n2.west = t.x * s + c2, n2.east = (t.x + 1) * s + c2, n2.north = a4 - (r2.y - t.y - 1) * i2, n2.south = a4 - (r2.y - t.y) * i2, n2;
  }
};
var ct;
function hr() {
  if (ct != null)
    return ct;
  const e = new Uint32Array([268435456]);
  return ct = new Uint8Array(e.buffer, e.byteOffset, e.byteLength)[0] === 0, ct;
}
function B(e, t, n2, r2 = true) {
  if (r2 === hr())
    return new t(e);
  const o = Object.assign(new DataView(e), {
    getFloat16(i2, c2) {
      return tr(this, i2, c2);
    }
  }), s = new t(o.byteLength / t.BYTES_PER_ELEMENT);
  for (let i2 = 0, c2 = 0; i2 < s.length; ++i2, c2 += t.BYTES_PER_ELEMENT)
    s[i2] = o[n2](c2, r2);
  return s;
}
var Wr = (e) => new Uint8Array(e);
var Vr = (e) => new Int8Array(e);
var Yr = (e, t) => B(e, Uint16Array, "getUint16", t);
var Xr = (e, t) => B(e, Int16Array, "getInt16", t);
var qr = (e, t) => B(e, Int32Array, "getInt32", t);
var kr = (e, t) => B(e, Uint32Array, "getUint32", t);
var Jr = (e, t) => B(e, A3, "getFloat16", t);
var $r = (e, t) => B(e, Float32Array, "getFloat32", t);
var Qr = (e, t) => B(e, Float64Array, "getFloat64", t);
function Zr(e) {
}
var fr = /#pragma unroll_loop_start\s+for\s*\(\s*int\s+i\s*=\s*(\d+)\s*;\s*i\s*<\s*(\d+)\s*;\s*(?:i\s*\+\+|\+\+\s*i)\s*\)\s*{([\s\S]+?)}\s+#pragma unroll_loop_end/g;
function lr(e, t, n2, r2) {
  let o = "";
  for (let s = parseInt(t, 10); s < parseInt(n2, 10); ++s)
    o += r2.replace(/\[\s*i\s*\]/g, `[${s}]`).replace(/UNROLLED_LOOP_INDEX/g, `${s}`);
  return o;
}
function Kr(e) {
  return e.replace(fr, lr);
}
export {
  sn as ArrayBufferLoader,
  _ as DEFAULT_STBN_URL,
  br as DataTextureLoader,
  zr as EXR3DTextureLoader,
  Hr as EXRTextureLoader,
  N as Ellipsoid,
  Q as EllipsoidGeometry,
  A3 as Float16Array,
  C as Geodetic,
  De as PointOfView,
  F as QuadGeometry,
  dt as Rectangle,
  A as STBNLoader,
  E as STBN_TEXTURE_DEPTH,
  y as STBN_TEXTURE_HEIGHT,
  S as STBN_TEXTURE_WIDTH,
  Z as TileCoordinate,
  Ge as TilingScheme,
  er as TypedArrayLoader,
  Pr as ceilPowerOfTwo,
  z3 as clamp,
  Mr as closeTo,
  Br as define,
  vr as defineExpression,
  Dr as defineFloat,
  Fr as defineInt,
  Gr as definePropertyShorthand,
  jr as defineUniformShorthand,
  Ir as degrees,
  Sr as euclideanModulo,
  xr as floorPowerOfTwo,
  gr as fromBufferGeometryLike,
  mr as inverseLerp,
  wr as isFloatLinearSupported,
  Or as isPowerOfTwo,
  Tr as isTypedArray,
  _r as lerp,
  Nr as normalize,
  Jr as parseFloat16Array,
  $r as parseFloat32Array,
  Qr as parseFloat64Array,
  Xr as parseInt16Array,
  qr as parseInt32Array,
  Vr as parseInt8Array,
  Yr as parseUint16Array,
  kr as parseUint32Array,
  Wr as parseUint8Array,
  Er as radians,
  Zr as reinterpretType,
  Lr as remap,
  Rr as remapClamped,
  ar as resolveIncludes,
  Cr as saturate,
  Ur as smoothstep,
  Ar as toBufferGeometryLike,
  Kr as unrollLoops
};
